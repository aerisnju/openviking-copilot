import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const URI_RE = /^viking:\/\/[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*$/;
const RUN_ID_RE = /^[A-Za-z0-9_-]{8,80}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const manifestLocks = new Map();

function validateUri(uri, label) {
  if (typeof uri !== "string" || !URI_RE.test(uri)) {
    throw new TypeError(`${label} must be a canonical viking:// URI`);
  }
  if (uri.split("/").some((segment) => segment === "." || segment === "..")) {
    throw new TypeError(`${label} cannot contain traversal segments`);
  }
}

function isAtOrBelow(uri, prefix) {
  return uri === prefix || uri.startsWith(`${prefix}/`);
}

async function atomicWrite(path, contents) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(contents, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

export function createTestNamespace({
  allowedRoot,
  date = new Date().toISOString().slice(0, 10),
  runId = randomUUID(),
}) {
  validateUri(allowedRoot, "allowedRoot");
  if (
    !DATE_RE.test(date) ||
    !Number.isFinite(Date.parse(`${date}T00:00:00Z`)) ||
    new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date
  ) {
    throw new TypeError("date must be a valid YYYY-MM-DD date");
  }
  if (!RUN_ID_RE.test(runId)) throw new TypeError("runId must be a unique safe identifier");
  return {
    allowedRoot,
    runPrefix: `${allowedRoot}/copilot-integration/${date}/${runId}`,
    runId,
  };
}

export function assertWithinRunPrefix(uri, runPrefix) {
  validateUri(uri, "uri");
  validateUri(runPrefix, "runPrefix");
  if (!isAtOrBelow(uri, runPrefix)) {
    throw new Error(`Remote URI is outside the confirmed test run prefix: ${uri}`);
  }
  return uri;
}

export async function readTestManifest(manifestPath, runPrefix) {
  validateUri(runPrefix, "runPrefix");
  let value;
  try {
    value = JSON.parse(await readFile(resolve(manifestPath), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") {
      return { schemaVersion: 1, runPrefix, createdUris: [] };
    }
    throw error;
  }
  if (
    value.schemaVersion !== 1 ||
    value.runPrefix !== runPrefix ||
    !Array.isArray(value.createdUris)
  ) {
    throw new Error("Test manifest schema or run prefix mismatch");
  }
  for (const uri of value.createdUris) assertWithinRunPrefix(uri, runPrefix);
  return value;
}

export async function recordCreatedUri(manifestPath, runPrefix, uri) {
  assertWithinRunPrefix(uri, runPrefix);
  const path = resolve(manifestPath);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const previous = manifestLocks.get(path) ?? Promise.resolve();
  let release;
  const current = new Promise((resolveLock) => {
    release = resolveLock;
  });
  manifestLocks.set(path, current);
  await previous;
  try {
    const manifest = await readTestManifest(path, runPrefix);
    if (!manifest.createdUris.includes(uri)) manifest.createdUris.push(uri);
    await atomicWrite(path, `${JSON.stringify(manifest, null, 2)}\n`);
    return manifest;
  } finally {
    if (manifestLocks.get(path) === current) manifestLocks.delete(path);
    release();
  }
}

export function assertRemoteMutationAllowed({
  uri,
  operation,
  runPrefix,
  createdUris = [],
}) {
  assertWithinRunPrefix(uri, runPrefix);
  if (operation === "create") return uri;
  if (operation !== "update" && operation !== "delete") {
    throw new TypeError(`Unsupported remote mutation operation: ${operation}`);
  }
  if (!createdUris.includes(uri)) {
    throw new Error(`${operation} is allowed only for an exact URI in the run manifest`);
  }
  return uri;
}
