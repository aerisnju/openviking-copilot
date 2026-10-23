import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const SCHEMA_VERSION = 1;
const DEFAULT_MAX_QUEUE_BYTES = 50 * 1024 * 1024;
const DEFAULT_MAX_RECORDS = 10_000;
const DEFAULT_LOCK_WAIT_MS = 5_000;
const DEFAULT_STALE_LOCK_MS = 60_000;
const SUBAGENT_SESSION_STATUSES = new Set([
  "active",
  "completed",
  "committing",
  "committed",
  "commit_unknown",
  "orphaned",
]);

function sessionDirectoryName(sessionId) {
  return createHash("sha256").update(sessionId).digest("hex");
}

function encodeRecord(record) {
  return `${JSON.stringify(record)}\n`;
}

function safeFailureMessage(value) {
  return String(value ?? "Unclassified non-retryable failure")
    .replace(
      /\b(api[-_]?key|access[-_]?token|refresh[-_]?token|password|passwd|secret|authorization)\b(\s*[:=]\s*)(?:Bearer\s+)?(?:"[^"]*"|'[^']*'|[^\s,;&]+)/gi,
      "$1$2[removed]",
    )
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [removed]")
    .replace(
      /\b(api[-_]?key|access[-_]?token|refresh[-_]?token|password|passwd|secret|authorization)\b(\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;&]+)/gi,
      "$1$2[removed]",
    )
    .slice(0, 2000);
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function readJournal(path) {
  let text;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const entries = [];
  for (const [index, line] of text.split("\n").entries()) {
    if (!line) continue;
    try {
      entries.push(JSON.parse(line));
    } catch (error) {
      throw new Error(`Invalid journal record on line ${index + 1}: ${error.message}`);
    }
  }
  return entries;
}

async function atomicWrite(path, contents) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(contents, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

async function appendDurably(path, line) {
  const handle = await open(path, "a", 0o600);
  try {
    await handle.writeFile(line, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    if (error.code === "EPERM") return true;
    throw error;
  }
}

async function recoverStaleLock(lockPath, recoveryPath, staleAfterMs) {
  try {
    await mkdir(recoveryPath);
  } catch (error) {
    if (error.code === "EEXIST") return false;
    throw error;
  }

  const quarantine = `${lockPath}.stale-${randomUUID()}`;
  try {
    const [owner, lockStat] = await Promise.all([
      readJson(join(lockPath, "owner.json")),
      stat(lockPath),
    ]);
    const oldEnough = Date.now() - lockStat.mtimeMs > staleAfterMs;
    if (!oldEnough || (await processIsAlive(owner?.pid))) return false;
    await rename(lockPath, quarantine);
    await rm(quarantine, { recursive: true, force: true });
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    if (process.platform === "win32" && error.code === "EPERM") return false;
    throw error;
  } finally {
    await rm(recoveryPath, { recursive: true, force: true });
  }
}

async function acquireLock(lockPath, { waitMs, staleAfterMs }) {
  const recoveryPath = `${lockPath}.recovering`;
  const deadline = Date.now() + waitMs;
  const token = randomUUID();
  while (Date.now() <= deadline) {
    try {
      await stat(recoveryPath);
      await delay(20);
      continue;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }

    try {
      await mkdir(lockPath);
      try {
        await atomicWrite(
          join(lockPath, "owner.json"),
          `${JSON.stringify({ pid: process.pid, token, acquiredAt: new Date().toISOString() })}\n`,
        );
      } catch (error) {
        await rm(lockPath, { recursive: true, force: true });
        throw error;
      }
      return async () => {
        const owner = await readJson(join(lockPath, "owner.json"));
        if (owner?.token === token) {
          await rm(lockPath, { recursive: true, force: true });
        }
      };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }

    if (await recoverStaleLock(lockPath, recoveryPath, staleAfterMs)) continue;
    await delay(25);
  }

  const owner = await readJson(join(lockPath, "owner.json"));
  throw new Error(
    owner
      ? `Timed out waiting for session state lock held by PID ${owner.pid}`
      : "Timed out waiting for session state lock with unreadable owner metadata",
  );
}

export class DurableSessionStore {
  constructor({
    sessionId,
    stateRoot = join(homedir(), ".openviking", "copilot", "state"),
    maxQueueBytes = DEFAULT_MAX_QUEUE_BYTES,
    maxRecords = DEFAULT_MAX_RECORDS,
    lockWaitMs = DEFAULT_LOCK_WAIT_MS,
    staleLockMs = DEFAULT_STALE_LOCK_MS,
  }) {
    if (typeof sessionId !== "string" || !sessionId.trim()) {
      throw new TypeError("sessionId must be a non-empty string");
    }
    if (!Number.isSafeInteger(maxQueueBytes) || maxQueueBytes < 1) {
      throw new TypeError("maxQueueBytes must be a positive safe integer");
    }
    if (!Number.isSafeInteger(maxRecords) || maxRecords < 1) {
      throw new TypeError("maxRecords must be a positive safe integer");
    }
    this.sessionId = sessionId;
    this.stateRoot = resolve(stateRoot);
    this.directory = resolve(this.stateRoot, sessionDirectoryName(sessionId));
    this.statePath = join(this.directory, "state.json");
    this.journalPath = join(this.directory, "journal.ndjson");
    this.deadLetterPath = join(this.directory, "dead-letter.ndjson");
    this.observedIdsPath = join(this.directory, "observed-ids.ndjson");
    this.discardedPath = join(this.directory, "discarded.ndjson");
    this.subagentSessionsPath = join(this.directory, "subagent-sessions.json");
    this.lockPath = join(this.directory, "lock");
    this.remoteLockPath = join(this.directory, "remote-operation.lock");
    this.maxQueueBytes = maxQueueBytes;
    this.maxRecords = maxRecords;
    this.lockWaitMs = lockWaitMs;
    this.staleLockMs = staleLockMs;
  }

  async initialize() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    return this.#withLock(async () => {
      const { state, pending, deadLetters } = await this.#load();
      await this.#recoverObservedDigests(pending, deadLetters);
      await this.#writeState(state);
      return this.#snapshot();
    });
  }

  async stage(record) {
    this.#validateRecord(record);
    return this.#withLock(async () => {
      const { state, pending, discarded, journalBytes } = await this.#load();
      if (record.sourceSequence <= state.lastResolvedSequence) {
        return { status: "already_acknowledged" };
      }
      const duplicate = pending.find((item) => item.sourceEventId === record.sourceEventId);
      if (duplicate) {
        if (
          duplicate.sourceSequence !== record.sourceSequence ||
          duplicate.payloadDigest !== record.payloadDigest
        ) {
          throw new Error("Source event identity conflicts with an existing journal record");
        }
        return { status: "already_queued" };
      }
      if (discarded.some((entry) => entry.sourceSequence === record.sourceSequence)) {
        return { status: "already_discarded" };
      }
      if (record.sourceSequence <= state.lastObservedSequence) {
        throw new Error("Observed source sequence exists without a matching pending record");
      }
      if (record.sourceSequence !== state.lastObservedSequence + 1) {
        throw new Error(
          `Source sequence gap: expected ${state.lastObservedSequence + 1}, received ${record.sourceSequence}`,
        );
      }

      const line = encodeRecord(record);
      const bytes = Buffer.byteLength(line, "utf8");
      if (pending.length + 1 > this.maxRecords) {
        throw new Error("Pending record limit reached; capture is paused without evicting queued data");
      }
      if (journalBytes + bytes > this.maxQueueBytes) {
        throw new Error("Pending byte limit reached; capture is paused without evicting queued data");
      }

      await appendDurably(this.journalPath, line);
      if (/^[a-f0-9]{64}$/.test(record.payloadDigest || "")) {
        await appendDurably(
          this.observedIdsPath,
          `${JSON.stringify({
            digest: createHash("sha256").update(record.sourceEventId).digest("hex"),
            payloadDigest: record.payloadDigest,
          })}\n`,
        );
      }
      state.lastObservedSequence = record.sourceSequence;
      await this.#writeState(state);
      return { status: "staged" };
    });
  }

  async pendingRecords() {
    return this.#withLock(async () => (await this.#load()).pending);
  }

  async observedEventDigests() {
    return this.#withLock(async () => {
      const { pending, deadLetters } = await this.#load();
      await this.#recoverObservedDigests(pending, deadLetters);
      const entries = await readJournal(this.observedIdsPath);
      if (entries.some((entry) =>
        !/^[a-f0-9]{64}$/.test(entry?.digest) ||
        !/^[a-f0-9]{64}$/.test(entry?.payloadDigest)
      )) {
        throw new Error("Invalid observed event digest");
      }
      return new Map(entries.map((entry) => [entry.digest, entry.payloadDigest]));
    });
  }

  /**
   * Drop ledger entries that can no longer be needed.
   *
   * The ledger exists so the compaction audit can prove that every event the
   * host had already written to the transcript was also journaled. Its required
   * span is therefore "whatever the current transcript still contains", plus
   * anything still pending or dead-lettered. Entries outside that span cannot
   * be consulted again, so keeping them only costs growth — a long session
   * accumulates one line per captured event with no upper bound.
   *
   * Callers pass the digests the current transcript still needs; everything else
   * is removed. The rewrite is atomic, so an interrupted prune leaves the
   * previous ledger intact.
   */
  async pruneObservedDigests(keepDigests) {
    if (!(keepDigests instanceof Set)) {
      throw new TypeError("keepDigests must be a Set of digest strings");
    }
    return this.#withLock(async () => {
      const { pending, deadLetters } = await this.#load();
      const entries = await readJournal(this.observedIdsPath);
      const kept = new Map();
      for (const entry of entries) {
        if (typeof entry?.digest !== "string" || !/^[a-f0-9]{64}$/.test(entry.digest)) {
          throw new Error("Invalid observed event digest");
        }
        if (keepDigests.has(entry.digest)) kept.set(entry.digest, entry.payloadDigest);
      }
      // Anything still queued must stay resolvable even if the transcript no
      // longer mentions it.
      for (const record of [...pending, ...deadLetters.map((entry) => entry.record)]) {
        if (!/^[a-f0-9]{64}$/.test(record.payloadDigest || "")) continue;
        const digest = createHash("sha256").update(record.sourceEventId).digest("hex");
        if (!kept.has(digest)) kept.set(digest, record.payloadDigest);
      }
      if (kept.size === entries.length) return { pruned: 0, kept: kept.size };
      await atomicWrite(
        this.observedIdsPath,
        [...kept].map(([digest, payloadDigest]) => `${JSON.stringify({ digest, payloadDigest })}\n`).join(""),
      );
      return { pruned: entries.length - kept.size, kept: kept.size };
    });
  }

  async #recoverObservedDigests(pending, deadLetters) {
    const entries = await readJournal(this.observedIdsPath);
    const observed = new Map();
    for (const entry of entries) {
      if (!/^[a-f0-9]{64}$/.test(entry?.digest) ||
          !/^[a-f0-9]{64}$/.test(entry?.payloadDigest) ||
          (observed.has(entry.digest) && observed.get(entry.digest) !== entry.payloadDigest)) {
        throw new Error("Invalid observed event digest");
      }
      observed.set(entry.digest, entry.payloadDigest);
    }
    for (const record of [...pending, ...deadLetters.map((entry) => entry.record)]) {
      if (!/^[a-f0-9]{64}$/.test(record.payloadDigest || "")) continue;
      const digest = createHash("sha256").update(record.sourceEventId).digest("hex");
      if (observed.has(digest)) {
        if (observed.get(digest) !== record.payloadDigest) {
          throw new Error("Observed event digest conflicts with journal");
        }
        continue;
      }
      await appendDurably(
        this.observedIdsPath,
        `${JSON.stringify({ digest, payloadDigest: record.payloadDigest })}\n`,
      );
      observed.set(digest, record.payloadDigest);
    }
  }

  async deadLetters() {
    return this.#withLock(async () => (await this.#load()).deadLetters);
  }

  async subagentSessions() {
    return this.#withLock(async () => {
      const data = await this.#readSubagentSessions();
      return Object.values(data.children);
    });
  }

  async updateSubagentSession({
    agentIdHash,
    openVikingSessionId,
    status,
    ownerPid = process.pid,
  }) {
    if (typeof agentIdHash !== "string" || !/^[a-f0-9]{64}$/.test(agentIdHash)) {
      throw new TypeError("agentIdHash must be a SHA-256 hex digest");
    }
    if (typeof openVikingSessionId !== "string" || !openVikingSessionId.trim()) {
      throw new TypeError("openVikingSessionId must be a non-empty string");
    }
    if (!SUBAGENT_SESSION_STATUSES.has(status)) {
      throw new TypeError("status is not a supported subagent session state");
    }
    if (!Number.isSafeInteger(ownerPid) || ownerPid < 1) {
      throw new TypeError("ownerPid must be a positive safe integer");
    }

    return this.#withLock(async () => {
      const data = await this.#readSubagentSessions();
      const existing = data.children[agentIdHash];
      if (existing && existing.openVikingSessionId !== openVikingSessionId) {
        throw new Error("Subagent identity is already mapped to a different OpenViking session");
      }
      if (
        existing?.status === "active" &&
        status === "active" &&
        existing.ownerPid !== ownerPid
      ) {
        throw new Error("Subagent session is already owned by another process");
      }
      if (existing && !this.#canTransitionSubagentStatus(existing.status, status)) {
        throw new Error(`Invalid subagent session transition: ${existing.status} -> ${status}`);
      }
      const now = new Date().toISOString();
      const entry = {
        agentIdHash,
        openVikingSessionId,
        status,
        ownerPid,
        createdAt: existing?.createdAt || now,
        updatedAt: now,
      };
      data.children[agentIdHash] = entry;
      await atomicWrite(this.subagentSessionsPath, `${JSON.stringify(data, null, 2)}\n`);
      return entry;
    });
  }

  async markDeadLetter(sequence, failure) {
    if (!Number.isSafeInteger(sequence) || sequence < 0) {
      throw new TypeError("sequence must be a non-negative safe integer");
    }
    if (!failure || typeof failure !== "object") {
      throw new TypeError("failure must be a structured object");
    }
    return this.#withLock(async () => {
      const { pending, deadLetters } = await this.#load();
      const existing = deadLetters.find((entry) => entry.record.sourceSequence === sequence);
      if (existing) return { status: "already_dead_lettered" };
      const record = pending.find((item) => item.sourceSequence === sequence);
      if (!record) throw new Error("Cannot dead-letter a record that is not pending");

      const entry = {
        record,
        failure: {
          category: ["authentication", "retryable", "schema", "local_io"].includes(failure.category)
            ? failure.category
            : "terminal",
          status: Number.isInteger(failure.status) ? failure.status : null,
          message: safeFailureMessage(failure.message),
        },
        deadLetteredAt: new Date().toISOString(),
      };
      await appendDurably(this.deadLetterPath, `${JSON.stringify(entry)}\n`);
      await this.#writeJournal(
        pending.filter((item) => item.sourceSequence !== sequence),
      );
      return { status: "dead_lettered" };
    });
  }

  async retryDeadLetter(sequence) {
    if (!Number.isSafeInteger(sequence) || sequence < 0) {
      throw new TypeError("sequence must be a non-negative safe integer");
    }
    return this.#withLock(async () => {
      const { pending, deadLetters } = await this.#load();
      const entry = deadLetters.find(
        (item) => item.record.sourceSequence === sequence,
      );
      if (!entry) throw new Error("Dead-letter sequence was not found");

      const retried = [...pending, entry.record].sort(
        (left, right) => left.sourceSequence - right.sourceSequence,
      );
      await this.#writeJournal(retried);
      await this.#writeDeadLetters(
        deadLetters.filter((item) => item.record.sourceSequence !== sequence),
      );
      return { status: "retried", sequence };
    });
  }

  async discardDeadLetter(sequence) {
    if (!Number.isSafeInteger(sequence) || sequence < 0) {
      throw new TypeError("sequence must be a non-negative safe integer");
    }
    return this.#withLock(async () => {
      const { state, pending, deadLetters, discarded } = await this.#load();
      const entry = deadLetters.find(
        (item) => item.record.sourceSequence === sequence,
      );
      if (!entry) throw new Error("Dead-letter sequence was not found");

      const tombstone = {
        sourceSequence: sequence,
        sourceEventDigest: createHash("sha256")
          .update(entry.record.sourceEventId)
          .digest("hex"),
        payloadDigest:
          typeof entry.record.payloadDigest === "string" &&
          /^[a-f0-9]{64}$/.test(entry.record.payloadDigest)
            ? entry.record.payloadDigest
            : createHash("sha256")
              .update(JSON.stringify(entry.record.payload ?? null))
              .digest("hex"),
        discardedAt: new Date().toISOString(),
      };
      await this.#writeDiscarded([...discarded, tombstone]);
      await this.#writeDeadLetters(
        deadLetters.filter((item) => item.record.sourceSequence !== sequence),
      );
      state.lastResolvedSequence = this.#advanceResolvedThroughDiscards(
        state.lastResolvedSequence,
        pending,
        discarded.concat(tombstone),
      );
      await this.#writeState(state);
      return { status: "discarded", sequence };
    });
  }

  async acknowledgeThrough(sequence) {
    if (!Number.isSafeInteger(sequence) || sequence < 0) {
      throw new TypeError("sequence must be a non-negative safe integer");
    }
    return this.#withLock(async () => {
      const { state, pending, deadLetters, discarded } = await this.#load();
      if (sequence <= state.lastResolvedSequence) return this.#snapshot();
      if (sequence > state.lastObservedSequence) {
        throw new Error("Cannot acknowledge beyond the highest durably observed sequence");
      }
      const required = sequence - state.lastResolvedSequence;
      const accepted = pending.filter(
        (record) =>
          record.sourceSequence > state.lastResolvedSequence &&
          record.sourceSequence <= sequence,
      );
      const blocked = deadLetters.find(
        (entry) =>
          entry.record.sourceSequence > state.lastResolvedSequence &&
          entry.record.sourceSequence <= sequence,
      );
      if (blocked) {
        throw new Error(
          `Cannot acknowledge through dead-letter sequence ${blocked.record.sourceSequence}`,
        );
      }
      const skipped = discarded.filter(
        (entry) =>
          entry.sourceSequence > state.lastResolvedSequence &&
          entry.sourceSequence <= sequence,
      );
      if (accepted.length + skipped.length !== required) {
        throw new Error("Cannot acknowledge a non-contiguous pending prefix");
      }
      if (!accepted.some((record) => record.sourceSequence === sequence)) {
        throw new Error("Cannot acknowledge through a sequence that was not accepted remotely");
      }

      state.lastAcknowledgedSequence = sequence;
      state.lastResolvedSequence = this.#advanceResolvedThroughDiscards(
        sequence,
        pending.filter((record) => record.sourceSequence > sequence),
        discarded,
      );
      await this.#writeState(state);
      await this.#writeJournal(pending.filter((record) => record.sourceSequence > sequence));
      return {
        ...state,
        pendingCount: pending.filter(
          (record) => record.sourceSequence > state.lastResolvedSequence,
        ).length,
        deadLetterCount: deadLetters.length,
        discardedCount: discarded.length,
      };
    });
  }

  async snapshot() {
    return this.#withLock(() => this.#snapshot());
  }

  async withRemoteLease(operation, { waitMs = this.lockWaitMs } = {}) {
    if (typeof operation !== "function") {
      throw new TypeError("operation must be a function");
    }
    const release = await acquireLock(this.remoteLockPath, {
      waitMs,
      staleAfterMs: this.staleLockMs,
    });
    try {
      return await operation();
    } finally {
      await release();
    }
  }

  async exportRecoveryBundle() {
    return this.#withLock(async () => {
      const { state, pending, deadLetters, discarded, journalBytes } = await this.#load();
      return {
        ...this.#buildSnapshot(state, pending, deadLetters, discarded, journalBytes),
        pending,
        deadLetters,
        discarded,
      };
    });
  }

  async #snapshot() {
    const { state, pending, deadLetters, discarded, journalBytes } = await this.#load();
    return this.#buildSnapshot(state, pending, deadLetters, discarded, journalBytes);
  }

  #buildSnapshot(state, pending, deadLetters, discarded, journalBytes) {
    return {
      ...state,
      pendingCount: pending.length,
      pendingBytes: journalBytes,
      deadLetterCount: deadLetters.length,
      deadLetterSequences: deadLetters.map((entry) => entry.record.sourceSequence),
      discardedCount: discarded.length,
      discardedSequences: discarded.map((entry) => entry.sourceSequence),
    };
  }

  async #load() {
    const stored = await readJson(this.statePath);
    let state = stored ?? {
      schemaVersion: SCHEMA_VERSION,
      sourceSessionId: this.sessionId,
      lastObservedSequence: -1,
      lastAcknowledgedSequence: -1,
      lastResolvedSequence: -1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    if (state.lastResolvedSequence === undefined) {
      state.lastResolvedSequence = state.lastAcknowledgedSequence;
    }
    if (state.schemaVersion !== SCHEMA_VERSION || state.sourceSessionId !== this.sessionId) {
      throw new Error("Session state schema or source identity mismatch");
    }
    if (
      !Number.isSafeInteger(state.lastObservedSequence) ||
      !Number.isSafeInteger(state.lastAcknowledgedSequence) ||
      !Number.isSafeInteger(state.lastResolvedSequence) ||
      state.lastAcknowledgedSequence < -1 ||
      state.lastAcknowledgedSequence > state.lastResolvedSequence ||
      state.lastResolvedSequence < -1 ||
      state.lastObservedSequence < state.lastResolvedSequence
    ) {
      throw new Error("Session state cursors are invalid");
    }

    const journal = await readJournal(this.journalPath);
    const deadLetterRows = await readJournal(this.deadLetterPath);
    const discardedRows = await readJournal(this.discardedPath);
    for (const record of journal) this.#validateRecord(record);
    for (const entry of deadLetterRows) {
      if (!entry || typeof entry !== "object" || !entry.record) {
        throw new Error("Invalid dead-letter entry: record is missing");
      }
      this.#validateRecord(entry.record);
    }
    for (const entry of discardedRows) {
      if (
        !Number.isSafeInteger(entry.sourceSequence) ||
        entry.sourceSequence < 0 ||
        typeof entry.sourceEventDigest !== "string" ||
        !/^[a-f0-9]{64}$/.test(entry.sourceEventDigest) ||
        typeof entry.payloadDigest !== "string" ||
        !/^[a-f0-9]{64}$/.test(entry.payloadDigest) ||
        typeof entry.discardedAt !== "string" ||
        !Number.isFinite(Date.parse(entry.discardedAt))
      ) {
        throw new Error("Invalid discarded sequence marker");
      }
    }
    const unresolvedDiscarded = discardedRows.filter(
      (entry) => entry.sourceSequence > state.lastResolvedSequence,
    );
    const discardedSequences = new Set(
      unresolvedDiscarded.map((entry) => entry.sourceSequence),
    );
    const journalPending = journal.filter(
      (record) => record.sourceSequence > state.lastResolvedSequence,
    );
    const deadLetters = deadLetterRows.filter(
      (entry) =>
        entry.record.sourceSequence > state.lastResolvedSequence &&
        !discardedSequences.has(entry.record.sourceSequence),
    );
    const deadLetterSequences = new Set(
      deadLetters.map((entry) => entry.record.sourceSequence),
    );
    const pending = journalPending.filter(
      (record) =>
        !deadLetterSequences.has(record.sourceSequence) &&
        !discardedSequences.has(record.sourceSequence),
    );
    const resolvedThroughDiscard = this.#advanceResolvedThroughDiscards(
      state.lastResolvedSequence,
      pending,
      unresolvedDiscarded,
    );
    if (resolvedThroughDiscard !== state.lastResolvedSequence) {
      state.lastResolvedSequence = resolvedThroughDiscard;
      await this.#writeState(state);
    }
    const remainingDiscarded = unresolvedDiscarded.filter(
      (entry) => entry.sourceSequence > state.lastResolvedSequence,
    );
    const journalBytes = Buffer.byteLength(
      pending.map(encodeRecord).join(""),
      "utf8",
    );
    const coveredSequences = [
      ...pending.map((record) => record.sourceSequence),
      ...deadLetters.map((entry) => entry.record.sourceSequence),
      ...remainingDiscarded.map((entry) => entry.sourceSequence),
    ].sort((left, right) => left - right);
    const lastCoveredSequence = coveredSequences.at(-1) ?? state.lastResolvedSequence;
    if (lastCoveredSequence > state.lastObservedSequence) {
      state.lastObservedSequence = lastCoveredSequence;
      await this.#writeState(state);
    }
    if (
      state.lastObservedSequence > state.lastResolvedSequence &&
      state.lastObservedSequence !== lastCoveredSequence
    ) {
      throw new Error("Session journal is missing one or more durably observed records");
    }
    for (let index = 0; index < coveredSequences.length; index += 1) {
      const expected = state.lastResolvedSequence + index + 1;
      if (coveredSequences[index] !== expected) {
        throw new Error(`Session journal sequence gap at ${expected}`);
      }
    }
    if (
      pending.length !== journal.length ||
      deadLetters.length !== deadLetterRows.length
    ) {
      await this.#writeJournal(pending);
      await this.#writeDeadLetters(deadLetters);
    }
    return {
      state,
      pending,
      deadLetters,
      discarded: discardedRows,
      journalBytes,
    };
  }

  async #readSubagentSessions() {
    const data = await readJson(this.subagentSessionsPath) ?? {
      schemaVersion: 1,
      sourceSessionId: this.sessionId,
      children: {},
    };
    if (
      data.schemaVersion !== 1 ||
      data.sourceSessionId !== this.sessionId ||
      !data.children ||
      typeof data.children !== "object" ||
      Array.isArray(data.children)
    ) {
      throw new Error("Subagent session registry schema or source identity mismatch");
    }
    for (const [hash, entry] of Object.entries(data.children)) {
      if (
        !/^[a-f0-9]{64}$/.test(hash) ||
        entry?.agentIdHash !== hash ||
        typeof entry.openVikingSessionId !== "string" ||
        !entry.openVikingSessionId.trim() ||
        !SUBAGENT_SESSION_STATUSES.has(entry.status) ||
        !Number.isSafeInteger(entry.ownerPid) ||
        entry.ownerPid < 1 ||
        !Number.isFinite(Date.parse(entry.createdAt)) ||
        !Number.isFinite(Date.parse(entry.updatedAt))
      ) {
        throw new Error("Invalid subagent session registry entry");
      }
    }
    return data;
  }

  #canTransitionSubagentStatus(from, to) {
    const transitions = {
      active: new Set(["active", "completed", "orphaned"]),
      completed: new Set(["completed", "committing"]),
      committing: new Set(["committed", "commit_unknown"]),
      committed: new Set(["committed"]),
      commit_unknown: new Set(["commit_unknown"]),
      orphaned: new Set(["orphaned"]),
    };
    return transitions[from]?.has(to) === true;
  }

  async #writeState(state) {
    state.updatedAt = new Date().toISOString();
    await atomicWrite(this.statePath, `${JSON.stringify(state, null, 2)}\n`);
  }

  async #writeJournal(records) {
    await atomicWrite(this.journalPath, records.map(encodeRecord).join(""));
  }

  async #writeDeadLetters(entries) {
    await atomicWrite(
      this.deadLetterPath,
      entries.map((entry) => `${JSON.stringify(entry)}\n`).join(""),
    );
  }

  async #writeDiscarded(entries) {
    await atomicWrite(
      this.discardedPath,
      entries.map((entry) => `${JSON.stringify(entry)}\n`).join(""),
    );
  }

  #advanceResolvedThroughDiscards(sequence, pending, discarded) {
    const pendingSequences = new Set(
      pending.map((record) => record.sourceSequence),
    );
    const discardedSequences = new Set(
      discarded.map((entry) => entry.sourceSequence),
    );
    let resolved = sequence;
    while (!pendingSequences.has(resolved + 1) && discardedSequences.has(resolved + 1)) {
      resolved += 1;
    }
    return resolved;
  }

  #validateRecord(record) {
    if (!record || typeof record !== "object") throw new TypeError("record must be an object");
    if (record.sourceSessionId !== this.sessionId) {
      throw new Error("record sourceSessionId does not match this state partition");
    }
    if (
      typeof record.sourceEventId !== "string" ||
      !record.sourceEventId ||
      !Number.isSafeInteger(record.sourceSequence) ||
      record.sourceSequence < 0
    ) {
      throw new TypeError("record requires a sourceEventId and non-negative sourceSequence");
    }
  }

  async #withLock(operation) {
    const release = await acquireLock(this.lockPath, {
      waitMs: this.lockWaitMs,
      staleAfterMs: this.staleLockMs,
    });
    try {
      return await operation();
    } finally {
      await release();
    }
  }
}
