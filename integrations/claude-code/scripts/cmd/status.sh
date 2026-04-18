#!/usr/bin/env bash
# /codexa-status
#
# Single-repo case: walks up from PWD for an ancestor with .codex/config.toml
# and runs `codexa status` on it. That matches the common "terminal is inside
# the repo" workflow.
#
# Multi-repo case: when PWD is above a set of wired children (e.g. VS Code
# opened at `/srv` with `/srv/codexa` and `/srv/atlas` both wired), we fan
# out and run `codexa status` on every wired child rather than erroring on
# ambiguity. The IDE-workspace-root view is "show me everything."
set -u
CMD_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=lib.sh
. "$CMD_DIR/lib.sh"

cmd_require_codexa_cli

ancestor="$(claudio_find_codexa_repo "$PWD")"
if [[ -n "$ancestor" ]]; then
  exec "$NODE_BIN" "$CODEXA_CLI" status "$ancestor"
fi

declare -a children=()
while IFS= read -r line; do
  [[ -z "$line" ]] && continue
  children+=("$line")
done < <(claudio_list_child_codexa_repos "$PWD")

case "${#children[@]}" in
  0)
    printf 'No codexa-wired repo (.codex/config.toml) found from %s.\n' "$PWD" >&2
    exit 1
    ;;
  1)
    exec "$NODE_BIN" "$CODEXA_CLI" status "${children[0]}"
    ;;
  *)
    printf '[codexa] no wired repo at %s; fanning out status across %d wired children:\n' \
      "$PWD" "${#children[@]}" >&2
    rc=0
    for child in "${children[@]}"; do
      printf '=== %s ===\n' "$child"
      if ! "$NODE_BIN" "$CODEXA_CLI" status "$child"; then
        rc=1
      fi
      printf '\n'
    done
    exit "$rc"
    ;;
esac
