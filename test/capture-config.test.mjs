import assert from "node:assert/strict";
import test from "node:test";
import { EXCLUDED_TOOLS_ENV, applyExcludedTools, resolveExcludedTools } from "../src/capture-config.mjs";

test("reads a comma-separated environment list", () => {
  assert.deepEqual(
    resolveExcludedTools({}, { [EXCLUDED_TOOLS_ENV]: "jira_search, openviking_*" }),
    ["jira_search", "openviking_*"],
  );
});

test("prefers an explicit config list over the environment", () => {
  assert.deepEqual(
    resolveExcludedTools({ excludedTools: ["from_config"] }, { [EXCLUDED_TOOLS_ENV]: "from_env" }),
    ["from_config"],
  );
});

test("deduplicates and trims so the resolved list is stable", () => {
  assert.deepEqual(
    resolveExcludedTools({}, { [EXCLUDED_TOOLS_ENV]: " a , a ,b,  , c " }),
    ["a", "b", "c"],
  );
});

test("returns no patterns when nothing is configured", () => {
  assert.deepEqual(resolveExcludedTools({}, {}), []);
  assert.deepEqual(resolveExcludedTools({}, { [EXCLUDED_TOOLS_ENV]: "   " }), []);
});

test("accepts an array config value as well as a string", () => {
  assert.deepEqual(resolveExcludedTools({ excludedTools: ["a", " b "] }, {}), ["a", "b"]);
});

test("leaves the config untouched when nothing is excluded", () => {
  const config = { autoCapture: true };
  assert.equal(applyExcludedTools(config, {}), config);
});

test("adds the resolved list without mutating the input", () => {
  const config = { autoCapture: true };
  const applied = applyExcludedTools(config, { [EXCLUDED_TOOLS_ENV]: "jira_search" });
  assert.deepEqual(applied.excludedTools, ["jira_search"]);
  assert.equal(applied.autoCapture, true);
  assert.equal(config.excludedTools, undefined, "the source config must not be mutated");
});