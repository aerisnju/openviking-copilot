import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const upstreamCommit = "168037c8d99fec270742ffda6014d65382a0f04a";
const upstreamBase =
  `https://raw.githubusercontent.com/volcengine/OpenViking/${upstreamCommit}`;
const destination = resolve(
  repositoryRoot,
  "vendor",
  "openviking-memory-plugin-shared",
);
const stage = `${destination}.staging-${randomUUID()}`;
const upstreamLibPrefix = "examples/memory-plugin-shared/lib/";

const upstreamFiles = [
  "examples/memory-plugin-shared/lib/MANIFEST",
  "examples/memory-plugin-shared/lib/agent-hook-runtime.mjs",
  "examples/memory-plugin-shared/lib/async-writer.mjs",
  "examples/memory-plugin-shared/lib/batch-send.mjs",
  "examples/memory-plugin-shared/lib/capture-utils.mjs",
  "examples/memory-plugin-shared/lib/config-schema.mjs",
  "examples/memory-plugin-shared/lib/credentials.mjs",
  "examples/memory-plugin-shared/lib/debug-log.mjs",
  "examples/memory-plugin-shared/lib/doctor-core.mjs",
  "examples/memory-plugin-shared/lib/input-filters.mjs",
  "examples/memory-plugin-shared/lib/mcp-proxy-config.mjs",
  "examples/memory-plugin-shared/lib/mcp-proxy-core.mjs",
  "examples/memory-plugin-shared/lib/ov-http.mjs",
  "examples/memory-plugin-shared/lib/pending-queue.mjs",
  "examples/memory-plugin-shared/lib/plugin-config.mjs",
  "examples/memory-plugin-shared/lib/profile-inject.mjs",
  "examples/memory-plugin-shared/lib/recall-compress-core.mjs",
  "examples/memory-plugin-shared/lib/recall-core.mjs",
  "examples/memory-plugin-shared/lib/retryable.mjs",
  "examples/memory-plugin-shared/lib/session-model.mjs",
  "examples/memory-plugin-shared/lib/setup-wizard.mjs",
  "examples/memory-plugin-shared/lib/uri-guard.mjs",
  "examples/memory-plugin-shared/lib/workspace-config.mjs",
  "examples/memory-plugin-shared/lib/workspace-identity.mjs",
  "examples/memory-plugin-shared/lib/workspace-peer.mjs",
  "examples/memory-plugin-shared/lib/workspace-registry.mjs",
  "LICENSE",
];

function sha256(data) {
  return createHash("sha256").update(data).digest("hex");
}

async function download(path) {
  const response = await fetch(`${upstreamBase}/${path}`);
  if (!response.ok) {
    throw new Error(`Failed to download ${path}: HTTP ${response.status}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

function targetPath(path) {
  if (path === "LICENSE") {
    return path;
  }
  if (!path.startsWith(upstreamLibPrefix)) {
    throw new Error(`Unexpected upstream path: ${path}`);
  }
  return `lib/${path.slice(upstreamLibPrefix.length)}`;
}

try {
  let existing = true;
  try {
    await access(destination);
  } catch (error) {
    if (error.code === "ENOENT") existing = false;
    else throw error;
  }
  if (existing) {
    throw new Error(
      `Refusing to overwrite existing vendor directory: ${destination}`,
    );
  }

  const downloaded = await Promise.all(
    upstreamFiles.map(async (path) => [path, await download(path)]),
  );
  const manifest = {
    upstream: "https://github.com/volcengine/OpenViking",
    commit: upstreamCommit,
    license: "GNU AGPL v3.0 (see included upstream LICENSE)",
    files: Object.fromEntries(
      downloaded.map(([path, contents]) => [path, sha256(contents)]),
    ),
  };
  const notice = [
    "# OpenViking shared memory-plugin modules",
    "",
    `Source commit: [${upstreamCommit}](${manifest.upstream}/commit/${upstreamCommit})`,
    "",
    "The vendored source files and copied upstream LICENSE are from OpenViking",
    "and are licensed under the GNU Affero General Public License v3.0. See",
    "`LICENSE` in this directory.",
    "Local Copilot adapter files outside this directory are not identified here",
    "as OpenViking source. Review whole-program and network-use obligations before",
    "redistributing or operating a modified combined work as a network service.",
    "",
    "`UPSTREAM-MANIFEST.json` records SHA-256 digests for the exact vendored files.",
    "",
  ].join("\n");

  await mkdir(dirname(destination), { recursive: true });
  await mkdir(stage, { recursive: false });
  for (const [path, contents] of downloaded) {
    const target = resolve(stage, targetPath(path));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, contents, { flag: "wx" });
  }
  await writeFile(
    resolve(stage, "UPSTREAM-MANIFEST.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    { flag: "wx" },
  );
  await writeFile(resolve(stage, "NOTICE.md"), notice, { flag: "wx" });
  await rename(stage, destination);
  process.stdout.write(
    `${JSON.stringify({
      destination,
      commit: upstreamCommit,
      files: downloaded.length,
      license: manifest.license,
    })}\n`,
  );
} catch (error) {
  await rm(stage, { recursive: true, force: true });
  process.stderr.write(`OpenViking vendoring failed: ${error.message}\n`);
  throw error;
}
