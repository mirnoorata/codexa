---
description: Get a Codexa task brief for the current dirty tree + a user task
argument-hint: "<task description>"
disable-model-invocation: true
allowed-tools: Bash(bash:*)
---

Ask Codexa for a focused task brief when the scope is ambiguous or the dirty
tree needs Codexa-ranked read-first guidance. Skip this command when direct
source evidence already makes a bounded local task clear; for an exact
non-trivial edit, go directly to the saved change plan. The brief bundles
impact, risks, covering tests, freshness, read-first files, relationship
evidence where available, quality signals, and structured `nextTools` for the
stated task plus the existing dirty diff.

!`bash "${CLAUDE_PLUGIN_ROOT}/scripts/cmd/brief.sh" "$ARGUMENTS"`
