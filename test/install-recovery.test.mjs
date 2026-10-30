import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { applyInstallRecovery, planInstallRecovery } from "../src/install-recovery.mjs";

const OWNER = "openviking-copilot";

async function withHome(run) {
  const home = await mkdtemp(join(tmpdir(), "ov-copilot-recovery-"));
  try {
    const extensionTarget = join(home, "extensions", "openviking-memory");
    const hookTarget = join(home, "hooks", "openviking-memory.json");
    await mkdir(join(home, "extensions"), { recursive: true });
    await mkdir(join(home, "hooks"), { recursive: true });
    await run({ home, extensionTarget, hookTarget });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

async function makeExtension(path, owner = OWNER) {
  await mkdir(path, { recursive: true });
  await writeFile(join(path, "extension.mjs"), "// extension\n");
  await writeFile(join(path, "install-config.json"), `${JSON.stringify({ owner })}\n`);
}

test("plans a restore when a backup exists and the target is gone", async () => {
  await withHome(async ({ home, extensionTarget, hookTarget }) => {
    const id = randomUUID();
    await makeExtension(`${extensionTarget}.backup-${id}`);
    const plan = await planInstallRecovery({ extensionTarget, hookTarget, copilotHome: home });
    assert.equal(plan.recoverable, true);
    const tx = plan.transactions[0];
    assert.equal(tx.id, id);
    assert.deepEqual(tx.actions.map((action) => action.op), ["restore-backup"]);
    assert.equal(tx.actions[0].from, `${extensionTarget}.backup-${id}`);
    assert.equal(tx.actions[0].to, extensionTarget);
  });
});

test("plans discarding staging when nothing was moved yet", async () => {
  await withHome(async ({ home, extensionTarget, hookTarget }) => {
    const id = randomUUID();
    await makeExtension(`${extensionTarget}.staging-${id}`);
    const plan = await planInstallRecovery({ extensionTarget, hookTarget, copilotHome: home });
    assert.equal(plan.recoverable, true);
    assert.deepEqual(plan.transactions[0].actions.map((action) => action.op), ["discard-staging"]);
  });
});

test("restores the backup and discards staging when the crash was mid-replacement", async () => {
  await withHome(async ({ home, extensionTarget, hookTarget }) => {
    const id = randomUUID();
    await makeExtension(`${extensionTarget}.backup-${id}`);
    await makeExtension(`${extensionTarget}.staging-${id}`);
    const plan = await planInstallRecovery({ extensionTarget, hookTarget, copilotHome: home });
    assert.equal(plan.recoverable, true);
    const ops = plan.transactions[0].actions.map((action) => action.op);
    assert.deepEqual(ops, ["restore-backup", "discard-staging"], "restore must come first");
  });
});

test("discards a leftover backup when the replacement already completed", async () => {
  await withHome(async ({ home, extensionTarget, hookTarget }) => {
    const id = randomUUID();
    await makeExtension(extensionTarget);
    await makeExtension(`${extensionTarget}.backup-${id}`);
    const plan = await planInstallRecovery({ extensionTarget, hookTarget, copilotHome: home });
    assert.equal(plan.recoverable, true);
    assert.deepEqual(plan.transactions[0].actions.map((action) => action.op), ["discard-backup"]);
  });
});

test("refuses a staging directory without this project's ownership marker", async () => {
  await withHome(async ({ home, extensionTarget, hookTarget }) => {
    const id = randomUUID();
    await makeExtension(`${extensionTarget}.staging-${id}`, "someone-else");
    const plan = await planInstallRecovery({ extensionTarget, hookTarget, copilotHome: home });
    assert.equal(plan.recoverable, false);
    assert.equal(plan.problems.some((entry) => entry.reason === "staging-without-ownership-marker"), true);
  });
});

test("refuses when target and backup coexist but the target is not owned", async () => {
  await withHome(async ({ home, extensionTarget, hookTarget }) => {
    const id = randomUUID();
    await makeExtension(extensionTarget, "someone-else");
    await makeExtension(`${extensionTarget}.backup-${id}`);
    const plan = await planInstallRecovery({ extensionTarget, hookTarget, copilotHome: home });
    assert.equal(plan.recoverable, false);
    assert.equal(
      plan.problems.some((entry) => entry.reason === "target-and-backup-both-present-without-ownership"),
      true,
    );
  });
});

test("recovers both targets of one transaction together", async () => {
  await withHome(async ({ home, extensionTarget, hookTarget }) => {
    const id = randomUUID();
    await makeExtension(`${extensionTarget}.backup-${id}`);
    await writeFile(`${hookTarget}.backup-${id}`, "{}\n");
    const plan = await planInstallRecovery({ extensionTarget, hookTarget, copilotHome: home });
    assert.equal(plan.recoverable, true);
    assert.equal(plan.transactions.length, 1);
    const ops = plan.transactions[0].actions.map((action) => action.op);
    assert.deepEqual(ops, ["restore-backup", "restore-backup"]);
  });
});

test("reports no transactions when the profile is clean", async () => {
  await withHome(async ({ home, extensionTarget, hookTarget }) => {
    const plan = await planInstallRecovery({ extensionTarget, hookTarget, copilotHome: home });
    assert.equal(plan.transactionCount, 0);
    assert.equal(plan.recoverable, false, "nothing to recover is not a recovery plan");
    assert.deepEqual(plan.problems, []);
  });
});

test("applies a restore and leaves the target usable", async () => {
  await withHome(async ({ home, extensionTarget, hookTarget }) => {
    const id = randomUUID();
    await makeExtension(`${extensionTarget}.backup-${id}`);
    await makeExtension(`${extensionTarget}.staging-${id}`);
    const plan = await planInstallRecovery({ extensionTarget, hookTarget, copilotHome: home });
    const result = await applyInstallRecovery(plan, { confirm: true });
    assert.equal(result.failures.length, 0);
    const names = await readdir(join(home, "extensions"));
    assert.deepEqual(names, ["openviking-memory"], "only the restored target should remain");
    const after = await planInstallRecovery({ extensionTarget, hookTarget, copilotHome: home });
    assert.equal(after.transactionCount, 0);
  });
});

test("refuses to apply without explicit confirmation", async () => {
  await withHome(async ({ home, extensionTarget, hookTarget }) => {
    const id = randomUUID();
    await makeExtension(`${extensionTarget}.backup-${id}`);
    const plan = await planInstallRecovery({ extensionTarget, hookTarget, copilotHome: home });
    await assert.rejects(applyInstallRecovery(plan, {}), /explicit confirmation/);
    await assert.rejects(applyInstallRecovery(plan, { confirm: false }), /explicit confirmation/);
  });
});

test("refuses to apply an unrecoverable plan", async () => {
  await withHome(async ({ home, extensionTarget, hookTarget }) => {
    const id = randomUUID();
    await makeExtension(`${extensionTarget}.staging-${id}`, "someone-else");
    const plan = await planInstallRecovery({ extensionTarget, hookTarget, copilotHome: home });
    await assert.rejects(applyInstallRecovery(plan, { confirm: true }), /unrecoverable/);
  });
});

test("reports a failure without touching later actions when one step throws", async () => {
  await withHome(async ({ home, extensionTarget, hookTarget }) => {
    const id = randomUUID();
    await makeExtension(`${extensionTarget}.backup-${id}`);
    const plan = await planInstallRecovery({ extensionTarget, hookTarget, copilotHome: home });
    const result = await applyInstallRecovery(plan, {
      confirm: true,
      renamePath: async () => {
        throw Object.assign(new Error("denied"), { code: "EPERM" });
      },
    });
    assert.equal(result.applied.length, 0);
    assert.equal(result.failures.length, 1);
    assert.equal(result.failures[0].error, "EPERM");
  });
});