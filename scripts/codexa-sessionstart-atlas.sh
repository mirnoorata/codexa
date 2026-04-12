#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="${1:-/srv/atlas}"
CODEXA_CLI="${CODEXA_CLI:-/srv/codexa/dist/cli.js}"

if [[ ! -x "$(command -v node)" ]]; then
  echo "Codexa unavailable: node is not on PATH"
  exit 0
fi

if [[ ! -f "$CODEXA_CLI" ]]; then
  echo "Codexa unavailable: build missing at $CODEXA_CLI"
  exit 0
fi

echo "Codexa Atlas context:"
node "$CODEXA_CLI" status "$REPO_ROOT" | sed -n '1,6p'
if [[ "${CODEXA_SESSIONSTART_CONTEXT:-0}" == "1" ]]; then
  node "$CODEXA_CLI" context-pack "$REPO_ROOT" \
    --task "Session start: identify current Atlas focus and verification surface" \
    --budget 700 \
    --limit 4 \
    --no-snippets \
    --no-auto-refresh | sed -n '1,24p' || true
fi
echo "Use MCP tool context_pack for task-specific follow-up before edits."
