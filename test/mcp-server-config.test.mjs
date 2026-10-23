import assert from "node:assert/strict";
import test from "node:test";
import { isAbsolute } from "node:path";
import {
  createMcpServerConfig,
  resolveInstalledNodeExecutable,
  shouldRegisterOpenVikingMcp,
} from "../src/mcp-server-config.mjs";

test("configures the MCP proxy with the installer-provided Node path", () => {
  const config = createMcpServerConfig({
    nodeExecutable: process.execPath,
    proxyEntry: `${process.cwd()}\\mcp-proxy.mjs`,
    environment: {
      OPENVIKING_COPILOT_CWD: "C:\\workspace\\repo",
      OPENVIKING_API_KEY: "key-value",
      OPENVIKING_TIMEOUT_MS: "10000",
      UNRELATED_SECRET: "do-not-forward",
    },
  });

  assert.equal(config.type, "stdio");
  assert.equal(config.command, process.execPath);
  assert.equal(config.args[0], `${process.cwd()}\\mcp-proxy.mjs`);
  assert.equal(config.env.OPENVIKING_COPILOT_CWD, "C:\\workspace\\repo");
  assert.equal(config.env.OPENVIKING_API_KEY, "key-value");
  assert.equal(config.env.OPENVIKING_TIMEOUT_MS, "10000");
  assert.equal("UNRELATED_SECRET" in config.env, false);
  assert.deepEqual(config.tools, ["*"]);
  assert.equal(config.timeout, 60_000);
});

test("rejects missing or relative executable and proxy paths", () => {
  assert.throws(
    () => createMcpServerConfig({ nodeExecutable: "node.exe", proxyEntry: "proxy.mjs" }),
    /nodeExecutable must be an absolute path/,
  );
  assert.throws(
    () => createMcpServerConfig({ nodeExecutable: process.execPath, proxyEntry: "proxy.mjs" }),
    /proxyEntry must be an absolute path/,
  );
});

test("accepts only absolute installed node paths", () => {
  const result = resolveInstalledNodeExecutable(process.execPath);
  assert.equal(isAbsolute(result), true);
  assert.equal(resolveInstalledNodeExecutable("node.exe"), null);
  assert.equal(resolveInstalledNodeExecutable(""), null);
});

test("can disable dynamic OpenViking MCP registration for host-only tests", () => {
  const installConfig = { owner: "openviking-copilot" };
  assert.equal(shouldRegisterOpenVikingMcp(installConfig, {}), true);
  assert.equal(shouldRegisterOpenVikingMcp({ ...installConfig, hostSmokeOnly: true }, {}), false);
  assert.equal(
    shouldRegisterOpenVikingMcp(installConfig, {
      OPENVIKING_COPILOT_DISABLE_MCP: "true",
    }),
    false,
  );
  assert.equal(
    shouldRegisterOpenVikingMcp(installConfig, {
      OPENVIKING_COPILOT_INTEGRATION_TEST: "true",
    }),
    false,
  );
  assert.equal(shouldRegisterOpenVikingMcp(null, {}), false);
});
