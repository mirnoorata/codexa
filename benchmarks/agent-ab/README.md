# Agent-level Codexa A/B pilot

This directory contains a Harbor 0.18.0 experiment contract and one generic
plumbing task. It compares the same coding agent and model with and without
Codexa. The deterministic verifier, not Codexa, decides whether the task was
completed.

The checked-in pilot is deliberately too small for a product-effect claim. Use
held-out external task packs for real conclusions.

The hardened GPT-5.6 Sol plumbing run is archived in
[`reports/benchmarks/v0.10.0-agent-ab-pilot-v3.json`](../../reports/benchmarks/v0.10.0-agent-ab-pilot-v3.json).
Both arms passed; the run descriptively observed higher treatment token use,
time, cost, and changed lines. That pass is against the registered oracle,
which checked ASCII C0 plus DEL but not Unicode C1 controls; see the full guide
before interpreting the result.

`experiment.json` intentionally remains frozen to that Codexa 0.10.0 pilot.
To evaluate another candidate, create a new experiment ID and update both
`candidate.codexaVersion` and the task Dockerfile's `CODEXA_VERSION` pin; never
reuse or overwrite the archived registration.

Validate the pack:

```bash
node scripts/agent-ab.mjs validate \
  --config benchmarks/agent-ab/experiment.json
```

Register a run before spending model tokens:

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
