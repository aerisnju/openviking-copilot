import assert from "node:assert/strict";
import test from "node:test";
import {
  assertSupportedCopilotCliVersion,
  compareCopilotCliVersions,
  parseCopilotCliVersion,
} from "../src/copilot-cli-version.mjs";

test("parses Copilot CLI version output with a trailing sentence delimiter", () => {
  assert.equal(
    parseCopilotCliVersion("GitHub Copilot CLI 1.0.90-7.\nRun 'copilot update' to check."),
    "1.0.90-7",
  );
});

test("compares numeric release and prerelease components semantically", () => {
  assert.equal(compareCopilotCliVersions("1.0.90-9", "1.0.90-10"), -1);
  assert.equal(compareCopilotCliVersions("1.0.90", "1.0.90-10"), 1);
  assert.equal(compareCopilotCliVersions("1.0.91-0", "1.0.90"), 1);
});

test("accepts the tested minimum and rejects older host versions", () => {
  assert.equal(
    assertSupportedCopilotCliVersion("GitHub Copilot CLI 1.0.90-0", "1.0.90-0"),
    "1.0.90-0",
  );
  assert.throws(
    () => assertSupportedCopilotCliVersion("Copilot CLI 1.0.89", "1.0.90-0"),
    /minimum supported version is 1\.0\.90-0/,
  );
  assert.throws(
    () => parseCopilotCliVersion("Copilot is installed"),
    /Could not determine Copilot CLI version/,
  );
});
