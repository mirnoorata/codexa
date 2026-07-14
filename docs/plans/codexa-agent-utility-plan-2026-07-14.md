# Codexa Agent Utility Plan

Status: proposed, evidence-gated
Date: 2026-07-14
Baseline: `main` at `5f57bd5` (`@mirnoorata/codexa` 0.14.0)

## Decision

Keep Codexa's two value contracts separate:

1. For developers and CI, Codexa is a deterministic change-evidence and
   verification layer. This lane can be useful without an agent.
2. For coding agents, Codexa is an optional risk and continuity layer. It is
   not a mandatory first call, a replacement for `rg`, or currently a proven
   net benefit.

The next agent release should optimize for *selective use*. An exact task that
raw search can solve should make zero Codexa calls. A normal bounded edit should
usually need at most `change_plan` and `post_edit_review`. Extra retrieval,
test-planning, or proof calls must be triggered by a concrete ambiguity, risk,
or formal handoff requirement.

Do not claim that Codexa is useful to agents until a current, held-out,
verifier-owned experiment shows completion non-inferiority and acceptable
overhead across diverse tasks. Component retrieval tests and transport-byte
reductions are necessary engineering gates, not agent-value evidence.

## Evidence Baseline

### What is proven

- The 0.14.0 repository gate passed 614 tests with one explicit skip, plus 26
  command-wrapper and 87 hook smokes.
- The installed-package smoke passed 31 checks.
- Three seeded retrieval evals passed all 63 scenario-runs. Across 51
  comparable cases, Codexa was better on at least one scored metric in 38,
  tied in 13, and lost to the raw baseline in none.
- Same-build MCP exposure reduced decoded `tools/list` payload by 56.4% and
  advertisement plus discovery payload by 47.2%. It did not reduce the measured
  task-result payload.
- MCP queries were fast after startup on the measured checkout: freshness p95
  was 190 ms, `repo_map` 33 ms, and explicit-file `task_brief` 53 ms. CLI
  process startup made equivalent one-shot calls materially slower.
- Committed-change review correctly credits verification commands through
  `--ran-command`; the misleading `--ran-test` help text found during this
  audit is fixed by the change that introduced this plan.

These results support local retrieval, review, and CI mechanics. They do not
measure whether a coding agent produces a better patch.

The exact commands, seeds, bounded measurements, and source-artifact digests
for this section are committed in
`reports/benchmarks/v0.14.0-usefulness-baseline.json`. The report omits local
paths, generated source samples, and private environment data.

### What is not proven

The only real agent outcome is the committed, non-confirmatory 0.10.0 pilot in
`reports/benchmarks/v0.10.0-agent-ab-pilot-v7.json`:

| Mean per run | Control | Codexa treatment | Ratio |
| --- | ---: | ---: | ---: |
| Verified completion | 2/2 | 2/2 | no difference |
| Input tokens | 104,448 | 620,053 | 5.94x |
| Cached input tokens | 86,272 | 552,064 | 6.40x |
| Output tokens | 3,212 | 6,680.5 | 2.08x |
| Cost | $0.230376 | $0.816392 | 3.54x |
| Agent elapsed | 87.849s | 164.996s | 1.88x |
| Controller elapsed | 128.603s | 205.863s | 1.60x |

The treatment made 13 Codexa calls across two easy runs and showed no
completion lift. The task count is one, so the result cannot generalize, but it
is strong evidence that unconditional lifecycle calls are too expensive.

The current synthetic eval also has a repeatable blind spot: the broad
`synthetic-session-context-seedless` case adds two false-positive files per
seed. On the real task "make the pinned transport benchmark runnable after
lock changes," task-only retrieval missed the benchmark script while a 4 ms
raw search found the exact package command, script, and test. Once the script
was named explicitly, Codexa returned the correct source and test. This means
targeted context can help, while vague automatic retrieval is not yet a
reliable default.

## Product Contract

### Non-agent workflows

Codexa should remain independently useful through:

- a deterministic `review --base ... --ran-command ...` receipt for local and
  CI changes;
- change impact, required checks, verification trust, and explicit gaps that
  do not require model judgment;
- machine-readable JSON/GitHub output with human-readable text;
- local, query-only operation with no model, API key, or source mutation;
- reproducible package, retrieval, transport, and release checks.

These workflows must not depend on agent-only instructions, hidden model state,
or a paid evaluation service.

### Agent workflows

Codexa should earn a call only when it supplies information or governance that
the agent does not already have cheaply:

| Task shape | Default route | Codexa budget |
| --- | --- | ---: |
| Exact file, symbol, command, or error string | raw file read/search first | 0 calls |
| Explicit bounded edit with nontrivial blast radius | `change_plan`, then `post_edit_review` | 2 calls |
| Ambiguous target after raw search | one targeted `task_brief`, then the bounded edit route | 3 calls |
| API, rename, delete, workflow, or dirty multi-file change | targeted dependency/workflow evidence plus plan/review | 3-4 calls |
| Formal policy, release, or handoff | bounded edit route plus `proof_card` | 3 calls |

`session_context`, `test_plan`, and `proof_card` are escalation tools, not
ritual steps. An agent must be able to ignore Codexa's recommendation and
continue with source reads when Codexa labels itself `raw-sufficient`,
orientation-only, stale, degraded, or less actionable than the raw result.

## Workstreams

### P0: Freeze a current value experiment

Create a new schema-v2 experiment for the current candidate. Do not edit or
relabel the archived 0.10.0 registration.

Use the four already-supported arms:

1. `control`: no Codexa;
2. `full-detailed-legacy`: legacy exposure and fixed cadence;
3. `adaptive-auto-legacy`: compact exposure with fixed cadence;
4. `adaptive-auto-bounded`: compact exposure with selective cadence.

The experiment must pin the agent, model, Codexa version, runner version,
container inputs, task hashes, arm instructions, MCP wrappers, seed, budgets,
and verifier. Every Codexa arm uses the same binary. This makes the registered
comparisons identify net value, transport/exposure effects, and lifecycle
cadence separately.

Before paid execution, validate the task pack and run an authenticated no-op
through the exact provider adapter. Provider credentials must be scoped,
disposable, spend-limited, and absent from all reports.

### P1: Complete the selective-routing delta

The adaptive plan/review loop, on-demand `test_plan` and `proof_card`, and
ambiguous-target escalation are already shipped in managed instructions. Do
not rewrite those contracts. Limit the next routing change to the missing
deltas:

- exact path, symbol, CLI flag, config key, stack frame, or quoted error:
  search/read raw source first;
- stop after a nonblocking review unless new source changes invalidate it.

Register the expected route class with each evaluator-owned task and derive the
actual call pattern from the agent trajectory. Server telemetry may add a
content-free reason for calls that reach Codexa; it cannot truthfully explain a
zero-call route. Do not add an LLM router, another MCP tool, a daemon, or a
second configuration language. The host instruction is the mechanism until
evidence shows that a server-side policy is necessary.

### P2: Fix target selection with real failure cases

Add retrieval regressions derived from actual work, including the transport
benchmark failure found in this audit. For a task mentioning a package command,
lock change, CLI flag, or exact error, lexical file/command/config evidence must
outrank weak graph proximity.

Acceptance for the transport regression:

- task-only output identifies `package.json`,
  `scripts/benchmark-mcp-transport.mjs`, and
  `tests/benchmark-mcp-transport.test.ts` in the read-first set;
- no unrelated graph/indexer test outranks all three exact targets;
- the packet labels uncertainty when no exact anchor exists;
- the raw baseline remains present in the eval and may win without failing the
  product contract when Codexa correctly reports `raw-sufficient`.

Prefer ranking and scenario fixes over adding a new retrieval lane. Keep tie
breaking deterministic and preserve evidence-class labels.

### P3: Remove lifecycle false positives

Use current review telemetry to find advice that makes agents reread, replan,
or rerun work without changing verifier outcomes. Prioritize:

- planned-file edits reported as unexplained symbol drift;
- a command passed as a test reference or a test passed as a command;
- repeated blocking review after the requested invariant/test evidence exists;
- recommendations for files that are not indexable or cannot affect the
  changed runtime path;
- duplicate review/hook results for the same dirty signature.

Every fix needs a production-path regression and an A/B-visible metric such as
fewer calls, fewer blocking-after-complete states, lower patch churn, or lower
elapsed time. Do not weaken a correct blocker merely to reduce friction.

### P4: Preserve the human and CI lane

Agent optimization must not make deterministic review harder to use directly.
For each agent-facing change, verify:

- CLI help still names the distinction between test references, commands,
  structured command reports, and waivers;
- JSON, GitHub, and text outputs agree on verdict, trust, coverage, and gaps;
- CI can run without an MCP host or agent;
- malformed or stale identity evidence fails closed where current identity is
  required;
- portable plans and reported verification remain explicitly advisory and are
  never promoted to authoritative or blocking evidence merely because they are
  present;
- package install and public-snapshot checks remain green.

## Evaluation Design

### Calibration

Use 12-20 diverse evaluator-owned tasks with at least two repetitions per arm,
as required by the existing agent A/B guide. Cover multiple repositories and
languages across these strata:

- exact lookup where raw search should be sufficient;
- small local behavioral bug;
- cross-file API change;
- rename/delete with caller risk;
- config, CI, or package-script failure;
- dirty-tree continuation;
- workflow/lifecycle change;
- verification trap where plausible public tests are insufficient.

Every task has a separate no-network verifier, generated or held-out edge
cases, scope checks, and a required nonzero regression-test count. Agent prose,
Codexa output, and agent-authored tests are untrusted telemetry.

Use calibration to remove dominated Codexa arms and estimate variance. It is
not a product claim. Paid execution requires an explicit spend approval after
the immutable registration reports the exact run count.

### Confirmatory run

Freeze a different held-out task set and compare only `control` with the
winning bounded Codexa arm. Determine the task count with a preregistered power
calculation using the task, not the repetition, as the generalization unit.
Interleave arms, use intention-to-treat analysis, and publish aggregate
outcomes, hashes, exclusions, and task-clustered uncertainty without exposing
private tasks or credentials.

Primary outcome:

- verifier-owned completed patch.

Secondary outcomes:

- severe regression and scope-failure rates;
- all-started input/cache/output tokens, cost, agent time, and controller time;
- Codexa calls, request/result bytes, detailed-resource fetches, and unchanged
  receipts;
- blocking review states that remained unresolved at agent termination;
- patch churn, duplicate searches, and repeated verification.

Completion-conditioned efficiency remains descriptive. A fast incorrect run
is not a win, and missing telemetry is never imputed as zero.

## Go/No-Go Gates

Codexa earns a default agent integration only when all applicable gates pass:

1. The lower bound of the preregistered 95% task-clustered interval for
   completion difference is above the -5 percentage-point non-inferiority
   margin.
2. Severe regression and scope-failure rates do not increase.
3. When completion is statistically indistinguishable, median token, cost, and
   agent-time ratios are each at most 1.10x control across all started runs.
4. Exact/raw-sufficient tasks have a median of zero Codexa calls.
5. Normal bounded edits have a median of at most two Codexa calls and no
   unconditional `session_context`, `test_plan`, or `proof_card` call.
6. At least 95% of uniquely correlated review calls end nonblocking when the
   call includes the task's required verification, the diff does not change
   afterward, and the verifier confirms the patch.
7. The current retrieval, package, privacy, security, and transport gates pass,
   and the committed benchmark commands are runnable from a fresh checkout.

If Codexa produces a credible completion or severe-failure improvement, the
confirmatory registration may predeclare a larger efficiency allowance and an
incremental cost-per-additional-success analysis. Do not choose that allowance
after seeing outcomes.

## Stop And Rollback Rules

- If calibration shows equal completion with more than 1.10x overhead, keep
  Codexa agent use opt-in and remove automatic lifecycle instructions from
  managed installs.
- If only high-risk task strata benefit, ship risk-triggered guidance for those
  strata and keep the zero-call route everywhere else.
- If retrieval loses to raw search on exact tasks, fix ranking or route those
  tasks to raw search; do not add more mandatory context calls.
- If no endpoint improves after the confirmatory study, describe Codexa as a
  developer/CI proof tool with optional agent integrations. That is a valid
  product outcome, not an evaluation failure.
- All routing changes live in versioned instructions and are reversible
  without changing indexes, stored facts, or source code in user repositories.

## Delivery Sequence

1. Land the benchmark and CLI defects fixed with this plan.
2. Add exact-task retrieval regressions and content-free route telemetry.
3. Create and validate a new immutable schema-v2 calibration pack for the
   current Codexa candidate.
4. Obtain explicit spend approval, run calibration, and publish aggregate
   results.
5. Fix only causal or repeated failure modes supported by calibration evidence.
6. Freeze, power, and run the held-out two-arm confirmatory study.
7. Change default agent guidance only if the go/no-go gates pass.

Each implementation PR must run focused tests, `npm run check`, retrieval eval,
package smoke, the relevant transport benchmark, Codexa post-edit review, and
an adversarial diff review. A release must also pass the repository security
gate on a clean commit. A user-facing CLI change is live only after the
next-version Release Please PR, tag, GitHub Release, and npm publication are
complete and a clean external install reproduces the behavior. Otherwise the
change must be reported as source-only.

## Explicit Rejects

- No built-in model, API requirement, vector database, or agent runtime.
- No source mutation or autonomous commit path through MCP.
- No universal "call Codexa first" instruction.
- No agent-value claim from retrieval scores, payload bytes, one repository,
  one task, or completion-conditioned metrics alone.
- No weakening of fail-closed review, evidence provenance, or verification
  trust to make the agent experience look cheaper.
- No paid confirmatory run before immutable registration and explicit spend
  approval.

## Success Definition

Codexa is worthwhile for non-agent workflows when developers and CI can obtain
deterministic impact and verification receipts without a model. It is
worthwhile for agents only when selective use improves verified outcomes or
reduces serious failures at an acceptable measured cost. The product should
opt out automatically when it cannot add that value.
