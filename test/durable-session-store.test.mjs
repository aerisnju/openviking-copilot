import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { DurableSessionStore } from "../src/durable-session-store.mjs";
import { normalizeCopilotEvents } from "../src/event-normalizer.mjs";

async function withStore(options, run) {
  const directory = await mkdtemp(join(tmpdir(), "ov-copilot-store-"));
  try {
    const store = new DurableSessionStore({
      sessionId: "source-session",
      stateRoot: directory,
      ...options,
    });
    await store.initialize();
    await run(store);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function record(sourceSequence, sourceEventId = `event-${sourceSequence}`) {
  return {
    sourceSessionId: "source-session",
    sourceSequence,
    sourceEventId,
    kind: "user_message",
    payload: { text: `message-${sourceSequence}` },
  };
}

test("journals before cursor movement and acknowledges only a contiguous prefix", async () => {
  await withStore({}, async (store) => {
    assert.deepEqual(await store.stage(record(0)), { status: "staged" });
    await store.stage(record(1));
    assert.equal((await store.snapshot()).lastObservedSequence, 1);
    assert.equal((await store.snapshot()).lastAcknowledgedSequence, -1);
    assert.equal((await store.pendingRecords()).length, 2);

    await assert.rejects(store.acknowledgeThrough(2), /beyond the highest durably observed/);
    const state = await store.acknowledgeThrough(0);
    assert.equal(state.lastAcknowledgedSequence, 0);
    assert.equal(state.pendingCount, 1);
    assert.deepEqual((await store.pendingRecords()).map((item) => item.sourceSequence), [1]);

    await assert.rejects(store.acknowledgeThrough(2), /beyond the highest durably observed/);
    await store.acknowledgeThrough(1);
    assert.equal((await store.pendingRecords()).length, 0);
    assert.equal((await store.snapshot()).lastAcknowledgedSequence, 1);
  });
});

test("recovers a missing digest after a crash between journal append and ledger append", async () => {
  await withStore({}, async (store) => {
    const event = {
      id: "synthetic-interrupted-ledger",
      type: "user.message",
      timestamp: "2026-10-01T00:00:00Z",
      data: { content: "synthetic offline record" },
    };
    const [captured] = normalizeCopilotEvents([event], store.sessionId);
    await store.stage(captured);
    await writeFile(store.observedIdsPath, "");
    const reopened = new DurableSessionStore({
      sessionId: store.sessionId,
      stateRoot: dirname(store.directory),
    });
    await reopened.initialize();
    assert.equal((await reopened.snapshot()).pendingCount, 1);
    const digests = await reopened.observedEventDigests();
    assert.equal(digests.get(createHash("sha256").update(event.id).digest("hex")), captured.payloadDigest);
    assert.equal(digests.size, 1);
    await reopened.initialize();
    assert.equal((await reopened.observedEventDigests()).size, 1);
  });
});

test("refuses to repair a journal whose event digest conflicts with the ledger", async () => {
  await withStore({}, async (store) => {
    const [captured] = normalizeCopilotEvents([{
      id: "synthetic-conflict",
      type: "user.message",
      timestamp: "2026-10-01T00:00:00Z",
      data: { content: "synthetic conflicting record" },
    }], store.sessionId);
    await store.stage(captured);
    await writeFile(store.observedIdsPath, `${JSON.stringify({
      digest: createHash("sha256").update(captured.sourceEventId).digest("hex"),
      payloadDigest: "0".repeat(64),
    })}\n`);
    const reopened = new DurableSessionStore({
      sessionId: store.sessionId,
      stateRoot: dirname(store.directory),
    });
    await assert.rejects(reopened.initialize(), /Observed event digest conflicts with journal/);
  });
});

test("deduplicates concurrent replay and refuses cursor gaps", async () => {
  await withStore({}, async (store) => {
    const secondInstance = new DurableSessionStore({
      sessionId: "source-session",
      stateRoot: dirname(store.directory),
    });
    await secondInstance.initialize();
    const outcomes = await Promise.all([
      store.stage(record(0)),
      secondInstance.stage(record(0)),
    ]);
    assert.deepEqual(outcomes.map(({ status }) => status).sort(), ["already_queued", "staged"]);
    await assert.rejects(store.stage(record(2)), /Source sequence gap/);
    assert.equal((await store.pendingRecords()).length, 1);
  });
});

test("serializes remote operations across store instances sharing one session", async () => {
  await withStore({}, async (store) => {
    const secondInstance = new DurableSessionStore({
      sessionId: "source-session",
      stateRoot: dirname(store.directory),
    });
    let enterFirst;
    let releaseFirst;
    let secondEntered = false;
    const firstEntered = new Promise((resolve) => {
      enterFirst = resolve;
    });
    const firstGate = new Promise((resolve) => {
      releaseFirst = resolve;
    });
    const firstOperation = store.withRemoteLease(async () => {
      enterFirst();
      await firstGate;
    });
    await firstEntered;
    const secondOperation = secondInstance.withRemoteLease(async () => {
      secondEntered = true;
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(secondEntered, false);
    releaseFirst();
    await Promise.all([firstOperation, secondOperation]);
    assert.equal(secondEntered, true);
  });
});

test("serializes competing worker processes on the same session partition", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ov-copilot-process-lock-"));
  const worker = fileURLToPath(new URL("../test-support/store-worker.mjs", import.meta.url));
  try {
    const store = new DurableSessionStore({
      sessionId: "source-session",
      stateRoot: directory,
    });
    await store.initialize();
    const runWorker = () =>
      new Promise((resolve, reject) => {
        const child = spawn(
          process.execPath,
          [worker, "source-session", directory, "0", "event-0"],
          { stdio: ["ignore", "pipe", "pipe"] },
        );
        let stdout = "";
        let stderr = "";
        child.stdout.setEncoding("utf8").on("data", (chunk) => {
          stdout += chunk;
        });
        child.stderr.setEncoding("utf8").on("data", (chunk) => {
          stderr += chunk;
        });
        child.once("error", reject);
        child.once("exit", (code) => {
          if (code !== 0) {
            reject(new Error(`worker exited ${code}: ${stderr}`));
            return;
          }
          try {
            resolve(JSON.parse(stdout));
          } catch (error) {
            reject(error);
          }
        });
      });

    const results = await Promise.all([runWorker(), runWorker()]);
    assert.deepEqual(
      results.map(({ status }) => status).sort(),
      ["already_queued", "staged"],
    );
    assert.equal((await store.pendingRecords()).length, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("isolates several simultaneous Copilot windows while de-duplicating a shared partition", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ov-copilot-multi-window-"));
  const worker = fileURLToPath(new URL("../test-support/store-worker.mjs", import.meta.url));
  const runWorker = (sessionId, sequence, eventId) =>
    new Promise((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [worker, sessionId, directory, String(sequence), eventId],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8").on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr.setEncoding("utf8").on("data", (chunk) => {
        stderr += chunk;
      });
      child.once("error", reject);
      child.once("exit", (code) => {
        if (code !== 0) {
          reject(new Error(`worker exited ${code}: ${stderr}`));
          return;
        }
        try {
          resolve(JSON.parse(stdout));
        } catch (error) {
          reject(error);
        }
      });
    });
  try {
    const results = await Promise.all([
      ...Array.from({ length: 6 }, () => runWorker("shared-session", 0, "shared-event")),
      ...Array.from({ length: 4 }, (_, index) =>
        runWorker(`window-session-${index}`, 0, `window-event-${index}`),
      ),
    ]);
    assert.equal(results.filter(({ status }) => status === "staged").length, 5);
    assert.equal(results.filter(({ status }) => status === "already_queued").length, 5);

    const shared = new DurableSessionStore({ sessionId: "shared-session", stateRoot: directory });
    const sharedSnapshot = await shared.snapshot();
    assert.equal(sharedSnapshot.pendingCount, 1);
    assert.equal(sharedSnapshot.lastObservedSequence, 0);

    for (let index = 0; index < 4; index += 1) {
      const windowStore = new DurableSessionStore({
        sessionId: `window-session-${index}`,
        stateRoot: directory,
      });
      const [windowRecord] = await windowStore.pendingRecords();
      assert.equal(windowRecord.sourceEventId, `window-event-${index}`);
      assert.equal(windowRecord.sourceSequence, 0);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("recovers an append that completed before its state cursor was written", async () => {
  await withStore({}, async (store) => {
    await writeFile(store.journalPath, `${JSON.stringify(record(0))}\n`, "utf8");
    const recovered = await store.initialize();
    assert.equal(recovered.lastObservedSequence, 0);
    assert.equal(recovered.pendingCount, 1);
    assert.equal((await store.pendingRecords())[0].sourceEventId, "event-0");
    const state = JSON.parse(await readFile(store.statePath, "utf8"));
    assert.equal(state.lastObservedSequence, 0);
  });
});

test("enforces queue caps without evicting existing records", async () => {
  await withStore({ maxRecords: 1 }, async (store) => {
    await store.stage(record(0));
    await assert.rejects(store.stage(record(1)), /record limit reached/);
    assert.deepEqual((await store.pendingRecords()).map((item) => item.sourceSequence), [0]);
  });
  await withStore({ maxQueueBytes: 1 }, async (store) => {
    await assert.rejects(store.stage(record(0)), /byte limit reached/);
    assert.equal((await store.pendingRecords()).length, 0);
  });
});

test("dead letters remain in the sequence and block acknowledgement beyond the gap", async () => {
  await withStore({}, async (store) => {
    await store.stage(record(0));
    await store.stage(record(1));
    assert.deepEqual(
      await store.markDeadLetter(0, {
        category: "terminal",
        status: 422,
        message: "invalid synthetic fixture; authorization=Bearer top-secret",
      }),
      { status: "dead_lettered" },
    );
    await store.stage(record(2));
    assert.deepEqual(
      (await store.snapshot()).deadLetterSequences,
      [0],
    );
    await assert.rejects(store.acknowledgeThrough(1), /dead-letter sequence 0/);
    assert.deepEqual(
      (await store.pendingRecords()).map((item) => item.sourceSequence),
      [1, 2],
    );
    assert.equal((await store.deadLetters())[0].failure.status, 422);
    assert.equal(
      JSON.stringify(await store.deadLetters()).includes("*".repeat(6)),
      false,
    );
  });
});

test("retries a dead-letter record without losing its sequence or payload", async () => {
  await withStore({}, async (store) => {
    await store.stage(record(0));
    await store.stage(record(1));
    await store.markDeadLetter(0, {
      category: "schema",
      status: 422,
      message: "invalid synthetic fixture",
    });

    assert.deepEqual(await store.retryDeadLetter(0), {
      status: "retried",
      sequence: 0,
    });
    assert.deepEqual(
      (await store.pendingRecords()).map((item) => item.sourceSequence),
      [0, 1],
    );
    assert.deepEqual(await store.deadLetters(), []);
    assert.equal((await store.pendingRecords())[0].payload.text, "message-0");
    await store.acknowledgeThrough(1);
    assert.equal((await store.snapshot()).lastAcknowledgedSequence, 1);
  });
});

test("rejects retrying a sequence that is not dead-lettered", async () => {
  await withStore({}, async (store) => {
    await assert.rejects(store.retryDeadLetter(0), /was not found/);
    await store.stage(record(0));
    await assert.rejects(store.retryDeadLetter(0), /was not found/);
  });
});

test("discards a dead-letter payload using a durable sequence tombstone", async () => {
  await withStore({}, async (store) => {
    await store.stage(record(0));
    await store.stage(record(1));
    await store.stage(record(2));
    await store.markDeadLetter(1, {
      category: "schema",
      status: 422,
      message: "invalid synthetic fixture",
    });

    assert.deepEqual(await store.discardDeadLetter(1), {
      status: "discarded",
      sequence: 1,
    });
    assert.equal((await store.deadLetters()).length, 0);
    assert.deepEqual(
      (await store.pendingRecords()).map((item) => item.sourceSequence),
      [0, 2],
    );
    assert.equal((await store.snapshot()).lastResolvedSequence, -1);
    assert.deepEqual(
      (await store.exportRecoveryBundle()).discarded.map((entry) => entry.sourceSequence),
      [1],
    );
    assert.equal(
      JSON.stringify(await store.exportRecoveryBundle()).includes("message-1"),
      false,
    );

    await store.acknowledgeThrough(0);
    const resolved = await store.acknowledgeThrough(2);
    assert.equal(resolved.lastAcknowledgedSequence, 2);
    assert.equal(resolved.lastResolvedSequence, 2);
    assert.equal(resolved.pendingCount, 0);
    assert.deepEqual((await store.snapshot()).discardedSequences, [1]);
  });
});

test("recovers a tombstone written before dead-letter cleanup and cursor update", async () => {
  await withStore({}, async (store) => {
    const original = record(0);
    await store.stage(original);
    await store.markDeadLetter(0, {
      category: "schema",
      status: 422,
      message: "invalid synthetic fixture",
    });
    const tombstone = {
      sourceSequence: 0,
      sourceEventDigest: createHash("sha256").update(original.sourceEventId).digest("hex"),
      payloadDigest: createHash("sha256")
        .update(JSON.stringify(original.payload))
        .digest("hex"),
      discardedAt: new Date().toISOString(),
    };
    await writeFile(store.discardedPath, `${JSON.stringify(tombstone)}\n`, "utf8");

    const recovered = await store.snapshot();
    assert.equal(recovered.lastResolvedSequence, 0);
    assert.equal(recovered.deadLetterCount, 0);
    assert.equal(recovered.discardedCount, 1);
    assert.equal((await readFile(store.deadLetterPath, "utf8")).trim(), "");
  });
});

test("migrates persisted state without a resolved-sequence cursor", async () => {
  await withStore({}, async (store) => {
    await store.stage(record(0));
    await store.acknowledgeThrough(0);
    const state = JSON.parse(await readFile(store.statePath, "utf8"));
    delete state.lastResolvedSequence;
    await writeFile(store.statePath, `${JSON.stringify(state)}\n`, "utf8");

    const migrated = await store.snapshot();
    assert.equal(migrated.lastAcknowledgedSequence, 0);
    assert.equal(migrated.lastResolvedSequence, 0);
  });
});

test("does not retry a discarded sequence", async () => {
  await withStore({}, async (store) => {
    await store.stage(record(0));
    await store.markDeadLetter(0, {
      category: "schema",
      status: 422,
      message: "invalid synthetic fixture",
    });
    await store.discardDeadLetter(0);
    assert.deepEqual(await store.stage(record(0)), {
      status: "already_acknowledged",
    });
    await assert.rejects(store.retryDeadLetter(0), /was not found/);
    assert.equal((await store.snapshot()).lastResolvedSequence, 0);
  });
});

test("does not confuse session IDs or accept malformed records", async () => {
  await withStore({}, async (store) => {
    await assert.rejects(store.stage({ ...record(0), sourceSessionId: "other-session" }), /does not match/);
    await assert.rejects(store.stage({ ...record(-1) }), /non-negative sourceSequence/);
  });
});
