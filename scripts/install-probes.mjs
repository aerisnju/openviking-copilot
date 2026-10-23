import { cp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const copilotHome =
  process.env.COPILOT_HOME || resolve(homedir(), ".copilot");
const extensionTarget = resolve(
  copilotHome,
  "extensions",
  "openviking-host-probe",
);
const hooksDirectory = resolve(copilotHome, "hooks");
const hookTarget = resolve(hooksDirectory, "openviking-host-probe.json");
const resultsDirectory = resolve(
  process.env.OPENVIKING_PROBE_RESULTS_DIR
    || resolve(projectRoot, ".probe-results"),
);
const runId = `${new Date().toISOString().replaceAll(":", "-")}-${randomUUID()}`;
const enableSubagentContextProbe =
  process.env.OPENVIKING_COPILOT_PROBE_SUBAGENT_CONTEXT === "true";
const enableSubAgentStreamingEvents =
  process.env.OPENVIKING_COPILOT_PROBE_STREAM_SUBAGENTS === "true";
const enableMcpProbe =
  process.env.OPENVIKING_COPILOT_PROBE_MCP_ENABLED !== "false";

try {
  const existingConfig = JSON.parse(
    await readFile(resolve(extensionTarget, "probe-config.json"), "utf8"),
  );
  if (existingConfig.owner !== "openviking-copilot-host-probe") {
    throw new Error(
      `Refusing to overwrite unowned extension directory: ${extensionTarget}`,
    );
  }
} catch (error) {
  if (error.code !== "ENOENT") {
    throw error;
  }
  let existingEntries;
  try {
    existingEntries = await readdir(extensionTarget);
  } catch (extensionError) {
    if (extensionError.code !== "ENOENT") {
      throw extensionError;
    }
  }
  if (existingEntries?.length) {
    throw new Error(
      `Refusing to overwrite an extension directory without an ownership marker: ${extensionTarget}`,
    );
  }
}

await mkdir(extensionTarget, { recursive: true });
await mkdir(hooksDirectory, { recursive: true });
await mkdir(resultsDirectory, { recursive: true });

const sourceExtensionDirectory = resolve(projectRoot, "probes", "extension");
const hookSource = resolve(
  projectRoot,
  "probes",
  "hooks",
  "hook-recorder.mjs",
);

await cp(
  resolve(sourceExtensionDirectory, "extension.mjs"),
  resolve(extensionTarget, "extension.mjs"),
);
await cp(
  resolve(sourceExtensionDirectory, "mcp-server.mjs"),
  resolve(extensionTarget, "mcp-server.mjs"),
);
await cp(hookSource, resolve(extensionTarget, "hook-recorder.mjs"));

const probeConfig = {
  owner: "openviking-copilot-host-probe",
  runId,
  outputFile: resolve(resultsDirectory, "extension.ndjson"),
  hookOutputFile: resolve(resultsDirectory, "hooks.ndjson"),
  mcpOutputFile: resolve(resultsDirectory, "mcp.ndjson"),
  nodeExecutable: process.execPath,
  enablePromptMarker: true,
  enableStartupMarker: true,
  enableMcpProbe,
  enableSubAgentStreamingEvents,
  enableSubagentContextProbe,
};
const installedConfigPath = resolve(extensionTarget, "probe-config.json");
await writeFile(
  installedConfigPath,
  `${JSON.stringify(probeConfig, null, 2)}\n`,
  "utf8",
);

const hookEvents = [
  "sessionStart",
  "userPromptSubmitted",
  "agentStop",
  "preCompact",
  "subagentStart",
  "subagentStop",
  "sessionEnd",
];
const hookConfig = {
  version: 1,
  hooks: Object.fromEntries(
    hookEvents.map((eventName) => [
      eventName,
      [
        {
          type: "command",
          exec: process.execPath,
          args: [
            resolve(extensionTarget, "hook-recorder.mjs"),
            installedConfigPath,
            eventName,
          ],
          env: {
            OPENVIKING_COPILOT_PROBE_OWNER:
              "openviking-copilot-host-probe",
          },
          timeoutSec: 5,
        },
      ],
    ]),
  ),
};

try {
  const existing = JSON.parse(await readFile(hookTarget, "utf8"));
  const entries = Object.values(existing.hooks ?? {}).flat();
  if (
    entries.length === 0 ||
    entries.some(
      (entry) =>
        entry.env?.OPENVIKING_COPILOT_PROBE_OWNER !==
        "openviking-copilot-host-probe",
    )
  ) {
    throw new Error(`Refusing to overwrite unowned hook file: ${hookTarget}`);
  }
} catch (error) {
  if (error.code !== "ENOENT") {
    throw error;
  }
}

await writeFile(hookTarget, `${JSON.stringify(hookConfig, null, 2)}\n`, "utf8");
await writeFile(
  resolve(resultsDirectory, "run.json"),
  `${JSON.stringify(
    {
      schemaVersion: 1,
      runId,
      installedAt: new Date().toISOString(),
      projectRoot,
      copilotHome,
      extensionTarget,
      hookTarget,
    },
    null,
    2,
  )}\n`,
  "utf8",
);

process.stdout.write(
  `${JSON.stringify({ runId, extensionTarget, hookTarget, resultsDirectory })}\n`,
);
