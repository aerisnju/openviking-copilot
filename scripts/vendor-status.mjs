/**
 * Report the state of the vendored OpenViking dependency.
 *
 * Usage:
 *   node scripts/vendor-status.mjs [--from <local OpenViking clone>] [--ref <git ref>] [--json]
 *
 * Exits non-zero when a vendored file no longer matches its recorded digest, so
 * CI (or a pre-release check) catches a hand-edited dependency.
 */
import { checkUpstreamDrift, verifyVendoredIntegrity } from "../src/vendor-status.mjs";

function argument(name, fallback = null) {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`Missing value for ${name}`);
  return value;
}

const json = process.argv.includes("--json");
const localClone = argument("--from", process.env.OPENVIKING_SOURCE_DIR || null);
const upstreamRef = argument("--ref", "HEAD");

const integrity = await verifyVendoredIntegrity();
const drift = localClone ? await checkUpstreamDrift({ localClone, upstreamRef }) : null;

if (json) {
  process.stdout.write(`${JSON.stringify({ integrity, drift }, null, 2)}\n`);
} else {
  process.stdout.write(
    `Vendored OpenViking snapshot: ${integrity.commit}\n`
      + `Integrity: ${integrity.ok ? "ok" : `${integrity.problems.length} problem(s)`}\n`,
  );
  for (const problem of integrity.problems) {
    process.stdout.write(`  ${problem.problem}: ${problem.path}\n`);
  }
  if (!drift) {
    process.stdout.write(
      "Upstream drift: not checked (pass --from <local OpenViking clone>)\n",
    );
  } else if (!drift.ok) {
    process.stdout.write(`Upstream drift: unavailable (${drift.reason})\n`);
  } else {
    process.stdout.write(
      `Upstream drift: ${drift.behind} commit(s) behind ${drift.upstream.slice(0, 12)}`
        + `, ${drift.sharedLibCommits} touching the shared lib\n`,
    );
    for (const commit of drift.commits.slice(0, 15)) process.stdout.write(`  ${commit}\n`);
    if (drift.commits.length > 15) {
      process.stdout.write(`  ... and ${drift.commits.length - 15} more\n`);
    }
    if (drift.breaking.length > 0) {
      process.stdout.write(
        `  BREAKING (${drift.breaking.length}): review before refreshing\n`,
      );
    }
  }
}

if (!integrity.ok) process.exitCode = 1;