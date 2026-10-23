import { buildPluginConfig } from "./vendor/openviking-memory-plugin-shared/lib/plugin-config.mjs";
import { createLogger } from "./vendor/openviking-memory-plugin-shared/lib/debug-log.mjs";
import { createOpenVikingMcpProxy } from "./vendor/openviking-memory-plugin-shared/lib/mcp-proxy-core.mjs";
import { toMcpProxyConfig } from "./vendor/openviking-memory-plugin-shared/lib/mcp-proxy-config.mjs";

const cwd = process.env.OPENVIKING_COPILOT_CWD || process.cwd();

const proxy = createOpenVikingMcpProxy({
  readConfig() {
    const resolved = buildPluginConfig("copilot", { cwd });
    return toMcpProxyConfig(resolved);
  },
  loggerFactory(name, config) {
    return createLogger(`copilot:${name}`, config);
  },
});

proxy.start();
