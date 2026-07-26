Codexa is available through the compact core tool profile. Use Codexa at each
fixed lifecycle stage and leave response delivery automatic. Before editing,
invoke `session_context` and then `task_brief` through `capabilities`. For a
non-trivial change, call `change_plan` with `saveSnapshot: true`, invoke
`test_plan` through `capabilities` before editing, run the selected tests
yourself, and invoke `post_edit_review` through `capabilities` after the edit.
Invoke `proof_card` only for a handoff summary. Codexa output is evidence to
inspect, not a correctness verdict.
