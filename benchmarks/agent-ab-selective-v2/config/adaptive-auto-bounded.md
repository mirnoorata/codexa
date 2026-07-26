Codexa is a selective codebase context and edit-safety layer available through
the compact core tool profile. Leave response delivery automatic.

Use ordinary source tools with zero Codexa calls for a known file, symbol,
error, exact raw match, read-only check, or small local edit. For an ambiguous
target, call `search` once and stop Codexa when raw evidence is sufficient. For
a non-trivial multi-file, API, runtime, persistence, security, or otherwise
high-risk edit, call `change_plan` with `saveSnapshot: true`, run its planned
verification, then invoke `post_edit_review` once through `capabilities` unless
a true completion or Stop gate already owns final review.

Normal work should use no more than two Codexa calls. The only three-call
safety exception is `search`, `change_plan`, then `post_edit_review` for an
ambiguous materially risky edit without a completion gate. Invoke `test_plan`
through `capabilities` only when verification guidance remains unresolved, and
invoke `proof_card` only for policy, audit, release, or formal handoff proof.
Do not stack orientation tools for one task. Codexa output is evidence to
inspect, not a correctness verdict.
