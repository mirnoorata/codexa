import type { FreshnessInfo } from "./types.js";
import { NO_SOURCE_MUTATION_CONTRACT, PRIMARY_CODEX_LOOP, PRIMARY_MCP_TOOL_NAMES } from "./mcp-tool-catalog.js";

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
      ? "For the next code task, call `task_brief` with the user's task and `diff: true`; call `diff_impact` only for broad review of existing dirty work."
      : "For the next code task, call `task_brief` with the user's task before reading unrelated files.";

  return `# Codexa Codex Contract

Codexa is the Codex-native edit safety layer for this repo. Use it to choose
the smallest useful context packet, save an edit snapshot, and review drift
after source changes. Do not treat it as an unbounded graph dump.

## Current State

- Repo: \`<repo>\`
- Freshness: ${stale}
- Commit: \`${freshness.headCommit ?? "none"}\`
- Indexed: \`${freshness.indexedAt || "never"}\`
- Dirty files: ${dirty}
- Parser errors: ${freshness.parserErrorCount}
- ${dirtyLine}

## Automatic Use Rules

1. Broad or ambiguous request: call \`session_context\`; if actionability says \`needs_target\`, \`raw_search_better\`, or \`raw_search_sufficient\`, use \`search\` or an explicit target before planning edits.
2. Any code edit, debug, or review task: call \`task_brief\` first with the user's exact task.
3. Before editing concrete files: call \`change_plan\` with \`saveSnapshot: true\` and keep the returned task id.
4. After editing: call \`post_edit_review\` with the saved task id and tests run.
5. Before final response: call \`test_plan\` or account for why no targeted tests apply.
6. Route, job, queue, adapter, manifest, or runtime behavior: call \`workflow_path\`.
7. API, rename, delete, or exported contract change: call \`callers\`, \`callees\`, or \`dependency_path\`.

Primary Codex loop: \`${PRIMARY_CODEX_LOOP}\`.
Primary MCP tools: ${PRIMARY_MCP_TOOL_NAMES.map((tool) => `\`${tool}\``).join(", ")}.

## Session Memory Protocol

- Codexa auto-records \`viewed\` memory for focused MCP packets such as
  \`task_brief\`, \`context_pack\`, \`focus_brief\`, \`impact\`, \`test_plan\`,
  \`change_plan\`, and \`post_edit_review\`.
- At session start or resume, call \`session_memory\` with \`action: "summary"\`
  before re-reading files already surfaced by Codexa.
- After establishing a non-trivial task-local claim, decision, constraint,
  risk, open question, next read, or ruled-out path, call \`session_memory\`
  with \`action: "remember"\` and explicit refs/files/symbols when available.
- Before deep-reading a file again, call \`session_memory\` with
  \`action: "read"\` and the file/symbol/task filter. Prefer a narrower graph
  tool when the memory says the file was already viewed.
- When a claim is replaced, pass the old entry id in \`supersedes\`; do not
  leave contradictory active entries unlinked.
- Agent-asserted entries are working memory, not parser facts. Use their
  \`provenance\`, \`evidenceTier\`, and \`confidence\` labels when deciding how
  much source verification is still required.

## Trust Rules

- If freshness is stale or missing, use auto-refresh or run \`codexa index\`.
- If a packet is heuristic-heavy, verify with source reads before editing.
- If the dirty tree is broad, keep the task's read-first set target-led.
- If Codexa says raw search is better, use \`rg\` and then return to a focused Codexa tool.
- ${NO_SOURCE_MUTATION_CONTRACT}
- Session memory recall is deterministic filtering by session, task, refs,
  files, symbols, kind, topic, and recency. It is not semantic search.

## Session Next Action

${nextAction}
`;
}
