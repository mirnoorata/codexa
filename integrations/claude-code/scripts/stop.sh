#!/usr/bin/env bash
# Stop hook. At the end of every assistant turn, if the session touched
# (or is sitting above) a codexa-wired repo, run `codexa post-edit-review` for
# each such repo whose change-plan snapshot is "interesting" (has edits
# beyond the last review), and print a structured summary to stderr.
#
# Two execution modes:
#   (1) cwd is inside a wired repo — review that repo.
#   (2) cwd is above any wired repo but wired child repos exist — rank
#       them by snapshot mtime and review the top N (N=3), skipping any
#       whose fingerprint is already debounced from a prior turn.
#
# Rules:
#   - Per-repo review has a 30s hard budget.
#   - Debounced per (session, repo, snapshot-content, dirty-tree-hash).
#   - Always exits 0. When a review's verdict is replan or a blocking
#     inspect, the drift summary is made model-visible through the Stop
#     hook JSON contract ({"decision":"block","reason":...}) so the agent
#     can act on it; clean/advisory verdicts stay stderr-only. The
#     stop_hook_active re-entrancy guard plus the fingerprint debounce
#     bound this to at most one block per stop sequence and per dirty-tree
#     state. Set CLAUDIO_STOP_BLOCK=0 for stderr-only behavior.

set -u

CLAUDIO_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "$0")/.." && pwd -P)}"
# shellcheck source=lib/codexa-repo.sh
. "$CLAUDIO_ROOT/scripts/lib/codexa-repo.sh"

MAX_STOP_REPOS_PER_TURN="${CLAUDIO_STOP_MAX_REPOS:-3}"

# Run a post-edit review for one repo. Returns 0 in all cases — this is a
# best-effort helper that never raises. Emits one stderr block per call.
claudio_stop_review_one() {
  local repo="$1"
  local session_id="$2"
  local data_dir="$3"

  if ! claudio_has_snapshot "$repo"; then
    return 0
  fi

  local snapshot_file="$repo/.codex/cache/codexa-tasks/latest.json"

  # Content-sensitive fingerprint. See session banner in the file below for
  # the full contract. Returns non-zero when any git step was degraded so
  # the caller never writes a cacheable marker from a trust-less state.
  local fingerprint_tmp
  fingerprint_tmp="$(mktemp)" || return 0
  python3 - "$repo" "$snapshot_file" >"$fingerprint_tmp" 2>/dev/null <<'PY'
import hashlib
import os
import stat
import subprocess
import sys

repo = sys.argv[1]
snapshot = sys.argv[2]

MAX_UNTRACKED_FILES = 2000
MAX_UNTRACKED_TOTAL_BYTES = 32 * 1024 * 1024  # 32 MiB
MAX_SINGLE_FILE_BYTES = 4 * 1024 * 1024        #  4 MiB
MAX_GIT_OUTPUT_BYTES = 16 * 1024 * 1024        # 16 MiB per git invocation
GIT_TIMEOUT_SECONDS = 8

degraded = False


def git_out(args):
    global degraded
    try:
        result = subprocess.run(
            ["git", *args],
            cwd=repo,
            capture_output=True,
            timeout=GIT_TIMEOUT_SECONDS,
        )
    except subprocess.TimeoutExpired:
        degraded = True
        return b"__GIT_TIMEOUT__\n", 124
    except OSError:
        degraded = True
        return b"__GIT_UNAVAILABLE__\n", 127
    if result.returncode != 0:
        degraded = True
    out = result.stdout
    if len(out) > MAX_GIT_OUTPUT_BYTES:
        degraded = True
        out = out[:MAX_GIT_OUTPUT_BYTES] + b"\n__GIT_OUTPUT_TRUNCATED__\n"
    return out, result.returncode


h = hashlib.sha256()
h.update(b"STATUS\n")
status_bytes, status_rc = git_out(["status", "--short", "--untracked-files=all"])
h.update(f"rc={status_rc}\n".encode("ascii"))
h.update(status_bytes)
h.update(b"\nDIFF\n")
diff_bytes, diff_rc = git_out(["diff", "--no-color"])
h.update(f"rc={diff_rc}\n".encode("ascii"))
h.update(diff_bytes)
h.update(b"\nCACHED\n")
cached_bytes, cached_rc = git_out(["diff", "--no-color", "--cached"])
h.update(f"rc={cached_rc}\n".encode("ascii"))
h.update(cached_bytes)
h.update(b"\nUNTRACKED\n")
raw, ls_rc = git_out(["ls-files", "--others", "--exclude-standard", "-z"])
h.update(f"rc={ls_rc}\n".encode("ascii"))
if ls_rc != 0:
    raw = b""
count = 0
bytes_read = 0
for entry in raw.split(b"\0"):
    if not entry:
        continue
    count += 1
    if count > MAX_UNTRACKED_FILES:
        degraded = True
        h.update(b"TRUNCATED_FILE_COUNT\n")
        break
    try:
        rel = os.fsdecode(entry)
        abs_path = os.path.join(repo, rel)
    except (UnicodeDecodeError, TypeError):
        degraded = True
        h.update(b"path_decode_failed:")
        h.update(hashlib.sha256(entry).hexdigest().encode("ascii"))
        h.update(b"\n")
        continue
    try:
        lst = os.lstat(abs_path)
    except OSError:
        degraded = True
        h.update(b"lstat_failed:")
        h.update(hashlib.sha256(entry).hexdigest().encode("ascii"))
        h.update(b"\n")
        continue
    h.update(entry)
    h.update(b":")
    if stat.S_ISLNK(lst.st_mode):
        try:
            target = os.readlink(abs_path).encode("utf-8", "replace")
        except OSError:
            target = b""
        h.update(b"lnk:")
        h.update(hashlib.sha256(target).hexdigest().encode("ascii"))
        h.update(b"\n")
        continue
    if not stat.S_ISREG(lst.st_mode):
        mode = stat.S_IFMT(lst.st_mode)
        h.update(f"special:{mode:o}:{lst.st_size}\n".encode("ascii"))
        continue
    fd = None
    try:
        fd = os.open(
            abs_path,
            os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC,
        )
    except OSError:
        degraded = True
        h.update(b"unreadable\n")
        continue
    try:
        fst = os.fstat(fd)
        if not stat.S_ISREG(fst.st_mode):
            degraded = True
            mode = stat.S_IFMT(fst.st_mode)
            h.update(f"special_post_swap:{mode:o}:{fst.st_size}\n".encode("ascii"))
            continue
        if (fst.st_dev, fst.st_ino) != (lst.st_dev, lst.st_ino):
            degraded = True
            h.update(b"identity_changed\n")
            continue
        if fst.st_size > MAX_SINGLE_FILE_BYTES:
            degraded = True
            h.update(f"toolarge:{fst.st_size}\n".encode("ascii"))
            continue
        if bytes_read + fst.st_size > MAX_UNTRACKED_TOTAL_BYTES:
            degraded = True
            h.update(b"TRUNCATED_TOTAL_BYTES\n")
            break
        with os.fdopen(fd, "rb") as f:
            fd = None
            data = f.read(MAX_SINGLE_FILE_BYTES + 1)
    except OSError:
        degraded = True
        h.update(b"unreadable\n")
        continue
    finally:
        if fd is not None:
            try:
                os.close(fd)
            except OSError:
                pass
    bytes_read += len(data)
    h.update(hashlib.sha256(data).hexdigest().encode("ascii"))
    h.update(b"\n")
h.update(b"\nSNAPSHOT\n")
try:
    with open(snapshot, "rb") as f:
        h.update(hashlib.sha256(f.read()).hexdigest().encode("ascii"))
        h.update(b"\n")
except OSError:
    h.update(b"missing\n")
sys.stdout.write(h.hexdigest())
sys.exit(3 if degraded else 0)
PY
  local fingerprint_rc=$?
  local fingerprint
  fingerprint="$(cat "$fingerprint_tmp" 2>/dev/null)"
  rm -f "$fingerprint_tmp"
  if [[ -z "$fingerprint" ]]; then
    # GNU stat uses -c; BSD/macOS stat uses -f.
    local snapshot_mtime
    snapshot_mtime="$(stat -c '%Y' "$snapshot_file" 2>/dev/null || stat -f '%m' "$snapshot_file" 2>/dev/null)"
    fingerprint="$(printf '%s:%s' "$repo" "$snapshot_mtime" | shasum -a 256 | awk '{print $1}')"
    fingerprint_rc=3
  fi

  local marker_key_src marker_key marker
  marker_key_src="$(printf '%s:%s:%s' "${session_id:-nosession}" "$repo" "$fingerprint")"
  marker_key="$(printf '%s' "$marker_key_src" | shasum -a 256 2>/dev/null | awk '{print $1}')"
  if [[ -z "$marker_key" ]]; then
    marker_key="$(printf '%s' "$marker_key_src" | md5sum | awk '{print $1}')"
  fi
  marker="$data_dir/stop-review-v2-$marker_key"

  if [[ "${fingerprint_rc:-0}" -eq 0 && -f "$marker" ]]; then
    # Already reviewed with this exact fingerprint; caller should NOT
    # count this against the per-turn attempt budget. Distinct return
    # code lets the dispatcher continue past debounced children to the
    # next candidate instead of starving older unreviewed repos.
    return 20
  fi

  if ! claudio_codexa_available; then
    return 0
  fi

  local out rc
  out="$(claudio_codexa_run 30 post-edit-review "$repo" --change-type unknown --budget 1600 --limit 8 2>&1)"
  rc=$?

  local safe_repo
  safe_repo="$(claudio_display_path "$repo")"

  if [[ $rc -ne 0 ]]; then
    cat >&2 <<EOF
[codexa] Post-edit review failed: rc=$rc repo=$safe_repo; debounce marker unchanged, next turn retries.
[codexa] Run the review by hand to see the full output: /codexa-review
EOF
    return 0
  fi

  if [[ "${fingerprint_rc:-0}" -eq 0 ]]; then
    touch "$marker" 2>/dev/null || true
  fi

  if [[ -z "$out" ]]; then
    return 0
  fi

  local summary_fields
  summary_fields="$(claudio_parse_post_edit_summary "$out")"
  cat >&2 <<EOF
[codexa] Post-edit review for $safe_repo:
$(printf '%s\n' "$summary_fields" | sed 's/^/  /')
[codexa] Full review: run /codexa-review or codexa post-edit-review $safe_repo
EOF

  claudio_stop_collect_block "$safe_repo" "$out" "$summary_fields"

  return 0
}

# When a review's verdict warrants attention (replan, or inspect classified
# blocking), record one model-facing reason line for the final Stop JSON.
# Only enum-validated tokens, sanitized paths, and plugin-controlled text
# are used — raw CLI output never flows into the reason.
# Blocking is an OPT-IN tied to an explicit change_plan snapshot: reviews
# against a hook-saved implicit baseline (the user never declared a plan)
# stay stderr-only, whatever their verdict. Without this gate, installing
# the plugin would by itself escalate every untested edit into a forced
# extra turn.
claudio_stop_collect_block() {
  local safe_repo="$1"
  local out="$2"
  local summary_fields="$3"
  [[ "${CLAUDIO_STOP_BLOCK:-1}" == "0" ]] && return 0
  [[ -z "${_CLAUDIO_BLOCK_FILE:-}" ]] && return 0
  local fields verdict inspect origin
  fields="$(claudio_parse_post_edit_verdict "$out")"
  verdict="$(printf '%s\n' "$fields" | sed -n 's/^verdict=//p')"
  inspect="$(printf '%s\n' "$fields" | sed -n 's/^inspect=//p')"
  origin="$(printf '%s\n' "$fields" | sed -n 's/^origin=//p')"
  if [[ "$origin" == "implicit" ]]; then
    return 0
  fi
  local label
  if [[ "$verdict" == "replan" ]]; then
    label="replan"
  elif [[ "$verdict" == "inspect" && "$inspect" == "blocking" ]]; then
    label="inspect (blocking)"
  else
    return 0
  fi
  # Zero counts are usually a budget-truncation artifact (the summary
  # sections render after the bulk sections and fall off small review
  # budgets), not a signal — drop them rather than mislead the model.
  local counts
  counts="$(printf '%s\n' "$summary_fields" | grep -v ' count=0$' | tr '\n' ' ' | sed 's/ *$//')"
  if [[ -n "$counts" ]]; then
    printf 'Codexa post-edit review for %s: verdict=%s. %s\n' "$safe_repo" "$label" "$counts" >>"$_CLAUDIO_BLOCK_FILE" 2>/dev/null || true
  else
    printf 'Codexa post-edit review for %s: verdict=%s.\n' "$safe_repo" "$label" >>"$_CLAUDIO_BLOCK_FILE" 2>/dev/null || true
  fi
}

# Emit the Stop hook JSON block decision when any reviewed repo produced a
# blockworthy verdict. Exit code stays 0; the JSON carries the decision.
claudio_emit_stop_block() {
  [[ -z "${_CLAUDIO_BLOCK_FILE:-}" ]] && return 0
  [[ ! -s "$_CLAUDIO_BLOCK_FILE" ]] && return 0
  local reasons reason_json
  reasons="$(cat "$_CLAUDIO_BLOCK_FILE" 2>/dev/null)"
  [[ -z "$reasons" ]] && return 0
  reason_json="$(claudio_json_escape "[codexa] ${reasons}
Address the drift or run the recommended verification, then re-check with the post_edit_review MCP tool or /codexa-review. If the remaining drift is intended, briefly state why before finishing. (This drift block fires at most once per stop and per dirty-tree state; it will not loop.)")"
  printf '{"decision":"block","reason":"%s"}\n' "$reason_json"
}

# ---------------------------------------------------------------------------
# Main dispatcher.

payload="$(cat)"
if [[ -z "$payload" ]]; then
  exit 0
fi

cwd="$(printf '%s' "$payload" | claudio_json_field cwd)"
session_id="$(printf '%s' "$payload" | claudio_json_field session_id)"
stop_hook_active="$(printf '%s' "$payload" | claudio_json_field stop_hook_active)"

# Re-entrancy guard — when a Stop hook's block decision re-triggers Claude,
# stop_hook_active becomes true; don't loop. JSON booleans round-trip
# through python's str() as "True"/"False"; normalize case before compare.
# (claudio_lowercase, not `${var,,}`: bash 3.2 on stock macOS aborts the
# whole script on the bash-4 substitution.)
if [[ "$(claudio_lowercase "$stop_hook_active")" == "true" ]]; then
  exit 0
fi

[[ -z "$cwd" ]] && exit 0

# Choose a state dir up front. The debounce marker lives OUTSIDE the repo
# so it never shows up in the repo's own dirty-tree fingerprint.
default_state_dir="${XDG_STATE_HOME:-$HOME/.local/state}/codexa-claude-code"
data_dir="${CLAUDE_PLUGIN_DATA:-$default_state_dir}"
mkdir -p "$data_dir" 2>/dev/null || true

# Blockworthy review verdicts accumulate here and are emitted as one Stop
# JSON decision from the EXIT trap — so a hook-timeout SIGTERM mid-review
# (worst case: 3 sequential repo reviews can exceed the 35s hook budget)
# still surfaces whatever was already found instead of failing open.
# Missing mktemp degrades to stderr-only behavior.
_CLAUDIO_BLOCK_FILE="$(mktemp 2>/dev/null)" || _CLAUDIO_BLOCK_FILE=""
_claudio_stop_finalize() {
  claudio_emit_stop_block
  [[ -n "${_CLAUDIO_BLOCK_FILE:-}" ]] && rm -f "$_CLAUDIO_BLOCK_FILE"
  _CLAUDIO_BLOCK_FILE=""
}
trap '_claudio_stop_finalize' EXIT
trap 'exit 124' TERM INT

# Mode 1: cwd is inside a wired repo with a snapshot — review that single repo.
# If a wired workspace parent has no snapshot, fall through to the child scan
# so a parent `.codex/config.toml` cannot mask active child repo reviews.
repo="$(claudio_find_codexa_repo "$cwd")"
if [[ -n "$repo" ]] && claudio_has_snapshot "$repo"; then
  # Defend against a configured state dir that resolves inside the repo —
  # a marker written there would invalidate its own debounce every turn.
  data_dir_real="$(claudio_realpath "$data_dir")"
  repo_real="$(claudio_realpath "$repo")"
  if [[ -n "$data_dir_real" && -n "$repo_real" && "$data_dir_real" == "$repo_real"* ]]; then
    data_dir="$default_state_dir"
    mkdir -p "$data_dir" 2>/dev/null || true
  fi
  claudio_stop_review_one "$repo" "$session_id" "$data_dir"
  exit 0
fi

# Mode 2: cwd is above any wired repo. Scan direct children, rank ALL of
# them by snapshot mtime (bounded at 32), and iterate the ranked list.
# Each child runs through claudio_stop_review_one, which returns 20 when
# it silently skips a debounced fingerprint (no actual review happened)
# and 0 otherwise. The dispatcher counts only 0-returns against the
# per-turn attempt budget, so debounced top-ranked children never starve
# older unreviewed repos.
declare -a _child_repos=()
while IFS= read -r _c; do
  [[ -z "$_c" ]] && continue
  _child_repos+=("$_c")
done < <(claudio_list_child_codexa_repos "$cwd")
if [[ ${#_child_repos[@]} -eq 0 ]]; then
  exit 0
fi

attempts_used=0
while IFS= read -r _ranked_line; do
  [[ -z "$_ranked_line" ]] && continue
  if (( attempts_used >= MAX_STOP_REPOS_PER_TURN )); then
    break
  fi
  candidate="${_ranked_line%%$'\t'*}"
  [[ -z "$candidate" ]] && continue
  # Protect against a state dir nested inside any candidate repo.
  data_dir_real="$(claudio_realpath "$data_dir")"
  cand_real="$(claudio_realpath "$candidate")"
  if [[ -n "$data_dir_real" && -n "$cand_real" && "$data_dir_real" == "$cand_real"* ]]; then
    data_dir="$default_state_dir"
    mkdir -p "$data_dir" 2>/dev/null || true
  fi
  set +e
  claudio_stop_review_one "$candidate" "$session_id" "$data_dir"
  review_rc=$?
  set -e
  if [[ "$review_rc" -ne 20 ]]; then
    attempts_used=$((attempts_used + 1))
  fi
done < <(claudio_rank_child_repos_by_snapshot 32 "${_child_repos[@]}")

exit 0
