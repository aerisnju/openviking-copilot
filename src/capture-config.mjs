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
 * Patterns the OpenViking server refuses with a bare `403`.
 *
 * Characterising the rule by minimisation did not converge — a substring that
 * fails inside a long command succeeds on its own — so this is a conservative
 * pre-filter, not a model of the server's decision. It rewrites the two forms
 * that were reproduced deterministically (backtick substitution and a command
 * substitution wrapping a quoted printf format) so an otherwise valid record is
 * not dead-lettered and does not block every later record in the session.
 *
 * Neutralising is deliberately visible: the stored command says the substitution
 * was removed rather than pretending the original text survived.
 */
export const SHELL_SUBSTITUTION_NEUTRALISERS = Object.freeze([
  // `command` -> [command]
  [/(?<![\\])`([^`\n]{1,200})(?<![\\])`/g, "[command: $1]"],
  // $(printf '...') -> (printf '...')
  [/\$\((printf\s+')/g, "($1"],
  // $( ... ) -> ( ... ) for any other substitution inside a tool argument
  [/\$\((?![^)]*\[command:)/g, "("],
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