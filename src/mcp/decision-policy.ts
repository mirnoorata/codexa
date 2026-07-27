import { freshnessBlocksAuthority } from "../freshness-authority.js";
import { validatePostEditReviewCoverage } from "../post-edit-review-coverage.js";
import { isRecord, nonEmptyArray, stringValue } from "./compaction-helpers.js";

/** Lifecycle authority needs every blocker inline when its compact kernel overflows. */
export function modeRequiresExactKernelDetail(mode: string): boolean {
  return mode === "post_edit_review" || mode === "proof_card";
}

export function mcpKernelRequiresExactDetail(mode: string, data: Record<string, unknown>): boolean { const authority = isRecord(data.authority) ? data.authority : data; return modeRequiresExactKernelDetail(mode) && !mcpPostEditReviewIsAdvisory({ mode, completionAuthority: authority.completionAuthority, inspectMode: authority.inspectMode }); }

const TARGET_ROLE_BOUNDARY_KEYS = ["editableTargets", "readDependencies", "excludedTargets"] as const;
const TARGET_ROLE_BOUNDARY_SCAN = "__mcp.targetRoleBoundaryScan";
const MAX_TARGET_ROLE_BOUNDARY_DEPTH = 128;
const MAX_TARGET_ROLE_BOUNDARY_NODES = 50_000;
type TargetRoleBoundary = { path: string[]; total: number; uncertain?: boolean };

/** A compact kernel must not authorize edits when it drops any target-role boundary. */
export function mcpTargetRoleBoundaryRequiresExactDetail(data: Record<string, unknown>, returnedPerRole = 6): boolean {
  const authority = isRecord(data.authority) ? data.authority : data;
  return authority.actionability === "edit_ready"
    && targetRoleBoundaries(data).some((boundary) => boundary.uncertain === true || boundary.total > returnedPerRole);
}

/** The detailed projection is still bounded; detect an actually omitted role boundary. */
export function mcpTargetRoleBoundariesTruncated(data: Record<string, unknown>): boolean {
  const truncation = isRecord(data.truncation) ? data.truncation : undefined;
  return Object.entries(truncation ?? {}).some(([path, entry]) => (path === TARGET_ROLE_BOUNDARY_SCAN || TARGET_ROLE_BOUNDARY_KEYS.some((key) => path === key || path.endsWith(`.${key}`)))
    && isRecord(entry) && typeof entry.total === "number" && typeof entry.returned === "number" && entry.total > entry.returned);
}

/** Preserve an explicit count when a later budget tier removes any nested role boundary. */
export function mcpTargetRoleBoundaryTruncation(source: Record<string, unknown>, returned: Record<string, unknown>): Record<string, { total: number; returned: number }> {
  return Object.fromEntries(targetRoleBoundaries(source).flatMap((boundary) => {
    const value = pathValue(returned, boundary.path);
    const count = Array.isArray(value) ? value.length : 0;
    return count < boundary.total ? [[boundary.path.join("."), { total: boundary.total, returned: count }]] : [];
  }));
}

function targetRoleBoundaries(value: Record<string, unknown>): TargetRoleBoundary[] {
  const boundaries: TargetRoleBoundary[] = [];
  const seen = new WeakSet<object>();
  const active = new WeakSet<object>();
  let visited = 0;
  let uncertain = false;
  const visit = (entry: unknown, path: string[], depth: number): void => {
    if (!entry || typeof entry !== "object") return;
    if (active.has(entry)) {
      uncertain = true;
      return;
    }
    if (seen.has(entry)) return;
    if (depth > MAX_TARGET_ROLE_BOUNDARY_DEPTH || ++visited > MAX_TARGET_ROLE_BOUNDARY_NODES) {
      uncertain = true;
      return;
    }
    seen.add(entry);
    active.add(entry);
    if (Array.isArray(entry)) {
      entry.forEach((child, index) => visit(child, [...path, String(index)], depth + 1));
    } else if (isRecord(entry)) {
      for (const key of TARGET_ROLE_BOUNDARY_KEYS) {
        if (Array.isArray(entry[key])) boundaries.push({ path: [...path, key], total: entry[key].length });
      }
      for (const [key, child] of Object.entries(entry)) {
        if (key !== "decisionKernel" && key !== "mcp" && key !== "truncation") visit(child, [...path, key], depth + 1);
      }
    }
    active.delete(entry);
  };
  visit(value, [], 0);
  if (uncertain) boundaries.push({ path: [TARGET_ROLE_BOUNDARY_SCAN], total: 1, uncertain: true });
  return boundaries;
}

function pathValue(value: Record<string, unknown>, path: string[]): unknown {
  return path.reduce<unknown>((current, key) => Array.isArray(current) ? current[Number(key)] : isRecord(current) ? current[key] : undefined, value);
}

/** One authority classifier feeds both detailed and compact delivery. */
export function mcpAuthorityBlockReason(data: Record<string, unknown>, freshness: Record<string, unknown> | undefined): string | undefined {
  if (freshness?.missing === true) return "index-missing";
  if (freshnessBlocksAuthority(freshness)) return `index-stale${typeof freshness?.reason === "string" ? `:${freshness.reason}` : ""}`;
  const runtime = isRecord(data.runtime) ? data.runtime : isRecord(data.session) ? data.session : undefined;
  if (checkoutIdentityMismatch(runtime, freshness)) return "checkout-index-identity-mismatch";
  if (data.ambiguous === true) return "ambiguous-target";
  if (isRecord(data.snapshotBlock)) return "snapshot-blocked";
  const snapshotLoad = isRecord(data.snapshotLoad) ? data.snapshotLoad : undefined;
  if (snapshotLoad?.ambiguousLatest === true || typeof snapshotLoad?.missingReason === "string") return "snapshot-missing-or-ambiguous";
  const advisoryReview = mcpPostEditReviewIsAdvisory(data);
  if (nonEmptyArray(data.driftReasons) && !advisoryReview) return "review-drift";
  const reviewCoverageReason = postEditReviewCoverageBlockReason(data);
  if (reviewCoverageReason) return reviewCoverageReason;
  if (readStringArray(data.gaps).some((gap) => gap.startsWith("worktree state unavailable"))) return "worktree-unavailable";
  const worktree = isRecord(data.worktree) ? data.worktree : runtime;
  if (worktree?.degraded === true || nonEmptyArray(data.worktreeDegradationReasons)) return "worktree-degraded";
  const quality = isRecord(data.quality) ? data.quality : undefined;
  if (quality?.level === "low") return "low-context-quality";
  const editReadiness = isRecord(data.editReadiness) ? data.editReadiness : undefined;
  if (editReadiness?.editable === false) return "edit-target-not-ready";
  const completionAuthority = stringValue(data.completionAuthority);
  if (completionAuthority && completionAuthority !== "complete" && !advisoryReview) return `completion-authority:${completionAuthority}`;
  const inspectMode = stringValue(data.inspectMode);
  if (inspectMode && inspectMode !== "none" && inspectMode !== "not-required" && !advisoryReview) return `inspect-mode:${inspectMode}`;
  if (data.mode === "post_edit_review" && hasUnresolvedInvariants(data.invariants, data.invariantReviews)) return "invariant-unresolved";
  const loop = isRecord(data.loopReview) ? data.loopReview : undefined;
  if (typeof loop?.status === "string" && !["continue", "resolved", "within-budget"].includes(loop.status)) return `loop:${loop.status}`;
  if (nonEmptyArray(data.failureSignals) && completionAuthority !== "complete" && !advisoryReview) return "recurring-failure-signal";
  if (data.mode === "proof_card") {
    const lifecycle = isRecord(data.lifecycle) ? data.lifecycle : undefined;
    const decisionLog = isRecord(data.decisionLog) ? data.decisionLog : undefined;
    // `verify` and `needs_target` are already non-authorizing proof states.
    // Proof gaps qualify completion; they must only revoke a claimed `done`
    // state, not erase the more useful verification/scope instruction.
    if (stringValue(data.actionability) === "done") {
      if (hasUnresolvedInvariants(lifecycle?.invariants, lifecycle?.invariantReviews)) return "proof-invariant-unresolved";
      if (nonEmptyArray(data.gaps)) return "proof-gaps";
      if (lifecycle?.status === "invalid" || isRecord(lifecycle?.pendingStop)) return "proof-lifecycle-stop";
      if (decisionLog?.status === "unavailable" || decisionLog?.baselineIntact === false || decisionLog?.summaryHashValid === false) return "decision-log-integrity";
    }
  }
  return undefined;
}

export function mcpPostEditReviewIsAdvisory(data: Record<string, unknown>): boolean {
  return data.mode === "post_edit_review" && stringValue(data.completionAuthority) === "advisory_inspect" && stringValue(data.inspectMode) === "advisory";
}

export function postEditReviewCoverageBlockReason(data: Record<string, unknown>, suppliedMode?: string): string | undefined {
  const mode = suppliedMode ?? stringValue(data.mode);
  if (mode !== "post_edit_review") return undefined;
  const snapshot = isRecord(data.snapshot) ? data.snapshot : undefined;
  const planRevision = data.planRevision;
  const candidateTargets = Array.isArray(data.reviewCandidateTargets)
    ? data.reviewCandidateTargets.filter((target): target is string => typeof target === "string")
    : undefined;
  const analyzedTargets = Array.isArray(data.reviewTargets)
    ? data.reviewTargets.filter((target): target is string => typeof target === "string")
    : undefined;
  if (
    !Number.isInteger(planRevision) ||
    (planRevision as number) < 1 ||
    !candidateTargets ||
    candidateTargets.length !== (data.reviewCandidateTargets as unknown[])?.length ||
    !analyzedTargets ||
    analyzedTargets.length !== (data.reviewTargets as unknown[])?.length
  ) {
    return "post-edit-review-coverage-invalid";
  }
  const topLevelTaskId = stringValue(data.taskId);
  const snapshotTaskId = stringValue(snapshot?.taskId);
  if (topLevelTaskId && snapshotTaskId && topLevelTaskId !== snapshotTaskId) return "post-edit-review-coverage-invalid";
  if (snapshot?.planRevision !== undefined && snapshot.planRevision !== planRevision) return "post-edit-review-coverage-invalid";
  const taskId = topLevelTaskId ?? snapshotTaskId ?? null;
  const snapshotCreatedAt = stringValue(snapshot?.createdAt) ?? null;
  const snapshotPublicationSequence = Number.isInteger(snapshot?.publicationSequence)
    ? snapshot!.publicationSequence as number
    : null;
  const validation = validatePostEditReviewCoverage(data.reviewCoverage, {
    taskId,
    planRevision: planRevision as number,
    snapshotCreatedAt,
    snapshotPublicationSequence,
    candidateTargets,
    analyzedTargets
  });
  if (!validation.valid) return "post-edit-review-coverage-invalid";
  return validation.coverage?.status === "partial" ? "post-edit-review-coverage-partial" : undefined;
}

/** Proof evidence can require inline detail without revoking a `verify` state. */
export function mcpProofEscalationReason(data: Record<string, unknown>): string | undefined {
  if (data.mode !== "proof_card" || stringValue(data.actionability) === "needs_target") return undefined;
  const lifecycle = isRecord(data.lifecycle) ? data.lifecycle : undefined;
  const decisionLog = isRecord(data.decisionLog) ? data.decisionLog : undefined;
  if (hasUnresolvedInvariants(lifecycle?.invariants, lifecycle?.invariantReviews)) return "proof-invariant-unresolved";
  if (nonEmptyArray(data.gaps)) return "proof-gaps";
  if (lifecycle?.status === "invalid" || isRecord(lifecycle?.pendingStop)) return "proof-lifecycle-stop";
  if (decisionLog?.status === "unavailable" || decisionLog?.baselineIntact === false || decisionLog?.summaryHashValid === false) return "decision-log-integrity";
  return undefined;
}

export function decisionEntryPath(value: unknown): string | undefined {
  if (!isRecord(value)) return typeof value === "string" ? value : undefined;
  const nestedFile = isRecord(value.file) ? value.file : undefined;
  return stringValue(value.path) ?? stringValue(value.file) ?? stringValue(nestedFile?.path);
}

export function renderDecisionReadScope(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const nextReads = Array.isArray(value.nextReads) ? value.nextReads : [];
  const focusFiles = Array.isArray(value.focusFiles) ? value.focusFiles : [];
  const source = nextReads.length > 0 ? nextReads : focusFiles;
  const paths = [...new Set(source.map(decisionEntryPath).filter((entry): entry is string => Boolean(entry)))].slice(0, 3);
  if (paths.length === 0) return undefined;
  const declaredCount = typeof value.nextReadCount === "number"
    ? value.nextReadCount
    : typeof value.focusFileCount === "number"
      ? value.focusFileCount
      : source.length;
  const omitted = Math.max(0, declaredCount - paths.length);
  return `Read first: ${paths.map((entry) => entry.slice(0, 220)).join(" | ")}${omitted > 0 ? ` | +${omitted} more` : ""}`;
}

function checkoutIdentityMismatch(runtime: Record<string, unknown> | undefined, freshness: Record<string, unknown> | undefined): boolean {
  if (!runtime || !freshness) return false;
  const activeRepo = stringValue(runtime.repoRoot);
  const indexedRepo = stringValue(freshness.repoRoot);
  const activeHead = stringValue(runtime.gitHead);
  const indexedHead = stringValue(freshness.headCommit);
  return Boolean((activeRepo && indexedRepo && activeRepo !== indexedRepo) || (activeHead && indexedHead && activeHead !== indexedHead));
}

function hasUnresolvedInvariants(invariantsValue: unknown, reviewsValue: unknown): boolean {
  if (!Array.isArray(invariantsValue) || invariantsValue.length === 0) return false;
  const reviews = Array.isArray(reviewsValue) ? reviewsValue.filter(isRecord) : [];
  return invariantsValue.some((value) => {
    const invariant = isRecord(value) ? value : {};
    const id = stringValue(invariant.id) ?? stringValue(invariant.invariantId);
    const review = reviews.find((entry) => stringValue(entry.invariantId) === id || stringValue(entry.id) === id);
    return !review || !["satisfied", "preserved", "pass"].includes(String(review.status));
  });
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}
