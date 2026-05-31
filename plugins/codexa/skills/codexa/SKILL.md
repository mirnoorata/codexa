---
name: codexa
description: Use Codexa's repository context server for Codex-native task briefs, change plans, post-edit reviews, dependency/workflow tracing, and targeted verification before or after code edits.
---

# Codexa Workflow

Use this skill when a task involves understanding, editing, reviewing, or verifying a repository that has Codexa installed or available through the Codexa MCP server.

## Operating Rules

1. Resolve the active repository first. If the repo has `.codex/config.toml`, use the project-local Codexa MCP server. If the MCP server is unavailable, run the equivalent `codexa` CLI command from the repository.
2. Primary Codexa path: `session_context -> task_brief -> change_plan(saveSnapshot) -> post_edit_review -> test_plan`.
3. For broad tasks, call `session_context` first. If `actionability` says `needs_target`, `raw_search_better`, or `raw_search_sufficient`, use `search` or ask for an explicit target before planning edits.
4. For code edits, debugging, reviews, or non-trivial refactors, call `task_brief` before reading or editing source.
5. Before non-trivial edits, call `change_plan` with `saveSnapshot=true` so Codexa can compare the plan with the final dirty tree.
6. After edits, call `post_edit_review` and pass any commands or test reports that were actually run.
7. For workflow/runtime/API/rename/delete changes, use `workflow_path`, `callers`, `callees`, or `dependency_path` before editing shared surfaces.
8. Finish with `test_plan` when the verification surface is unclear.

## Thin Adapter Rules

1. Keep host adapters thin. They should launch the shared Codexa MCP server or CLI and should not add independent planning, ranking, indexing, or source-editing behavior.
2. Codexa MCP tools may write generated `.codex/` cache artifacts, but there must be no source-mutating MCP tool path.
3. Do not add broad host-specific tools when the primary MCP path or an existing advanced tool can answer the need.

## CLI Fallbacks

Use these commands from the target repository when MCP is not available:

```bash
codexa session-context .
codexa brief . --task "<task>"
codexa change-plan . --task "<task>" --save-snapshot
codexa post-edit-review . --task "<task>" --ran-command "<command>"
codexa test-plan .
codexa search . --query "<literal or symbol>"
```

Use `--no-auto-refresh` only when the host requires strict filesystem-read-only metadata. The default auto-refresh mode may update generated Codexa cache artifacts under `.codex/`, but it does not mutate source files.
