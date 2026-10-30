import assert from "node:assert/strict";
import test from "node:test";
import { isExcludedTool, normalizeCopilotEvents } from "../src/event-normalizer.mjs";

const SESSION = "session-tool-exclusion";

function start(id, toolName) {
  return {
    id: `${id}-start`,
    type: "tool.execution_start",
    timestamp: "2026-10-23T00:00:00Z",
    data: { toolCallId: id, toolName, arguments: { secret: "value" } },
  };
}

function complete(id) {
  return {
    id: `${id}-complete`,
    type: "tool.execution_complete",
    timestamp: "2026-10-23T00:00:01Z",
    data: { toolCallId: id, success: true, result: "ok" },
  };
}

test("matches tool names exactly by default", () => {
  assert.equal(isExcludedTool("jira_search", ["jira_search"]), true);
  assert.equal(isExcludedTool("jira_search_v2", ["jira_search"]), false);
  assert.equal(isExcludedTool("JIRA_SEARCH", ["jira_search"]), false);
});

test("supports a trailing wildcard for prefixes", () => {
  assert.equal(isExcludedTool("jira_search", ["jira_*"]), true);
  assert.equal(isExcludedTool("jira", ["jira_*"]), false);
  assert.equal(isExcludedTool("confluence_search", ["jira_*"]), false);
});

test("ignores empty patterns instead of excluding everything", () => {
  assert.equal(isExcludedTool("anything", []), false);
  assert.equal(isExcludedTool("anything", ["", "  "]), false);
  assert.equal(isExcludedTool("", ["jira_search"]), false);
});

test("drops both the start and completion of an excluded tool", () => {
  const records = normalizeCopilotEvents(
    [start("call-1", "jira_search"), complete("call-1")],
    SESSION,
    { excludedTools: ["jira_search"] },
  );
  assert.deepEqual(records, []);
});

test("keeps tools that are not excluded", () => {
  const records = normalizeCopilotEvents(
    [start("call-1", "jira_search"), complete("call-1"), start("call-2", "read_file"), complete("call-2")],
    SESSION,
    { excludedTools: ["jira_search"] },
  );
  assert.equal(records.length, 2);
  assert.deepEqual(records.map((record) => record.kind), ["tool_call", "tool_result"]);
  assert.equal(records[0].payload.parts[0].tool_name, "read_file");
});

test("keeps everything when no exclusion is configured", () => {
  const records = normalizeCopilotEvents(
    [start("call-1", "jira_search"), complete("call-1")],
    SESSION,
  );
  assert.equal(records.length, 2);
});

test("excludes by prefix across a whole tool family", () => {
  const events = [
    start("a", "openviking_write"),
    complete("a"),
    start("b", "openviking_read"),
    complete("b"),
    start("c", "other_tool"),
    complete("c"),
  ];
  const records = normalizeCopilotEvents(events, SESSION, { excludedTools: ["openviking_*"] });
  assert.equal(records.length, 2);
  const callIds = records.map((record) => record.payload.parts[0].tool_id);
  assert.deepEqual(callIds, ["c", "c"]);
  assert.equal(records[0].payload.parts[0].tool_name, "other_tool");
});

test("applies captureFilters substitutions to tool arguments and output", () => {
  const filter = "s|Customer \\d+|Customer [ID]|g";
  const events = [
    {
      id: "t1",
      type: "tool.execution_start",
      timestamp: "2026-10-30T00:00:00Z",
      data: { toolCallId: "c1", toolName: "shell", arguments: { command: "curl -H 'X: Customer 12345'" } },
    },
    {
      id: "t1r",
      type: "tool.execution_complete",
      timestamp: "2026-10-30T00:00:01Z",
      data: { toolCallId: "c1", success: true, result: "output for Customer 12345" },
    },
  ];
  const records = normalizeCopilotEvents(events, SESSION, {
    captureFilters: [filter],
    captureToolResults: true,
  });
  const input = JSON.stringify(records[0].payload.parts[0].tool_input);
  const output = JSON.stringify(records[1].payload.parts[0].tool_output);
  assert.equal(input.includes("12345"), false, "tool arguments must be redacted");
  assert.equal(output.includes("12345"), false, "tool output must be redacted");
  assert.equal(input.includes("Customer [ID]"), true);
  assert.equal(output.includes("Customer [ID]"), true);
});

test("leaves tool payloads untouched when no capture filter applies", () => {
  const events = [
    {
      id: "t1",
      type: "tool.execution_start",
      timestamp: "2026-10-30T00:00:00Z",
      data: { toolCallId: "c1", toolName: "shell", arguments: { command: "echo hello" } },
    },
  ];
  const records = normalizeCopilotEvents(events, SESSION);
  assert.equal(records[0].payload.parts[0].tool_input.command, "echo hello");
});

test("applies exclusion before tool output capture, not after", () => {
  const records = normalizeCopilotEvents(
    [start("call-1", "jira_search"), complete("call-1")],
    SESSION,
    { excludedTools: ["jira_search"], captureToolResults: true },
  );
  assert.deepEqual(records, [], "an excluded tool must not leak its output either");
});