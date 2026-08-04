import { createHash, randomUUID } from "node:crypto";
import { constants, promises as fs, type Stats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";

export interface ManagedArtifactDirectory {
  directory: string;
  repoReal: string;
}

export interface ManagedArtifactDigest {
  sizeBytes: number;
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
    const hash = createHash("sha256");
    const chunk = Buffer.allocUnsafe(Math.min(1024 * 1024, Math.max(1, opened.size)));
    let offset = 0;
    while (offset < opened.size) {
      const requested = Math.min(chunk.length, opened.size - offset);
      const { bytesRead } = await handle.read(chunk, 0, requested, offset);
      if (bytesRead < 1) {
        throw new Error(`Codexa managed artifact ended before its declared size: ${filePath}`);
      }
      hash.update(chunk.subarray(0, bytesRead));
      offset += bytesRead;
    }
    const afterRead = await handle.stat();
    assertRegularSingleLink(afterRead, filePath);
    if (!sameFileIdentity(opened, afterRead) || afterRead.size !== opened.size || offset !== opened.size) {
      throw new Error(`Codexa managed artifact changed while it was being digested: ${filePath}`);
    }
    await validateManagedArtifactDirectory(parent);
    const named = await fs.lstat(filePath);
    assertRegularSingleLink(named, filePath);
    if (!sameFileIdentity(afterRead, named) || named.size !== afterRead.size) {
      throw new Error(`Codexa managed artifact path changed while it was being digested: ${filePath}`);
    }
    return { sizeBytes: opened.size, sha256: hash.digest("hex") };
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

function assertRegularSingleLink(entry: Stats, filePath: string): void {
  if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1) {
    throw new Error(`Codexa refuses redirected or non-regular managed artifact: ${filePath}`);
  }
}

function sameFileIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function errorCode(error: unknown): string {
  return error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code)
    : "";
}
