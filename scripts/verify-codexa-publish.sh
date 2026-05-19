#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

mkdir -p "$tmp/bin" "$tmp/root"

cat >"$tmp/bin/git" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

case "$*" in
  "branch --show-current")
    printf 'main\n'
    ;;
  *)
    printf 'unexpected git command: %s\n' "$*" >&2
    exit 44
    ;;
esac
EOF
chmod +x "$tmp/bin/git"

cat >"$tmp/bin/gh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

joined="$*"

if [[ "${1:-} ${2:-}" == "pr list" ]]; then
  printf '16\n'
  exit 0
fi

if [[ "${1:-} ${2:-}" == "pr view" ]]; then
  if [[ "$joined" == *"--json state,mergeStateStatus,mergeable"* ]]; then
    printf 'OPEN\tDIRTY\tCONFLICTING\n'
    exit 0
  fi
  if [[ "$joined" == *"--json author"* ]]; then
    printf 'mirnoorata\n'
    exit 0
  fi
  if [[ "$joined" == *"--json headRefName"* ]]; then
    printf 'codex/fix-fast-uri-advisory\n'
    exit 0
  fi
  if [[ "$joined" == *"--json title"* ]]; then
    printf '[codex] Fix vulnerable transitive URI parser\n'
    exit 0
  fi
fi

printf 'unexpected gh command: %s\n' "$joined" >&2
exit 45
EOF
chmod +x "$tmp/bin/gh"

run_publish() {
  PATH="$tmp/bin:$PATH" \
    CODEXA_ROOT="$tmp/root" \
    CODEXA_GITHUB_REPO="OWNER/REPO" \
    bash "$ROOT/scripts/codexa-publish.sh" "$@" 2>&1
}

set +e
implicit_output="$(run_publish)"
implicit_status=$?
explicit_output="$(run_publish 16)"
explicit_status=$?
set -e

if [[ "$implicit_status" -eq 0 ]]; then
  printf 'verify-codexa-publish: implicit conflicted PR selection unexpectedly succeeded\n' >&2
  printf '%s\n' "$implicit_output" >&2
  exit 1
fi
if [[ "$explicit_status" -eq 0 ]]; then
  printf 'verify-codexa-publish: explicit conflicted PR publish unexpectedly succeeded\n' >&2
  printf '%s\n' "$explicit_output" >&2
  exit 1
fi

grep -Fq "codexaPublish: skipping PR #16 for auto-publish: merge conflicts with main." <<<"$implicit_output"
grep -Fq "codexaPublish: no open auto-publishable non-bot codex/* PR found." <<<"$implicit_output"
grep -Fq "codexaPublish: PR #16 cannot be published: merge conflicts with main." <<<"$explicit_output"

printf 'codexa-publish: PR selection hardening verified\n'
