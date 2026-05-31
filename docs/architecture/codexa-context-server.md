# Codexa V1: Codex-Native Codebase Intelligence

## Summary

Codexa V1 is a Codex-first context compiler plus an MCP context server. It is
not a general knowledge-graph platform and intentionally keeps the runtime
small.

The first milestone used a private application repository as the acceptance project, but Codexa is not project-specialized. It optimizes for generic blast-radius analysis and keeps the implementation intentionally small: TypeScript CLI, Tree-sitter parsing for TypeScript/TSX/Python, offline TypeScript/Python static assists, an in-memory graph, JSON/NDJSON persistence, concise Codex-native artifacts, and a focused MCP context surface.

## Key Decisions

- No external graph-intelligence runtime dependency or invasive generated agent
  setup.
- Static artifacts are the primary product; MCP is only for focused dynamic queries.
- Necessary correction after automation work: V1 MCP has no manual mutation or reindex tool, but context tools may auto-refresh the generated `.codex/codebase/` cache when freshness checks prove the stored snapshot is missing or stale. This keeps Codex from silently reasoning over stale project context after edits.
- Dirty working trees are supported from day one because Codex works inside active edits.
- Artifacts are Codex-first: short, ranked, actionable, and provenance-backed.
- Python support is included for simple structure, imports, decorators, tests, and direct usage sites, but dynamic/framework behavior is marked heuristic.
- Generic project support includes TypeScript path alias/project-reference metadata, package manifest symbols, Python package and `__init__.py` resolution, changed-symbol summaries for dirty diffs, framework route/job/test surfaces, and heuristic candidate test commands.
- Research-driven V1.1 additions keep the same small architecture while adding a default `task_brief` path, task-shaped `context_pack` output, bounded impact expansion inside task packets, grouped dirty-diff impact, MCP output schemas/annotations/resources/prompts, content-hash parse caching, generic framework detectors, repo-local SessionStart/edit-loop helpers, provenance-aware test command suggestions, known-gap reporting, and a structured anti-cheat eval harness.
- The current implementation also adds natural-language `focus_brief`/`session_context`, a small BM25/inverted-index retrieval layer, first-class typed graph edges, route/job/manifest workflow traces, generated architecture playbooks, change-plan packets, and cross-process refresh locking. These are still local, deterministic, and dependency-light.
- `session_memory` follows `docs/architecture/session-memory.md`: cache-only structured working memory, bounded auto-recorded `viewed` entries, one MCP tool with actions, no embeddings or learned similarity, and no promotion of agent assertions into the codebase fact graph.
- The first competitive Codex-native differentiator is the generated
  `.codex/codebase/codex-contract.md` plus SessionStart packet. It tells Codex
  exactly when to call `task_brief`, `change_plan`, `workflow_path`,
  `dependency_path`, `post_edit_review`, and `test_plan`, avoiding a noisy
  generic graph preview at startup.
- The v1 graph is in-memory and serialized to JSON/NDJSON. No graph DB, vector
  DB, always-on LSP daemon, formal solver, web UI, or generated wiki subsystem
  ships in v1. Embeddings and LSP are optional side lanes that are disabled by
  default, fail open, and never mutate source files.
- Every relationship carries an explicit source and confidence label.
- Freshness is a gate. Stale or dirty state must be visible in artifacts and MCP responses.

## Implementation

### CLI

Codexa is packaged for public npm distribution as `@mirnoorata/codexa`; the installed
binary remains `codexa` so existing Codex workflows do not need to change.
The package also includes `plugins/codexa/`, a Codex plugin bundle with a
manifest, skill, and MCP wrapper that launches the same npm `codexa serve`
entrypoint for the focused git repository or a workspace root that carries a
`.codex/WORKING.md` focused-project marker.

```bash
npm install -g @mirnoorata/codexa
npx -y @mirnoorata/codexa serve <repo> --auto-refresh
```

`<repo>` is the target repository root — the absolute path of the
codebase you want Codexa to index.

The `codexa` CLI exposes:

```bash
codexa init [repo]
codexa index <repo>
codexa semantic-index <repo> --provider openai
codexa semantic-index <repo> --provider local-command --command <embed-jsonl-command>
codexa watch <repo>
codexa static-analysis <repo>
codexa status <repo>
codexa explain <repo> --file <path>
codexa explain <repo> --symbol <symbol_id>
codexa search <repo> --query <query>
codexa impact <repo> --file <path>
codexa impact <repo> --symbol <symbol_id>
codexa test-plan <repo> --diff
codexa brief <repo> --task <task>
codexa context-pack <repo> --task <task>
codexa focus-brief <repo> --task <task>
codexa session-context <repo>
codexa callers <repo> --file <path>
codexa callees <repo> --symbol <symbol>
codexa dependency-path <repo> --from-file <path> --to-file <path>
codexa workflow-path <repo> --query <task>
codexa change-plan <repo> --task <task> --file <path>
codexa post-edit-review <repo> --task-id <snapshot_id>
codexa eval <repo>
codexa serve <repo>
```

When an MCP host launches from a workspace root, `codexa serve
<workspace-root>` resolves the active repository from
`<workspace-root>/.codex/WORKING.md` before falling back to the workspace git
root. The preferred compact marker is an `## Active Focus` section with a
`Project: /absolute/path/to/repo` line; the legacy `Focused project:
/absolute/path/to/repo` line is still supported. That resolution is checked for
each tool/resource call, so focus changes do not require an MCP process
restart. Focus-file targets must stay inside the configured workspace root.
`CODEXA_REPO` and `CODEXA_FOCUSED_REPO` remain fallbacks for launch roots that
are not git repositories and explicit escape hatches for out-of-tree repos;
they do not override an explicit git repository argument.

`init` is the user-facing setup command. It writes the repo-local `.codex/config.toml`
MCP entry, writes/updates the SessionStart and edit-loop hooks, and indexes the repo unless
`--no-index` is passed. After `codexa init`, future Codex sessions should only
need `focus on <repo>`; Codexa is discovered from the project `.codex` config.
`index` writes `.codex/codebase/*` inside the target repo. `watch` keeps those
artifacts live during active edit sessions with debounced filesystem events plus
a fallback git freshness poll. `serve` starts a stdio MCP server and must keep
stdout protocol-clean; logs go to stderr.

Artifact writes are staged in a temporary directory and then swapped into place so a failed write does not leave a partially updated live index.

Context commands (`repo-map`, `find-context`, `explain`, `impact`,
`diff-impact`, `test-plan`, `brief`, `context-pack`, `focus-brief`,
`session-context`, `workflow-path`, `change-plan`, and `serve`) auto-refresh
stale or missing artifacts by default. `status` remains a cheap freshness check
and does not refresh. `--no-auto-refresh` disables automatic refresh for
inspection or debugging.

`watch` is intentionally CLI-only. It never runs inside MCP and it does not add
an MCP reindex tool. Each rebuild goes through the same cross-process lock,
freshness recheck, parse cache, and atomic publish path as `codexa index`, so
the live mode cannot create a graph shape that differs from normal indexing.
The watcher has bounded operational knobs: `--debounce-ms`, `--poll-ms`,
`--no-initial`, and `--max-runs` for one-shot hook/smoke usage.

`static-analysis` is also CLI-only. It imports existing Semgrep JSON, CodeQL
SARIF, generic SARIF, or Codexa risk JSON reports into `.codex/static-analysis/`
and reindexes by default so the findings become `RiskSignal` facts. It can
optionally run user-installed `semgrep` or `codeql` binaries, but this is never
implicit and is not exposed through MCP. The command writes reports/cache files
under `.codex/` only; it does not edit source code.

`search` is deliberately honest about value. It runs a bounded raw `rg` lookup,
then overlays Codexa ranking, likely tests, freshness, and known gaps. If raw
search already returns a narrow exact result, the response says so instead of
pretending Codexa added high value.

`semantic-index` builds an optional embedding cache under
`.codex/cache/codexa-semantic-v1/`. The cache stores manifest metadata plus JSONL
vectors tied to the current Codexa snapshot id and provider settings. Once the
cache exists, query commands automatically use the lane when the snapshot
matches and the provider can embed the query; `--semantic` only forces the lane
for diagnostics and `--no-semantic` disables it for one call. Stale, missing, or
provider-mismatched caches produce diagnostics only when forced and otherwise
fall back to the normal exact/symbol/BM25/graph retrieval lanes. Providers are
`openai` and `local-command`. OpenAI uses the standard embeddings endpoint and
`OPENAI_API_KEY`; `local-command` receives JSONL `{id,text,model,dimensions}`
records on stdin and returns `{id,embedding}` records as JSON, JSONL, or
`{embeddings:[...]}`. MCP can use an already configured semantic lane without
tool-by-tool prompting, but arbitrary local embedding commands are configured at
server startup or through environment variables rather than accepted from tool
calls.

Optional LSP assist is read-only and bounded. `--lsp` on `explain`, `brief`,
`context-pack`, `change-plan`, or `serve` starts a stdio language server for at
most a few TypeScript, JavaScript, or Python files, sends `initialize` and
`didOpen`, then asks for document symbols, definitions, references, and
diagnostics. Codexa discovers `typescript-language-server --stdio`,
`basedpyright-langserver --stdio`, or `pyright-langserver --stdio`, and also
honors `CODEXA_LSP_*_COMMAND` plus JSON args environment overrides. Failures are
reported as warnings in the packet; source files are never edited.

`impact` and `context-pack` accept a small `change-type` hint: `style`, `api`,
`behavior`, `rename`, `delete`, or `unknown`. Style-shaped changes collapse
repeated consumer fanout aggressively. API, rename, and delete-shaped changes
keep broader importer and test coverage because public contracts can break
without local failures.

Borrowed context-quality rules from stronger code-intelligence systems are kept
deterministic and small:

- strict evidence tiers: `authoritative`, `derived`, `heuristic`, and `fallback`,
  including test recommendations
- context reflection: every search/impact/context-pack response includes a
  quality label, evidence counts, and a recommendation for whether to trust,
  verify, or narrow the packet
- token-budget discipline: repo-map/context-pack outputs fit explicit budgets and
  prefer ranked files plus key symbols over raw graph dumps

Fallback context is never presented as evidence-backed context. If Codexa cannot
find a confident file/symbol/diff focus, it says so and recommends raw search or
an explicit target.

Candidate test commands are ranked hints, not authoritative execution contracts. They include command provenance through package/Python metadata and are omitted when Codexa cannot find evidence for a runner.

`brief` is the preferred first query for Codex before editing, debugging, or reviewing a dirty tree. It uses the same compact packet format as `context-pack`, but defaults to a smaller task budget and is described to MCP hosts as the first-call workflow.

`context-pack` composes existing facts rather than inventing a second wiki layer. It accepts a task, focus files, symbols, query text, current diff inclusion, and a token budget, then returns the highest-utility files, bounded impact expansion, change groups, snippets, tests, freshness, warnings, known gaps, baseline search noise, and next-read order. Explicit files/symbols and small focused diffs seed bounded impact expansion, so likely callers and covering tests appear in the same packet instead of requiring a separate `impact` call for ordinary tasks.

`focus-brief` and `session-context` handle broad natural-language project focus
without requiring file or symbol seeds. They classify intent, run a small BM25
retrieval pass over indexed paths/symbols/imports/usages/risks, group likely
subsystems, explain matched terms, list read-first files, include likely tests,
and recommend the next MCP call. Decoy/mock/fixture-looking files are filtered
unless the query asks for them.

`callers`, `callees`, `dependency-path`, and `workflow-path` expose the graph
directly for Codex follow-up queries. `change-plan` combines focus, context,
graph/workflow signals, risk, tests, and verification recipes into a short edit
packet. Explicit files or symbols stay target-led; broad task retrieval is not
allowed to crowd out a requested target.

`change-plan --save-snapshot` records a small task snapshot under
`.codex/cache/codexa-tasks/`. The snapshot stores the planned edit
targets, read-first context, recommended tests, verification recipes, freshness,
and the exact dirty-file path/hash baseline at plan time. `post-edit-review`
then compares the current dirty tree against that baseline after Codex edits
files. It reports files changed since the snapshot, unplanned edits, high-risk
targets, related workflows, recommended tests not accounted for, and whether the
next step should be `continue`, `run_tests`, `inspect`, or `replan`. This is a
cache-only loop: it never edits source files and it does not regenerate indexes
except through the same optional auto-refresh used by other context queries.

`eval` runs a structured benchmark using raw `rg`/`git status` as baseline-noise measurements and Codexa impact/context/test planning as the system under test. It scores structured `QueryResult.data`, not prose. The default benchmark disables auto-refresh and can fail any scenario that refreshes during scoring. Synthetic holdouts use seed-generated names plus decoy files so the benchmark cannot be satisfied by hardcoded private-project strings.

### Indexer

The indexer walks git-visible files while respecting ignore rules and common generated directories. It parses TypeScript, TSX, JavaScript, JSX, and Python with Tree-sitter, then extracts files, symbols, imports, usage sites, decorators, tests, route/job hints, parser errors, and simple module clusters.

Unchanged files are reused from a content-hash parse cache at `.codex/cache/codexa-parse-cache.json`. The cache stores pre-resolution parse results and rebases snapshot metadata on reuse. The resolver still runs over the full current index, so changed files can relink against cached unchanged files. Cache misses, corrupt caches, parser-version changes, and missing entries fall back to normal parsing.

The resolver reads TypeScript `tsconfig.json` path aliases and project-reference
metadata from indexed files. Import edges preserve both the exported/imported
name and the local alias. The resolver then binds usage sites through named
imports, aliased imports, default-export aliases, namespace imports, object
literal methods, Python relative imports, Python `__init__.py` re-exports, and
Python module namespace calls before falling back to same-file or unique global
symbol names. Test files that import source files produce direct `TestEdge`
facts, which gives test planning stronger evidence than filename proximity
alone. TypeScript ESM imports that name `.js`, `.mjs`, `.cjs`, or `.jsx` outputs
can resolve back to `.ts`/`.tsx` source files, which keeps source-first projects
like Codexa linked before build output exists.

JSON node package manifests that expose a `nodes[]` array produce `node` symbols
for each `type_id`. Literal node type references across Python, TypeScript,
JSON, and tests are linked back to those manifest symbols with heuristic
confidence unless they come directly from the manifest.

Generic framework detectors stay heuristic unless the relationship is explicit
in source:

- FastAPI-style routes, websockets, event handlers, task/job decorators, pytest fixtures, and pytest tests.
- React hook/component naming hints.
- Pydantic models, SQLAlchemy/SQLModel models, Celery/shared-task registrations, and framework wiring calls.
- Operator-risk files such as service units and service/release/preview control scripts.
- Optional local-rule packs can add project-specific hints, such as adapter
  registries, generator template files, package manifests, and node type string
  references, without making the core graph project-specific.

Codexa also ships a tiny inspectable structural rule pack. It is deliberately not
a replacement for Semgrep, ast-grep, or CodeQL. The rules only add bounded
`RiskSignal` facts for high-leverage review surfaces: shell/process execution,
filesystem writes/removes, MCP tool registration, raw HTML sinks, and SQL
execution boundaries.

Third-party static-analysis integration is report-based, not code-based. Codexa
can ingest Semgrep JSON, CodeQL SARIF, generic SARIF, or a small generic risk
JSON shape from `.codex/static-analysis/` and `reports/`, but it does not vendor
Semgrep or CodeQL engine code, bundled rules, query packs, or CLI binaries. That
keeps V1 small and avoids mixing Codexa's MIT package with third-party
runtime/license obligations. Users can still run Semgrep or CodeQL themselves,
or explicitly ask `codexa static-analysis` to invoke installed scanners, and let
Codexa fold the produced findings into ranked risk context.

The static-analysis bridge deliberately stores only scanner output. Semgrep
configs such as `p/default` and CodeQL query suites such as
`codeql/<language>-queries:codeql-suites/<language>-code-scanning.qls` remain
owned by the user's scanner installation. Scanner execution defaults are
conservative: Semgrep runs with `--metrics=off`, CodeQL output is SARIF, and both
paths are opt-in because they can be slow and may contact external registries
depending on local scanner configuration.

Ranking uses a simple inspectable score that combines dependency centrality, usage count, public-surface hints, git churn, test proximity, and dirty-file risk. Pure PageRank is not treated as authority.

### Graph And Workflow Model

Codexa persists first-class graph facts rather than exposing only file tables.
`GraphEdge` facts use typed adjacency:

- `DEFINES`
- `IMPORTS`
- `CALLS`
- `REFERENCES`
- `TESTS`
- `ROUTE`
- `JOB`
- `RISK`

Graph tools return bounded edge lists and file sets with freshness and evidence
quality labels. They are intended for follow-up precision after a task brief, not
for dumping the entire graph into context.

`WorkflowTrace` facts model route, job, and manifest flows. A trace has an
entry, ordered steps, related files, tests, summary, rank, source, and confidence.
Tree-sitter-derived calls/imports are higher confidence; framework registry and
string-reference links remain heuristic. Natural-language workflow queries only
return traces with term or file evidence, so a broad prompt does not receive an
unrelated high-rank workflow just because it is central.

### Simple Python Support

V1 Python support includes:

- `.py` files
- modules, classes, functions, async functions, and methods
- `import x`, `import x as y`, `from x import y`, relative imports, package/module boundaries, and `__init__.py`
- direct calls like `foo()`, attribute calls like `module.foo()`, obvious class instantiations, and references to imported names, including aliased and namespace imports when the target module resolves inside the repo
- decorators for route/job/test evidence, including FastAPI-style routes, Flask-style routes, pytest fixtures, Celery/RQ/task decorators, and visible app-specific registries
- pytest-style files, test functions/classes, fixtures, and likely test-target links by import/reference proximity
- risk signals for public API functions, decorated handlers/jobs, shared utilities, migration/config files, high-churn files, and dirty files

Python confidence rules:

- `authoritative`: syntax facts such as definitions, import statements, decorator text, file paths, and line ranges.
- `derived`: simple import resolution, direct call/reference links, test proximity, and route/job handler hints.
- `heuristic`: dynamic dispatch, dependency injection, monkey patching, framework registry behavior, string-based imports, plugin loading, and cross-language endpoint matching.

V1 does not attempt full Python type checking, runtime tracing, dynamic import
resolution, deep framework plugins, or deep cross-language linking. LSP assist is
an optional query-time supplement, not a required indexing dependency.

### Data Model

The index is stored as:

```text
.codex/codebase/index.json
.codex/codebase/facts.ndjson
.codex/codebase/freshness.json
```

Minimum fact types:

- `RepoSnapshot`
- `File`
- `Symbol`
- `UsageSite`
- `ImportEdge`
- `TestEdge`
- `ModuleCluster`
- `RiskSignal`
- `ParserError`
- `GraphEdge`
- `WorkflowTrace`

Every fact includes a stable id, path, line/byte range when available, source, confidence, and snapshot metadata.

Freshness stores both dirty-file paths and dirty-file content hashes. Editing an already-dirty file after indexing must mark the index stale even when the dirty path set is unchanged.

### Artifacts

Codexa generates only this minimal artifact set:

```text
.codex/codebase/README.md
.codex/codebase/codex-contract.md
.codex/codebase/repo-map.md
.codex/codebase/risk-map.md
.codex/codebase/test-map.md
.codex/codebase/conventions.md
.codex/codebase/workflows.md
.codex/codebase/freshness.json
.codex/codebase/modules/<module-id>.md
.codex/codebase/playbooks/README.md
.codex/codebase/playbooks/<module-id>.md
```

Artifacts include ranked read-first lists, Python route/job/test hints where detected, provenance paths/line references where possible, and stale/dirty warnings. Codexa does not overwrite `AGENTS.md`.

Playbooks are generated from facts, not hand-written wiki content. Each module
playbook stays short and includes invariants, read-first files, risky boundaries,
related workflows, likely tests, and a safe change recipe.

### MCP Server

The MCP context server exposes:

```text
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
freshness
```

Tool responses are bounded and include freshness, provenance, confidence labels,
and a value estimate where the query can be compared with raw search. MCP tools
expose `outputSchema` for their structured result wrapper. Tool annotations are
non-destructive and closed-world unless the server is configured for OpenAI
semantic embeddings. When auto-refresh is disabled, context tools are strict
filesystem reads and advertise `readOnlyHint: true` unless they auto-record
session memory. Auto-recording tools advertise non-destructive cache-write
semantics because they can update `.codex/cache/codexa-session-memory/`.
With auto-refresh enabled, context tools may also update generated Codexa cache
artifacts under `.codex/codebase/` before answering. `change_plan` advertises
cache-write semantics because `saveSnapshot=true` writes
`.codex/cache/codexa-tasks/` and reads the legacy
`.codex/cache/codexa-task-snapshots/` path only as a migration fallback. They
never mutate source files.
`doctor --mcp-readiness` compares the declared MCP tool catalog with the server
registrations and reports drift before release. It also checks that the latest
passing eval was recorded against the current repo `HEAD` and MCP catalog tool
set rather than accepting an unversioned or stale pass marker.

When the MCP server starts with semantic retrieval forced, inputs for
`find_context`, `search`, `task_brief`, `context_pack`, `focus_brief`,
`session_context`, `workflow_path`, and `change_plan` include an optional
`semantic` flag plus provider/model/dimension/time-budget fields. Automatic
semantic use does not require these fields. Inputs for
`symbol_context`, `task_brief`, `context_pack`, and `change_plan` always include
optional LSP flags and bounded time/file limits. Both lanes are best-effort
context enrichments: a failed semantic provider or language server is reported
in diagnostics rather than failing the whole context tool.

The server also exposes MCP resources for the generated artifact set:

```text
codexa://repo/codebase/README.md
codexa://repo/codebase/repo-map.md
codexa://repo/codebase/risk-map.md
codexa://repo/codebase/test-map.md
codexa://repo/codebase/conventions.md
codexa://repo/codebase/workflows.md
codexa://repo/codebase/freshness.json
codexa://repo/codebase/modules
codexa://repo/codebase/playbooks/README.md
```

MCP prompts are intentionally workflow-shaped and small: `impact_before_edit`,
`dirty_diff_review`, `snapshot_edit_loop`, and `targeted_test_plan`. The
edit/review prompts prefer `change_plan saveSnapshot` before source edits and
`post_edit_review` after edits when a snapshot exists, while reserving separate
`impact`, `diff_impact`, or `test_plan` calls for medium/low-quality packets,
broad fanout, or high-risk public contracts.

MCP exposes no source mutation or manual reindex tool and never edits source
files, but context tool handlers can rebuild the generated `.codex/codebase/`
cache before answering when the dirty-file path/hash set or head commit differs
from the indexed snapshot. Concurrent refreshes within the same MCP process are
coalesced so parallel tool calls do not stampede artifact writes. Cross-process
refreshes use a lock directory under `.codex/cache/`, debounce by rechecking
freshness after lock acquisition, recover stale lock owners, and publish
artifacts atomically so partial writes are not treated as a live index.

Live indexing uses the same operational guarantees from the CLI side. A running
`codexa watch <repo>` subscribes to git-visible directories with `fs.watch`,
filters Codexa-generated paths, and polls freshness as a portable backstop for
missed platform watcher events. It coalesces bursts into one rebuild and relies
on the parse cache for unchanged files; it does not attempt per-file graph
patching in V1 because partial graph mutation is a larger correctness surface
than a cache-backed full resolver pass.

### SessionStart Hook

`codexa init` wires repos with `.codex/hooks.json` and the Codex hooks feature
flag in `.codex/config.toml`. The hook runs `codexa session-start <repo>` on
startup/resume. The helper prints cheap status by default; setting
`CODEXA_SESSIONSTART_CONTEXT=1` also prints a bounded no-refresh `context-pack`
preview. It does not mutate source files.

When Codex edit hooks are available, init also writes `hook-pre-edit` and
`hook-post-edit` entries for edit tools. The pre-edit helper is intentionally a
cheap guardrail: it reminds Codex to call `change_plan --save-snapshot` before a
non-trivial edit if no task snapshot exists. The post-edit helper runs a bounded
`post_edit_review`, returns the clear `continue` / `run_tests` / `inspect` /
`replan` verdict, and records compact outcome data in
`.codex/cache/codexa-outcomes/`. Eval runs persist aggregate calibration data
under `.codex/cache/codexa-evals/` so noisy cases, missing tests, heuristic-heavy
packets, and raw-search-better cases become regression material.
AutoVerify execution from hooks is disabled unless the user environment sets
`CODEXA_AUTOVERIFY=1` or `CODEXA_AUTOVERIFY=true`; repo-local config cannot opt
the hook into spawning test commands. When enabled, AutoVerify still runs only
allowlisted targeted test commands and feeds structured command reports back
into `post_edit_review`.

### Benchmark Integrity

The eval benchmark avoids false confidence by design:

- structured scoring uses returned `data`, not text snippets
- randomized synthetic holdouts generate new paths, symbols, and decoys from a seed
- current-repository scenarios remain operational regressions, not the only quality signal
- no-refresh mode is the default for scoring retrieval quality
- refresh events are measured and can fail the run
- metrics include recall, precision at K, selected tests, text size, baseline line count, selected/baseline compression, and failures
- comparison metrics parse baseline `rg`/`git status` output into file/test sets so with-vs-without Codexa is scored against the same oracle
- new scenarios include exact-search raw-sufficient cases, shared-module fanout,
  post-edit snapshot review, and change-type-sensitive impact so Codexa is
  penalized for adding noise where raw search is enough
- smoke scenarios are reported separately and are not averaged into the quality score unless they carry explicit gold labels

## Drift Controls

After implementation, check for forbidden scope creep:

- no external graph-intelligence runtime dependency
- no graph DB
- no vector DB
- no mandatory embeddings
- no always-on LSP daemon orchestration
- no formal solver
- no web UI
- no generated skill/wiki subsystem
- no MCP mutation/reindex tool

If implementation drift is found, either fix the code or update this document with an explicit correction and reason.

## Test Plan

Unit tests cover TS/TSX/Python parsing, Python imports/decorators/pytest fixtures/direct calls, usage-site source/confidence labeling, dirty working-tree overlays, deterministic ranking, artifact validity, bounded Markdown output, static-analysis report ingestion, and MCP freshness metadata.

Integration tests index a mixed TS/Python fixture repo, run status before and after edits, run impact for TS and Python symbols/files, run `test-plan --diff`, exercise live watch debouncing, start `serve`, call each MCP tool through a test client, and verify stdout stays JSON-RPC protocol-only.

Acceptance runs `codexa index <repo>`, inspects `<repo>/.codex/codebase/`, confirms Python backend and TypeScript frontend hotspots are represented, confirms route/helper/test relationships carry correct confidence labels, and checks impact/test-plan output on a real dirty or historical diff.
