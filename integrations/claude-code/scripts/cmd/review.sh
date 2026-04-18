#!/usr/bin/env bash
set -u
CMD_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=lib.sh
. "$CMD_DIR/lib.sh"

raw_args="${1-}"

repo="$(cmd_require_codexa_repo)" || exit 1
cmd_require_codexa_cli

if [[ ! -f "$repo/.codex/cache/codexa-tasks/latest.json" ]]; then
  printf 'No change-plan snapshot found at %s/.codex/cache/codexa-tasks/latest.json.\nRun /codexa-plan first.\n' "$repo" >&2
  exit 1
fi

declare -a tokens
if ! cmd_shlex_split "$raw_args" tokens; then
  exit 2
fi

# Only allow a known flag set through. The CLI has many flags; we allow
# the post-edit-relevant ones and refuse anything else so a stray argument
# can't slip a shell metachar or an unknown subcommand.
allowed_flags=(--change-type --ran-test --ran-command --ran-command-report \
               --waive-check --waiver --file --symbol --budget --limit \
               --snippets --no-snippets --auto-refresh --no-auto-refresh \
               --task-id)
is_allowed() {
  local candidate="$1"
  for f in "${allowed_flags[@]}"; do
    if [[ "$candidate" == "$f" ]]; then
      return 0
    fi
  done
  return 1
}

i=0
cli_args=(post-edit "$repo")
while [[ $i -lt ${#tokens[@]} ]]; do
  tok="${tokens[$i]}"
  if [[ "$tok" == --* ]]; then
    if ! is_allowed "$tok"; then
      printf 'refusing unknown flag %q\n' "$tok" >&2
      exit 2
    fi
    cli_args+=("$tok")
    # flags with a value: consume next token too unless it's the start of
    # another flag or we're at end of list.
    if [[ $((i + 1)) -lt ${#tokens[@]} ]]; then
      next="${tokens[$((i + 1))]}"
      if [[ "$next" != --* ]]; then
        cli_args+=("$next")
        i=$((i + 2))
        continue
      fi
    fi
    i=$((i + 1))
  else
    printf 'positional arguments are not supported for /codexa-review: %q\n' "$tok" >&2
    exit 2
  fi
done

exec "$NODE_BIN" "$CODEXA_CLI" "${cli_args[@]}"
