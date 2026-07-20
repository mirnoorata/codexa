# Change Summary

- Project: `codexa`
- Checkout: isolated Codexa task worktree
- Branch: `codex/backend/codexa-20260719-codexa-portable-tracked-init`
- Base: `main` at `adc1e65`
- Subject: `fix(init): keep tracked wiring clean across worktrees`

## Problem

`codexa init` embedded an absolute checkout path in generated `.codex/config.toml`,
`.codex/hooks.json`, and `.mcp.json` wiring. When a team intentionally tracked
those files, initializing a linked worktree rewrote them for the new path and
made a freshly created worktree appear dirty. The index report could therefore
say the tree was clean immediately before bootstrap changed tracked files.

## Resolution

- Tracked wiring omits the checkout argument and resolves the active Git root at
  process startup; untracked host-local wiring keeps its explicit absolute path.
- Codex lifecycle commands resolve from their session cwd, while Claude MCP
  launches honor its validated `CLAUDE_PROJECT_DIR` contract.
- Linked worktrees retain a stable MCP server name derived from the shared Git
  directory, and Claude-only tracked wiring preserves its existing name and
  core/full tool profile.
- Requested `.mcp.json` content is parsed before any other wiring changes, so a
  malformed shared config cannot leave initialization half-applied.
- Generated text is written only when bytes change, including repeated
  `--no-hooks` initialization with remaining team-owned hooks.

## Source Commits

- `1062fa8` — `fix(init): keep tracked wiring portable across worktrees`
- `e70a8a0` — `fix(cli): honor Claude project roots`
- `e814b14` — `fix(init): preserve Claude-only wiring`
- `fa83ee9` — `fix(init): avoid stable hook rewrites`

## Verification

- `npm run check` passed: source/release/privacy gates, 28 Claude command smokes,
  89 Claude hook smokes, and 905 Vitest tests passed with 1 intentional skip.
- Focused initialization, hook, and MCP suites passed: 62 of 62 tests.
- A real linked-worktree smoke migrated tracked wiring once, committed it, then
  reran initialization and lifecycle commands from a nested directory with a
  clean Git status before and after.
- The shared worktree-helper self-test passed after adding the board prose
  synchronization regression.
- Two independent adversarial confirmation reviews of `origin/main...HEAD`
  reported no actionable findings; one explicitly checked bloat, idempotence,
  and partial-write behavior.

## Operational Notes

Existing repositories that track absolute Codexa wiring require one intentional
migration commit. After that commit, future linked-worktree initialization is
byte-stable and Git-clean. Repositories with untracked wiring retain their prior
host-local behavior and explicit checkout path.

The host workspace's companion board helper was corrected and regression-tested
separately so changing its default repository also refreshes stale default/focus
prose. That host-local helper is not part of this repository diff.

Rollback is a normal revert of the four source commits. That restores the old
absolute-path behavior and therefore also restores the linked-worktree dirtying
failure for tracked wiring.
