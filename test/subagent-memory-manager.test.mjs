import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DurableSessionStore } from "../src/durable-session-store.mjs";
import { createSubagentMemoryManager, SUBAGENT_MEMORY_POLICY } from "../src/subagent-memory-manager.mjs";

async function withStore(run) {
  const stateRoot = await mkdtemp(join(tmpdir(), "ov-copilot-subagent-"));
  const store = new DurableSessionStore({
    sessionId: "parent-session",
    stateRoot,
  });
  try {
    await store.initialize();
    await run({ stateRoot, store });
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
}

function childIdHash(agentId) {
  return createHash("sha256").update(agentId).digest("hex");
}

function runtimeFactory(observed) {
  return async ({ sourceSessionId, openVikingSessionId }) => ({
    sourceSessionId,
    openVikingSessionId,
    async initialize() {
      observed.initialized += 1;
    },
    async capture(event) {
      observed.childEvents.push(event);
    },
    async flush() {
      observed.flushed += 1;
      return { blocked: false };
    },
    async commit() {
      observed.committed += 1;
      return { ok: true };
    },
    async close() {
      observed.closed += 1;
    },
  });
}

function createManager(store, observed, overrides = {}) {
  return createSubagentMemoryManager({
    enabled: true,
    parentSessionId: "parent-session",
    parentStore: store,
    resolveChildIdentity: ({ agentIdHash }) => `ov-copilot-it-test-sub-${agentIdHash.slice(0, 12)}`,
    createRuntime: runtimeFactory(observed),
    logger: () => {},
    ...overrides,
  });
}

function observed() {
  return { initialized: 0, childEvents: [], flushed: 0, committed: 0, closed: 0 };
}

test("routes subagent messages to a hashed, isolated peer-only session and commits on completion", async () => {
  await withStore(async ({ store }) => {
    const state = observed();
    const parentEvents = [];
    const manager = createManager(store, state);
    await manager.initialize();
    const captureParent = async (event) => parentEvents.push(event);
    await manager.capture({ type: "subagent.started", agentId: "private-agent-id" }, captureParent);
    await manager.capture({
      type: "user.message",
      agentId: "private-agent-id",
      data: { content: "A child-specific preference." },
    }, captureParent);
    const completed = { type: "subagent.completed", agentId: "private-agent-id" };
    await manager.capture(completed, captureParent);
    await manager.capture(completed, captureParent);

    const [entry] = await store.subagentSessions();
    assert.equal(entry.agentIdHash, childIdHash("private-agent-id"));
    assert.equal(entry.status, "committed");
    assert.match(entry.openVikingSessionId, /^ov-copilot-it-test-sub-[a-f0-9]{12}$/);
    assert.equal(JSON.stringify(entry).includes("private-agent-id"), false);
    assert.deepEqual(state.childEvents.map(({ type }) => type), ["user.message"]);
    assert.equal(state.initialized, 1);
    assert.equal(state.flushed, 1);
    assert.equal(state.committed, 1);
    assert.equal(state.closed, 1);
    assert.deepEqual(parentEvents.map(({ type }) => type), [
      "subagent.started",
      "subagent.completed",
      "subagent.completed",
    ]);
    assert.deepEqual(SUBAGENT_MEMORY_POLICY, {
      self: { enabled: false },
      peer: { enabled: true },
      memory_types: ["preferences"],
      working_memory: { enabled: false },
    });
    await manager.close();
  });
});

test("recovers a completed child by its stored hash without re-hashing the hash", async () => {
  await withStore(async ({ store }) => {
    const hash = childIdHash("private-agent-id");
    await store.updateSubagentSession({
      agentIdHash: hash,
      openVikingSessionId: `ov-copilot-it-test-sub-${hash.slice(0, 12)}`,
      status: "completed",
      ownerPid: process.pid,
    });
    const state = observed();
    const manager = createManager(store, state);
    await manager.initialize();

    assert.equal((await store.subagentSessions())[0].status, "committed");
    assert.equal(state.initialized, 1);
    assert.equal(state.committed, 1);
    await manager.close();
  });
});

test("marks interrupted commits unknown and does not retry them automatically", async () => {
  await withStore(async ({ store }) => {
    const hash = childIdHash("private-agent-id");
    await store.updateSubagentSession({
      agentIdHash: hash,
      openVikingSessionId: `ov-copilot-it-test-sub-${hash.slice(0, 12)}`,
      status: "committing",
      ownerPid: process.pid,
    });
    const state = observed();
    const manager = createManager(store, state);
    await manager.initialize();

    assert.equal((await store.subagentSessions())[0].status, "commit_unknown");
    assert.equal(state.initialized, 0);
    assert.equal(state.committed, 0);
    await manager.close();
  });
});

test("marks active sessions from a dead process orphaned without committing", async () => {
  await withStore(async ({ store }) => {
    const hash = childIdHash("private-agent-id");
    await store.updateSubagentSession({
      agentIdHash: hash,
      openVikingSessionId: `ov-copilot-it-test-sub-${hash.slice(0, 12)}`,
      status: "active",
      ownerPid: 2_000_000_000,
    });
    const state = observed();
    const manager = createManager(store, state);
    await manager.initialize();

    assert.equal((await store.subagentSessions())[0].status, "orphaned");
    assert.equal(state.initialized, 0);
    assert.equal(state.committed, 0);
    await manager.close();
  });
});

test("does not commit an unfinished child when the extension closes", async () => {
  await withStore(async ({ store }) => {
    const state = observed();
    const manager = createManager(store, state);
    await manager.initialize();
    await manager.capture({ type: "subagent.started", agentId: "private-agent-id" }, async () => {});
    await manager.close();

    assert.equal((await store.subagentSessions())[0].status, "orphaned");
    assert.equal(state.committed, 0);
    assert.equal(state.closed, 1);
  });
});

test("rejects invalid registry transitions and validates persisted hashes", async () => {
  await withStore(async ({ store }) => {
    const hash = childIdHash("private-agent-id");
    await store.updateSubagentSession({
      agentIdHash: hash,
      openVikingSessionId: "ov-copilot-it-test-sub",
      status: "committed",
      ownerPid: process.pid,
    });
    await assert.rejects(
      store.updateSubagentSession({
        agentIdHash: hash,
        openVikingSessionId: "ov-copilot-it-test-sub",
        status: "active",
        ownerPid: process.pid,
      }),
      /Invalid subagent session transition/,
    );
    const competingHash = childIdHash("competing-agent-id");
    await store.updateSubagentSession({
      agentIdHash: competingHash,
      openVikingSessionId: "ov-copilot-it-competing-sub",
      status: "active",
      ownerPid: process.pid,
    });
    await assert.rejects(
      store.updateSubagentSession({
        agentIdHash: competingHash,
        openVikingSessionId: "ov-copilot-it-competing-sub",
        status: "active",
        ownerPid: process.pid + 1,
      }),
      /already owned by another process/,
    );
    const registry = JSON.parse(await readFile(store.subagentSessionsPath, "utf8"));
    registry.children["not-a-hash"] = registry.children[hash];
    await writeFile(store.subagentSessionsPath, JSON.stringify(registry), "utf8");
    await assert.rejects(store.subagentSessions(), /Invalid subagent session registry entry/);
  });
});
