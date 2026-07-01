# Change Summary

- Project: `codexa`
- Worktree: `isolated codexa worktree`
- Branch: `codex/devops/codexa-20260701-codexa-srv-routing-fix`
- Base: `main`
- Primary commit: `80287c1`
- Hardening commit: `45d35b9`
- Subject: `fix(mcp): route workspace defaults without stale session pins`

## Changed Files

45d35b9 test(mcp): cover session-start workspace defaults with active rows
76302ac docs(workflow): add PR summary for codexa
80287c1 fix(mcp): route workspace defaults without stale session pins
 .../summary.md                                     |  30 +++++++++
 .../summary.pdf                                    | Bin 0 -> 1760 bytes
 src/mcp-repo-root.ts                               |   2 +-
 ...jects-malformed-integer-options-instead.test.ts |  56 +++++++++++++++++
 ...s-02-launches-windows-package-local-cmd.test.ts |  16 ++---
 tests/mcp-01-keeps-the-primary-mcp-happy.test.ts   |  65 ++++++++++++++++++--
 6 files changed, 151 insertions(+), 18 deletions(-)

## Verification

- git diff --check: passed
- npm run check: passed
- npx vitest run tests/cli-hooks-01-rejects-malformed-integer-options-instead.test.ts: passed
- Codexa post-edit-review: local artifact recorded
- Codexa test-plan: local artifact recorded
- git diff --cached --check: passed
- staged safety scan: passed
- Adversarial review: one actionable session-start coverage gap fixed in `45d35b9`; final no-actionable-finding pass required before merge

## Notes

Local workspace MCP config was refreshed separately to exercise this branch until the canonical checkout is updated.
