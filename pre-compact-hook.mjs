import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { makeAgentFetchJSON } from "./vendor/openviking-memory-plugin-shared/lib/agent-hook-runtime.mjs";
import { buildPluginConfig } from "./vendor/openviking-memory-plugin-shared/lib/plugin-config.mjs";
import { DurableSessionStore } from "./src/durable-session-store.mjs";
import {
  resolveIntegrationTestMode,
  shouldRunIntegrationTestPreCompact,
} from "./src/integration-test-mode.mjs";
import { runPreCompactHook } from "./src/pre-compact-hook.mjs";
import { applyExcludedTools } from "./src/capture-config.mjs";

const owner = "openviking-copilot";
const extensionDirectory = dirname(fileURLToPath(import.meta.url));
const installConfigPath = resolve(extensionDirectory, "install-config.json");
const maximumInputBytes = 1024 * 1024;

function log(event, detail = {}) {
  process.stderr.write(`[openviking-copilot] ${event} ${JSON.stringify(detail)}\n`);
}

async function readInput() {
  const chunks = [];
  let byteCount = 0;
  for await (const chunk of process.stdin) {
    byteCount += chunk.length;
    if (byteCount > maximumInputBytes) {
      throw new Error("preCompact input exceeded the 1 MiB safety limit");
    }
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

try {
  if (process.env.OPENVIKING_COPILOT_HOOK_OWNER !== owner) {
    throw new Error("preCompact hook ownership marker is missing");
  }
  const installed = JSON.parse(await readFile(installConfigPath, "utf8"));
  if (installed.owner !== owner) {
    throw new Error("preCompact hook installation marker is invalid");
  }
  if (installed.hostSmokeOnly === true) {
    log("pre-compact-skipped", { reason: "host-smoke-only" });
    process.exitCode = 0;
  } else {
    const integrationTestMode = resolveIntegrationTestMode();
    const runScopedIntegrationHook = shouldRunIntegrationTestPreCompact(integrationTestMode);
    if (integrationTestMode && !runScopedIntegrationHook) {
      log("pre-compact-skipped", { reason: "integration-test-mode" });
      process.exitCode = 0;
    } else {
      const input = await readInput();
      const baseConfig = applyExcludedTools(buildPluginConfig("copilot", { cwd: input?.cwd }));
      const config = integrationTestMode
        ? { ...baseConfig, peerId: integrationTestMode.peerId, autoRecall: false }
        : baseConfig;
      const { fetchJSON } = makeAgentFetchJSON(config, input?.cwd);
      const store = new DurableSessionStore({
        sessionId: input?.sessionId,
        lockWaitMs: 1_000,
      });
      const result = await runPreCompactHook(input, {
        config,
        fetchJSON,
        store,
        openVikingSessionId: integrationTestMode?.sessionId,
        sessionMemoryPolicy: integrationTestMode?.memoryPolicy,
        logger: log,
      });
      if (!result?.ok) {
        log("pre-compact-incomplete", { reason: result?.reason || "request-failed" });
      } else {
        log("pre-compact-complete", { skipped: result.skipped === true });
      }
    }
  }
} catch (error) {
  log("pre-compact-failed-open", { name: error?.name || "Error" });
}
