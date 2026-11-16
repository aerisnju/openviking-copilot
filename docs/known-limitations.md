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

## K-5: installer recovery is explicit, not automatic

**What happens.** If the installer is killed between its four target renames,
install, dry-run, and uninstall all refuse to proceed and preserve the
staging/backup artifacts. The refusal now points at
`npm run recover:copilot`.

**What recovery does.** `recover-install.mjs` reads the on-disk artifacts,
groups them by transaction id (one install run stamps both targets with the same
UUID), and prints a plan. `--apply` executes it. The plan distinguishes the
reachable crash states:

| Left behind | Plan |
|---|---|
| backup only, target gone | restore the backup (then discard any staging) |
| staging only | discard staging — nothing was applied |
| backup + target | replacement completed, so discard the backup — but only if the installed extension still carries this project's ownership marker |
| staging without a valid ownership marker, or an ambiguous mix | report as **not recoverable**; change nothing |

**Why it is not automatic.** Recovery moves or deletes files. Deleting the wrong
artifact destroys a working installation, so it requires an explicit
`--apply` and refuses any state it cannot justify from the artifacts themselves.
A crash during recovery leaves a state a later run can still reason about,
because restores happen before discards.

**What it does not do.** It does not reconstruct a transaction whose artifacts
were both lost (nothing left to reason about), and it does not verify that the
restored extension still matches a particular release — it restores whatever the
backup contains.

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

## K-10: an edge WAF in front of the API rejects command-injection and file-inclusion payloads

**What happens.** A capture or recall request comes back `403` with an empty body.
The record is dead-lettered, and under the default `hold` policy a commit cannot
step over an unsent record, so every later turn in that session waits behind it.
In one session this stalled the queue for eleven days.

**The 403 is not produced by OpenViking.** Three observations settle it:

| Observation | Result |
|---|---|
| Response body, `content-type`, trace id on a 403 | all empty/absent |
| The same three fields on any OpenViking response, success or error | JSON envelope plus a trace id |
| Invalid API key + clean body | `401` |
| Invalid API key + blocked body | `403` — blocks before authentication |
| Unknown path + clean body | `404` |
| Unknown path + blocked body | `403` — blocks before routing |

A rejection that happens before authentication and before routing, and that
carries none of the application's response framing, is made by the network edge
in front of the API. `openviking/server/error_mapping.py` maps
`PermissionDeniedError` to 403 *with* a `PERMISSION_DENIED` envelope, so an
application-level 403 would have looked different.

**The rules.** Three signatures reproduce, all case-insensitive, all matched
anywhere in the request body or query string — the WAF does not distinguish
fields, so `turn_id`, `source_message_ids`, tool arguments and tool output are all
inspected:

1. `$(` + optional whitespace + `printf` + whitespace + `'` — command injection
2. `etc` + `/`, `\` or `.` + `passwd` / `shadow` — local file inclusion
3. `windows` + `/`, `\` or `.` + `win.ini` — local file inclusion

What does **not** trigger, despite looking like it should: `$(echo 'x')`, `$(ls)`,
`$(id)`, `$(whoami)`, `$(rm -rf /)`, `$(curl …)`, backticks, `${IFS}`,
`/etc/hosts`, `/etc/sudoers`, `/etc/group`, `/proc/self/environ`,
`/root/.ssh/id_rsa`, `../` on its own, and the bare words `passwd` / `shadow` /
`win.ini`. The `/etc/foo/passwd` shape passes, so rule 2 requires `etc` directly
adjacent to the separator. `win.ini` matches without a leading slash; `passwd`
does not.

Earlier notes in this project blamed backticks, then "content in general", then a
stable substring. Each was an artifact of testing one variable at a time; the
table above is what the field-by-field probes established.

**What this integration does.**

1. `WAF_NEUTRALISERS` rewrites those three shapes in every string of the request
   body — text parts, tool arguments, tool output, and the recall query. The
   rewrite keeps the text readable (`/etc/passwd` becomes `/etc/[REDACTED]/passwd`)
   and is verified against the live edge for all 27 blocked forms and all 19
   accepted look-alikes.
2. `deadLetterPolicy` covers what the rewrite cannot: `hold` (default) keeps the
   record and stalls later capture; `discard` writes a digest-only tombstone and
   continues. `discard` also drains dead letters a session already holds. See
   `docs/configuration-security.md` §6a.
3. Retryable failures are never discarded, so the policy only governs records the
   server will never accept.

**Why the rewrite is not a guarantee.** The edge rule set is not ours to version,
and a WAF update can add signatures we do not know. The neutraliser reduces the
observed surface; `deadLetterPolicy` is the backstop that keeps an unknown
signature from freezing a session.

**How to clear one that already blocked.** `diagnostics:copilot export --session
<id> --output <file>` first, then either retry after the payload is corrected or
discard that exact sequence with `--confirm-data-loss`. `diagnostics:copilot
discard` remains the explicit, single-record form.


## K-11: a running session keeps the code it loaded, not the code on disk

**What happens.** After `install:copilot` replaces the extension files, sessions
that are already running keep executing the modules they loaded at startup. The
new files are on disk and a fresh session picks them up, but an in-flight session
still captures with the old logic.

**Why it matters for the WAF rewrite.** The rule list is the thing that grows as
the edge is characterised. A session started before a rule was added stages
records the new build would have neutralised, and those records then fail with
`403` — looking like the fix did not work. This was observed directly: a record
staged at 13:5x contained a neutralised `printf` substitution (the older rule) and
a raw `/etc/passwd` (the newer rule), because the process predated the deploy by
four minutes.

**What makes it self-healing.** Because neutralisation also runs at the send
boundary (K-10), a record staged under an older rule list is normalised whenever
it is finally sent — but only by a process that has the new code. `diagnostics
retry --session <id> --sequence <n>` puts the record back in the pending queue; it
does not send it, so the flush still comes from whichever process owns that
session's partition. In practice that means restarting the session is what applies
a deploy to an in-flight conversation. Verified: a record that failed with `403`
under the old process returned `200` when replayed through the deployed build.

**How to check.** Compare the deployed file's mtime against the extension
process's start time. If the process is older, restart the session; the backlog is
not lost, and the send-boundary rewrite will normalise it on the next flush.
