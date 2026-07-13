# Agent-level Codexa A/B pilot

This directory contains a Harbor 0.18.0 experiment contract and one generic
plumbing task. It compares the same coding agent and model with and without
Codexa. The deterministic verifier, not Codexa, decides whether the task was
completed.

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

Future reports may add descriptive `post_edit_review` decision telemetry from
uniquely correlated structured trajectory results. Generate it only with a new
experiment ID and the matching current analyzer. The v7 JSON must not be
backfilled; its recorded manual trajectory observation is not independently
reproducible because the underlying trajectories are not published.

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
