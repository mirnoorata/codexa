#!/usr/bin/env bash
# Shared helpers for claudio hooks. Never write to the user's repo. Fail safe —
# if anything goes wrong, exit 0 so the session never gets blocked.
#
# All functions:
#   - take primitive args (paths, tool names) and return via stdout
#   - never read stdin (hook scripts read stdin once, then pass fields)
#   - emit diagnostic output to stderr under CLAUDIO_DEBUG=1

set -u

# Resolve how to invoke Codexa. Priority:
#   1. $CODEXA_CLI env var (explicit path to dist/cli.js) — user override.
#   2. <checkout>/dist/cli.js walked up from this script — when the plugin
#      is loaded directly from a codexa checkout via --plugin-dir.
#   3. `codexa` on $PATH — when the user ran `npm install -g @mirnoorata/codexa`
#      (the supported path once the plugin is copied into the Claude Code
#      plugin cache, where the walk-up no longer points at a real checkout).
#
# _CODEXA_INVOKE is a bash array — the full argv to launch Codexa. Hooks
# invoke it via `"${_CODEXA_INVOKE[@]}" <codexa args...>`.
NODE_BIN="${CLAUDIO_NODE_BIN:-node}"
_codexa_lib_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd -P)" || _codexa_lib_dir=""
_codexa_root_guess="$(cd "${_codexa_lib_dir}/../../../.." 2>/dev/null && pwd -P)" || _codexa_root_guess=""
_codexa_cli_guess="${_codexa_root_guess}/dist/cli.js"
_CODEXA_INVOKE=()
if [[ -n "${CODEXA_CLI:-}" ]]; then
  _CODEXA_INVOKE=("$NODE_BIN" "$CODEXA_CLI")
elif [[ -f "$_codexa_cli_guess" ]]; then
  CODEXA_CLI="$_codexa_cli_guess"
  _CODEXA_INVOKE=("$NODE_BIN" "$CODEXA_CLI")
elif command -v codexa >/dev/null 2>&1; then
  CODEXA_CLI="$(command -v codexa)"
  _CODEXA_INVOKE=("$CODEXA_CLI")
else
  CODEXA_CLI=""
fi

claudio_log() {
  if [[ "${CLAUDIO_DEBUG:-0}" == "1" ]]; then
    printf '[claudio] %s\n' "$*" >&2
  fi
}

claudio_is_wired_repo() {
  local repo="${1:-}"
  [[ -z "$repo" ]] && return 1
  [[ ! -d "$repo" ]] && return 1
  python3 - "$repo" <<'PY' 2>/dev/null
import os
import stat
import sys

repo = sys.argv[1]
repo_fd = codex_fd = config_fd = None
try:
    repo_fd = os.open(repo, os.O_RDONLY | os.O_NOFOLLOW | os.O_DIRECTORY | os.O_CLOEXEC)
    codex_fd = os.open(".codex", os.O_RDONLY | os.O_NOFOLLOW | os.O_DIRECTORY | os.O_CLOEXEC, dir_fd=repo_fd)
    config_fd = os.open("config.toml", os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=codex_fd)
    st = os.fstat(config_fd)
    sys.exit(0 if stat.S_ISREG(st.st_mode) else 1)
except OSError:
    sys.exit(1)
finally:
    for fd in (config_fd, codex_fd, repo_fd):
        if fd is not None:
            try:
                os.close(fd)
            except OSError:
                pass
PY
}

# Print the nearest ancestor directory that contains a .codex/config.toml
# (a codexa-wired repo), or empty if not found. Refuses to traverse above
# the user's home directory or return "/".
claudio_find_codexa_repo() {
  local start_dir="${1:-}"
  [[ -z "$start_dir" ]] && return 0
  [[ ! -d "$start_dir" ]] && return 0
  local dir
  dir="$(cd "$start_dir" 2>/dev/null && pwd -P)" || return 0
  local home_real
  home_real="$(cd "$HOME" 2>/dev/null && pwd -P)" || home_real=""
  while [[ -n "$dir" && "$dir" != "/" ]]; do
    if claudio_is_wired_repo "$dir"; then
      printf '%s\n' "$dir"
      return 0
    fi
    if [[ -n "$home_real" && "$dir" == "$home_real" ]]; then
      return 0
    fi
    dir="$(dirname "$dir")"
  done
  return 0
}

# Return 0 if the argument names a code-editing tool we want to guard.
claudio_is_edit_tool() {
  case "${1:-}" in
    Edit|Write|MultiEdit|NotebookEdit)
      return 0
      ;;
  esac
  return 1
}

# Return 0 if the Codexa CLI is invocable (either node+cli.js or PATH codexa).
claudio_codexa_available() {
  [[ ${#_CODEXA_INVOKE[@]} -gt 0 ]] || return 1
  # If invoking via node, also require the node binary to be present.
  if [[ "${_CODEXA_INVOKE[0]}" == "$NODE_BIN" ]]; then
    command -v "$NODE_BIN" >/dev/null 2>&1 || return 1
  fi
  return 0
}

# Run the codexa CLI with a hard timeout and stdout capped. Args after the
# timeout are forwarded. Returns the CLI's exit status, or 124 on timeout.
claudio_codexa_run() {
  local seconds="$1"
  shift
  if ! claudio_codexa_available; then
    claudio_log "codexa CLI unavailable; skipping"
    return 127
  fi
  timeout --preserve-status "${seconds}s" "${_CODEXA_INVOKE[@]}" "$@"
}

# Emit a JSON string from a bash variable. Minimal escape set that covers
# backslash, double-quote, and control chars — sufficient for our own
# status/advisory text. Avoids taking a jq dependency.
claudio_json_escape() {
  local value="${1:-}"
  printf '%s' "$value" | awk '
    BEGIN {
      for (i = 0; i < 32; i++) esc[sprintf("%c", i)] = sprintf("\\u%04x", i)
      esc["\\"] = "\\\\"
      esc["\""] = "\\\""
      esc["\n"] = "\\n"
      esc["\t"] = "\\t"
      esc["\r"] = "\\r"
    }
    {
      if (NR > 1) {
        printf "\\n"
      }
      for (i = 1; i <= length($0); i++) {
        c = substr($0, i, 1)
        if (c in esc) {
          printf "%s", esc[c]
        } else {
          printf "%s", c
        }
      }
    }
  '
}

# Parse a top-level string field out of a JSON object read on stdin.
# Matches `"key"\s*:\s*"value"` with basic backslash-escape handling.
# Good enough for the hook schema (session_id/cwd/tool_name are strings);
# does not handle nested objects.
claudio_json_field() {
  local key="${1:-}"
  [[ -z "$key" ]] && return 0
  python3 -c "
import json, sys
try:
    data = json.load(sys.stdin)
except Exception:
    sys.exit(0)
value = data.get('$key', '')
if isinstance(value, (dict, list)):
    value = json.dumps(value)
elif value is None:
    value = ''
sys.stdout.write(str(value))
"
}

# Extract a nested tool_input field (string). Example:
#   claudio_tool_input_field file_path < payload
# Uses python3 for correctness — shell regex isn't safe on JSON.
claudio_tool_input_field() {
  local key="${1:-}"
  [[ -z "$key" ]] && return 0
  python3 -c "
import json, sys
try:
    data = json.load(sys.stdin)
except Exception:
    sys.exit(0)
tool_input = data.get('tool_input') or {}
if not isinstance(tool_input, dict):
    sys.exit(0)
value = tool_input.get('$key', '')
if isinstance(value, (dict, list)):
    value = json.dumps(value)
elif value is None:
    value = ''
sys.stdout.write(str(value))
"
}

# Resolve a path as absolute, collapsing symlinks. Prints nothing on failure.
# `target` is untrusted hook input (tool_input.file_path / notebook_path),
# so it must never be interpolated into shell or Python source. We pass it
# via argv[1] to python3, or via the `--` argument sentinel to coreutils
# realpath when available.
claudio_realpath() {
  local target="${1:-}"
  [[ -z "$target" ]] && return 0
  if command -v realpath >/dev/null 2>&1; then
    realpath -m -- "$target" 2>/dev/null
    return 0
  fi
  python3 - "$target" <<'PY' 2>/dev/null
import os
import sys

try:
    sys.stdout.write(os.path.realpath(sys.argv[1]))
except Exception:
    sys.exit(0)
PY
}

# Display-sanitize a filesystem-controlled string for transcript / stderr
# output. Every non-printable byte is replaced by a visible escape sequence,
# AND the whole value is wrapped in shell quoting. That produces a single-
# line, single-token form so a hostile filename cannot inject extra lines
# or prose into hook output. `shlex.quote` alone is insufficient — it
# preserves real newlines inside single quotes.
claudio_display_path() {
  local target="${1:-}"
  [[ -z "$target" ]] && return 0
  python3 - "$target" <<'PY' 2>/dev/null
import shlex
import sys

try:
    raw = sys.argv[1]
    # 1. Escape every control character (newline, tab, etc.) and non-ASCII
    #    byte into a visible backslash-escape sequence. unicode_escape
    #    always yields ASCII-safe text.
    visible = raw.encode("unicode_escape").decode("ascii")
    # 2. Wrap in shell-quoting for unambiguous display as one token.
    sys.stdout.write(shlex.quote(visible))
except Exception:
    sys.exit(0)
PY
}

# List direct-child directories of `start_dir` that contain a
# `.codex/config.toml`. One absolute path per line, sorted by most-recently-
# modified config first.
#
# EVERY path component is validated without symlink following. We open the
# child dir with O_NOFOLLOW | O_DIRECTORY, then `.codex` relative to that
# fd with the same flags, then `config.toml` relative to the `.codex` fd
# with O_NOFOLLOW and a regular-file fstat check. A hostile layout where
# `<child>/.codex` is itself a symlink (even if it resolves to a real
# `.codex` dir somewhere else) is rejected — never follow-through.
# Scan capped at MAX_CHILD_SCAN to keep the sweep cheap.
claudio_list_child_codexa_repos() {
  local start_dir="${1:-}"
  [[ -z "$start_dir" ]] && return 0
  [[ ! -d "$start_dir" ]] && return 0
  local dir
  dir="$(cd "$start_dir" 2>/dev/null && pwd -P)" || return 0
  python3 - "$dir" <<'PY' 2>/dev/null
import os
import stat
import sys

# Two independent caps so a parent with many non-wired dirs can't burn the
# hook budget on lstat/open attempts.
#   MAX_ENTRIES_SCANNED — cap on directory entries we inspect at all,
#     regardless of whether any are wired. Guards against 10k-child parents.
#   MAX_WIRED_ACCEPTED — cap on wired repos we list in the output. Keeps
#     the banner and downstream work bounded.
MAX_ENTRIES_SCANNED = 256
MAX_WIRED_ACCEPTED = 64

start = sys.argv[1]
try:
    entries = sorted(os.listdir(start))
except OSError:
    sys.exit(0)


def safe_check_wired(parent_path):
    """Return the config.toml st_mtime if parent_path is a wired repo,
    with every path component opened via O_NOFOLLOW so intermediate
    symlinks (`.codex -> /elsewhere/.codex`) are rejected. Returns None
    otherwise."""
    parent_fd = None
    codex_fd = None
    config_fd = None
    try:
        try:
            parent_fd = os.open(
                parent_path,
                os.O_RDONLY | os.O_NOFOLLOW | os.O_DIRECTORY | os.O_CLOEXEC,
            )
        except OSError:
            return None
        try:
            codex_fd = os.open(
                ".codex",
                os.O_RDONLY | os.O_NOFOLLOW | os.O_DIRECTORY | os.O_CLOEXEC,
                dir_fd=parent_fd,
            )
        except OSError:
            return None
        try:
            config_fd = os.open(
                "config.toml",
                os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC,
                dir_fd=codex_fd,
            )
        except OSError:
            return None
        try:
            st = os.fstat(config_fd)
        except OSError:
            return None
        if not stat.S_ISREG(st.st_mode):
            return None
        return st.st_mtime
    finally:
        for fd in (config_fd, codex_fd, parent_fd):
            if fd is not None:
                try:
                    os.close(fd)
                except OSError:
                    pass


candidates = []
scanned = 0
accepted = 0
for name in entries:
    if name.startswith("."):
        continue
    # Parent-scan output is consumed by shell loops. Refuse control-character
    # names instead of letting a newline or tab become a fake second repo.
    if any(ord(ch) < 32 or ord(ch) == 127 for ch in name):
        continue
    if scanned >= MAX_ENTRIES_SCANNED:
        break
    scanned += 1
    path = os.path.join(start, name)
    try:
        st = os.lstat(path)
    except OSError:
        continue
    # Must be a real directory. Symlinks are never followed.
    if not stat.S_ISDIR(st.st_mode):
        continue
    mtime = safe_check_wired(path)
    if mtime is None:
        continue
    candidates.append((mtime, path))
    accepted += 1
    if accepted >= MAX_WIRED_ACCEPTED:
        break

# Most-recently-modified .codex/config.toml first.
candidates.sort(key=lambda item: item[0], reverse=True)
for _, path in candidates:
    sys.stdout.write(path)
    sys.stdout.write("\n")
PY
}

# Locate the most-recent `<repo>/.codex/cache/codexa-tasks/latest.json`
# among the given repo paths. Every intermediate (.codex/, .codex/cache/,
# .codex/cache/codexa-tasks/, latest.json) is opened with O_NOFOLLOW so a
# hostile symlinked intermediate is rejected before we trust the mtime.
# Prints "<repo>\t<mtime_epoch>" for the top `limit` repos, skipping any
# without a valid snapshot.
claudio_rank_child_repos_by_snapshot() {
  local limit="${1:-3}"
  shift || return 0
  [[ $# -eq 0 ]] && return 0
  python3 - "$limit" "$@" <<'PY' 2>/dev/null
import os
import stat
import sys

limit = max(1, min(int(sys.argv[1] or "3"), 32))
repos = sys.argv[2:]


def safe_snapshot_mtime(repo):
    fds = []

    def open_component(name, parent_fd, *, is_dir):
        flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC
        if is_dir:
            flags |= os.O_DIRECTORY
        try:
            fd = os.open(name, flags, dir_fd=parent_fd)
        except OSError:
            return None
        fds.append(fd)
        return fd

    try:
        try:
            repo_fd = os.open(
                repo,
                os.O_RDONLY | os.O_NOFOLLOW | os.O_DIRECTORY | os.O_CLOEXEC,
            )
        except OSError:
            return None
        fds.append(repo_fd)

        codex_fd = open_component(".codex", repo_fd, is_dir=True)
        if codex_fd is None:
            return None
        cache_fd = open_component("cache", codex_fd, is_dir=True)
        if cache_fd is None:
            return None
        tasks_fd = open_component("codexa-tasks", cache_fd, is_dir=True)
        if tasks_fd is None:
            return None
        snap_fd = open_component("latest.json", tasks_fd, is_dir=False)
        if snap_fd is None:
            return None
        try:
            st = os.fstat(snap_fd)
        except OSError:
            return None
        if not stat.S_ISREG(st.st_mode):
            return None
        return st.st_mtime
    finally:
        for fd in fds:
            try:
                os.close(fd)
            except OSError:
                pass


scored = []
for repo in repos:
    mtime = safe_snapshot_mtime(repo)
    if mtime is None:
        continue
    scored.append((mtime, repo))

scored.sort(key=lambda item: item[0], reverse=True)
for mtime, repo in scored[:limit]:
    sys.stdout.write(f"{repo}\t{int(mtime)}\n")
PY
}

# Wrap a block of repo-controlled text in an unambiguous data fence and
# sanitize each line so a malicious line that starts with "SYSTEM:",
# "USER:", etc. cannot look like a fresh prompt-turn boundary. Control
# characters are escaped to visible backslash forms. Size is capped at
# `max_bytes` (default 8192) — any excess is replaced by a truncation
# marker — so a large hostile README can't inflate session context.
#
# Usage: claudio_fence_block TITLE "raw text" [MAX_BYTES]
claudio_fence_block() {
  local title="${1:-DATA}"
  local text="${2:-}"
  local max_bytes="${3:-8192}"
  [[ -z "$text" ]] && return 0
  python3 - "$title" "$text" "$max_bytes" <<'PY' 2>/dev/null
import sys

title = sys.argv[1]
text = sys.argv[2]
try:
    max_bytes = int(sys.argv[3])
except ValueError:
    max_bytes = 8192

if len(text) > max_bytes:
    text = text[:max_bytes] + f"\n[...truncated, {len(text) - max_bytes} bytes omitted...]"

safe_lines = []
for raw_line in text.splitlines():
    # 1. Escape every control character / non-ASCII byte so nothing in the
    #    repo-controlled string can introduce a new line or a hidden byte
    #    to the model.
    escaped = raw_line.encode("unicode_escape").decode("ascii")
    # 2. Prefix every line with two spaces so any leading "SYSTEM:",
    #    "USER:", "ASSISTANT:", "TOOL:", etc. never anchors at column 0
    #    where the model might read it as a turn boundary marker.
    safe_lines.append("  " + escaped)

fence_open = f"<<{title}>>"
fence_close = f"<<END_{title}>>"
sys.stdout.write(fence_open + "\n" + "\n".join(safe_lines) + "\n" + fence_close)
PY
}

# Strict parsers for codexa CLI/README output. These do NOT escape repo-
# controlled text — they parse known-shape lines against narrow regex +
# character allowlists and DROP anything that does not match. The output
# is plugin-controlled labels + validated field values, never free-form
# repo prose. This is the trust boundary that prevents prompt injection
# through `additionalContext` / hook stderr.

# Parse the short `codexa status` output into strict key=value lines. All
# fields optional; invalid lines are dropped silently.
# Safe output format:
#   freshness=<token>
#   commit=<hex>
#   indexed_at=<iso8601>
#   dirty_files=<int>
#   parser_errors=<int>
claudio_parse_codexa_status() {
  local raw="${1:-}"
  [[ -z "$raw" ]] && return 0
  python3 - "$raw" <<'PY' 2>/dev/null
import re
import sys

raw = sys.argv[1]
# Each rule: regex → label. The regex must match the WHOLE line after any
# whitespace trimming and must use strict character classes only.
rules = [
    (re.compile(r"^Codexa status:\s+(?P<v>[a-z][a-z0-9_\-]{0,32})(?:\s+\([a-z0-9_\-]{0,64}\))?\s*$"),
     "freshness"),
    (re.compile(r"^Commit:\s+(?P<v>[0-9a-f]{7,40})\s*$"),
     "commit"),
    (re.compile(r"^Indexed:\s+(?P<v>\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?)\s*$"),
     "indexed_at"),
    (re.compile(r"^Dirty files:\s+(?P<v>\d{1,6})\s*$"),
     "dirty_files"),
    (re.compile(r"^Parser errors:\s+(?P<v>\d{1,6})\s*$"),
     "parser_errors"),
]

lines = []
for line in raw.splitlines():
    stripped = line.strip()
    if not stripped:
        continue
    for rx, label in rules:
        m = rx.match(stripped)
        if m:
            lines.append(f"{label}={m.group('v')}")
            break
sys.stdout.write("\n".join(lines))
PY
}

# Extract up to `max_entries` (default 8) numbered read-first bullets from
# a `.codex/codebase/README.md`. Each bullet must look like:
#   N. `path/to/file.ts` - rank 42.68  ...rest ignored...
#   N. path/to/file.ts - rank 42.68    ...rest ignored...
# `path` is only accepted if it matches [A-Za-z0-9._/-]+ (no spaces, no
# control chars, no `..`, no absolute prefix) and is <= 256 chars. Rank
# must be a plain decimal. Anything else is dropped — no escape fallback.
# Output: one entry per line, format "path<TAB>rank"
claudio_parse_read_first() {
  local raw="${1:-}"
  local max_entries="${2:-8}"
  [[ -z "$raw" ]] && return 0
  python3 - "$raw" "$max_entries" <<'PY' 2>/dev/null
import re
import sys

raw = sys.argv[1]
try:
    max_entries = int(sys.argv[2])
except ValueError:
    max_entries = 8
if max_entries < 1 or max_entries > 64:
    max_entries = 8

PATH_RX = re.compile(r"^[A-Za-z0-9_.\-/]+$")
BULLET_RX = re.compile(
    r"^\s*\d+\.\s+`?([^`\s]{1,256})`?\s+-\s+rank\s+([0-9]{1,4}(?:\.[0-9]{1,4})?)"
)

in_section = False
emitted = 0
out_lines = []
for line in raw.splitlines():
    stripped = line.strip()
    if stripped.startswith("## "):
        in_section = bool(re.match(r"^##\s+Read First\b", stripped))
        continue
    if not in_section:
        continue
    m = BULLET_RX.match(line)
    if not m:
        continue
    path, rank = m.group(1), m.group(2)
    if ".." in path or path.startswith("/") or not PATH_RX.match(path):
        continue
    out_lines.append(f"{path}\t{rank}")
    emitted += 1
    if emitted >= max_entries:
        break
sys.stdout.write("\n".join(out_lines))
PY
}

# Parse the `codexa post-edit` output into strict section headers + bullet
# counts. We do NOT carry the raw content through — hostile CLI output
# cannot smuggle prose via this channel. Output format:
#   section=<slug> count=<n>
# where slug is one of {drift_reasons, next_actions, tests_unaccounted,
# known_gaps, verification_ledger}.
claudio_parse_post_edit_summary() {
  local raw="${1:-}"
  [[ -z "$raw" ]] && return 0
  python3 - "$raw" <<'PY' 2>/dev/null
import re
import sys

raw = sys.argv[1]
sections = {
    "Drift reasons:": "drift_reasons",
    "Next actions:": "next_actions",
    "Tests still unaccounted for:": "tests_unaccounted",
    "Known gaps:": "known_gaps",
    "Verification ledger:": "verification_ledger",
}
BULLET_RX = re.compile(r"^\s*[-*\u2022]\s+\S")

current = None
counts = {v: 0 for v in sections.values()}
for line in raw.splitlines():
    stripped = line.rstrip()
    if not stripped:
        current = None
        continue
    if stripped in sections:
        current = sections[stripped]
        continue
    if current and BULLET_RX.match(stripped):
        counts[current] += 1
    else:
        # Non-bullet line resets the current section so free-form prose
        # between known headings does not inflate counts.
        if stripped.startswith("## "):
            current = None

for key in ["drift_reasons", "next_actions", "tests_unaccounted", "known_gaps", "verification_ledger"]:
    sys.stdout.write(f"section={key} count={counts[key]}\n")
PY
}

# Tasks dir holds codexa change-plan snapshots. Returns 0 if a 'latest.json'
# exists for this repo.
claudio_has_snapshot() {
  local repo="${1:-}"
  [[ -z "$repo" ]] && return 1
  python3 - "$repo" <<'PY' 2>/dev/null
import os
import stat
import sys

repo = sys.argv[1]
fds = []
try:
    fd = os.open(repo, os.O_RDONLY | os.O_NOFOLLOW | os.O_DIRECTORY | os.O_CLOEXEC)
    fds.append(fd)
    for component in (".codex", "cache", "codexa-tasks"):
        fd = os.open(component, os.O_RDONLY | os.O_NOFOLLOW | os.O_DIRECTORY | os.O_CLOEXEC, dir_fd=fds[-1])
        fds.append(fd)
    latest_fd = os.open("latest.json", os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=fds[-1])
    fds.append(latest_fd)
    st = os.fstat(latest_fd)
    sys.exit(0 if stat.S_ISREG(st.st_mode) else 1)
except OSError:
    sys.exit(1)
finally:
    for fd in reversed(fds):
        try:
            os.close(fd)
        except OSError:
            pass
PY
}
