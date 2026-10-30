# Configuration and security

## 1. Configuration principles

- Automatic lifecycle calls and MCP tools must resolve the same server and identity.
- Secrets are never stored in repository files or extension source.
- Project configuration may control behavior but may not silently override user
  credentials.
- Every effective value has a visible source in doctor output.

## 2. Effective configuration precedence

For connection credentials, the upstream resolver applies environment values
before the user `ovcli.conf` values. For plugin settings, lower to higher:

1. Adapter defaults.
2. The legacy `copilot` section in `ov.conf`.
3. Shared `plugin` settings and `plugin.copilot` in `ovcli.conf`.
4. Workspace OpenViking settings and workspace registry overrides.
5. Supported `OPENVIKING_*` environment variables.

Credential-bearing fields are accepted only from environment variables,
`ovcli.conf`, or an OS credential provider supported upstream. Workspace files
cannot supply API keys.

## 3. Supported configuration example

```json
{
  "url": "https://openviking.example",
  "api_key": "stored-in-user-config",
  "plugin": {
    "copilot": {
      "enabled": true,
      "autoRecall": true,
      "autoCapture": true,
      "recallQueryFilters": ["user:d|^/no-memory", "s|Customer \\d+|Customer [ID]|g"],
      "captureFilters": ["user:d|^/private", "assistant:s|Customer \\d+|Customer [ID]|g"]
    }
  }
}
```

The filter grammar is documented in the pinned upstream
`input-filters.mjs`: ordered `s<delimiter>pattern<delimiter>replacement<delimiter>flags`
substitutions, `d<delimiter>pattern<delimiter>` drop rules, and
`k<delimiter>pattern<delimiter>` keep-only rules. Prefix with `user:` or
`assistant:` to scope a rule. Environment equivalents are
`OPENVIKING_RECALL_QUERY_FILTERS` and `OPENVIKING_CAPTURE_FILTERS`.
Recall filters apply before sending a prompt to OpenViking. Capture filters
apply to each visible user/assistant text event; structured tool arguments and
results are not matched by these text rules and may still be captured. Filters
are not a substitute for turning off capture or excluding sensitive tools.
Recall injection is capped locally by `recallMaxTokens` (default 1600) using a
conservative CJK-aware estimate, preserving the OpenViking context envelope
when trimming. If the configured budget cannot fit the envelope and truncation
notice, recall context is omitted rather than exceeding the cap.

## 4. Credential handling

- Default to `~/.openviking/ovcli.conf`.
- Request sensitive environment access only when the user configured it.
- Redact authorization headers and known secret fields from logs and errors.
- Do not pass credentials through command-line arguments.
- The MCP proxy and adapter use the same credential resolver.
- Credential rotation is detected without requiring a Copilot restart when the
  upstream shared module supports it.

## 5. Privacy model

Captured by default:

- user-visible user messages;
- user-visible assistant messages;
- structured tool name, arguments, and completion status;
- timestamps and source identities;
- attachment name/type/reference metadata.

Tool output content is included only when `captureToolResults` /
`OPENVIKING_CAPTURE_TOOL_RESULTS` is explicitly enabled (default: `false`).
Tool names and arguments remain captured; there is not yet a per-tool exclusion
setting.

Not captured by default:

- hidden reasoning;
- Copilot system/developer prompts;
- raw environment variables;
- API keys or authorization headers;
- raw attachment bytes;
- adapter debug payload dumps.

The implemented capture filters transform or drop visible user/assistant text
before journal persistence. They do not exclude structured tools by name or
filter tool arguments/results; use the global capture switch where those records
must not be retained.

Individual tools can be excluded from capture with
`OPENVIKING_CAPTURE_EXCLUDED_TOOLS`, a comma-separated list of tool names where
a trailing `*` matches a prefix (`jira_search`, `openviking_*`). An excluded
tool's start **and** completion are both dropped, so its arguments and output
never reach the journal; names match exactly unless a wildcard is given, so a
typo cannot silently broaden the exclusion. The same resolved list is used by
the capture path and the compaction audit, because a mismatch would make an
excluded tool look like a missing event and block the commit.

### Subagent memory capture

Subagent capture is disabled unless `OPENVIKING_COPILOT_SUBAGENT_MEMORY=true`
is present when the local Copilot process starts. When enabled, the extension
subscribes to Copilot's child streaming events and routes supported visible
user, assistant, tool, and turn-boundary records to an independent OpenViking
session per child. Parent lifecycle records remain in the parent session.
Subagent prompts do not currently receive profile or recalled memory context.

Every child session is created with the restricted policy
`self.enabled=false`, `peer.enabled=true`, `memory_types=["preferences"]`,
`working_memory.enabled=false`, and `auto_commit_policy=null`. Before writing,
the adapter verifies that an existing session has the same policy. Child
sessions are committed only after Copilot reports child completion. Copilot's
current OpenViking session API does not represent parent/child relationships;
the adapter stores that mapping locally in the parent's
`subagent-sessions.json`, using a SHA-256 agent identity rather than the raw
Copilot agent ID.

If the extension exits while a child is active, the child is marked
`orphaned`; if it exits after commit begins and before the outcome is recorded,
the child is marked `commit_unknown`. Neither state is automatically committed
or retried because the child may be incomplete or the server may already have
committed. `diagnostics:copilot status --json` exposes only the child identity
hash and status; `summary` reports the number requiring recovery. These
diagnostics do not contact OpenViking. Manual recovery is not yet implemented.

## 6. Tool-result handling

Large tool outputs remain structured and rely on OpenViking externalization.
Before transport, the adapter additionally:

- redacts configured secret patterns;
- records truncation/externalization metadata;
- preserves tool call/result correlation;
- avoids copying the same output into logs.

The adapter does not claim comprehensive secret detection. Users must retain
control over capture and exclusion policy.

## 7. URI guard security

The SDK `onPreToolUse` hook applies the shared URI guard to supported local
file tools and shell command aliases. It prevents accidental local treatment
of virtual OpenViking paths, not malicious command execution. It must:

- validate parsed tool arguments rather than search only raw strings;
- reject local file read/write/edit/glob/grep targets with `viking://`;
- avoid rewriting shell commands;
- allow legitimate textual references to Viking URIs;
- produce no false success response.

## 8. Logs and diagnostics

The Copilot doctor reuses the upstream configuration resolver and runs locally
without health checks or network calls. It reports endpoint/authentication
metadata and effective recall/capture toggles, never credential values; URL
user-info, paths, and query/fragment data are omitted. The interactive setup command
reuses the upstream wizard, which masks API keys, asks for confirmation, and
backs up the existing `ovcli.conf` before writing.

Default logs contain:

- lifecycle transition;
- source and target sequence ranges;
- latency, retry class, and HTTP status category;
- queue size;
- effective non-secret configuration source;
- compatibility and degraded-capability flags.

Default logs do not contain complete prompts, responses, tool payloads, or secrets.
Payload logging requires an explicit temporary debug mode and prominent warning.

Log rotation and retention are bounded. Doctor output supports a sanitized export.

## 9. Installation safety

The installer must:

- detect the Copilot user configuration root;
- reject Copilot CLI versions below the minimum version established by host probes;
- back up only files it will modify;
- isolate its owned hook file rather than rewriting unrelated hook files;
- stage replacements and restore previous owned targets if a replacement fails;
- be idempotent;
- leave credentials untouched;
- provide a dry-run.

The uninstaller must remove only owned files and owned hook entries. It must not
delete OpenViking user data, unrelated MCP configuration, or queued records
without explicit confirmation.

Current implementation scope: `install.mjs` requires Copilot CLI `1.0.95-3`
or newer; `1.0.95-3` is the oldest version on which this project's extension
loading and the dynamic MCP projection check were directly verified. It runs
`copilot --version` before creating or changing profile files, and records the
detected/minimum versions in the ownership marker. This gate covers the local
Copilot CLI target, not a separate Copilot App version.

The installer stages a clean extension tree and owned hook file, then replaces
each target by same-directory rename. If either replacement fails, it attempts
to restore the previous owned targets; an incomplete rollback reports the
preserved backup paths. Each rename is atomic, but the two-target update is not
crash-atomic: forced process termination or power loss between renames may leave
temporary backup/staging paths. `npm run recover:copilot` inspects those artifacts
and prints a plan; `--apply` restores a displaced backup, discards unused staging,
or discards a backup whose replacement already completed. It refuses any state it
cannot justify from the artifacts (for example staging without this project's
ownership marker) and never deletes a backup while the installed target is
unowned. `--dry-run` performs
version/ownership checks and reports targets without creating directories or
changing files. The hook is a dedicated ownership-tagged
`hooks/openviking-memory.json`, so unrelated hook files are not modified or
merged. The uninstaller validates ownership of both targets before removing
either. Successful upgrades discard their temporary rollback copies; no
long-term backup is retained. Tests cover dry-run non-mutation, old-version
refusal, injected second-target replacement failure with restoration of both
prior targets, ownership refusal, clean replacement of stale runtime files,
unrelated hook preservation, and uninstall validation.

The preCompact command uses the same durable per-session journal, serializes
remote work with an interprocess lease, and has an 8-second adapter budget
inside a 10-second Copilot hook timeout. It flushes only records already
durably observed by the SDK extension and audits the transcript-visible
prefix before commit; it does not import events still buffered in memory or
guarantee the host has flushed all events into its transcript. A disabled-memory
smoke test passed in the isolated Copilot home. Two additional real compactions
in an isolated profile
invoked the command, which exited successfully in 130 ms and 148 ms before the
host's compaction-complete event; memory was disabled, so those runs exercised
only the skip path. A separate restricted memory-enabled run committed one
peer-only preference, then cleaned the exact test session, memory file, local
journal, and temporary workspace. A later metadata-only audit captured the
memory-enabled hook's success event, exit code 0, and no watchdog 8.414 seconds
before `session.compaction_complete`; the server `last_commit_at` timestamp
followed the host event. This verifies command ordering for one invocation, not
a general deadline guarantee or completeness of events not yet durable in the
shared journal.

Newly captured records also append a SHA-256 digest of the source event ID and
a payload digest to a local per-session ledger. The configured `preCompact`
command compares those against the bounded, session-scoped Copilot
`events.jsonl` through a compaction start no more than two seconds before the
Hook timestamp; mismatches, missing
history, or an unverifiable path prevent commit and leave the journal for
recovery. It does not import transcript text, and sessions captured before
the ledger existed cannot be audited retroactively. The transcript is parsed
locally and is not uploaded by the audit. A loopback-only isolated real-host
run verified the gate for two transcript-visible events with a simulated
commit before compaction completion. A guarantee that the host has flushed all
events into its transcript at hook time remains outstanding.

Normal-profile install/uninstall passed a reversible host-only trial on CLI
`1.0.90`; the installed `--host-smoke-only` marker prevented the extension from
initializing memory or registering OpenViking MCP even though normal user
configuration enabled recall and capture. The separate installed hook skipped
before reading input, and both owned targets were removed afterward. A later
authorized normal-profile installation left the owned targets in place with
memory enabled; one fresh synthetic CLI session captured and acknowledged
three events and its OpenViking session showed a new commit. This is a
controlled trial, not production acceptance or a full privacy assessment. A
later read-only probe confirmed a server-assembled recall context and a
health-only OpenViking MCP call; capture was disabled in those probe processes.
The installed normal-profile Hook command was also invoked directly with a
synthetic transcript and run-scoped session; the digest gate and restricted
remote commit succeeded, then the exact test artifacts were deleted. A real
host-triggered normal-profile `/compact` has since been observed in a terminal
session: approving the extension let it load, `/compact` produced a real
compaction boundary, and the run-scoped session showed a commit that the
extension cannot have made, because it commits only on session end. That is one
synthetic invocation on CLI `1.0.90`; capture completeness for events not yet
durable at Hook time and cross-version behavior remain open.
Retained pre-upgrade backups and automatic recovery after
abrupt termination remain release limitations. The installer now stops on its
own UUID-suffixed staging/backup remnants rather than replacing a partially
installed target; uninstall also refuses these remnants so it cannot destroy
the recovery state. An operator must inspect and recover exact targets manually.
Disposable-profile tests terminated a child process after each replacement
rename and verified detection and preservation; power-loss durability and
automatic restoration were not tested.
A combined isolated interactive
smoke test on CLI `1.0.90-7` loaded the
integration extension, completed a synthetic prompt, `/compact`, and clean CLI
exit with OpenViking memory and MCP explicitly disabled. That run did not
independently capture a new preCompact command result or test session-end
persistence; the separate memory-enabled audit above did capture one successful
preCompact invocation.

For isolated host-only tests, set `OPENVIKING_COPILOT_DISABLE_MCP=true` to
prevent the extension from registering or starting the OpenViking MCP proxy.
This does not change the default installation behavior and should not be set
when testing the active OpenViking MCP tool surface.

### Isolated cloud integration mode

`OPENVIKING_COPILOT_INTEGRATION_TEST=true` activates a deliberately restricted
mode for one controlled local Copilot session. It also requires a unique,
non-secret `OPENVIKING_COPILOT_TEST_RUN_ID` containing 8-80 letters, digits,
underscores, or hyphens. The run ID becomes the exact session and peer ID
`ov-copilot-it-{run-id}`. In this mode the extension:

- creates the session with `self.enabled=false`, `peer.enabled=true`,
  `memory_types=["preferences"]`, and `working_memory.enabled=false`;
- explicitly disables server-side automatic commits and verifies the saved
  session policy before sending any message;
- disables profile/prompt recall and does not register OpenViking MCP tools;
- skips the separate `preCompact` command by default to avoid an unscoped
  second writer. A memory-enabled test may set
  `OPENVIKING_COPILOT_TEST_PRECOMPACT=true` to opt in only while integration
  test mode is active; the hook then uses the same exact test session/peer IDs
  and verifies the restricted session policy before capture or commit.
- If `OPENVIKING_COPILOT_SUBAGENT_MEMORY=true` is also set, each child uses a
  separate session ID under the same run namespace:
  `ov-copilot-it-{run-id}-sub-{24-hex-agent-hash-prefix}`. Child sessions use the same
  restricted peer-preferences-only policy. This is still a remote write and
  requires explicit authorization for the test run.

Only the session URI `viking://~/sessions/ov-copilot-it-{run-id}/` and the
test peer's memory URI prefix `viking://~/peers/ov-copilot-it-{run-id}/memories/`
are in scope. Use a fresh run ID, record both paths in a local manifest before
starting, and test with synthetic-only conversation content. The mode narrows
this extension's automatic behavior; it is **not** a server-side ACL. The
OpenViking credential itself retains its normal authority, so do not enable the
mode in a normal Copilot profile or expose other write-capable tools during the
test. Cleanup must target only the test session and peer memory files recorded
for that run; never recursively delete the user or peer root.

## 10. Threat and failure summary

| Risk | Mitigation |
|---|---|
| Secret leakage to logs | Structured redaction and payload-free default logs |
| Workspace injects credentials | Disallow credential fields from workspace config |
| Malicious recalled memory influences agent | Clearly delimit untrusted recalled context and retain source URIs |
| Duplicate capture | Stable source identity and durable cursor |
| Memory outage blocks coding | Fail-open hooks with bounded deadlines |
| Queue grows without bound | Hard byte/record caps and explicit recovery |
| Hook overwrites user config | Ownership-tagged merge and backup |
| Local URI used as filesystem path | Parsed-argument URI guard |
| MCP and hooks target different servers | Single shared configuration resolver |

## 11. Remote test-data isolation

The primary integration target is the cloud server already configured by the
local `ov` CLI. Tests must treat all pre-existing server data as protected.

Every mutable integration test receives a unique namespace:

```text
viking://<test-root>/copilot-integration/<date>/<run-id>/
```

The concrete `<test-root>` is selected only after listing the server's allowed
test location and confirming it is not an existing user/project memory root.

Safety rules:

- A mutation guard rejects `write`, `edit`, `remember`, `forget`, resource/skill
  creation, and cleanup outside the resolved run prefix.
- Each created URI is recorded in a local run manifest before subsequent mutation.
- Cleanup may target only URIs in that manifest and still under the same run prefix.
- Recursive cleanup of a broad parent test root is prohibited.
- Read tests prefer fixtures under the run prefix. Any read outside it must be
  explicitly non-mutating and avoid exporting payloads to test logs.
- Destructive tests use synthetic fixtures only.
- A failed or interrupted run leaves its manifest for reviewed, targeted cleanup;
  it never triggers wildcard cleanup on the next run.
- Test names, logs, and assertions must not contain existing remote memory content.
