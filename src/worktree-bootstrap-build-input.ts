import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { assertSafeManagedDirectory, assertSafeManagedFile } from "./init-portability.js";
import {
  readBoundedStableRegularFileWithSnapshot,
  STARTUP_INPUT_MAX_BYTES
} from "./worktree-bootstrap-adoption.js";
import {
  captureStableDirectory,
  revalidateStableDirectories,
  revalidateStableTreeEntries
} from "./stable-directory-snapshot.js";
import type {
  StableDirectoryBudget,
  StableDirectorySnapshot,
  StableTreeEntrySnapshot
} from "./stable-directory-snapshot.js";

const BUILD_SCAN_TIMEOUT_MS = 10_000;
const BUILD_SCAN_MAX_FILES = 10_000;
const BUILD_SCAN_MAX_ENTRIES = 10_000;
const BUILD_SCAN_MAX_LOGICAL_BYTES = 256 * 1024 * 1024;

interface BuildScanBudget extends StableDirectoryBudget {
  deadlineAt: number;
  fileCount: number;
  logicalBytes: number;
  maxFiles: number;
  maxLogicalBytes: number;
  rootDev?: number;
  rootIno?: number;
  rootReal?: string;
}

interface BuildTreeSnapshot {
  containmentRootReal: string;
  directories: StableDirectorySnapshot[];
  entries: StableTreeEntrySnapshot[];
  files: string[];
}

export async function worktreeBootstrapBuildInputDigest(
  repoRoot: string
): Promise<string> {
  const repo = path.resolve(repoRoot);
  const budget = createBuildScanBudget();
  const tree = await regularTreeFiles(repo, path.join(repo, "src"), budget);
  const files = [
    path.join(repo, "package.json"),
    path.join(repo, "package-lock.json"),
    path.join(repo, "tsconfig.json"),
    ...tree.files
  ];
  const hash = createHash("sha256");
  hash.update("codexa-build-input-v2\0", "utf8");
  for (const file of files.sort()) {
    const read = await readBuildInput(file, budget, repo);
    tree.entries.push(read.snapshot);
    updateManifestRecord(
      hash,
      path.relative(repo, file).replaceAll(path.sep, "/"),
      read.contents
    );
  }
  const digest = hash.digest("hex");
  await revalidateStableTreeEntries(tree, budget, () => assertDeadline(budget));
  await revalidateStableDirectories(tree, budget, () => assertDeadline(budget));
  return digest;
}

async function regularTreeFiles(
  repoRoot: string,
  directory: string,
  budget: BuildScanBudget
): Promise<BuildTreeSnapshot> {
  const repoReal = await fs.realpath(repoRoot);
  const directoryStat = await fs.lstat(directory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    throw new Error(`non-regular-directory:${path.relative(repoRoot, directory)}`);
  }
  const directoryReal = await fs.realpath(directory);
  if (!isContainedPath(repoReal, directoryReal)) throw new Error("tree-outside-repository");
  const files: string[] = [];
  const directories: StableDirectorySnapshot[] = [];
  const entries: StableTreeEntrySnapshot[] = [];
  const visit = async (current: string): Promise<void> => {
    const captured = await captureStableDirectory(
      current,
      repoReal,
      budget,
      "scan",
      () => assertDeadline(budget)
    );
    directories.push(captured.snapshot);
    for (const entry of captured.entries) {
      const candidate = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await assertSafeManagedDirectory(candidate);
        await visit(candidate);
      } else if (entry.isFile()) {
        await assertSafeManagedFile(candidate);
        files.push(candidate);
      } else {
        throw new Error(`non-regular-tree-entry:${path.relative(repoRoot, candidate)}`);
      }
    }
  };
  await visit(directory);
  return { containmentRootReal: repoReal, directories, entries, files };
}

async function readBuildInput(
  filePath: string,
  budget: BuildScanBudget,
  repoRoot: string
): Promise<{ contents: Buffer; snapshot: StableTreeEntrySnapshot }> {
  assertDeadline(budget);
  budget.fileCount += 1;
  if (budget.fileCount > budget.maxFiles) {
    throw new Error(`${budget.label}-file-limit-exceeded`);
  }
  const read = await readBoundedStableRegularFileWithSnapshot(
    filePath,
    STARTUP_INPUT_MAX_BYTES,
    "build-input",
    budget.deadlineAt,
    repoRoot
  );
  budget.logicalBytes += read.contents.length;
  if (budget.logicalBytes > budget.maxLogicalBytes) {
    throw new Error(`${budget.label}-byte-limit-exceeded`);
  }
  const rootReal = await fs.realpath(repoRoot);
  const root = await fs.lstat(rootReal);
  if (
    budget.rootReal && (
      budget.rootReal !== rootReal ||
      budget.rootDev !== root.dev ||
      budget.rootIno !== root.ino
    )
  ) {
    throw new Error(`${budget.label}-repository-changed`);
  }
  budget.rootReal = rootReal;
  budget.rootDev = root.dev;
  budget.rootIno = root.ino;
  if (!isContainedPath(rootReal, read.snapshot.realPath)) {
    throw new Error("build-input-outside-repository");
  }
  assertDeadline(budget);
  return read;
}

function createBuildScanBudget(): BuildScanBudget {
  return {
    deadlineAt: Date.now() + BUILD_SCAN_TIMEOUT_MS,
    fileCount: 0,
    label: "build-input",
    logicalBytes: 0,
    maxEntries: BUILD_SCAN_MAX_ENTRIES,
    maxFiles: BUILD_SCAN_MAX_FILES,
    maxLogicalBytes: BUILD_SCAN_MAX_LOGICAL_BYTES,
    scannedDirectoryEntries: 0,
    revalidatedDirectoryEntries: 0
  };
}

function updateManifestRecord(
  hash: ReturnType<typeof createHash>,
  name: string,
  contents: Buffer
): void {
  const encodedName = Buffer.from(name, "utf8");
  hash.update(`N${encodedName.length}:`, "utf8");
  hash.update(encodedName);
  hash.update(`P${contents.length}:`, "utf8");
  hash.update(contents);
}

function assertDeadline(budget: BuildScanBudget): void {
  if (Date.now() > budget.deadlineAt) {
    throw new Error(`${budget.label}-scan-timeout`);
  }
}

function isContainedPath(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
