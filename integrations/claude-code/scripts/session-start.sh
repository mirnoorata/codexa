#!/usr/bin/env bash
# SessionStart hook. Behaves in two modes depending on cwd:
#
#   (1) Single-repo mode — cwd is inside a codexa-wired repo (walks up to
#       find `.codex/config.toml`). Emits a structured packet with that
#       repo's freshness + top read-first files, all allowlist-validated.
#
#   (2) Parent-scan mode — cwd has no wired repo above it but contains
#       wired child repos one level down (for example, cwd=~/code with
#       ~/code/myproject wired). Emits a structured roll-up listing each
#       child with its parsed status fields.
#
#   (3) Silent — cwd has no wired repo either way. Exit 0, no output.
#
# Design rules:
#   - Must never block. 5s hard timeout per subprocess; total budget is
#     bounded by the 6s hook timeout in hooks.json.
#   - Never write to disk. Read-only.
#   - No free-form repo text in model-visible fields. Structured only.

set -u

CLAUDIO_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "$0")/.." && pwd -P)}"
# shellcheck source=lib/codexa-repo.sh
. "$CLAUDIO_ROOT/scripts/lib/codexa-repo.sh"

payload="$(cat)"
if [[ -z "$payload" ]]; then
  exit 0
fi

cwd="$(printf '%s' "$payload" | claudio_json_field cwd)"
if [[ -z "$cwd" ]]; then
  exit 0
fi

# --- Mode 1: Single repo (existing behavior). ------------------------------
repo="$(claudio_find_codexa_repo "$cwd")"
if [[ -n "$repo" ]]; then
  status_raw=""
  if claudio_codexa_available; then
    status_raw="$(claudio_codexa_run 5 status "$repo" 2>/dev/null || true)"
  fi

  readme_raw=""
  readme_path="$repo/.codex/codebase/README.md"
  if [[ -f "$readme_path" ]]; then
    readme_raw="$(head -c 65536 "$readme_path" 2>/dev/null || true)"
  fi

  status_fields="$(claudio_parse_codexa_status "$status_raw")"
  read_first_entries="$(claudio_parse_read_first "$readme_raw" 8)"

  context="$(
    printf 'codexa/plugin v0.1.0 — validated session context.\n'
    printf '(All values below were parsed against strict allowlists; repo prose is not forwarded.)\n'
    printf '\nStatus:\n'
    if [[ -n "$status_fields" ]]; then
      printf '%s\n' "$status_fields" | sed 's/^/  /'
    else
      printf '  (unavailable)\n'
    fi
    printf '\nRead-first (top-ranked files):\n'
    if [[ -n "$read_first_entries" ]]; then
      while IFS=$'\t' read -r p r; do
        [[ -z "$p" ]] && continue
        printf '  - %s (rank %s)\n' "$p" "$r"
      done <<<"$read_first_entries"
    else
      printf '  (none parsed)\n'
    fi
    printf '\nNext calls:\n'
    printf '  - /codexa-status    — refresh this packet\n'
    printf '  - /codexa-brief     — task brief + diff impact\n'
    printf '  - /codexa-plan      — save a change-plan snapshot\n'
    printf '  - /codexa-review    — post-edit drift review\n'
    printf '  - /codexa-impact    — blast-radius for a file or symbol\n'
  )"

  python3 - "$repo" "$context" <<'PY'
import json
import sys

repo_path = sys.argv[1]
additional_context = sys.argv[2]
payload = {
    "hookSpecificOutput": {
        "hookEventName": "SessionStart",
        "additionalContext": additional_context,
        "codexaRepoPath": repo_path,
    },
    "systemMessage": "Codexa-wired repo detected. See hookSpecificOutput for details.",
}
sys.stdout.write(json.dumps(payload, ensure_ascii=False))
sys.stdout.write("\n")
PY
  exit 0
fi

# --- Mode 2: Parent-scan fallback. -----------------------------------------
# cwd has no wired repo above; look for wired repos one level down.
declare -a child_repos=()
while IFS= read -r child; do
  [[ -z "$child" ]] && continue
  child_repos+=("$child")
done < <(claudio_list_child_codexa_repos "$cwd")

# Mode 3: Silent exit if no children either.
if [[ ${#child_repos[@]} -eq 0 ]]; then
  exit 0
fi

# Parent-scan mode deliberately does NOT run `codexa status` per child.
# Up to 8 wired children × 2s-per-call can chew through the 6s outer hook
# budget before the banner is emitted at all. Instead we list the child
# repo paths with no per-repo status — the user can `/codexa-status`
# after `cd`-ing into a repo to get full detail.
declare -a child_paths=()
for child in "${child_repos[@]:0:8}"; do
  child_paths+=("$child")
done

# Build the multi-repo additionalContext. Repo names are validated as
# basename-only (no paths), which means ${child##*/}. Those are
# filesystem-controlled but already pass through the structured
# additionalContext field, and downstream we never re-interpret them.
# The parent cwd is also filesystem-controlled, so it runs through the
# display-safe quoter before reaching the banner — same threat as a
# hostile repo directory name would otherwise smuggle in newlines.
safe_cwd="$(claudio_display_path "$cwd")"

# Privacy knob: by default, list each wired child by basename so the user
# can see which projects are discoverable. Set CLAUDIO_PARENT_SCAN_NAMES=0
# to emit a count-only banner instead — useful when Claude Code is
# started from a shared parent directory where exposing sibling project
# names to the session context would leak information.
reveal_names="${CLAUDIO_PARENT_SCAN_NAMES:-1}"

context="$(
  printf 'codexa/plugin v0.1.0 — parent-scan session context.\n'
  printf '(cwd is above any wired repo. Reporting direct children that are codexa-wired.)\n'
  if [[ "$reveal_names" == "0" ]]; then
    # Privacy mode: NO cwd, NO child names. Just the count. Nothing in
    # this banner can identify the parent directory or any sibling
    # project once CLAUDIO_PARENT_SCAN_NAMES=0 is set.
    printf '\nWired repos:\n'
    printf '  (%d wired child repo(s) detected; names and parent cwd redacted via CLAUDIO_PARENT_SCAN_NAMES=0)\n' "${#child_paths[@]}"
  else
    printf '\nWired repos under %s:\n' "$safe_cwd"
    for repo_path in "${child_paths[@]}"; do
      short_name="$(basename "$repo_path")"
      # Basename must pass a strict allowlist. Anything else — prose,
      # punctuation, control chars — is replaced with a stable placeholder
      # so a hostile directory name cannot inject prompt text.
      if [[ "$short_name" =~ ^[A-Za-z0-9._-]{1,64}$ ]]; then
        safe_name="$short_name"
      else
        safe_name="(unsafe-name)"
      fi
      printf '  - %s\n' "$safe_name"
    done
    printf '\n(Run /codexa-status after cd-ing into any repo for freshness / commit / dirty-file detail.)\n'
  fi  # end reveal_names branch
  printf '\nNext calls:\n'
  printf '  - cd into any wired repo to enable auto-nudges on Edit/Write/MultiEdit\n'
  printf '  - /codexa-status    — full status for the repo containing your cwd\n'
  printf '  - /codexa-brief     — task brief + diff impact\n'
  printf '  - /codexa-plan      — save a change-plan snapshot before editing\n'
  printf '  - /codexa-review    — post-edit drift review\n'
  printf '  - codexa init <repo>  — wire an unwired project\n'
)"

# Emit multi-repo envelope. `codexaRepoPaths` is a JSON array of the raw
# paths for structured-field consumers (e.g. Claude tool calls that want
# to enumerate available projects).
python3 - "$cwd" "$context" "$reveal_names" "${child_paths[@]}" <<'PY'
import json
import sys

cwd = sys.argv[1]
additional_context = sys.argv[2]
reveal_names = sys.argv[3] != "0"
child_paths = list(sys.argv[4:])
output = {
    "hookEventName": "SessionStart",
    "additionalContext": additional_context,
    "codexaRepoCount": len(child_paths),
}
# Count-only privacy mode: suppress BOTH codexaRepoPaths and codexaCwd so
# no path-level identifier (raw paths, parent cwd) leaks to downstream
# structured consumers. Only the count survives.
if reveal_names:
    output["codexaCwd"] = cwd
    output["codexaRepoPaths"] = child_paths
payload = {
    "hookSpecificOutput": output,
    "systemMessage": "Codexa-wired child repos detected. See hookSpecificOutput for details.",
}
sys.stdout.write(json.dumps(payload, ensure_ascii=False))
sys.stdout.write("\n")
PY
