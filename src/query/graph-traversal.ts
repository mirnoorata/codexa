import { isTestPath } from "../language.js";
import type { CodexaIndex, GraphEdgeFact, GraphEdgeKind, QueryOptions, QueryResult, WorkflowTraceFact } from "../types.js";
import { limitText, uniqueSorted } from "../util.js";
import { formatGaps, indexGaps } from "./diff.js";
import { confidenceTier } from "./formatting.js";
import { formatGraphEdge, graphEdgeSort } from "./graph.js";
import { assessContextQuality, formatContextQuality, type ContextQuality } from "./quality.js";
import { freshnessBanner } from "./runtime.js";
import { ensureQuerySession, type QuerySessionInput } from "./session.js";
import { graphNodeIdsForTarget, resolveGraphTarget } from "./targets.js";

export async function callersQuery(input: QuerySessionInput, graphInput: { file?: string; symbol?: string; limit?: number }, options: QueryOptions = {}): Promise<QueryResult> {
  const session = await ensureQuerySession(input, options);
  const { index, freshness, refresh, repoRoot } = session;
  const target = resolveGraphTarget(index, repoRoot, graphInput);
  if ("result" in target) {
    return { ...target.result, freshness, refresh };
  }
  const limit = Math.max(1, Math.min(graphInput.limit ?? 20, session.maxResults));
  const targetIds = graphNodeIdsForTarget(index, target);
  const incoming = index.graphEdges
    .filter((edge) => targetIds.has(edge.toId) || (edge.toSymbolId && targetIds.has(edge.toSymbolId)) || (edge.toPath && target.paths.has(edge.toPath)))
    .filter((edge) => isCallerGraphEdge(edge.edgeKind))
    .sort(graphEdgeSort)
    .slice(0, limit);
  const files = uniqueSorted(incoming.flatMap((edge) => [edge.fromPath].filter((value): value is string => Boolean(value))));
  const quality = assessContextQuality({
    freshness,
    gaps: indexGaps(index, freshness),
    tiers: edgeTierCounts(incoming),
    selectedCount: files.length,
    testCount: files.filter(isTestPath).length
  });
  const text = [
    freshnessBanner(freshness, refresh),
    formatContextQuality(quality),
    `Callers/importers for ${target.label}:`,
    ...incoming.map(formatGraphEdge),
    "",
    "Caller files:",
    ...(files.length > 0 ? files.map((file) => `- ${file}`) : ["- none"])
  ].join("\n");
  return { freshness, refresh, text: limitText(text, 6000), data: { target, edges: incoming, files, quality } };
}

export async function calleesQuery(input: QuerySessionInput, graphInput: { file?: string; symbol?: string; limit?: number }, options: QueryOptions = {}): Promise<QueryResult> {
  const session = await ensureQuerySession(input, options);
  const { index, freshness, refresh, repoRoot } = session;
  const target = resolveGraphTarget(index, repoRoot, graphInput);
  if ("result" in target) {
    return { ...target.result, freshness, refresh };
  }
  const limit = Math.max(1, Math.min(graphInput.limit ?? 20, session.maxResults));
  const targetIds = graphNodeIdsForTarget(index, target);
  const outgoing = index.graphEdges
    .filter((edge) => targetIds.has(edge.fromId) || (edge.fromSymbolId && targetIds.has(edge.fromSymbolId)) || (edge.fromPath && target.paths.has(edge.fromPath)))
    .filter((edge) => isCalleeGraphEdge(edge.edgeKind))
    .sort(graphEdgeSort)
    .slice(0, limit);
  const files = uniqueSorted(outgoing.flatMap((edge) => [edge.toPath].filter((value): value is string => Boolean(value))));
  const quality = assessContextQuality({
    freshness,
    gaps: indexGaps(index, freshness),
    tiers: edgeTierCounts(outgoing),
    selectedCount: files.length,
    testCount: files.filter(isTestPath).length
  });
  const text = [
    freshnessBanner(freshness, refresh),
    formatContextQuality(quality),
    `Callees/dependencies for ${target.label}:`,
    ...outgoing.map(formatGraphEdge),
    "",
    "Dependency files:",
    ...(files.length > 0 ? files.map((file) => `- ${file}`) : ["- none"])
  ].join("\n");
  return { freshness, refresh, text: limitText(text, 6000), data: { target, edges: outgoing, files, quality } };
}

export async function dependencyPathQuery(
  input: QuerySessionInput,
  graphInput: { fromFile?: string; fromSymbol?: string; toFile?: string; toSymbol?: string; maxDepth?: number },
  options: QueryOptions = {}
): Promise<QueryResult> {
  const session = await ensureQuerySession(input, options);
  const { index, freshness, refresh, repoRoot } = session;
  const from = resolveGraphTarget(index, repoRoot, { file: graphInput.fromFile, symbol: graphInput.fromSymbol });
  if ("result" in from) {
    return { ...from.result, freshness, refresh };
  }
  const to = resolveGraphTarget(index, repoRoot, { file: graphInput.toFile, symbol: graphInput.toSymbol });
  if ("result" in to) {
    return { ...to.result, freshness, refresh };
  }
  const pathEdges = shortestDependencyPath(index, graphNodeIdsForTarget(index, from), graphNodeIdsForTarget(index, to), Math.max(1, Math.min(graphInput.maxDepth ?? 6, 10)));
  const files = uniqueSorted(pathEdges.flatMap((edge) => [edge.fromPath, edge.toPath].filter((value): value is string => Boolean(value))));
  const quality = assessContextQuality({
    freshness,
    gaps: indexGaps(index, freshness),
    tiers: edgeTierCounts(pathEdges),
    selectedCount: pathEdges.length,
    testCount: files.filter(isTestPath).length
  });
  const text = [
    freshnessBanner(freshness, refresh),
    formatContextQuality(quality),
    `Dependency path: ${from.label} -> ${to.label}`,
    ...(pathEdges.length > 0 ? pathEdges.map(formatGraphEdge) : ["- no dependency path found within depth budget"]),
    "",
    "Files on path:",
    ...(files.length > 0 ? files.map((file) => `- ${file}`) : ["- none"])
  ].join("\n");
  return { freshness, refresh, text: limitText(text, 6000), data: { from, to, path: pathEdges, files, quality } };
}

export function edgeTierCounts(edges: GraphEdgeFact[]): ContextQuality["counts"] {
  const counts: ContextQuality["counts"] = { authoritative: 0, derived: 0, heuristic: 0, fallback: 0 };
  for (const edge of edges) {
    counts[confidenceTier(edge.confidence)] += 1;
  }
  return counts;
}

export function workflowTierCounts(workflows: WorkflowTraceFact[]): ContextQuality["counts"] {
  const counts: ContextQuality["counts"] = { authoritative: 0, derived: 0, heuristic: 0, fallback: 0 };
  for (const workflow of workflows) {
    counts[confidenceTier(workflow.confidence)] += 1;
  }
  return counts;
}

function isCallerGraphEdge(kind: GraphEdgeKind): boolean {
  return [
    "CALLS",
    "REFERENCES",
    "IMPORTS",
    "TESTS",
    "UI_CALLS_ENDPOINT",
    "TEST_COVERS_WORKFLOW",
    "IMPLEMENTS",
    "EXTENDS",
    "ADAPTER_REFERENCED_BY_MANIFEST"
  ].includes(kind);
}

function isCalleeGraphEdge(kind: GraphEdgeKind): boolean {
  return [
    "CALLS",
    "REFERENCES",
    "IMPORTS",
    "TESTS",
    "ROUTE",
    "JOB",
    "RISK",
    "ROUTE_HANDLES",
    "ROUTE_CALLS_STORE",
    "STORE_DISPATCHES_ADAPTER",
    "ADAPTER_REFERENCED_BY_MANIFEST",
    "UI_CALLS_ENDPOINT",
    "TEST_COVERS_WORKFLOW",
    "IMPLEMENTS",
    "EXTENDS",
    "EXPORTS",
    "TYPE_EXPORTS"
  ].includes(kind);
}

function shortestDependencyPath(index: CodexaIndex, startIds: Set<string>, endIds: Set<string>, maxDepth: number): GraphEdgeFact[] {
  const allowed = new Set<GraphEdgeKind>([
    "DEFINES",
    "IMPORTS",
    "CALLS",
    "REFERENCES",
    "TESTS",
    "ROUTE",
    "JOB",
    "ROUTE_HANDLES",
    "ROUTE_CALLS_STORE",
    "STORE_DISPATCHES_ADAPTER",
    "ADAPTER_REFERENCED_BY_MANIFEST",
    "UI_CALLS_ENDPOINT",
    "TEST_COVERS_WORKFLOW",
    "IMPLEMENTS",
    "EXTENDS",
    "EXPORTS",
    "TYPE_EXPORTS"
  ]);
  const adjacency = new Map<string, GraphEdgeFact[]>();
  for (const edge of index.graphEdges.filter((candidate) => allowed.has(candidate.edgeKind))) {
    const outgoing = adjacency.get(edge.fromId) ?? [];
    outgoing.push(edge);
    adjacency.set(edge.fromId, outgoing);
    if (edge.toSymbolId && edge.toSymbolId !== edge.toId) {
      const directToSymbol = { ...edge, toId: edge.toSymbolId };
      const directOutgoing = adjacency.get(directToSymbol.fromId) ?? [];
      directOutgoing.push(directToSymbol);
      adjacency.set(directToSymbol.fromId, directOutgoing);
    }
    if (edge.edgeKind === "DEFINES" || edge.edgeKind === "IMPORTS" || edge.edgeKind === "ROUTE_HANDLES") {
      const reverse = { ...edge, fromId: edge.toId, toId: edge.fromId, fromPath: edge.toPath, toPath: edge.fromPath, fromSymbolId: edge.toSymbolId, toSymbolId: edge.fromSymbolId };
      const reverseOutgoing = adjacency.get(reverse.fromId) ?? [];
      reverseOutgoing.push(reverse);
      adjacency.set(reverse.fromId, reverseOutgoing);
    }
  }
  const queue: Array<{ id: string; path: GraphEdgeFact[]; depth: number }> = [...startIds].map((id) => ({ id, path: [], depth: 0 }));
  const seen = new Set([...startIds]);
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const current = queue[cursor];
    if (endIds.has(current.id)) {
      return current.path;
    }
    if (current.depth >= maxDepth) {
      continue;
    }
    const edges = (adjacency.get(current.id) ?? []).sort(graphEdgeSort);
    for (const edge of edges) {
      if (seen.has(edge.toId)) {
        continue;
      }
      seen.add(edge.toId);
      queue.push({ id: edge.toId, path: [...current.path, edge], depth: current.depth + 1 });
    }
  }
  return [];
}
