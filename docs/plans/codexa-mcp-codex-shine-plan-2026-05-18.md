# Codexa MCP-for-Codex High-ROI Hardening Plan

## Summary

- Goal: make Codexa a proof-carrying, Codex-native MCP server: correct repo, typed outputs, explicit lifecycle, bounded trust, and fewer tool-choice mistakes.
- Market lesson: GitHub MCP wins on repo actions, Sourcegraph/Serena win on code intelligence, Context7 wins on simple docs freshness, Playwright MCP wins on compact structured snapshots. Codexa should win on local repo edit-readiness, verification provenance, and safe Codex workflow guidance.

## Key Changes

1. **Fix repo routing and execution trust first**
   - Change MCP repo resolution so active session repo beats workspace default; if multiple writable candidates remain, fail closed with an ambiguity message.
   - Make AutoVerify execution opt-in per trusted repo via `.codex/config.toml` or `CODEXA_AUTOVERIFY=1`; default behavior records recommended commands without spawning repo code.
   - Add `--session-memory auto|off`; with `--no-auto-refresh --session-memory off`, mark core context tools read-only and avoid session-memory cache writes.

2. **Add a typed MCP envelope**
   - Replace generic `z.unknown()` output schemas with `CodexaMcpEnvelopeV1` while preserving existing top-level `data`, `freshness`, and `refresh`.
   - Envelope fields: `schemaVersion`, `mode`, `actionability`, `quality`, `freshness`, `refresh`, `lifecycle`, `worktree`, `verificationProvenance`, `truncation`, `nextTools`, `relatedResources`, and `data`.
   - Add explicit `data.mode` to every query result. Start with strict schemas for `session_context`, `task_brief`, `change_plan`, `post_edit_review`, `test_plan`, `context_pack`, and `diff_impact`.

3. **Make lifecycle enforceable**
   - Add `lifecycle.phase`, `taskId`, `snapshotStatus`, `preconditions`, `blockingReasons`, and `nextTools` to key tool outputs.
   - Treat `post_edit_review` without an exact task/snapshot affinity as degraded when multiple snapshots exist.
   - Update the generated Codex contract to present the primary path: `session_context -> task_brief -> change_plan(saveSnapshot) -> post_edit_review -> test_plan`.

4. **Propagate degraded worktree state everywhere**
   - Centralize diff/status reads in one `worktreeState` helper returning `knownClean`, `entries`, `symbols`, and `degradedReasons`.
   - `context_pack(diff:true)`, `diff_impact`, and `test_plan(diff:true)` must say "worktree unknown" instead of implying zero changes when git status/diff failed.
   - Lower quality/actionability when diff-sensitive context is degraded.

5. **Tighten MCP-native UX and tool surface**
   - Introduce a `toolCatalog` with `primary|advanced`, `phase`, `writeEffects`, `readOnly`, and `nextToolUse`.
   - Keep compatibility aliases, but make the primary Codex tool set small: `session_context`, `task_brief`, `change_plan`, `post_edit_review`, `test_plan`, `search`, and one graph/workflow tool.
   - Return MCP `resource_link` content for important generated artifacts and include `relatedResources` in structured content for clients that do not display links well.

6. **Harden cache, LSP, and memory boundaries**
   - Redact/drop LSP file URIs outside the repo after realpath/subpath checks; run LSP in a process group and kill the group on timeout.
   - Add stat-size caps and schema checks before reading semantic manifests, vectors, memory JSON, and memory event logs.
   - Render non-Codexa-derived memory as labeled untrusted quoted text, with control characters stripped.

7. **Add market-grade eval and doctor surfaces**
   - Add eval tasks measuring context precision, stale-state detection, false positives, structured byte size, tool hops to edit-ready, and verification provenance.
   - Add a `codexa doctor --mcp-readiness` view covering active repo routing, tool schemas, hooks, session-memory mode, semantic/LSP availability, package metadata, and latest eval score.
   - Keep Codexa out of GitHub operations; hand off releases/PRs through links and metadata instead of competing with GitHub MCP.

## Test Plan

- Unit: repo routing precedence, AutoVerify opt-in, worktree degradation helper, cache size caps, LSP outside-repo URI redaction, untrusted memory rendering.
- MCP integration: `listTools()` exposes typed schemas; primary tools validate against `CodexaMcpEnvelopeV1`; `resource_link` results are parseable.
- Lifecycle: two saved snapshots plus ambiguous `post_edit_review` must degrade; exact `taskId` must pass normal lifecycle checks.
- CLI/MCP parity: shared input contracts cover `changeType`, semantic options, LSP options, and verification command reports.
- Gates: `npm run typecheck`, focused Vitest files, `npm run check`; run `npm run security:check` only after the tree is committed/HEAD-matching because snapshot check is clean-tree sensitive.

## Assumptions

- Codexa remains Codex-first, local-first, and project-agnostic: no hardcoded `/srv/atlas`, no graph DB, no vector DB requirement, no web UI, and no source-mutating MCP tools.
- Market references used: [MCP tool outputs and schemas](https://modelcontextprotocol.io/specification/2025-06-18/server/tools), [MCP Registry](https://modelcontextprotocol.io/registry/about), [GitHub MCP docs](https://docs.github.com/en/enterprise-cloud@latest/copilot/how-tos/provide-context/use-mcp-in-your-ide/use-the-github-mcp-server?tool=webui), [Sourcegraph MCP](https://sourcegraph.com/docs/api/mcp), [Playwright MCP](https://playwright.dev/mcp/introduction), [Context7](https://github.com/upstash/context7#readme), and [Serena](https://github.com/oraios/serena).
