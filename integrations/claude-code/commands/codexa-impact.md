---
description: Show Codexa blast-radius impact for a file/symbol, or diff-impact when no argument
argument-hint: "[path or symbol]"
disable-model-invocation: true
allowed-tools: Bash(bash:*)
---

Show Codexa impact evidence. With an argument, query `impact` for that file or
symbol. Without an argument, show `diff-impact` for the current dirty tree.
Relationship-backed results may include edge evidence ids, confidence labels,
stale/degraded flags, and structured next Codexa tools for symbol context,
change planning, or targeted tests.

!`bash "${CLAUDE_PLUGIN_ROOT}/scripts/cmd/impact.sh" "$ARGUMENTS"`
