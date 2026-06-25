# Change Summary

- Project: `codexa`
- Worktree: isolated Codexa worktree
- Branch: `codex/general/codexa-20260624-162241-focus-orientation`
- Base: `main`
- Primary commit: `ac16904`
- Subject: `fix(mcp): prefer focused workspace routing`

## Changed Files

ac16904 fix(mcp): prefer focused workspace routing

- `src/mcp-repo-root.ts`
- `tests/cli-hooks.test.ts`
- `tests/mcp.test.ts`

3 files changed, 63 insertions(+), 79 deletions(-)

## Summary

- Removed the extra unscoped conflict guard so a selected session, explicit focus, or focused workspace default can route Codexa before unrelated active-session rows.
- Kept active-session ambiguity fail-closed when the workspace default is the configured root itself.
- Updated MCP and CLI readiness tests for default focus, active project focus, verified live rows, and root-default ambiguity behavior.

## Verification

- `rtk npm run build`: passed
- `rtk npx vitest run tests/mcp.test.ts tests/cli-hooks.test.ts tests/init.test.ts`: passed, 3 files and 115 tests
- `rtk npm run check`: passed, including typecheck, source hygiene, privacy, Claude integration smokes, build, and 369 Vitest tests
- Codexa `change-plan`: saved snapshot `codexa-workspace-default-routing-20260624`
- Codexa `post-edit-review`: verdict `continue`, no drift, all recommended tests accounted for
- Codexa `test-plan`: recommended `tests/mcp.test.ts`, `tests/init.test.ts`, and `tests/cli-hooks.test.ts`
- Live readiness probes: `session-start` and MCP readiness doctor routed the workspace root to the focused Codexa checkout

## Review Notes

Adversarial review focused on routing precedence, stale active rows, workspace-root fallback, and privacy-sensitive PR artifacts. The additional hardening test locks the root-default safeguard so future default-focus changes cannot silently route back to the workspace root when multiple active project rows are present.
