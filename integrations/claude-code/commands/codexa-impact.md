---
description: Show Codexa blast-radius impact for a file/symbol, or diff-impact when no argument
argument-hint: "[path or symbol]"
disable-model-invocation: true
allowed-tools: Bash(bash:*)
---

Show Codexa impact evidence. With an argument, query `impact` for that file or symbol. Without an argument, show `diff-impact` for the current dirty tree.

!`bash "${CLAUDE_PLUGIN_ROOT}/scripts/cmd/impact.sh" "$ARGUMENTS"`
