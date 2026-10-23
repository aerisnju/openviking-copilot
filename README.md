# OpenViking for GitHub Copilot

Deep OpenViking memory integration for the local GitHub Copilot App and CLI.

This repository is currently in **Phase 1 runtime integration**. It contains a
Copilot SDK extension entry point, OpenViking session adapter, crash-recoverable
local journal, retry classification, and guarded test-namespace utilities.
Adapter behavior is covered by mocked HTTP tests. A restricted cloud-integration
mode is available for an explicitly authorized, isolated session and peer; no
unrestricted remote writes are part of the normal configuration.

## Goals

- Recall relevant OpenViking context before each Copilot prompt.
- Capture user, assistant, and tool activity without duplicating events.
- Flush and commit memory before compaction and at session shutdown.
- Expose the complete OpenViking MCP tool surface without copying server schemas.
- Recover safely from extension reloads, offline periods, `/clear`, and crashes.
- Keep Copilot usable when OpenViking is unavailable.

## Proposed integration

The design uses three cooperating adapters:

1. A user-level Copilot SDK extension as the primary runtime.
2. A minimal configured hook for lifecycle points not exposed as blocking SDK hooks.
3. The official OpenViking stdio-to-HTTP MCP proxy for active tools.

See [Design overview](docs/design-overview.md) for the architecture and
[Decision log](docs/decision-log.md) for the approved baseline.

The vendored OpenViking shared modules are pinned to a source commit and include
their upstream license and checksum manifest. The project owner has accepted the
AGPL-3.0 reuse direction subject to compliance review; no legal review is implied.

The extension currently injects profile and per-prompt recall context, captures
live user-visible events into the local journal, replays queued messages in
order with bounded exponential retry scheduling, and commits at session end
only when no pending or dead-lettered record blocks the sequence. It also
registers the official OpenViking stdio-to-HTTP MCP proxy when installed, using
the absolute Node executable recorded by the installer. It does not replay
historical Copilot events. The installer registers an owned `preCompact` hook.
The hook now audits a session-scoped Copilot transcript against hashed IDs and
payload digests of durably captured events before committing; if the transcript
or current compaction boundary cannot be verified, it skips the commit and
preserves queued data rather than claiming complete capture. When the host has
already written an event the extension had not yet journaled, the hook journals
that small tail from the transcript and re-audits before committing; a gap
larger than 16 events is refused as historical replay rather than guessed at.
Older sessions without this digest ledger cannot pass the audit retroactively.
Adapter tests use mock HTTP. A reversible normal-profile host smoke test ran
with memory and OpenViking MCP locked off; a subsequent authorized normal-profile
installation enabled memory. A small synthetic CLI session confirmed local
capture acknowledgement and an OpenViking commit. This is a controlled trial,
not cross-session or production acceptance.
The pre-tool hook prevents supported local file tools from treating
`viking://` paths as filesystem paths and gives shell commands a non-blocking
notice when such a URI appears. For a controlled cloud test, see the
[isolated integration mode](docs/configuration-security.md#isolated-cloud-integration-mode);
it suppresses recall/profile reads and MCP tools, and refuses to write until a
session's restricted peer-only policy is confirmed.

## Approving the extension

OpenViking's MCP tools are registered dynamically by the extension at session
time, so they only appear where the extension actually loaded. In a fresh
directory (or any prompt-mode `-p` run) Copilot asks before loading a
user-level extension that registers hooks; if it is not approved, automatic
recall/capture and the OpenViking MCP tools are all absent from that session and
nothing is written. Approve once with "Yes" for that session, or "Yes, and
always allow" to skip the prompt in that directory. This is normal host
behavior, not a fault in the integration: the same session that shows no
`openviking` tools is one where the extension never ran. The MCP proxy itself is
healthy independently — a direct stdio handshake returns `openviking-mcp` with
14 tools including `health`.

A second, subtler state exists even when the extension *is* approved: the host
projects the MCP tool catalog asynchronously, so a session can report the MCP
server as connected while its tools are still missing from the model's tool
list, resolving only on a later reload/resume. The extension now detects this at
session start and asks the host to reload once; look for `mcp-tools-projected`
with `available: true` in the extension log to confirm the tools reached the
model. If tools seem missing, a resume/reload is the first thing to try before
suspecting the approval.

Subagent event capture is separately **off by default**. Set
`OPENVIKING_COPILOT_SUBAGENT_MEMORY=true` before launching Copilot to opt in.
The extension then archives each child's visible messages and tools in a
separate OpenViking session and commits it when Copilot reports the child
complete. Child sessions allow only peer preference memory
(`self=false`, `working_memory=false`, automatic commit disabled); this feature
does not inject recalled context into child prompts. Local diagnostics report
orphaned sessions and commits with unknown outcomes, which are not retried
automatically. See
[subagent capture and recovery](docs/configuration-security.md#subagent-memory-capture).

Install or remove the user extension from the repository root with:

```sh
npm run install:copilot -- --dry-run
npm run install:copilot -- --dry-run --host-smoke-only
npm run install:copilot -- --host-smoke-only
npm run install:copilot
npm run uninstall:copilot
npm run diagnostics:copilot -- status
npm run diagnostics:copilot -- summary
npm run diagnostics:copilot -- gc
npm run diagnostics:copilot -- gc --apply
npm run diagnostics:copilot -- health
npm run diagnostics:copilot -- doctor
npm run diagnostics:copilot -- setup
```

The installer copies only the runtime source and pinned shared modules into
`~/.copilot/extensions/openviking-memory`. It refuses to overwrite a non-empty
extension directory without this project's ownership marker. It does not
change Copilot settings; it also writes an ownership-tagged `preCompact` hook
configuration. Installation requires Copilot CLI `1.0.95-3` or newer and
supports `--dry-run` for a non-mutating version/ownership check. Upgrades stage
both owned targets and restore the old targets after an in-process replacement
failure; abrupt termination between target renames is not automatically
recovered. If an interrupted run leaves a UUID-suffixed owned staging or backup
artifact, install, dry-run, and uninstall refuse to proceed and preserve it for
manual recovery; do not delete a backup without inspecting the affected targets.
For a controlled host-only trial, `--host-smoke-only` persists a safety marker
in the installed extension: memory initialization/capture/recall/commit and
OpenViking MCP registration are disabled regardless of the user's normal
OpenViking configuration. The installed `preCompact` hook also skips without
reading a session or connecting to OpenViking. To enable actual integration,
reinstall without that flag after separately approving remote memory access;
uninstall removes the marker with the owned extension and hook.

Local queue status is available through `diagnostics:copilot status` (or add
`--json` for machine-readable counts). `diagnostics:copilot gc` surveys every
local partition and reports which ones can be removed; nothing is deleted until
you add `--apply`. A partition is only eligible when it holds no pending or
dead-lettered records **and** its remote session is gone; an unknown remote is
treated as present, and a recently active session is kept. Use
`--keep <session-id>` to protect an additional session explicitly.

`diagnostics:copilot health` reports a health verdict per session derived from
durable local state and remote session metadata — pending and dead-letter
counts, whether the remote session still exists, idle days, and commit recency —
rather than from host logs, which rotate in about three days. An undeterminable
remote is reported as unknown, not as a failure. The command exits non-zero only
when a session reports an error (dead letters). To export a specific session's pending
and dead-letter records for recovery, use
`diagnostics:copilot export --session <copilot-session-id> --output <new-file>`.
Exports contain conversation data, are created without overwriting an existing
file, and should be treated as sensitive. Diagnostics do not contact OpenViking.
`doctor` resolves the same local configuration as the extension, reports only
sanitized effective settings, and performs no network request. `setup` opens
the upstream interactive configuration wizard; it shows a masked API key and
asks before writing `ovcli.conf`, making a timestamped backup first.
The upstream `captureFilters` and `recallQueryFilters` settings are honored;
capture filters operate on visible user/assistant text, not structured tool
arguments or results. The doctor omits URL paths, query strings, and fragments
from its sanitized endpoint display. Tool result content is off by default and
can be enabled with `captureToolResults`; tool names and arguments are still
captured. Recall context has an additional local CJK-aware token cap.
`diagnostics:copilot summary --json` gives aggregate local queue counts and
bytes without session IDs or conversation payloads.
To retry one dead-letter after correcting its cause, run
`node scripts/diagnostics.mjs retry --session <copilot-session-id> --sequence <n>`.
This moves the unchanged record back to the pending queue; the next capture
flush retries it. It is local-only and does not send a request immediately.
To permanently drop a dead-letter after reviewing the recovery export, specify
its exact sequence and the explicit confirmation flag:
`node scripts/diagnostics.mjs discard --session <copilot-session-id> --sequence <n> --confirm-data-loss`.
This deletes the queued conversation payload and leaves a digest-only tombstone;
subsequent commits may proceed past the intentionally omitted sequence.

## Design documents

- [Design overview](docs/design-overview.md)
- [Known limitations](docs/known-limitations.md)
- [Release strategy](docs/release-strategy.md)
- [Copilot host contract](docs/host-contract.md)
- [Persistence and recovery](docs/persistence-recovery.md)
- [Configuration and security](docs/configuration-security.md)
- [Verification strategy](docs/verification.md)
- [Decision log](docs/decision-log.md)
- [Phase 0 host probe results](docs/probe-results.md)

## Current scope

The first implementation target is the local Copilot App/CLI on Windows, while
keeping the adapter portable to macOS and Linux. Copilot cloud-agent support is
a separate deployment target because it cannot load a user's local extension.
