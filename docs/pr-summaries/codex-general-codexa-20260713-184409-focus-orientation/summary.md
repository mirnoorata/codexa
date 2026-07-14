# Change Summary

- Project: `codexa`
- Repository: `codexa`
- Branch: `codex/general/codexa-20260713-184409-focus-orientation`
- Base: `main`
- Primary commit: `de1054a`
- Subject: `feat(review): add shared committed change receipts`

## Changed Files

de1054a feat(review): add shared committed change receipts
 README.md                                          |  66 ++-
 action.yml                                         |  49 ++
 package.json                                       |   7 +-
 scripts/package-install-smoke.mjs                  |  25 +
 src/ci-workflow.ts                                 | 101 ++++
 src/cli.ts                                         |   8 +-
 src/cli/query-commands.ts                          |  68 +++
 src/init.ts                                        |  43 +-
 src/mcp/advanced-mode-kernel.ts                    |  28 ++
 src/mcp/tool-registry.ts                           |  13 +
 src/mcp/tools.ts                                   |  33 ++
 src/queries.ts                                     |   2 +
 src/query/change-review.ts                         | 533 +++++++++++++++++++++
 src/task-snapshots.ts                              |   2 +-
 src/types/init.ts                                  |  35 ++
 src/types/query-data.ts                            |  17 +-
 tests/change-review.test.ts                        | 223 +++++++++
 ...s-02-launches-windows-package-local-cmd.test.ts |   2 +-
 tests/github-action.test.ts                        |  21 +
 tests/init.test.ts                                 |  40 ++
 tests/mcp-advanced-auto.test.ts                    |   1 +
 21 files changed, 1270 insertions(+), 47 deletions(-)
 create mode 100644 action.yml
 create mode 100644 src/ci-workflow.ts
 create mode 100644 src/query/change-review.ts
 create mode 100644 src/types/init.ts
 create mode 100644 tests/change-review.test.ts
 create mode 100644 tests/github-action.test.ts

## Verification

- git diff --check: passed
- npm run check: passed
- npm run smoke:package: passed
- npm run package:hygiene: passed
- npm run audit: passed
- Codexa post-edit-review: passed
- Codexa test-plan: passed
- git diff --cached --check: passed
- staged safety scan: passed

## Notes

Adds one deterministic committed-change receipt shared by the CLI, MCP, and a read-only GitHub Action, with optional CI scaffolding through codexa init --ci. Includes bounded Git handling, trust-aware plan and verification evidence, package smoke coverage, and adversarial regression tests.
