import { createHash } from "node:crypto";
import { INTEGRATION_TEST_MEMORY_POLICY } from "./integration-test-mode.mjs";

export const SUBAGENT_MEMORY_POLICY = INTEGRATION_TEST_MEMORY_POLICY;

const CHILD_EVENT_TYPES = new Set([
  "user.message",
  "assistant.message",
  "tool.execution_start",
  "tool.execution_complete",
  "assistant.turn_end",
]);

function hashAgentId(agentId) {
  return createHash("sha256").update(agentId).digest("hex");
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    if (error.code === "EPERM") return true;
    throw error;
  }
}

export function createSubagentMemoryManager({
  enabled,
  parentSessionId,
  parentStore,
  createRuntime,
  resolveChildIdentity,
  logger = () => {},
}) {
  const entries = new Map();
  let queue = Promise.resolve();
  let initialized = false;
  let closed = false;

  function identity(agentId) {
    if (typeof agentId !== "string" || !agentId.trim() || agentId.length > 1024) {
      return null;
    }
    const agentIdHash = hashAgentId(agentId);
    const sourceSessionId = `${parentSessionId}:subagent:${agentIdHash}`;
    return {
      agentIdHash,
      sourceSessionId,
      openVikingSessionId: resolveChildIdentity({ agentIdHash, sourceSessionId }),
    };
  }

  async function readEntry(agentIdHash) {
    const cached = entries.get(agentIdHash);
    if (cached) return cached;
    const stored = (await parentStore.subagentSessions())
      .find((entry) => entry.agentIdHash === agentIdHash);
    if (!stored) return null;
    const entry = { ...stored, runtimePromise: null };
    entries.set(agentIdHash, entry);
    return entry;
  }

  async function runtimeFor(entry) {
    if (!entry.runtimePromise) {
      entry.runtimePromise = (async () => {
        const runtime = await createRuntime({
          agentIdHash: entry.agentIdHash,
          sourceSessionId: `${parentSessionId}:subagent:${entry.agentIdHash}`,
          openVikingSessionId: entry.openVikingSessionId,
        });
        await runtime.initialize();
        return runtime;
      })();
    }
    return entry.runtimePromise;
  }

  async function closeRuntime(entry) {
    if (!entry.runtimePromise || entry.runtimeClosed) return;
    const runtime = await entry.runtimePromise;
    await runtime.close();
    entry.runtimeClosed = true;
  }

  async function setStatus(entry, status) {
    const updated = await parentStore.updateSubagentSession({
      agentIdHash: entry.agentIdHash,
      openVikingSessionId: entry.openVikingSessionId,
      status,
      ownerPid: process.pid,
    });
    Object.assign(entry, updated);
    return entry;
  }

  async function ensureActive(agentId, { missingStart = false } = {}) {
    const childIdentity = identity(agentId);
    if (!childIdentity) return null;
    let entry = await readEntry(childIdentity.agentIdHash);
    if (entry) {
      if (entry.status !== "active" || entry.ownerPid !== process.pid) {
        logger("subagent-capture-paused", {
          agentIdHash: entry.agentIdHash,
          status: entry.status,
        });
        return null;
      }
      return entry;
    }

    entry = {
      ...childIdentity,
      status: "active",
      ownerPid: process.pid,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      runtimePromise: null,
    };
    const persisted = await parentStore.updateSubagentSession({
      agentIdHash: entry.agentIdHash,
      openVikingSessionId: entry.openVikingSessionId,
      status: "active",
      ownerPid: process.pid,
    });
    Object.assign(entry, persisted);
    entries.set(entry.agentIdHash, entry);
    if (missingStart) {
      logger("subagent-start-event-missing", { agentIdHash: entry.agentIdHash });
    }
    await runtimeFor(entry);
    return entry;
  }

  async function completeEntry(entry) {
    if (entry.status === "active" && entry.ownerPid !== process.pid) {
      logger("subagent-capture-paused", {
        agentIdHash: entry.agentIdHash,
        status: entry.status,
      });
      return;
    }
    if (entry.status === "committed" || entry.status === "commit_unknown" || entry.status === "orphaned") {
      return;
    }
    if (entry.status === "active") await setStatus(entry, "completed");
    if (entry.status !== "completed") return;

    const runtime = await runtimeFor(entry);
    const flush = await runtime.flush();
    if (flush?.blocked) {
      logger("subagent-flush-incomplete", {
        agentIdHash: entry.agentIdHash,
        reason: flush.reason || "unknown",
      });
      return;
    }

    await setStatus(entry, "committing");
    let result;
    try {
      result = await runtime.commit();
    } catch (error) {
      await setStatus(entry, "commit_unknown");
      logger("subagent-commit-outcome-unknown", {
        agentIdHash: entry.agentIdHash,
        name: error?.name || "Error",
      });
      await closeRuntime(entry);
      return;
    }
    if (result?.ok === true || result?.skipped === true) {
      await setStatus(entry, "committed");
      logger("subagent-session-committed", { agentIdHash: entry.agentIdHash });
    } else {
      await setStatus(entry, "commit_unknown");
      logger("subagent-commit-outcome-unknown", {
        agentIdHash: entry.agentIdHash,
        reason: result?.reason || "request-failed",
      });
    }
    await closeRuntime(entry);
  }

  async function completeChild(agentId) {
    const childIdentity = identity(agentId);
    if (!childIdentity) return;
    const entry = await readEntry(childIdentity.agentIdHash);
    if (!entry) {
      logger("subagent-completion-without-start", {
        agentIdHash: childIdentity.agentIdHash,
      });
      return;
    }
    return completeEntry(entry);
  }

  async function handle(event, captureParent) {
    if (!enabled || closed) return captureParent(event);
    const agentId = event?.agentId;
    if (event?.type === "subagent.started") {
      await captureParent(event);
      if (typeof agentId === "string") await ensureActive(agentId);
      return;
    }
    if (event?.type === "subagent.completed") {
      await captureParent(event);
      if (typeof agentId === "string") await completeChild(agentId);
      return;
    }
    if (typeof agentId === "string" && CHILD_EVENT_TYPES.has(event?.type)) {
      const entry = await ensureActive(agentId, { missingStart: true });
      if (!entry) return;
      const runtime = await runtimeFor(entry);
      await runtime.capture(event);
      return;
    }
    return captureParent(event);
  }

  return {
    async initialize() {
      if (!enabled || initialized) return;
      initialized = true;
      for (const stored of await parentStore.subagentSessions()) {
        const entry = { ...stored, runtimePromise: null };
        entries.set(entry.agentIdHash, entry);
        if (entry.status === "active" && entry.ownerPid !== process.pid) {
          if (processIsAlive(entry.ownerPid)) {
            logger("subagent-session-owned-by-other-process", {
              agentIdHash: entry.agentIdHash,
            });
          } else {
            await setStatus(entry, "orphaned");
            logger("subagent-recovery-required", {
              agentIdHash: entry.agentIdHash,
              status: "orphaned",
            });
          }
        } else if (entry.status === "committing") {
          await setStatus(entry, "commit_unknown");
          logger("subagent-recovery-required", {
            agentIdHash: entry.agentIdHash,
            status: "commit_unknown",
          });
        } else if (entry.status === "completed") {
          await completeEntry(entry);
        } else if (entry.status === "commit_unknown" || entry.status === "orphaned") {
          logger("subagent-recovery-required", {
            agentIdHash: entry.agentIdHash,
            status: entry.status,
          });
        }
      }
    },
    capture(event, captureParent) {
      if (!enabled) return captureParent(event);
      const result = queue.then(() => handle(event, captureParent));
      queue = result.catch((error) => {
        logger("subagent-capture-failed", { name: error?.name || "Error" });
      });
      return result;
    },
    async drain() {
      await queue;
    },
    async close() {
      await queue;
      closed = true;
      for (const entry of entries.values()) {
        if (entry.status === "active" && entry.ownerPid === process.pid) {
          await setStatus(entry, "orphaned");
          logger("subagent-recovery-required", {
            agentIdHash: entry.agentIdHash,
            status: "orphaned",
          });
        }
        if (entry.runtimePromise) {
          await closeRuntime(entry);
        }
      }
    },
  };
}
