#!/usr/bin/env bash
# focus-worktree-bootstrap-input: scripts/worktree-bootstrap.mjs
# focus-worktree-bootstrap-input: scripts/worktree-bootstrap-preflight.mjs
# focus-worktree-bootstrap-input: package.json
# focus-worktree-bootstrap-input: package-lock.json
# focus-worktree-bootstrap-input: tsconfig.json
# focus-worktree-bootstrap-input: .npmrc
set -euo pipefail
umask 077

git_top="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  printf 'Codexa bootstrap must run inside a Git worktree.\n' >&2
  exit 2
}
repo_root="$(cd "$git_top" && pwd -P)"

if ! command -v node >/dev/null 2>&1; then
  printf 'Codexa bootstrap requires Node.js on PATH.\n' >&2
  exit 2
fi

exec node "$repo_root/scripts/worktree-bootstrap.mjs" posix-hooks "$repo_root"
