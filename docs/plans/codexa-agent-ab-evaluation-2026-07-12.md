# Codexa agent A/B evaluation plan

Date: 2026-07-12
Status: implemented and externally verified

## Decision

Use Harbor 0.18.0 as the external execution framework and keep causal
registration and statistics in a standalone repository script. Harbor is a
better fit than extending `codexa eval` because it already runs Codex, Claude
Code, OpenHands, and other coding agents in isolated containers, accepts MCP
configuration as an experimental treatment, supports separate verifier
containers, and records agent trajectories and usage.

Codexa must not grade Codexa. The existing retrieval gate remains a component
test; this lane measures whether an agent completes a coding task better when
Codexa is available.

Primary sources used for the framework decision:

- [Harbor agents](https://www.harborframework.com/docs/agents)
- [Harbor tasks and verifier isolation](https://www.harborframework.com/docs/tasks)
- [Harbor MCP task configuration](https://www.harborframework.com/docs/tutorials/mcp-server-task)
- [Harbor metrics](https://www.harborframework.com/docs/datasets/metrics)
- [Inspect agent bridge](https://inspect.aisi.org.uk/agent-bridge.html)
- [Inspect multi-agent evaluation](https://inspect.aisi.org.uk/multi-agent.html)
- [SWE-bench harness](https://www.swebench.com/SWE-bench/api/harness/)

## Experimental contract

The primary endpoint is `verified_completion`, a binary reward produced only
by deterministic, agent-inaccessible checks after the agent stops. The pilot's
verifier source is public and auditable; confirmatory held-out tests remain in
an unpublished task pack. A run passes when its
behavior, regression, genericity, public-test, and scope checks all pass. Once an assignment
starts, timeouts, agent errors, validly recorded verifier failures, and missing
primary rewards are failures under intention-to-treat analysis. A finalized
run whose evaluator-owned result is missing, malformed, misattributed, or does
not reproduce the registered protocol invalidates the experiment and suppresses
the effect instead of moving either arm's score. An assignment that never starts
is administrative missingness: the experiment is incomplete and emits no
effect estimate.

The control and treatment use the same task, task image, agent, model, ordinary
tools, concurrency, retry policy, and budgets. Treatment receives only:

1. a sandbox-local Codexa MCP server; and
2. the documented Codexa workflow instruction.

Codexa setup and indexing time are recorded separately. Codexa tool traffic and
proof output are telemetry, not correctness evidence.

## Trust boundaries

- The task's `tests/` directory builds a separate no-network verifier image.
  Harbor never copies those files into the agent environment.
- The declared finished project and `/logs/artifacts/` telemetry cross the
  agent boundary. Only the project is a correctness input; telemetry is
  agent-reported and descriptive.
- A root-owned verifier parent locks the transferred tree, runs candidate code
  as a bounded unprivileged `no_new_privs` subprocess, validates exact result
  types, and alone writes the reward.
- The controller never records environment-variable values or credentials.
- Experiments use scoped, disposable provider credentials with only required
  model access and bounded spend; broad repository, publishing, or cloud
  credentials are never exposed to agent tasks and are revoked or rotated
  afterward.
- Harbor telemetry is disabled by the runner.
- The controller writes immutable registration before execution and an exact
  attempt journal before each Harbor spawn. A started assignment is never
  retried.
- Final metadata, job identity, task identity, agent, model, MCP servers, and
  extra instructions must all match registration or the protocol is invalid
  and the effect is suppressed.
- Public pilot tasks prove harness plumbing only. Product-effect claims require
  held-out external tasks that were not used to build Codexa or the harness.
- Registration hashes bind source inputs, not resolved container builds. Exact
  replay additionally requires the built-image digest and resolved operating-
  system and package dependency lock from the original run.

## Implementation slices

1. Added a standalone `scripts/agent-ab.mjs` controller. It does not import
   `src/eval`, `prove`, lifecycle, or other Codexa scoring code.
2. Added a pinned Harbor experiment configuration and treatment MCP/instruction
   files under `benchmarks/agent-ab/`.
3. Added one generic path-normalization pilot with a separate verifier and an
   oracle solution. It validates the execution boundary; it is not evidence of
   product impact.
4. Added black-box tests for validation, deterministic arm assignment,
   intention-to-treat failure accounting, paired statistics, and task-clustered
   confidence intervals.
5. Documented how to run a pilot and how to interpret results without converting
   a retrieval win into an agent-performance claim.

## Analysis

The generalization unit is the task, not the repetition. The report includes:

- success rate per arm and absolute risk difference;
- treatment-only and control-only discordant pairs;
- task-clustered bootstrap confidence interval;
- present/missing-aware token, cost, wall-time, reward, and diff-size
  diagnostics where Harbor reports them;
- Codexa setup/version/index fidelity and structured per-tool call counts; and
- started failures as intention-to-treat failures, with never-started work
  reported separately as incomplete.

Repetition-level McNemar significance is intentionally omitted because repeated
runs on the same task are not independent generalization units.

The pilot uses two repetitions for plumbing. A confirmatory study starts with a
12-20 task calibration set, then powers a held-out task set for a predeclared
minimum useful lift. Pilot tasks cannot move into the confirmatory set.

## Observed plumbing pilot

The completed 2026-07-13 run used Harbor 0.18.0, Codex CLI 0.144.1,
`openai/gpt-5.6-sol`, and Codexa 0.10.0. It was protocol-valid, completed all
four registered assignments, and is explicitly non-confirmatory.

The publication run was preregistered as v3 after adversarial review added an
exact Harbor task-snapshot path check and made agent-writable setup/version
telemetry descriptive-only. The earlier v2 run is diagnostic, not publication
evidence.

| Mean per run | Control | Treatment | Ratio |
| --- | ---: | ---: | ---: |
| Verified completion | 2/2 | 2/2 | no difference |
| Input tokens | 84,954.5 | 692,609.5 | 8.15x |
| Output tokens | 2,670 | 6,888.5 | 2.58x |
| Reported cost | $0.2226 | $0.8646 | 3.88x |
| Agent elapsed time | 77.7s | 177.0s | 2.28x |
| Controller elapsed time | 118.2s | 217.7s | 1.84x |
| Verifier-counted changed lines | 33.5 | 57 | 1.70x |

Treatment invoked Codexa in both runs. Across them the structured trajectories
recorded 14 Codexa calls: 2 each to `session_context`, `task_brief`,
`change_plan`, `test_plan`, `post_edit_review`, `callers`, and `proof_card`.
Mean agent-reported Codexa indexing time was 617.5 ms, so indexing itself was
not the dominant overhead. In both runs `post_edit_review` issued a blocking
symbol-drift warning for changes already covered by the saved plan even while
reporting satisfied invariants, no unplanned files, and covered verification.

This run exercised the measurement path and produced a descriptive
negative-efficiency observation for one easy task. It cannot establish Codexa's
effect on diverse or difficult tasks. The sanitized report is
[`reports/benchmarks/v0.10.0-agent-ab-pilot-v3.json`](../../reports/benchmarks/v0.10.0-agent-ab-pilot-v3.json).

Adversarial post-run review found that the registered verifier operationalized
the task's "control characters" wording as ASCII C0 plus DEL and did not test
Unicode C1. Consequently, `verified_completion` proves only the registered
oracle, not the broadest Unicode reading of the instruction. The evaluated
bytes remain frozen; a successor task must state its Unicode categories
explicitly, add the corresponding checks, and use a new experiment ID.

## Multi-agent extension

After the single-agent lane is stable, use the same controller for a fixed team:
one coordinator and sole writer, one impact scout, one test specialist, and one
adversarial reviewer. Harbor's agent trajectory format can retain subagent
trajectories. Compare the full 2x2 design:

| Topology | Control | Codexa |
| --- | --- | --- |
| Single agent | S0 | S1 |
| Fixed team | M0 | M1 |

The interaction `(M1 - M0) - (S1 - S0)` estimates Codexa's coordination value.
Dynamic native delegation is a later effectiveness study, not a replacement for
the fixed-topology causal comparison.

## Verification and delivery

- Ran the black-box Vitest suite.
- Validated Harbor's resolved control and treatment configurations.
- Ran the oracle through the real Docker and separate-verifier boundary.
- Ran a real MCP `initialize` and `tools/list` handshake in the treatment image.
- Ran a deterministic simulated paired analysis with successes, crashes, and
  missing metrics.
- Ran a four-assignment GPT-5.6 Sol control/treatment plumbing pilot.
- Run repository typecheck, lint, privacy, tests, and package gates before
  delivery.
- Adversarially reviewed scorer independence, verifier isolation, treatment
  parity, process termination, registration immutability, and output privacy.
- Ship through a normal branch, PR, merge, and canonical sync. Release only if
  the repository's release automation classifies the development-only addition
  as package-facing.

## Explicit non-goals

- No claim that Codexa raises a model to another model's capability level.
- No model-based primary grader.
- No required model run in pull-request CI.
- No production Codexa module, runtime dependency, installed command, executable
  package surface, or packed file-set change. The public README may document the
  source-checkout-only harness.
- No retrieval-versus-lifecycle factorial until those treatment components can
  be switched independently without changing unrelated behavior.
- No domain-, customer-, screenplay-, or fixture-specific production rules.
