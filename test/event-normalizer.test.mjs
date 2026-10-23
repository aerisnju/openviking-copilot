import assert from "node:assert/strict";
import test from "node:test";
import { normalizeCopilotEvents } from "../src/event-normalizer.mjs";

test("normalizes visible conversation and correlated tool events only", () => {
  const events = [
    { type: "system.message", id: "sys-1", data: { content: "hidden" } },
    { type: "assistant.reasoning", id: "reason-1", data: { content: "private" } },
    {
      type: "assistant.message",
      id: "analysis-1",
      data: { phase: "analysis", content: "internal" },
    },
    {
      type: "user.message",
      id: "user-1",
      timestamp: "2026-09-30T12:00:00Z",
      data: { content: "Please use api_key=abc123 to connect.", turnId: "turn-1" },
    },
    {
      type: "tool.execution_start",
      id: "tool-start-1",
      data: {
        toolCallId: "call-1",
        toolName: "fetch",
        arguments: { api_key: "do-not-store", query: "Bearer hidden-token" },
      },
    },
    {
      type: "tool.execution_complete",
      id: "tool-done-1",
      data: {
        toolCallId: "call-1",
        success: true,
        result: { access_token: "do-not-store", status: "ok" },
      },
    },
    {
      type: "assistant.message",
      id: "assistant-1",
      data: { phase: "final", content: "The request completed successfully." },
    },
    { type: "assistant.turn_end", id: "turn-end-1", data: { turnId: "turn-1" } },
    {
      type: "user.message",
      id: "ephemeral-1",
      ephemeral: true,
      data: { content: "not captured" },
    },
  ];

  const records = normalizeCopilotEvents(events, "copilot-session", {
    captureToolResults: true,
  });
  assert.deepEqual(
    records.map(({ kind }) => kind),
    ["user_message", "tool_call", "tool_result", "assistant_message", "turn_boundary"],
  );
  assert.deepEqual(records.map(({ sourceSequence }) => sourceSequence), [0, 1, 2, 3, 4]);
  assert.equal(records[1].parentOperationId, "call-1");
  assert.equal(records[2].payload.parts[0].tool_id, "call-1");
  assert.equal(records[2].payload.parts[0].tool_output, '{"access_token":"[REDACTED]","status":"ok"}');

  const serialized = JSON.stringify(records);
  for (const forbidden of [
    "hidden",
    "private",
    "internal",
    "do-not-store",
    "abc123",
    "hidden-token",
    "reasoningBlocks",
    "encryptedContent",
  ]) {
    assert.equal(serialized.includes(forbidden), false, `${forbidden} leaked`);
  }
  assert.match(records[0].payload.parts[0].text, /api_key=\[REDACTED\]/);
});

test("omits tool output unless captureToolResults is explicitly enabled", () => {
  const [record] = normalizeCopilotEvents(
    [{
      type: "tool.execution_complete",
      id: "tool-done",
      data: { toolCallId: "call-1", success: true, result: "sensitive output" },
    }],
    "copilot-session",
  );
  assert.equal(record.kind, "tool_result");
  assert.equal(record.payload.parts[0].tool_status, "completed");
  assert.equal(Object.hasOwn(record.payload.parts[0], "tool_output"), false);
  assert.equal(JSON.stringify(record).includes("sensitive output"), false);
});

test("uses deterministic fallback identities and normalized timestamps", () => {
  const event = {
    type: "user.message",
    timestamp: "2026-09-30T12:00:00-04:00",
    data: { content: "A meaningful user request for testing." },
  };
  const [first] = normalizeCopilotEvents([event], "session-a");
  const [second] = normalizeCopilotEvents([event], "session-a");
  const [otherSession] = normalizeCopilotEvents([event], "session-b");

  assert.match(first.sourceEventId, /^sha256:[a-f0-9]{64}$/);
  assert.equal(first.sourceEventId, second.sourceEventId);
  assert.notEqual(first.sourceEventId, otherSession.sourceEventId);
  assert.equal(first.occurredAt, "2026-09-30T16:00:00.000Z");
  assert.match(first.payloadDigest, /^[a-f0-9]{64}$/);
});

test("applies configured capture filters to visible text before journaling", () => {
  const records = normalizeCopilotEvents(
    [
      {
        type: "user.message",
        id: "private-prompt",
        data: { content: "/private please do not retain this" },
      },
      {
        type: "assistant.message",
        id: "assistant-answer",
        data: { phase: "final", content: "Customer 4821 was notified." },
      },
    ],
    "copilot-session",
    {
      captureFilters: [
        "user:d|^/private",
        "assistant:s|Customer \\d+|Customer [ID]|g",
      ],
    },
  );

  assert.equal(records.length, 1);
  assert.equal(records[0].sourceEventId, "assistant-answer");
  assert.equal(records[0].payload.parts[0].text, "Customer [ID] was notified.");
  assert.equal(records[0].sourceSequence, 0);
});

test("rejects malformed input instead of silently capturing partial state", () => {
  assert.throws(() => normalizeCopilotEvents({}, "session-a"), /events must be an array/);
  assert.throws(() => normalizeCopilotEvents([], ""), /sourceSessionId/);
});
