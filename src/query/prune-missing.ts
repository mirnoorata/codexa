import { existsSync } from "node:fs";
import path from "node:path";

export interface PruneMissingResult<T> {
  entries: T[];
  prunedCount: number;
}

// A stale index can still rank files that no longer exist on disk; a packet
// that tells the reader to open a ghost burns trust in every other line.
// Prune at emission — and surface the count through prunedFilesGap so the
// staleness signal that should drive an index rebuild stays visible instead
// of being silently compensated away. Called on already-sliced lists, so
// the existsSync cost is bounded by the packet limit.
export function pruneMissingFiles<T>(entries: T[], repoRoot: string, pathOf: (entry: T) => string): PruneMissingResult<T> {
  const kept = entries.filter((entry) => {
    const relative = pathOf(entry);
    return typeof relative === "string" && relative.length > 0 && existsSync(path.join(repoRoot, relative));
  });
  return { entries: kept, prunedCount: entries.length - kept.length };
}

export function prunedFilesGap(prunedCount: number): string {
  return `${prunedCount} indexed file(s) no longer exist on disk and were pruned from this packet; rebuild the index`;
}
