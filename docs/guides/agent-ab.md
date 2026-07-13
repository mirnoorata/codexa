# Measuring Codexa's value to coding agents

Codexa has two distinct evaluation lanes:

1. `codexa eval` is a fast component gate for retrieval packets versus raw
   `rg` and Git output.
2. `scripts/agent-ab.mjs` is an opt-in, external agent experiment whose primary
   outcome is a completed patch verified outside Codexa.

Only the second lane can support a claim about agent task completion.

## Why Harbor

The experiment pins [Harbor](https://www.harborframework.com/docs/) 0.18.0.
Harbor already provides containerized coding-agent execution, built-in adapters
for flagship coding CLIs, MCP configuration, separate verifier containers,
usage records, and agent trajectories. The Codexa repository adds only causal
registration, arm assignment, deterministic grading fixtures, and paired
statistics.

No production Codexa module is imported by the controller or verifier.

The harness is source-checkout evaluation tooling, not a new installed Codexa
command. It adds no production runtime module or dependency and is excluded from
the npm package's executable payload; the public README may still document it.

## Arms

Both arms receive the same task bytes, task image, agent, model, ordinary
tools, budgets, retry policy, and concurrency.

- **Control:** no Codexa MCP registration and no Codexa workflow instruction.
- **Treatment:** a sandbox-local Codexa stdio MCP server plus the documented
  Codexa workflow instruction.

The registered intention-to-treat estimand is the effect of *offering that
MCP-plus-workflow-instruction bundle*. It is not the effect of the MCP in
isolation and it is not a per-protocol estimate among agents that chose to use
Codexa. A future component study needs a matched placebo instruction or a
preregistered factorial design.

The common task image contains the pinned Codexa package under an opaque
`/opt` prefix so the filesystem and toolchain stay identical, but it does not
put a `codexa` executable on the control agent's `PATH`. Only treatment
registers the sandbox-local entrypoint. Control contamination and treatment
adherence are reported from available trajectories; contaminated runs remain
in intention-to-treat results.

Only structured tool-call records support the usage classification. Missing,
malformed, or ambiguous trajectories remain unknown. Adherence and
contamination are descriptive telemetry and never alter outcome inclusion.

Codexa indexes the treatment checkout inside the sandbox. It cannot borrow an
index from the host or another arm. Index duration and exit status are written
as telemetry under `/logs/artifacts/`; they do not affect correctness.

The checked-in MCP wrapper deliberately takes no command-line arguments. Harbor
0.18's Codex adapter flattens an MCP command and its arguments into one command
string, so the wrapper binds `/workspace/project` internally rather than
depending on separately preserved arguments. The treatment-startup smoke must
perform a real MCP `initialize` handshake followed by `tools/list`; process
startup alone does not prove that the treatment is usable.

## Agent-inaccessible verification

Every task uses Harbor's separate verifier environment with `no-network` mode.
The checked-in pilot's public, auditable `tests/` source builds that image but
is never part of the agent image's Docker context. It is hidden from the agent
at execution time, not hidden from repository readers. After the agent stops,
Harbor transfers the declared finished project and `/logs/artifacts/` telemetry.
Only the project is a correctness input; setup and usage telemetry remain
agent-reported and descriptive. Private held-out confirmatory tests and oracles
belong in an unpublished task pack and must never be copied into public result
artifacts.

The primary reward is numeric `verified_completion`. The pilot requires:

- evaluator-owned behavioral checks;
- verifier-owned regression checks with a required nonzero test count;
- generated cases that discourage literal-specific patches;
- a nonzero passing public-test run as a task-contract check; and
- a verifier-owned pristine-tree comparison for scope and changed-line counts.

Transferred `.git` metadata is excluded and never defines the verifier's
baseline. Agent-modifiable public tests must pass but are not trusted as the
regression oracle. Benchmark tasks must be evaluator-owned
and audited before execution because repository code runs in the same agent
sandbox that receives model credentials.

Inside the verifier, a root-owned parent snapshots and locks the transferred
tree, then invokes candidate code in a bounded subprocess under an unprivileged
UID with `no_new_privs`, no network, read-only project access, no access to the
verifier or pristine baseline, a clean bytecode-cache prefix, and bounded time,
memory, processes, files, and result bytes. The parent validates exact JSON
types and expected values and is the only process that writes Harbor's reward.
Candidate diagnostics use a separate bounded channel and cannot corrupt the
result protocol.

Use a scoped, disposable provider credential for each experiment. Give it only
the model access and spend limit the run needs, do not expose repository,
publishing, cloud-administration, or other broad credentials, and revoke or
rotate it after the run. The agent sandbox has public network access and must be
treated as capable of reading and exfiltrating every credential made available
to it.

Agent prose, claimed test results, Codexa post-edit output, and proof cards are
untrusted telemetry. Once an assignment starts, a timeout, agent crash, validly
recorded verifier failure, or missing primary reward is a failed run under
intention-to-treat analysis. A missing, malformed, or misattributed
evaluator-owned result invalidates the protocol and suppresses the effect rather
than moving an arm's score. An assignment that never started is administrative
missingness, not an agent failure: the experiment is marked incomplete and no
effect is estimated.

## Registration and execution

Validate before registration:

```bash
node scripts/agent-ab.mjs validate --config benchmarks/agent-ab/experiment.json
```

Register the exact task hashes, treatment hashes, framework, agent, model,
agent-runner version and arguments, seed, repetitions, and counterbalanced
within-task execution order:

```bash
node scripts/agent-ab.mjs register \
  --config benchmarks/agent-ab/experiment.json \
  --output .codex/cache/codexa-agent-ab/RUN_ID \
  --agent codex \
  --model PROVIDER/MODEL
```

Registration is immutable. Immediately before spawning Harbor, the runner
writes an immutable `attempts/<run-id>.json` journal bound to the exact
registered assignment. `--resume` permits never-started registered work to
continue only when the experiment, task, treatment, agent, and model hashes
still match. A started assignment without final metadata remains an ITT failure
and is never rerun.

Those hashes bind source inputs; they do not make a container build
bit-for-bit reproducible. Exact replay also requires recording the built-image
digest and the resolved operating-system and package dependency lock used by
that run. Without those artifacts, compare paired arms within a run and label
cross-run reproduction accordingly.

The checked-in configuration is frozen to the archived Codexa 0.10.0 pilot.
A later candidate needs a new experiment ID plus matching version pins in the
experiment config and task Dockerfile; do not relabel or overwrite the archived
result.

Execute:

```bash
node scripts/agent-ab.mjs run \
  --config benchmarks/agent-ab/experiment.json \
  --output .codex/cache/codexa-agent-ab/RUN_ID \
  --agent codex \
  --model PROVIDER/MODEL \
  --resume
```

The runner uses executable-plus-argument subprocesses, disables Harbor
telemetry, sets one Harbor attempt, sets zero retries, and terminates the whole
Harbor process group at the controller deadline. Environment values are
inherited for provider authentication but never serialized by the controller.

## Analysis

The summary reports:

- the registered configuration, task, treatment, framework, and runner hashes
  or identities needed to bind the result to its inputs;
- whether every registered assignment started;
- control and treatment verified-completion rates;
- present/missing-aware summaries of every numeric verifier reward, including
  scope and diff-size diagnostics when a task emits them;
- absolute risk difference;
- treatment-only and control-only discordant pairs;
- task-clustered percentile bootstrap interval;
- reported tokens, cost, wall time, and Codexa indexing time, including present
  and missing counts for every metric; and
- completion-conditioned metric means alongside all-started-run summaries.
- structured per-tool Codexa call counts when the agent trajectory exposes
  them, without treating invocation as proof of benefit.

No effect is emitted while the experiment is incomplete. Final metadata is
accepted only when its assignment fields and expected job path match the
registration, and the Harbor aggregate, trial identity, and recorded task path
match the exact registered immutable task snapshot. This prevents a sibling
job or same-named task result from being attributed to the wrong arm.

The trial's recorded agent, model, exact runner kwargs, MCP servers, and
extra-instruction paths must reproduce the registered arm. Control must record
empty MCP and instruction lists; treatment must record exactly the
zero-argument Codexa stdio wrapper and the registered input-snapshot workflow
instruction. Any mismatch is an evaluator-protocol failure:
`protocolStatus` becomes `invalid`, the outcome is not scored as a product
failure, and the effect and claim are suppressed. Codexa setup presence,
reported version, indexing result, and trajectory usage come from
agent-writable artifacts. They remain explicitly agent-reported, descriptive
fidelity telemetry and never change ITT inclusion; treatment identity instead
rests on the registered immutable task, Dockerfile, MCP, and instruction hashes.

The task is the generalization unit. Repetitions characterize stochasticity;
they do not turn one task into several independent observations. With fewer
than two tasks, the controller explicitly refuses to estimate a clustered
interval.

The configured confidence level controls both the calculation and the rendered
interval label. Repetition-level McNemar significance is intentionally not a
headline because repetitions within a task are not independent generalization
units.

Efficiency comparisons are conditioned on verified completion as well as
reported across all started runs. Every metric reports eligible, present, and
missing run counts so differential telemetry loss cannot silently change the
denominator. A fast incorrect run is not a win.

## From pilot to confirmatory evidence

Schema-v1 summaries always set `confirmatory` to false because the registration
does not encode a power calculation or confirmatory declaration. The checked-in
one-task study is specifically labeled a non-confirmatory plumbing pilot, even
after every run finishes; a multi-task v1 run remains descriptive. A credible
study should:

1. Calibrate on 12-20 diverse tasks and at least two runs per arm.
2. Freeze a different held-out set across repositories, languages, bugs,
   refactors, configuration, and multi-file work.
3. Keep confirmatory held-out tests and oracles outside agent-visible
   repositories and public result artifacts.
4. Power the confirmatory run for a predeclared minimum useful completion lift.
5. Interleave arms because hosted model implementations can drift over time.
6. Publish the registration, hashes, deterministic scorer, aggregate outcomes,
   and exclusions; do not publish secrets or private task contents.

Retrieval, lifecycle governance, and full Codexa should be studied separately.
The current tools couple some retrieval and governance behavior, so hiding a
few tools is not a valid factorial decomposition.

## Multi-agent study

The checked-in runner does not yet implement or score a multi-agent design. The
following is a separate future study, not a claim supported by the pilot.

First fix the topology: a coordinator and sole writer, an impact scout, a test
specialist, and an adversarial reviewer. Run single-agent control/treatment and
fixed-team control/treatment with equal aggregate budgets. Harbor trajectories
can retain subagent activity.

Measure final verified completion first, then duplicate searches, handoff loss,
contradictory recommendations, scope drift, attempts, patch churn, tokens,
messages, and time. A later optional-use study can let a flagship agent choose
its own delegation strategy; that measures product effectiveness, not the
fixed-topology causal mechanism.

## What the result can say

- Higher verified completion: effectiveness value.
- Equal completion with lower cost or time: efficiency value.
- Fewer severe scope or continuity failures without completion loss: safety
  value.
- Better retrieval with unchanged completion: component value only.
- No endpoint improvement after accounting for overhead: no demonstrated net
  agent value.

The experiment is not designed to claim that Codexa changes a model's intrinsic
reasoning capability.

The checked-in one-task GPT-5.6 Sol run is archived at
[`reports/benchmarks/v0.10.0-agent-ab-pilot-v3.json`](../../reports/benchmarks/v0.10.0-agent-ab-pilot-v3.json).
It found equal verified completion and higher treatment cost, tokens, time, and
diff size. Both treatment runs also received a blocking post-edit drift warning
for planned symbols despite satisfied invariants and passing external
verification. Those are descriptive plumbing-pilot observations, not a
product-effect estimate.

One post-run audit limitation narrows even that completion claim: the
registered oracle interpreted "control characters" as ASCII C0 plus DEL and
did not test Unicode C1. The result is valid against the preregistered oracle,
but it does not prove the task wording's broadest Unicode interpretation. The
immutable task is preserved for provenance; any successor must specify the
Unicode contract and add cases under a new experiment ID.
