---
description: Print a Codexa proof card for the current repo and task
argument-hint: "[task description]"
disable-model-invocation: true
allowed-tools: Bash(bash:*)
---

Ask Codexa for a compact proof card. It reports freshness, dirty-tree state,
read-first files, saved change-plan snapshot status, verification commands that
would earn credit, local policy-pack status, trust posture, and remaining gaps.

!`bash "${CLAUDE_PLUGIN_ROOT}/scripts/cmd/prove.sh" "$ARGUMENTS"`
