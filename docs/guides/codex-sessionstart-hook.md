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

The helper is intentionally read-only for source files. By default it prints a
versioned receipt with separate project-config, index, and current-thread MCP
activation states plus the compact selective-use cadence. SessionStart cannot
observe the host's MCP initialize handshake, so it reports current-thread MCP
activation as `unverified`; config presence alone is never called active or
ready. Pass `--json` for the structured receipt. Set
`CODEXA_SESSIONSTART_CONTEXT=1` in the hook environment if you want the bounded
context preview and workspace-row digest as well.

At a shared workspace root, a `Workspace Default` or lone implicit `Active
Sessions` row is only a fallback for explicit query commands; neither proves
that the new session selected that project. SessionStart therefore returns
`routing.state=selection-required` and `index.state=not-selected` without
inspecting that repo's config or index. Pass `--workspace-session <id>` to
select an active row. If a shared workspace generates a selector file, its
coordinator must validate that selector against current workspace state before
importing it; do not source a mutable selector directly. An explicit `Active
Focus` continues to route directly.

The config facet parses the complete TOML document, selects the managed server
table, and bounds its `command`, launcher token, arguments, enabled-tool list,
and `serve` operand. The command must resolve to an executable; Node launchers
must be a readable `dist/cli.js` under a package named `@mirnoorata/codexa`;
and the post-`serve` arguments must match init's stdio shape. The configured
repo must resolve to the receipt's active `repoRoot`. Malformed TOML, nested or
duplicate server tables, non-stdio transports, unrelated or stale launchers,
copied wrong-root configs, and excessive tool lists are invalid.
When `--auto-refresh` is requested, a missing or stale index is rebuilt during
that SessionStart invocation, before the receipt is returned; it is not
deferred to a later MCP call.

Every index-derived receipt string and count is validated, control-sanitized,
and bounded before text or JSON rendering. Malformed metadata produces
`metadata-invalid`; a nonzero parser error count produces `parser-degraded`.
Both are nonfresh strict failures rather than a successful `fresh` receipt.

The generated hook remains advisory and exits successfully. Explicit callers
can pass `--strict`: it exits nonzero when repo routing/status is unavailable or
still requires selection,
the focused repo's managed config is missing or invalid, its tool profile is not
an internally consistent `core` or `full` profile, or its index is not `fresh`
(including malformed metadata or parser degradation).
Strict mode deliberately does not turn `Current-thread MCP: unverified` into a
failure, because only the host handshake—not this subprocess—can attest that
state.

When Codex edit hooks are available, `codexa init` also writes two lightweight
edit-loop helpers:

```bash
node <codexa-checkout>/dist/cli.js hook-pre-edit <repo>
node <codexa-checkout>/dist/cli.js hook-post-edit <repo>
```

`hook-pre-edit` silently saves a cheap implicit baseline when no CLI
`change-plan --save-snapshot` baseline exists. If blocked/invalid snapshot
state, a degraded worktree, or another active writer prevents a reliable
baseline, it emits one bounded warning to save an explicit MCP `change_plan`
with `saveSnapshot=true` before a non-trivial edit. `hook-post-edit` runs a
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

Because the Codex `PostToolUse` matcher covers edit tools, this hook runs before
shell verification that follows the final edit. It is an edit-time guardrail,
not a completion/Stop gate: a saved plan still offers one final
`post_edit_review` after verification so the actual command evidence can be
recorded. A true completion hook may suppress that route only when it can carry
trusted command reports and invariant reviews; the current Claude plugin Stop
hook remains advisory and does not claim that ownership.
Those local outcomes can later produce bounded, visible ranking/test boosts, but
they do not override freshness, explicit targets, or authoritative graph
evidence.

These helpers do not intentionally mutate source files. AutoVerify may execute
repo test code when externally enabled and then mark detected source/test
mutations as non-covering. Codexa context tools may still refresh generated
`.codex/codebase/` cache artifacts when auto-refresh is enabled.
