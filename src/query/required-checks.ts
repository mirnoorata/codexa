import { isTestPath } from "../language.js";
import type { PostEditCheckResult } from "../post-edit-outcomes.js";
import type { GraphEdgeFact, TaskSnapshotRequiredCheck, TestRecommendation, VerificationCoverage, VerificationTrustTier, WorkflowTraceFact } from "../types.js";
import { strongestVerificationTrustTier } from "./verification/trust.js";
import { verificationTestRunnerCoversPath } from "./verification/test-runner.js";

export function evaluateRequiredChecks(
  checks: TaskSnapshotRequiredCheck[],
  input: {
    editPaths: string[];
    reviewTargets: string[];
    selectedFiles: string[];
    workflows: WorkflowTraceFact[];
    affectedEdges: GraphEdgeFact[];
    affectedTests: string[];
    tests: TestRecommendation[];
    ranTests: string[];
    verificationCoverage: VerificationCoverage[];
  }
): PostEditCheckResult[] {
  if (checks.length === 0) {
    return [];
  }
  const editSet = new Set(input.editPaths);
  const reviewSet = new Set(input.reviewTargets);
  const selectedSet = new Set(input.selectedFiles);
  const affectedTestSet = new Set(input.affectedTests);
  const workflowTitles = new Set(input.workflows.map((workflow) => workflow.title));
  const edgePaths = new Set(input.affectedEdges.flatMap((edge) => [edge.fromPath, edge.toPath]).filter((filePath): filePath is string => Boolean(filePath)));
  return checks.map((check) => {
    const relevant = input.editPaths.length === 0 || check.paths.some((filePath) => editSet.has(filePath) || reviewSet.has(filePath));
    const evidencePaths = check.paths.filter((filePath) => !editSet.has(filePath));
    const hasNonEditedEvidence = evidencePaths.some((filePath) => edgePaths.has(filePath) || selectedSet.has(filePath) || affectedTestSet.has(filePath));
    if (!relevant) {
      return { ...check, status: "not_applicable", trustTier: "none" };
    }
    const verificationEvidence =
      check.kind === "dependency" ? dependencyCheckVerificationEvidence(check, input) : { covered: false, trustTier: "none" as const };
    const covered =
      check.kind === "workflow"
        ? workflowTitles.has(check.target) && hasNonEditedEvidence
        : hasNonEditedEvidence || verificationEvidence.covered;
    return { ...check, status: covered ? "covered" : "missing", trustTier: covered ? verificationEvidence.trustTier : "none" };
  });
}

function dependencyCheckVerificationEvidence(
  check: TaskSnapshotRequiredCheck,
  input: {
    tests: TestRecommendation[];
    ranTests: string[];
    verificationCoverage: VerificationCoverage[];
  }
): { covered: boolean; trustTier: VerificationTrustTier } {
  const testPaths = check.paths.filter(isTestPath);
  const directTestEvidence = testPaths.some((testPath) =>
    input.ranTests.some((ranTest) => normalizePathLike(ranTest) === normalizePathLike(testPath))
  );
  const testCoverage = input.verificationCoverage.filter((coverage) =>
    testPaths.some(
      (testPath) =>
        coverage.kind === (testPath.endsWith(".py") ? "python-tests" : "javascript-tests") &&
        verificationTestRunnerCoversPath(coverage, testPath) &&
        coverageCoversPath(coverage, testPath)
    )
  );
  const sourcePaths = check.paths.filter((filePath) => !isTestPath(filePath));
  const sourceCoverage = input.verificationCoverage.filter((coverage) => {
    if (coverage.targetPath) {
      return sourcePaths.some(
        (filePath) =>
          normalizePathLike(filePath) === normalizePathLike(coverage.targetPath!) &&
          coverageKindCompatibleWithSourcePath(coverage.kind, filePath)
      );
    }
    return sourcePaths.some((filePath) => coverageKindCompatibleWithSourcePath(coverage.kind, filePath) && coverageCoversPath(coverage, filePath));
  });
  const matchingCoverage = [...testCoverage, ...sourceCoverage];
  return {
    covered: directTestEvidence || matchingCoverage.length > 0,
    trustTier: strongestVerificationTrustTier([
      ...(directTestEvidence ? (["reported"] as VerificationTrustTier[]) : []),
      ...matchingCoverage.map((coverage) => coverage.trustTier)
    ])
  };
}

function coverageKindCompatibleWithSourcePath(kind: VerificationCoverage["kind"], filePath: string): boolean {
  const normalized = normalizePathLike(filePath).toLowerCase();
  if (normalized.endsWith(".py")) {
    return kind === "python-tests";
  }
  if (/\.(?:cjs|cts|js|jsx|mjs|mts|ts|tsx)$/u.test(normalized)) {
    return kind === "build" || kind === "typescript-syntax" || kind === "javascript-tests";
  }
  return kind === "build";
}

function coverageCoversPath(coverage: VerificationCoverage, filePath: string): boolean {
  const normalizedPath = normalizePathLike(filePath);
  if (coverage.targetPath) {
    return normalizePathLike(coverage.targetPath) === normalizedPath;
  }
  const normalizedScope = normalizePathLike(coverage.scope ?? ".");
  return normalizedScope === "." || normalizedPath === normalizedScope || normalizedPath.startsWith(`${normalizedScope}/`);
}

function normalizePathLike(value: string): string {
  return value.replace(/\\/gu, "/").replace(/^\.\//u, "").replace(/\/+/gu, "/");
}
