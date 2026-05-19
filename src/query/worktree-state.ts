import type { ChangedFileEntry, ChangedSymbol } from "../types.js";
import type { QuerySession } from "./session.js";

export interface WorktreeState {
  entries: ChangedFileEntry[];
  files: string[];
  symbols: ChangedSymbol[];
  knownClean: boolean;
  degraded: boolean;
  degradedReasons: string[];
}

export async function getWorktreeState(session: QuerySession, options: { includeSymbols?: boolean } = {}): Promise<WorktreeState> {
  const entries = await session.getChangedFileEntries();
  const symbols = options.includeSymbols === false ? [] : await session.getChangedSymbols();
  const degradedReasons = [...new Set(session.worktreeDegradationReasons)];
  return {
    entries,
    files: entries.map((entry) => entry.path),
    symbols,
    knownClean: entries.length === 0 && symbols.length === 0 && degradedReasons.length === 0,
    degraded: degradedReasons.length > 0,
    degradedReasons
  };
}

export function worktreeStateGaps(state: WorktreeState): string[] {
  return state.degraded ? [`worktree state unavailable: ${state.degradedReasons.join("; ")}`] : [];
}

export function worktreeStateText(state: WorktreeState): string[] {
  if (!state.degraded) {
    return [];
  }
  return ["", "Worktree state:", `- unknown: ${state.degradedReasons.join("; ")}`];
}

export function compactWorktreeState(state: WorktreeState): {
  knownClean: boolean;
  degraded: boolean;
  dirtyFileCount: number;
  symbolCount: number;
  degradedReasons: string[];
} {
  return {
    knownClean: state.knownClean,
    degraded: state.degraded,
    dirtyFileCount: state.files.length,
    symbolCount: state.symbols.length,
    degradedReasons: state.degradedReasons
  };
}
