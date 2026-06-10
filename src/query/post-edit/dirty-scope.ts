import type { ChangedFileEntry, CodexaIndex, TaskSnapshot } from "../../types.js";
import { uniqueSorted } from "../../util.js";
import { isCodexaControlPath } from "../worktree.js";

export interface PostEditDirtyScope {
  currentDirtyPaths: string[];
  changedSinceSnapshot: ChangedFileEntry[];
  resolvedBaselineFiles: string[];
  editPaths: string[];
  unindexedEditedFiles: string[];
}

export function postEditDirtyScope(input: {
  snapshot: TaskSnapshot | undefined;
  currentEntries: ChangedFileEntry[];
  freshness: { dirtyFileHashes: Record<string, string> };
  index: CodexaIndex;
}): PostEditDirtyScope {
  const currentDirtyPaths = input.currentEntries.map((entry) => entry.path);
  const baselinePaths = new Set(input.snapshot?.dirtyBaseline.dirtyFiles ?? input.snapshot?.dirtyBaseline.changedEntries.map((entry) => entry.path) ?? []);
  const baselineHashes = input.snapshot?.dirtyBaseline.dirtyFileHashes ?? {};
  const changedSinceSnapshot = input.snapshot
    ? input.currentEntries.filter((entry) => !baselinePaths.has(entry.path) || baselineHashes[entry.path] !== input.freshness.dirtyFileHashes[entry.path])
    : input.currentEntries;
  const resolvedBaselineFiles = input.snapshot ? uniqueSorted([...baselinePaths].filter((filePath) => !currentDirtyPaths.includes(filePath))) : [];
  const editPaths = uniqueSorted(changedSinceSnapshot.map((entry) => entry.path).filter((filePath) => !isCodexaControlPath(filePath)));
  const indexedPaths = new Set(input.index.files.map((file) => file.path));
  return {
    currentDirtyPaths,
    changedSinceSnapshot,
    resolvedBaselineFiles,
    editPaths,
    unindexedEditedFiles: editPaths.filter((filePath) => !indexedPaths.has(filePath))
  };
}
