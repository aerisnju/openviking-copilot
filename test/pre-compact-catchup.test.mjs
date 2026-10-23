import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DurableSessionStore } from "../src/durable-session-store.mjs";
import { runPreCompactHook } from "../src/pre-compact-hook.mjs";
import { auditPreCompactTranscript } from "../src/transcript-audit.mjs";
import { MAX_CATCH_UP_EVENTS } from "../src/transcript-catchup.mjs";
import { readVerifiedTranscript } from "../src/transcript-read.mjs";

const config = { enabled: true, baseUrl: "https://openviking.example" };

function userEvent(id, content) {
  return {
    id,
    type: "user.message",
    timestamp: "2026-10-22T00:00:00Z",
    data: { content, messageId: id },
  };
}

async function setupTranscript({ sessionId, events, compactionOffsetMs = 10 }) {
  const root = await mkdtemp(join(tmpdir(), "ov-copilot-catchup-hook-"));
  const file = join(root, "session-state", sessionId, "events.jsonl");
  await mkdir(join(root, "session-state", sessionId), { recursive: true });
  const compaction = {
    id: `${sessionId}-compaction`,
    type: "session.compaction_start",
    timestamp: "2026-10-22T00:00:02Z",
    data: { trigger: "manual" },
  };
  await writeFile(
    file,
    [...events, compaction].map((event) => JSON.stringify(event)).join("\n") + "\n",
  );
  return {
    root,
    input: {
      sessionId,
      cwd: "C:\\workspace",
      transcriptPath: file,
      timestamp: Date.parse(compaction.timestamp) + compactionOffsetMs,
    },
  };
}

function fakeRuntime(calls) {
  return {
    async initialize() { calls.push("initialize"); },
    async flush() { calls.push("flush"); return { blocked: false }; },
    async commit() { calls.push("commit"); return { ok: true }; },
    async close() { calls.push("close"); },
  };
}

test("catches up a transcript tail the extension had not journaled, then commits", async () => {
  const sessionId = "synthetic-catchup-hook";
  const events = [userEvent("early-user", "Journaled before compaction.")];
  const { root, input } = await setupTranscript({ sessionId, events });
  const store = new DurableSessionStore({ sessionId, stateRoot: join(root, "store") });
  const calls = [];
  const logs = [];
  try {
    await store.initialize();
    // The extension only ever journaled the first event; the host had already
    // written a second one before the Hook ran.
    const { normalizeCopilotEvents } = await import("../src/event-normalizer.mjs");
    await store.stage(normalizeCopilotEvents([events[0]], sessionId)[0]);
    await store.acknowledgeThrough(0);
    await writeFile(
      join(root, "session-state", sessionId, "events.jsonl"),
      [...events, userEvent("late-user", "Written by the host just before the Hook."), {
        id: `${sessionId}-compaction`,
        type: "session.compaction_start",
        timestamp: "2026-10-22T00:00:02Z",
        data: { trigger: "manual" },
      }].map((event) => JSON.stringify(event)).join("\n") + "\n",
    );

    const result = await runPreCompactHook(input, {
      config,
      fetchJSON: async () => assert.fail("the injected runtime must not make network calls"),
      store,
      logger: (name, detail) => logs.push({ name, detail }),
      createRuntime: () => fakeRuntime(calls),
      auditTranscript: (hookInput, hookStore, hookConfig) =>
        auditPreCompactTranscript(hookInput, hookStore, hookConfig, root, { includeMissing: true }),
    });

    assert.deepEqual(result, { ok: true });
    assert.deepEqual(calls, ["initialize", "flush", "flush", "commit", "close"]);
    assert.equal(logs.some((entry) => entry.name === "pre-compact-catch-up" && entry.detail.staged === 1), true);
    assert.equal((await store.snapshot()).lastObservedSequence, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("refuses an oversized gap and never commits it", async () => {
  const sessionId = "synthetic-catchup-large";
  const { root, input } = await setupTranscript({ sessionId, events: [] });
  const store = new DurableSessionStore({ sessionId, stateRoot: join(root, "store") });
  const calls = [];
  const logs = [];
  try {
    await store.initialize();
    const bulk = Array.from({ length: MAX_CATCH_UP_EVENTS + 1 }, (_, index) =>
      userEvent(`old-${index}`, `Historical event ${index}.`));
    await writeFile(
      join(root, "session-state", sessionId, "events.jsonl"),
      [...bulk, {
        id: `${sessionId}-compaction`,
        type: "session.compaction_start",
        timestamp: "2026-10-22T00:00:02Z",
        data: { trigger: "manual" },
      }].map((event) => JSON.stringify(event)).join("\n") + "\n",
    );

    const result = await runPreCompactHook(input, {
      config,
      fetchJSON: async () => assert.fail("no network calls for a refused catch-up"),
      store,
      logger: (name, detail) => logs.push({ name, detail }),
      createRuntime: () => fakeRuntime(calls),
      auditTranscript: (hookInput, hookStore, hookConfig) =>
        auditPreCompactTranscript(hookInput, hookStore, hookConfig, root, { includeMissing: true }),
    });

    assert.deepEqual(result, { ok: false, reason: "catch-up-too-large" });
    assert.equal(calls.includes("commit"), false);
    assert.equal(logs.some((entry) => entry.name === "pre-compact-catch-up-refused"), true);
    assert.equal((await store.snapshot()).lastObservedSequence, -1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("prunes the ledger to the transcript after a verified audit", async () => {
  const sessionId = "synthetic-ledger-prune";
  const events = [userEvent("live-user", "Still in the transcript.")];
  const { root, input } = await setupTranscript({ sessionId, events });
  const store = new DurableSessionStore({ sessionId, stateRoot: join(root, "store") });
  const calls = [];
  const logs = [];
  try {
    await store.initialize();
    const { normalizeCopilotEvents } = await import("../src/event-normalizer.mjs");
    // One event is journaled and acknowledged but has already left the transcript.
    await store.stage(normalizeCopilotEvents([userEvent("dropped-user", "Compacted away.")], sessionId)[0]);
    await store.acknowledgeThrough(0);
    await store.stage(normalizeCopilotEvents(events, sessionId, { startSequence: 1 })[0]);
    await store.acknowledgeThrough(1);
    assert.equal((await store.observedEventDigests()).size, 2);

    const result = await runPreCompactHook(input, {
      config,
      fetchJSON: async () => assert.fail("the injected runtime must not make network calls"),
      store,
      logger: (name, detail) => logs.push({ name, detail }),
      createRuntime: () => fakeRuntime(calls),
      auditTranscript: (hookInput, hookStore, hookConfig) =>
        auditPreCompactTranscript(hookInput, hookStore, hookConfig, root, { includeMissing: true }),
      readTranscript: (hookInput) => readVerifiedTranscript(hookInput, root),
    });

    assert.deepEqual(result, { ok: true });
    const digests = await store.observedEventDigests();
    assert.equal(digests.size, 1, "only the transcript-visible event should remain");
    assert.equal(logs.some((entry) => entry.name === "pre-compact-ledger-pruned" && entry.detail.pruned === 1), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("does not catch up a changed payload, because it is not a missing event", async () => {
  const sessionId = "synthetic-catchup-changed";
  const events = [userEvent("changed-user", "Original content.")];
  const { root, input } = await setupTranscript({ sessionId, events });
  const store = new DurableSessionStore({ sessionId, stateRoot: join(root, "store") });
  const calls = [];
  try {
    await store.initialize();
    const { normalizeCopilotEvents } = await import("../src/event-normalizer.mjs");
    await store.stage(normalizeCopilotEvents([events[0]], sessionId)[0]);
    await store.acknowledgeThrough(0);
    await writeFile(
      join(root, "session-state", sessionId, "events.jsonl"),
      [userEvent("changed-user", "Rewritten content."), {
        id: `${sessionId}-compaction`,
        type: "session.compaction_start",
        timestamp: "2026-10-22T00:00:02Z",
        data: { trigger: "manual" },
      }].map((event) => JSON.stringify(event)).join("\n") + "\n",
    );

    const result = await runPreCompactHook(input, {
      config,
      fetchJSON: async () => assert.fail("no network calls for a refused commit"),
      store,
      logger: () => {},
      createRuntime: () => fakeRuntime(calls),
      auditTranscript: (hookInput, hookStore, hookConfig) =>
        auditPreCompactTranscript(hookInput, hookStore, hookConfig, root, { includeMissing: true }),
    });

    // The ledger still holds the original digest, so staging the changed event
    // is refused by the store and the commit never happens.
    assert.equal(result.ok, false);
    assert.equal(calls.includes("commit"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});