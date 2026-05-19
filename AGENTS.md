# Codexa Project Runbook

Use this file for repository-local contributor guidance only. Do not add
machine-specific paths, private project names, service URLs, credentials, user
names, hostnames, or session memory to the public repository.

## Development

- Install dependencies with `npm install`.
- Run the full gate with `npm run check`.
- Keep generated output out of git: `dist/`, `node_modules/`, `.codex/codebase/`,
  `.codex/cache/`, local storage, and local environment files are ignored.
- Prefer small deterministic fixtures over references to private repositories or
  local infrastructure.
- When adding docs or examples, use placeholders such as `/path/to/project`,
  `OWNER/REPO`, and `example.com`.

## GitHub Change and Release Path

- Codexa changes that are meant to ship should not remain local-only. Finish
  them on a named branch, push that branch to GitHub, and merge through the
  repository's normal GitHub flow before cutting a release from `main`.
- Releases must use the tracked release lane:

```bash
npm run release:github:dry-run -- --tag vX.Y.Z
npm run release:github -- --tag vX.Y.Z
```

- The release lane must keep running `security:check`, create or reuse a source
  tag, push through the configured GitHub remote, and create or update the
  GitHub Release entry with a changelog-style summary, changed-area summary,
  GitHub restore commands, branch/worktree continuation commands, and a
  forward-only rollback recipe.
- The tracked helper `bash scripts/codexa-publish.sh` is the Codexa publish
  wrapper used by local `codexaPublish`; keep it pointed at the same
  `release:github` lane so every release is restorable from GitHub and has a
  visible changelog.
- `codexaPublish` may create one source commit for dirty working-tree changes
  before the PR merge/current-main release step. Use `--commit-message` for a
  better changelog subject, or `--no-source-commit` to restore the old
  clean-tree refusal.
- When publishing through a PR, `codexaPublish` should satisfy protected branch
  policy with GitHub auto-merge and wait until the PR lands before bumping,
  tagging, or creating the GitHub Release. Bare `codexaPublish` should only
  auto-select PRs that are open and not currently conflicting with `main`;
  conflicted PRs need an explicit repair before release.
- The version bump is also a protected-main change. When pushing is enabled,
  `codexaPublish` should land `package.json` / `package-lock.json` bumps through
  a release PR before creating the tag and GitHub Release.
- Do not cut official releases from a dirty tree, detached worktree, or
  machine-local project path. The only dirty-tree exception is the tracked
  `codexaPublish` pre-release source commit on the active PR branch or on
  `main` with `--current-main`. If local work is not ready for `main`, push a
  branch or draft PR instead of tagging it.
- After publishing, verify both surfaces:

```bash
git ls-remote --tags origin refs/tags/vX.Y.Z
gh release view vX.Y.Z --repo OWNER/REPO --json tagName,name,url,targetCommitish
```

- Keep the release command project-agnostic. It may derive the project name
  from the target repo, but it must not hardcode private workspace paths or
  unrelated project names.

## Privacy

Before publishing or pushing release-oriented changes, run:

```bash
npm run privacy
```

The privacy scan checks tracked files for workspace-specific paths and owner
identifiers. It is not a secret scanner; still avoid committing secrets, tokens,
logs, generated indexes from private repositories, or machine-local runbooks.
