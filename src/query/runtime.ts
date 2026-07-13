import path from "node:path";
import { buildIndexLocked, getFreshness, loadIndex, loadIndexReadOnly } from "../indexer.js";
import { assertIndexIdentity, findIndexIdentityIssue, IndexIdentityError } from "../index-identity.js";
import { freshnessBlocksAuthority } from "../freshness-authority.js";
import { workspaceStateDigest } from "../workspace-state.js";
import type { CodexaIndex, FileFact, FreshnessInfo, QueryOptions, QueryResult, RefreshInfo, SymbolFact } from "../types.js";

const refreshLocks = new Map<string, Promise<CodexaIndex>>();

export async function requireIndex(
  repoRoot: string,
  options: QueryOptions = {}
): Promise<{ index: CodexaIndex; freshness: FreshnessInfo; refresh?: RefreshInfo }> {
  const repo = path.resolve(repoRoot);
  let index = options.autoRefresh ? await loadIndex(repo) : await loadIndexReadOnly(repo);
  let identityIssue = index ? findIndexIdentityIssue(repo, index) : undefined;
  let freshness = await getFreshness(repo, index, { recover: options.autoRefresh });
  identityIssue ??= index ? findIndexIdentityIssue(repo, index, freshness) : undefined;
  if (options.autoRefresh && (freshness.stale || identityIssue)) {
    const refreshReason = identityIssue?.reason ?? freshness.reason;
    index = await refreshIndex(repo, Boolean(identityIssue));
    freshness = await getFreshness(repo, index);
    assertIndexIdentity(repo, index, freshness);
    if (freshness.stale) {
      throw new Error(
        `Codexa index changed again during refresh (${freshness.reason}); refusing to return stale context for ${repo}. Retry the query or run: codexa index ${repo}`
      );
    }
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
  assertIndexIdentity(repo, index, freshness);
  return { index, freshness, refresh: { refreshed: false } };
}

export async function statusQuery(repoRoot: string, options: { recover?: boolean } = {}): Promise<QueryResult> {
  void options;
  const repo = path.resolve(repoRoot);
  const index = await loadIndexReadOnly(repo);
  const observedFreshness = await getFreshness(repo, index, { recover: false });
  const identityIssue = index ? findIndexIdentityIssue(repo, index, observedFreshness) : undefined;
  const freshness = identityIssue
    ? { ...observedFreshness, stale: true, reason: identityIssue.reason }
    : observedFreshness;
  const text = [
    `Codexa status: ${freshness.stale ? "stale" : "fresh"} (${freshness.reason})`,
    `Repo: ${freshness.repoRoot}`,
    `Commit: ${freshness.headCommit ?? "none"}`,
    `Indexed: ${freshness.indexedAt || "never"}`,
    `Workspace state: ${workspaceStateDigest(freshness)}`,
    `Dirty files: ${freshness.dirtyFiles.length}`,
    `Parser errors: ${freshness.parserErrorCount}`,
    identityIssue ? `Identity: blocked (${identityIssue.reason}); indexed repo ${identityIssue.indexedRepoRoot ?? "unknown"}` : undefined
  ].filter((line): line is string => Boolean(line)).join("\n");
  return {
    freshness,
    text,
    data: { mode: "freshness", ...freshness, workspaceStateDigest: workspaceStateDigest(freshness), ...(identityIssue ? { identityIssue } : {}) }
  };
}

export function freshnessBanner(freshness: FreshnessInfo, refresh?: RefreshInfo): string {
  const repo = `; Repo: ${freshness.repoRoot}`;
  if (refresh?.refreshed) {
    return `Freshness: ${freshness.reason} (auto-refreshed from ${refresh.reason})${repo}`;
  }
  return freshness.stale ? `WARNING: index stale (${freshness.reason})${repo}` : `Freshness: ${freshness.reason}${repo}`;
}

/**
 * Stale indexed context may still be useful for read-only orientation, but it
 * must never authorize or persist lifecycle state. Callers that can save a
 * plan, outcome, or completion decision use this guard before those writes.
 */
export function freshnessAuthorityBlockReason(freshness: FreshnessInfo): string | undefined {
  if (freshness.missing) {
    return "Codexa index is missing; index the active checkout before creating authoritative task state";
  }
  // A dirty overlay is the normal input to change planning and post-edit
  // review. It is safe to persist against when the checkout identity matches
  // and the exact overlay remains unchanged through the persistence boundary.
  // Other stale reasons mean the indexed evidence itself may be obsolete.
  if (freshnessBlocksAuthority(freshness)) {
    return `Codexa index is stale (${freshness.reason}); refresh the active checkout index before creating authoritative task state`;
  }
  return undefined;
}

export class FreshnessAuthorityChangedError extends Error {
  readonly code = "CODEXA_FRESHNESS_AUTHORITY_CHANGED";

  constructor(
    readonly freshness: FreshnessInfo,
    readonly reason: string
  ) {
    super(reason);
    this.name = "FreshnessAuthorityChangedError";
  }
}

/**
 * Re-check the live checkout at the authoritative persistence boundary.
 * This is deliberately a filesystem/Git compare-and-set guard only: callers
 * retain the context they already computed and do not repeat query analysis.
 */
export async function assertFreshnessAuthorityCurrent(
  repoRoot: string,
  index: CodexaIndex,
  expectedFreshness?: FreshnessInfo
): Promise<FreshnessInfo> {
  const freshness = await getFreshness(repoRoot, index, { recover: false });
  const identityIssue = findIndexIdentityIssue(repoRoot, index, freshness);
  const reason = identityIssue
    ? new IndexIdentityError(identityIssue).message
    : freshnessAuthorityBlockReason(freshness);
  if (reason) {
    throw new FreshnessAuthorityChangedError(freshness, reason);
  }
  if (expectedFreshness && workspaceStateDigest(freshness) !== workspaceStateDigest(expectedFreshness)) {
    throw new FreshnessAuthorityChangedError(
      freshness,
      "Codexa checkout changed after context collection; retry against the current worktree before creating authoritative task state"
    );
  }
  return freshness;
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

async function refreshIndex(repoRoot: string, force = false): Promise<CodexaIndex> {
  const existing = refreshLocks.get(repoRoot);
  if (existing) {
    return existing;
  }
  const refresh = (async () => {
    const loaded = await loadIndex(repoRoot);
    const currentFreshness = await getFreshness(repoRoot, loaded);
    const identityIssue = loaded ? findIndexIdentityIssue(repoRoot, loaded, currentFreshness) : undefined;
    if (loaded && !force && !identityIssue && !currentFreshness.stale) {
      return { ...loaded, freshness: currentFreshness };
    }
    return buildIndexLocked({ repoRoot, writeArtifacts: true });
  })().finally(() => {
    refreshLocks.delete(repoRoot);
  });
  refreshLocks.set(repoRoot, refresh);
  return refresh;
}
