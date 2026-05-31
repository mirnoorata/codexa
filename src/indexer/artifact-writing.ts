import { promises as fs } from "node:fs";
import path from "node:path";
import { writeArtifacts } from "../artifacts.js";
import type { CodexaFact, CodexaIndex } from "../types.js";

const FACTS_NDJSON_WRITE_BUFFER_BYTES = 1024 * 1024;

export async function persistIndex(index: CodexaIndex, outputDir: string): Promise<void> {
  await fs.mkdir(path.join(outputDir, "modules"), { recursive: true });
  await fs.writeFile(path.join(outputDir, "index.json"), `${JSON.stringify(index)}\n`, "utf8");
  await fs.writeFile(path.join(outputDir, "freshness.json"), `${JSON.stringify(index.freshness, null, 2)}\n`, "utf8");
  await writeFactsNdjson(path.join(outputDir, "facts.ndjson"), allFacts(index));
}

export async function writeIndexBundle(index: CodexaIndex, outputDir: string): Promise<void> {
  const parentDir = path.dirname(outputDir);
  const tempDir = path.join(parentDir, `.codebase.tmp-${process.pid}-${Date.now()}`);
  const backupDir = path.join(parentDir, `.codebase.backup-${process.pid}-${Date.now()}`);
  await fs.mkdir(parentDir, { recursive: true });
  await fs.rm(tempDir, { recursive: true, force: true });
  await persistIndex(index, tempDir);
  await writeArtifacts(index, tempDir);
  try {
    await fs.rm(backupDir, { recursive: true, force: true });
    if (await pathExists(outputDir)) {
      await fs.rename(outputDir, backupDir);
    }
    await fs.rename(tempDir, outputDir);
    await fs.rm(backupDir, { recursive: true, force: true });
  } catch (error) {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    if (!(await pathExists(outputDir)) && (await pathExists(backupDir))) {
      await fs.rename(backupDir, outputDir).catch(() => undefined);
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

async function writeFactsNdjson(filePath: string, facts: CodexaFact[]): Promise<void> {
  const handle = await fs.open(filePath, "w");
  try {
    let buffer = "";
    for (const fact of facts) {
      const line = `${JSON.stringify(fact)}\n`;
      if (buffer.length + line.length > FACTS_NDJSON_WRITE_BUFFER_BYTES && buffer.length > 0) {
        await handle.write(buffer);
        buffer = "";
      }
      buffer += line;
    }
    if (buffer.length > 0) {
      await handle.write(buffer);
    }
  } finally {
    await handle.close();
  }
}

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await fs.stat(candidate);
    return true;
  } catch {
    return false;
  }
}
