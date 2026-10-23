import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createHash } from "node:crypto";
import { DurableSessionStore } from "../src/durable-session-store.mjs";
import { normalizeCopilotEvents } from "../src/event-normalizer.mjs";
import { transcriptDigests } from "../src/transcript-audit.mjs";

function event(id, content = `text-${id}`) {
  return {
    id,
    type: "user.message",
    timestamp: "2026-10-23T00:00:00Z",
    data: { content, messageId: id },
  };
}

function digestOf(id) {
  return createHash("sha256").update(id).digest("hex");
}

async function withStore(run) {
  const root = await mkdtemp(join(tmpdir(), "ov-copilot-ledger-"));
  try {
    const store = new DurableSessionStore({ sessionId: "session-ledger", stateRoot: root });
    await store.initialize();
    await run(store);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function stageAndAcknowledge(store, events) {
  const records = normalizeCopilotEvents(events, "session-ledger", {
    startSequence: (await store.snapshot()).lastObservedSequence + 1,
  });
  for (const record of records) await store.stage(record);
  if (records.length > 0) {
    await store.acknowledgeThrough(records.at(-1).sourceSequence);
  }
  return records;
}

test("prunes ledger entries the transcript no longer contains", async () => {
  await withStore(async (store) => {
    const all = [event("old-1"), event("old-2"), event("keep-1")];
    await stageAndAcknowledge(store, all);
    assert.equal((await store.observedEventDigests()).size, 3);

    const pruned = await store.pruneObservedDigests(new Set([digestOf("keep-1")]));
    assert.deepEqual(pruned, { pruned: 2, kept: 1 });

    const after = await store.observedEventDigests();
    assert.equal(after.size, 1);
    assert.equal(after.has(digestOf("keep-1")), true);
    assert.equal(after.has(digestOf("old-1")), false);
  });
});

test("keeps queued records resolvable even when the transcript dropped them", async () => {
  await withStore(async (store) => {
    await stageAndAcknowledge(store, [event("acked-1")]);
    // A second event is staged but never acknowledged, so it is still pending.
    const [pendingRecord] = normalizeCopilotEvents([event("pending-1")], "session-ledger", {
      startSequence: (await store.snapshot()).lastObservedSequence + 1,
    });
    await store.stage(pendingRecord);

    // The transcript knows only about an unrelated event.
    const pruned = await store.pruneObservedDigests(new Set([digestOf("other")]));
    assert.equal(pruned.kept, 1);
    const after = await store.observedEventDigests();
    assert.equal(after.has(digestOf("pending-1")), true, "pending record must stay resolvable");
    assert.equal(after.has(digestOf("acked-1")), false, "acknowledged and dropped may be pruned");
  });
});

test("is a no-op when every entry is still needed", async () => {
  await withStore(async (store) => {
    await stageAndAcknowledge(store, [event("a"), event("b")]);
    const keep = new Set([digestOf("a"), digestOf("b")]);
    assert.deepEqual(await store.pruneObservedDigests(keep), { pruned: 0, kept: 2 });
    assert.equal((await store.observedEventDigests()).size, 2);
  });
});

test("rejects a non-Set argument instead of silently pruning everything", async () => {
  await withStore(async (store) => {
    await assert.rejects(store.pruneObservedDigests(["not-a-set"]), /must be a Set/);
    await assert.rejects(store.pruneObservedDigests(undefined), /must be a Set/);
  });
});

test("collects digests only for events that carry an identity", () => {
  const digests = transcriptDigests([
    event("with-id"),
    { type: "user.message", timestamp: "2026-10-23T00:00:00Z", data: { content: "no id" } },
    { id: "   ", type: "user.message", timestamp: "2026-10-23T00:00:00Z", data: {} },
  ]);
  assert.equal(digests.size, 1);
  assert.equal(digests.has(digestOf("with-id")), true);
});

test("survives a reopen and still validates the pruned ledger", async () => {
  const root = await mkdtemp(join(tmpdir(), "ov-copilot-ledger-reopen-"));
  try {
    const first = new DurableSessionStore({ sessionId: "session-ledger", stateRoot: root });
    await first.initialize();
    await stageAndAcknowledge(first, [event("gone"), event("kept")]);
    await first.pruneObservedDigests(new Set([digestOf("kept")]));

    const reopened = new DurableSessionStore({ sessionId: "session-ledger", stateRoot: root });
    await reopened.initialize();
    const digests = await reopened.observedEventDigests();
    assert.equal(digests.size, 1);
    assert.equal(digests.has(digestOf("kept")), true);
    const raw = await readFile(join(root, first.directory.split(/[\\/]/).pop(), "observed-ids.ndjson"), "utf8");
    assert.equal(raw.trim().split("\n").length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("writing a partial line is rejected rather than trusted", async () => {
  await withStore(async (store) => {
    await stageAndAcknowledge(store, [event("a")]);
    const dir = store.observedIdsPath;
    await writeFile(dir, `${JSON.stringify({ digest: "short", payloadDigest: "0".repeat(64) })}\n`);
    await assert.rejects(store.observedEventDigests(), /Invalid observed event digest/);
    await assert.rejects(store.pruneObservedDigests(new Set()), /Invalid observed event digest/);
  });
});