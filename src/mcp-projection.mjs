const OPENVIKING_SERVER = "openviking";

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function countProjected(metadata, serverName) {
  if (!Array.isArray(metadata)) return null;
  const names = metadata
    .filter((tool) => tool?.mcpServerName === serverName)
    .map((tool) => tool.mcpToolName || tool.name)
    .filter(Boolean);
  return { projected: names.length, sample: names.slice(0, 3) };
}

/**
 * Verifies that a dynamically registered MCP server's tools actually reached
 * the session's model-facing tool set.
 *
 * A successful MCP handshake only proves the server answered. The host projects
 * the tool catalog asynchronously, so a server can be connected while its tools
 * are still invisible to the model. `tools.getCurrentMetadata()` reports the
 * session's initialized tool set and is the authoritative projection signal: a
 * `null` set means tools were never initialized, which is normal for an idle
 * session and is reported separately from a missing projection.
 *
 * Emits one log line per observed state so "connected" and "tools available"
 * cannot be read as the same claim. Never throws: a failure to observe the
 * projection is reported and treated as unknown/false, never as a fault.
 *
 * @returns true when the server's tools are projected, false when they are
 * missing after a reload, null when the tool set was never initialized.
 */
export function createMcpProjectionVerifier({
  session,
  logger = () => {},
  sleep = defaultSleep,
  serverName = OPENVIKING_SERVER,
  initializeAttempts = 4,
  recoveryAttempts = 6,
    pollMs = 250,
} = {}) {
  return async function confirmMcpToolsProjected() {
    try {
        logger("mcp-projection-check-start", { serverName });
        if (!session?.rpc?.mcp || !session?.rpc?.tools) {
          logger("mcp-projection-check-failed-open", { name: "MissingRpc" });
          return null;
        }
        const listed = await session.rpc.mcp.list();
      const connectedClients = listed?.host?.clients || [];
      const server = listed?.servers?.find((entry) => entry.name === serverName);
      logger("mcp-server-connected", {
        connectedClients,
        hostReportsOpenViking: Boolean(server),
        status: server?.status || "unknown",
      });

      const read = async () => countProjected((await session.rpc.tools.getCurrentMetadata())?.tools, serverName);

      let observed = await read();
      if (!observed) {
        const attempts = [];
        for (let attempt = 0; attempt < initializeAttempts && !observed; attempt += 1) {
          await sleep(pollMs);
          observed = await read();
          attempts.push(Boolean(observed));
        }
        if (!observed) {
          logger("mcp-tools-not-yet-initialized", { attempts });
          return null;
        }
      }

      logger("mcp-tools-projected", { ...observed, available: observed.projected > 0 });
      if (observed.projected > 0) return true;

      logger("mcp-tools-missing-after-handshake", { connectedClients });
      await session.rpc.mcp.reload();
      let recovered = await read();
      for (let attempt = 0; attempt < recoveryAttempts && (!recovered || recovered.projected === 0); attempt += 1) {
        await sleep(pollMs);
        recovered = await read();
      }
      const projected = recovered?.projected || 0;
      logger("mcp-tools-projection-recovered", { projected, available: projected > 0 });
      return projected > 0;
    } catch (error) {
      logger("mcp-projection-check-failed-open", { name: error?.name || "Error" });
      return false;
    }
  };
}