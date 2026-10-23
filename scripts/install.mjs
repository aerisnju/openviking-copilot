import { cp, lstat, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { execSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { assertSupportedCopilotCliVersion } from "../src/copilot-cli-version.mjs";
import { assertNoInterruptedInstallArtifacts } from "../src/install-artifacts.mjs";
import { replaceInstallTargets } from "../src/install-rollback.mjs";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const copilotHome = resolve(process.env.COPILOT_HOME || resolve(homedir(), ".copilot"));
const extensionTarget = resolve(copilotHome, "extensions", "openviking-memory");
const hooksDirectory = resolve(copilotHome, "hooks");
const hookTarget = resolve(hooksDirectory, "openviking-memory.json");
const owner = "openviking-copilot";
// 1.0.95-3 is the oldest host this integration has been verified against.
// The dynamic-MCP projection check calls `session.rpc.mcp.reload()` and
// `session.rpc.tools.getCurrentMetadata()`; installing on an older host would
// claim support for RPCs that were never exercised. The check itself fails open,
// but the installer should not advertise untested versions.
const minimumCopilotCliVersion = "1.0.95-3";
const dryRun = process.argv.slice(2).includes("--dry-run");
const hostSmokeOnly = process.argv.slice(2).includes("--host-smoke-only");

function getCopilotCliVersion() {
  let output;
  try {
    const options = {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 5000,
      windowsHide: true,
    };
    output = execSync("copilot --version", options);
  } catch (error) {
    throw new Error(
      `Unable to verify Copilot CLI version. Install Copilot CLI ${minimumCopilotCliVersion} or newer and ensure 'copilot --version' works: ${error.message}`,
      { cause: error },
    );
  }
  return assertSupportedCopilotCliVersion(output, minimumCopilotCliVersion);
}

async function exists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function ensureOwnedOrEmptyTarget() {
  let targetStat;
  try {
    targetStat = await lstat(extensionTarget);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  if (targetStat.isSymbolicLink() || !targetStat.isDirectory()) {
    throw new Error(`Refusing to install over a non-directory or symlink: ${extensionTarget}`);
  }
  try {
    const marker = JSON.parse(await readFile(resolve(extensionTarget, "install-config.json"), "utf8"));
    if (marker.owner !== owner) {
      throw new Error(`Refusing to overwrite an extension not owned by ${owner}: ${extensionTarget}`);
    }
  } catch (error) {
    if (error.code === "ENOENT") {
      if ((await readdir(extensionTarget)).length === 0) return;
      throw new Error(`Refusing to overwrite an extension without an ownership marker: ${extensionTarget}`);
    }
    throw error;
  }
}

async function ensureOwnedHookOrMissing() {
  try {
    const existing = JSON.parse(await readFile(hookTarget, "utf8"));
    const entries = Object.values(existing.hooks ?? {}).flat();
    if (
      entries.length === 0 ||
      entries.some((entry) => entry.env?.OPENVIKING_COPILOT_HOOK_OWNER !== owner)
    ) {
      throw new Error(`Refusing to overwrite an unowned hook file: ${hookTarget}`);
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

const copilotCliVersion = getCopilotCliVersion();
await assertNoInterruptedInstallArtifacts([extensionTarget, hookTarget]);
await ensureOwnedOrEmptyTarget();
await ensureOwnedHookOrMissing();

if (dryRun) {
  process.stdout.write(
    `${JSON.stringify({
      dryRun: true,
      copilotCliVersion,
      minimumCopilotCliVersion,
      extensionTarget,
      hookTarget,
      nodeExecutable: process.execPath,
      hostSmokeOnly,
      replacesOwnedExtension: await exists(extensionTarget),
      replacesOwnedHook: await exists(hookTarget),
    })}\n`,
  );
  process.exit(0);
}

await mkdir(dirname(extensionTarget), { recursive: true });
await mkdir(hooksDirectory, { recursive: true });

const transactionId = randomUUID();
const extensionStage = `${extensionTarget}.staging-${transactionId}`;
const extensionBackup = `${extensionTarget}.backup-${transactionId}`;
const hookStage = `${hookTarget}.staging-${transactionId}`;
const hookBackup = `${hookTarget}.backup-${transactionId}`;
const installConfig = {
  owner,
  schemaVersion: 1,
  installedAt: new Date().toISOString(),
  copilotCliVersion,
  minimumCopilotCliVersion,
  nodeExecutable: process.execPath,
  proxyEntry: "mcp-proxy.mjs",
  hookOwner: owner,
  hostSmokeOnly,
};

const hookConfig = {
  version: 1,
  hooks: {
    preCompact: [
      {
        type: "command",
        exec: process.execPath,
        args: [resolve(extensionTarget, "pre-compact-hook.mjs")],
        env: { OPENVIKING_COPILOT_HOOK_OWNER: owner },
        timeoutSec: 10,
      },
    ],
  },
};

try {
  await mkdir(extensionStage);
  for (const entry of ["src", "vendor"]) {
    await cp(resolve(projectRoot, entry), resolve(extensionStage, entry), {
      recursive: true,
      force: true,
    });
  }
  for (const entry of ["extension.mjs", "mcp-proxy.mjs", "pre-compact-hook.mjs"]) {
    await cp(resolve(projectRoot, entry), resolve(extensionStage, entry));
  }
  await writeFile(
    resolve(extensionStage, "install-config.json"),
    `${JSON.stringify(installConfig, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  await writeFile(hookStage, `${JSON.stringify(hookConfig, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });

  await replaceInstallTargets([
    { staged: extensionStage, target: extensionTarget, backup: extensionBackup },
    { staged: hookStage, target: hookTarget, backup: hookBackup },
  ]);
} catch (error) {
  await Promise.all(
    [extensionStage, hookStage].map((path) => rm(path, { recursive: true, force: true })),
  );
  throw error;
}

await Promise.all([
  rm(extensionBackup, { recursive: true, force: true }),
  rm(hookBackup, { recursive: true, force: true }),
]);

process.stdout.write(
  `${JSON.stringify({ extensionTarget, hookTarget, nodeExecutable: process.execPath, copilotCliVersion })}\n`,
);
