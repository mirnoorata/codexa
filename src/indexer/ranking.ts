import { moduleNameForPath } from "../language.js";
import type { CodexaIndex, Confidence, FactSource, FileFact, GraphEdgeFact, ModuleClusterFact, PacketEvidenceProfile, RiskSignalFact, SymbolFact, WorkflowTraceFact } from "../types.js";
import { stableId, uniqueSorted } from "../util.js";
import type { OutcomeRankSignals } from "../outcome-ranking.js";

const MAX_FUNCTIONAL_CLUSTERS = 40;
const MAX_FUNCTIONAL_CLUSTER_FILES = 16;
const MAX_FUNCTIONAL_EDGE_SEEDS = 24;

export function applyRanking(index: CodexaIndex, churnByPath: Map<string, number>, outcomeSignals?: OutcomeRankSignals): CodexaIndex {
  const incomingImports = countBy(index.imports.flatMap((imp) => (imp.resolvedPath ? [imp.resolvedPath] : [])));
  // Eval-only experiment per the architecture contract: transitive centrality
  // must not change default ranking until the eval harness shows material wins.
  const transitiveCentrality = process.env.CODEXA_EXPERIMENTAL_TRANSITIVE_RANK === "1" ? transitiveImportCentrality(index) : undefined;
  const importsByPath = countBy(index.imports.map((imp) => imp.path));
  const usageByPath = countBy(index.usageSites.map((usage) => usage.path));
  const symbolsByPath = countBy(index.symbols.map((symbol) => symbol.path));
  const filesWithTestEdges = new Set(index.testEdges.flatMap((edge) => (edge.targetPath ? [edge.targetPath] : [])));
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
    const testProximity = file.test ? 0.5 : filesWithTestEdges.has(file.path) ? 1.5 : 0;
    const dirtyRisk = file.dirty ? 3 : 0;
    const riskScore = riskByPath.get(file.path) ?? 0;
    const generatedPenalty = file.generated ? -2 : 0;
    const outcomeHistory = Math.min(3, outcomeSignals?.boosts.get(file.path) ?? 0);
    const rankReasons = {
      centrality: Math.log2(centrality + 1),
      transitiveCentrality: transitiveCentrality?.get(file.path) ?? 0,
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
      importCount: importsByPath.get(file.path) ?? 0,
      riskScore,
      rank,
      rankReasons
    };
  });

  return { ...index, files: files.sort((a, b) => b.rank - a.rank || a.path.localeCompare(b.path)) };
}

export function applyModules(index: CodexaIndex): CodexaIndex {
  const byModule = new Map<string, FileFact[]>();
  for (const file of index.files) {
    const name = moduleNameForPath(file.path);
    const files = byModule.get(name) ?? [];
    files.push(file);
    byModule.set(name, files);
  }
  const fileRank = new Map(index.files.map((file) => [file.path, file.rank]));

  const pathModules = [...byModule.entries()].map(([name, files]) =>
    moduleClusterFact(index, {
      name,
      files,
      fileRank,
      clusterKind: "path",
      sourceModules: [name]
    })
  );
  const functionalModules = buildFunctionalClusters(index, fileRank);
  const modules = [...pathModules, ...functionalModules].sort(
    (a, b) => b.rank - a.rank || clusterKindPriority(a) - clusterKindPriority(b) || a.name.localeCompare(b.name)
  );

  return { ...index, modules };
}

function moduleClusterFact(
  index: CodexaIndex,
  input: {
    name: string;
    files: FileFact[];
    fileRank: Map<string, number>;
    clusterKind: NonNullable<ModuleClusterFact["clusterKind"]>;
    sourceModules?: string[];
    rankBoost?: number;
    communityScore?: number;
  }
): ModuleClusterFact {
  const files = uniqueByPath(input.files).sort((a, b) => b.rank - a.rank || a.path.localeCompare(b.path));
  const filePaths = new Set(files.map((file) => file.path));
  const topFiles = files.slice(0, 8).map((file) => file.path);
  const allSymbols = topModuleSymbols(index.symbols, filePaths, input.fileRank);
  const topSymbols = allSymbols.slice(0, 12);
  const allWorkflows = topModuleWorkflows(index.workflows, filePaths);
  const workflows = allWorkflows.slice(0, 10);
  const allTests = topModuleTests(index, filePaths, workflows);
  const tests = allTests.slice(0, 12);
  const allRisks = topModuleRisks(index.risks, filePaths);
  const risks = allRisks.slice(0, 10);
  const relatedGraphEdges = relatedEdges(index.graphEdges, filePaths);
  const crossModuleRelationCount = relatedGraphEdges.filter(
    (edge) => edge.fromPath && edge.toPath && moduleNameForPath(edge.fromPath) !== moduleNameForPath(edge.toPath)
  ).length;
  const evidenceCounts = confidenceCounts([
    ...relatedGraphEdges.map((edge) => edge.confidence),
    ...workflows.map((workflow) => workflow.confidence),
    ...risks.map((risk) => risk.confidence)
  ]);
  const sourceModules = input.sourceModules ?? uniqueSorted(files.map((file) => moduleNameForPath(file.path)));
  const rank = files.reduce((sum, file) => sum + file.rank, 0) + (input.rankBoost ?? 0);
  const topSymbolNames = topSymbols.map((symbol) => symbol.qualifiedName);
  const workflowTitles = workflows.map((workflow) => workflow.title);
  const riskLabels = risks.map((risk) => `${risk.signal} at ${risk.path}`);
  const summaryInput = {
    name: input.name,
    fileCount: files.length,
    topFiles,
    topSymbols: topSymbolNames,
    workflows: workflowTitles,
    tests,
    risks: riskLabels,
    relationCount: relatedGraphEdges.length,
    crossModuleRelationCount,
    sourceModules
  };
  return {
    id: input.clusterKind === "path" ? stableId("module", input.name) : stableId("module", input.clusterKind, input.name),
    type: "ModuleCluster",
    source: "heuristic",
    confidence: "heuristic",
    snapshotId: index.snapshot.snapshotId,
    indexedAt: index.snapshot.indexedAt,
    name: input.name,
    files: uniqueSorted(files.map((file) => file.path)),
    summary: summarizeModuleCluster(summaryInput),
    rank,
    clusterKind: input.clusterKind,
    sourceModules,
    communityScore: input.communityScore ?? communityScore({ relationCount: relatedGraphEdges.length, crossModuleRelationCount, workflowCount: workflows.length, fileCount: files.length }),
    topFiles,
    topSymbols: topSymbolNames,
    workflows: workflowTitles,
    tests,
    risks: riskLabels,
    relationCount: relatedGraphEdges.length,
    crossModuleRelationCount,
    evidenceCounts,
    evidenceProfile: moduleEvidenceProfile(index, filePaths, relatedGraphEdges, workflows, risks),
    summarySource: "deterministic",
    summaryPrompt: moduleSummaryPrompt({
      name: input.name,
      clusterKind: input.clusterKind,
      topFiles,
      topSymbols: topSymbolNames,
      workflows: workflowTitles,
      tests,
      risks: riskLabels,
      sourceModules
    }),
    truncation: {
      files: { total: files.length, returned: topFiles.length },
      symbols: { total: allSymbols.length, returned: topSymbols.length },
      workflows: { total: allWorkflows.length, returned: workflows.length },
      tests: { total: allTests.length, returned: tests.length },
      risks: { total: allRisks.length, returned: risks.length }
    }
  };
}

function buildFunctionalClusters(index: CodexaIndex, fileRank: Map<string, number>): ModuleClusterFact[] {
  const fileByPath = new Map(index.files.map((file) => [file.path, file]));
  const candidates = new Map<string, { name: string; files: FileFact[]; rankBoost: number; communityScore: number }>();

  for (const workflow of [...index.workflows].sort((a, b) => b.rank - a.rank || a.title.localeCompare(b.title)).slice(0, MAX_FUNCTIONAL_CLUSTERS)) {
    const files = workflowFunctionalFiles(workflow, fileByPath);
    if (files.length < 2) {
      continue;
    }
    const signature = clusterSignature(files);
    if (candidates.has(signature)) {
      continue;
    }
    const name = uniqueFunctionalName(candidates, functionalClusterNameFromWorkflow(workflow, files));
    candidates.set(signature, {
      name,
      files,
      rankBoost: workflow.rank,
      communityScore: communityScore({
        relationCount: 0,
        crossModuleRelationCount: sourceModuleCount(files) > 1 ? files.length - 1 : 0,
        workflowCount: 1,
        fileCount: files.length
      })
    });
  }

  for (const seed of graphNeighborhoodSeeds(index, fileByPath, fileRank).slice(0, MAX_FUNCTIONAL_EDGE_SEEDS)) {
    const signature = clusterSignature(seed.files);
    if (candidates.has(signature)) {
      continue;
    }
    const name = uniqueFunctionalName(candidates, functionalClusterNameFromFiles(seed.files));
    candidates.set(signature, {
      name,
      files: seed.files,
      rankBoost: seed.score,
      communityScore: communityScore({
        relationCount: seed.edgeCount,
        crossModuleRelationCount: sourceModuleCount(seed.files) > 1 ? seed.files.length - 1 : 0,
        workflowCount: 0,
        fileCount: seed.files.length
      })
    });
  }

  return [...candidates.values()]
    .map((candidate) =>
      moduleClusterFact(index, {
        name: candidate.name,
        files: candidate.files,
        fileRank,
        clusterKind: "functional",
        sourceModules: uniqueSorted(candidate.files.map((file) => moduleNameForPath(file.path))),
        rankBoost: candidate.rankBoost,
        communityScore: candidate.communityScore
      })
    )
    .filter((module) => module.files.length >= 2)
    .sort((a, b) => b.rank - a.rank || a.name.localeCompare(b.name))
    .slice(0, MAX_FUNCTIONAL_CLUSTERS);
}

function topModuleSymbols(symbols: SymbolFact[], filePaths: Set<string>, fileRank: Map<string, number>): SymbolFact[] {
  return symbols
    .filter((symbol) => filePaths.has(symbol.path))
    .sort(
      (a, b) =>
        symbolSummaryScore(b, fileRank) - symbolSummaryScore(a, fileRank) ||
        a.path.localeCompare(b.path) ||
        (a.range?.startLine ?? 0) - (b.range?.startLine ?? 0) ||
        a.qualifiedName.localeCompare(b.qualifiedName)
    );
}

function symbolSummaryScore(symbol: SymbolFact, fileRank: Map<string, number>): number {
  const kindBoost = ["route", "class", "function", "method", "node"].includes(symbol.kind) ? 3 : 0;
  return (fileRank.get(symbol.path) ?? 0) + (symbol.exported ? 4 : 0) + kindBoost;
}

function topModuleWorkflows(workflows: WorkflowTraceFact[], filePaths: Set<string>): WorkflowTraceFact[] {
  return workflows
    .filter((workflow) => filePaths.has(workflow.entryPath) || workflow.relatedFiles.some((filePath) => filePaths.has(filePath)))
    .sort((a, b) => b.rank - a.rank || a.title.localeCompare(b.title));
}

function topModuleTests(index: CodexaIndex, filePaths: Set<string>, workflows: WorkflowTraceFact[]): string[] {
  return uniqueSorted([
    ...workflows.flatMap((workflow) => workflow.tests),
    ...index.testEdges
      .filter((edge) => filePaths.has(edge.path) || (edge.targetPath ? filePaths.has(edge.targetPath) : false))
      .map((edge) => edge.path)
  ]);
}

function topModuleRisks(risks: RiskSignalFact[], filePaths: Set<string>): RiskSignalFact[] {
  return risks
    .filter((risk) => filePaths.has(risk.path))
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path) || (a.range?.startLine ?? 0) - (b.range?.startLine ?? 0) || a.signal.localeCompare(b.signal));
}

function relatedEdges(edges: GraphEdgeFact[], filePaths: Set<string>): GraphEdgeFact[] {
  return edges.filter((edge) => (edge.fromPath && filePaths.has(edge.fromPath)) || (edge.toPath && filePaths.has(edge.toPath)));
}

function moduleEvidenceProfile(
  index: CodexaIndex,
  filePaths: Set<string>,
  relatedGraphEdges: GraphEdgeFact[],
  workflows: WorkflowTraceFact[],
  risks: RiskSignalFact[]
): PacketEvidenceProfile {
  const symbols = index.symbols.filter((symbol) => filePaths.has(symbol.path));
  return {
    symbolSources: sourceCounts(symbols.map((symbol) => symbol.source)),
    edgeSources: sourceCounts(relatedGraphEdges.map((edge) => edge.source)),
    edgeConfidence: confidenceCounts(relatedGraphEdges.map((edge) => edge.confidence)),
    workflowConfidence: confidenceCounts(workflows.map((workflow) => workflow.confidence)),
    riskConfidence: confidenceCounts(risks.map((risk) => risk.confidence)),
    staticAnalysisSymbolCount: symbols.filter((symbol) => symbol.source === "static-analysis").length,
    lspSymbolCount: symbols.filter((symbol) => symbol.source === "lsp").length,
    deterministicSymbolCount: symbols.filter((symbol) => symbol.source !== "static-analysis" && symbol.source !== "lsp").length
  };
}

function confidenceCounts(confidences: Confidence[]): Partial<Record<Confidence, number>> {
  const counts: Partial<Record<Confidence, number>> = {};
  for (const confidence of confidences) {
    counts[confidence] = (counts[confidence] ?? 0) + 1;
  }
  return counts;
}

function sourceCounts(sources: FactSource[]): Partial<Record<FactSource, number>> {
  const counts: Partial<Record<FactSource, number>> = {};
  for (const source of sources) {
    counts[source] = (counts[source] ?? 0) + 1;
  }
  return counts;
}

function summarizeModuleCluster(input: {
  name: string;
  fileCount: number;
  topFiles: string[];
  topSymbols: string[];
  workflows: string[];
  tests: string[];
  risks: string[];
  relationCount: number;
  crossModuleRelationCount: number;
  sourceModules: string[];
}): string {
  const topFiles = input.topFiles.slice(0, 4).join(", ") || "none";
  const symbols = input.topSymbols.slice(0, 5).join(", ") || "none";
  const workflows = input.workflows.slice(0, 3).join(", ") || "none";
  const tests = input.tests.slice(0, 3).join(", ") || "none";
  const risks = input.risks.slice(0, 3).join(", ") || "none";
  const modules = input.sourceModules.slice(0, 6).join(", ") || "none";
  return `${input.name} contains ${input.fileCount} indexed file(s) across ${modules}. Read first: ${topFiles}. Top symbols: ${symbols}. Workflows: ${workflows}. Tests: ${tests}. Relations: ${input.relationCount} total, ${input.crossModuleRelationCount} cross-module. Risks: ${risks}.`;
}

function moduleSummaryPrompt(input: {
  name: string;
  clusterKind: NonNullable<ModuleClusterFact["clusterKind"]>;
  topFiles: string[];
  topSymbols: string[];
  workflows: string[];
  tests: string[];
  risks: string[];
  sourceModules: string[];
}): string {
  return [
    `Summarize ${input.clusterKind} cluster "${input.name}" for a coding agent using only cited files.`,
    `Cover responsibilities, process flow, read-first order, tests, and risky boundaries.`,
    `Files: ${input.topFiles.slice(0, 8).join(", ") || "none"}.`,
    `Modules: ${input.sourceModules.slice(0, 8).join(", ") || "none"}.`,
    `Symbols: ${input.topSymbols.slice(0, 8).join(", ") || "none"}.`,
    `Workflows: ${input.workflows.slice(0, 5).join(", ") || "none"}.`,
    `Tests: ${input.tests.slice(0, 5).join(", ") || "none"}.`,
    `Risks: ${input.risks.slice(0, 5).join(", ") || "none"}.`
  ].join(" ");
}

function workflowFunctionalFiles(workflow: WorkflowTraceFact, fileByPath: Map<string, FileFact>): FileFact[] {
  const paths = uniqueSorted([
    workflow.entryPath,
    ...workflow.relatedFiles,
    ...(workflow.terminalFiles ?? [])
  ]).filter((filePath) => {
    const file = fileByPath.get(filePath);
    return file && !file.test;
  });
  return paths
    .map((filePath) => fileByPath.get(filePath))
    .filter((file): file is FileFact => Boolean(file))
    .sort((a, b) => b.rank - a.rank || a.path.localeCompare(b.path))
    .slice(0, MAX_FUNCTIONAL_CLUSTER_FILES);
}

function graphNeighborhoodSeeds(
  index: CodexaIndex,
  fileByPath: Map<string, FileFact>,
  fileRank: Map<string, number>
): Array<{ files: FileFact[]; score: number; edgeCount: number }> {
  const neighbors = new Map<string, Map<string, number>>();
  for (const edge of index.graphEdges) {
    if (!edge.fromPath || !edge.toPath || edge.fromPath === edge.toPath || !fileByPath.has(edge.fromPath) || !fileByPath.has(edge.toPath)) {
      continue;
    }
    const weight = functionalEdgeWeight(edge);
    addNeighborWeight(neighbors, edge.fromPath, edge.toPath, weight);
    addNeighborWeight(neighbors, edge.toPath, edge.fromPath, weight);
  }
  return [...neighbors.entries()]
    .map(([seedPath, neighborWeights]) => {
      const seed = fileByPath.get(seedPath);
      if (!seed || seed.test) {
        return undefined;
      }
      const files = [
        seed,
        ...[...neighborWeights.entries()]
          .map(([filePath, weight]) => ({ file: fileByPath.get(filePath), weight }))
          .filter((entry): entry is { file: FileFact; weight: number } => entry.file !== undefined && !entry.file.test)
          .sort((a, b) => b.weight - a.weight || (fileRank.get(b.file.path) ?? 0) - (fileRank.get(a.file.path) ?? 0) || a.file.path.localeCompare(b.file.path))
          .slice(0, MAX_FUNCTIONAL_CLUSTER_FILES - 1)
          .map((entry) => entry.file)
      ];
      if (files.length < 2 || sourceModuleCount(files) < 2) {
        return undefined;
      }
      const score = files.reduce((sum, file) => sum + (fileRank.get(file.path) ?? 0), 0) + [...neighborWeights.values()].reduce((sum, value) => sum + value, 0);
      return { files: uniqueByPath(files), score, edgeCount: neighborWeights.size };
    })
    .filter((entry): entry is { files: FileFact[]; score: number; edgeCount: number } => Boolean(entry))
    .sort((a, b) => b.score - a.score || clusterSignature(a.files).localeCompare(clusterSignature(b.files)));
}

function addNeighborWeight(neighbors: Map<string, Map<string, number>>, source: string, target: string, weight: number): void {
  const weighted = neighbors.get(source) ?? new Map<string, number>();
  weighted.set(target, (weighted.get(target) ?? 0) + weight);
  neighbors.set(source, weighted);
}

function functionalEdgeWeight(edge: GraphEdgeFact): number {
  const kindWeight =
    edge.edgeKind === "ROUTE_HANDLES" || edge.edgeKind === "UI_CALLS_ENDPOINT" || edge.edgeKind === "TEST_COVERS_WORKFLOW"
      ? 5
      : edge.edgeKind === "ROUTE_CALLS_STORE" || edge.edgeKind === "STORE_DISPATCHES_ADAPTER" || edge.edgeKind === "ADAPTER_REFERENCED_BY_MANIFEST"
        ? 4
        : edge.edgeKind === "CALLS" || edge.edgeKind === "REFERENCES"
          ? 3
          : edge.edgeKind === "IMPLEMENTS" || edge.edgeKind === "EXTENDS" || edge.edgeKind === "IMPORTS"
            ? 2
            : 1;
  const confidenceWeight = edge.confidence === "authoritative" ? 1.5 : edge.confidence === "derived" ? 1.2 : 1;
  return kindWeight * confidenceWeight * Math.max(1, edge.weight);
}

function functionalClusterNameFromWorkflow(workflow: WorkflowTraceFact, files: FileFact[]): string {
  const title = workflow.title.replace(/^route\s+/iu, "").replace(/^job\s+/iu, "");
  return `functional/${slugName(title) || slugName(files[0]?.path ?? "") || "workflow"}`;
}

function functionalClusterNameFromFiles(files: FileFact[]): string {
  const modules = uniqueSorted(files.map((file) => moduleNameForPath(file.path)));
  return `functional/${slugName(modules.slice(0, 2).join("-")) || "graph-neighborhood"}`;
}

function uniqueFunctionalName(candidates: Map<string, { name: string }>, baseName: string): string {
  const names = new Set([...candidates.values()].map((candidate) => candidate.name));
  if (!names.has(baseName)) {
    return baseName;
  }
  for (let index = 2; index < 100; index += 1) {
    const candidate = `${baseName}-${index}`;
    if (!names.has(candidate)) {
      return candidate;
    }
  }
  return `${baseName}-${stableId("functional-name", baseName).slice(0, 8)}`;
}

function slugName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9._/-]+/gu, "-").replace(/\/+/gu, "/").replace(/^-+|-+$/gu, "").slice(0, 80);
}

function clusterSignature(files: FileFact[]): string {
  return uniqueSorted(files.map((file) => file.path)).join("\0");
}

function uniqueByPath(files: FileFact[]): FileFact[] {
  const byPath = new Map<string, FileFact>();
  for (const file of files) {
    byPath.set(file.path, file);
  }
  return [...byPath.values()];
}

function sourceModuleCount(files: FileFact[]): number {
  return new Set(files.map((file) => moduleNameForPath(file.path))).size;
}

function communityScore(input: { relationCount: number; crossModuleRelationCount: number; workflowCount: number; fileCount: number }): number {
  return input.relationCount + input.crossModuleRelationCount * 2 + input.workflowCount * 8 + input.fileCount;
}

function clusterKindPriority(module: ModuleClusterFact): number {
  return module.clusterKind === "path" ? 0 : 1;
}

const TRANSITIVE_RANK_DAMPING = 0.85;
const TRANSITIVE_RANK_ITERATIONS = 4;
const TRANSITIVE_RANK_WEIGHT = 2;

/**
 * Damped power iteration over the resolved import graph (PageRank-style).
 * One-hop in-degree misses deep API consumers; this propagates importance
 * from importers to importees so widely-depended-on leaves rank above
 * incidental hubs. Deterministic, bounded iterations, normalized so the
 * average file contributes 0 and the strongest hubs contribute up to
 * TRANSITIVE_RANK_WEIGHT to the composite rank.
 */
function transitiveImportCentrality(index: CodexaIndex): Map<string, number> {
  const fileCount = index.files.length;
  if (fileCount === 0) {
    return new Map();
  }
  const outEdges = new Map<string, string[]>();
  const filePaths = new Set(index.files.map((file) => file.path));
  for (const imp of index.imports) {
    if (!imp.resolvedPath || !filePaths.has(imp.resolvedPath) || !filePaths.has(imp.path)) {
      continue;
    }
    const targets = outEdges.get(imp.path) ?? [];
    targets.push(imp.resolvedPath);
    outEdges.set(imp.path, targets);
  }
  let scores = new Map<string, number>([...filePaths].map((path) => [path, 1 / fileCount]));
  for (let iteration = 0; iteration < TRANSITIVE_RANK_ITERATIONS; iteration += 1) {
    const next = new Map<string, number>([...filePaths].map((path) => [path, (1 - TRANSITIVE_RANK_DAMPING) / fileCount]));
    for (const [source, targets] of outEdges) {
      const share = (TRANSITIVE_RANK_DAMPING * (scores.get(source) ?? 0)) / targets.length;
      for (const target of targets) {
        next.set(target, (next.get(target) ?? 0) + share);
      }
    }
    scores = next;
  }
  // score * fileCount == 1 for a file of exactly average importance, so the
  // -1 shift makes the average file contribute 0 and below-average files clamp
  // to 0 instead of every file receiving a flat boost.
  const normalized = new Map<string, number>();
  for (const [path, score] of scores) {
    normalized.set(path, Math.min(TRANSITIVE_RANK_WEIGHT, Math.max(0, Math.log2(score * fileCount + 1) - 1)));
  }
  return normalized;
}

function countBy(values: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return counts;
}
