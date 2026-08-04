import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import { writeArtifacts } from "../artifacts.js";
import { MAX_INDEX_ARTIFACT_BYTES } from "../index-limits.js";
import { CODEXA_INDEX_REVISION, CODEXA_INDEX_SCHEMA_VERSION } from "../index-revision.js";
import {
  digestManagedArtifact,
  ensureManagedArtifactDirectory,
  probeManagedArtifactMetadataFastPath,
  requireManagedArtifactDirectory,
  writeManagedArtifact,
  writeManagedArtifactText,
  type ManagedArtifactDirectory
} from "../managed-artifacts.js";
import type { CodexaFact, CodexaIndex } from "../types.js";

const FACTS_NDJSON_WRITE_BUFFER_BYTES = 1024 * 1024;
const CODEBASE_RELATIVE_DIR = path.join(".codex", "codebase");
const INDEX_INTEGRITY_SCHEMA_VERSION = 2;

export async function persistIndex(index: CodexaIndex, outputDir: string): Promise<void> {
  const publishIntegrityManifest = index.schemaVersion === CODEXA_INDEX_SCHEMA_VERSION && index.indexRevision === CODEXA_INDEX_REVISION;
  if (publishIntegrityManifest) assertIntegrityManifestInput(index);
  // Capture the exact attested payload before the first await. persistIndex is
  // exported, so a caller can retain and mutate its input while directory I/O
  // is pending; validation and publication must refer to one immutable value.
  const repoRoot = index.snapshot.repoRoot;
  const serializedIndex = `${JSON.stringify(index)}\n`;
  const serializedFreshness = `${JSON.stringify(index.freshness, null, 2)}\n`;
  assertIndexArtifactSize(serializedIndex);
  const expectedIndexDigest = digestText(serializedIndex);
  const freshnessDigest = digestText(serializedFreshness);
  const facts = allFacts(index);
  const output = await ensureManagedArtifactDirectory(repoRoot, outputDir);
  await ensureManagedArtifactDirectory(repoRoot, path.join(output.directory, "modules"));
  await writeManagedArtifactText(output, "index.json", serializedIndex);
  await writeManagedArtifactText(output, "freshness.json", serializedFreshness);
  if (publishIntegrityManifest) {
    const outputSegments = path.relative(output.repoReal, output.directory).split(path.sep);
    const indexSegments = [...outputSegments, "index.json"];
    const metadataFastPath = await probeManagedArtifactMetadataFastPath(
      output.repoReal,
      indexSegments,
      MAX_INDEX_ARTIFACT_BYTES
    ).catch(() => false);
    const publishedIndexDigest = await digestManagedArtifact(
      output.repoReal,
      indexSegments,
      MAX_INDEX_ARTIFACT_BYTES
    );
    if (
      publishedIndexDigest.sizeBytes !== expectedIndexDigest.sizeBytes ||
      publishedIndexDigest.sha256 !== expectedIndexDigest.sha256
    ) {
      throw new Error("Codexa published index changed before its integrity identity was captured");
    }
    const serializedIntegrityManifest = `${JSON.stringify({
      schemaVersion: INDEX_INTEGRITY_SCHEMA_VERSION,
      indexRevision: index.indexRevision,
      index: { ...publishedIndexDigest, metadataFastPath },
      freshness: freshnessDigest,
      snapshot: {
        repoRoot: index.snapshot.repoRoot,
        snapshotId: index.snapshot.snapshotId,
        headCommit: index.snapshot.headCommit,
        gitRoot: index.snapshot.gitRoot
      }
    }, null, 2)}\n`;
    await writeManagedArtifactText(output, "index-integrity.json", serializedIntegrityManifest);
  }
  await writeFactsNdjson(output, facts);
}

function assertIntegrityManifestInput(index: CodexaIndex): void {
  if (
    index.schemaVersion !== CODEXA_INDEX_SCHEMA_VERSION ||
    index.indexRevision !== CODEXA_INDEX_REVISION ||
    index.freshness?.schemaVersion !== CODEXA_INDEX_SCHEMA_VERSION ||
    index.freshness.indexRevision !== CODEXA_INDEX_REVISION ||
    !Array.isArray(index.files) ||
    !Array.isArray(index.symbols) ||
    !Array.isArray(index.usageSites) ||
    !Array.isArray(index.imports) ||
    !Array.isArray(index.testEdges) ||
    !Array.isArray(index.graphEdges) ||
    !Array.isArray(index.workflows) ||
    !Array.isArray(index.modules) ||
    !Array.isArray(index.risks) ||
    !Array.isArray(index.parserErrors) ||
    !index.workflowMembershipSpill ||
    typeof index.workflowMembershipSpill !== "object" ||
    Array.isArray(index.workflowMembershipSpill)
  ) {
    throw new Error("Codexa cannot attest an incomplete or unsupported current index bundle");
  }
  for (const [workflowId, paths] of Object.entries(index.workflowMembershipSpill)) {
    if (!Array.isArray(paths) || !paths.every((filePath) => typeof filePath === "string")) {
      throw new Error(`Codexa cannot attest invalid workflow membership spill for ${workflowId}`);
    }
  }
  for (const workflow of index.workflows) {
    if (!Object.prototype.hasOwnProperty.call(index.workflowMembershipSpill, workflow.id)) {
      throw new Error(`Codexa cannot attest workflow membership spill missing ${workflow.id}`);
    }
  }
}

function digestText(value: string): { sizeBytes: number; sha256: string } {
  return {
    sizeBytes: Buffer.byteLength(value, "utf8"),
    sha256: createHash("sha256").update(value, "utf8").digest("hex")
  };
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
