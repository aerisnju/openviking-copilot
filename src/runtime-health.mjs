import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { DurableSessionStore } from "./durable-session-store.mjs";
import { getOpenVikingSessionId } from "./copilot-memory-session.mjs";

const DEFAULT_STATE_ROOT = join(homedir(), ".openviking", "copilot", "state");
const DAY = 86_400_000;

/**
 * Turn raw partition facts into a small set of health verdicts.
 *
 * Host logs rotate in about three days, so "no errors in the log" says little
 * about a session that has been running for weeks. These verdicts are derived
 * from durable local state and remote session metadata instead, which survive
 * log rotation.
 */
export function assessHealth({
  pendingCount,
  deadLetterCount,
  observedSequence,
  idleMs,
  remoteExists,
  lastCommitAt,
  pendingTokens,
  now = Date.now(),
}) {
  const issues = [];
  if (deadLetterCount > 0) {
    issues.push({ severity: "error", code: "dead_letters", count: deadLetterCount });
  }
  if (pendingCount > 0) {
    // A few records in flight is normal; a large or long-standing queue is not.
    issues.push({
      severity: pendingCount > 50 ? "warning" : "info",
      code: "pending_records",
      count: pendingCount,
    });
  }
  if (remoteExists === false && observedSequence >= 0) {
    issues.push({ severity: "warning", code: "remote_session_missing" });
  }
  if (remoteExists === true && lastCommitAt) {
    const commitAge = now - Date.parse(lastCommitAt);
    if (Number.isFinite(commitAge) && commitAge > 7 * DAY && idleMs < DAY) {
      issues.push({ severity: "warning", code: "stale_commit", ageDays: Math.floor(commitAge / DAY) });
    }
  }
  if (remoteExists === true && Number(pendingTokens) > 20_000) {
    issues.push({ severity: "info", code: "large_pending_tokens", pendingTokens });
  }
  const status = issues.some((issue) => issue.severity === "error")
    ? "error"
    : issues.some((issue) => issue.severity === "warning")
      ? "warning"
      : "ok";
  return { status, issues };
}

/**
 * Build a health report for every local partition.
 *
 * `remoteSession` is injected so the caller controls network access; returning
 * null means "could not determine", which is reported as unknown rather than as
 * a failure.
 */
export async function buildHealthReport({
  stateRoot = DEFAULT_STATE_ROOT,
  remoteSession = async () => null,
  now = Date.now(),
} = {}) {
  const root = resolve(stateRoot);
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return { status: "ok", sessions: [], generatedAt: new Date(now).toISOString() };
    throw error;
  }

  const sessions = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const directory = join(root, entry.name);
    let state;
    try {
      state = JSON.parse(await readFile(join(directory, "state.json"), "utf8"));
    } catch {
      sessions.push({ stateDirectoryId: entry.name, status: "unreadable", issues: [{ severity: "warning", code: "unreadable_state" }] });
      continue;
    }
    if (typeof state.sourceSessionId !== "string" || !state.sourceSessionId) continue;

    const store = new DurableSessionStore({ sessionId: state.sourceSessionId, stateRoot: root });
    let snapshot;
    try {
      snapshot = await store.snapshot();
    } catch {
      sessions.push({ sessionId: state.sourceSessionId, status: "unreadable", issues: [{ severity: "warning", code: "unreadable_state" }] });
      continue;
    }

    let remote = null;
    try {
      remote = await remoteSession(getOpenVikingSessionId(state.sourceSessionId));
    } catch {
      remote = null;
    }
    const updatedAt = Date.parse(state.updatedAt || "");
    const idleMs = Number.isFinite(updatedAt) ? now - updatedAt : 0;
    const verdict = assessHealth({
      pendingCount: snapshot.pendingCount,
      deadLetterCount: snapshot.deadLetterCount,
      observedSequence: snapshot.lastObservedSequence,
      idleMs,
      remoteExists: remote ? remote.exists : null,
      lastCommitAt: remote?.lastCommitAt || null,
      pendingTokens: remote?.pendingTokens ?? 0,
      now,
    });
    sessions.push({
      sessionId: state.sourceSessionId,
      observedSequence: snapshot.lastObservedSequence,
      acknowledgedSequence: snapshot.lastAcknowledgedSequence,
      pendingCount: snapshot.pendingCount,
      deadLetterCount: snapshot.deadLetterCount,
      idleDays: Math.floor(idleMs / DAY),
      remoteExists: remote ? remote.exists : null,
      commitCount: remote?.commitCount ?? null,
      lastCommitAt: remote?.lastCommitAt ?? null,
      ...verdict,
    });
  }

  sessions.sort((left, right) => String(right.observedSequence ?? -1).localeCompare(String(left.observedSequence ?? -1)));
  const status = sessions.some((session) => session.status === "error")
    ? "error"
    : sessions.some((session) => session.status === "warning")
      ? "warning"
      : "ok";
  return { status, sessions, generatedAt: new Date(now).toISOString() };
}