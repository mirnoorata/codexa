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

## Privacy

Before publishing or pushing release-oriented changes, run:

```bash
npm run privacy
```

The privacy scan checks tracked files for workspace-specific paths and owner
identifiers. It is not a secret scanner; still avoid committing secrets, tokens,
logs, generated indexes from private repositories, or machine-local runbooks.
