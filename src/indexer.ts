import { promises as fs } from "node:fs";
import path from "node:path";
import { acquireCacheLock } from "./cache-lock.js";
import { discoverRepoFreshness } from "./repo-files.js";
import { type ImportAliasRule, relinkUsageIds, resolveIndexLinks } from "./resolver.js";
import { externalRiskReportSnapshot, loadExternalRiskSignalReport, type ExternalRiskReportDiagnostic } from "./risk-ingest.js";
import { loadOutcomeRankSignals } from "./outcome-ranking.js";
import { writeIndexBundle as writeIndexBundleStage } from "./indexer/artifact-writing.js";
import { discoverIndexInputs } from "./indexer/discovery.js";
import { freshnessFromStored } from "./indexer/freshness.js";
import { applyGraphStages } from "./indexer/graph-stage.js";
import { formatBytes, loadPythonSemanticSourceFiles, parseRepoSources, writeParseCache } from "./indexer/parsing.js";
import { applyModules, applyRanking } from "./indexer/ranking.js";
import { applyPythonSemanticAssist } from "./semantic/python.js";
import { applyTypeScriptSemanticAssist } from "./semantic/typescript.js";
import { loadExternalSymbolReportFacts } from "./symbol-report-ingest.js";
import type {
  CodexaIndex,
  FreshnessInfo,
  IndexOptions,
  ParserErrorFact,
  RepoSnapshotFact,
  RiskSignalFact
} from "./types.js";
import { normalizePath, stableId } from "./util.js";

export const CODEBASE_DIR = ".codex/codebase";
export { persistIndex, writeIndexBundle } from "./indexer/artifact-writing.js";
const INDEX_LOCK_DIR = ".codex/cache/codexa-index.lock";
const INDEX_LOCK_STALE_MS = 120_000;

export async function buildIndex(options: IndexOptions): Promise<CodexaIndex> {
  const repoRoot = path.resolve(options.repoRoot);
  const discovered = await discoverIndexInputs(repoRoot);
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
  const parsedSources = await parseRepoSources({
    repoRoot,
    files: discovered.files,
    skippedFiles: discovered.skippedFiles,
    snapshotId,
    indexedAt
  });
  const parsed = parsedSources.parsed;
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
      parserErrorCount: 0,
      externalRiskReportHashes: {},
      indexedExternalRiskReportHashes: {},
      externalRiskReportDiagnostics: []
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

  const [externalRiskReport, externalSymbols] = await Promise.all([
    loadExternalRiskSignalReport(repoRoot, snapshotId, indexedAt),
    loadExternalSymbolReportFacts(repoRoot, snapshotId, indexedAt, new Set(discovered.git.dirtyFiles))
  ]);
  const withExternalRisks = mergeExternalSymbolFacts(
    {
      ...initial,
      freshness: {
        ...initial.freshness,
        externalRiskReportHashes: externalRiskReport.reportHashes,
        indexedExternalRiskReportHashes: externalRiskReport.reportHashes,
        externalRiskReportDiagnostics: externalRiskReport.diagnostics
      },
      risks: dedupeRiskSignals([...initial.risks, ...externalRiskReport.risks]),
      parserErrors: [...initial.parserErrors, ...externalRiskReport.diagnostics.map((diagnostic) => riskReportParserError(diagnostic, snapshotId, indexedAt))]
    },
    externalSymbols
  );
  const withTypeScriptSemanticAssist = await applyTypeScriptSemanticAssist(withExternalRisks, {
    repoRoot,
    files: discovered.files.map((file) => ({
      path: file.path,
      absolutePath: file.absolutePath,
      contentHash: file.contentHash
    }))
  });
  const withPythonSemanticAssist = applyPythonSemanticAssist(withTypeScriptSemanticAssist, {
    files: await loadPythonSemanticSourceFiles(discovered.files)
  });
  const linked = relinkUsageIds(resolveIndexLinks(withPythonSemanticAssist, aliases));
  const outcomeSignals = await loadOutcomeRankSignals(repoRoot, discovered.git.headCommit, new Set(linked.files.map((file) => file.path)));
  const ranked = applyRanking(linked, discovered.git.churnByPath, outcomeSignals);
  const withModules = applyModules(ranked);
  const withWorkflows = applyGraphStages(withModules, externalSymbols.graphEdges);
  const freshness: FreshnessInfo = {
    ...withWorkflows.freshness,
    parserErrorCount: withWorkflows.parserErrors.length
  };
  const finalIndex = { ...withWorkflows, freshness };

  if (options.writeArtifacts ?? true) {
    await writeIndexBundleStage(finalIndex, options.outputDir ?? path.join(repoRoot, CODEBASE_DIR));
    await writeParseCache(repoRoot, parsedSources.nextCache);
  }

  return finalIndex;
}

function riskReportParserError(diagnostic: ExternalRiskReportDiagnostic, snapshotId: string, indexedAt: string): ParserErrorFact {
  return {
    id: stableId("external-risk-report-diagnostic", diagnostic.path, diagnostic.reason, diagnostic.sizeBytes ?? 0, diagnostic.limitBytes ?? 0),
    type: "ParserError",
    path: diagnostic.path,
    source: "static-analysis",
    confidence: "heuristic",
    snapshotId,
    indexedAt,
    message:
      diagnostic.reason === "report-too-large"
        ? `Skipped external risk report ${diagnostic.path}: ${formatBytes(diagnostic.sizeBytes ?? 0)} exceeds Codexa's ${formatBytes(diagnostic.limitBytes ?? 0)} report cap`
        : `Skipped external risk report ${diagnostic.path}: invalid JSON`
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

export async function buildIndexLocked(options: IndexOptions): Promise<CodexaIndex> {
  const repoRoot = path.resolve(options.repoRoot);
  const release = await acquireIndexLock(repoRoot);
  try {
    return await buildIndex(options);
  } finally {
    await release();
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
  const [current, riskReports] = await Promise.all([discoverRepoFreshness(repo), externalRiskReportSnapshot(repo)]);
  if (index !== undefined) {
    return freshnessFromStored(repo, current, riskReports, index?.freshness ?? null);
  }

  const stored = await loadFreshnessReadOnly(repo);
  if (stored) {
    const freshness = freshnessFromStored(repo, current, riskReports, stored);
    if (!freshness.stale && options.recover !== false && (await indexBundleNewerThanFreshness(repo))) {
      const loaded = await loadIndex(repo);
      if (loaded) {
        return freshnessFromStored(repo, current, riskReports, loaded.freshness);
      }
    }
    return freshness;
  }

  const loaded = options.recover === false ? null : await loadIndex(repo);
  return freshnessFromStored(repo, current, riskReports, loaded?.freshness ?? null);
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
