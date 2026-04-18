#!/usr/bin/env bash
# PreToolUse hook. When an Edit/Write/MultiEdit/NotebookEdit targets a file
# inside a codexa-wired repo AND that repo has no change-plan snapshot yet,
# print a short advisory to stderr so the next turn reminds me to run
# `/codexa-plan <task>` before continuing. Never blocks — always exits 0.
#
# Rules:
#   - 2s hard budget. This runs in the tool call's critical path.
#   - Only checks snapshot presence; does not call the codexa CLI here.
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

# Advisory-only. Stderr surfaces in the transcript UI; stdout is reserved
# for JSON the harness parses. Filesystem-controlled paths flow through
# claudio_display_path so a hostile filename cannot inject extra advisory
# lines or prose into the transcript.
rel="${resolved#"$repo/"}"
safe_repo="$(claudio_display_path "$repo")"
safe_rel="$(claudio_display_path "$rel")"
cat >&2 <<EOF
[codexa] No codexa change-plan snapshot found for $safe_repo.
[codexa] Before editing $safe_rel, run:
[codexa]   /codexa-plan "<task>" $safe_rel
[codexa] This saves a baseline under .codex/cache/codexa-tasks/latest.json so
[codexa] /codexa-review can compute post-edit drift. Skipping the snapshot is
[codexa] fine for trivial edits; run the planner for anything meaningful.
EOF

exit 0
