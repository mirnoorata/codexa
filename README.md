# Codexa

[![Check](https://github.com/mirnoorata/codexa/actions/workflows/check.yml/badge.svg)](https://github.com/mirnoorata/codexa/actions/workflows/check.yml)
[![npm](https://img.shields.io/npm/v/%40mirnoorata%2Fcodexa)](https://www.npmjs.com/package/@mirnoorata/codexa)

**Understand the code. See what a change could affect. Check the evidence.**

Codexa helps developers and AI coding assistants work on a repository with
more context and fewer guesses. It builds a local map of your code, connects
files to their dependencies and tests, and produces readable reports about
proposed and completed changes.

Think of it as a map and a change checklist for your project. The person—or
coding assistant—still drives. Codexa points out the bridge you might want to
check before taking the truck across it.

Use it from a terminal, with **Codex**, **Claude Code**, or another compatible
coding assistant, or in **GitHub Actions** to help review pull requests. The
core needs **no API key, hosted account, or database**. Codexa is free and
MIT-licensed; your AI assistant and any optional hosted services have their
own requirements and costs.

[Get started](#quick-start) · [Connect an assistant](#connect-your-coding-assistant) ·
[Everyday use](#the-everyday-workflow) · [GitHub reviews](#review-pull-requests) ·
[Troubleshooting](#troubleshooting) · [Full reference](docs/reference.md)

> **Maintainer expectations:** Codexa is a focused project maintained by one
> person in spare time. Expect replies in days to weeks. Please discuss larger
> changes before opening a PR; see [Contributing](CONTRIBUTING.md).

## What does it actually do?

| Your question | What Codexa gives you |
| --- | --- |
| “Where does this behavior live?” | Relevant files, functions, and exact text matches, with related code when useful. |
| “What might break if we change this?” | A map of connected code and tests that may be affected. |
| “What should we test?” | Suggested checks tied to the changed files and known relationships. |
| “Did the work stay within the plan?” | A comparison between a saved plan and the actual edits, including unexpected changes. |
| “What evidence supports this handoff?” | A **proof card**: a summary of the plan, verification evidence, and remaining gaps. |
| “What is this pull request changing?” | A **change receipt**: a report covering committed changes, possible impact, and review guidance. |

For example, changing a login timeout can affect more than one number. Codexa
can help locate the setting, identify code that uses it, suggest related tests,
and flag edits outside the agreed scope. Its findings depend on what it can
read and connect in your repository; it cannot predict every runtime behavior.

Codexa supplies context and checks. Your editor or assistant makes the edits,
and your project's tests establish whether the behavior works. A green-looking
report is useful evidence, not a force field.

## Quick start

You need **Node.js 22 or newer**, **npm** (included with Node.js), **Git**, and a
local Git repository—the project folder you want to inspect. You do not need
to clone Codexa itself or install an AI assistant to use the terminal commands.

### 1. Install

Run these commands in a terminal:

```bash
node --version
git --version
npm install -g @mirnoorata/codexa
codexa --version
```

### 2. Try it on your project

Replace `/path/to/project` with your repository's actual folder path. Quote the
path if it contains spaces. In the examples below, `.` means “this folder.”

```bash
cd /path/to/project
codexa index .
codexa repo-map .
```

`index` reads the repository and creates the local map. `repo-map` shows the
ranked files and modules. This terminal-only path needs no assistant setup.

Ask a question relevant to your project:

```bash
codexa search . --query "login timeout"
```

This is an example query, not a built-in demo: results depend on your code.
For ongoing use, follow the [generated-files guidance](#what-gets-written-to-your-repository)
and choose your assistant setup below.

**No global install?** Prefix commands with `npx -y @mirnoorata/codexa`, for
example `npx -y @mirnoorata/codexa index /path/to/project`. npm may download the
package; the default indexing itself runs locally.

## Connect your coding assistant

Codexa uses **MCP (Model Context Protocol)**, the connection that lets an AI
assistant ask external tools for information. The assistant runs the model;
Codexa provides repository context. Install and sign in to your chosen
assistant separately.

### Codex

From your project folder:

```bash
codexa init . --agents-md
codexa session-start .
```

This creates the index, adds the Codexa server to `.codex/config.toml`, installs
Codex startup/edit hooks, and adds a small managed workflow block to `AGENTS.md`.
Omit `--agents-md` if you want to manage your own agent instructions. If a
Codexa plugin already supplies your MCP connection, avoid registering a second
server for the same repository.

Open or reload that same project in Codex and trust it when prompted.
Project-scoped MCP configuration is loaded only for trusted projects. In
Codex CLI, `/mcp` shows active connections; see the
[official MCP setup guide](https://learn.chatgpt.com/docs/extend/mcp).

A successful `session-start` check confirms observable setup and index state;
it cannot prove that an already-running assistant has loaded the server.

**Windows:** use `codexa init . --agents-md --no-hooks` for native Windows
MCP-only setup. The generated shell hooks require a POSIX environment such as
WSL. macOS and Linux can use the standard command above.

### Claude Code

For the simplest connection:

```bash
codexa init . --claude --claude-md --no-hooks
codexa session-start .
```

This also writes the server entry to `.mcp.json` and workflow guidance to
`CLAUDE.md`. Restart Claude Code in that repository and approve the project MCP
server if prompted. `--no-hooks` disables Codexa's Codex hooks; this setup gives
Claude tools and instructions, without Claude hooks or slash commands.

Want automatic startup guidance, a review hook, and commands such as
`/codexa-plan` and `/codexa-review`? Use the bundled
[Claude Code plugin](integrations/claude-code/README.md#install). Choose either
the plugin or the `.mcp.json` connection above to avoid duplicate servers.

### Other MCP clients

Configure a local command server in your client's MCP settings:

```json
{
  "mcpServers": {
    "codexa": {
      "command": "codexa",
      "args": ["serve", "/path/to/project", "--auto-refresh"]
    }
  }
}
```

Replace the path and adapt the outer configuration format to your client.
The client must be able to find `codexa` and access the repository. It launches
the server; `serve` is not an interactive chat command.

Fresh installs expose three tools: `search`, `change_plan`, and `capabilities`.
That small menu is intentional: `capabilities` provides access to the remaining
operations. Use `--tools full` with `init` or `serve` if your client needs every
operation listed directly.

The default connection uses a local process. Optional HTTP transport binds
only to the local machine; Codexa does not ship a public remote server.

## The everyday workflow

**Use Codexa when it resolves uncertainty.** A small fix in a known file may
need only direct inspection and the project's normal tests. No ceremony is
required for changing a comma. A change spanning several files benefits more
from planning and review.

For a coding assistant, a useful request is:

> Find where login timeouts are handled. Use Codexa if the target or impact is
> unclear. Before a substantial edit, save a change plan. Make the change, run
> the relevant checks, and review the result against the plan. Tell me what
> remains unverified.

You can also run that workflow yourself. This example assumes your repository
has `src/auth.ts`; substitute a real file and task:

```bash
codexa change-plan . --task "Adjust the login timeout" --file src/auth.ts --task-id login-timeout --save-snapshot
```

Read the plan, make the edits, and run the checks appropriate to your project.
Then review the work **before committing**, while the edits are still visible
as local changes:

```bash
codexa post-edit-review . --task-id login-timeout
```

Report checks you actually ran with `--ran-command`. For example, **only if
`npm test` is a real check in your project and you ran it**:

```bash
codexa post-edit-review . --task-id login-timeout --ran-command "npm test"
```

That flag records a claim; it does not execute the command. Codexa checks
whether the reported command could cover the relevant work. A command that
hides failures, such as `npm test || true`, does not earn credit. Codexa cannot
detect a completely fabricated report.

For a formal handoff, `codexa prove . --task-id login-timeout` summarizes the
saved plan, available evidence, and unresolved gaps. Supply actual command
reports or selected verification artifacts when the handoff needs them.

Startup and edit hooks reduce manual steps, but their reviews do not replace
one final review with the actual test evidence. Detailed workflow, invariants,
and repeat-attempt controls are in the [reference](docs/reference.md#the-everyday-workflow).

### A few useful commands

Run these from the project root, using your own file names and questions:

| Command | Purpose |
| --- | --- |
| `codexa search . --query "password reset"` | Find a starting point. |
| `codexa explain . --file src/auth.ts` | Inspect a file and its relationships. |
| `codexa impact . --file src/auth.ts` | See what a change could affect. |
| `codexa diff-impact .` | Inspect the impact of uncommitted changes. |
| `codexa test-plan . --diff` | Get test suggestions for current edits. |
| `codexa status .` | Check freshness and parser errors without refreshing. |
| `codexa watch .` | Keep the index updated during a session; stop with Ctrl+C. |
| `codexa doctor .` | Diagnose local setup problems. |

Most context commands refresh an outdated index automatically. Use
`codexa --help`, `codexa <command> --help`, or the
[command reference](docs/reference.md#main-commands) for more options.

## Review pull requests

Codexa can generate a report for a committed branch without an AI assistant.
From a **clean checkout of that branch**, with `origin/main` available locally:

```bash
git fetch origin
codexa review . --base origin/main --head HEAD
codexa review . --base origin/main --head HEAD --format json
```

Replace `origin/main` if your repository uses a different base branch. Codexa
compares changes since the branches' common ancestor. `HEAD` must match the
checked-out commit, and the index must represent that clean checkout.

To add the same review to GitHub Actions:

```bash
codexa init . --ci
```

Review and commit the generated `.github/workflows/codexa-review.yml` with your
normal PR process. It checks out the PR's exact head, uses read-only repository
permissions, and writes results to the Actions summary and annotations. It
does not post PR comments or run your project's tests. Keep your existing CI.

The default `observe` mode reports findings without blocking on them. `warn`
adds warning annotations. Explicit `fail` mode can block on local plan drift,
an unavailable requested local plan, or reported command failures. Suggested
but unrun tests alone do not fail the review. Invalid inputs and setup errors
can fail in any mode.

See [committed change receipts](docs/reference.md#committed-change-receipts)
for plan comparison, trust limits, and CI options.

## What gets written to your repository?

| Location | Contents | Usual Git treatment |
| --- | --- | --- |
| `.codex/codebase/` | Generated maps, relationships, and index. | Ignore; regenerate per checkout. |
| `.codex/cache/` | Saved plans, session notes, review state, and optional caches. | Ignore; keep local evidence private. |
| `.codex/static-analysis/` | Imported or explicitly generated scanner reports. | Ignore. |
| `.codex/config.toml`, `.codex/hooks.json` | Codex connection and hooks from `init`. | Usually local; share deliberately. |
| `.mcp.json` | Claude connection, when requested. | Inspect paths and existing servers before sharing. |
| `AGENTS.md`, `CLAUDE.md` | Managed workflow block, only with the corresponding flag. | Share if useful to your team. |
| `.codex/policies/` | Optional JSON policies for proof cards. | Share if they express team policy. |
| `.github/workflows/codexa-review.yml` | Optional GitHub Actions review. | Commit to enable it. |

Add these generated paths to your project's `.gitignore` (Codexa does not add
them for you):

```gitignore
.codex/codebase/
.codex/cache/
.codex/static-analysis/
```

If your MCP config and hooks are local to your machine, ignore those files too.
Avoid ignoring the entire `.codex/` directory if your team tracks policies or
setup scripts there. Inspect generated launch paths before committing wiring;
`init` supports portable wiring for already-tracked files. Each teammate and
fresh checkout still needs its own install and index.

Re-running `init` refreshes Codexa's managed configuration and preserves other
MCP server entries. Optional instruction blocks replace only the region between
Codexa's markers. `--policy-pack` creates local proof policies without
replacing existing policy files. See the
[setup reference](docs/reference.md#codex-project-worktrees-and-local-setup)
for portability and managed-file behavior.

## Support, privacy, and limits

- **Language support:** TypeScript, JavaScript, and Python get the deepest
  parsing. Rust, Go, and Java get shallower declarations and relationships.
  Other recognized files receive lighter facts. External symbol reports can
  extend coverage; this is not full compiler-level understanding of every language.
- **Coverage:** Codexa reads supported Git-visible files, including unignored
  new files. It skips common generated/dependency directories and source files
  larger than 2 MiB. Impact analysis follows at most three relationship steps;
  dynamic behavior and large repositories can need additional investigation.
- **Privacy:** Default indexing and queries run locally without model calls.
  Context returned to an AI assistant is handled under that assistant's data
  policy. Optional OpenAI embeddings send selected source text and queries to
  OpenAI; optional TypeSafe reranking sends queries and candidate source snippets
  to TypeSafe. Both are off by default.
- **Execution:** MCP tools can update Codexa's generated state, but do not edit
  your source files or run verification commands. Optional **AutoVerify** lets
  edit hooks run selected local checks after explicit user-owned configuration.
  It is off by default and is not a sandbox.
- **Evidence:** Directly observed facts, inferred relationships, and guesses
  carry different confidence labels. Reported verification is distinguished
  from AutoVerify execution. A proof card records evidence and gaps; it does
  not certify that your code is correct or secure.

There is no web dashboard or hosted indexing service to operate. Optional
embeddings, TypeSafe, language-server assistance, scanner imports, session
memory, and AutoVerify are documented in the
[reference](docs/reference.md#optional-lanes).

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| `codexa` is not found | Reopen your terminal, check npm's global executable directory is on `PATH`, or use the `npx` alternative. |
| Installation fails building a native dependency | Check Node.js is 22+; Tree-sitter dependencies may need your platform's native build tools when a prebuilt binary is unavailable. |
| The assistant cannot see Codexa | Run `codexa doctor .`, confirm the repository path, then reload that project in the assistant. In Codex, check project trust and `/mcp`. |
| “Current-thread MCP: unverified” | The CLI cannot inspect your assistant's live connection. Check the assistant's active server list; this alone is not an installation failure. |
| Missing, stale, or mismatched index | Run `codexa index .` in the actual checkout. Never copy an index from another worktree. |
| Parser errors or missing relationships | Check `codexa status .`, language support, ignored files, and source-size limits. A degraded result is incomplete evidence. |
| Committed review refuses to run | Resolve local changes, check out the requested head, and rebuild the index. Use `post-edit-review` for uncommitted edits. |
| Hooks fail on native Windows | Re-run `init` with `--no-hooks` for MCP-only use, or use WSL for shell hooks. |

### Updating or removing Codexa

Update with `npm install -g @mirnoorata/codexa@latest`, re-run your chosen `init`
command in each repository, and reload the assistant connection. Reuse optional
flags such as `--claude` or `--agents-md` to refresh those integrations. Plain
`init` preserves the existing tool profile; use `--tools core` to switch it.

To remove Codexa, first disable its server/plugin and remove only its managed
config entries, hooks, and instruction blocks. Preserve other tools' settings.
Then run `npm uninstall -g @mirnoorata/codexa`. Generated indexes can be removed;
export any plans or evidence you want to keep before deleting `.codex/cache/`.
Remove its CI workflow too if you enabled one. There is no all-in-one uninstall
command.

## Codex Project Worktrees And Local Setup

A Git worktree is another checkout of the same repository. Run `codexa init`
inside each one so its configuration and index match its own code. Automate
that step in your project's setup if you create worktrees frequently.

When **developing Codexa itself**, this repository includes a Codex local
environment and bootstrap scripts that install locked dependencies, build the
package, and verify worktree setup. Those scripts are for this repository;
ordinary users do not need to copy them. See the
[worktree and recovery guide](docs/reference.md#codex-project-worktrees-and-local-setup).

## For contributors and curious readers

Codexa's engine is TypeScript. Its main path is:

```text
Repository → local index → relevant context and change analysis → evidence report
```

| Area | Where to look |
| --- | --- |
| Installation and commands | [`src/init.ts`](src/init.ts), [`src/cli.ts`](src/cli.ts) |
| File discovery, parsing, and relationships | [`src/indexer/`](src/indexer/), [`src/parser/`](src/parser/), [`src/resolver.ts`](src/resolver.ts), [`src/graph.ts`](src/graph.ts) |
| Search, plans, review, and test evidence | [`src/query/`](src/query/), [`src/prove.ts`](src/prove.ts) |
| Assistant tools and local session state | [`src/mcp/`](src/mcp/), [`src/session-memory/`](src/session-memory/) |
| Host integrations and CI | [`plugins/codexa/`](plugins/codexa/), [`integrations/claude-code/`](integrations/claude-code/), [`action.yml`](action.yml) |
| Verification and packaging | [`tests/`](tests/), [`scripts/`](scripts/) |

To build from source:

```bash
git clone https://github.com/mirnoorata/codexa.git
cd codexa
npm ci
npm run build
npm link
npm run check
```

`npm link` makes this checkout's `codexa` command available locally; skip it if
you prefer `node dist/cli.js`. The full gate builds and type-checks the package,
checks hygiene and public paths, runs tests, and checks the startup context
budget. See [Contributing](CONTRIBUTING.md) and the
[architecture reference](docs/reference.md#architecture-for-engineers).

### Public Proof

The repository includes reproducible retrieval evaluations and an agent A/B
harness. These measure different things: finding useful context does not by
itself prove that an assistant finishes tasks faster or better. An archived
small agent pilot showed extra overhead without a completion benefit; it is
not evidence of universal savings. Results, dates, caveats, and reproduction
commands are kept in [Public Proof](docs/reference.md#public-proof).

### Release Automation

Maintainers use Release Please to prepare version/changelog PRs and GitHub
Releases. npm publishing follows a published release through GitHub Actions
and trusted publishing. Ordinary feature merges do not each publish a package.
See [release automation](docs/reference.md#release-automation),
[npm publishing and recovery](docs/reference.md#npm-package-publishing), and the
[public release checklist](docs/PUBLIC_RELEASE_CHECKLIST.md).

## Help and license

Use [Discussions](https://github.com/mirnoorata/codexa/discussions) for questions
and [Issues](https://github.com/mirnoorata/codexa/issues) for reproducible bugs.
Report vulnerabilities through
[private security advisories](https://github.com/mirnoorata/codexa/security/advisories/new);
see [SECURITY.md](SECURITY.md).

Codexa is licensed under [MIT](LICENSE).
