export const INTEGRATION_TEST_MEMORY_POLICY = Object.freeze({
  self: Object.freeze({ enabled: false }),
  peer: Object.freeze({ enabled: true }),
  memory_types: Object.freeze(["preferences"]),
  working_memory: Object.freeze({ enabled: false }),
});

const RUN_ID_RE = /^[A-Za-z0-9_-]{8,80}$/;

export function resolveIntegrationTestMode(environment = process.env) {
  if (environment.OPENVIKING_COPILOT_INTEGRATION_TEST !== "true") return null;

  const runId = environment.OPENVIKING_COPILOT_TEST_RUN_ID;
  if (typeof runId !== "string" || !RUN_ID_RE.test(runId)) {
    throw new Error(
      "Integration test mode requires OPENVIKING_COPILOT_TEST_RUN_ID (8-80 safe characters)",
    );
  }

  const testId = `ov-copilot-it-${runId}`;
  return {
    peerId: testId,
    sessionId: testId,
    memoryPolicy: INTEGRATION_TEST_MEMORY_POLICY,
  };
}

export function shouldRunIntegrationTestPreCompact(
  integrationTestMode,
  environment = process.env,
) {
  const enabled = environment.OPENVIKING_COPILOT_TEST_PRECOMPACT === "true";
  if (enabled && !integrationTestMode) {
    throw new Error(
      "Integration preCompact testing requires OPENVIKING_COPILOT_INTEGRATION_TEST=true",
    );
  }
  return enabled;
}
