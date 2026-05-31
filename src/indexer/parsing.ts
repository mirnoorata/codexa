import { promises as fs } from "node:fs";
import path from "node:path";
import { isGeneratedPath, isTestPath, languageForPath } from "../language.js";
import { parseFile } from "../parser.js";
import { MAX_INDEXED_SOURCE_BYTES, type RepoSkippedFile, type RepoSourceFile } from "../repo-files.js";
import type { ParseResult } from "../types.js";
import { mapLimit, stableId } from "../util.js";

const PARSE_CACHE_VERSION = "parse-cache-v1-placeholder-signals-20260515a";
const PARSE_CACHE_PATH = ".codex/cache/codexa-parse-cache.json";
const PYTHON_SEMANTIC_SOURCE_TOTAL_BYTES = 16 * 1024 * 1024;

interface ParseCache {
  version: string;
  entries: Record<
    string,
    {
      contentHash: string;
      sizeBytes: number;
      result: ParseResult;
    }
  >;
}

export interface ParsedRepoSources {
  parsed: ParseResult[];
  nextCache: ParseCache;
  parseCacheHits: number;
}

export async function parseRepoSources(input: {
  repoRoot: string;
  files: RepoSourceFile[];
  skippedFiles: RepoSkippedFile[];
  snapshotId: string;
  indexedAt: string;
}): Promise<ParsedRepoSources> {
  const parseCache = await loadParseCache(input.repoRoot);
  const nextCache: ParseCache = { version: PARSE_CACHE_VERSION, entries: {} };
  let parseCacheHits = 0;
  const parsedSourceFiles = await mapLimit(input.files, 12, async (file) => {
    const parseInput = {
      repoRoot: input.repoRoot,
      relativePath: file.path,
      absolutePath: file.absolutePath,
      dirty: file.dirty,
      sizeBytes: file.sizeBytes,
      snapshotId: input.snapshotId,
      indexedAt: input.indexedAt
    };
    const cached = parseCache.entries[file.path];
    if (cached?.contentHash === file.contentHash && cached.sizeBytes === file.sizeBytes && isParseResult(cached.result)) {
      parseCacheHits += 1;
      const rebased = rebaseParseResult(cached.result, parseInput);
      nextCache.entries[file.path] = {
        contentHash: file.contentHash,
        sizeBytes: file.sizeBytes,
        result: rebased
      };
      return rebased;
    }
    const result = await parseFile(parseInput);
    nextCache.entries[file.path] = {
      contentHash: file.contentHash,
      sizeBytes: file.sizeBytes,
      result
    };
    return result;
  });
  const parsed = [...parsedSourceFiles, ...input.skippedFiles.map((file) => skippedFileParseResult(file, input.snapshotId, input.indexedAt))].sort((a, b) => a.file.path.localeCompare(b.file.path));
  return { parsed, nextCache, parseCacheHits };
}

export async function writeParseCache(repoRoot: string, cache: ParseCache): Promise<void> {
  const target = path.join(repoRoot, PARSE_CACHE_PATH);
  const temp = `${target}.tmp-${process.pid}-${Date.now()}`;
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(temp, `${JSON.stringify(cache)}\n`, "utf8");
  await fs.rename(temp, target);
}

export async function loadPythonSemanticSourceFiles(files: RepoSourceFile[]): Promise<Array<{ path: string; sourceText: string; contentHash: string }>> {
  const selected: Array<{ path: string; sourceText: string; contentHash: string }> = [];
  let totalBytes = 0;
  for (const file of files.filter((entry) => entry.path.endsWith(".py"))) {
    if (totalBytes + file.sizeBytes > PYTHON_SEMANTIC_SOURCE_TOTAL_BYTES) {
      continue;
    }
    try {
      selected.push({
        path: file.path,
        sourceText: await fs.readFile(file.absolutePath, "utf8"),
        contentHash: file.contentHash
      });
      totalBytes += file.sizeBytes;
    } catch {
      // The file may have been removed between git discovery and semantic assist.
    }
  }
  return selected;
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
  }
  if (bytes >= 1024) {
    return `${(bytes / 1024).toFixed(1)} KiB`;
  }
  return `${bytes} bytes`;
}

async function loadParseCache(repoRoot: string): Promise<ParseCache> {
  try {
    const parsed = JSON.parse(await fs.readFile(path.join(repoRoot, PARSE_CACHE_PATH), "utf8")) as ParseCache;
    if (parsed.version === PARSE_CACHE_VERSION && parsed.entries && typeof parsed.entries === "object") {
      return {
        version: parsed.version,
        entries: Object.fromEntries(
          Object.entries(parsed.entries).filter(([filePath, entry]) => Boolean(entry?.contentHash && typeof entry.sizeBytes === "number" && isParseResult(entry.result) && parseResultMatchesPath(entry.result, filePath)))
        )
      };
    }
  } catch {
    // Missing or corrupt caches are safe to ignore; Codexa can always rebuild from source.
  }
  return { version: PARSE_CACHE_VERSION, entries: {} };
}

function isParseResult(value: unknown): value is ParseResult {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Partial<ParseResult>;
  return (
    Boolean(record.file && typeof record.file === "object" && typeof record.file.path === "string") &&
    Array.isArray(record.symbols) &&
    Array.isArray(record.usageSites) &&
    Array.isArray(record.imports) &&
    Array.isArray(record.testEdges) &&
    Array.isArray(record.risks) &&
    Array.isArray(record.parserErrors)
  );
}

function parseResultMatchesPath(result: ParseResult, filePath: string): boolean {
  return (
    result.file.path === filePath &&
    result.symbols.every((fact) => fact.path === filePath) &&
    result.usageSites.every((fact) => fact.path === filePath) &&
    result.imports.every((fact) => fact.path === filePath) &&
    result.testEdges.every((fact) => fact.path === filePath) &&
    result.risks.every((fact) => fact.path === filePath) &&
    result.parserErrors.every((fact) => fact.path === filePath)
  );
}

function rebaseParseResult(
  result: ParseResult,
  input: {
    relativePath: string;
    dirty: boolean;
    sizeBytes: number;
    snapshotId: string;
    indexedAt: string;
  }
): ParseResult {
  const rebase = <T extends { snapshotId: string; indexedAt: string }>(fact: T): T => ({
    ...fact,
    snapshotId: input.snapshotId,
    indexedAt: input.indexedAt
  });
  return {
    file: {
      ...rebase(result.file),
      path: input.relativePath,
      dirty: input.dirty,
      sizeBytes: input.sizeBytes
    },
    symbols: result.symbols.map(rebase),
    usageSites: result.usageSites.map(rebase),
    imports: result.imports.map(rebase),
    testEdges: result.testEdges.map(rebase),
    risks: result.risks.map(rebase),
    parserErrors: result.parserErrors.map(rebase)
  };
}

function skippedFileParseResult(file: RepoSkippedFile, snapshotId: string, indexedAt: string): ParseResult {
  const language = languageForPath(file.path);
  return {
    file: {
      id: stableId("file", file.path),
      type: "File",
      path: file.path,
      source: "git",
      confidence: "authoritative",
      snapshotId,
      indexedAt,
      language,
      sizeBytes: file.sizeBytes,
      dirty: file.dirty,
      generated: isGeneratedPath(file.path),
      test: isTestPath(file.path)
    },
    symbols: [],
    usageSites: [],
    imports: [],
    testEdges: [],
    risks: [],
    parserErrors: [
      {
        id: stableId("parser-error", file.path, file.reason, file.sizeBytes),
        type: "ParserError",
        path: file.path,
        source: "git",
        confidence: "heuristic",
        snapshotId,
        indexedAt,
        message: `Skipped source parsing for ${file.path}: ${formatBytes(file.sizeBytes)} exceeds Codexa's ${formatBytes(MAX_INDEXED_SOURCE_BYTES)} per-file index cap`
      }
    ]
  };
}
