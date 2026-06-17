# Codexa New User Tutorial

This tutorial walks through the first successful Codexa setup and edit loop.
It assumes you want Codexa to help an AI coding agent understand a local git
repository without sending source code to a hosted indexing service.

## What you will do

1. Install Codexa.
2. Wire Codexa into one local repository.
3. Check that the index and MCP server are ready.
4. Run the normal plan, edit, review, and verification loop for a small change.
5. Know where to look when setup is not ready.

## Before you start

Codexa requires Node.js 22 or newer and a local git checkout:

```bash
node --version
git -C /path/to/project status --short --branch
```

The project path should be the repository you want your agent to work on, not
the Codexa source checkout unless you are developing Codexa itself.

## 1. Install Codexa

Install the published package:

```bash
npm install -g @mirnoorata/codexa
codexa --version
```

Or run from a source checkout:

```bash
git clone https://github.com/mirnoorata/codexa.git
cd codexa
npm install
npm run build
npm link
codexa --version
```

## 2. Wire one repository

For Codex CLI, initialize the target repository:

```bash
codexa init /path/to/project
```

For Claude Code, add `--claude` so Codexa also writes a repo-root `.mcp.json`:

```bash
codexa init /path/to/project --claude
```

`codexa init` writes Codexa MCP configuration and hook files for the target
repo, then builds the first `.codex/codebase/` index. It does not edit your
source files. Generated Codexa artifacts live under `.codex/codebase/` and
`.codex/cache/`.

## 3. Check readiness

Start every new session with:

```bash
codexa session-start /path/to/project
```

A ready repository reports the repo path, the current commit, freshness, dirty
file count, parser error count, and the automatic-use loop. `fresh` means the
stored Codexa index matches the current checkout. `stale` usually means the
checkout changed since the last index, and most context commands can refresh it
automatically.

For a fuller setup check, run:

```bash
codexa doctor /path/to/project
```

Use `doctor` when the agent cannot see Codexa tools, the MCP server is not
starting, hooks did not run, or freshness looks wrong.

## 4. Use the everyday edit loop

Codexa is most useful when it brackets real edits. For a small issue such as
"rename this CLI option in the docs and help text", use this loop:

```bash
codexa brief /path/to/project --task "rename this CLI option in docs and help text"
codexa change-plan /path/to/project \
  --task "rename this CLI option in docs and help text" \
  --file README.md \
  --save-snapshot
```

Then make the source or docs edits with your normal editor or agent. Codexa MCP
tools do not edit source files.

After editing, review the real dirty tree against the saved plan:

```bash
codexa post-edit-review /path/to/project \
  --task "rename this CLI option in docs and help text"
```

If you have already run checks, report them so Codexa can reason about what the
commands proved:

```bash
codexa post-edit-review /path/to/project \
  --task "rename this CLI option in docs and help text" \
  --ran-command "npm run check"
```

If you are unsure what to run, ask for a targeted test plan:

```bash
codexa test-plan /path/to/project --diff
```

The same flow is available through MCP tools inside an agent host:

```text
session_context -> search(if target unclear) -> task_brief ->
change_plan(saveSnapshot) -> post_edit_review -> test_plan
```

## 5. What success looks like

After the loop, you should be able to answer four questions with evidence:

- Which files did Codexa tell the agent to read first?
- What edit scope did the saved change plan record?
- Did the dirty tree stay inside that planned scope?
- Which checks were run, and what behavior did they actually cover?

That evidence is the point of Codexa. It does not replace judgment, tests, or
code review; it makes the agent's context and verification claims easier to
inspect.

## Troubleshooting

If `codexa` is not found, confirm the npm global bin directory is on `PATH`, or
use the source-checkout flow with `npm link`.

If `session-start` reports `missing-index`, run:

```bash
codexa index /path/to/project
```

If MCP tools do not appear in Codex or Claude Code, rerun the matching init
command for that host and then restart the agent host:

```bash
codexa init /path/to/project            # Codex CLI
codexa init /path/to/project --claude   # Claude Code
```

If the wrong repository is being indexed, rerun commands with the explicit
target repo path and inspect the generated MCP config in that repository.

If a command output looks heuristic-heavy, treat it as a reading list rather
than proof. Open the cited files, run the relevant checks, and pass the actual
commands back to `post-edit-review`.

## Next steps

- Read the main [README](../../README.md) for commands, architecture, and
  limits.
- Read [Contributing](../../CONTRIBUTING.md) before opening a PR.
- Read [Codex SessionStart Hook](codex-sessionstart-hook.md) to understand the
  startup and edit hooks that `codexa init` writes.
