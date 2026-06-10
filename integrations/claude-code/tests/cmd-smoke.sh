#!/usr/bin/env bash
# Unit tests for the /codexa-* slash-command helper scripts. Each test
# invokes the shell helper with a synthetic "$ARGUMENTS" string and asserts
# on exit code / stderr. codexa CLI is stubbed so these tests don't require
# an index.
#
# Run:  bash integrations/claude-code/tests/cmd-smoke.sh  (from the codexa repo root)

set -u

INTEG_ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

PASS=0
FAIL=0

pass() { PASS=$((PASS + 1)); printf '  PASS  %s\n' "$1"; }
fail() { FAIL=$((FAIL + 1)); printf '  FAIL  %s\n    %s\n' "$1" "$2"; }
section() { printf '\n== %s ==\n' "$1"; }

# Stub codexa CLI: prints each forwarded argument on its own line so tests
# can grep for exact values without worrying about shell escaping.
STUB_NODE="$TMP/stub-node"
STUB_CLI="$TMP/stub-cli.js"
: > "$STUB_CLI"
cat >"$STUB_NODE" <<'EOF'
#!/usr/bin/env bash
# Skip the first argument (path to the fake CLI), then dump the rest with
# one arg per line prefixed by `ARG: `.
shift
for a in "$@"; do
  printf 'ARG: %s\n' "$a"
done
EOF
chmod +x "$STUB_NODE"

# Stub codexa CLI that fails with non-zero exit.
FAIL_NODE="$TMP/stub-fail"
cat >"$FAIL_NODE" <<'EOF'
#!/usr/bin/env bash
printf 'STUB ERROR: simulated failure\n' >&2
exit 3
EOF
chmod +x "$FAIL_NODE"

make_wired_repo() {
  local dir="$1"
  mkdir -p "$dir/.codex/cache/codexa-tasks"
  cat >"$dir/.codex/config.toml" <<'TOML'
[features]
hooks = true
TOML
}

run_cmd() {
  local helper="$1"
  local argstr="$2"
  local workdir="$3"
  local node_bin="${4:-$STUB_NODE}"
  local cli="${5:-$STUB_CLI}"
  local stdout
  local stderr
  stdout="$(mktemp)"
  stderr="$(mktemp)"
  (
    cd "$workdir"
    env -i HOME="$HOME" PATH="$PATH" \
      CLAUDIO_NODE_BIN="$node_bin" CODEXA_CLI="$cli" \
      CLAUDE_PLUGIN_ROOT="$INTEG_ROOT" \
      bash "$INTEG_ROOT/scripts/cmd/$helper" "$argstr"
  ) >"$stdout" 2>"$stderr"
  LAST_RC=$?
  LAST_STDOUT="$(cat "$stdout")"
  LAST_STDERR="$(cat "$stderr")"
  rm -f "$stdout" "$stderr"
}

# ---------- status ----------
section "status.sh"

REPO="$TMP/repo"
make_wired_repo "$REPO"
run_cmd "status.sh" "" "$REPO"
if [[ $LAST_RC -eq 0 ]] && printf '%s' "$LAST_STDOUT" | grep -Fxq "ARG: status" \
   && printf '%s' "$LAST_STDOUT" | grep -Fxq "ARG: $REPO"; then
  pass "status invokes codexa status with absolute repo root"
else
  fail "status invokes codexa status with absolute repo root" "rc=$LAST_RC stdout='$LAST_STDOUT'"
fi

EMPTY_PARENT="$TMP/empty"
mkdir -p "$EMPTY_PARENT"
run_cmd "status.sh" "" "$EMPTY_PARENT"
if [[ $LAST_RC -ne 0 ]] && printf '%s' "$LAST_STDERR" | grep -q "No codexa-wired"; then
  pass "status exits non-zero outside a wired repo"
else
  fail "status exits non-zero outside a wired repo" "rc=$LAST_RC stderr='$LAST_STDERR'"
fi

# Parent with exactly one wired child: auto-pick.
SOLO_PARENT="$TMP/solo"
mkdir -p "$SOLO_PARENT"
make_wired_repo "$SOLO_PARENT/only-child"
run_cmd "status.sh" "" "$SOLO_PARENT"
if [[ $LAST_RC -eq 0 ]] \
   && printf '%s' "$LAST_STDOUT" | grep -Fxq "ARG: status" \
   && printf '%s' "$LAST_STDOUT" | grep -Fxq "ARG: $SOLO_PARENT/only-child"; then
  pass "status auto-picks sole wired child of PWD"
else
  fail "status auto-picks sole wired child of PWD" "rc=$LAST_RC stdout='$LAST_STDOUT'"
fi

# Parent with multiple wired children: fan out, run status on each.
FAN_PARENT="$TMP/fan"
mkdir -p "$FAN_PARENT"
make_wired_repo "$FAN_PARENT/alpha"
make_wired_repo "$FAN_PARENT/beta"
run_cmd "status.sh" "" "$FAN_PARENT"
alpha_hits=$(printf '%s\n' "$LAST_STDOUT" | grep -Fc "ARG: $FAN_PARENT/alpha")
beta_hits=$(printf '%s\n' "$LAST_STDOUT" | grep -Fc "ARG: $FAN_PARENT/beta")
status_hits=$(printf '%s\n' "$LAST_STDOUT" | grep -Fxc "ARG: status")
if [[ $LAST_RC -eq 0 && $alpha_hits -eq 1 && $beta_hits -eq 1 && $status_hits -eq 2 ]] \
   && printf '%s' "$LAST_STDERR" | grep -q "fanning out status across 2"; then
  pass "status fans out across multiple wired children"
else
  fail "status fans out across multiple wired children" \
    "rc=$LAST_RC alpha=$alpha_hits beta=$beta_hits status=$status_hits stdout='$LAST_STDOUT' stderr='$LAST_STDERR'"
fi

# Fan-out must propagate a non-zero exit if any child fails.
run_cmd "status.sh" "" "$FAN_PARENT" "$FAIL_NODE"
if [[ $LAST_RC -ne 0 ]] && printf '%s' "$LAST_STDERR" | grep -q "simulated failure"; then
  pass "status fan-out propagates non-zero exit when a child fails"
else
  fail "status fan-out propagates non-zero exit when a child fails" \
    "rc=$LAST_RC stderr='$LAST_STDERR'"
fi

# ---------- brief ----------
section "brief.sh"

run_cmd "brief.sh" "" "$REPO"
if [[ $LAST_RC -eq 2 ]] && printf '%s' "$LAST_STDERR" | grep -q "Usage"; then
  pass "brief with no arguments prints usage and exits 2"
else
  fail "brief with no arguments prints usage and exits 2" "rc=$LAST_RC stderr='$LAST_STDERR'"
fi

TASK="fix the scrollbar in frame back-face"
run_cmd "brief.sh" "$TASK" "$REPO"
if [[ $LAST_RC -eq 0 ]] && printf '%s' "$LAST_STDOUT" | grep -Fxq "ARG: $TASK" \
   && printf '%s' "$LAST_STDOUT" | grep -Fxq "ARG: --diff"; then
  pass "brief passes the full task string through --task, preserving spaces"
else
  fail "brief passes the full task string through --task, preserving spaces" "rc=$LAST_RC stdout='$LAST_STDOUT'"
fi

# ---------- plan ----------
section "plan.sh"

run_cmd "plan.sh" "" "$REPO"
if [[ $LAST_RC -eq 2 ]] && printf '%s' "$LAST_STDERR" | grep -q "Usage"; then
  pass "plan with no arguments prints usage and exits 2"
else
  fail "plan with no arguments prints usage and exits 2" "rc=$LAST_RC stderr='$LAST_STDERR'"
fi

run_cmd "plan.sh" '"fix auth bug" src/auth.py' "$REPO"
if [[ $LAST_RC -eq 0 ]] \
   && printf '%s' "$LAST_STDOUT" | grep -Fxq "ARG: fix auth bug" \
   && printf '%s' "$LAST_STDOUT" | grep -Fxq "ARG: src/auth.py" \
   && printf '%s' "$LAST_STDOUT" | grep -Fxq "ARG: --save-snapshot"; then
  pass "plan parses quoted task and one file via shlex"
else
  fail "plan parses quoted task and one file via shlex" "rc=$LAST_RC stdout='$LAST_STDOUT'"
fi

run_cmd "plan.sh" '"redesign" "web/src/App.tsx" "web/src/styles.css"' "$REPO"
fileflags=$(printf '%s\n' "$LAST_STDOUT" | grep -Fc "ARG: --file")
if [[ $LAST_RC -eq 0 && $fileflags -eq 2 ]] \
   && printf '%s' "$LAST_STDOUT" | grep -Fxq "ARG: web/src/App.tsx" \
   && printf '%s' "$LAST_STDOUT" | grep -Fxq "ARG: web/src/styles.css"; then
  pass "plan parses multiple quoted file paths"
else
  fail "plan parses multiple quoted file paths" "rc=$LAST_RC file-flags=$fileflags stdout='$LAST_STDOUT'"
fi

run_cmd "plan.sh" '"fix spaces" "path with spaces/file.ts"' "$REPO"
if printf '%s' "$LAST_STDOUT" | grep -Fxq "ARG: path with spaces/file.ts"; then
  pass "plan preserves a path containing spaces"
else
  fail "plan preserves a path containing spaces" "stdout='$LAST_STDOUT'"
fi

# Semicolon injection: passes through as one --file value, not as a shell
# command. Nothing matching `^rm: ` should appear in stdout.
run_cmd "plan.sh" '"malicious" "src/foo.py; rm -rf /"' "$REPO"
if printf '%s' "$LAST_STDOUT" | grep -Fxq "ARG: src/foo.py; rm -rf /" \
   && ! printf '%s' "$LAST_STDOUT" | grep -q "^rm: "; then
  pass "plan does not execute injected shell metachars in file tokens"
else
  fail "plan does not execute injected shell metachars in file tokens" "rc=$LAST_RC stdout='$LAST_STDOUT'"
fi

# Path with embedded newline (preserved through shlex via NUL delimiter):
# cmd_validate_path_token rejects before the CLI is invoked.
run_cmd "plan.sh" $'"evil" "bad\nnewline"' "$REPO"
if [[ $LAST_RC -ne 0 ]] && printf '%s' "$LAST_STDERR" | grep -q "control character"; then
  pass "plan rejects path tokens with embedded newlines"
else
  fail "plan rejects path tokens with embedded newlines" "rc=$LAST_RC stderr='$LAST_STDERR'"
fi

# Unbalanced quote: shlex raises, cmd_shlex_split returns 2.
run_cmd "plan.sh" '"oops' "$REPO"
if [[ $LAST_RC -eq 2 ]] && printf '%s' "$LAST_STDERR" | grep -q "argument parse error"; then
  pass "plan rejects unbalanced quotes"
else
  fail "plan rejects unbalanced quotes" "rc=$LAST_RC stderr='$LAST_STDERR'"
fi

# ---------- review ----------
section "review.sh"

# Without a snapshot: exits 1
run_cmd "review.sh" "" "$REPO"
if [[ $LAST_RC -eq 1 ]] && printf '%s' "$LAST_STDERR" | grep -q "No change-plan snapshot"; then
  pass "review refuses to run without a saved snapshot"
else
  fail "review refuses to run without a saved snapshot" "rc=$LAST_RC stderr='$LAST_STDERR'"
fi

echo '{"taskId":"t","path":"t.json","createdAt":"now"}' >"$REPO/.codex/cache/codexa-tasks/latest.json"

run_cmd "review.sh" "--change-type style" "$REPO"
if [[ $LAST_RC -eq 0 ]] && printf '%s' "$LAST_STDOUT" | grep -Fxq "ARG: post-edit-review" \
   && printf '%s' "$LAST_STDOUT" | grep -Fxq "ARG: --change-type" \
   && printf '%s' "$LAST_STDOUT" | grep -Fxq "ARG: style"; then
  pass "review uses canonical post-edit-review and passes allowlisted --change-type through"
else
  fail "review uses canonical post-edit-review and passes allowlisted --change-type through" "rc=$LAST_RC stdout='$LAST_STDOUT'"
fi

run_cmd "review.sh" "--change-type behavior --ran-test tests/test_foo.py" "$REPO"
if [[ $LAST_RC -eq 0 ]] && printf '%s' "$LAST_STDOUT" | grep -Fxq "ARG: --ran-test" \
   && printf '%s' "$LAST_STDOUT" | grep -Fxq "ARG: tests/test_foo.py"; then
  pass "review passes --ran-test through"
else
  fail "review passes --ran-test through" "rc=$LAST_RC stdout='$LAST_STDOUT'"
fi

run_cmd "review.sh" "--evil-flag foo" "$REPO"
if [[ $LAST_RC -ne 0 ]] && printf '%s' "$LAST_STDERR" | grep -q "refusing unknown flag"; then
  pass "review rejects unknown flags"
else
  fail "review rejects unknown flags" "rc=$LAST_RC stderr='$LAST_STDERR'"
fi

run_cmd "review.sh" "tests/test_foo.py" "$REPO"
if [[ $LAST_RC -ne 0 ]] && printf '%s' "$LAST_STDERR" | grep -q "positional arguments"; then
  pass "review rejects bare positional arguments"
else
  fail "review rejects bare positional arguments" "rc=$LAST_RC stderr='$LAST_STDERR'"
fi

# Failed post-edit: the stub returns non-zero; review must propagate it.
run_cmd "review.sh" "--change-type style" "$REPO" "$FAIL_NODE"
if [[ $LAST_RC -eq 3 ]] && printf '%s' "$LAST_STDERR" | grep -q "simulated failure"; then
  pass "review propagates codexa CLI non-zero exit"
else
  fail "review propagates codexa CLI non-zero exit" "rc=$LAST_RC stderr='$LAST_STDERR'"
fi

# ---------- impact ----------
section "impact.sh"

run_cmd "impact.sh" "" "$REPO"
if [[ $LAST_RC -eq 0 ]] && printf '%s' "$LAST_STDOUT" | grep -Fxq "ARG: diff-impact"; then
  pass "impact with no argument falls back to diff-impact"
else
  fail "impact with no argument falls back to diff-impact" "rc=$LAST_RC stdout='$LAST_STDOUT'"
fi

touch "$REPO/src-x.ts"
run_cmd "impact.sh" "src-x.ts" "$REPO"
if [[ $LAST_RC -eq 0 ]] && printf '%s' "$LAST_STDOUT" | grep -Fxq "ARG: --file" \
   && printf '%s' "$LAST_STDOUT" | grep -Fxq "ARG: src-x.ts"; then
  pass "impact with existing path uses --file"
else
  fail "impact with existing path uses --file" "rc=$LAST_RC stdout='$LAST_STDOUT'"
fi

run_cmd "impact.sh" "SomeSymbolName" "$REPO"
if [[ $LAST_RC -eq 0 ]] && printf '%s' "$LAST_STDOUT" | grep -Fxq "ARG: --symbol" \
   && printf '%s' "$LAST_STDOUT" | grep -Fxq "ARG: SomeSymbolName"; then
  pass "impact with non-existing path uses --symbol"
else
  fail "impact with non-existing path uses --symbol" "rc=$LAST_RC stdout='$LAST_STDOUT'"
fi

run_cmd "impact.sh" $'"bad\nnewline"' "$REPO"
if [[ $LAST_RC -ne 0 ]] && printf '%s' "$LAST_STDERR" | grep -q "control character"; then
  pass "impact rejects tokens with embedded newlines"
else
  fail "impact rejects tokens with embedded newlines" "rc=$LAST_RC stderr='$LAST_STDERR'"
fi

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[[ $FAIL -eq 0 ]]
