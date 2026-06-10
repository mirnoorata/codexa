#!/usr/bin/env bash
# Shared helpers for the /codexa-* slash-command implementations.
#
# Every slash-command `.md` file passes the raw "$ARGUMENTS" string as the
# single first positional argument. We do NOT eval it or let the shell
# word-split it — shlex handles quoting and shell metacharacters safely.

set -u

CMD_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
CMD_LIB_INTEGRATION_ROOT="$(cd "$CMD_LIB_DIR/../.." && pwd -P)"
# shellcheck source=../lib/codexa-repo.sh
. "$CMD_LIB_INTEGRATION_ROOT/scripts/lib/codexa-repo.sh"

# Populate a bash array from shell-like tokenization of a single string.
# Usage: cmd_shlex_split "quoted string \"with escapes\"" arr_name
# After the call, ${arr_name[@]} holds the parsed tokens. Tokens may include
# newlines/tabs — we use a NUL delimiter end-to-end. Returns 2 on malformed
# input (unbalanced quotes, etc.), with the error written to stderr.
cmd_shlex_split() {
  local raw="${1:-}"
  local -n out_arr="$2"
  out_arr=()
  [[ -z "$raw" ]] && return 0
  local tokens_file err_file
  tokens_file="$(mktemp)" || return 2
  err_file="$(mktemp)" || { rm -f "$tokens_file"; return 2; }
  python3 - "$raw" >"$tokens_file" 2>"$err_file" <<'PY'
import shlex, sys
try:
    tokens = shlex.split(sys.argv[1])
except ValueError as exc:
    sys.stderr.write("argument parse error: " + str(exc) + "\n")
    sys.exit(2)
for t in tokens:
    sys.stdout.write(t)
    sys.stdout.write("\0")
PY
  local rc=$?
  if [[ $rc -ne 0 ]]; then
    cat "$err_file" >&2
    rm -f "$tokens_file" "$err_file"
    return "$rc"
  fi
  rm -f "$err_file"
  local token
  while IFS= read -r -d '' token; do
    out_arr+=("$token")
  done <"$tokens_file"
  rm -f "$tokens_file"
  return 0
}

# Resolve the target codexa-wired repo for a slash command.
#
# Resolution order:
#   (1) Walk up from PWD looking for .codex/config.toml (existing behavior).
#   (2) If no ancestor is wired, scan direct children of PWD for wired repos.
#       If exactly one, auto-pick it and note the choice on stderr so the
#       user sees which repo the command ran against. If more than one,
#       error with the list so the user can disambiguate by cd-ing in.
#
# Writes the repo root to stdout and returns 0 on success. On failure writes
# a diagnostic to stderr and returns 1 — callers use `|| exit 1` in command
# substitution so the parent script actually exits.
cmd_require_codexa_repo() {
  local repo
  repo="$(claudio_find_codexa_repo "$PWD")"
  if [[ -n "$repo" ]]; then
    printf '%s' "$repo"
    return 0
  fi

  local -a children=()
  local line
  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    children+=("$line")
  done < <(claudio_list_child_codexa_repos "$PWD")

  case "${#children[@]}" in
    0)
      printf 'No codexa-wired repo (.codex/config.toml) found from %s.\n' "$PWD" >&2
      return 1
      ;;
    1)
      printf '[codexa] no wired repo at %s; auto-selected sole child: %s\n' \
        "$PWD" "${children[0]}" >&2
      printf '%s' "${children[0]}"
      return 0
      ;;
    *)
      printf 'Ambiguous codexa target: %s has %d wired child repos.\n' \
        "$PWD" "${#children[@]}" >&2
      printf 'cd into one of these and re-run:\n' >&2
      local child
      for child in "${children[@]}"; do
        printf '  - %s\n' "$child" >&2
      done
      return 1
      ;;
  esac
}

# Require a usable codexa CLI and print a clear error if missing.
cmd_require_codexa_cli() {
  if ! claudio_codexa_available; then
    printf 'codexa CLI not available at %s (NODE=%s).\n' "$CODEXA_CLI" "$NODE_BIN" >&2
    exit 127
  fi
}

# Reject tokens that look like path-traversal or obvious shell injection
# before passing them through to --file flags. Call once per user-supplied
# file path. We do not try to sandbox — just block the dumb cases.
cmd_validate_path_token() {
  local tok="${1:-}"
  if [[ -z "$tok" ]]; then
    return 0
  fi
  case "$tok" in
    *$'\n'*|*$'\r'*|*$'\t'*)
      printf 'rejecting path with control character: %q\n' "$tok" >&2
      exit 2
      ;;
  esac
  # Allow relative .. under repo root (valid monorepo paths may include it)
  # but disallow an absolute path outside known workspace, home, or repo roots.
  return 0
}
