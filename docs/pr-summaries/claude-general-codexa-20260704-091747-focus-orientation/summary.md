# Change Summary

- Project: `codexa`
- Worktree: `isolated codexa worktree`
- Branch: `claude/general/codexa-20260704-091747-focus-orientation`
- Base: `main`
- Primary commit: `a076e15`
- Subject: `feat(mcp): surface workspace skill hints`

## Changed Files

a076e15 feat(mcp): surface workspace skill hints
 src/init.ts                                      | 159 +++++++++
 src/mcp/compaction.ts                            |   3 +
 src/mcp/resources.ts                             |   4 +
 src/query/context.ts                             |  19 +
 src/skill-hints.ts                               | 425 +++++++++++++++++++++++
 src/types/query-data.ts                          |   2 +
 tests/init.test.ts                               |  41 +++
 tests/mcp-01-keeps-the-primary-mcp-happy.test.ts |  68 ++++
 8 files changed, 721 insertions(+)
 create mode 100644 src/skill-hints.ts

## Verification

- git diff --check: passed
- npm run check: passed
- Codexa post-edit-review: local artifact recorded
- Codexa test-plan: local artifact recorded
- Codexa proof-card: local artifact recorded
- Codexa outcome-to-row: WORKING.md bridge updated
- git diff --cached --check: passed
- staged safety scan: passed

## Notes

Implements the portable Codexa portion of the workspace audit remediation: bounded workspace session-start digest, configured skill/playbook hints, structured MCP compaction, and regression coverage.
