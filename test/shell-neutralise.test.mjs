import assert from "node:assert/strict";
import test from "node:test";
import { neutraliseShellSubstitutions, neutraliseToolArguments } from "../src/capture-config.mjs";
import { normalizeCopilotEvents } from "../src/event-normalizer.mjs";

// The server answers 403 to some shell substitution syntax, dead-lettering the
// record and blocking every later record in the session. Characterising the rule
// by minimisation did not converge, so these are conservative rewrites of the
// forms that reproduced deterministically.
test("rewrites backtick substitution into a readable placeholder", () => {
  assert.equal(neutraliseShellSubstitutions("echo `date`"), "echo [command: date]");
  assert.equal(neutraliseShellSubstitutions("a `ls -l` b"), "a [command: ls -l] b");
});

test("rewrites a command substitution wrapping printf", () => {
  assert.equal(
    neutraliseShellSubstitutions("m=$(printf '%s' x)"),
    "m=(printf '%s' x)",
  );
});

test("rewrites other command substitutions", () => {
  assert.equal(neutraliseShellSubstitutions("echo $(whoami)"), "echo (whoami)");
});

test("leaves ordinary text untouched", () => {
  const plain = "Set-Location 'D:\\Project'; Get-ChildItem -Recurse";
  assert.equal(neutraliseShellSubstitutions(plain), plain);
  assert.equal(neutraliseShellSubstitutions(""), "");
  assert.equal(neutraliseShellSubstitutions(undefined), undefined);
});

test("does not rewrite an escaped backtick", () => {
  assert.equal(neutraliseShellSubstitutions("echo \\`x\\`"), "echo \\`x\\`");
});

test("walks nested argument trees", () => {
  const out = neutraliseToolArguments({
    command: "echo `date`",
    nested: { list: ["$(printf '%s')", "plain"] },
  });
  assert.equal(out.command, "echo [command: date]");
  assert.equal(out.nested.list[0], "(printf '%s')");
  assert.equal(out.nested.list[1], "plain");
});

test("applies to captured tool arguments before they are journaled", () => {
  const events = [{
    id: "t1",
    type: "tool.execution_start",
    timestamp: "2026-11-16T00:00:00Z",
    data: {
      toolCallId: "c1",
      toolName: "powershell",
      arguments: { command: "echo `date`; m=$(printf '%s' x)" },
    },
  }];
  const [record] = normalizeCopilotEvents(events, "session-neutralise");
  const command = record.payload.parts[0].tool_input.command;
  assert.equal(command.includes("`"), false, "no backtick may reach the server");
  assert.equal(command, "echo [command: date]; m=(printf '%s' x)");
});