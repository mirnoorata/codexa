# Codexa no-capability-loss overhead reduction plan

Date: 2026-07-13
Status: implemented; repository verification and publication in progress
Owner: Codex backend worker `20260713-codexa-zero-loss-overhead`
Branch: `codex/backend/codexa-20260713-codexa-zero-loss-overhead`

## Decision

Reduce Codexa's agent-visible schema, response, and lifecycle overhead without
reducing its logical analysis capability or weakening any edit-safety decision.
Keep the computation and enforcement plane intact; optimize only the exposure,
delivery, and redundant-call plane.

"Zero loss" is an evaluation hypothesis, not an implementation claim. This
plan can establish capability reachability, decision equivalence, and bounded
transport mechanics; only a held-out agent study can establish non-inferior
task outcomes.

The historical v7 pilot remains valid for the exact full-profile, detailed,
fixed-lifecycle treatment that it ran. It is not an estimate of this optimized
design. The archived v7 report and schema-v1 interpretation remain unchanged.

## Evidence and problem statement

The checked-in v7 pilot observed, on one easy task with two paired repetitions:

- equal verified completion: 2/2 control and 2/2 treatment;
- 5.94x input tokens, 3.54x reported cost, and 1.88x agent time for treatment;
- 13 Codexa calls across two treatment runs;
- only 650.5 ms mean Codexa indexing time.

The treatment launched bare `codexa serve`, which defaults to the full tool
surface for backward compatibility, used detailed responses by default, and instructed the agent
through a largely unconditional lifecycle chain. The experiment bundled tool
exposure, workflow instruction, tool usage, response delivery, and model
behavior, and retained no per-call latency or payload ledger. The aggregate
penalty is real for that treatment; its component causes are not identified.

Current source also contains a correctness prerequisite for any transport
optimization: hard-budget compaction can discard `actionability`,
`inspectMode`, `completionAuthority`, task invariants, repeated-loop state, and
proof gaps. A smaller response is unacceptable if it can become more
permissive than the detailed result.

## Operating contract

### Goal

Make routine bounded Codexa use cheap enough to act as repository-local safety
and continuity infrastructure while retaining full analysis, drill-down, and
formal proof capability.

### Non-goals

- Do not make Codexa imitate or compensate for a particular model.
- Do not delete advanced tools or weaken their underlying query engines.
- Do not optimize index construction; it was below 1% of observed incremental
  agent time in the pilot.
- Do not infer per-call token or dollar causality from aggregate run totals.
- Do not add fixture-specific, domain-specific, screenplay-specific, or
  benchmark-answer-specific behavior.
- Do not run a paid external model comparison as part of implementation. The
  implementation must make the next comparison valid and attributable.

### Hard invariants

1. Checkout/root/HEAD identity and decision-relevant index staleness continue
   to fail closed. A stable dirty overlay remains valid lifecycle input and is
   compare-and-set checked under the task lock before persistence.
2. A compact or automatic response can never authorize more than the detailed
   response.
3. `completionAuthority`, `inspectMode`, task invariant status, replan state,
   repeated-loop state, and unresolved verification blockers are never silently
   omitted.
4. Every logical operation available in the full tool profile remains
   reachable through the optimized profile in the same MCP session.
5. The complete sanitized detailed packet remains retrievable through an
   immutable, state-bound, content-addressed reference.
6. Saved-plan, post-edit, required-check, verification-trust, and proof-ledger
   semantics remain unchanged.
7. Automatic response escalation is fail-closed: identity or evidence
   staleness, ambiguity, blocking inspection, replan, unresolved invariants, or
   integrity degradation cannot leave contradictory edit/completion authority.
   Advisory `verify` and `needs_target` states remain precise while their proof
   evidence may expand. Stable `dirty-files-changed` lifecycle input remains
   actionable.
8. Benchmark transport telemetry is descriptive only and cannot alter
   intention-to-treat inclusion, verifier authority, or completion scoring.
9. Schema-v1 experiments remain semantically readable through the compatibility
   path, while the archived v7 report retains its pinned byte identity.

### Trust boundaries

- Model/tool boundary: compact delivery must preserve decision semantics.
- Filesystem cache boundary: detailed-result artifacts must be bounded,
  content-addressed, atomically published, path-contained, and safe to read.
- MCP capability boundary: reduced schema exposure must not make advanced
  operations unreachable.
- Lifecycle boundary: only saved snapshots and persisted post-edit outcomes
  may change task stop state.
- Benchmark boundary: agent/ATIF/server telemetry is descriptive and
  untrusted; only the isolated verifier determines success.

### Rollback and containment

- Explicit `responseFormat: "detailed"` remains available.
- Explicit `--tools full` remains available.
- Automatic delivery can be reverted independently from lifecycle routing.
- Schema-v2 benchmark support is additive; schema-v1 remains the compatibility
  path.
- Any decision-kernel mismatch blocks default rollout and falls back to the
  detailed packet.

## Slice 1: decision-safe automatic delivery

### Mechanism

Add `responseFormat: "auto"` to every primary analysis tool whose evidence can
expand and make it the default. Keep explicit `concise` and `detailed` modes;
leave the already-bounded `freshness` result formatless.

Before any array or byte compaction, derive one small mode-aware decision
kernel from the original result. Merge that kernel after every hard-budget
tier so generic compaction cannot overwrite or discard it. If an authoritative
plan, review, or proof kernel cannot fit, return an explicit fail-closed
`detailsRequired` state instead of a verdict-only fallback. Advisory context,
test-selection, capability, and graph results may retain bounded counts and top
identities with the exact detailed packet behind the immutable resource; a
size event alone is not an authority failure.

Automatic mode returns the compact kernel for an ordinary high-confidence
result, including ordinary `inspect_first` read guidance. It revokes and/or
expands contradictory edit/completion authority for stale identity, ambiguous
target, degraded context, blocking inspection, replan, unresolved invariants,
integrity warnings, or other decision-relevant uncertainty. A non-authorizing
`verify` receipt stays `verify` even when exact proof evidence expands.

### Common decision receipt

The semantic kernel contains:

- exact query mode and original actionability;
- task/query identity;
- freshness and active-worktree identity;
- current verdict/packet verdict;
- required next action and bounded next-tool arguments;
- verification provenance;
- truncation tier and `detailsRequired` state.

The mandatory delivery envelope beside that kernel contains requested/effective
format, escalation reason, immutable result ID, and resource URI. Compaction
must preserve both parts of the receipt.

### Mode-specific kernel

- Search: raw-sufficiency state, exact-hit counts, top raw/file/symbol
  identities, diagnostics and gaps.
- Session/task context: packet verdict, next call/read identities, top focus
  files/tests, quality and blocking gaps.
- Change plan: complete edit readiness, saved or blocked snapshot identity,
  plan revision, planned targets/tests, invariant IDs/status, required-check
  counts and unresolved targets.
- Test plan: exact actionability, accepted/rejected targets, test and command
  identities, unresolved ledger items and gaps.
- Post-edit review: verdict, inspect mode/reasons, completion authority, task
  and plan revision, every invariant review status, loop/replan counters and
  reasons, failure classes, unresolved verification, outcome identity.
- Proof card: actionability, snapshot and lifecycle status, pending stops,
  decision-log integrity, proof gaps, evidence/trust state, non-passing
  artifacts and next commands.

Concise text is rendered from the same kernel for text-only hosts; arbitrary
first-N-line slicing is only a final size limiter.

### Detailed-result artifact

For automatic results that remain concise, and for explicit concise delivery,
persist the exact bounded detailed result under
`.codex/cache/codexa-mcp-results/`:

- hash the sanitized detailed payload to form an immutable ID;
- bind the record to tool and checkout/freshness identity; keep first-observed
  time as unhashed advisory retention metadata;
- publish atomically and reject symlink/path escapes;
- cap artifact bytes, retained artifact count, session leases, and in-memory
  route entries;
- pin every promised result ID in a durable live-session lease before emitting
  its URI; share those pins across concurrent MCP server processes so one
  process cannot prune another process's live promise;
- admit at most 256 unique pinned records and 256 session leases per repository;
  when a new pin or lease would exceed capacity, return the detailed packet
  inline before promising a URI;
- release leases on graceful shutdown and reclaim abandoned leases only after
  both a stale window and process-identity check;
- serialize pin/prune admission with an exact-owner lock whose cleanup is not
  age-only and claims the stale directory before rename, preventing a new live
  owner's lock from being removed by an old stale-lock decision;
- expose a server-session-scoped opaque
  `codexa://repo/mcp-results/{route}/{id}` MCP resource without encoding the
  checkout path in the URI;
- include the URI and digest in the mandatory delivery envelope and related
  resources.

An explicit detailed request and a resource fetch use the same canonical
bounded projection (512 KiB by default, or the same explicit structured-budget
override). Fetching the resource must reproduce the stored detailed packet
exactly, without re-running a query against potentially changed state.

### Duplicate delivery

Within one MCP server session, track exact detailed-result IDs already emitted.
When an automatic non-blocking call produces an identical result again, return
an `unchanged` receipt containing the decision kernel and result reference.
Do not suppress explicit detailed calls or blocking/ambiguous results.

### Product telemetry

Add optional content-free JSONL telemetry behind
`CODEXA_MCP_TELEMETRY_PATH`. Record only bounded mechanical facts:

- sequence, event kind, transport tool, logical operation, profile, and
  success/error outcome;
- requested/effective response format and escalation reason;
- request, text, structured, and total bytes;
- elapsed milliseconds;
- result reference, unchanged-receipt flag, and explicit partial/drop marker.

Telemetry file writes are queued and bounded off the response path; opt-in byte
accounting still serializes the bounded result synchronously. Queue loss, event
errors, and writer-cap markers make benchmark evidence partial rather than
silently reporting zero. Telemetry write failure is advisory and cannot change
tool output. Graceful shutdown writes a content-free `session-complete` record
after the queue drains. Analysis excludes it from event totals and treats an
absent or inconsistent completion record as partial evidence.

### Proof

- Table-driven 12 KB and 4 KB compaction tests for every primary mode.
- Detailed-versus-auto decision equivalence assertions.
- Envelope actionability cannot become more permissive after compaction.
- Text-only output contains completion authority, invariant/replan state, and
  proof gaps.
- Resource round-trip reproduces the full stored packet.
- Total envelope bytes, not only `data` bytes, are reported.

## Slice 2: compact exposure with full logical capability

### Mechanism

Keep every existing direct tool and explicit `--tools full`. Add one compact
primary `capabilities` tool that:

- returns the canonical advanced-operation manifest with cost/use/avoid hints;
- accepts an advanced operation plus a shallow plain-object arguments wrapper;
- immediately validates that wrapper through the exact operation-specific
  schema used by the direct tool, without a second recursive generic walk or a
  dispatcher-only size limit;
- invokes the same underlying handler and returns the same query result.

Any total transport limit must apply identically to direct and dispatched
calls. The dispatcher cannot reject an input that the same operation accepts
through its direct surface.

The optimized/core profile exposes the primary tools plus `capabilities`.
Advanced direct schemas no longer need to be present on every model turn, but
all advanced operations remain executable through the dispatcher. Full mode
keeps direct advanced tools for users who prefer them.

After this parity path exists, make fresh managed installs explicitly launch
`codexa serve --tools core`. Keep bare `codexa serve` full so legacy unmanaged
and pre-profile launchers retain every direct tool name after package upgrades.

### Proof

- The full direct manifest and dispatcher manifest have the same logical
  capability hash.
- Every advanced operation is present in the dispatcher manifest.
- Representative read, graph, workflow, memory, and risk operations return
  equivalent envelopes through direct and dispatched paths.
- Invalid dispatched arguments fail through the same schema contract.
- Core tools/list remains materially smaller than full.

## Slice 3: adaptive lifecycle and duplicate-review removal

### Normal path

```text
explicit bounded task:
change_plan(saveSnapshot) -> edit/run planned verification -> post_edit_review

ambiguous or degraded task:
session_context/search/task_brief -> change_plan -> edit/verify -> post_edit_review

formal policy, audit, release, or artifact handoff:
... -> proof_card
```

`change_plan` already builds focus/context and planned verification. It becomes
the direct pre-edit call for explicit targets. Separate `test_plan` remains an
on-demand drill-down when plan/review verification guidance is insufficient.
`proof_card` remains required when configured policy, decision-log integrity,
or a formal handoff is in scope.

### Source changes

- Remove redundant internal `focusBriefQuery` from `change_plan`; use the
  context packet and `session.index.workflows` for workflow evidence.
- Remove unconditional `test_plan` routing from edit-ready plans and
  post-edit reviews; preserve exact tests/commands in their existing packets.
- Update tool descriptions, server instructions, generated contracts,
  managed agent docs, plugin guidance, and public docs to one adaptive policy.
- In the post-edit hook, use one persisted review when AutoVerify is off. Keep
  the two-pass preview/enriched path when full-access AutoVerify can add trusted
  runner evidence. Preserve locking, dirty-signature deduplication, and exactly
  one persisted lifecycle outcome.

### Proof

- Explicit edit-ready plans still contain context, tests, commands, workflow
  and dependency checks, snapshot and invariant state.
- Explicit plans recommend eventual post-edit review, not redundant
  orientation or test-plan calls.
- Ambiguous, stale, degraded, workflow, API, rename, delete, and public-contract
  tasks still escalate.
- Read-only hook path runs one review; full-access path runs preview plus one
  enriched review; both persist exactly one outcome.
- Formal proof-card behavior and policy/decision-log validation remain intact.

## Slice 4: attributable agent evaluation

### Compatibility

Keep schema-v1 experiments readable with their existing meaning through an
explicit compatibility path. Controller/analyzer metadata and stricter input
validation may evolve; only the archived v7 report is required to retain its
pinned byte identity.

### Schema-v2 stepped ablation

Support registered arbitrary arms and explicit comparisons. The recommended
four arms use the same candidate binary:

1. `control`: no Codexa.
2. `full-detailed-legacy`: full schemas, explicit detailed delivery, legacy
   fixed lifecycle.
3. `adaptive-auto-legacy`: compact full-capability exposure and automatic
   delivery, legacy lifecycle.
4. `adaptive-auto-bounded`: compact full-capability exposure, automatic
   delivery, adaptive lifecycle.

Preregister comparisons:

- optimized net value: arm 4 versus arm 1;
- total optimization: arm 4 versus arm 2;
- transport/exposure effect: arm 3 versus arm 2;
- cadence effect: arm 4 versus arm 3.

Each task/repetition block contains every arm exactly once. Use a seed-derived
base permutation and cyclic rotation across repetitions, and report positional
balance rather than claiming full counterbalancing when repetitions are
insufficient.

Registration snapshots and hashes each arm's MCP config and instruction.
Control arms must have neither; Codexa arms must have exactly one of each.
Trial validation compares the actual received MCP/instruction paths with that
arm's immutable registration.

### Transport attribution

From uniquely correlated ATIF calls/results, report UTF-8 byte totals for:

- request arguments;
- model-visible result text;
- requested/effective formats;
- explicit detailed requests, actual detailed-resource fetches, automatic
  escalations, and unchanged receipts.

Duplicate IDs, copied context, unsupported continuation/subagent lineage,
malformed shapes, or scan limits make telemetry partial/unknown. Never turn
payload bytes into attributed tokens or dollars.

Optionally ingest exactly one bounded, non-symlink server JSONL telemetry
artifact for per-tool elapsed time and structured/total bytes. Missing or
malformed telemetry stays descriptive unknown and never invalidates the run.

### Proof

- Schema-v1 registration, assignment, validation, and analysis remain
  semantically compatible; the archived report SHA remains unchanged.
- Schema-v2 rejects duplicate/unknown arms, invalid comparisons, and arm-input
  mismatches.
- Every block contains every registered arm once.
- Synthetic four-arm results recompute all comparisons independently.
- UTF-8 payload totals and partial/unknown lineage rules are exact.
- Telemetry never changes verifier results, ITT inclusion, or protocol status.

## Implementation order

1. Add characterization tests for decision semantics and capability parity.
2. Implement detailed-result artifacts and the decision kernel.
3. Add automatic delivery, text rendering, unchanged receipts, and telemetry.
4. Add the compact capabilities dispatcher and make fresh managed installs
   launch core explicitly while preserving bare-serve compatibility.
5. Implement adaptive lifecycle routing and hook coalescing.
6. Add schema-v2 stepped-ablation registration, analysis, and transport
   telemetry while preserving v1.
7. Update public/managed/plugin documentation from the production contracts.
8. Run focused tests after each slice, then the full repository gates.
9. Run Codexa post-edit review, adversarially inspect the integrated diff, and
   fix all confirmed findings.

## Verification matrix

Focused checks:

- MCP compaction, envelopes, resources, profiles, init, and tool routing;
- change-plan/post-edit workflow and required-check tests;
- CLI hook read-only/full-access/duplicate-signature suites;
- schema-v1 and schema-v2 agent A/B runner, validity, analysis, and report
  suites;
- typecheck and build.

Repository gates:

- `npm run check`;
- synthetic and historical Codexa evals;
- `npm run benchmark:ci` with hot-path regression review;
- commit, then `npm run security:check` on the clean tree;
- reindex the worktree and verify fresh status with zero parser errors;
- Codexa post-edit review and proof card against task
  `codexa-zero-loss-overhead`.

No external paid agent run is required to prove implementation correctness.
The next real comparison must use the new preregistered schema-v2 design and
must report uncertainty across diverse tasks before making a product-value
claim.

## Pre-publication implementation evidence

The reproducible decoded-application-payload simulation used a clean indexed
detached checkout at commit `68061b0`, the task `Assess MCP transport overhead
for an explicit target`, file `src/mcp.ts`, disabled session-memory recording,
and five calls per arm. From the feature worktree, the exact portable command
was:

```bash
SOURCE_REPO="$(git rev-parse --show-toplevel)"
TARGET_ROOT="$(mktemp -d)"
trap 'rm -rf "$TARGET_ROOT"' EXIT
npm run build
git clone --quiet --no-checkout --shared "$SOURCE_REPO" "$TARGET_ROOT/repo"
git -C "$TARGET_ROOT/repo" checkout --quiet --detach \
  68061b022cfc9f4dcc1aaf3d7776710196cc69b0
node ./dist/cli.js index "$TARGET_ROOT/repo"
node scripts/benchmark-mcp-transport.mjs \
  --release-baseline v0.12.0 \
  --repo "$TARGET_ROOT/repo" \
  --candidate-cli ./dist/cli.js \
  --candidate-tools core \
  --task "Assess MCP transport overhead for an explicit target" \
  --file src/mcp.ts \
  --calls 5
```

The release-baseline mode materializes commit
`68061b022cfc9f4dcc1aaf3d7776710196cc69b0` for the pinned v0.12.0 baseline
from the local Git object database and verifies the pinned lockfile's exact
SHA-256. It always runs `npm ci` in the disposable pinned checkout with
lifecycle scripts disabled and cache-preferred resolution; this may access the
npm registry when the cache is incomplete. It never reuses the current
checkout's unverified installed dependency tree. The report records the
dependency materialization path. It identifies the result as locally built
tagged source, not as npm-tarball identity, and asserts the commit, CLI version, MCP
initialize identity, CLI digest, and full `dist`-tree digest before measuring.
The real pinned compatibility test is explicitly opt-in with
`CODEXA_RUN_V012_TRANSPORT_COMPAT=1`; routine tests keep only the offline
same-build exposure contract and never depend on repository history.

The observation compared the canonical v0.12.0 bare full/default server (CLI SHA-256
`ea90fb40a0cf2b9825707f511ba8013644e8a0492349f58741f7ded47f110e0d`)
with this branch's explicit core/automatic server:

- direct tool schemas: 21 to 10;
- advertised logical operation names: 21 versus 21, with exact name-set parity
  for that historical candidate (the separate direct-versus-dispatched suite
  establishes execution parity); current cross-release checks require every
  baseline operation to remain advertised while permitting candidate additions;
- decoded `tools/list` application payload: 59,376 to 29,554 UTF-8 bytes, a
  50.2% reduction;
- decoded freshness setup payload: 3,300 bytes per arm;
- decoded capability-discovery payload: zero for full exposure and 12,927
  bytes for the explicit core capability-manifest probe;
- combined decoded advertisement plus capability-discovery payload: 59,376 to
  42,481 bytes, a 28.5% reduction;
- first decoded task-result application payload: 55,419 to 16,387 bytes, a
  70.4% reduction;
- median repeated decoded task-result application payload: 55,419 to 6,372
  bytes, an 88.5% reduction;
- all four later candidate calls returned unchanged receipts;
- the candidate's 53,884-byte canonical detailed packet remained readable
  through its immutable resource URI (58,595 bytes for the decoded resource
  response envelope).

These are JSON-serialized decoded MCP application-payload sizes, not JSON-RPC
or stdio wire bytes. Two fresh runs on clean candidate `ea30f6b` reproduced
every candidate count and both schema counts exactly; one baseline first-result
observation differed by one byte because the legacy packet contains runtime
metadata. Exact payload sizes remain candidate- and run-bound. The checked-in
command fails closed on target cleanliness, exact indexed root/HEAD, parser
errors, MCP error results, pinned server identity, per-call receipt ordering,
and strict advertisement-plus-discovery reduction (with no brittle percentage
threshold). Task-result reductions remain observations because tiny tasks can
be dominated by fixed decision-safety metadata. It emits complete executable
identity, target HEAD, setup/discovery/task/resource payload bytes, advertised
name parity, and a machine-readable claim boundary.

This is a transport and lifecycle-mechanics result, not an agent-quality or
model-performance result. The no-Codexa arm has zero MCP transport bytes, so
only a preregistered held-out agent comparison can determine whether Codexa's
added bytes buy enough task value and whether optimized use is non-inferior.

Repository verification before publication: `npm run check` passed 63 files,
598 tests, one explicit opt-in skip, and 113 integration-hook smokes; the one
real-release compatibility test was explicitly skipped in the routine gate and
passed separately under `CODEXA_RUN_V012_TRANSPORT_COMPAT=1` (2/2 focused tests
passed).
`npm run benchmark:ci` passed all hot-path thresholds. On the exact clean PR
candidate, `npm run eval:ci` passed 21 scenarios with score 1 and
`rawRgBetter=0` using seed `ci-local-ea30f6b74101da7d7c42585d248949db56ed2909`;
`npm run security:check` also passed the complete check, zero-vulnerability
audit, clean public snapshot, package/plugin hygiene, and 25-check
installed-package smoke on `ea30f6b`.

### PR hardening evidence

Independent push and pull-request CI runs exposed a same-process retention-lock
race that local runs had not reproduced. Callers had shared one arrival-time
500 ms filesystem deadline, so a productive burst could time out under runner
load. The corrected design uses a bounded 256-participant per-checkout FIFO,
keeps the 500 ms budget only for foreign-process contention, and uses a separate
two-second no-progress budget for the active local holder. A 64-call burst and
a deliberately slowed 650 ms production write both retain resource delivery;
failed foreign acquisition rejects the queued batch once and the same router
recovers cleanly.

Adversarial review also rejected automatic telemetry-path reuse: replacing or
appending a prior stream would either create a destructive file boundary or
make objective run attribution ambiguous. Telemetry therefore requires a
runner-enforced unique, absent path per server session, creates it exclusively,
and preserves any existing evidence. Documentation states explicitly that the
analyzer cannot infer a valid stream's origin time. Telemetry and result-store
opens are nonblocking, all repository-controlled reads use fixed byte bounds,
and FIFO substitution tests prove graceful bounded failure. The final focused
production-path suites passed 24/24, and the final adversarial re-review reported
no release-blocking findings and no domain-, fixture-, screenplay-, or
model-specific production behavior.

The first pinned-transport attempt after committing `ea30f6b` refused to pass
because the worktree index still identified the pre-commit HEAD. Reindexing
that same worktree made the exact root/HEAD identity fresh and the comparison
passed. This is direct fail-closed evidence for the checkout-identity guard,
not a transport-regression failure.

## Rollout acceptance gate

Do not call the optimized mode zero-loss until all of the following hold:

- zero compact-to-detailed decision upgrades on the semantic-equivalence suite;
- zero missed blocking, invariant, replan, required-check, or trust states;
- full detailed artifact round-trip succeeds;
- logical capability manifests match and all advanced operation categories are
  reachable through optimized mode;
- existing v1/historical tests remain green;
- held-out multi-task evaluation is non-inferior on verified completion and
  severe guardrail recall;
- efficiency reporting includes model tokens/cost/time, MCP call count,
  request/result bytes, server time, escalations, explicit detailed requests,
  and actual detailed-resource fetches.

## Explicit rejects

- Lowering byte limits without a mandatory decision kernel.
- Treating `verdict` alone as completion authority.
- Calling a reduced direct-tool allowlist zero-loss without a dispatcher.
- Removing `proof_card` globally.
- Caching write-bearing lifecycle queries before they execute.
- Partial graph mutation to save indexing time.
- Reinterpreting v7 as component attribution.
- Benchmark-specific code paths or hardcoded expected task values.
