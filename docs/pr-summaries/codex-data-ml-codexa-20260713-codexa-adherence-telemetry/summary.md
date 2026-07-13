# Change Summary

- Project: `codexa`
- Worktree: isolated task worktree
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
- Codexa post-edit-review: passed; host-local evidence retained outside the repository
- Codexa test-plan: passed; host-local evidence retained outside the repository
- git diff --cached --check: passed
- staged safety scan: passed

## Notes

Adds forward-only, agent-reported post-edit review decision telemetry to new A/B analyses. The fields are descriptive and ITT-neutral; archived v7 bytes remain frozen. Conservative correlation and partial/unknown handling prevent unsupported trajectories from becoming confident no-use claims.
