---
name: codexa
description: Use Codexa selectively for ambiguous, cross-cutting, or high-risk repository work that needs search, change planning, dependency context, or verification guidance beyond exact source inspection.
---

# Codexa Workflow

Use this skill when repository work needs context beyond direct source inspection. Codexa is an escalation path for ambiguity and material change risk, not a mandatory ceremony around every edit.

## Operating Rules

1. Resolve the active repository first. If the repo has `.codex/config.toml`, use the project-local Codexa MCP server. If the MCP server is unavailable, run the equivalent `codexa` CLI command from the repository.
2. Use zero Codexa calls for exact-target, local, read-only, or otherwise source-sufficient work. Read the named files and symbols directly, then use repository-native tests and tools.
3. When the target is ambiguous, make one `search` call. If its raw search result is sufficient, stop discovery and work from those exact hits. A materially risky edit may still justify one `change_plan` after source establishes the target. Do not stack `session_context`, `search`, and `task_brief` for the same discovery need.
4. A normal bounded task should usually use no more than two Codexa calls. Choose the smallest useful sequence: `change_plan` alone for an exact materially risky edit with a true completion/Stop gate; `search -> change_plan` when that edit target is ambiguous and such a gate owns final review; or `change_plan -> capabilities(action=invoke, operation=post_edit_review, arguments={taskId})` when an exact task has no completion/Stop gate. The only three-call exception adds that same dispatcher invocation after `search -> change_plan` when the target is ambiguous, the edit is materially risky, and no completion/Stop gate exists.
5. Use `capabilities` with `action="invoke"`, `operation="session_context"`, and `arguments={}` only for genuinely broad work or resumed work after context loss. It replaces the discovery call; it is not a ritual prerequisite.
6. Use `capabilities` only when shared-surface risk cannot be resolved from direct source inspection, and always include concrete operation arguments: a known `symbol` for `symbol_context`; a known `file` or `symbol` for `impact`, `callers`, or `callees`; a `query`, `file`, or `symbol` for `workflow_path`; or both directed endpoints for `dependency_path`. Each invocation counts against the call budget.
7. Before a non-trivial, cross-cutting, API, runtime, rename, or delete change, call `change_plan` with `saveSnapshot=true`. Run the returned verification commands.
8. Do not manually invoke `capabilities` with `action="invoke"`, `operation="post_edit_review"`, and `arguments={taskId,...actualEvidence}` when a true completion/Stop hook, such as the Claude plugin's Stop hook, already owns final review. The edit-only hooks written by `codexa init` run before later shell verification and do not suppress one final review. This Codex plugin does not ship a hook; without a completion gate, use at most one final review and pass only commands or reports that were actually run. Treat degraded snapshot tests as evidence to inspect or rerun, not trusted coverage.
9. Invoke `capabilities` with `action="invoke"`, `operation="test_plan"`, and explicit `arguments` such as `{diff:true}` only when verification guidance remains unresolved. Use the same action with `operation="proof_card"` and its concrete scope arguments only for policy changes, formal audits, releases, artifact handoffs, or decision-integrity proof.
10. In optimized/core mode, use `capabilities` to discover or invoke any non-core operation. Full mode exposes those operations directly but increases the advertised schema surface; both paths use the same validation and handler.
11. Do not automatically chain from one Codexa result to another. A suggested tool name is conditional guidance, not permission to spend another call; continue only for unresolved ambiguity, material risk, or a missing managed review gate.

## Thin Adapter Rules

1. Keep host adapters thin. They should launch the shared Codexa MCP server or CLI and should not add independent planning, ranking, indexing, or source-editing behavior.
2. Codexa MCP tools may write generated `.codex/` cache artifacts, but there must be no source-mutating MCP tool path.
3. Do not add broad host-specific tools when the primary MCP path or an existing advanced tool can answer the need.

## CLI Fallbacks

Use these commands from the target repository when MCP is not available:

```bash
codexa session-context .
codexa search . --query "<task, literal, or symbol>"
codexa brief . --task "<task>"
codexa explain . --symbol "<symbol_or_stable_id>"
codexa impact . --symbol "<symbol_or_stable_id>"
codexa change-plan . --task "<task>" --save-snapshot --task-id "<task_id>"
codexa post-edit-review . --task-id "<task_id>" --ran-command "<command>"
codexa test-plan .
codexa prove . --task "<task>" --task-id "<task_id>" --ran-command "<command>"
codexa serve . --transport http --host 127.0.0.1 --port 8729 --tools core
```

Prefer `--task-id` for a necessary final `post-edit-review` so Codexa can
compare against the saved snapshot. Use `post-edit-review . --task "<task>" ...`
only when no snapshot exists. Set `CODEXA_PLUGIN_TOOLS=full` only when direct
access to every non-core tool is worth the larger advertised schema surface.

Use `--no-auto-refresh` only when the host requires strict filesystem-read-only metadata. The default auto-refresh mode may update generated Codexa cache artifacts under `.codex/`, but it does not mutate source files.
