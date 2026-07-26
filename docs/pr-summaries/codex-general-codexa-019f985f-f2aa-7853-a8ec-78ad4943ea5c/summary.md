# Change Summary

- Project: `codexa`
- Checkout: isolated `codexa` task worktree
- Branch: `codex/general/codexa-019f985f-f2aa-7853-a8ec-78ad4943ea5c`
- Base: `main`
- Primary commit: `76688b4`
- Subject: `feat(workflow): harden selective Codexa execution`

## Changed Files

76688b4 feat(workflow): harden selective Codexa execution
 benchmarks/agent-ab-selective-v2/README.md         |  53 +++
 .../config/adaptive-auto-bounded.mcp.json          |   8 +
 .../config/adaptive-auto-bounded.md                |  18 +
 .../config/adaptive-auto-legacy.mcp.json           |   8 +
 .../config/adaptive-auto-legacy.md                 |   8 +
 .../config/full-detailed-legacy.mcp.json           |   8 +
 .../config/full-detailed-legacy.md                 |   8 +
 benchmarks/agent-ab-selective-v2/experiment.json   |  92 +++++
 .../environment/Dockerfile                         |  21 ++
 .../environment/project/.gitignore                 |   3 +
 .../environment/project/README.md                  |  10 +
 .../environment/project/src/__init__.py            |   1 +
 .../environment/project/src/targets.py             |  11 +
 .../environment/project/tests/test_targets.py      |  14 +
 .../start-codexa-mcp-adaptive-auto-bounded.sh      |  41 +++
 .../start-codexa-mcp-adaptive-auto-legacy.sh       |  41 +++
 .../start-codexa-mcp-full-detailed-legacy.sh       |  41 +++
 .../tasks/path-target-normalization/instruction.md |  14 +
 .../solution/solution.patch                        |  36 ++
 .../path-target-normalization/solution/solve.sh    |   4 +
 .../tasks/path-target-normalization/task.toml      |  32 ++
 .../path-target-normalization/tests/Dockerfile     |  16 +
 .../tests/baseline/.gitignore                      |   3 +
 .../tests/baseline/README.md                       |  10 +
 .../tests/baseline/src/__init__.py                 |   1 +
 .../tests/baseline/src/targets.py                  |  11 +
 .../tests/baseline/tests/test_targets.py           |  14 +
 .../tests/candidate_runner.py                      |  67 ++++
 .../tests/public_test_runner.py                    |  53 +++
 .../tasks/path-target-normalization/tests/test.sh  |   7 +
 .../path-target-normalization/tests/verify.py      | 398 +++++++++++++++++++++
 docs/architecture/codexa-context-server.md         |  13 +-
 docs/architecture/session-memory.md                |  56 +--
 docs/guides/agent-ab.md                            | 110 +++++-
 scripts/agent-ab-analysis.mjs                      | 322 ++++++++++++++++-
 scripts/agent-ab.mjs                               | 118 +++++-
 src/language.ts                                    |   3 +-
 src/mcp/compaction.ts                              |   8 +-
 src/mcp/decision-kernel.ts                         |  31 +-
 src/mcp/decision-policy.ts                         |  45 +++
 src/mcp/review-coverage-kernel.ts                  |  44 +++
 src/post-edit-outcomes.ts                          |  47 ++-
 src/post-edit-review-coverage.ts                   | 164 +++++++++
 src/prove.ts                                       |  12 +
 src/query-data.ts                                  |   1 +
 src/query/post-edit.ts                             |  42 ++-
 src/query/post-edit/decision.ts                    |  21 +-
 src/query/post-edit/lifecycle.ts                   |   5 +
 src/query/post-edit/next-actions.ts                |   9 +-
 src/query/post-edit/support.ts                     |  22 ++
 src/task-lifecycle.ts                              |   3 +
 src/types/query-data.ts                            |  10 +-
 src/types/verification.ts                          |  26 ++
 tests/agent-ab-report.test.ts                      |  36 ++
 tests/agent-ab-v2-identity.test.ts                 | 251 ++++++++++++-
 tests/agent-ab-v2.test.ts                          |  27 +-
 ...r-01-ranks-transitive-import-hubs-above.test.ts |  41 +++
 ...exer-06-keeps-planned-post-edit-reviews.test.ts |  18 +
 tests/language.test.ts                             |  29 ++
 tests/mcp-decision-kernel.test.ts                  |  84 ++++-
 tests/mcp-result-budget.test.ts                    |  14 +
 tests/post-edit-review-coverage-validation.test.ts | 263 ++++++++++++++
 tests/post-edit-review-coverage.test.ts            | 347 ++++++++++++++++++
 tests/task-lifecycle-ordering.test.ts              |  64 ++++
 64 files changed, 3216 insertions(+), 122 deletions(-)
 create mode 100644 benchmarks/agent-ab-selective-v2/README.md
 create mode 100644 benchmarks/agent-ab-selective-v2/config/adaptive-auto-bounded.mcp.json
 create mode 100644 benchmarks/agent-ab-selective-v2/config/adaptive-auto-bounded.md
 create mode 100644 benchmarks/agent-ab-selective-v2/config/adaptive-auto-legacy.mcp.json
 create mode 100644 benchmarks/agent-ab-selective-v2/config/adaptive-auto-legacy.md
 create mode 100644 benchmarks/agent-ab-selective-v2/config/full-detailed-legacy.mcp.json
 create mode 100644 benchmarks/agent-ab-selective-v2/config/full-detailed-legacy.md
 create mode 100644 benchmarks/agent-ab-selective-v2/experiment.json
 create mode 100644 benchmarks/agent-ab-selective-v2/tasks/path-target-normalization/environment/Dockerfile
 create mode 100644 benchmarks/agent-ab-selective-v2/tasks/path-target-normalization/environment/project/.gitignore
 create mode 100644 benchmarks/agent-ab-selective-v2/tasks/path-target-normalization/environment/project/README.md
 create mode 100644 benchmarks/agent-ab-selective-v2/tasks/path-target-normalization/environment/project/src/__init__.py
 create mode 100644 benchmarks/agent-ab-selective-v2/tasks/path-target-normalization/environment/project/src/targets.py
 create mode 100644 benchmarks/agent-ab-selective-v2/tasks/path-target-normalization/environment/project/tests/test_targets.py
 create mode 100644 benchmarks/agent-ab-selective-v2/tasks/path-target-normalization/environment/start-codexa-mcp-adaptive-auto-bounded.sh
 create mode 100644 benchmarks/agent-ab-selective-v2/tasks/path-target-normalization/environment/start-codexa-mcp-adaptive-auto-legacy.sh
 create mode 100644 benchmarks/agent-ab-selective-v2/tasks/path-target-normalization/environment/start-codexa-mcp-full-detailed-legacy.sh
 create mode 100644 benchmarks/agent-ab-selective-v2/tasks/path-target-normalization/instruction.md
 create mode 100644 benchmarks/agent-ab-selective-v2/tasks/path-target-normalization/solution/solution.patch
 create mode 100644 benchmarks/agent-ab-selective-v2/tasks/path-target-normalization/solution/solve.sh
 create mode 100644 benchmarks/agent-ab-selective-v2/tasks/path-target-normalization/task.toml
 create mode 100644 benchmarks/agent-ab-selective-v2/tasks/path-target-normalization/tests/Dockerfile
 create mode 100644 benchmarks/agent-ab-selective-v2/tasks/path-target-normalization/tests/baseline/.gitignore
 create mode 100644 benchmarks/agent-ab-selective-v2/tasks/path-target-normalization/tests/baseline/README.md
 create mode 100644 benchmarks/agent-ab-selective-v2/tasks/path-target-normalization/tests/baseline/src/__init__.py
 create mode 100644 benchmarks/agent-ab-selective-v2/tasks/path-target-normalization/tests/baseline/src/targets.py
 create mode 100644 benchmarks/agent-ab-selective-v2/tasks/path-target-normalization/tests/baseline/tests/test_targets.py
 create mode 100644 benchmarks/agent-ab-selective-v2/tasks/path-target-normalization/tests/candidate_runner.py
 create mode 100644 benchmarks/agent-ab-selective-v2/tasks/path-target-normalization/tests/public_test_runner.py
 create mode 100644 benchmarks/agent-ab-selective-v2/tasks/path-target-normalization/tests/test.sh
 create mode 100644 benchmarks/agent-ab-selective-v2/tasks/path-target-normalization/tests/verify.py
 create mode 100644 src/mcp/review-coverage-kernel.ts
 create mode 100644 src/post-edit-review-coverage.ts
 create mode 100644 tests/language.test.ts
 create mode 100644 tests/post-edit-review-coverage-validation.test.ts
 create mode 100644 tests/post-edit-review-coverage.test.ts
 create mode 100644 tests/task-lifecycle-ordering.test.ts

## Verification

- git diff --check: passed
- rtk npm run check: passed
- rtk npm run smoke:package: passed
- rtk proxy node scripts/agent-ab.mjs validate --config benchmarks/agent-ab-selective-v2/experiment.json: passed
- (cd benchmarks/agent-ab-selective-v2/tasks/path-target-normalization/environment/project && PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s tests -v): passed
- SOLUTION_CHECK_DIR="$(mktemp -d /tmp/codexa-solution-check.XXXXXX)"; mkdir -p "$SOLUTION_CHECK_DIR/src"; cp benchmarks/agent-ab-selective-v2/tasks/path-target-normalization/tests/baseline/src/targets.py "$SOLUTION_CHECK_DIR/src/targets.py"; git -C "$SOLUTION_CHECK_DIR" apply --check --unidiff-zero "$PWD/benchmarks/agent-ab-selective-v2/tasks/path-target-normalization/solution/solution.patch"; git -C "$SOLUTION_CHECK_DIR" apply --unidiff-zero "$PWD/benchmarks/agent-ab-selective-v2/tasks/path-target-normalization/solution/solution.patch"; PYTHONPATH="$SOLUTION_CHECK_DIR" PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s benchmarks/agent-ab-selective-v2/tasks/path-target-normalization/environment/project/tests -v: passed
- Codexa post-edit-review: generated as a local verification artifact
- Codexa verdict replan (none) accepted over block: The saved machine snapshot intentionally covered the core authority paths rather than the final four-workstream diff; all six invariants have explicit evidence, the full deterministic gate passes, and the budgeted protocol and authority reviews are clean after the substitution-path fix.
- git diff --cached --check: passed
- staged safety scan: passed

## Notes

Fixes #119

Implements four bounded improvements:
- fail-closed post-edit coverage bound to task, snapshot, candidate order, and analyzed targets;
- a public no-spend schema-v2 four-arm conformance pack pinned to Codexa 0.17.0;
- recovery-only session-memory guidance;
- truthful file-only C#, C/C++, Ruby, and PHP lanes.

Risk-budgeted review: the protocol specialist was clean; the authority specialist found a target-substitution laundering path, the validator and all-surfaces regression were corrected, and the affected rereview is clean. No new dependency, source-writing MCP capability, paid model call, or configuration toggle is introduced. Release deployment remains on the normal Release Please lane.
