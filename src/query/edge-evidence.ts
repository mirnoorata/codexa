import type { CodexaIndex, EdgeEvidenceV1, FreshnessInfo, GraphEdgeFact } from "../types.js";

export function edgeEvidenceForGraphEdges(edges: GraphEdgeFact[], freshness?: FreshnessInfo, limit = 60): EdgeEvidenceV1[] {
  const seen = new Set<string>();
  const evidence: EdgeEvidenceV1[] = [];
  for (const edge of edges) {
    if (seen.has(edge.id)) {
      continue;
    }
    seen.add(edge.id);
    evidence.push({
      schemaVersion: 1,
      id: edge.id,
      edgeKind: edge.edgeKind,
      fromId: edge.fromId,
      toId: edge.toId,
      fromPath: edge.fromPath,
      toPath: edge.toPath,
      fromSymbolId: edge.fromSymbolId,
      toSymbolId: edge.toSymbolId,
      source: edge.source,
      confidence: edge.confidence,
      reason: edge.reason,
      range: edge.range,
      degraded: edge.source === "heuristic" || edge.confidence === "heuristic",
      stale: freshness?.stale ?? false
    });
    if (evidence.length >= limit) {
      break;
    }
  }
  return evidence;
}

export function edgeEvidenceForPaths(index: CodexaIndex, paths: string[], freshness?: FreshnessInfo, limit = 60): EdgeEvidenceV1[] {
  const pathSet = new Set(paths);
  return edgeEvidenceForGraphEdges(
    index.graphEdges.filter((edge) => (edge.fromPath && pathSet.has(edge.fromPath)) || (edge.toPath && pathSet.has(edge.toPath))),
    freshness,
    limit
  );
}
