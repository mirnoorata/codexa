# Codexa Project Kernel

Keep this automatic layer repository-local and compact. Detailed setup,
recovery, architecture, and release procedures live in `README.md` and
`docs/`; load them only when the task reaches that boundary.

## Development

- Restore locked dependencies with `npm ci`; use `npm install` only when
  deliberately changing dependencies and `package-lock.json`.
- Run `npm run check` for the normal full gate.
- Keep generated or host-local state out of Git: `dist/`, `node_modules/`,
  `.codex/codebase/`, `.codex/cache/`, local storage, config, and hooks are
  ignored. The tracked environment and bootstrap launchers are intentional.
- Use deterministic public fixtures and placeholders such as
  `/path/to/project`, `OWNER/REPO`, and `example.com`. Do not commit private
  paths, projects, hosts, credentials, logs, or session memory.

## Project Startup

- In the desktop Codex composer, select this saved project, `Worktree`, the
  intended starting branch, and the Codexa local environment before the first
  prompt. Mobile remote access may continue that chat but does not configure
  its local setup.
- Adopt the app-created linked worktree; never create a second checkout for the
  same task. Attach a named branch before committing if the app starts
  detached, and leave app-managed cleanup to the app.
- The tracked Bash and PowerShell launchers delegate to one serialized Node
  bootstrap. Generate dependencies, build output, `core` wiring, and the index
  in the active worktree; never copy machine-local config, hooks, indexes, or
  absolute launch commands from another checkout.
- Setup proof is the immutable blob behind the per-worktree
  `refs/worktree/codexa/bootstrap-receipt` ref. SessionStart validates its
  durable subset; `worktree-receipt validate --scope adoption` additionally
  binds generated runtime/dependencies for a trusted shared controller, and
  the default `full` scope is the completion gate. A receipt never authorizes
  executing unvalidated worktree output.
- Missing, stale, or invalid setup evidence is source-ready, not edit-ready.
  Follow README `Codex Project Worktrees And Local Setup` for repair. Neither
  config nor a receipt proves current-thread MCP activation.

## GitHub Change and Release Path

- Finish on a named branch through the protected `main` PR flow with
  Conventional Commits; push that branch to GitHub. Do not tag dirty or
  detached source.
- Run `npm run security:check`. Release Please is the normal lane and requires
  `RELEASE_PLEASE_TOKEN`; use `npm run release:github` only on explicit request
  and verify with `gh release view`. At release time, load README `Release Automation`
  and `docs/PUBLIC_RELEASE_CHECKLIST.md`.
- Before release-oriented pushes, run `npm run privacy`; it checks repository
  paths, not secrets.
