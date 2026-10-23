# Release strategy

## 1. Question

This integration is expected to ship under the same license as OpenViking
(AGPL-3.0). Once the plan is complete, should it be released as an independent
repository, or proposed upstream as a pull request into `volcengine/OpenViking`?

## 2. Facts established (2026-10-24)

Checked against upstream `main` and its issue tracker.

| Fact | Evidence |
|---|---|
| Upstream license | AGPL-3.0 (`repos/volcengine/OpenViking` → `license.spdx_id`) |
| Upstream has a formal standard for adding an agent plugin | `docs/en/agent-integrations/18-plugin-development.md` |
| Upstream's plugin list has no Copilot | `examples/agent-hook-plugin/hosts/` = cursor, kimicode, trae, trae-cn, zcode; plugins = claude-code, codex, opencode, dsh, pi, openclaw, hermes, openwebui |
| Upstream prefers small PRs | `CONTRIBUTING.md`: ≤100 changed lines reviewed promptly, ≤200 prioritized |
| New hosts are welcome | Issue #5972 (VS Code hooks): "Contributions are welcome. When submitting a PR, please provide screenshots and logs." |
| A comparable host contribution is still unmerged | PR #6030 (VS Code adapter): 799 additions, 93 deletions, 33 files, opened 2026-10-13, still open |
| Upstream declined a *model-routing* Copilot feature | Issue #2842 closed `NOT_PLANNED` — but its scope was using Copilot as OpenViking's model provider, not adding Copilot as a memory client |
| Our size | ~4 366 lines in `src/`+`scripts/` (30 files), ~3 997 test lines (24 files), ~2 258 doc lines, 29 vendored files |

Two facts shape the decision more than the others:

1. **Our shape does not match upstream's hook-host adapter slot.** Per upstream's
   own table in §2.1 of the plugin standard, a config-file hook host goes into
   `agent-hook-plugin/hosts/`, while a host with "SDK callbacks [that] require
   persistent state" gets its own extension package. Copilot is the latter: a
   long-lived SDK extension that owns a durable journal, a configured
   `preCompact` command, and dynamic MCP registration. There is no adapter slot
   to drop it into — it would be a new top-level `examples/copilot-memory-plugin/`.
2. **Review economics are against a single large PR.** A ~10 000-line
   first-time contribution is far outside the ≤100/≤200-line review band, and
   the closest precedent (799 lines) has been open for over a week.

## 3. Recommendation

**Release as an independent AGPL-3.0 repository first, then contribute a thin
adapter upstream once the host contract is stable.**

Two releases, not one:

### Phase A — independent repository (primary distribution)

Publish `openviking-copilot` as its own repository, AGPL-3.0, with:

- the extension, configured hook, MCP proxy, durable store, installer, and
  diagnostics as they are today;
- `vendor/` pinned by commit + SHA-256 manifest, refreshed by
  `scripts/vendor-openviking.mjs`;
- the bilingual or English docs already written, plus the verification record
  (`docs/probe-results.md`) as the evidence that the host contract was measured
  rather than assumed;
- a compatibility statement naming the verified CLI versions
  (`1.0.95-3` … `1.0.103`) and the measured `preCompact` matrix.

Why this first:

- It is shippable now, and the risk of waiting is that the validated host
  contract (compaction timing, projection race, catch-up bound) ages out.
- The bulk of our work is genuinely host-specific — durable journal, transcript
  audit, bounded catch-up, projection guard, Windows installer, GC/health
  tooling. Upstream's standard says host differences belong in the adapter, but
  it also says *shared* rules belong in shared modules; our durability layer
  would have to be argued as shared infrastructure, which is a design
  negotiation, not a code review.
- AGPL-3.0 on both sides means no license friction for vendoring, and our
  repository becomes the canonical record of the measured behaviour.

### Phase B — upstream contribution (single source of truth, later)

Open an issue first, then a focused PR, deliberately **smaller than our whole
implementation**:

1. **Issue** describing Copilot as a memory *client*, citing the measured host
   contract (extension permission prompt, `preCompact` timing across five CLI
   versions, dynamic MCP projection race, transcript flush ordering) and asking
   whether maintainers want an SDK-extension plugin directory. Note explicitly
   that this is unrelated to #2842 (model routing).
2. **PR** containing the host adapter and the reuse of shared capabilities —
   `buildPluginConfig`, recall, capture filtering, the official MCP proxy — with
   our proprietary-by-comparison parts (durable journal, audit, catch-up)
   offered separately or kept out of the first PR.
3. Adapt to upstream conventions before submitting: their `sync.mjs` vendoring
   instead of our script, `install.sh` harness wiring, bilingual `docs/en` +
   `docs/zh`, their version-bump CI, their test layout.

Why not upstream-first: a 10 000-line PR would likely stall, and stalling is
worse than two releases — it leaves the validated behaviour unpublished while
our local copy drifts from `main`.

Why not upstream-only, ever: the durability and diagnostic layers are the parts
that make this trustworthy on Windows, and they are the parts least likely to be
accepted into a repository whose installer is bash-first. Keeping a standalone
home preserves them.

## 4. Prerequisites before publishing (either option)

These are gaps found while preparing this document. The first three are now
addressed; the last two remain.

1. ~~No `LICENSE` file.~~ Added: AGPL-3.0 (copied from the vendored upstream
   license, since the vendored code is AGPL-3.0 and the integration is intended
   to ship under the same terms).
2. ~~`package.json` has no `license` field.~~ Added `"license": "AGPL-3.0-only"`.
3. ~~No `NOTICE` for the vendored tree.~~ Added `NOTICE`, naming the vendored
   directory, the source commit, the license, and the fact that this is an
   independent third-party integration.
4. **No repository yet.** `git log` reports no commits and there is no remote;
   the working tree is entirely untracked. An initial commit and a remote are
   prerequisites for "release".
5. **Decide the release mechanism.** A Git tag plus an installable artifact is
   the minimum. Because installation is "copy files into `~/.copilot/extensions`
   and write one hook file", a plain repository checkout with
   `npm run install:copilot` is sufficient for version 1; an npm package can come
   later if the installer needs a registry.

## 5. What not to claim at publication

- That it works on macOS/Linux. Only Windows was verified.
- That it is exactly-once. Remote delivery is at-least-once (known limitation K-2).
- That every host event is archived. Events the host had not yet written when
  `preCompact` ran are invisible (K-1).
- That it is supported by the OpenViking maintainers. Until Phase B lands, it is
  a third-party integration.

## 6. Decision

Recorded as D-012 in `docs/decision-log.md`.
