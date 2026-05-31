import { promises as fs } from "node:fs";
import path from "node:path";
import { acquireCacheLock } from "./cache-lock.js";
import { buildGraphEdges, extractWorkflowTraces } from "./graph.js";
import { moduleNameForPath } from "./language.js";
import { parseFile } from "./parser.js";
import { discoverRepoFiles, discoverRepoFreshness } from "./repo-files.js";
import { type ImportAliasRule, relinkUsageIds, resolveIndexLinks } from "./resolver.js";
import { loadExternalRiskSignals } from "./risk-ingest.js";
import { loadOutcomeRankSignals, type OutcomeRankSignals } from "./outcome-ranking.js";
import { applyPythonSemanticAssist } from "./semantic/python.js";
import { applyTypeScriptSemanticAssist } from "./semantic/typescript.js";
import { loadExternalSymbolReportFacts } from "./symbol-report-ingest.js";
import type {
  CodexaFact,
  CodexaIndex,
  FileFact,
  FreshnessInfo,
  GraphEdgeFact,
  IndexOptions,
  ModuleClusterFact,
  ParseResult,
  RepoSnapshotFact,
  RiskSignalFact
} from "./types.js";
import { normalizePath, stableId, uniqueSorted } from "./util.js";
import { writeArtifacts } from "./artifacts.js";

export const CODEBASE_DIR = ".codex/codebase";
const PARSE_CACHE_VERSION = "parse-cache-v1-placeholder-signals-20260515a";
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

  const [externalRisks, externalSymbols] = await Promise.all([
    loadExternalRiskSignals(repoRoot, snapshotId, indexedAt),
    loadExternalSymbolReportFacts(repoRoot, snapshotId, indexedAt, new Set(discovered.git.dirtyFiles))
  ]);
  const withExternalRisks = mergeExternalSymbolFacts({ ...initial, risks: dedupeRiskSignals([...initial.risks, ...externalRisks]) }, externalSymbols);
  const withTypeScriptSemanticAssist = await applyTypeScriptSemanticAssist(withExternalRisks, {
    repoRoot,
    files: discovered.files.map((file) => ({
      path: file.path,
      absolutePath: file.absolutePath,
      contentHash: file.contentHash
    }))
  });
  const withPythonSemanticAssist = applyPythonSemanticAssist(withTypeScriptSemanticAssist, {
    files: discovered.files.map((file) => ({
      path: file.path,
      sourceText: file.sourceText,
      contentHash: file.contentHash
    }))
  });
  const linked = relinkUsageIds(resolveIndexLinks(withPythonSemanticAssist, aliases));
  const outcomeSignals = await loadOutcomeRankSignals(repoRoot, discovered.git.headCommit, new Set(linked.files.map((file) => file.path)));
  const ranked = applyRanking(linked, discovered.git.churnByPath, outcomeSignals);
  const withModules = applyModules(ranked);
  const withGraph = { ...withModules, graphEdges: dedupeGraphEdges([...buildGraphEdges(withModules), ...externalSymbols.graphEdges]) };
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

function mergeExternalSymbolFacts(index: CodexaIndex, external: Awaited<ReturnType<typeof loadExternalSymbolReportFacts>>): CodexaIndex {
  const existingFiles = new Set(index.files.map((file) => file.path));
  const existingSymbols = new Set(index.symbols.map((symbol) => `${symbol.path}\0${symbol.qualifiedName}\0${symbol.kind}\0${symbol.range?.startLine ?? 0}`));
  return {
    ...index,
    files: [
      ...index.files,
      ...external.files.filter((file) => !existingFiles.has(file.path))
    ],
    symbols: [
      ...index.symbols,
      ...external.symbols.filter((symbol) => !existingSymbols.has(`${symbol.path}\0${symbol.qualifiedName}\0${symbol.kind}\0${symbol.range?.startLine ?? 0}`))
    ]
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

function dedupeGraphEdges(edges: GraphEdgeFact[]): GraphEdgeFact[] {
  const seen = new Set<string>();
  const result: GraphEdgeFact[] = [];
  for (const edge of edges) {
    if (seen.has(edge.id)) {
      continue;
    }
    seen.add(edge.id);
    result.push(edge);
  }
  return result.sort(
    (a, b) =>
      a.edgeKind.localeCompare(b.edgeKind) ||
      (a.fromPath ?? "").localeCompare(b.fromPath ?? "") ||
      (a.toPath ?? "").localeCompare(b.toPath ?? "") ||
      a.reason.localeCompare(b.reason)
  );
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
    scopePrefix: configDir === "." ? undefined : configDir,
    exact: !wildcard
  };
}

function normalizeAliasTarget(configDir: string, baseUrl: string, targetPattern: string): string {
  return normalizePath(path.posix.normalize(path.posix.join(configDir === "." ? "" : configDir, baseUrl, targetPattern)));
}

export async function persistIndex(index: CodexaIndex, outputDir: string): Promise<void> {
  await fs.mkdir(path.join(outputDir, "modules"), { recursive: true });
  await fs.writeFile(path.join(outputDir, "index.json"), `${JSON.stringify(index)}\n`, "utf8");
  await fs.writeFile(path.join(outputDir, "freshness.json"), `${JSON.stringify(index.freshness, null, 2)}\n`, "utf8");
  await writeFactsNdjson(path.join(outputDir, "facts.ndjson"), allFacts(index));
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

export async function loadIndex(repoRoot: string, options: { recover?: boolean } = {}): Promise<CodexaIndex | null> {
  const outputDir = path.join(path.resolve(repoRoot), CODEBASE_DIR);
  const index = await readIndexBundle(outputDir);
  if (index || options.recover === false) {
    return index;
  }
  return recoverIndexBundle(outputDir);
}

export async function loadIndexReadOnly(repoRoot: string): Promise<CodexaIndex | null> {
  return loadIndex(repoRoot, { recover: false });
}

export async function loadFreshnessReadOnly(repoRoot: string): Promise<FreshnessInfo | null> {
  return readFreshnessBundle(path.join(path.resolve(repoRoot), CODEBASE_DIR));
}

async function readIndexBundle(outputDir: string): Promise<CodexaIndex | null> {
  try {
    return normalizeLoadedIndex(JSON.parse(await fs.readFile(path.join(outputDir, "index.json"), "utf8")) as Partial<CodexaIndex>);
  } catch {
    return null;
  }
}

async function readFreshnessBundle(outputDir: string): Promise<FreshnessInfo | null> {
  try {
    return normalizeLoadedFreshness(JSON.parse(await fs.readFile(path.join(outputDir, "freshness.json"), "utf8")) as Partial<FreshnessInfo>);
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

function normalizeLoadedFreshness(freshness: Partial<FreshnessInfo>): FreshnessInfo {
  if (
    freshness.schemaVersion !== 1 ||
    typeof freshness.snapshotId !== "string" ||
    typeof freshness.repoRoot !== "string" ||
    typeof freshness.indexedAt !== "string" ||
    !Array.isArray(freshness.dirtyFiles) ||
    !Array.isArray(freshness.indexedDirtyFiles) ||
    !freshness.dirtyFileHashes ||
    typeof freshness.dirtyFileHashes !== "object" ||
    !freshness.indexedDirtyFileHashes ||
    typeof freshness.indexedDirtyFileHashes !== "object" ||
    typeof freshness.missing !== "boolean" ||
    typeof freshness.stale !== "boolean" ||
    typeof freshness.reason !== "string" ||
    typeof freshness.parserErrorCount !== "number"
  ) {
    throw new Error("Codexa freshness bundle is incomplete or unsupported");
  }
  return freshness as FreshnessInfo;
}

export async function getFreshness(repoRoot: string, index?: CodexaIndex | null, options: { recover?: boolean } = {}): Promise<FreshnessInfo> {
  const repo = path.resolve(repoRoot);
  const current = await discoverRepoFreshness(repo);
  if (index !== undefined) {
    return freshnessFromStored(repo, current, index?.freshness ?? null);
  }

  const stored = await loadFreshnessReadOnly(repo);
  if (stored) {
    const freshness = freshnessFromStored(repo, current, stored);
    if (!freshness.stale && options.recover !== false && (await indexBundleNewerThanFreshness(repo))) {
      const loaded = await loadIndex(repo);
      if (loaded) {
        return freshnessFromStored(repo, current, loaded.freshness);
      }
    }
    return freshness;
  }

  const loaded = options.recover === false ? null : await loadIndex(repo);
  return freshnessFromStored(repo, current, loaded?.freshness ?? null);
}

function freshnessFromStored(
  repo: string,
  current: Awaited<ReturnType<typeof discoverRepoFreshness>>,
  loaded: FreshnessInfo | null
): FreshnessInfo {
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
    current.git.dirtyFiles.join("\n") !== loaded.indexedDirtyFiles.join("\n") ||
    stableJson(current.dirtyFileHashes) !== stableJson(loaded.indexedDirtyFileHashes ?? {});
  const commitChanged = current.git.headCommit !== loaded.headCommit;
  const repoRootChanged = path.resolve(loaded.repoRoot) !== repo || loaded.gitRoot !== current.git.gitRoot;
  const stale = dirtyChanged || commitChanged || repoRootChanged;
  return {
    ...loaded,
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
      : loaded.reason
  };
}

function applyRanking(index: CodexaIndex, churnByPath: Map<string, number>, outcomeSignals?: OutcomeRankSignals): CodexaIndex {
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
    const outcomeHistory = Math.min(3, outcomeSignals?.boosts.get(file.path) ?? 0);
    const rankReasons = {
      centrality: Math.log2(centrality + 1),
      usage: Math.log2(usage + 1),
      symbols: Math.min(symbols, 20) / 4,
      publicSurface,
      churn: Math.min(churn, 20) / 4,
      testProximity,
      dirtyRisk,
      riskScore: Math.min(riskScore, 12),
      outcomeHistory,
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

async function writeFactsNdjson(filePath: string, facts: CodexaFact[]): Promise<void> {
  const handle = await fs.open(filePath, "w");
  try {
    for (const fact of facts) {
      await handle.write(`${JSON.stringify(fact)}\n`);
    }
  } finally {
    await handle.close();
  }
}

async function acquireIndexLock(repoRoot: string): Promise<() => Promise<void>> {
  return acquireCacheLock({
    repoRoot,
    lockDir: INDEX_LOCK_DIR,
    staleMs: INDEX_LOCK_STALE_MS,
    timeoutMs: 30_000,
    label: "Codexa index"
  });
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

async function indexBundleNewerThanFreshness(repoRoot: string): Promise<boolean> {
  try {
    const outputDir = path.join(repoRoot, CODEBASE_DIR);
    const [indexStat, freshnessStat] = await Promise.all([
      fs.stat(path.join(outputDir, "index.json")),
      fs.stat(path.join(outputDir, "freshness.json"))
    ]);
    return indexStat.mtimeMs > freshnessStat.mtimeMs;
  } catch {
    return false;
  }
}

function stableJson(value: Record<string, string>): string {
  return JSON.stringify(Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))));
}
