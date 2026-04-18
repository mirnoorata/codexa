---
description: Save a Codexa change-plan snapshot before editing concrete files
argument-hint: '"<task>" [file ...]'
disable-model-invocation: true
allowed-tools: Bash(bash:*)
---

Save a Codexa change-plan snapshot so the post-edit review can compute drift afterward. Quote the task so it is parsed as a single argument, then list the files you intend to edit.

Examples:

```
/codexa-plan "fix auth bug" src/auth.py
/codexa-plan "redesign frame header" web/src/App.tsx web/src/styles.css
```

!`bash "${CLAUDE_PLUGIN_ROOT}/scripts/cmd/plan.sh" "$ARGUMENTS"`
