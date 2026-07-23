# Change Summary

- Project: `codexa`
- Checkout: isolated `codexa` task worktree
- Branch: `codex/general/codexa-20260722-210037-focus-orientation`
- Base: `main`
- Primary commit: `79c8898`
- Subject: `feat(startup): make project readiness truthful`

## Changed Files

79c8898 feat(startup): make project readiness truthful
 .codex/environments/environment.toml               |   5 +
 .codex/worktree-bootstrap.sh                       | 233 ++++++
 AGENTS.md                                          |  99 +--
 README.md                                          |  21 +-
 docs/architecture/codexa-context-server.md         |  32 +-
 docs/guides/codex-sessionstart-hook.md             |  49 +-
 docs/guides/new-user-tutorial.md                   |  25 +-
 package-lock.json                                  |  91 ++-
 package.json                                       |   4 +
 src/cli.ts                                         |  31 +-
 src/init-portability.ts                            |  51 +-
 src/init.ts                                        | 229 +-----
 src/mcp-repo-root.ts                               |  28 +-
 src/session-start.ts                               | 889 +++++++++++++++++++++
 ...jects-malformed-integer-options-instead.test.ts | 197 ++++-
 tests/init.test.ts                                 |  67 +-
 tests/mcp-01-keeps-the-primary-mcp-happy.test.ts   |   4 +-
 tests/session-start.test.ts                        | 403 ++++++++++
 18 files changed, 2044 insertions(+), 414 deletions(-)
 create mode 100644 .codex/environments/environment.toml
 create mode 100755 .codex/worktree-bootstrap.sh
 create mode 100644 src/session-start.ts
 create mode 100644 tests/session-start.test.ts

## Verification

- git diff --check: passed
- rtk proxy bash -n .codex/worktree-bootstrap.sh: passed
- rtk proxy shellcheck -S warning .codex/worktree-bootstrap.sh: passed
- rtk npm run check: passed
- rtk npm audit --audit-level=moderate: passed
- rtk npm run package:hygiene: passed
- rtk npm run smoke:package: passed
- Codexa post-edit-review: generated as a local verification artifact
- Codexa verdict: continue (none)
- git diff --cached --check: passed
- staged safety scan: passed

## Notes

Implements the Codexa pilot for project-bound startup: native worktree setup, compact faceted SessionStart receipts, core MCP exposure, identity-bound indexing, and full-runtime bootstrap attestation.
