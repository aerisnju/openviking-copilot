# Verification strategy

## 1. Test layers

### Phase 1 local unit tests

`npm test` currently covers event filtering/normalization, secret-key and
credential-string redaction, deterministic fallback identities, sequence and
journal recovery, cross-instance duplicate staging, contiguous acknowledgement,
queue caps, dead-letter blocking, retry classification, and test-prefix/
manifest-only mutation guards, plus bounded retry scheduling and concurrent
flush serialization, local status privacy, and explicit recovery export. These
tests create only temporary local files and use synthetic `viking://` roots;
they also cover the Copilot URI-guard output contract. They do not invoke `ov`,
MCP, or external HTTP. The config doctor tests resolve temporary user config
files and assert that secrets and URL query values never appear in output.
Capture-filter tests verify message-level drops/substitutions, and recall-filter
tests verify prompt redaction and bypass before any HTTP request is made.
CJK budget tests verify the final injected block stays within its configured
estimated-token cap and retains its opening/closing context markers, or is
omitted when the cap cannot fit the required markers.
Multi-window stress tests launch simultaneous worker processes against both a
shared session partition and isolated session partitions, verifying duplicate
suppression and per-session cursor separation.
A local two-runtime `preCompact` test stages three synthetic records while the
capture transport is unavailable. A separate worker process holds the remote
lease, then releases it to a hook runtime on the same journal with mocked
recovery. The test asserts no remote calls before release, exact source ID
order, commit-after-all-messages, and an acknowledged, empty pending queue.
An additional restart test queues two synthetic messages against a mocked
offline transport, closes the runtime, reopens the same partition in a new
runtime, and checks that replay sends both in order before committing. A
journal/ledger interruption test removes an observed digest while its
unacknowledged record remains durable; initialization repairs exactly that
digest without duplication. Conflicting ledger and journal digests fail
explicitly. These are local tests, not proof of OpenViking-side deduplication
after a remotely accepted message is replayed.
Another synthetic test suspends `stage()` before it writes the journal and
confirms that a separate hook cannot include the in-flight event. A new
transcript audit checks scoped `events.jsonl` input against the durable
source-ID and payload-digest ledger; it blocks commit if the synthetic
in-flight event is present in the transcript but not yet journaled. It also
rejects changed payloads, an unverifiable path, or a stale compaction boundary.
The two-second boundary rejects an old compaction marker if the current marker
has not appeared; an unexpectedly slow host instead skips the commit safely.
This is a conservative barrier, not proof that the host transcript includes
every possible event or that the updated gate succeeds in a real compaction.
Installer crash-point tests stop a disposable child process immediately after
each of the four extension/Hook replacement renames during an upgrade. They
then verify that dry-run, normal installation, and uninstall refuse to alter
the interrupted state, and that the original owned extension backup (and,
when applicable, Hook backup) is still intact. This tests preservation and
detection, not automatic restoration or power-loss durability.
Subagent tests verify default-off routing boundaries, SHA-256-only local
identity mapping, peer-preferences-only session policy, completion-only commit,
duplicate-safe recovery, owner conflicts, and conservative `orphaned` /
`commit_unknown` outcomes. These use fake runtimes and mock HTTP; they do not
verify complete live capture or real process-failure recovery. One authorized
end-to-end run on Copilot CLI 1.0.90-7 verified the opt-in path for one built-in
`task` child: both session policies matched, one child commit extracted the
expected synthetic preference, and the exact remote artifacts were cleaned.
See `docs/probe-results.md`; this does not establish support for every agent
type.

### Unit tests

- Copilot event to normalized record conversion.
- Stable event identity and duplicate elimination.
- Tool call/result correlation and ordering.
- Configuration precedence and credential-source restrictions.
- Recall budget, bypass patterns, and context formatting.
- URI guard parsing.
- Retry classification and backoff.
- Queue compaction and atomic state updates.

### Contract tests

- Recorded Copilot event fixtures against the host adapter.
- Recorded OpenViking API responses against the shared runtime.
- MCP proxy startup, initialization, tool listing, reconnect, and shutdown.
- Hook stdin/stdout fixtures for every configured event.

### Integration tests

- Cloud OpenViking server configured by the local `ov` CLI.
- Unique per-run test prefix and local creation manifest.
- Create session, add mixed message parts, commit, and observe asynchronous task.
- Prompt recall with a real OpenViking session ID.
- Credential rotation and authentication failure.
- Offline queue, server recovery, ordered replay, and commit.
- Large tool-result externalization.

All mutating test helpers require a resolved run prefix. Tests prove that attempts
to mutate or clean up outside that prefix are rejected before any server call.
Cleanup deletes only manifest-recorded synthetic fixtures.

### End-to-end host tests

- Install into an isolated Copilot user configuration.
- Start a session in Git and non-Git workspaces.
- Verify startup injection and prompt-time hidden context.
- Execute successful and failing local and MCP tools.
- Trigger automatic and manual compaction.
- Run `/clear`, resume, close normally, and terminate unexpectedly.
- Run multiple Copilot windows against different workspaces.
- Metadata-only host probes verified configured start-context delivery and
  child SDK lifecycle for synthetic fleet children and one workspace-defined
  custom agent on Copilot CLI 1.0.90-7. This is not a guarantee for every
  built-in/custom definition or CLI version.
- With explicit opt-in, actual child event routing and completion commit have
  been verified once for a built-in `task` child in an isolated Copilot profile
  and fresh `ov-copilot-it-*` namespace. Host-only probes may expand the event
  matrix with memory disabled; any further live OpenViking child-session write
  needs separate authorization, an exact manifest, and exact-target cleanup.
- Uninstall and verify unrelated configuration remains unchanged.

## 2. Phase 0 host experiments

| ID | Experiment | Required evidence |
|---|---|---|
| H-001 | Extension lifecycle | Load, session replacement, `/clear`, shutdown event trace |
| H-002 | Event identity | Stable IDs/order across `getEvents()` and extension reload |
| H-003 | Turn reconstruction | User, assistant, tool start/result, agent-stop ordering |
| H-004 | Prompt context | `additionalContext` is hidden and affects the current turn |
| H-005 | MCP merge | Dynamic registration preserves unrelated MCP servers |
| H-006 | Compaction | Trigger a real compaction; record `preCompact` input and observe whether the command exits before compaction proceeds. Do not infer from a synthetic stdin fixture. |
| H-007 | Subagents | Metadata-only probes verified start-hook `additionalContext` delivery and SDK child lifecycle for synthetic fleet children and one workspace-defined custom agent on CLI 1.0.90-7; this is not an every-definition or cross-version guarantee |
| H-008 | Transcript fallback | Encoding, schema, growth, and availability on Windows |

Each experiment stores sanitized fixtures for repeatable contract tests.

## 3. Failure-recovery matrix

| Scenario | Expected result |
|---|---|
| Server offline before prompt | Prompt proceeds without recalled context; warning recorded |
| Server fails during capture | Record remains durably queued; accepted cursor does not advance; synthetic restart/replay tested |
| 401/403 | Automatic retry stops; credential error is visible |
| 429/5xx | Bounded retry with backoff; delivery may duplicate if acceptance preceded a lost response |
| Crash after journal append but before digest ledger append | Repair digest from the still-unacknowledged journal/dead letter; synthetic restart tested |
| Crash after remote accept but before cursor write | May replay the message; server-side idempotency is unverified, so duplicate remote messages remain possible |
| Dead-letter in sequence | Later commit is blocked; gap is visible |
| Queue reaches limit | New capture pauses; old queued records are retained |
| Hook deadline expires | Compaction proceeds; state remains recoverable |
| Two processes flush same session | Lease serializes mutation; no journal corruption |

Windows local tests cover multiple state-store worker processes, including a
worker holding the remote lease while a second runtime attempts to flush and
commit the same synthetic durable queue. A live isolated loopback-only
`/compact` also completed a simulated commit before host compaction completion.
These observations do not cover abrupt termination of either active writer.
Records acknowledged and removed before the digest ledger existed cannot be
reconstructed from a queue; an older session with missing evidence fails the
transcript gate instead of being treated as verified.

## 4. Acceptance criteria for version 1

### Correctness

- 100% of visible user and final assistant messages are represented once logically.
- Every captured tool result is linked to the correct captured tool call.
- Replaying the same source history does not add duplicate logical records.
- No commit crosses an unaccepted or dead-lettered source record unless its
  exact sequence has an explicit durable discard tombstone.

### Reliability

- All defined crash points recover without journal corruption.
- OpenViking downtime does not prevent normal Copilot prompts or tools.
- `/clear`, reload, resume, and shutdown leave an explainable state.
- Two concurrent sessions do not share mappings, cursors, or queue records.

### Performance

- Recall obeys its configured hard deadline.
- Startup injection and recall obey character/token budgets.
- Event callbacks do not perform unbounded synchronous work.
- Queue replay uses bounded batches and backpressure.

### Security and privacy

- Test secrets never appear in normal logs.
- Workspace config cannot set credentials.
- `viking://` local filesystem misuse is rejected.
- Mutating remote tests cannot escape their unique test prefix.
- Cleanup cannot target unrecorded or pre-existing server data.
- Installer/uninstaller preserve unrelated Copilot configuration.

### Compatibility

- Windows is mandatory for version 1.
- macOS/Linux path and process behavior is covered before claiming support.
- Unsupported Copilot versions fail installation cleanly.

## 5. Manual review checklist

- All automatic context includes source boundaries and URIs.
- Diagnostic messages distinguish offline, auth, schema, and local I/O failures.
- Memory extraction is described as asynchronous after commit.
- Cloud-agent limitations are not represented as local feature parity.
- Documentation states what is captured and how to disable it.
