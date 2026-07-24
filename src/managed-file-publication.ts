import { randomUUID } from "node:crypto";
import {
  constants as fsConstants,
  promises as fs,
  type BigIntStats
} from "node:fs";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import {
  assertSafeManagedFile,
  ensureSafeManagedStateDirectory
} from "./init-portability.js";

interface ManagedDirectoryIdentity {
  dev: bigint;
  ino: bigint;
  realPath: string;
  repoRealPath: string;
}

interface ManagedFileIdentity {
  dev: bigint;
  ino: bigint;
  nlink: bigint;
  size: bigint;
}

interface PosixDirectoryAnchor {
  handle: FileHandle;
  path: string;
}

interface WasmMemory {
  buffer: ArrayBuffer;
  grow(deltaPages: number): number;
}

const ANCHORED_WASI_PUBLISHER_BASE64 =
  "AGFzbQEAAAABOAdgAn9/AX9gCX9/f39/fn5/fwF/YAR/f39/AX9gAX8Bf2AGf39/f39/AX9gA39/fwF/YAN/f38AAoECBxZ3YXNpX3NuYXBzaG90X3ByZXZpZXcxD2ZkX2ZpbGVzdGF0X2dldAAAFndhc2lfc25hcHNob3RfcHJldmlldzEJcGF0aF9vcGVuAAEWd2FzaV9zbmFwc2hvdF9wcmV2aWV3MQhmZF93cml0ZQACFndhc2lfc25hcHNob3RfcHJldmlldzEHZmRfc3luYwADFndhc2lfc25hcHNob3RfcHJldmlldzEIZmRfY2xvc2UAAxZ3YXNpX3NuYXBzaG90X3ByZXZpZXcxC3BhdGhfcmVuYW1lAAQWd2FzaV9zbmFwc2hvdF9wcmV2aWV3MRBwYXRoX3VubGlua19maWxlAAUDBAMDBgQFAwEABAcpAwZtZW1vcnkCABJkaXJlY3RvcnlfZmlsZXN0YXQABwdwdWJsaXNoAAkKnQIDCABBAyAAEAALEAAgABAEGkEDIAEgAhAGGguAAgECf0EDQQAgACABQQ1C0ICAAUIAQQBBDBABIQcgB0EARwRAQegHIAdqDwtBDCgCACEGQQAgBDYCAEEEIAU2AgAgBkEAQQFBCBACIQcgB0EARwRAIAYgACABEAhB0A8gB2oPC0EIKAIAIAVHBEAgBiAAIAEQCEG3Fw8LIAYQAyEHIAdBAEcEQCAGIAAgARAIQbgXIAdqDwsgBkGAARAAIQcgB0EARwRAIAYgACABEAhBrBsgB2oPCyAGEAQhByAHQQBHBEBBAyAAIAEQBhpBoB8gB2oPC0EDIAAgAUEDIAIgAxAFIQcgB0EARwRAQQMgACABEAYaQYgnIAdqDwtBAAs=";

export async function publishManagedStateFile(
  repoRoot: string,
  stateSegments: string[],
  destinationName: string,
  contents: string,
  label: string
): Promise<string> {
  assertManagedBasename(destinationName, label);
  const directory = await ensureSafeManagedStateDirectory(repoRoot, ...stateSegments);
  const identity = await managedDirectoryIdentity(repoRoot, directory, label);
  const destination = path.join(directory, destinationName);
  await assertSafeManagedFile(destination);
  const temporaryName = `.${destinationName}.${process.pid}.${randomUUID()}.tmp`;
  if (process.platform === "win32") {
    const expected = await publishThroughWasiDirectory(
      directory,
      identity,
      temporaryName,
      destinationName,
      contents,
      label
    );
    await assertStableNamedManagedFile(
      identity,
      repoRoot,
      directory,
      destination,
      expected,
      label
    );
    return destination;
  }
  return publishThroughPosixDirectory(
    identity,
    repoRoot,
    directory,
    destination,
    temporaryName,
    destinationName,
    contents,
    label
  );
}

async function publishThroughPosixDirectory(
  identity: ManagedDirectoryIdentity,
  repoRoot: string,
  directory: string,
  destination: string,
  temporaryName: string,
  destinationName: string,
  contents: string,
  label: string
): Promise<string> {
  const anchor = await openPosixDirectoryAnchor(identity, directory, label);
  const temporary = path.join(anchor.path, temporaryName);
  const anchoredDestination = path.join(anchor.path, destinationName);
  const handle = await fs.open(temporary, "wx", 0o600);
  let temporaryStat: BigIntStats | undefined;
  let published = false;
  try {
    temporaryStat = await handle.stat({ bigint: true });
    await assertAnchoredManagedFile(anchor, identity, temporary, temporaryStat, label);
    await handle.writeFile(contents, { encoding: "utf8" });
    await handle.sync();
    const written = await handle.stat({ bigint: true });
    if (
      written.dev !== temporaryStat.dev ||
      written.ino !== temporaryStat.ino ||
      written.nlink !== temporaryStat.nlink ||
      written.size !== BigInt(Buffer.byteLength(contents, "utf8"))
    ) {
      throw new Error(`${label}-temporary-changed-during-write`);
    }
    temporaryStat = written;
    await assertAnchoredManagedFile(anchor, identity, temporary, written, label);
    await assertManagedDirectoryIdentity(identity, repoRoot, directory, label);
    await fs.rename(temporary, anchoredDestination);
    await assertAnchoredManagedFile(anchor, identity, anchoredDestination, written, label);
    await assertManagedDirectoryIdentity(identity, repoRoot, directory, label);
    published = true;
    return destination;
  } finally {
    await handle.close().catch(() => undefined);
    if (!published && temporaryStat) {
      await removeAnchoredTemporary(anchor, identity, temporary, temporaryStat);
    }
    await anchor.handle.close().catch(() => undefined);
  }
}

async function openPosixDirectoryAnchor(
  identity: ManagedDirectoryIdentity,
  directory: string,
  label: string
): Promise<PosixDirectoryAnchor> {
  const flags =
    fsConstants.O_RDONLY |
    fsConstants.O_NOFOLLOW |
    (fsConstants.O_DIRECTORY ?? 0);
  const handle = await fs.open(directory, flags);
  try {
    await assertDirectoryHandleIdentity(handle, identity, label);
    for (const candidate of [
      `/proc/self/fd/${handle.fd}`,
      `/dev/fd/${handle.fd}`
    ]) {
      const realPath = await fs.realpath(candidate).catch(() => undefined);
      if (realPath === identity.realPath) return { handle, path: candidate };
    }
    throw new Error(`${label}-anchored-publication-unavailable`);
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

async function assertAnchoredManagedFile(
  anchor: PosixDirectoryAnchor,
  identity: ManagedDirectoryIdentity,
  filePath: string,
  expected: ManagedFileIdentity,
  label: string
): Promise<void> {
  await assertDirectoryHandleIdentity(anchor.handle, identity, label);
  const named = await fs.lstat(filePath, { bigint: true });
  if (
    !named.isFile() ||
    named.isSymbolicLink() ||
    named.nlink !== 1n ||
    named.dev !== expected.dev ||
    named.ino !== expected.ino ||
    named.size !== expected.size
  ) {
    throw new Error(`${label}-path-changed-during-publication`);
  }
}

async function assertDirectoryHandleIdentity(
  handle: FileHandle,
  identity: ManagedDirectoryIdentity,
  label: string
): Promise<void> {
  const current = await handle.stat({ bigint: true });
  if (
    !current.isDirectory() ||
    current.dev !== identity.dev ||
    current.ino !== identity.ino
  ) {
    throw new Error(`${label}-directory-handle-changed-during-publication`);
  }
}

async function removeAnchoredTemporary(
  anchor: PosixDirectoryAnchor,
  identity: ManagedDirectoryIdentity,
  temporary: string,
  expected: ManagedFileIdentity
): Promise<void> {
  try {
    await assertDirectoryHandleIdentity(anchor.handle, identity, "managed-publication-cleanup");
    const named = await fs.lstat(temporary, { bigint: true });
    if (
      named.isFile() &&
      !named.isSymbolicLink() &&
      named.dev === expected.dev &&
      named.ino === expected.ino
    ) {
      await fs.rm(temporary, { force: true });
    }
  } catch {
    // The anchored entry is absent or no longer the file created by this call.
  }
}

async function publishThroughWasiDirectory(
  directory: string,
  identity: ManagedDirectoryIdentity,
  temporaryName: string,
  destinationName: string,
  contents: string,
  label: string
): Promise<ManagedFileIdentity> {
  const { WASI } = await import("node:wasi");
  const wasi = new WASI({
    version: "preview1",
    args: [],
    env: {},
    preopens: { "/managed": directory }
  });
  const wasm = (globalThis as unknown as {
    WebAssembly: {
      compile: (bytes: Buffer) => Promise<object>;
      instantiate: (
        module: object,
        imports: object
      ) => Promise<{ exports: Record<string, unknown> }>;
    };
  }).WebAssembly;
  const module = await wasm.compile(
    Buffer.from(ANCHORED_WASI_PUBLISHER_BASE64, "base64")
  );
  const instance = await wasm.instantiate(module, wasi.getImportObject());
  wasi.initialize(instance);
  const exports = instance.exports as {
    memory: WasmMemory;
    directory_filestat: (offset: number) => number;
    publish: (
      temporaryOffset: number,
      temporaryLength: number,
      destinationOffset: number,
      destinationLength: number,
      contentsOffset: number,
      contentsLength: number
    ) => number;
  };
  const directoryStatOffset = 64;
  const fileStatOffset = 128;
  const payloadOffset = 256;
  if (exports.directory_filestat(directoryStatOffset) !== 0) {
    throw new Error(`${label}-directory-handle-unavailable`);
  }
  let view = new DataView(exports.memory.buffer);
  if (
    view.getBigUint64(directoryStatOffset, true) !== identity.dev ||
    view.getBigUint64(directoryStatOffset + 8, true) !== identity.ino
  ) {
    throw new Error(`${label}-directory-changed-during-publication`);
  }
  const temporary = Buffer.from(temporaryName, "utf8");
  const destination = Buffer.from(destinationName, "utf8");
  const encodedContents = Buffer.from(contents, "utf8");
  const requiredBytes =
    payloadOffset + temporary.length + destination.length + encodedContents.length;
  if (requiredBytes > exports.memory.buffer.byteLength) {
    exports.memory.grow(Math.ceil(
      (requiredBytes - exports.memory.buffer.byteLength) / (64 * 1024)
    ));
    view = new DataView(exports.memory.buffer);
  }
  const memory = new Uint8Array(exports.memory.buffer);
  let offset = payloadOffset;
  memory.set(temporary, offset);
  const temporaryOffset = offset;
  offset += temporary.length;
  memory.set(destination, offset);
  const destinationOffset = offset;
  offset += destination.length;
  memory.set(encodedContents, offset);
  const result = exports.publish(
    temporaryOffset,
    temporary.length,
    destinationOffset,
    destination.length,
    offset,
    encodedContents.length
  );
  if (result !== 0) {
    throw new Error(`${label}-anchored-publication-failed:${result}`);
  }
  const fileType = view.getUint8(fileStatOffset + 16);
  const expected: ManagedFileIdentity = {
    dev: view.getBigUint64(fileStatOffset, true),
    ino: view.getBigUint64(fileStatOffset + 8, true),
    nlink: view.getBigUint64(fileStatOffset + 24, true),
    size: view.getBigUint64(fileStatOffset + 32, true)
  };
  if (
    fileType !== 4 ||
    expected.nlink !== 1n ||
    expected.size !== BigInt(encodedContents.length)
  ) {
    throw new Error(`${label}-temporary-changed-during-write`);
  }
  return expected;
}

async function assertStableNamedManagedFile(
  identity: ManagedDirectoryIdentity,
  repoRoot: string,
  directory: string,
  filePath: string,
  expected: ManagedFileIdentity,
  label: string
): Promise<void> {
  await assertManagedDirectoryIdentity(identity, repoRoot, directory, label);
  const named = await fs.lstat(filePath, { bigint: true });
  const real = await fs.realpath(filePath);
  if (
    !named.isFile() ||
    named.isSymbolicLink() ||
    named.nlink !== 1n ||
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
  const entry = await fs.lstat(realPath, { bigint: true });
  if (
    !entry.isDirectory() ||
    entry.isSymbolicLink() ||
    !isContainedPath(repoRealPath, realPath)
  ) {
    throw new Error(`${label}-directory-invalid`);
  }
  return { repoRealPath, realPath, dev: entry.dev, ino: entry.ino };
}

function assertManagedBasename(name: string, label: string): void {
  if (
    name.length === 0 ||
    name === "." ||
    name === ".." ||
    path.basename(name) !== name ||
    name.includes("/") ||
    name.includes("\\") ||
    name.includes("\0")
  ) {
    throw new Error(`${label}-destination-name-invalid`);
  }
}

function isContainedPath(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
