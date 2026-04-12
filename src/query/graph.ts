import { isTestPath } from "../language.js";
import type { GraphEdgeFact, GraphEdgeKind, WorkflowTraceFact } from "../types.js";
import { uniqueSorted } from "../util.js";

export function recommendNextCodexaCall(
  intents: string[],
  workflows: WorkflowTraceFact[],
  changedFileCount: number,
  task: string
): { tool: string; reason: string; arguments?: Record<string, unknown> } {
  const lowerTask = task.toLowerCase();
  if (/\b(callers?|importers?)\b/.test(lowerTask)) {
    return { tool: "callers", reason: "the task asks who uses a symbol or file" };
  }
  if (/\b(callees?|dependencies|uses)\b/.test(lowerTask)) {
    return { tool: "callees", reason: "the task asks what a symbol or file depends on" };
  }
  if (/\b(path|between|connects?)\b/.test(lowerTask) && /\b(dependency|workflow|call)\b/.test(lowerTask)) {
    return { tool: "dependency_path", reason: "the task asks for a path between code elements" };
  }
  if (intents.includes("workflow") && workflows.length > 0) {
    return { tool: "workflow_path", reason: "the task maps to route/job/process flow evidence", arguments: { query: task } };
  }
  if (changedFileCount > 0 && intents.includes("testing")) {
    return { tool: "test_plan", reason: "there are current changes and the task asks for verification", arguments: { diff: true } };
  }
  if (changedFileCount > 0) {
    return { tool: "task_brief", reason: "there is a dirty tree; use task_brief to keep the read-first set target-led", arguments: { task, diff: true } };
  }
  return { tool: "task_brief", reason: "default Codexa first call before code edits", arguments: { task, diff: false } };
}

export function formatWorkflowSummary(workflow: WorkflowTraceFact): string {
  return `- ${workflow.title}: ${workflow.workflowKind}, rank ${workflow.rank.toFixed(2)}, ${workflow.confidence}; ${workflow.summary}`;
}

export function isImpactGraphEdge(kind: GraphEdgeKind): boolean {
  return [
    "CALLS",
    "REFERENCES",
    "IMPORTS",
    "TESTS",
    "ROUTE_HANDLES",
    "ROUTE_CALLS_STORE",
    "STORE_DISPATCHES_ADAPTER",
    "ADAPTER_REFERENCED_BY_MANIFEST",
    "UI_CALLS_ENDPOINT",
    "TEST_COVERS_WORKFLOW",
    "IMPLEMENTS",
    "EXTENDS"
  ].includes(kind);
}

export function graphEdgeSort(a: GraphEdgeFact, b: GraphEdgeFact): number {
  return (
    graphEdgeKindScore(a.edgeKind) - graphEdgeKindScore(b.edgeKind) ||
    confidenceScore(a.confidence) - confidenceScore(b.confidence) ||
    b.weight - a.weight ||
    (a.fromPath ?? "").localeCompare(b.fromPath ?? "") ||
    (a.toPath ?? "").localeCompare(b.toPath ?? "")
  );
}

export function formatGraphEdge(edge: GraphEdgeFact): string {
  const from = edge.fromSymbolId ? edge.fromSymbolId : edge.fromPath ?? edge.fromId;
  const to = edge.toSymbolId ? edge.toSymbolId : edge.toPath ?? edge.toId;
  const location = edge.range?.startLine ? ` at ${edge.fromPath ?? edge.path}:${edge.range.startLine}` : "";
  return `- ${edge.edgeKind}: ${from} -> ${to}; ${edge.confidence}; ${edge.reason}${location}`;
}

export function affectedWorkflowGraphEdges(index: { graphEdges: GraphEdgeFact[] }, paths: string[]): GraphEdgeFact[] {
  const pathSet = new Set(paths);
  return index.graphEdges
    .filter((edge) => pathSet.has(edge.fromPath ?? "") || pathSet.has(edge.toPath ?? ""))
    .filter((edge) => isImpactGraphEdge(edge.edgeKind) || edge.edgeKind === "ROUTE" || edge.edgeKind === "JOB")
    .sort(graphEdgeSort);
}

export function testsFromGraphEdges(edges: GraphEdgeFact[]): string[] {
  return uniqueSorted(
    edges
      .flatMap((edge) => [edge.fromPath, edge.toPath])
      .filter((filePath): filePath is string => Boolean(filePath))
      .filter((filePath) => isTestPath(filePath))
  );
}

function graphEdgeKindScore(kind: GraphEdgeKind): number {
  const order: Record<GraphEdgeKind, number> = {
    DEFINES: 0,
    ROUTE: 1,
    JOB: 1,
    ROUTE_HANDLES: 1,
    UI_CALLS_ENDPOINT: 2,
    TEST_COVERS_WORKFLOW: 2,
    ROUTE_CALLS_STORE: 3,
    STORE_DISPATCHES_ADAPTER: 3,
    ADAPTER_REFERENCED_BY_MANIFEST: 3,
    CALLS: 4,
    REFERENCES: 5,
    IMPORTS: 6,
    TESTS: 7,
    EXTENDS: 8,
    IMPLEMENTS: 8,
    EXPORTS: 9,
    TYPE_EXPORTS: 9,
    RISK: 10
  };
  return order[kind];
}

function confidenceScore(confidence: GraphEdgeFact["confidence"]): number {
  if (confidence === "authoritative") {
    return 0;
  }
  if (confidence === "derived") {
    return 1;
  }
  return 2;
}
