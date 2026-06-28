# Change Summary

- Project: `codexa`
- Worktree: `isolated codexa worktree`
- Branch: `codex/general/codexa-20260628-170957-focus-orientation`
- Base: `main`
- Primary commit: `44217cd`
- Review fix commit: `39ed7ec`
- Subject: `fix(cli): route focused workspace sessions explicitly`

## Changed Files

44217cd fix(cli): route focused workspace sessions explicitly
 src/cli.ts                                         |  10 +-
 src/cli/options.ts                                 |  15 ++-
 src/cli/query-commands.ts                          | 128 +++++++++++----------
 src/init.ts                                        |  26 ++++-
 ...jects-malformed-integer-options-instead.test.ts |  80 ++++++++++++-
 5 files changed, 188 insertions(+), 71 deletions(-)

39ed7ec fix(cli): route proof and eval workspace sessions
 src/cli.ts                                         | 12 ++++--
 ...jects-malformed-integer-options-instead.test.ts | 43 ++++++++++++++++++++++
 2 files changed, 51 insertions(+), 4 deletions(-)

## Verification

- git diff --check: passed
- npm run check: passed
- git diff --check: passed
- Codexa session-start workspace-session routing smoke: passed
- Codexa brief workspace-session routing smoke: passed
- Codexa proof-card workspace-session routing smoke: passed
- focused CLI workspace routing regression test: passed
- Codexa post-edit-review: local artifact recorded
- Codexa test-plan: local artifact recorded
- git diff --cached --check: passed
- staged safety scan: passed

## Notes

Adds explicit workspace focus/session routing flags for session-start and Codexa query commands so workspace launch roots can resolve to the intended focused worktree without relying on inherited shell environment.
