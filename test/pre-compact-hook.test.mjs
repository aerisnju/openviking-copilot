import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createCopilotMemorySession, getOpenVikingSessionId } from "../src/copilot-memory-session.mjs";
import { DurableSessionStore } from "../src/durable-session-store.mjs";
import { runPreCompactHook } from "../src/pre-compact-hook.mjs";
import { auditPreCompactTranscript } from "../src/transcript-audit.mjs";

const input = { sessionId: "copilot-session", cwd: "C:\\workspace" };
const enabledConfig = { enabled: true, baseUrl: "https://openviking.example" };

test("flushes and commits the durable observed prefix before compaction", async () => {
  const calls = [];
  const runtime = {
    async initialize() {
      calls.push("initialize");
    },
    async flush(options) {
      assert.equal(Number.isFinite(options.deadlineAt), true);
      calls.push("flush");
      return { sent: 2, blocked: false };
    },
    async commit(options) {
      assert.equal(Number.isFinite(options.deadlineAt), true);
      calls.push("commit");
      return { ok: true };
    },
    close() {
      calls.push("close");
    },
  };
  const result = await runPreCompactHook(input, {
    config: enabledConfig,
    fetchJSON: async () => assert.fail("injected runtime must not make network calls"),
    auditTranscript: async () => ({ ok: true }),
    createRuntime(options) {
      assert.equal(options.copilotSessionId, input.sessionId);
      assert.equal(options.cwd, input.cwd);
      return runtime;
    },
  });

  assert.deepEqual(result, { ok: true });
  assert.deepEqual(calls, ["initialize", "flush", "commit", "close"]);
});

test("a separate hook waits for a competing process, then flushes the durable prefix before commit", async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "ov-copilot-compact-prefix-"));
  const sessionId = "synthetic-compact-prefix";
  const cwd = tmpdir();
  const config = {
    ...enabledConfig,
    autoCapture: true,
    captureTimeoutMs: 1_000,
    timeoutMs: 1_000,
    peerSource: "none",
  };
  const makeStore = () => new DurableSessionStore({ sessionId, stateRoot });
  const captureRuntime = createCopilotMemorySession({
    copilotSessionId: sessionId,
    cwd,
    config,
    store: makeStore(),
    fetchJSON: async () => ({ ok: false, status: 503 }),
  });
  let worker;
  try {
    await captureRuntime.initialize();
    for (const [index, role] of ["user", "assistant", "user"].entries()) {
      await captureRuntime.capture({
        id: `synthetic-${index}`,
        type: `${role}.message`,
        timestamp: "2026-10-01T00:00:00Z",
        data: { content: `Synthetic ${index}`, messageId: `synthetic-${index}` },
      });
    }
    assert.equal((await makeStore().snapshot()).pendingCount, 3);
    await captureRuntime.close();

    worker = spawn(
      process.execPath,
      [fileURLToPath(new URL("../test-support/remote-lease-worker.mjs", import.meta.url)), sessionId, stateRoot],
      { stdio: ["ignore", "ignore", "pipe", "ipc"] },
    );
    await new Promise((resolve, reject) => {
      worker.once("message", resolve);
      worker.once("error", reject);
      worker.once("exit", (code) => reject(new Error(`Lease worker exited early: ${code}`)));
    });
    const calls = [];
    const fetchJSON = async (path, init = {}) => {
      if (path.endsWith("?auto_create=true")) {
        return {
          ok: true,
          status: 200,
          result: { session_id: getOpenVikingSessionId(sessionId) },
        };
      }
      if (path.endsWith("/messages")) {
        calls.push(JSON.parse(init.body).source_message_ids[0]);
      } else if (path.endsWith("/commit")) {
        calls.push("commit");
      } else {
        assert.fail(`Unexpected mock request: ${path}`);
      }
      return { ok: true, status: 200, result: {} };
    };
    const hookResult = runPreCompactHook({ sessionId, cwd }, {
      config,
      fetchJSON,
      store: makeStore(),
      auditTranscript: async () => ({ ok: true }),
    });
    await delay(100);
    assert.deepEqual(calls, []);
    const workerExit = new Promise((resolve, reject) => {
      worker.once("error", reject);
      worker.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`Lease worker exited: ${code}`)));
    });
    worker.send("release");
    await workerExit;
    const result = await hookResult;
    assert.equal(result.ok, true);
    assert.deepEqual(calls, ["synthetic-0", "synthetic-1", "synthetic-2", "commit"]);
    const snapshot = await makeStore().snapshot();
    assert.equal(snapshot.pendingCount, 0);
    assert.equal(snapshot.lastAcknowledgedSequence, 2);
  } finally {
    if (worker && worker.exitCode === null) worker.kill();
    await captureRuntime.close();
    await rm(stateRoot, { recursive: true, force: true });
  }
});

test("a hook cannot include an event that has not reached the journal", async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "ov-copilot-unpersisted-event-"));
  const sessionId = "synthetic-unpersisted-event";
  const cwd = tmpdir();
  const config = {
    ...enabledConfig,
    autoCapture: true,
    captureTimeoutMs: 1_000,
    timeoutMs: 1_000,
    peerSource: "none",
  };
  const store = new DurableSessionStore({ sessionId, stateRoot });
  const stage = store.stage.bind(store);
  let enterStage;
  let allowStage;
  const stageStarted = new Promise((resolve) => { enterStage = resolve; });
  const stageAllowed = new Promise((resolve) => { allowStage = resolve; });
  store.stage = async (record) => {
    enterStage();
    await stageAllowed;
    return stage(record);
  };
  const runtime = createCopilotMemorySession({
    copilotSessionId: sessionId,
    cwd,
    config,
    store,
    fetchJSON: async () => ({ ok: false, status: 503 }),
  });
  let capture;
  try {
    await runtime.initialize();
    const event = {
      id: "synthetic-late",
      type: "user.message",
      timestamp: "2026-10-01T00:00:00Z",
      data: { content: "Synthetic late event", messageId: "synthetic-late" },
    };
    const transcriptPath = join(stateRoot, "session-state", sessionId, "events.jsonl");
    await mkdir(join(stateRoot, "session-state", sessionId), { recursive: true });
    const compactAt = Date.parse(event.timestamp) + 100;
    await writeFile(transcriptPath, `${JSON.stringify(event)}\n${JSON.stringify({
      id: "synthetic-compact",
      type: "session.compaction_start",
      timestamp: new Date(compactAt).toISOString(),
      data: { trigger: "manual" },
    })}\n`);
    capture = runtime.capture(event);
    await stageStarted;
    const result = await runPreCompactHook({ sessionId, cwd, transcriptPath, timestamp: compactAt + 10 }, {
      config,
      store: new DurableSessionStore({ sessionId, stateRoot }),
      fetchJSON: async () => assert.fail("No remote request is needed for an empty journal"),
      auditTranscript: (i, s, c) => auditPreCompactTranscript(i, s, c, stateRoot),
    });
    assert.deepEqual(result, { ok: false, reason: "transcript-event-not-durable" });
    allowStage();
    await capture;
    assert.equal((await store.snapshot()).pendingCount, 1);
  } finally {
    allowStage();
    await capture;
    await runtime.close();
    await rm(stateRoot, { recursive: true, force: true });
  }
});

test("passes isolated session identity and policy to the hook runtime", async () => {
  const isolated = {
    openVikingSessionId: "ov-copilot-it-run-12345678",
    sessionMemoryPolicy: { self: { enabled: false } },
  };
  const result = await runPreCompactHook(input, {
    config: enabledConfig,
    fetchJSON: async () => assert.fail("injected runtime must not make network calls"),
    auditTranscript: async () => ({ ok: true }),
    ...isolated,
    createRuntime(options) {
      assert.equal(options.openVikingSessionId, isolated.openVikingSessionId);
      assert.equal(options.sessionMemoryPolicy, isolated.sessionMemoryPolicy);
      return {
        async initialize() {},
        async flush() {
          return { blocked: false };
        },
        async commit() {
          return { ok: true };
        },
        close() {},
      };
    },
  });

  assert.deepEqual(result, { ok: true });
});

test("does not commit when flushing reports a blocked durable queue", async () => {
  const calls = [];
  const logs = [];
  const result = await runPreCompactHook(input, {
    config: enabledConfig,
    fetchJSON: async () => {},
    logger: (name, detail) => logs.push({ name, detail }),
    createRuntime() {
      return {
        async initialize() {},
        async flush() {
          calls.push("flush");
          return { blocked: true, reason: "dead-letter" };
        },
        async commit() {
          calls.push("commit");
          return { ok: true };
        },
        close() {
          calls.push("close");
        },
      };
    },
  });

  assert.deepEqual(result, { ok: false, reason: "dead-letter" });
  assert.deepEqual(calls, ["flush", "close"]);
  assert.deepEqual(logs, [
    { name: "pre-compact-flush-blocked", detail: { reason: "dead-letter" } },
  ]);
});

test("does not commit if the transcript audit cannot confirm the captured prefix", async () => {
  const calls = [];
  const result = await runPreCompactHook(input, {
    config: enabledConfig,
    fetchJSON: async () => assert.fail("injected runtime must not make network calls"),
    auditTranscript: async () => ({ ok: false, reason: "transcript-event-not-durable" }),
    createRuntime() {
      return {
        async initialize() { calls.push("initialize"); },
        async flush() { calls.push("flush"); return { blocked: false }; },
        async commit() { calls.push("commit"); return { ok: true }; },
        async close() { calls.push("close"); },
      };
    },
  });
  assert.deepEqual(result, { ok: false, reason: "transcript-event-not-durable" });
  assert.deepEqual(calls, ["initialize", "flush", "close"]);
});

test("skips runtime work when memory is disabled", async () => {
  let created = false;
  const result = await runPreCompactHook(input, {
    config: { enabled: false, baseUrl: enabledConfig.baseUrl },
    fetchJSON: async () => {},
    createRuntime() {
      created = true;
      throw new Error("disabled memory must not construct a runtime");
    },
  });

  assert.deepEqual(result, { ok: true, skipped: true, reason: "memory-disabled" });
  assert.equal(created, false);
});

test("rejects incomplete hook input before creating a runtime", async () => {
  await assert.rejects(
    runPreCompactHook({ cwd: input.cwd }, {
      config: enabledConfig,
      fetchJSON: async () => {},
      createRuntime: () => assert.fail("invalid input must not create a runtime"),
    }),
    /sessionId/,
  );
  await assert.rejects(
    runPreCompactHook({ sessionId: input.sessionId }, {
      config: enabledConfig,
      fetchJSON: async () => {},
      createRuntime: () => assert.fail("invalid input must not create a runtime"),
    }),
    /cwd/,
  );
});
