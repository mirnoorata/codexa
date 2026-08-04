import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import { writeArtifacts } from "../artifacts.js";
import { MAX_INDEX_ARTIFACT_BYTES } from "../index-limits.js";
import {
  ensureManagedArtifactDirectory,
  requireManagedArtifactDirectory,
  writeManagedArtifact,
  writeManagedArtifactText,
  type ManagedArtifactDirectory
} from "../managed-artifacts.js";
import type { CodexaFact, CodexaIndex } from "../types.js";

const FACTS_NDJSON_WRITE_BUFFER_BYTES = 1024 * 1024;
const CODEBASE_RELATIVE_DIR = path.join(".codex", "codebase");

export async function persistIndex(index: CodexaIndex, outputDir: string): Promise<void> {
  const output = await ensureManagedArtifactDirectory(index.snapshot.repoRoot, outputDir);
  await ensureManagedArtifactDirectory(index.snapshot.repoRoot, path.join(output.directory, "modules"));
  const serializedIndex = `${JSON.stringify(index)}\n`;
  assertIndexArtifactSize(serializedIndex);
  await writeManagedArtifactText(output, "index.json", serializedIndex);
  await writeManagedArtifactText(output, "freshness.json", `${JSON.stringify(index.freshness, null, 2)}\n`);
  await writeFactsNdjson(output, allFacts(index));
}

export function assertIndexArtifactSize(
  serializedIndex: string,
  maxBytes = MAX_INDEX_ARTIFACT_BYTES
): void {
  const sizeBytes = Buffer.byteLength(serializedIndex, "utf8");
  if (sizeBytes > maxBytes) {
    throw new Error(`Codexa index artifact is ${sizeBytes} bytes; maximum supported size is ${maxBytes} ${maxBytes === 1 ? "byte" : "bytes"}`);
  }
}

export async function writeIndexBundle(index: CodexaIndex, outputDir: string): Promise<void> {
  const repoRoot = path.resolve(index.snapshot.repoRoot);
  const expectedOutputDir = path.join(repoRoot, CODEBASE_RELATIVE_DIR);
  if (path.resolve(outputDir) !== expectedOutputDir) {
    throw new Error(`Codexa index output must use the managed repository path: ${expectedOutputDir}`);
  }
  const parent = await ensureManagedArtifactDirectory(repoRoot, path.dirname(expectedOutputDir));
  const existingOutput = await fs.lstat(path.join(parent.directory, "codebase")).catch((error: unknown) => {
    if (errorCode(error) === "ENOENT") return undefined;
    throw error;
  });
  if (existingOutput) {
    await requireManagedArtifactDirectory(repoRoot, expectedOutputDir);
  }
  const tempDir = await fs.mkdtemp(path.join(parent.directory, ".codebase.tmp-"));
  await requireManagedArtifactDirectory(repoRoot, tempDir);
  const backupDir = path.join(parent.directory, `.codebase.backup-${process.pid}-${randomUUID()}`);
  try {
    await persistIndex(index, tempDir);
    await writeArtifacts(index, tempDir);
    if (await pathExists(expectedOutputDir)) {
      await requireManagedArtifactDirectory(repoRoot, expectedOutputDir);
      await fs.rename(expectedOutputDir, backupDir);
      await requireManagedArtifactDirectory(repoRoot, backupDir);
    }
    await requireManagedArtifactDirectory(repoRoot, tempDir);
    await fs.rename(tempDir, expectedOutputDir);
    await requireManagedArtifactDirectory(repoRoot, expectedOutputDir);
    await fs.rm(backupDir, { recursive: true, force: true });
  } catch (error) {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    if (!(await pathExists(expectedOutputDir)) && (await pathExists(backupDir))) {
      await requireManagedArtifactDirectory(repoRoot, backupDir)
        .then(() => fs.rename(backupDir, expectedOutputDir))
        .catch(() => undefined);
    }
    throw error;
  }
}

function allFacts(index: CodexaIndex): CodexaFact[] {
  return [
    index.snapshot,
    ...index.files,
    ...index.symbols,
    ...index.usageSites,
    ...index.imports,
    ...index.testEdges,
    ...index.graphEdges,
    ...index.workflows,
    ...index.modules,
    ...index.risks,
    ...index.parserErrors
  ];
}

async function writeFactsNdjson(output: ManagedArtifactDirectory, facts: CodexaFact[]): Promise<void> {
  await writeManagedArtifact(output, "facts.ndjson", async (handle) => {
    let buffer = "";
    for (const fact of facts) {
      const line = `${JSON.stringify(fact)}\n`;
      if (buffer.length + line.length > FACTS_NDJSON_WRITE_BUFFER_BYTES && buffer.length > 0) {
        await writeAll(handle, buffer);
        buffer = "";
      }
      buffer += line;
    }
    if (buffer.length > 0) {
      await writeAll(handle, buffer);
    }
  });
}

async function writeAll(handle: FileHandle, contents: string): Promise<void> {
  const bytes = Buffer.from(contents, "utf8");
  let offset = 0;
  while (offset < bytes.length) {
    const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset);
    if (bytesWritten < 1) throw new Error("Codexa managed fact publication made no write progress");
    offset += bytesWritten;
  }
}

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await fs.lstat(candidate);
    return true;
  } catch {
    return false;
  }
}

function errorCode(error: unknown): string {
  return error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code)
    : "";
}
