import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import test from "node:test";
import { DurableSessionStore } from "../src/durable-session-store.mjs";
import { normalizeCopilotEvents } from "../src/event-normalizer.mjs";
import { collectPartitions, evaluatePartitionForGc, surveyPartitions } from "../src/session-gc.mjs";

const DAY = 86_400_000;

function base(overrides = {}) {
  return {
    observedSequence: 10,
    pendingCount: 0,
    deadLetterCount: 0,
    remoteExists: false,
    idleMs: 30 * DAY,
    ...overrides,
  };
}

test("never removes a partition that still holds queued data", () => {
  assert.deepEqual(evaluatePartitionForGc(base({ pendingCount: 1 })), {
    eligible: false,
    reason: "pending-records",
  });
  assert.deepEqual(evaluatePartitionForGc(base({ deadLetterCount: 1 })), {
    eligible: false,
    reason: "dead-letters",
  });
});

test("keeps a partition whose remote session still exists", () => {
  assert.deepEqual(evaluatePartitionForGc(base({ remoteExists: true })), {
    eligible: false,
    reason: "remote-session-exists",
  });
});

test("keeps a recently active partition even when the remote is gone", () => {
  assert.deepEqual(evaluatePartitionForGc(base({ idleMs: 2 * DAY })), {
    eligible: false,
    reason: "recently-active",
  });
});

test("removes an idle partition whose remote is gone", () => {
  assert.deepEqual(evaluatePartitionForGc(base()), {
    eligible: true,
    reason: "remote-gone-and-idle",
  });
});

test("removes an empty shell immediately", () => {
  assert.deepEqual(evaluatePartitionForGc(base({ observedSequence: -1, idleMs: 0 })), {
    eligible: true,
    reason: "never-used",
  });
});

async function makePartition(root, sessionId, { events = 0, acknowledge = false } = {}) {
  const store = new DurableSessionStore({ sessionId, stateRoot: root });
  await store.initialize();
  if (events > 0) {
    const list = Array.from({ length: events }, (_, index) => ({
      id: `${sessionId}-${index}`,
      type: "user.message",
      timestamp: "2026-10-23T00:00:00Z",
      data: { content: `event ${index}`, messageId: `${sessionId}-${index}` },
    }));
    const records = normalizeCopilotEvents(list, sessionId);
    for (const record of records) await store.stage(record);
    if (acknowledge) await store.acknowledgeThrough(records.at(-1).sourceSequence);
  }
  return store;
}

test("surveys partitions and treats an unknown remote as present", async () => {
  const root = await mkdtemp(join(tmpdir(), "ov-copilot-gc-"));
  try {
    await makePartition(root, "empty-shell");
    await makePartition(root, "unknown-remote", { events: 1, acknowledge: true });
    // Every remote lookup fails to resolve: nothing may be authorised by that.
    const unknownAll = await surveyPartitions({
      stateRoot: root,
      remoteExists: async () => null,
    });
    const unknown = unknownAll.find((entry) => entry.sessionId === "unknown-remote");
    assert.equal(unknown.eligible, false, "an unknown remote must not authorise deletion");
    assert.equal(unknown.reason, "remote-session-exists");

    // When the remote is confirmed absent the same partition becomes eligible
    // only once it is also idle long enough.
    const absentAll = await surveyPartitions({
      stateRoot: root,
      remoteExists: async () => false,
      now: Date.now() + 40 * DAY,
    });
    const shell = absentAll.find((entry) => entry.sessionId === "empty-shell");
    assert.equal(shell.eligible, true);
    assert.equal(shell.reason, "never-used");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("protects the live session and removes only eligible partitions", async () => {
  const root = await mkdtemp(join(tmpdir(), "ov-copilot-gc-collect-"));
  try {
    await makePartition(root, "live-session", { events: 1, acknowledge: true });
    await makePartition(root, "orphan", { events: 1, acknowledge: true });
    const { removed, kept } = await collectPartitions({
      stateRoot: root,
      remoteExists: async () => false,
      now: Date.now() + 40 * DAY,
      keepSessionIds: ["live-session"],
    });
    assert.equal(removed.some((entry) => entry.sessionId === "orphan"), true);
    assert.equal(removed.some((entry) => entry.sessionId === "live-session"), false);
    assert.equal(kept.some((entry) => entry.sessionId === "live-session" && entry.reason === "protected"), true);
    const remaining = await readdir(root);
    assert.equal(remaining.length, 1, "only the protected live partition should remain");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("keeps a partition that still has unacknowledged records", async () => {
  const root = await mkdtemp(join(tmpdir(), "ov-copilot-gc-pending-"));
  try {
    await makePartition(root, "pending-session", { events: 2 });
    const surveyed = await surveyPartitions({
      stateRoot: root,
      remoteExists: async () => false,
      now: Date.now() + 40 * DAY,
    });
    assert.equal(surveyed[0].pendingCount, 2);
    assert.equal(surveyed[0].eligible, false);
    assert.equal(surveyed[0].reason, "pending-records");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("returns an empty survey when no state root exists", async () => {
  const missing = join(tmpdir(), `ov-copilot-gc-missing-${Date.now()}`);
  assert.deepEqual(await surveyPartitions({ stateRoot: missing }), []);
});

test("ignores directories that are not session partitions", async () => {
  const root = await mkdtemp(join(tmpdir(), "ov-copilot-gc-noise-"));
  try {
    await mkdir(join(root, "not-a-session"), { recursive: true });
    await makePartition(root, "real-session");
    const surveyed = await surveyPartitions({ stateRoot: root });
    assert.equal(surveyed.length, 1);
    assert.equal(surveyed[0].sessionId, "real-session");
    // The identity hash must match the directory name, as elsewhere.
    assert.equal(
      createHash("sha256").update("real-session").digest("hex"),
      surveyed[0].directory,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});