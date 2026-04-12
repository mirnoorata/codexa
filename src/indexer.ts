import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { buildGraphEdges, extractWorkflowTraces } from "./graph.js";
import { moduleNameForPath } from "./language.js";
import { parseFile } from "./parser.js";
import { discoverRepoFiles, discoverRepoFreshness } from "./repo-files.js";
import { type ImportAliasRule, relinkUsageIds, resolveIndexLinks } from "./resolver.js";
import { loadExternalRiskSignals } from "./risk-ingest.js";
import type {
  CodexaFact,
  CodexaIndex,
  FileFact,
  FreshnessInfo,
  IndexOptions,
  ModuleClusterFact,
  ParseResult,
  RepoSnapshotFact,
  RiskSignalFact
} from "./types.js";
import { normalizePath, stableId, uniqueSorted } from "./util.js";
import { writeArtifacts } from "./artifacts.js";

export const CODEBASE_DIR = ".codex/codebase";
const PARSE_CACHE_VERSION = "parse-cache-v1-ts-js-py-json-20260412-semantic-auto-review";
const PARSE_CACHE_PATH = ".codex/cache/codexa-parse-cache.json";
const INDEX_LOCK_DIR = ".codex/cache/codexa-index.lock";
const INDEX_LOCK_STALE_MS = 120_000;

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

interface IndexLockOwner {
  pid: number;
  token: string;
  processStartTime?: string | null;
  startedAt: string;
  heartbeatAt: string;
  repoRoot: string;
}

export async function buildIndex(options: IndexOptions): Promise<CodexaIndex> {
  const repoRoot = path.resolve(options.repoRoot);
  const discovered = await discoverRepoFiles(repoRoot);
  const indexedAt = new Date().toISOString();
  const snapshotId = stableId("snapshot", repoRoot, discovered.git.headCommit, discovered.git.dirtyFiles.join("\n"), indexedAt);
  const snapshot: RepoSnapshotFact = {
    id: stableId("repo-snapshot", repoRoot, discovered.git.headCommit ?? "none"),
    type: "RepoSnapshot",
    source: "git",
    confidence: "authoritative",
    snapshotId,
    indexedAt,
    repoRoot,
    gitRoot: discovered.git.gitRoot,
    headCommit: discovered.git.headCommit,
    dirtyFiles: discovered.git.dirtyFiles
  };

  const parseCache = await loadParseCache(repoRoot);
  const nextCache: ParseCache = { version: PARSE_CACHE_VERSION, entries: {} };
  let parseCacheHits = 0;
  const parsed = await mapLimit(discovered.files, 12, async (file) => {
    const parseInput = {
      repoRoot,
      relativePath: file.path,
      absolutePath: file.absolutePath,
      dirty: file.dirty,
      sizeBytes: file.sizeBytes,
      sourceText: file.sourceText,
      snapshotId,
      indexedAt
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
  const aliases = await loadImportAliases(repoRoot, discovered.files.map((file) => file.path));

  const initial: CodexaIndex = {
    schemaVersion: 1,
    snapshot,
    freshness: {
      schemaVersion: 1,
      snapshotId,
      repoRoot,
      gitRoot: discovered.git.gitRoot,
      headCommit: discovered.git.headCommit,
      indexedAt,
      dirtyFiles: discovered.git.dirtyFiles,
      indexedDirtyFiles: discovered.git.dirtyFiles,
      dirtyFileHashes: discovered.dirtyFileHashes,
      indexedDirtyFileHashes: discovered.dirtyFileHashes,
      missing: false,
      stale: false,
      reason: discovered.git.dirtyFiles.length > 0 ? "fresh-with-dirty-overlay" : "fresh",
      parserErrorCount: 0
    },
    files: parsed.map((result) => ({
      ...result.file,
      rank: 0,
      rankReasons: {},
      symbolCount: result.symbols.length,
      usageCount: result.usageSites.length,
      importCount: result.imports.length,
      riskScore: 0
    })),
    symbols: parsed.flatMap((result) => result.symbols),
    usageSites: parsed.flatMap((result) => result.usageSites),
    imports: parsed.flatMap((result) => result.imports),
    testEdges: parsed.flatMap((result) => result.testEdges),
    graphEdges: [],
    workflows: [],
    modules: [],
    risks: parsed.flatMap((result) => result.risks),
    parserErrors: parsed.flatMap((result) => result.parserErrors)
  };

  const externalRisks = await loadExternalRiskSignals(repoRoot, snapshotId, indexedAt);
  const linked = relinkUsageIds(resolveIndexLinks({ ...initial, risks: dedupeRiskSignals([...initial.risks, ...externalRisks]) }, aliases));
  const ranked = applyRanking(linked, discovered.git.churnByPath);
  const withModules = applyModules(ranked);
  const withGraph = { ...withModules, graphEdges: buildGraphEdges(withModules) };
  const withWorkflows = { ...withGraph, workflows: extractWorkflowTraces(withGraph) };
  const freshness: FreshnessInfo = {
    ...withWorkflows.freshness,
    parserErrorCount: withWorkflows.parserErrors.length
  };
  const finalIndex = { ...withWorkflows, freshness };

  if (options.writeArtifacts ?? true) {
    await writeIndexBundle(finalIndex, options.outputDir ?? path.join(repoRoot, CODEBASE_DIR));
    await writeParseCache(repoRoot, nextCache);
  }

  return finalIndex;
}

async function loadParseCache(repoRoot: string): Promise<ParseCache> {
  try {
    const parsed = JSON.parse(await fs.readFile(path.join(repoRoot, PARSE_CACHE_PATH), "utf8")) as ParseCache;
    if (parsed.version === PARSE_CACHE_VERSION && parsed.entries && typeof parsed.entries === "object") {
      return {
        version: parsed.version,
        entries: Object.fromEntries(
          Object.entries(parsed.entries).filter(([, entry]) => Boolean(entry?.contentHash && typeof entry.sizeBytes === "number" && isParseResult(entry.result)))
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

async function writeParseCache(repoRoot: string, cache: ParseCache): Promise<void> {
  const target = path.join(repoRoot, PARSE_CACHE_PATH);
  const temp = `${target}.tmp-${process.pid}-${Date.now()}`;
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(temp, `${JSON.stringify(cache)}\n`, "utf8");
  await fs.rename(temp, target);
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

function dedupeRiskSignals(risks: RiskSignalFact[]): RiskSignalFact[] {
  const seen = new Set<string>();
  const result: RiskSignalFact[] = [];
  for (const risk of risks) {
    const key = `${risk.path}\0${risk.signal}\0${risk.range?.startLine ?? 0}\0${risk.reason}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(risk);
  }
  return result.sort((a, b) => a.path.localeCompare(b.path) || b.score - a.score || a.signal.localeCompare(b.signal));
}

async function loadImportAliases(repoRoot: string, files: string[]): Promise<ImportAliasRule[]> {
  const aliases: ImportAliasRule[] = [];
  const fileSet = new Set(files);
  for (const relativePath of files.filter((file) => path.posix.basename(file) === "tsconfig.json")) {
    const absolutePath = path.join(repoRoot, relativePath);
    try {
      const parsed = JSON.parse(await fs.readFile(absolutePath, "utf8")) as {
        compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> };
      };
      const compilerOptions = parsed.compilerOptions ?? {};
      const paths = compilerOptions.paths ?? {};
      const configDir = path.posix.dirname(relativePath);
      const baseUrl = compilerOptions.baseUrl ?? ".";
      for (const [aliasPattern, targets] of Object.entries(paths)) {
        const target = targets[0];
        if (!target) {
          continue;
        }
        aliases.push(aliasRule(configDir, baseUrl, aliasPattern, target));
      }
    } catch {
      continue;
    }
  }
  for (const relativePath of files.filter((file) => path.posix.basename(file) === "package.json")) {
    const absolutePath = path.join(repoRoot, relativePath);
    try {
      const parsed = JSON.parse(await fs.readFile(absolutePath, "utf8")) as {
        name?: string;
        exports?: unknown;
        main?: string;
        module?: string;
        types?: string;
      };
      if (!parsed.name || typeof parsed.name !== "string") {
        continue;
      }
      const packageDir = path.posix.dirname(relativePath);
      for (const entry of packageExportTargets(parsed)) {
        const target = normalizePath(path.posix.join(packageDir === "." ? "" : packageDir, entry.target.replace(/^\.\//, "")));
        if (!targetExistsForAlias(target, fileSet)) {
          continue;
        }
        aliases.push({
          prefix: entry.subpath === "." ? parsed.name : `${parsed.name}/${entry.subpath.replace(/^\.\//, "")}`,
          targetPrefix: target,
          exact: true
        });
      }
    } catch {
      continue;
    }
  }
  return aliases.sort((a, b) => b.prefix.length - a.prefix.length || a.prefix.localeCompare(b.prefix));
}

function packageExportTargets(parsed: { exports?: unknown; main?: string; module?: string; types?: string }): Array<{ subpath: string; target: string }> {
  const result: Array<{ subpath: string; target: string }> = [];
  const add = (subpath: string, value: unknown) => {
    const target = exportTargetString(value);
    if (target) {
      result.push({ subpath, target });
    }
  };
  if (typeof parsed.exports === "string") {
    add(".", parsed.exports);
  } else if (parsed.exports && typeof parsed.exports === "object") {
    for (const [subpath, value] of Object.entries(parsed.exports as Record<string, unknown>)) {
      add(subpath, value);
    }
  }
  for (const fallback of [parsed.module, parsed.main, parsed.types, "./src/index.ts", "./src/index.tsx", "./index.ts"]) {
    add(".", fallback);
  }
  const seen = new Set<string>();
  return result.filter((entry) => {
    const key = `${entry.subpath}\0${entry.target}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function exportTargetString(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  for (const key of ["source", "types", "import", "module", "default", "require"]) {
    const target = exportTargetString(record[key]);
    if (target) {
      return target;
    }
  }
  return undefined;
}

function targetExistsForAlias(target: string, files: Set<string>): boolean {
  if (files.has(target)) {
    return true;
  }
  const ext = path.posix.extname(target);
  const stem = ext ? target.slice(0, -ext.length) : target;
  const variants = [
    `${stem}.ts`,
    `${stem}.tsx`,
    `${stem}.js`,
    `${stem}.jsx`,
    `${target}/index.ts`,
    `${target}/index.tsx`,
    `${target}/index.js`
  ];
  return variants.some((variant) => files.has(variant));
}

function aliasRule(configDir: string, baseUrl: string, aliasPattern: string, targetPattern: string): ImportAliasRule {
  const wildcard = aliasPattern.endsWith("/*") && targetPattern.endsWith("/*");
  const aliasBase = wildcard ? aliasPattern.slice(0, -1) : aliasPattern;
  const targetBase = wildcard ? targetPattern.slice(0, -1) : targetPattern;
  return {
    prefix: aliasBase,
    targetPrefix: normalizeAliasTarget(configDir, baseUrl, targetBase),
    exact: !wildcard
  };
}

function normalizeAliasTarget(configDir: string, baseUrl: string, targetPattern: string): string {
  return normalizePath(path.posix.normalize(path.posix.join(configDir === "." ? "" : configDir, baseUrl, targetPattern)));
}

export async function persistIndex(index: CodexaIndex, outputDir: string): Promise<void> {
  await fs.mkdir(path.join(outputDir, "modules"), { recursive: true });
  await fs.writeFile(path.join(outputDir, "index.json"), `${JSON.stringify(index, null, 2)}\n`, "utf8");
  await fs.writeFile(path.join(outputDir, "freshness.json"), `${JSON.stringify(index.freshness, null, 2)}\n`, "utf8");
  const facts = allFacts(index)
    .map((fact) => JSON.stringify(fact))
    .join("\n");
  await fs.writeFile(path.join(outputDir, "facts.ndjson"), `${facts}\n`, "utf8");
}

export async function buildIndexLocked(options: IndexOptions): Promise<CodexaIndex> {
  const repoRoot = path.resolve(options.repoRoot);
  const release = await acquireIndexLock(repoRoot);
  try {
    return await buildIndex(options);
  } finally {
    await release();
  }
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

export async function loadIndex(repoRoot: string): Promise<CodexaIndex | null> {
  const outputDir = path.join(path.resolve(repoRoot), CODEBASE_DIR);
  return (await readIndexBundle(outputDir)) ?? (await recoverIndexBundle(outputDir));
}

async function readIndexBundle(outputDir: string): Promise<CodexaIndex | null> {
  try {
    return normalizeLoadedIndex(JSON.parse(await fs.readFile(path.join(outputDir, "index.json"), "utf8")) as Partial<CodexaIndex>);
  } catch {
    return null;
  }
}

async function recoverIndexBundle(outputDir: string): Promise<CodexaIndex | null> {
  const parentDir = path.dirname(outputDir);
  let entries: Array<{ name: string; mtimeMs: number }> = [];
  try {
    entries = await Promise.all(
      (await fs.readdir(parentDir, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory() && entry.name.startsWith(".codebase.backup-"))
        .map(async (entry) => ({ name: entry.name, mtimeMs: (await fs.stat(path.join(parentDir, entry.name))).mtimeMs }))
    );
  } catch {
    return null;
  }
  for (const entry of entries.sort((a, b) => b.mtimeMs - a.mtimeMs || a.name.localeCompare(b.name))) {
    const backupDir = path.join(parentDir, entry.name);
    const recovered = await readIndexBundle(backupDir);
    if (!recovered) {
      continue;
    }
    if (await pathExists(outputDir)) {
      const corruptDir = path.join(parentDir, `.codebase.corrupt-${process.pid}-${Date.now()}`);
      await fs.rm(corruptDir, { recursive: true, force: true }).catch(() => undefined);
      await fs.rename(outputDir, corruptDir).catch(() => undefined);
    }
    if (!(await pathExists(outputDir))) {
      await fs.rename(backupDir, outputDir).catch(() => undefined);
    }
    return recovered;
  }
  return null;
}

function normalizeLoadedIndex(index: Partial<CodexaIndex>): CodexaIndex {
  if (
    index.schemaVersion !== 1 ||
    !index.snapshot ||
    !index.freshness ||
    !Array.isArray(index.files) ||
    !Array.isArray(index.symbols) ||
    !Array.isArray(index.usageSites) ||
    !Array.isArray(index.imports) ||
    !Array.isArray(index.testEdges) ||
    !Array.isArray(index.modules) ||
    !Array.isArray(index.risks) ||
    !Array.isArray(index.parserErrors)
  ) {
    throw new Error("Codexa index bundle is incomplete or unsupported");
  }
  return {
    ...(index as CodexaIndex),
    graphEdges: index.graphEdges ?? [],
    workflows: index.workflows ?? []
  };
}

export async function getFreshness(repoRoot: string, index?: CodexaIndex | null): Promise<FreshnessInfo> {
  const repo = path.resolve(repoRoot);
  const current = await discoverRepoFreshness(repo);
  const loaded = index ?? (await loadIndex(repo));
  if (!loaded) {
    return {
      schemaVersion: 1,
      snapshotId: "missing",
      repoRoot: repo,
      gitRoot: current.git.gitRoot,
      headCommit: current.git.headCommit,
      indexedAt: "",
      dirtyFiles: current.git.dirtyFiles,
      indexedDirtyFiles: [],
      dirtyFileHashes: current.dirtyFileHashes,
      indexedDirtyFileHashes: {},
      missing: true,
      stale: true,
      reason: "missing-index",
      parserErrorCount: 0
    };
  }

  const dirtyChanged =
    current.git.dirtyFiles.join("\n") !== loaded.freshness.indexedDirtyFiles.join("\n") ||
    stableJson(current.dirtyFileHashes) !== stableJson(loaded.freshness.indexedDirtyFileHashes ?? {});
  const commitChanged = current.git.headCommit !== loaded.freshness.headCommit;
  const repoRootChanged = path.resolve(loaded.freshness.repoRoot) !== repo || loaded.freshness.gitRoot !== current.git.gitRoot;
  const stale = dirtyChanged || commitChanged || repoRootChanged;
  return {
    ...loaded.freshness,
    repoRoot: repo,
    gitRoot: current.git.gitRoot,
    dirtyFiles: current.git.dirtyFiles,
    dirtyFileHashes: current.dirtyFileHashes,
    missing: false,
    stale,
    reason: stale
      ? commitChanged
        ? "head-commit-changed"
        : repoRootChanged
          ? "repo-root-changed"
          : "dirty-files-changed"
      : loaded.freshness.reason
  };
}

function applyRanking(index: CodexaIndex, churnByPath: Map<string, number>): CodexaIndex {
  const incomingImports = countBy(index.imports.flatMap((imp) => (imp.resolvedPath ? [imp.resolvedPath] : [])));
  const usageByPath = countBy(index.usageSites.map((usage) => usage.path));
  const symbolsByPath = countBy(index.symbols.map((symbol) => symbol.path));
  const riskByPath = new Map<string, number>();
  for (const risk of index.risks) {
    riskByPath.set(risk.path, (riskByPath.get(risk.path) ?? 0) + risk.score);
  }

  const files = index.files.map((file) => {
    const centrality = incomingImports.get(file.path) ?? 0;
    const usage = usageByPath.get(file.path) ?? 0;
    const symbols = symbolsByPath.get(file.path) ?? 0;
    const publicSurface = file.path.includes("/api/") || file.path.includes("app.") || file.path.includes("index.") ? 2 : 0;
    const churn = churnByPath.get(file.path) ?? 0;
    const testProximity = file.test ? 0.5 : index.testEdges.some((edge) => edge.targetPath === file.path) ? 1.5 : 0;
    const dirtyRisk = file.dirty ? 3 : 0;
    const riskScore = riskByPath.get(file.path) ?? 0;
    const generatedPenalty = file.generated ? -2 : 0;
    const rankReasons = {
      centrality: Math.log2(centrality + 1),
      usage: Math.log2(usage + 1),
      symbols: Math.min(symbols, 20) / 4,
      publicSurface,
      churn: Math.min(churn, 20) / 4,
      testProximity,
      dirtyRisk,
      riskScore: Math.min(riskScore, 12),
      generatedPenalty
    };
    const rank = Object.values(rankReasons).reduce((sum, value) => sum + value, 0);
    return {
      ...file,
      symbolCount: symbols,
      usageCount: usage,
      importCount: index.imports.filter((imp) => imp.path === file.path).length,
      riskScore,
      rank,
      rankReasons
    };
  });

  return { ...index, files: files.sort((a, b) => b.rank - a.rank || a.path.localeCompare(b.path)) };
}

function applyModules(index: CodexaIndex): CodexaIndex {
  const byModule = new Map<string, FileFact[]>();
  for (const file of index.files) {
    const name = moduleNameForPath(file.path);
    const files = byModule.get(name) ?? [];
    files.push(file);
    byModule.set(name, files);
  }

  const modules: ModuleClusterFact[] = [...byModule.entries()]
    .map(([name, files]) => {
      const rank = files.reduce((sum, file) => sum + file.rank, 0);
      const topFiles = files.slice(0, 5).map((file) => file.path).join(", ");
      return {
        id: stableId("module", name),
        type: "ModuleCluster" as const,
        source: "heuristic" as const,
        confidence: "heuristic" as const,
        snapshotId: index.snapshot.snapshotId,
        indexedAt: index.snapshot.indexedAt,
        name,
        files: uniqueSorted(files.map((file) => file.path)),
        summary: `${name} contains ${files.length} indexed files. Top files: ${topFiles || "none"}.`,
        rank
      };
    })
    .sort((a, b) => b.rank - a.rank || a.name.localeCompare(b.name));

  return { ...index, modules };
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

async function acquireIndexLock(repoRoot: string): Promise<() => Promise<void>> {
  const lockDir = path.join(repoRoot, INDEX_LOCK_DIR);
  const ownerPath = path.join(lockDir, "owner.json");
  const started = Date.now();
  const owner: IndexLockOwner = {
    pid: process.pid,
    token: randomUUID(),
    processStartTime: await currentProcessStartTime(process.pid),
    startedAt: new Date().toISOString(),
    heartbeatAt: new Date().toISOString(),
    repoRoot
  };
  await fs.mkdir(path.dirname(lockDir), { recursive: true });
  while (true) {
    try {
      await fs.mkdir(lockDir, { recursive: false });
      await writeLockOwner(ownerPath, owner);
      const heartbeat = setInterval(() => {
        owner.heartbeatAt = new Date().toISOString();
        void writeLockOwner(ownerPath, owner).catch(() => undefined);
      }, Math.max(10_000, Math.floor(INDEX_LOCK_STALE_MS / 3)));
      heartbeat.unref?.();
      return async () => {
        clearInterval(heartbeat);
        await removeLockIfOwned(lockDir, owner).catch(() => undefined);
      };
    } catch (error) {
      if (!isNodeError(error) || error.code !== "EEXIST") {
        throw error;
      }
      if (await removeStaleLock(lockDir)) {
        continue;
      }
      if (Date.now() - started > 30_000) {
        throw new Error(`Timed out waiting for Codexa index lock: ${lockDir}`);
      }
      await sleep(250);
    }
  }
}

async function removeStaleLock(lockDir: string): Promise<boolean> {
  const ownerPath = path.join(lockDir, "owner.json");
  try {
    const stat = await fs.stat(lockDir);
    const owner = await readLockOwner(ownerPath);
    if (owner) {
      if (!(await lockOwnerStillRunning(owner))) {
        await fs.rm(lockDir, { recursive: true, force: true });
        return true;
      }
      const heartbeatMs = Date.parse(owner.heartbeatAt || owner.startedAt);
      if (Date.now() - heartbeatMs <= INDEX_LOCK_STALE_MS) {
        return false;
      }
      return false;
    }
    if (Date.now() - stat.mtimeMs <= INDEX_LOCK_STALE_MS) {
      return false;
    }
    await fs.rm(lockDir, { recursive: true, force: true });
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return true;
    }
    return false;
  }
}

async function writeLockOwner(ownerPath: string, owner: IndexLockOwner): Promise<void> {
  const temp = `${ownerPath}.${process.pid}.${owner.token}.tmp`;
  await fs.writeFile(temp, `${JSON.stringify(owner)}\n`, "utf8");
  await fs.rename(temp, ownerPath);
}

async function readLockOwner(ownerPath: string): Promise<IndexLockOwner | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(ownerPath, "utf8")) as Partial<IndexLockOwner>;
    return typeof parsed.pid === "number" && typeof parsed.token === "string" && typeof parsed.startedAt === "string" && typeof parsed.heartbeatAt === "string"
      ? {
          pid: parsed.pid,
          token: parsed.token,
          processStartTime: parsed.processStartTime,
          startedAt: parsed.startedAt,
          heartbeatAt: parsed.heartbeatAt,
          repoRoot: typeof parsed.repoRoot === "string" ? parsed.repoRoot : ""
        }
      : null;
  } catch {
    return null;
  }
}

async function removeLockIfOwned(lockDir: string, owner: IndexLockOwner): Promise<void> {
  const current = await readLockOwner(path.join(lockDir, "owner.json"));
  if (current?.token === owner.token) {
    await fs.rm(lockDir, { recursive: true, force: true });
  }
}

async function lockOwnerStillRunning(owner: IndexLockOwner): Promise<boolean> {
  if (!Number.isInteger(owner.pid) || owner.pid <= 0) {
    return false;
  }
  const currentStart = await currentProcessStartTime(owner.pid);
  if (owner.processStartTime && currentStart) {
    return owner.processStartTime === currentStart;
  }
  try {
    process.kill(owner.pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function currentProcessStartTime(pid: number): Promise<string | null> {
  try {
    const stat = await fs.readFile(`/proc/${pid}/stat`, "utf8");
    const closeParen = stat.lastIndexOf(")");
    if (closeParen < 0) {
      return null;
    }
    const fields = stat.slice(closeParen + 2).trim().split(/\s+/);
    return fields[19] ?? null;
  } catch {
    return null;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function countBy(values: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return counts;
}

async function mapLimit<T, R>(items: T[], limit: number, mapper: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await fs.stat(candidate);
    return true;
  } catch {
    return false;
  }
}

function stableJson(value: Record<string, string>): string {
  return JSON.stringify(Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))));
}
