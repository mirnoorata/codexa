# Codexa for Claude Code

Ships Codexa's edit-safety loop into Claude Code the way it already ships into
Codex. One install, both tools wired to the same engine and the same
`<repo>/.codex/` state.

## What it does

When Claude Code is running in a Codexa-wired repo (one that contains
`<repo>/.codex/config.toml`), this plugin:

- **MCP server** — exposes the Codexa query tools (`task_brief`,
  `change_plan`, `post_edit_review`, `impact`, `search`, …) directly to
  Claude through the plugin's `.mcp.json`. The launcher resolves the repo
  from the session's project directory and the CLI from `CODEXA_CLI`, the
  package's own `dist/cli.js`, or a global install.
- **SessionStart** — injects a short Codexa freshness status and the top
  read-first files from `.codex/codebase/README.md` into Claude's session
  context.
- **PreToolUse** — before `Edit`/`Write`/`MultiEdit`/`NotebookEdit` lands on a
  file inside the wired repo, saves an implicit pre-edit baseline via
  `codexa hook-pre-edit` when no change-plan snapshot exists yet, so the
  post-edit drift review always has a pre-edit reference. Falls back to an
  advisory nudge when the CLI is unavailable. Never blocks the edit.
- **Stop** — at the end of every assistant turn, if a snapshot exists and
  has not been reviewed on this session yet, runs `codexa post-edit-review`
  and prints the drift summary to stderr. When the review ran against an
  **explicit** `change_plan` snapshot and the verdict is `replan` or a
  blocking `inspect`, the summary is surfaced to the model through the Stop
  hook's `{"decision":"block","reason":…}` contract so Claude can act on the
  drift. Reviews against hook-saved implicit baselines never block — saving
  a plan is the opt-in — and neither do parent-scan reviews of other
  workspace repos: only the repo the session is working inside can block.
  Clean and advisory verdicts stay quiet. Debounced
  per session+repo+dirty-tree state, with a `stop_hook_active` re-entrancy
  guard, so it blocks at most once per stop and never loops. Set
  `CLAUDIO_STOP_BLOCK=0` for stderr-only behavior.

Slash commands available to Claude:

| Command            | Wraps                                |
| ------------------ | ------------------------------------ |
| `/codexa-status`   | `codexa status <repo>`               |
| `/codexa-brief`    | `codexa brief <repo> --diff`         |
| `/codexa-prove`    | `codexa prove <repo> --diff`         |
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
session_context -> task_brief -> change_plan(saveSnapshot) -> post_edit_review -> test_plan -> proof_card
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

Treat `codexa/integrations/` as a local Claude Code plugin marketplace. It
ships inside the npm package, so both a git checkout and an npm install work
as the marketplace source.

For a repo that should be ready for both proof cards and Claude hook guidance:

```bash
codexa init <repo> --claude-md
codexa policy-init <repo>
```

### Quick, supported path (persistent)

From a Claude Code session:

```text
/plugin marketplace add <codexa-root>/integrations
/plugin install codexa@codexa-integrations
```

`<codexa-root>` is either a local checkout (example: `~/code/codexa`) or the
installed npm package root — for a global install that is
`$(npm root -g)/@mirnoorata/codexa`.

Under the hood, `<codexa-root>/integrations/.claude-plugin/marketplace.json`
registers this directory as the `codexa-integrations` marketplace, and the
plugin `codexa` lives at `./claude-code` relative to that manifest. After
install, restart Claude Code so the MCP server and the SessionStart,
PreToolUse, and Stop hooks load.

### MCP-only alternative (no plugin)

If you only want the Codexa tools (no hooks or slash commands), skip the
plugin and run `codexa init <repo> --claude` instead — it writes the codexa
MCP server into the repo's `.mcp.json`. Use the plugin **or** `init
--claude`, not both, to avoid registering the server twice.

### Development (per-session)

No install, one-shot:

```bash
claude --plugin-dir <codexa-checkout>/integrations/claude-code
```

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
- `awk`, `python3`, `shasum` (or `md5sum`). GNU coreutils `timeout` is used
  when present; on stock macOS (bash 3.2, no `timeout`) the hooks fall back
  to a `python3` timeout wrapper, so no Homebrew packages are required.

## Configuration

Environment variables the hooks honor:

| Variable                           | Default                                | Purpose                                                                      |
| ---------------------------------- | -------------------------------------- | ---------------------------------------------------------------------------- |
| `CODEXA_CLI`                       | `<codexa-checkout>/dist/cli.js` (auto) | Path to the built CLI                                                        |
| `CLAUDIO_NODE_BIN`                 | `node` on `$PATH`                      | Node binary to run the CLI                                                   |
| `CLAUDIO_DEBUG`                    | unset                                  | Set to `1` for `[claudio]` stderr traces                                     |
| `CLAUDIO_STOP_BLOCK`               | `1`                                    | Set to `0` to keep drift verdicts stderr-only (never block)                  |
| `CODEXA_REPO`                      | session project dir                    | Repository the plugin MCP server serves                                      |
| `CODEXA_PLUGIN_TOOLS`              | `core`                                 | MCP tool profile served by the plugin (`full` exposes all 20 tools)          |
| `CODEXA_PLUGIN_AUTO_REFRESH`       | `1`                                    | Set to `0` to stop the MCP server refreshing stale indexes                   |
| `CODEXA_PLUGIN_ALLOW_NPX_FALLBACK` | unset                                  | Set to `1` to let the MCP launcher fall back to `npx -y @mirnoorata/codexa`  |

## Safety properties

- Every hook has a hard Claude hook timeout (SessionStart 6s, PreToolUse 10s,
  Stop 35s). The shell scripts also wrap Codexa CLI calls with shorter
  subprocess budgets (`timeout(1)` or the python3 fallback).
- Every hook exits 0 on any error — Claude sessions are never blocked by a
  Codexa outage. The Stop hook's drift block is a JSON decision on a clean
  exit, gated to replan/blocking-inspect verdicts parsed against a strict
  enum allowlist; raw CLI output never flows into the block reason.
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
