import { lstat, readdir, readFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

const OWNER = "openviking-copilot";
const TRANSACTION_ID = "[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}";

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function pathKind(path) {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink()) return "symlink";
    if (info.isDirectory()) return "directory";
    if (info.isFile()) return "file";
    return "other";
  } catch (error) {
    if (error.code === "ENOENT") return "absent";
    throw error;
  }
}

/**
 * Read the ownership marker of a staged extension directory.
 *
 * A plan may only move artifacts that this project wrote, so a marker that is
 * missing, unparsable, or names another owner makes the whole target
 * unrecoverable rather than something to guess about.
 */
async function readStagedOwner(path) {
  const markerPath = join(path, "install-config.json");
  try {
    const marker = JSON.parse(await readFile(markerPath, "utf8"));
    return marker?.owner === OWNER ? OWNER : null;
  } catch {
    return null;
  }
}

/**
 * Group every interrupted artifact for one target into a transaction.
 *
 * Artifacts are named `<target>.staging-<uuid>` / `<target>.backup-<uuid>`. One
 * install run uses one UUID for both targets, so grouping by UUID is what lets
 * a plan reason about a half-finished transaction instead of individual files.
 */
async function findArtifacts(target) {
  const directory = dirname(target);
  const name = basename(target);
  let entries;
  try {
    entries = await readdir(directory);
  } catch (error) {
    if (error.code === "ENOENT") return new Map();
    throw error;
  }
  const pattern = new RegExp(
    `^${escapeRegExp(name)}\\.(staging|backup)-(${TRANSACTION_ID})$`,
    "i",
  );
  const transactions = new Map();
  for (const entry of entries) {
    const match = pattern.exec(entry);
    if (!match) continue;
    const [, kind, id] = match;
    if (!transactions.has(id)) transactions.set(id, {});
    transactions.get(id)[kind] = resolve(directory, entry);
  }
  return transactions;
}

/**
 * Plan recovery from an interrupted installation, without changing anything.
 *
 * The installer replaces two targets by rename:
 *
 *   1. target      -> backup      (only when a target already existed)
 *   2. staging     -> target
 *
 * A crash can therefore leave: staging only (nothing moved yet), staging +
 * backup (old target moved aside, new one not yet in place), or nothing but a
 * target that was already replaced. Only the states with clear evidence get an
 * action; anything ambiguous is reported for manual handling, because guessing
 * here would delete a working installation.
 *
 * @returns `{ recoverable, transactions, problems }` where each transaction
 *          carries an ordered `actions` list and a `reason`.
 */
export async function planInstallRecovery({ extensionTarget, hookTarget, copilotHome }) {
  const targets = [
    { name: "extension", target: extensionTarget, isExtension: true },
    { name: "hook", target: hookTarget, isExtension: false },
  ];
  const perTarget = new Map();
  for (const entry of targets) {
    perTarget.set(entry.name, { ...entry, transactions: await findArtifacts(entry.target) });
  }

  // One install run stamps both targets with the same transaction id; recover
  // whole transactions so the extension and hook cannot end up from different
  // versions.
  const ids = new Set();
  for (const entry of perTarget.values()) {
    for (const id of entry.transactions.keys()) ids.add(id);
  }

  const transactions = [];
  const problems = [];
  for (const id of ids) {
    const parts = [];
    for (const entry of perTarget.values()) {
      const artifact = entry.transactions.get(id);
      if (!artifact) continue;
      parts.push({
        name: entry.name,
        target: entry.target,
        isExtension: entry.isExtension,
        staging: artifact.staging ?? null,
        backup: artifact.backup ?? null,
        targetKind: await pathKind(entry.target),
        stagingKind: artifact.staging ? await pathKind(artifact.staging) : "absent",
        backupKind: artifact.backup ? await pathKind(artifact.backup) : "absent",
      });
    }

    const actions = [];
    const reasons = [];
    let blocked = false;

    for (const part of parts) {
      // A backup means the old target was moved aside. Restoring it is the only
      // action that preserves a working installation.
      if (part.backup && part.backupKind !== "absent") {
        if (part.targetKind === "absent") {
          actions.push({ op: "restore-backup", from: part.backup, to: part.target, name: part.name });
          reasons.push(`${part.name}: restore the previous installation from its backup`);
          if (part.staging && part.stagingKind !== "absent") {
            actions.push({ op: "discard-staging", path: part.staging, name: part.name });
            reasons.push(`${part.name}: discard the unused staging copy`);
          }
          continue;
        }
        // Target and backup both present: the replacement finished but the
        // backup was never cleaned. Deleting the backup is safe only when the
        // installed target carries this project's marker.
        if (part.isExtension) {
          const owner = await readStagedOwner(part.target);
          if (owner !== OWNER) {
            blocked = true;
            problems.push({
              name: part.name,
              reason: "target-and-backup-both-present-without-ownership",
            });
            continue;
          }
        }
        actions.push({ op: "discard-backup", path: part.backup, name: part.name });
        reasons.push(`${part.name}: the replacement completed, so the backup can be removed`);
        if (part.staging && part.stagingKind !== "absent") {
          actions.push({ op: "discard-staging", path: part.staging, name: part.name });
          reasons.push(`${part.name}: discard the unused staging copy`);
        }
        continue;
      }

      // No backup: either nothing was moved yet, or this target did not exist
      // before the run. Staging can simply be discarded in both cases.
      if (part.staging && part.stagingKind !== "absent") {
        if (part.isExtension) {
          const owner = await readStagedOwner(part.staging);
          if (owner !== OWNER) {
            blocked = true;
            problems.push({ name: part.name, reason: "staging-without-ownership-marker" });
            continue;
          }
        }
        actions.push({ op: "discard-staging", path: part.staging, name: part.name });
        reasons.push(`${part.name}: no replacement was applied, so the staging copy is unused`);
        continue;
      }

      blocked = true;
      problems.push({ name: part.name, reason: "no-recoverable-artifact" });
    }

    transactions.push({
      id,
      recoverable: !blocked && actions.length > 0,
      blocked,
      actions,
      reason: reasons.join("; ") || "nothing to do",
      parts,
    });
  }

  const recoverable = transactions.length > 0
    && transactions.every((entry) => entry.recoverable)
    && problems.length === 0;

  return {
    copilotHome: copilotHome ? resolve(copilotHome) : null,
    recoverable,
    transactionCount: transactions.length,
    transactions,
    problems,
  };
}

/**
 * Execute a recovery plan.
 *
 * Recovery moves or deletes files, so it refuses to run unless the caller
 * passes `confirm: true` and the plan was judged recoverable. Actions execute
 * in plan order — restore before discard — so an interruption part-way through
 * recovery leaves a state a later run can still reason about.
 *
 * @returns `{ applied, skipped, failures }`.
 */
export async function applyInstallRecovery(plan, {
  confirm = false,
  renamePath,
  removePath,
} = {}) {
  if (!plan || plan.recoverable !== true) {
    throw new Error("Refusing to apply an unrecoverable installation plan");
  }
  if (confirm !== true) {
    throw new Error("Installation recovery requires explicit confirmation");
  }
  const rename = renamePath ?? (await import("node:fs/promises")).rename;
  const remove = removePath ?? (await import("node:fs/promises")).rm;

  const applied = [];
  const skipped = [];
  const failures = [];
  for (const transaction of plan.transactions) {
    for (const action of transaction.actions) {
      try {
        if (action.op === "restore-backup") {
          await rename(action.from, action.to);
        } else if (action.op === "discard-backup" || action.op === "discard-staging") {
          await remove(action.path, { recursive: true, force: true });
        } else {
          skipped.push({ ...action, reason: "unknown-operation" });
          continue;
        }
        applied.push({ transactionId: transaction.id, ...action });
      } catch (error) {
        failures.push({ transactionId: transaction.id, ...action, error: error?.code || "Error" });
      }
    }
  }
  return { applied, skipped, failures };
}