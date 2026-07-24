#!/usr/bin/env bash
# focus-worktree-bootstrap-input: scripts/worktree-bootstrap.mjs
# focus-worktree-bootstrap-input: scripts/worktree-bootstrap-preflight.mjs
# focus-worktree-bootstrap-input: package.json
# focus-worktree-bootstrap-input: package-lock.json
# focus-worktree-bootstrap-input: tsconfig.json
# focus-worktree-bootstrap-input: .npmrc
set -euo pipefail
umask 077

script_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)"
repo_root="$(CDPATH= cd -- "$script_dir/.." && pwd -P)"

if ! command -v node >/dev/null 2>&1; then
  printf 'Codexa bootstrap requires Node.js on PATH.\n' >&2
  exit 2
fi

exec node "$repo_root/scripts/worktree-bootstrap.mjs" posix-hooks "$repo_root"
