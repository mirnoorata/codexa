# Change Summary

- Project: `codexa`
- Worktree: `isolated codexa worktree`
- Branch: `claude/general/codexa-20260704-091747-focus-orientation`
- Base: `main`
- Source head before artifact refresh: `405f906`
- Subject: `feat(mcp): surface workspace skill hints`

## Changed Files

- `src/skill-hints.ts`
- `src/init.ts`
- `src/query/context.ts`
- `src/mcp/compaction.ts`
- `src/mcp/resources.ts`
- `src/types/query-data.ts`
- `tests/init.test.ts`
- `tests/mcp-01-keeps-the-primary-mcp-happy.test.ts`
- Summary artifacts under `docs/pr-summaries/`

Diff stat before artifact refresh:

```text
10 files changed, 970 insertions(+)
```

## Commit Stack

- `a076e15` `feat(mcp): surface workspace skill hints`
- `16cc35a` `docs(workflow): add PR summary for codexa`
- `6484259` `fix(mcp): avoid workspace paths in skill hints`
- `16aadd8` `fix(mcp): harden skill hint config parsing`
- `911ed7f` `fix(mcp): redact workspace skill hint surfaces`
- `a779398` `test(mcp): keep redaction fixtures public-safe`
- `161ad91` `docs(workflow): refresh Codexa PR summary artifacts`
- `ef0ea84` `fix(mcp): close skill hint trust boundaries`
- `405f906` `test(mcp): assert symlinked skill roots stay opaque`

## Verification

- `npm run test -- tests/init.test.ts tests/mcp-01-keeps-the-primary-mcp-happy.test.ts`: passed, 53 tests
- `npm run test -- tests/mcp-01-keeps-the-primary-mcp-happy.test.ts`: passed, 21 tests
- `npm run privacy`: passed
- `git diff --check`: passed
- `npm run check`: passed, including typecheck, lint, privacy, Claude Code integration tests, build, and Vitest
- `npm run security:check`: passed, including full check, npm audit, public snapshot check, package hygiene, plugin hygiene, and package install smoke
- Claude Code integration tests: 77 passed
- Vitest: 39 files passed, 400 tests passed
- npm audit: 0 vulnerabilities
- package smoke: 25 checks passed against the packed package
- Adversarial review: actionable findings fixed in follow-up Conventional Commits
- git diff --check: passed

## Notes

Implements the portable Codexa portion of the workspace audit remediation: bounded workspace session-start digest, configured skill/playbook hints, structured MCP compaction, and regression coverage.

Hardening follow-ups keep repo-controlled skill-hint config contained to repo-local real paths, render malformed config warnings instead of hiding them, redact workspace session claims and freeform next text from session-start summaries, require scanned skills before emitting actionable skill hints, make glob matching cover direct children, and keep redaction fixtures public-safe.
