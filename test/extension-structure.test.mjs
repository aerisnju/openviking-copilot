import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

const extensionPath = fileURLToPath(new URL("../extension.mjs", import.meta.url));

// `session` is produced by the top-level `await joinSession(...)`, so any code
// that touches it must run after that awaits resolves. A verifier created at
// module top level would capture the temporal-dead-zone binding and crash the
// whole extension with "Cannot access 'session' before initialization" — a
// failure that silently disables recall, capture, and MCP. This regression
// guard pins the lazy-assignment ordering.
test("creates the projection verifier only after joinSession resolves", async () => {
  const source = await readFile(extensionPath, "utf8");
  const joinIndex = source.indexOf("await joinSession(");
  const createIndex = source.indexOf("confirmMcpToolsProjected = createMcpProjectionVerifier(");
  assert.notEqual(joinIndex, -1, "extension should await joinSession");
  assert.notEqual(createIndex, -1, "extension should assign the projection verifier");
  assert.equal(
    createIndex > joinIndex,
    true,
    "the projection verifier must be assigned after joinSession so `session` is initialized",
  );

  // The verifier starts as a safe no-op so an early hook call cannot throw.
  assert.match(source, /let confirmMcpToolsProjected = \(\) => Promise\.resolve\(null\);/);
});