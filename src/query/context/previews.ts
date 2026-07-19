import type { ChangedSymbol, CodexaIndex, FreshnessInfo } from "../../types.js";
import { summarizeSessionMemory } from "../../session-memory.js";
import { findFile } from "../targets.js";
import { matchScore } from "../search.js";
import { readContextSnippet } from "./snippets.js";

export async function contextSnippets(
  repoRoot: string,
  index: CodexaIndex,
  focusPaths: string[],
  changedSymbols: ChangedSymbol[],
  queryText: string,
  limit: number
): Promise<string[]> {
  const snippets: string[] = [];
  const used = new Set<string>();
  const unreadableFiles = new Set<string>();
  const add = async (filePath: string, line: number, reason: string) => {
    if (snippets.length >= Math.min(10, limit)) return;
    const key = `${filePath}:${line}`;
    if (used.has(key)) return;
    used.add(key);
    const snippet = await readContextSnippet(repoRoot, filePath, line, 3);
    if ("unreadable" in snippet) {
      if (!unreadableFiles.has(filePath)) {
        unreadableFiles.add(filePath);
        snippets.push(`- ${filePath}:${line} ${reason}\n  <snippet unavailable: ${snippet.unreadable}>`);
      }
      return;
    }
    if (snippet.text) snippets.push(`- ${filePath}:${line} ${reason}\n${snippet.text}`);
  };

  for (const entry of changedSymbols.slice(0, limit)) {
    await add(entry.symbol.path, entry.symbol.range?.startLine ?? 1, `changed ${entry.symbol.qualifiedName}`);
  }

  const focusSet = new Set(focusPaths);
  const hasQuery = Boolean(queryText.trim());
  const symbols = index.symbols
    .filter((symbol) => focusSet.has(symbol.path))
    .sort((a, b) => {
      const fileA = findFile(index, a.path)?.rank ?? 0;
      const fileB = findFile(index, b.path)?.rank ?? 0;
      return fileB - fileA || (a.range?.startLine ?? 0) - (b.range?.startLine ?? 0) || a.qualifiedName.localeCompare(b.qualifiedName);
    });
  if (hasQuery) {
    const usages = index.usageSites
      .map((usage) => ({
        usage,
        score: focusSet.has(usage.path) ? Math.max(matchScore(queryText, usage.name), matchScore(queryText, usage.text), matchScore(queryText, usage.path)) : 0
      }))
      .filter((entry) => entry.score > 0)
      .sort(
        (a, b) =>
          b.score - a.score ||
          Number(a.usage.kind === "import") - Number(b.usage.kind === "import") ||
          a.usage.path.localeCompare(b.usage.path) ||
          (a.usage.range?.startLine ?? 0) - (b.usage.range?.startLine ?? 0)
      )
      .slice(0, limit);
    for (const { usage } of usages) await add(usage.path, usage.range?.startLine ?? 1, `usage ${usage.name} ${usage.confidence}`);
  }

  const symbolCandidates = hasQuery
    ? symbols.filter((symbol) => Math.max(matchScore(queryText, symbol.name), matchScore(queryText, symbol.qualifiedName), matchScore(queryText, symbol.path)) > 0)
    : symbols;
  for (const symbol of symbolCandidates.slice(0, limit)) {
    await add(symbol.path, symbol.range?.startLine ?? 1, `${symbol.kind} ${symbol.qualifiedName}`);
  }
  return snippets;
}

export async function sessionMemoryPreview(input: {
  repoRoot: string;
  freshness: FreshnessInfo;
  files?: string[];
  symbols?: string[];
  topics?: string[];
  taskId?: string;
  limit: number;
}): Promise<{ lines: string[]; data?: unknown }> {
  try {
    const result = await summarizeSessionMemory({
      repoRoot: input.repoRoot,
      taskId: input.taskId,
      files: input.files,
      symbols: input.symbols,
      topics: input.topics,
      freshness: input.freshness,
      limit: input.limit,
      includeStale: true
    });
    if (result.memory.entries.length === 0) return { lines: [] };
    return {
      lines: (result.memory.markdown ?? "").split(/\r?\n/u).slice(0, 12),
      data: {
        sessionId: result.sessionId,
        revision: result.revision,
        entries: result.memory.entries.slice(0, input.limit),
        warnings: result.warnings
      }
    };
  } catch (error) {
    return {
      lines: [`- unavailable: ${error instanceof Error ? error.message : String(error)}`],
      data: { warning: error instanceof Error ? error.message : String(error) }
    };
  }
}
