import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { acquireCacheLock } from "./cache-lock.js";
import { CODEXA_INDEX_REVISION, CODEXA_INDEX_SCHEMA_VERSION } from "./index-revision.js";
import { MAX_INDEX_ARTIFACT_BYTES } from "./index-limits.js";
import { ensureSafeManagedStateDirectory } from "./init-portability.js";
import { digestManagedArtifact, isManagedArtifactSegment, readManagedArtifactText, requireManagedArtifactDirectory } from "./managed-artifacts.js";
import { discoverRepoFreshness } from "./repo-files.js";
import { relinkUsageIds, resolveIndexLinks } from "./resolver.js";
import { externalRiskReportSnapshot, loadExternalRiskSignalReport } from "./risk-ingest.js";
import { loadOutcomeRankSignals } from "./outcome-ranking.js";
import { loadImportAliases } from "./indexer/aliases.js";
import { writeIndexBundle as writeIndexBundleStage } from "./indexer/artifact-writing.js";
import { discoverIndexInputs } from "./indexer/discovery.js";
import { applyExternalSymbolFacts, dedupeRiskSignals, riskReportParserError, symbolReportParserError } from "./indexer/external-facts.js";
import { freshnessFromStored } from "./indexer/freshness.js";
import { applyGraphStages } from "./indexer/graph-stage.js";
import { loadPythonSemanticSourceFiles, parseRepoSources, type ParsedRepoSources, writeParseCache } from "./indexer/parsing.js";
import { runIndexPipeline, type IndexPipelineStage } from "./indexer/pipeline.js";
import { applyModules, applyRanking } from "./indexer/ranking.js";
import { applyPythonSemanticAssist } from "./semantic/python.js";
import { applyTypeScriptSemanticAssist } from "./semantic/typescript.js";
import { externalSymbolReportSnapshot, loadExternalSymbolReportFacts } from "./symbol-report-ingest.js";
import type {
  CodexaIndex,
  FreshnessInfo,
  IndexOptions,
  RepoSnapshotFact
} from "./types.js";
import { mapLimit, stableId } from "./util.js";

export const CODEBASE_DIR = ".codex/codebase";
export { CODEXA_INDEX_REVISION, CODEXA_INDEX_SCHEMA_VERSION } from "./index-revision.js";
export { persistIndex, writeIndexBundle } from "./indexer/artifact-writing.js";
const INDEX_LOCK_DIR = ".codex/cache/codexa-index.lock";
const INDEX_LOCK_STALE_MS = 120_000;

interface BuildIndexPipelineContext {
  options: IndexOptions;
  repoRoot: string;
  discovered?: Awaited<ReturnType<typeof discoverIndexInputs>>;
  indexedAt?: string;
  snapshotId?: string;
  snapshot?: RepoSnapshotFact;
  previousFreshness?: FreshnessInfo | null;
  parsedSources?: ParsedRepoSources;
  parsed?: ParsedRepoSources["parsed"];
  aliases?: Awaited<ReturnType<typeof loadImportAliases>>;
  externalSymbols?: Awaited<ReturnType<typeof loadExternalSymbolReportFacts>>;
  index?: CodexaIndex;
}

interface IndexIntegrityManifest {
  schemaVersion: 1;
  indexRevision: number;
  index: { sizeBytes: number; sha256: string };
  freshness: { sizeBytes: number; sha256: string };
  snapshot: Pick<RepoSnapshotFact, "repoRoot" | "snapshotId" | "headCommit" | "gitRoot">;
}

export interface IndexStatusSnapshot {
  identity: {
    snapshot: IndexIntegrityManifest["snapshot"];
    freshness: FreshnessInfo;
  };
  freshness: FreshnessInfo;
}

export async function buildIndex(options: IndexOptions): Promise<CodexaIndex> {
  const repoRoot = path.resolve(options.repoRoot);
  if (options.writeArtifacts ?? true) {
    await ensureSafeManagedStateDirectory(repoRoot, "cache");
  }
  const finalContext = await runIndexPipeline<BuildIndexPipelineContext>(
    { options, repoRoot },
    [
      discoverStage(),
      parseStage(),
      externalFactsStage(),
      semanticAssistStage(),
      linkStage(),
      rankingStage(),
      graphStage(),
      freshnessStage(),
      artifactWritingStage()
    ]
  );
  if (!finalContext.index) {
    throw new Error("Codexa index pipeline did not produce an index");
  }
  return finalContext.index;
}

function discoverStage(): IndexPipelineStage<BuildIndexPipelineContext> {
  return {
    name: "discover",
    async run(context) {
      const [discovered, previousFreshness] = await Promise.all([discoverIndexInputs(context.repoRoot), loadFreshnessReadOnly(context.repoRoot)]);
      const indexedAt = new Date().toISOString();
      const snapshotId = stableId("snapshot", context.repoRoot, discovered.git.headCommit, discovered.git.dirtyFiles.join("\n"), indexedAt);
      const snapshot: RepoSnapshotFact = {
        id: stableId("repo-snapshot", context.repoRoot, discovered.git.headCommit ?? "none"),
        type: "RepoSnapshot",
        source: "git",
        confidence: "authoritative",
        snapshotId,
        indexedAt,
        repoRoot: context.repoRoot,
        gitRoot: discovered.git.gitRoot,
        headCommit: discovered.git.headCommit,
        dirtyFiles: discovered.git.dirtyFiles
      };
      return { ...context, discovered, indexedAt, snapshotId, snapshot, previousFreshness };
    }
  };
}

function parseStage(): IndexPipelineStage<BuildIndexPipelineContext> {
  return {
    name: "parse",
    async run(context) {
      const { discovered, snapshotId, indexedAt, snapshot } = requireIndexContext(context, "parse", ["discovered", "snapshotId", "indexedAt", "snapshot"]);
      const parsedSources = await parseRepoSources({
        repoRoot: context.repoRoot,
        files: discovered.files,
        skippedFiles: discovered.skippedFiles,
        snapshotId,
        indexedAt
      });
      const parsed = parsedSources.parsed;
      const aliases = await loadImportAliases(context.repoRoot, discovered.files.map((file) => file.path));
      const index: CodexaIndex = {
        schemaVersion: CODEXA_INDEX_SCHEMA_VERSION,
        indexRevision: CODEXA_INDEX_REVISION,
        snapshot,
        freshness: {
          schemaVersion: CODEXA_INDEX_SCHEMA_VERSION,
          indexRevision: CODEXA_INDEX_REVISION,
          snapshotId,
          repoRoot: context.repoRoot,
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
          degradedGitState: discovered.git.degradedReasons,
          externalRiskReportHashes: {},
          indexedExternalRiskReportHashes: {},
          externalRiskReportDiagnostics: [],
          externalSymbolReportHashes: {},
          indexedExternalSymbolReportHashes: {},
          externalSymbolReportDiagnostics: []
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
        workflowMembershipSpill: {},
        modules: [],
        risks: parsed.flatMap((result) => result.risks),
        parserErrors: parsed.flatMap((result) => result.parserErrors)
      };
      return { ...context, parsedSources, parsed, aliases, index };
    }
  };
}

function externalFactsStage(): IndexPipelineStage<BuildIndexPipelineContext> {
  return {
    name: "external-facts",
    async run(context) {
      const { discovered, indexedAt, index, snapshotId } = requireIndexContext(context, "external-facts", ["discovered", "indexedAt", "index", "snapshotId"]);
      const knownSymbolReportPaths = knownExternalSymbolReportPaths(context.previousFreshness);
      const knownRiskReportPaths = knownExternalRiskReportPaths(context.previousFreshness);
      const knownExternalReportPaths = new Set([...knownSymbolReportPaths, ...knownRiskReportPaths]);
      const [externalRiskReport, externalSymbols] = await Promise.all([
        loadExternalRiskSignalReport(context.repoRoot, snapshotId, indexedAt, knownSymbolReportPaths, knownRiskReportPaths),
        loadExternalSymbolReportFacts(context.repoRoot, snapshotId, indexedAt, new Set(discovered.git.dirtyFiles), knownSymbolReportPaths, knownExternalReportPaths)
      ]);
      const indexWithReports = applyExternalSymbolFacts(
        {
          ...index,
          freshness: {
            ...index.freshness,
            externalRiskReportHashes: externalRiskReport.reportHashes,
            indexedExternalRiskReportHashes: externalRiskReport.reportHashes,
            externalRiskReportDiagnostics: externalRiskReport.diagnostics,
            externalSymbolReportHashes: externalSymbols.reportHashes,
            indexedExternalSymbolReportHashes: externalSymbols.reportHashes,
            externalSymbolReportDiagnostics: externalSymbols.diagnostics
          },
          risks: dedupeRiskSignals([...index.risks, ...externalRiskReport.risks]),
          parserErrors: [
            ...index.parserErrors,
            ...externalRiskReport.diagnostics.map((diagnostic) => riskReportParserError(diagnostic, snapshotId, indexedAt)),
            ...externalSymbols.diagnostics.map((diagnostic) => symbolReportParserError(diagnostic, snapshotId, indexedAt))
          ]
        },
        externalSymbols
      );
      return { ...context, externalSymbols, index: indexWithReports };
    }
  };
}

function semanticAssistStage(): IndexPipelineStage<BuildIndexPipelineContext> {
  return {
    name: "semantic-assist",
    async run(context) {
      const { discovered, index } = requireIndexContext(context, "semantic-assist", ["discovered", "index"]);
      const withTypeScriptSemanticAssist = await applyTypeScriptSemanticAssist(index, {
        repoRoot: context.repoRoot,
        files: discovered.files.map((file) => ({
          path: file.path,
          absolutePath: file.absolutePath,
          contentHash: file.contentHash
        }))
      });
      const withPythonSemanticAssist = applyPythonSemanticAssist(withTypeScriptSemanticAssist, {
        files: await loadPythonSemanticSourceFiles(discovered.files)
      });
      return { ...context, index: withPythonSemanticAssist };
    }
  };
}

function linkStage(): IndexPipelineStage<BuildIndexPipelineContext> {
  return {
    name: "link",
    run(context) {
      const { aliases, index } = requireIndexContext(context, "link", ["aliases", "index"]);
      return { ...context, index: relinkUsageIds(resolveIndexLinks(index, aliases)) };
    }
  };
}

function rankingStage(): IndexPipelineStage<BuildIndexPipelineContext> {
  return {
    name: "rank",
    async run(context) {
      const { discovered, index } = requireIndexContext(context, "rank", ["discovered", "index"]);
      const outcomeSignals = await loadOutcomeRankSignals(context.repoRoot, discovered.git.headCommit, new Set(index.files.map((file) => file.path)));
      return { ...context, index: applyRanking(index, discovered.git.churnByPath, outcomeSignals) };
    }
  };
}

function graphStage(): IndexPipelineStage<BuildIndexPipelineContext> {
  return {
    name: "graph",
    run(context) {
      const { externalSymbols, index } = requireIndexContext(context, "graph", ["externalSymbols", "index"]);
      return { ...context, index: applyModules(applyGraphStages(index, externalSymbols.graphEdges)) };
    }
  };
}

function freshnessStage(): IndexPipelineStage<BuildIndexPipelineContext> {
  return {
    name: "freshness",
    run(context) {
      const { index } = requireIndexContext(context, "freshness", ["index"]);
      return {
        ...context,
        index: {
          ...index,
          freshness: {
            ...index.freshness,
            parserErrorCount: index.parserErrors.length
          }
        }
      };
    }
  };
}

function artifactWritingStage(): IndexPipelineStage<BuildIndexPipelineContext> {
  return {
    name: "artifact-writing",
    async run(context) {
      const { index, parsedSources } = requireIndexContext(context, "artifact-writing", ["index", "parsedSources"]);
      if (context.options.writeArtifacts ?? true) {
        await writeIndexBundleStage(index, context.options.outputDir ?? path.join(context.repoRoot, CODEBASE_DIR));
        await writeParseCache(context.repoRoot, parsedSources.nextCache);
      }
      return context;
    }
  };
}

function requireIndexContext<K extends keyof BuildIndexPipelineContext>(
  context: BuildIndexPipelineContext,
  stage: string,
  keys: K[]
): BuildIndexPipelineContext & { [P in K]-?: NonNullable<BuildIndexPipelineContext[P]> } {
  for (const key of keys) {
    if (context[key] === undefined || context[key] === null) {
      throw new Error(`Codexa index pipeline stage ${stage} missing ${String(key)}`);
    }
  }
  return context as BuildIndexPipelineContext & { [P in K]-?: NonNullable<BuildIndexPipelineContext[P]> };
}

export async function buildIndexLocked(options: IndexOptions): Promise<CodexaIndex> {
  const repoRoot = path.resolve(options.repoRoot);
  await ensureSafeManagedStateDirectory(repoRoot, "cache");
  const release = await acquireIndexLock(repoRoot);
  try {
    return await buildIndex(options);
  } finally {
    await release();
  }
}

export async function loadIndex(repoRoot: string, options: { recover?: boolean } = {}): Promise<CodexaIndex | null> {
  const repo = path.resolve(repoRoot);
  const outputDir = path.join(repo, CODEBASE_DIR);
  const index = await readIndexBundle(repo, outputDir);
  if (index || options.recover === false) {
    return index;
  }
  return recoverIndexBundle(repo, outputDir);
}

export async function loadIndexReadOnly(repoRoot: string): Promise<CodexaIndex | null> {
  return loadIndex(repoRoot, { recover: false });
}

export async function loadFreshnessReadOnly(repoRoot: string): Promise<FreshnessInfo | null> {
  const repo = path.resolve(repoRoot);
  return readFreshnessBundle(repo, path.join(repo, CODEBASE_DIR));
}

/**
 * Load the status projection without decoding the potentially large index.
 * The integrity sidecar is published in the same atomic directory bundle. A
 * missing, torn, or modified sidecar falls back to the full loader at the
 * caller so legacy and damaged bundles retain their established semantics.
 */
export async function loadIndexStatusReadOnly(repoRoot: string): Promise<IndexStatusSnapshot | null> {
  const repo = path.resolve(repoRoot);
  const relativeDir = CODEBASE_DIR.split("/");
  let manifest: IndexIntegrityManifest;
  let stored: FreshnessInfo;
  try {
    const [manifestText, freshnessText] = await Promise.all([
      readManagedArtifactText(repo, [...relativeDir, "index-integrity.json"]),
      readManagedArtifactText(repo, [...relativeDir, "freshness.json"])
    ]);
    manifest = normalizeIndexIntegrityManifest(JSON.parse(manifestText) as unknown);
    stored = normalizeLoadedFreshness(JSON.parse(freshnessText) as Partial<FreshnessInfo>);
    const freshnessDigest = {
      sizeBytes: Buffer.byteLength(freshnessText, "utf8"),
      sha256: createHash("sha256").update(freshnessText, "utf8").digest("hex")
    };
    if (
      manifest.index.sizeBytes > MAX_INDEX_ARTIFACT_BYTES ||
      manifest.indexRevision !== CODEXA_INDEX_REVISION ||
      stored.indexRevision !== manifest.indexRevision ||
      !sameArtifactDigest(manifest.freshness, freshnessDigest)
    ) {
      return null;
    }
    const indexDigest = await digestManagedArtifact(
      repo,
      [...relativeDir, "index.json"],
      manifest.index.sizeBytes
    );
    if (!sameArtifactDigest(manifest.index, indexDigest)) return null;
  } catch {
    return null;
  }
  // Live checkout discovery intentionally sits outside the compatibility
  // fallback: command-budget and filesystem failures must retain the same
  // observable behavior as the full status path rather than being retried.
  const [current, riskReports, symbolReports] = await externalFreshnessInputs(repo, stored);
  return {
    identity: { snapshot: manifest.snapshot, freshness: stored },
    freshness: freshnessFromStored(repo, current, riskReports, symbolReports, stored)
  };
}

async function readIndexBundle(repoRoot: string, outputDir: string): Promise<CodexaIndex | null> {
  try {
    const relativeDir = path.relative(repoRoot, outputDir).split(path.sep);
    return normalizeLoadedIndex(
      JSON.parse(await readManagedArtifactText(repoRoot, [...relativeDir, "index.json"], MAX_INDEX_ARTIFACT_BYTES)) as Partial<CodexaIndex>
    );
  } catch {
    return null;
  }
}

async function readFreshnessBundle(repoRoot: string, outputDir: string): Promise<FreshnessInfo | null> {
  try {
    const relativeDir = path.relative(repoRoot, outputDir).split(path.sep);
    return normalizeLoadedFreshness(
      JSON.parse(await readManagedArtifactText(repoRoot, [...relativeDir, "freshness.json"])) as Partial<FreshnessInfo>
    );
  } catch {
    return null;
  }
}

async function recoverIndexBundle(repoRoot: string, outputDir: string): Promise<CodexaIndex | null> {
  const parentDir = path.dirname(outputDir);
  let entries: Array<{ name: string; mtimeMs: number }> = [];
  try {
    const parent = await requireManagedArtifactDirectory(repoRoot, parentDir);
    const candidates = (await fs.readdir(parent.directory, { withFileTypes: true }))
      .filter((entry) => isManagedArtifactSegment(entry.name) && entry.name.startsWith(".codebase.backup-"))
      .map((entry) => entry.name)
      .sort((left, right) => right.localeCompare(left));
    const inspected = await mapLimit(candidates, 8, async (name) => {
      const backup = await requireManagedArtifactDirectory(repoRoot, path.join(parent.directory, name)).catch(() => undefined);
      return backup ? { name, mtimeMs: (await fs.lstat(backup.directory)).mtimeMs } : undefined;
    });
    entries = inspected.filter((entry): entry is { name: string; mtimeMs: number } => Boolean(entry));
  } catch {
    return null;
  }
  for (const entry of entries.sort((a, b) => b.mtimeMs - a.mtimeMs || a.name.localeCompare(b.name))) {
    const backupDir = path.join(parentDir, entry.name);
    const recovered = await readIndexBundle(repoRoot, backupDir);
    if (!recovered) {
      continue;
    }
    if (await pathExists(outputDir)) {
      try {
        await requireManagedArtifactDirectory(repoRoot, outputDir);
      } catch {
        return null;
      }
      const corruptDir = path.join(parentDir, `.codebase.corrupt-${process.pid}-${randomUUID()}`);
      try {
        await fs.rename(outputDir, corruptDir);
      } catch {
        continue;
      }
    }
    if (!(await pathExists(outputDir))) {
      try {
        await requireManagedArtifactDirectory(repoRoot, backupDir);
        await fs.rename(backupDir, outputDir);
      } catch {
        continue;
      }
    }
    return (await readIndexBundle(repoRoot, outputDir)) ?? recovered;
  }
  return null;
}

function normalizeLoadedIndex(index: Partial<CodexaIndex>): CodexaIndex {
  if (
    index.schemaVersion !== CODEXA_INDEX_SCHEMA_VERSION ||
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
  const indexRevision = normalizeStoredIndexRevision(index.indexRevision, "index");
  if (
    indexRevision !== undefined &&
    indexRevision >= 3 &&
    (!Array.isArray(index.graphEdges) || !Array.isArray(index.workflows))
  ) {
    throw new Error("Codexa current graph and workflow lanes are incomplete or unsupported");
  }
  const freshness = normalizeLoadedFreshness(index.freshness);
  const workflows = index.workflows ?? [];
  const workflowMembershipSpill = normalizeWorkflowMembershipSpill(index.workflowMembershipSpill, indexRevision, workflows);
  // A schema-v1 bundle remains readable when the revision is absent, but the
  // nested freshness revision is authoritative only when both persisted
  // copies agree. Any legacy or torn publication therefore becomes stale.
  const consistentFreshnessRevision = indexRevision === freshness.indexRevision ? indexRevision : undefined;
  return {
    ...(index as CodexaIndex),
    indexRevision,
    freshness: { ...freshness, indexRevision: consistentFreshnessRevision },
    graphEdges: index.graphEdges ?? [],
    workflows,
    workflowMembershipSpill
  };
}

function normalizeWorkflowMembershipSpill(
  value: unknown,
  indexRevision: number | undefined,
  workflows: CodexaIndex["workflows"]
): Record<string, string[]> {
  if (value === undefined && (indexRevision === undefined || indexRevision < 3)) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Codexa workflow membership spill is incomplete or unsupported");
  }
  const spill = value as Record<string, unknown>;
  for (const [workflowId, paths] of Object.entries(spill)) {
    if (!Array.isArray(paths) || !paths.every((filePath) => typeof filePath === "string")) {
      throw new Error(`Codexa workflow membership spill is invalid for ${workflowId}`);
    }
  }
  if (indexRevision !== undefined && indexRevision >= 3) {
    for (const workflow of workflows) {
      if (!Object.prototype.hasOwnProperty.call(spill, workflow.id)) {
        throw new Error(`Codexa workflow membership spill is missing ${workflow.id}`);
      }
    }
  }
  return spill as Record<string, string[]>;
}

function normalizeLoadedFreshness(freshness: Partial<FreshnessInfo>): FreshnessInfo {
  if (
    freshness.schemaVersion !== CODEXA_INDEX_SCHEMA_VERSION ||
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
  return {
    ...(freshness as FreshnessInfo),
    indexRevision: normalizeStoredIndexRevision(freshness.indexRevision, "freshness")
  };
}

function normalizeStoredIndexRevision(value: unknown, artifact: "index" | "freshness"): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error(`Codexa ${artifact} index revision is invalid`);
  }
  return value as number;
}

function normalizeIndexIntegrityManifest(value: unknown): IndexIntegrityManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Codexa index integrity manifest is incomplete");
  }
  const manifest = value as Partial<IndexIntegrityManifest>;
  if (
    manifest.schemaVersion !== 1 ||
    !Number.isSafeInteger(manifest.indexRevision) ||
    (manifest.indexRevision as number) < 1 ||
    !validArtifactDigest(manifest.index) ||
    !validArtifactDigest(manifest.freshness) ||
    !manifest.snapshot ||
    typeof manifest.snapshot.repoRoot !== "string" ||
    manifest.snapshot.repoRoot.length === 0 ||
    typeof manifest.snapshot.snapshotId !== "string" ||
    manifest.snapshot.snapshotId.length === 0 ||
    !nullableString(manifest.snapshot.headCommit) ||
    !nullableString(manifest.snapshot.gitRoot)
  ) {
    throw new Error("Codexa index integrity manifest is incomplete or unsupported");
  }
  return manifest as IndexIntegrityManifest;
}

function validArtifactDigest(value: unknown): value is { sizeBytes: number; sha256: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const digest = value as { sizeBytes?: unknown; sha256?: unknown };
  return Number.isSafeInteger(digest.sizeBytes) && (digest.sizeBytes as number) > 0 &&
    typeof digest.sha256 === "string" && /^[a-f0-9]{64}$/u.test(digest.sha256);
}

function sameArtifactDigest(left: { sizeBytes: number; sha256: string }, right: { sizeBytes: number; sha256: string }): boolean {
  return left.sizeBytes === right.sizeBytes && left.sha256 === right.sha256;
}

function nullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

export async function getFreshness(repoRoot: string, index?: CodexaIndex | null, options: { recover?: boolean } = {}): Promise<FreshnessInfo> {
  const repo = path.resolve(repoRoot);
  if (index !== undefined) {
    const [current, riskReports, symbolReports] = await externalFreshnessInputs(repo, index?.freshness ?? null);
    return freshnessFromStored(repo, current, riskReports, symbolReports, index?.freshness ?? null);
  }

  const [current, stored] = await Promise.all([discoverRepoFreshness(repo), loadFreshnessReadOnly(repo)]);
  if (stored) {
    const [riskReports, symbolReports] = await externalReportSnapshots(repo, knownExternalSymbolReportPaths(stored), knownExternalRiskReportPaths(stored));
    const freshness = freshnessFromStored(repo, current, riskReports, symbolReports, stored);
    if (!freshness.stale && options.recover !== false && (await indexBundleNewerThanFreshness(repo))) {
      const loaded = await loadIndex(repo);
      if (loaded) {
        const [recoveredRiskReports, recoveredSymbolReports] = await externalReportSnapshots(repo, knownExternalSymbolReportPaths(loaded.freshness), knownExternalRiskReportPaths(loaded.freshness));
        return freshnessFromStored(repo, current, recoveredRiskReports, recoveredSymbolReports, loaded.freshness);
      }
    }
    return freshness;
  }

  const loaded = options.recover === false ? null : await loadIndex(repo);
  const [riskReports, symbolReports] = await externalReportSnapshots(repo, knownExternalSymbolReportPaths(loaded?.freshness ?? null), knownExternalRiskReportPaths(loaded?.freshness ?? null));
  return freshnessFromStored(repo, current, riskReports, symbolReports, loaded?.freshness ?? null);
}

async function externalFreshnessInputs(
  repo: string,
  stored: FreshnessInfo | null
): Promise<[
  Awaited<ReturnType<typeof discoverRepoFreshness>>,
  Awaited<ReturnType<typeof externalRiskReportSnapshot>>,
  Awaited<ReturnType<typeof externalSymbolReportSnapshot>>
]> {
  const current = await discoverRepoFreshness(repo);
  const [riskReports, symbolReports] = await externalReportSnapshots(repo, knownExternalSymbolReportPaths(stored), knownExternalRiskReportPaths(stored));
  return [current, riskReports, symbolReports];
}

async function externalReportSnapshots(
  repo: string,
  knownSymbolReportPaths: Set<string>,
  knownRiskReportPaths: Set<string>
): Promise<[Awaited<ReturnType<typeof externalRiskReportSnapshot>>, Awaited<ReturnType<typeof externalSymbolReportSnapshot>>]> {
  const knownExternalReportPaths = new Set([...knownSymbolReportPaths, ...knownRiskReportPaths]);
  return Promise.all([externalRiskReportSnapshot(repo, knownSymbolReportPaths, knownRiskReportPaths), externalSymbolReportSnapshot(repo, knownSymbolReportPaths, knownExternalReportPaths)]);
}

function knownExternalSymbolReportPaths(freshness: FreshnessInfo | null | undefined): Set<string> {
  return new Set(Object.keys(freshness?.indexedExternalSymbolReportHashes ?? freshness?.externalSymbolReportHashes ?? {}));
}

function knownExternalRiskReportPaths(freshness: FreshnessInfo | null | undefined): Set<string> {
  return new Set(Object.keys(freshness?.indexedExternalRiskReportHashes ?? freshness?.externalRiskReportHashes ?? {}));
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
    await fs.lstat(candidate);
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
