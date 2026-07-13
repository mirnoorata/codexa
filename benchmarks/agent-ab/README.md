# Agent-level Codexa A/B pilot

This directory contains the frozen schema-v1 Harbor 0.18.0 experiment contract
and one generic plumbing task. It compares the same coding agent and model with
and without Codexa. The deterministic verifier, not Codexa, decides whether the
task was completed.

The checked-in pilot is deliberately too small for a product-effect claim. Use
held-out external task packs for real conclusions.

The hardened GPT-5.6 Sol plumbing run is archived in
[`reports/benchmarks/v0.10.0-agent-ab-pilot-v7.json`](../../reports/benchmarks/v0.10.0-agent-ab-pilot-v7.json).
Both arms passed both repetitions. On this one easy task, Codexa therefore
showed no completion benefit and substantially increased tokens, cost, and
elapsed time. This is a non-confirmatory two-pair observation, not a product
effect or causal-mechanism claim; see the full guide before interpreting it.

The task specifies Unicode General Category `Cc`; the separate verifier covers
embedded plus leading/trailing C0, DEL, and C1 controls, including generated
edge cases. Pack validation rejects transient task artifacts before hashing.

`experiment.json` intentionally remains frozen to that Codexa 0.10.0 pilot.
To evaluate another candidate, create a new experiment ID and update both
`candidate.codexaVersion` and the task Dockerfile's `CODEXA_VERSION` pin; never
reuse or overwrite the archived registration.

The runner and analyzer also support schema v2 for new, separately registered
stepped-ablation studies. Schema v2 accepts arbitrary immutable arms and
explicit comparisons. The recommended zero-loss-hypothesis candidate study has
four arms:

1. `control` (no Codexa);
2. `full-detailed-legacy` (full exposure, detailed delivery, legacy cadence);
3. `adaptive-auto-legacy` (compact full-capability exposure, automatic
   delivery, legacy cadence); and
4. `adaptive-auto-bounded` (compact full-capability exposure, automatic
   delivery, adaptive cadence).

Every task/repetition block runs every registered arm exactly once. A
seed-derived base permutation is cyclically rotated across repetitions, and the
registration reports the actual position counts instead of claiming complete
counterbalancing. Each Codexa arm must provide its own sandbox-local,
zero-argument MCP wrapper and instruction; the control arm must provide
neither. For every task image, validation requires an executable wrapper for
every registered command. Before writing any attempt journal or starting a
timed assignment, the controller builds each immutable task snapshot and uses
the canonical bounded smoke client to run a real `initialize` and `tools/list`
exchange through every exact wrapper command still needed by a pending
assignment. The Dockerfile must install the candidate package from its
`${CODEXA_VERSION}` argument, and the live `initialize` response must identify
`codexa` at that exact registered candidate version. Successful receipts bind
the task hash, command, helper hash, expected server identity, and observed
server identity outside measured attempts and are reused on resume; changed or
mismatched inputs cannot reuse them. The preflight is not repeated inside the
measured wrapper, so it cannot add a second server startup to a candidate arm.
The frozen v1 task is intentionally not modified to masquerade as a runnable
v2 pack. Schema-v2 analysis revalidates every receipt required by a started
Codexa task/command pair and publishes its expected and observed server
identity. A missing or tampered receipt makes the protocol invalid and
suppresses every effect estimate.

See [the full guide](../../docs/guides/agent-ab.md#schema-v2-stepped-ablation)
for the exact v2 shape, comparison semantics, telemetry limits, and study
requirements. Tests use synthetic/fake agents only; no new paid model
comparison is represented by this implementation.

New reports may add descriptive `post_edit_review` decision telemetry from
uniquely correlated structured trajectory results. Generate it only with a new
experiment ID and the matching current analyzer. The v7 JSON must not be
backfilled; its recorded manual trajectory observation is not independently
reproducible because the underlying trajectories are not published.

Schema-v2 reports can also include exact UTF-8 ATIF request/result text bytes
when one call and one same-step result correlate uniquely. An actual generic
`read_mcp_resource` call counts as a detailed-result fetch only for server
`codexa` and an exact content-addressed routed
`codexa://repo/mcp-results/rr_<repo-locator>/mr_<sha256>` URI. Its request and
result bytes are included in overall totals and reported
separately; merely receiving a resource link is not a fetch. Optional
content-free server telemetry is read from exactly one bounded,
non-symlinked `codexa-mcp-telemetry.jsonl` artifact. Set
`CODEXA_MCP_TELEMETRY_PATH=/logs/artifacts/codexa-mcp-telemetry.jsonl` (or
another path transferred by the task pack) only for a new registered run, with
the target absent before server start and no symlinked path components. A final
content-free `session-complete` record proves that the accepted prefix drained;
it is excluded from event totals, and its absence makes the block partial.
Missing, copied, continued, duplicated, malformed, or oversized evidence remains
unknown/partial and never changes verifier results, protocol validity, or ITT
inclusion. Registered comparisons additionally report paired descriptive
candidate-minus-baseline overhead for all-started pairs and a separately
labelled both-completed-success view. Missing pair members are never imputed,
and ratios are omitted when the paired baseline mean is not positive.

Validate the pack:

```bash
node scripts/agent-ab.mjs validate \
  --config benchmarks/agent-ab/experiment.json
```

Run validation on an artifact-clean task tree, then make a real authenticated
no-op call through the exact selected provider adapter and model. Do not infer
credential readiness from CLI installation or configuration alone.
Registration is not an authentication check, so complete this preflight before
spending tokens on the paired run.

Register a run before spending tokens on the paired trials:

```bash
node scripts/agent-ab.mjs register \
  --config benchmarks/agent-ab/experiment.json \
  --output .codex/cache/codexa-agent-ab/pilot \
  --agent codex \
  --model PROVIDER/MODEL
```

Execute the registered paired trials:

```bash
node scripts/agent-ab.mjs run \
  --config benchmarks/agent-ab/experiment.json \
  --output .codex/cache/codexa-agent-ab/pilot \
  --agent codex \
  --model PROVIDER/MODEL \
  --resume
```

`run` invokes the pinned Harbor version through `uvx`, disables Harbor
telemetry, and keeps outputs under ignored `.codex/cache/`. Docker, `uv`, and
the selected agent's provider credentials must already be available. The
controller never writes credential values into registration or summaries.
Use a scoped, disposable credential with only the required model access and a
bounded spend limit; never expose repository, publishing, cloud-administration,
or other broad credentials to an agent task, and revoke or rotate the credential
afterward.

Only v7 is published evidence. Earlier diagnostics were discarded: v4 was
stopped after provider authentication returned 401 before any useful
observation, exposing the need for the explicit preflight above; v5 exposed a
post-run oracle gap; and v6 used a locally contaminated task hash and was
interrupted before a usable observation. None contributes an outcome to the
archived result.

Registration hashes bind the source inputs but not the fully resolved container
build. Exact replay additionally requires the built-image digest and resolved
operating-system and package dependency lock from the original run.

Analyze again without rerunning agents:

```bash
node scripts/agent-ab.mjs analyze \
  --config benchmarks/agent-ab/experiment.json \
  --output .codex/cache/codexa-agent-ab/pilot
```

See [the full guide](../../docs/guides/agent-ab.md) for isolation, statistics,
held-out task requirements, and multi-agent extension rules.
