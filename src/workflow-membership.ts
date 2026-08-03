import type { WorkflowTraceFact } from "./types.js";

export function workflowMatchesAnyPath(workflow: WorkflowTraceFact, paths: ReadonlySet<string>): boolean {
  return (
    paths.has(workflow.entryPath) ||
    workflow.relatedFiles.some((filePath) => paths.has(filePath)) ||
    workflow.tests.some((filePath) => paths.has(filePath)) ||
    workflow.steps.some((step) => paths.has(step.path) || Boolean(step.targetPath && paths.has(step.targetPath)))
  );
}

export function workflowIncludesPath(workflow: WorkflowTraceFact, filePath: string): boolean {
  return (
    workflow.entryPath === filePath ||
    workflow.relatedFiles.includes(filePath) ||
    workflow.tests.includes(filePath) ||
    workflow.steps.some((step) => step.path === filePath || step.targetPath === filePath)
  );
}

export function retainedWorkflowPaths(workflow: WorkflowTraceFact): string[] {
  const paths = new Set<string>([workflow.entryPath, ...workflow.relatedFiles, ...workflow.tests]);
  for (const step of workflow.steps) {
    paths.add(step.path);
    if (step.targetPath) paths.add(step.targetPath);
  }
  return [...paths].sort((left, right) => left.localeCompare(right));
}
