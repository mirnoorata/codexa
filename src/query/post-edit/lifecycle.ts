import { postEditDecision } from "./decision.js";
import { getDiffFootprint } from "../worktree.js";
import {
  classifyTaskLoopFailures,
  loadTaskLifecycleState,
  prepareTaskLoopAttempt,
  saveTaskLifecycleState,
  taskLoopAttemptId,
  withTaskLifecycleLock,
  type TaskInvariantReviewResult
} from "../../task-lifecycle.js";
import { savePostEditOutcome, type PostEditOutcomeInput } from "../../post-edit-outcomes.js";
import type { ChangedFileEntry, DiffFootprintV1, TaskInvariant, TaskLoopFailureSignal, TaskLoopReview, VerificationCommandReport } from "../../types.js";

export interface PostEditLifecycleInput {
  repoRoot: string;
  lifecycleTaskId: string;
  planRevision: number;
  decisionInput: Parameters<typeof postEditDecision>[0];
  currentEntries: ChangedFileEntry[];
  modifiedSymbolCount: number;
  invariantReview: TaskInvariantReviewResult;
  verification: {
    ranTests: string[];
    ranCommands: string[];
    commandReports: VerificationCommandReport[];
    reviewTargets: string[];
    noVerificationProofForEditedFiles: boolean;
  };
  changedFiles: string[];
  artifactIds?: string[];
  externalCheckFailedTargets?: string[];
  expectedInvariants?: TaskInvariant[];
  requireExistingState?: boolean;
  beforePersist?: () => Promise<void>;
}

export async function buildPostEditLifecycleDecision(input: PostEditLifecycleInput): Promise<{
  decision: ReturnType<typeof postEditDecision>;
  failureSignals: ReturnType<typeof classifyTaskLoopFailures>;
  diffFootprint: Awaited<ReturnType<typeof getDiffFootprint>>;
  loopReview: TaskLoopReview;
  nextState: Awaited<ReturnType<typeof prepareTaskLoopAttempt>>["nextState"];
}> {
  if (input.requireExistingState) {
    const state = await loadTaskLifecycleState(input.repoRoot, input.lifecycleTaskId);
    if (!state) {
      throw new Error(`Task lifecycle state is missing for governed snapshot ${input.lifecycleTaskId} revision ${input.planRevision}`);
    }
    if (state.planRevision !== input.planRevision) {
      throw new Error(`Task lifecycle revision ${state.planRevision} does not match governed snapshot revision ${input.planRevision}`);
    }
    if (!sameInvariants(state.invariants, input.expectedInvariants ?? [])) {
      throw new Error(`Task lifecycle invariants do not match governed snapshot ${input.lifecycleTaskId}`);
    }
  }
  const preliminaryDecision = postEditDecision(input.decisionInput);
  const diffFootprint = await getDiffFootprint(input.repoRoot, input.currentEntries, input.modifiedSymbolCount);
  const failureSignals = classifyTaskLoopFailures({
    planDriftTargets: [
      ...(input.decisionInput.headChanged && !input.decisionInput.implicitBaseline ? ["git-head"] : []),
      ...input.decisionInput.unplannedEditedFiles,
      ...input.decisionInput.unplannedChangedSymbols.map((entry) => entry.symbol.id)
    ],
    contextUnreliableTargets: [...input.decisionInput.worktreeDegradationReasons, ...(input.decisionInput.quality?.level === "low" ? ["low-context-quality"] : [])],
    verificationMissingTargets: [
      ...input.decisionInput.testsNotRun.map((test) => test.path),
      ...(input.verification.noVerificationProofForEditedFiles ? input.verification.reviewTargets : []),
      ...input.decisionInput.degradedSnapshotTests.map((test) => test.path)
    ],
    verificationFailedTargets: input.verification.commandReports.filter((report) => report.exitCode !== undefined && report.exitCode !== 0).map((report) => report.command),
    requiredCheckMissingTargets: [...input.decisionInput.workflowChecks, ...input.decisionInput.dependencyChecks].filter((check) => check.status === "missing").map((check) => check.target),
    riskEscalationTargets: preliminaryDecision.riskEscalationsNeedInspection ? input.decisionInput.riskEscalations.map((file) => file.path) : [],
    invariantUnreviewedTargets: input.invariantReview.missing.map((invariant) => invariant.id),
    invariantViolatedTargets: input.invariantReview.violated.map((invariant) => invariant.id),
    externalCheckFailedTargets: input.externalCheckFailedTargets
  });
  const attemptId = taskLoopAttemptId({
    taskId: input.lifecycleTaskId,
    planRevision: input.planRevision,
    diffFootprint,
    artifactIds: input.artifactIds ?? []
  });
  const prepared = await prepareTaskLoopAttempt({
    repoRoot: input.repoRoot,
    taskId: input.lifecycleTaskId,
    planRevision: input.planRevision,
    attemptId,
    attemptStatus: preliminaryDecision.completionAuthority === "complete" ? "resolved" : "unresolved",
    failureSignals,
    diffFootprint,
    changedFiles: input.changedFiles,
    forceReplanReasons: [
      ...(preliminaryDecision.completionAuthority === "replan_required" ? preliminaryDecision.driftReasons : []),
      ...(input.invariantReview.violated.length > 0 ? ["a declared task invariant was reported violated"] : [])
    ],
    invariantReviews: input.invariantReview.reviews
  });
  const loopReview = prepared.review;
  return {
    decision: loopReview.status === "replan-required"
      ? postEditDecision({ ...input.decisionInput, loopReplanReasons: loopReview.reasons })
      : preliminaryDecision,
    failureSignals,
    diffFootprint,
    loopReview,
    nextState: prepared.nextState
  };
}

export async function persistPostEditLifecycleOutcome(lifecycleInput: PostEditLifecycleInput, outcomeInput: PostEditOutcomeInput) {
  return withTaskLifecycleLock(lifecycleInput.repoRoot, lifecycleInput.lifecycleTaskId, async () => {
    const lifecycle = await buildPostEditLifecycleDecision(lifecycleInput);
    await lifecycleInput.beforePersist?.();
    // Publish the safety latch before the audit record. An interrupted outcome
    // write may require a retry, but it must never leave a mandatory stop
    // visible only in an outcome file that the pre-edit gate does not read.
    await saveTaskLifecycleState(lifecycleInput.repoRoot, lifecycle.nextState);
    const saved = await savePostEditOutcome({
      ...outcomeInput,
      verdict: lifecycle.decision.verdict,
      inspectMode: lifecycle.decision.inspectMode,
      inspectReasons: lifecycle.decision.inspectReasons,
      completionAuthority: lifecycle.decision.completionAuthority,
      driftReasons: lifecycle.decision.driftReasons,
      failureSignals: lifecycle.failureSignals,
      diffFootprint: lifecycle.diffFootprint,
      loopReview: lifecycle.loopReview
    });
    return { ...saved, lifecycle };
  });
}

function sameInvariants(left: TaskInvariant[], right: TaskInvariant[]): boolean {
  return left.length === right.length && left.every((invariant, index) => {
    const expected = right[index];
    return expected?.id === invariant.id && expected.statement === invariant.statement;
  });
}

export function postEditLifecycleData(
  planRevision: number,
  invariants: TaskInvariant[],
  invariantReview: TaskInvariantReviewResult,
  failureSignals: TaskLoopFailureSignal[],
  diffFootprint: DiffFootprintV1,
  loopReview: TaskLoopReview
) {
  return {
    planRevision,
    invariants,
    invariantReviews: invariantReview.reviews,
    invariantReviewMissing: invariantReview.missing.map((invariant) => invariant.id),
    invariantReviewUnknown: invariantReview.unknownInvariantIds,
    failureSignals,
    diffFootprint,
    loopReview
  };
}

export function formatPostEditLifecycle(invariants: TaskInvariant[], invariantReview: TaskInvariantReviewResult, loopReview: TaskLoopReview, planRevision: number): string[] {
  return [
    `Task loop: ${loopReview.status}; attempt ${loopReview.attemptsSincePlan} in plan revision ${planRevision}; unresolved streak ${loopReview.unresolvedAttemptsSincePlan}`,
    ...(invariants.length > 0 ? ["", "Task invariants (reported review only):"] : []),
    ...invariants.map((invariant) => {
      const review = invariantReview.reviews.find((entry) => entry.invariantId === invariant.id);
      return `- ${invariant.id}: ${review?.status ?? "unreviewed"}; ${invariant.statement}${review?.evidence.length ? `; evidence ${review.evidence.join(" | ")}` : ""}`;
    })
  ];
}
