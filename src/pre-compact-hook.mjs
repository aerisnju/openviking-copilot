import { createCopilotMemorySession } from "./copilot-memory-session.mjs";
import { auditPreCompactTranscript, transcriptDigests } from "./transcript-audit.mjs";
import { catchUpTranscriptTail } from "./transcript-catchup.mjs";
import { readVerifiedTranscript } from "./transcript-read.mjs";

export async function runPreCompactHook(
  input,
  {
    config,
    fetchJSON,
    store,
    openVikingSessionId,
    sessionMemoryPolicy,
    logger = () => {},
    createRuntime = createCopilotMemorySession,
    auditTranscript = auditPreCompactTranscript,
    catchUp = catchUpTranscriptTail,
    readTranscript = readVerifiedTranscript,
  },
) {
  const copilotSessionId = input?.sessionId;
  const cwd = input?.cwd;
  if (typeof copilotSessionId !== "string" || !copilotSessionId.trim()) {
    throw new TypeError("preCompact input must include a non-empty sessionId");
  }
  if (typeof cwd !== "string" || !cwd.trim()) {
    throw new TypeError("preCompact input must include a non-empty cwd");
  }
  if (config?.enabled === false || !config?.baseUrl) {
    return { ok: true, skipped: true, reason: "memory-disabled" };
  }

  const deadlineAt = Date.now() + 8_000;
  const runtime = createRuntime({
    copilotSessionId,
    openVikingSessionId,
    cwd,
    config,
    fetchJSON,
    store,
    sessionMemoryPolicy,
    logger,
  });
  try {
    await runtime.initialize();
    const flushed = await runtime.flush({ deadlineAt });
    if (flushed?.blocked) {
      const reason = flushed.reason || "capture-pending";
      logger("pre-compact-flush-blocked", { reason });
      return { ok: false, reason };
    }
    let audit = await auditTranscript(input, store, config, undefined, { includeMissing: true });
    if (
      !audit.ok &&
      audit.reason === "transcript-event-not-durable" &&
      Array.isArray(audit.missing) &&
      audit.missing.length > 0
    ) {
      // The host wrote these events before the Hook ran, so they are the live
      // race rather than missing history. Journal the tail from the transcript,
      // flush it, then re-audit. A gap beyond the catch-up bound stays refused.
      const caughtUp = await catchUp({
        missing: audit.missing,
        sessionId: copilotSessionId,
        config,
        store,
      });
      if (!caughtUp.ok) {
        logger("pre-compact-catch-up-refused", {
          reason: caughtUp.reason,
          missingCount: caughtUp.missingCount ?? audit.missingCount ?? null,
        });
        logger("pre-compact-audit-blocked", { reason: audit.reason });
        return { ok: false, reason: caughtUp.reason };
      }
      logger("pre-compact-catch-up", {
        staged: caughtUp.staged,
        missingCount: audit.missingCount ?? audit.missing?.length ?? 0,
      });
      const caughtFlush = await runtime.flush({ deadlineAt });
      if (caughtFlush?.blocked) {
        const reason = caughtFlush.reason || "capture-pending";
        logger("pre-compact-flush-blocked", { reason, after: "catch-up" });
        return { ok: false, reason };
      }
      audit = await auditTranscript(input, store, config);
    }
    if (!audit.ok) {
      logger("pre-compact-audit-blocked", { reason: audit.reason });
      return { ok: false, reason: audit.reason };
    }

    // The audit proves the ledger covers the transcript. Anything the ledger
    // still holds beyond the transcript can never be consulted again, so trim
    // it here — a long session otherwise grows one line per captured event.
    try {
      const transcript = await readTranscript(input);
      if (transcript.ok) {
        const pruned = await store.pruneObservedDigests(transcriptDigests(transcript.events));
        if (pruned.pruned > 0) logger("pre-compact-ledger-pruned", pruned);
      }
    } catch (error) {
      // Pruning is housekeeping; never let it block a verified commit.
      logger("pre-compact-ledger-prune-skipped", { name: error?.name || "Error" });
    }

    const result = await runtime.commit({ deadlineAt });
    if (!result?.ok) {
      logger("pre-compact-commit-skipped", {
        reason: result?.reason || "request-failed",
      });
    }
    return result;
  } finally {
    await runtime.close();
  }
}
