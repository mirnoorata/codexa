# Change Summary

- Project: `codexa`
- Worktree: `isolated codexa worktree`
- Branch: `claude/general/codexa-20260709-025016-focus-orientation`
- Base: `origin/main`
- Commits: 8 (`1048508..1c842b5`)
- Subject: `fix(core): kill false-positive drift blocks, pin node truth, unfreeze MCP routing, prune ghost packets`

## Scope

Implements F1-F8 of the "functioning optimally" audit plan (adversarially
reviewed by four independent reviewers before implementation; all items
SOUND-WITH-AMENDMENTS, amendments folded in).

- F1/F2 `fix(hooks)`: stop-hook drift blocks now require recorded edit
  evidence from the current session (pre-edit session ledger, hashed
  filenames, mtime GC) and a snapshot younger than
  `CLAUDIO_SNAPSHOT_BLOCK_TTL_HOURS` (default 24h). A session that edited
  nothing is never drift-blocked; demotions print their reason.
- F3 `fix(git)`: deleted the production-dead sync `getGitState`; one 16 MiB
  cap shared with the review path; truncation/timeout degrade loudly
  (freshness.degradedGitState + packet gaps) instead of hard-throwing;
  truncated NUL output clamps to the last complete entry; churn failure
  records a gap instead of silently zeroing ranking.
- F4 `fix(init)`: untracked host-local wiring pins the exact node binary;
  tracked/shared files keep PATH-"node"; `serve` refuses node <22 naming the
  binary and fix; hook subcommands stay quiet; doctor reports the running
  binary and flags bare-node PATH-dependence and dangling/undersized pins.
- F5 `fix(mcp)`: root preference recomputed per call (no spawn-time freeze),
  focus rows written after server start route the next call; explicit
  workspace routing with no matching row surfaces an envelope warning;
  plugin env allowlist gains `CODEXA_WORKSPACE_SESSION`.
- F6 `test(init)`: characterization tests pin that `codexa init` wires a
  linked worktree correctly (own config/hooks/fresh index) and that unwired
  worktrees are invisible; README documents worktree add -> codexa init.
- F7 `fix(query)`: focus/impact/proof-card read-first lists and session
  banners prune files that no longer exist, surfacing a counted
  rebuild-the-index gap; banner shows the plugin manifest version and labels
  stale-index read-first lists.
- F8 `fix(mcp)`: absent worktree data renders knownClean:false + unknown:true
  (envelope schema + proof card); AutoVerify reports real CODEXA_VERSION;
  CODEXA_AUTONOMY documented.

## Verification

- `npm run check` green end-to-end (typecheck, lint, privacy, cmd-smoke,
  hook-smoke 87 cases, vitest 418 tests / 42 files), exit code 0.
- Live v18 verification on this host: `/usr/bin/node dist/cli.js serve`
  refuses with rc=1 naming the binary; doctor warns once and still runs;
  hook subcommands emit no version noise.
- Doctor node-wiring states exercised live: pinned-ok, dangling-pin fail,
  bare-node warn.
- New hook-smoke cases: no-edit demotion, TTL demotion, fresh-snapshot block
  preserved, TTL env override, ledger persistence on the snapshot fast path,
  ghost pruning, manifest version, stale label, worktree wiring contract.

## Notes

- F9 (workspace remediation runbook) is operator-side and runs after this
  branch lands in the workspace's codexa install.
- Deferred explicitly: H12 session pins/leases (incl. snapshot session
  binding — identity-namespace mismatch), fail-closed no-match routing,
  H5/H6 verdict precision for editing sessions with concurrent foreign
  changes.
