import { buildGraphEdges, extractWorkflowTraceData } from "../graph.js";
import type { CodexaIndex, GraphEdgeFact } from "../types.js";

export function applyGraphStages(index: CodexaIndex, externalGraphEdges: GraphEdgeFact[]): CodexaIndex {
  const withGraph = { ...index, graphEdges: dedupeGraphEdges([...buildGraphEdges(index), ...externalGraphEdges]) };
  const extracted = extractWorkflowTraceData(withGraph);
  return { ...withGraph, workflows: extracted.workflows, workflowMembershipSpill: extracted.workflowMembershipSpill };
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
