# Our context server must beat grep — or fail CI

Every AI-coding context tool claims it beats grep. Codexa makes the claim
falsifiable: the eval harness runs in CI on every push, compares Codexa's
packets against real `rg` and `git status` baselines, and **fails the build
if the raw baseline does the job better on any scenario**. Not a launch-day
benchmark — a permanent gate.

## Why a gate instead of a benchmark

A benchmark is a number you publish once, measured under conditions you
chose. A gate is a constraint every future commit must satisfy. The
difference matters for a context server because the failure mode of the
category is silent regression: ranking tweaks, new lanes, and compaction
changes can each quietly make packets worse than the grep they were supposed
to replace, while the README number stays frozen at launch.

So the rule in [`scripts/eval-ci.sh`](../../scripts/eval-ci.sh) is simple: a
scenario fails outright if baseline file recall, test recall, or precision
beats Codexa, if output exceeds its byte budget, or if a packet leans on
heuristic-only evidence. Any failure fails CI.

## How the harness resists being gamed

Self-graded evals deserve suspicion, so the design assumes the author (or a
model) will try to cheat:

- **Seeded nonce repositories.** The synthetic suite generates fixture repos
  whose identifiers come from a seeded RNG — function names like
  `normalizeCuhacikh` that exist nowhere in any training set. In CI the seed
  is derived from the commit SHA, so every push gets holdouts nobody could
  have overfitted, including us.
- **Real baselines, really executed.** The "without Codexa" column runs
  actual `rg` and `git` via `execFileSync` with an argument allowlist —
  not a simulation of what grep might return.
- **Structured scoring.** Scenarios score `QueryResult.data`, not prose, so
  packet wording cannot flatter the metrics.
- **Refresh accounting.** A query that silently rebuilds the index during
  scoring fails the scenario unless explicitly permitted.

## The current numbers

The archived v0.3.0 run (seed `codexa-v030-eval`, full suite, 20 scenarios:
2 project, 12 synthetic anti-cheat, 6 historical fixture) — raw report in
[`reports/benchmarks/v0.3.0-eval.json`](../../reports/benchmarks/v0.3.0-eval.json):

| Metric | Result |
| --- | --- |
| Scenarios passed | 20/20 |
| File recall (mean) | 1.00 |
| Precision@k (mean) | 1.00 |
| Test recall (mean) | 1.00 |
| Scenarios where raw `rg`/`git` beat Codexa | 0 |
| Packet size vs. raw baseline output (mean) | 0.66x |

## The warts, on purpose

The same archived run records its own imperfections, because a harness that
can only produce perfect numbers is measuring nothing:

- 2 false-positive impact files surfaced by one synthetic scenario;
- 1 broad-retrieval failure (`synthetic-session-context-seedless`), where a
  seedless orientation query produced fallback-only context;
- a perfect 1.00 on recall/precision says the scenarios are currently at
  ceiling — they bound regressions, they do not differentiate rankings. When
  we A/B-tested an experimental transitive-PageRank ranking against the
  current one-hop centrality, the suite scored them identically, so the
  experiment stays gated off until a scenario can tell them apart.

And the scope limits: 20 scenarios is small; baselines are raw `rg`/`git`,
not other context servers; the project suite scores the live working tree
(deterministic only on a clean checkout); only TypeScript/JavaScript and
Python are deep lanes.

## Run it yourself

```bash
git clone https://github.com/mirnoorata/codexa && cd codexa
npm ci && npm run build
node dist/cli.js index .
node dist/cli.js eval . --suite all --seed any-seed-you-like --json
```

Pick your own seed — that's the point.
