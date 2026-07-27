# PR Summary: Harden Codexa Model Guidance

- Branch: `codex/general/codexa-019fa0eb-model-guidance`
- Base: `main` at `c7bd6943cc23e2fba1339cb54669179d4744e1bb`
- Release candidate: patch release from `0.17.0` to `0.17.1`
- Scope: 23 source and test files; 897 additions and 104 deletions before this summary artifact

## Outcome

Codexa gives models a clearer, safer path from repository orientation to bounded changes. It distinguishes exploration from edit authority, guides targetless work through search and inspection, keeps post-edit review advisory unless blocking evidence requires otherwise, and preserves evidence-backed next steps.

The delivery path now treats every target-role boundary as authority-critical. If compact, detailed, fallback, or artifact projections omit an editable, read-only, or excluded role boundary, the response fails closed, removes executable follow-up guidance, and asks the model to narrow the target before acting. A safe detailed resource remains usable when the concise receipt alone is incomplete.

The retrieval classifier also preserves normal source-change intent: `change planning logic` is edit-directed, while list-style read-only phrases such as `change planning, result compaction` remain orientation-only.

## Commits

1. `a5568878a408807d3c3c7d3137763e872aa07fd8` — `fix(mcp): harden model guidance`
2. `1971e165ab12add293ce23b4438dfe31c872e77a` — `fix(mcp): fail closed on truncated target roles`
3. `49bf0595ddf0662bcb3fe9437161715494b0b983` — `fix(retrieval): preserve planning logic edit requests`

## Risk-Budgeted Review

Independent contract and artifact-flow reviews found and closed these high-risk cases:

- Target-role loss in generic, typed, deep, array-contained, summary, fallback, and transport-limited projections.
- Unsafe detailed artifact persistence and stale visible text after authority changes.
- Leaked `nextCall` authority through raw payloads, decision-kernel scope, and MCP envelope lifecycle fields.
- False blocking caused by shared query-object aliases being mistaken for cycles; true cycles, depth exhaustion, and node-budget exhaustion still fail closed.
- A prompt-routing regression that misclassified ordinary planning-logic changes as orientation.

The final review found no remaining actionable blocker. The implementation is deliberately conservative only when a role boundary is actually absent or traversal cannot establish safety.

## Validation

- `npm run check` — passed.
- `npm run eval:ci` — passed: 21 scenarios, score 1, `rawRgBetter=0`.
- Focused MCP, retrieval, envelope, artifact-equivalence, and core-profile suites — passed: 268 tests.
- Live local core-profile MCP smoke — passed: a complete focus receipt stayed `edit_ready` with its bounded `change_plan` follow-up; role loss remained blocked.
- Release-grade security, privacy-history, bootstrap-receipt, GitHub PR checks, release automation, npm publication, and registry verification are tracked in the delivery steps below.

## Delivery and Rollback

Delivery sequence: source PR to protected `main`, Release Please patch PR, GitHub Release `v0.17.1`, npm publication, then MCP Registry publication and live package smoke.

If a post-merge issue is found, use a forward revert PR against `main`; do not force-push or rewrite release history.
