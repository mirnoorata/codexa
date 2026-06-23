# Change Summary

- Project: `codexa`
- Worktree: `/path/to/codexa-worktree`
- Branch: `codex/general/codexa-20260622-144621-focus-orientation`
- Base: `main`
- Primary commit: `eb612e4`
- Subject: `fix(mcp): route workspace default before active rows`
- Status: ready after local verification, Codexa post-edit review, and PR review-thread fix

## Changed Files

eb612e4 fix(mcp): route workspace default before active rows
 src/mcp-repo-root.ts    | 27 +++++++++++++++++++++++----
 tests/cli-hooks.test.ts | 30 ++++++++++++++++++++++++++++++
 tests/mcp.test.ts       | 18 +++++++++---------
 3 files changed, 62 insertions(+), 13 deletions(-)

cc32184 fix(mcp): ignore invalid workspace defaults
 src/mcp-repo-root.ts |  5 ++++-
 tests/mcp.test.ts    | 46 ++++++++++++++++++++++++++++++++++++++++++++++
 2 files changed, 50 insertions(+), 1 deletion(-)

## Verification

- npm run test -- tests/mcp.test.ts: passed, 45 tests
- npm run test -- tests/mcp.test.ts tests/cli-hooks.test.ts tests/init.test.ts: passed, 111 tests
- npm run check: passed, including typecheck, lint, privacy, Claude integration smoke, and 365 Vitest tests
- node dist/cli.js doctor /path/to/workspace --mcp-readiness --json: passed; workspace root resolves to the focused Codexa worktree with `mcp-routing: ok`
- node dist/cli.js session-context /path/to/workspace --task "verify patched workspace focus routing" --limit 3 --budget 1500: passed
- git diff --check: passed
- Codexa change-plan snapshot `mcp-srv-routing-post-main-20260623`: saved
- Codexa post-edit-review for `mcp-srv-routing-post-main-20260623`: passed with Verdict: continue
- Codexa change-plan snapshot `mcp-invalid-default-review-20260623`: saved for the PR review-thread fix
- Codexa post-edit-review for `mcp-invalid-default-review-20260623`: passed with Verdict: continue
- Codexa test-plan: reviewed; focused tests and full `npm run check` cover recommended affected suites

## Notes

This fixes the ambiguous shared workspace board path by treating the workspace default as the unscoped focus before considering active session rows. Defaults that point at the configured root itself are still deferred behind active rows, preserving the previous fallback behavior for root-only defaults.

PR review feedback identified a stale-default edge case. Focused workspace defaults are now admitted into the higher-priority default group only after they resolve to a git root inside the configured workspace, so stale, missing, or out-of-workspace defaults cannot preempt valid active-session rows.

The reproduced live path now resolves the workspace root through its `.codex/WORKING.md` file to the focused Codexa worktree instead of reporting multiple active repos as ambiguous.
