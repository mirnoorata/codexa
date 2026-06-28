# Change Summary

- Project: `codexa`
- Worktree: `isolated codexa worktree`
- Branch: `codex/general/codexa-20260628-0222-codexa-focus-orientation`
- Base: `main`
- Primary commit: `b239836`
- Subject: `refactor(codexa): split monolithic modules`

## Changed Files

b239836 refactor(codexa): split monolithic modules
 scripts/verify-source-hygiene.mjs                  |   11 +
 src/autoverify.ts                                  |  408 +-
 src/autoverify/runner-state.ts                     |  394 ++
 src/cli.ts                                         |  932 +---
 src/cli/options.ts                                 |  283 +
 src/cli/query-commands.ts                          |  652 +++
 src/mcp/compaction-helpers.ts                      |  607 ++
 src/mcp/compaction.ts                              |  644 +--
 src/query/change-plan.ts                           |   87 +-
 src/query/change-plan/checks.ts                    |   88 +
 src/query/context.ts                               |  712 +--
 src/query/context/focus.ts                         |  696 +++
 src/query/post-edit.ts                             |  143 +-
 src/query/post-edit/runner-review.ts               |  145 +
 src/query/verification.ts                          |  774 +--
 src/query/verification/command-envelope.ts         |  347 ++
 src/query/verification/command-scope.ts            |  405 ++
 src/retrieval.ts                                   |   87 +-
 src/retrieval/constants.ts                         |   88 +
 src/types.ts                                       | 1167 +---
 src/types/change.ts                                |    1 +
 src/types/facts.ts                                 |  432 ++
 src/types/inputs.ts                                |   87 +
 src/types/query-data.ts                            |  293 +
 src/types/runtime.ts                               |  104 +
 src/types/snapshots.ts                             |   77 +
 src/types/verification.ts                          |  180 +
 ...jects-malformed-integer-options-instead.test.ts |  727 +++
 ...s-02-launches-windows-package-local-cmd.test.ts |  531 ++
 tests/cli-hooks-03-suite.test.ts                   |   86 +
 tests/cli-hooks-04-suite.test.ts                   |   91 +
 tests/cli-hooks-fixtures.ts                        |  170 +
 tests/cli-hooks.test.ts                            | 1573 ------
 ...r-01-ranks-transitive-import-hubs-above.test.ts |  740 +++
 ...2-surfaces-malformed-symbol-shaped-json.test.ts |  729 +++
 ...exer-03-reserves-fixed-risk-path-symbol.test.ts |  745 +++
 ...er-04-separates-evidence-tiers-and-uses.test.ts |  554 ++
 ...r-05-answers-broad-focus-graph-workflow.test.ts |  719 +++
 ...exer-06-keeps-planned-post-edit-reviews.test.ts |  427 ++
 ...ccounts-for-rancommands-through-package.test.ts |  935 ++++
 tests/indexer-08-does-not-recover-a-legacy.test.ts |  513 ++
 ...indexer-09-verification-workspace-scope.test.ts |  174 +
 tests/indexer-fixtures.ts                          |  609 ++
 tests/indexer.test.ts                              | 5886 --------------------
 tests/mcp-01-keeps-the-primary-mcp-happy.test.ts   |  717 +++
 tests/mcp-02-does-not-let-stale-codexa.test.ts     |  699 +++
 ...3-records-truncation-metadata-when-post.test.ts |  719 +++
 ...p-04-reports-package-version-and-codexa.test.ts |  435 ++
 tests/mcp-05-suite.test.ts                         |  108 +
 ...p-06-core-profile-envelopes-never-steer.test.ts |   57 +
 tests/mcp-fixtures.ts                              |  415 ++
 tests/mcp.test.ts                                  | 3048 ----------
 ...ecords-bounded-entries-with-provenance.test.ts} |  399 +-
 ...ory-02-bounds-direct-entry-scope-arrays.test.ts |  314 ++
 tests/session-memory-fixtures.ts                   |   89 +
 tests/setup-env.ts                                 |    6 +
 ...01-runs-optional-external-scanners-with.test.ts |  724 +++
 ...lysis-02-imports-scip-json-reports-into.test.ts |  714 +++
 ...c-analysis-03-does-not-publish-new-scip.test.ts |  330 ++
 tests/static-analysis.test.ts                      | 1751 ------
 vitest.config.ts                                   |    1 +
 61 files changed, 18132 insertions(+), 17447 deletions(-)
 create mode 100644 src/autoverify/runner-state.ts
 create mode 100644 src/cli/options.ts
 create mode 100644 src/cli/query-commands.ts
 create mode 100644 src/mcp/compaction-helpers.ts
 create mode 100644 src/query/change-plan/checks.ts
 create mode 100644 src/query/context/focus.ts
 create mode 100644 src/query/post-edit/runner-review.ts
 create mode 100644 src/query/verification/command-envelope.ts
 create mode 100644 src/query/verification/command-scope.ts
 create mode 100644 src/retrieval/constants.ts
 create mode 100644 src/types/change.ts
 create mode 100644 src/types/facts.ts
 create mode 100644 src/types/inputs.ts
 create mode 100644 src/types/query-data.ts
 create mode 100644 src/types/runtime.ts
 create mode 100644 src/types/snapshots.ts
 create mode 100644 src/types/verification.ts
 create mode 100644 tests/cli-hooks-01-rejects-malformed-integer-options-instead.test.ts
 create mode 100644 tests/cli-hooks-02-launches-windows-package-local-cmd.test.ts
 create mode 100644 tests/cli-hooks-03-suite.test.ts
 create mode 100644 tests/cli-hooks-04-suite.test.ts
 create mode 100644 tests/cli-hooks-fixtures.ts
 delete mode 100644 tests/cli-hooks.test.ts
 create mode 100644 tests/indexer-01-ranks-transitive-import-hubs-above.test.ts
 create mode 100644 tests/indexer-02-surfaces-malformed-symbol-shaped-json.test.ts
 create mode 100644 tests/indexer-03-reserves-fixed-risk-path-symbol.test.ts
 create mode 100644 tests/indexer-04-separates-evidence-tiers-and-uses.test.ts
 create mode 100644 tests/indexer-05-answers-broad-focus-graph-workflow.test.ts
 create mode 100644 tests/indexer-06-keeps-planned-post-edit-reviews.test.ts
 create mode 100644 tests/indexer-07-accounts-for-rancommands-through-package.test.ts
 create mode 100644 tests/indexer-08-does-not-recover-a-legacy.test.ts
 create mode 100644 tests/indexer-09-verification-workspace-scope.test.ts
 create mode 100644 tests/indexer-fixtures.ts
 delete mode 100644 tests/indexer.test.ts
 create mode 100644 tests/mcp-01-keeps-the-primary-mcp-happy.test.ts
 create mode 100644 tests/mcp-02-does-not-let-stale-codexa.test.ts
 create mode 100644 tests/mcp-03-records-truncation-metadata-when-post.test.ts
 create mode 100644 tests/mcp-04-reports-package-version-and-codexa.test.ts
 create mode 100644 tests/mcp-05-suite.test.ts
 create mode 100644 tests/mcp-06-core-profile-envelopes-never-steer.test.ts
 create mode 100644 tests/mcp-fixtures.ts
 delete mode 100644 tests/mcp.test.ts
 rename tests/{session-memory.test.ts => session-memory-01-records-bounded-entries-with-provenance.test.ts} (63%)
 create mode 100644 tests/session-memory-02-bounds-direct-entry-scope-arrays.test.ts
 create mode 100644 tests/session-memory-fixtures.ts
 create mode 100644 tests/setup-env.ts
 create mode 100644 tests/static-analysis-01-runs-optional-external-scanners-with.test.ts
 create mode 100644 tests/static-analysis-02-imports-scip-json-reports-into.test.ts
 create mode 100644 tests/static-analysis-03-does-not-publish-new-scip.test.ts
 delete mode 100644 tests/static-analysis.test.ts

## Verification

- git diff --check: passed
- bash -lc 'source .codex/session-env.sh && unset CODEXA_WORKSPACE_SESSION CODEXA_WORKSPACE_FOCUS_FILE && npm run check': passed
- Codexa post-edit-review: local artifact recorded
- Codexa test-plan: local artifact recorded
- git diff --cached --check: passed
- staged safety scan: passed

## Notes

- No extra notes supplied by the finishing agent.
