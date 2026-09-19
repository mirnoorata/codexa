# Public TypeSafe retrieval regressions

This pack checks whether optional reranking makes the correct file easier to
find. It does not measure whether an agent produces a correct patch.

`public-pack.json` pins three public repositories and 14 labeled queries. One
repository is for calibration; two are for evaluation. Labels name a tracked
file and source line. Repositories cannot appear in both groups under aliases.
`results-2026-09-19.json` records the measured stages without source, keys,
provider request IDs, or machine paths.

Clone each manifest repository into `/path/to/checkouts/<id>`, check out its
exact `commit`, and leave source clean. The harness verifies root, origin,
revision, tracked targets, line bounds, and clean source. It neither installs
nor runs those repositories. In a Codexa source checkout:

```bash
npm ci
npm run build
node scripts/compare-typesafe.mjs --pack benchmarks/typesafe-retrieval/public-pack.json --repos /path/to/checkouts --partition evaluation
```

The first command below calibrates separately; the second evaluates. Live runs
require `TYPESAFE_API_KEY` in the process environment and send public candidate
excerpts to TypeSafe. Outputs default to ignored local state.

```bash
node scripts/compare-typesafe.mjs --pack benchmarks/typesafe-retrieval/public-pack.json --repos /path/to/checkouts --partition calibration --live --output .codex/cache/calibration.json
node scripts/compare-typesafe.mjs --pack benchmarks/typesafe-retrieval/public-pack.json --repos /path/to/checkouts --partition evaluation --live --output .codex/cache/evaluation.json
```

Use an evaluator-owned manifest with the same schema for a genuinely unseen
set. Freeze it before tuning, partition by repository, and report every case.
This public pack is small, correlated within repositories, and visible during
development. It is useful regression evidence, not a competitive leaderboard.

## Observed evaluation results

Eleven evaluation cases: nine behavior questions and two exact-path controls.
All stages used the same candidates, disabled embeddings, at most eight
TypeSafe candidates, a 2,500 ms deadline, no retries, SDK 0.6.0, and
`jev-latest` resolving to `jev-1.13.0`.

| Stage | Correct first file | Target in candidates | Requests | Input/output tokens |
| --- | ---: | ---: | ---: | ---: |
| Local deterministic baseline | 2/11 | 8/11 | 0 | 0/0 |
| Original reranking policy | 2/11 | 8/11 | 9 | 77,670/1,116 |
| Relevant excerpts only | 2/11 | 8/11 | 9 | 61,583/1,116 |
| Excerpts + supported winner promotion | 5/11 | 8/11 | 9 | 61,583/1,116 |
| Immediate repeat of final policy | 5/11 | 8/11 | 0 | 0/0 |

Three behavior questions improved to first place; no answer ranks worsened in
this set. All two exact controls retained first place. The final policy reused
nine cached decisions, including valid abstentions. Service errors remain
retryable on a later query. Cache lifetime is five minutes within one process.

Excerpt input fell 20.7%. Final first-call median latency was 207.8 ms versus
4.5 ms locally; the repeat median was 7.4 ms. Shared-host sample timings exclude
index construction, CLI/MCP startup, and embedding retrieval. No price schedule
was captured, so dollar cost stays unknown. These observations justify keeping
TypeSafe optional, not enabling it indiscriminately.

The original acceptance rule let uncertain tail candidates veto a clear winner.
Calibration exposed that case. The revised heuristic requires a winner score
of at least 2/3, confidence of at least 0.6, and a 0.5 score lead for a promotion.
It promotes one candidate and preserves remaining order. Provider confidence
is concentration, not a calibrated probability of correctness. Query intent,
source anchors, edit authority, and candidate membership remain unchanged.

Three correct files never entered the candidate set. A reranker cannot recover
them. Improving candidate retrieval and measuring saved agent work are the next
useful experiments. Historical synthetic results are in
[the TypeSafe evaluation document](../../docs/TYPESAFE_EVALUATION.md).
