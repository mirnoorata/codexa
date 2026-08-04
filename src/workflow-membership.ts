import type { CodexaIndex, WorkflowTraceFact } from "./types.js";
import { isTestPath } from "./language.js";

type WorkflowMembershipIndex = Pick<CodexaIndex, "testEdges" | "workflowMembershipSpill">;

const testTargetsByPathCache = new WeakMap<
  CodexaIndex["testEdges"],
  ReadonlyMap<string, readonly string[]>
>();
const structuralPathsCache = new WeakMap<WorkflowTraceFact, ReadonlySet<string>>();
const membershipSpillSetCache = new WeakMap<string[], ReadonlySet<string>>();

export function workflowMatchesAnyPath(
  workflow: WorkflowTraceFact,
  paths: ReadonlySet<string>,
  index: WorkflowMembershipIndex
): boolean {
  if (
    paths.has(workflow.entryPath) ||
    workflow.relatedFiles.some((filePath) => paths.has(filePath)) ||
    workflow.tests.some((filePath) => paths.has(filePath)) ||
    workflow.steps.some((step) => paths.has(step.path) || Boolean(step.targetPath && paths.has(step.targetPath)))
  ) {
    return true;
  }
  const membershipSpill = workflowMembershipSpill(workflow, index);
  if (membershipSpill) {
    for (const filePath of paths) {
      if (membershipSpill.has(filePath)) return true;
    }
    return false;
  }
  for (const filePath of paths) {
    if (workflowIncludesRelatedTestPath(workflow, filePath, index)) return true;
  }
  return false;
}

export function workflowIncludesPath(
  workflow: WorkflowTraceFact,
  filePath: string,
  index: WorkflowMembershipIndex
): boolean {
  if (workflowRetainsPath(workflow, filePath)) return true;
  const membershipSpill = workflowMembershipSpill(workflow, index);
  return membershipSpill ? membershipSpill.has(filePath) : workflowIncludesRelatedTestPath(workflow, filePath, index);
}

export function retainedWorkflowPaths(workflow: WorkflowTraceFact): string[] {
  const paths = new Set<string>([workflow.entryPath, ...workflow.relatedFiles, ...workflow.tests]);
  for (const step of workflow.steps) {
    paths.add(step.path);
    if (step.targetPath) paths.add(step.targetPath);
  }
  return [...paths].sort((left, right) => left.localeCompare(right));
}

export function scopedWorkflowPaths(
  workflow: WorkflowTraceFact,
  paths: ReadonlySet<string>,
  index: WorkflowMembershipIndex
): string[] {
  return [...paths]
    .filter((filePath) => workflowIncludesPath(workflow, filePath, index))
    .sort((left, right) => left.localeCompare(right));
}

function workflowIncludesRelatedTestPath(
  workflow: WorkflowTraceFact,
  testPath: string,
  index: WorkflowMembershipIndex
): boolean {
  if (!isTestPath(testPath)) return false;
  const targets = testTargetsByPath(index).get(testPath);
  if (!targets) return false;
  for (const targetPath of targets) {
    if (!isTestPath(targetPath) && structuralWorkflowPaths(workflow).has(targetPath)) return true;
  }
  return false;
}

function workflowMembershipSpill(
  workflow: WorkflowTraceFact,
  index: WorkflowMembershipIndex
): ReadonlySet<string> | undefined {
  const spill = index.workflowMembershipSpill;
  if (!spill || !Object.prototype.hasOwnProperty.call(spill, workflow.id)) return undefined;
  const paths = spill[workflow.id];
  if (!paths) return undefined;
  const cached = membershipSpillSetCache.get(paths);
  if (cached) return cached;
  const pathSet = new Set(paths);
  membershipSpillSetCache.set(paths, pathSet);
  return pathSet;
}

function workflowRetainsPath(workflow: WorkflowTraceFact, filePath: string): boolean {
  return (
    workflow.entryPath === filePath ||
    workflow.relatedFiles.includes(filePath) ||
    workflow.tests.includes(filePath) ||
    workflow.steps.some((step) => step.path === filePath || step.targetPath === filePath)
  );
}

function testTargetsByPath(index: WorkflowMembershipIndex): ReadonlyMap<string, readonly string[]> {
  const cached = testTargetsByPathCache.get(index.testEdges);
  if (cached) return cached;
  // Workflow arrays are bounded projections, while test edges retain the
  // complete indexed test-to-target relation. Keep that relation internal so
  // authority checks survive payload caps without widening serialized output.
  const stagedTargets = new Map<string, Set<string>>();
  for (const edge of index.testEdges) {
    if (!edge.targetPath || !isTestPath(edge.path) || isTestPath(edge.targetPath)) continue;
    const entries = stagedTargets.get(edge.path) ?? new Set<string>();
    entries.add(edge.targetPath);
    stagedTargets.set(edge.path, entries);
  }
  const targets = new Map<string, readonly string[]>();
  for (const [testPath, targetPaths] of stagedTargets) targets.set(testPath, [...targetPaths]);
  testTargetsByPathCache.set(index.testEdges, targets);
  return targets;
}

function structuralWorkflowPaths(workflow: WorkflowTraceFact): ReadonlySet<string> {
  const cached = structuralPathsCache.get(workflow);
  if (cached) return cached;
  const paths = new Set<string>();
  if (!isTestPath(workflow.entryPath)) paths.add(workflow.entryPath);
  for (const step of workflow.steps) {
    if (step.kind !== "test" && !isTestPath(step.path)) paths.add(step.path);
    if (step.targetPath && !isTestPath(step.targetPath)) paths.add(step.targetPath);
  }
  structuralPathsCache.set(workflow, paths);
  return paths;
}
