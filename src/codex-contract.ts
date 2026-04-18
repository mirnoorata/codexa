import type { FreshnessInfo } from "./types.js";

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

1. Broad or ambiguous request: call \`focus_brief\` or \`session_context\`.
2. Any code edit, debug, or review task: call \`task_brief\` first with the user's exact task.
3. Before editing concrete files: call \`change_plan\` with \`saveSnapshot: true\`.
4. Route, job, queue, adapter, manifest, or runtime behavior: call \`workflow_path\`.
5. API, rename, delete, or exported contract change: call \`callers\`, \`callees\`, or \`dependency_path\`.
6. After editing: call \`post_edit_review\` with the saved task id and tests run.
7. Before final response: call \`test_plan\` or account for why no targeted tests apply.

## Trust Rules

- If freshness is stale or missing, use auto-refresh or run \`codexa index\`.
- If a packet is heuristic-heavy, verify with source reads before editing.
- If the dirty tree is broad, keep the task's read-first set target-led.
- If Codexa says raw search is better, use \`rg\` and then return to a focused Codexa tool.

## Session Next Action

${nextAction}
`;
}
