# Change Summary

- Project: `codexa`
- Worktree: `/srv/worktree/codexa/codex/20260713-codexa-adherence-telemetry`
- Branch: `codex/data-ml/codexa-20260713-codexa-adherence-telemetry`
- Base: `main`
- Primary commit: `4fcd67c`
- Subject: `feat(eval): report post-edit decision telemetry`

## Changed Files

4fcd67c feat(eval): report post-edit decision telemetry
 benchmarks/agent-ab/README.md            |   6 +
 docs/guides/agent-ab.md                  |  58 +++-
 scripts/agent-ab-analysis.mjs            | 438 ++++++++++++++++++++++++++++++-
 tests/agent-ab-analysis-validity.test.ts | 301 ++++++++++++++++++++-
 tests/agent-ab-report.test.ts            |  12 +-
 5 files changed, 793 insertions(+), 22 deletions(-)

## Verification

- git diff --check: passed
- npm run check: passed
- Codexa post-edit-review: /srv/.codex/artifacts/codexa/codex-data-ml-codexa-20260713-codexa-adherence-telemetry/codexa-post-edit-review.txt
- Codexa test-plan: /srv/.codex/artifacts/codexa/codex-data-ml-codexa-20260713-codexa-adherence-telemetry/codexa-test-plan.txt
- git diff --cached --check: passed
- staged safety scan: passed

## Notes

Adds forward-only, agent-reported post_edit_review decision telemetry to new A/B analyses. The fields are descriptive and ITT-neutral; archived v7 bytes remain frozen. Conservative correlation and partial/unknown handling prevent unsupported trajectories from becoming confident no-use claims.
