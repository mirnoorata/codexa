import { mkdir, readFile, readdir, rm, writeFile, mkdtemp, utimes } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { acquireCacheLock } from "../src/cache-lock.js";
import {
  SESSION_MEMORY_LOCK_DIR,
  compactSessionMemory,
  readSessionMemory,
  recordViewedMemoryForTool,
  recordSessionMemory,
  sessionMemoryCacheDir,
  summarizeSessionMemory
} from "../src/session-memory.js";
import { CURRENT_VERIFICATION_PROVENANCE, type CodexaIndex, type FileFact, type FreshnessInfo, type QueryResult, type RepoSnapshotFact } from "../src/types.js";

export function indexFixture(repoRoot: string, freshness: FreshnessInfo, files: FileFact[]): CodexaIndex {
  const snapshot: RepoSnapshotFact = {
    id: "repo-snapshot",
    type: "RepoSnapshot",
    source: "git",
    confidence: "authoritative",
    snapshotId: freshness.snapshotId,
    indexedAt: freshness.indexedAt,
    repoRoot,
    gitRoot: repoRoot,
    headCommit: freshness.headCommit,
    dirtyFiles: freshness.dirtyFiles
  };
  return {
    schemaVersion: 1,
    snapshot,
    freshness,
    files,
    symbols: [],
    usageSites: [],
    imports: [],
    testEdges: [],
    graphEdges: [],
    workflows: [],
    modules: [],
    risks: [],
    parserErrors: []
  };
}

export function fileFixture(filePath: string, freshness: FreshnessInfo, overrides: Partial<FileFact> = {}): FileFact {
  return {
    id: `file:${filePath}`,
    type: "File",
    path: filePath,
    source: "tree-sitter",
    confidence: "authoritative",
    snapshotId: freshness.snapshotId,
    indexedAt: freshness.indexedAt,
    language: filePath.endsWith(".ts") ? "typescript" : "unknown",
    sizeBytes: 10,
    dirty: false,
    generated: false,
    test: false,
    rank: 1,
    rankReasons: {},
    symbolCount: 0,
    usageCount: 0,
    importCount: 0,
    riskScore: 0,
    ...overrides
  };
}

export function freshnessFixture(snapshotId: string, overrides: Partial<FreshnessInfo> = {}): FreshnessInfo {
  const dirtyFiles = overrides.dirtyFiles ?? [];
  return {
    schemaVersion: 1,
    snapshotId,
    repoRoot: "/tmp/repo",
    gitRoot: "/tmp/repo",
    headCommit: overrides.headCommit ?? "abc",
    indexedAt: overrides.indexedAt ?? "2026-05-05T00:00:00.000Z",
    dirtyFiles,
    dirtyFileHashes: Object.fromEntries(dirtyFiles.map((file) => [file, `${file}-hash`])),
    indexedDirtyFileHashes: {},
    indexedDirtyFiles: [],
    missing: false,
    stale: false,
    reason: "fresh",
    parserErrorCount: 0
  };
}
