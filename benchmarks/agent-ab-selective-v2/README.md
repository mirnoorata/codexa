# Selective-workflow schema-v2 conformance pack

This public pack exercises the schema-v2 four-arm contract for Codexa 0.17.0
and Codex runner 0.145.0. It contains one exact-target task, one repetition,
and four assignments. It is deliberately the smallest honest conformance
fixture, not a calibration, confirmatory experiment, or product-effect study.

The task is registered as `source-only`: the current selective workflow should
use ordinary source tools and make zero Codexa calls. The legacy arms retain
their fixed lifecycle instructions so the pack also makes that deliberate
policy difference visible. Route conformance is descriptive telemetry and never
changes verifier rewards or intention-to-treat inclusion; only the
`adaptive-auto-bounded` arm treats a mismatch as policy nonadherence.

The public task and verifier are auditable repository fixtures. They cannot
stand in for evaluator-owned held-out tasks. A usefulness study needs a new
experiment ID, an unpublished audited pack of 12–20 diverse tasks, at least two
repetitions per arm, an authenticated no-op provider check, immutable
registration, disclosure of the exact run count and positional balance, and
explicit spend approval.

Validate the public pack without a model or provider:

```bash
node scripts/agent-ab.mjs validate \
  --config benchmarks/agent-ab-selective-v2/experiment.json
```

Registration writes immutable inputs under ignored local state but does not
call a provider:

```bash
node scripts/agent-ab.mjs register \
  --config benchmarks/agent-ab-selective-v2/experiment.json \
  --output .codex/cache/codexa-agent-ab/selective-v2-conformance \
  --agent codex \
  --model PROVIDER/MODEL
```

After registration, the standalone schema-v2 preflight builds the task image
and performs `initialize` plus `tools/list` through every registered Codexa
wrapper. It does not invoke Harbor, the agent runner, or a model provider:

```bash
node scripts/agent-ab.mjs preflight \
  --config benchmarks/agent-ab-selective-v2/experiment.json \
  --output .codex/cache/codexa-agent-ab/selective-v2-conformance \
  --agent codex \
  --model PROVIDER/MODEL
```

Do not run this public conformance pack as evidence. Any `run` command is
spend-bearing and remains gated by the study requirements above.
