# Codexa Project Startup Optimization

PR summary for
`codex/general/codexa-20260722-210037-focus-orientation` against `main`.
The final source-evidence head used for the measurements below is
`96e144b164326964cbebc92460ab4d8bef0c7b14`.

## Outcome

Codexa startup is now designed around truthful readiness and progressive
retrieval, not token reduction by itself:

- The desktop saved-project flow selects `Worktree`, the intended branch, and
  the Codexa local environment before the first prompt, then adopts the
  app-created linked worktree.
- One serialized Node bootstrap owns dependency installation, build, worktree
  wiring, indexing, and receipt publication for Bash and PowerShell launchers.
  Every stage has a deadline, termination grace, forced-stop fallback, and a
  shared 8 MiB log ceiling. Terminal settlement also closes inherited pipes
  when an escaped descendant prevents the direct child’s `close` event,
  including ordinary commands that do not request process-tree termination.
- Setup proof is an immutable Git blob published through the per-worktree
  `refs/worktree/codexa/bootstrap-receipt` ref. SessionStart validates a cheap
  durable subset; adoption and completion use progressively stronger scopes.
  Startup inputs have a closing snapshot revalidation. The public adoption
  wall begins before requirement and Git-ref reads, shares at most 20 seconds
  across all phases, and reserves command-settlement time inside the shared
  controller’s deadline. Adoption performs one capture plus one closing
  revalidation over retained entries; full validation rechecks the smaller
  completion scope after adoption and detects source or HEAD drift introduced
  during that scan. Receipt issuance repeats dependency completeness after
  inventory capture without retaining successful `npm ls` output.
- SessionStart reports routing, setup, config/profile, index, and
  current-thread activation as separate facts. Unknown or unobservable state
  never becomes `ready`.
- Ordinary SessionStart is telemetry-free, uses one request-local focus
  snapshot, has an aggregate deadline, preserves completed phase evidence on
  timeout, and waits for cancelled work to quiesce.
- Fresh wiring exposes only `search`, `change_plan`, and `capabilities`
  directly. The dispatcher retains all 22 logical operations with their
  operation-specific validation.
- Recovery context is opt-in and prioritizes the selected task and next action.
  Detailed setup and release procedures moved out of the automatic project
  kernel into explicit README and documentation boundaries.
- Helper-owned startup can resume the identical command after a recoverable
  Codexa runtime snapshot or timeout configuration failure is repaired.
- A committed context inventory and `npm run startup:context-check` now reject
  drift in repository-controlled byte limits, direct-tool counts, SessionStart
  bounds, and runbook links.

## What Was Kept, Deferred, or Removed

| Startup input | Classification | Design |
| --- | --- | --- |
| Source, Git, worktree, routing, and setup identity | Essential | Keep as bounded, independent readiness facets. |
| Compact host, workspace, and project policy | Essential | Keep the policy kernel; load detailed procedure only at the relevant boundary. |
| Recovery context, full runbook, advanced schemas | Conditional | Make opt-in or retrieve through docs and the capability dispatcher. |
| Repeated generic contract text and SessionStart telemetry | Bloat | Remove from ordinary startup. |
| Broad pre-task reads and repeated readiness probes | Bloat | Replace with progressive retrieval and one focus snapshot per request. |
| Platform system/tool envelope | External | Measure separately; never attribute it to repository changes. |

This preserves safety and diagnostic reachability. It does not use a smaller
prompt as a proxy for task success.

## Measurements and Claim Boundaries

| Measure | Baseline | Current evidence |
| --- | ---: | ---: |
| Automatic policy text | 30,795 bytes | 11,456 bytes, 62.8% lower |
| Project `AGENTS.md` | prior runbook | 2,823 bytes within a 3,072-byte gate |
| Direct MCP tools | 23 full | 3 core; all 22 logical operations retained |
| Decoded `tools/list` payload | full profile | 87.2% lower in core profile |
| Startup advertisement plus discovery | full profile | 69.8% lower in core profile |
| First/repeated tiny task result | full profile | 0% reduction |
| SessionStart p95 | 1,000 ms limit | 533 ms |

The automatic-policy token figure is only a four-bytes-per-token estimate
(2,864), not an observed model-token count. The transport benchmark measures
decoded MCP application-payload bytes, not model tokens, wire bytes, cost,
quality, or no-Codexa net value. Its zero task-result reduction is retained
because fixed decision-safety metadata dominates the tiny benchmark task.

The observed platform envelope began at 23,331 input tokens before
repository-controlled work. That is recorded as external, not as Codexa
overhead. The prior session also exposed 46,918 startup tool-result tokens,
including 31,111 associated with broad startup reads and 8,114 with repeated
readiness work; those diagnostic slices are not asserted to be disjoint.

The only honest remaining effectiveness measurement is a user-authorized
fresh desktop three-arm evaluation: no Codexa, Codexa core, and Codexa full.
It must compare first/repeat actual input tokens, task success and evidence
quality, and latency. This PR does not fabricate that host-controlled result.

## Security and Portability Design

- Managed file reads and writes reject redirected directories, special files,
  hardlinks, stale snapshots, and optimistic-write conflicts.
- Bootstrap inputs, source, build output, managed wiring, dependencies, runtime,
  worktree identity, and Git identity have explicit validation boundaries,
  including cross-scope mutation and dependency-removal races.
- Receipt publication relies on Git object and ref semantics instead of
  platform-specific filesystem replacement behavior.
- A trusted shared controller validates adoption before executing generated
  worktree code.
- Native Windows remains deliberately MCP-only; POSIX may also attest hooks.
  Linux execution and cross-platform fixture coverage passed here. Physical
  macOS and native-Windows hosts were not available and are not claimed as
  runtime proof.

## Verification

- `npm run security:check`: passed.
  - 86 test files passed.
  - 1,035 tests passed; 1 intentionally skipped.
  - npm audit found 0 vulnerabilities.
  - Public snapshot, package hygiene, plugin hygiene, and the 31-check packaged
    install smoke passed.
- `npm run benchmark:ci`: passed every threshold.
  - SessionStart p50 494 ms, p95 533 ms.
  - Adoption validation 953 ms against a 5,000 ms ceiling.
  - MCP startup 286 ms; MCP freshness p95 179 ms.
- `npm run benchmark:transport:exposure`: passed with 3/23 direct tools,
  logical-operation parity, 87.2% lower decoded tool-list payload, and 69.8%
  lower startup advertisement/discovery payload.
- `npm run eval:ci`: passed 21 scenarios with score 1 and no raw-search win.
- The shared worktree controller self-test passed against this real Codexa
  checkout, including fresh bootstrap/adoption behavior.
- `git diff --check`, source hygiene, release-path verification, public hygiene,
  and the startup-context gate passed.
  - The context gate measured 717/901/1,448-byte SessionStart fixtures and
    reran the full-versus-core transport comparison on a generated clean repo.

## Release Protocol

The PR may be marked ready only after reviewers inspect the exact committed
diff, PR state, comments, review threads, checks, ancestry, and both summary
artifacts, and the latest adversarial pass reports no actionable findings.
Merge does not itself prove publication or runtime health; post-merge
canonical sync, bootstrap/reindex, public-main verification, and real behavior
smokes remain mandatory.
