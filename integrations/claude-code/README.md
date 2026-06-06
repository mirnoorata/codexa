# Codexa for Claude Code

Ships Codexa's edit-safety loop into Claude Code the way it already ships into
Codex. One install, both tools wired to the same engine and the same
`<repo>/.codex/` state.

## What it does

When Claude Code is running in a Codexa-wired repo (one that contains
`<repo>/.codex/config.toml`), this plugin:

- **SessionStart** — injects a short Codexa freshness status and the top
  read-first files from `.codex/codebase/README.md` into Claude's session
  context.
- **PreToolUse** — before `Edit`/`Write`/`MultiEdit`/`NotebookEdit` lands on a
  file inside the wired repo, reminds Claude to save a change-plan snapshot
  via `/codexa-plan` if one does not exist yet. Advisory only; never blocks.
- **Stop** — at the end of every assistant turn, if a snapshot exists and
  has not been reviewed on this session yet, runs `codexa post-edit-review` and
  prints the drift summary to stderr. Debounced per session+repo so it
  never thrashes the engine.

Slash commands available to Claude:

| Command            | Wraps                                |
| ------------------ | ------------------------------------ |
| `/codexa-status`   | `codexa status <repo>`               |
| `/codexa-brief`    | `codexa brief <repo> --diff`         |
| `/codexa-plan`     | `codexa change-plan --save-snapshot` |
| `/codexa-review`   | `codexa post-edit-review`            |
| `/codexa-impact`   | `codexa impact` / `diff-impact`      |

Current Codexa packets are proof-carrying. Impact and symbol lookups can include
edge evidence, confidence labels, stale/degraded flags, and structured
`nextTools` entries that name the next read-only or cache-writing Codexa call.
Post-edit review compares against planned-test provenance from the saved
snapshot, degrades legacy or scope-mismatched tests, and persists compact local
outcomes that may visibly influence future ranking/test recommendations.

## Thin Adapter Contract

Claude Code commands and hooks are adapters over the shared Codexa engine.
They do not maintain a separate index, ranking layer, planner, or source-editing
path. The primary Codexa path stays:

```text
session_context -> task_brief -> change_plan(saveSnapshot) -> post_edit_review -> test_plan
```

Use `symbol_context`, `impact`, `callers`, and `callees` when Claude needs to
audit who uses a symbol, what may break, and which tests are relationship-backed.
For non-TypeScript/JavaScript/Python repositories, the shared engine can consume
`CodexaSymbolReportV1` reports through
`codexa static-analysis <repo> --symbol-report <path>` and labels those
relationships as report-backed derived evidence.

The adapter may write Codexa-owned `.codex/cache/` state through the CLI, but it
must not introduce source-mutating MCP tools or host-only behavior that bypasses
the shared Codexa MCP/CLI contract.

## Install

Treat `codexa/integrations/` as a local Claude Code plugin marketplace.

### Quick, supported path (persistent)

From a Claude Code session:

```
/plugin marketplace add <codexa-checkout>/integrations
/plugin install codexa@codexa-integrations
```

(Substitute `<codexa-checkout>` with the absolute path of your local
Codexa checkout. Example: `~/code/codexa/integrations`.)

Under the hood, `<codexa-checkout>/integrations/.claude-plugin/marketplace.json`
registers this directory as the `codexa-integrations` marketplace, and the
plugin `codexa` lives at `./claude-code` relative to that manifest. After
install, restart Claude Code so SessionStart, PreToolUse, and Stop hooks
load.

### Development (per-session)

No install, one-shot:

```bash
claude --plugin-dir <codexa-checkout>/integrations/claude-code
```

### Future: `codexa init` automation

A future release of the `codexa init <repo>` CLI will offer to register the
marketplace and install the plugin automatically. Until then, the two
`/plugin` commands above are the supported path.

## Requirements

- Node.js >= 22 on `$PATH` (override with `CLAUDIO_NODE_BIN`)
- Codexa must be locatable one of three ways (tried in this order):
  1. `CODEXA_CLI` env var set to an absolute path to `dist/cli.js`
  2. `<codexa-checkout>/dist/cli.js` auto-detected from the plugin's own
     location (works when the plugin is loaded via `--plugin-dir
     <codexa-checkout>/integrations/claude-code`)
  3. `codexa` on `$PATH` (works after the public package is published and the
     user ran `npm install -g @mirnoorata/codexa`; recommended when the plugin
     is installed via `/plugin marketplace add`, which copies the plugin out of
     the source checkout)
- GNU coreutils `timeout`, `awk`, `python3`, `shasum` (or `md5sum`)

## Configuration

Environment variables the hooks honor:

| Variable           | Default                   | Purpose                                  |
| ------------------ | ------------------------- | ---------------------------------------- |
| `CODEXA_CLI`       | `<codexa-checkout>/dist/cli.js` (auto) | Path to the built CLI       |
| `CLAUDIO_NODE_BIN` | `node` on `$PATH`         | Node binary to run the CLI               |
| `CLAUDIO_DEBUG`    | unset                     | Set to `1` for `[claudio]` stderr traces |

## Safety properties

- Every hook has a hard Claude hook timeout (SessionStart 6s, PreToolUse 3s,
  Stop 35s). The shell scripts also wrap Codexa CLI calls with shorter
  `timeout(1)` subprocess budgets.
- Every hook exits 0 on any error — Claude sessions are never blocked by a
  Codexa outage.
- Hooks never write to the user's repo. Codexa's own `.codex/cache/` state
  is managed by the CLI, not the hooks.
- Repo detection refuses to climb above `$HOME` or treat `/` as a wired repo.
- Re-entrancy guard on the Stop hook via `stop_hook_active`.
- Slash-command argument parsing routes through `python3 shlex.split` — no
  `eval`, no word-splitting of user input — and `/codexa-review` allowlists
  the flags that can reach the CLI.

## Testing

```bash
bash integrations/claude-code/tests/hook-smoke.sh
bash integrations/claude-code/tests/cmd-smoke.sh
```

Hook smoke: non-wired cwd, empty/malformed payloads, read-first extraction,
snapshot presence/absence, `MultiEdit`/`NotebookEdit` dispatch, relative-path
rejection, Stop debouncing, re-entrancy, failed post-edit passthrough.

Command smoke: `shlex` parsing of quoted tasks and paths with spaces,
unknown-flag rejection, path-traversal-like tokens, empty arguments.
