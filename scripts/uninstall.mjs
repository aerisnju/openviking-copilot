import { lstat, readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { assertNoInterruptedInstallArtifacts } from "../src/install-artifacts.mjs";

const copilotHome = resolve(process.env.COPILOT_HOME || resolve(homedir(), ".copilot"));
const extensionTarget = resolve(copilotHome, "extensions", "openviking-memory");
const installConfigPath = resolve(extensionTarget, "install-config.json");
const hookTarget = resolve(copilotHome, "hooks", "openviking-memory.json");
const owner = "openviking-copilot";

async function readOwnedExtension() {
  let targetStat;
  try {
    targetStat = await lstat(extensionTarget);
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
  if (targetStat.isSymbolicLink() || !targetStat.isDirectory()) {
    throw new Error(`Refusing to remove a non-directory or symlink: ${extensionTarget}`);
  }
  const marker = JSON.parse(await readFile(installConfigPath, "utf8"));
  if (marker.owner !== owner) {
    throw new Error(`Refusing to remove an extension not owned by ${owner}: ${extensionTarget}`);
  }
  return true;
}

async function readOwnedHook() {
  try {
    const hook = JSON.parse(await readFile(hookTarget, "utf8"));
    const entries = Object.values(hook.hooks ?? {}).flat();
    if (
      entries.length === 0 ||
      entries.some((entry) => entry.env?.OPENVIKING_COPILOT_HOOK_OWNER !== owner)
    ) {
      throw new Error(`Refusing to remove an unowned hook file: ${hookTarget}`);
    }
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

await assertNoInterruptedInstallArtifacts([extensionTarget, hookTarget]);
const [removeExtension, removeHook] = await Promise.all([
  readOwnedExtension(),
  readOwnedHook(),
]);
if (!removeExtension && !removeHook) {
  process.stdout.write(`${JSON.stringify({ removed: false, reason: "not-installed" })}\n`);
  process.exit(0);
}
if (removeHook) await rm(hookTarget);
if (removeExtension) await rm(extensionTarget, { recursive: true });
process.stdout.write(
  `${JSON.stringify({ removedExtension: removeExtension, removedHook: removeHook, extensionTarget, hookTarget })}\n`,
);
