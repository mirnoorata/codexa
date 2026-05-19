---
name: codexa
description: Use Codexa's repository context server for Codex-native task briefs, change plans, post-edit reviews, dependency/workflow tracing, and targeted verification before or after code edits.
---

# Codexa Workflow

Use this skill when a task involves understanding, editing, reviewing, or verifying a repository that has Codexa installed or available through the Codexa MCP server.

## Operating Rules

1. Resolve the active repository first. If the repo has `.codex/config.toml`, use the project-local Codexa MCP server. If the MCP server is unavailable, run the equivalent `codexa` CLI command from the repository.
2. For broad tasks, call `focus_brief` or `session_context` first.
3. For code edits, debugging, reviews, or non-trivial refactors, call `task_brief` before reading or editing source.
4. Before non-trivial edits, call `change_plan` with `saveSnapshot=true` so Codexa can compare the plan with the final dirty tree.
5. After edits, call `post_edit_review` and pass any commands or test reports that were actually run.
6. For workflow/runtime/API/rename/delete changes, use `workflow_path`, `callers`, `callees`, or `dependency_path` before editing shared surfaces.
7. Finish with `test_plan` when the verification surface is unclear.

## CLI Fallbacks

Use these commands from the target repository when MCP is not available:

```bash
codexa session-context .
codexa brief . --task "<task>"
codexa change-plan . --task "<task>" --save-snapshot
codexa post-edit-review . --task "<task>" --ran-command "<command>"
codexa test-plan .
```

Use `--no-auto-refresh` only when the host requires strict filesystem-read-only metadata. The default auto-refresh mode may update generated Codexa cache artifacts under `.codex/`, but it does not mutate source files.
