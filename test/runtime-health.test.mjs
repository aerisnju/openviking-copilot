import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DurableSessionStore } from "../src/durable-session-store.mjs";
import { normalizeCopilotEvents } from "../src/event-normalizer.mjs";
import { assessHealth, buildHealthReport } from "../src/runtime-health.mjs";

const DAY = 86_400_000;
const NOW = Date.parse("2026-10-23T12:00:00Z");

function health(overrides = {}) {
  return assessHealth({
    pendingCount: 0,
    deadLetterCount: 0,
    observedSequence: 100,
    idleMs: 0,
    remoteExists: true,
    lastCommitAt: "2026-10-23T11:00:00Z",
    pendingTokens: 0,
    now: NOW,
    ...overrides,
  });
}

test("reports ok for a healthy active session", () => {
  assert.deepEqual(health(), { status: "ok", issues: [] });
});

test("reports an error when dead letters exist", () => {
  const result = health({ deadLetterCount: 2 });
  assert.equal(result.status, "error");
  assert.equal(result.issues[0].code, "dead_letters");
});

test("treats a small in-flight queue as informational and a large one as a warning", () => {
  assert.equal(health({ pendingCount: 3 }).status, "ok");
  assert.equal(health({ pendingCount: 3 }).issues[0].severity, "info");
  const large = health({ pendingCount: 200 });
  assert.equal(large.status, "warning");
  assert.equal(large.issues[0].severity, "warning");
});

test("warns when the remote session has disappeared", () => {
  const result = health({ remoteExists: false });
  assert.equal(result.status, "warning");
  assert.equal(result.issues.some((issue) => issue.code === "remote_session_missing"), true);
});

test("does not warn about a missing remote for a never-used shell", () => {
  const result = health({ remoteExists: false, observedSequence: -1 });
  assert.equal(result.issues.some((issue) => issue.code === "remote_session_missing"), false);
});

test("warns about a stale commit only while the session is active", () => {
  const active = health({ lastCommitAt: "2026-10-10T00:00:00Z", idleMs: 60_000 });
  assert.equal(active.issues.some((issue) => issue.code === "stale_commit"), true);
  const idle = health({ lastCommitAt: "2026-10-10T00:00:00Z", idleMs: 5 * DAY });
  assert.equal(idle.issues.some((issue) => issue.code === "stale_commit"), false);
});

test("flags a very large uncommitted token count as informational", () => {
  const result = health({ pendingTokens: 25_000 });
  assert.equal(result.issues.some((issue) => issue.code === "large_pending_tokens"), true);
});

test("treats an unknown remote as neither present nor missing", () => {
  const result = health({ remoteExists: null, lastCommitAt: null });
  assert.equal(result.issues.some((issue) => issue.code === "remote_session_missing"), false);
  assert.equal(result.status, "ok");
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

test("builds a report across partitions and surfaces the worst status", async () => {
  const root = await mkdtemp(join(tmpdir(), "ov-copilot-health-"));
  try {
    await makePartition(root, "healthy-session", { events: 1, acknowledge: true });
    await makePartition(root, "pending-session", { events: 2 });
    const report = await buildHealthReport({
      stateRoot: root,
      now: Date.now(),
      remoteSession: async () => ({ exists: true, commitCount: 3, lastCommitAt: new Date().toISOString(), pendingTokens: 10 }),
    });
    assert.equal(report.sessions.length, 2);
    assert.equal(report.status, "ok");
    const pending = report.sessions.find((entry) => entry.sessionId === "pending-session");
    assert.equal(pending.pendingCount, 2);
    assert.equal(pending.issues.some((issue) => issue.code === "pending_records"), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reports unknown remote data without inventing a failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "ov-copilot-health-unknown-"));
  try {
    await makePartition(root, "session-a", { events: 1, acknowledge: true });
    const report = await buildHealthReport({
      stateRoot: root,
      remoteSession: async () => { throw new Error("network down"); },
    });
    assert.equal(report.status, "ok");
    assert.equal(report.sessions[0].remoteExists, null);
    assert.equal(report.sessions[0].issues.some((issue) => issue.code === "remote_session_missing"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("returns an ok report when no state root exists", async () => {
  const missing = join(tmpdir(), `ov-copilot-health-missing-${Date.now()}`);
  const report = await buildHealthReport({ stateRoot: missing });
  assert.equal(report.status, "ok");
  assert.deepEqual(report.sessions, []);
});