import path from "node:path";
import { isTestPath } from "../../language.js";
import type {
  AutoVerifyCandidate,
  TaskSnapshot,
  TestRecommendation,
  TestRecommendationProvenance,
  VerificationCoverage,
  VerificationLedgerEntry
} from "../../types.js";
import type { PostEditCheckResult } from "../../post-edit-outcomes.js";
import { stableId, uniqueSorted } from "../../util.js";
import { autoVerifySnapshotDigest } from "./runner-review.js";

export function buildAutoVerifyCandidates(input: { snapshot: TaskSnapshot | undefined; testsNotRun: TestRecommendation[]; reviewTargets: string[]; repoRoot: string }): AutoVerifyCandidate[] {
  if (!input.snapshot) return [];
  const snapshot = input.snapshot;
  const snapshotDigest = autoVerifySnapshotDigest(snapshot);
  return input.testsNotRun
    .filter((test) => test.command && test.commandCwd && test.commandExecutable && test.commandArgs)
    .map((test, index) => ({
      schemaVersion: 1,
      taskId: snapshot.taskId,
      snapshotDigest,
      commandId: stableId("autoverify-command", snapshot.taskId, test.command!, test.commandCwd!, JSON.stringify(test.commandArgs!)),
      command: test.command!,
      commandExecutable: test.commandExecutable!,
      commandArgs: test.commandArgs!,
      commandCwd: test.commandCwd!,
      targetPaths: uniqueSorted([test.path, ...(test.provenance?.targetPaths ?? input.reviewTargets)]),
      source: autoVerifyCandidateSource(test.provenance),
      rank: test.rank - index / 100
    } satisfies AutoVerifyCandidate));
}

export function stableSessionMemoryHash(value: string): string {
  return stableId("session-memory-summary", value);
}

export function compactContextData(data: unknown): unknown {
  if (!data || typeof data !== "object") return undefined;
  const record = data as Record<string, unknown>;
  return {
    mode: record.mode,
    packetVerdict: record.packetVerdict,
    diagnostics: Array.isArray(record.diagnostics) ? record.diagnostics.slice(0, 12) : undefined,
    focusFiles: Array.isArray(record.focusFiles) ? record.focusFiles.slice(0, 20) : undefined,
    tests: Array.isArray(record.tests) ? record.tests.slice(0, 20) : undefined,
    quality: record.quality,
    gaps: Array.isArray(record.gaps) ? record.gaps.slice(0, 20) : undefined,
    warnings: Array.isArray(record.warnings) ? record.warnings.slice(0, 20) : undefined
  };
}

export function hasRelevantVerificationEvidence(input: {
  verificationLedger: VerificationLedgerEntry[];
  verificationCoverage: VerificationCoverage[];
  ranTests: string[];
  tests: TestRecommendation[];
  workflowChecks: PostEditCheckResult[];
  dependencyChecks: PostEditCheckResult[];
  reviewTargets: string[];
  editPaths: string[];
}): boolean {
  const checkedTargets = new Set([
    ...input.tests.map((test) => normalizeReviewPath(test.path)),
    ...input.workflowChecks.map((check) => normalizeReviewPath(check.target)),
    ...input.dependencyChecks.map((check) => normalizeReviewPath(check.target))
  ]);
  if (input.verificationLedger.some((entry) => (entry.status === "covered" || entry.status === "waived") && (checkedTargets.size === 0 || checkedTargets.has(normalizeReviewPath(entry.target))))) return true;
  const recommendedTests = new Set(input.tests.map((test) => normalizeReviewPath(test.path)));
  if (input.ranTests.some((test) => recommendedTests.has(normalizeReviewPath(test)))) return true;
  const changedTargets = uniqueSorted([...input.editPaths, ...input.reviewTargets].map(normalizeReviewPath).filter(Boolean));
  return input.verificationCoverage.some((coverage) => coverageIsRelevantProof(coverage, changedTargets, recommendedTests));
}

function autoVerifyCandidateSource(provenance: TestRecommendationProvenance | undefined): AutoVerifyCandidate["source"] {
  const sources = provenance?.sources ?? [];
  if (sources.includes("explicit_target")) return "explicit";
  if (sources.includes("authoritative_test_edge")) return "authoritative-test-edge";
  if (sources.includes("derived_import") || sources.includes("derived_impact_expansion") || sources.includes("package_import") || sources.includes("outcome_history")) return "derived-impact";
  if (sources.length > 0) return "heuristic";
  return "legacy";
}

function coverageIsRelevantProof(coverage: VerificationCoverage, changedTargets: string[], recommendedTests: Set<string>): boolean {
  if (["unknown", "audit", "privacy", "lint"].includes(coverage.kind)) return false;
  const target = coverage.targetPath ? normalizeReviewPath(coverage.targetPath) : undefined;
  if (target) return changedTargets.includes(target) || recommendedTests.has(target) || changedTargets.some((changed) => pathIntersects(target, changed));
  if (coverage.kind === "javascript-tests" || coverage.kind === "python-tests" || coverage.kind === "targeted-test") {
    return recommendedTests.size === 0 && changedTargets.some((changed) => scopeCoversReviewPath(coverage.scope ?? ".", changed));
  }
  if (coverage.kind === "build" || coverage.kind === "typescript-syntax") {
    return changedTargets.some((changed) => sourcePathFitsCoverageKind(changed, coverage.kind) && scopeCoversReviewPath(coverage.scope ?? ".", changed));
  }
  return false;
}

function sourcePathFitsCoverageKind(filePath: string, kind: VerificationCoverage["kind"]): boolean {
  if (kind === "typescript-syntax") return /\.(?:[cm]?[jt]sx?)$/iu.test(filePath);
  if (kind === "build") return !isTestPath(filePath);
  return false;
}

function scopeCoversReviewPath(scope: string, filePath: string): boolean {
  const normalizedScope = normalizeReviewPath(scope);
  const normalizedPath = normalizeReviewPath(filePath);
  return normalizedScope === "." || normalizedScope === "" || normalizedPath === normalizedScope || normalizedPath.startsWith(`${normalizedScope}/`);
}

function pathIntersects(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function normalizeReviewPath(value: string): string {
  const normalized = value.replace(/\\/gu, "/").replace(/^\.\/+/u, "");
  const collapsed = path.posix.normalize(normalized);
  return collapsed === "." ? "." : collapsed.replace(/^\/+/u, "");
}
