# Change Summary

- Project: `codexa`
- Worktree: `isolated codexa worktree`
- Branch: `codex/general/codexa-20260628-005647-focus-orientation`
- Base: `main`
- Primary commit: `4b9210f`
- Subject: `docs(readme): document Codexa 0.7.0 updates`

## Changed Files

4b9210f docs(readme): document Codexa 0.7.0 updates
 README.md | 37 ++++++++++++++++++++++++++++++-------
 1 file changed, 30 insertions(+), 7 deletions(-)

## Verification

- git diff --check: passed
- git diff --check: passed
- PATH=/home/q/.nvm/versions/node/v22.22.2/bin:$PATH npm run privacy: passed
- PATH=/home/q/.nvm/versions/node/v22.22.2/bin:$PATH npm run package:hygiene: passed
- docs-only waiver: no test command required
- Codexa post-edit-review: local artifact recorded
- Codexa test-plan: local artifact recorded
- git diff --cached --check: passed
- docs-only scope check: passed
- staged safety scan: passed

## Notes

Updates the README to cover the shipped v0.7.0 graph-aware relational packets, generated packet artifacts, raw-exact-vs-ranked search behavior, and fail-closed workspace-root routing guidance.\n\nVerification:\n- git diff --check\n- npm run privacy\n- npm run package:hygiene
