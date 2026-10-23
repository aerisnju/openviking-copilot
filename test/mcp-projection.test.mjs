import assert from "node:assert/strict";
import test from "node:test";
import { createMcpProjectionVerifier } from "../src/mcp-projection.mjs";

function fakeSession({ metadataSequence, listResult, throwOnList = false, listError }) {
  const calls = { reload: 0, metadata: 0, list: 0 };
  return {
    calls,
    rpc: {
      mcp: {
        list: async () => {
          calls.list += 1;
          if (listError) throw new Error("mcp.list unavailable");
          return listResult;
        },
        reload: async () => {
          calls.reload += 1;
        },
      },
      tools: {
        getCurrentMetadata: async () => {
          const value = metadataSequence[Math.min(calls.metadata, metadataSequence.length - 1)];
          calls.metadata += 1;
          if (throwOnList && value === "throw") throw new Error("tools.getCurrentMetadata unavailable");
          return value;
        },
      },
    },
  };
}

const connectedList = {
  servers: [{ name: "openviking", status: "connected" }],
  host: { clients: ["openviking", "github-mcp-server"] },
};
const withTools = { tools: [{ name: "openviking-health", mcpServerName: "openviking", mcpToolName: "health" }] };

test("reports success when OpenViking tools are already projected", async () => {
  const session = fakeSession({ metadataSequence: [withTools], listResult: connectedList });
  const events = [];
  const verify = createMcpProjectionVerifier({
    session,
    logger: (event, detail) => events.push({ event, detail }),
    sleep: async () => {},
  });
  const result = await verify();
  assert.equal(result, true);
  assert.equal(session.calls.reload, 0);
  assert.equal(events.some((entry) => entry.event === "mcp-tools-projected" && entry.detail.available === true), true);
  assert.equal(events.some((entry) => entry.event === "mcp-tools-missing-after-handshake"), false);
});

test("reloads once and recovers when the handshake succeeded but tools were not projected", async () => {
  const empty = { tools: [{ name: "some-other-tool" }] };
  const session = fakeSession({ metadataSequence: [empty, empty, withTools], listResult: connectedList });
  const events = [];
  const verify = createMcpProjectionVerifier({
    session,
    logger: (event, detail) => events.push({ event, detail }),
    sleep: async () => {},
  });
  const result = await verify();
  assert.equal(result, true);
  assert.equal(session.calls.reload, 1);
  assert.equal(events.some((entry) => entry.event === "mcp-tools-missing-after-handshake"), true);
  assert.equal(events.some((entry) => entry.event === "mcp-tools-projection-recovered" && entry.detail.available === true), true);
});

test("treats a null tool set as not-yet-initialized rather than a fault", async () => {
  const session = fakeSession({ metadataSequence: [{ tools: null }], listResult: connectedList });
  const events = [];
  const verify = createMcpProjectionVerifier({
    session,
    logger: (event, detail) => events.push({ event, detail }),
    sleep: async () => {},
    initializeAttempts: 2,
  });
  const result = await verify();
  assert.equal(result, null);
  assert.equal(session.calls.reload, 0);
  assert.equal(events.some((entry) => entry.event === "mcp-tools-not-yet-initialized"), true);
  assert.equal(events.some((entry) => entry.event === "mcp-tools-missing-after-handshake"), false);
});

test("waits for lazy tool initialization before judging the projection", async () => {
  const session = fakeSession({ metadataSequence: [{ tools: null }, withTools], listResult: connectedList });
  const events = [];
  const verify = createMcpProjectionVerifier({
    session,
    logger: (event, detail) => events.push({ event, detail }),
    sleep: async () => {},
    initializeAttempts: 4,
  });
  const result = await verify();
  assert.equal(result, true);
  assert.equal(session.calls.reload, 0);
  assert.equal(events.some((entry) => entry.event === "mcp-tools-projected" && entry.detail.available === true), true);
});

test("reports a connection event separately from a missing projection", async () => {
  const empty = { tools: [{ name: "some-other-tool" }] };
  const session = fakeSession({ metadataSequence: [empty], listResult: connectedList });
  const events = [];
  const verify = createMcpProjectionVerifier({
    session,
    logger: (event, detail) => events.push({ event, detail }),
    sleep: async () => {},
    recoveryAttempts: 2,
  });
  const result = await verify();
  assert.equal(result, false);
  const connected = events.find((entry) => entry.event === "mcp-server-connected");
  assert.equal(connected.detail.hostReportsOpenViking, true);
  assert.equal(connected.detail.status, "connected");
  assert.equal(events.some((entry) => entry.event === "mcp-tools-projection-recovered" && entry.detail.available === false), true);
});

test("fails open when the projection RPCs are unavailable", async () => {
  const session = fakeSession({ metadataSequence: [withTools], listResult: connectedList, listError: true });
  const events = [];
  const verify = createMcpProjectionVerifier({
    session,
    logger: (event, detail) => events.push({ event, detail }),
    sleep: async () => {},
  });
  const result = await verify();
  assert.equal(result, false);
  assert.equal(events.some((entry) => entry.event === "mcp-projection-check-failed-open"), true);
});