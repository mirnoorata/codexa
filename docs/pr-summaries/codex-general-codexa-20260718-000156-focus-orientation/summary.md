# Change Summary

- Project: `codexa`
- Checkout: isolated `codexa` task worktree
- Branch: `codex/general/codexa-20260718-000156-focus-orientation`
- Base: `main`
- Primary commit: `803460f`
- Subject: `perf(mcp): reduce agentic Codexa overhead`

## Changed Files

803460f perf(mcp): reduce agentic Codexa overhead
 README.md                                          | 207 ++++++++----
 docs/architecture/codexa-context-server.md         | 124 ++++---
 docs/guides/new-user-tutorial.md                   |  73 +++--
 .../codexa-zero-loss-overhead-plan-2026-07-13.md   |   5 +
 integrations/claude-code/README.md                 |  69 ++--
 integrations/claude-code/scripts/codexa-mcp.js     |   5 +-
 integrations/claude-code/scripts/session-start.sh  |  99 +++---
 integrations/claude-code/tests/cmd-smoke.sh        |  44 +++
 integrations/claude-code/tests/hook-smoke.sh       |  24 +-
 plugins/codexa/.codex-plugin/plugin.json           |  13 +-
 plugins/codexa/.mcp.json                           |   3 +-
 plugins/codexa/scripts/codexa-mcp.js               |   6 +-
 plugins/codexa/skills/codexa/SKILL.md              |  33 +-
 scripts/benchmark-mcp-transport.mjs                |  56 +++-
 scripts/verify-plugin-package.mjs                  |  22 +-
 src/artifacts.ts                                   |  42 +--
 src/cli.ts                                         |   8 +-
 src/cli/hooks.ts                                   |  74 +++--
 src/codex-contract.ts                              |  46 ++-
 src/init.ts                                        |  92 ++++--
 src/mcp-tool-catalog.ts                            |   1 +
 src/mcp.ts                                         |  45 ++-
 src/mcp/decision-kernel.ts                         |  30 +-
 src/mcp/envelope.ts                                | 129 ++++----
 src/mcp/prompts.ts                                 |  23 +-
 src/mcp/result-artifacts.ts                        |  20 +-
 src/mcp/result-budget.ts                           | 364 +++++++++++++++++++++
 src/mcp/telemetry.ts                               |  28 ++
 src/mcp/tool-registry.ts                           |  78 ++---
 src/mcp/tools.ts                                   |  14 +-
 src/query/change-plan.ts                           |  35 +-
 src/query/context.ts                               |  81 +++--
 src/query/graph-traversal.ts                       |  43 ++-
 src/query/graph.ts                                 |  24 +-
 src/query/impact.ts                                |  13 +-
 src/query/inspection.ts                            |  12 +-
 src/query/search.ts                                |  15 +-
 src/types/runtime.ts                               |   4 +-
 tests/benchmark-mcp-transport.test.ts              |  27 +-
 ...jects-malformed-integer-options-instead.test.ts |  36 +-
 ...s-02-launches-windows-package-local-cmd.test.ts |   5 +-
 tests/cli-hooks-03-suite.test.ts                   |  10 +-
 tests/cli-hooks-04-suite.test.ts                   |   2 +-
 tests/index-identity.test.ts                       |   6 +-
 ...exer-03-reserves-fixed-risk-path-symbol.test.ts |   4 +-
 ...er-04-separates-evidence-tiers-and-uses.test.ts |   3 +
 ...r-05-answers-broad-focus-graph-workflow.test.ts |  32 ++
 tests/init.test.ts                                 |  47 ++-
 tests/mcp-01-keeps-the-primary-mcp-happy.test.ts   |  59 ++--
 tests/mcp-02-does-not-let-stale-codexa.test.ts     |  30 +-
 ...p-04-reports-package-version-and-codexa.test.ts |  19 +-
 tests/mcp-05-suite.test.ts                         |  32 +-
 ...p-06-core-profile-envelopes-never-steer.test.ts |  74 ++++-
 tests/mcp-advanced-auto.test.ts                    |  37 ++-
 tests/mcp-capabilities.test.ts                     |  27 +-
 tests/mcp-decision-kernel.test.ts                  |   5 +-
 tests/mcp-envelope-guidance.test.ts                | 117 +++++++
 tests/mcp-result-artifacts.test.ts                 |   2 +-
 tests/mcp-result-budget.test.ts                    | 325 ++++++++++++++++++
 tests/mcp-telemetry.test.ts                        |  30 +-
 tests/plugin-package.test.ts                       |  37 ++-
 tests/session.test.ts                              |   5 +-
 62 files changed, 2244 insertions(+), 731 deletions(-)
 create mode 100644 src/mcp/result-budget.ts
 create mode 100644 tests/mcp-envelope-guidance.test.ts
 create mode 100644 tests/mcp-result-budget.test.ts

## Verification

- git diff --check: passed
- npm run check: passed
- npm run package:hygiene: passed
- Codexa post-edit-review: generated as a local verification artifact
- Codexa verdict replan (none) accepted over block: The saved plan predates reviewer-driven transport, documentation, and bare-launch default fixes. Codexa reports no unaccounted tests, while the full gate, package hygiene, clean transport benchmark, and two independent audits cover the integrated diff.
- Codexa test-plan: generated as a local verification artifact
- git diff --cached --check: passed
- staged safety scan: passed

## Notes

Defaults every agent launcher to the 3-tool core surface while preserving 22 logical operations through capabilities. Adds terminal guidance, managed-hook coalescing, hard ToolResult budgets, and a deterministic decoded-payload benchmark. Clean-fixture tools/list bytes fall from 68,134 to 8,745 and startup advertisement plus discovery from 87,682 to 28,293. These are decoded JSON byte proxies, not model-token measurements.
