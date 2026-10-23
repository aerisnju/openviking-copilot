import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DurableSessionStore } from "../src/durable-session-store.mjs";
import { catchUpTranscriptTail, MAX_CATCH_UP_EVENTS } from "../src/transcript-catchup.mjs";

const config = {};

function event(id, content = `text-${id}`) {
  return {
    id,
    type: "user.message",
    timestamp: "2026-10-22T00:00:00Z",
    data: { content, messageId: id },
  };
}

function missingFor(ids) {
  return ids.map((id) => ({
    event: event(id),
    record: { sourceEventId: id },
  }));
}

async function withStore(run) {
  const root = await mkdtemp(join(tmpdir(), "ov-copilot-catchup-"));
  try {
    const store = new DurableSessionStore({ sessionId: "session-catchup", stateRoot: root });
    await store.initialize();
    await run(store);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("journals a small transcript tail so the pre-compaction audit can pass", async () => {
  await withStore(async (store) => {
    const result = await catchUpTranscriptTail({
      missing: missingFor(["late-1", "late-2"]),
      sessionId: "session-catchup",
      config,
      store,
    });
    assert.deepEqual(result, { ok: true, staged: 2 });
    const snapshot = await store.snapshot();
    assert.equal(snapshot.lastObservedSequence, 1);
    assert.equal(snapshot.pendingCount, 2);
    const digests = await store.observedEventDigests();
    assert.equal(digests.size, 2);
  });
});

test("refuses a gap larger than the live-race bound instead of replaying history", async () => {
  await withStore(async (store) => {
    const ids = Array.from({ length: MAX_CATCH_UP_EVENTS + 1 }, (_, index) => `old-${index}`);
    const result = await catchUpTranscriptTail({
      missing: missingFor(ids),
      sessionId: "session-catchup",
      config,
      store,
    });
    assert.deepEqual(result, {
      ok: false,
      reason: "catch-up-too-large",
      missingCount: MAX_CATCH_UP_EVENTS + 1,
      maxEvents: MAX_CATCH_UP_EVENTS,
    });
    assert.equal((await store.snapshot()).lastObservedSequence, -1);
    assert.equal((await store.snapshot()).pendingCount, 0);
  });
});

test("accepts a gap exactly at the bound", async () => {
  await withStore(async (store) => {
    const ids = Array.from({ length: MAX_CATCH_UP_EVENTS }, (_, index) => `edge-${index}`);
    const result = await catchUpTranscriptTail({
      missing: missingFor(ids),
      sessionId: "session-catchup",
      config,
      store,
    });
    assert.deepEqual(result, { ok: true, staged: MAX_CATCH_UP_EVENTS });
    assert.equal((await store.snapshot()).lastObservedSequence, MAX_CATCH_UP_EVENTS - 1);
  });
});

test("is a no-op when nothing is missing", async () => {
  await withStore(async (store) => {
    assert.deepEqual(
      await catchUpTranscriptTail({ missing: [], sessionId: "session-catchup", config, store }),
      { ok: true, staged: 0 },
    );
    assert.equal((await store.snapshot()).lastObservedSequence, -1);
  });
});

test("refuses when normalization would drop an audited event", async () => {
  await withStore(async (store) => {
    const result = await catchUpTranscriptTail({
      missing: [{
        // A type the normalizer ignores cannot be re-derived as a record.
        event: { id: "ignored", type: "session.start", timestamp: "2026-10-22T00:00:00Z", data: {} },
      }],
      sessionId: "session-catchup",
      config,
      store,
    });
    assert.deepEqual(result, { ok: false, reason: "catch-up-normalization-mismatch" });
    assert.equal((await store.snapshot()).lastObservedSequence, -1);
  });
});

test("fails closed when the durable store rejects a record", async () => {
  await withStore(async (store) => {
    const originalStage = store.stage.bind(store);
    store.stage = async () => {
      throw new Error("journal unavailable");
    };
    try {
      const result = await catchUpTranscriptTail({
        missing: missingFor(["late-1"]),
        sessionId: "session-catchup",
        config,
        store,
      });
      assert.deepEqual(result, { ok: false, reason: "catch-up-stage-failed", name: "Error" });
    } finally {
      store.stage = originalStage;
    }
  });
});

test("is idempotent when the same tail is staged twice", async () => {
  await withStore(async (store) => {
    const missing = missingFor(["late-1", "late-2"]);
    assert.deepEqual(
      await catchUpTranscriptTail({ missing, sessionId: "session-catchup", config, store }),
      { ok: true, staged: 2 },
    );
    // A second hook invocation for the same boundary must not duplicate work.
    const again = await catchUpTranscriptTail({
      missing, sessionId: "session-catchup", config, store,
    });
    assert.equal(again.ok, true);
    assert.equal(again.staged, 0);
    assert.equal((await store.snapshot()).lastObservedSequence, 1);
    assert.equal((await store.snapshot()).pendingCount, 2);
  });
});