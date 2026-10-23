import { createHash } from "node:crypto";
import { buildAgentProfile, recallForPrompt } from "../vendor/openviking-memory-plugin-shared/lib/agent-hook-runtime.mjs";
import { applyInputFilters, compileInputFilters } from "../vendor/openviking-memory-plugin-shared/lib/input-filters.mjs";
import { resolveEffectivePeerId } from "../vendor/openviking-memory-plugin-shared/lib/workspace-peer.mjs";
import { classifyOpenVikingFailure } from "./retry-policy.mjs";
import { boundRecallContext } from "./context-budget.mjs";
import { normalizeCopilotEvents, isExcludedTool } from "./event-normalizer.mjs";
import { DurableSessionStore } from "./durable-session-store.mjs";
import {
  createSubagentMemoryManager,
  SUBAGENT_MEMORY_POLICY,
} from "./subagent-memory-manager.mjs";

const MAX_EVENT_IDS = 2048;
const DEFAULT_RETRY_BASE_MS = 1_000;
// A transient transport failure should not leave a session backlog visible for
// a minute. The cap bounds how long a stalled flush can stay unchallenged, and
// a new event resets the schedule through flushPending.
const DEFAULT_RETRY_MAX_MS = 15_000;
// The upstream default capture budget is 30 s, which is generous for a single
// message write and long enough to look like a stall: one hung socket costs
// half a minute before the queue is even retried. Clamp the per-write budget so
// a dead connection is abandoned quickly; a slower but live server still gets
// the full configured budget up to this ceiling.
const MAX_CAPTURE_WRITE_TIMEOUT_MS = 10_000;
const RETRY_JITTER_RATIO = 0.2;

export function getOpenVikingSessionId(copilotSessionId) {
  if (typeof copilotSessionId !== "string" || !copilotSessionId.trim()) {
    throw new TypeError("copilotSessionId must be a non-empty string");
  }
  return `copilot-${createHash("sha256").update(copilotSessionId).digest("hex").slice(0, 40)}`;
}

function messageForRecord(record, peerId) {
  const payload = record.payload || {};
  const role = record.actor === "user" ? "user" : "assistant";
  const messageKind =
    record.kind === "turn_boundary" ||
    record.kind === "subagent_start" ||
    record.kind === "subagent_complete"
      ? "checkpoint"
      : role === "user"
        ? "user_query"
        : "assistant_step";
  const parts = Array.isArray(payload.parts)
    ? payload.parts
    : [{ type: "text", text: payload.lifecycleEvent || "Turn boundary" }];
  const message = {
    role,
    parts,
    created_at: record.occurredAt || new Date().toISOString(),
    message_kind: messageKind,
    source_message_ids: [record.sourceEventId],
  };
  if (payload.turnId) message.turn_id = payload.turnId;
  if (peerId) message.peer_id = peerId;
  return message;
}

function failureCategory(classification) {
  if (classification.category !== "terminal") return classification.category;
  if (classification.status === 400 || classification.status === 422) return "schema";
  return "terminal";
}

function failureMessage(result) {
  const code = result?.error?.code;
  return typeof code === "string" ? code.slice(0, 200) : `HTTP ${Number(result?.status) || "network"}`;
}

export function createCopilotMemorySession({
  copilotSessionId,
  openVikingSessionId: configuredOpenVikingSessionId,
  cwd,
  config,
  fetchJSON,
  store,
  sessionMemoryPolicy,
  subagentMemoryEnabled = false,
  subagentSessionIdFactory,
  logger = () => {},
  retryScheduler = {},
}) {
  if (typeof fetchJSON !== "function") throw new TypeError("fetchJSON must be a function");
  const sourceSessionId = copilotSessionId;
  const openVikingSessionId = configuredOpenVikingSessionId || getOpenVikingSessionId(copilotSessionId);
  const peerId = resolveEffectivePeerId({ cfg: config, cwd }).peerId;
  const captureFilterErrors = compileInputFilters(config.captureFilters).errors;
  const recallFilters = compileInputFilters(config.recallQueryFilters);
  if (captureFilterErrors.length > 0) {
    logger("capture-filter-invalid", { count: captureFilterErrors.length });
  }
  if (recallFilters.errors.length > 0) {
    logger("recall-filter-invalid", { count: recallFilters.errors.length });
  }
  const sessionStore =
    store ||
    new DurableSessionStore({
      sessionId: sourceSessionId,
    });
  const recentEventIds = new Set();
  const excludedCallIds = new Set();
  let nextSequence = 0;
  let initialized = false;
  let remoteSessionReady = false;
  let operationQueue = Promise.resolve();
  let retryTimer = null;
  let retryAttempt = 0;
  let closed = false;
  const setTimer = retryScheduler.setTimeout || setTimeout;
  const clearTimer = retryScheduler.clearTimeout || clearTimeout;
  const random = retryScheduler.random || Math.random;
  const retryBaseMs = retryScheduler.baseDelayMs ?? DEFAULT_RETRY_BASE_MS;
  const retryMaxMs = retryScheduler.maxDelayMs ?? DEFAULT_RETRY_MAX_MS;
  const subagentManager = subagentMemoryEnabled && config.autoCapture !== false
    ? createSubagentMemoryManager({
        enabled: true,
        parentSessionId: sourceSessionId,
        parentStore: sessionStore,
        resolveChildIdentity: ({ agentIdHash, sourceSessionId: childSourceSessionId }) =>
          subagentSessionIdFactory
            ? subagentSessionIdFactory({ agentIdHash, sourceSessionId: childSourceSessionId })
            : getOpenVikingSessionId(childSourceSessionId),
        createRuntime: ({ sourceSessionId: childSourceSessionId, openVikingSessionId: childSessionId }) =>
          createCopilotMemorySession({
            copilotSessionId: childSourceSessionId,
            openVikingSessionId: childSessionId,
            cwd,
            config,
            fetchJSON,
            store: new DurableSessionStore({
              sessionId: childSourceSessionId,
              stateRoot: sessionStore.stateRoot,
            }),
            sessionMemoryPolicy: SUBAGENT_MEMORY_POLICY,
            logger,
          }),
        logger,
      })
    : null;

  function sessionPolicyMatches(result) {
    if (!sessionMemoryPolicy) return true;
    const actual = result?.result;
    const actualPolicy = actual?.memory_policy;
    const expectedTypes = [...(sessionMemoryPolicy.memory_types || [])].sort();
    const actualTypes = Array.isArray(actualPolicy?.memory_types)
      ? [...actualPolicy.memory_types].sort()
      : [];
    return actual?.session_id === openVikingSessionId
      && actualPolicy?.self?.enabled === false
      && actualPolicy?.peer?.enabled === true
      && actualPolicy?.working_memory?.enabled === false
      && JSON.stringify(actualTypes) === JSON.stringify(expectedTypes)
      && actual.auto_commit_policy == null;
  }

  async function readRemoteSession(timeoutMs) {
    return fetchJSON(
      `/api/v1/sessions/${encodeURIComponent(openVikingSessionId)}`,
      {},
      { timeoutMs },
    );
  }

  function cancelRetry() {
    if (retryTimer === null) return;
    clearTimer(retryTimer);
    retryTimer = null;
  }

  function scheduleRetry() {
    if (closed || retryTimer !== null) return;
    const exponentialDelay = Math.min(
      retryMaxMs,
      retryBaseMs * (2 ** Math.min(retryAttempt, 30)),
    );
    retryAttempt += 1;
    const jitteredDelay = Math.round(
      exponentialDelay * (1 - RETRY_JITTER_RATIO + random() * RETRY_JITTER_RATIO * 2),
    );
    const delayMs = Math.min(retryMaxMs, Math.max(0, jitteredDelay));
    retryTimer = setTimer(() => {
      retryTimer = null;
      void enqueue(async () => {
        if (!closed) await flushPending();
      });
    }, delayMs);
    retryTimer?.unref?.();
    logger("capture-retry-scheduled", { attempt: retryAttempt, delayMs });
  }

  async function ensureRemoteSession(timeoutMs = config.timeoutMs) {
    if (remoteSessionReady) return true;
    if (sessionMemoryPolicy) {
      let existing = await readRemoteSession(timeoutMs);
      if (existing?.ok) {
        if (!sessionPolicyMatches(existing)) {
          logger("session-policy-mismatch", {});
          return false;
        }
        remoteSessionReady = true;
        return true;
      }
      if (Number(existing?.status) !== 404) {
        const classification = classifyOpenVikingFailure(existing);
        logger("session-unavailable", {
          status: Number(existing?.status) || null,
          category: failureCategory(classification),
        });
        if (classification.retryable) scheduleRetry();
        return false;
      }

      const created = await fetchJSON(
        "/api/v1/sessions",
        {
          method: "POST",
          body: JSON.stringify({
            session_id: openVikingSessionId,
            memory_policy: sessionMemoryPolicy,
            auto_commit_policy: null,
          }),
        },
        { timeoutMs },
      );
      if (!created?.ok) {
        // A competing process may have created the same isolated session.
        existing = await readRemoteSession(timeoutMs);
        if (!existing?.ok || !sessionPolicyMatches(existing)) {
          const classification = classifyOpenVikingFailure(created);
          logger("session-create-failed", {
            status: Number(created?.status) || null,
            category: failureCategory(classification),
          });
          if (classification.retryable) scheduleRetry();
          return false;
        }
      }

      const verified = await readRemoteSession(timeoutMs);
      if (!verified?.ok || !sessionPolicyMatches(verified)) {
        logger("session-policy-verification-failed", {
          status: Number(verified?.status) || null,
        });
        return false;
      }
      remoteSessionReady = true;
      return true;
    }

    const result = await fetchJSON(
      `/api/v1/sessions/${encodeURIComponent(openVikingSessionId)}?auto_create=true`,
      {},
      { timeoutMs },
    );
    if (!result?.ok || result.result?.session_id !== openVikingSessionId) {
      const classification = classifyOpenVikingFailure(result);
      logger("session-unavailable", {
        status: Number(result?.status) || null,
        category: failureCategory(classification),
      });
      if (classification.retryable) scheduleRetry();
      return false;
    }
    remoteSessionReady = true;
    return true;
  }

  async function flushPendingWithLease({ deadlineAt } = {}) {
    cancelRetry();
    if (closed) return { sent: 0, blocked: true, reason: "closed" };
    const snapshot = await sessionStore.snapshot();
    if (snapshot.deadLetterCount > 0) {
      retryAttempt = 0;
      return { sent: 0, blocked: true, reason: "dead-letter" };
    }
    const pending = await sessionStore.pendingRecords();
    if (pending.length === 0) {
      retryAttempt = 0;
      return { sent: 0, blocked: false };
    }
    const remaining = (fallback) =>
      deadlineAt === undefined
        ? fallback
        : Math.min(fallback, Math.max(0, deadlineAt - Date.now()));
    const sessionTimeout = remaining(config.timeoutMs);
    if (sessionTimeout <= 0) {
      return { sent: 0, blocked: true, reason: "deadline" };
    }
    if (!(await ensureRemoteSession(sessionTimeout))) {
      return { sent: 0, blocked: true, reason: "session-unavailable" };
    }
    let sent = 0;
    for (const record of pending) {
      const captureTimeout = remaining(
        Math.min(config.captureTimeoutMs, MAX_CAPTURE_WRITE_TIMEOUT_MS),
      );
      if (captureTimeout <= 0) {
        scheduleRetry();
        return { sent, blocked: true, reason: "deadline" };
      }
      const result = await fetchJSON(
        `/api/v1/sessions/${encodeURIComponent(openVikingSessionId)}/messages`,
        {
          method: "POST",
          body: JSON.stringify(messageForRecord(record, peerId)),
        },
        { timeoutMs: captureTimeout },
      );
      const classification = classifyOpenVikingFailure(result);
      if (classification.category !== "accepted") {
        if (!classification.retryable) {
          await sessionStore.markDeadLetter(record.sourceSequence, {
            category: failureCategory(classification),
            status: classification.status,
            message: failureMessage(result),
          });
        } else {
          logger("capture-deferred", {
            sequence: record.sourceSequence,
            status: classification.status,
          });
          scheduleRetry();
        }
        return { sent, blocked: true };
      }
      await sessionStore.acknowledgeThrough(record.sourceSequence);
      sent += 1;
      retryAttempt = 0;
    }
    cancelRetry();
    return { sent, blocked: false };
  }

  function flushPending(options = {}) {
    const waitMs =
      options.deadlineAt === undefined
        ? undefined
        : Math.max(1, Math.min(1_000, options.deadlineAt - Date.now()));
    return sessionStore.withRemoteLease(
      () => flushPendingWithLease(options),
      { waitMs },
    );
  }

  function serialize(operation, returnOperationResult) {
    const result = operationQueue.then(operation);
    operationQueue = result.catch((error) => {
      logger("capture-local-failure", {
        name: error?.name || "Error",
      });
    });
    return returnOperationResult ? result : operationQueue;
  }

  function enqueue(operation) {
    return serialize(operation, false);
  }

  function runExclusive(operation) {
    return serialize(operation, true);
  }

  function captureParentEvent(event) {
    if (!initialized || config.autoCapture === false) return enqueue(async () => {});
    return enqueue(async () => {
      if (event?.id && recentEventIds.has(event.id)) return;
      // Events arrive one at a time, so the exclusion decision made on a tool
      // start has to be remembered for its completion.
      if (event?.type === "tool.execution_start") {
        const callId = event.data?.toolCallId;
        if (callId && isExcludedTool(event.data?.toolName, config.excludedTools)) {
          excludedCallIds.add(callId);
        }
      }
      const [record] = normalizeCopilotEvents(
        [event],
        sourceSessionId,
        {
          startSequence: nextSequence,
          captureFilters: config.captureFilters,
          captureMaxLength: config.captureMaxLength,
          captureToolMaxChars: config.captureToolMaxChars,
          captureToolResults: config.captureToolResults === true,
          excludedTools: config.excludedTools,
          excludedCallIds,
        },
      );
      if (!record) return;
      const result = await sessionStore.stage(record);
      if (result.status === "staged" || result.status === "already_queued") {
        nextSequence = record.sourceSequence + 1;
        if (event?.id) {
          recentEventIds.add(event.id);
          if (recentEventIds.size > MAX_EVENT_IDS) {
            recentEventIds.delete(recentEventIds.values().next().value);
          }
        }
        await flushPending();
      }
    });
  }

  return {
    sourceSessionId,
    openVikingSessionId,
    async initialize() {
      if (initialized) return;
      await sessionStore.initialize();
      const snapshot = await sessionStore.snapshot();
      nextSequence = snapshot.lastObservedSequence + 1;
      initialized = true;
      await subagentManager?.initialize();
    },
    capture(event) {
      if (!subagentManager) return captureParentEvent(event);
      return subagentManager.capture(event, captureParentEvent);
    },
    async recall(prompt) {
      try {
        const filteredPrompt = applyInputFilters(prompt, recallFilters.rules, { role: "user" });
        if (filteredPrompt.dropped || !filteredPrompt.text) return null;
        const recalled = await recallForPrompt(
          fetchJSON,
          config,
          filteredPrompt.text,
          cwd,
          logger,
          { sessionId: openVikingSessionId },
        );
        const bounded = boundRecallContext(recalled, config.recallMaxTokens);
        if (bounded.truncated) {
          logger("recall-context-truncated", {
            tokenBudget: config.recallMaxTokens || 1600,
            estimatedTokens: bounded.estimatedTokens,
          });
        }
        return bounded.text || null;
      } catch (error) {
        logger("recall-unavailable", { name: error?.name || "Error" });
        return null;
      }
    },
    async profile() {
      try {
        return await buildAgentProfile(fetchJSON, config, cwd);
      } catch (error) {
        logger("profile-unavailable", { name: error?.name || "Error" });
        return null;
      }
    },
    async commit({ deadlineAt } = {}) {
      await subagentManager?.drain();
      const waitMs =
        deadlineAt === undefined
          ? undefined
          : Math.max(1, Math.min(1_000, deadlineAt - Date.now()));
      return runExclusive(() =>
        sessionStore.withRemoteLease(async () => {
          const snapshot = await sessionStore.snapshot();
          if (snapshot.pendingCount > 0 || snapshot.deadLetterCount > 0) {
            return {
              ok: false,
              reason: snapshot.deadLetterCount > 0 ? "dead-letter" : "capture-pending",
            };
          }
          if (snapshot.lastObservedSequence < 0) {
            return { ok: true, skipped: true, reason: "no-captured-events" };
          }
          const remaining =
            deadlineAt === undefined
              ? config.timeoutMs
              : Math.min(config.timeoutMs, Math.max(0, deadlineAt - Date.now()));
          if (remaining <= 0) return { ok: false, reason: "deadline" };
          if (!(await ensureRemoteSession(remaining))) {
            return { ok: false, reason: "session-unavailable" };
          }
          const commitTimeout =
            deadlineAt === undefined
              ? config.captureTimeoutMs
              : Math.min(config.captureTimeoutMs, Math.max(0, deadlineAt - Date.now()));
          if (commitTimeout <= 0) return { ok: false, reason: "deadline" };
          const result = await fetchJSON(
            `/api/v1/sessions/${encodeURIComponent(openVikingSessionId)}/commit`,
            { method: "POST", body: JSON.stringify({}) },
            { timeoutMs: commitTimeout },
          );
          if (!result?.ok) {
            logger("commit-failed", {
              status: Number(result?.status) || null,
              category: failureCategory(classifyOpenVikingFailure(result)),
            });
          }
          return result;
        }, { waitMs }),
      );
    },
    async flush(options) {
      await subagentManager?.drain();
      return runExclusive(() => flushPending(options));
    },
    async close() {
      await subagentManager?.close();
      closed = true;
      cancelRetry();
    },
  };
}
