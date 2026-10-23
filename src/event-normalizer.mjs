import { createHash } from "node:crypto";
import {
  shapeCapturePayload,
  truncateCaptureText,
} from "../vendor/openviking-memory-plugin-shared/lib/capture-utils.mjs";

const SECRET_KEY = /(?:authorization|api[-_]?key|access[-_]?token|refresh[-_]?token|password|passwd|secret|credential)/i;
const PRIVATE_EVENT_TYPES = new Set([
  "assistant.reasoning",
  "model.message",
  "model.messages_snapshot",
  "model.response",
  "system.message",
]);
const MAX_TEXT_CHARS = 24_000;
const MAX_TOOL_CHARS = 100_000;

function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function digest(value) {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function redactText(value) {
  return String(value)
    .replace(
      /\b(api[-_]?key|access[-_]?token|refresh[-_]?token|password|passwd|secret|authorization)\b(\s*[:=]\s*)(?:Bearer\s+)?(?:"[^"]*"|'[^']*'|[^\s,;&]+)/gi,
      "$1$2[REDACTED]",
    )
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [REDACTED]")
    .replace(
      /\b(api[-_]?key|access[-_]?token|refresh[-_]?token|password|passwd|secret|authorization)\b(\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;&]+)/gi,
      "$1$2[REDACTED]",
    );
}

function redactSensitive(value, depth = 0) {
  if (typeof value === "string") return truncateCaptureText(redactText(value), MAX_TOOL_CHARS);
  if (Array.isArray(value)) {
    return value.slice(0, 1000).map((item) => redactSensitive(item, depth + 1));
  }
  if (!value || typeof value !== "object" || depth >= 20) return value;
  return Object.fromEntries(
    Object.entries(value).slice(0, 1000).map(([key, item]) => [
      key,
      SECRET_KEY.test(key) ? "[REDACTED]" : redactSensitive(item, depth + 1),
    ]),
  );
}

function normalizeTime(value) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return null;
  return new Date(value).toISOString();
}

function boundedId(value, maxLength = 512) {
  return typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= maxLength
    ? value
    : null;
}

function stringifyToolOutput(value) {
  const safeValue = redactSensitive(value);
  const text = typeof safeValue === "string" ? safeValue : JSON.stringify(safeValue);
  return truncateCaptureText(text ?? "", MAX_TOOL_CHARS);
}

function contentParts(content, role, config) {
  if (content === undefined || content === null) return [];
  const shaped = shapeCapturePayload(
    { content },
    role,
    {
      captureFilters: config.captureFilters,
      captureMaxLength: config.captureMaxLength || MAX_TEXT_CHARS,
      captureToolMaxChars: config.captureToolMaxChars || MAX_TOOL_CHARS,
    },
    { faithful: true },
  );
  if (shaped.dropped) return [];
  return shaped.parts
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => ({ type: "text", text: redactText(part.text) }))
    .filter((part) => part.text.length > 0);
}

function makeRecord(event, sourceSessionId, sourceSequence, kind, actor, payload, parentOperationId) {
  const identityFields = {
    sourceSessionId,
    sourceSequence,
    eventType: event.type,
    occurredAt: normalizeTime(event.timestamp),
    kind,
    actor,
    parentOperationId: parentOperationId || null,
    payload,
  };
  const sourceEventId =
    boundedId(event.id)
      ? event.id
      : `sha256:${digest(identityFields)}`;
  const record = {
    ...identityFields,
    sourceEventId,
  };
  record.payloadDigest = digest(record.payload);
  return record;
}

export function isExcludedTool(toolName, excluded) {
  if (!Array.isArray(excluded) || excluded.length === 0) return false;
  const name = String(toolName || "");
  if (!name) return false;
  return excluded.some((pattern) => {
    const value = String(pattern || "").trim();
    if (!value) return false;
    // A trailing `*` is a prefix match; anything else must match exactly, so a
    // typo in configuration cannot silently broaden the exclusion.
    return value.endsWith("*") ? name.startsWith(value.slice(0, -1)) : name === value;
  });
}

/**
 * Resolve which tool calls belong to an excluded tool.
 *
 * Completion events carry only a call ID, so the decision has to be made on the
 * start event and carried to the matching completion.
 */
function collectExcludedCallIds(events, excludedTools) {
  const ids = new Set();
  if (!Array.isArray(excludedTools) || excludedTools.length === 0) return ids;
  for (const event of events) {
    if (event?.type !== "tool.execution_start") continue;
    const toolCallId = boundedId(event.data?.toolCallId);
    if (toolCallId && isExcludedTool(event.data?.toolName, excludedTools)) {
      ids.add(toolCallId);
    }
  }
  return ids;
}

function normalizeOne(event, sourceSessionId, sourceSequence, config) {
  if (
    !event ||
    typeof event !== "object" ||
    typeof event.type !== "string" ||
    event.ephemeral === true ||
    PRIVATE_EVENT_TYPES.has(event.type) ||
    event.type.startsWith("model.") ||
    event.type.startsWith("hook.") ||
    event.type.startsWith("system.")
  ) {
    return null;
  }

  const data = event.data && typeof event.data === "object" ? event.data : {};
  switch (event.type) {
    case "user.message": {
      const parts = contentParts(data.content, "user", config);
      if (parts.length === 0) return null;
      return makeRecord(
        event,
        sourceSessionId,
        sourceSequence,
        "user_message",
        "user",
        { parts, turnId: boundedId(data.turnId) },
        boundedId(data.messageId) ?? boundedId(event.parentId),
      );
    }
    case "assistant.message": {
      const phase = typeof data.phase === "string" ? data.phase.toLowerCase() : "";
      if (phase && !["final", "commentary", "complete", "completion"].includes(phase)) {
        return null;
      }
      const parts = contentParts(data.content, "assistant", config);
      if (parts.length === 0) return null;
      return makeRecord(
        event,
        sourceSessionId,
        sourceSequence,
        "assistant_message",
        "assistant",
        { parts, turnId: boundedId(data.turnId) },
        boundedId(data.messageId) ?? boundedId(event.parentId),
      );
    }
    case "tool.execution_start": {
      const toolCallId = boundedId(data.toolCallId);
      const toolName = boundedId(data.toolName, 256);
      if (!toolCallId || !toolName) return null;
      if (isExcludedTool(toolName, config.excludedTools)) return null;
      const payload = {
        type: "tool",
        tool_id: toolCallId,
        tool_name: toolName,
        tool_status: "running",
        tool_input: redactSensitive(data.arguments ?? {}),
      };
      return makeRecord(
        event,
        sourceSessionId,
        sourceSequence,
        "tool_call",
        "tool",
        { parts: [payload], turnId: boundedId(data.turnId) },
        toolCallId,
      );
    }
    case "tool.execution_complete": {
      const toolCallId = boundedId(data.toolCallId);
      if (!toolCallId) return null;
      if (config.excludedCallIds?.has(toolCallId)) return null;
      const payload = {
        type: "tool",
        tool_id: toolCallId,
        tool_status: data.success === false ? "error" : "completed",
      };
      if (config.captureToolResults === true) {
        payload.tool_output = stringifyToolOutput(data.result ?? "");
      }
      return makeRecord(
        event,
        sourceSessionId,
        sourceSequence,
        data.success === false ? "tool_error" : "tool_result",
        "tool",
        { parts: [payload], turnId: boundedId(data.turnId) },
        toolCallId,
      );
    }
    case "assistant.turn_end":
      return makeRecord(
        event,
        sourceSessionId,
        sourceSequence,
        "turn_boundary",
        "assistant",
        { turnId: boundedId(data.turnId) },
        boundedId(event.parentId),
      );
    case "subagent.started":
    case "subagent.completed":
      return makeRecord(
        event,
        sourceSessionId,
        sourceSequence,
        event.type === "subagent.completed" ? "subagent_complete" : "subagent_start",
        "subagent",
        { lifecycleEvent: event.type },
        boundedId(event.parentId),
      );
    default:
      return null;
  }
}

/**
 * Normalize only user-visible Copilot event types; reasoning and model-internal
 * events are deliberately excluded. Sequence numbers count emitted records.
 */
export function normalizeCopilotEvents(events, sourceSessionId, {
  startSequence = 0,
  captureFilters = [],
  captureMaxLength = MAX_TEXT_CHARS,
  captureToolMaxChars = MAX_TOOL_CHARS,
  captureToolResults = false,
  excludedTools = [],
  excludedCallIds: excludedCallIdsInput,
} = {}) {
  if (
    typeof sourceSessionId !== "string" ||
    !sourceSessionId.trim() ||
    sourceSessionId.length > 1024
  ) {
    throw new TypeError("sourceSessionId must be a non-empty string");
  }
  if (!Array.isArray(events)) throw new TypeError("events must be an array");
  if (!Number.isSafeInteger(startSequence) || startSequence < 0) {
    throw new TypeError("startSequence must be a non-negative safe integer");
  }

  const records = [];
  // Tool completions carry only a call ID, so the exclusion decision made on
  // the matching start event has to be carried across. A caller that already
  // resolved the set (the transcript audit, which sees events one at a time)
  // passes it in.
  const excludedCallIds = excludedCallIdsInput ?? collectExcludedCallIds(events, excludedTools);
  for (const event of events) {
    const record = normalizeOne(event, sourceSessionId, startSequence + records.length, {
      captureFilters,
      captureMaxLength,
      captureToolMaxChars,
      captureToolResults,
      excludedTools,
      excludedCallIds,
    });
    if (record) records.push(record);
  }
  return records;
}
