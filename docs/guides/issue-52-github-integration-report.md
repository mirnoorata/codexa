# Codexa GitHub Integration Report

Prepared for GitHub issue #52 on 2026-06-16.

Issue prompt: useful scenarios for Codexa to work directly on GitHub issues and
pull requests, scan for improvements like Dependabot, make analogies, look at
competitive tools, and identify what would make this automatic and valuable.

## Executive Recommendation

Codexa should not try to be "another autonomous coding agent" first. The
stronger wedge is a GitHub-native maintenance and evidence bot: it watches
issues, pull requests, and scheduled repository scans; maps them to the real
codebase; ranks risk; suggests the smallest next action; and attaches proof
about plan drift and verification coverage.

The best product shape is:

1. Read-only issue and PR intelligence by default.
2. Comment-level commands such as `@codexa triage`, `@codexa review`,
   `@codexa plan`, and `@codexa verify`.
3. Scheduled "maintenance scouts" that open issues or draft PRs only when the
   evidence is specific, reproducible, and low-noise.
4. Explicit labels or reviewer approval before Codexa pushes code.
5. Human merge authority, branch protection, and CI as hard boundaries.

The analogy is "Dependabot for codebase health classes, not only dependency
versions." Dependabot knows a narrow external fact - a package is stale or
vulnerable - then opens a scoped PR. Codexa can know narrow repository facts -
a PR drifted from its plan, a risky file lacks covering tests, a repeated
review theme can become a rule, an issue is underspecified, or a proposed fix
touches hidden callers - then open a scoped comment, issue, or PR.

## Why This Fits Codexa

Codexa's current public README defines it as an edit-lifecycle governance layer
for AI coding agents, not an autonomous source editor. It builds a local,
deterministic map of files, symbols, imports, tests, risks, and workflows, then
serves evidence-backed packets before and after edits.

Three existing strengths map directly to GitHub:

- Plan drift: `change_plan` snapshots file hashes, symbols, and risk baselines;
  `post_edit_review` compares the real dirty tree against the plan.
- Verification accounting: reported commands are parsed before earning coverage
  credit, so exit-masked or irrelevant commands do not get the same trust as
  meaningful tests.
- Freshness and scope visibility: Codexa already treats stale, dirty, and
  heuristic state as reportable context instead of hiding it.

The architecture docs reinforce that Codexa is deterministic, local-first,
MCP-based, and source-file mutation is not exposed through MCP tools. The
AutoVerify plan is also intentionally conservative: query tools stay
non-executing, execution is opt-in through local lifecycle hooks, and evidence
is attached back to review rather than treated as magic trust.

That means a GitHub integration should make Codexa the "evidence clerk" and
"maintenance scout" around human and agent work. It can hand tasks to Codex,
Copilot, Devin, Cursor, Claude Code, or a local agent later, but the first
durable value is knowing what should be done and whether the reported work is
actually supported by code facts.

## Competitive Landscape

### GitHub Copilot cloud agent

GitHub positions Copilot cloud agent as an agent that can work independently in
the background: research a repository, plan, fix bugs, implement features,
improve test coverage, update docs, address technical debt, and resolve merge
conflicts. It can be invoked from GitHub issues or PR comments, and GitHub now
supports automations that run on schedules or events such as issue creation, PR
open, and PR synchronization.

Competitive implication: GitHub owns the broad "delegate this task to an agent"
lane. Codexa should not compete by being a generic task executor. Codexa should
win by being the repo-specific proof layer that tells any agent or reviewer
what is risky, what is covered, and what drifted.

### OpenAI Codex GitHub integration

OpenAI Codex can be tagged on issues and pull requests to start cloud tasks and
propose changes. Its GitHub code review integration supports `@codex review`,
automatic reviews, repository guidance through `AGENTS.md`, and follow-up
comments such as asking Codex to fix a specific review finding.

Competitive implication: Codex already has the "cloud task from GitHub"
surface. Codexa can complement it by making GitHub review requests more
evidence-grounded: before `@codex fix`, Codexa can identify the likely files,
required tests, trust boundaries, and whether the eventual PR matched the
planned scope.

### Dependabot and Renovate

Dependabot and Renovate are the best analogies for useful automation because
they are narrow, recurring, configurable, and reviewable. Dependabot opens
security and version-update PRs from dependency facts; Renovate detects package
files across platforms, schedules PR creation, and supports configurable
behavior.

Competitive implication: the winning automation pattern is not "do anything."
It is "watch a narrow fact class, create a scoped branch or issue, attach
evidence, and let humans review."

### CodeRabbit, Qodo, and Greptile

AI review products converge on pull request monitoring, whole-repo context,
summaries, bug detection, security and quality checks, prioritized findings,
custom rules, and fix suggestions. CodeRabbit emphasizes automatic PR review,
security scanners, one-click fixes, and incremental reviews. Qodo emphasizes
multi-agent review, rule enforcement, organizational standards, full repo
context, and lower noise. Greptile frames itself as a stack-agnostic,
AI-powered linter that summarizes PRs, comments on issues, suggests fixes, and
uses repository context.

Competitive implication: PR review is crowded. Codexa needs a clearer promise
than "AI comments on your PR." The strongest promise is: "This PR's plan,
blast radius, and verification evidence are coherent, or here is the precise
gap."

### SonarQube Cloud and Snyk

SonarQube Cloud uses pull request analysis and quality gates to catch new
issues before merge, decorates PRs in the DevOps platform, and can block merges
when the gate fails. Snyk creates automatic Fix PRs for vulnerabilities based
on recurring scans, with thresholds and severity controls.

Competitive implication: teams trust automation when it is policy-shaped,
severity-ranked, and tied to merge gates. Codexa should copy that control
model: severity, confidence, noisy-signal suppression, explicit permissions,
and "warn/comment/block" modes.

### Devin and other full-contributor agents

Devin's GitHub integration enables it to create pull requests, respond to PR
comments, collaborate directly in repositories, and act like a contributor.
Recent research on PR lifecycles describes a collaborator-to-assistant spectrum:
some tools initiate and carry PR work forward, while human merge governance
usually remains the final authority.

Competitive implication: full-contributor agents are real, but the oversight
problem is not solved by more autonomy. Codexa can be valuable as the
oversight substrate: who initiated the work, which evidence justifies it, what
changed outside scope, and what verification actually covers.

## Useful GitHub Scenarios

### 1. Issue intake and readiness

When a new issue is opened, Codexa can comment with:

- likely subsystem and files to inspect;
- whether the issue has enough reproduction detail;
- missing environment, logs, screenshots, or expected behavior;
- suggested labels such as `needs-repro`, `good-first-codex`, `high-risk`,
  `docs-only`, or `needs-maintainer-scope`;
- a proposed smallest useful next action.

This is "triage nurse for engineering issues": it does not treat every issue
as ready for surgery. It tells maintainers what information is missing and
routes the issue to the right lane.

### 2. Issue-to-plan conversion

On `@codexa plan`, Codexa can turn a reasonably clear issue into a plan comment:

- target behavior;
- non-goals;
- files and call paths to read first;
- risks and trust boundaries;
- tests to run;
- explicit "do not touch" areas;
- whether the issue is safe for an autonomous agent or should stay human-led.

This is "an architect's one-page design review before the branch exists."

### 3. PR scope and drift review

On PR open or synchronize, Codexa can compare the PR against the issue and any
saved plan:

- files changed but not planned;
- planned files not touched;
- risky imports or callers pulled in by the diff;
- migrations, generated artifacts, or config changes that increase review
  surface;
- whether the PR quietly changed tests without changing production code, or
  vice versa.

This is "diff air traffic control": not judging style first, but making sure
the flight path still matches the filed plan.

### 4. Verification ledger comments

Codexa can post a concise evidence ledger:

- reported commands;
- what changed surface they cover;
- what they do not cover;
- exit-masking or irrelevant-command warnings;
- CI failures mapped to likely files;
- recommended missing targeted tests.

This is "a receipt for the claim that the PR is verified."

### 5. Dependabot/Renovate PR blast-radius assistant

For dependency-update PRs, Codexa should not replace Dependabot or Renovate.
Instead it should annotate their PRs:

- which local modules import the updated package;
- whether lockfile-only updates are truly lockfile-only;
- which tests are most relevant;
- whether changelog notes imply runtime, security, or API risk;
- whether the update touches build tooling and should run broader checks.

This is "Dependabot's senior reviewer."

### 6. Scheduled codebase health scouts

On a weekly schedule, Codexa can scan for specific, evidence-backed issues and
open a grouped report issue or small fix PRs:

- stale generated docs or demos;
- public CLI flags documented but not tested;
- high-risk shell/file/network call paths without regression tests;
- repeated TODO or placeholder clusters in non-test code;
- issue/PR feedback patterns that should become repo guidance;
- test commands that no longer map to changed files.

This is "a staff engineer's maintenance patrol with a strict noise budget."

### 7. Review-comment consolidation

When a PR has review comments, Codexa can consolidate them:

- separate blocking issues from preferences;
- identify duplicate or conflicting comments;
- map each actionable comment to files and likely tests;
- propose a repair order;
- detect when new commits resolved a comment even if the thread is still open.

This is "review thread compiler."

### 8. CI failure triage

On failing checks, Codexa can classify:

- likely flaky vs deterministic failure;
- whether the failure appears related to the diff;
- the shortest local reproduction command;
- a suggested next command or rollback path;
- whether the PR should be blocked before further review.

This is "CI incident report, scoped to this diff."

### 9. Release and publish readiness

For release PRs, Codexa can check:

- public hygiene;
- changelog and version consistency;
- package contents;
- release workflow changes;
- dry-run evidence;
- whether any generated or private artifacts slipped into the diff.

This is "release captain, not release magician."

### 10. Post-merge learning

After a merge, Codexa can summarize whether the work introduced reusable
lessons:

- update an existing AGENTS.md or skill only when a recurring class of defect
  was proven;
- otherwise keep learning in targeted tests or code contracts;
- never create process artifacts for one-off local details.

This is "retrospective without ceremony."

## What Would Make It Super Useful

The integration becomes compelling when it is automatic but bounded:

1. Low-noise by design. Codexa should prefer one high-signal comment over many
   inline nits. Every finding needs severity, confidence, evidence, and the
   smallest corrective action.
2. Clear modes. Repositories should choose `observe`, `comment`, `label`,
   `review`, `draft-pr`, and `block` modes separately.
3. Permission gates. Codexa can read by default. Commenting, labeling, opening
   issues, pushing branches, and committing fixes should require separate
   permissions or labels.
4. Evidence bundles. Each comment should include "why Codexa thinks this" with
   file paths, source facts, freshness state, and verification coverage.
5. Reusable commands. Humans should be able to say `@codexa plan`,
   `@codexa review-risk`, `@codexa verify`, `@codexa split`, `@codexa make
   dependabot-safe`, and `@codexa summarize-comments`.
6. Human merge governance. Codexa may open PRs, but it should not merge them in
   the first product version.
7. Repository memory with restraint. Codexa should learn from merged PRs and
   accepted review patterns, but only promote recurring, evidence-backed rules.
8. Works with other agents. The output should be useful to Codex, Copilot,
   Devin, Cursor, Claude Code, and human maintainers.

## Roadmap

### Phase 1: GitHub read model and comments

Implement a GitHub app or CLI-backed workflow that can read issues, PRs, diffs,
comments, checks, labels, and linked branches. Add read-only commands:

- `codexa github issue-brief <repo> <issue>`
- `codexa github pr-brief <repo> <pr>`
- `codexa github review-plan <repo> <pr>`

Outputs should be deterministic Markdown plus structured JSON so they can be
posted to GitHub or used by agents.

### Phase 2: PR evidence review

Add PR comments for:

- scope drift;
- likely impacted files;
- test and CI coverage gaps;
- suspicious verification claims;
- dependency-update blast radius.

Start in "single top-level comment" mode. Avoid inline comments until the
signal quality is proven.

### Phase 3: Issue automation

Add event triggers:

- issue opened;
- label added, such as `codexa:triage`;
- comment command;
- schedule.

Codexa can label and comment, but not push code yet. The best first win is
turning under-specified issues into actionable scoped tasks.

### Phase 4: Maintenance scouts

Add scheduled scans that open one grouped issue per category rather than many
small noisy issues:

- verification gaps;
- high-risk files without tests;
- stale docs against CLI flags;
- repeated review guidance candidates.

Require a confidence threshold and dedupe window.

### Phase 5: Draft PR creation

Only after the signal is trusted, allow Codexa to open draft PRs for narrow
classes:

- docs/code reference drift;
- missing regression tests for existing behavior;
- low-risk GitHub workflow/documentation fixes;
- Dependabot/Renovate verification helper changes.

Use labels such as `codexa:allow-branch` and `codexa:allow-pr`. Never merge by
default.

## Risks and Guardrails

- Permission creep. Keep GitHub app scopes separate by action.
- Noise. Cap comments per PR and require evidence-backed severity.
- Prompt injection from issues, PR descriptions, comments, branches, and file
  names. Treat GitHub content as untrusted input.
- Secret exposure. Never paste secrets into prompts or comments; redact command
  output and remote URLs.
- Stale context. Every comment should include freshness, head commit, and dirty
  state.
- False verification. Reported commands are not proof unless they cover the
  changed surface and are not exit-masked.
- Automation overreach. Opening a PR is acceptable for narrow classes; merging
  should remain human-governed.

## Positioning

Recommended product sentence:

> Codexa is the GitHub-native evidence layer for agentic development: it turns
> issues and pull requests into scoped plans, risk reviews, and verification
> receipts so humans and coding agents can move faster without losing control.

Shorter tagline:

> Dependabot for codebase health, with a verification ledger.

## Source Notes

- GitHub issue #52: https://github.com/mirnoorata/codexa/issues/52
- Local Codexa product shape: `README.md`
- Local architecture: `docs/architecture/codexa-context-server.md`
- Local AutoVerify plan: `docs/plans/codexa-verifier-runner-lane-2026-05-31.md`
- Local GitHub sync diagnostics: `src/github-sync.ts`
- OpenAI Codex cloud and GitHub integration:
  https://developers.openai.com/codex/cloud and
  https://developers.openai.com/codex/integrations/github
- GitHub Copilot cloud agent and automations:
  https://docs.github.com/en/copilot/concepts/agents/cloud-agent/about-cloud-agent
  and
  https://docs.github.com/en/copilot/how-tos/use-copilot-agents/cloud-agent/create-automations
- Dependabot version updates:
  https://docs.github.com/en/code-security/concepts/supply-chain-security/dependabot-version-updates
- Renovate docs: https://docs.renovatebot.com/
- CodeRabbit overview:
  https://docs.coderabbit.ai/guides/code-review-overview
- Qodo code review:
  https://docs.qodo.ai/code-review
- Greptile getting started:
  https://www.greptile.com/docs/code-review-bot/getting-started
- SonarQube Cloud pull request analysis:
  https://docs.sonarsource.com/sonarqube-cloud/analyzing-source-code/pull-request-analysis
- Snyk automatic Fix PRs:
  https://docs.snyk.io/scan-with-snyk/pull-requests/snyk-pull-or-merge-requests/enable-automatic-fix-prs
- Devin GitHub integration:
  https://docs.devin.ai/integrations/gh
- PR lifecycle research:
  https://arxiv.org/abs/2605.08017
- Coding agent adoption research:
  https://arxiv.org/abs/2601.18341
