import path from "node:path";
import { getGitStateAsync, type GitState } from "../git.js";
import type { ChangedFileEntry, ChangedSymbol, CodexaIndex, FreshnessInfo, QueryOptions, RefreshInfo } from "../types.js";
import { getChangedFileEntries, getChangedSymbols } from "./worktree.js";
import { requireIndex } from "./runtime.js";

export interface QuerySession {
  repoRoot: string;
  options: QueryOptions;
  index: CodexaIndex;
  freshness: FreshnessInfo;
  refresh?: RefreshInfo;
  gitState: GitState;
  commandBudgetMs: number;
  maxResultBytes: number;
  maxResults: number;
  warnings: string[];
  provenance: string[];
  getChangedFileEntries(): Promise<ChangedFileEntry[]>;
  getChangedFiles(): Promise<string[]>;
  getChangedSymbols(): Promise<ChangedSymbol[]>;
}

export type QuerySessionInput = string | QuerySession;

const DEFAULT_COMMAND_BUDGET_MS = 10_000;
const DEFAULT_MAX_RESULT_BYTES = 64 * 1024;
const DEFAULT_MAX_RESULTS = 50;

export async function createQuerySession(repoRoot: string, options: QueryOptions = {}): Promise<QuerySession> {
  const repo = path.resolve(repoRoot);
  const { index, freshness, refresh } = await requireIndex(repo, options);
  const gitState = await getGitStateAsync(repo, { includeFiles: false, includeChurn: false });
  const warnings: string[] = [];
  const provenance: string[] = [
    `index:${index.freshness.indexedAt}`,
    `freshness:${freshness.reason}`,
    `git:${gitState.headCommit ?? "none"}`
  ];
  if (freshness.stale) {
    warnings.push(`index stale: ${freshness.reason}`);
  }

  let changedEntriesPromise: Promise<ChangedFileEntry[]> | undefined;
  let changedSymbolsPromise: Promise<ChangedSymbol[]> | undefined;
  const session: QuerySession = {
    repoRoot: repo,
    options,
    index,
    freshness,
    refresh,
    gitState,
    commandBudgetMs: positiveInt(options.commandBudgetMs, DEFAULT_COMMAND_BUDGET_MS),
    maxResultBytes: positiveInt(options.maxResultBytes, DEFAULT_MAX_RESULT_BYTES),
    maxResults: positiveInt(options.maxResults, DEFAULT_MAX_RESULTS),
    warnings,
    provenance,
    getChangedFileEntries: async () => {
      changedEntriesPromise ??= getChangedFileEntries(repo).then((entries) => {
        provenance.push(`changed-files:${entries.length}`);
        return entries;
      });
      return changedEntriesPromise;
    },
    getChangedFiles: async () => (await session.getChangedFileEntries()).map((entry) => entry.path),
    getChangedSymbols: async () => {
      changedSymbolsPromise ??= getChangedSymbols(repo, index).then((symbols) => {
        provenance.push(`changed-symbols:${symbols.length}`);
        return symbols;
      });
      return changedSymbolsPromise;
    }
  };
  return session;
}

export async function ensureQuerySession(input: QuerySessionInput, options: QueryOptions = {}): Promise<QuerySession> {
  return typeof input === "string" ? createQuerySession(input, options) : input;
}

function positiveInt(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && value !== undefined && value > 0 ? Math.trunc(value) : fallback;
}
