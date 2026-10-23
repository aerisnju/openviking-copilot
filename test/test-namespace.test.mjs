import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  assertRemoteMutationAllowed,
  assertWithinRunPrefix,
  createTestNamespace,
  readTestManifest,
  recordCreatedUri,
} from "../src/viking-namespace-guard.mjs";

test("creates a unique constrained namespace and rejects parent/sibling paths", () => {
  const namespace = createTestNamespace({
    allowedRoot: "viking://user/test-only",
    date: "2026-09-30",
    runId: "run-12345678",
  });
  assert.equal(
    namespace.runPrefix,
    "viking://user/test-only/copilot-integration/2026-09-30/run-12345678",
  );
  assert.equal(
    assertWithinRunPrefix(`${namespace.runPrefix}/fixture`, namespace.runPrefix),
    `${namespace.runPrefix}/fixture`,
  );
  assert.throws(
    () => assertWithinRunPrefix("viking://user/test-only/existing-memory", namespace.runPrefix),
    /outside the confirmed test run prefix/,
  );
  assert.throws(
    () => assertWithinRunPrefix(`${namespace.runPrefix}/../existing`, namespace.runPrefix),
    /traversal segments/,
  );
  assert.throws(
    () => createTestNamespace({ allowedRoot: "viking://user/test-only", date: "2026-02-31" }),
    /valid YYYY-MM-DD/,
  );
});

test("requires manifest ownership for updates and cleanup", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ov-copilot-manifest-"));
  try {
    const namespace = createTestNamespace({
      allowedRoot: "viking://test/isolated",
      date: "2026-09-30",
      runId: "run-87654321",
    });
    const manifestPath = join(directory, "manifest.json");
    const createdUri = `${namespace.runPrefix}/fixture`;
    assert.equal(
      assertRemoteMutationAllowed({
        uri: createdUri,
        operation: "create",
        runPrefix: namespace.runPrefix,
      }),
      createdUri,
    );
    assert.throws(
      () =>
        assertRemoteMutationAllowed({
          uri: createdUri,
          operation: "delete",
          runPrefix: namespace.runPrefix,
        }),
      /exact URI in the run manifest/,
    );

    await recordCreatedUri(manifestPath, namespace.runPrefix, createdUri);
    await Promise.all([
      recordCreatedUri(manifestPath, namespace.runPrefix, `${namespace.runPrefix}/fixture-2`),
      recordCreatedUri(manifestPath, namespace.runPrefix, `${namespace.runPrefix}/fixture-3`),
    ]);
    const manifest = await readTestManifest(manifestPath, namespace.runPrefix);
    assert.deepEqual([...manifest.createdUris].sort(), [
      createdUri,
      `${namespace.runPrefix}/fixture-2`,
      `${namespace.runPrefix}/fixture-3`,
    ].sort());
    assert.equal(
      assertRemoteMutationAllowed({
        uri: createdUri,
        operation: "delete",
        runPrefix: namespace.runPrefix,
        createdUris: manifest.createdUris,
      }),
      createdUri,
    );
    assert.throws(
      () =>
        assertRemoteMutationAllowed({
          uri: `${namespace.runPrefix}/sibling`,
          operation: "delete",
          runPrefix: namespace.runPrefix,
          createdUris: manifest.createdUris,
        }),
      /exact URI in the run manifest/,
    );
    await assert.rejects(
      readTestManifest(manifestPath, `${namespace.runPrefix}/different`),
      /manifest schema or run prefix mismatch/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
