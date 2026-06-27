# Change Summary

- Project: `codexa`
- Worktree: `isolated codexa worktree`
- Branch: `codex/general/codexa-20260626-220925-focus-orientation`
- Base: `main`
- Primary commit: `f545e0e`
- Subject: `fix(mcp): fail closed on ambiguous workspace routing`

## Changed Files

f545e0e fix(mcp): fail closed on ambiguous workspace routing
 src/mcp-repo-root.ts    |  60 ++++++++++++++++---
 src/mcp.ts              |  15 +++--
 src/mcp/compaction.ts   |   5 ++
 src/mcp/runtime.ts      |  27 ++++++++-
 tests/cli-hooks.test.ts |  16 +++---
 tests/mcp.test.ts       | 150 +++++++++++++++++++++++++++++++++++++++++++++---
 6 files changed, 244 insertions(+), 29 deletions(-)

## Verification

- git diff --check: passed
- source .codex/session-env.sh && unset CODEXA_WORKSPACE_SESSION CODEXA_WORKSPACE_FOCUS_FILE SESSION_ID && npm run check: passed
- Codexa post-edit-review: local artifact recorded
- Codexa test-plan: local artifact recorded
- git diff --cached --check: passed
- staged safety scan: passed

## Notes

Fixes CLI/MCP divergence for shared workspace roots by failing closed on conflicting focus/default/session evidence, preserving selected-session routing, and exposing sanitized routing metadata in MCP runtime results. Verification: npm run check.
