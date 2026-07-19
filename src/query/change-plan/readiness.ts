import { loadTaskSnapshot, type TaskSnapshotLoadResult } from "../../task-snapshots.js";
import type { ChangePlanInput, EvidenceTier, FileFact } from "../../types.js";
import { uniqueSorted } from "../../util.js";
import type { ContextQuality } from "../quality.js";

export function changePlanEditReadiness(input: {
  input: ChangePlanInput;
  focusFiles: Array<{ file: FileFact; reasons: string[]; tier: EvidenceTier }>;
  explicitTargetProvided: boolean;
  explicitTargetInvalid?: boolean;
  dirtyScope?: { requested?: boolean; mode?: "edit" | "orientation"; canPlan?: boolean; plannedEditTargets?: string[] };
  quality?: ContextQuality;
  packetVerdict?: string;
  intentConfidence?: { editReady?: boolean; confidence?: number; verdict?: string; recommendedNextTool?: string; missingAnchors?: string[] };
}): {
  editable: boolean;
  status: "edit-ready" | "orientation-only";
  reason: string;
  source: "explicit-target" | "high-confidence-context" | "dirty-worktree" | "insufficient-context";
  explicitTargetProvided: boolean;
  packetVerdict?: string;
  qualityLevel?: ContextQuality["level"];
  confidence?: number;
  recommendedNextTool?: string;
  missingAnchors: string[];
  snapshotBlocked: boolean;
} {
  const packetVerdict = input.packetVerdict ?? input.intentConfidence?.verdict;
  const qualityLevel = input.quality?.level;
  const hasEvidenceBackedFocus = input.focusFiles.some((entry) => entry.tier === "authoritative" || entry.tier === "derived");
  const highConfidenceContext = qualityLevel === "high" && hasEvidenceBackedFocus && (packetVerdict === undefined || packetVerdict === "edit-ready");
  const dirtyWorktreeContext = !input.explicitTargetProvided && input.dirtyScope?.requested === true && input.dirtyScope.mode === "edit" &&
    input.dirtyScope.canPlan === true && (input.dirtyScope.plannedEditTargets?.length ?? 0) > 0 && (packetVerdict === undefined || packetVerdict === "edit-ready");
  const editable = !input.explicitTargetInvalid && (input.explicitTargetProvided || highConfidenceContext || dirtyWorktreeContext);
  const missingAnchors = uniqueSorted([
    ...(input.intentConfidence?.missingAnchors ?? []),
    ...(input.explicitTargetProvided || dirtyWorktreeContext ? [] : ["file-or-symbol-target"]),
    ...(highConfidenceContext || input.explicitTargetProvided || dirtyWorktreeContext ? [] : ["edit-ready-context"]),
    ...(input.dirtyScope?.requested && !input.dirtyScope.canPlan ? ["known-dirty-worktree-scope"] : []),
    ...(input.explicitTargetInvalid ? ["resolved-file-or-symbol-target"] : [])
  ]);
  const reason = input.explicitTargetInvalid ? "one or more explicit targets are missing, ambiguous, or not authorized as new destinations"
    : input.explicitTargetProvided ? "explicit file or symbol target provided"
    : dirtyWorktreeContext ? `current dirty worktree explicitly requested as edit scope (${input.dirtyScope?.plannedEditTargets?.length ?? 0} file(s))`
      : highConfidenceContext ? "high-confidence evidence-backed packet"
        : packetVerdict === "raw-search-better" ? "raw search is likely a cleaner first pass than this broad packet"
          : packetVerdict === "needs-target" ? "broad change plan needs an explicit file or symbol target"
            : qualityLevel === "low" ? "context quality is low" : "packet is not edit-ready without an explicit file or symbol target";
  return {
    editable,
    status: editable ? "edit-ready" : "orientation-only",
    reason,
    source: editable && input.explicitTargetProvided ? "explicit-target" : editable && dirtyWorktreeContext ? "dirty-worktree" : editable && highConfidenceContext ? "high-confidence-context" : "insufficient-context",
    explicitTargetProvided: input.explicitTargetProvided,
    packetVerdict,
    qualityLevel,
    confidence: input.intentConfidence?.confidence,
    recommendedNextTool: editable ? undefined : input.intentConfidence?.recommendedNextTool ?? (packetVerdict === "raw-search-better" || packetVerdict === "needs-target" ? "search" : "task_brief"),
    missingAnchors,
    snapshotBlocked: Boolean(input.input.saveSnapshot && !editable)
  };
}

export async function resolveChangePlanFollowBaseInput(repoRoot: string, input: ChangePlanInput): Promise<{ input?: ChangePlanInput; snapshotLoad?: TaskSnapshotLoadResult; reason?: string }> {
  const directInput = withoutFollowCandidate(input);
  if (!input.taskId && hasChangePlanReplaySeed(directInput)) return { input: directInput };
  const snapshotLoad = await loadTaskSnapshot(repoRoot, input.taskId);
  if (snapshotLoad.missingReason === "blocked-plan" && snapshotLoad.blockedSnapshot?.input) {
    return { input: { ...withoutFollowCandidate(snapshotLoad.blockedSnapshot.input), taskId: snapshotLoad.blockedSnapshot.taskId, saveSnapshot: true }, snapshotLoad };
  }
  if (hasChangePlanReplaySeed(directInput)) return { input: directInput, snapshotLoad };
  if (snapshotLoad.missingReason === "blocked-plan") return { snapshotLoad, reason: "blocked change-plan marker does not include replayable input" };
  if (snapshotLoad.snapshot) return { snapshotLoad, reason: "requested task already has an edit-ready snapshot; followCandidate only applies to blocked orientation plans" };
  return { snapshotLoad, reason: snapshotLoad.missingReason ? `no blocked change-plan input available (${snapshotLoad.missingReason})` : "no blocked change-plan input available" };
}

export function normalizeTargetCandidateSelector(value: string | undefined): string | undefined {
  return value?.trim() || undefined;
}

function withoutFollowCandidate(input: ChangePlanInput): ChangePlanInput {
  const rest = { ...input };
  delete rest.followCandidate;
  return rest;
}

function hasChangePlanReplaySeed(input: ChangePlanInput): boolean {
  return Boolean(input.task?.trim() || input.query?.trim() || input.files?.length || input.symbols?.length);
}
