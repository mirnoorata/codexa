import type { PostEditReviewCoverage } from "./types.js";
import { stableId } from "./util.js";

const DIGEST_PATTERN = /^[a-f0-9]{16}$/u;
export const MAX_POST_EDIT_REVIEW_TARGETS_PER_PASS = 30;
export const MAX_POST_EDIT_REVIEW_CANDIDATE_TARGETS = 2_000;

export interface PostEditReviewCoverageContext {
  taskId: string | null;
  planRevision: number;
  snapshotCreatedAt: string | null;
  snapshotPublicationSequence: number | null;
  candidateTargets?: string[];
  analyzedTargets: string[];
}

export interface PostEditReviewCoverageValidation {
  valid: boolean;
  reason?: string;
  coverage?: PostEditReviewCoverage;
}

export function postEditReviewTargetDigest(targets: string[]): string {
  return stableId("post-edit-review-targets-v1", ...targets);
}

export function createPostEditReviewCoverage(input: {
  candidateTargets: string[];
  analyzedTargets: string[];
  targetLimit: number;
  analysisPassCount?: number;
  taskId: string | null;
  planRevision: number;
  snapshotCreatedAt: string | null;
  snapshotPublicationSequence: number | null;
}): PostEditReviewCoverage {
  const omittedTargetCount = input.candidateTargets.length - input.analyzedTargets.length;
  const analysisPassCount =
    input.analysisPassCount ?? Math.max(1, Math.ceil(input.analyzedTargets.length / input.targetLimit));
  const coverage: PostEditReviewCoverage = {
    schemaVersion: 2,
    binding: {
      taskId: input.taskId,
      planRevision: input.planRevision,
      snapshotCreatedAt: input.snapshotCreatedAt,
      snapshotPublicationSequence: input.snapshotPublicationSequence,
      candidateTargetsDigest: postEditReviewTargetDigest(input.candidateTargets),
      analyzedTargetsDigest: postEditReviewTargetDigest(input.analyzedTargets)
    },
    status: omittedTargetCount === 0 ? "complete" : "partial",
    candidateTargetCount: input.candidateTargets.length,
    analyzedTargetCount: input.analyzedTargets.length,
    omittedTargetCount,
    targetLimit: input.targetLimit,
    analysisPassCount
  };
  const validation = validatePostEditReviewCoverage(coverage, {
    taskId: input.taskId,
    planRevision: input.planRevision,
    snapshotCreatedAt: input.snapshotCreatedAt,
    snapshotPublicationSequence: input.snapshotPublicationSequence,
    candidateTargets: input.candidateTargets,
    analyzedTargets: input.analyzedTargets
  });
  if (!validation.valid) throw new Error(`invalid generated post-edit review coverage: ${validation.reason}`);
  return coverage;
}

export function validatePostEditReviewCoverage(
  value: unknown,
  context?: PostEditReviewCoverageContext
): PostEditReviewCoverageValidation {
  if (!isRecord(value)) return invalid("receipt is missing or not an object");
  if (value.schemaVersion !== 1 && value.schemaVersion !== 2) return invalid("schemaVersion must be 1 or 2");
  if (!isRecord(value.binding)) return invalid("binding is missing or not an object");
  if (value.status !== "complete" && value.status !== "partial") return invalid("status must be complete or partial");
  for (const key of ["candidateTargetCount", "analyzedTargetCount", "omittedTargetCount", "targetLimit"] as const) {
    if (!Number.isInteger(value[key])) return invalid(`${key} must be an integer`);
  }
  const candidateTargetCount = value.candidateTargetCount as number;
  const analyzedTargetCount = value.analyzedTargetCount as number;
  const omittedTargetCount = value.omittedTargetCount as number;
  const targetLimit = value.targetLimit as number;
  if (candidateTargetCount < 0 || analyzedTargetCount < 0 || omittedTargetCount < 0) return invalid("target counts must be non-negative");
  if (candidateTargetCount > MAX_POST_EDIT_REVIEW_CANDIDATE_TARGETS) {
    return invalid(`candidateTargetCount exceeds the ${MAX_POST_EDIT_REVIEW_CANDIDATE_TARGETS}-target lifecycle safety limit`);
  }
  if (targetLimit < 3 || targetLimit > MAX_POST_EDIT_REVIEW_TARGETS_PER_PASS) return invalid("targetLimit must be between 3 and 30");
  let analysisPassCount = 1;
  if (value.schemaVersion === 1) {
    if (value.analysisPassCount !== undefined) return invalid("schema v1 cannot declare analysisPassCount");
    if (analyzedTargetCount > targetLimit) return invalid("schema v1 analyzedTargetCount exceeds targetLimit");
  } else {
    if (!Number.isInteger(value.analysisPassCount)) return invalid("analysisPassCount must be an integer");
    analysisPassCount = value.analysisPassCount as number;
    if (analysisPassCount < 1) return invalid("analysisPassCount must be positive");
    const expectedAnalysisPassCount = Math.max(1, Math.ceil(analyzedTargetCount / targetLimit));
    if (analysisPassCount !== expectedAnalysisPassCount) return invalid("analysisPassCount does not match analyzed targets");
  }
  if (candidateTargetCount !== analyzedTargetCount + omittedTargetCount) return invalid("target counts do not reconcile");
  if (value.status === "complete" && (omittedTargetCount !== 0 || candidateTargetCount !== analyzedTargetCount)) {
    return invalid("complete coverage cannot omit targets");
  }
  if (value.status === "partial") {
    if (omittedTargetCount === 0 || candidateTargetCount <= analyzedTargetCount) {
      return invalid("partial coverage must omit at least one target");
    }
    if (value.schemaVersion === 1 && (candidateTargetCount <= targetLimit || analyzedTargetCount !== targetLimit)) {
      return invalid("schema v1 partial coverage must fill its single pass");
    }
  }
  const binding = value.binding;
  if (binding.taskId !== null && (typeof binding.taskId !== "string" || binding.taskId.length === 0 || binding.taskId.length > 200)) {
    return invalid("binding.taskId must be null or a bounded non-empty string");
  }
  if (!Number.isInteger(binding.planRevision) || (binding.planRevision as number) < 1) return invalid("binding.planRevision must be positive");
  if (!nullableDate(binding.snapshotCreatedAt)) return invalid("binding.snapshotCreatedAt must be null or a valid timestamp");
  if (binding.snapshotPublicationSequence !== null && (!Number.isInteger(binding.snapshotPublicationSequence) || (binding.snapshotPublicationSequence as number) < 1)) {
    return invalid("binding.snapshotPublicationSequence must be null or positive");
  }
  if (!DIGEST_PATTERN.test(String(binding.candidateTargetsDigest))) return invalid("binding.candidateTargetsDigest is invalid");
  if (!DIGEST_PATTERN.test(String(binding.analyzedTargetsDigest))) return invalid("binding.analyzedTargetsDigest is invalid");
  if (context) {
    if (
      binding.taskId !== context.taskId ||
      binding.planRevision !== context.planRevision ||
      binding.snapshotCreatedAt !== context.snapshotCreatedAt ||
      binding.snapshotPublicationSequence !== context.snapshotPublicationSequence
    ) return invalid("binding does not match the task snapshot");
    if (analyzedTargetCount !== context.analyzedTargets.length || binding.analyzedTargetsDigest !== postEditReviewTargetDigest(context.analyzedTargets)) {
      return invalid("binding does not match analyzed targets");
    }
    if (context.candidateTargets) {
      if (
        candidateTargetCount !== context.candidateTargets.length ||
        binding.candidateTargetsDigest !== postEditReviewTargetDigest(context.candidateTargets)
      ) return invalid("binding does not match candidate targets");
      if (!matchesCandidatePrefix(context.candidateTargets, context.analyzedTargets)) {
        return invalid("analyzed targets do not match the candidate prefix");
      }
    }
  }
  return { valid: true, coverage: value as unknown as PostEditReviewCoverage };
}

export function isCompletionBearingPostEditReviewCoverage(
  value: unknown,
  context: PostEditReviewCoverageContext
): boolean {
  const validation = validatePostEditReviewCoverage(value, context);
  return validation.valid && validation.coverage?.status === "complete";
}

export function postEditReviewCoverageDigest(value: unknown): string | undefined {
  const validation = validatePostEditReviewCoverage(value);
  if (!validation.valid || !validation.coverage) return undefined;
  const coverage = validation.coverage;
  if (coverage.schemaVersion === 1) {
    return stableId(
      "post-edit-review-coverage-v1",
      `status:${coverage.status}`,
      `candidate:${coverage.candidateTargetCount}`,
      `analyzed:${coverage.analyzedTargetCount}`,
      `omitted:${coverage.omittedTargetCount}`,
      `limit:${coverage.targetLimit}`,
      `task:${coverage.binding.taskId ?? "<null>"}`,
      `revision:${coverage.binding.planRevision}`,
      `snapshot:${coverage.binding.snapshotCreatedAt ?? "<null>"}`,
      `publication:${coverage.binding.snapshotPublicationSequence ?? "<null>"}`,
      `candidates:${coverage.binding.candidateTargetsDigest}`,
      `analyzedTargets:${coverage.binding.analyzedTargetsDigest}`
    );
  }
  return stableId(
    "post-edit-review-coverage-v2",
    `status:${coverage.status}`,
    `candidate:${coverage.candidateTargetCount}`,
    `analyzed:${coverage.analyzedTargetCount}`,
    `omitted:${coverage.omittedTargetCount}`,
    `limit:${coverage.targetLimit}`,
    `passes:${coverage.analysisPassCount ?? 1}`,
    `task:${coverage.binding.taskId ?? "<null>"}`,
    `revision:${coverage.binding.planRevision}`,
    `snapshot:${coverage.binding.snapshotCreatedAt ?? "<null>"}`,
    `publication:${coverage.binding.snapshotPublicationSequence ?? "<null>"}`,
    `candidates:${coverage.binding.candidateTargetsDigest}`,
    `analyzedTargets:${coverage.binding.analyzedTargetsDigest}`
  );
}

function invalid(reason: string): PostEditReviewCoverageValidation {
  return { valid: false, reason };
}

function nullableDate(value: unknown): boolean {
  return value === null || (typeof value === "string" && value.length <= 80 && Number.isFinite(Date.parse(value)));
}

function matchesCandidatePrefix(candidateTargets: string[], analyzedTargets: string[]): boolean {
  return analyzedTargets.every((target, index) => candidateTargets[index] === target);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
