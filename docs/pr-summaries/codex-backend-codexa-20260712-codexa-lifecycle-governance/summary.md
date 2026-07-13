# Change Summary

- Project: `codexa`
- Worktree: `/srv/worktree/codexa/codex/20260712-codexa-lifecycle-governance`
- Branch: `codex/backend/codexa-20260712-codexa-lifecycle-governance`
- Base: `main`
- Primary commit: `837f4dc`
- Subject: `feat(lifecycle): enforce worktree-bound governance`

## Changed Files

837f4dc feat(lifecycle): enforce worktree-bound governance
 README.md                                          |  70 ++-
 docs/architecture/codexa-context-server.md         |   2 +-
 docs/architecture/session-memory.md                |  10 +-
 docs/guides/new-user-tutorial.md                   |   2 +-
 .../codexa-lifecycle-governance-2026-07-12.md      | 504 ++++++++++++++++++++
 integrations/claude-code/README.md                 |   2 +-
 src/cli.ts                                         |  36 +-
 src/cli/hooks.ts                                   |  40 ++
 src/cli/query-commands.ts                          |  26 +-
 src/codex-contract.ts                              |   9 +-
 src/git.ts                                         |  11 +
 src/index-identity.ts                              | 107 +++++
 src/indexer/freshness.ts                           |  17 +-
 src/init.ts                                        |   4 +-
 src/lifecycle-contract.ts                          |  72 +++
 src/mcp-repo-root.ts                               |  17 +-
 src/mcp.ts                                         |  27 +-
 src/mcp/compaction.ts                              |  32 +-
 src/mcp/envelope.ts                                |  15 +-
 src/mcp/resources.ts                               |  18 +-
 src/mcp/runtime.ts                                 |  16 +-
 src/mcp/session-memory.ts                          |   1 +
 src/mcp/tool-registry.ts                           |  18 +-
 src/mcp/tools.ts                                   |  19 +-
 src/post-edit-outcomes.ts                          |  35 +-
 src/prove.ts                                       | 277 ++++++++++-
 src/query-data.ts                                  |   4 +
 src/query/change-plan.ts                           | 150 +-----
 src/query/change-plan/readiness.ts                 |  86 ++++
 src/query/post-edit.ts                             | 286 ++++-------
 src/query/post-edit/artifacts.ts                   |  23 +
 src/query/post-edit/decision.ts                    |  25 +-
 src/query/post-edit/lifecycle.ts                   | 168 +++++++
 src/query/post-edit/next-actions.ts                |   5 +-
 src/query/post-edit/support.ts                     | 119 +++++
 src/query/runtime.ts                               |  44 +-
 src/query/session-memory.ts                        |   5 +-
 src/query/session.ts                               |   2 +
 src/query/worktree.ts                              | 104 +++-
 src/session-memory/derivation.ts                   |  38 ++
 src/session-memory/event-log.ts                    |   9 +-
 src/session-memory/model.ts                        |  12 +
 src/session-memory/runtime.ts                      | 108 ++++-
 src/session-memory/store.ts                        |   5 +-
 src/task-lifecycle.ts                              | 530 +++++++++++++++++++++
 src/task-snapshots.ts                              | 126 +++--
 src/types/facts.ts                                 |   2 +-
 src/types/inputs.ts                                |   4 +
 src/types/query-data.ts                            |  20 +-
 src/types/snapshots.ts                             |  67 +++
 src/types/verification.ts                          |  69 +++
 src/verification-artifacts.ts                      | 503 +++++++++++++++++++
 src/workspace-state.ts                             |   7 +
 tests/git-state-degraded.test.ts                   |  86 +++-
 tests/index-identity.test.ts                       | 177 +++++++
 ...r-05-answers-broad-focus-graph-workflow.test.ts |   7 +-
 tests/indexer-08-does-not-recover-a-legacy.test.ts |   2 +-
 tests/init.test.ts                                 |   2 +-
 tests/lifecycle-transport-contracts.test.ts        | 122 +++++
 tests/mcp-01-keeps-the-primary-mcp-happy.test.ts   |  13 +-
 tests/mcp-02-does-not-let-stale-codexa.test.ts     |  68 ++-
 tests/prove.test.ts                                | 284 ++++++++++-
 tests/schema.test.ts                               |   7 +-
 ...ory-02-bounds-direct-entry-scope-arrays.test.ts |  24 +
 tests/task-lifecycle.test.ts                       | 426 +++++++++++++++++
 tests/verification-artifacts.test.ts               | 182 +++++++
 66 files changed, 4821 insertions(+), 487 deletions(-)
 create mode 100644 docs/plans/codexa-lifecycle-governance-2026-07-12.md
 create mode 100644 src/index-identity.ts
 create mode 100644 src/lifecycle-contract.ts
 create mode 100644 src/query/change-plan/readiness.ts
 create mode 100644 src/query/post-edit/artifacts.ts
 create mode 100644 src/query/post-edit/lifecycle.ts
 create mode 100644 src/query/post-edit/support.ts
 create mode 100644 src/task-lifecycle.ts
 create mode 100644 src/verification-artifacts.ts
 create mode 100644 src/workspace-state.ts
 create mode 100644 tests/index-identity.test.ts
 create mode 100644 tests/lifecycle-transport-contracts.test.ts
 create mode 100644 tests/task-lifecycle.test.ts
 create mode 100644 tests/verification-artifacts.test.ts

## Verification

- git diff --check: passed
- npm run typecheck: passed
- npm run package:hygiene: passed
- Codexa skipped: Explicit Codexa revision-3 full-code post_edit_review with all five invariant reviews returned continue/complete; final revision-4 docs-only review had no drift or unaccounted checks and was advisory only because documentation context quality was medium.
- git diff --cached --check: passed
- staged safety scan: passed

## Notes

Implements the lifecycle-governance plan: exact checkout identity, invariant-bound replanning, bounded loop stops, external verification artifacts, and compaction-safe decision continuity. All behavior is project-neutral.
