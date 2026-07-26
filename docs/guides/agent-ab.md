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

## Schema-v1 arms

The frozen schema-v1 pilot's two arms receive the same task bytes, task image,
agent, model, ordinary
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

Newly analyzed experiments also include
`codexaUsage.postEditDecisionTrace`. This nullable, versioned block separates
mere `post_edit_review` invocation from the decision sequence observable in the
agent-reported ATIF trajectory. A decision is attributed only when one
`tool_call_id` has exactly one observation result in the same ATIF step with the
same `source_call_id`, and the result contains one internally consistent Codexa
decision. `completionAuthority`, not `verdict` alone, distinguishes an advisory
inspection from a blocking decision. Result parsing accepts direct JSON and
bounded JSON embedded in Harbor 0.18's Codex-adapter carrier; it never evaluates
the surrounding wrapper syntax.

The derived `finalState` is one of:

- `not-reviewed`: no review call was observed;
- `complete` or `advisory`: the last observed decision was nonblocking;
- `nonblocking-after-blocking`: a nonblocking decision appeared in a later
  step after a blocking one; this does not imply the calls used the same task
  snapshot;
- `blocking-unresolved`: the last observed decision still required tests,
  inspection, or replanning; or
- `unknown`: the trace or call/result evidence was missing, copied,
  continued elsewhere, malformed, oversized, duplicated, ambiguous, or
  contained multiple review calls in one step.

These labels describe trace order only. They do not establish that the agent
obeyed or ignored Codexa, that Codexa was correct, or that a decision helped or
harmed the patch. Per-arm state counts retain unknowns in the denominator and
remain agent-reported telemetry; they never alter verifier-owned completion,
protocol validity, inclusion, or the intention-to-treat effect.

Copied-context steps are excluded from invocation counts because ATIF marks
them as prior interactions. A trajectory with an unloaded continuation,
embedded or externally referenced subagents, a malformed evidence-bearing
container, or a tool call without a usable `tool_call_id`, `function_name`, or
`arguments` is `partial`: aggregate Codexa invocation fields remain unknown and
the post-edit state is `unknown`. This is intentionally not a complete ATIF
conformance validator; it validates the structures used to make usage and
adherence claims. That avoids turning unsupported lineage or malformed evidence
into a confident no-use result; per-agent attribution is a separate future
analysis.

## Schema-v2 stepped ablation

Schema v2 preserves the verifier-owned ITT boundary while supporting arbitrary
registered arms and explicit pairwise comparisons. It is additive: schema-v1
configuration, assignment IDs, registration shape, analysis meaning, and the
archived v7 report remain historical evidence and are not rewritten as v2.

The recommended zero-loss-hypothesis candidate study uses the same Codexa
binary in every Codexa arm. The name is a hypothesis, not a result; the
optimized arm is not called zero-loss unless the held-out non-inferiority and
guardrail-recall gates pass.

| Arm | Exposure and delivery | Lifecycle cadence |
| --- | --- | --- |
| `control` | no Codexa | no Codexa |
| `full-detailed-legacy` | full direct schemas, detailed delivery | fixed legacy workflow |
| `adaptive-auto-legacy` | compact full-capability dispatcher, automatic delivery | fixed legacy workflow |
| `adaptive-auto-bounded` | compact full-capability dispatcher, automatic delivery | adaptive bounded workflow |

All Codexa arms use the same canonical detailed projection and structured-data
target for explicit detailed responses and resource-backed automatic results.
The delivery comparison therefore changes transport exposure, not evidence
capacity.

Preregister these comparisons to separate net value from individual overhead
changes:

- `adaptive-auto-bounded` versus `control`: optimized net value;
- `adaptive-auto-bounded` versus `full-detailed-legacy`: total optimization;
- `adaptive-auto-legacy` versus `full-detailed-legacy`: transport/exposure;
- `adaptive-auto-bounded` versus `adaptive-auto-legacy`: lifecycle cadence.

A v2 experiment replaces top-level `treatment` with `arms` and adds
`analysis.comparisons`:

```json
{
  "schemaVersion": 2,
  "experimentId": "codexa-agent-ab-zero-loss-hypothesis-v1",
  "framework": { "name": "harbor", "version": "0.18.0" },
  "runner": {
    "agent": "codex",
    "version": "PINNED_RUNNER_VERSION",
    "kwargs": { "reasoning_effort": "high", "web_search": "disabled" }
  },
  "candidate": { "codexaVersion": "PINNED_CODEXA_VERSION" },
  "design": {
    "seed": "PREREGISTERED_RANDOM_SEED",
    "repetitions": 4,
    "concurrency": 1,
    "maxRetries": 0,
    "timeoutMultiplier": 1,
    "controllerTimeoutSeconds": 3600
  },
  "tasks": [
    {
      "id": "TASK_ID",
      "name": "PACK/TASK_NAME",
      "path": "TASK_PATH",
      "expectedRouteClass": "source-only"
    }
  ],
  "arms": [
    { "id": "control", "kind": "control" },
    {
      "id": "full-detailed-legacy",
      "kind": "codexa",
      "mcpConfig": "config/full-detailed-legacy.mcp.json",
      "extraInstruction": "config/full-detailed-legacy.md"
    },
    {
      "id": "adaptive-auto-legacy",
      "kind": "codexa",
      "mcpConfig": "config/adaptive-auto-legacy.mcp.json",
      "extraInstruction": "config/adaptive-auto-legacy.md"
    },
    {
      "id": "adaptive-auto-bounded",
      "kind": "codexa",
      "mcpConfig": "config/adaptive-auto-bounded.mcp.json",
      "extraInstruction": "config/adaptive-auto-bounded.md"
    }
  ],
  "analysis": {
    "primaryReward": "verified_completion",
    "bootstrapSamples": 10000,
    "confidenceLevel": 0.95,
    "generalizationUnit": "task",
    "failurePolicy": "intention-to-treat",
    "comparisons": [
      { "id": "optimized-net-value", "baselineArm": "control", "candidateArm": "adaptive-auto-bounded", "primary": true },
      { "id": "total-optimization", "baselineArm": "full-detailed-legacy", "candidateArm": "adaptive-auto-bounded", "primary": false },
      { "id": "transport-exposure", "baselineArm": "full-detailed-legacy", "candidateArm": "adaptive-auto-legacy", "primary": false },
      { "id": "cadence", "baselineArm": "adaptive-auto-legacy", "candidateArm": "adaptive-auto-bounded", "primary": false }
    ]
  }
}
```

Arm IDs and comparison IDs are unique. Exactly one arm is control and exactly
one comparison is primary. Control carries no MCP or instruction input; every
Codexa arm carries exactly one of each. Registration copies each input into an
arm-specific immutable snapshot and records its hash and sandbox wrapper
command. Trial validation compares the actual MCP command and instruction path
with that arm's snapshot, so a copied config or swapped instruction invalidates
the protocol rather than becoming a product failure.

Within each task, the seed selects one base permutation of all arms. Repetition
`n` cyclically rotates that permutation by `n - 1`. Thus every block contains
every arm once, and four repetitions of a four-arm design put each arm in each
position once. Fewer repetitions remain valid but are only partially balanced;
the registration and summary publish the exact `positionalBalance` counts.
This is positional balance, not a claim of complete sequence counterbalancing.

### Selective-route conformance

Every task in a new selective-route schema-v2 study should register one
evaluator-owned `expectedRouteClass`. The value is immutable with the task
registration and must be one of:

- `source-only`: use ordinary source tools and make no Codexa call;
- `search-only`: call `search` once and make no later Codexa call;
- `plan-review`: call `change_plan`, then `post_edit_review`; or
- `search-plan-review`: call `search`, then `change_plan`, then
  `post_edit_review`.

The field is additive for compatibility: an older schema-v2 input without it
is still accepted, but its route evidence remains `unknown` and legacy
invocation-based adherence semantics remain in force. The checked-in
conformance pack requires the field on every task.

These classes encode the current selective-workflow contract, not task
correctness. The analyzer derives the ordered logical call pattern only from
structured trajectory evidence, including the explicit operation named by a
`capabilities` invocation. Exact single-command Codexa CLI tool calls are also
recognized. Tool names found only in source strings, comments, compound or
conditional shell commands, or other unexecuted text remain unknown. Missing,
malformed, copied, or unsupported lineage remains unknown. Repeated calls remain
in the observed sequence and therefore
produce a deviation when the registered sequence expects only one. Server
telemetry may corroborate calls that reached Codexa, but it cannot prove a
truthful zero-call route. The route trace does not prove that planned
verification ran; verifier and command evidence retain that separate
responsibility.

Route conformance is descriptive and never changes verifier rewards, protocol
validity, ITT inclusion, or effect estimates. A mismatch is treatment
nonadherence only for the registered primary comparison's candidate arm
(`adaptive-auto-bounded` in the checked-in design). The control has no Codexa
exposure, while legacy arms deliberately follow a fixed cadence that may
disagree with the selective route and are not labelled nonadherent for that
designed difference.

The checked-in
[`benchmarks/agent-ab-selective-v2`](../../benchmarks/agent-ab-selective-v2/)
pack is a one-task public conformance fixture for this plumbing. Its one
`source-only` task, one repetition, and four assignments cannot support a
calibration, confirmatory, or product-effect claim.

### Descriptive transport evidence

For ATIF-v1.7 trajectories, the analyzer correlates a Codexa call only when its
`tool_call_id` occurs once and exactly one result with the same
`source_call_id` appears in the same step. It reports:

- UTF-8 bytes of raw string-valued arguments or JSON-serialized object-valued
  arguments;
- UTF-8 bytes of model-visible observation text;
- requested and, when versioned delivery metadata is present, effective
  response formats;
- explicit detailed requests, actual detailed-resource fetches, automatic
  escalations, and unchanged receipts; and
- per-tool counts and byte totals.

The generic `read_mcp_resource` adapter call counts as an actual fetch only
when its uniquely correlated arguments contain exactly `server: "codexa"` and
an exact content-addressed
`codexa://repo/mcp-results/rr_<32-lowercase-hex-route>/mr_<64-lowercase-hex>`
URI. The fixed-size route is an opaque server-session identifier and does not
encode the checkout path.
The fetch's argument and model-visible
result bytes contribute to the overall totals and are also reported separately.
A resource link offered in another result is not a fetch.
Wrong servers, malformed or non-matching URIs, duplicate call/result IDs, or a
mismatch with observed server fetch events make the evidence partial instead
of silently reporting zero.

This is payload accounting, not token or cost attribution. Copied context,
duplicate IDs, unsupported continuation or subagent lineage, malformed
evidence, and scan/byte-limit exhaustion make the transport block
partial/unknown instead of producing a zero.

An arm may additionally opt into Codexa's content-free server JSONL telemetry
with `CODEXA_MCP_TELEMETRY_PATH`. For Harbor task packs, use a path that the
artifact contract transfers, for example
`/logs/artifacts/codexa-mcp-telemetry.jsonl`. The analyzer accepts exactly one
non-symlinked `codexa-mcp-telemetry.jsonl`, at most 4 MiB, 1,000 records, and 64
KiB per record. Relative paths resolve once against the configured MCP launch
root and remain there if workspace focus changes; an absolute task-pack path is
preferred when artifacts are collected outside that root. Discovery visits at
most 10,000 artifact-tree entries. Each trial and MCP server session must use a
unique event path that is absent when the server starts. The writer creates the
file exclusively and leaves any existing path untouched. The registered runner
must enforce that freshness precondition because the analyzer cannot infer the
origin time of an otherwise valid completed stream. The writer rejects
symlinked parent or final paths. Event
sequences must be contiguous from 1 so an advisory write failure cannot silently
undercount later events. Each event uses schema version 1 and may identify its
`eventKind` as `tool` (the default) or `resource-read`, plus an optional bounded
logical operation. A resource-read event must identify `read_mcp_resource`, the
exact content-addressed URI, detailed/detailed delivery, zero structured bytes,
and an unchanged-receipt value of false. Optional `outcome` is restricted to
`ok` or `error`. Optional nonzero `droppedBefore`
marks the whole server block partial; dropped values are never imputed. Graceful
shutdown appends a content-free `session-complete` record with the accepted event
count. The analyzer excludes that record from event and byte totals; a missing,
misordered, or count-mismatched completion record makes the block partial. It
emits aggregates only and never republishes event content or result references.

`efficiencyTelemetry` reports ATIF and server totals per arm together with
observed and unknown/partial run counts. Missing or malformed telemetry is not
imputed. These fields and the per-outcome telemetry are descriptive only: they
cannot change verifier rewards, ITT inclusion, protocol validity, arm success
rates, or comparison effects.

Requested-format accounting follows production routing: a direct outer
`responseFormat` wins when it is the only value, while dispatcher calls may put
the value in the inner `arguments` object. Conflicting outer and inner values
make trajectory transport evidence partial rather than guessing which value
the rejected call intended.

Each registered comparison also contains `pairedOverhead`, with
candidate-minus-baseline summaries for input/cache/output tokens, cost,
agent/controller elapsed time, and available ATIF/server call, byte, and time
fields. `allStarted` uses every started pair. `bothCompletedSuccessfully` is a
separately labelled selected view and can differ systematically from
all-started. Every metric reports paired-present and paired-missing counts,
mean and median deltas, and a candidate-to-baseline mean ratio only when the
paired baseline mean is positive. No missing value is imputed and none of these
descriptive summaries is a causal attribution.

Codexa indexes the treatment checkout inside the sandbox. It cannot borrow an
index from the host or another arm. Index duration and exit status are written
as telemetry under `/logs/artifacts/`; they do not affect correctness.

The checked-in schema-v1 MCP wrapper deliberately takes no command-line arguments. Harbor
0.18's Codex adapter flattens an MCP command and its arguments into one command
string, so the wrapper binds `/workspace/project` internally rather than
depending on separately preserved arguments. The treatment-startup smoke must
perform a real MCP `initialize` handshake followed by `tools/list`; process
startup alone does not prove that the treatment is usable. For schema v2, every
task environment must copy every registered suffix wrapper to its exact command
path with mode `0755`. Each wrapper binds `/workspace/project`, uses the
isolated Codexa runtime, and execs its exact `codexa serve` flags. Before any
attempt journal or timed Harbor assignment, the controller builds the immutable
task snapshot and runs the harness-owned bounded
`mcp-initialize-tools-list-smoke.mjs` client through every wrapper still needed
by a pending assignment. Validation requires the canonical isolated runtime
install to consume `${CODEXA_VERSION}`. The smoke client requires a successful
`initialize` response whose `serverInfo` is exactly `codexa` at the registered
candidate version, followed by a non-empty `tools/list`, with container
networking disabled. Each successful receipt binds the task hash, command,
smoke-helper hash, expected server identity, and observed server identity
outside attempt journals and is reused on resume; any identity change forces a
new preflight. Validation rejects a command suffix that any task image does not
provision. Keeping the preflight outside the measured wrapper avoids charging
a second server startup to Codexa arms. At analysis time, every receipt needed
by a started Codexa task/command pair is read again as a bounded regular file.
The JSON and Markdown reports surface the proof status plus expected and
observed server identities; a missing, malformed, identity-mismatched, or
post-attempt receipt invalidates the protocol and suppresses all effect
estimates. The controller refuses to create or accept a receipt completed after
the first bound attempt journal starts.

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

Validate from an artifact-clean task tree. Validation rejects symlinks,
oversized input, and transient artifacts such as bytecode and tool caches
before the task hash is computed. Separately, make a real authenticated no-op
request through the exact selected agent adapter and model. Installation-only
checks do not prove that credentials reach the model, and registration
deliberately does not inspect or serialize provider secrets.

Register the exact task hashes, schema-v1 treatment or schema-v2 per-arm input
hashes, comparisons, framework, agent, model, agent-runner version and
arguments, seed, repetitions, and within-task execution order:

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
continue only when the experiment, task, registered arm inputs, agent, and model
hashes still match. A started assignment without final metadata remains an ITT
failure and is never rerun.

For schema v2, exercise the exact registered candidate images and wrappers
without invoking Harbor or a provider:

```bash
node scripts/agent-ab.mjs preflight \
  --config benchmarks/agent-ab-selective-v2/experiment.json \
  --output .codex/cache/codexa-agent-ab/selective-v2-conformance \
  --agent codex \
  --model PROVIDER/MODEL
```

`preflight` requires an existing immutable schema-v2 registration and exact
matching agent and model labels. It builds each required task image with the
registered candidate pin and runs the harness-owned bounded `initialize` plus
`tools/list` identity handshake through every registered Codexa wrapper. It
writes reusable identity receipts only: it does not create attempt journals,
spawn assignments, invoke `uvx` or Harbor, start the agent runner, or contact a
model provider. Schema v1 is rejected.

Those hashes bind source inputs; they do not make a container build
bit-for-bit reproducible. Exact replay also requires recording the built-image
digest and the resolved operating-system and package dependency lock used by
that run. Without those artifacts, compare paired arms within a run and label
cross-run reproduction accordingly.

The checked-in `benchmarks/agent-ab` configuration is frozen to the archived
Codexa 0.10.0 pilot. The public `benchmarks/agent-ab-selective-v2` fixture
validates current schema-v2 conformance only. A later candidate or evidence
study needs a new experiment ID plus matching version pins in the experiment
config and every task Dockerfile; do not relabel or overwrite either input.

Before any paid run, audit the immutable registration, including task hashes,
route classes, comparisons, exact registered run count, and positional
balance. For a calibration, require 12–20 diverse evaluator-owned tasks and at
least two repetitions per arm. Also complete the authenticated no-op provider
check with scoped, disposable, spend-limited credentials and obtain explicit
approval for the disclosed spend-bearing assignment count. `validate`,
`register`, and schema-v2 `preflight` are not substitutes for that approval.

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
`run` is the spend-bearing boundary: do not invoke it for the public conformance
pack or before the explicit approval above.

## Analysis

The schema-v1 summary reports:

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

Schema v2 reports the same arm metrics for every registered arm, independently
recomputes every registered baseline/candidate comparison, identifies the
primary comparison, publishes positional balance, and adds per-arm descriptive
efficiency and selective-route-conformance telemetry. It does not use telemetry
to adjust or select effects.

No effect is emitted while the experiment is incomplete. Final metadata is
accepted only when its assignment fields and expected job path match the
registration, and the Harbor aggregate, trial identity, and recorded task path
match the exact registered immutable task snapshot. This prevents a sibling
job or same-named task result from being attributed to the wrong arm.

The trial's recorded agent, model, exact runner kwargs, MCP servers, and
extra-instruction paths must reproduce the registered arm. A control arm must
record empty MCP and instruction lists; every Codexa arm must record exactly
its zero-argument Codexa stdio wrapper and registered input-snapshot workflow
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
[`reports/benchmarks/v0.10.0-agent-ab-pilot-v7.json`](../../reports/benchmarks/v0.10.0-agent-ab-pilot-v7.json).
It completed all four registered assignments with a valid protocol. Both arms
passed 2/2, giving a descriptive absolute risk difference of zero and two
both-pass pairs:

| Mean per run | Control | Treatment | Treatment / control |
| --- | ---: | ---: | ---: |
| Verified completion | 2/2 | 2/2 | no difference |
| Input tokens | 104,448 | 620,053 | 5.94x |
| Cached input tokens | 86,272 | 552,064 | 6.40x |
| Output tokens | 3,212 | 6,680.5 | 2.08x |
| Reported cost | $0.230376 | $0.816392 | 3.54x |
| Agent elapsed time | 87.849s | 164.996s | 1.88x |
| Controller elapsed time | 128.603s | 205.863s | 1.60x |
| Verifier-counted changed files | 2 | 2 | 1.00x |
| Verifier-counted changed lines | 62 | 67 | 1.08x |

Agent-reported treatment setup succeeded in both runs. Structured trajectories
recorded 13 Codexa calls: 2 each to `session_context`, `task_brief`,
`change_plan`, `test_plan`, and `proof_card`, plus 3 to `post_edit_review`;
controls recorded no Codexa invocation. Mean agent-reported indexing time was
650.5 ms.

A manual observation recorded during v7 analysis found that both treatment
runs received a blocking `post_edit_review` inspection warning for changed
symbols even though the actual edited files exactly matched the saved file
plan. One run called the review twice after its first call omitted two explicit
invariant reviews; the symbol warning remained after the evidence was supplied.
The underlying trajectories are not published, so this observation is not
independently reproducible. It is not output from the new decision telemetry,
evidence that the review prevented an error, or a causal mechanism. The
archived v7 JSON remains byte-identical and is not retroactively reanalyzed or
backfilled.

The pilot therefore demonstrates neither a completion benefit nor net agent
value on this easy task and shows a large efficiency penalty. It is one
non-confirmatory task with two pairs and no task-clustered interval, so it
cannot establish how Codexa performs on diverse or difficult work, or that it
never helps.

The task and verifier now share an explicit Unicode General Category `Cc`
contract. The verifier covers embedded plus leading/trailing C0, DEL, and C1
controls, including generated edge cases, and pack validation rejects transient
artifacts before task hashing.

Only v7 is published evidence. Three intermediate diagnostics are excluded:
v4 was stopped after provider authentication returned 401 before any useful
observation, which exposed the missing explicit preflight; v5 exposed a
post-run oracle gap; and v6 had a locally contaminated task hash and was
interrupted before a usable observation. None is counted in the archived
outcome.
