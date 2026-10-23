import { randomUUID } from "node:crypto";
import { link, open, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  exportLocalSessionRecoveryBundle,
  discardLocalSessionDeadLetter,
  listLocalSessionDiagnostics,
  retryLocalSessionDeadLetter,
  summarizeLocalSessionDiagnostics,
} from "../src/local-diagnostics.mjs";
import { diagnoseOpenVikingConfig } from "../src/config-doctor.mjs";
import { collectPartitions, surveyPartitions } from "../src/session-gc.mjs";
import { buildHealthReport } from "../src/runtime-health.mjs";
import { runSetupWizard } from "../vendor/openviking-memory-plugin-shared/lib/setup-wizard.mjs";

function usage() {
  process.stderr.write(
    "Usage:\n"
      + "  node scripts/diagnostics.mjs doctor [--json] [--cwd <workspace>]\n"
      + "  node scripts/diagnostics.mjs setup\n"
      + "  node scripts/diagnostics.mjs status [--json]\n"
      + "  node scripts/diagnostics.mjs summary [--json]\n"
      + "  node scripts/diagnostics.mjs gc [--json] [--apply] [--keep <session-id>...]\n"
      + "  node scripts/diagnostics.mjs health [--json]\n"
      + "  node scripts/diagnostics.mjs retry --session <copilot-session-id> --sequence <n>\n"
      + "  node scripts/diagnostics.mjs discard --session <copilot-session-id> --sequence <n> --confirm-data-loss\n"
      + "  node scripts/diagnostics.mjs export --session <copilot-session-id> --output <new-file>\n",
  );
}

function option(args, name) {
  const index = args.indexOf(name);
  if (index === -1 || index + 1 >= args.length) {
    throw new Error(`Missing required ${name} option`);
  }
  return args[index + 1];
}

function doctorOptions(args) {
  const options = { json: false, cwd: process.cwd() };
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--json") {
      options.json = true;
    } else if (args[index] === "--cwd" && args[index + 1]) {
      options.cwd = resolve(args[++index]);
    } else {
      throw new Error(`Unexpected doctor option: ${args[index]}`);
    }
  }
  return options;
}

/**
 * A remote-existence probe for GC. Diagnostics are local-only by design, so
 * this only runs for `gc` and only when credentials are already configured;
 * any failure resolves to "unknown", which GC treats as "present" (keep).
 */
async function makeRemoteExistsProbe() {
  try {
    const { buildPluginConfig } = await import(
      "../vendor/openviking-memory-plugin-shared/lib/plugin-config.mjs"
    );
    const { makeAgentFetchJSON } = await import(
      "../vendor/openviking-memory-plugin-shared/lib/agent-hook-runtime.mjs"
    );
    const config = buildPluginConfig("copilot", { cwd: process.cwd() });
    if (!config?.baseUrl) return async () => null;
    const { fetchJSON } = makeAgentFetchJSON(config, process.cwd());
    return async (sessionId) => {
      const response = await fetchJSON(
        `/api/v1/sessions/${encodeURIComponent(sessionId)}`,
        {},
        { timeoutMs: 5_000 },
      );
      if (Number(response?.status) === 404) return false;
      if (response?.ok === true) return true;
      return null;
    };
  } catch {
    return async () => null;
  }
}

function printStatus(sessions, json) {
  if (json) {
    process.stdout.write(`${JSON.stringify(sessions, null, 2)}\n`);
    return;
  }
  if (sessions.length === 0) {
    process.stdout.write("No local OpenViking Copilot session state found.\n");
    return;
  }
  for (const session of sessions) {
    if (session.status === "unreadable") {
      process.stdout.write(
        `${session.stateDirectoryId}: unreadable (${session.error})\n`,
      );
      continue;
    }
    process.stdout.write(
      `${session.sessionId}: ${session.status}; pending=${session.pendingCount}`
        + ` (${session.pendingBytes} bytes); dead-letter=${session.deadLetterCount}`
        + ` [${session.deadLetterSequences.join(",")}]; ack=${session.lastAcknowledgedSequence}`
      + `; resolved=${session.lastResolvedSequence}; discarded=${session.discardedCount}`
    + `; observed=${session.lastObservedSequence}; subagents=${session.subagentSessions?.length || 0}`
    + ` (${session.subagentSessions?.filter((child) => child.status === "orphaned" || child.status === "commit_unknown").length || 0} need recovery)`
    + `; updated=${session.updatedAt}\n`,
    );
  }
}

function printSummary(summary, json) {
  if (json) {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    return;
  }
  process.stdout.write(
    `Local queue summary: sessions=${summary.sessionCount}`
      + ` (clear=${summary.clearSessionCount}, pending=${summary.pendingSessionCount}`
      + `, blocked=${summary.blockedSessionCount}, unreadable=${summary.unreadableSessionCount})\n`
      + `Pending=${summary.pendingRecordCount} records (${summary.pendingBytes} bytes); `
      + `dead-letter=${summary.deadLetterRecordCount} records; `
      + `discarded=${summary.discardedRecordCount} records; `
      + `subagents=${summary.subagentSessionCount} `
      + `(${summary.subagentRecoveryRequiredCount} need recovery).\n`,
  );
}

async function writeNewFileAtomically(path, contents) {
  const temporary = resolve(dirname(path), `.${randomUUID()}.tmp`);
  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(contents, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await link(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

try {
  const [command, ...args] = process.argv.slice(2);
  if (command === "doctor") {
    const options = doctorOptions(args);
    const report = diagnoseOpenVikingConfig({
      cwd: options.cwd,
      env: process.env,
    });
    if (options.json) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    } else {
      process.stdout.write(
        `OpenViking configuration: ${report.status} (${report.mode})\n`
          + `Server: ${report.server.endpoint} via ${report.server.transport}\n`
          + `Authentication: ${report.server.authMode}; API key configured: ${report.server.apiKeyConfigured} (${report.server.apiKeySource})\n`
          + `Recall: ${report.behavior.autoRecall ? "on" : "off"}; capture: ${report.behavior.autoCapture ? "on" : "off"}\n`,
      );
      for (const issue of report.issues) {
        process.stdout.write(
          `${issue.severity.toUpperCase()} ${issue.code}: ${issue.message}`
            + `${issue.action ? ` Action: ${issue.action}` : ""}\n`,
        );
      }
    }
    if (report.status === "error") process.exitCode = 1;
  } else if (command === "setup") {
    if (args.length) throw new Error(`Unexpected setup option: ${args[0]}`);
    await runSetupWizard();
  } else if (command === "status") {
    const unexpected = args.filter((arg) => arg !== "--json");
    if (unexpected.length > 0) throw new Error(`Unexpected option: ${unexpected[0]}`);
    printStatus(
      await listLocalSessionDiagnostics({
        stateRoot: process.env.OPENVIKING_COPILOT_STATE_DIR,
      }),
      args.includes("--json"),
    );
  } else if (command === "summary") {
    const unexpected = args.filter((arg) => arg !== "--json");
    if (unexpected.length > 0) throw new Error(`Unexpected option: ${unexpected[0]}`);
    const sessions = await listLocalSessionDiagnostics({
      stateRoot: process.env.OPENVIKING_COPILOT_STATE_DIR,
    });
    printSummary(summarizeLocalSessionDiagnostics(sessions), args.includes("--json"));
  } else if (command === "gc") {
    const apply = args.includes("--apply");
    const json = args.includes("--json");
    const keep = [];
    for (let index = 0; index < args.length; index += 1) {
      if (args[index] === "--keep" && args[index + 1]) keep.push(args[++index]);
      else if (!["--apply", "--json", "--keep"].includes(args[index])) {
        throw new Error(`Unexpected gc option: ${args[index]}`);
      }
    }
    const stateRoot = process.env.OPENVIKING_COPILOT_STATE_DIR;
    const remoteExists = await makeRemoteExistsProbe();
    if (!apply) {
      const surveyed = await surveyPartitions({ stateRoot, remoteExists });
      if (json) {
        process.stdout.write(`${JSON.stringify({ apply: false, partitions: surveyed }, null, 2)}\n`);
      } else {
        const eligible = surveyed.filter((entry) => entry.eligible);
        process.stdout.write(
          `Dry run: ${surveyed.length} partition(s), ${eligible.length} eligible for removal.\n`,
        );
        for (const entry of surveyed) {
          process.stdout.write(
            `  ${entry.sessionId}: ${entry.eligible ? "removable" : "keep"}`
              + ` (${entry.reason}); observed=${entry.observedSequence ?? "n/a"}`
              + ` pending=${entry.pendingCount ?? "n/a"} dead-letter=${entry.deadLetterCount ?? "n/a"}`
              + ` idleDays=${entry.idleDays ?? "n/a"}\n`,
          );
        }
        if (eligible.length > 0) {
          process.stdout.write("Re-run with --apply to remove the eligible partitions.\n");
        }
      }
    } else {
      const result = await collectPartitions({ stateRoot, remoteExists, keepSessionIds: keep });
      if (json) process.stdout.write(`${JSON.stringify({ apply: true, ...result }, null, 2)}\n`);
      else {
        process.stdout.write(`Removed ${result.removed.length} partition(s).\n`);
        for (const entry of result.removed) process.stdout.write(`  removed ${entry.sessionId} (${entry.reason})\n`);
        for (const entry of result.kept) process.stdout.write(`  kept ${entry.sessionId} (${entry.reason})\n`);
      }
    }
  } else if (command === "health") {
    const unexpected = args.filter((arg) => arg !== "--json");
    if (unexpected.length > 0) throw new Error(`Unexpected option: ${unexpected[0]}`);
    const probe = await makeRemoteExistsProbe();
    const remoteSession = async (sessionId) => {
      const exists = await probe(sessionId);
      if (exists === null) return null;
      if (exists === false) return { exists: false };
      return { exists: true };
    };
    const report = await buildHealthReport({
      stateRoot: process.env.OPENVIKING_COPILOT_STATE_DIR,
      remoteSession,
    });
    if (args.includes("--json")) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    } else {
      process.stdout.write(`Runtime health: ${report.status}\n`);
      for (const session of report.sessions) {
        const issues = session.issues?.length
          ? session.issues.map((issue) => `${issue.severity}:${issue.code}`).join(",")
          : "none";
        process.stdout.write(
          `  ${session.sessionId}: ${session.status}; observed=${session.observedSequence ?? "n/a"}`
            + ` pending=${session.pendingCount ?? "n/a"} dead-letter=${session.deadLetterCount ?? "n/a"}`
            + ` idleDays=${session.idleDays ?? "n/a"} remote=${session.remoteExists === null ? "unknown" : session.remoteExists}`
            + `; issues=${issues}\n`,
        );
      }
    }
    if (report.status === "error") process.exitCode = 1;
  } else if (command === "retry") {
    const sessionId = option(args, "--session");
    const sequenceText = option(args, "--sequence");
    if (args.length !== 4 || !/^(0|[1-9]\d*)$/.test(sequenceText)) {
      throw new Error("Retry requires --session and a non-negative --sequence");
    }
    const sequence = Number(sequenceText);
    if (!Number.isSafeInteger(sequence)) {
      throw new Error("Retry sequence must be a safe integer");
    }
    const result = await retryLocalSessionDeadLetter({
      sessionId,
      sequence,
      stateRoot: process.env.OPENVIKING_COPILOT_STATE_DIR,
    });
    process.stdout.write(
      `Dead-letter sequence ${result.sequence} returned to the pending queue.`
        + " It will be retried on the next capture flush.\n",
    );
  } else if (command === "discard") {
    const sessionId = option(args, "--session");
    const sequenceText = option(args, "--sequence");
    if (
        args.length !== 5 ||
        !/^(0|[1-9]\d*)$/.test(sequenceText) ||
        !args.includes("--confirm-data-loss")
    ) {
        throw new Error(
          "Discard requires --session, a non-negative --sequence, and --confirm-data-loss",
        );
    }
    const sequence = Number(sequenceText);
    if (!Number.isSafeInteger(sequence)) {
        throw new Error("Discard sequence must be a safe integer");
    }
    const result = await discardLocalSessionDeadLetter({
        sessionId,
        sequence,
        stateRoot: process.env.OPENVIKING_COPILOT_STATE_DIR,
    });
    process.stdout.write(
        `Dead-letter sequence ${result.sequence} was discarded locally.`
          + " Its payload was deleted; a digest-only tombstone records the intentional gap.\n",
    );
  } else if (command === "export") {
    const sessionId = option(args, "--session");
    const outputPath = resolve(option(args, "--output"));
    if (args.length !== 4) throw new Error("Unexpected export arguments");
    const bundle = await exportLocalSessionRecoveryBundle({
      sessionId,
      stateRoot: process.env.OPENVIKING_COPILOT_STATE_DIR,
    });
    await writeNewFileAtomically(outputPath, `${JSON.stringify(bundle, null, 2)}\n`);
    process.stdout.write(
      `Recovery bundle exported to ${outputPath}; it contains conversation records and should be treated as sensitive.\n`,
    );
  } else {
    usage();
    process.exitCode = 2;
  }
} catch (error) {
  process.stderr.write(`OpenViking Copilot diagnostics failed: ${error.message}\n`);
  usage();
  process.exitCode = 1;
}
