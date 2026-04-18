#!/usr/bin/env bash
set -u
CMD_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=lib.sh
. "$CMD_DIR/lib.sh"

raw_args="${1-}"
if [[ -z "$raw_args" ]]; then
  printf 'Usage: /codexa-brief <task description>\n' >&2
  exit 2
fi

# Task may include shell metacharacters; treat the whole string as the task.
task="$raw_args"

repo="$(cmd_require_codexa_repo)" || exit 1
cmd_require_codexa_cli
exec "$NODE_BIN" "$CODEXA_CLI" brief "$repo" --task "$task" --diff
