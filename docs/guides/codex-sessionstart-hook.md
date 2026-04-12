# Codex SessionStart Hook

Projects opt into a small repo-local SessionStart hook by running:

```bash
codexa init
```

That writes `.codex/hooks.json` and the required feature flag in
`.codex/config.toml`.

The generated hook command is:

```bash
node /path/to/codexa/dist/cli.js session-start /path/to/project
```

The helper is intentionally read-only for source files. By default it prints
only Codexa status and a pointer to the MCP `task_brief` tool so Codex startup
stays cheap. Set `CODEXA_SESSIONSTART_CONTEXT=1` in the hook environment if you
want a bounded no-refresh context-pack preview as well.

It does not mutate source files. Codexa MCP context tools may still refresh
generated `.codex/codebase/` cache artifacts when auto-refresh is enabled.
