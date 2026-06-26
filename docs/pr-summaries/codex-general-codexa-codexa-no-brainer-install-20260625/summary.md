# Change Summary

- Project: `codexa`
- Worktree: `isolated codexa worktree`
- Branch: `codex/general/codexa-codexa-no-brainer-install-20260625`
- Base: `main`
- Primary commit: `afc229d`
- Subject: `fix(proof-card): preserve explicit verification scope`

## Changed Files

afc229d fix(proof-card): preserve explicit verification scope
 src/cli.ts            |  4 +++-
 src/mcp/compaction.ts |  1 +
 src/mcp/tools.ts      |  2 ++
 src/prove.ts          |  9 ++++++++-
 src/types.ts          |  1 +
 tests/mcp.test.ts     | 18 ++++++++++++++++++
 tests/prove.test.ts   | 32 ++++++++++++++++++++++++++++++++
 7 files changed, 65 insertions(+), 2 deletions(-)

## Verification

- git diff --check: passed
- source .codex/session-env.sh && unset CODEXA_WORKSPACE_SESSION CODEXA_WORKSPACE_FOCUS_FILE SESSION_ID && npm run check: passed
- Codexa post-edit-review: local artifact recorded
- Codexa test-plan: local artifact recorded
- git diff --cached --check: passed
- staged safety scan: passed

## Notes

- No extra notes supplied by the finishing agent.
