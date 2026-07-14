# Change Summary

- Project: `codexa`
- Worktree: isolated feature checkout
- Branch: `codex/general/codexa-20260714-codexa-usefulness-repairs`
- Base: `main`
- Primary commit: `2817e73`
- Subject: `fix(workflows): harden usefulness validation`

## Changed Files

2817e73 fix(workflows): harden usefulness validation
 .github/workflows/check.yml                        |   6 +-
 .gitignore                                         |   1 +
 docs/plans/codexa-agent-utility-plan-2026-07-14.md | 340 +++++++++++++++++++++
 .../codexa-zero-loss-overhead-plan-2026-07-13.md   |  16 +-
 .../benchmarks/v0.14.0-usefulness-baseline.json    | 147 +++++++++
 scripts/benchmark-mcp-transport.mjs                |  40 ++-
 src/cli/query-commands.ts                          |   2 +-
 tests/benchmark-mcp-transport.test.ts              |  33 +-
 tests/command.test.ts                              |  15 +
 9 files changed, 574 insertions(+), 26 deletions(-)
 create mode 100644 docs/plans/codexa-agent-utility-plan-2026-07-14.md
 create mode 100644 reports/benchmarks/v0.14.0-usefulness-baseline.json

## Verification

- git diff --check: passed
- CODEXA_RUN_V012_TRANSPORT_COMPAT=1 npm run test -- tests/benchmark-mcp-transport.test.ts tests/command.test.ts: passed
- npm run check: passed
- npm run smoke:package: passed
- npm run eval:ci: passed
- npm run benchmark:ci: passed
- npm run benchmark:transport:exposure -- --repo <clean-candidate-checkout>: passed
- npm run benchmark:transport -- --repo <clean-candidate-checkout>: passed
- node scripts/agent-ab.mjs validate --config benchmarks/agent-ab/experiment.json: passed
- Codexa post-edit-review: passed (local completion artifact)
- Codexa test-plan: passed (local completion artifact)
- git diff --cached --check: passed
- staged safety scan: passed

## Notes

Repairs pinned transport benchmark reproducibility and CLI verification help, adds CI coverage, and commits an evidence-gated plan for measuring agent utility without overstating the current evidence.
