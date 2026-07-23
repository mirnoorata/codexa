# Codexa Project Runbook

Use this file for repository-local contributor guidance only. Do not add
machine-specific paths, private project names, service URLs, credentials, user
names, hostnames, or session memory to the public repository.

## Development

- Restore locked dependencies with `npm ci`; use `npm install` when deliberately
  changing dependencies and the lockfile.
- Run the full gate with `npm run check`.
- Keep generated output out of git: `dist/`, `node_modules/`, `.codex/codebase/`,
  `.codex/cache/`, local storage, project-local Codexa config, and hooks are
  ignored. The repo-owned `.codex/environments/environment.toml` and
  `.codex/worktree-bootstrap.sh` setup files are intentionally tracked.
- Prefer small deterministic fixtures over references to private repositories or
  local infrastructure.
- When adding docs or examples, use placeholders such as `/path/to/project`,
  `OWNER/REPO`, and `example.com`.

## Codex Worktree Setup

- In the desktop Codex composer, select this saved project, `Worktree`, the
  intended starting branch (normally `main`), and the Codexa local environment
  before the first prompt. Mobile remote access may continue that desktop chat
  but does not configure or select local setup.
- The tracked local environment runs `.codex/worktree-bootstrap.sh`, which
  installs the locked dependencies, builds Codexa, and generates ignored
  worktree-local Codexa wiring with the compact `core` tool profile.
- Treat the app-created linked worktree as the task checkout. Do not create a
  second worktree for the same task. App worktrees may start detached; attach a
  named branch before committing. Let the app own cleanup of app-managed
  worktrees.
- Never copy `.codex/config.toml`, `.codex/hooks.json`, generated indexes, or
  absolute launch commands from another checkout. Generate them in the active
  worktree so Codexa's workspace identity remains correct.
- Treat the identity-bound bootstrap receipt as proof; a selected environment
  with no valid receipt is only source-ready and needs explicit repair/fallback.

## GitHub Change and Release Path

- Shipping changes finish on a named branch: push that branch to GitHub and use
  the protected-`main` PR flow. Never tag a dirty or detached checkout.
- Release Please is the normal lane and requires `RELEASE_PLEASE_TOKEN`; use
  conventional `fix:`/`feat:` subjects. A requested manual release uses
  `npm run release:github`, then verifies it with
  `gh release view vX.Y.Z --repo OWNER/REPO`.
- Before any release, run `npm run security:check`. The full source-first npm
  procedure and rollback path are in README `Release Automation` and
  `docs/PUBLIC_RELEASE_CHECKLIST.md`; load them only for a release task.

## Privacy

Before publishing or pushing release-oriented changes, run:

```bash
npm run privacy
```

The privacy scan checks tracked files for workspace-specific paths and owner
identifiers. It is not a secret scanner; still avoid committing secrets, tokens,
logs, generated indexes from private repositories, or machine-local runbooks.
