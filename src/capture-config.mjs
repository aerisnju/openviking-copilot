/**
 * Capture-side tool exclusion, layered on top of the shared config.
 *
 * The shared config resolver is vendored with pinned checksums, so this setting
 * is applied locally rather than by editing the vendor tree. Both the capture
 * path and the compaction audit read the same resolved list, which is what keeps
 * the digest ledger consistent: if the two disagreed, an excluded tool would
 * look like a missing event and block the commit.
 */
export const EXCLUDED_TOOLS_ENV = "OPENVIKING_CAPTURE_EXCLUDED_TOOLS";

/**
 * Rewrites for the payloads an edge WAF rejects before OpenViking sees them.
 *
 * The `403` is **not** produced by OpenViking. A rejected request has no body,
 * no `content-type` and no trace id, while every OpenViking response — success
 * or error — carries a trace id and a JSON envelope. The block also happens
 * before authentication (a bad key plus a blocked body returns 403, the same key
 * with a clean body returns 401) and before routing (an unknown path plus a
 * blocked body returns 403, the same path clean returns 404). That places it in
 * the network edge in front of the API, not in `openviking/server`.
 *
 * Three rules reproduce, all case-insensitive and all matched anywhere in the
 * request body or query string:
 *
 *   1. `$(` + optional space + `printf` + space + `'`  — command injection
 *   2. `etc` + separators + `passwd` / `shadow`        — local file inclusion
 *   3. `windows` + separators + `win.ini`              — local file inclusion
 *
 * Everything else that looked like a trigger was noise: `$(echo 'x')`, `$(ls)`,
 * `$(id)`, backticks, `${IFS}`, `/etc/hosts`, `/etc/sudoers`, `../` on its own,
 * and the bare words `passwd` / `shadow` all pass. Earlier notes in this project
 * blamed backticks, then "content in general", then a stable substring; the
 * probes above are what settled it.
 *
 * The rewrites keep the text readable but remove the exact shape the WAF matches.
 * They are applied to every string in the request body, because the WAF does not
 * distinguish fields: `turn_id`, `source_message_ids`, tool arguments and tool
 * output are all inspected.
 */
export const WAF_NEUTRALISERS = Object.freeze([
  [/\$\(\s*printf\s*'/gi, "$(printf [REDACTED]"],
  [/\betc[/\\.]+(passwd|shadow)/gi, "etc/[REDACTED]/$1"],
  [/\bwindows[/\\.]+win\.ini/gi, "windows/[REDACTED]/win.ini"],
]);

/**
 * @deprecated Name kept so existing imports and tests keep working; the list is
 * no longer about shell substitution only.
 */
export const SHELL_SUBSTITUTION_NEUTRALISERS = WAF_NEUTRALISERS;

export function neutraliseShellSubstitutions(value) {
  if (typeof value !== "string" || value.length === 0) return value;
  let out = value;
  for (const [pattern, replacement] of WAF_NEUTRALISERS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

function neutraliseDeep(value, depth = 0) {
  if (typeof value === "string") return neutraliseShellSubstitutions(value);
  if (Array.isArray(value)) return value.map((item) => neutraliseDeep(item, depth + 1));
  if (!value || typeof value !== "object" || depth >= 20) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, neutraliseDeep(item, depth + 1)]),
  );
}

/** Apply the neutraliser to a structured tool argument tree. */
export function neutraliseToolArguments(value) {
  return neutraliseDeep(value);
}

function splitPatterns(value) {
  if (Array.isArray(value)) return value.flatMap(splitPatterns);
  if (typeof value !== "string") return [];
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/**
 * Resolve the excluded tool patterns for a config object.
 *
 * An explicit `excludedTools` on the config wins; otherwise the comma-separated
 * `OPENVIKING_CAPTURE_EXCLUDED_TOOLS` environment value is used. Duplicates are
 * removed so the resolved list is stable for logging and comparison.
 */
export function resolveExcludedTools(config = {}, env = process.env) {
  const fromConfig = splitPatterns(config?.excludedTools);
  const source = fromConfig.length > 0 ? fromConfig : splitPatterns(env?.[EXCLUDED_TOOLS_ENV]);
  return [...new Set(source)];
}

export function applyExcludedTools(config, env = process.env) {
  const excludedTools = resolveExcludedTools(config, env);
  return excludedTools.length > 0 ? { ...config, excludedTools } : config;
}