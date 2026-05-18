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
  GitHub Release entry with branch/worktree continuation commands and a
  forward-only rollback recipe.
- Do not cut official releases from a dirty tree, detached worktree, or
  machine-local project path. If local work is not ready for `main`, push a
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
