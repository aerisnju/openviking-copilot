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
 * The one pattern the OpenViking server refuses with a bare `403`.
 *
 * Established by repeated isolated probes: a command substitution whose command
 * is `printf` immediately followed by a single quote is rejected, while
 * `$(printf` without a quote, `$(printf "` with a double quote, and
 * `$(echo '` all pass. Length, backticks and other commands are not involved.
 *
 * The rewrite keeps the substitution visible and readable but removes the exact
 * form the server refuses. It is applied to tool arguments, tool output and
 * assistant text, because a plain reply that merely quoted the pattern was
 * rejected too.
 */
export const SHELL_SUBSTITUTION_NEUTRALISERS = Object.freeze([
  [/\$\(\s*printf\s*'/gi, "$(printf [REDACTED]"],
]);

export function neutraliseShellSubstitutions(value) {
  if (typeof value !== "string" || value.length === 0) return value;
  let out = value;
  for (const [pattern, replacement] of SHELL_SUBSTITUTION_NEUTRALISERS) {
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