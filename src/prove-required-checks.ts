import { affectedWorkflowGraphEdges, testsFromGraphEdges } from "./query/graph.js";
import type { CodexaIndex, TaskSnapshot, TestRecommendation, VerificationCoverage } from "./types.js";
import { uniqueSorted } from "./util.js";

export function proofRequiredCheckContext(input: {
  index: CodexaIndex;
  snapshot?: TaskSnapshot;
  tests: TestRecommendation[];
  ranTests: string[];
  verificationCoverage: VerificationCoverage[];
  reconstruct: boolean;
}) {
  const editPaths = input.snapshot?.plannedEditTargets ?? [];
  const reviewTargets = input.snapshot?.plannedFiles ?? editPaths;
  if (!input.reconstruct) {
    return {
      editPaths,
      reviewTargets,
      selectedFiles: [],
      workflows: [],
      affectedEdges: [],
      affectedTests: [],
      tests: input.tests,
      ranTests: input.ranTests,
      verificationCoverage: input.verificationCoverage
    };
  }
  const reviewTargetSet = new Set(reviewTargets);
  const affectedEdges = affectedWorkflowGraphEdges(input.index, reviewTargets);
  const affectedTests = uniqueSorted([
    ...testsFromGraphEdges(affectedEdges),
    ...input.index.testEdges
      .filter((edge) => edge.targetPath && reviewTargetSet.has(edge.targetPath))
      .map((edge) => edge.path)
  ]);
  const workflows = input.index.workflows
    .filter((workflow) => workflow.relatedFiles.some((filePath) => reviewTargetSet.has(filePath)) || reviewTargetSet.has(workflow.entryPath))
    .sort((a, b) => b.rank - a.rank || a.title.localeCompare(b.title));
  return {
    editPaths,
    reviewTargets,
    selectedFiles: reviewTargets,
    workflows,
    affectedEdges,
    affectedTests,
    tests: input.tests,
    ranTests: input.ranTests,
    verificationCoverage: input.verificationCoverage
  };
}
