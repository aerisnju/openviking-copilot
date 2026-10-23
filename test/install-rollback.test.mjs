import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { replaceInstallTargets } from "../src/install-rollback.mjs";

test("restores both owned installation targets when the second replacement fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "ov-copilot-install-rollback-"));
  const extensionTarget = join(root, "extension");
  const extensionStage = join(root, "extension.staging");
  const extensionBackup = join(root, "extension.backup");
  const hookTarget = join(root, "hook.json");
  const hookStage = join(root, "hook.staging");
  const hookBackup = join(root, "hook.backup");
  const injectedFailure = new Error("simulated hook replacement failure");
  try {
    await mkdir(extensionTarget);
    await mkdir(extensionStage);
    await writeFile(join(extensionTarget, "version.txt"), "old");
    await writeFile(join(extensionStage, "version.txt"), "new");
    await writeFile(hookTarget, "old hook");
    await writeFile(hookStage, "new hook");
    const renamePath = async (from, to) => {
      if (from === hookStage && to === hookTarget) throw injectedFailure;
      await rename(from, to);
    };

    await assert.rejects(
      replaceInstallTargets(
        [
          { staged: extensionStage, target: extensionTarget, backup: extensionBackup },
          { staged: hookStage, target: hookTarget, backup: hookBackup },
        ],
        renamePath,
      ),
      (error) => error === injectedFailure,
    );
    assert.equal(await readFile(join(extensionTarget, "version.txt"), "utf8"), "old");
    assert.equal(await readFile(hookTarget, "utf8"), "old hook");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
