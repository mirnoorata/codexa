# Optional TypeSafe reranking evaluation

The first live comparison improved the top-ranked file on two of twelve
synthetic behavior queries. It added about 170 ms median latency. Keep TypeSafe
opt-in: these results support a limited pilot, not a general production accuracy
claim.

## Method

`scripts/compare-typesafe.mjs` fixes six implementation/reference pairs before
scoring. Each pair has two behavior queries and an exact-path control: 18 cases
total. It exercises the production `find-context` query with a prebuilt, fresh
index, semantic embeddings disabled, and otherwise identical options. The
baseline gets one local warmup; subsequent baseline/hosted order alternates.
Every pair asserts equal candidate sets and unchanged edit-readiness evidence.
Only synthetic source is sent to TypeSafe.

The run used Node 22.22.2, TypeSafe SDK 0.6.0, and `jev-latest`, which the
service resolved to `jev-1.13.0`. Reranking was limited to eight candidates,
2,500 ms total, and zero retries. The fixture SHA-256 was
`20ba45ce22d70ac04bd5ab80df6cec3e65a7b7c19c41d68e68f772a9063fa892`.

## Results

| Measure | Local baseline | TypeSafe enabled |
| --- | ---: | ---: |
| Behavior queries: correct first file | 10/12 (83.3%) | 12/12 (100%) |
| Behavior queries: mean reciprocal rank | 0.917 | 1.000 |
| Behavior queries: target in first eight | 12/12 | 12/12 |
| Behavior queries: median query latency | 0.35 ms | 170.47 ms |
| Behavior queries: observed p95 latency | 0.64 ms | 368.30 ms |
| Exact-path controls: correct first file | 6/6 | 6/6 |
| Hosted requests | 0 | 12 |
| Reported input/output tokens | 0 / 0 | 9,708 / 498 |

Both corrected cases asked about rejecting expired sessions. All 12 hosted
behavior requests returned usable scores; all six exact-path controls skipped
the service. No local result regressed in this fixture. Token counts come from
API usage responses; no dollar-cost estimate is inferred from them.

This is one small synthetic run on a shared development host, with the same six
behaviors expressed twice. The queries are correlated, and their labels were
written with the fixtures. The observed p95 is a sample statistic, not a service
latency guarantee. The measurement excludes indexing, CLI startup, MCP
transport, and semantic embeddings. It does not establish improvement on
unseen repositories, entire-codebase bug detection, or verification accuracy.

## Independent regression coverage

### First use and repeat reuse

A second live run on the unchanged fixture verified the process-local decision
cache. Each accepted query was immediately repeated through `find-context`.
The script counts actual fetch calls and asserts no additional request, identical
file order, and unchanged edit authority on repeats. All 12 behavior queries
returned accepted scores; all six exact controls skipped the service on both
calls. There were 12 API requests total, using 9,708 input and 498 output tokens.

| Behavior-query measure | Local | TypeSafe first call | TypeSafe repeat |
| --- | ---: | ---: | ---: |
| Correct first file | 10/12 | 12/12 | 12/12 |
| Median query latency | 0.34 ms | 175.42 ms | 0.81 ms |
| Observed p95 latency | 0.64 ms | 343.35 ms | 2.60 ms |
| Additional hosted calls | 0 | 12 | 0 |

This verifies reuse, not general production accuracy. It uses the same small,
correlated fixture as the initial run and the same provider settings. The cache
is limited to 128 accepted decisions and five minutes in a running process;
new CLI processes start empty. Candidate source is reread and hashed before
reuse, including content beyond the excerpt sent to TypeSafe. Snapshot, query,
candidate order, model, credential, and bound changes invalidate reuse. Failures,
uncertain responses, and unavailable source are not cached.

Codexa still assembles candidates before TypeSafe can assess them. Scoring now
starts before independent local summary assembly. An enabled semantic provider
can still add latency before scoring; these measurements disable that lane.

### Offline checks

Offline tests exercise the actual SDK response boundary and query consumers:
disabled mode, explicit environment override, absent credentials, HTTP errors
without retries, invalid scores, uncertainty, abort deadlines, exact queries,
stale session freshness, preserved candidates, and unchanged edit authority.
The repository also has regressions for the six reviewed defects: inert script
arguments, malformed TOML termination, redirected semantic caches, module
TypeScript discovery/resolution, double-dot-prefixed dirty files, and structured
literal-search filenames.

Semantic-cache tests demonstrate zero repeated provider input for unchanged
content, reuse across refreshed index snapshots, partial rebuilds, model
invalidation, and explicit `--force`. Changed-content generations remain on
disk; pruning them safely needs reader/build coordination and is deferred.
The proposed BM25 inverted index is also deferred pending equivalence and
quality measurements.

An independent local resolver comparison used the original source at
`c306c1d5b2a9858647eae488551a6f90cb328995` and the changed implementation.
Synthetic inputs contained unique imported test edges, ten duplicates, and an
existing inferred edge. Complete outputs were asserted equal. With one warmup
and five measured calls, median times were:

| Unique imported edges | Original array scan | Set-based deduplication |
| --- | ---: | ---: |
| 1,000 | 3.37 ms | 0.94 ms |
| 2,000 | 10.89 ms | 1.95 ms |
| 4,000 | 54.24 ms | 3.27 ms |

This isolates resolver work; it is not a whole-indexing speedup measurement.
