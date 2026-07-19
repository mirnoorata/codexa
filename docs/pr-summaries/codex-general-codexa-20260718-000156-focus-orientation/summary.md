# PR Summary: Reduce Agentic Codexa Overhead

- Project: `codexa`
- Branch: `codex/general/codexa-20260718-000156-focus-orientation`
- Base: `main`
- Source head before summary refresh: `81ef637f913e`
- Subject: `perf(mcp): reduce agentic Codexa overhead`

## Goal and Outcome

This change targets the archived agent A/B failure in which the Codexa-enabled
arm used 5.94x the control's input tokens while producing the same verified
completion result. The current candidate removes the mandatory lifecycle call
chain, defaults agent hosts to a three-tool MCP surface, and tells agents to use
zero Codexa calls for exact local tasks.

An authenticated one-pair regression smoke on the same checked-in task did not
reproduce the 5.94x failure:

| Actual model usage | Control | Current Codexa treatment | Ratio |
| --- | ---: | ---: | ---: |
| Input tokens | 108,683 | 127,190 | 1.17x |
| Cached input tokens | 76,032 | 109,568 | 1.44x |
| Output tokens | 3,065 | 3,551 | 1.16x |
| Codexa tool calls | 0 | 0 | no difference |

The treatment used the intended zero-call route, passed the public tests, and
passed all committed hidden behavior cases plus 40 generated cases. The single
control run passed its public tests but failed the leading/trailing C1 control
case. This is a non-confirmatory one-pair smoke, not a broad product-effect
estimate. It has no task-clustered interval or comparable provider-cost metric.

## What Changed

### Smaller default agent surface

- Agent launchers now default to the core MCP profile: `search`, `change_plan`,
  and `capabilities`.
- `capabilities` retains access to all 22 logical operations, while the full
  direct-tool profile remains an explicit opt-in.
- Server instructions and tool guidance make raw source reads terminal when an
  exact target is already known.

### Selective lifecycle cadence

- Exact file, symbol, command, config, and quoted-error work can use zero Codexa
  calls.
- A normal bounded change usually uses at most two calls; only an ambiguous,
  materially risky change without a managed completion gate uses the narrow
  three-call exception.
- Managed hooks coalesce duplicate work and retain an evidence-bearing final
  review only when the host can provide meaningful verification evidence.

### Bounded transport results

- Automatic and concise results stay inside a hard serialized-result budget.
- Detailed evidence can be fetched through content-addressed, repository-bound
  MCP resources instead of being repeated inline.
- Repeated equivalent calls return bounded unchanged receipts while preserving
  the same logical operation contract.

### Routing and lifecycle hardening

- Exact target authority, source dependencies, mutation intent, and directed
  task language are kept consistent across search, planning, and review.
- Snapshot governance preserves the last durable plan across interrupted
  replans without colliding with dotted task IDs.
- Rollback artifacts use an isolated internal namespace with symlink and
  containment checks, preventing writes outside the repository.
- The storage helpers were extracted to keep `task-snapshots.ts` below the
  repository's 1,000-line source-hygiene ceiling.

## Verification

| Gate | Result |
| --- | --- |
| `npm run check` | 72 test files; 900 passed; 1 intentional skip |
| Claude integration smokes | 28 command checks and 89 hook checks passed |
| Package hygiene | Generated npm and plugin contents passed |
| Installed-package smoke | 31 checks passed against the packed 0.15.0 tarball |
| Source hygiene | Passed; `task-snapshots.ts` is 994 lines |
| Adversarial review | Latest strict pass: `NO ACTIONABLE FINDINGS` |
| Bloat audit | No high-confidence removable production bloat found |

The final adversarial bar was limited to core regressions, security or write
authority, crash or data loss, and direct redundant-agent-call regressions.
Actionable findings were fixed in separate Conventional Commits; speculative
polish and refactor suggestions were not accepted.

## Transport Evidence

The deterministic benchmark measures decoded JSON application bytes, not model
tokens or provider cost. On the final clean candidate checkout:

| Same-build full vs. core | Full | Core | Reduction |
| --- | ---: | ---: | ---: |
| `tools/list` | 68,196 B | 8,745 B | 87.2% |
| Startup + advertisement + discovery | 88,032 B | 26,622 B | 69.8% |
| Advertised logical operations | 22 | 22 | no loss |

Against the pinned v0.12.0 source build, startup plus advertisement and
discovery fell from 60,409 B to 26,622 B (55.9%), the first task result fell
from 55,285 B to 13,852 B (74.9%), and the repeated-result median fell from
55,285 B to 6,117 B (88.9%).

The hot-path benchmark also passed every threshold. Representative p95 values
were 4,707 ms for indexing, 496 ms for status, 223 ms for MCP freshness, 30 ms
for MCP repository map, and 118 ms for an explicit-file MCP task brief.

## Limits and Rollback

- The actual-token result is one task and one pair. A registered, held-out,
  multi-task experiment is still required before claiming general agent value.
- Task-result payloads are not universally smaller in same-build comparisons;
  the largest deterministic win is exposure and repeated-result overhead.
- The full direct-tool profile remains available for hosts that explicitly need
  it.
- If the selective defaults cause a regression, revert this PR; no persistence
  migration or external service rollback is required.
