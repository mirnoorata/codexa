# Codex SessionStart Hook

Projects opt into a small repo-local SessionStart hook by running:

```bash
codexa init
```

That writes `.codex/hooks.json` and the required feature flag in
`.codex/config.toml`.

The generated SessionStart hook command is:

```bash
node <codexa-checkout>/dist/cli.js session-start <repo>
```

`<repo>` is the target repository root — the absolute path of the
codebase you want Codexa to index.

The helper is intentionally read-only for source files. By default it prints
only Codexa status and a pointer to the MCP `task_brief` tool so Codex startup
stays cheap. Set `CODEXA_SESSIONSTART_CONTEXT=1` in the hook environment if you
want a bounded no-refresh context-pack preview as well.

When Codex edit hooks are available, `codexa init` also writes two lightweight
edit-loop helpers:

```bash
node <codexa-checkout>/dist/cli.js hook-pre-edit <repo>
node <codexa-checkout>/dist/cli.js hook-post-edit <repo>
```

`hook-pre-edit` is a cheap reminder when no CLI
`change-plan --save-snapshot` baseline exists, using the same planning engine as
the MCP `change_plan` tool with `saveSnapshot=true`. `hook-post-edit` runs a
bounded CLI `post-edit-review`, using the same review engine as MCP
`post_edit_review`, after edit tools. It evaluates the saved planned-test
provenance, degrades stale or scope-mismatched snapshot tests, and stores the
compact verdict under
`.codex/cache/codexa-outcomes/`. If user-owned autonomy is `full-access` through
`codexa autonomy <repo> --mode full-access`, or `CODEXA_AUTOVERIFY=1` /
`CODEXA_AUTOVERIFY=true` is set, it can also auto-run targeted safe test
commands inferred from that review and feed captured command reports into the
final review. AutoVerify is hook-only: MCP `post_edit_review` does not execute
commands. The hook runner uses a scrubbed child environment with isolated
home/config/cache paths, rejects unsafe executables, package lifecycle hooks,
package-manager shell execution, and code-loading/config flags. Safe package
scripts are lowered to direct runner commands before execution, using a
validated package-local `node_modules/.bin` entry or a safe system path. The
hook records policy/dirty-tree metadata and treats source/test/Codexa-provenance
mutations detected after a run as non-covering evidence. It is not a sandbox;
repo test code still executes locally.
Those local outcomes can later produce bounded, visible ranking/test boosts, but
they do not override freshness, explicit targets, or authoritative graph
evidence.

These helpers do not intentionally mutate source files. AutoVerify may execute
repo test code when externally enabled and then mark detected source/test
mutations as non-covering. Codexa context tools may still refresh generated
`.codex/codebase/` cache artifacts when auto-refresh is enabled.
