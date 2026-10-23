import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCopilotMemorySession, getOpenVikingSessionId } from "../src/copilot-memory-session.mjs";
import { boundRecallContext, estimateContextTokens } from "../src/context-budget.mjs";
import { DurableSessionStore } from "../src/durable-session-store.mjs";
import { normalizeCopilotEvents } from "../src/event-normalizer.mjs";
import { INTEGRATION_TEST_MEMORY_POLICY } from "../src/integration-test-mode.mjs";

const config = {
  autoCapture: true,
  autoRecall: false,
  captureTimeoutMs: 1000,
  timeoutMs: 1000,
  peerSource: "none",
};

function event(id, type, content) {
  return {
    id,
    type,
    timestamp: "2026-09-30T12:00:00Z",
    data: { content, messageId: id },
  };
}

async function withRuntime(run) {
  const stateRoot = await mkdtemp(join(tmpdir(), "ov-copilot-runtime-"));
  const store = new DurableSessionStore({
    sessionId: "copilot-native-session",
    stateRoot,
  });
  try {
    await run({ stateRoot, store });
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
}

test("maps a Copilot session deterministically and captures accepted messages", async () => {
  assert.equal(
    getOpenVikingSessionId("copilot-native-session"),
    getOpenVikingSessionId("copilot-native-session"),
  );
  assert.match(getOpenVikingSessionId("copilot-native-session"), /^copilot-[a-f0-9]{40}$/);

  await withRuntime(async ({ store }) => {
    const requests = [];
    const fetchJSON = async (path, init = {}) => {
      requests.push({ path, init });
      if (path.includes("?auto_create=true")) {
        return { ok: true, status: 200, result: { session_id: getOpenVikingSessionId("copilot-native-session") } };
      }
      return { ok: true, status: 200, result: {} };
    };
    const runtime = createCopilotMemorySession({
      copilotSessionId: "copilot-native-session",
      cwd: tmpdir(),
      config,
      fetchJSON,
      store,
    });

    await runtime.initialize();
    await runtime.capture(event("user-1", "user.message", "Keep this preference in mind."));
    await runtime.capture(event("assistant-1", "assistant.message", "Understood."));

    const messageRequests = requests.filter(({ init }) => init.method === "POST");
    assert.equal(messageRequests.length, 2);
    const first = JSON.parse(messageRequests[0].init.body);
    assert.equal(first.role, "user");
    assert.equal(first.message_kind, "user_query");
    assert.deepEqual(first.source_message_ids, ["user-1"]);
    assert.equal(first.parts[0].text, "Keep this preference in mind.");
    assert.equal((await store.snapshot()).lastAcknowledgedSequence, 1);
    assert.equal((await store.snapshot()).pendingCount, 0);
  });
});

test("creates an isolated test session with self memory and auto-commit disabled", async () => {
  await withRuntime(async ({ store }) => {
    const requests = [];
    const testSessionId = "ov-copilot-it-run-12345678";
    const testPeerId = "ov-copilot-it-run-12345678";
    let sessionCreated = false;
    const fetchJSON = async (path, init = {}) => {
      requests.push({ path, init });
      if (path === `/api/v1/sessions/${testSessionId}`) {
        return sessionCreated
          ? {
              ok: true,
              status: 200,
              result: {
                session_id: testSessionId,
                memory_policy: {
                  self: { enabled: false },
                  peer: { enabled: true },
                  memory_types: ["preferences"],
                  working_memory: { enabled: false },
                },
                auto_commit_policy: null,
              },
            }
          : { ok: false, status: 404, error: { code: "NOT_FOUND" } };
      }
      if (path === "/api/v1/sessions" && init.method === "POST") {
        sessionCreated = true;
        return { ok: true, status: 200, result: { session_id: testSessionId } };
      }
      return { ok: true, status: 200, result: {} };
    };
    const runtime = createCopilotMemorySession({
      copilotSessionId: "copilot-native-session",
      openVikingSessionId: testSessionId,
      cwd: tmpdir(),
      config: { ...config, peerId: testPeerId },
      fetchJSON,
      sessionMemoryPolicy: INTEGRATION_TEST_MEMORY_POLICY,
      store,
    });

    await runtime.initialize();
    await runtime.capture(event("user-test-1", "user.message", "Remember this test-only preference."));

    const creation = requests.find(({ path, init }) => path === "/api/v1/sessions" && init.method === "POST");
    assert.ok(creation);
    assert.deepEqual(JSON.parse(creation.init.body), {
      session_id: testSessionId,
      memory_policy: INTEGRATION_TEST_MEMORY_POLICY,
      auto_commit_policy: null,
    });
    assert.ok(requests.some(({ path }) => path === `/api/v1/sessions/${testSessionId}`));
    assert.ok(!requests.some(({ path }) => path.includes("auto_create=true")));
    const message = requests.find(({ path, init }) => path.endsWith("/messages") && init.method === "POST");
    assert.ok(message);
    assert.equal(JSON.parse(message.init.body).peer_id, testPeerId);
  });
});

test("refuses to write to an existing session with a different memory policy", async () => {
  await withRuntime(async ({ store }) => {
    const requests = [];
    const logs = [];
    const testSessionId = "ov-copilot-it-run-87654321";
    const fetchJSON = async (path, init = {}) => {
      requests.push({ path, init });
      if (path === `/api/v1/sessions/${testSessionId}`) {
        return {
          ok: true,
          status: 200,
          result: {
            session_id: testSessionId,
            memory_policy: { self: { enabled: true }, peer: { enabled: true } },
            auto_commit_policy: null,
          },
        };
      }
      return { ok: true, status: 200, result: {} };
    };
    const runtime = createCopilotMemorySession({
      copilotSessionId: "copilot-native-session",
      openVikingSessionId: testSessionId,
      cwd: tmpdir(),
      config: { ...config, peerId: "ov-copilot-it-run-87654321" },
      fetchJSON,
      sessionMemoryPolicy: INTEGRATION_TEST_MEMORY_POLICY,
      store,
      logger: (eventName, detail) => logs.push({ eventName, detail }),
    });

    await runtime.initialize();
    await runtime.capture(event("user-test-2", "user.message", "Must not reach a mismatched session."));

    assert.ok(!requests.some(({ path, init }) => path === "/api/v1/sessions" && init.method === "POST"));
    assert.ok(!requests.some(({ path }) => path.endsWith("/messages")));
    assert.ok(logs.some(({ eventName }) => eventName === "session-policy-mismatch"));
    assert.equal((await store.snapshot()).pendingCount, 1);
  });
});

test("retains retryable failures for replay without advancing the cursor", async () => {
  await withRuntime(async ({ store }) => {
    let acceptMessages = false;
    let scheduled;
    const scheduledDelays = [];
    const fetchJSON = async (path) => {
      if (path.includes("?auto_create=true")) {
        return { ok: true, status: 200, result: { session_id: getOpenVikingSessionId("copilot-native-session") } };
      }
      return acceptMessages
        ? { ok: true, status: 200, result: {} }
        : { ok: false, status: 503, error: { code: "UNAVAILABLE" } };
    };
    const runtime = createCopilotMemorySession({
      copilotSessionId: "copilot-native-session",
      cwd: tmpdir(),
      config,
      fetchJSON,
      store,
      retryScheduler: {
        baseDelayMs: 1_000,
        maxDelayMs: 2_000,
        random: () => 0.5,
        setTimeout(callback, delayMs) {
          scheduled = callback;
          scheduledDelays.push(delayMs);
          return { unref() {} };
        },
        clearTimeout() {
          scheduled = null;
        },
      },
    });

    await runtime.initialize();
    await runtime.capture(event("user-1", "user.message", "Retry me."));
    assert.equal((await store.snapshot()).lastAcknowledgedSequence, -1);
    assert.equal((await store.snapshot()).pendingCount, 1);
    assert.deepEqual(scheduledDelays, [1_000]);

    acceptMessages = true;
    scheduled();
    await runtime.flush();
    assert.equal((await store.snapshot()).lastAcknowledgedSequence, 0);
    assert.equal((await store.snapshot()).pendingCount, 0);
    await runtime.close();
  });
});

test("reopens an offline queue in a new runtime and commits only after replay", async () => {
  await withRuntime(async ({ store, stateRoot }) => {
    const sessionId = "copilot-native-session";
    const events = [
      event("offline-user", "user.message", "Synthetic offline request."),
      event("offline-assistant", "assistant.message", "Synthetic offline reply."),
    ];
    const offline = createCopilotMemorySession({
      copilotSessionId: sessionId,
      cwd: tmpdir(),
      config,
      store,
      fetchJSON: async () => ({ ok: false, status: 503 }),
    });
    await offline.initialize();
    for (const item of events) await offline.capture(item);
    assert.equal((await store.snapshot()).pendingCount, 2);
    await offline.close();

    const calls = [];
    const reopenedStore = new DurableSessionStore({ sessionId, stateRoot });
    const recovered = createCopilotMemorySession({
      copilotSessionId: sessionId,
      cwd: tmpdir(),
      config,
      store: reopenedStore,
      fetchJSON: async (path, init = {}) => {
        if (path.includes("?auto_create=true")) {
          return { ok: true, status: 200, result: { session_id: getOpenVikingSessionId(sessionId) } };
        }
        if (path.endsWith("/messages")) {
          calls.push(JSON.parse(init.body).source_message_ids[0]);
        } else if (path.endsWith("/commit")) {
          calls.push("commit");
        } else {
          assert.fail(`Unexpected mock request: ${path}`);
        }
        return { ok: true, status: 200, result: {} };
      },
    });
    await recovered.initialize();
    assert.equal((await reopenedStore.snapshot()).pendingCount, 2);
    await recovered.flush();
    assert.equal((await reopenedStore.snapshot()).pendingCount, 0);
    assert.equal((await recovered.commit()).ok, true);
    assert.deepEqual(calls, ["offline-user", "offline-assistant", "commit"]);
    assert.equal((await reopenedStore.observedEventDigests()).size, 2);
    await recovered.close();
  });
});

test("caps exponential retry delay and cancels retries when the session closes", async () => {
  await withRuntime(async ({ store }) => {
    let timerCallback;
    let timerDelay;
    let cancelled = false;
    const fetchJSON = async (path) => {
      if (path.includes("?auto_create=true")) {
        return { ok: true, status: 200, result: { session_id: getOpenVikingSessionId("copilot-native-session") } };
      }
      return { ok: false, status: 503, error: { code: "UNAVAILABLE" } };
    };
    const runtime = createCopilotMemorySession({
      copilotSessionId: "copilot-native-session",
      cwd: tmpdir(),
      config,
      fetchJSON,
      store,
      retryScheduler: {
        baseDelayMs: 1_000,
        maxDelayMs: 1_500,
        random: () => 1,
        setTimeout(callback, delayMs) {
          timerCallback = callback;
          timerDelay = delayMs;
          return { unref() {} };
        },
        clearTimeout() {
          cancelled = true;
          timerCallback = null;
        },
      },
    });

    await runtime.initialize();
    await runtime.capture(event("user-1", "user.message", "Retry with a capped delay."));
    assert.equal(timerDelay, 1_200);
    timerCallback();
    await runtime.flush();
    assert.equal(timerDelay, 1_500);
    assert.equal((await store.snapshot()).pendingCount, 1);

    await runtime.close();
    assert.equal(cancelled, true);
    assert.equal(timerCallback, null);
  });
});

test("bounds the default retry delay so a stalled flush stays short-lived", async () => {
  await withRuntime(async ({ store }) => {
    const delays = [];
    let timerCallback;
    const fetchJSON = async (path) => {
      if (path.includes("?auto_create=true")) {
        return { ok: true, status: 200, result: { session_id: getOpenVikingSessionId("copilot-native-session") } };
      }
      return { ok: false, status: 503, error: { code: "UNAVAILABLE" } };
    };
    const runtime = createCopilotMemorySession({
      copilotSessionId: "copilot-native-session",
      cwd: tmpdir(),
      config,
      fetchJSON,
      store,
      retryScheduler: {
        random: () => 1,
        setTimeout(callback, delayMs) {
          timerCallback = callback;
          delays.push(delayMs);
          return { unref() {} };
        },
        clearTimeout() {
          timerCallback = null;
        },
      },
    });

    await runtime.initialize();
    await runtime.capture(event("user-1", "user.message", "Default backoff must stay bounded."));
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const callback = timerCallback;
      assert.equal(typeof callback, "function");
      callback();
      await runtime.flush();
    }
    assert.equal(delays.length >= 8, true);
    assert.equal(Math.max(...delays) <= 15_000, true);
    assert.equal((await store.snapshot()).pendingCount, 1);
    await runtime.close();
  });
});

test("clamps the per-write capture timeout so a hung socket is abandoned quickly", async () => {
  await withRuntime(async ({ store }) => {
    const observed = [];
    const fetchJSON = async (path, init = {}, options = {}) => {
      if (path.includes("?auto_create=true")) {
        return { ok: true, status: 200, result: { session_id: getOpenVikingSessionId("copilot-native-session") } };
      }
      observed.push(options.timeoutMs);
      return { ok: false, status: 0, error: { name: "AbortError" } };
    };
    const runtime = createCopilotMemorySession({
      copilotSessionId: "copilot-native-session",
      cwd: tmpdir(),
      // Upstream derives 30 s by default; the write must not wait that long.
      config: { ...config, captureTimeoutMs: 30_000, timeoutMs: 30_000 },
      fetchJSON,
      store,
      retryScheduler: {
        random: () => 0.5,
        setTimeout: () => ({ unref() {} }),
        clearTimeout: () => {},
      },
    });

    await runtime.initialize();
    await runtime.capture(event("user-1", "user.message", "Clamp the write budget."));
    assert.equal(observed.length, 1);
    assert.equal(observed[0] <= 10_000, true);
    assert.equal(observed[0] > 0, true);
    assert.equal((await store.snapshot()).pendingCount, 1);
    await runtime.close();
  });
});

test("keeps a shorter configured capture timeout unchanged", async () => {
  await withRuntime(async ({ store }) => {
    const observed = [];
    const fetchJSON = async (path, init = {}, options = {}) => {
      if (path.includes("?auto_create=true")) {
        return { ok: true, status: 200, result: { session_id: getOpenVikingSessionId("copilot-native-session") } };
      }
      observed.push(options.timeoutMs);
      return { ok: false, status: 0, error: { name: "AbortError" } };
    };
    const runtime = createCopilotMemorySession({
      copilotSessionId: "copilot-native-session",
      cwd: tmpdir(),
      config: { ...config, captureTimeoutMs: 1_200, timeoutMs: 30_000 },
      fetchJSON,
      store,
      retryScheduler: {
        random: () => 0.5,
        setTimeout: () => ({ unref() {} }),
        clearTimeout: () => {},
      },
    });

    await runtime.initialize();
    await runtime.capture(event("user-1", "user.message", "Keep the small budget."));
    assert.equal(observed.length, 1);
    assert.equal(observed[0] <= 1_200, true);
    assert.equal(observed[0] > 1_000, true);
    await runtime.close();
  });
});

test("applies recall query filters and can bypass recall for a matching prompt", async () => {
  await withRuntime(async ({ store }) => {
    const requests = [];
    const fetchJSON = async (path, init = {}) => {
      requests.push({ path, init });
      return { ok: true, status: 200, result: { items: [] } };
    };
    const runtime = createCopilotMemorySession({
      copilotSessionId: "copilot-native-session",
      cwd: tmpdir(),
      config: {
        ...config,
        autoRecall: true,
        recallQueryFilters: [
          "user:d|^/no-memory",
          "s|Customer \\d+|Customer [ID]|g",
        ],
      },
      fetchJSON,
      store,
    });

    await runtime.recall("/no-memory Customer 4815");
    assert.equal(requests.length, 0);
    await runtime.recall("Find notes about Customer 4815");

    const search = requests.find(({ path }) => path === "/api/v1/search/search");
    assert.ok(search);
    assert.equal(JSON.parse(search.init.body).query, "Find notes about Customer [ID]");
    await runtime.close();
  });
});

test("bounds the context returned from a real recall pipeline before injection", async () => {
  await withRuntime(async ({ store }) => {
    const requests = [];
    const fetchJSON = async (path, init = {}) => {
      requests.push({ path, init });
      if (path === "/api/v1/search/search") {
        return {
          ok: true,
          status: 200,
          result: { rendered: "中文记忆。".repeat(200), entries: [], stats: {} },
        };
      }
      throw new Error(`Unexpected recall request: ${path}`);
    };
    const logs = [];
    const runtime = createCopilotMemorySession({
      copilotSessionId: "copilot-native-session",
      cwd: tmpdir(),
      config: { ...config, autoRecall: true, recallMaxTokens: 64 },
      fetchJSON,
      store,
      logger: (eventName, detail) => logs.push({ eventName, detail }),
    });

    const result = await runtime.recall("请告诉我中文记忆");
    assert.ok(result);
    assert.ok(estimateContextTokens(result) <= 64);
    assert.ok(result.startsWith("<openviking-context>\n"));
    assert.ok(result.endsWith("\n</openviking-context>"));
    assert.ok(logs.some(({ eventName }) => eventName === "recall-context-truncated"));
    await runtime.close();
  });
});

test("estimates CJK context conservatively and trims recalled content without breaking its envelope", () => {
  assert.equal(estimateContextTokens("abcdefgh"), 2);
  assert.equal(estimateContextTokens("中文"), 3);

  const block = [
    "<openviking-context>",
    "Relevant memory from OpenViking. Use the search/read MCP tools to expand URIs.",
    "用户偏好使用中文。".repeat(100),
    "</openviking-context>",
  ].join("\n");
  const result = boundRecallContext(block, 64);

  assert.equal(result.truncated, true);
  assert.ok(result.estimatedTokens <= 64);
  assert.ok(result.text.startsWith("<openviking-context>\n"));
  assert.ok(result.text.endsWith("\n</openviking-context>"));
  assert.match(result.text, /trimmed to fit the token budget/);

  const tiny = boundRecallContext(block, 1);
  assert.equal(tiny.text, "");
  assert.equal(tiny.estimatedTokens, 0);
});

test("serializes concurrent flushes so a pending message is not sent twice", async () => {
  await withRuntime(async ({ store }) => {
    let messageCalls = 0;
    let notifyFirstMessage;
    let releaseMessage;
    const firstMessageStarted = new Promise((resolve) => {
      notifyFirstMessage = resolve;
    });
    const messageGate = new Promise((resolve) => {
      releaseMessage = resolve;
    });
    const fetchJSON = async (path) => {
      if (path.includes("?auto_create=true")) {
        return { ok: true, status: 200, result: { session_id: getOpenVikingSessionId("copilot-native-session") } };
      }
      messageCalls += 1;
      notifyFirstMessage();
      await messageGate;
      return { ok: true, status: 200, result: {} };
    };
    const runtime = createCopilotMemorySession({
      copilotSessionId: "copilot-native-session",
      cwd: tmpdir(),
      config,
      fetchJSON,
      store,
    });

    await runtime.initialize();
    const [record] = normalizeCopilotEvents(
      [event("user-queued", "user.message", "Send once.")],
      "copilot-native-session",
    );
    await store.stage(record);
    const firstFlush = runtime.flush();
    const secondFlush = runtime.flush();

    await firstMessageStarted;
    assert.equal(messageCalls, 1);
    releaseMessage();
    await Promise.all([firstFlush, secondFlush]);
    assert.equal(messageCalls, 1);
    assert.equal((await store.snapshot()).lastAcknowledgedSequence, 0);
    await runtime.close();
  });
});

test("stops a pre-compaction flush when its absolute deadline has expired", async () => {
  await withRuntime(async ({ store }) => {
    const requests = [];
    const fetchJSON = async (path) => {
      requests.push(path);
      return {
        ok: true,
        status: 200,
        result: { session_id: getOpenVikingSessionId("copilot-native-session") },
      };
    };
    const runtime = createCopilotMemorySession({
      copilotSessionId: "copilot-native-session",
      cwd: tmpdir(),
      config,
      fetchJSON,
      store,
    });
    await runtime.initialize();
    const [record] = normalizeCopilotEvents(
      [event("user-deadline", "user.message", "Leave queued after the deadline.")],
      "copilot-native-session",
    );
    await store.stage(record);

    const result = await runtime.flush({ deadlineAt: Date.now() - 1 });
    assert.deepEqual(result, { sent: 0, blocked: true, reason: "deadline" });
    assert.deepEqual(requests, []);
    assert.equal((await store.snapshot()).pendingCount, 1);
    await runtime.close();
  });
});

test("dead-letters terminal write failures and blocks later records behind the gap", async () => {
  await withRuntime(async ({ store }) => {
    let messageWrites = 0;
    let commitWrites = 0;
    const fetchJSON = async (path) => {
      if (path.includes("?auto_create=true")) {
        return { ok: true, status: 200, result: { session_id: getOpenVikingSessionId("copilot-native-session") } };
      }
      if (path.endsWith("/commit")) {
        commitWrites += 1;
        return { ok: true, status: 200, result: {} };
      }
      messageWrites += 1;
      return { ok: false, status: 422, error: { code: "INVALID_ARGUMENT" } };
    };
    const runtime = createCopilotMemorySession({
      copilotSessionId: "copilot-native-session",
      cwd: tmpdir(),
      config,
      fetchJSON,
      store,
    });

    await runtime.initialize();
    await runtime.capture(event("user-1", "user.message", "Invalid payload."));
    await runtime.capture(event("user-2", "user.message", "Must remain queued."));

    assert.equal(messageWrites, 1);
    const snapshot = await store.snapshot();
    assert.equal(snapshot.deadLetterCount, 1);
    assert.equal(snapshot.deadLetterSequences[0], 0);
    assert.equal(snapshot.pendingCount, 1);
    assert.equal(snapshot.lastAcknowledgedSequence, -1);
    assert.equal((await runtime.commit()).reason, "dead-letter");
    assert.equal(commitWrites, 0);
  });
});

test("routes enabled subagent events to a peer-preferences-only isolated session", async () => {
  await withRuntime(async ({ store }) => {
    const parentSessionId = "ov-copilot-it-run-12345678";
    const agentIdHash = createHash("sha256").update("agent-42").digest("hex");
    const childSessionId = `ov-copilot-it-run-12345678-sub-${agentIdHash.slice(0, 24)}`;
    const sessions = new Map();
    const messageRequests = [];
    const commitRequests = [];
    const fetchJSON = async (path, init = {}) => {
      const sessionMatch = path.match(/^\/api\/v1\/sessions\/([^/?]+)/);
      if (path === "/api/v1/sessions" && init.method === "POST") {
        const body = JSON.parse(init.body);
        sessions.set(body.session_id, body);
        return { ok: true, status: 200, result: { session_id: body.session_id } };
      }
      if (sessionMatch && !path.endsWith("/messages") && !path.endsWith("/commit")) {
        const sessionId = decodeURIComponent(sessionMatch[1]);
        const session = sessions.get(sessionId);
        return session
          ? {
              ok: true,
              status: 200,
              result: {
                session_id: sessionId,
                memory_policy: session.memory_policy,
                auto_commit_policy: session.auto_commit_policy,
              },
            }
          : { ok: false, status: 404, error: { code: "NOT_FOUND" } };
      }
      if (path.endsWith("/messages")) {
        messageRequests.push({ path, body: JSON.parse(init.body) });
        return { ok: true, status: 200, result: {} };
      }
      if (path.endsWith("/commit")) {
        commitRequests.push(path);
        return { ok: true, status: 200, result: {} };
      }
      throw new Error(`Unexpected request: ${path}`);
    };
    const runtime = createCopilotMemorySession({
      copilotSessionId: "copilot-native-session",
      openVikingSessionId: parentSessionId,
      cwd: tmpdir(),
      config: { ...config, peerId: parentSessionId },
      fetchJSON,
      sessionMemoryPolicy: INTEGRATION_TEST_MEMORY_POLICY,
      subagentMemoryEnabled: true,
      subagentSessionIdFactory: ({ agentIdHash }) =>
        `ov-copilot-it-run-12345678-sub-${agentIdHash.slice(0, 24)}`,
      store,
    });

    await runtime.initialize();
    await runtime.capture({ ...event("subagent-start", "subagent.started", ""), agentId: "agent-42" });
    await runtime.capture({
      ...event("child-user", "user.message", "Store only this synthetic child preference."),
      agentId: "agent-42",
    });
    await runtime.capture({
      ...event("child-assistant", "assistant.message", "Synthetic child response."),
      agentId: "agent-42",
    });
    const completedEvent = {
      ...event("subagent-complete", "subagent.completed", ""),
      agentId: "agent-42",
    };
    await runtime.capture(completedEvent);
    await runtime.capture(completedEvent);

    assert.deepEqual([...sessions.keys()].sort(), [childSessionId, parentSessionId].sort());
    assert.deepEqual(
      sessions.get(childSessionId).memory_policy,
      {
        self: { enabled: false },
        peer: { enabled: true },
        memory_types: ["preferences"],
        working_memory: { enabled: false },
      },
    );
    const childMessages = messageRequests.filter(({ path }) =>
      path.includes(`/sessions/${encodeURIComponent(childSessionId)}/`));
    const parentMessages = messageRequests.filter(({ path }) =>
      path.includes(`/sessions/${encodeURIComponent(parentSessionId)}/`));
    assert.deepEqual(childMessages.map(({ body }) => body.role), ["user", "assistant"]);
    assert.equal(parentMessages.some(({ body }) => JSON.stringify(body).includes("child preference")), false);
    assert.equal(commitRequests.length, 1);
    assert.ok(commitRequests[0].includes(encodeURIComponent(childSessionId)));
    assert.equal((await store.subagentSessions())[0].status, "committed");
    await runtime.close();
  });
});
