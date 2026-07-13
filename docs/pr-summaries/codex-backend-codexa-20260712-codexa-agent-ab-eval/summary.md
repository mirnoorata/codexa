# Change Summary

- Project: `codexa`
- Worktree: `/srv/worktree/codexa/codex/20260712-codexa-agent-ab-eval`
- Branch: `codex/backend/codexa-20260712-codexa-agent-ab-eval`
- Base: `main`
- Primary commit: `95bef4c`
- Subject: `fix(eval): harden agent A/B evidence`

## Changed Files

95bef4c fix(eval): harden agent A/B evidence
 README.md                                          |  51 +++--
 benchmarks/agent-ab/README.md                      |  29 ++-
 benchmarks/agent-ab/experiment.json                |   4 +-
 .../tasks/path-target-normalization/instruction.md |   5 +-
 .../solution/solution.patch                        |   7 +-
 .../path-target-normalization/tests/verify.py      |  25 ++-
 docs/guides/agent-ab.md                            |  69 ++++--
 .../plans/codexa-agent-ab-evaluation-2026-07-12.md |  74 ++++---
 ...ilot-v3.json => v0.10.0-agent-ab-pilot-v7.json} | 245 ++++++++++-----------
 scripts/agent-ab-analysis.mjs                      |  29 ++-
 scripts/agent-ab.mjs                               |  15 +-
 tests/agent-ab-analysis-validity.test.ts           |  44 ++++
 tests/agent-ab-report.test.ts                      |  12 +-
 tests/agent-ab-runner.test.ts                      |  36 +++
 14 files changed, 434 insertions(+), 211 deletions(-)
 rename reports/benchmarks/{v0.10.0-agent-ab-pilot-v3.json => v0.10.0-agent-ab-pilot-v7.json} (77%)

## Verification

- git diff --check: passed
- PYTHONDONTWRITEBYTECODE=1 npm run check: passed
- node scripts/agent-ab.mjs validate --config benchmarks/agent-ab/experiment.json: passed
- npm run package:hygiene: passed
- Codexa post-edit-review: /srv/.codex/artifacts/codexa/codex-backend-codexa-20260712-codexa-agent-ab-eval/codexa-post-edit-review.txt
- Codexa test-plan: /srv/.codex/artifacts/codexa/codex-backend-codexa-20260712-codexa-agent-ab-eval/codexa-test-plan.txt
- git diff --cached --check: passed
- staged safety scan: passed

## Notes

Addresses both automated review findings, rejects transient task artifacts before hashing, aligns the reference and verifier on raw Unicode General Category Cc, and archives only the clean v7 run. V7 is non-confirmatory: both arms passed 2/2; Codexa showed no completion benefit and used 3.54x cost, 1.88x agent time, and 5.94x input tokens. V4-v6 are excluded diagnostics. No production runtime, package dependency, bin, lockfile, or packed evaluator surface changed.
