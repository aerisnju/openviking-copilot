import { isAbsolute, resolve } from "node:path";
import { MCP_PROXY_ENV_VARS } from "../vendor/openviking-memory-plugin-shared/lib/mcp-proxy-config.mjs";

export function createMcpServerConfig({
  nodeExecutable,
  proxyEntry,
  environment = process.env,
}) {
  if (typeof nodeExecutable !== "string" || !isAbsolute(nodeExecutable)) {
    throw new TypeError("nodeExecutable must be an absolute path");
  }
  if (typeof proxyEntry !== "string" || !isAbsolute(proxyEntry)) {
    throw new TypeError("proxyEntry must be an absolute path");
  }
  const forwardedEnvironment = Object.fromEntries(
    MCP_PROXY_ENV_VARS
      .filter((name) => Object.hasOwn(environment, name))
      .map((name) => [name, environment[name]]),
  );
  return {
    type: "stdio",
    command: nodeExecutable,
    args: [proxyEntry],
    env: {
      OPENVIKING_COPILOT_CWD: environment.OPENVIKING_COPILOT_CWD || process.cwd(),
      ...forwardedEnvironment,
    },
    tools: ["*"],
    timeout: 60_000,
  };
}

export function shouldRegisterOpenVikingMcp(installConfig, environment = process.env) {
  return Boolean(installConfig)
    && installConfig.hostSmokeOnly !== true
    && environment.OPENVIKING_COPILOT_DISABLE_MCP !== "true"
    && environment.OPENVIKING_COPILOT_INTEGRATION_TEST !== "true";
}

export function resolveInstalledNodeExecutable(value) {
  if (typeof value !== "string" || !isAbsolute(value)) return null;
  return resolve(value);
}
