import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import test from "node:test";
import { chmod, cp, mkdtemp, readFile, readdir, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function runScript(script, copilotHome) {
  if (script === "install.mjs") return runInstaller(copilotHome);
  return execFileAsync(process.execPath, [resolve(projectRoot, "scripts", script)], {
    cwd: projectRoot,
    env: { ...process.env, COPILOT_HOME: copilotHome },
  });
}

async function runScriptWithEnvironment(script, environment) {
  return execFileAsync(process.execPath, [resolve(projectRoot, "scripts", script)], {
    cwd: projectRoot,
    env: { ...process.env, ...environment },
  });
}

async function runInstaller(copilotHome, args = [], version = "1.0.95-3") {
  const shimDirectory = await mkdtemp(join(tmpdir(), "ov-copilot-cli-shim-"));
  const shimPath = join(
    shimDirectory,
    process.platform === "win32" ? "copilot.cmd" : "copilot",
  );
  const shim = process.platform === "win32"
    ? "@echo off\r\necho GitHub Copilot CLI %OV_TEST_CLI_VERSION%\r\n"
    : '#!/bin/sh\necho "GitHub Copilot CLI $OV_TEST_CLI_VERSION"\n';
  try {
    await writeFile(shimPath, shim, "utf8");
    if (process.platform !== "win32") await chmod(shimPath, 0o755);
    return await execFileAsync(
      process.execPath,
      [resolve(projectRoot, "scripts", "install.mjs"), ...args],
      {
        cwd: projectRoot,
        env: {
          ...process.env,
          COPILOT_HOME: copilotHome,
          OV_TEST_CLI_VERSION: version,
          PATH: `${shimDirectory}${process.platform === "win32" ? ";" : ":"}${process.env.PATH}`,
        },
      },
    );
  } finally {
    await rm(shimDirectory, { recursive: true, force: true });
  }
}

async function runInstallDryRun(copilotHome) {
  return runInstaller(copilotHome, ["--dry-run"]);
}

test("installs the owned extension layout with an explicit Node executable and uninstalls it", async () => {
  const copilotHome = await mkdtemp(join(tmpdir(), "ov-copilot-install-"));
  const target = join(copilotHome, "extensions", "openviking-memory");
  const hookTarget = join(copilotHome, "hooks", "openviking-memory.json");
  const unrelatedHookTarget = join(copilotHome, "hooks", "user-hooks.json");
  const unrelatedHook = JSON.stringify({ version: 1, hooks: { sessionStart: [] } });
  try {
    await mkdir(join(copilotHome, "hooks"), { recursive: true });
    await writeFile(unrelatedHookTarget, unrelatedHook);
    await runScript("install.mjs", copilotHome);
    await writeFile(join(target, "stale-runtime-file.txt"), "obsolete");
    await runScript("install.mjs", copilotHome);
    await assert.rejects(readFile(join(target, "stale-runtime-file.txt")), { code: "ENOENT" });
    assert.deepEqual(await readdir(join(copilotHome, "extensions")), ["openviking-memory"]);
    assert.deepEqual(
      (await readdir(join(copilotHome, "hooks"))).sort(),
      ["openviking-memory.json", "user-hooks.json"],
    );
    const config = JSON.parse(await readFile(join(target, "install-config.json"), "utf8"));
    assert.equal(config.owner, "openviking-copilot");
    assert.equal(config.minimumCopilotCliVersion, "1.0.95-3");
    assert.equal(config.copilotCliVersion, "1.0.95-3");
    assert.equal(config.nodeExecutable, process.execPath);
    assert.equal(config.hookOwner, "openviking-copilot");
    assert.equal(await readFile(join(target, "extension.mjs"), "utf8").then((text) => text.includes("joinSession")), true);
    assert.equal(await readFile(join(target, "mcp-proxy.mjs"), "utf8").then((text) => text.includes("createOpenVikingMcpProxy")), true);
    assert.equal(await readFile(join(target, "pre-compact-hook.mjs"), "utf8").then((text) => text.includes("runPreCompactHook")), true);
    const hook = JSON.parse(await readFile(hookTarget, "utf8"));
    const [preCompact] = hook.hooks.preCompact;
    assert.equal(preCompact.type, "command");
    assert.equal(preCompact.exec, process.execPath);
    assert.deepEqual(preCompact.args, [join(target, "pre-compact-hook.mjs")]);
    assert.equal(preCompact.env.OPENVIKING_COPILOT_HOOK_OWNER, "openviking-copilot");
    assert.equal(preCompact.timeoutSec, 10);

    await runScript("uninstall.mjs", copilotHome);
    await assert.rejects(readFile(join(target, "install-config.json")), { code: "ENOENT" });
    await assert.rejects(readFile(hookTarget), { code: "ENOENT" });
    assert.equal(await readFile(unrelatedHookTarget, "utf8"), unrelatedHook);
  } finally {
    await rm(copilotHome, { recursive: true, force: true });
  }
});

test("installer dry-run reports planned targets without creating or changing files", async () => {
  const copilotHome = await mkdtemp(join(tmpdir(), "ov-copilot-dry-run-"));
  try {
    const result = await runInstallDryRun(copilotHome);
    const plan = JSON.parse(result.stdout);
    assert.equal(plan.dryRun, true);
    assert.equal(plan.copilotCliVersion, "1.0.95-3");
    assert.equal(plan.minimumCopilotCliVersion, "1.0.95-3");
    assert.equal(plan.extensionTarget, join(copilotHome, "extensions", "openviking-memory"));
    assert.equal(plan.hookTarget, join(copilotHome, "hooks", "openviking-memory.json"));
    assert.equal(plan.replacesOwnedExtension, false);
    assert.equal(plan.replacesOwnedHook, false);
    assert.deepEqual(await readdir(copilotHome), []);
  } finally {
    await rm(copilotHome, { recursive: true, force: true });
  }
});

test("host-smoke-only installation persistently disables remote hooks and MCP", async () => {
  const copilotHome = await mkdtemp(join(tmpdir(), "ov-copilot-host-smoke-"));
  const target = join(copilotHome, "extensions", "openviking-memory");
  const hookTarget = join(copilotHome, "hooks", "openviking-memory.json");
  try {
    const plan = JSON.parse((await runInstaller(copilotHome, ["--dry-run", "--host-smoke-only"])).stdout);
    assert.equal(plan.hostSmokeOnly, true);
    assert.deepEqual(await readdir(copilotHome), []);

    await runInstaller(copilotHome, ["--host-smoke-only"]);
    const config = JSON.parse(await readFile(join(target, "install-config.json"), "utf8"));
    assert.equal(config.hostSmokeOnly, true);
    const hook = JSON.parse(await readFile(hookTarget, "utf8")).hooks.preCompact[0];
    const result = await execFileAsync(hook.exec, hook.args, {
      input: "",
      env: {
        ...process.env,
        OPENVIKING_COPILOT_HOOK_OWNER: "openviking-copilot",
        OPENVIKING_COPILOT_INTEGRATION_TEST: "true",
      },
    });
    assert.match(result.stderr, /pre-compact-skipped.*host-smoke-only/);
    await runScript("uninstall.mjs", copilotHome);
    await assert.rejects(readFile(join(target, "install-config.json")), { code: "ENOENT" });
    await assert.rejects(readFile(hookTarget), { code: "ENOENT" });
  } finally {
    await rm(copilotHome, { recursive: true, force: true });
  }
});

test("refuses unsupported Copilot CLI versions before mutating the profile", async () => {
  const copilotHome = await mkdtemp(join(tmpdir(), "ov-copilot-old-cli-"));
  try {
    await assert.rejects(
      runInstaller(copilotHome, [], "1.0.89"),
      /minimum supported version is 1\.0\.95-3/,
    );
    assert.deepEqual(await readdir(copilotHome), []);
  } finally {
    await rm(copilotHome, { recursive: true, force: true });
  }
});

test("refuses interrupted install artifacts without altering their contents", async () => {
  for (const relative of [
    join("extensions", `openviking-memory.backup-${randomUUID()}`),
    join("hooks", `openviking-memory.json.staging-${randomUUID()}`),
  ]) {
    const copilotHome = await mkdtemp(join(tmpdir(), "ov-copilot-interrupted-"));
    const artifact = join(copilotHome, relative);
    try {
      await mkdir(dirname(artifact), { recursive: true });
      if (relative.startsWith("extensions")) {
        await mkdir(artifact);
        await writeFile(join(artifact, "version.txt"), "preserved");
      } else {
        await writeFile(artifact, "preserved");
      }
      await assert.rejects(runInstaller(copilotHome, ["--dry-run"]), /interrupted installation artifact/);
      await assert.rejects(runInstaller(copilotHome), /interrupted installation artifact/);
      await assert.rejects(runScript("uninstall.mjs", copilotHome), /interrupted installation artifact/);
      assert.equal(
        await readFile(relative.startsWith("extensions") ? join(artifact, "version.txt") : artifact, "utf8"),
        "preserved",
      );
      await assert.rejects(readFile(join(copilotHome, "extensions", "openviking-memory", "install-config.json")), { code: "ENOENT" });
      await assert.rejects(readFile(join(copilotHome, "hooks", "openviking-memory.json")), { code: "ENOENT" });
    } finally {
      await rm(copilotHome, { recursive: true, force: true });
    }
  }
});

test("preserves owned backups when a child installer is terminated during replacement", {
  timeout: 20_000,
}, async () => {
  for (const stopAfterMove of [1, 2, 3, 4]) {
    const copilotHome = await mkdtemp(join(tmpdir(), "ov-copilot-crash-"));
    const extensionTarget = join(copilotHome, "extensions", "openviking-memory");
    const hookTarget = join(copilotHome, "hooks", "openviking-memory.json");
    const transactionId = randomUUID();
    const extensionStage = `${extensionTarget}.staging-${transactionId}`;
    const extensionBackup = `${extensionTarget}.backup-${transactionId}`;
    const hookStage = `${hookTarget}.staging-${transactionId}`;
    const hookBackup = `${hookTarget}.backup-${transactionId}`;
    let child;
    try {
      await runInstaller(copilotHome);
      await writeFile(join(extensionTarget, "version.txt"), "old extension");
      const oldHook = await readFile(hookTarget, "utf8");
      await cp(extensionTarget, extensionStage, { recursive: true });
      await writeFile(join(extensionStage, "version.txt"), "new extension");
      await writeFile(hookStage, oldHook);
      child = spawn(
        process.execPath,
        [
          resolve(projectRoot, "test-support", "interrupted-install-worker.mjs"),
          extensionTarget, extensionStage, extensionBackup, hookTarget, hookStage, hookBackup,
        ],
        { stdio: ["ignore", "ignore", "pipe", "ipc"] },
      );
      for (let move = 1; move <= stopAfterMove; move += 1) {
        const nextMove = await new Promise((resolveMove, reject) => {
          child.once("message", resolveMove);
          child.once("error", reject);
          child.once("exit", () => reject(new Error("Installer child exited before the rename")));
        });
        assert.equal(nextMove.to, [
          extensionBackup, extensionTarget, hookBackup, hookTarget,
        ][move - 1]);
        if (move < stopAfterMove) child.send("continue");
      }
      const exited = new Promise((resolveExit) => child.once("exit", resolveExit));
      child.kill("SIGKILL");
      await exited;

      await assert.rejects(runInstaller(copilotHome, ["--dry-run"]), /interrupted installation artifact/);
      await assert.rejects(runInstaller(copilotHome), /interrupted installation artifact/);
      await assert.rejects(runScript("uninstall.mjs", copilotHome), /interrupted installation artifact/);
      assert.equal(await readFile(join(extensionBackup, "version.txt"), "utf8"), "old extension");
      if (stopAfterMove >= 3) assert.equal(await readFile(hookBackup, "utf8"), oldHook);
      else assert.equal(await readFile(hookTarget, "utf8"), oldHook);
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) {
        const exited = new Promise((resolveExit) => child.once("exit", resolveExit));
        child.kill("SIGKILL");
        await exited;
      }
      await rm(copilotHome, { recursive: true, force: true });
    }
  }
});

test("installer dry-run leaves an existing owned installation unchanged", async () => {
  const copilotHome = await mkdtemp(join(tmpdir(), "ov-copilot-dry-run-owned-"));
  const target = join(copilotHome, "extensions", "openviking-memory");
  const hookTarget = join(copilotHome, "hooks", "openviking-memory.json");
  try {
    await runScript("install.mjs", copilotHome);
    const beforeConfig = await readFile(join(target, "install-config.json"), "utf8");
    const beforeHook = await readFile(hookTarget, "utf8");
    const result = await runInstallDryRun(copilotHome);
    const plan = JSON.parse(result.stdout);
    assert.equal(plan.replacesOwnedExtension, true);
    assert.equal(plan.replacesOwnedHook, true);
    assert.equal(await readFile(join(target, "install-config.json"), "utf8"), beforeConfig);
    assert.equal(await readFile(hookTarget, "utf8"), beforeHook);
  } finally {
    await rm(copilotHome, { recursive: true, force: true });
  }
});

test("refuses to overwrite an extension without its ownership marker", async () => {
  const copilotHome = await mkdtemp(join(tmpdir(), "ov-copilot-unowned-"));
  const target = join(copilotHome, "extensions", "openviking-memory");
  try {
    await mkdir(target, { recursive: true });
    await writeFile(join(target, "do-not-touch.txt"), "not ours");
    await assert.rejects(runScript("install.mjs", copilotHome), /without an ownership marker/);
    assert.equal(await readFile(join(target, "do-not-touch.txt"), "utf8"), "not ours");
  } finally {
    await rm(copilotHome, { recursive: true, force: true });
  }
});

test("refuses to overwrite an unowned hook file before changing the extension", async () => {
  const copilotHome = await mkdtemp(join(tmpdir(), "ov-copilot-unowned-hook-"));
  const extensionTarget = join(copilotHome, "extensions", "openviking-memory");
  const hooksDirectory = join(copilotHome, "hooks");
  const hookTarget = join(hooksDirectory, "openviking-memory.json");
  const original = JSON.stringify({ version: 1, hooks: { preCompact: [{ type: "command" }] } });
  try {
    await mkdir(hooksDirectory, { recursive: true });
    await writeFile(hookTarget, original);
    await assert.rejects(runScript("install.mjs", copilotHome), /unowned hook file/);
    assert.equal(await readFile(hookTarget, "utf8"), original);
    await assert.rejects(readFile(extensionTarget), { code: "ENOENT" });
  } finally {
    await rm(copilotHome, { recursive: true, force: true });
  }
});

test("refuses to uninstall the extension when its hook file is no longer owned", async () => {
  const copilotHome = await mkdtemp(join(tmpdir(), "ov-copilot-uninstall-hook-"));
  const extensionTarget = join(copilotHome, "extensions", "openviking-memory");
  const hookTarget = join(copilotHome, "hooks", "openviking-memory.json");
  try {
    await runScript("install.mjs", copilotHome);
    const replacement = JSON.stringify({ version: 1, hooks: { preCompact: [{ type: "command" }] } });
    await writeFile(hookTarget, replacement);
    await assert.rejects(runScript("uninstall.mjs", copilotHome), /unowned hook file/);
    assert.equal(await readFile(join(extensionTarget, "install-config.json"), "utf8").then(Boolean), true);
    assert.equal(await readFile(hookTarget, "utf8"), replacement);
  } finally {
    await rm(copilotHome, { recursive: true, force: true });
  }
});

test("installs the host probe into isolated home and results directories", async () => {
  const root = await mkdtemp(join(tmpdir(), "ov-copilot-probe-install-"));
  const copilotHome = join(root, "copilot-home");
  const resultsDirectory = join(root, "probe-results");
  try {
    const result = await runScriptWithEnvironment("install-probes.mjs", {
      COPILOT_HOME: copilotHome,
      OPENVIKING_PROBE_RESULTS_DIR: resultsDirectory,
    });
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.resultsDirectory, resultsDirectory);
    const probeConfig = JSON.parse(
      await readFile(
        join(copilotHome, "extensions", "openviking-host-probe", "probe-config.json"),
        "utf8",
      ),
    );
    assert.equal(probeConfig.enableSubagentContextProbe, false);
    assert.equal(probeConfig.enableSubAgentStreamingEvents, false);
    assert.equal(probeConfig.enableMcpProbe, true);
    assert.equal("subagentContextMarker" in probeConfig, false);
    assert.equal(
      await readFile(join(copilotHome, "hooks", "openviking-host-probe.json"), "utf8")
        .then((text) => text.includes("preCompact")),
      true,
    );
    assert.equal(await readFile(join(resultsDirectory, "run.json"), "utf8").then(Boolean), true);

    await runScriptWithEnvironment("uninstall-probes.mjs", {
      COPILOT_HOME: copilotHome,
    });
    await assert.rejects(
      readFile(join(copilotHome, "hooks", "openviking-host-probe.json")),
      { code: "ENOENT" },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("enables synthetic subagent context injection only when explicitly requested", async () => {
  const root = await mkdtemp(join(tmpdir(), "ov-copilot-subagent-probe-"));
  const copilotHome = join(root, "copilot-home");
  try {
    await runScriptWithEnvironment("install-probes.mjs", {
      COPILOT_HOME: copilotHome,
      OPENVIKING_COPILOT_PROBE_SUBAGENT_CONTEXT: "true",
      OPENVIKING_COPILOT_PROBE_STREAM_SUBAGENTS: "true",
      OPENVIKING_COPILOT_PROBE_MCP_ENABLED: "false",
    });
    const config = JSON.parse(
      await readFile(
        join(
          copilotHome,
          "extensions",
          "openviking-host-probe",
          "probe-config.json",
        ),
        "utf8",
      ),
    );
    assert.equal(config.enableSubagentContextProbe, true);
    assert.equal(config.enableSubAgentStreamingEvents, true);
    assert.equal(config.enableMcpProbe, false);
    assert.equal("subagentContextMarker" in config, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
