---
description: Run Codexa post-edit review against the saved change-plan snapshot
argument-hint: "[--change-type <type>] [--ran-test <path> ...] [--ran-command <cmd> ...]"
disable-model-invocation: true
allowed-tools: Bash(bash:*)
---

Compare the current dirty tree against the saved Codexa change-plan snapshot.
Reports tests still unaccounted for, drift signals, and known gaps. Saved
planned tests now carry provenance; legacy, stale, or scope-mismatched snapshot
tests are reported as degraded instead of silently trusted. Passing structured
command reports lets Codexa account for verification and persist compact local
outcomes for future visible ranking/test boosts.

Allowlisted flags (others are rejected): `--change-type`, `--ran-test`, `--ran-command`, `--ran-command-report`, `--waive-check`, `--waiver`, `--file`, `--symbol`, `--budget`, `--limit`, `--snippets`, `--no-snippets`, `--auto-refresh`, `--no-auto-refresh`, `--task-id`.

Common use:

```
/codexa-review --change-type style
/codexa-review --change-type behavior --ran-test tests/test_queue.py --ran-command "pytest tests/"
```

!`bash "${CLAUDE_PLUGIN_ROOT}/scripts/cmd/review.sh" "$ARGUMENTS"`
