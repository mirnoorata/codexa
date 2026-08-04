import { createHash, randomUUID } from "node:crypto";
import { constants, promises as fs, type BigIntStats, type Stats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";

export interface ManagedArtifactDirectory {
  directory: string;
  repoReal: string;
}

export interface ManagedArtifactIdentity {
  device: string;
  inode: string;
  modifiedTimeNs: string;
  changedTimeNs: string;
}

export interface ManagedArtifactState {
  sizeBytes: number;
  identity: ManagedArtifactIdentity;
}

export interface ManagedArtifactDigest extends ManagedArtifactState {
  sha256: string;
}

export async function ensureManagedArtifactDirectory(
  repoRoot: string,
  targetDirectory: string
): Promise<ManagedArtifactDirectory> {
  return resolveManagedArtifactDirectory(repoRoot, targetDirectory, true);
}

export async function requireManagedArtifactDirectory(
  repoRoot: string,
  targetDirectory: string
): Promise<ManagedArtifactDirectory> {
  return resolveManagedArtifactDirectory(repoRoot, targetDirectory, false);
}

export async function writeManagedArtifactText(
  boundary: ManagedArtifactDirectory,
  name: string,
  contents: string
): Promise<void> {
  await writeManagedArtifact(boundary, name, async (handle) => {
    await handle.writeFile(contents, { encoding: "utf8" });
  });
}

export async function writeManagedArtifact(
  boundary: ManagedArtifactDirectory,
  name: string,
  writer: (handle: FileHandle) => Promise<void>
): Promise<void> {
  requireArtifactSegment(name);
  await validateManagedArtifactDirectory(boundary);
  const targetPath = path.join(boundary.directory, name);
  const temporaryPath = path.join(boundary.directory, `.codexa-${process.pid}-${randomUUID()}.tmp`);
  let handle: FileHandle | undefined;
  try {
    handle = await fs.open(
      temporaryPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o600
    );
    await writer(handle);
    const written = await handle.stat();
    if (!written.isFile() || written.isSymbolicLink() || written.nlink !== 1) {
      throw new Error(`Codexa managed artifact staging file is redirected or non-regular: ${temporaryPath}`);
    }
    await handle.close();
    handle = undefined;
    await validateManagedArtifactDirectory(boundary);
    await publishManagedArtifactFile(temporaryPath, targetPath);
    const published = await fs.lstat(targetPath);
    if (!published.isFile() || published.isSymbolicLink() || published.nlink !== 1) {
      throw new Error(`Codexa managed artifact publication is redirected or non-regular: ${targetPath}`);
    }
  } finally {
    await handle?.close().catch(() => undefined);
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

export async function readManagedArtifactText(
  repoRoot: string,
  segments: readonly string[],
  maxBytes = 4 * 1024 * 1024
): Promise<string> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new Error("Codexa managed artifact read limit must be a positive integer");
  }
  if (segments.length === 0) {
    throw new Error("Codexa managed artifact path must name a file");
  }
  for (const segment of segments) requireArtifactSegment(segment);
  const repo = path.resolve(repoRoot);
  const parentSegments = segments.slice(0, -1);
  const parent = await requireManagedArtifactDirectory(repo, path.join(repo, ...parentSegments));
  const filePath = path.join(parent.directory, segments.at(-1)!);
  const beforeOpen = await fs.lstat(filePath);
  assertRegularSingleLink(beforeOpen, filePath);
  const handle = await fs.open(
    filePath,
    constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW
  );
  try {
    const opened = await handle.stat();
    assertRegularSingleLink(opened, filePath);
    if (!sameFileIdentity(beforeOpen, opened)) {
      throw new Error(`Codexa managed artifact changed while it was being opened: ${filePath}`);
    }
    if (opened.size > maxBytes) {
      throw new Error(`Codexa managed artifact exceeds ${maxBytes} bytes: ${filePath}`);
    }
    const contents = Buffer.alloc(Number(opened.size) + 1);
    let offset = 0;
    while (offset < contents.length) {
      const { bytesRead } = await handle.read(contents, offset, contents.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const afterRead = await handle.stat();
    assertRegularSingleLink(afterRead, filePath);
    if (!sameFileIdentity(opened, afterRead) || afterRead.size !== opened.size || offset !== opened.size) {
      throw new Error(`Codexa managed artifact changed while it was being read: ${filePath}`);
    }
    return contents.subarray(0, offset).toString("utf8");
  } finally {
    await handle.close();
  }
}

export async function digestManagedArtifact(
  repoRoot: string,
  segments: readonly string[],
  maxBytes: number
): Promise<ManagedArtifactDigest> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new Error("Codexa managed artifact digest limit must be a positive integer");
  }
  if (segments.length === 0) {
    throw new Error("Codexa managed artifact path must name a file");
  }
  for (const segment of segments) requireArtifactSegment(segment);
  const repo = path.resolve(repoRoot);
  const parentSegments = segments.slice(0, -1);
  const parent = await requireManagedArtifactDirectory(repo, path.join(repo, ...parentSegments));
  const filePath = path.join(parent.directory, segments.at(-1)!);
  const beforeOpen = await fs.lstat(filePath, { bigint: true });
  assertRegularSingleLink(beforeOpen, filePath);
  const handle = await fs.open(
    filePath,
    constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW
  );
  try {
    const opened = await handle.stat({ bigint: true });
    assertRegularSingleLink(opened, filePath);
    if (!sameFileIdentity(beforeOpen, opened)) {
      throw new Error(`Codexa managed artifact changed while it was being opened: ${filePath}`);
    }
    if (opened.size > BigInt(maxBytes)) {
      throw new Error(`Codexa managed artifact exceeds ${maxBytes} bytes: ${filePath}`);
    }
    const openedSize = Number(opened.size);
    const hash = createHash("sha256");
    const chunk = Buffer.allocUnsafe(Math.min(1024 * 1024, Math.max(1, openedSize)));
    let offset = 0;
    while (offset < openedSize) {
      const requested = Math.min(chunk.length, openedSize - offset);
      const { bytesRead } = await handle.read(chunk, 0, requested, offset);
      if (bytesRead < 1) {
        throw new Error(`Codexa managed artifact ended before its declared size: ${filePath}`);
      }
      hash.update(chunk.subarray(0, bytesRead));
      offset += bytesRead;
    }
    const afterRead = await handle.stat({ bigint: true });
    assertRegularSingleLink(afterRead, filePath);
    if (!sameBigIntFileState(opened, afterRead) || offset !== openedSize) {
      throw new Error(`Codexa managed artifact changed while it was being digested: ${filePath}`);
    }
    await validateManagedArtifactDirectory(parent);
    const named = await fs.lstat(filePath, { bigint: true });
    assertRegularSingleLink(named, filePath);
    if (!sameBigIntFileState(afterRead, named)) {
      throw new Error(`Codexa managed artifact path changed while it was being digested: ${filePath}`);
    }
    return {
      sizeBytes: openedSize,
      sha256: hash.digest("hex"),
      identity: managedArtifactIdentity(named)
    };
  } finally {
    await handle.close();
  }
}

export async function inspectManagedArtifact(
  repoRoot: string,
  segments: readonly string[],
  maxBytes: number
): Promise<ManagedArtifactState> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new Error("Codexa managed artifact inspection limit must be a positive integer");
  }
  if (segments.length === 0) {
    throw new Error("Codexa managed artifact path must name a file");
  }
  for (const segment of segments) requireArtifactSegment(segment);
  const repo = path.resolve(repoRoot);
  const parentSegments = segments.slice(0, -1);
  const parent = await requireManagedArtifactDirectory(repo, path.join(repo, ...parentSegments));
  const filePath = path.join(parent.directory, segments.at(-1)!);
  const beforeOpen = await fs.lstat(filePath, { bigint: true });
  assertRegularSingleLink(beforeOpen, filePath);
  const handle = await fs.open(
    filePath,
    constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW
  );
  try {
    const opened = await handle.stat({ bigint: true });
    assertRegularSingleLink(opened, filePath);
    if (!sameBigIntFileState(beforeOpen, opened)) {
      throw new Error(`Codexa managed artifact changed while it was being inspected: ${filePath}`);
    }
    if (opened.size > BigInt(maxBytes)) {
      throw new Error(`Codexa managed artifact exceeds ${maxBytes} bytes: ${filePath}`);
    }
    await validateManagedArtifactDirectory(parent);
    const named = await fs.lstat(filePath, { bigint: true });
    assertRegularSingleLink(named, filePath);
    if (!sameBigIntFileState(opened, named)) {
      throw new Error(`Codexa managed artifact path changed while it was being inspected: ${filePath}`);
    }
    return { sizeBytes: Number(named.size), identity: managedArtifactIdentity(named) };
  } finally {
    await handle.close();
  }
}

/**
 * Prove that this artifact's filesystem advances ctime for the same-inode,
 * same-size rewrite an integrity cache must detect. The byte is written back
 * unchanged and the original mtime is restored before each observation. A
 * false result disables the metadata fast path; callers still verify SHA-256.
 */
export async function probeManagedArtifactMetadataFastPath(
  repoRoot: string,
  segments: readonly string[],
  maxBytes: number
): Promise<boolean> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new Error("Codexa managed artifact probe limit must be a positive integer");
  }
  if (segments.length === 0) {
    throw new Error("Codexa managed artifact path must name a file");
  }
  for (const segment of segments) requireArtifactSegment(segment);
  const repo = path.resolve(repoRoot);
  const parentSegments = segments.slice(0, -1);
  const parent = await requireManagedArtifactDirectory(repo, path.join(repo, ...parentSegments));
  const filePath = path.join(parent.directory, segments.at(-1)!);
  const beforeOpen = await fs.lstat(filePath, { bigint: true });
  assertRegularSingleLink(beforeOpen, filePath);
  const handle = await fs.open(
    filePath,
    constants.O_RDWR | constants.O_NONBLOCK | constants.O_NOFOLLOW
  );
  try {
    const opened = await handle.stat({ bigint: true });
    assertRegularSingleLink(opened, filePath);
    if (!sameBigIntFileState(beforeOpen, opened)) {
      throw new Error(`Codexa managed artifact changed while it was being probed: ${filePath}`);
    }
    if (opened.size < 1n || opened.size > BigInt(maxBytes)) {
      return false;
    }

    const byte = Buffer.allocUnsafe(1);
    const read = await handle.read(byte, 0, 1, 0);
    if (read.bytesRead !== 1) {
      throw new Error(`Codexa managed artifact could not be sampled for metadata probing: ${filePath}`);
    }
    const originalAtimeSeconds = Number(opened.atimeNs) / 1_000_000_000;
    const originalMtimeSeconds = Number(opened.mtimeNs) / 1_000_000_000;
    let observed = opened;
    let capable = true;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const written = await handle.write(byte, 0, 1, 0);
      if (written.bytesWritten !== 1) {
        throw new Error(`Codexa managed artifact could not be rewritten for metadata probing: ${filePath}`);
      }
      await handle.sync();
      await handle.utimes(originalAtimeSeconds, originalMtimeSeconds);
      await handle.sync();
      const afterWrite = await handle.stat({ bigint: true });
      assertRegularSingleLink(afterWrite, filePath);
      if (!sameFileIdentity(observed, afterWrite) || observed.size !== afterWrite.size) {
        throw new Error(`Codexa managed artifact changed identity while it was being probed: ${filePath}`);
      }
      if (afterWrite.ctimeNs <= observed.ctimeNs) capable = false;
      observed = afterWrite;
    }

    await validateManagedArtifactDirectory(parent);
    const named = await fs.lstat(filePath, { bigint: true });
    assertRegularSingleLink(named, filePath);
    if (!sameBigIntFileState(observed, named)) {
      throw new Error(`Codexa managed artifact path changed while it was being probed: ${filePath}`);
    }
    return capable;
  } finally {
    await handle.close();
  }
}

async function resolveManagedArtifactDirectory(
  repoRoot: string,
  targetDirectory: string,
  create: boolean
): Promise<ManagedArtifactDirectory> {
  const repo = path.resolve(repoRoot);
  const target = path.resolve(targetDirectory);
  const repoReal = await fs.realpath(repo).catch(() => "");
  if (!repoReal) throw new Error("Codexa managed artifact repository root does not exist");
  const repoStat = await fs.lstat(repoReal);
  if (!repoStat.isDirectory() || repoStat.isSymbolicLink()) {
    throw new Error("Codexa managed artifact repository root is not a real directory");
  }
  const relative = containedChildRelative(repo, target) ?? containedChildRelative(repoReal, target);
  if (!relative) {
    throw new Error(`Codexa managed artifact directory must be a repository child: ${target}`);
  }

  let current = repoReal;
  for (const component of relative.split(path.sep)) {
    requireArtifactSegment(component);
    const next = path.join(current, component);
    let entry = await fs.lstat(next).catch((error: unknown) => {
      if (errorCode(error) === "ENOENT") return undefined;
      throw error;
    });
    if (!entry && create) {
      await validateDirectoryPath(current, repoReal);
      await fs.mkdir(next, { mode: 0o700 }).catch((error: unknown) => {
        if (errorCode(error) !== "EEXIST") throw error;
      });
      entry = await fs.lstat(next);
    }
    if (!entry) {
      throw new Error(`Codexa managed artifact directory does not exist: ${next}`);
    }
    await validateDirectoryPath(next, repoReal, entry);
    current = next;
  }
  return { directory: current, repoReal };
}

async function validateManagedArtifactDirectory(boundary: ManagedArtifactDirectory): Promise<void> {
  await validateDirectoryPath(boundary.directory, boundary.repoReal);
}

async function validateDirectoryPath(directory: string, repoReal: string, knownEntry?: Stats): Promise<void> {
  const entry = knownEntry ?? (await fs.lstat(directory));
  const directoryReal = await fs.realpath(directory);
  const relative = path.relative(repoReal, directoryReal);
  if (
    !entry.isDirectory() ||
    entry.isSymbolicLink() ||
    !isContainedRelative(relative)
  ) {
    throw new Error(`Codexa managed artifact directory escapes the repository or traverses a symbolic link: ${directory}`);
  }
}

function containedChildRelative(parent: string, candidate: string): string | undefined {
  const relative = path.relative(parent, candidate);
  return relative && isContainedRelative(relative) ? relative : undefined;
}

function isContainedRelative(relative: string): boolean {
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function publishManagedArtifactFile(temporaryPath: string, targetPath: string): Promise<void> {
  try {
    await fs.rename(temporaryPath, targetPath);
    return;
  } catch (error) {
    if (!new Set(["EACCES", "EEXIST", "ENOTEMPTY", "EPERM"]).has(errorCode(error))) throw error;
  }

  const existing = await fs.lstat(targetPath).catch((error: unknown) => {
    if (errorCode(error) === "ENOENT") return undefined;
    throw error;
  });
  if (!existing) {
    await fs.rename(temporaryPath, targetPath);
    return;
  }
  if (!existing.isFile() && !existing.isSymbolicLink()) {
    throw new Error(`Codexa refuses to replace non-file managed artifact entry: ${targetPath}`);
  }
  await fs.rm(targetPath, { force: true });
  await fs.rename(temporaryPath, targetPath);
}

export function isManagedArtifactSegment(segment: string): boolean {
  return Boolean(
    segment &&
    segment !== "." &&
    segment !== ".." &&
    !path.isAbsolute(segment) &&
    !segment.includes("/") &&
    !segment.includes("\\") &&
    !/[\u0000-\u001f<>:"|?*]/u.test(segment) &&
    !/[. ]$/u.test(segment) &&
    !/^(?:aux|con|nul|prn|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(segment)
  );
}

function requireArtifactSegment(segment: string): void {
  if (!isManagedArtifactSegment(segment)) {
    throw new Error("Invalid Codexa managed artifact path segment");
  }
}

function assertRegularSingleLink(entry: Stats | BigIntStats, filePath: string): void {
  const singleLink = typeof entry.nlink === "bigint" ? entry.nlink === 1n : entry.nlink === 1;
  if (!entry.isFile() || entry.isSymbolicLink() || !singleLink) {
    throw new Error(`Codexa refuses redirected or non-regular managed artifact: ${filePath}`);
  }
}

function sameFileIdentity(left: Stats | BigIntStats, right: Stats | BigIntStats): boolean {
  return String(left.dev) === String(right.dev) && String(left.ino) === String(right.ino);
}

function sameBigIntFileState(left: BigIntStats, right: BigIntStats): boolean {
  return (
    sameFileIdentity(left, right) &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function managedArtifactIdentity(entry: BigIntStats): ManagedArtifactIdentity {
  return {
    device: String(entry.dev),
    inode: String(entry.ino),
    modifiedTimeNs: String(entry.mtimeNs),
    changedTimeNs: String(entry.ctimeNs)
  };
}

function errorCode(error: unknown): string {
  return error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code)
    : "";
}
