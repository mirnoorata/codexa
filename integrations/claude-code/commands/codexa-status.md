---
description: Show Codexa index freshness for the current repo
argument-hint: ""
disable-model-invocation: true
allowed-tools: Bash(bash:*)
---

Show the Codexa index freshness, commit, indexed-at, and dirty-file count for the repo you are focused on. Return the output verbatim.

!`bash "${CLAUDE_PLUGIN_ROOT}/scripts/cmd/status.sh"`
