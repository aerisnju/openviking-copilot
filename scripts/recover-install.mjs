/**
 * Recover an installation that was interrupted between target renames.
 *
 * Usage:
 *   node scripts/recover-install.mjs [--dry-run] [--apply] [--json]
 *
 * Without `--apply` this only prints the plan. Recovery moves or deletes files,
 * so it never runs implicitly: install, dry-run, and uninstall all keep refusing
 * an interrupted profile and point here.
 */
import { homedir } from "node:os";
import { resolve } from "node:path";
import { applyInstallRecovery, planInstallRecovery } from "../src/install-recovery.mjs";

const copilotHome = resolve(process.env.COPILOT_HOME || resolve(homedir(), ".copilot"));
const extensionTarget = resolve(copilotHome, "extensions", "openviking-memory");
const hookTarget = resolve(copilotHome, "hooks", "openviking-memory.json");
const json = process.argv.includes("--json");
const apply = process.argv.includes("--apply");
const dryRun = process.argv.includes("--dry-run");

if (apply && dryRun) {
  process.stderr.write("Choose either --dry-run or --apply, not both\n");
  process.exit(2);
}

const plan = await planInstallRecovery({ extensionTarget, hookTarget, copilotHome });

if (json && !apply) {
  process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
} else if (!apply) {
  if (plan.transactionCount === 0) {
    process.stdout.write("No interrupted installation found; nothing to recover.\n");
  } else {
    process.stdout.write(
      `Interrupted installation: ${plan.transactionCount} transaction(s),`
        + ` ${plan.recoverable ? "recoverable" : "NOT recoverable"}\n`,
    );
    for (const transaction of plan.transactions) {
      process.stdout.write(`  transaction ${transaction.id}\n`);
      for (const action of transaction.actions) {
        process.stdout.write(`    ${action.op} ${action.name}: ${action.path ?? action.from}\n`);
      }
      process.stdout.write(`    reason: ${transaction.reason}\n`);
    }
    for (const problem of plan.problems) {
      process.stdout.write(`  problem ${problem.name}: ${problem.reason}\n`);
    }
    if (plan.recoverable) {
      process.stdout.write("Re-run with --apply to perform this recovery.\n");
    } else {
      process.stdout.write(
        "Recovery needs manual inspection: an artifact is missing an ownership marker"
          + " or the state is ambiguous. Nothing was changed.\n",
      );
    }
  }
  if (!plan.recoverable && plan.transactionCount > 0) process.exitCode = 1;
} else {
  const result = await applyInstallRecovery(plan, { confirm: true });
  if (json) {
    process.stdout.write(`${JSON.stringify({ plan, result }, null, 2)}\n`);
  } else {
    process.stdout.write(`Recovery applied: ${result.applied.length} action(s).\n`);
    for (const action of result.applied) {
      process.stdout.write(`  ${action.op} ${action.name}: ${action.path ?? action.from}\n`);
    }
    for (const failure of result.failures) {
      process.stdout.write(`  FAILED ${failure.op} ${failure.name}: ${failure.error}\n`);
    }
  }
  if (result.failures.length > 0) process.exitCode = 1;
}