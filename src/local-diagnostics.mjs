import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { DurableSessionStore } from "./durable-session-store.mjs";

const DEFAULT_STATE_ROOT = join(homedir(), ".openviking", "copilot", "state");

function sessionDirectoryName(sessionId) {
  return createHash("sha256").update(sessionId).digest("hex");
}

async function readState(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function safeDiagnosticError(error) {
  if (error?.code) return String(error.code);
  if (error?.name === "SyntaxError" || error?.name === "TypeError") {
    return "InvalidState";
  }
  if (/^Timed out waiting/.test(error?.message || "")) {
    return "LockUnavailable";
  }
  if (/^(Session (identity|state|journal)|Invalid (journal|dead-letter|discarded))/.test(error?.message || "")) {
    return "InvalidState";
  }
  return error?.name || "LocalError";
}

export async function listLocalSessionDiagnostics({
  stateRoot = DEFAULT_STATE_ROOT,
} = {}) {
  const root = resolve(stateRoot);
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }

  const sessions = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const directory = join(root, entry.name);
    try {
      const state = await readState(join(directory, "state.json"));
      if (
        typeof state.sourceSessionId !== "string" ||
        !state.sourceSessionId ||
        sessionDirectoryName(state.sourceSessionId) !== entry.name
      ) {
        throw Object.assign(
          new Error("Session identity does not match state directory"),
          { code: "InvalidState" },
        );
      }
      const store = new DurableSessionStore({
        sessionId: state.sourceSessionId,
        stateRoot: root,
      });
      const snapshot = await store.snapshot();
      const subagentSessions = (await store.subagentSessions()).map((child) => ({
        agentIdHash: child.agentIdHash,
        status: child.status,
      }));
      sessions.push({
        sessionId: state.sourceSessionId,
        status:
          snapshot.deadLetterCount > 0
            ? "blocked"
            : snapshot.pendingCount > 0
              ? "pending"
              : "clear",
        lastObservedSequence: snapshot.lastObservedSequence,
        lastAcknowledgedSequence: snapshot.lastAcknowledgedSequence,
        lastResolvedSequence: snapshot.lastResolvedSequence,
        pendingCount: snapshot.pendingCount,
        pendingBytes: snapshot.pendingBytes,
        deadLetterCount: snapshot.deadLetterCount,
        deadLetterSequences: snapshot.deadLetterSequences,
        discardedCount: snapshot.discardedCount,
        discardedSequences: snapshot.discardedSequences,
        subagentSessions,
        updatedAt: snapshot.updatedAt,
      });
    } catch (error) {
      sessions.push({
        stateDirectoryId: entry.name,
        status: "unreadable",
        error: safeDiagnosticError(error),
      });
    }
  }
  return sessions.sort((left, right) => {
    const leftDate = Date.parse(left.updatedAt || "") || 0;
    const rightDate = Date.parse(right.updatedAt || "") || 0;
    return rightDate - leftDate || String(left.sessionId || left.stateDirectoryId)
      .localeCompare(String(right.sessionId || right.stateDirectoryId));
  });
}

export function summarizeLocalSessionDiagnostics(sessions) {
  const summary = {
    sessionCount: 0,
    clearSessionCount: 0,
    pendingSessionCount: 0,
    blockedSessionCount: 0,
    unreadableSessionCount: 0,
    pendingRecordCount: 0,
    pendingBytes: 0,
    deadLetterRecordCount: 0,
    discardedRecordCount: 0,
    subagentSessionCount: 0,
    subagentRecoveryRequiredCount: 0,
  };
  for (const session of Array.isArray(sessions) ? sessions : []) {
    if (session.status === "unreadable") {
      summary.unreadableSessionCount += 1;
      continue;
    }
    summary.sessionCount += 1;
    if (session.status === "clear") summary.clearSessionCount += 1;
    if (session.status === "pending") summary.pendingSessionCount += 1;
    if (session.status === "blocked") summary.blockedSessionCount += 1;
    summary.pendingRecordCount += session.pendingCount;
    summary.pendingBytes += session.pendingBytes;
    summary.deadLetterRecordCount += session.deadLetterCount;
    summary.discardedRecordCount += session.discardedCount || 0;
    const children = Array.isArray(session.subagentSessions) ? session.subagentSessions : [];
    summary.subagentSessionCount += children.length;
    summary.subagentRecoveryRequiredCount += children.filter(
      (child) => child.status === "orphaned" || child.status === "commit_unknown",
    ).length;
  }
  return summary;
}

export async function exportLocalSessionRecoveryBundle({
  sessionId,
  stateRoot = DEFAULT_STATE_ROOT,
} = {}) {
  if (typeof sessionId !== "string" || !sessionId.trim()) {
    throw new TypeError("sessionId must be a non-empty string");
  }
  const store = new DurableSessionStore({
    sessionId,
    stateRoot: resolve(stateRoot),
  });
  const bundle = await store.exportRecoveryBundle();
  return {
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    sessionId,
    ...bundle,
  };
}

export async function retryLocalSessionDeadLetter({
  sessionId,
  sequence,
  stateRoot = DEFAULT_STATE_ROOT,
} = {}) {
  if (typeof sessionId !== "string" || !sessionId.trim()) {
    throw new TypeError("sessionId must be a non-empty string");
  }
  if (!Number.isSafeInteger(sequence) || sequence < 0) {
    throw new TypeError("sequence must be a non-negative safe integer");
  }
  const store = new DurableSessionStore({
    sessionId,
    stateRoot: resolve(stateRoot),
  });
  return store.retryDeadLetter(sequence);
}

export async function discardLocalSessionDeadLetter({
  sessionId,
  sequence,
  stateRoot = DEFAULT_STATE_ROOT,
} = {}) {
  if (typeof sessionId !== "string" || !sessionId.trim()) {
    throw new TypeError("sessionId must be a non-empty string");
  }
  if (!Number.isSafeInteger(sequence) || sequence < 0) {
    throw new TypeError("sequence must be a non-negative safe integer");
  }
  const store = new DurableSessionStore({
    sessionId,
    stateRoot: resolve(stateRoot),
  });
  return store.discardDeadLetter(sequence);
}
