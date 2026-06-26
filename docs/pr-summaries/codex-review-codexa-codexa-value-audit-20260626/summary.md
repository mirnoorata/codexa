# Change Summary

- Project: `codexa`
- Worktree: `isolated codexa worktree`
- Branch: `codex/review/codexa-codexa-value-audit-20260626`
- Base: `main`
- Primary commit: `893d343`
- Subject: `fix(test-plan): require explicit verification scope`

## Summary

Codexa `test_plan` now requires a real verification scope instead of inventing
work from ranked repository files. It accepts explicit target files through CLI
and MCP, validates unsafe or unindexed targets as gaps, and returns
`needs_target` with no tests or commands when there is no diff and no explicit
target.

The change also aligns docs, generated guidance, eval scoring, and session
memory so targetless no-op plans do not become durable verification noise.

## Changed Areas

- `src/query/test-plan.ts`: target-aware scope selection and no-target behavior.
- `src/mcp/tools.ts`, `src/cli.ts`, `src/types.ts`, `src/mcp/compaction.ts`:
  public contract and structured output updates.
- `src/eval.ts`, `src/eval/scoring.ts`, `src/eval/types.ts`: eval guardrail for
  clean/no-scope test plans.
- `src/session-memory/derivation.ts`: suppress no-op targetless test-plan memory.
- `README.md`, `docs/architecture/codexa-context-server.md`,
  `docs/guides/new-user-tutorial.md`, `src/artifacts.ts`: guidance now points
  agents to explicit files before verification planning.
- `tests/*`: regression coverage for query, MCP, eval, and session-memory paths.
- `docs/plans/codexa-target-aware-test-plan-2026-06-26.md`: saved root-cause
  plan and adversarial hardening review.

## Verification

- `npm run check`: passed.
- `npm run eval:ci`: passed, 21 scenarios, score 1, rawRgBetter 0.
- CLI clean/no-target probe: returned `needs_target`, 0 tests, 0 commands.
- CLI explicit target probe: returned a scoped plan for `src/query/test-plan.ts`.
- Invalid-target dirty-tree probe: rejected `../outside.ts` and did not fall
  back to dirty diff tests.
- Final Codexa clean `test-plan`: fresh, targetless, no invented work.

## Review Notes

- The branch is intentionally one functional commit plus this summary artifact
  commit.
- Generated local Codexa cache and codebase artifacts are ignored and are not
  part of the PR.
