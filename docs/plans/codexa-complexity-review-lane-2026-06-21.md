# Codexa Complexity Review Lane

Status: hardened for implementation
Date: 2026-06-21
Branch: `codex/general/codexa-codexa-ponytail-complexity-20260621`

## Source Facts

- Ponytail is an instruction/skill/plugin set, not a code intelligence index. Its useful mechanism is a pre-edit ladder: avoid unnecessary work, prefer standard library/native platform/already-installed dependencies, then write the minimum that works.
- Ponytail's review mode is diff-focused and limited to over-engineering: delete dead flexibility, prefer standard library or native features, avoid speculative abstractions, and shrink equivalent logic.
- Its own benchmark claim is narrower than the social-media version: measured reductions come mostly from avoiding over-built features, while safety guards must remain intact.
- Primary sources checked on 2026-06-21:
  - https://github.com/DietrichGebert/ponytail
  - https://raw.githubusercontent.com/DietrichGebert/ponytail/main/AGENTS.md
  - https://raw.githubusercontent.com/DietrichGebert/ponytail/main/skills/ponytail/SKILL.md
  - https://raw.githubusercontent.com/DietrichGebert/ponytail/main/skills/ponytail-review/SKILL.md
  - https://raw.githubusercontent.com/DietrichGebert/ponytail/main/benchmarks/results/2026-06-18-agentic.md

## Decision

Implement a Codexa-native advisory "complexity review" section inside existing `change_plan` and `post_edit_review` packets.

This should not import Ponytail, install a Ponytail dependency, add a new MCP tool, or add another agent. Codexa already controls the high-value loop: current source index, focus packets, saved snapshots, post-edit drift review, and verification ledger. The upgrade should supplement that loop with a deterministic minimality lens where it can be grounded in the current plan or dirty tree.

## Goals

- Add plan-time prompts that force agents to consider the higher rungs before writing code: do nothing, reuse existing code, standard library/native platform, already-installed dependency, smaller local edit.
- Add post-edit review signals that flag likely over-build patterns in the actual diff: new package manifests, broad file fanout, unplanned new files, abstraction-heavy names, and scope growth against the saved plan.
- Preserve Codexa's stronger invariants: freshness, source provenance, planned-vs-actual drift, required workflow/dependency checks, and runnable verification.
- Keep the review advisory. Complexity findings should guide the agent but must not mark a PR complete or block a correctness/security finding.

## Non-Goals

- No Ponytail runtime dependency or copied skill pack.
- No model call, benchmark runner, token accounting service, or agent persona.
- No standalone MCP tool in v1. Existing `change_plan` and `post_edit_review` are where agents already look before and after edits.
- No hard fail based only on naming heuristics. False positives would train agents to ignore the lane.
- No removal of validation, error handling, security, accessibility, migration safety, or tests in the name of smaller code.

## Public Contract

Add a structured `complexityReview` field to:

- `ChangePlanData`
- `PostEditReviewData`

The field should be compact, deterministic, and safe for MCP structured output:

```ts
interface ComplexityReviewData {
  schemaVersion: 1;
  phase: "plan" | "post-edit";
  status: "lean" | "review";
  blocking: false;
  summary: string;
  items: ComplexityReviewItem[];
  invariants: string[];
}
```

Each item should include:

- `kind`: `yagni`, `stdlib`, `native`, `existing-dependency`, `abstraction`, `scope`, `verification`, or `delete`
- `severity`: `info`, `watch`, or `review`
- `message`
- optional `paths`
- optional `replacement`
- `rationale`

## Implementation Shape

1. Add `src/query/complexity.ts` with pure helpers:
   - `buildPlanComplexityReview(...)`
   - `buildPostEditComplexityReview(...)`
   - `formatComplexityReview(...)`
   - `compactComplexityReview(...)` with bounded `items` and `invariants`
2. Wire plan review in `src/query/change-plan.ts` after planned edit targets/tests/checks are known.
3. Wire post-edit review in `src/query/post-edit.ts` after dirty scope, plan drift, tests, and verification are known.
4. Add types in `src/types.ts`.
5. Preserve the field through `src/query-data.ts` and `src/mcp/compaction.ts`.
6. Add focused tests in `tests/indexer.test.ts` and `tests/mcp.test.ts`.

## Heuristic Rules

Plan phase:

- If no explicit target or the packet is orientation-only, tell the agent to narrow scope before editing rather than build a broad abstraction.
- If planned targets include `package.json` or lockfiles, require dependency/change justification against standard library/native/existing installed alternatives.
- If many planned edit targets are selected, flag the scope as review-worthy and recommend splitting unless the task truly crosses that boundary.
- If no targeted tests/checks are known, keep the Ponytail-compatible invariant that non-trivial logic still needs one runnable check.
- Always state that safety, trust boundaries, accessibility, data-loss handling, and explicit user requirements are not simplification candidates.

Post-edit phase:

- Flag package manifest or lockfile changes as dependency/change-review items. Do not claim a new dependency was added unless future diff parsing proves it.
- Flag unplanned new files or broad changed-file fanout as scope-review items.
- Flag abstraction-heavy new file names (`factory`, `manager`, `registry`, `adapter`, `interface`, `abstract`) only as advisory review items.
- When existing post-edit verification says edited files have no credible proof, mirror that as a complexity invariant: smaller code without a runnable check is unfinished.
- Return `Lean already` equivalent only when no signals fire and existing post-edit review has no verification gaps.

## Verification

Targeted:

- `npm run test -- tests/indexer.test.ts tests/mcp.test.ts`
- `npm run typecheck`

Full before PR:

- `npm run check`
- Codexa `post-edit-review` against the saved task snapshot, with the commands actually run.
- Codexa `test-plan` if post-edit review reports missing verification.

## MCP Compaction Contract

- Keep `complexityReview.summary`, `status`, and `blocking` in every detailed packet.
- Bound `complexityReview.items` to 8 in normal compaction and 4 in summary-tier compaction.
- Bound `complexityReview.invariants` to 6.
- Reattach `complexityReview` in budget summary/fallback tiers when it fits, but do not let it displace `verdict`, `editReadiness`, `nextTools`, or verification provenance.

## PR Completion

- Commit on the feature worktree branch.
- Use the workspace `finish-worktree` helper or equivalent repo-native commands to produce Markdown/PDF PR summary artifacts.
- Open a GitHub PR.
- Inspect PR checks, reviews, issue comments, and review threads.
- Fix actionable Dependabot or ChatGPT bot issues until none remain.
- Merge only after required checks are green and no actionable bot review remains.

## Risks

- Heuristic overreach: names like `adapter` can be legitimate. Mitigation: advisory-only severity unless paired with scope drift or missing verification.
- Token bloat: a new section could make packets noisier. Mitigation: keep summaries short and compact arrays in MCP output.
- Safety regression: agents might delete required validation to satisfy "minimal". Mitigation: invariants explicitly forbid cutting security, validation, accessibility, data-loss handling, and explicit requirements.
- Duplicate guidance: Codexa already has verification and drift lanes. Mitigation: complexity review references existing verification instead of reimplementing it.

## Adversarial Review Rounds

Round 1 findings and fixes:

- Finding: The initial plan implied package manifest changes always mean dependency additions, but v1 has only changed file metadata, not hunk-level dependency parsing. Fix: downgraded language to dependency/change review and explicitly forbids claiming a new dependency without future diff parsing.
- Finding: The post-edit lane risked duplicating the existing verification gate. Fix: complexity review mirrors missing verification only as the minimality invariant that non-trivial code still needs one runnable check.
- Finding: The MCP behavior was underspecified. Fix: added a bounded compaction contract and priority rule so complexity metadata cannot crowd out verdict, edit readiness, routing, or provenance.
- Finding: A new helper file could become abstraction bloat. Fix: keep one pure helper only because it has two production consumers (`change_plan` and `post_edit_review`) plus MCP compaction; do not add a standalone tool, runner, or service.

Round 2 result:

- The plan is sufficiently bounded for implementation: advisory only, deterministic, no external dependency, no new agent, no token accounting claims, no safety shortcuts, and testable through existing query and MCP packet tests.
