# /srv/codexa

Project root: `/srv/codexa`

Codexa is a Codex-native codebase intelligence compiler. It indexes a target
repository, writes concise `.codex/codebase/` artifacts for Codex to read, and
serves focused MCP context tools over stdio.

## V1 Scope

- TypeScript CLI and MCP server.
- Tree-sitter parsing for TypeScript, TSX, JavaScript, JSX, and Python.
- In-memory relationship graph persisted as JSON/NDJSON.
- Codex-first artifacts for repo maps, risk, tests, conventions, and freshness.
- MCP context tools: `repo_map`, `find_context`, `search`, `symbol_context`, `impact`,
  `diff_impact`, `test_plan`, `task_brief`, `context_pack`, `focus_brief`,
  `session_context`, `callers`, `callees`, `dependency_path`, `workflow_path`,
  `change_plan`, `post_edit_review`, and `freshness`.
- MCP resources for generated `.codex/codebase/` artifacts and MCP prompts for
  common Codex workflows before edits, dirty-diff review, and test planning.
- A generated `.codex/codebase/codex-contract.md` that gives Codex a deterministic
  automatic-use contract for session start, pre-edit snapshots, post-edit drift
  review, workflow tracing, dependency checks, and final test planning.
- Generic relationship hints for package manifests, TypeScript project/path
  configuration, changed symbols, route/job/test surfaces, and candidate test
  commands with provenance. Atlas-specific rule patterns exist only as a local
  rules pack and regression target, not as the core architecture.
- Import-aware symbol binding for TypeScript/Python aliases and namespace/member
  calls so impact analysis can follow `import { x as y }`, `import * as ns`, and
  `from .module import x as y` usage without treating every match as a raw string.
  TypeScript source imports that name emitted `.js` files resolve back to `.ts`
  and `.tsx` sources.
- Offline TypeScript compiler assist strengthens default exports, aliased
  re-exports, type-only exports, JSX/createElement references, object literal
  methods, project references, and path alias metadata without running an LSP
  daemon.
- Python package/static analysis resolves relative imports, `__init__.py`
  re-exports, pytest fixture dependencies, class base references, and generic
  FastAPI/Celery/Pydantic/SQLAlchemy hints with heuristic labels where runtime
  framework behavior cannot be proven statically.
- A small built-in structural rule pack that emits bounded risk signals for shell
  execution, filesystem writes, MCP tool surfaces, raw HTML sinks, and SQL
  execution boundaries without adding Semgrep/ast-grep as runtime dependencies.
- Static-analysis report bridge for Semgrep JSON, CodeQL SARIF, generic SARIF,
  and Codexa risk JSON. Codexa can also run user-installed Semgrep/CodeQL CLIs
  on explicit request, then ingest the produced reports.
- A default `task_brief` path for Codex before edits, debugging, or dirty-diff
  review. It wraps the context pack with bounded impact expansion so requested
  files and focused dirty changes bring likely callers, covering tests, risks,
  confidence labels, snippets, and next reads in one response.
- Budgeted context packs that combine focus files, bounded impact expansion,
  grouped diff impact, snippets, tests, provenance, confidence, known gaps,
  baseline search noise, and freshness for a specific task.
- Natural-language focus briefs backed by a small BM25/inverted-index layer and
  intent rules. Broad prompts such as "how does queue polling work?" classify
  likely subsystems, explain why, and recommend the next MCP call instead of
  falling back to top-ranked files.
- Explicit graph queries over persisted typed edges: `DEFINES`, `IMPORTS`,
  `CALLS`, `REFERENCES`, `TESTS`, `ROUTE`, `JOB`, and `RISK`.
- Workflow traces for route/job/manifest execution paths plus generated
  architecture playbooks under `.codex/codebase/playbooks/`.
- Adaptive search that compares raw `rg` with Codexa ranking and explicitly says
  when raw search is already enough.
- Change-type-aware impact/context output for `style`, `api`, `behavior`,
  `rename`, `delete`, and `unknown`, including fanout collapse and verification
  recipes.
- Task snapshots for the edit loop: `change_plan --save-snapshot` records the
  plan-time dirty baseline under `.codex/cache/`, and `post_edit_review`
  compares the actual post-edit dirty tree against that snapshot for drift,
  unplanned files, risk/workflow signals, and tests still unaccounted for.
- `codexa init` also writes lightweight edit hooks when supported by Codex
  hooks: `hook-pre-edit` reminds Codex when a non-trivial edit lacks a saved
  change-plan snapshot, and `hook-post-edit` runs a bounded post-edit review.
  Each review writes a compact outcome record under
  `.codex/cache/codexa-outcomes/`; eval runs summarize those outcomes under
  `.codex/cache/codexa-evals/`.
- Strict evidence tiers in query output: `authoritative`, `derived`,
  `heuristic`, and `fallback`, including test recommendations.
- Deterministic context quality checks that can warn when a packet is
  heuristic-heavy, parser-gap affected, fallback-only, or broad-fanout.
- Token-budgeted repo maps that prefer ranked files and key symbols over
  unbounded graph dumps.
- Cache-aware indexing: unchanged files are reused from a content-hash parse
  cache while stale dirty overlays still trigger refreshes.
- Live indexing via `codexa watch <repo>`: a debounced filesystem watcher plus
  git freshness poll keeps `.codex/codebase/` artifacts updated through the
  same locked, atomic, parse-cache-backed index path as manual indexing.
- No GitNexus dependency, graph DB, vector DB, embeddings, web UI, formal solver,
  LSP daemon, or source-mutating MCP tools.

## Commands

```bash
npm install
npm run build
npm test

node dist/cli.js init /srv/atlas
node dist/cli.js index /srv/atlas
node dist/cli.js watch /srv/atlas
node dist/cli.js static-analysis /srv/atlas --semgrep-report /tmp/semgrep.json --codeql-report /tmp/codeql.sarif
node dist/cli.js status /srv/atlas
node dist/cli.js repo-map /srv/atlas --budget 1200
node dist/cli.js explain /srv/atlas --file atlas_api/app.py
node dist/cli.js search /srv/atlas --query useRunPolling
node dist/cli.js impact /srv/atlas --file atlas_api/app.py --change-type api
node dist/cli.js test-plan /srv/atlas --diff
node dist/cli.js brief /srv/atlas --task "Update S2S safely" --change-type behavior
node dist/cli.js context-pack /srv/atlas --task "Update S2S safely" --change-type behavior
node dist/cli.js focus-brief /srv/atlas --task "How does queue polling work?"
node dist/cli.js callers /srv/atlas --symbol useRunPolling
node dist/cli.js callees /srv/atlas --file web/src/App.tsx
node dist/cli.js dependency-path /srv/atlas --from-file web/src/App.tsx --to-file web/src/features/atlas/use-run-polling.ts
node dist/cli.js workflow-path /srv/atlas --query "queue workflow"
node dist/cli.js change-plan /srv/atlas --task "Change polling behavior safely" --file web/src/features/atlas/use-run-polling.ts --save-snapshot --task-id polling-update
node dist/cli.js post-edit-review /srv/atlas --task-id polling-update --ran-test web/src/features/atlas/use-run-polling.test.tsx
node dist/cli.js eval /srv/atlas --suite all --seed codexa-v1-benchmark
node dist/cli.js serve /srv/atlas
```

Context commands refresh stale or missing `.codex/codebase/` artifacts by default
before answering. Use `--no-auto-refresh` on `repo-map`, `find-context`, `search`,
`explain`, `impact`, `diff-impact`, `test-plan`, `brief`, `context-pack`,
`focus-brief`, `session-context`, `callers`, `callees`, `dependency-path`,
`workflow-path`, `change-plan`, `post-edit-review`, or `serve` when you need to inspect the stored
index without rewriting it.

After `npm link`, the same commands are available as `codexa ...`.

## Live Indexing

For active Codex edit sessions, run:

```bash
codexa watch /srv/atlas
```

The watcher performs an initial index by default, then debounces filesystem
events and uses a fallback git freshness poll so missed `fs.watch` events are
still caught. Rebuilds go through the existing cross-process lock, atomic
artifact publish, and content-hash parse cache. This keeps the implementation
simple: Codexa does not maintain a second partial graph writer, and MCP still
does not expose a manual mutation/reindex tool.

Useful automation flags:

```bash
codexa watch /srv/atlas --no-initial
codexa watch /srv/atlas --debounce-ms 500 --poll-ms 2000
codexa watch /srv/atlas --initial --max-runs 1
```

Use `--max-runs 1` for hooks or smoke tests that need one refresh and then exit.

## Static Analysis Integration

Codexa does not vendor Semgrep or CodeQL engines, rules, query packs, or CLI
bundles. The safe integration shape is report ingestion: run user-installed
tools separately, write Semgrep JSON or SARIF into `.codex/static-analysis/` or
`reports/`, and let Codexa convert those findings into `RiskSignal` facts during
indexing. This keeps Codexa dependency-light and leaves third-party license and
usage compliance with the tool installation that produced the report.

Import existing reports and reindex:

```bash
codexa static-analysis /srv/atlas \
  --semgrep-report /tmp/semgrep.json \
  --codeql-report /tmp/codeql.sarif
```

Optionally run locally installed scanners:

```bash
codexa static-analysis /srv/atlas --run-semgrep --semgrep-config p/default
codexa static-analysis /srv/atlas --run-codeql --codeql-language javascript-typescript python
```

Those scanner runs are opt-in because they may be slow, may contact external
rule/query registries depending on tool configuration, and are governed by the
user's Semgrep/CodeQL installation and license terms.

Supported report locations include:

```text
.codex/static-analysis/risks.json
.codex/static-analysis/semgrep.json
.codex/static-analysis/codeql.sarif
reports/static-analysis/risks.json
reports/static-analysis/*.sarif
reports/semgrep.json
reports/codeql.sarif
codeql.sarif
semgrep.json
```

## Codex Setup

From a project root, run:

```bash
codexa init
```

That writes the project-local `.codex/config.toml` MCP entry, writes the
SessionStart hook, and creates the first `.codex/codebase/` index. After that,
a new Codex chat only needs:

```text
focus on /path/to/project
```

Codexa will be discovered from the project `.codex` config and its MCP tools
will auto-refresh stale generated context before answering.
The SessionStart hook prints the compact Codex contract instead of a generic
graph preview, so Codex knows the next tool to call without loading noisy
project context.

In the `/srv` workspace, the intended chat flow is:

```text
focus on the atlas project
```

If the project is already wired, Codex should run the lightweight Codexa
session-start check automatically. If a project is not wired yet, say:

```text
codexa init
```

Codex should initialize the current focused repo, then run the session-start
check.

## MCP Configuration

`codexa init` writes the local Codex MCP entry automatically. The generated
entry looks like:

```toml
[mcp_servers.codexa-atlas]
command = "node"
args = ["/srv/codexa/dist/cli.js", "serve", "/srv/atlas", "--auto-refresh"]
startup_timeout_sec = 10
tool_timeout_sec = 60
```

The server exposes only context tools. It does not apply patches or expose a
manual reindex/source-mutation tool, but context queries can auto-refresh the
generated `.codex/codebase/` cache when freshness checks prove it is missing or
stale. `change_plan` can also write a small task snapshot under
`.codex/cache/codexa-tasks/` when `saveSnapshot=true`; this snapshot is
used by `post_edit_review` to detect drift after Codex edits files. Refreshes
are guarded by a cross-process lock file under `.codex/cache/` and stale locks
are recovered before a new index is published.
MCP tools include structured output schemas and non-destructive annotations.
When auto-refresh is enabled, tools are source-read-only but not strictly
filesystem-read-only because they may update generated Codexa cache artifacts.
In that mode Codexa does not advertise context tools as `readOnlyHint: true`;
use `--no-auto-refresh` when the MCP host needs strict filesystem-read-only
tool metadata.

Candidate test commands include provenance such as `package.json` scripts or
Python test metadata. If Codexa cannot find provenance, it omits the command
instead of inventing one.

## Eval Harness

Run a structured benchmark against Atlas plus randomized synthetic holdouts:

```bash
node dist/cli.js eval /srv/atlas --suite all --seed "$(date +%s)"
```

The harness scores structured `QueryResult.data` rather than prose substrings.
Synthetic scenarios use seed-generated identifiers and decoy files, and eval
queries default to no auto-refresh so the benchmark does not silently reward
reindexing. Use an explicit `--seed` for reproducible trend lines and `--json`
for machine-readable metrics. Each scenario reports both raw-baseline discovery
and Codexa results against the same oracle: file recall, test recall,
precision@K, selected-file compression, and refresh behavior.

## SessionStart Hook

`codexa init` wires a repo-local SessionStart hook in `.codex/hooks.json`. See
`docs/guides/codex-sessionstart-hook.md` for details. The helper prints cheap
status by default; a bounded no-refresh context-pack preview is available by
setting `CODEXA_SESSIONSTART_CONTEXT=1`.

## Storage Layout

- `storage/` -> `/srv/storage/apps/codexa/storage`
- `data/` -> `/srv/storage/apps/codexa/data`
- `models/` -> `/srv/storage/models/codexa`
- `cache/` -> `/srv/storage/cache/codexa`
- `backups/` -> `/srv/storage/backups/codexa`

Keep source code, tests, docs, and configs in the repo tree. Keep large mutable
state in the linked storage paths above.
