# Upstream dependency tracking

## 1. What we depend on from OpenViking

Two kinds, and only two:

| Kind | Where | Update mechanism |
|---|---|---|
| Vendored source | `vendor/openviking-memory-plugin-shared/` — 27 files (26 modules + `LICENSE`) copied from `examples/memory-plugin-shared/lib/` at a pinned commit | `npm run vendor:openviking -- --from <clone> --commit <sha> --force` |
| Server HTTP API | Called at runtime, never copied | Tracked by the compatibility notes below |

There is **no npm dependency on OpenViking** and no runtime import of an
OpenViking package: `package.json` has no `dependencies` at all. The only
non-relative import in the whole project is `@github/copilot-sdk/extension`,
which the host provides.

So the update surface is exactly one directory plus the HTTP contract.

## 2. Why this matters

The vendored snapshot is a *fixed* copy. Upstream fixes — including security
fixes — do not arrive on their own. Concretely: our first pin was
`168037c8`, and by 2026-10-30 upstream was 22 commits ahead on the shared
library, one of them breaking:

- `621b1ddd9 fix(plugins)!: apply captureFilters substitutions to tool call
  inputs and outputs (#5937)` — before this, a `captureFilters` redaction rule
  reached conversation text but **not** tool arguments or tool output, which
  were stored verbatim.

That gap applied to us too, because this adapter builds tool parts itself rather
than routing them through the shared `filterCaptureParts`. It is now closed
locally (`substituteStructured` in `src/event-normalizer.mjs`) and covered by a
test.

## 3. Checking for drift

```bash
npm run vendor:status -- --from D:/Development/Project/OpenViking
```

Reports:

- the pinned commit and whether every vendored file still matches its recorded
  SHA-256 (a mismatch means a hand edit, and exits non-zero);
- how many commits the pin is behind the clone's `HEAD`;
- how many of those touch `examples/memory-plugin-shared/lib`;
- the commit list, flagging `!` breaking changes.

Point `--ref <sha>` at another commit to compare against something other than
`HEAD`. `OPENVIKING_SOURCE_DIR` supplies the clone path without `--from`.

`test/vendor-integrity.test.mjs` runs the digest check in the normal suite, so a
hand-edited vendored file fails CI rather than waiting to be discovered.

## 4. Refreshing

```bash
# 1. Read the drift first.
npm run vendor:status -- --from D:/Development/Project/OpenViking

# 2. Review the upstream diff for anything that changes behavior we rely on.
git -C D:/Development/Project/OpenViking log <pinned>..HEAD -- examples/memory-plugin-shared/lib

# 3. Refresh. --from uses `git show <commit>:<path>`, so a dirty or
#    differently-checked-out clone cannot change what is vendored.
npm run vendor:openviking -- --from D:/Development/Project/OpenViking \
  --commit $(git -C D:/Development/Project/OpenViking rev-parse HEAD) --force

# 4. Run the suite, then update NOTICE and this document if the pin moved.
npm test
```

Without `--force` the script refuses to overwrite an existing vendor tree, and
the refresh stages every file before replacing anything: a failed download
leaves the previous tree intact, because the integration imports from it.

## 5. Behaviour changes found while refreshing (2026-10-30)

Refreshing from `168037c8` to `14fa24dc` surfaced two changes worth remembering:

1. **Tool-part redaction** (`621b1ddd9`, breaking) — described above. Fixed
   locally.
2. **A longer recall envelope** — the server-rendered block now opens with an
   orientation sentence ("Relevant memory from OpenViking. It is this user's own
   saved history…") before the content. Our token-budget trimming assumed a
   short fixed prefix, so with a tight `recallMaxTokens` the fixed cost exceeded
   the budget and the whole block was dropped. `boundRecallContext` now falls
   back to a minimal envelope plus the truncation marker instead of returning
   nothing.

Neither was caught by upstream's own tests reaching us; both were caught by our
suite plus a targeted check. That is the argument for keeping the digest test and
the drift command in the loop.

## 6. What the refresh does *not* cover

- **Server API compatibility.** We call `/api/v1/sessions`, `/messages`,
  `/commit`, `/search/search`, `/fs/*`, and `/system/status`. These are not
  vendored, so a server-side change surfaces as a runtime failure, not a
  dependency bump. The integration fails open and the queue retries, but there is
  no automated check against a new server version.
- **New upstream modules.** A new shared module is only picked up if it is added
  to `upstreamFiles` in `scripts/vendor-openviking.mjs`. Adding a host capability
  that depends on one means editing that list.
- **Type declaration files** (`*.d.mts`) are not vendored; we consume plain
  `.mjs` only.
