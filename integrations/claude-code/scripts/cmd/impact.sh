#!/usr/bin/env bash
set -u
CMD_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=lib.sh
. "$CMD_DIR/lib.sh"

raw_args="${1-}"

repo="$(cmd_require_codexa_repo)" || exit 1
cmd_require_codexa_cli

if [[ -z "$raw_args" ]]; then
  exec "$NODE_BIN" "$CODEXA_CLI" diff-impact "$repo"
fi

declare -a tokens
if ! cmd_shlex_split "$raw_args" tokens; then
  exit 2
fi

if [[ ${#tokens[@]} -ne 1 ]]; then
  printf 'Usage: /codexa-impact [path or symbol]\n' >&2
  exit 2
fi

target="${tokens[0]}"
cmd_validate_path_token "$target"

# If the argument resolves to a real file (relative to repo or absolute),
# treat it as a path; otherwise fall back to --symbol.
if [[ -e "$repo/$target" ]] || [[ -e "$target" ]]; then
  exec "$NODE_BIN" "$CODEXA_CLI" impact "$repo" --file "$target"
else
  exec "$NODE_BIN" "$CODEXA_CLI" impact "$repo" --symbol "$target"
fi
