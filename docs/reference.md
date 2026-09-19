# Codexa reference

Detailed usage, implementation, evidence, and maintainer procedures. Start with
the [README](../README.md) for an introduction and first-time installation.
Commands below use `/path/to/project` as a placeholder for your repository.

- [Worktrees and setup receipts](#codex-project-worktrees-and-local-setup)
- [Committed change receipts](#committed-change-receipts)
- [Proof cards and policy packs](#proof-cards-and-policy-packs)
- [Agent workflow](#the-everyday-workflow) and [MCP delivery](#mcp-delivery-and-transport)
- [Generated files](#what-codexa-builds) and [command reference](#main-commands)
- [Language support](#what-it-understands) and [architecture](#architecture-for-engineers)
- [Optional integrations and AutoVerify](#optional-lanes)
- [Development checks](#testing-and-verification) and [benchmark evidence](#public-proof)
- [Releases](#release-automation) and [npm publishing](#npm-package-publishing)

## Codex Project Worktrees And Local Setup

Linked git worktrees are wired the same way. Untracked `.codex/config.toml`
and hook files stay host-local, so a fresh worktree is invisible to Codexa
until you run init in it. If a team intentionally tracks those files, init
renders worktree-relative launch commands and keeps the shared files unchanged
when the same branch is checked out at a different path:

```bash
git worktree add ../my-feature feature-branch
codexa init ../my-feature        # non-interactive: config + hooks + a fresh index for the worktree
```

The worktree gets its own index (its HEAD and dirty state differ from the
parent checkout's, so the parent's index would serve stale answers). If you
automate worktree creation, add `codexa init` to that automation; tracked
wiring remains Git-clean while the worktree-local ignored index is refreshed.

This repository also tracks a
[Codex local-environment](https://learn.chatgpt.com/docs/environments/local-environment)
definition at `.codex/environments/environment.toml`. On a local Linux/macOS
host (or Windows through WSL), its Bash setup installs locked dependencies,
builds Codexa, initializes worktree-local `core` wiring, and publishes an
identity-bound receipt through a worktree-local Git ref. Native Windows uses
the tracked PowerShell override: it installs, builds, and proves `core` MCP
config/index readiness with `--no-hooks`, then issues a receipt scoped to the
native-Windows MCP-only lane.
Both wrappers delegate to one Node orchestrator, which holds a cross-platform
lock across clean dependency installation, build, init, receipt issuance, and
strict startup validation.

In the desktop composer, select the saved Codexa project, `Worktree`, the
intended starting branch (normally `main`), and the `Codexa` local environment
before the first prompt. Create and configure that Worktree chat on desktop;
Remote on mobile may continue a supported desktop Codex chat but cannot select
or configure local setup. Once the app has created the linked worktree, adopt
that checkout for the task instead of creating a second worktree. A successful
setup receipt is an immutable Git blob published through the worktree-local
`refs/worktree/codexa/bootstrap-receipt` ref. Git provides the cross-platform
atomic publication boundary and keeps linked-worktree receipts isolated; no
mutable `.codex` pathname is treated as receipt authority. The receipt binds
the complete regular-file `dist/` runtime manifest, not only the CLI entry
point, so a changed imported module invalidates full validation. SessionStart
consumes a lightweight durable subset: worktree and Git identity, package/lock
and startup-procedure inputs, dependency-install seal, managed config/hooks,
and Node runtime. Ordinary source, HEAD, index, or build-output evolution
therefore does not force a complete bootstrap rerun or block a safe index
refresh. The explicit `worktree-receipt validate` completion gate still
recomputes source, complete `dist/`, HEAD, and installed dependency inventory.
Shared adoption uses a trusted canonical Codexa CLI with `--scope adoption`.
That scope validates durable startup inputs, the complete generated runtime,
and a single-pass, bounded manifest of the complete installed dependency tree
while permitting ordinary source/HEAD evolution. Legitimate dependency
hardlinks and in-tree executable links are supported; extraneous packages,
content changes, or links escaping `node_modules` invalidate adoption. The
receipt is local freshness evidence and never authorizes a controller to
execute generated code from the worktree before validation.

If a Remote-SSH host creates the worktree without invoking local-environment
setup, treat it as source-ready only. Repair the active remote worktree and
verify its observable readiness there:

```bash
bash .codex/worktree-bootstrap.sh
node dist/cli.js session-start "$PWD" --json --strict
```

Then reload or reopen that exact repaired checkout so the host can initialize
its MCP server. Do not start a generic new Worktree chat: it may create a
replacement checkout, abandon the repair, and repeat the skipped-setup path.
Neither the bootstrap receipt nor SessionStart can prove an already-running
thread's MCP handshake.
That bootstrap receipt records local dependency/build/init setup only, scoped
to either POSIX hooks or native-Windows MCP-only setup. It is locally validated
freshness evidence, not a signature or hostile-repository attestation.
SessionStart validates the durable startup subset together with managed config
and index state and still cannot attest the host's current-thread MCP handshake.

Codexa binds an index to the canonical worktree root, Git top-level root,
HEAD commit, and workspace-state digest. Context and review queries fail closed
when that identity does not match the active checkout. Auto-refresh may make
one bounded repair attempt, but Codexa validates the rebuilt index again before
serving an answer; `--no-auto-refresh` never serves a mismatched index.

Useful flags: the default tool profile for fresh installs is `core` — only
`search`, `change_plan`, and `capabilities` are advertised directly, which
reduces the decoded `tools/list` JSON surface. The compact `capabilities`
dispatcher keeps every non-core operation reachable through the same
operation-specific validation.
`--tools full` also exposes every operation directly, and re-running plain
`codexa init` preserves whichever profile the repo already uses. Fresh and
core-profile Codex and Claude Code launches both pass `serve --tools core`, so
the server enforces the compact surface even when a client ignores Codex's
additional `enabled_tools` hint. `--agents-md` (opt-in) writes a managed
Codexa workflow block into the repo's `AGENTS.md` for Codex, and `--claude-md`
(opt-in) writes the same managed block into `CLAUDE.md` for Claude Code. The
region between the `<!-- >>> codexa managed -->` / `<!-- <<< codexa managed -->`
markers is reserved: Codexa replaces it in place on every re-run (so the block
stays current) and never edits anything outside it. Unbalanced or malformed
markers abort the write instead of silently truncating the file.

## Committed change receipts

Use the receipt directly from a clean checkout. `head` must be the checked-out
commit so Codexa cannot combine a different Git object with the current index:

```bash
codexa review . --base origin/main --head HEAD
codexa review . --base origin/main --head HEAD --format json
codexa review . --base origin/main --head HEAD --task-id my-saved-plan
```

For a valid review, the default `--mode observe` reports findings without
failing on them. Setup, Git, and input errors can still fail the command. `warn`
uses warning annotations in GitHub output but remains non-blocking. `fail`
returns exit code 2 for range-bound local plan drift, an explicitly requested
local plan that is unavailable or not bound to the range, or a supplied
structured command report with a nonzero exit; missing heuristic
recommendations never become a blocking gate. Command and test claims are
classified by the existing verification ledger and remain explicitly
`reported`, not witnessed execution.

`codexa init . --ci` creates `.github/workflows/codexa-review.yml`. The managed
workflow has only `contents: read`, disables persisted checkout credentials,
checks out the exact pull-request head, and writes the receipt to the workflow
summary and annotations. It does not comment on pull requests. Codexa refuses
to overwrite a workflow it does not own. Re-running `init --ci` updates only
the Codexa-managed workflow.

For portable plan comparison in CI, commit a redacted Codexa change-plan
snapshot inside the repository and pass `--plan-snapshot <path>` (or the
Action's `plan-snapshot` input). The loader accepts only a bounded, valid,
non-symlink snapshot that resolves inside the repository. Local agent flows
normally use `--task-id` or MCP `change_review.taskId` instead. A repository
file is PR-controlled input, so portable plan conformance is advisory and never
becomes a blocking verdict; local cache plans must also bind to the reviewed
merge base before they can block explicit fail mode.

The installed command is `codexa`, and the server can also run ad hoc:

```bash
npx -y @mirnoorata/codexa serve /path/to/project --auto-refresh
```

The package's MCP registry identity is `io.github.mirnoorata/codexa`; its
publication metadata lives in [`server.json`](../server.json).

For shared workspace launches such as `codexa serve /path/to/workspace`, Codexa can route to
the active project recorded in `.codex/WORKING.md`. Selected session rows win;
conflicting active focus, workspace default, or active-session evidence fails
closed instead of silently choosing the wrong repo. Use
`CODEXA_WORKSPACE_SESSION=<session>` or `--workspace-session <session>` when
serving a shared workspace root with multiple live workers.

## Proof cards and policy packs

`codexa prove` is the compact "should I trust this agent handoff?" view:

```bash
codexa prove /path/to/project --task "change auth timeout behavior" --diff
```

It reports:

- index freshness and current dirty-tree state;
- read-first files selected from the task and graph context;
- saved `change-plan` snapshot status, including planned edit targets, planned
  tests, and exact task invariants when a snapshot exists;
- current task-lifecycle state, including any latched mandatory-replan stop;
- a bounded decision log recovered from active session memory or its compaction
  archive, with pointer-integrity diagnostics;
- verification commands, ledger preview, and reported commands/tests/reports
  classified with the same command-credit rules as `post-edit-review`;
- explicitly selected, immutable live-run artifacts bound to the exact task,
  HEAD, and workspace-state digest;
- explicit trust tiers on coverage and ledger rows, so an agent-reported pass
  cannot look equivalent to a fresh AutoVerify execution;
- local policy-pack status and remaining proof gaps.

`codexa policy-init /path/to/project` writes a small local policy pack under
`.codex/policies/` (`verification.json`, `complexity.json`, `security.json`).
`codexa init /path/to/project --policy-pack` creates the same pack during
initial setup. The files are plain JSON, are not executable, and are consumed
by `codexa prove` as bounded local evidence. Neither init nor `policy-init`
overwrite existing policy files unless `policy-init --force` is passed.

## MCP delivery and transport

Result-size discipline is built in: every tool description states its typical
output size, and structured results are budget-compacted with truncation
records naming dropped fields. `CODEXA_MCP_STRUCTURED_BUDGET_BYTES` caps the
serialized UTF-8 JSON bytes of the `structuredContent.data` subobject;
mandatory envelope identity, lifecycle, and resource metadata is additional,
so telemetry's `totalBytes` measures the complete reserialized result object.
Analysis tools whose evidence can expand accept `responseFormat: "auto"`,
`"concise"`, or `"detailed"`; the already-bounded `freshness` result has no
format switch. Automatic and explicit concise delivery always return a bounded
concise receipt. When available, an immutable resource URI preserves the
bounded detailed packet. If omitted detail is required for a safe decision and
that resource cannot be persisted or retrieved, the concise receipt becomes
blocked and directs the caller to request explicit detailed output. Explicit
`detailed` output is inline but still subject to a hard total-result bound. The
`tools/list` surface is budgeted too: the per-tool output schema defaults to a
compact top-level contract
(`CODEXA_MCP_OUTPUT_SCHEMA=full` restores the deep schema). Managed and bare
`codexa serve` launches default to core, so manual MCP entries receive the same
bounded surface without a migration step. Use `--tools full` only when an older
client requires direct names for every operation. Core advertises three direct
tools while retaining the same logical operations through `capabilities`.

The deterministic transport benchmark reserializes decoded JSON and counts
UTF-8 bytes. That is a provider-agnostic proxy, not a measurement of model input
tokens, price, or provider-specific wire serialization. Its clean fixture
supports a reduction in tool advertisement plus capability-discovery bytes and
the hard worst-case result budget. Ordinary first and repeated task-result
bytes were unchanged, so Codexa does not claim that core mode makes ordinary
result packets smaller.

### Managed cloud agents

Codexa's stdio transport is for a host running on the same machine as the
repository (Codex CLI, Claude Code). Its HTTP transport is **loopback-only by
design** — non-loopback bind addresses and non-loopback `Origin` headers are
rejected — so a hosted agent whose container runs in someone else's cloud (for
example a Claude Managed Agents session) cannot reach a local Codexa server over
the public network.

For managed cloud agents, run the tool-execution environment and Codexa where
they share repository access and, for HTTP, the same loopback network namespace.
Merely placing them in separate containers on the same host does not establish
that connection. Public authenticated remote HTTP is not currently shipped.

## The Everyday Workflow

Use Codexa selectively as a guardrail around code changes. A normal bounded
agent task should usually use no more than two Codexa calls. Exact local work
may use zero. The narrow three-call safety exception is an ambiguous,
materially risky edit in a host with no completion/Stop gate:
`search -> change_plan -> post_edit_review`.

1. Start with source tools when the target is exact and local.
   Read the named files or symbols and use repository-native verification with
   zero Codexa calls. A raw-sufficient `search` result is terminal for
   discovery: work from the exact hits instead of requesting another context
   packet. A materially risky edit may still warrant one `change_plan` after
   the source has established the target.

2. Spend one discovery call only when the target is ambiguous.
   Use `search`, then stop if its raw results are sufficient. Use
   `session_context` instead for genuinely broad or resumed work; do not stack
   `session_context`, `search`, and `task_brief` for the same discovery need.

3. Save a plan only for a non-trivial or materially risky edit.
   `change_plan` with `saveSnapshot=true`, or CLI
   `change-plan --save-snapshot`, records intended scope, targeted tests,
   verification commands, and task invariants. For an ambiguous materially
   risky edit, `search -> change_plan` normally uses the usual two calls.

4. Edit and run the planned verification.
   Use the targeted tests and commands already returned by `change_plan`.
   Call `test_plan` only when that guidance remains unresolved or a dedicated
   verification plan is explicitly requested.

5. Let a true completion/Stop gate review after verification when one is
   installed and able to carry the actual verification evidence. Codex's
   `codexa init` hooks are edit-scoped and run before later shell verification;
   the Claude plugin's Stop hook also lacks a trusted command/invariant ledger.
   Both retain one final evidence-bearing review route. Without a qualifying
   completion/Stop gate, an exact materially risky task may use
   `change_plan -> post_edit_review`. If the target was also ambiguous, the
   safety-preserving sequence is the narrow three-call exception
   `search -> change_plan -> post_edit_review`. `post_edit_review` /
   `post-edit-review` compares the actual dirty tree
   with the saved snapshot, reports drift, checks declared task invariants, and
   tells you whether to continue, run tests, inspect, or replan. Repeated
   distinct attempts are accounted against a task-scoped loop budget; once the
   budget trips, the stop remains latched until a new saved plan revision is
   accepted.

6. Produce formal proof only when the handoff needs it.
   `proof_card` / `prove` binds policy changes, formal audits, releases, or
   artifact handoffs to freshness, a saved plan snapshot, task invariants,
   lifecycle status, local policies, and reported verification evidence.

When a managed pre-edit hook exists and you skip the explicit plan, it saves an
implicit baseline of the dirty tree on the first edit. The review still gets
changed-since-baseline and head-drift accuracy, but only an explicit plan
enables unplanned-scope drift detection.

In core mode, use `capabilities` to discover or invoke a non-core operation;
full mode also exposes each operation directly. Both paths use the same
operation-specific schema and handler.

Automatic and explicit concise results stay within the concise result budget.
When persistence succeeds, they also return a content-addressed URI for the
bounded detailed packet under the active repository. The URI does not encode
the checkout path, remains
resolvable only for that server session, and is pinned by a durable
live-session lease until that server shuts down. Concurrent MCP server
processes share a hard per-repository ceiling of 256 result records and 256
session leases; a live owner's pins are never evicted merely because they are
old. If a new unique pin, session lease, opaque route, or persistence write
would exceed its bound, Codexa keeps the response concise. It remains
self-contained when the retained receipt is sufficient; when omitted detail is
required for a safe decision and no URI is available, it returns a blocked
receipt that requests explicit detailed output.
Graceful shutdown releases that server's leases; an abandoned lease is
reclaimed only after its stale window and owner-process identity check.
Unpinned records remain LRU-prunable within the 256-record disk bound.
Explicit `responseFormat: "detailed"` returns a bounded detailed packet inline.
Optional `CODEXA_MCP_TELEMETRY_PATH`
records bounded mechanical byte/time events; byte accounting is synchronous,
while file writes use a bounded queue off the response path. Graceful shutdown
adds a content-free `session-complete` record; analysis excludes that footer
from event totals and treats a missing footer as partial evidence. A relative
telemetry path is resolved once against the configured MCP launch root, so a
later workspace-focus change cannot split one server sequence across files.
Each server session must use a unique destination that is absent at startup;
the runner is responsible for enforcing that freshness precondition. The
writer creates the path exclusively and leaves an existing path untouched,
but an analyzer cannot infer from valid file contents alone which run wrote it.
Telemetry never changes tool authority or completion scoring.

Selective MCP call budget:

```text
exact/local/source-sufficient -> source tools, zero Codexa calls
ambiguous/raw-sufficient -> search, then stop
exact materially risky + completion/Stop gate -> change_plan(saveSnapshot)
ambiguous materially risky + completion/Stop gate -> search -> change_plan(saveSnapshot)
exact materially risky + no completion gate -> change_plan(saveSnapshot) -> post_edit_review
ambiguous materially risky + no completion gate -> search -> change_plan(saveSnapshot) -> post_edit_review
```

These are ceilings, not an automatic chain. Every additional call must be
justified by unresolved ambiguity, material edit risk, or a missing completion
review gate; a returned tool name alone is not a reason to keep calling Codexa.

## What Codexa Builds

Running `codexa index /path/to/project` writes generated files under the target
repo's `.codex/codebase/` directory:

```text
.codex/codebase/README.md
.codex/codebase/codex-contract.md
.codex/codebase/repo-map.md
.codex/codebase/relational-packets.md
.codex/codebase/relational-packets.json
.codex/codebase/relational-graph.json
.codex/codebase/packet-summary-prompts.ndjson
.codex/codebase/risk-map.md
.codex/codebase/placeholder-map.md
.codex/codebase/test-map.md
.codex/codebase/conventions.md
.codex/codebase/workflows.md
.codex/codebase/freshness.json
.codex/codebase/index.json
.codex/codebase/facts.ndjson
.codex/codebase/modules/
.codex/codebase/playbooks/
```

For lay readers, these are the maps and checklists Codex reads. For engineers,
the durable machine-readable index is `index.json` plus `facts.ndjson`; the
Markdown files are compact human/agent-facing projections of the same facts.
`relational-packets.md` is the read-first graph packet view for process traces
and module clusters; the JSON companions are bounded machine-readable exports
for tools and graph visualizers. `packet-summary-prompts.ndjson` contains
explicit opt-in prompt records only — indexing does not call a model.

Generated cache and working state live under `.codex/cache/`. Codexa-owned cache
writes are allowed; source-file mutation is not exposed through MCP tools.

## Main Commands

| Command | Use it for |
| --- | --- |
| `codexa init <repo>` | Write repo-local Codex MCP config/hooks and index the repo (`--claude` for Claude Code, `--ci` for a read-only PR workflow, `--tools full` for every tool, `--agents-md` for an AGENTS.md workflow block). |
| `codexa session-start <repo>` | Print a cheap versioned receipt with separate config, index, required local setup, and current-thread MCP activation states (`--json` for structured output; `--strict` for observable readiness gating). |
| `codexa worktree-receipt issue\|validate <repo>` | Issue bootstrap-bound setup evidence or validate it. Validation defaults to the full source/dist/dependency scope; `--scope startup` checks durable startup readiness and `--scope adoption` adds generated-runtime and installed-dependency integrity without binding source/HEAD. Issuance requires the orchestrator's pre-install startup fingerprint and pre-build source fingerprint. |
| `codexa index <repo>` | Build `.codex/codebase/` artifacts once. |
| `codexa watch <repo>` | Keep artifacts fresh during active edit sessions. |
| `codexa status <repo>` | Check freshness and parser errors without refreshing. |
| `codexa doctor <repo>` | Diagnose wiring, freshness, hooks, artifacts, and MCP readiness. |
| `codexa repo-map <repo>` | Show ranked modules/files. |
| `codexa search <repo> --query "..."` | Discover a target from natural language, identifiers, or broad prompts. |
| `codexa find-context <repo> --query "..."` | Find matching files, symbols, and usage sites. |
| `codexa explain <repo> --file path` | Explain a file. |
| `codexa explain <repo> --symbol name` | Explain a symbol neighborhood. |
| `codexa impact <repo> --file path` | Estimate blast radius for a file or symbol. |
| `codexa diff-impact <repo>` | Summarize current dirty worktree impact. |
| `codexa review <repo> --base <ref> --head HEAD` | Produce the shared committed-change receipt for terminal, JSON, or GitHub output. |
| `codexa test-plan <repo> --diff` | Recommend targeted tests for current changes. Use `--file path` when there is no dirty diff but you already know the target. |
| `codexa brief <repo> --task "..."` | Get a read-first packet when direct source inspection leaves the task unclear. |
| `codexa context-pack <repo> --task "..."` | Get a larger task-shaped context packet. |
| `codexa focus-brief <repo> --task "..."` | Orient around a broad project question. |
| `codexa callers <repo> --symbol name` | Find who calls or references a symbol/file. |
| `codexa callees <repo> --file path` | Find what a symbol/file calls or references. |
| `codexa dependency-path <repo> ...` | Find a bounded graph path between two files/symbols. |
| `codexa workflow-path <repo> --query "..."` | Trace route, job, manifest, or workflow paths. |
| `codexa change-plan <repo> --task "..." --save-snapshot --invariant "..."` | Save a pre-edit plan, dirty baseline, and bounded task invariants. Repeat `--invariant` as needed. |
| `codexa post-edit-review <repo> --task-id ... --invariant-review '<json>' --artifact-id ...` | Review the final dirty tree against the saved plan, exact invariants, lifecycle budget, and selected ingested run artifacts. |
| `codexa verification-artifact <repo> --file run-summary.json` | Safely ingest one bounded external live-run manifest and return its immutable artifact ID. |
| `codexa prove <repo> --task-id ... --artifact-id ...` | Build a proof card using only explicitly selected, state-bound artifacts. |
| `codexa semantic-index <repo> --provider ...` | Build optional semantic retrieval cache. |
| `codexa static-analysis <repo> ...` | Import or optionally run external scanner reports. |
| `codexa eval <repo>` | Run structured retrieval/verification benchmark scenarios. |
| `codexa github-sync-check <repo>` | Diagnose GitHub source sync readiness. |
| `codexa github-release <repo>` | Create release notes, tags, and GitHub Release entries. |
| `codexa serve <repo>` | Start the core MCP context server over stdio; non-core operations remain reachable through `capabilities` (`--tools full` restores every direct tool name). |
| `codexa serve <repo> --transport http --host 127.0.0.1 --port 8729` | Start loopback-only HTTP MCP. |

Most context commands auto-refresh stale or missing Codexa artifacts before
answering. Use `--no-auto-refresh` when you intentionally want to inspect only
the stored index.

## What It Understands

Codexa indexes git-visible files and skips common generated or dependency
directories. The source reader is intentionally small and deterministic.

Native parser lanes:

- TypeScript, TSX, JavaScript, and JSX through Tree-sitter plus TypeScript
  compiler assist.
- Python through Tree-sitter plus lightweight semantic assist.

Shallow deterministic lanes:

- Rust declarations, imports, methods, calls, and tests.
- Go packages, imports, functions, methods, types, constants, variables, and
  tests with module-aware import resolution.
- Java packages, imports, classes, interfaces, enums, records, methods, and
  direct call-like usage.

Lightweight file lanes:

- JSON manifests.
- Markdown, MDX, RST, and text docs.
- Shell scripts.
- Systemd service files.

Facts carry explicit confidence:

- `authoritative`: syntax or git facts Codexa directly read.
- `derived`: deterministic links, static assists, report-backed relationships,
  and likely test relationships.
- `heuristic`: framework hints, string references, dynamic behavior guesses, or
  risk hints.
- `fallback`: low-confidence context used only when nothing better is available.

Codexa should never make heuristic-heavy output look stronger than it is.

## Architecture For Engineers

Codexa is a TypeScript package with five main layers.

### 1. Indexing

Entry point: `src/indexer.ts`.

Pipeline:

1. Discover git-visible files and dirty state.
2. Parse source files and reuse the content-hash parse cache where possible.
3. Import external static-analysis and symbol-report facts.
4. Apply TypeScript/Python semantic assists.
5. Resolve imports, usage sites, aliases, test edges, and graph links.
6. Rank files/modules with centrality, usage, churn, tests, dirty risk, and
   bounded outcome signals.
7. Build typed graph edges, workflow traces, functional clusters, and
   relational packet exports.
8. Record freshness, parser errors, and dirty hashes.
9. Publish artifacts atomically.

The indexer uses a cross-process cache lock so parallel Codexa commands do not
stampede artifact writes.

### 2. Fact Model

Core types live in `src/types.ts`.

Important fact types:

- `RepoSnapshot`
- `File`
- `Symbol`
- `UsageSite`
- `ImportEdge`
- `TestEdge`
- `GraphEdge`
- `WorkflowTrace`
- `ModuleCluster`
- `RiskSignal`
- `ParserError`
- `SessionMemoryEntry`

Important graph edge kinds:

- `DEFINES`
- `IMPORTS`
- `CALLS`
- `REFERENCES`
- `TESTS`
- `ROUTE`
- `JOB`
- `RISK`
- `ROUTE_HANDLES`
- `ROUTE_CALLS_STORE`
- `STORE_DISPATCHES_ADAPTER`
- `ADAPTER_REFERENCED_BY_MANIFEST`
- `UI_CALLS_ENDPOINT`
- `TEST_COVERS_WORKFLOW`
- `IMPLEMENTS`
- `EXTENDS`
- `EXPORTS`
- `TYPE_EXPORTS`

Relationship claims can include `EdgeEvidenceV1`, which carries edge kind,
source, confidence, reason, path/symbol endpoints, optional range, and
stale/degraded flags.

### 3. Query Layer

Public query exports live in `src/queries.ts`, intentionally kept as a thin
barrel. Implementations live under `src/query/`.

Key query modules:

- `search.ts`: repo maps, raw/BM25/exact/symbol/semantic search, target
  discovery, raw-exact-vs-ranked anchor reporting, and relational process /
  cluster packet selection.
- `context.ts`: `context_pack`, `task_brief`, `focus_brief`, and
  `session_context`.
- `impact.ts`: file/symbol blast-radius expansion and verification recipes.
- `graph-traversal.ts`: callers, callees, and dependency paths.
- `workflow.ts`: route/job/manifest workflow traces.
- `change-plan.ts`: pre-edit plans and saved snapshots.
- `post-edit.ts`: dirty-tree review against saved snapshots.
- `test-plan.ts` and `tests.ts`: test recommendations and provenance.
- `verification.ts`: command coverage, command envelopes, and verification
  ledger entries.
- `session-memory.ts`: cache-only working memory queries.

Query sessions (`src/query/session.ts`) carry the repo root, loaded index,
freshness, git state, command budget, warnings, provenance, changed files, and
changed symbols. Worktree inspection is allowed to degrade; an empty changed-file
set with degradation warnings means "unknown", not "clean".

### 4. MCP Server

Entry point: `src/mcp.ts`.

Codexa registers a query-only MCP server. Stdio is the default transport for
local Codex use. Streamable HTTP is available only on loopback addresses unless
future auth/origin policy is added.

The default core profile advertises three direct tools:

```text
search
change_plan
capabilities
```

`capabilities` dispatches every non-core operation through its own schema and
handler. Full mode advertises the complete direct-tool surface:

```text
freshness
repo_map
find_context
search
placeholder_report
symbol_context
impact
diff_impact
change_review
test_plan
task_brief
context_pack
focus_brief
session_context
callers
callees
dependency_path
workflow_path
change_plan
post_edit_review
proof_card
capabilities
session_memory
```

MCP resources expose generated `.codex/codebase/` artifacts. MCP prompts expose
small workflow prompts for impact-before-edit, dirty-diff review, snapshot edit
loops, and targeted test planning.

MCP tools may update Codexa-generated artifacts or cache state when
auto-refresh, snapshots, or session memory are enabled. They do not expose a
source-editing tool.

### 5. Adapters, Packaging, And Release Tools

Adapters:

- `src/cli.ts`: Commander-based CLI.
- `src/init.ts`: repo-local MCP config and hook setup.
- `integrations/claude-code/`: Claude Code plugin, hooks, and slash commands.
- `plugins/codexa/`: hookless Codex plugin bundle with manifest, skill, and MCP
  wrapper; repositories initialized with `codexa init` supply the managed Codex
  hooks separately.

Operational tools:

- `src/doctor.ts`: local readiness checks.
- `src/github-sync.ts`: git/GitHub sync diagnostics.
- `src/github-release.ts`: release notes, tags, and GitHub Release flow.
- `scripts/*.mjs` and `scripts/*.sh`: source hygiene, privacy, package smoke,
  public snapshot, benchmark, and publish gates.

## Optional Lanes

### Session memory

Codexa stores bounded task decisions, rejected hypotheses, invariants, and
artifact references under `.codex/cache/`. These are local working notes, not a
complete transcript or an independent record of everything an agent read.
See [session memory architecture](architecture/session-memory.md) for storage,
compaction, and trust boundaries. Use `codexa session-memory --help` for CLI
operations and `codexa serve --help` for memory modes.

### Semantic Retrieval

Semantic retrieval is opt-in and cache-based.

Build the cache:

```bash
codexa semantic-index /path/to/project --provider openai
codexa semantic-index /path/to/project --provider local-command --command ./embed-jsonl
```

After the cache exists, query commands can use it automatically when the snapshot
and provider settings match. `--semantic` forces diagnostics, and
`--no-semantic` disables the lane for one call.

OpenAI uses `OPENAI_API_KEY` and defaults to `text-embedding-3-small`.
`local-command` receives JSONL on stdin and returns embedding records. Codexa
does not ship a vector database and does not call embedding providers unless the
semantic cache/provider path is configured or explicitly forced.

Unchanged chunks reuse their embeddings across source-index rebuilds. Reuse is
bound to content, provider, model, requested dimensions, command arguments, and
preprocessing version. Use `semantic-index --force` to refresh all embeddings,
including after changing a local embedder's implementation without changing its
command. Unchanged rebuilds retain one vector generation; generations from
changed content are retained to avoid deleting data used by concurrent readers.

### TypeSafe Reranking

For a new ambiguous query, Codexa first assembles candidate files, then uses
TypeSafe to rank them before returning results. Scoring starts as soon as that
candidate set is ready, overlapping independent local summary work. Exact
symbol/path matches and sufficient literal search hits skip the hosted call.
An optional semantic provider still participates in candidate retrieval before
TypeSafe; this is not a separate TypeSafe verification pass.

Accepted decisions are reused within the running process (including MCP) for
up to five minutes, with at most 128 entries. Reuse binds to the exact query,
repository snapshot, candidate order and source contents, model, credential,
and request limits. Changed inputs trigger a fresh decision. Failed or uncertain
responses are not cached. The cache stores only digests and scores in memory;
separate CLI processes make their own first request. Reused results report
`cacheHit: true` and zero new token usage in structured query output.

TypeSafe is an optional hosted relevance scorer. It reorders existing candidate
files for behavior queries; deterministic scores, anchors, and verification
authority remain unchanged. It needs no embedding cache. A key alone does not
enable it.

`codexa index` (also available as `codexa reindex`) prints `TypeSafe on`,
`TypeSafe off — not enabled`, or `TypeSafe off — API key missing` for the current
process. The same status appears after indexing
during `init`, `watch`, `semantic-index`, and `static-analysis`. Indexing does
not call TypeSafe or validate the key. `TypeSafe on` means enabled with a key
present for search reranking; it does not confirm API
access, and a separately launched search or MCP process needs its own environment
and options. Each user supplies their own key; Codexa includes no shared key.

Provide `TYPESAFE_API_KEY` through your secret manager or a private local file:

```bash
TYPESAFE_API_KEY="$(cat /path/to/private/typesafe.key)" \
  codexa find-context /path/to/project --query "where are expired sessions rejected" --typesafe --no-semantic
```

`search`, `find-context`, and `serve` accept `--typesafe` and
`--no-typesafe`. For MCP, these settings apply to search and find-context tools. `CODEXA_TYPESAFE=1` enables it for a process; explicit
`--no-typesafe` overrides that setting. Opting in sends the query, candidate
paths, symbol names, and up to 3,000 characters of each candidate's source to
`https://api.typesafe.ai`. Credentials are read from the environment and are
never stored in the index or comparison output.

The defaults are `jev-latest`, 12 candidates (maximum 20), and a total 2,500 ms
deadline per rerank, with no retries. Configure them with `--typesafe-model`,
`--typesafe-max-candidates`, and `--typesafe-timeout-ms`, or the corresponding
`CODEXA_TYPESAFE_MODEL`, `CODEXA_TYPESAFE_MAX_CANDIDATES`, and
`CODEXA_TYPESAFE_TIMEOUT_MS` environment variables. Exact path/symbol queries,
sufficient literal search hits, and stale indexes skip hosted scoring. Missing
keys, service failures, timeouts, malformed responses, and low-confidence
results preserve the local ranking.

Explicit candidate and timeout limits must be positive integers. Smaller limits
are honored; a one-candidate limit skips reranking without sending source.
Invalid explicit limits are rejected instead of replaced with larger defaults.

Run the fixed synthetic comparison after `npm run build`:

```bash
node scripts/compare-typesafe.mjs
TYPESAFE_API_KEY="$(cat /path/to/private/typesafe.key)" \
  node scripts/compare-typesafe.mjs --live
```

The default output is ignored local state at
`.codex/cache/typesafe-comparison.json`. See
[measured results and limits](../docs/TYPESAFE_EVALUATION.md) and the
[TypeSafe JavaScript SDK documentation](https://docs.typesafe.ai/sdk/javascript).

### LSP Assist

LSP assist is read-only and bounded. Enable it with `--lsp` or
`CODEXA_LSP=1` on supported query commands.

Codexa can query:

- `typescript-language-server --stdio`
- `basedpyright-langserver --stdio`
- `pyright-langserver --stdio`

LSP failures are warnings in the packet, not hard failures. LSP never edits
source files.

### Static Analysis Reports

Codexa does not vendor Semgrep, CodeQL, ShellCheck, or other scanner engines.
The default safe shape is report ingestion:

```bash
codexa static-analysis /path/to/project \
  --semgrep-report /tmp/semgrep.json \
  --codeql-report /tmp/codeql.sarif \
  --symbol-report /tmp/codexa-symbols.json \
  --scip-report /tmp/index.scip.json
```

Codexa also accepts a bounded `CodexaSymbolReportV1` JSON document so external
language tools can feed symbols and relationships into Codexa with `derived`
confidence. SCIP reports are accepted as JSON exported by `scip print --json`;
Codexa converts them into the same bounded symbol-report lane and does not run
or vendor SCIP indexers.

Scanner execution flags such as `--run-semgrep`, `--run-codeql`, and
`--run-shellcheck` are explicit opt-ins. They run installed local tools under
scrubbed environments and write reports under `.codex/static-analysis/`.

### AutoVerify Hooks

`codexa init` writes advisory hooks when Codex hooks are available:

- `hook-pre-edit` silently saves an implicit pre-edit baseline when no
  change-plan snapshot exists. If an invalid/blocked snapshot, degraded
  worktree, or active writer prevents a reliable baseline, it emits one bounded
  warning to run explicit `change_plan` with `saveSnapshot=true` before a
  non-trivial edit.
- `hook-pre-edit` also blocks when a task's repeated-loop budget has latched a
  mandatory replan. Lifecycle read or validation failures fail closed with an
  actionable diagnostic instead of silently disabling the guard.
- `hook-post-edit` runs a bounded review after edit tools. Because it runs
  before later shell verification, it does not replace one final
  `post_edit_review` with the actual verification evidence.

With read-only autonomy, the post-edit hook performs one review, persists that
outcome once, and skips AutoVerify candidate derivation entirely. With
full-access AutoVerify, it performs a non-persisted preview to select safe
commands and one final persisted review enriched with
the trusted runner reports. This keeps the two-pass path only where command
execution can add evidence.

AutoVerify command execution is disabled unless user-owned autonomy is
`full-access` or the environment sets `CODEXA_AUTOVERIFY=1` /
`CODEXA_AUTOVERIFY=true`. Even then, AutoVerify is hook-only. MCP
`post_edit_review` never spawns commands.

The general autonomy switch is `CODEXA_AUTONOMY`: `read-only` (aliases
`readonly`, `off`) or `full-access` (aliases `full`, `bypass` — this grants
the same command-execution rights as user-owned full-access autonomy, so
treat it like a credential). `CODEXA_AUTOVERIFY` takes precedence when both
are set, and an unrecognized `CODEXA_AUTONOMY` value fails with an error
instead of being silently ignored.

AutoVerify is not a sandbox. Test code still runs locally with the user's file
permissions. Codexa records whether verification mutated source/test/provenance
state and treats such reports as non-covering evidence.

## Testing And Verification

Common development commands:

```bash
npm run typecheck
npm run lint
npm run privacy
npm test
npm run check
```

`npm run check` builds and type-checks the package, checks source/release-path
hygiene and public paths, runs Claude Code smoke tests and Vitest, and checks
the startup context budget.

Release-oriented checks:

```bash
npm run smoke:package
npm run benchmark:ci
npm run public:snapshot-check
npm run package:hygiene
npm run security:check
```

`security:check` runs the development gate, dependency audit, clean-tree public
snapshot verification, package hygiene, and installed-package smoke test. The
public snapshot check intentionally refuses a dirty tree so the verified archive
matches `HEAD`.

`benchmark:ci` is self-preparing: it runs the same serialized clean-install,
build, core-wiring, receipt, and strict-startup bootstrap used by a fresh
worktree before measuring hot paths, then opts the SessionStart metric into
strict readiness with `--strict-session-start` and measures adoption-scope
receipt validation with `--verify-startup-contract`. The adoption metric binds
the complete installed dependency tree and built runtime, and fails above five
seconds. Direct uses of the benchmark remain advisory unless those flags are
supplied, so an intentionally unwired fixture can still measure transport cost.
This avoids benchmarking an accidentally stale local build without silently
changing the benchmark target.

GitHub Actions passes `--threshold-scale 1.5` to give variable shared runners
bounded headroom without changing the checked-in product targets. Benchmark
JSON and the job summary report the base target and the effective gate
separately, and identify target misses even when they remain inside that
headroom. The scale is explicit, applies uniformly, and is capped at `2`.

## Public Proof

Codexa has a structured eval harness:

```bash
node dist/cli.js index /path/to/project
node dist/cli.js eval /path/to/project --suite all --seed codexa-v1-benchmark
```

The eval scores structured query data, not prose. It compares Codexa packets
against raw `rg`/`git status` baselines, tracks recall/precision/test
recommendations/context size, and can run ranking experiments without changing
production ranking. The claim is deliberately falsifiable: a scenario fails
outright if the raw-grep baseline does the job better, and the harness runs in
CI on every push (`npm run eval:ci` in the check workflow, seeded per commit
so the synthetic holdouts cannot be overfitted) — "beats grep on its
scenarios" is a gate, not a one-off benchmark.

Measured results for v0.3.0 (seed `codexa-v030-eval`, full suite, archived
in [`reports/benchmarks/v0.3.0-eval.json`](../reports/benchmarks/v0.3.0-eval.json)):

| Metric | Result |
| --- | --- |
| Scenarios passed | 20/20 (2 project, 12 synthetic anti-cheat, 6 historical fixture) |
| File recall (mean) | 1.00 |
| Precision@k (mean) | 1.00 |
| Test recall (mean) | 1.00 |
| Scenarios where raw `rg`/`git` beat Codexa | 0 |
| Packet size vs. raw baseline output (mean) | 0.66x |
| Over-budget packets | 0 |

Known imperfections in that run, recorded by the harness itself: 2
false-positive impact files and 1 broad-retrieval failure
(`synthetic-session-context-seedless`) — see the `calibrationSummary` block in
the archived report. The previous run is kept at
[`reports/benchmarks/v0.2.0-eval.json`](../reports/benchmarks/v0.2.0-eval.json).

Do not update public benchmark claims without rerunning the eval on the current
checkout and current target.

### Agent-level A/B evaluation

The retrieval gate above does not establish that an agent completes coding
tasks better with Codexa. The opt-in
[agent A/B harness](../docs/guides/agent-ab.md) uses version-pinned Harbor
execution and digest-pinned base images to run the same coding agent and model
in control and Codexa-treatment arms. A separate no-network verifier produces
the binary completion outcome; Codexa does not grade itself.

The checked-in task is a plumbing pilot, not a product benchmark. Credible
effect claims require preregistered held-out tasks, paired repetitions, and
task-clustered analysis.

The archived GPT-5.6 Sol plumbing run is intentionally reported even though it
does not demonstrate a Codexa completion benefit. Both arms completed both
repetitions (two both-pass pairs; descriptive absolute risk difference 0),
while this easy task showed a large treatment efficiency penalty:

| Mean per run | Control | Treatment | Treatment / control |
| --- | ---: | ---: | ---: |
| Verified completion | 2/2 | 2/2 | no difference |
| Input tokens | 104,448 | 620,053 | 5.94x |
| Cached input tokens | 86,272 | 552,064 | 6.40x |
| Output tokens | 3,212 | 6,680.5 | 2.08x |
| Reported cost | $0.230376 | $0.816392 | 3.54x |
| Agent time | 87.849s | 164.996s | 1.88x |
| Controller time | 128.603s | 205.863s | 1.60x |
| Verifier-counted changed files | 2 | 2 | 1.00x |
| Verifier-counted changed lines | 62 | 67 | 1.08x |

This is descriptive evidence from one simple task and two pairs, with no
task-clustered interval; it cannot establish a product effect or a causal
mechanism. The treatment was a complete Codexa-enabled agent bundle, so the
5.94x input ratio is not evidence of MCP-only causality. Agent-reported
treatment setup succeeded in both runs and structured trajectories recorded 13
Codexa calls, while controls recorded none. Both
treatment runs also received a blocking `post_edit_review` inspection warning
for changed symbols even though the edited files exactly matched the saved file
plan. One run made a second review call after supplying initially omitted
invariant evidence. That is observed process friction, not demonstrated safety
value.
The immutable hashes, arm metrics, fidelity telemetry, and per-run outcomes are
archived in
[`reports/benchmarks/v0.10.0-agent-ab-pilot-v7.json`](../reports/benchmarks/v0.10.0-agent-ab-pilot-v7.json).

That v0.10 treatment used the 13-call workflow recorded above. The current
selective policy intentionally avoids that mandatory call chain. A full
registered, held-out experiment has not yet been rerun against the new policy,
so the archived result remains evidence about the v0.10 treatment rather than
a general efficiency or efficacy claim for the current release.

A later authenticated paired smoke on the same checked-in task provides a narrower
regression check for the original 5.94x failure. It used Codex CLI 0.144.6,
GPT-5.6 Sol at high reasoning effort, an ephemeral clean Codex home, identical
prompts and fresh fixture checkouts, and the locally built core-profile server
from candidate commit `97b84c9` as the treatment's only configured difference:

| One-pair smoke | Control | Candidate `97b84c9` treatment | Treatment / control |
| --- | ---: | ---: | ---: |
| Input tokens | 108,683 | 127,190 | 1.17x |
| Cached input tokens | 76,032 | 109,568 | 1.44x |
| Output tokens | 3,065 | 3,551 | 1.16x |
| Codexa tool calls | 0 | 0 | no difference |
| Public tests | pass | pass | no difference |
| Committed hidden-behavior smoke | fail | pass | descriptive only |

The exact-path treatment correctly took the zero-call route, so the historical
5.94x input-token regression did not reproduce; observed input overhead was
1.17x. The treatment also passed all committed behavior cases plus 40 generated
cases, while this single control run stripped leading/trailing C1 controls
before validation. This is a non-confirmatory one-pair smoke, not a product
effect estimate: it is not task-clustered, the runner differs by one patch
version from the archived experiment, and the ChatGPT-authenticated run emitted
no comparable provider-cost metric.

The task now specifies Unicode General Category `Cc` explicitly. The separate
verifier covers embedded plus leading/trailing C0, DEL, and C1 cases, including
generated edge cases, and validation rejects transient task artifacts before
hashing. Run a real authenticated provider preflight and validate an
artifact-clean task tree before spending tokens on a registered experiment.

## GitHub Release Timeline

Use GitHub Releases as the visible source timeline for the current project.

Source sync diagnostic:

```bash
codexa github-sync-check /path/to/codexa-checkout
codexa github-sync-check /path/to/codexa-checkout --no-network
```

For an explicitly requested manual release, replace `<release-tag>` with the
intended version tag. Use [Release Automation](#release-automation) normally.
Dry run and real release:

```bash
npm run release:github:dry-run -- --tag <release-tag>
npm run release:github -- --tag <release-tag>
```

The release command generates a changelog-style summary, changed-area summary,
restore commands, branch/worktree continuation commands, and forward-only PR rollback commands.
Official releases should come from a clean `main` after the normal GitHub flow
has landed.

## Release Automation

Release Please runs after pushes to `main`. It reads conventional commits,
opens or updates a release PR with the package version and changelog changes,
and creates the GitHub Release after that release PR is merged.

This does not publish npm on every main merge. Normal feature and fix PRs land
on `main` first, Release Please batches releasable changes into its release PR,
and npm publishing stays downstream of a published GitHub Release.

Release Please uses the short-lived repository `GITHUB_TOKEN`; no personal
access token or `RELEASE_PLEASE_TOKEN` secret is needed. In repository
`Settings → Actions → General`, enable **Allow GitHub Actions to create and
approve pull requests**. The workflow never approves or merges its release PR.
It explicitly dispatches `check.yml` on the release PR branch and dispatches
`npm-publish.yml` on `main` with the newly published release tag. These explicit
triggers are needed because `GITHUB_TOKEN` does not trigger normal push or
`release: published` workflows. The token has repository-scoped contents,
issues, pull-request, and Actions write permissions. Maintainers still review
and merge the release PR through the protected branch flow.

To retry release creation, manually run `release-please.yml` from `main`.
If the Release already exists but publishing was interrupted, use the npm
recovery procedure below.

## npm Package Publishing

The npm package is published by GitHub Actions after the GitHub Release lane
publishes a release. Release Please explicitly dispatches the publishing
workflow; manually created releases trigger `release: published`. Pushed tags
alone do not publish to npm. The workflow checks the released tag, package identity,
repository URL, version availability, and `npm run security:check`, then runs:

```bash
npm publish --registry https://registry.npmjs.org --access public --tag latest --provenance --ignore-scripts
```

Publishing uses npm trusted publishing (OIDC), without an `NPM_TOKEN` secret.
In the npm package settings, configure GitHub Actions with owner `mirnoorata`,
repository `codexa`, workflow filename `npm-publish.yml`, no environment name,
and permission for direct `npm publish`. The workflow verifies this trust before
installing dependencies or running the security gate. Authentication failures
report npm's response and the non-secret workflow identity; tokens are never
printed or retained by the diagnostic step.

To diagnose or recover an existing stable GitHub Release, run
`npm-publish.yml` manually from the default branch, providing its tag. The
default `publish=false` only checks release/package validity and authenticates;
it does not build, publish npm, or publish to the MCP registry. Set `publish=true`
to run the full security gate and publish the tagged source of the latest stable
GitHub Release. Already published
versions are skipped. This lets a corrected workflow publish an existing tag
without moving the tag or creating another release. Re-running an old failed
Actions run still uses its old workflow definition. The MCP registry job waits
for npm to expose the version before registering it; if npm processing exceeds
the bounded wait, retry the failed MCP job after the version becomes visible.
