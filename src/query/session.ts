import path from "node:path";
import { createCommandBudget, runCommand, type CommandBudget, type CommandResult, type RunCommandOptions } from "../command.js";
import type { GitState } from "../git.js";
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
  commandBudget: CommandBudget;
  commandBudgetUsedMs(): number;
  commandBudgetRemainingMs(): number;
  maxResultBytes: number;
  maxResults: number;
  warnings: string[];
  provenance: string[];
  /**
   * Reasons git-based worktree inspection could not complete. Each entry
   * names a specific command that failed (rev-parse / status / diff) plus
   * the failure mode (timeout, truncated, non-zero exit). Callers that act
   * on an empty change set MUST check this — an empty `getChangedFileEntries`
   * result paired with a non-empty `worktreeDegradationReasons` means
   * "don't know", NOT "clean tree".
   */
  worktreeDegradationReasons: string[];
  runCommand(command: string, args: string[], options?: RunCommandOptions): Promise<CommandResult>;
  getChangedFileEntries(): Promise<ChangedFileEntry[]>;
  getChangedFiles(): Promise<string[]>;
  getChangedSymbols(): Promise<ChangedSymbol[]>;
}

export type QuerySessionInput = string | QuerySession;
export interface QuerySessionIndexState {
  index: CodexaIndex;
  freshness: FreshnessInfo;
  refresh?: RefreshInfo;
}

const DEFAULT_COMMAND_BUDGET_MS = 10_000;
const DEFAULT_MAX_RESULT_BYTES = 64 * 1024;
const DEFAULT_MAX_RESULTS = 50;

export async function createQuerySession(repoRoot: string, options: QueryOptions = {}): Promise<QuerySession> {
  const repo = path.resolve(repoRoot);
  return createQuerySessionFromIndexState(repo, await requireIndex(repo, options), options);
}

export function createQuerySessionFromIndexState(repoRoot: string, state: QuerySessionIndexState, options: QueryOptions = {}): QuerySession {
  const repo = path.resolve(repoRoot);
  const { index, freshness, refresh } = state;
  const gitState = gitStateFromFreshness(repo, freshness);
  const warnings: string[] = [];
  const provenance: string[] = [
    `index:${index.freshness.indexedAt}`,
    `freshness:${freshness.reason}`,
    `git:${gitState.headCommit ?? "none"}`
  ];
  if (freshness.stale) {
    warnings.push(`index stale: ${freshness.reason}`);
  }
  const commandBudget = createCommandBudget(positiveInt(options.commandBudgetMs, DEFAULT_COMMAND_BUDGET_MS), warnings, provenance);

  let changedEntriesPromise: Promise<ChangedFileEntry[]> | undefined;
  let changedSymbolsPromise: Promise<ChangedSymbol[]> | undefined;
  const worktreeDegradationReasons: string[] = [];
  const recordWorktreeDegradation = (reason: string | null, subject: string) => {
    if (!reason) {
      return;
    }
    worktreeDegradationReasons.push(reason);
    warnings.push(`worktree ${subject} unavailable: ${reason}`);
    provenance.push(`worktree-degraded:${subject}:${reason}`);
  };
  const session: QuerySession = {
    repoRoot: repo,
    options,
    index,
    freshness,
    refresh,
    gitState,
    commandBudgetMs: commandBudget.totalMs,
    commandBudget,
    commandBudgetUsedMs: () => commandBudget.usedMs,
    commandBudgetRemainingMs: () => commandBudget.remainingMs(),
    maxResultBytes: positiveInt(options.maxResultBytes, DEFAULT_MAX_RESULT_BYTES),
    maxResults: positiveInt(options.maxResults, DEFAULT_MAX_RESULTS),
    warnings,
    provenance,
    worktreeDegradationReasons,
    runCommand: async (command, args, runOptions = {}) => runCommand(command, args, { ...runOptions, budget: runOptions.budget ?? commandBudget }),
    getChangedFileEntries: async () => {
      changedEntriesPromise ??= getChangedFileEntries(repo, session.runCommand).then((result) => {
        recordWorktreeDegradation(result.degradedReason, "status");
        provenance.push(`changed-files:${result.entries.length}`);
        return result.entries;
      });
      return changedEntriesPromise;
    },
    getChangedFiles: async () => (await session.getChangedFileEntries()).map((entry) => entry.path),
    getChangedSymbols: async () => {
      changedSymbolsPromise ??= getChangedSymbols(repo, index, session.runCommand).then((result) => {
        recordWorktreeDegradation(result.degradedReason, "diff");
        provenance.push(`changed-symbols:${result.symbols.length}`);
        return result.symbols;
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

function gitStateFromFreshness(repoRoot: string, freshness: FreshnessInfo): GitState {
  return {
    repoRoot,
    gitRoot: freshness.gitRoot,
    headCommit: freshness.headCommit,
    files: [],
    dirtyFiles: freshness.dirtyFiles,
    churnByPath: new Map()
  };
}
