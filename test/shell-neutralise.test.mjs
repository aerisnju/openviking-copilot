import assert from "node:assert/strict";
import test from "node:test";
import { neutraliseShellSubstitutions, neutraliseToolArguments } from "../src/capture-config.mjs";
import { normalizeCopilotEvents } from "../src/event-normalizer.mjs";

// The server answers 403 to one specific form: a command substitution whose
// command is printf followed by a single quote. These cases mirror the probes
// that established the rule, so a change here changes what we send.
test("rewrites the rejected printf substitution", () => {
  assert.equal(neutraliseShellSubstitutions("$(printf '%s' x)"), "$(printf [REDACTED]%s' x)");
  assert.equal(neutraliseShellSubstitutions("$(printf '"), "$(printf [REDACTED]");
});

test("rewrites the no-space and upper-case spellings that also fail", () => {
  assert.equal(neutraliseShellSubstitutions("$(printf'"), "$(printf [REDACTED]");
  assert.equal(neutraliseShellSubstitutions("$(PRINTF '"), "$(printf [REDACTED]");
});

test("leaves forms the server accepts untouched", () => {
  for (const accepted of ["$(printf", '$(printf "', "$(echo '", "echo `date`", "printf '%s' x"]) {
    assert.equal(neutraliseShellSubstitutions(accepted), accepted, `must not rewrite: ${accepted}`);
  }
});

test("leaves ordinary text untouched", () => {
  const plain = "Set-Location 'D:\\Project'; Get-ChildItem -Recurse";
  assert.equal(neutraliseShellSubstitutions(plain), plain);
  assert.equal(neutraliseShellSubstitutions(""), "");
  assert.equal(neutraliseShellSubstitutions(undefined), undefined);
});

test("walks nested argument trees", () => {
  const out = neutraliseToolArguments({
    command: "$(printf '%s' x)",
    nested: { list: ["$(printf 'a')", "plain"] },
  });
  assert.equal(out.command, "$(printf [REDACTED]%s' x)");
  assert.equal(out.nested.list[0], "$(printf [REDACTED]a')");
  assert.equal(out.nested.list[1], "plain");
});

test("applies to captured tool arguments before they are journaled", () => {
  const events = [{
    id: "t1",
    type: "tool.execution_start",
    timestamp: "2026-11-16T00:00:00Z",
    data: { toolCallId: "c1", toolName: "powershell", arguments: { command: "m=$(printf '%s' x)" } },
  }];
  const [record] = normalizeCopilotEvents(events, "session-neutralise");
  assert.equal(record.payload.parts[0].tool_input.command, "m=$(printf [REDACTED]%s' x)");
});

test("applies to assistant text, because a quoted pattern was rejected too", () => {
  const events = [{
    id: "m1",
    type: "assistant.message",
    timestamp: "2026-11-16T00:00:00Z",
    data: { content: "the pattern is $(printf '", messageId: "m1" },
  }];
  const [record] = normalizeCopilotEvents(events, "session-neutralise");
  assert.equal(record.payload.parts[0].text, "the pattern is $(printf [REDACTED]");
});
// The edge WAF in front of the API also blocks local-file-inclusion shapes, and
// it inspects every string in the body rather than only the text parts. These
// mirror the probes that established the rule, so a change here changes what we
// send.
test("rewrites the local-file-inclusion shapes the WAF blocks", () => {
  assert.equal(neutraliseShellSubstitutions("/etc/passwd"), "/etc/[REDACTED]/passwd");
  assert.equal(neutraliseShellSubstitutions("/etc/shadow"), "/etc/[REDACTED]/shadow");
  assert.equal(neutraliseShellSubstitutions("etc/passwd"), "etc/[REDACTED]/passwd");
  assert.equal(neutraliseShellSubstitutions("/etc//passwd"), "/etc/[REDACTED]/passwd");
  assert.equal(neutraliseShellSubstitutions("../etc/passwd"), "../etc/[REDACTED]/passwd");
  assert.equal(neutraliseShellSubstitutions("/windows/win.ini"), "/windows/[REDACTED]/win.ini");
  assert.equal(neutraliseShellSubstitutions("C:\\windows\\win.ini"), "C:\\windows/[REDACTED]/win.ini");
});

test("leaves sensitive-looking paths the WAF accepts untouched", () => {
  for (const accepted of [
    "/etc/hosts",
    "/etc/sudoers",
    "/etc/group",
    "/proc/self/environ",
    "/root/.ssh/id_rsa",
    "passwd",
    "shadow",
    "win.ini",
    "/etc/passw",
    "/etc/foo/passwd",
  ]) {
    assert.equal(neutraliseShellSubstitutions(accepted), accepted, `must not rewrite: ${accepted}`);
  }
});

test("neutralises every string field, not only the text part", () => {
  const events = [{
    id: "t2",
    type: "tool.execution_start",
    timestamp: "2026-11-16T00:00:00Z",
    data: {
      toolCallId: "c2",
      toolName: "powershell",
      arguments: { command: "Get-Content /etc/passwd", nested: { path: "/etc/shadow" } },
    },
  }];
  const [record] = normalizeCopilotEvents(events, "session-neutralise");
  assert.equal(record.payload.parts[0].tool_input.command, "Get-Content /etc/[REDACTED]/passwd");
  assert.equal(record.payload.parts[0].tool_input.nested.path, "/etc/[REDACTED]/shadow");
});
