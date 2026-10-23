import { createHash } from "node:crypto";
import { normalizeCopilotEvents } from "./event-normalizer.mjs";
import { readVerifiedTranscript } from "./transcript-read.mjs";

const MAX_COMPACTION_BOUNDARY_SKEW_MS = 2_000;

/**
 * The digests the current transcript still needs the ledger to explain.
 *
 * Used to prune the ledger after a successful audit: an entry for an event that
 * is no longer in the transcript can never be consulted again.
 */
export function transcriptDigests(events) {
  const digests = new Set();
  for (const event of events) {
    if (typeof event?.id !== "string" || !event.id.trim()) continue;
    digests.add(createHash("sha256").update(event.id).digest("hex"));
  }
  return digests;
}

function captureOptions(config) {
  return {
    captureFilters: config?.captureFilters,
    captureMaxLength: config?.captureMaxLength,
    captureToolMaxChars: config?.captureToolMaxChars,
    captureToolResults: config?.captureToolResults === true,
    excludedTools: config?.excludedTools ?? [],
  };
}

function collectExcludedCallIds(events, excludedTools) {
  const ids = new Set();
  if (!Array.isArray(excludedTools) || excludedTools.length === 0) return ids;
  for (const event of events) {
    if (event?.type !== "tool.execution_start") continue;
    const name = typeof event.data?.toolName === "string" ? event.data.toolName : "";
    const id = typeof event.data?.toolCallId === "string" ? event.data.toolCallId : "";
    if (!name || !id) continue;
    const excluded = excludedTools.some((pattern) => {
      const value = String(pattern || "").trim();
      if (!value) return false;
      return value.endsWith("*") ? name.startsWith(value.slice(0, -1)) : name === value;
    });
    if (excluded) ids.add(id);
  }
  return ids;
}

/**
 * Compare the transcript-visible events through the compaction boundary with
 * the durable digest ledger.
 *
 * Returns the missing events rather than only failing, so the caller can try a
 * bounded catch-up. A missing event here means the host had already written it
 * to the transcript before the Hook ran — exactly the window this gate exists
 * to close.
 *
 * @returns `{ ok: true, checked }` or
 *          `{ ok: false, reason, checked?, missing?, missingCount? }`.
 */
export async function auditPreCompactTranscript(
  input,
  store,
  config,
  copilotHome = process.env.COPILOT_HOME,
  { includeMissing = false } = {},
) {
  if (!Number.isSafeInteger(input?.timestamp)) {
    return { ok: false, reason: "compaction-boundary-unverified" };
  }
  const transcript = await readVerifiedTranscript(input, copilotHome);
  if (!transcript.ok) return { ok: false, reason: transcript.reason };

  const observed = await store.observedEventDigests();
  const capture = captureOptions(config);
  const excludedCallIds = collectExcludedCallIds(transcript.events, capture.excludedTools);
  let checked = 0;
  let compactionStart = null;
  const missing = [];

  for (const event of transcript.events) {
    const eventTime = Date.parse(event?.timestamp);
    if (event?.type === "session.compaction_start" && eventTime <= input.timestamp) {
      compactionStart = eventTime;
    }
    if (Number.isFinite(input.timestamp) && eventTime > input.timestamp) continue;

    const [record] = normalizeCopilotEvents([event], input.sessionId, {
      ...capture,
      excludedCallIds,
    });
    if (!record) continue;
    if (typeof event.id !== "string" || !event.id.trim()) {
      return { ok: false, reason: "transcript-event-identity-missing" };
    }
    checked += 1;
    const digest = createHash("sha256").update(event.id).digest("hex");
    if (observed.get(digest) !== record.payloadDigest) {
      missing.push({ event, record });
    }
  }

  if (
    !Number.isFinite(compactionStart) ||
    compactionStart > input.timestamp ||
    input.timestamp - compactionStart > MAX_COMPACTION_BOUNDARY_SKEW_MS
  ) {
    return { ok: false, reason: "compaction-boundary-unverified" };
  }

  if (missing.length > 0) {
    return includeMissing
      ? {
          ok: false,
          reason: "transcript-event-not-durable",
          checked,
          missingCount: missing.length,
          missing,
        }
      : { ok: false, reason: "transcript-event-not-durable", checked };
  }
  return { ok: true, checked };
}

export { MAX_COMPACTION_BOUNDARY_SKEW_MS };