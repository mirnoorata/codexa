# Change Summary

- Project: `codexa`
- Worktree: local session path omitted
- Branch: `codex/backend/codexa-20260712-codexa-agent-ab-eval`
- Base: `main`
- Primary commit: `ab7c3c2`
- Subject: `feat(eval): add external agent A/B harness`

## Changed Files

ab7c3c2 feat(eval): add external agent A/B harness
 .gitattributes                                     |    1 +
 README.md                                          |   42 +
 benchmarks/agent-ab/README.md                      |   73 ++
 benchmarks/agent-ab/config/codexa-instructions.md  |    6 +
 benchmarks/agent-ab/config/codexa.mcp.json         |    8 +
 benchmarks/agent-ab/experiment.json                |   45 +
 .../environment/Dockerfile                         |   20 +
 .../environment/codexa-mcp-entrypoint.sh           |   39 +
 .../environment/project/.gitignore                 |    3 +
 .../environment/project/README.md                  |   10 +
 .../environment/project/src/__init__.py            |    1 +
 .../environment/project/src/targets.py             |   11 +
 .../environment/project/tests/test_targets.py      |   14 +
 .../tasks/path-target-normalization/instruction.md |   13 +
 .../solution/solution.patch                        |   38 +
 .../path-target-normalization/solution/solve.sh    |    4 +
 .../tasks/path-target-normalization/task.toml      |   32 +
 .../path-target-normalization/tests/Dockerfile     |   16 +
 .../tests/baseline/.gitignore                      |    3 +
 .../tests/baseline/README.md                       |   10 +
 .../tests/baseline/src/__init__.py                 |    1 +
 .../tests/baseline/src/targets.py                  |   11 +
 .../tests/baseline/tests/test_targets.py           |   14 +
 .../tests/candidate_runner.py                      |   71 ++
 .../tests/public_test_runner.py                    |   53 +
 .../tasks/path-target-normalization/tests/test.sh  |    7 +
 .../path-target-normalization/tests/verify.py      |  377 ++++++
 docs/guides/agent-ab.md                            |  285 +++++
 docs/guides/eval-gate.md                           |   11 +
 .../plans/codexa-agent-ab-evaluation-2026-07-12.md |  200 ++++
 reports/benchmarks/v0.10.0-agent-ab-pilot-v3.json  |  685 +++++++++++
 scripts/agent-ab-analysis.mjs                      |  993 ++++++++++++++++
 scripts/agent-ab.mjs                               | 1257 ++++++++++++++++++++
 tests/agent-ab-analysis-validity.test.ts           |  567 +++++++++
 tests/agent-ab-report.test.ts                      |  467 ++++++++
 tests/agent-ab-runner.test.ts                      |  620 ++++++++++
 tests/agent-ab.test.ts                             |  307 +++++
 37 files changed, 6315 insertions(+)
 create mode 100644 benchmarks/agent-ab/README.md
 create mode 100644 benchmarks/agent-ab/config/codexa-instructions.md
 create mode 100644 benchmarks/agent-ab/config/codexa.mcp.json
 create mode 100644 benchmarks/agent-ab/experiment.json
 create mode 100644 benchmarks/agent-ab/tasks/path-target-normalization/environment/Dockerfile
 create mode 100644 benchmarks/agent-ab/tasks/path-target-normalization/environment/codexa-mcp-entrypoint.sh
 create mode 100644 benchmarks/agent-ab/tasks/path-target-normalization/environment/project/.gitignore
 create mode 100644 benchmarks/agent-ab/tasks/path-target-normalization/environment/project/README.md
 create mode 100644 benchmarks/agent-ab/tasks/path-target-normalization/environment/project/src/__init__.py
 create mode 100644 benchmarks/agent-ab/tasks/path-target-normalization/environment/project/src/targets.py
 create mode 100644 benchmarks/agent-ab/tasks/path-target-normalization/environment/project/tests/test_targets.py
 create mode 100644 benchmarks/agent-ab/tasks/path-target-normalization/instruction.md
 create mode 100644 benchmarks/agent-ab/tasks/path-target-normalization/solution/solution.patch
 create mode 100644 benchmarks/agent-ab/tasks/path-target-normalization/solution/solve.sh
 create mode 100644 benchmarks/agent-ab/tasks/path-target-normalization/task.toml
 create mode 100644 benchmarks/agent-ab/tasks/path-target-normalization/tests/Dockerfile
 create mode 100644 benchmarks/agent-ab/tasks/path-target-normalization/tests/baseline/.gitignore
 create mode 100644 benchmarks/agent-ab/tasks/path-target-normalization/tests/baseline/README.md
 create mode 100644 benchmarks/agent-ab/tasks/path-target-normalization/tests/baseline/src/__init__.py
 create mode 100644 benchmarks/agent-ab/tasks/path-target-normalization/tests/baseline/src/targets.py
 create mode 100644 benchmarks/agent-ab/tasks/path-target-normalization/tests/baseline/tests/test_targets.py
 create mode 100644 benchmarks/agent-ab/tasks/path-target-normalization/tests/candidate_runner.py
 create mode 100644 benchmarks/agent-ab/tasks/path-target-normalization/tests/public_test_runner.py
 create mode 100644 benchmarks/agent-ab/tasks/path-target-normalization/tests/test.sh
 create mode 100644 benchmarks/agent-ab/tasks/path-target-normalization/tests/verify.py
 create mode 100644 docs/guides/agent-ab.md
 create mode 100644 docs/plans/codexa-agent-ab-evaluation-2026-07-12.md
 create mode 100644 reports/benchmarks/v0.10.0-agent-ab-pilot-v3.json
 create mode 100644 scripts/agent-ab-analysis.mjs
 create mode 100644 scripts/agent-ab.mjs
 create mode 100644 tests/agent-ab-analysis-validity.test.ts
 create mode 100644 tests/agent-ab-report.test.ts
 create mode 100644 tests/agent-ab-runner.test.ts
 create mode 100644 tests/agent-ab.test.ts

## Verification

- git diff --check: passed
- PYTHONDONTWRITEBYTECODE=1 npm run check: passed
- Codexa post-edit-review: completed; local artifact omitted
- Codexa test-plan: completed; local artifact omitted
- git diff --cached --check: passed
- staged safety scan: passed

## Notes

Adds a source-only Harbor 0.18.0 control/treatment harness for measuring Codexa's effect on coding-agent task completion with an external no-network verifier. Archives the non-confirmatory GPT-5.6 Sol v3 pilot: both arms completed 2/2, while treatment used 3.88x reported cost, 2.28x agent time, and 8.15x input tokens. The docs explicitly limit this to one easy task and disclose that the registered control-character oracle covered ASCII C0 plus DEL, not Unicode C1. No Codexa production src, dependency, bin, manifest, lockfile, or packed evaluator surface changes.
