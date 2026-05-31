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
`change-plan --save-snapshot` baseline exists, equivalent to the MCP
`change_plan` tool with `saveSnapshot=true`. `hook-post-edit` runs a bounded CLI
`post-edit-review`, equivalent to the MCP `post_edit_review` tool, after edit
tools. It evaluates the saved planned-test provenance, degrades stale or
scope-mismatched snapshot tests, and stores the compact verdict under
`.codex/cache/codexa-outcomes/`. If `CODEXA_AUTOVERIFY=1` or
`CODEXA_AUTOVERIFY=true` is set, it can also auto-run targeted safe test
commands inferred from that review and feed captured command reports into the
final review.
Those local outcomes can later produce bounded, visible ranking/test boosts, but
they do not override freshness, explicit targets, or authoritative graph
evidence.

These helpers do not mutate source files. Codexa context tools may still refresh
generated `.codex/codebase/` cache artifacts when auto-refresh is enabled.
