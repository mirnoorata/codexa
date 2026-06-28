# Change Summary

- Project: `codexa`
- Worktree: `isolated codexa worktree`
- Branch: `codex/backend/codexa-20260628-codexa-relational-packets`
- Base: `main`
- Primary commit: `1957685`
- Subject: `feat(retrieval): add relational packets for ranked context`

## Changed Files

1957685 feat(retrieval): add relational packets for ranked context
 src/artifacts.ts                 |  67 +++++++++++++++
 src/graph.ts                     |  83 ++++++++++++++++++-
 src/indexer.ts                   |   4 +-
 src/indexer/ranking.ts           | 114 ++++++++++++++++++++++++-
 src/query/search.ts              |  48 ++++++++++-
 src/retrieval.ts                 | 175 ++++++++++++++++++++++++++++++++++++++-
 src/types.ts                     |  27 ++++++
 tests/indexer.test.ts            |  18 ++++
 tests/semantic-retrieval.test.ts |  11 +++
 9 files changed, 536 insertions(+), 11 deletions(-)

## Verification

- git diff --check: passed
- npm run check: passed
- git diff --check: passed
- Codexa post-edit-review: local artifact recorded
- Codexa test-plan: local artifact recorded
- git diff --cached --check: passed
- staged safety scan: passed

## Notes

Adds deterministic process and cluster packets to Codexa indexing and retrieval so zero-exact-hit searches can still surface ranked symbol, workflow, and module anchors without adding a new graph database.
