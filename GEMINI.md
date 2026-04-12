# /srv/codexa Gemini Runbook

Follow the workspace handbook at `/srv/GEMINI.md`.

## Storage Rules

- `storage/` is the persistent app storage root
- `data/` is the mutable project data root
- `models/` is the project model root
- `cache/` is the project cache root
- `backups/` is the project backup root

Those paths are already linked into `/srv/storage`. Use them instead of
creating new large mutable directories elsewhere in the repo.
