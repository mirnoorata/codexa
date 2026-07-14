# Change Summary

- Project: `codexa`
- Branch: `codex/general/codexa-20260713-184409-focus-orientation`
- Base: `main` at `3d8ac153bafbc6dea5ef792980f0b961f4bc76dd`
- Pull request: `#104`
- Subject: `feat(review): add shared committed change receipts`

## Outcome

Codexa now produces one deterministic committed-change receipt for conventional
terminal and CI workflows and for agentic MCP workflows. The shared engine
reports the resolved Git range, changed files and statistics, bounded graph
impact, optional plan conformance, verification evidence, verdict, gaps, and
next actions.

The delivery includes:

- `codexa review` text, JSON, and GitHub output;
- advanced MCP `change_review` plus core `capabilities.invoke` parity;
- a read-only composite GitHub Action;
- `codexa init --ci` generation of an owned, read-only pull-request workflow;
- packed-package and production-path regression coverage.

## Commits

- `de1054a` feat(review): add shared committed change receipts
- `82ff261` docs(workflow): add PR summary for codexa
- `cc661a0` fix(review): require deterministic clean change evidence
- `fb34fa2` fix(mcp): expose portable change review plans
- `ff3ee26` fix(action): isolate packaged review bootstrap
- `fc200c3` fix(review): bind portable plans to validated files
- `e2fa398` fix(review): verify snapshot identity before opening

## Scope

- Source/config/tests: 21 files, 1,384 insertions, 55 deletions.
- Review artifacts: this Markdown summary and its PDF rendering.
- No source mutation, pull-request comments, or write permissions are exposed
  by the Action or MCP operation.

## Adversarial Hardening

Independent reviewers exercised Git correctness, interface parity, and
Action/CI delivery against the actual `origin/main...HEAD` diff. Actionable
findings were fixed with dedicated Conventional Commits:

- rejected stale indexes built from dirty overlays;
- fixed rename/copy determinism against hostile `diff.renameLimit` config;
- bound portable snapshot containment, identity, size, and reads to the same
  validated file;
- exposed bounded portable-plan input through both MCP access paths;
- isolated `npx` Action bootstrap from same-name consumer workspaces;
- refreshed stale committed review artifacts after the fixes.

## Verification

- `npm run check`: passed.
- TypeScript and source/release/privacy hygiene: passed.
- Claude Code shell integrations: 113 passed.
- Vitest: 65 files passed; 614 passed, 1 skipped.
- `npm run smoke:package`: 31 packed-install checks passed, including the
  isolated Action bootstrap against a same-name/same-version workspace.
- `npm run package:hygiene`: passed.
- `npm run audit`: 0 vulnerabilities.
- `npm run public:snapshot-check`: passed on the committed branch.
- Targeted stale-index, hostile rename-limit, portable snapshot, MCP parity,
  and Action delivery regressions: passed.

## Publication Boundary

The branch provides the Action implementation, but the public Action cannot be
called live until the matching release tag and npm package are published. The
post-merge release workflow and a real tag-to-npm Action smoke remain required
before claiming the new Action is live.
