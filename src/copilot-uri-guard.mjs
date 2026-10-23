import {
  evaluateUriGuard,
  evaluateUriNotice,
  normalizeToolName,
} from "../vendor/openviking-memory-plugin-shared/lib/uri-guard.mjs";

const TOOL_ALIASES = new Map([
  ["read_file", "read"],
  ["view", "read"],
  ["open_file", "read"],
  ["list_dir", "read"],
  ["list_directory", "read"],
  ["directory_tree", "read"],
  ["write_file", "write"],
  ["create_file", "write"],
  ["edit_file", "edit"],
  ["glob_search", "glob"],
  ["grep_search", "grep"],
  ["run_command", "runcommand"],
]);

function canonicalLocalToolName(value) {
  const name = normalizeToolName(value);
  if (
    !name ||
    name.includes("openviking") ||
    name.startsWith("mcp__") ||
    name.startsWith("mcp.")
  ) {
    return null;
  }
  return TOOL_ALIASES.get(name) || name;
}

export function copilotUriGuardOutput(input = {}) {
  const toolName = canonicalLocalToolName(input.toolName);
  if (!toolName) return undefined;
  const toolArgs = input.toolArgs ?? {};
  const denied = evaluateUriGuard(toolName, toolArgs);
  if (denied) {
    return {
      permissionDecision: "deny",
      permissionDecisionReason: denied.reason,
    };
  }
  const notice = evaluateUriNotice(toolName, toolArgs);
  if (notice) return { additionalContext: notice.reason };
  return undefined;
}
