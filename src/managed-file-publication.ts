import { promises as fs, type Stats } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  assertSafeManagedFile,
  ensureSafeManagedStateDirectory
} from "./init-portability.js";

interface ManagedDirectoryIdentity {
  dev: number;
  ino: number;
  realPath: string;
  repoRealPath: string;
}

export async function publishManagedStateFile(
  repoRoot: string,
  stateSegments: string[],
  destinationName: string,
  contents: string,
  label: string
): Promise<string> {
  const directory = await ensureSafeManagedStateDirectory(repoRoot, ...stateSegments);
  const identity = await managedDirectoryIdentity(repoRoot, directory, label);
  const destination = path.join(directory, destinationName);
  await assertSafeManagedFile(destination);
  const temporary = path.join(
    directory,
    `.${destinationName}.${process.pid}.${randomUUID()}.tmp`
  );
  const handle = await fs.open(temporary, "wx", 0o600);
  let temporaryStat: Stats | undefined;
  let published = false;
  try {
    temporaryStat = await handle.stat();
    await assertStableManagedFile(identity, directory, temporary, temporaryStat, label);
    await handle.writeFile(contents, { encoding: "utf8" });
    await handle.sync();
    const written = await handle.stat();
    if (
      written.dev !== temporaryStat.dev ||
      written.ino !== temporaryStat.ino ||
      written.nlink !== temporaryStat.nlink ||
      written.size !== Buffer.byteLength(contents, "utf8")
    ) {
      throw new Error(`${label}-temporary-changed-during-write`);
    }
    temporaryStat = written;
    await assertStableManagedFile(identity, directory, temporary, written, label);
    await assertSafeManagedFile(destination);
    await assertManagedDirectoryIdentity(identity, repoRoot, directory, label);
    await fs.rename(temporary, destination);
    await assertStableManagedFile(identity, directory, destination, written, label);
    published = true;
    return destination;
  } finally {
    await handle.close().catch(() => undefined);
    if (!published && temporaryStat) {
      await removeStableTemporary(
        identity,
        repoRoot,
        directory,
        temporary,
        temporaryStat,
        label
      );
    }
  }
}

async function assertStableManagedFile(
  identity: ManagedDirectoryIdentity,
  directory: string,
  filePath: string,
  expected: Stats,
  label: string
): Promise<void> {
  await assertManagedDirectoryIdentity(identity, identity.repoRealPath, directory, label);
  const named = await fs.lstat(filePath);
  const real = await fs.realpath(filePath);
  if (
    !named.isFile() ||
    named.isSymbolicLink() ||
    named.nlink !== 1 ||
    named.dev !== expected.dev ||
    named.ino !== expected.ino ||
    named.size !== expected.size ||
    !isContainedPath(identity.realPath, real)
  ) {
    throw new Error(`${label}-path-changed-during-publication`);
  }
}

async function assertManagedDirectoryIdentity(
  expected: ManagedDirectoryIdentity,
  repoRoot: string,
  directory: string,
  label: string
): Promise<void> {
  const current = await managedDirectoryIdentity(repoRoot, directory, label);
  if (
    current.repoRealPath !== expected.repoRealPath ||
    current.realPath !== expected.realPath ||
    current.dev !== expected.dev ||
    current.ino !== expected.ino
  ) {
    throw new Error(`${label}-directory-changed-during-publication`);
  }
}

async function managedDirectoryIdentity(
  repoRoot: string,
  directory: string,
  label: string
): Promise<ManagedDirectoryIdentity> {
  const repoRealPath = await fs.realpath(repoRoot);
  const realPath = await fs.realpath(directory);
  const entry = await fs.lstat(realPath);
  if (
    !entry.isDirectory() ||
    entry.isSymbolicLink() ||
    !isContainedPath(repoRealPath, realPath)
  ) {
    throw new Error(`${label}-directory-invalid`);
  }
  return { repoRealPath, realPath, dev: entry.dev, ino: entry.ino };
}

async function removeStableTemporary(
  identity: ManagedDirectoryIdentity,
  repoRoot: string,
  directory: string,
  temporary: string,
  expected: Stats,
  label: string
): Promise<void> {
  try {
    await assertManagedDirectoryIdentity(identity, repoRoot, directory, label);
    const named = await fs.lstat(temporary);
    if (
      named.isFile() &&
      !named.isSymbolicLink() &&
      named.dev === expected.dev &&
      named.ino === expected.ino
    ) {
      await fs.rm(temporary, { force: true });
    }
  } catch {
    // A changed pathname is not safe to clean up by name.
  }
}

function isContainedPath(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
