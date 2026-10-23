import { appendFile, readFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";

function summarize(value, depth = 0) {
  if (value === null) {
    return { type: "null" };
  }
  if (Array.isArray(value)) {
    return { type: "array", length: value.length };
  }
  if (typeof value === "string") {
    return { type: "string", length: value.length };
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return { type: typeof value, value };
  }
  if (value && typeof value === "object") {
    const keys = Object.keys(value).sort();
    return depth >= 1
      ? { type: "object", keys }
      : {
          type: "object",
          keys,
          fields: Object.fromEntries(
            keys.map((key) => [key, summarize(value[key], depth + 1)]),
          ),
        };
  }
  return { type: typeof value };
}

const configPath = process.argv[2];
const eventName = process.argv[3];
const config = JSON.parse(await readFile(configPath, "utf8"));
const inputText = await new Promise((resolve, reject) => {
  let body = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    body += chunk;
  });
  process.stdin.on("end", () => resolve(body));
  process.stdin.on("error", reject);
});

let parsedInput;
try {
  parsedInput = inputText.trim() ? JSON.parse(inputText) : null;
} catch {
  parsedInput = { invalidJsonLength: inputText.length };
}

const subagentContextMarker =
  eventName === "subagentStart" && config.enableSubagentContextProbe
    ? `OVCP-SUBAGENT-${randomUUID().replaceAll("-", "").slice(0, 16).toUpperCase()}`
    : undefined;
const entry = {
  schemaVersion: 1,
  runId: config.runId,
  recordedAt: new Date().toISOString(),
  processId: process.pid,
  kind: "configured-hook",
  name: eventName,
  sessionIdHash: fingerprint(parsedInput?.sessionId),
  agentIdHash: fingerprint(parsedInput?.agentId),
  agentNameHash: fingerprint(parsedInput?.agentName),
  transcriptPathHash: fingerprint(parsedInput?.transcriptPath),
  subagentContextMarkerHash: fingerprint(subagentContextMarker),
  responseMarkerHash: fingerprint(
    typeof parsedInput?.response === "string"
      ? parsedInput.response.match(/OVCP-SUBAGENT-[A-F0-9]{16}/)?.[0]
      : undefined,
  ),
  summary: summarize(parsedInput),
};

const hookOutput =
  typeof subagentContextMarker === "string"
    ? {
        additionalContext:
          `Synthetic host-probe context marker: ${subagentContextMarker}. ` +
          "Return this marker verbatim to the parent as your result.",
      }
    : {};
entry.outputKeys = Object.keys(hookOutput).sort();
entry.additionalContextHash = fingerprint(hookOutput.additionalContext);

await appendFile(config.hookOutputFile, `${JSON.stringify(entry)}\n`, "utf8");
process.stdout.write(`${JSON.stringify(hookOutput)}\n`);

function fingerprint(value) {
  return typeof value === "string" && value
    ? createHash("sha256").update(value).digest("hex").slice(0, 24)
    : null;
}
