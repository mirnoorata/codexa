import type { FreshnessInfo } from "./types.js";
import { CORE_PROFILE_TOOL_NAMES, NO_SOURCE_MUTATION_CONTRACT, PRIMARY_CODEX_LOOP } from "./mcp-tool-catalog.js";

export function renderCodexUseContract(freshness: FreshnessInfo): string {
  const stale = freshness.stale ? `stale (${freshness.reason})` : `fresh (${freshness.reason})`;
  const dirty = freshness.dirtyFiles.length;
  const dirtyLine =
    dirty > 0
      ? `There are ${dirty} dirty file(s). Treat broad dirty context as background until the user gives a concrete task.`
      : "No dirty files were present at index time.";
  const nextAction = freshness.missing
    ? "Run `codexa index <repo>` or use an auto-refreshing MCP tool before relying on Codexa context."
    : dirty > 0
      ? "Use source tools first for an exact task. Call `change_plan` with `diff: true` only when the dirty scope or material risk makes a saved plan useful."
      : "Use source tools with zero Codexa calls for exact local work. Call `search` once for ambiguity or `change_plan` for a non-trivial risky edit.";

  return `# Codexa Codex Contract

Codexa is a selective codebase context and edit-safety layer. Use it when one
bounded packet replaces repeated exploration or protects a material edit. Do
not add Codexa calls to exact local work merely because the server is present.

## Current State

- Repo: \`<repo>\`
- Freshness: ${stale}
- Commit: \`${freshness.headCommit ?? "none"}\`
- Indexed: \`${freshness.indexedAt || "never"}\`
- Dirty files: ${dirty}
- Parser errors: ${freshness.parserErrorCount}
- ${dirtyLine}

## Automatic Use Rules

1. Known file, symbol, error, exact raw match, read-only check, or small local edit: use source tools and tests directly. Make zero Codexa calls.
2. Ambiguous target: call \`search\` once. If it reports \`raw_search_sufficient\`, stop Codexa and read the exact hits; do not chain another context tool.
3. Non-trivial multi-file, API, runtime, persistence, security, or otherwise high-risk edit: call \`change_plan\` with \`saveSnapshot: true\`, then run its planned verification.
4. Call \`post_edit_review\` once only on a hookless host, for a formal requested review, or when no deterministic completion gate already owns drift review.
5. Normal agentic work should usually use no more than two Codexa calls. The only three-call safety exception is \`search -> change_plan -> post_edit_review\` for an ambiguous materially risky edit on a hookless host. Do not stack \`session_context\`, \`search\`, and \`task_brief\` for one task.
6. Call \`test_plan\` only when verification guidance remains unresolved; call \`proof_card\` only for policy, audit, release, or formal handoff proof.
7. Use \`capabilities\` only when a concrete trigger requires a non-core operation. Full mode exposes every operation directly but does not make them mandatory.

Primary Codex loop: \`${PRIMARY_CODEX_LOOP}\`.
Core direct MCP tools: ${CORE_PROFILE_TOOL_NAMES.map((tool) => `\`${tool}\``).join(", ")}.

## Session Memory Protocol

- Codexa auto-records \`viewed\` memory for focused MCP packets such as
  \`task_brief\`, \`context_pack\`, \`focus_brief\`, \`impact\`, \`test_plan\`,
  \`change_plan\`, and \`post_edit_review\`.
- Use \`session_memory\` only after real context loss or when a compact recall
  will prevent repeated deep reads. Do not call it ritualistically at session
  start; focused packets are already auto-recorded.
- Explicitly remember only durable task-local decisions or constraints whose
  reuse will save more context than the memory call costs.
- When a claim is replaced, pass the old entry id in \`supersedes\`; do not
  leave contradictory active entries unlinked.
- Agent-asserted entries are working memory, not parser facts. Use their
  \`provenance\`, \`evidenceTier\`, and \`confidence\` labels when deciding how
  much source verification is still required.

## Trust Rules

- If freshness is stale or missing, use auto-refresh or run \`codexa index\`.
- If a packet is heuristic-heavy, verify with source reads before editing.
- If the dirty tree is broad, keep the task's read-first set target-led.
- Treat \`search\` as the first-class locator: it combines raw search, exact/symbol evidence, semantic retrieval when configured, ranking, likely tests, and gaps. If its semantic lane is disabled, it still must not silently create embeddings.
- If Codexa says raw search is enough, stop Codexa and read the exact raw hit.
- ${NO_SOURCE_MUTATION_CONTRACT}
- Session memory recall is deterministic filtering by session, task, refs,
  files, symbols, kind, topic, and recency. It is not semantic search.

## Session Next Action

${nextAction}
`;
}
