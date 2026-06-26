# Codexa Target-Aware Test Plan Fix

Status: implemented, adversarially hardened
Date: 2026-06-26

## Root Cause

Codexa promises target-led verification, but `test_plan` loses the target at
the tool boundary. Upstream tools already emit next-tool arguments such as
`{ files: [...] }`, yet the MCP and CLI `test_plan` inputs accept only `diff`
and `changeType`. When the worktree is clean, `testPlanQuery` substitutes the
first ten ranked repository files as if they were an affected scope. That turns
"no current edit scope" into broad test recommendations.

First-principles invariant:

- A verification recommendation must be tied to a concrete edit scope: current
  dirty diff, explicit target files, or a saved review scope.
- If no scope exists, Codexa should reduce uncertainty by saying no targeted
  plan exists, not create work.

Failure mode:

- Codex or Claude follows Codexa's own `test_plan` next-tool hint on a clean
  tree and receives tests for "top-ranked files." This burns tokens, creates
  unnecessary work, and teaches agents to distrust Codexa.

Trust boundary:

- MCP/CLI input is the lifecycle boundary. The tool must not infer a mutable
  verification scope from repository rank when the caller supplied no diff and
  no target.

## Six Implementation Points

1. Add explicit target-file input to the query contract.
   - `TestPlanOptions.files?: string[]`.
   - Normalize to indexed relative paths.
   - Surface unindexed or rejected targets as gaps; do not silently substitute
     ranked repository files.

2. Scope recommendations to explicit files when supplied.
   - Use explicit files before dirty diff files.
   - Preserve dirty diff grouping when `diff=true`, but do not mix clean rank
     fallback into target-led verification.

3. Fail quiet when clean and targetless.
   - If there are no explicit target files and no dirty files, return a short
     packet with no tests or verification commands.
   - Preserve freshness, worktree state, gaps, and provenance.

4. Make the structured lifecycle actionable.
   - Set `actionability: "needs_target"` for clean/no-target `test_plan`.
   - Keep normal scoped plans actionable as `verify`.

5. Align public surfaces and docs.
   - Add `files` to MCP `test_plan`.
   - Add CLI `test-plan --file`.
   - Update the tool registry so it no longer advertises "top-ranked files."

6. Add regression and eval guardrails.
   - Add tests for clean/no-target no-op behavior.
   - Add tests proving MCP file targets are accepted.
   - Add eval scoring support for max test count, then a project scenario that
     fails if clean-tree `test_plan` emits tests or bloated text.

## Adversarial Review

Finding 1: A text-only fix is insufficient.
- Rejected because envelope actionability and session-memory derivation would
  still treat a packet with tests as actionable.

Finding 2: Making concise response output the default is lower ROI.
- Rejected because a compact wrong packet still sends agents toward false work.

Finding 3: Removing `test_plan` from the primary loop is too broad.
- Rejected because post-edit verification is a core Codexa value. The defect is
  missing scope discipline, not the existence of verification planning.

Finding 4: The target should be accepted at the `test_plan` boundary, not only
upstream.
- Accepted. Upstream next-tool hints already pass `files`; the receiver must
  honor that contract.

Finding 5: Eval must fail on this class.
- Accepted. The current project eval passes clean-tree broad output because it
  only caps text length. It needs a direct no-tests constraint.

Finding 6: Silently ignoring bad explicit targets would preserve the same
contract bug in a new form.
- Accepted. Outside-repo absolute paths, Windows-absolute paths, backslash paths,
  control-character paths, and unindexed targets must be reported as gaps. They
  must not fall through to dirty diff or rank fallback when the caller
  explicitly supplied files.

## Post-Implementation Six-Point Review

1. Query contract: accepted explicit `files` targets, normalized them to
   repo-relative indexed paths, and rejected unsafe or unindexed inputs without
   falling through to ranked-file scope.
2. Scope selection: explicit targets take precedence; dirty diff remains the
   fallback only when the caller did not provide files.
3. Clean targetless behavior: no diff and no explicit target now returns a
   short no-target packet with zero tests and zero verification commands.
4. Lifecycle actionability: scoped plans return `verify`; targetless plans
   return `needs_target` and session-memory derivation skips no-op "0 tests"
   entries.
5. Public surfaces: MCP, CLI, registry text, README, architecture docs, tutorial
   guidance, and generated artifact guidance now point agents toward explicit
   targets instead of ranked fallback.
6. Guardrails: direct query tests, MCP schema/runtime tests, eval scoring, and
   session-memory tests cover the regression class.

Adversarial result after implementation: no remaining real findings in the six
points after manual review, Codexa post-edit review, and an independent
read-only adversarial subagent review.

## Verification

- Focused tests:
  - `npm run test -- tests/mcp.test.ts tests/eval.test.ts`
- Type/build:
  - `npm run typecheck`
  - `npm run build`
- Product behavior:
  - `codexa test-plan <repo> --no-auto-refresh` on a clean tree must return a
    short no-target result with no tests.
  - `codexa test-plan <repo> --file src/query/test-plan.ts --no-auto-refresh`
    must return a scoped plan.
- Codexa review:
  - `post-edit-review` against snapshot `target-aware-test-plan-20260626`.
  - `test-plan` after edits as a second-opinion gap check.

## Rollback

This change is localized to `test_plan` query inputs, CLI/MCP exposure,
registry copy, eval scoring, and tests. Reverting the commit restores the prior
rank-fallback behavior without data migration.
