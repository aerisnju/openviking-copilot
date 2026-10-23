import assert from "node:assert/strict";
import test from "node:test";
import { copilotUriGuardOutput } from "../src/copilot-uri-guard.mjs";

test("denies filesystem operations whose location is an OpenViking URI", () => {
  for (const toolName of ["read_file", "write_file", "edit_file", "glob_search", "grep_search"]) {
    const output = copilotUriGuardOutput({
      toolName,
      toolArgs: { filePath: "viking://user/default/memories/profile.md" },
    });
    assert.equal(output?.permissionDecision, "deny", toolName);
    assert.match(output.permissionDecisionReason, /OpenViking/);
  }
});

test("does not block URI text passed to local file content or shell commands", () => {
  assert.equal(
    copilotUriGuardOutput({
      toolName: "write_file",
      toolArgs: {
        filePath: "notes.txt",
        content: "The OpenViking location is viking://user/default/memories.",
      },
    }),
    undefined,
  );

  const shellNotice = copilotUriGuardOutput({
    toolName: "run_command",
    toolArgs: { command: "ov read viking://user/default/memories" },
  });
  assert.equal(shellNotice.permissionDecision, undefined);
  assert.match(shellNotice.additionalContext, /URI guard/);
});

test("does not interfere with OpenViking MCP calls or unrelated tools", () => {
  assert.equal(
    copilotUriGuardOutput({
      toolName: "mcp__openviking__read",
      toolArgs: { uri: "viking://user/default/memories/profile.md" },
    }),
    undefined,
  );
  assert.equal(
    copilotUriGuardOutput({
      toolName: "search_code",
      toolArgs: { query: "viking://user/default/memories" },
    }),
    undefined,
  );
  assert.equal(
    copilotUriGuardOutput({
      toolName: "read_file",
      toolArgs: { filePath: "src/index.mjs" },
    }),
    undefined,
  );
});
