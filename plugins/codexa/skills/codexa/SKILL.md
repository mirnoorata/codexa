---
name: codexa
description: Use Codexa's repository context server for first-class hybrid semantic search, task briefs, change plans, post-edit reviews, dependency/workflow tracing, verification planning, and evidence review before or after code edits.
---

# Codexa Workflow

Use this skill when a task involves understanding, editing, reviewing, or verifying a repository that has Codexa installed or available through the Codexa MCP server.

## Operating Rules

1. Resolve the active repository first. If the repo has `.codex/config.toml`, use the project-local Codexa MCP server. If the MCP server is unavailable, run the equivalent `codexa` CLI command from the repository.
2. Primary Codexa path for an explicit bounded task: `change_plan(saveSnapshot) -> edit/run planned verification -> post_edit_review`. Add `session_context`/`search`/`task_brief` only when target or context is unclear, `test_plan` only when verification guidance is unresolved, and `proof_card` only for policy or formal handoff.
3. For broad tasks, call `session_context` first. If the target is unclear or `actionability` says `needs_target`, `raw_search_better`, or `raw_search_sufficient`, use first-class `search` or ask for an explicit target before planning edits.
4. For code edits, debugging, reviews, or non-trivial refactors, call `search` first when the target is unclear. If a plausible target still lacks safe repository context, call `task_brief`; otherwise call `change_plan` directly.
5. For symbol-level changes, call `symbol_context` or `impact` when you need callers, callees, implementations, tests, risks, edge evidence, or the next exact Codexa tool.
6. Before non-trivial edits, call `change_plan` with `saveSnapshot=true` so Codexa can compare the plan with the final dirty tree and planned-test provenance.
7. After edits, call go-to `post_edit_review` before the final response and pass any commands or test reports that were actually run. Treat degraded snapshot tests as evidence to inspect or rerun, not as trusted coverage. MCP `post_edit_review` is review-only; AutoVerify execution is limited to the Codexa hook path when the user environment enables it.
8. For workflow/runtime/API/rename/delete changes, use `workflow_path`, `callers`, `callees`, or `dependency_path` before editing shared surfaces.
9. Run the tests and commands returned by `change_plan`; call `test_plan` only when that verification surface remains unclear.
10. Call `proof_card` for policy changes, formal audits, releases, artifact handoffs, or decision-integrity proof, not as a mandatory final call for every edit.
11. In optimized/core mode, use `capabilities` to discover or invoke any advanced operation. Full mode also exposes every advanced tool directly; both paths use the same operation-specific validation and handler.

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
codexa serve . --transport http --host 127.0.0.1 --port 8729
```

Prefer `--task-id` for `post-edit-review` so Codexa can compare against the
saved snapshot. Use `post-edit-review . --task "<task>" ...` only when no
snapshot exists.

Use `--no-auto-refresh` only when the host requires strict filesystem-read-only metadata. The default auto-refresh mode may update generated Codexa cache artifacts under `.codex/`, but it does not mutate source files.
