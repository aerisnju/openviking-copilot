import assert from "node:assert/strict";
import test from "node:test";
import {
  INTEGRATION_TEST_MEMORY_POLICY,
  resolveIntegrationTestMode,
  shouldRunIntegrationTestPreCompact,
} from "../src/integration-test-mode.mjs";

test("integration test mode requires a safe run ID and derives isolated paths", () => {
  assert.equal(resolveIntegrationTestMode({}), null);
  assert.throws(
    () => resolveIntegrationTestMode({ OPENVIKING_COPILOT_INTEGRATION_TEST: "true" }),
    /requires OPENVIKING_COPILOT_TEST_RUN_ID/,
  );
  assert.throws(
    () => resolveIntegrationTestMode({
      OPENVIKING_COPILOT_INTEGRATION_TEST: "true",
      OPENVIKING_COPILOT_TEST_RUN_ID: "../escape",
    }),
    /requires OPENVIKING_COPILOT_TEST_RUN_ID/,
  );

  assert.deepEqual(
    resolveIntegrationTestMode({
      OPENVIKING_COPILOT_INTEGRATION_TEST: "true",
      OPENVIKING_COPILOT_TEST_RUN_ID: "run-12345678",
    }),
    {
      peerId: "ov-copilot-it-run-12345678",
      sessionId: "ov-copilot-it-run-12345678",
      memoryPolicy: INTEGRATION_TEST_MEMORY_POLICY,
    },
  );
});

test("integration preCompact remains disabled unless explicitly enabled for a scoped run", () => {
  const mode = resolveIntegrationTestMode({
    OPENVIKING_COPILOT_INTEGRATION_TEST: "true",
    OPENVIKING_COPILOT_TEST_RUN_ID: "run-12345678",
  });

  assert.equal(shouldRunIntegrationTestPreCompact(mode, {}), false);
  assert.equal(
    shouldRunIntegrationTestPreCompact(mode, {
      OPENVIKING_COPILOT_TEST_PRECOMPACT: "true",
    }),
    true,
  );
  assert.throws(
    () => shouldRunIntegrationTestPreCompact(null, {
      OPENVIKING_COPILOT_TEST_PRECOMPACT: "true",
    }),
    /requires OPENVIKING_COPILOT_INTEGRATION_TEST=true/,
  );
});
