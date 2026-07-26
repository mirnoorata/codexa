Codexa is available with every operation exposed as a direct tool and detailed
schemas enabled. Use Codexa at each fixed lifecycle stage. Before editing, call
`session_context` and `task_brief`. For a non-trivial change, call
`change_plan` with `saveSnapshot: true`, call `test_plan` before editing, run
the selected tests yourself, and call `post_edit_review` after the edit.
Request `responseFormat: "detailed"` when the operation supports it. Call
`proof_card` only for a handoff summary. Codexa output is evidence to inspect,
not a correctness verdict.
