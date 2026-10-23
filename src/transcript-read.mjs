import { lstat, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";

const MAX_TRANSCRIPT_BYTES = 16 * 1024 * 1024;

/**
 * Read and verify the session-scoped Copilot transcript that a `preCompact`
 * hook was told to use.
 *
 * The path must be exactly the session's own `events.jsonl` under the Copilot
 * home, with no symlinks anywhere on the way, and the file must not change
 * while it is read. The result is the single authority both the audit gate and
 * the catch-up path compare against, so neither can be talked into reading some
 * other file.
 *
 * @returns `{ ok: true, events, size, mtimeMs }` or `{ ok: false, reason }`.
 */
export async function readVerifiedTranscript(
  input,
  copilotHome = process.env.COPILOT_HOME || resolve(homedir(), ".copilot"),
) {
  if (typeof input?.sessionId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(input.sessionId)) {
    return { ok: false, reason: "transcript-path-unverified" };
  }
  const expected = resolve(copilotHome, "session-state", input.sessionId, "events.jsonl");
  if (typeof input.transcriptPath !== "string" || resolve(input.transcriptPath) !== expected) {
    return { ok: false, reason: "transcript-path-unverified" };
  }

  let sessionRoot;
  let directory;
  let file;
  try {
    sessionRoot = await lstat(resolve(copilotHome, "session-state"));
    directory = await lstat(resolve(expected, ".."));
    file = await lstat(expected);
  } catch (error) {
    if (error.code === "ENOENT") return { ok: false, reason: "transcript-path-unverified" };
    throw error;
  }
  if (
    sessionRoot.isSymbolicLink() ||
    !sessionRoot.isDirectory() ||
    directory.isSymbolicLink() ||
    !directory.isDirectory() ||
    file.isSymbolicLink() ||
    !file.isFile()
  ) {
    return { ok: false, reason: "transcript-path-unverified" };
  }
  if (file.size > MAX_TRANSCRIPT_BYTES) {
    return { ok: false, reason: "transcript-too-large" };
  }

  const text = await readFile(expected, "utf8");
  if (
    Buffer.byteLength(text, "utf8") !== file.size ||
    (text && !text.endsWith("\n"))
  ) {
    return { ok: false, reason: "transcript-changing" };
  }

  const events = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      return { ok: false, reason: "transcript-unparsable" };
    }
    events.push(event);
  }

  const end = await lstat(expected);
  if (end.size !== file.size || end.mtimeMs !== file.mtimeMs) {
    return { ok: false, reason: "transcript-changing" };
  }
  return { ok: true, events, size: file.size, mtimeMs: file.mtimeMs };
}

export { MAX_TRANSCRIPT_BYTES };