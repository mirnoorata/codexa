# Change Summary

- Project: `codexa`
- Worktree: `/path/to/codexa-worktree`
- Branch: `codex/general/codexa-20260622-144621-focus-orientation`
- Base: `main`
- Primary commit: `eb612e4`
- Subject: `fix(mcp): route workspace default before active rows`
- Status: ready for PR after local and live-path verification

## Changed Files

eb612e4 fix(mcp): route workspace default before active rows
 src/mcp-repo-root.ts    | 27 +++++++++++++++++++++++----
 tests/cli-hooks.test.ts | 30 ++++++++++++++++++++++++++++++
 tests/mcp.test.ts       | 18 +++++++++---------
 3 files changed, 62 insertions(+), 13 deletions(-)

## Verification

- npm run test -- tests/mcp.test.ts tests/cli-hooks.test.ts tests/init.test.ts: passed, 110 tests
- npm run check: passed, including typecheck, lint, privacy, Claude integration smoke, and 364 Vitest tests
- node dist/cli.js doctor /path/to/workspace --mcp-readiness --json: passed; workspace root resolves to the focused Codexa worktree with `mcp-routing: ok`
- node dist/cli.js session-context /path/to/workspace --task "verify patched workspace focus routing" --limit 3 --budget 1500: passed
- git diff --check: passed
- Codexa change-plan snapshot `mcp-srv-routing-post-main-20260623`: saved
- Codexa post-edit-review for `mcp-srv-routing-post-main-20260623`: passed with Verdict: continue
- Codexa test-plan: reviewed; focused tests and full `npm run check` cover recommended affected suites

## Notes

This fixes the ambiguous shared workspace board path by treating the workspace default as the unscoped focus before considering active session rows. Defaults that point at the configured root itself are still deferred behind active rows, preserving the previous fallback behavior for root-only defaults.

The reproduced live path now resolves the workspace root through its `.codex/WORKING.md` file to the focused Codexa worktree instead of reporting multiple active repos as ambiguous.
