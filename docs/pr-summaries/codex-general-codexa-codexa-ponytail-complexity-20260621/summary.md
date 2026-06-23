# Change Summary

- Project: `codexa`
- Worktree session: `codexa-ponytail-complexity-20260621`
- Branch: `codex/general/codexa-codexa-ponytail-complexity-20260621`
- Base: `main`
- Primary commit: `2b5a89f`
- Subject: `feat(query): add complexity review lane`

## Changed Files

2b5a89f feat(query): add complexity review lane
 .../codexa-complexity-review-lane-2026-06-21.md    | 148 ++++++++++++
 src/mcp/compaction.ts                              |   5 +
 src/query/change-plan.ts                           |  11 +
 src/query/complexity.ts                            | 268 +++++++++++++++++++++
 src/query/post-edit.ts                             |  12 +
 src/types.ts                                       |  26 ++
 tests/indexer.test.ts                              |  88 ++++++-
 tests/mcp.test.ts                                  |  48 ++++
 8 files changed, 604 insertions(+), 2 deletions(-)
 create mode 100644 docs/plans/codexa-complexity-review-lane-2026-06-21.md
 create mode 100644 src/query/complexity.ts

## Verification

- git diff --check: passed
- npm run check: passed
- Codexa not wired: no .codex/config.toml
- git diff --cached --check: passed
- staged safety scan: passed

## Notes

- No extra notes supplied by the finishing agent.
