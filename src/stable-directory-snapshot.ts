import { createHash } from "node:crypto";
import { promises as fs, type Dirent, type Stats } from "node:fs";
import path from "node:path";

export interface StableDirectoryBudget {
  label: string;
  maxEntries: number;
  scannedDirectoryEntries: number;
  revalidatedDirectoryEntries: number;
}

export interface StableDirectorySnapshot {
  path: string;
  realPath: string;
  dev: number;
  ino: number;
  mode: number;
  nlink: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  entrySetSha256: string;
}

export interface StableDirectoryTreeSnapshot {
  containmentRootReal: string;
  directories: StableDirectorySnapshot[];
}

export interface StableTreeEntrySnapshot {
  path: string;
  kind: "file" | "symlink";
  realPath: string;
  dev: number;
  ino: number;
  mode: number;
  nlink: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  linkTarget?: string;
}

export async function captureStableDirectory(
  directory: string,
  containmentRootReal: string,
  budget: StableDirectoryBudget,
  phase: "scan" | "revalidation",
  assertDeadline: () => void
): Promise<{ entries: Dirent[]; snapshot: StableDirectorySnapshot }> {
  const before = await directorySnapshotState(
    directory,
    containmentRootReal,
    budget,
    assertDeadline
  );
  const entries = await readBoundedDirectoryEntries(
    directory,
    budget,
    phase,
    assertDeadline
  );
  const after = await directorySnapshotState(
    directory,
    containmentRootReal,
    budget,
    assertDeadline
  );
  if (!sameDirectorySnapshotState(before, after)) {
    throw changedDirectoryError(budget);
  }
  return {
    entries,
    snapshot: {
      path: directory,
      ...after,
      entrySetSha256: directoryEntrySetSha256(entries)
    }
  };
}

export async function revalidateStableDirectories(
  tree: StableDirectoryTreeSnapshot,
  budget: StableDirectoryBudget,
  assertDeadline: () => void
): Promise<void> {
  for (const expected of [...tree.directories].reverse()) {
    const current = await captureStableDirectory(
      expected.path,
      tree.containmentRootReal,
      budget,
      "revalidation",
      assertDeadline
    ).catch((error: unknown) => {
      if (
        isNodeError(error) &&
        (error.code === "ENOENT" || error.code === "ENOTDIR" || error.code === "ELOOP")
      ) {
        throw changedDirectoryError(budget);
      }
      throw error;
    });
    if (
      !sameDirectorySnapshotState(expected, current.snapshot) ||
      expected.entrySetSha256 !== current.snapshot.entrySetSha256
    ) {
      throw changedDirectoryError(budget);
    }
  }
  assertDeadline();
}

export function stableRegularFileSnapshot(
  filePath: string,
  realPath: string,
  stat: Stats
): StableTreeEntrySnapshot {
  return {
    path: filePath,
    kind: "file",
    realPath,
    dev: stat.dev,
    ino: stat.ino,
    mode: stat.mode,
    nlink: stat.nlink,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs
  };
}

export async function captureStableSymlink(
  filePath: string,
  containmentRootReal: string,
  budget: StableDirectoryBudget,
  assertDeadline: () => void
): Promise<StableTreeEntrySnapshot> {
  assertDeadline();
  const before = await fs.lstat(filePath);
  if (!before.isSymbolicLink()) throw changedEntryError(budget);
  const linkTarget = await fs.readlink(filePath);
  const realPath = await fs.realpath(filePath);
  const after = await fs.lstat(filePath);
  if (
    !after.isSymbolicLink() ||
    !sameEntryStat(before, after) ||
    !isContainedPath(containmentRootReal, realPath)
  ) {
    throw changedEntryError(budget);
  }
  assertDeadline();
  return {
    path: filePath,
    kind: "symlink",
    realPath,
    dev: after.dev,
    ino: after.ino,
    mode: after.mode,
    nlink: after.nlink,
    size: after.size,
    mtimeMs: after.mtimeMs,
    ctimeMs: after.ctimeMs,
    linkTarget
  };
}

export async function revalidateStableTreeEntries(
  tree: { containmentRootReal: string; entries: StableTreeEntrySnapshot[] },
  budget: StableDirectoryBudget,
  assertDeadline: () => void
): Promise<void> {
  for (const expected of [...tree.entries].reverse()) {
    assertDeadline();
    const current = await fs.lstat(expected.path).catch((error: unknown) => {
      if (
        isNodeError(error) &&
        (error.code === "ENOENT" || error.code === "ENOTDIR" || error.code === "ELOOP")
      ) {
        throw changedEntryError(budget);
      }
      throw error;
    });
    const expectedKindMatches = expected.kind === "file"
      ? current.isFile() && !current.isSymbolicLink()
      : current.isSymbolicLink();
    if (!expectedKindMatches || !sameEntryStat(expected, current)) {
      throw changedEntryError(budget);
    }
    const realPath = await fs.realpath(expected.path).catch((error: unknown) => {
      if (
        isNodeError(error) &&
        (error.code === "ENOENT" || error.code === "ENOTDIR" || error.code === "ELOOP")
      ) {
        throw changedEntryError(budget);
      }
      throw error;
    });
    if (
      realPath !== expected.realPath ||
      !isContainedPath(tree.containmentRootReal, realPath)
    ) {
      throw changedEntryError(budget);
    }
    if (
      expected.kind === "symlink" &&
      await fs.readlink(expected.path) !== expected.linkTarget
    ) {
      throw changedEntryError(budget);
    }
  }
  assertDeadline();
}

async function readBoundedDirectoryEntries(
  directory: string,
  budget: StableDirectoryBudget,
  phase: "scan" | "revalidation",
  assertDeadline: () => void
): Promise<Dirent[]> {
  const entries: Dirent[] = [];
  const handle = await fs.opendir(directory);
  try {
    while (true) {
      assertDeadline();
      const entry = await handle.read();
      if (!entry) break;
      const count = phase === "scan"
        ? ++budget.scannedDirectoryEntries
        : ++budget.revalidatedDirectoryEntries;
      if (count > budget.maxEntries) {
        throw new Error(`${budget.label}-entry-limit-exceeded`);
      }
      entries.push(entry);
    }
  } finally {
    await handle.close();
  }
  assertDeadline();
  return entries.sort((left, right) => compareEntryNames(left.name, right.name));
}

async function directorySnapshotState(
  directory: string,
  containmentRootReal: string,
  budget: StableDirectoryBudget,
  assertDeadline: () => void
): Promise<Omit<StableDirectorySnapshot, "path" | "entrySetSha256">> {
  assertDeadline();
  const entry = await fs.lstat(directory);
  if (!entry.isDirectory() || entry.isSymbolicLink()) {
    throw changedDirectoryError(budget);
  }
  const realPath = await fs.realpath(directory);
  if (!isContainedPath(containmentRootReal, realPath)) {
    throw changedDirectoryError(budget);
  }
  assertDeadline();
  return {
    realPath,
    dev: entry.dev,
    ino: entry.ino,
    mode: entry.mode,
    nlink: entry.nlink,
    size: entry.size,
    mtimeMs: entry.mtimeMs,
    ctimeMs: entry.ctimeMs
  };
}

function sameDirectorySnapshotState(
  left: Omit<StableDirectorySnapshot, "path" | "entrySetSha256">,
  right: Omit<StableDirectorySnapshot, "path" | "entrySetSha256">
): boolean {
  return left.realPath === right.realPath &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs;
}

function directoryEntrySetSha256(entries: Dirent[]): string {
  const hash = createHash("sha256");
  hash.update("codexa-directory-entries-v1\0", "utf8");
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    hash.update(`${directoryEntryKind(entry)}${name.length}:`, "utf8");
    hash.update(name);
  }
  return hash.digest("hex");
}

function directoryEntryKind(entry: Dirent): string {
  if (entry.isDirectory()) return "D";
  if (entry.isFile()) return "F";
  if (entry.isSymbolicLink()) return "L";
  if (entry.isBlockDevice()) return "B";
  if (entry.isCharacterDevice()) return "C";
  if (entry.isFIFO()) return "P";
  if (entry.isSocket()) return "S";
  return "U";
}

function compareEntryNames(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function changedDirectoryError(budget: StableDirectoryBudget): Error {
  return new Error(`${budget.label}-directory-changed-during-scan`);
}

function changedEntryError(budget: StableDirectoryBudget): Error {
  return new Error(`${budget.label}-entry-changed-during-scan`);
}

function sameEntryStat(
  left: Pick<StableTreeEntrySnapshot, "dev" | "ino" | "mode" | "nlink" | "size" | "mtimeMs" | "ctimeMs"> | Stats,
  right: Stats
): boolean {
  return left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs;
}

function isContainedPath(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
