import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import test from "node:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  discardLocalSessionDeadLetter,
  exportLocalSessionRecoveryBundle,
  listLocalSessionDiagnostics,
  retryLocalSessionDeadLetter,
  summarizeLocalSessionDiagnostics,
} from "../src/local-diagnostics.mjs";
import { diagnoseOpenVikingConfig } from "../src/config-doctor.mjs";
import { DurableSessionStore } from "../src/durable-session-store.mjs";
import { normalizeCopilotEvents } from "../src/event-normalizer.mjs";

const sessionId = "local-diagnostics-session";
const execFileAsync = promisify(execFile);
const diagnosticsScript = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "scripts",
  "diagnostics.mjs",
);

async function withConfig(content, run) {
  const root = await mkdtemp(join(tmpdir(), "ov-copilot-config-"));
  const cliPath = join(root, "ovcli.conf");
  const ovPath = join(root, "ov.conf");
  try {
    await writeFile(cliPath, JSON.stringify(content), "utf8");
    await writeFile(ovPath, "{}", "utf8");
    await run({
      root,
      env: {
        ...Object.fromEntries(
          Object.entries(process.env).filter(([name]) => !name.startsWith("OPENVIKING_")),
        ),
        OPENVIKING_CLI_CONFIG_FILE: cliPath,
        OPENVIKING_CONFIG_FILE: ovPath,
      },
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("doctor uses shared config resolution but never exposes credential values or contacts the server", async () => {
  await withConfig({
    url: "https://user:password@example.test/api?access_token=hidden",
    api_key: "secret-api-key-value",
    plugin: {
      copilot: {
        autoRecall: false,
        autoCapture: true,
        captureToolResults: false,
      },
    },
  }, async ({ root, env }) => {
    const report = diagnoseOpenVikingConfig({ cwd: root, env });
    const serialized = JSON.stringify(report);
    assert.equal(report.mode, "local-only");
    assert.equal(report.server.endpoint, "https://example.test");
    assert.equal(report.server.apiKeyConfigured, true);
    assert.equal(report.server.apiKeySource, "ovcli");
    assert.equal(report.behavior.autoRecall, false);
    assert.equal(report.behavior.autoCapture, true);
    assert.equal(serialized.includes("password"), false);
    assert.equal(serialized.includes("hidden"), false);
    assert.equal(serialized.includes("secret-api-key-value"), false);
    assert.equal(report.issues.some((issue) => issue.code === "server_url_missing"), false);
  });
});

test("doctor flags missing server configuration and remote plaintext HTTP", async () => {
  await withConfig({}, async ({ root, env }) => {
    const report = diagnoseOpenVikingConfig({ cwd: root, env });
    assert.equal(report.status, "warning");
    assert.equal(report.issues.some((issue) => issue.code === "server_url_defaulted"), true);
    assert.equal(report.server.transport, "http-loopback");
  });
  await withConfig({ url: "http://memory.example.test:1933", api_key: "secret" }, async ({ root, env }) => {
    const report = diagnoseOpenVikingConfig({ cwd: root, env });
    assert.equal(report.status, "error");
    assert.equal(report.server.endpointValid, false);
    assert.equal(report.issues[0].code, "server_url_invalid");
  });
});

test("doctor reports invalid filter counts without disclosing filter text", async () => {
  await withConfig({
    url: "https://openviking.example",
    plugin: { copilot: { captureFilters: ["this is secret invalid filter text"] } },
  }, async ({ root, env }) => {
    const report = diagnoseOpenVikingConfig({ cwd: root, env });
    assert.equal(report.status, "warning");
    assert.deepEqual(report.filters.find(({ key }) => key === "captureFilters"), {
      key: "captureFilters",
      total: 1,
      active: 0,
      invalid: 1,
    });
    assert.equal(JSON.stringify(report).includes("secret invalid filter text"), false);
  });
});

function event(id) {
  return {
    id,
    type: "user.message",
    timestamp: "2026-09-30T12:00:00Z",
    data: { content: "Sensitive conversation content.", messageId: id },
  };
}

test("lists local queue state without exposing journal payloads", async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "ov-copilot-diagnostics-"));
  try {
    const store = new DurableSessionStore({ sessionId, stateRoot });
    await store.initialize();
    await store.updateSubagentSession({
      agentIdHash: createHash("sha256").update("private-agent-id").digest("hex"),
      openVikingSessionId: "child-session-id",
      status: "orphaned",
      ownerPid: process.pid,
    });
    const [record] = normalizeCopilotEvents([event("queued-1")], sessionId);
    await store.stage(record);

    const sessions = await listLocalSessionDiagnostics({ stateRoot });
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].sessionId, sessionId);
    assert.equal(sessions[0].status, "pending");
    assert.equal(sessions[0].pendingCount, 1);
    assert.deepEqual(sessions[0].subagentSessions.map(({ status }) => status), ["orphaned"]);
    assert.equal(JSON.stringify(sessions).includes("Sensitive conversation"), false);
    assert.equal(JSON.stringify(sessions).includes("private-agent-id"), false);
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});

test("summarizes queue telemetry without including session IDs or message content", () => {
  const summary = summarizeLocalSessionDiagnostics([
    {
      status: "clear",
      pendingCount: 0,
      pendingBytes: 0,
      deadLetterCount: 0,
      sessionId: "private-session-id",
    },
    {
      status: "pending",
      pendingCount: 2,
      pendingBytes: 312,
      deadLetterCount: 0,
      sessionId: "another-private-id",
    },
    {
      status: "blocked",
      pendingCount: 1,
      pendingBytes: 128,
      deadLetterCount: 1,
    },
    { status: "unreadable", error: "InvalidState" },
  ]);
  assert.deepEqual(summary, {
    sessionCount: 3,
    clearSessionCount: 1,
    pendingSessionCount: 1,
    blockedSessionCount: 1,
    unreadableSessionCount: 1,
    pendingRecordCount: 3,
    pendingBytes: 440,
    deadLetterRecordCount: 1,
    discardedRecordCount: 0,
    subagentSessionCount: 0,
    subagentRecoveryRequiredCount: 0,
  });
  assert.equal(JSON.stringify(summary).includes("private-session-id"), false);
});

test("exports an explicit local recovery bundle including pending and dead-letter data", async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "ov-copilot-export-"));
  try {
    const store = new DurableSessionStore({ sessionId, stateRoot });
    await store.initialize();
    const [record] = normalizeCopilotEvents([event("queued-1")], sessionId);
    await store.stage(record);
    await store.markDeadLetter(0, {
      category: "schema",
      status: 422,
      message: "invalid payload",
    });

    const bundle = await exportLocalSessionRecoveryBundle({ sessionId, stateRoot });
    assert.equal(bundle.sessionId, sessionId);
    assert.equal(bundle.pending.length, 0);
    assert.equal(bundle.deadLetters.length, 1);
    assert.equal(
      bundle.deadLetters[0].record.payload.parts[0].text,
      "Sensitive conversation content.",
    );
    assert.equal(bundle.deadLetters[0].failure.message, "invalid payload");
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});

test("retries a selected dead-letter through the local diagnostics API", async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "ov-copilot-retry-"));
  try {
    const store = new DurableSessionStore({ sessionId, stateRoot });
    await store.initialize();
    const [record] = normalizeCopilotEvents([event("queued-1")], sessionId);
    await store.stage(record);
    await store.markDeadLetter(0, {
      category: "schema",
      status: 422,
      message: "invalid payload",
    });

    assert.deepEqual(
      await retryLocalSessionDeadLetter({ sessionId, sequence: 0, stateRoot }),
      { status: "retried", sequence: 0 },
    );
    assert.equal((await store.snapshot()).pendingCount, 1);
    assert.equal((await store.snapshot()).deadLetterCount, 0);
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});

test("discards a selected dead-letter through the local diagnostics API", async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "ov-copilot-discard-"));
  try {
    const store = new DurableSessionStore({ sessionId, stateRoot });
    await store.initialize();
    const [record] = normalizeCopilotEvents([event("queued-1")], sessionId);
    await store.stage(record);
    await store.markDeadLetter(0, {
      category: "schema",
      status: 422,
      message: "invalid payload",
    });

    assert.deepEqual(
      await discardLocalSessionDeadLetter({ sessionId, sequence: 0, stateRoot }),
      { status: "discarded", sequence: 0 },
    );
    const snapshot = await store.snapshot();
    assert.equal(snapshot.deadLetterCount, 0);
    assert.equal(snapshot.discardedCount, 1);
    assert.equal(snapshot.lastResolvedSequence, 0);
    assert.equal(
      JSON.stringify(await store.exportRecoveryBundle()).includes("Sensitive conversation"),
      false,
    );
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});

test("reports invalid state without returning its contents", async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "ov-copilot-invalid-state-"));
  const directoryId = createHash("sha256").update(sessionId).digest("hex");
  const sessionDirectory = join(stateRoot, directoryId);
  try {
    await mkdir(sessionDirectory);
    await writeFile(
      join(sessionDirectory, "state.json"),
      JSON.stringify({ sourceSessionId: sessionId, malformedSecret: "never report this" }),
    );

    const sessions = await listLocalSessionDiagnostics({ stateRoot });
    assert.deepEqual(sessions, [{
      stateDirectoryId: directoryId,
      status: "unreadable",
      error: "InvalidState",
    }]);
    assert.equal(JSON.stringify(sessions).includes("never report this"), false);
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});

test("diagnostics CLI reports counts and refuses to overwrite recovery exports", async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "ov-copilot-cli-"));
  const outputPath = join(stateRoot, "recovery.json");
  try {
    const store = new DurableSessionStore({ sessionId, stateRoot });
    await store.initialize();
    const [record] = normalizeCopilotEvents([event("queued-1")], sessionId);
    await store.stage(record);
    const env = {
      ...process.env,
      OPENVIKING_COPILOT_STATE_DIR: stateRoot,
    };

    const status = await execFileAsync(process.execPath, [
      diagnosticsScript,
      "status",
      "--json",
    ], { env });
    const parsedStatus = JSON.parse(status.stdout);
    assert.equal(parsedStatus[0].pendingCount, 1);
    assert.equal(status.stdout.includes("Sensitive conversation"), false);

    const summaryResult = await execFileAsync(process.execPath, [
      diagnosticsScript,
      "summary",
      "--json",
    ], { env });
    const parsedSummary = JSON.parse(summaryResult.stdout);
    assert.equal(parsedSummary.sessionCount, 1);
    assert.equal(parsedSummary.pendingRecordCount, 1);
    assert.equal(summaryResult.stdout.includes(sessionId), false);
    assert.equal(summaryResult.stdout.includes("Sensitive conversation"), false);

    const exported = await execFileAsync(process.execPath, [
      diagnosticsScript,
      "export",
      "--session",
      sessionId,
      "--output",
      outputPath,
    ], { env });
    assert.match(exported.stdout, /treated as sensitive/);
    const bundle = JSON.parse(await readFile(outputPath, "utf8"));
    assert.equal(bundle.pending[0].payload.parts[0].text, "Sensitive conversation content.");

    await assert.rejects(
      execFileAsync(process.execPath, [
        diagnosticsScript,
        "export",
        "--session",
        sessionId,
        "--output",
        outputPath,
      ], { env }),
      (error) => error.code === 1 && /EEXIST/.test(error.stderr),
    );
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});

test("diagnostics CLI retries only the requested dead-letter sequence", async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "ov-copilot-cli-retry-"));
  try {
    const store = new DurableSessionStore({ sessionId, stateRoot });
    await store.initialize();
    const first = normalizeCopilotEvents([event("queued-1")], sessionId)[0];
    const second = normalizeCopilotEvents([event("queued-2")], sessionId, {
      startSequence: 1,
    })[0];
    await store.stage(first);
    await store.stage(second);
    await store.markDeadLetter(0, {
      category: "schema",
      status: 422,
      message: "invalid payload",
    });
    const env = {
      ...process.env,
      OPENVIKING_COPILOT_STATE_DIR: stateRoot,
    };

    const result = await execFileAsync(process.execPath, [
      diagnosticsScript,
      "retry",
      "--session",
      sessionId,
      "--sequence",
      "0",
    ], { env });
    assert.match(result.stdout, /sequence 0 returned to the pending queue/);
    assert.deepEqual(
      (await store.pendingRecords()).map((item) => item.sourceSequence),
      [0, 1],
    );
    assert.deepEqual(await store.deadLetters(), []);
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});

test("diagnostics CLI requires explicit confirmation before discarding payload", async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "ov-copilot-cli-discard-"));
  try {
    const store = new DurableSessionStore({ sessionId, stateRoot });
    await store.initialize();
    const [record] = normalizeCopilotEvents([event("queued-1")], sessionId);
    await store.stage(record);
    await store.markDeadLetter(0, {
      category: "schema",
      status: 422,
      message: "invalid payload",
    });
    const env = {
      ...process.env,
      OPENVIKING_COPILOT_STATE_DIR: stateRoot,
    };
    const command = [
      diagnosticsScript,
      "discard",
      "--session",
      sessionId,
      "--sequence",
      "0",
    ];

    await assert.rejects(
      execFileAsync(process.execPath, command, { env }),
      (error) => error.code === 1 && /confirm-data-loss/.test(error.stderr),
    );
    assert.equal((await store.snapshot()).deadLetterCount, 1);

    const result = await execFileAsync(process.execPath, [
      ...command,
      "--confirm-data-loss",
    ], { env });
    assert.match(result.stdout, /payload was deleted/);
    const snapshot = await store.snapshot();
    assert.equal(snapshot.deadLetterCount, 0);
    assert.equal(snapshot.discardedCount, 1);
    assert.equal(snapshot.lastResolvedSequence, 0);
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});
