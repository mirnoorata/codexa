import { createHash } from "node:crypto";
import { promises as fs, type Dirent, type Stats } from "node:fs";
import path from "node:path";
import {
  assertSafeManagedDirectory,
  assertSafeManagedFile
} from "./init-portability.js";

const ADOPTION_SCAN_TIMEOUT_MS = 20_000;
const DIST_RUNTIME_MAX_ENTRIES = 10_000;
const DIST_RUNTIME_MAX_LOGICAL_BYTES = 256 * 1024 * 1024;
const DIST_RUNTIME_MAX_FILE_BYTES = 128 * 1024 * 1024;
const DEPENDENCY_MAX_ENTRIES = 100_000;
const DEPENDENCY_MAX_LOGICAL_BYTES = 2 * 1024 * 1024 * 1024;
const DEPENDENCY_MAX_FILE_BYTES = 256 * 1024 * 1024;
export const STARTUP_INPUT_MAX_BYTES = 16 * 1024 * 1024;
const PACKAGE_LOCK_MAX_ENTRIES = 100_000;

export interface WorktreeBootstrapAdoptionFacts {
  distCliSha256: string;
  distRuntimeSha256: string;
  dependencyInventory: {
    sha256: string;
    count: number;
    fileCount: number;
    logicalBytes: number;
  };
}

interface AdoptionScanBudget {
  label: string;
  deadlineAt: number;
  maxEntries: number;
  maxLogicalBytes: number;
  maxFileBytes: number;
  entries: number;
  logicalBytes: number;
}

export async function currentAdoptionReceiptFacts(
  repoRoot: string
): Promise<WorktreeBootstrapAdoptionFacts> {
  const repo = path.resolve(repoRoot);
  const packageLockPath = path.join(repo, "package-lock.json");
  const dist = path.join(repo, "dist");
  await assertSafeManagedDirectory(dist);
  const deadlineAt = Date.now() + ADOPTION_SCAN_TIMEOUT_MS;
  return {
    distRuntimeSha256: await hashBoundedRegularTree(
      repo,
      dist,
      createScanBudget(
        "dist-runtime",
        deadlineAt,
        DIST_RUNTIME_MAX_ENTRIES,
        DIST_RUNTIME_MAX_LOGICAL_BYTES,
        DIST_RUNTIME_MAX_FILE_BYTES
      )
    ),
    distCliSha256: sha256(await readBoundedStableRegularFile(
      path.join(dist, "cli.js"),
      DIST_RUNTIME_MAX_FILE_BYTES,
      "dist-cli",
      deadlineAt
    )),
    dependencyInventory: await installedDependencyInventory(repo, packageLockPath, deadlineAt)
  };
}

async function installedDependencyInventory(
  repoRoot: string,
  packageLockPath: string,
  deadlineAt: number
): Promise<{ sha256: string; count: number; fileCount: number; logicalBytes: number }> {
  const repoReal = await fs.realpath(repoRoot);
  const nodeModules = path.join(repoRoot, "node_modules");
  const nodeModulesEntry = await fs.lstat(nodeModules);
  if (!nodeModulesEntry.isDirectory() || nodeModulesEntry.isSymbolicLink()) {
    throw new Error("dependency-root-invalid");
  }
  const nodeModulesReal = await fs.realpath(nodeModules);
  if (!isContainedPath(repoReal, nodeModulesReal)) {
    throw new Error("dependency-root-outside-repository");
  }
  const lock = JSON.parse((await readBoundedStableRegularFile(
    packageLockPath,
    STARTUP_INPUT_MAX_BYTES,
    "package-lock",
    deadlineAt
  )).toString("utf8")) as {
    packages?: Record<string, unknown>;
  };
  assertAdoptionDeadline(deadlineAt);
  if (!lock.packages || typeof lock.packages !== "object" || Array.isArray(lock.packages)) {
    throw new Error("package-lock-packages-missing");
  }
  const lockedPackagePaths: string[] = [];
  const installedPackagePaths: string[] = [];
  let packageLockEntries = 0;
  for (const lockPath in lock.packages) {
    if (!Object.prototype.hasOwnProperty.call(lock.packages, lockPath)) continue;
    assertAdoptionDeadline(deadlineAt);
    packageLockEntries += 1;
    if (packageLockEntries > PACKAGE_LOCK_MAX_ENTRIES) {
      throw new Error("package-lock-entry-limit-exceeded");
    }
    if (lockPath.startsWith("node_modules/")) lockedPackagePaths.push(lockPath);
  }
  lockedPackagePaths.sort();
  for (const lockPath of lockedPackagePaths) {
    assertAdoptionDeadline(deadlineAt);
    const packageDir = path.resolve(repoRoot, ...lockPath.split("/"));
    if (
      !isContainedPath(nodeModules, packageDir) ||
      path.relative(repoRoot, packageDir).replaceAll(path.sep, "/") !== lockPath
    ) {
      throw new Error(`package-lock-path-invalid:${lockPath.slice(0, 256)}`);
    }
    let entry;
    try {
      entry = await fs.lstat(packageDir);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") continue;
      throw error;
    }
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new Error(`dependency-directory-invalid:${lockPath}`);
    }
    if (!isContainedPath(nodeModulesReal, await fs.realpath(packageDir))) {
      throw new Error(`dependency-directory-outside-repository:${lockPath}`);
    }
    installedPackagePaths.push(lockPath);
  }

  const tree = await hashDependencyTree(
    repoRoot,
    nodeModulesReal,
    createScanBudget(
      "dependency-inventory",
      deadlineAt,
      DEPENDENCY_MAX_ENTRIES,
      DEPENDENCY_MAX_LOGICAL_BYTES,
      DEPENDENCY_MAX_FILE_BYTES
    )
  );
  return {
    sha256: createHash("sha256")
      .update(installedPackagePaths.join("\n"), "utf8")
      .update(`\0${tree.sha256}`, "utf8")
      .digest("hex"),
    count: installedPackagePaths.length,
    fileCount: tree.fileCount,
    logicalBytes: tree.logicalBytes
  };
}

function createScanBudget(
  label: string,
  deadlineAt: number,
  maxEntries: number,
  maxLogicalBytes: number,
  maxFileBytes: number
): AdoptionScanBudget {
  return {
    label,
    deadlineAt,
    maxEntries,
    maxLogicalBytes,
    maxFileBytes,
    entries: 0,
    logicalBytes: 0
  };
}

async function hashBoundedRegularTree(
  repoRoot: string,
  directory: string,
  budget: AdoptionScanBudget
): Promise<string> {
  const repoReal = await fs.realpath(repoRoot);
  const directoryReal = await fs.realpath(directory);
  if (!isContainedPath(repoReal, directoryReal)) throw new Error("tree-outside-repository");
  const hash = createHash("sha256");
  const scratch = Buffer.allocUnsafe(1024 * 1024);
  const visit = async (current: string): Promise<void> => {
    assertAdoptionDeadline(budget.deadlineAt);
    const entries = await readBoundedDirectoryEntries(current, budget);
    for (const entry of entries) {
      const candidate = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await assertSafeManagedDirectory(candidate);
        consumeAdoptionBytes(budget, 0);
        hash.update(`D\0${path.relative(directory, candidate).replaceAll(path.sep, "/")}\0`, "utf8");
        await visit(candidate);
      } else if (entry.isFile()) {
        await assertSafeManagedFile(candidate);
        const stat = await fs.lstat(candidate);
        consumeAdoptionBytes(budget, stat.size);
        hash.update(
          `F\0${path.relative(directory, candidate).replaceAll(path.sep, "/")}` +
          `\0${(stat.mode & 0o777).toString(8)}\0${stat.size}\0`,
          "utf8"
        );
        await updateHashFromFile(hash, candidate, stat, scratch, budget.deadlineAt);
      } else {
        throw new Error(`non-regular-tree-entry:${path.relative(repoRoot, candidate)}`);
      }
    }
  };
  await visit(directory);
  return hash.digest("hex");
}

async function hashDependencyTree(
  repoRoot: string,
  nodeModulesReal: string,
  budget: AdoptionScanBudget
): Promise<{ sha256: string; fileCount: number; logicalBytes: number }> {
  const hash = createHash("sha256");
  const scratch = Buffer.allocUnsafe(1024 * 1024);
  let fileCount = 0;
  const visit = async (current: string): Promise<void> => {
    assertAdoptionDeadline(budget.deadlineAt);
    const entries = await readBoundedDirectoryEntries(current, budget);
    for (const entry of entries) {
      const candidate = path.join(current, entry.name);
      const relative = path.relative(nodeModulesReal, candidate).replaceAll(path.sep, "/");
      if (entry.isDirectory()) {
        const stat = await fs.lstat(candidate);
        if (!stat.isDirectory() || stat.isSymbolicLink()) {
          throw new Error(`dependency-directory-invalid:${relative}`);
        }
        if (!isContainedPath(nodeModulesReal, await fs.realpath(candidate))) {
          throw new Error(`dependency-directory-outside-root:${relative}`);
        }
        consumeAdoptionBytes(budget, 0);
        hash.update(`D\0${relative}\0${(stat.mode & 0o777).toString(8)}\0`, "utf8");
        await visit(candidate);
      } else if (entry.isFile()) {
        const stat = await assertDependencyRegularFile(nodeModulesReal, candidate);
        consumeAdoptionBytes(budget, stat.size);
        fileCount += 1;
        hash.update(`F\0${relative}\0${(stat.mode & 0o777).toString(8)}\0${stat.size}\0`, "utf8");
        await updateHashFromFile(hash, candidate, stat, scratch, budget.deadlineAt);
      } else if (entry.isSymbolicLink()) {
        const target = await fs.readlink(candidate);
        const resolved = await fs.realpath(candidate);
        if (!isContainedPath(nodeModulesReal, resolved)) {
          throw new Error(`dependency-symlink-outside-root:${relative}`);
        }
        consumeAdoptionBytes(budget, Buffer.byteLength(target));
        hash.update(`L\0${relative}\0${target}\0`, "utf8");
      } else {
        throw new Error(`dependency-entry-invalid:${relative}`);
      }
    }
  };
  await visit(nodeModulesReal);
  return {
    sha256: hash.digest("hex"),
    fileCount,
    logicalBytes: budget.logicalBytes
  };
}

async function updateHashFromFile(
  hash: ReturnType<typeof createHash>,
  filePath: string,
  expected: Stats,
  scratch: Buffer,
  deadlineAt: number
): Promise<void> {
  const handle = await fs.open(filePath, "r");
  try {
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      opened.dev !== expected.dev ||
      opened.ino !== expected.ino ||
      opened.size !== expected.size ||
      opened.mode !== expected.mode ||
      opened.nlink !== expected.nlink
    ) {
      throw new Error("adoption-file-changed-during-scan");
    }
    let position = 0;
    while (position < expected.size) {
      assertAdoptionDeadline(deadlineAt);
      const length = Math.min(scratch.length, expected.size - position);
      const { bytesRead } = await handle.read(scratch, 0, length, position);
      if (bytesRead <= 0) throw new Error("adoption-file-changed-during-scan");
      hash.update(scratch.subarray(0, bytesRead));
      position += bytesRead;
    }
    const final = await handle.stat();
    if (
      final.dev !== opened.dev ||
      final.ino !== opened.ino ||
      final.size !== opened.size ||
      final.mode !== opened.mode ||
      final.nlink !== opened.nlink ||
      final.mtimeMs !== opened.mtimeMs ||
      final.ctimeMs !== opened.ctimeMs
    ) {
      throw new Error("adoption-file-changed-during-scan");
    }
    const named = await fs.lstat(filePath).catch((error: unknown) => {
      if (isNodeError(error) && error.code === "ENOENT") {
        throw new Error("adoption-file-changed-during-scan");
      }
      throw error;
    });
    if (
      !named.isFile() ||
      named.isSymbolicLink() ||
      named.dev !== final.dev ||
      named.ino !== final.ino ||
      named.size !== final.size ||
      named.mode !== final.mode ||
      named.nlink !== final.nlink ||
      named.mtimeMs !== final.mtimeMs ||
      named.ctimeMs !== final.ctimeMs
    ) {
      throw new Error("adoption-file-changed-during-scan");
    }
    assertAdoptionDeadline(deadlineAt);
  } finally {
    await handle.close();
  }
}

function consumeAdoptionBytes(budget: AdoptionScanBudget, logicalBytes: number): void {
  assertAdoptionDeadline(budget.deadlineAt);
  budget.logicalBytes += logicalBytes;
  if (logicalBytes > budget.maxFileBytes) {
    throw new Error(`${budget.label}-file-size-limit-exceeded`);
  }
  if (budget.logicalBytes > budget.maxLogicalBytes) {
    throw new Error(`${budget.label}-byte-limit-exceeded`);
  }
}

function assertAdoptionDeadline(deadlineAt: number): void {
  if (Date.now() > deadlineAt) throw new Error("adoption-scan-timeout");
}

async function readBoundedDirectoryEntries(
  directory: string,
  budget: AdoptionScanBudget
): Promise<Dirent[]> {
  const entries: Dirent[] = [];
  const handle = await fs.opendir(directory);
  try {
    while (true) {
      assertAdoptionDeadline(budget.deadlineAt);
      const entry = await handle.read();
      if (!entry) break;
      budget.entries += 1;
      if (budget.entries > budget.maxEntries) {
        throw new Error(`${budget.label}-entry-limit-exceeded`);
      }
      entries.push(entry);
    }
  } finally {
    await handle.close();
  }
  assertAdoptionDeadline(budget.deadlineAt);
  return entries.sort((left, right) => compareEntryNames(left.name, right.name));
}

function compareEntryNames(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

async function assertDependencyRegularFile(
  nodeModulesReal: string,
  filePath: string
) {
  const stat = await fs.lstat(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`dependency-file-invalid:${path.relative(nodeModulesReal, filePath)}`);
  }
  if (!isContainedPath(nodeModulesReal, await fs.realpath(filePath))) {
    throw new Error(`dependency-file-outside-root:${path.relative(nodeModulesReal, filePath)}`);
  }
  return stat;
}

export async function readBoundedStableRegularFile(
  filePath: string,
  maxBytes: number,
  label: string,
  deadlineAt?: number
): Promise<Buffer> {
  if (deadlineAt !== undefined) assertAdoptionDeadline(deadlineAt);
  await assertSafeManagedFile(filePath);
  const expected = await fs.lstat(filePath);
  if (!expected.isFile() || expected.isSymbolicLink() || expected.nlink !== 1) {
    throw new Error(`${label}-invalid`);
  }
  if (expected.size > maxBytes) throw new Error(`${label}-size-limit-exceeded`);
  const handle = await fs.open(filePath, "r").catch((error: unknown) => {
    if (isNodeError(error) && error.code === "ENOENT") {
      throw new Error(`${label}-changed-during-read`);
    }
    throw error;
  });
  try {
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      opened.dev !== expected.dev ||
      opened.ino !== expected.ino ||
      opened.size !== expected.size ||
      opened.mode !== expected.mode ||
      opened.nlink !== expected.nlink
    ) {
      throw new Error(`${label}-changed-during-read`);
    }
    const contents = Buffer.alloc(expected.size);
    let position = 0;
    while (position < contents.length) {
      if (deadlineAt !== undefined) assertAdoptionDeadline(deadlineAt);
      const { bytesRead } = await handle.read(
        contents,
        position,
        contents.length - position,
        position
      );
      if (bytesRead <= 0) throw new Error(`${label}-changed-during-read`);
      position += bytesRead;
    }
    const final = await handle.stat();
    if (
      final.dev !== opened.dev ||
      final.ino !== opened.ino ||
      final.size !== opened.size ||
      final.mode !== opened.mode ||
      final.nlink !== opened.nlink ||
      final.mtimeMs !== opened.mtimeMs ||
      final.ctimeMs !== opened.ctimeMs
    ) {
      throw new Error(`${label}-changed-during-read`);
    }
    const named = await fs.lstat(filePath).catch((error: unknown) => {
      if (isNodeError(error) && error.code === "ENOENT") {
        throw new Error(`${label}-changed-during-read`);
      }
      throw error;
    });
    if (
      !named.isFile() ||
      named.isSymbolicLink() ||
      named.nlink !== final.nlink ||
      named.dev !== final.dev ||
      named.ino !== final.ino ||
      named.size !== final.size ||
      named.mode !== final.mode ||
      named.mtimeMs !== final.mtimeMs ||
      named.ctimeMs !== final.ctimeMs
    ) {
      throw new Error(`${label}-changed-during-read`);
    }
    if (deadlineAt !== undefined) assertAdoptionDeadline(deadlineAt);
    return contents;
  } finally {
    await handle.close();
  }
}

function sha256(contents: Buffer): string {
  return createHash("sha256").update(contents).digest("hex");
}

function isContainedPath(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
