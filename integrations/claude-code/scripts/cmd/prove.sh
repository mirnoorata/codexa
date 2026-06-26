#!/usr/bin/env bash
set -u
CMD_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=lib.sh
. "$CMD_DIR/lib.sh"

raw_args="${1-}"

repo="$(cmd_require_codexa_repo)" || exit 1
cmd_require_codexa_cli

cli_args=(prove "$repo" --diff)
if [[ -n "$raw_args" ]]; then
  cli_args+=(--task "$raw_args")
fi

exec "$NODE_BIN" "$CODEXA_CLI" "${cli_args[@]}"
