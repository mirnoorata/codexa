import { moduleNameForPath } from "../language.js";
import type { CodexaIndex, Confidence, FileFact, ModuleClusterFact, RiskSignalFact, SymbolFact, WorkflowTraceFact } from "../types.js";
import { stableId, uniqueSorted } from "../util.js";
import type { OutcomeRankSignals } from "../outcome-ranking.js";

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

  const modules: ModuleClusterFact[] = [...byModule.entries()]
    .map(([name, files]) => {
      const filePaths = new Set(files.map((file) => file.path));
      const rank = files.reduce((sum, file) => sum + file.rank, 0);
      const topFiles = [...files].sort((a, b) => b.rank - a.rank || a.path.localeCompare(b.path)).slice(0, 8).map((file) => file.path);
      const topSymbols = topModuleSymbols(index.symbols, filePaths, fileRank).slice(0, 12);
      const workflows = topModuleWorkflows(index.workflows, filePaths).slice(0, 10);
      const tests = topModuleTests(index, filePaths, workflows).slice(0, 12);
      const risks = topModuleRisks(index.risks, filePaths).slice(0, 10);
      const relatedGraphEdges = index.graphEdges.filter((edge) => (edge.fromPath && filePaths.has(edge.fromPath)) || (edge.toPath && filePaths.has(edge.toPath)));
      const crossModuleRelationCount = relatedGraphEdges.filter(
        (edge) => edge.fromPath && edge.toPath && moduleNameForPath(edge.fromPath) !== moduleNameForPath(edge.toPath)
      ).length;
      const evidenceCounts = confidenceCounts([
        ...relatedGraphEdges.map((edge) => edge.confidence),
        ...workflows.map((workflow) => workflow.confidence),
        ...risks.map((risk) => risk.confidence)
      ]);
      return {
        id: stableId("module", name),
        type: "ModuleCluster" as const,
        source: "heuristic" as const,
        confidence: "heuristic" as const,
        snapshotId: index.snapshot.snapshotId,
        indexedAt: index.snapshot.indexedAt,
        name,
        files: uniqueSorted(files.map((file) => file.path)),
        summary: summarizeModuleCluster({
          name,
          fileCount: files.length,
          topFiles,
          topSymbols: topSymbols.map((symbol) => symbol.qualifiedName),
          workflows: workflows.map((workflow) => workflow.title),
          tests,
          risks: risks.map((risk) => `${risk.signal} at ${risk.path}`),
          relationCount: relatedGraphEdges.length,
          crossModuleRelationCount
        }),
        rank,
        clusterKind: "path" as const,
        topFiles,
        topSymbols: topSymbols.map((symbol) => symbol.qualifiedName),
        workflows: workflows.map((workflow) => workflow.title),
        tests,
        risks: risks.map((risk) => `${risk.signal} at ${risk.path}`),
        relationCount: relatedGraphEdges.length,
        crossModuleRelationCount,
        evidenceCounts,
        truncation: {
          files: { total: files.length, returned: topFiles.length },
          symbols: { total: topModuleSymbols(index.symbols, filePaths, fileRank).length, returned: topSymbols.length },
          workflows: { total: topModuleWorkflows(index.workflows, filePaths).length, returned: workflows.length },
          tests: { total: topModuleTests(index, filePaths, workflows).length, returned: tests.length },
          risks: { total: topModuleRisks(index.risks, filePaths).length, returned: risks.length }
        }
      };
    })
    .sort((a, b) => b.rank - a.rank || a.name.localeCompare(b.name));

  return { ...index, modules };
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

function confidenceCounts(confidences: Confidence[]): Partial<Record<Confidence, number>> {
  const counts: Partial<Record<Confidence, number>> = {};
  for (const confidence of confidences) {
    counts[confidence] = (counts[confidence] ?? 0) + 1;
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
}): string {
  const topFiles = input.topFiles.slice(0, 4).join(", ") || "none";
  const symbols = input.topSymbols.slice(0, 5).join(", ") || "none";
  const workflows = input.workflows.slice(0, 3).join(", ") || "none";
  const tests = input.tests.slice(0, 3).join(", ") || "none";
  const risks = input.risks.slice(0, 3).join(", ") || "none";
  return `${input.name} contains ${input.fileCount} indexed file(s). Read first: ${topFiles}. Top symbols: ${symbols}. Workflows: ${workflows}. Tests: ${tests}. Relations: ${input.relationCount} total, ${input.crossModuleRelationCount} cross-module. Risks: ${risks}.`;
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
