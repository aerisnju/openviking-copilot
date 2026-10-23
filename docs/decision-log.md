# Decision log

## Decisions

| ID | Decision | Proposal | Status |
|---|---|---|---|
| D-001 | Primary architecture | SDK extension + minimal configured hooks + official MCP proxy | Approved |
| D-002 | Shared code strategy | Reuse/vendor upstream `memory-plugin-shared`; do not rewrite behavior; AGPL-3.0 accepted subject to compliance review | Approved |
| D-003 | First implementation target | Local Copilot App/CLI on Windows, with portable boundaries | Approved |
| D-004 | `preCompact` in version 1 | Required, fail-open, bounded blocking hook | Approved |
| D-005 | Subagent model in version 1 | Parent-owned capture by default; explicit local opt-in for isolated peer-preferences-only child sessions | Approved |
| D-006 | Peer default | Git-origin peer; non-Git folders use user scope unless configured | Approved |
| D-007 | MCP integration | Register official stdio proxy dynamically through `joinSession()` | Approved |
| D-008 | Failure policy | Recall/capture fail open; durable queue for retryable writes | Approved |
| D-009 | Integration server | Cloud server configured by local `ov` CLI | Approved |
| D-010 | Remote test isolation | Unique guarded Viking prefix and manifest-only cleanup | Approved |
| D-012 | Release strategy | Independent AGPL-3.0 repository first; focused upstream contribution afterwards | Proposed |

## Decision rationale

### D-001: Architecture

**Proposal:** Approve the hybrid architecture as the implementation baseline.

Why: no single Copilot extension surface currently provides persistent event
handling, a configured pre-compaction lifecycle point, and the complete
server-owned MCP tool set.

### D-002: Upstream strategy

Options:

1. Build in this repository using vendored upstream shared modules, then propose an
   upstream OpenViking integration after validation.
2. Develop directly inside an OpenViking fork from the first implementation.

**Recommendation:** Option 1. It isolates host-contract experiments while preserving
an explicit upstream path.

### D-004: Pre-compaction hook

**Proposal:** Include the minimal configured `preCompact` hook in version 1.

Why: SDK event listeners are non-blocking and cannot prove that messages were
accepted before Copilot compacts source context. Host delivery and timing remain
unverified by Phase 0 and are an implementation acceptance gate.

### D-005: Subagent scope

**Proposal:** Keep parent-owned lifecycle capture as the default. Permit an
explicit local opt-in for independently archived child sessions, using the
restricted peer-preferences-only policy and conservative recovery states.

Why: current Copilot documentation excludes at least `general-purpose` from
configured subagent hooks, and the SDK evidence is limited to one CLI version
and synthetic tasks. A child prompt context hook is not yet implemented. The
opt-in does not imply universal host support; enabled deployments must verify
the event contract for their Copilot version.

### D-011: Child-session persistence

**Decision:** Create a separate OpenViking session per child only when
`OPENVIKING_COPILOT_SUBAGENT_MEMORY=true` is present at extension startup.
Child sessions may extract only peer preferences; self memory, working
memory, and automatic commit are disabled. Keep the parent/child map locally
with hashed Copilot identities. Mark interrupted active sessions orphaned and
ambiguous commits unknown; do not automatically retry either state.

**Rationale:** The user selected independent child sessions, peer-preferences-
only extraction, and explicit opt-in. OpenViking currently has no documented
parent-session or agent-attribution fields, so the local registry is the only
supported way to preserve lineage without making assumptions about server
schema.

### D-012: Release strategy

**Proposal:** Publish as an independent AGPL-3.0 repository first, then contribute
a focused host adapter upstream.

Why: upstream's plugin standard routes config-file hook hosts into
`agent-hook-plugin/hosts/`, while a host whose SDK callbacks need persistent
state gets its own extension package — Copilot is the latter, so there is no
adapter slot and the contribution would be a new plugin directory. Upstream asks
for ≤100-line PRs and prioritizes ≤200, and the closest precedent (the VS Code
adapter, 799 lines) is still unmerged after eleven days, so a ~10 000-line
first-time PR would likely stall while the validated host contract aged.
AGPL-3.0 on both sides removes license friction for vendoring.

Full analysis, prerequisites (missing `LICENSE`, missing `license` field, no
`NOTICE`, no commits or remote), and what must not be claimed at publication are
in `docs/release-strategy.md`.

## Remaining implementation input

- Confirm an allowed dedicated Viking root for synthetic integration-test data.

This does not block Phase 0 host probes or interface-level implementation, but it
blocks mutating cloud integration tests.

## Review record

The design baseline was reviewed and approved on 2026-09-30. Implementation must
return for review if a Phase 0 host probe invalidates any approved decision.
