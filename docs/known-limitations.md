# Known limitations

These are behaviours the integration cannot change from inside Copilot, or
guarantees it deliberately does not make. They are recorded so they are not
mistaken for defects, and so a future host version that removes one can be
recognised as an improvement rather than a surprise.

## K-1: events the host had not written yet are invisible

**What happens.** The `preCompact` command can only see what is already in the
session transcript (`session-state/<sessionId>/events.jsonl`) at the moment it
runs. If Copilot writes an event to its transcript *after* the Hook starts, no
reader — extension, Hook, or transcript audit — can observe it, so it cannot be
archived by that compaction.

**Why it cannot be fixed locally.** The transcript is the host's own durable
record; there is no API that lets an extension read unflushed in-memory session
events, and the Hook is a separate short-lived process. Changing this ordering
would require the host to flush before invoking `preCompact`, or to expose a
"flush then notify" contract.

**What the integration does instead.** It closes the reachable part of the
window: events the host *had* already written are journaled by the bounded
catch-up (`src/transcript-catchup.mjs`) and then archived, up to 16 events per
compaction. A larger gap is refused as historical replay. So the residual loss
is bounded by "events written after the Hook began", not "everything the
extension had not yet seen".

**How to recognise it.** A compaction whose transcript audit passed still may
not contain events from the last few hundred milliseconds. There is no error;
this is expected. If exact tail completeness ever matters, the mitigation is to
stop typing briefly before `/compact` or to accept that the next commit picks
the events up.

**Related.** `docs/verification.md` H-006 covers the measured ordering;
`docs/probe-results.md` records the host-triggered compaction timings.

## K-2: remote delivery is at-least-once

**What happens.** A crash after OpenViking accepts a message but before the local
acknowledged cursor is persisted can replay that message. A probe posted the
same `source_message_ids` twice and the server's `message_count` went from 1 to
2, so the server does not deduplicate on that field.

**Why it cannot be fixed locally.** Deduplication would have to happen on the
server. Local replay deduplication only prevents *local* duplicates.

**Mitigation.** The window is small (one acknowledgement write) and the local
journal never loses data. Treat remote archives as possibly containing a
duplicate after an abrupt termination.

## K-3: extension approval is per directory and per session

**What happens.** Copilot asks before loading a user-level extension that
registers hooks. In a fresh directory, or in a `-p` run, the prompt may be
auto-denied; the session then has no recall, no capture, and no OpenViking MCP
tools.

**Why it cannot be fixed locally.** This is the host's trust model. The
integration cannot approve itself, and no CLI setting was found that grants a
user-level extension cross-directory approval.

**What to do.** Approve with "Yes, and always allow" in directories you use
regularly. A session that shows no `openviking-*` tools is a session where the
extension did not load — check the permission prompt before suspecting the
integration.

## K-4: MCP tool projection is asynchronous

**What happens.** A session can report the OpenViking MCP server as connected
while its tools are still missing from the model's tool list, resolving only on
a later reload or resume.

**Why it cannot be fixed locally.** The host projects the tool catalog on its own
schedule. There is no "catalog updated" event to await.

**Mitigation.** The extension verifies the projection at session start through
`session.rpc.tools.getCurrentMetadata()` and asks the host to reload once when
the tools are missing. Each state emits its own log event
(`mcp-server-connected`, `mcp-tools-projected`, `mcp-tools-missing-after-handshake`,
`mcp-tools-projection-recovered`) so "connected" is never read as "available".

## K-5: installer cannot recover from an interrupted replacement

**What happens.** If the installer is killed between its four target renames,
install, dry-run, and uninstall all refuse to proceed and preserve the
staging/backup artifacts for manual recovery. Nothing is lost, but nothing
self-heals either.

**Why it is not done yet.** Automatic recovery needs a crash-consistent
transaction log, and recovery must delete or move half-replaced files — a
destructive action that needs explicit confirmation. It is therefore scheduled
last, after the non-destructive work. The current behaviour is safe (fail
closed, preserve evidence). Documented in
`docs/configuration-security.md`.

## K-6: historical replay is not implemented

**What happens.** Only live events are captured. A session resumed from history,
or one whose extension started late, is not backfilled.

**Why.** Host event identity across reload/resume is unproven, so replaying
would risk duplicate or misordered records. The bounded catch-up explicitly
refuses gaps that look like history rather than guessing.

## K-7: per-tool capture exclusion is opt-in, not automatic

**What happens.** Capture filters apply to visible user/assistant text. Tool
names and arguments are captured unless the tool is named in
`OPENVIKING_CAPTURE_EXCLUDED_TOOLS` (comma-separated, trailing `*` for a prefix).
There is no built-in deny list, because which tools carry sensitive arguments
depends on the user's own MCP servers.

**Mitigation.** Name the tools to skip; an excluded tool's start and completion
are both dropped, and tool *output* is off by default (`captureToolResults`).
For a session where no tool traffic may be retained at all, disable capture.

**Note.** A misconfigured pattern matches exactly, so a typo silently captures
the tool rather than over-excluding it.

## K-8: host logs rotate quickly, so history is short

**What happens.** Every Copilot session that the extension ever touched leaves a
directory under `~/.openviking/copilot/state/`. Sessions that were created but
never used, sessions whose remote counterpart was deleted, and test sessions all
leave an empty or orphaned directory behind.

**Mitigation.** `diagnostics:copilot gc` surveys them and reports what is
eligible; `gc --apply` removes only partitions that hold no queued data **and**
whose remote session is confirmed gone. An unknown remote counts as present, a
recently active session is kept, and `--keep <session-id>` protects a specific
one. Nothing is removed without `--apply`.

**Why it is not automatic.** Deleting a partition destroys the only local record
of an unarchived conversation if the eligibility test were ever wrong, so removal
stays an explicit operator action.


**What happens.** Copilot keeps only a few days of `process-*.log` under
`~/.copilot/logs` (59 files spanning about three days when checked on
2026-10-23). The extension writes its diagnostics to stderr, which the host
captures into those files, so extension history disappears with them.

**Why it cannot be fixed locally.** Rotation is the host's policy. The
extension cannot extend retention, and writing its own persistent log would
duplicate a decision the user has not asked for.

**Consequence for diagnosis.** "No failure in the logs" only covers the
retention window. For anything older, rely on the durable local state
(`~/.openviking/copilot/state/<hash>/`) — cursors, pending counts, dead letters,
and the digest ledger survive — and on OpenViking session metadata
(`commit_count`, `memories_extracted`, `last_commit_at`), which is the real
long-term record.

**Related.** A periodic self-check is tracked as outstanding work so trends do
not depend on a three-day window.

## K-9: local partitions accumulate until `gc` runs

**What happens.** Every Copilot session the extension ever touched leaves a
directory under `~/.openviking/copilot/state/`. Sessions created but never used,
sessions whose remote counterpart was deleted, and test sessions all leave an
empty or orphaned directory behind, and nothing cleans them up on its own.

**Mitigation.** `diagnostics:copilot gc` surveys them and reports what is
eligible; `gc --apply` removes only partitions that hold no queued data **and**
whose remote session is confirmed gone. An unknown remote counts as present, a
recently active session is kept, and `--keep <session-id>` protects a specific
one. Nothing is removed without `--apply`.

**Why it is not automatic.** Deleting a partition destroys the only local record
of an unarchived conversation if the eligibility test were ever wrong, so removal
stays an explicit operator action.

