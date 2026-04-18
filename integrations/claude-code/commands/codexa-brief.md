---
description: Get a Codexa task brief for the current dirty tree + a user task
argument-hint: "<task description>"
disable-model-invocation: true
allowed-tools: Bash(bash:*)
---

Ask Codexa for a focused task brief. This is the first call before any non-trivial codexa-wired edit. It bundles impact, risks, covering tests, freshness, and read-first files for the stated task plus the existing dirty diff.

!`bash "${CLAUDE_PLUGIN_ROOT}/scripts/cmd/brief.sh" "$ARGUMENTS"`
