# Change Summary

- Project: `codexa`
- Worktree: isolated session worktree
- Branch: `codex/backend/codexa-20260713-codexa-zero-loss-overhead`
- Base: `main`
- Primary commit: `91c88cd`
- Subject: `feat(mcp): reduce agent overhead without capability loss`

## Changed Files

91c88cd feat(mcp): reduce agent overhead without capability loss
 README.md                                          |  147 +-
 benchmarks/agent-ab/README.md                      |   71 +-
 .../support/mcp-initialize-tools-list-smoke.mjs    |  188 +++
 docs/architecture/codexa-context-server.md         |   75 +-
 docs/architecture/session-memory.md                |   13 +-
 docs/guides/agent-ab.md                            |  240 +++-
 docs/guides/new-user-tutorial.md                   |   17 +-
 .../codexa-zero-loss-overhead-plan-2026-07-13.md   |  554 ++++++++
 integrations/claude-code/README.md                 |   14 +-
 package.json                                       |    2 +
 plugins/codexa/skills/codexa/SKILL.md              |    8 +-
 scripts/agent-ab-analysis.mjs                      | 1408 +++++++++++++++++++-
 scripts/agent-ab.mjs                               |  761 +++++++++--
 scripts/benchmark-mcp-transport.mjs                |  495 +++++++
 scripts/verify-plugin-package.mjs                  |    4 +-
 src/artifacts.ts                                   |   11 +-
 src/cli.ts                                         |    4 +-
 src/cli/hooks.ts                                   |   46 +-
 src/codex-contract.ts                              |   21 +-
 src/freshness-authority.ts                         |   12 +
 src/init.ts                                        |   15 +-
 src/mcp.ts                                         |  488 ++++++-
 src/mcp/advanced-mode-kernel.ts                    |  497 +++++++
 src/mcp/capability-kernel.ts                       |  106 ++
 src/mcp/compaction.ts                              |  160 ++-
 src/mcp/decision-guidance.ts                       |   75 ++
 src/mcp/decision-kernel.ts                         |  954 +++++++++++++
 src/mcp/decision-policy.ts                         |  107 ++
 src/mcp/envelope.ts                                |   66 +-
 src/mcp/resources.ts                               |   90 +-
 src/mcp/result-artifacts.ts                        |  844 ++++++++++++
 src/mcp/telemetry.ts                               |  340 +++++
 src/mcp/tool-registry.ts                           |   44 +-
 src/mcp/tools.ts                                   |  304 ++++-
 src/query/change-plan.ts                           |  139 +-
 src/query/post-edit.ts                             |   99 +-
 src/query/post-edit/lifecycle.ts                   |    2 +
 src/query/post-edit/next-actions.ts                |    1 -
 src/query/runtime.ts                               |   61 +-
 src/session-memory/runtime.ts                      |   85 +-
 src/task-snapshots.ts                              |    4 +-
 tests/agent-ab-report.test.ts                      |    3 +-
 tests/agent-ab-v2-identity.test.ts                 |  167 +++
 tests/agent-ab-v2.test.ts                          | 1191 +++++++++++++++++
 tests/benchmark-mcp-transport.test.ts              |   93 ++
 ...jects-malformed-integer-options-instead.test.ts |   34 +-
 ...s-02-launches-windows-package-local-cmd.test.ts |    8 +-
 ...exer-06-keeps-planned-post-edit-reviews.test.ts |    6 +-
 tests/init.test.ts                                 |   28 +-
 tests/mcp-01-keeps-the-primary-mcp-happy.test.ts   |   47 +-
 tests/mcp-02-does-not-let-stale-codexa.test.ts     |  121 +-
 ...3-records-truncation-metadata-when-post.test.ts |    8 +-
 ...p-04-reports-package-version-and-codexa.test.ts |   76 +-
 tests/mcp-05-suite.test.ts                         |  190 ++-
 ...p-06-core-profile-envelopes-never-steer.test.ts |    7 +-
 tests/mcp-advanced-auto.test.ts                    |  233 ++++
 tests/mcp-capabilities.test.ts                     |  240 ++++
 tests/mcp-decision-equivalence.test.ts             |  417 ++++++
 tests/mcp-decision-kernel.test.ts                  |  409 ++++++
 tests/mcp-result-artifacts.test.ts                 |  362 +++++
 tests/mcp-telemetry.test.ts                        |  340 +++++
 ...records-bounded-entries-with-provenance.test.ts |   59 +
 tests/task-lifecycle.test.ts                       |  120 +-
 63 files changed, 12201 insertions(+), 530 deletions(-)
 create mode 100644 benchmarks/agent-ab/support/mcp-initialize-tools-list-smoke.mjs
 create mode 100644 docs/plans/codexa-zero-loss-overhead-plan-2026-07-13.md
 create mode 100644 scripts/benchmark-mcp-transport.mjs
 create mode 100644 src/freshness-authority.ts
 create mode 100644 src/mcp/advanced-mode-kernel.ts
 create mode 100644 src/mcp/capability-kernel.ts
 create mode 100644 src/mcp/decision-guidance.ts
 create mode 100644 src/mcp/decision-kernel.ts
 create mode 100644 src/mcp/decision-policy.ts
 create mode 100644 src/mcp/result-artifacts.ts
 create mode 100644 src/mcp/telemetry.ts
 create mode 100644 tests/agent-ab-v2-identity.test.ts
 create mode 100644 tests/agent-ab-v2.test.ts
 create mode 100644 tests/benchmark-mcp-transport.test.ts
 create mode 100644 tests/mcp-advanced-auto.test.ts
 create mode 100644 tests/mcp-capabilities.test.ts
 create mode 100644 tests/mcp-decision-equivalence.test.ts
 create mode 100644 tests/mcp-decision-kernel.test.ts
 create mode 100644 tests/mcp-result-artifacts.test.ts
 create mode 100644 tests/mcp-telemetry.test.ts

## Verification

- git diff --check: passed
- npm run check: passed
- npm run benchmark:ci: passed
- npm run smoke:package: passed
- npm run eval:ci on clean commit: passed 21 scenarios; score 1; rawRgBetter=0
- npm run security:check on clean commit: passed; 0 audit vulnerabilities
- Codexa post-edit-review: passed; local artifact retained outside the repository
- Codexa test-plan: passed; local artifact retained outside the repository
- git diff --cached --check: passed
- staged safety scan: passed

## Notes

Implements decision-safe compact delivery, full logical capability through core exposure, bounded lifecycle and artifacts, generic loop controls, and schema-v2 agent evaluation. Includes a pinned v0.12.0 transport reproducer with explicit claim boundaries.
