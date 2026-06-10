# Codexa

Codexa is a local codebase map for AI coding agents.

In plain English: it reads a repository, builds a compact index of the files,
symbols, imports, tests, risks, and workflows it can prove, then gives Codex or
another MCP client small evidence-backed packets before and after edits. It is
meant to help an agent answer questions like:

- What should I read first?
- What could this change break?
- Which tests are relevant?
- Did my final dirty tree match the plan I saved before editing?

It is not an autonomous coding agent. It does not edit your source files through
MCP. It is a context compiler, query server, and verification guide.

## Maintainer Expectations

Codexa is maintained by one person, in spare time, with a deliberately narrow
scope. That shapes how this repo works:

- Response times are days to weeks, not hours.
- Scope is narrow on purpose. Deep native language indexers, new LLM analysis
  layers, broad IDE products, and general-purpose search modes are usually out
  of scope.
- Not every working PR will be merged. Open an issue first for anything beyond
  a typo or small docs fix.
- Security issues go through
  [private advisories](https://github.com/mirnoorata/codexa/security/advisories/new),
  not public issues. See [SECURITY.md](SECURITY.md).
- Questions and "is this the right tool?" discussions belong in
  [Discussions](https://github.com/mirnoorata/codexa/discussions), not the
  issue tracker.

## Quick Start

Codexa requires Node.js 22 or newer.

Install from npm:

```bash
npm install -g @mirnoorata/codexa
```

Or work from a checkout:

```bash
git clone https://github.com/mirnoorata/codexa.git
cd codexa
npm install
npm run build
npm link
```

Wire Codexa into another repository:

```bash
codexa init /path/to/project
codexa session-start /path/to/project
```

After `codexa init`, the target repository gets a repo-local `.codex/config.toml`
entry that lets Codex discover the Codexa MCP server automatically. Useful flags:
`--tools core` exposes only the primary-loop tools (plus `impact`/`freshness`) via an
`enabled_tools` allowlist to cut per-turn schema token cost (confirm your Codex CLI
supports `enabled_tools` first), and `--agents-md` (opt-in) writes a managed Codexa
workflow block into the repo's `AGENTS.md`.

The installed command is `codexa`, and the server can also run ad hoc:

```bash
npx -y @mirnoorata/codexa serve /path/to/project --auto-refresh
```

Codexa is also listed in the official MCP registry as
`io.github.mirnoorata/codexa` for MCP clients that discover servers there.

Token discipline is built in: every tool description states its typical output
cost, structured results are budget-compacted with truncation records naming
dropped fields, hosts with small MCP result limits can set
`CODEXA_MCP_STRUCTURED_BUDGET_BYTES`, and the big retrieval tools accept
`responseFormat: "concise"` for a summary-tier packet.

## The Everyday Workflow

Use Codexa as a guardrail around code changes:

1. Start with `session_context` or `codexa session-start`.
   This tells the agent whether the index is fresh and what loop to use.

2. Search when the target is unclear.
   `search` combines bounded raw search, exact/symbol evidence, Codexa ranking,
   optional semantic retrieval, likely tests, and known gaps.

3. Ask for a task brief before editing.
   `task_brief` / `brief` returns read-first files, impact expansion, risks,
   snippets, test recommendations, freshness, and next tool guidance.

4. Save a change plan before non-trivial edits.
   `change_plan` with `saveSnapshot=true`, or CLI
   `change-plan --save-snapshot`, records the intended scope and test plan.

5. Review after editing.
   `post_edit_review` / `post-edit-review` compares the actual dirty tree with
   the saved snapshot, reports drift, and tells you whether to continue, run
   tests, inspect, or replan.

6. Finish with a test plan if verification is unclear.
   `test_plan` recommends targeted commands and shows what they would cover.

Primary MCP loop:

```text
session_context -> search(if target unclear) -> task_brief ->
change_plan(saveSnapshot) -> post_edit_review -> test_plan
```

## What Codexa Builds

Running `codexa index /path/to/project` writes generated files under the target
repo's `.codex/codebase/` directory:

```text
.codex/codebase/README.md
.codex/codebase/codex-contract.md
.codex/codebase/repo-map.md
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

Generated cache and working state live under `.codex/cache/`. Codexa-owned cache
writes are allowed; source-file mutation is not exposed through MCP tools.

## Main Commands

| Command | Use it for |
| --- | --- |
| `codexa init <repo>` | Write repo-local Codex MCP config/hooks and index the repo (`--tools core` for a lean tool allowlist, `--agents-md` for an AGENTS.md workflow block). |
| `codexa session-start <repo>` | Print cheap startup status and the automatic-use loop. |
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
| `codexa test-plan <repo> --diff` | Recommend targeted tests for current changes. |
| `codexa brief <repo> --task "..."` | Get the default read-first packet before editing. |
| `codexa context-pack <repo> --task "..."` | Get a larger task-shaped context packet. |
| `codexa focus-brief <repo> --task "..."` | Orient around a broad project question. |
| `codexa callers <repo> --symbol name` | Find who calls or references a symbol/file. |
| `codexa callees <repo> --file path` | Find what a symbol/file calls or references. |
| `codexa dependency-path <repo> ...` | Find a bounded graph path between two files/symbols. |
| `codexa workflow-path <repo> --query "..."` | Trace route, job, manifest, or workflow paths. |
| `codexa change-plan <repo> --task "..." --save-snapshot` | Save a pre-edit plan and dirty baseline. |
| `codexa post-edit-review <repo> --task-id ...` | Review the final dirty tree against the saved plan. |
| `codexa semantic-index <repo> --provider ...` | Build optional semantic retrieval cache. |
| `codexa static-analysis <repo> ...` | Import or optionally run external scanner reports. |
| `codexa eval <repo>` | Run structured retrieval/verification benchmark scenarios. |
| `codexa github-sync-check <repo>` | Diagnose GitHub source sync readiness. |
| `codexa github-release <repo>` | Create release notes, tags, and GitHub Release entries. |
| `codexa serve <repo>` | Start the MCP context server over stdio. |
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
7. Build typed graph edges and workflow traces.
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

- `search.ts`: repo maps, raw/BM25/exact/symbol/semantic search, and target
  discovery.
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

MCP tools:

```text
freshness
repo_map
find_context
search
placeholder_report
symbol_context
impact
diff_impact
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
- `plugins/codexa/`: Codex plugin bundle with manifest, skill, and MCP wrapper.

Operational tools:

- `src/doctor.ts`: local readiness checks.
- `src/github-sync.ts`: git/GitHub sync diagnostics.
- `src/github-release.ts`: release notes, tags, and GitHub Release flow.
- `scripts/*.mjs` and `scripts/*.sh`: source hygiene, privacy, package smoke,
  public snapshot, benchmark, and publish gates.

## Optional Lanes

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
  --symbol-report /tmp/codexa-symbols.json
```

Codexa also accepts a bounded `CodexaSymbolReportV1` JSON document so external
language tools can feed symbols and relationships into Codexa with `derived`
confidence.

Scanner execution flags such as `--run-semgrep`, `--run-codeql`, and
`--run-shellcheck` are explicit opt-ins. They run installed local tools under
scrubbed environments and write reports under `.codex/static-analysis/`.

### AutoVerify Hooks

`codexa init` writes advisory hooks when Codex hooks are available:

- `hook-pre-edit` reminds the agent to save a change-plan snapshot.
- `hook-post-edit` runs a bounded post-edit review after edits.

AutoVerify command execution is disabled unless user-owned autonomy is
`full-access` or the environment sets `CODEXA_AUTOVERIFY=1` /
`CODEXA_AUTOVERIFY=true`. Even then, AutoVerify is hook-only. MCP
`post_edit_review` never spawns commands.

AutoVerify is not a sandbox. Test code still runs locally with the user's file
permissions. Codexa records whether verification mutated source/test/provenance
state and treats such reports as non-covering evidence.

## Source Map

| Path | Purpose |
| --- | --- |
| `src/cli.ts` | CLI command registration and option parsing. |
| `src/indexer.ts` | Main index pipeline orchestration. |
| `src/indexer/` | Discovery, parsing, graph stage, ranking, freshness, and artifact writing helpers. |
| `src/parser/` | Tree-sitter and shallow language extraction. |
| `src/resolver.ts` | Import, alias, usage, and symbol relationship resolution. |
| `src/graph.ts` | Typed graph and workflow trace construction. |
| `src/query/` | Query packets, edit planning, post-edit review, test planning, and verification logic. |
| `src/mcp.ts` | MCP server creation and transport setup. |
| `src/mcp/` | MCP tool/resource/prompt registration, runtime refresh, result compaction, and session-memory adapter code. |
| `src/session-memory/` | Cache-only structured working memory store. |
| `src/semantic-retrieval.ts` | Optional embedding cache build/query lane. |
| `src/static-analysis.ts` | Static-analysis report import and optional scanner execution. |
| `src/autoverify.ts` | Hook-only targeted verification runner. |
| `src/github-sync.ts` | GitHub source-sync diagnostics. |
| `src/github-release.ts` | GitHub Release and restore-note generation. |
| `scripts/` | Hygiene, privacy, package, benchmark, and publish checks. |
| `tests/` | Vitest coverage for indexing, MCP, CLI hooks, session memory, static analysis, packaging, and release helpers. |
| `docs/architecture/` | Design notes for the context server and session memory. |
| `integrations/claude-code/` | Claude Code plugin adapter and smoke tests. |
| `plugins/codexa/` | Codex plugin package. |

## Safety Boundaries

Codexa is deliberately constrained:

- Local-first by default.
- Query-only MCP surface.
- No source-mutating MCP tools.
- No graph database.
- No vector database.
- No web UI.
- No mandatory embeddings.
- No always-on LSP daemon.
- No hidden scanner execution.
- No broad host-specific planning layer.
- No project-specific private rules in the public setup path.

Context commands can refresh generated `.codex/codebase/` artifacts. Snapshot
and session-memory tools can write under `.codex/cache/`. Those are Codexa-owned
state paths, not source edits.

## Testing And Verification

Common development commands:

```bash
npm run typecheck
npm run lint
npm run privacy
npm test
npm run check
```

`npm run check` runs typecheck, source hygiene, release-path hygiene, privacy,
Claude Code smoke tests, and the Vitest suite.

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

## Public Proof

Codexa has a structured eval harness:

```bash
node dist/cli.js eval /path/to/project --suite all --seed codexa-v1-benchmark
```

The eval scores structured query data, not prose. It compares Codexa packets
against raw `rg`/`git status` baselines, tracks recall/precision/test
recommendations/context size, and can run ranking experiments without changing
production ranking. A scenario fails outright if the raw-grep baseline does the
job better.

Measured results for v0.2.0 (seed `codexa-v020-release`, full suite, archived
in [`reports/benchmarks/v0.2.0-eval.json`](reports/benchmarks/v0.2.0-eval.json)):

| Metric | Result |
| --- | --- |
| Scenarios passed | 20/20 (2 project, 12 synthetic anti-cheat, 6 historical fixture) |
| File recall (mean) | 1.00 |
| Precision@k (mean) | 1.00 |
| Test recall (mean) | 1.00 |
| Scenarios where raw `rg`/`git` beat Codexa | 0 |
| Packet size vs. raw baseline output (mean) | 0.66x |
| Over-budget packets | 0 |

Do not update public benchmark claims without rerunning the eval on the current
checkout and current target.

## GitHub Release Timeline

Use GitHub Releases as the visible source timeline for the current project.

Source sync diagnostic:

```bash
codexa github-sync-check /path/to/codexa-checkout
codexa github-sync-check /path/to/codexa-checkout --no-network
```

GitHub Release dry run and real release:

```bash
npm run release:github:dry-run -- --tag v0.2.0
npm run release:github -- --tag v0.2.0
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
and npm publishing stays downstream of the GitHub Release event.

Configure a `RELEASE_PLEASE_TOKEN` GitHub repository secret with a personal
access token that can create pull requests, tags, and releases. Do not use the
default `GITHUB_TOKEN` for Release Please if npm publishing should happen
automatically, because releases created by `GITHUB_TOKEN` do not trigger the
separate `release: published` npm workflow.

## npm Package Publishing

The npm package is published by GitHub Actions after the GitHub Release lane
publishes a release. The trigger is `release: published`; pushed tags alone do
not publish to npm. The workflow checks the released tag, package identity,
repository URL, version availability, and `npm run security:check`, then runs:

```bash
npm publish --registry https://registry.npmjs.org --access public --tag latest --provenance --ignore-scripts
```

For the first public npm release, configure an `NPM_TOKEN` GitHub repository
secret with publish access. After the package exists and npm trusted publishing
is configured, the workflow can remove token-based publishing while keeping the
same release gate and `--ignore-scripts` protection.

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a PR.

What usually fits:

- Bug fixes with clear reproduction and regression tests.
- Performance improvements with before/after measurements.
- Documentation fixes.
- Targeted improvements to existing commands or MCP tools.

What usually does not fit:

- New deep language indexers.
- New LLM-based analysis layers.
- Whole-file rewrites for style preference.
- Heavy dependencies where a small deterministic helper is enough.
- New source-mutating agent behavior.

Run this before proposing code changes:

```bash
npm run check
```

## License

MIT. See [LICENSE](LICENSE).
