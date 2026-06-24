# Change Summary

- Project: `codexa`
- Worktree: isolated fresh Codexa worktree
- Branch: `codex/general/codexa-20260624-094437-focus-orientation`
- Base: `main`
- Primary commit: `373fb78`
- Subject: `fix(mcp): isolate workspace session routing`

## Changed Files

373fb78 fix(mcp): isolate workspace session routing
 src/cli.ts              |   9 +++-
 src/mcp-repo-root.ts    |  58 +++++++++++++++++++++---
 tests/cli-hooks.test.ts |  59 ++++++++++++++++++++----
 tests/mcp.test.ts       | 116 ++++++++++++++++++++++++++++++++++++++++++------
 4 files changed, 212 insertions(+), 30 deletions(-)

## Verification

- git diff --check: passed
- npm run check: passed
- Codexa not wired: no .codex/config.toml
- git diff --cached --check: passed
- staged safety scan: passed

## Notes

Adversarial hardening resolved two routing defects: unscoped shared workspace
roots now fail closed when shared focus conflicts with active session rows, and
selected workspace sessions must match an active row before any shared
focus/default fallback is considered. CLI query commands now keep explicit git
repo arguments authoritative even when focus-worktree environment variables are
exported.

Additional Codexa evidence: change-plan and test-plan ran through
CODEXA_WORKSPACE_SESSION for this worktree; post-edit-review remained inspect
because src/cli.ts was added during the second adversarial finding after the
initial snapshot, while targeted tests and required dependency checks were
accounted for.

Manual live probes also verified the shared workspace root fails closed when
unscoped, --workspace-session routes to this Codexa worktree, and an explicit
canonical Codexa repo status command remains pinned under focus env.
