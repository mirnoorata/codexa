# /srv/codexa Project Runbook

Follow the workspace runbook at `/srv/AGENTS.md`.

## Storage Rules

This repo already exposes the correct storage paths:

- `storage/` -> `/srv/storage/apps/codexa/storage`
- `data/` -> `/srv/storage/apps/codexa/data`
- `models/` -> `/srv/storage/models/codexa`
- `cache/` -> `/srv/storage/cache/codexa`
- `backups/` -> `/srv/storage/backups/codexa`

Use those paths for large mutable state. Keep code, docs, tests, and small
checked-in fixtures inside the repo tree. Do not create new large mutable
directories elsewhere under the repo root.
