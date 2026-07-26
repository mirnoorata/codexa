import type { ChangedFileEntry, CodexaIndex, TaskSnapshot } from "../../types.js";
import { uniqueSorted } from "../../util.js";
import { isCodexaControlPath } from "../worktree.js";

export interface PostEditDirtyScope {
  currentDirtyPaths: string[];
  changedSinceSnapshot: ChangedFileEntry[];
  resolvedBaselineFiles: string[];
  editPaths: string[];
  unindexedEditedFiles: string[];
  authoritativeDeletedFiles: string[];
}

export function postEditDirtyScope(input: {
  snapshot: TaskSnapshot | undefined;
  currentEntries: ChangedFileEntry[];
  freshness: { dirtyFileHashes: Record<string, string> };
  index: CodexaIndex;
}): PostEditDirtyScope {
  const currentDirtyPaths = input.currentEntries.map((entry) => entry.path);
  const currentDirtyPathSet = new Set(currentDirtyPaths);
  const baselinePaths = new Set(input.snapshot?.dirtyBaseline.dirtyFiles ?? input.snapshot?.dirtyBaseline.changedEntries.map((entry) => entry.path) ?? []);
  const baselineHashes = input.snapshot?.dirtyBaseline.dirtyFileHashes ?? {};
  const changedSinceSnapshot = input.snapshot
    ? input.currentEntries.filter((entry) => !baselinePaths.has(entry.path) || baselineHashes[entry.path] !== input.freshness.dirtyFileHashes[entry.path])
    : input.currentEntries;
  const resolvedBaselineFiles = input.snapshot ? uniqueSorted([...baselinePaths].filter((filePath) => !currentDirtyPathSet.has(filePath))) : [];
  const editPaths = uniqueSorted(changedSinceSnapshot.map((entry) => entry.path).filter((filePath) => !isCodexaControlPath(filePath)));
  const indexedPaths = new Set(input.index.files.map((file) => file.path));
  const plannedScope = new Set(
    input.snapshot
      ? input.snapshot.plannedEditTargets.length > 0
        ? input.snapshot.plannedEditTargets
        : input.snapshot.plannedFiles
      : []
  );
  const authoritativeDeletedFiles = uniqueSorted(
    changedSinceSnapshot
      .filter((entry) => entry.kind === "deleted" && entry.status.includes("D") && plannedScope.has(entry.path))
      .map((entry) => entry.path)
  );
  const authoritativeDeletionSet = new Set(authoritativeDeletedFiles);
  return {
    currentDirtyPaths,
    changedSinceSnapshot,
    resolvedBaselineFiles,
    editPaths,
    unindexedEditedFiles: editPaths.filter((filePath) => !indexedPaths.has(filePath) && !authoritativeDeletionSet.has(filePath)),
    authoritativeDeletedFiles
  };
}
