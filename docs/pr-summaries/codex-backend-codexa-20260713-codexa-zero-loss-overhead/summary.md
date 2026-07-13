# Change Summary

- Project: `codexa`
- Worktree: isolated session worktree
- Branch: `codex/backend/codexa-20260713-codexa-zero-loss-overhead`
- Base: `main`
- Primary implementation commit: `91c88cd`
- Verified candidate commit: `ea30f6b`
- Latest hardening commit: `fix(mcp): bound concurrent artifact persistence`
- Subject: `feat(mcp): reduce agent overhead without capability loss`

## Primary Implementation Commit Snapshot

91c88cd feat(mcp): reduce agent overhead without capability loss
 README.md                                          |  147 +-
 benchmarks/agent-ab/README.md                      |   71 +-
 .../support/mcp-initialize-tools-list-smoke.mjs    |  188 +++
 docs/architecture/codexa-context-server.md         |   75 +-
 docs/architecture/session-memory.md                |   13 +-
 docs/guides/agent-ab.md                            |  240 +++-
 docs/guides/new-user-tutorial.md                   |   17 +-
 .../codexa-zero-loss-overhead-plan-2026-07-13.md   |  554 ++++++++
 integrations/claude-code/README.md                 |   14 +-
 package.json                                       |    2 +
 plugins/codexa/skills/codexa/SKILL.md              |    8 +-
 scripts/agent-ab-analysis.mjs                      | 1408 +++++++++++++++++++-
 scripts/agent-ab.mjs                               |  761 +++++++++--
 scripts/benchmark-mcp-transport.mjs                |  495 +++++++
 scripts/verify-plugin-package.mjs                  |    4 +-
 src/artifacts.ts                                   |   11 +-
 src/cli.ts                                         |    4 +-
 src/cli/hooks.ts                                   |   46 +-
 src/codex-contract.ts                              |   21 +-
 src/freshness-authority.ts                         |   12 +
 src/init.ts                                        |   15 +-
 src/mcp.ts                                         |  488 ++++++-
 src/mcp/advanced-mode-kernel.ts                    |  497 +++++++
 src/mcp/capability-kernel.ts                       |  106 ++
 src/mcp/compaction.ts                              |  160 ++-
 src/mcp/decision-guidance.ts                       |   75 ++
 src/mcp/decision-kernel.ts                         |  954 +++++++++++++
 src/mcp/decision-policy.ts                         |  107 ++
 src/mcp/envelope.ts                                |   66 +-
 src/mcp/resources.ts                               |   90 +-
 src/mcp/result-artifacts.ts                        |  844 ++++++++++++
 src/mcp/telemetry.ts                               |  340 +++++
 src/mcp/tool-registry.ts                           |   44 +-
 src/mcp/tools.ts                                   |  304 ++++-
 src/query/change-plan.ts                           |  139 +-
 src/query/post-edit.ts                             |   99 +-
 src/query/post-edit/lifecycle.ts                   |    2 +
 src/query/post-edit/next-actions.ts                |    1 -
 src/query/runtime.ts                               |   61 +-
 src/session-memory/runtime.ts                      |   85 +-
 src/task-snapshots.ts                              |    4 +-
 tests/agent-ab-report.test.ts                      |    3 +-
 tests/agent-ab-v2-identity.test.ts                 |  167 +++
 tests/agent-ab-v2.test.ts                          | 1191 +++++++++++++++++
 tests/benchmark-mcp-transport.test.ts              |   93 ++
 ...jects-malformed-integer-options-instead.test.ts |   34 +-
 ...s-02-launches-windows-package-local-cmd.test.ts |    8 +-
 ...exer-06-keeps-planned-post-edit-reviews.test.ts |    6 +-
 tests/init.test.ts                                 |   28 +-
 tests/mcp-01-keeps-the-primary-mcp-happy.test.ts   |   47 +-
 tests/mcp-02-does-not-let-stale-codexa.test.ts     |  121 +-
 ...3-records-truncation-metadata-when-post.test.ts |    8 +-
 ...p-04-reports-package-version-and-codexa.test.ts |   76 +-
 tests/mcp-05-suite.test.ts                         |  190 ++-
 ...p-06-core-profile-envelopes-never-steer.test.ts |    7 +-
 tests/mcp-advanced-auto.test.ts                    |  233 ++++
 tests/mcp-capabilities.test.ts                     |  240 ++++
 tests/mcp-decision-equivalence.test.ts             |  417 ++++++
 tests/mcp-decision-kernel.test.ts                  |  409 ++++++
 tests/mcp-result-artifacts.test.ts                 |  362 +++++
 tests/mcp-telemetry.test.ts                        |  340 +++++
 ...records-bounded-entries-with-provenance.test.ts |   59 +
 tests/task-lifecycle.test.ts                       |  120 +-
 63 files changed, 12201 insertions(+), 530 deletions(-)
 create mode 100644 benchmarks/agent-ab/support/mcp-initialize-tools-list-smoke.mjs
 create mode 100644 docs/plans/codexa-zero-loss-overhead-plan-2026-07-13.md
 create mode 100644 scripts/benchmark-mcp-transport.mjs
 create mode 100644 src/freshness-authority.ts
 create mode 100644 src/mcp/advanced-mode-kernel.ts
 create mode 100644 src/mcp/capability-kernel.ts
 create mode 100644 src/mcp/decision-guidance.ts
 create mode 100644 src/mcp/decision-kernel.ts
 create mode 100644 src/mcp/decision-policy.ts
 create mode 100644 src/mcp/result-artifacts.ts
 create mode 100644 src/mcp/telemetry.ts
 create mode 100644 tests/agent-ab-v2-identity.test.ts
 create mode 100644 tests/agent-ab-v2.test.ts
 create mode 100644 tests/benchmark-mcp-transport.test.ts
 create mode 100644 tests/mcp-advanced-auto.test.ts
 create mode 100644 tests/mcp-capabilities.test.ts
 create mode 100644 tests/mcp-decision-equivalence.test.ts
 create mode 100644 tests/mcp-decision-kernel.test.ts
 create mode 100644 tests/mcp-result-artifacts.test.ts
 create mode 100644 tests/mcp-telemetry.test.ts

## Verification

- git diff --check: passed
- npm run check on `ea30f6b`: 63 files; 598 passed; 1 explicit opt-in skip; 113 hook smokes
- npm run benchmark:ci on `ea30f6b`: all hot-path thresholds passed
- npm run eval:ci on `ea30f6b`: 21 scenarios; score 1; rawRgBetter=0; seed `ci-local-ea30f6b74101da7d7c42585d248949db56ed2909`
- npm run security:check on `ea30f6b`: complete check, zero-vulnerability audit, clean public snapshot, package/plugin hygiene, and 25-check installed-package smoke passed
- opt-in pinned v0.12.0 compatibility test on `ea30f6b`: 2/2 passed using locally built tagged source with pinned commit, lockfile, CLI, and dist-tree identities
- fresh pinned v0.12.0 transport comparison on `ea30f6b`: 21 to 10 direct schemas; all 21 logical operations advertised; tools/list 59,376 to 29,554 decoded bytes (-50.2%); advertisement plus discovery 59,376 to 42,481 (-28.5%); first task result 55,419 to 16,387 (-70.4%); repeated median 55,419 to 6,372 (-88.5%); four unchanged receipts; 58,595-byte decoded detailed-resource response remained readable
- Codexa post-edit-review: authority complete; all seven invariants satisfied; no drift or unaccounted tests
- Codexa test-plan: passed; local artifact retained outside the repository
- git diff --cached --check: passed
- staged safety scan: passed

The transport comparison measures JSON-serialized decoded MCP application
payloads, not wire bytes, tokens, cost, task success, or agent quality. A
held-out agent comparison is still required to measure net usefulness and
non-inferiority against no Codexa.

## PR Hardening

PR CI exposed a same-process retention-lock deadline race. The follow-up uses
a bounded per-checkout FIFO so the 500 ms filesystem budget measures foreign
process contention, while a separate two-second no-progress budget bounds a
stalled local holder. Tests cover a 64-call burst, a 650 ms productive holder,
failed-batch recovery, and FIFO substitution without blocking.

Telemetry destinations now require a runner-enforced unique absent path per
server session, use exclusive nonblocking creation, and preserve prior
evidence. Bounded regular-file reads and nonblocking opens prevent special-file
substitution from hanging or causing unbounded reads. Independent adversarial
review found no release blocker, capability removal, or domain-specific
production behavior.

## Notes

Implements decision-safe compact delivery, all 21 logical operations reachable
through a 10-schema core surface, bounded lifecycle and artifact persistence,
generic loop controls, and schema-v2 agent evaluation. The transport result
does not establish zero capability loss or improved agent outcomes; those
claims require held-out agent evaluation. Includes a pinned v0.12.0 transport
reproducer with explicit claim boundaries.
