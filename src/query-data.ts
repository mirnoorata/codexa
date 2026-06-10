import type { ChangePlanData, CodexaQueryData, ContextPacketData, FocusBriefData, PostEditReviewData, QueryResultMode, TestPlanData } from "./types.js";

const typedCompactionModes = new Set<QueryResultMode>(["context_pack", "task_brief", "focus_brief", "session_context", "change_plan", "post_edit_review", "test_plan"]);

export function asCodexaQueryData(value: unknown, inferredMode?: string): CodexaQueryData | undefined {
  const record = queryRecord(value);
  if (!record) {
    return undefined;
  }
  const mode = queryResultMode(record.mode) ?? queryResultMode(inferredMode);
  if (!mode || !typedCompactionModes.has(mode)) {
    return undefined;
  }
  const data = { ...record, mode };
  switch (mode) {
    case "context_pack":
    case "task_brief":
      return isContextPacketData(data) ? (data as ContextPacketData) : undefined;
    case "focus_brief":
    case "session_context":
      return isFocusBriefData(data) ? (data as FocusBriefData) : undefined;
    case "change_plan":
      return isChangePlanData(data) ? (data as ChangePlanData) : undefined;
    case "post_edit_review":
      return isPostEditReviewData(data) ? (data as PostEditReviewData) : undefined;
    case "test_plan":
      return isTestPlanData(data) ? (data as TestPlanData) : undefined;
    default:
      return undefined;
  }
}

export function asPostEditReviewData(value: unknown): PostEditReviewData | undefined {
  const data = asCodexaQueryData(value, "post_edit_review");
  return data?.mode === "post_edit_review" ? data : undefined;
}

export function queryResultMode(value: unknown): QueryResultMode | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  return typedCompactionModes.has(value as QueryResultMode) ? (value as QueryResultMode) : undefined;
}

function isContextPacketData(value: Record<string, unknown>): boolean {
  return arraysOrUndefined(value, ["focusFiles", "changedFiles", "changedEntries", "changedSymbols", "unindexedChanged", "groups", "tests", "snippets", "contextSources", "nextReads"]);
}

function isFocusBriefData(value: Record<string, unknown>): boolean {
  return arraysOrUndefined(value, ["focusFiles", "workflows", "modules", "groups", "tests"]);
}

function isChangePlanData(value: Record<string, unknown>): boolean {
  return arraysOrUndefined(value, ["targetCandidates", "steps", "files", "plannedEditTargets", "tests", "recipes", "requiredWorkflowChecks", "requiredDependencyChecks"]);
}

function isPostEditReviewData(value: Record<string, unknown>): boolean {
  return arraysOrUndefined(value, [
    "files",
    "changedSinceSnapshot",
    "changedGroups",
    "resolvedBaselineFiles",
    "unplannedEditedFiles",
    "plannedRenames",
    "unplannedChangedSymbols",
    "plannedButUntouchedFiles",
    "symbolDeltas",
    "modifiedSymbols",
    "modifiedPublicSymbols",
    "riskDeltas",
    "affectedEdges",
    "affectedTests",
    "tests",
    "degradedSnapshotTests",
    "supersededDegradedSnapshotTests",
    "testsNotRun",
    "missedLikelyTests",
    "ranTests",
    "ranCommands",
    "ranCommandReports",
    "commandEnvelopes",
    "waivedChecks",
    "waivers",
    "verificationCoverage",
    "verificationLedger",
    "waivedVerification",
    "unindexedEditedFiles",
    "riskEscalations",
    "workflows",
    "workflowChecks",
    "dependencyChecks",
    "driftReasons",
    "nextActions",
    "autoVerifyCandidates",
    "autoVerifyRunnerEvidence"
  ]);
}

function isTestPlanData(value: Record<string, unknown>): boolean {
  return arraysOrUndefined(value, [
    "changedFiles",
    "changedEntries",
    "changedSymbols",
    "unindexedChanged",
    "groups",
    "tests",
    "verificationCommands",
    "verificationCoverage",
    "verificationCommandPlan",
    "commandEnvelopes",
    "verificationLedgerPreview",
    "verificationLedger",
    "testsNotRun"
  ]);
}

function arraysOrUndefined(value: Record<string, unknown>, keys: string[]): boolean {
  return keys.every((key) => value[key] === undefined || Array.isArray(value[key]));
}

function queryRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}
