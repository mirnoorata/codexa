import { moduleNameForPath } from "../language.js";
import type { CodexaIndex, FileFact, ModuleClusterFact } from "../types.js";
import { stableId, uniqueSorted } from "../util.js";
import type { OutcomeRankSignals } from "../outcome-ranking.js";

export function applyRanking(index: CodexaIndex, churnByPath: Map<string, number>, outcomeSignals?: OutcomeRankSignals): CodexaIndex {
  const incomingImports = countBy(index.imports.flatMap((imp) => (imp.resolvedPath ? [imp.resolvedPath] : [])));
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

function countBy(values: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return counts;
}
