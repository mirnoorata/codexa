# Change Summary

- Project: `codexa`
- Worktree: `isolated codexa worktree`
- Branch: `codex/devops/codexa-20260701-codexa-srv-routing-fix`
- Base: `main`
- Subject: `fix(mcp): route workspace defaults without stale session pins`
- Source commit: `80287c1` - route workspace defaults without stale session pins
- Hardening commit: `45d35b9` - cover `session-start` workspace defaults with unrelated active rows
- Summary artifacts: this Markdown file and the paired PDF in the same directory

## Changed Runtime and Test Files

- `src/mcp-repo-root.ts` - lets an explicit Workspace Default focused repo route ahead of unrelated active session rows.
- `tests/mcp-01-keeps-the-primary-mcp-happy.test.ts` - covers MCP stdio routing for Workspace Default with unrelated active rows.
- `tests/cli-hooks-02-launches-windows-package-local-cmd.test.ts` - covers `doctor --mcp-readiness` routing for the same board shape.
- `tests/cli-hooks-01-rejects-malformed-integer-options-instead.test.ts` - covers `session-start` routing for the same board shape.

## Verification

- git diff --check: passed
- npm run check: passed
- npx vitest run tests/cli-hooks-01-rejects-malformed-integer-options-instead.test.ts: passed
- npm run security:check: passed after hardening; includes typecheck, lint, privacy, Claude integration smoke, full Vitest, npm audit, public snapshot, package hygiene, plugin hygiene, and package smoke
- Codexa post-edit-review: local artifact recorded
- Codexa test-plan: local artifact recorded
- git diff --cached --check: passed
- staged safety scan: passed
- Adversarial review: one actionable session-start coverage gap fixed in `45d35b9`; later artifact and PR-body hygiene findings fixed before merge

## Notes

Local workspace MCP config was refreshed separately to exercise this branch until the canonical checkout is updated.
