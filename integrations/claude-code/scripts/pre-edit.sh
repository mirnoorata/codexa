#!/usr/bin/env bash
# PreToolUse hook. When an Edit/Write/MultiEdit/NotebookEdit targets a file
# inside a codexa-wired repo AND that repo has no change-plan snapshot yet,
# save an implicit pre-edit baseline via `codexa hook-pre-edit` so the
# post-edit drift review always has a pre-edit reference, then print a
# short advisory to stderr. Never blocks — always exits 0.
#
# Rules:
#   - The CLI call only happens when no snapshot exists (once per task),
#     capped at 8s inside the 10s hook timeout. Repos that already have a
#     snapshot exit in milliseconds without spawning the CLI.
#   - Fail-open: CLI unavailable/slow degrades to the advisory text.
#   - Non-edit tools exit immediately.
#   - Missing or malformed payload exits 0.

set -u

CLAUDIO_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "$0")/.." && pwd -P)}"
# shellcheck source=lib/codexa-repo.sh
. "$CLAUDIO_ROOT/scripts/lib/codexa-repo.sh"

payload="$(cat)"
if [[ -z "$payload" ]]; then
  exit 0
fi

tool_name="$(printf '%s' "$payload" | claudio_json_field tool_name)"
if ! claudio_is_edit_tool "$tool_name"; then
  exit 0
fi

file_path="$(printf '%s' "$payload" | claudio_tool_input_field file_path)"
if [[ -z "$file_path" ]]; then
  # NotebookEdit uses notebook_path
  file_path="$(printf '%s' "$payload" | claudio_tool_input_field notebook_path)"
fi
if [[ -z "$file_path" ]]; then
  exit 0
fi

# Absolute paths only — relative paths can't be located without a cwd that
# the hook payload may not carry reliably.
if [[ "$file_path" != /* ]]; then
  exit 0
fi

resolved="$(claudio_realpath "$file_path")"
[[ -z "$resolved" ]] && resolved="$file_path"

target_dir="$(dirname "$resolved")"
repo="$(claudio_find_codexa_repo "$target_dir")"
if [[ -z "$repo" ]]; then
  exit 0
fi

if claudio_has_snapshot "$repo"; then
  exit 0
fi

rel="${resolved#"$repo/"}"
safe_repo="$(claudio_display_path "$repo")"
safe_rel="$(claudio_display_path "$rel")"

# Negative cache: when the baseline save persistently skips (degraded
# worktree, blocked plan), every edit would otherwise pay the up-to-8s CLI
# spawn in the PreToolUse critical path. A recent skip marker (5 min TTL)
# short-circuits straight to the advisory.
_pe_state_dir="${CLAUDE_PLUGIN_DATA:-${XDG_STATE_HOME:-$HOME/.local/state}/codexa-claude-code}"
_pe_repo_key="$(printf '%s' "$repo" | shasum -a 256 2>/dev/null | awk '{print $1}')"
_pe_skip_marker="$_pe_state_dir/pre-edit-skip-$_pe_repo_key"
_pe_marker_fresh=0
if [[ -n "$_pe_repo_key" && -f "$_pe_skip_marker" ]]; then
  _pe_now="$(date +%s 2>/dev/null)"
  _pe_mtime="$(stat -c '%Y' "$_pe_skip_marker" 2>/dev/null || stat -f '%m' "$_pe_skip_marker" 2>/dev/null)"
  if [[ -n "$_pe_now" && -n "$_pe_mtime" ]] && (( _pe_now - _pe_mtime < 300 )); then
    _pe_marker_fresh=1
  fi
fi

# Arm the drift loop: save an implicit baseline of the pre-edit dirty tree.
# The CLI's own output is discarded; success is re-verified by checking the
# snapshot on disk so a misbehaving CLI cannot fake the success message.
if [[ "$_pe_marker_fresh" -eq 0 ]]; then
  if claudio_codexa_run 8 hook-pre-edit "$repo" >/dev/null 2>&1; then
    :
  fi
  if claudio_has_snapshot "$repo"; then
    rm -f "$_pe_skip_marker" 2>/dev/null || true
    cat >&2 <<EOF
[codexa] Saved an implicit pre-edit baseline for $safe_repo.
[codexa] /codexa-review can now diff the final tree against this baseline.
[codexa] Run /codexa-plan "<task>" $safe_rel to upgrade it with planned
[codexa] scope and tests before anything non-trivial.
EOF
    exit 0
  fi
  if [[ -n "$_pe_repo_key" ]]; then
    mkdir -p "$_pe_state_dir" 2>/dev/null || true
    touch "$_pe_skip_marker" 2>/dev/null || true
  fi
fi

# Advisory-only fallback. Stderr surfaces in the transcript UI; stdout is
# reserved for JSON the harness parses. Filesystem-controlled paths flow
# through claudio_display_path so a hostile filename cannot inject extra
# advisory lines or prose into the transcript.
cat >&2 <<EOF
[codexa] No codexa change-plan snapshot found for $safe_repo.
[codexa] Before editing $safe_rel, run:
[codexa]   /codexa-plan "<task>" $safe_rel
[codexa] This saves a baseline under .codex/cache/codexa-tasks/latest.json so
[codexa] /codexa-review can compute post-edit drift. Skipping the snapshot is
[codexa] fine for trivial edits; run the planner for anything meaningful.
EOF

exit 0
