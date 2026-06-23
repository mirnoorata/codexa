# Change Summary

- Project: `codexa`
- Worktree: isolated fresh Codexa worktree
- Branch: `codex/general/codexa-codexa-complexity-hardening-20260621`
- Base: `main`
- Primary commit: `ed08f30`
- Subject: `fix(types): align post-edit changed entries contract`

## Changed Files

ed08f30 fix(types): align post-edit changed entries contract
 src/types.ts | 2 +-
 1 file changed, 1 insertion(+), 1 deletion(-)

## Verification

- git diff --check: passed
- npm run check: passed
- Codexa not wired: no .codex/config.toml
- git diff --cached --check: passed
- staged safety scan: passed

## Notes

Hardening follow-up for the Codexa complexity-review lane. The source change aligns the exported PostEditReviewData contract with the structured ChangedFileEntry[] payload already produced and compacted at runtime.
