import path from "node:path";
import { buildIndexLocked, getFreshness, loadIndex, loadIndexReadOnly } from "../indexer.js";
import type { CodexaIndex, FileFact, FreshnessInfo, QueryOptions, QueryResult, RefreshInfo, SymbolFact } from "../types.js";

const refreshLocks = new Map<string, Promise<CodexaIndex>>();

export async function requireIndex(
  repoRoot: string,
  options: QueryOptions = {}
): Promise<{ index: CodexaIndex; freshness: FreshnessInfo; refresh?: RefreshInfo }> {
  const repo = path.resolve(repoRoot);
  let index = options.autoRefresh ? await loadIndex(repo) : await loadIndexReadOnly(repo);
  let freshness = await getFreshness(repo, index, { recover: options.autoRefresh });
  if (options.autoRefresh && freshness.stale) {
    const refreshReason = freshness.reason;
    index = await refreshIndex(repo);
    freshness = await getFreshness(repo, index);
    return {
      index,
      freshness,
      refresh: {
        refreshed: true,
        reason: refreshReason,
        indexedAt: index.freshness.indexedAt
      }
    };
  }
  if (!index) {
    throw new Error(`Missing Codexa index. Run: codexa index ${path.resolve(repoRoot)}`);
  }
  return { index, freshness, refresh: { refreshed: false } };
}

export async function statusQuery(repoRoot: string, options: { recover?: boolean } = {}): Promise<QueryResult> {
  const recover = options.recover ?? true;
  const freshness = await getFreshness(repoRoot, undefined, { recover });
  const text = [
    `Codexa status: ${freshness.stale ? "stale" : "fresh"} (${freshness.reason})`,
    `Repo: ${freshness.repoRoot}`,
    `Commit: ${freshness.headCommit ?? "none"}`,
    `Indexed: ${freshness.indexedAt || "never"}`,
    `Dirty files: ${freshness.dirtyFiles.length}`,
    `Parser errors: ${freshness.parserErrorCount}`
  ].join("\n");
  return { freshness, text, data: freshness };
}

export function freshnessBanner(freshness: FreshnessInfo, refresh?: RefreshInfo): string {
  if (refresh?.refreshed) {
    return `Freshness: ${freshness.reason} (auto-refreshed from ${refresh.reason})`;
  }
  return freshness.stale ? `WARNING: index stale (${freshness.reason})` : `Freshness: ${freshness.reason}`;
}

export function ambiguityResult(
  freshness: FreshnessInfo,
  refresh: RefreshInfo | undefined,
  kind: "file" | "symbol",
  query: string,
  candidates: Array<FileFact | SymbolFact>
): QueryResult {
  const formatted = candidates.slice(0, 20).map((candidate) => {
    if ("qualifiedName" in candidate) {
      return `- ${candidate.id} ${candidate.qualifiedName} at ${candidate.path}:${candidate.range?.startLine ?? 1}`;
    }
    return `- ${candidate.path}`;
  });
  return {
    freshness,
    refresh,
    text: [freshnessBanner(freshness, refresh), `Ambiguous ${kind} target "${query}". Use an exact path, symbol id, or qualified name.`, ...formatted].join("\n"),
    data: { ambiguous: true, kind, query, candidates: candidates.slice(0, 20) }
  };
}

async function refreshIndex(repoRoot: string): Promise<CodexaIndex> {
  const existing = refreshLocks.get(repoRoot);
  if (existing) {
    return existing;
  }
  const refresh = (async () => {
    const loaded = await loadIndex(repoRoot);
    const currentFreshness = await getFreshness(repoRoot, loaded);
    if (loaded && !currentFreshness.stale) {
      return { ...loaded, freshness: currentFreshness };
    }
    return buildIndexLocked({ repoRoot, writeArtifacts: true });
  })().finally(() => {
    refreshLocks.delete(repoRoot);
  });
  refreshLocks.set(repoRoot, refresh);
  return refresh;
}
