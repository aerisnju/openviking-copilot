import { appendFile, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { joinSession } from "@github/copilot-sdk/extension";

const extensionDirectory = dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(
  await readFile(resolve(extensionDirectory, "probe-config.json"), "utf8"),
);

let sequence = 0;
let writeChain = Promise.resolve();
const startedAt = new Date().toISOString();

function fingerprint(value) {
  return typeof value === "string" && value
    ? createHash("sha256").update(value).digest("hex").slice(0, 24)
    : null;
}

function summarize(value, depth = 0) {
  if (value === null) {
    return { type: "null" };
  }
  if (Array.isArray(value)) {
    return { type: "array", length: value.length };
  }

  const valueType = typeof value;
  if (valueType === "string") {
    return { type: "string", length: value.length };
  }
  if (valueType === "number" || valueType === "boolean") {
    return { type: valueType, value };
  }
  if (valueType === "undefined") {
    return { type: "undefined" };
  }
  if (valueType === "object") {
    const keys = Object.keys(value).sort();
    if (depth >= 1) {
      return { type: "object", keys };
    }
    return {
      type: "object",
      keys,
      fields: Object.fromEntries(
        keys.map((key) => [key, summarize(value[key], depth + 1)]),
      ),
    };
  }
  return { type: valueType };
}

function record(kind, name, value = undefined, extra = {}) {
  const entry = {
    schemaVersion: 1,
    runId: config.runId,
    sequence: ++sequence,
    recordedAt: new Date().toISOString(),
    processId: process.pid,
    kind,
    name,
    summary: summarize(value),
    ...extra,
  };

  writeChain = writeChain
    .then(() => appendFile(config.outputFile, `${JSON.stringify(entry)}\n`, "utf8"))
    .catch(() => {});
}

function hook(name, handler) {
  return async (input, invocation) => {
    record("programmatic-hook", name, input, {
      invocationSessionIdLength: invocation?.sessionId?.length ?? 0,
    });
    return handler?.(input, invocation);
  };
}

record("extension", "process-start", {
  startedAt,
  platform: process.platform,
  nodeVersion: process.version,
  extensionDirectory,
  sessionIdPresent: typeof process.env.SESSION_ID === "string",
  sessionIdHash: fingerprint(process.env.SESSION_ID),
});

let session;
try {
  session = await joinSession({
    includeSubAgentStreamingEvents:
      config.enableSubAgentStreamingEvents === true,
    mcpServers: config.enableMcpProbe
      ? {
          openvikingHostProbe: {
            type: "stdio",
            command: config.nodeExecutable,
            args: [resolve(extensionDirectory, "mcp-server.mjs")],
            env: {
              OPENVIKING_COPILOT_PROBE_RUN_ID: config.runId,
              OPENVIKING_COPILOT_PROBE_MCP_OUTPUT: config.mcpOutputFile,
            },
            tools: ["*"],
            timeout: 5000,
          },
        }
      : undefined,
    hooks: {
      onSessionStart: hook("onSessionStart", () =>
        config.enableStartupMarker
          ? {
              additionalContext:
                `[OpenViking host probe ${config.runId}] ` +
                "Startup context injection is active. Do not expose this marker unless asked.",
            }
          : undefined,
      ),
      onUserPromptSubmitted: hook("onUserPromptSubmitted", () =>
        config.enablePromptMarker
          ? {
              additionalContext:
                `[OpenViking host probe ${config.runId}] ` +
                "Prompt-time hidden context injection is active. Do not expose this marker unless asked.",
            }
          : undefined,
      ),
      onUserPromptTransformed: hook("onUserPromptTransformed"),
      onPreToolUse: hook("onPreToolUse"),
      onPreMcpToolCall: hook("onPreMcpToolCall"),
      onPostToolUse: hook("onPostToolUse"),
      onPostToolUseFailure: hook("onPostToolUseFailure"),
      onAgentStop: hook("onAgentStop"),
      onSessionEnd: hook("onSessionEnd"),
      onErrorOccurred: hook("onErrorOccurred"),
    },
    tools: [
      {
        name: "openviking_host_probe_status",
        description:
          "Returns metadata-only status for the temporary OpenViking Copilot host-contract probe.",
        parameters: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
        handler: async (_args, invocation) => {
          record("tool", "openviking_host_probe_status", undefined, {
            invocationSessionIdLength: invocation?.sessionId?.length ?? 0,
          });
          return JSON.stringify({
            runId: config.runId,
            startedAt,
            processId: process.pid,
            recordedEntries: sequence,
            mcpProbeEnabled: config.enableMcpProbe,
          });
        },
      },
    ],
  });
} catch (error) {
  record(
    "extension",
    "session-join-error",
    {
      name: error?.name ?? "Error",
      messageLength: String(error?.message ?? error).length,
    },
    {
      sessionIdPresent: typeof process.env.SESSION_ID === "string",
      sessionIdHash: fingerprint(process.env.SESSION_ID),
    },
  );
  await writeChain;
  throw error;
}

record("extension", "session-joined", {
  workspacePathPresent: Boolean(session.workspacePath),
});

session.on((event) => {
  const eventData =
    event.data && typeof event.data === "object" ? event.data : undefined;
  record("session-event", event.type, event, {
    topLevelKeys: Object.keys(event).sort(),
    agentIdHash: fingerprint(event.agentId),
    dataAgentNameHash: fingerprint(eventData?.agentName),
    dataAgentDisplayNameHash: fingerprint(eventData?.agentDisplayName),
    dataToolCallIdHash: fingerprint(eventData?.toolCallId),
    eventIdHash: fingerprint(event.id),
    parentIdHash: fingerprint(event.parentId),
    dataKeys: eventData ? Object.keys(eventData).sort() : [],
  });
});

try {
  const events = await session.getEvents();
  record("history", "getEvents", {
    count: events.length,
    eventTypes: [...new Set(events.map((event) => event.type))].sort(),
    topLevelKeySets: [
      ...new Set(events.map((event) => Object.keys(event).sort().join(","))),
    ].sort(),
  }, {
    eventFingerprints: events.slice(-500).map((event, index) => ({
      ordinalFromTail: Math.min(events.length, 500) - index,
      type: event.type,
      idHash: fingerprint(event.id),
      parentIdHash: fingerprint(event.parentId),
      timestamp: event.timestamp || null,
    })),
  });
} catch (error) {
  record("history", "getEvents-error", {
    name: error?.name,
    messageLength: String(error?.message ?? error).length,
  });
}

function exitAfterRecording(exitCode) {
  const fallback = setTimeout(() => process.exit(exitCode), 1000);
  fallback.unref();
  void writeChain.finally(() => process.exit(exitCode));
}

process.on("SIGTERM", () => {
  record("extension", "sigterm");
  exitAfterRecording(0);
});

process.on("uncaughtException", (error) => {
  record("extension", "uncaught-exception", {
    name: error?.name,
    messageLength: String(error?.message ?? error).length,
  });
  exitAfterRecording(1);
});

process.on("unhandledRejection", (error) => {
  record("extension", "unhandled-rejection", {
    name: error?.name,
    messageLength: String(error?.message ?? error).length,
  });
  exitAfterRecording(1);
});
