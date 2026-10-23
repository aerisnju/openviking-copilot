import { readdir, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { DurableSessionStore } from "./durable-session-store.mjs";
import { getOpenVikingSessionId } from "./copilot-memory-session.mjs";

const DEFAULT_STATE_ROOT = join(homedir(), ".openviking", "copilot", "state");
const DEFAULT_IDLE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Decide whether a local session partition can be removed.
 *
 * Partitions accumulate: a session that was created but never used, a session
 * whose remote counterpart was deleted, or a test session all leave a directory
 * behind that nothing ever cleans up. Removal is destructive, so the rules are
 * deliberately narrow — a partition is only eligible when it holds no queued
 * data AND its remote session is gone. Anything still holding pending or
 * dead-lettered records is never eligible, because deleting it would discard
 * conversation data that has not been archived.
 *
 * @returns `{ eligible: true, reason }` or `{ eligible: false, reason }`.
 */
export function evaluatePartitionForGc(
  { observedSequence, pendingCount, deadLetterCount, remoteExists, idleMs },
  { idleMs: idleThreshold = DEFAULT_IDLE_MS } = {},
) {
  if (pendingCount > 0) return { eligible: false, reason: "pending-records" };
  if (deadLetterCount > 0) return { eligible: false, reason: "dead-letters" };
  if (remoteExists) return { eligible: false, reason: "remote-session-exists" };
  // An empty shell (never observed an event) is safe immediately.
  if (observedSequence < 0) return { eligible: true, reason: "never-used" };
  if (idleMs < idleThreshold) return { eligible: false, reason: "recently-active" };
  return { eligible: true, reason: "remote-gone-and-idle" };
}

/**
 * List every local partition with the facts GC needs, without deleting anything.
 *
 * `remoteExists` is injected so the caller controls network access; a failure to
 * determine it must be treated as "exists" (keep the partition).
 */
export async function surveyPartitions({
  stateRoot = DEFAULT_STATE_ROOT,
  remoteExists = async () => null,
  now = Date.now(),
} = {}) {
  const root = resolve(stateRoot);
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }

  const partitions = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const directory = join(root, entry.name);
    let state;
    try {
      state = JSON.parse(await readFile(join(directory, "state.json"), "utf8"));
    } catch {
      continue;
    }
    if (typeof state.sourceSessionId !== "string" || !state.sourceSessionId) continue;
    if (createHash("sha256").update(state.sourceSessionId).digest("hex") !== entry.name) continue;

    const store = new DurableSessionStore({ sessionId: state.sourceSessionId, stateRoot: root });
    let snapshot;
    try {
      snapshot = await store.snapshot();
    } catch {
      // Unreadable partitions are reported but never auto-removed.
      partitions.push({
        directory: entry.name,
        sessionId: state.sourceSessionId,
        unreadable: true,
      });
      continue;
    }
    const updatedAt = Date.parse(state.updatedAt || "");
    const idleMs = Number.isFinite(updatedAt) ? now - updatedAt : 0;
    const remoteId = getOpenVikingSessionId(state.sourceSessionId);
    let exists = null;
    try {
      exists = await remoteExists(remoteId);
    } catch {
      exists = null;
    }
    const decision = evaluatePartitionForGc({
      observedSequence: snapshot.lastObservedSequence,
      pendingCount: snapshot.pendingCount,
      deadLetterCount: snapshot.deadLetterCount,
      // Unknown remote state must not authorise deletion.
      remoteExists: exists === null ? true : exists,
      idleMs,
    });
    partitions.push({
      directory: entry.name,
      sessionId: state.sourceSessionId,
      observedSequence: snapshot.lastObservedSequence,
      pendingCount: snapshot.pendingCount,
      deadLetterCount: snapshot.deadLetterCount,
      idleDays: Math.floor(idleMs / 86_400_000),
      remoteExists: exists,
      ...decision,
    });
  }
  return partitions;
}

/**
 * Remove the partitions a survey marked eligible.
 *
 * Only directories the survey itself listed and marked eligible are removed, so
 * a caller cannot pass an arbitrary path. The live session is protected by the
 * caller passing `keepSessionIds`.
 */
export async function collectPartitions({
  stateRoot = DEFAULT_STATE_ROOT,
  remoteExists = async () => null,
  now = Date.now(),
  keepSessionIds = [],
} = {}) {
  const keep = new Set(keepSessionIds);
  const partitions = await surveyPartitions({ stateRoot, remoteExists, now });
  const root = resolve(stateRoot);
  const removed = [];
  const kept = [];
  for (const partition of partitions) {
    if (!partition.eligible || keep.has(partition.sessionId) || partition.unreadable) {
      kept.push({
        sessionId: partition.sessionId,
        reason: partition.unreadable ? "unreadable" : keep.has(partition.sessionId) ? "protected" : partition.reason,
      });
      continue;
    }
    await rm(join(root, partition.directory), { recursive: true, force: true });
    removed.push({ sessionId: partition.sessionId, reason: partition.reason });
  }
  return { removed, kept };
}