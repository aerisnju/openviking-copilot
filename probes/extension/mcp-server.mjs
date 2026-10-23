import { appendFile } from "node:fs/promises";
import { createInterface } from "node:readline";

const outputFile = process.env.OPENVIKING_COPILOT_PROBE_MCP_OUTPUT;
const runId = process.env.OPENVIKING_COPILOT_PROBE_RUN_ID ?? "unknown";
let sequence = 0;
let writeChain = Promise.resolve();

function record(name, metadata = {}) {
  if (!outputFile) {
    return;
  }
  const entry = {
    schemaVersion: 1,
    runId,
    sequence: ++sequence,
    recordedAt: new Date().toISOString(),
    processId: process.pid,
    kind: "mcp",
    name,
    ...metadata,
  };
  writeChain = writeChain
    .then(() => appendFile(outputFile, `${JSON.stringify(entry)}\n`, "utf8"))
    .catch(() => {});
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function result(id, value) {
  send({ jsonrpc: "2.0", id, result: value });
}

function error(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

record("process-start", {
  platform: process.platform,
  nodeVersion: process.version,
});

const lines = createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

lines.on("line", (line) => {
  if (!line.trim()) {
    return;
  }

  let request;
  try {
    request = JSON.parse(line);
  } catch {
    record("invalid-json", { lineLength: line.length });
    return;
  }

  record("request", {
    method: request.method,
    hasId: Object.hasOwn(request, "id"),
    parameterKeys:
      request.params && typeof request.params === "object"
        ? Object.keys(request.params).sort()
        : [],
  });

  if (!Object.hasOwn(request, "id")) {
    return;
  }

  switch (request.method) {
    case "initialize":
      result(request.id, {
        protocolVersion: request.params?.protocolVersion ?? "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: {
          name: "openviking-copilot-host-probe",
          version: "0.0.0",
        },
      });
      break;
    case "ping":
      result(request.id, {});
      break;
    case "tools/list":
      result(request.id, {
        tools: [
          {
            name: "openviking_host_probe_mcp_ping",
            description:
              "Returns a metadata-only response from the temporary host-contract MCP probe.",
            inputSchema: {
              type: "object",
              properties: {},
              additionalProperties: false,
            },
          },
        ],
      });
      break;
    case "tools/call":
      if (request.params?.name !== "openviking_host_probe_mcp_ping") {
        error(request.id, -32601, "Unknown probe tool");
        break;
      }
      result(request.id, {
        content: [
          {
            type: "text",
            text: JSON.stringify({ runId, processId: process.pid, ok: true }),
          },
        ],
        isError: false,
      });
      break;
    default:
      error(request.id, -32601, "Method not found");
  }
});

lines.on("close", () => {
  record("stdin-close");
});

