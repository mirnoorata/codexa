# Change Summary

- Project: `codexa`
- Worktree: `claude/claude-20260714-135959` (session checkout)
- Branch: `claude/general/codexa-claude-20260714-135959`
- Base: `main`
- Primary commit: `5166b9d`
- Subject: `feat(cli): add post-edit-review --format json and opt-in --exit-code`

## Changed Files

5166b9d feat(cli): add post-edit-review --format json and opt-in --exit-code
 src/cli/query-commands.ts               | 65 ++++++++++++++----------
 tests/post-edit-review-cli-gate.test.ts | 88 +++++++++++++++++++++++++++++++++
 2 files changed, 128 insertions(+), 25 deletions(-)
 create mode 100644 tests/post-edit-review-cli-gate.test.ts

## Verification

- git diff --check: passed
- npm run typecheck: passed
- npm test: passed
- Codexa post-edit-review: local artifact: codexa-post-edit-review.txt
- Codexa verdict: inspect (advisory)
- Codexa test-plan: local artifact: codexa-test-plan.txt
- git diff --cached --check: passed
- staged safety scan: passed

## Notes

Downstream completion gates (commit hooks, CI wrappers) currently have to parse the human-oriented post-edit-review text to act on the verdict, and the command always exits 0. This mirrors the existing review --format/exit-code pattern: --format json emits the structured review data, and opt-in --exit-code exits 2 unless completionAuthority is complete or advisory_inspect (missing authority fails closed; tests_required counts as blocking, consistent with mcpAuthorityBlockReason). Both flags are opt-in — existing consumers (hooks, wrappers, MCP) see byte-identical behavior.
