# Codexa AutoVerify v2 Plan

Status: proposed, adversarially hardened
Date: 2026-05-31

## Decision

Implement the executor/verifier as **AutoVerify v2** inside the Codexa package,
not as a second server, new user workflow, or general command runner.

The v1 product shape is one install and one Codexa-triggered loop:

```text
task_brief
change_plan(saveSnapshot=true)
Codex edits files
Codexa hook-post-edit
  first post_edit_review pass, no persistence
  AutoVerify v2 runs planned targeted tests when CODEXA_AUTOVERIFY=1
  final post_edit_review pass with in-memory runner reports
```

The user should not have to manually run a verifier command. Codexa triggers the
verifier from its existing hook lifecycle when execution is explicitly enabled.

The hard invariant is narrower than the earlier companion idea:

- Codexa query/MCP tools stay deterministic and non-executing in v1.
- `postEditReviewQuery` stays pure; execution lives in an explicit CLI hook
  wrapper.
- AutoVerify owns process-spawning risk and only emits evidence.
- `post_edit_review` remains the authority that decides whether evidence covers
  planned verification.

Keep the existing public name and flag. Do not rename the feature to a new
"verifier lane" in user docs unless usage proves the current AutoVerify wording
is failing.

## Research Constraints

Online research from 2026-05-31 was useful, but the hardened plan deliberately
collapses it into three constraints:

- **Do not become a build system.** Bazel sandboxing, Nx affected execution,
  Pants invalidation, Turborepo summaries, Jest related tests, and testmon all
  validate targeted, graph-aware verification. Codexa should consume its own
  planned test evidence instead of owning a build graph.
- **Do not add a runtime dependency in v1.** Dagger or Docker would improve
  isolation for some repos, but they materially raise installation and support
  cost. Keep container execution deferred.
- **Do not fake trust with signatures.** SLSA-style provenance is useful as a
  schema model. Sigstore-style signing is only meaningful with real key custody
  or a separate process boundary. V1 should use exact snapshot binding, policy
  validation, dirty hashes, and canonical digests.

Sources retained for implementation context:

- Bazel sandboxing: https://bazel.build/docs/sandboxing
- Nx affected: https://nx.dev/docs/features/ci-features/affected
- Pants test invalidation: https://www.pantsbuild.org/stable/docs/python/goals/test
- Turborepo run summaries: https://turborepo.dev/docs/reference/run
- Jest CLI related-test primitives: https://jestjs.io/docs/cli
- pytest-testmon: https://www.testmon.org/
- Dagger: https://docs.dagger.io/
- SLSA provenance: https://slsa.dev/spec/v1.2/provenance
- Sigstore: https://docs.sigstore.dev/

## Non-Goals

- No arbitrary command input.
- No main MCP execution tool in v1.
- No MCP `post_edit_review` execution in v1, even if the server inherited
  `CODEXA_AUTOVERIFY=1`.
- No new user-facing `verifier-dry-run` command in v1.
- No repo-local config policy surface in v1.
- No mandatory Docker, Dagger, Nix, Bazel, Pants, remote cache, API key, or paid
  provider.
- No command-result reuse cache in v1. Runner reports are fresh evidence, not
  cached pass claims.
- No cryptographic signing until there is a real separate-process or key-custody
  boundary.

## Trust Boundaries

Risky inputs and lifecycle edges:

- Planned command candidates derived from the first post-edit review pass.
- Repo-local `package.json` scripts and test runner config.
- `cwd`, argv, target path, symlink, path traversal, and path-valued flags.
- Environment variables inherited by child processes.
- Output capture that may contain secrets or private paths.
- Race between a user/Codex edit and a running verification command.
- Tests that mutate tracked source, tests, snapshots, or existing dirty files.
- New untracked source/snapshot files created by tests.
- Spoofed `ranCommandReports` supplied through CLI or MCP.
- A long-lived MCP server inheriting an execution env var.

The v1 rule is simple: only reports created in memory by the current
`hook-post-edit` AutoVerify invocation can receive trusted runner treatment.
Externally supplied reports remain manual evidence. They may stay backward
compatible, but they must never be labeled as "Codexa executed".

## Invocation Model

### Primary Path: CLI Hook Only

Execution in v1 is limited to `hook-post-edit`, which is already a Codexa-owned
local lifecycle hook. `postEditReviewQuery` must not spawn processes.

The hook wrapper should:

1. Load the exact current change-plan snapshot and `taskId`.
2. Skip execution if the latest snapshot is ambiguous or stale.
3. Run `postEditReviewQuery(..., persistOutcome=false, taskId=exactTaskId)`.
4. Build internal runner candidates before display truncation or MCP
   serialization.
5. Run AutoVerify only when `CODEXA_AUTOVERIFY=1`.
6. Pass trusted in-memory runner reports to the final post-edit review through
   an internal-only option, not through public JSON input.
7. Persist the final post-edit outcome normally.

### Consent And Enablement

Keep the existing public enablement:

```bash
CODEXA_AUTOVERIFY=1
```

Do not introduce a second public env var in v1. A future user-level Codexa
config outside the repo may enable AutoVerify after an explicit `codexa init`
prompt, but repo-local config must never enable execution by itself.

Repo-local policy narrowing is also deferred. Fixed conservative defaults are
lower risk until real repos demonstrate which overrides are necessary.

### MCP Boundary

MCP remains query-only in v1.

Required test: starting `codexa serve` with `CODEXA_AUTOVERIFY=1` in the server
environment must not let MCP `post_edit_review` spawn commands. If MCP execution
is ever added later, it must require both explicit server startup mode, such as
`codexa serve --enable-verifier`, and environment/user-level consent.

### Diagnostics

Do not add `codexa verifier-dry-run` in v1. Surface "would run" and "skipped
because" details through existing hook output, `post_edit_review`, and
`test_plan` fields. A separate dry-run command can be reconsidered only after
the hook path is stable and users need standalone debugging.

## Report Contract

Do not replace `VerificationCommandReport`. Runner reports must be a flat
strict superset so existing command/cwd/exit-code logic keeps working.

```ts
interface CodexaAutoVerifyReportV1 extends VerificationCommandReport {
  runner?: {
    schemaVersion: 1;
    reportKind: "codexa-autoverify-report";
    runnerName: "codexa";
    runnerVersion: string;
    policyId: "local-targeted-tests-v1";
    policyDigest: string;
    taskId: string;
    snapshotDigest: string;
    commandId: string;
    candidateDigest: string;
    headCommit: string | null;
    dirtyHashBefore: string;
    dirtyHashAfter: string;
    cwdRealpath: string;
    targetRealpaths: string[];
    envMode: "minimal";
    allowedBy: string[];
    sourceMutationDetected: boolean;
    timedOut: boolean;
    startedAt: string;
    finishedAt: string;
    signal?: string;
    outputRedacted: boolean;
    canonicalDigest: string;
  };
}
```

Trusted runner treatment requires all of these:

- The report came from the current in-memory hook runner, not from public CLI or
  MCP JSON input.
- Top-level `command: string`, `cwd`, `args`, and `exitCode` remain valid.
- `exitCode === 0`.
- `taskId`, `snapshotDigest`, `commandId`, and `candidateDigest` match the exact
  first-pass candidate.
- `cwdRealpath` and all target realpaths are under the repo realpath.
- `dirtyHashAfter` matches the final review dirty hash.
- `sourceMutationDetected === false`.
- The reported command matches the package/test-target inference already
  enforced by `verification.ts`.
- Output summaries were redacted before any logging or outcome persistence.

Legacy/manual reports stay accepted for backward compatibility, but they should
be labeled as manual/reported evidence and should never receive runner freshness
or provenance trust.

## Candidate Contract

Do not scrape serialized display fields such as truncated `data.testsNotRun`.
Add an internal candidate contract produced before display limiting:

```ts
interface AutoVerifyCandidateV2 {
  taskId: string;
  snapshotDigest: string;
  commandId: string;
  command: string;
  commandExecutable: string;
  commandArgs: string[];
  commandCwd: string;
  targetPaths: string[];
  source: "explicit" | "authoritative-test-edge" | "derived-impact" | "heuristic";
  rank: number;
}
```

The hook must pass the exact `taskId` into both post-edit passes. A latest
snapshot fallback may produce review text, but it must not execute commands.

## Execution Policy V1

Policy id: `local-targeted-tests-v1`.

Allowed runner families:

- Direct runner invocations: `vitest`, `jest`, `node --test`, `pytest`,
  `uv run pytest`, `python -m pytest`, `python3 -m pytest`.
- Package scripts only when the script name is `test` or `test:*`, has no
  lifecycle hooks, and the script body is a single supported direct test runner.

Allowed command shapes must be targeted:

- Each positional target must resolve under the repo realpath.
- Each target must be a test-like file already indexed or an authoritative
  planned test path.
- Broad test commands with no target are skipped.
- Composite package scripts such as `npm run build && vitest run` are skipped
  in v1. The planner should prefer a direct safe runner command such as
  `vitest run <target>` when it can prove the runner and target.

Required validation:

- No shell execution. Use `spawn(executable, args, ...)`.
- Executable name must be allowlisted.
- `cwd` realpath must remain under repo realpath.
- Reject package scripts with `pre<script>` or `post<script>` lifecycle hooks.
- Reject package scripts with shell metacharacters, command substitution,
  leading environment assignments, or multiple commands.
- Define per-runner allowed flags. Reject code-loading or path-valued flags
  unless explicitly supported and realpathed under the repo, including
  `--require`, `--loader`, `--import`, `--config`, `--setupFiles`,
  `--globalSetup`, and `-c`.
- Run commands serially under a runner lock.

Environment:

- Child env is allowlisted, not copied from `process.env`.
- Include only required process basics such as `PATH`, `HOME`, `TMPDIR`,
  `TEMP`, platform-required system vars, `CI=1`, `NO_COLOR=1`, and
  `CODEXA_VERIFY=1`.
- Do not pass `CODEXA_AUTOVERIFY`, API keys, tokens, `NODE_OPTIONS`,
  `NPM_CONFIG_USERCONFIG`, `PYTHONPATH`, or arbitrary `*_TOKEN` /
  `*_SECRET` / `*_PASSWORD` values.

Output handling:

- Capture bounded stdout/stderr.
- Redact secrets before console logging, report construction, outcome
  persistence, or any future diagnostics.
- Test redaction for Bearer tokens, `*_TOKEN=...`, `--token value`,
  credential URLs, and private absolute paths.

Timeouts:

- Align runner timeout with hook timeout. The generated hook cannot keep a
  20-second timeout while AutoVerify has a 60-second command timeout.
- Either raise the generated hook timeout when AutoVerify is enabled or lower
  the runner budget so it can always emit a final report before the hook exits.

## Source Mutation And Race Policy

Runner evidence is non-covering if the command mutates any reviewed source,
test, snapshot, or Codexa provenance state.

Required checks:

- Capture git status and content hashes for reviewed source/test files and all
  pre-existing dirty tracked files before each command.
- Capture the same after each command.
- Treat deletes, renames, modifications to already-dirty files, snapshot
  rewrites, and new untracked source/test/snapshot files as
  `sourceMutationDetected=true`.
- Ignore only declared test-output/cache directories that cannot affect source
  provenance.
- If the dirty tree changes between runner completion and final review, degrade
  the report as stale and tell the agent to rerun verification.

Persisted runner files, if added later, are diagnostics only. Repo-local cache
files are same-user writable by tests and must never be authoritative coverage
evidence.

## Module Design

Do not start by splitting `src/autoverify.ts` into five modules. It is small
enough that extraction-first work would add churn before the trust behavior is
proven.

Implementation should start in place:

- Harden `src/autoverify.ts` policy, env, flags, timeout, mutation checks, and
  report construction.
- Add the internal candidate contract at the post-edit boundary.
- Add an internal-only trusted runner report path to `postEditReviewQuery` or a
  wrapper used by the hook.
- Keep `src/query/verification.ts` as the consumer-side authority for coverage.

After behavior is stable, extract only cohesive pieces that have real reuse:

```text
src/runner/policy.ts      # argv, cwd, flags, env, package-script validation
src/runner/evidence.ts    # hashes, mutation detection, flat report metadata
```

No extraction is required if the in-place version remains readable and tested.

## Implementation Phases

### Phase 1: Freeze Public Boundaries

- Add a regression test proving MCP `post_edit_review` does not spawn with
  `CODEXA_AUTOVERIFY=1` in the server env.
- Keep `postEditReviewQuery` pure.
- Keep `CODEXA_AUTOVERIFY=1` as the only public execution flag.
- Remove new `verifier-dry-run`, runner cache, and repo-local policy config from
  the v1 implementation scope.

Acceptance:

- MCP remains query-only.
- Existing CLI/MCP `ranCommandReports` input stays backward compatible.
- Fake runner fields supplied through CLI/MCP are treated as manual/untrusted.

### Phase 2: Harden AutoVerify In Place

- Bind candidates to exact `taskId`, snapshot digest, command id, and candidate
  digest.
- Build candidates from an internal pre-display contract.
- Add minimal child env allowlisting.
- Reject dangerous package scripts, env assignments, lifecycle hooks, shell
  control, broad commands, and unsafe flags.
- Add source mutation and dirty-tree race detection.
- Align hook and command timeouts.
- Emit flat `CodexaAutoVerifyReportV1` reports in memory.
- Pass trusted reports only through the internal hook wrapper path.

Acceptance:

- Passing targeted test evidence can cover planned verification.
- Failing, stale, source-mutating, timed-out, skipped, or spoofed reports do not
  cover planned verification.
- Mutating an already-dirty file is non-covering.
- Creating an untracked test snapshot/source file is non-covering.
- A two-snapshot ambiguous latest review refuses to execute.

### Phase 3: Improve Existing Output Surfaces

- Show "AutoVerify would run", "AutoVerify ran", and "AutoVerify skipped"
  details in existing hook/post-edit output.
- Surface runner policy and skipped reasons in the verification ledger.
- Keep output concise and redacted.

Acceptance:

- Agents can see exactly why a command did or did not run without learning a new
  command.
- No raw secrets or private command output are stored or printed.

### Phase 4: Documentation And Gates

- Update README hook/AutoVerify docs.
- Update architecture docs to say MCP is non-executing in v1.
- Update plugin/skill docs only if their current AutoVerify wording becomes
  inaccurate.
- Add release checklist entries for hook smoke, MCP non-execution, spoofed
  report, mutation detection, and env redaction.

Acceptance:

- `npm run check`
- Focused AutoVerify/post-edit/MCP tests
- `npm run security:check` before publish
- PR checks green

## Test Plan

Unit tests:

- Flat report extension preserves `VerificationCommandReport.command: string`.
- Fake runner fields over CLI/MCP are manual/untrusted.
- Minimal env omits `OPENAI_API_KEY`, `GITHUB_TOKEN`, `NODE_OPTIONS`,
  `NPM_CONFIG_USERCONFIG`, `PYTHONPATH`, and arbitrary secret env vars.
- Package script lifecycle hooks, env assignments, shell control, composites,
  broad commands, and code-loading flags are rejected.
- Target realpath escapes and path-valued flag escapes are rejected.
- Output redaction happens before report/log construction.

Integration tests:

- `hook-post-edit` with no `CODEXA_AUTOVERIFY` runs review only.
- `hook-post-edit` with `CODEXA_AUTOVERIFY=1` runs only allowed targeted tests.
- MCP `post_edit_review` never spawns with env-only enablement.
- Two snapshots with ambiguous latest state refuse execution.
- Already-dirty source overwrite is non-covering.
- New untracked source/test/snapshot file is non-covering.
- Stale dirty hash after a user edit is non-covering.
- Slow tests produce a final timeout report rather than being killed by the hook
  wrapper.
- A fixture using Codexa's own `npm run test` composite shape is skipped, while
  direct `vitest run <target>` is allowed.

Release gates:

- `npm run typecheck`
- Focused Vitest tests for AutoVerify/post-edit/MCP
- `npm test`
- `npm run security:check` before publishing

## Adversarial Review Results

Accepted hardening changes:

- Kept this as AutoVerify v2 instead of adding a new user-facing verifier
  concept.
- Made MCP non-executing in v1, even with inherited env consent.
- Preserved the flat `VerificationCommandReport` contract.
- Added an internal-only trusted runner report path so public JSON cannot spoof
  "Codexa executed" evidence.
- Moved trust hardening into the first executable phase.
- Deferred new dry-run CLI, runner cache, repo-local policy config, broad module
  extraction, containers, and signing.
- Tightened mutation detection to include already-dirty files and untracked
  source/snapshot creation.
- Required minimal child env, unsafe flag rejection, exact snapshot binding, and
  hook timeout alignment.

Rejected or deferred:

- A separate companion server: not needed for the current product shape.
- General MCP execution: too much trust-boundary expansion for v1.
- New verifier CLI/cache/config surfaces: lower ROI than hardening the existing
  hook and report loop.
- Extraction-first refactor: lower ROI than trust behavior and regression tests.

## Highest ROI First Slice

Implement only this first:

1. Add tests that freeze the public boundary: MCP never executes, CLI/MCP
   spoofed runner fields are untrusted, and `postEditReviewQuery` stays pure.
2. Harden `src/autoverify.ts` in place: exact snapshot/candidate binding,
   minimal env, safe flags, source mutation checks, output redaction, and hook
   timeout alignment.
3. Emit flat in-memory `CodexaAutoVerifyReportV1` evidence from the hook path.
4. Teach final post-edit review to trust only current in-memory runner reports
   that pass freshness, mutation, digest, command, and target checks.
5. Improve existing hook/post-edit/test-plan output so agents see what Codexa
   ran or skipped without a new command.

This proves the architecture without adding a second service, a new public
workflow, a container dependency, cryptographic signing, a repo-local policy
surface, or a language-specific test-selection database.
