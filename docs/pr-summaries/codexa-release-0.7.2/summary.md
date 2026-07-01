# Codexa 0.7.2 Release Summary

- Project: `codexa`
- Release PR: `#84`
- Release version: `0.7.2`
- Base: `main`
- Release branch: `release-please--branches--main--components--codexa`
- Subject: `chore(main): release 0.7.2`

## Changed Files

- `.release-please-manifest.json`
- `CHANGELOG.md`
- `package.json`
- `package-lock.json`
- `server.json`
- `integrations/.claude-plugin/marketplace.json`
- `integrations/claude-code/.claude-plugin/plugin.json`
- `plugins/codexa/.codex-plugin/plugin.json`
- `docs/pr-summaries/codexa-release-0.7.2/summary.md`
- `docs/pr-summaries/codexa-release-0.7.2/summary.pdf`

## Verification

- Release path verifier: passed.
- Public hygiene verifier: passed.
- Registry preflight: `@mirnoorata/codexa@0.7.2` was not published before the release PR merge.
- GitHub PR checks before artifact commit: `check`, `package-smoke`, and `benchmark` passed.
- Final local and GitHub gates must pass again after this artifact commit before merge.

## Notes

This release publishes the merged fix for workspace-root Codexa MCP routing so unscoped workspace launches use the explicit Workspace Default repo instead of stale session pins.
