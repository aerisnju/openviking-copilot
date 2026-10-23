import { rename } from "node:fs/promises";
import { replaceInstallTargets } from "../src/install-rollback.mjs";

const [extensionTarget, extensionStage, extensionBackup, hookTarget, hookStage, hookBackup] =
  process.argv.slice(2);

await replaceInstallTargets(
  [
    { target: extensionTarget, staged: extensionStage, backup: extensionBackup },
    { target: hookTarget, staged: hookStage, backup: hookBackup },
  ],
  async (from, to) => {
    await rename(from, to);
    process.send({ from, to });
    await new Promise((resolve) => process.once("message", resolve));
  },
);
