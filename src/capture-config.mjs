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