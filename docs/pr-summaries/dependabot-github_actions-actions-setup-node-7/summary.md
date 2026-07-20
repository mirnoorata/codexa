# PR Summary: Upgrade GitHub Actions setup-node to v7

- Project: `codexa`
- Checkout: isolated `codexa` task worktree
- Branch: `dependabot/github_actions/actions/setup-node-7`
- Base: `main`
- Dependency commit: `build(deps): bump actions/setup-node from 6 to 7`
- Follow-up fix: `fix(ci): align setup-node release guard`

## Goal and Outcome

Upgrade every production and publication use of `actions/setup-node` from v6
to v7 while preserving Codexa's release-path verification. The original bot
commit updated the workflows and composite action but left the release guard
expecting v6, which made the required `check` job fail. The follow-up changes
that single assertion to v7.

## Complete PR Diff

- `.github/workflows/check.yml`: use setup-node v7 in the check,
  package-smoke, and benchmark jobs.
- `.github/workflows/npm-publish.yml`: use setup-node v7 for the release
  publication job.
- `action.yml`: use setup-node v7 in the published Codexa composite action.
- `scripts/verify-release-path.mjs`: require the same v7 reference used by the
  publication workflow.
- `docs/pr-summaries/dependabot-github_actions-actions-setup-node-7/`: commit
  this Markdown summary and its PDF counterpart for review.

No runtime source, package dependency, permission, secret scope, or published
command contract changes.

## Verification

- `npm run check`: passed 72 test files; 900 tests passed and 1 intentional
  skip, plus 28 Claude command and 89 hook checks.
- `npm run security:check`: passed typecheck, lint, privacy, tests, audit,
  public snapshot, package/plugin hygiene, and all 31 packed-package smokes.
- `npm run benchmark:ci`: every hot-path threshold passed.
- `git diff --check`: passed.
- Staged safety scan: passed.
- Initial adversarial review found this summary omitted the bot commit; the
  Markdown and PDF were corrected without expanding production scope.

## Risk and Rollback

The operational risk is limited to the setup-node action runtime used by CI,
publication, and the composite action. The v7 setup step already completed
successfully on GitHub-hosted runners. If fresh post-push checks expose a
runner incompatibility, revert this PR to restore v6; no data or package
migration is involved.
