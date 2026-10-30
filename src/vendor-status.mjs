import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const vendorRoot = resolve(repositoryRoot, "vendor", "openviking-memory-plugin-shared");

function sha256(data) {
  return createHash("sha256").update(data).digest("hex");
}

async function readManifest() {
  return JSON.parse(await readFile(resolve(vendorRoot, "UPSTREAM-MANIFEST.json"), "utf8"));
}

/**
 * Verify that the vendored files still match the digests recorded when they were
 * fetched. A mismatch means someone edited a vendored file by hand, which the
 * manifest exists to prevent: the next refresh would silently discard the edit.
 */
export async function verifyVendoredIntegrity() {
  const manifest = await readManifest();
  const problems = [];
  for (const [path, expected] of Object.entries(manifest.files)) {
    const target = path === "LICENSE"
      ? resolve(vendorRoot, "LICENSE")
      : resolve(vendorRoot, "lib", path.replace("examples/memory-plugin-shared/lib/", ""));
    let actual;
    try {
      actual = sha256(await readFile(target));
    } catch (error) {
      if (error.code === "ENOENT") {
        problems.push({ path, problem: "missing" });
        continue;
      }
      throw error;
    }
    if (actual !== expected) problems.push({ path, problem: "modified" });
  }
  return { commit: manifest.commit, ok: problems.length === 0, problems };
}

function gitLog(localClone, from, to, paths) {
  return execFileSync(
    "git",
    ["-C", localClone, "log", "--oneline", `${from}..${to}`, "--", ...paths],
    { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 },
  ).trim();
}

/**
 * Report how far the vendored snapshot is behind a local OpenViking clone.
 *
 * The integration vendors a fixed commit, so upstream fixes — including security
 * fixes to capture redaction — do not arrive on their own. This turns "are we
 * behind?" into a command instead of something to remember.
 */
export async function checkUpstreamDrift({ localClone, upstreamRef = "HEAD" } = {}) {
  const manifest = await readManifest();
  const from = manifest.commit;
  let to;
  try {
    to = execFileSync("git", ["-C", localClone, "rev-parse", upstreamRef], {
      encoding: "utf8",
    }).trim();
  } catch {
    return { ok: false, reason: "clone-unavailable", clone: localClone, pinned: from };
  }
  if (to === from) {
    return {
      ok: true,
      pinned: from,
      upstream: to,
      behind: 0,
      sharedLibCommits: 0,
      commits: [],
      breaking: [],
    };
  }
  let behind;
  try {
    behind = Number(
      execFileSync("git", ["-C", localClone, "rev-list", "--count", `${from}..${to}`], {
        encoding: "utf8",
      }).trim(),
    );
  } catch {
    return { ok: false, reason: "pinned-commit-missing", clone: localClone, pinned: from, upstream: to };
  }
  const log = gitLog(localClone, from, to, ["examples/memory-plugin-shared/lib"]);
  const commits = log ? log.split("\n").map((line) => line.trim()) : [];
  return {
    ok: true,
    pinned: from,
    upstream: to,
    behind,
    sharedLibCommits: commits.length,
    commits,
    breaking: commits.filter((line) => /\)!:/.test(line)),
  };
}

export { vendorRoot };