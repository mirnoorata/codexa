# Codexa

> **Maintainer expectations**
>
> Codexa is maintained by one person, in spare time, with a deliberately narrow
> scope. That shapes how this repo works:
>
> - **Response times are days to weeks, not hours.** Pinging for faster triage
>   will not make it faster.
> - **Scope is narrow on purpose.** New language indexers, new LLM-based
>   layers, and general-purpose search modes are usually closed as out of
>   scope even when they are clearly useful somewhere else. See
>   [CONTRIBUTING.md](CONTRIBUTING.md) for the exact scope.
> - **Not every working PR will be merged.** Please open an issue first for
>   anything beyond a typo or docs fix. A rejected PR after an "issue-first"
>   conversation is rare; a rejected PR without one is common.
> - **Security issues go through
>   [private advisories](https://github.com/mirnoorata/codexa/security/advisories/new),
>   not public issues.** See [SECURITY.md](SECURITY.md) for SLAs and scope.
> - **Questions and "is this the right tool" discussions belong in
>   [Discussions](https://github.com/mirnoorata/codexa/discussions), not the
>   issue tracker.**

Codexa is a Codex-native codebase intelligence compiler. It indexes a target
repository, writes concise `.codex/codebase/` artifacts for Codex to read, and
serves focused MCP context tools over stdio.

## V1 Scope

- TypeScript CLI and MCP server.
- Tree-sitter parsing for TypeScript, TSX, JavaScript, JSX, and Python, plus
  lightweight indexing for JSON manifests, Markdown/MDX/RST/text docs,
  `scripts/*.sh`, and `.service` files.
- In-memory relationship graph persisted as `.codex/codebase/index.json`,
  `.codex/codebase/freshness.json`, and `.codex/codebase/facts.ndjson`.
- Codex-first artifacts for repo maps, risk, placeholder findings, tests,
  conventions, and freshness.
- MCP context tools: `repo_map`, `find_context`, `search`, `symbol_context`, `impact`,
  `diff_impact`, `placeholder_report`, `test_plan`, `task_brief`,
  `context_pack`, `focus_brief`, `session_context`, `callers`, `callees`,
  `dependency_path`, `workflow_path`, `change_plan`, `post_edit_review`, and
  `freshness`.
- MCP resources for generated `.codex/codebase/` artifacts and MCP prompts
  (`impact_before_edit`, `dirty_diff_review`, `snapshot_edit_loop`, and
  `targeted_test_plan`) for common Codex workflows before edits,
  dirty-diff review, and test planning.
- A generated `.codex/codebase/codex-contract.md` that gives Codex a deterministic
  automatic-use contract for session start, pre-edit snapshots, post-edit drift
  review, workflow tracing, dependency checks, and final test planning.
- Generic relationship hints for package manifests, TypeScript project/path
  configuration, changed symbols, route/job/test surfaces, and candidate test
  commands with provenance. Project-specific rules belong in local fixtures or
  private forks, not in public setup instructions.
- Import-aware symbol binding for TypeScript/Python aliases and namespace/member
  calls so impact analysis can follow `import { x as y }`, `import * as ns`, and
  `from .module import x as y` usage without treating every match as a raw string.
  TypeScript source imports that name emitted `.js` files resolve back to `.ts`
  and `.tsx` sources.
- Offline TypeScript compiler assist strengthens default exports, aliased
  re-exports, type-only exports, JSX/createElement references, object literal
  methods, project references, and path alias metadata without running an LSP
  daemon.
- Optional read-only LSP assist for TypeScript, JavaScript, and Python can be
  enabled with `--lsp` or `CODEXA_LSP=1`. It queries a stdio language server for
  document symbols, definitions, references, and diagnostics, fails open when no
  server is configured, and never edits source files.
- Python package/static analysis resolves relative imports, `__init__.py`
  re-exports, pytest fixture dependencies, class base references, and generic
  FastAPI/Celery/Pydantic/SQLAlchemy hints with heuristic labels where runtime
  framework behavior cannot be proven statically.
- A small built-in structural rule pack that emits bounded risk signals for shell
  execution, filesystem writes, MCP tool surfaces, raw HTML sinks, and SQL
  execution boundaries without adding Semgrep/ast-grep as runtime dependencies.
- Built-in placeholder/dummy detection that indexes TODO/stub comments,
  not-implemented bodies, no-op bodies, dummy data, and placeholder literals as
  bounded risk signals. Test, docs, and generated contexts are downweighted and
  filtered from the default placeholder report.
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
- Automatic semantic retrieval stores embeddings in
  `.codex/cache/codexa-semantic-v1/` after `codexa semantic-index <repo>`.
  After that one-time setup, normal query commands decide whether to use the
  semantic lane from cache/provider readiness; `--semantic` is only a
  force/debug override. Providers are OpenAI embeddings or an explicit local
  JSONL embedding command. Codexa still ships no vector database and does not
  call embedding providers unless a semantic cache and provider configuration
  are present, or semantic retrieval is explicitly forced.
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
  unplanned files, risk/workflow signals, placeholder risk deltas, and tests
  still unaccounted for.
- Local diagnostics: `codexa doctor` checks repo wiring, index freshness,
  generated artifacts, hook setup, and the latest structured hook event.
- `codexa init` also writes lightweight edit hooks when supported by Codex
  hooks: `hook-pre-edit` reminds Codex when a non-trivial edit lacks a saved
  change-plan snapshot, and `hook-post-edit` runs a bounded post-edit review.
  The post-edit hook also runs narrowly targeted safe test commands inferred
  from the review packet, captures structured command reports, and feeds those
  reports into the persisted outcome without user-supplied `--ran-command`
  input.
  These hooks are advisory and fail open: setup/query errors print a bounded
  unavailable message and exit successfully so editor tool calls are not
  blocked. Hook runs write compact local JSONL diagnostics under ignored
  `.codex/cache/codexa-hooks/` state. Each successful review writes a compact
  outcome record under `.codex/cache/codexa-outcomes/`; eval runs summarize
  those outcomes under `.codex/cache/codexa-evals/`.
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
- Codex plugin packaging under `plugins/codexa/`: the package includes a Codexa
  skill, plugin manifest, and MCP wrapper so Codex plugin installs can discover
  the same local context workflow.
- No graph DB, vector DB, web UI, formal solver, always-on LSP daemon, or
  source-mutating MCP tools.

## Commands

Examples use `<repo>` for the target repository root. Replace it with the
absolute path of the repository you want Codexa to index.

```bash
npm install
npm run build
npm test
npm run smoke:package
npm run benchmark:ci

node dist/cli.js init <repo>
node dist/cli.js session-start <repo>
node dist/cli.js hook-pre-edit <repo>
node dist/cli.js hook-post-edit <repo>
node dist/cli.js index <repo>
node dist/cli.js semantic-index <repo> --provider openai
node dist/cli.js semantic-index <repo> --provider local-command --command ./embed-jsonl
node dist/cli.js watch <repo>
node dist/cli.js static-analysis <repo> --semgrep-report /tmp/semgrep.json --codeql-report /tmp/codeql.sarif
node dist/cli.js doctor <repo>
node dist/cli.js doctor <repo> --json
node dist/cli.js status <repo>
node dist/cli.js repo-map <repo> --budget 1200
node dist/cli.js find-context <repo> --query "auth middleware"
node dist/cli.js explain <repo> --file src/app.ts --lsp
node dist/cli.js explain <repo> --symbol usePolling --lsp
node dist/cli.js search <repo> --query usePolling
node dist/cli.js placeholder-report <repo> --limit 20
node dist/cli.js placeholder-report <repo> --include-tests --include-docs --include-generated
node dist/cli.js impact <repo> --file src/app.ts --change-type api
node dist/cli.js diff-impact <repo>
node dist/cli.js test-plan <repo> --diff
node dist/cli.js brief <repo> --task "Update polling safely" --change-type behavior
node dist/cli.js context-pack <repo> --task "Update polling safely" --change-type behavior
node dist/cli.js focus-brief <repo> --task "How does queue polling work?"
node dist/cli.js session-context <repo> --task "Start a Codex session"
node dist/cli.js callers <repo> --symbol usePolling
node dist/cli.js callees <repo> --file src/App.tsx
node dist/cli.js dependency-path <repo> --from-file src/App.tsx --to-file src/features/use-polling.ts
node dist/cli.js workflow-path <repo> --query "queue workflow"
node dist/cli.js change-plan <repo> --task "Change polling behavior safely" --file src/features/use-polling.ts --save-snapshot --task-id polling-update --lsp
node dist/cli.js post-edit-review <repo> --task-id polling-update --ran-command "npm run check"
node dist/cli.js post-edit-review <repo> --task-id polling-update --ran-command-report '{"command":"npm run check","exitCode":0,"cwd":"<repo>","packageManager":"npm","packageRoot":".","scriptName":"check","args":[],"durationMs":1200,"stdoutSummary":"typecheck and tests passed"}'
node dist/cli.js post-edit-review <repo> --task-id polling-update --ran-test src/features/use-polling.test.ts
node dist/cli.js post-edit-review <repo> --task-id polling-update --waiver '{"kind":"test","target":"src/features/use-polling.test.ts","reason":"covered by manual browser regression"}'
node dist/cli.js post-edit-review <repo> --task-id polling-update --waive-check src/features/use-polling.test.ts
node dist/cli.js eval <repo> --suite all --seed codexa-v1-benchmark
node dist/cli.js github-sync-check <codexa-checkout>
node dist/cli.js serve <repo>
```

The public package name for the Codex-focused release is `@mirnoorata/codexa`; the
installed command remains `codexa`:

```bash
npm install -g @mirnoorata/codexa
codexa init <repo>
npx -y @mirnoorata/codexa serve <repo> --auto-refresh
```

In the commands above, substitute `<repo>` with the absolute path of the
repository you are indexing.

Context commands refresh stale or missing `.codex/codebase/` artifacts by default
before answering. Use `--no-auto-refresh` on `repo-map`, `find-context`,
`search`, `placeholder-report`, `explain`, `impact`, `diff-impact`,
`test-plan`, `brief`, `context-pack`, `focus-brief`, `session-context`,
`callers`, `callees`, `dependency-path`, `workflow-path`, `change-plan`,
`post-edit-review`, or `serve` when you need to inspect the stored index without
rewriting it.

After `npm link`, the same commands are available as `codexa ...`.

Semantic retrieval is a two-step installed capability. First build the cache:

```bash
codexa semantic-index <repo> --provider openai
codexa semantic-index <repo> --provider local-command --command ./embed-jsonl
```

After that, `find-context`, `search`, `brief`, `context-pack`, `focus-brief`,
`session-context`, `workflow-path`, `change-plan`, and `serve` use the semantic
lane automatically when the cache snapshot matches and the provider can embed
the query. OpenAI uses `OPENAI_API_KEY` and defaults to
`text-embedding-3-small`. `local-command` receives JSONL on stdin with
`{id,text,model,dimensions}` and must return JSON, JSONL, or
`{embeddings:[...]}` records containing `{id,embedding}`. Use `--semantic` only
to force diagnostics when auto-detection would skip the lane, and
`--no-semantic` to disable it for a single call. If the cache is missing, stale,
or provider settings do not match during forced use, Codexa reports the semantic
lane as unavailable and returns normal non-semantic context.

LSP assist is also opt-in. Pass `--lsp` to `explain`, `brief`, `context-pack`,
`change-plan`, or `serve`, or set `CODEXA_LSP=1`. Codexa discovers
`typescript-language-server --stdio`, `basedpyright-langserver --stdio`, or
`pyright-langserver --stdio` when available. You can override discovery with
`CODEXA_LSP_TYPESCRIPT_COMMAND`, `CODEXA_LSP_TYPESCRIPT_ARGS_JSON`,
`CODEXA_LSP_JAVASCRIPT_COMMAND`, `CODEXA_LSP_JAVASCRIPT_ARGS_JSON`,
`CODEXA_LSP_PYTHON_COMMAND`, and `CODEXA_LSP_PYTHON_ARGS_JSON`.

To prepare a functional `codera` package for name parking, run:

```bash
npm run build
npm run prepare:codera-parking
npm pack .local/release/codera --dry-run
```

Publish `.local/release/codera` only from the intended npm account after
reviewing the generated package. It ships the same working MCP server with
`codera` and `codexa` command aliases; it is not an empty placeholder.

## Live Indexing

For active Codex edit sessions, run:

```bash
codexa watch <repo>
```

The watcher performs an initial index by default, then debounces filesystem
events and uses a fallback git freshness poll so missed `fs.watch` events are
still caught. Rebuilds go through the existing cross-process lock, atomic
artifact publish, and content-hash parse cache. This keeps the implementation
simple: Codexa does not maintain a second partial graph writer, and MCP still
does not expose a manual mutation/reindex tool.

Useful automation flags:

```bash
codexa watch <repo> --no-initial
codexa watch <repo> --debounce-ms 500 --poll-ms 2000
codexa watch <repo> --initial --max-runs 1
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
codexa static-analysis <repo> \
  --semgrep-report /tmp/semgrep.json \
  --codeql-report /tmp/codeql.sarif
```

Optionally run locally installed scanners:

```bash
codexa static-analysis <repo> --run-semgrep --semgrep-config p/default
codexa static-analysis <repo> --run-codeql --codeql-language javascript-typescript python
```

Those scanner runs are opt-in because they may be slow, may contact external
rule/query registries depending on tool configuration, and are governed by the
user's Semgrep/CodeQL installation and license terms.
Codexa runs these optional scanner commands with a scrubbed environment:
credentials and service tokens from the Codexa shell are not forwarded. If a
scanner needs authenticated cloud behavior, run that scanner yourself and import
the generated report instead.

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

## GitHub Source Sync

Codexa treats GitHub source sync as normal git transport, not as a package
registry action. The GitHub Packages page is only relevant later if Codexa is
published as an npm package or container image. It is not needed to push source
code.

Run this diagnostic when a local Codexa repository and GitHub repository appear
out of sync:

```bash
codexa github-sync-check <codexa-checkout>
codexa github-sync-check <codexa-checkout> --no-network
```

The command checks the current branch, local HEAD, GitHub remote URL, remote
branch visibility, `git push --dry-run`, and optional `gh auth status`. It sets
`GIT_TERMINAL_PROMPT=0` so failures are explicit instead of hanging on a hidden
credential prompt.

Important boundary: the Codex GitHub connector can inspect repositories and make
small GitHub API changes, but it does not provide shell credentials for local
`git push`. For full source sync, authenticate normal git access with SSH, a
credential manager, or `gh auth login`, then push from the shell. If the remote
branch contains only a bootstrap placeholder commit, inspect it first and replace
it intentionally with `git push --force-with-lease`.

## Public Release Hygiene

Codexa is designed to work without publishing machine-local paths, private
project names, service URLs, credentials, generated indexes, or session memory.
Run the privacy gate before any release-oriented push:

```bash
npm run privacy
npm run check
```

The privacy gate scans tracked files for publish-blocking environment markers
such as local workspace paths, local home paths, non-example Codexa GitHub
remotes, GitHub tokens, and private key blocks. It deliberately scans tracked
files only; ignored generated artifacts and local caches should stay ignored.

Push CI runs the deterministic development gate, verifies the packed npm
tarball from a temporary install, and records a hot-path benchmark artifact:

```bash
npm run check
npm run smoke:package
npm run benchmark:ci
```

`smoke:package` runs `npm pack --json`, installs the generated tarball into a
temporary consumer project, then exercises the installed `codexa` binary,
repo initialization, advisory hooks, and MCP startup. `benchmark:ci` rebuilds
`dist/`, indexes the checkout, measures CLI and MCP hot paths with generous
CI thresholds, writes `.codex/cache/codexa-benchmarks/latest.json`, and appends
a Markdown summary when `GITHUB_STEP_SUMMARY` is available.

Release-oriented security checks remain available locally and should be run
before publication or visibility changes:

```bash
npm run security:check
```

## GitHub Release Timeline

Use GitHub Releases as the visible source timeline for the current project. The
release command derives the project display name from the target repo's
`package.json` name, falling back to the repo directory, then creates an
annotated source tag, pushes `main` and the tag, and creates or updates the
GitHub Release for that tag:

```bash
npm run release:github:dry-run -- --tag v0.2.0
npm run release:github -- --tag v0.2.0
```

The dry run shows what would be tagged and pushed. The real command runs
`security:check` first, refuses dirty working trees and non-`main` releases by
default, disables hidden git credential prompts, and writes release notes with:

- a compare link from the previous `v*` release tag
- a changelog-style summary grouped by commit purpose
- a changed-area summary grouped by touched file paths
- commands to restore a clean checkout from GitHub at the exact release tag
- commands to branch or add a worktree at the exact release
- forward-only PR rollback commands using `git revert --no-commit <tag>..HEAD`
- raw changed-file stats and commit subjects for auditability

For future Codexa changes, ship code to GitHub before cutting the release:
finish on a named branch, push the branch, merge through the normal GitHub
flow, then run the release command from a clean `main`. After publishing,
verify the remote tag and release entry:

```bash
git ls-remote --tags origin refs/tags/v0.2.0
gh release view v0.2.0 --repo mirnoorata/codexa --json tagName,name,url,targetCommitish
```

Local `codexaPublish` wraps that flow. If the current PR branch is dirty, it
creates one source commit first, pushes that branch, waits for PR checks,
squash-merges through GitHub, bumps the version, and then runs
`release:github`. Pass `--commit-message "Subject"` when the default generated
source-commit subject would be too vague. Pass `--no-source-commit` to require a
clean tree.

If you need notes without mutating git or GitHub, run:

```bash
codexa github-release . --tag v0.2.0 --notes-file /tmp/project-v0.2.0-notes.md --no-push --no-github-release
```

If sensitive identifiers were already pushed to a private remote, a clean public
release requires rewriting git history before the repository is made public.
Adding a sanitizing commit is not enough because old commits remain visible once
the repository visibility changes.

Use this stricter gate before changing repository visibility:

```bash
npm run privacy:release
```

`privacy:release` includes `privacy:history`, which scans every reachable
commit. It is expected to fail until the private development history has been
replaced by sanitized public history.

To prove that the current `HEAD` can be exported as a clean fresh-history
release without changing the working repo, run:

```bash
npm run public:snapshot-check
```

That command builds a temporary one-commit repository from `git archive HEAD`,
then runs current-file, history, and source-hygiene gates inside the temporary
repo. It requires a clean working tree so the verified snapshot exactly matches
the committed source.

Before creating a public source archive, remove local generated artifacts and
export from git rather than from the working directory:

```bash
npm run clean:private-artifacts
npm run release:archive
```

`release:archive` uses `git archive HEAD`, so ignored local files are not
included in the package.

## Codex Setup

From a project root, run:

```bash
codexa init
```

That writes the project-local `.codex/config.toml` MCP entry, writes the
SessionStart hook, and creates the first `.codex/codebase/` index. After that,
a new Codex chat only needs:

```text
focus on <repo>
```

Codexa will be discovered from the project `.codex` config and its MCP tools
will auto-refresh stale generated context before answering.
The SessionStart hook prints the compact Codex contract instead of a generic
graph preview, so Codex knows the next tool to call without loading noisy
project context.

If the project is already wired, Codex should run the lightweight Codexa
session-start check automatically. If a project is not wired yet, say:

```text
codexa init
```

Codex should initialize the current focused repo, then run the session-start
check.

The npm package also ships a Codex plugin bundle at `plugins/codexa/`. The
plugin contains the Codexa skill, plugin manifest, and a small MCP wrapper that
resolves the focused git repository from `CODEXA_REPO`, Codex workspace
environment variables, the current directory, or a workspace root with
`.codex/WORKING.md`, then launches the bundled Codexa MCP server.

## MCP Configuration

`codexa init` writes the local Codex MCP entry automatically. The generated
entry looks like:

```toml
[mcp_servers.codexa-project]
command = "npx"
args = ["-y", "@mirnoorata/codexa", "serve", "<repo>", "--auto-refresh"]
startup_timeout_sec = 10
tool_timeout_sec = 60
```

Local source checkouts can still use the direct Node form:

```toml
[mcp_servers.codexa-project]
command = "node"
args = ["<codexa-checkout>/dist/cli.js", "serve", "<repo>", "--auto-refresh"]
startup_timeout_sec = 10
tool_timeout_sec = 60
```

If an MCP host starts Codexa from a workspace root, `codexa serve
<workspace-root>` resolves the active repository from
`<workspace-root>/.codex/WORKING.md` before falling back to the workspace git
root. The preferred compact marker is:

```markdown
## Active Focus

- Project: `/absolute/path/to/repo`
```

The legacy `Focused project: /absolute/path/to/repo` line is still supported.
The resolver is checked on each tool/resource call, so changing the focused
project updates MCP routing without restarting the server. Use
`--workspace-focus-file <path>` or `CODEXA_WORKSPACE_FOCUS_FILE` when the focus
marker lives somewhere else. Focus-file targets must stay inside the configured
workspace root. `CODEXA_REPO` and `CODEXA_FOCUSED_REPO` are fallback inputs for
non-git launch roots and explicit escape hatches for out-of-tree repos; they do
not override an explicit git repository argument.

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
tool metadata. If OpenAI semantic embeddings are enabled for the MCP server,
semantic-capable context tools advertise `openWorldHint: true`.

Generated artifacts are also exposed as MCP resources:
`codexa://repo/codebase/README.md`,
`codexa://repo/codebase/codex-contract.md`,
`codexa://repo/codebase/repo-map.md`,
`codexa://repo/codebase/risk-map.md`,
`codexa://repo/codebase/placeholder-map.md`,
`codexa://repo/codebase/test-map.md`,
`codexa://repo/codebase/conventions.md`,
`codexa://repo/codebase/workflows.md`,
`codexa://repo/codebase/playbooks/README.md`, and
`codexa://repo/codebase/freshness.json`. Module and playbook entries are
available through the `codexa://repo/codebase/modules`,
`codexa://repo/codebase/modules/{name}`, and
`codexa://repo/codebase/playbooks/{name}` resource paths.

Candidate test commands include provenance such as `package.json` scripts or
Python test metadata. If Codexa cannot find provenance, it omits the command
instead of inventing one.
Post-edit review accepts both `--ran-test` for direct test/accounting entries
and `--ran-command` for aggregate verification commands. The generated
`hook-post-edit` path attempts AutoVerify first: it runs only targeted test
commands whose package script and runner shape are allowlisted, then passes the
captured command report into the final review. Use
`--ran-command-report` when you have structured execution evidence such as
`cwd`, package manager, package/workspace scope, script name, args, `exitCode`,
`durationMs`, and short stdout/stderr summaries. Codexa records these command
envelopes in post-edit outcomes and mirrors them under
`verificationCoverage.commandEnvelope` when a command contributes coverage.
Reported envelope fields are used for coverage only when they match the command
text, so spoofed package managers or package scopes fall back to raw command
inference and remain visible as unknown evidence. Failed or malformed command
reports do not satisfy verification coverage. Accepted envelope fields are
`command`, `cwd`, `packageManager`, `workspace`, `packageRoot`, `packageName`,
`scriptName`, `args`, `exitCode`, `durationMs`, `stdoutSummary`,
`stderrSummary`, and `outputSummary`. Prefer structured
`--waiver` JSON for explicit waivers; `--waive-check` remains as a legacy
test-target shortcut and does not waive workflow or dependency checks.

## Eval Harness

Run a structured benchmark against a target project plus randomized synthetic holdouts:

```bash
node dist/cli.js eval <repo> --suite all --seed "$(date +%s)"
```

The harness scores structured `QueryResult.data` rather than prose substrings.
Synthetic scenarios use seed-generated identifiers and decoy files, and eval
queries default to no auto-refresh so the benchmark does not silently reward
reindexing. Use an explicit `--seed` for reproducible trend lines and `--json`
for machine-readable metrics. Each scenario reports both raw-baseline discovery
and Codexa results against the same oracle: file recall, test recall,
precision@K, selected-file compression, and refresh behavior.
Suites are `all`, `project`, `synthetic`, `historical-fixture`, and `task-pack`;
external historical fixtures can be passed with `--task-pack <path>`. By
default, `--fail-on-refresh` marks a scenario failed if a query refreshes while
scoring; use `--no-fail-on-refresh` only when refresh behavior is the thing you
are measuring.

## SessionStart Hook

`codexa init` wires a repo-local SessionStart hook in `.codex/hooks.json`. See
`docs/guides/codex-sessionstart-hook.md` for details. The helper prints cheap
status by default; a bounded no-refresh context-pack preview is available by
setting `CODEXA_SESSIONSTART_CONTEXT=1`. Generated edit hooks are advisory:
`hook-pre-edit` and `hook-post-edit` exit successfully even when their local
context check is unavailable. The generated helper entry points are
`session-start`, `hook-pre-edit`, and `hook-post-edit`; normal users usually
reach them through Codex hooks rather than invoking them directly.

Hook diagnostics are written locally to `.codex/cache/codexa-hooks/events.ndjson`
and summarized by `codexa doctor <repo>`. The log is ignored state, bounded, and
intended for answering whether a hook ran, skipped a duplicate tree, or failed
open.

## Local State

Keep source code, tests, docs, and configs in the repo tree. Keep generated
artifacts, caches, private reports, local storage, and machine-specific config
out of git. Use ignored paths such as `.codex/cache/`, `.codex/codebase/`, and
`.local/` for local-only state.
