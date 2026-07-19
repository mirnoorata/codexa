import { freshnessBlocksAuthority } from "../freshness-authority.js";
import { isRecord, nonEmptyArray, stringValue } from "./compaction-helpers.js";

/** Lifecycle authority needs every blocker inline when its compact kernel overflows. */
export function modeRequiresExactKernelDetail(mode: string): boolean {
  return mode === "post_edit_review" || mode === "proof_card";
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
  if (nonEmptyArray(data.driftReasons)) return "review-drift";
  if (readStringArray(data.gaps).some((gap) => gap.startsWith("worktree state unavailable"))) return "worktree-unavailable";
  const worktree = isRecord(data.worktree) ? data.worktree : runtime;
  if (worktree?.degraded === true || nonEmptyArray(data.worktreeDegradationReasons)) return "worktree-degraded";
  const quality = isRecord(data.quality) ? data.quality : undefined;
  if (quality?.level === "low") return "low-context-quality";
  const editReadiness = isRecord(data.editReadiness) ? data.editReadiness : undefined;
  if (editReadiness?.editable === false) return "edit-target-not-ready";
  const completionAuthority = stringValue(data.completionAuthority);
  if (completionAuthority && completionAuthority !== "complete") return `completion-authority:${completionAuthority}`;
  const inspectMode = stringValue(data.inspectMode);
  if (inspectMode && inspectMode !== "none" && inspectMode !== "not-required") return `inspect-mode:${inspectMode}`;
  if (data.mode === "post_edit_review" && hasUnresolvedInvariants(data.invariants, data.invariantReviews)) return "invariant-unresolved";
  const loop = isRecord(data.loopReview) ? data.loopReview : undefined;
  if (typeof loop?.status === "string" && !["continue", "resolved", "within-budget"].includes(loop.status)) return `loop:${loop.status}`;
  if (nonEmptyArray(data.failureSignals) && completionAuthority !== "complete") return "recurring-failure-signal";
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
