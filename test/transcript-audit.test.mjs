import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DurableSessionStore } from "../src/durable-session-store.mjs";
import { normalizeCopilotEvents } from "../src/event-normalizer.mjs";
import { auditPreCompactTranscript } from "../src/transcript-audit.mjs";

test("audits only durable visible events in a session-scoped transcript", async () => {
  const root = await mkdtemp(join(tmpdir(), "ov-copilot-transcript-"));
  const sessionId = "synthetic-session";
  const file = join(root, "session-state", sessionId, "events.jsonl");
  const store = new DurableSessionStore({ sessionId, stateRoot: join(root, "store") });
  const user = {
    id: "synthetic-user",
    type: "user.message",
    timestamp: "2026-10-01T00:00:00Z",
    data: { content: "Synthetic preference" },
  };
  const second = {
    id: "synthetic-assistant",
    type: "assistant.message",
    timestamp: "2026-10-01T00:00:01Z",
    data: { content: "Synthetic response" },
  };
  const ignored = {
    id: "synthetic-reasoning",
    type: "assistant.reasoning",
    timestamp: "2026-10-01T00:00:01Z",
    data: { content: "Never captured" },
  };
  const compaction = {
    id: "synthetic-compaction",
    type: "session.compaction_start",
    timestamp: "2026-10-01T00:00:02Z",
    data: { trigger: "manual" },
  };
  const config = { autoCapture: true };
  const input = { sessionId, transcriptPath: file, timestamp: Date.parse(compaction.timestamp) + 10 };
  try {
    await mkdir(join(root, "session-state", sessionId), { recursive: true });
    await store.initialize();
    await writeFile(file, [user, ignored, second, compaction].map((event) => JSON.stringify(event)).join("\n") + "\n");
    const [record] = normalizeCopilotEvents([user], sessionId);
    await store.stage(record);
    assert.deepEqual(
      await auditPreCompactTranscript(input, store, config, root),
      { ok: false, reason: "transcript-event-not-durable", checked: 2 },
    );
    const [secondRecord] = normalizeCopilotEvents([second], sessionId, { startSequence: 1 });
    await store.stage(secondRecord);
    await store.acknowledgeThrough(1);
    assert.deepEqual(await auditPreCompactTranscript(input, store, config, root), { ok: true, checked: 2 });
    await writeFile(file, [user, ignored, { ...second, data: { content: "Changed response" } }, compaction]
      .map((event) => JSON.stringify(event)).join("\n") + "\n");
    assert.deepEqual(
      await auditPreCompactTranscript(input, store, config, root),
      { ok: false, reason: "transcript-event-not-durable", checked: 2 },
    );
    await writeFile(file, [user, ignored, second, compaction].map((event) => JSON.stringify(event)).join("\n") + "\n");
    const digests = await store.observedEventDigests();
    assert.equal(digests.has(createHash("sha256").update(user.id).digest("hex")), true);
    assert.equal(digests.size, 2);
    await writeFile(file, [user, ignored, second, compaction, {
      id: "later-user",
      type: "user.message",
      timestamp: "2026-10-01T00:01:00Z",
      data: { content: "After compaction" },
    }].map((event) => JSON.stringify(event)).join("\n") + "\n");
    assert.deepEqual(await auditPreCompactTranscript(input, store, config, root), { ok: true, checked: 2 });
    assert.deepEqual(
      await auditPreCompactTranscript({ ...input, transcriptPath: join(root, "other.jsonl") }, store, config, root),
      { ok: false, reason: "transcript-path-unverified" },
    );
    await writeFile(file, [user, ignored, second, compaction].map((event) => JSON.stringify(event)).join("\n") + "\n");
    assert.deepEqual(
      await auditPreCompactTranscript({ ...input, timestamp: input.timestamp + 60_000 }, store, config, root),
      { ok: false, reason: "compaction-boundary-unverified" },
    );
    assert.deepEqual(
      await auditPreCompactTranscript({ ...input, timestamp: input.timestamp + 3_000 }, store, config, root),
      { ok: false, reason: "compaction-boundary-unverified" },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
