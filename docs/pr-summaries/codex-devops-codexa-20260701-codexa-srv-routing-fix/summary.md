# Change Summary

- Project: `codexa`
- Worktree: `isolated codexa worktree`
- Branch: `codex/devops/codexa-20260701-codexa-srv-routing-fix`
- Base: `main`
- Primary commit: `80287c1`
- Subject: `fix(mcp): route workspace defaults without stale session pins`

## Changed Files

80287c1 fix(mcp): route workspace defaults without stale session pins
 src/mcp-repo-root.ts                               |  2 +-
 ...s-02-launches-windows-package-local-cmd.test.ts | 16 +++---
 tests/mcp-01-keeps-the-primary-mcp-happy.test.ts   | 65 +++++++++++++++++++---
 3 files changed, 65 insertions(+), 18 deletions(-)

## Verification

- git diff --check: passed
- npm run check: passed
- Codexa post-edit-review: local artifact recorded
- Codexa test-plan: local artifact recorded
- git diff --cached --check: passed
- staged safety scan: passed

## Notes

Local workspace MCP config was refreshed separately to exercise this branch until the canonical checkout is updated.
