#!/usr/bin/env bash
set -euo pipefail

ROOT="${CODEXA_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)}"
DEFAULT_GITHUB_REPO="${CODEXA_GITHUB_REPO:-}"

usage() {
  cat <<'USAGE'
Usage: codexaPublish [release_type] [pr_number] [options]
       codexaPublish [pr_number] [options]
       codexaPublish --current-main [release_type] [options]

One-command Codexa source release path.

Default behavior:
  1. resolves the current/latest non-bot codex/* PR unless --current-main is set
  2. commits current dirty source on that PR branch, then pushes it
  3. makes draft PRs ready, updates stale PR branches, and waits for checks
  4. enables GitHub auto-merge for the PR and waits until it lands
  5. syncs local main to origin/main
  6. bumps package.json/package-lock.json with npm version
  7. commits the version bump
  8. runs the tracked GitHub release lane
  9. verifies GitHub has main, the release tag, and the GitHub Release entry

Release types are npm version release types, defaulting to patch.
Examples:
  codexaPublish
  codexaPublish minor
  codexaPublish 18
  codexaPublish minor 18
  codexaPublish --current-main patch

Options:
  --current-main, --no-pr       Release the current clean main without merging a PR.
  --commit-message MESSAGE      Source commit message for dirty changes.
  --no-source-commit            Refuse dirty source instead of committing it.
  --dry-run                    Show the release lane for the current package version without mutating GitHub.
  --no-push                    Leave the branch/tag local; skips GitHub restore-point verification.
  --push                       Push branch and tag to GitHub. Default.
  --no-tag                     Do not create a release tag; skips GitHub restore-point verification.
  --tag                        Create the release tag. Default.
  --no-github-release          Do not create/update the GitHub Release entry.
  --github-release             Create/update the GitHub Release entry. Default.
  --github-release-latest MODE Pass latest marker mode to the release lane: auto, true, or false.
  -h, --help                   Show this help.
USAGE
}

github_repo_from_origin() {
  local remote
  remote="$(git -C "$ROOT" config --get remote.origin.url || true)"
  case "$remote" in
    git@github.com:*.git)
      remote="${remote#git@github.com:}"
      remote="${remote%.git}"
      ;;
    git@github.com:*)
      remote="${remote#git@github.com:}"
      ;;
    https://github.com/*.git)
      remote="${remote#https://github.com/}"
      remote="${remote%.git}"
      ;;
    https://github.com/*)
      remote="${remote#https://github.com/}"
      ;;
    *)
      remote=""
      ;;
  esac
  printf '%s\n' "$remote"
}

is_release_type() {
  case "$1" in
    major|minor|patch|premajor|preminor|prepatch|prerelease)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

dirty_tree() {
  [[ -n "$(git -C "$ROOT" status --porcelain=v1)" ]]
}

current_branch() {
  git -C "$ROOT" branch --show-current
}

default_source_commit_message() {
  local files has_release=0 has_context=0 has_docs=0
  files="$(git -C "$ROOT" status --porcelain=v1 | sed -E 's/^.{3}//')"
  if grep -Eq '^(scripts/codexa-publish\.sh|scripts/verify-release-path\.mjs|src/github-release\.ts|docs/PUBLIC_RELEASE_CHECKLIST\.md|package\.json|package-lock\.json)' <<<"$files"; then
    has_release=1
  fi
  if grep -Eq '^(src/(mcp|mcp-repo-root|query/|semantic|session-memory|lsp/)|tests/(mcp|session|semantic|lsp|cli-hooks))' <<<"$files"; then
    has_context=1
  fi
  if grep -Eq '^(README\.md|AGENTS\.md|docs/)' <<<"$files"; then
    has_docs=1
  fi

  if [[ "$has_release" == "1" && "$has_context" == "1" ]]; then
    printf 'Update Codexa release and context tooling\n'
  elif [[ "$has_release" == "1" ]]; then
    printf 'Harden Codexa release publishing\n'
  elif [[ "$has_context" == "1" ]]; then
    printf 'Improve Codexa context tooling\n'
  elif [[ "$has_docs" == "1" ]]; then
    printf 'Update Codexa docs\n'
  else
    printf 'Update Codexa source before publish\n'
  fi
}

push_current_branch() {
  local branch="$1"
  if git -C "$ROOT" rev-parse --abbrev-ref --symbolic-full-name '@{upstream}' >/dev/null 2>&1; then
    git -C "$ROOT" push
  else
    git -C "$ROOT" push -u origin "$branch"
  fi
}

commit_current_source_if_dirty() {
  local expected_branch="$1"
  local allow_main="$2"
  local branch message file_count

  if ! dirty_tree; then
    return 0
  fi
  if [[ "$source_commit_enabled" != "1" ]]; then
    echo "codexaPublish: ${ROOT} has uncommitted changes and --no-source-commit was passed." >&2
    return 1
  fi

  branch="$(current_branch)"
  if [[ -z "$branch" ]]; then
    echo "codexaPublish: refusing to commit from a detached HEAD." >&2
    return 1
  fi
  if [[ -n "$expected_branch" && "$branch" != "$expected_branch" ]]; then
    echo "codexaPublish: refusing to commit dirty branch '$branch' while publishing PR branch '$expected_branch'." >&2
    return 1
  fi
  if [[ "$branch" == "main" && "$allow_main" != "1" ]]; then
    echo "codexaPublish: refusing to commit dirty main for PR publish. Use --current-main or move the work to a branch." >&2
    return 1
  fi
  if [[ "$branch" == "main" ]]; then
    git -C "$ROOT" fetch origin main --prune
    read -r _ahead behind < <(git -C "$ROOT" rev-list --left-right --count main...origin/main)
    if [[ "${behind:-0}" != "0" ]]; then
      echo "codexaPublish: refusing to commit dirty main because it is behind origin/main by ${behind} commit(s)." >&2
      echo "codexaPublish: pull/rebase main first, then rerun codexaPublish --current-main." >&2
      return 1
    fi
  fi

  message="${source_commit_message:-$(default_source_commit_message)}"
  file_count="$(git -C "$ROOT" status --porcelain=v1 | wc -l | tr -d '[:space:]')"
  echo "codexaPublish: committing ${file_count} dirty source file(s) on ${branch}."
  git -C "$ROOT" add -A
  if git -C "$ROOT" diff --cached --quiet; then
    echo "codexaPublish: no staged changes after git add -A."
    return 0
  fi
  git -C "$ROOT" commit -m "$message"
  if [[ "$branch" != "main" ]]; then
    echo "codexaPublish: pushing source commit on ${branch}."
    push_current_branch "$branch"
  fi
}

sync_main() {
  local local_head origin_head backup
  git -C "$ROOT" fetch origin main --prune
  git -C "$ROOT" switch main
  local_head="$(git -C "$ROOT" rev-parse main)"
  origin_head="$(git -C "$ROOT" rev-parse origin/main)"
  if [[ "$local_head" == "$origin_head" ]]; then
    return 0
  fi
  if git -C "$ROOT" merge-base --is-ancestor main origin/main; then
    git -C "$ROOT" pull --ff-only origin main
    return 0
  fi
  backup="codexa-local-main-backup-$(date +%Y%m%d%H%M%S)"
  git -C "$ROOT" branch "$backup" main
  echo "codexaPublish: preserved divergent local main as ${backup}"
  git -C "$ROOT" switch --detach origin/main
  git -C "$ROOT" branch -f main origin/main
  git -C "$ROOT" switch main
}

update_branch_and_wait() {
  local pr_number="$1"
  local github_repo="$2"
  local merge_state

  merge_state="$(gh pr view "$pr_number" --repo "$github_repo" --json mergeStateStatus --jq '.mergeStateStatus')"
  if [[ "$merge_state" == "BEHIND" ]]; then
    echo "codexaPublish: PR #${pr_number} is behind main; updating branch before merge."
    gh pr update-branch "$pr_number" --repo "$github_repo"
    sleep 5
  fi

  echo "codexaPublish: waiting for PR #${pr_number} checks."
  gh pr checks "$pr_number" --repo "$github_repo" --watch --interval 10
}

merge_pr_and_wait() {
  local pr_number="$1"
  local github_repo="$2"
  local timeout_seconds="${CODEXA_PUBLISH_MERGE_TIMEOUT_SECONDS:-900}"
  local start now state merged_at merge_state

  echo "codexaPublish: enabling auto-merge for PR #${pr_number}."
  gh pr merge "$pr_number" --auto --squash --delete-branch --repo "$github_repo"

  start="$(date +%s)"
  while true; do
    state="$(gh pr view "$pr_number" --repo "$github_repo" --json state --jq '.state')"
    if [[ "$state" == "MERGED" ]]; then
      merged_at="$(gh pr view "$pr_number" --repo "$github_repo" --json mergedAt --jq '.mergedAt')"
      echo "codexaPublish: PR #${pr_number} merged at ${merged_at}."
      return 0
    fi
    if [[ "$state" == "CLOSED" ]]; then
      echo "codexaPublish: PR #${pr_number} closed without merging; aborting release." >&2
      return 1
    fi

    now="$(date +%s)"
    if (( now - start >= timeout_seconds )); then
      merge_state="$(gh pr view "$pr_number" --repo "$github_repo" --json mergeStateStatus --jq '.mergeStateStatus')"
      echo "codexaPublish: timed out waiting for PR #${pr_number} to auto-merge; current merge state is ${merge_state}." >&2
      echo "codexaPublish: resolve the branch policy blocker, then rerun codexaPublish." >&2
      return 1
    fi

    sleep 10
  done
}

verify_github_restore_point() {
  local tag="$1"
  local github_repo="$2"

  echo "codexaPublish: verifying GitHub restore point."
  git -C "$ROOT" ls-remote --exit-code --heads origin main >/dev/null
  git -C "$ROOT" ls-remote --exit-code --tags origin "refs/tags/${tag}" >/dev/null
  gh release view "$tag" --repo "$github_repo" --json tagName,name,url,targetCommitish >/dev/null
  echo "codexaPublish: GitHub restore point verified for ${tag}."
}

next_version_for_release_type() {
  local release_type="$1"
  local tmp next_version
  tmp="$(mktemp -d)"
  cp "$ROOT/package.json" "$tmp/package.json"
  if [[ -f "$ROOT/package-lock.json" ]]; then
    cp "$ROOT/package-lock.json" "$tmp/package-lock.json"
  fi
  next_version="$(
    cd "$tmp"
    npm version "$release_type" --no-git-tag-version --ignore-scripts --workspaces=false
  )"
  rm -rf "$tmp"
  printf '%s\n' "${next_version#v}"
}

release_type="patch"
pr_number=""
explicit_pr="0"
use_current_main="0"
dry_run="0"
push_release="1"
create_tag="1"
github_release="1"
github_release_latest="auto"
source_commit_enabled="1"
source_commit_message="${CODEXA_PUBLISH_COMMIT_MESSAGE:-}"
release_args=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help|help)
      usage
      exit 0
      ;;
    --current-main|--no-pr)
      use_current_main="1"
      ;;
    --commit-message|--source-commit-message)
      shift
      if [[ $# -eq 0 || -z "${1:-}" ]]; then
        echo "codexaPublish: missing message after --commit-message." >&2
        exit 1
      fi
      source_commit_message="$1"
      ;;
    --no-source-commit)
      source_commit_enabled="0"
      ;;
    --dry-run)
      dry_run="1"
      ;;
    --push)
      push_release="1"
      release_args+=("--push")
      ;;
    --no-push)
      push_release="0"
      release_args+=("--no-push")
      ;;
    --tag)
      create_tag="1"
      release_args+=("--create-tag")
      ;;
    --no-tag)
      create_tag="0"
      release_args+=("--no-create-tag")
      ;;
    --github-release)
      github_release="1"
      release_args+=("--github-release")
      ;;
    --no-github-release)
      github_release="0"
      release_args+=("--no-github-release")
      ;;
    --github-release-latest|--latest)
      shift
      if [[ $# -eq 0 || -z "${1:-}" ]]; then
        echo "codexaPublish: missing latest mode after --github-release-latest." >&2
        exit 1
      fi
      github_release_latest="$1"
      release_args+=("--latest" "$1")
      ;;
    --release-type)
      shift
      if [[ $# -eq 0 || -z "${1:-}" ]]; then
        echo "codexaPublish: missing release type after --release-type." >&2
        exit 1
      fi
      release_type="$1"
      ;;
    [0-9]*)
      pr_number="$1"
      explicit_pr="1"
      ;;
    *)
      if is_release_type "$1"; then
        release_type="$1"
      else
        echo "codexaPublish: unknown argument: $1" >&2
        usage >&2
        exit 1
      fi
      ;;
  esac
  shift
done

if ! is_release_type "$release_type"; then
  echo "codexaPublish: invalid release type: ${release_type}" >&2
  exit 1
fi

if [[ "$github_release_latest" != "auto" && "$github_release_latest" != "true" && "$github_release_latest" != "false" ]]; then
  echo "codexaPublish: --github-release-latest must be one of: auto, true, false" >&2
  exit 1
fi

cd "$ROOT"

github_repo="${DEFAULT_GITHUB_REPO:-$(github_repo_from_origin)}"
if [[ -z "$github_repo" ]]; then
  echo "codexaPublish: could not infer GitHub repository from origin. Set CODEXA_GITHUB_REPO=OWNER/REPO." >&2
  exit 1
fi

if [[ "$dry_run" == "1" ]]; then
  next_version="$(next_version_for_release_type "$release_type")"
  echo "codexaPublish dry run:"
  echo "  repo: $ROOT"
  echo "  github repo: $github_repo"
  echo "  release type: $release_type"
  echo "  release tag preview: v${next_version}"
  if [[ "$use_current_main" == "1" ]]; then
    echo "  source: current main"
  elif [[ -n "$pr_number" ]]; then
    echo "  source: PR #${pr_number}"
  else
    echo "  source: current/latest non-bot codex/* PR"
  fi
  if dirty_tree; then
    if [[ "$source_commit_enabled" == "1" ]]; then
      echo "  would commit dirty source first: ${source_commit_message:-$(default_source_commit_message)}"
    else
      echo "  would refuse dirty source because --no-source-commit was passed"
    fi
  fi
  npm run release:github:dry-run -- --tag "v${next_version}" "${release_args[@]}"
  exit 0
fi

if [[ "$use_current_main" != "1" ]]; then
  if [[ -z "$pr_number" ]]; then
    branch="$(git branch --show-current)"
    if [[ -n "$branch" && "$branch" != "main" ]]; then
      pr_number="$(gh pr view --repo "$github_repo" --json number --jq '.number' 2>/dev/null || true)"
    fi
    if [[ -z "$pr_number" ]]; then
      pr_number="$(
        gh pr list --repo "$github_repo" --state open --limit 50 --json number,updatedAt,headRefName,author \
          --jq '[.[] | select((.headRefName | startswith("codex/")) and (.author.is_bot == false))] | sort_by(.updatedAt) | reverse | .[0].number // empty'
      )"
    fi
  fi

  if [[ -z "$pr_number" ]]; then
    echo "codexaPublish: no open non-bot codex/* PR found. Pass a PR number or use codexaPublish --current-main." >&2
    exit 1
  fi

  pr_author="$(gh pr view "$pr_number" --repo "$github_repo" --json author --jq '.author.login')"
  pr_head="$(gh pr view "$pr_number" --repo "$github_repo" --json headRefName --jq '.headRefName')"
  pr_title="$(gh pr view "$pr_number" --repo "$github_repo" --json title --jq '.title')"
  if [[ "$explicit_pr" != "1" ]] && { [[ "$pr_author" == app/* ]] || [[ "$pr_head" == dependabot/* ]]; }; then
    echo "codexaPublish: refused to auto-publish bot PR #${pr_number} (${pr_title}). Pass the PR number explicitly if you really want it." >&2
    exit 1
  fi

  commit_current_source_if_dirty "$pr_head" "0"
  echo "codexaPublish: publishing PR #${pr_number} (${pr_title}) as a ${release_type} release."
  is_draft="$(gh pr view "$pr_number" --repo "$github_repo" --json isDraft --jq '.isDraft')"
  if [[ "$is_draft" == "true" ]]; then
    gh pr ready "$pr_number" --repo "$github_repo"
  fi

  sync_main
  update_branch_and_wait "$pr_number" "$github_repo"
  merge_pr_and_wait "$pr_number" "$github_repo"
  sync_main
else
  echo "codexaPublish: releasing current main as a ${release_type} release."
  commit_current_source_if_dirty "main" "1"
  sync_main
fi

npm version "$release_type" --no-git-tag-version
version="$(node -p "require('./package.json').version")"
git add package.json package-lock.json
git commit -m "Bump Codexa version to v${version}"

npm run release:github -- --tag "v${version}" "${release_args[@]}"

if [[ "$push_release" == "1" && "$create_tag" == "1" && "$github_release" == "1" ]]; then
  verify_github_restore_point "v${version}" "$github_repo"
else
  echo "codexaPublish: GitHub restore-point verification skipped because push/tag/GitHub Release was disabled."
fi
