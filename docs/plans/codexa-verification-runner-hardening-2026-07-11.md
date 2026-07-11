# Codexa Verification Runner Hardening Plan

Status: locally validated; pull-request review pending
Date: 2026-07-11
Baseline: `main` at `4b9d3c5` (`@mirnoorata/codexa` 0.9.0)
Task snapshot: `codexa-verification-runner-hardening-20260711`

## Decision

Ship two tightly coupled verification improvements:

1. Add a deterministic differential harness that executes generated command
   shapes under a real POSIX shell and proves that a failed test runner never
   earns positive Codexa coverage when shell structure masks its exit.
2. Add one in-lane runner pack for Playwright Test, close the existing
   `vitest --project` scope over-credit, and bump command-classifier provenance
   from v3 to v4.

This is the highest-ROI next phase because verification credit is Codexa's
strongest product distinction. The first slice protects that trust boundary
before grammar expansion; the second removes a common false missing result for
targeted browser tests without claiming more scope than the command proves.
It adds no public tool, command execution path, runtime dependency, service, or
source mutation surface.

## Product Contract

Codexa remains a local, deterministic, query-only context and proof layer.
This phase must preserve these invariants:

- MCP never executes commands or edits source.
- A reported exit code is evidence only for the command whose exit it reflects.
- Failed, masked, interactive, list-only, or zero-test-tolerant invocations do
  not earn positive verification credit.
- Coverage scope is explicit. A runner configuration or project name is not a
  substitute for an indexed test path.
- Public and persisted results carry the classifier version that produced
  them.
- Unknown command semantics fail closed and remain visible as `unknown`.
- The same declared inputs produce deterministic coverage and ordering.

## Current Evidence

Current source and a clean-tree probe show:

- `src/query/verification.ts` recognizes Vitest, Jest, Node test, and pytest,
  but not Playwright Test.
- Direct, `npx`, package-manager exec, and package-script Playwright commands
  currently produce no verification coverage.
- `vitest --project api` currently emits repository-scope
  `javascript-tests`, even though a Vitest project can select only one subset
  of tests.
- Classifier provenance is already first-class and persisted as
  `command-coverage-v3`; a grammar change therefore requires a version bump,
  not a new provenance system.
- Existing hand-written masking regressions are extensive, but they do not
  compare Codexa's decision with an actual shell and failed stub runner.

Primary runner documentation checked on 2026-07-11:

- Playwright documents `playwright test [options] [test-filter...]`, states
  that non-option filters select matching test paths, and states that
  `--list` collects tests without running them:
  https://playwright.dev/docs/test-cli
- Playwright projects can split test files with project-specific `testMatch`
  and `testIgnore`, so `--project` alone cannot prove repository-wide test
  coverage:
  https://playwright.dev/docs/test-projects
- Vitest documents `--project` as a workspace-project filter and
  `--passWithNoTests` as allowing success with no tests:
  https://vitest.dev/guide/cli

## Slice A: Differential Shell Safety Harness

### Invariant

Positive test coverage requires an exit-faithful successful runner.

### Failure mode

A parser blind spot in wrappers, control operators, compounds, heredocs, or
command substitutions can let a failed runner be reported as covered because a
later shell operation returns zero.

### Trust boundary

The boundary is the untrusted reported command string plus exit code. Codexa's
static classifier must agree with real shell exit propagation before it grants
credit.

### Smallest mechanism

- Add a deterministic, seeded test generator using only Node and Vitest.
- Create a temporary `vitest` stub that records invocation and exits with a
  controlled status.
- Execute bounded command shapes through real `/bin/sh`.
- Feed the exact command, cwd, and aggregate exit code through the production
  verification classifier.
- Assert that every invoked failed runner whose aggregate command exits zero
  produces no `javascript-tests` or `targeted-test` credit.
- Keep positive exit-faithful controls so the harness cannot pass by suppressing
  all coverage.

No property-testing dependency or new production API is justified.

### Proof

- The generated seed and command are printed on failure.
- Cases cover direct commands, `||`, `;`, pipes, backgrounding, wrappers,
  groups, compounds, heredocs, substitutions, and deterministic combinations.
- The stub log proves whether the runner actually executed.
- Focused and full tests pass on Linux, the shell platform used by CI.

### Rollback

The harness is an isolated test file. Any production fix it exposes is kept as
a named regression, so reverting the generator cannot erase the concrete bug.

## Slice B: Fail-Closed Playwright Test Credit

### Invariant

Playwright credit identifies only test files the reported command demonstrably
selected and ran successfully.

### Failure modes

- Targeted Playwright commands currently receive no credit, training users to
  waive legitimate verification.
- A naive runner pack could mark every JavaScript test in a package covered by
  `playwright test`, even though Playwright config and projects can select a
  disjoint subset.
- `--list`, UI mode, or `--pass-with-no-tests` can exit without proving tests
  ran.
- `vitest --project` currently over-credits repository scope for the same
  configuration-selection reason.

### Trust boundary

The boundary includes launcher flags, exact runner/subcommand identity,
selection flags, package-script expansion, structured command envelopes, and
reported cwd/exit status.

### Smallest mechanism

- Reuse the existing tool-invocation resolver for direct, `npx`/`bunx`, and
  package-manager exec launchers rather than adding a second parser.
- Recognize only the exact Playwright `test` subcommand.
- Reject help, version, list, UI, and zero-test-tolerant invocations.
- Require one or more explicit normalized test paths before Playwright earns
  `javascript-tests` and `targeted-test` credit.
- Keep unscoped or config/project-only Playwright commands visible as
  `unknown` with a specific reason.
- Downgrade targetless `vitest --project` reports to `unknown` while preserving
  explicit targeted commands.
- Teach command envelopes the same runner identity and bump provenance to
  `command-coverage-v4`.
- Do not add Playwright to AutoVerify in this phase. Execution policy is a
  separate, higher-risk boundary.

### Proof

Production-path tests cover:

- direct, `npx -y`, `npm exec`, `pnpm exec`, `bunx`, and package-script forms;
- explicit relative and absolute test paths;
- structured envelope parity;
- project/filter commands with and without explicit paths;
- help, version, list, UI, install, show-report, and pass-with-no-tests cases;
- masks and wrappers through the differential harness;
- persisted and MCP-visible classifier provenance v4.

### Rollback

Reverting the runner-recognition branch restores the prior false-missing
behavior without changing persisted schema. Older outcomes remain honest
because they retain classifier v3.

## Execution Order

1. Save the plan and Codexa task snapshot.
2. Add the differential harness against current production behavior.
3. Fix every concrete false-positive shape the harness exposes and retain a
   named regression for each.
4. Add Playwright recognition, Vitest project-scope hardening, and v4
   provenance.
5. Run focused tests and inspect the complete diff.
6. Run typecheck, full check, security/package gates, retrieval eval, and
   hot-path benchmark.
7. Run repeated adversarial reviews across trust, scope, persistence, bloat,
   and test-vacuity vectors. Fix valid findings and repeat until convergence.
8. Commit, generate Markdown/PDF PR artifacts, push a draft PR, obtain an
   exact-head review, merge only with green checks and zero unresolved threads,
   then sync, rebuild, and reindex canonical Codexa.

## Adversarial Acceptance Gate

The phase is fit to ship only if all answers are yes:

- Can any generated failed runner hidden behind shell syntax earn positive
  credit? It must not.
- Does the harness prove the runner ran, the runner failed, and the aggregate
  shell exited zero before asserting fail-closed behavior?
- Can `playwright install`, `show-report`, `codegen`, `--list`, UI mode, or
  zero-test-tolerant execution earn credit? It must not.
- Can an unscoped Playwright or Vitest project filter cover unrelated tests? It
  must not.
- Do direct, launcher, package-script, and structured-envelope paths classify
  the same invocation consistently?
- Do persisted outcomes, proof surfaces, compact MCP data, and eval provenance
  expose classifier v4?
- Did the implementation avoid new dependencies, public verbs, execution
  policy, services, and broad runner frameworks?
- Are full local gates, exact-head CI, review threads, branch ancestry, and
  canonical post-merge parity clean?

## Explicit Deferrals

- Monorepo fan-out (`pnpm -r`, Turbo, Nx, Lerna): package-set expansion and
  partial-failure semantics need their own slice.
- Additional runners (Mocha, Bun, Deno, Cargo, Go, Gradle): one or two packs per
  release only, after this harness proves useful.
- Artifact credit, witnessed execution, flaky-test history, GitHub Actions,
  and sticky PR comments: separate trust or distribution boundaries.
- Parsing Playwright/Vitest configuration to map projects to tests: defer until
  targeted-command evidence shows enough false-missing demand to justify a
  config parser.

## Implementation And Adversarial Review Record

### Round 1: Exit Fidelity, Scope, And Test Vacuity

The first implementation pass exposed and fixed these blocking issues:

- `yarn dlx playwright` was initially routed as a Yarn package script. Runner
  resolution now happens before the Yarn script branch and is shared by raw
  classification and command-envelope derivation.
- A target-shaped Vitest `--project` value could be mistaken for a test path.
  Project option values are removed before target extraction, while an
  explicit path after the project remains eligible for targeted credit.
- Playwright snapshot-ignore/update modes could pass while weakening the test
  proof. They now fail closed with list, UI, grep, shard, last-failed, changed,
  and zero-test-tolerant modes.
- The differential harness originally sampled only Vitest. Playwright is now
  an independent generated runner dimension, with positive controls for both.
- Low-order linear-congruential bits initially starved one generated runner
  dimension. Sampling now uses the normalized 32-bit value, and the harness
  aborts unless every runner, mask, wrapper, and prefix dimension is covered.
- The temporary-repository cleanup is guarded, generation has an attempt cap,
  and the entire real-shell suite skips before setup on non-POSIX platforms.

### Round 2: Provenance, Adjacent Runners, And Bloat

The persistence and fresh-eyes pass exposed and fixed these issues:

- The schema contract still pinned `command-coverage-v3`; it now requires v4.
  Runtime, outcome, MCP, compaction, proof, and eval paths already consume the
  shared provenance constant and required no parallel version source.
- Launcher-wrapped Vitest and Jest commands could classify as those runners
  while their derived envelopes retained the launcher identity. All three
  JavaScript runners now use the same invocation resolver for provenance.
- Equivalent proof-weakening modes remained beside the new Playwright branch.
  Vitest, Jest, and Node test now reject documented non-running, watch/UI,
  snapshot-update, project/subset, shard, and zero-test-tolerant forms.
- The implementation adds no dependency, public command, MCP execution path,
  configuration parser, service, or generalized runner framework.

The initially unplanned `README.md` and `tests/schema.test.ts` edits are
required for public behavior disclosure and the existing provenance contract.
The provisional runner predicate was moved out of
`src/query/verification/shell.ts` during the final cohesion review, leaving the
generic shell parser unchanged.

### Round 3: Architecture Ratchet And Full Gates

The first full check rejected the implementation because
`src/query/verification.ts` exceeded the repository's 1,000-line source cap.
Runner-specific policy now lives in
`src/query/verification/javascript-tests.ts`; the orchestration module is 920
lines, and no hygiene threshold was relaxed. The original task snapshot is
preserved, while a second explicit snapshot,
`codexa-verification-runner-hardening-replan-20260711`, records the reviewed
12-file provisional scope expansion. The final cohesion pass then removed the
`src/query/verification/shell.ts` diff, leaving 11 changed files.

Local acceptance evidence:

- `npm run check`: source/release/privacy checks, 113 shell integration checks,
  46 test files, and 431 Vitest tests passed.
- `npm run eval:ci`: 21 scenarios passed with score 1.
- `npm run benchmark:ci`: every hot-path threshold passed.
- `npm run smoke:package`: 25 packed install/runtime checks passed.
- `npm run package:hygiene`: package and plugin hygiene passed.
- `npm audit --audit-level=moderate`: zero vulnerabilities.

The remaining gates are exact-head pull-request review, GitHub checks, zero
unresolved threads, merge ancestry, and canonical post-merge sync/reindex.

### Round 4: Pull-Request CI Hygiene

Both initial GitHub `check` jobs rejected the generated Markdown and PDF
summaries because they embedded local absolute worktree and artifact paths. The
summary now uses repository-safe descriptions, the PDF was regenerated with
the same deterministic renderer and visually inspected, and the public-hygiene
gate passes. This was an artifact-only failure; package smoke passed on the
same PR head.

### Round 5: Official CLI Parity

A fresh comparison against the official Playwright Test option contract found
that `--debug` had been treated as a harmless switch even though it launches
the interactive Inspector. Debug mode now fails closed like UI mode. The same
audit added targeted credit for the safe value-bearing `--global-timeout`
option, avoiding an unnecessary false missing without widening test scope.

The exact-head Codex review then found that raw `yarn dlx vitest` and
`yarn exec jest` commands resolved the correct runner but entered generic Yarn
script expansion before receiving coverage. All resolved JavaScript runners
now classify before that branch, matching command-envelope behavior; both Yarn
launcher forms have production-path regressions.

The second exact-head review found that the common flag helper treated inline
values `false`, `0`, and `off` as disabled for every option. Those strings are
valid grep and test-name patterns, so subset runs could regain full file
credit. Proof-weakening flags are now presence-sensitive regardless of inline
value, with Playwright, Vitest, Jest, and Node test regressions. This is
deliberately fail-closed for boolean-looking values.

The third exact-head review found a compatibility false missing for supported
Playwright `-b/--browser <name>` test runs. Browser selection is scope-safe
when an explicit indexed test path is present, so both separate and inline
forms now receive the same targeted credit as other safe value options.
