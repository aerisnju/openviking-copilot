import { createHash } from "node:crypto";
import { normalizeCopilotEvents } from "./event-normalizer.mjs";

/**
 * Largest tail of already-transcripted events this path will ingest.
 *
 * The point is to close the live race — the host wrote an event to
 * `events.jsonl` moments before the Hook ran, and the extension had not yet
 * journaled it. A larger gap is not that race: it means the session was
 * captured by an earlier process, resumed, or otherwise diverged, and silently
 * importing it would be historical replay. Replay is deliberately out of scope
 * for version 1 because host event identity across reload/resume is unproven,
 * so an oversized gap is refused rather than guessed at.
 */
export const MAX_CATCH_UP_EVENTS = 16;

function toDurableRecords(missing, sessionId, config, startSequence) {
  const events = missing.map((entry) => entry.event);
  return normalizeCopilotEvents(events, sessionId, {
    startSequence,
    captureFilters: config?.captureFilters,
    captureMaxLength: config?.captureMaxLength,
    captureToolMaxChars: config?.captureToolMaxChars,
    captureToolResults: config?.captureToolResults === true,
  });
}

/**
 * Journal events that the transcript proves the host had already written.
 *
 * The transcript is the authority here: an event is only staged when the host
 * itself recorded it before the Hook ran, which is strictly better evidence
 * than anything the extension observed in memory. Staging goes through the same
 * durable store as live capture, so ordering, deduplication, and the digest
 * ledger all apply.
 *
 * @returns `{ ok: true, staged }`, or `{ ok: false, reason, ... }` when the gap
 *          is too large to be the live race or the store refused a record.
 */
export async function catchUpTranscriptTail({
  missing,
  sessionId,
  config,
  store,
  maxEvents = MAX_CATCH_UP_EVENTS,
}) {
  if (!Array.isArray(missing) || missing.length === 0) {
    return { ok: true, staged: 0 };
  }
  if (missing.length > maxEvents) {
    return { ok: false, reason: "catch-up-too-large", missingCount: missing.length, maxEvents };
  }

  // Re-check the ledger instead of trusting the caller's snapshot: a second
  // invocation for the same boundary must not re-stage records that already
  // landed, and a sequence computed from a stale cursor would conflict.
  const observed = await store.observedEventDigests();
  const pending = missing.filter((entry) => {
    const digest = createHash("sha256").update(String(entry?.event?.id)).digest("hex");
    return !observed.has(digest);
  });
  if (pending.length === 0) return { ok: true, staged: 0 };

  const snapshot = await store.snapshot();
  const records = toDurableRecords(pending, sessionId, config, snapshot.lastObservedSequence + 1);
  if (records.length !== pending.length) {
    // Normalization must be deterministic: an event the audit counted as
    // capturable must produce exactly one record here.
    return { ok: false, reason: "catch-up-normalization-mismatch" };
  }

  let staged = 0;
  try {
    for (const record of records) {
      const outcome = await store.stage(record);
      if (outcome?.status === "staged") staged += 1;
    }
  } catch (error) {
    return { ok: false, reason: "catch-up-stage-failed", name: error?.name || "Error" };
  }
  return { ok: true, staged };
}