#!/usr/bin/env bash
set -u
CMD_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=lib.sh
. "$CMD_DIR/lib.sh"

raw_args="${1-}"
if [[ -z "$raw_args" ]]; then
  cat >&2 <<'USAGE'
Usage: /codexa-plan "<task>" [file ...]

The task must be a quoted string. Additional tokens are treated as file
paths to snapshot. Examples:

  /codexa-plan "fix auth bug" src/auth.py
  /codexa-plan "redesign frame header" web/src/App.tsx web/src/styles.css
USAGE
  exit 2
fi

declare -a tokens
if ! cmd_shlex_split "$raw_args" tokens; then
  exit 2
fi

if [[ ${#tokens[@]} -eq 0 ]]; then
  printf 'Parsed zero tokens from arguments.\n' >&2
  exit 2
fi

task="${tokens[0]}"
files=("${tokens[@]:1}")

if [[ -z "$task" ]]; then
  printf 'First argument (task description) must be non-empty.\n' >&2
  exit 2
fi

# Validate file tokens BEFORE touching codexa.
for f in "${files[@]}"; do
  cmd_validate_path_token "$f"
done

repo="$(cmd_require_codexa_repo)" || exit 1
cmd_require_codexa_cli

cli_args=(change-plan "$repo" --task "$task" --save-snapshot)
for f in "${files[@]}"; do
  cli_args+=(--file "$f")
done

exec "$NODE_BIN" "$CODEXA_CLI" "${cli_args[@]}"
