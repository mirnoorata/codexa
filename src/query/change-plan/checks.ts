import type { ChangeType, CodexaIndex, EvidenceTier, TaskSnapshotRequiredCheck, WorkflowTraceFact } from "../../types.js";
import { uniqueSorted } from "../../util.js";

export function requiredWorkflowChecksForPlan(
  workflows: WorkflowTraceFact[],
  pathScope: Set<string>,
  changeType: ChangeType
): TaskSnapshotRequiredCheck[] {
  return workflows
    .filter((workflow) => workflow.relatedFiles.some((filePath) => pathScope.has(filePath)) || pathScope.has(workflow.entryPath))
    .sort((a, b) => b.rank - a.rank || a.title.localeCompare(b.title))
    .map((workflow) => ({
      kind: "workflow" as const,
      target: workflow.title,
      reason:
        changeType === "style"
          ? "workflow is adjacent to the planned edit; spot-check only if behavior changed"
          : `planned edit intersects ${workflow.workflowKind} workflow evidence`,
      evidenceTier: workflow.confidence === "authoritative" ? "authoritative" : workflow.confidence === "derived" ? "derived" : "heuristic",
      confidence: workflow.confidence,
      paths: uniqueSorted([workflow.entryPath, ...workflow.relatedFiles, ...workflow.tests]).slice(0, 20)
    }));
}

export function requiredDependencyChecksForPlan(index: CodexaIndex, paths: string[], changeType: ChangeType): TaskSnapshotRequiredCheck[] {
  if (paths.length === 0) {
    return [];
  }
  const pathSet = new Set(paths);
  const edgeChecks = index.graphEdges
    .filter((edge) => pathSet.has(edge.fromPath ?? "") || pathSet.has(edge.toPath ?? ""))
    .filter((edge) => ["IMPORTS", "CALLS", "REFERENCES", "TESTS", "EXTENDS", "IMPLEMENTS", "EXPORTS", "TYPE_EXPORTS"].includes(edge.edgeKind))
    .filter((edge) => !(pathSet.has(edge.fromPath ?? "") && pathSet.has(edge.toPath ?? "")))
    .sort((a, b) => b.weight - a.weight || a.edgeKind.localeCompare(b.edgeKind) || (a.fromPath ?? "").localeCompare(b.fromPath ?? "") || (a.toPath ?? "").localeCompare(b.toPath ?? ""))
    .slice(0, 10)
    .map((edge) => ({
      kind: "dependency" as const,
      target: `${edge.edgeKind}: ${edge.fromPath ?? edge.fromId} -> ${edge.toPath ?? edge.toId}`,
      reason:
        changeType === "style"
          ? "dependency edge is adjacent to the planned edit; verify if public behavior changed"
          : `planned edit has typed ${edge.edgeKind} dependency evidence`,
      evidenceTier: (edge.confidence === "authoritative" ? "authoritative" : edge.confidence === "derived" ? "derived" : "heuristic") as EvidenceTier,
      confidence: edge.confidence,
      paths: uniqueSorted([edge.fromPath, edge.toPath].filter((filePath): filePath is string => Boolean(filePath)))
    }));
  const publicFiles = index.files
    .filter((file) => pathSet.has(file.path))
    .filter((file) => file.rank >= 4 || file.riskScore >= 2)
    .sort((a, b) => b.rank - a.rank || b.riskScore - a.riskScore || a.path.localeCompare(b.path))
    .slice(0, 4)
    .map((file) => ({
      kind: "dependency" as const,
      target: `public-surface: ${file.path}`,
      reason: `planned target is ranked ${file.rank.toFixed(2)} with risk ${file.riskScore.toFixed(1)}; check callers/tests before completion`,
      evidenceTier: "derived" as const,
      confidence: "derived" as const,
      paths: uniqueSorted([
        file.path,
        ...index.graphEdges
          .filter((edge) => edge.fromPath === file.path || edge.toPath === file.path)
          .flatMap((edge) => [edge.fromPath, edge.toPath])
          .filter((filePath): filePath is string => Boolean(filePath) && filePath !== file.path)
      ]).slice(0, 12)
    }));
  return dedupeRequiredChecks([...edgeChecks, ...publicFiles]);
}

function dedupeRequiredChecks(checks: TaskSnapshotRequiredCheck[]): TaskSnapshotRequiredCheck[] {
  const seen = new Set<string>();
  const result: TaskSnapshotRequiredCheck[] = [];
  for (const check of checks) {
    const key = `${check.kind}\0${check.target}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(check);
  }
  return result;
}

export function formatRequiredChecks(checks: TaskSnapshotRequiredCheck[]): string[] {
  if (checks.length === 0) {
    return ["- none proven from current graph evidence"];
  }
  return checks.slice(0, 10).map((check) => `- ${check.target}: ${check.confidence}; ${check.reason}`);
}
