# Copilot host contract

## 1. Purpose

This contract isolates Copilot-specific behavior from the reusable OpenViking
adapter. The implementation must reject or degrade capabilities explicitly when
the host does not satisfy this contract.

## 2. Extension contract

### Verified capabilities

- User extensions use an `extension.mjs` entry point.
- The host provides `@github/copilot-sdk`.
- The extension can join the current session. **Observed** in Copilot CLI 1.0.90-0.
- `joinSession()` accepts hooks, tools, and `mcpServers`.
- The session exposes a live event stream and `getEvents()` history. **Observed**:
  event records include UUID-like `id` and `parentId`, timestamp, type, and
  `ephemeral`; history returned existing events.
- Programmatic hooks include session start/end, prompt submitted, agent stop,
  pre/post tool use, pre-MCP call, and error events.
- Prompt submission can return hidden `additionalContext`.
- An independent local Copilot session loaded the user extension and triggered
  configured `sessionStart`, `userPromptSubmitted`, `agentStop`, and `sessionEnd`
  hooks. Only field names and string lengths were recorded.
- SDK `subagent.started`, `subagent.configured`, `subagent.selected`, and
  `subagent.completed` were observed for a delegated read-only task.
- In Copilot CLI 1.0.90-7, configured `subagentStart` and `subagentStop`
  command hooks fired for synthetic read-only fleet tasks. In two two-child
  parallel runs, distinct random `additionalContext` marker hashes matched the
  respective stop-response marker hashes; each stop `agentId` hash matched its
  child `userPromptSubmitted.sessionId` hash. In two authenticated interactive
  runs, the SDK extension joined the parent session and observed two each of
  `subagent.started`, `subagent.configured`, and `subagent.completed`, plus
  ephemeral assistant streaming events. In the latest run, SDK lifecycle
  `agentId` hashes also matched both hook identity hashes for each child. The
  SDK stream also delivered one non-ephemeral `user.message` and one
  `assistant.message` per child, each with the matching `agentId`; for both,
  `subagent.started` preceded `user.message` and `assistant.turn_end` preceded
  `subagent.completed`. The start hook itself exposed no child ID. These are
  repeated observations on one CLI version, not a cross-version identity,
  complete-capture, or recovery guarantee.
- One user-authorized isolated integration run on Copilot CLI 1.0.90-7
  exercised the real extension's opt-in path for one built-in `task` child.
  Parent and child session policies were read back as peer-preferences-only;
  the child completed one commit, extracted one preference, and left zero
  pending tokens. The extracted content matched the synthetic test preference,
  and the local registry/log recorded the child as committed using only the
  agent-ID hash. The exact memory file, generated empty preference directory,
  and parent/child sessions were removed and verified absent. This validates
  one end-to-end path only; see `docs/probe-results.md`.
- A separate metadata-only probe on CLI 1.0.90-7 verified that a workspace-
  defined `probe-helper` agent received the configured `subagentStart`
  `additionalContext`: its marker hash matched the `subagentStop` response
  marker hash, and the SDK stream recorded the child lifecycle plus one visible
  user/assistant message pair. The OpenViking memory extension and hook were
  absent from discovery paths during this probe and restored afterward; no
  OpenViking endpoint was contacted. This adds one custom-agent observation,
  not coverage of every custom definition or CLI version.
- Dynamic MCP registration launched a stdio server and made a metadata-only ping
  tool callable in the foreground session.
- In an isolated Copilot home, the actual integration extension loaded and
  joined under Copilot CLI `1.0.90-0` when launched with `--experimental`;
  the CLI extension picker reported both the integration extension and probe
  enabled. This was host-only: memory was disabled and no OpenViking server was
  contacted.
- After browser sign-in to the isolated profile, a fresh CLI process returned
  `READY` both without and with the integration extension enabled. The
  integration run explicitly disabled the OpenViking MCP proxy.
- A real `/compact` completed and the metadata-only probe observed the host's
  `preCompact` event with `sessionId`, `cwd`, `transcriptPath`, and `trigger`.
- In two later isolated real compactions, the installed integration command
  received the host payload and reported `pre-compact-complete` with exit code 0,
  no timeout, and 130 ms / 148 ms elapsed. It ran before the host's
  `session.compaction_complete` event. Memory was disabled, so this verified the
  real hook invocation and no-memory path only, not remote flush/commit.
- With automatic memory behavior disabled but dynamic MCP registration enabled,
  the actual OpenViking MCP server appeared in `/mcp` with 14 tools and its
  read-only `health` call succeeded. The isolated Copilot config had no static
  OpenViking MCP entry.
- A user-authorized, restricted memory-enabled `/compact` run read back the
  dedicated peer-only session policy, then produced one successful commit and
  one preference-memory add. A follow-up instrumented run captured
  `pre-compact-complete`, exit code 0, no watchdog, and a 1,912 ms duration;
  the process exited 8.414 seconds before `session.compaction_complete`.
  The server's `last_commit_at` was 18:25:30.931Z, after the host event, so that
  server timestamp is not a reliable proxy for command completion. This
  establishes ordering for one invocation only.
- In one `--continue` run, fingerprints for previously observed event IDs were
  present again in `getEvents()` history. This is limited evidence for that
  transition, not a guarantee across all reloads, resumes, or host versions.
- In an isolated `/clear` run, the old session produced `sessionEnd`; after a
  synthetic prompt, the new session produced `sessionStart` with a different
  hashed session identity. This confirms session replacement for that run only;
  it does not establish event-history ordering or behavior across all host
  transitions.

### Runtime integration status

`extension.mjs` uses the verified SDK entry point and hooks for startup
profile context, per-prompt recall, live event capture, stop-time flush, and
session-end flush/commit. Its `onPreToolUse` hook denies supported local
filesystem tools when their path targets a `viking://` URI and adds a
non-blocking notice for shell commands; OpenViking MCP tools are not intercepted.
Lifecycle input provides `sessionId` and `cwd`.
Historical `getEvents()` data is deliberately not replayed yet: event ID
stability across host restarts has not been established for durable
deduplication. The extension buffers live events until its durable store is
ready. The configured `subagentStart` hook was used only for isolated host
probes; production installation does not register it. Those probes correlated
unique start markers to stop responses and stop agent IDs to child
prompt-session IDs. Two authenticated interactive runs verified SDK join and
observed child lifecycle and streaming events. In the latest run, lifecycle
agent IDs matched the stop-hook and child prompt-session IDs; each child also
emitted one non-ephemeral `user.message` and `assistant.message` carrying that
ID. These observations do not establish a general cross-version identity,
complete-capture, or recovery contract.

The local extension now supports independent child archives behind the
explicit `OPENVIKING_COPILOT_SUBAGENT_MEMORY=true` opt-in. Mock tests cover
hashed local mapping, child-only message routing, restricted peer-preferences-
only policy, completion commit, and conservative orphan/unknown-commit
recovery. One live Copilot/OpenViking integration run has now exercised that
path for one `task` child, with exact policy read-back, commit, extraction, and
cleanup verification. It does not establish complete event capture, recovery
under a real process failure, or support for every built-in/custom subagent
type. A separate host-only probe verified start-context delivery for one
workspace-defined custom agent; see `docs/probe-results.md`. The current
official OpenViking
`create_session` API does not document a parent-session parameter; the local
registry therefore maintains parent/child association. Its current
`AddMessageRequest` schema also has no agent-attribution metadata field, so
server-side lineage is unavailable. See the
[session router schema](https://github.com/volcengine/OpenViking/blob/main/openviking/server/routers/sessions.py)
[session API](https://github.com/volcengine/OpenViking/blob/main/docs/en/api/05-sessions.md).
In non-interactive `-p` mode, the probe extension was denied loading with
`ExtensionDeniedError`; that run did not test SDK join or streaming.

Once installed, it registers
`mcp-proxy.mjs` through the stdio
transport, using the Node executable recorded by the installer. The MCP child
receives only the upstream allowlisted `OPENVIKING_*` environment variables and
the workspace directory; it resolves credentials through the same user
configuration files and upstream loader as lifecycle calls. The installer also
registers an owned `preCompact` command hook. That short-lived process reopens
the same durable session journal, flushes its already-observed queue, and
commits only if flush succeeds; a per-session interprocess lease serializes its
remote operations with the SDK extension. It has an 8-second adapter deadline
inside the configured 10-second command timeout. A local transcript audit now
checks that visible events through the current compaction start have matching
durable event-ID and payload digests before allowing that commit. It does not
write missing events: a missing, changed, or unverified transcript blocks the
commit and lets Copilot proceed. It cannot prove that the host has delivered
every event into the transcript at that instant, and its real-host behavior
after this change remains unverified. Two isolated real
compactions confirmed the no-memory path completed before the host's completion
event. An instrumented memory-enabled run also completed before that event:
`session.compaction_start` was 18:25:15.119Z, the hook exited at 18:25:17.121Z,
and `session.compaction_complete` was 18:25:25.535Z. The server's
`last_commit_at` was later than the host event, but the wrapper independently
captured the successful command event and process exit. This is evidence for
one invocation, not a general deadline guarantee.

### Required runtime assumptions

The implementation must probe rather than assume:

- Current session identity is stable for the life of one joined session.
- Event history identifiers and ordering are stable across extension reload.
- The extension receives all events required to reconstruct a complete turn.
- Joining with MCP configuration does not erase unrelated session MCP servers.
- Session shutdown provides enough time for bounded persistence.

If an assumption fails, the fallback is transcript reconciliation or reduced
capture with an explicit diagnostic; never silent partial success.

### Observed host-specific caveat

Inside the extension, `process.execPath` points to the Copilot executable, not
Node.js. A stdio MCP server configured with that value was rejected before
handshake. Passing the validated absolute Node path from the installer fixed the
probe. Production must use an explicit Node runtime resolver and must not silently
fall back to the extension's `process.execPath`.

### Current host-verification status

The initial isolated profile was unauthenticated and displayed a third-party
MCP policy message and a model 403. After browser sign-in, the policy message
disappeared; a fresh CLI process returned `READY`, including with the
integration extension loaded. A later isolated run verified dynamic OpenViking
MCP registration and one read-only health call. The earlier unauthenticated
output is not evidence that organization policy blocks MCP. No policy was
bypassed; this health call did not read or mutate memory data.

## 3. Configured-hook contract

The local Copilot hook configuration provides a `preCompact` event with:

- Copilot session identity;
- working directory;
- transcript path;
- compaction trigger metadata.

The hook process must:

1. Parse one structured input record from stdin.
2. Resolve the same state partition as the extension.
3. Acquire a bounded per-session lease.
4. Flush the complete durable queue already observed by the extension.
5. Commit only after the queue is fully accepted; otherwise retain the pending
   or dead-letter state without advancing the cursor.
6. Exit before the configured hook deadline.

The current implementation satisfies these steps against the durable journal.
It audits transcript-visible source-ID and payload digests before committing,
but does not wait for an event that Copilot has not yet appended to the
transcript. Two isolated real `/compact` runs observed the
installed command exit 130 ms and 148 ms after invocation, both before the
host's `session.compaction_complete` event. A metadata-only wrapper in a
restricted memory-enabled run observed `pre-compact-complete`, exit code 0,
and no watchdog after 1,912 ms; the process exited 8.414 seconds before the
host's completion event. A later isolated loopback-only host run confirmed
that the new audit matched two transcript-visible events and a simulated
commit completed before compaction. These observations are not a general
deadline or transcript-delivery guarantee.

The official Hooks reference says `preCompact` output is not processed. The hook
must not depend on returning an acknowledgement or injected context. The
metadata-only probe confirmed that, in one restricted memory-enabled run, the
hook emitted its success event and exited before the host's
`session.compaction_complete` event. The server's `last_commit_at` timestamp
lagged that event, so it must not be used as a substitute for process timing.
This does not prove a general deadline or wait guarantee, nor that buffered
events were included; keep those limits explicit. Memory failure must not veto
compaction; the hook exits promptly, records an actionable warning locally, and
leaves uncommitted state for recovery.

## 4. Event normalization contract

The host adapter converts Copilot events into stable source records:

```text
SourceRecord {
  sourceSessionId
  sourceEventId
  sourceSequence
  occurredAt
  kind
  actor
  parentOperationId?
  payload
  payloadDigest
}
```

The installed host probe observed UUID-like `id` and `parentId` fields. The
Phase 1 normalizer now consumes `user.message`, visible `assistant.message`,
`tool.execution_start`, `tool.execution_complete`, `assistant.turn_end`, and
`subagent.started`/`subagent.completed`. It omits reasoning, system, model-
internal, hook, and ephemeral events; assistant messages with non-final/
non-commentary phases are omitted. Text is passed through upstream capture
sanitization and secret-shaped values in tool data are redacted. The normalizer
does not include `encryptedContent`, `reasoningBlocks`, or tool telemetry.

Event ID stability has limited positive evidence across `--continue` in one
isolated run; broad stability across reload/resume remains unverified.
`sourceEventId` is preferred. If the host does not expose one, the adapter
derives a SHA-256 identity from the normalized event and its sequence ordinal.

Supported normalized kinds:

- `user_message`
- `assistant_message`
- `tool_call`
- `tool_result`
- `tool_error`
- `turn_boundary`
- `subagent_start`
- `subagent_complete`
- `subagent_error`
- `compaction_boundary`
- `session_boundary`

Tool calls and results remain structured OpenViking message parts. They are not
flattened into assistant prose. The normalizer is connected to the live
extension event listener for new events; unit tests use synthetic records.
Historical event replay and cross-restart deduplication remain disabled pending
host evidence for event identity stability.

## 5. Ordering rules

1. Source order is established by host sequence, then event timestamp, then
   deterministic event identity.
2. A tool result cannot be emitted before its tool call.
3. A turn is flushable when its user message exists and the assistant boundary is
   observed; partial turns may be persisted locally but not committed remotely.
4. Late tool results cause reconciliation before the next commit.
5. Re-reading history may reproduce records; durable identity makes this harmless.

## 6. Recall contract

`onUserPromptSubmitted` performs recall only when:

- auto-recall is enabled;
- the prompt does not match a bypass rule;
- OpenViking session identity is available;
- the configured deadline budget remains.

The call uses `search(mode="context")` and includes the actual OpenViking session
ID. Injected output contains:

- source URI;
- compact context text;
- a notice that detailed content requires OpenViking MCP tools.

The adapter caps result count, characters/tokens, and per-source contribution.
Timeout, authentication failure, or server failure returns no additional context
and records a status warning.

## 7. Startup injection contract

Startup context is composed in this order:

1. User profile.
2. Preference/entity memory index.
3. Peer/project memory index when a peer exists.
4. Available OpenViking skills catalog.
5. Recovery warning when offline records remain.

Each section is independently optional. A malformed section is omitted with an
explicit diagnostic rather than failing the complete injection.

## 8. URI guard contract

Hard reject a `viking://` URI used as the target of local filesystem mutation or
read tools. The error points to the appropriate OpenViking MCP tool.

For shell commands:

- do not block solely because the command contains `viking://`;
- warn when the URI appears to be treated as a local path;
- never rewrite the command automatically.

For OpenViking skill paths, mutations are directed to `add_skill` or the relevant
OpenViking tool.

## 9. Compatibility gate

At startup the adapter reports one of:

- `supported`: all mandatory capabilities are present;
- `degraded`: memory works with named missing optional capabilities;
- `unsupported`: mandatory extension or lifecycle APIs are absent.

Unsupported versions must not install hooks or mutate Copilot configuration.
