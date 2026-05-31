import type { PostEditCheckResult } from "../../post-edit-outcomes.js";
import type { TaskSnapshotLoadResult } from "../../task-snapshots.js";
import type {
  FileFact,
  SymbolFact,
  TaskSnapshot,
  TaskSnapshotRiskFile,
  TaskSnapshotSymbol,
  TestRecommendation,
  VerificationLedgerEntry
} from "../../types.js";
import type { ContextQuality } from "../quality.js";

export interface PostEditDecision {
  driftReasons: string[];
  verdict: "continue" | "run_tests" | "inspect" | "replan";
  missingWorkflowCheckCount: number;
  missingDependencyCheckCount: number;
  riskEscalationsCoveredByVerification: boolean;
  riskEscalationsNeedInspection: boolean;
  hasDegradedSnapshotTests: boolean;
}

export function postEditDecision(input: {
  snapshot: TaskSnapshot | undefined;
  loadedSnapshot: TaskSnapshotLoadResult;
  snapshotAmbiguity: string | undefined;
  worktreeDegradationReasons: string[];
  headChanged: boolean;
  unplannedEditedFiles: string[];
  unplannedChangedSymbols: Array<{ symbol: SymbolFact }>;
  unindexedEditedFiles: string[];
  symbolDeltas: Array<{ path: string; newSymbols: TaskSnapshotSymbol[]; removedSymbols: TaskSnapshotSymbol[] }>;
  riskDeltas: Array<{ path: string; before: TaskSnapshotRiskFile; after: TaskSnapshotRiskFile; delta: number }>;
  workflowChecks: PostEditCheckResult[];
  dependencyChecks: PostEditCheckResult[];
  degradedSnapshotTests: TestRecommendation[];
  quality: ContextQuality | undefined;
  riskEscalations: FileFact[];
  waivedVerification: VerificationLedgerEntry[];
  hasActualEditedFiles: boolean;
  testsNotRun: TestRecommendation[];
  hasTestVerificationAccounting: boolean;
  noVerificationProofForEditedFiles: boolean;
}): PostEditDecision {
  const missingWorkflowCheckCount = input.workflowChecks.filter((check) => check.status === "missing").length;
  const missingDependencyCheckCount = input.dependencyChecks.filter((check) => check.status === "missing").length;
  const riskEscalationsCoveredByVerification =
    input.riskEscalations.length > 0 &&
    input.unplannedEditedFiles.length === 0 &&
    input.testsNotRun.length === 0 &&
    input.hasTestVerificationAccounting &&
    missingWorkflowCheckCount === 0 &&
    missingDependencyCheckCount === 0 &&
    input.waivedVerification.length === 0;
  const riskEscalationsNeedInspection =
    input.hasActualEditedFiles && input.riskEscalations.length > 0 && !riskEscalationsCoveredByVerification;
  const hasDegradedSnapshotTests = input.degradedSnapshotTests.length > 0;
  const driftReasons = [
    !input.snapshot ? `missing task snapshot${input.loadedSnapshot.missingReason ? `: ${input.loadedSnapshot.missingReason}` : ""}` : undefined,
    input.snapshotAmbiguity ? input.snapshotAmbiguity : undefined,
    input.loadedSnapshot.missingReason === "invalid-json" ? input.loadedSnapshot.error : undefined,
    input.worktreeDegradationReasons.length > 0
      ? `worktree state unavailable (${input.worktreeDegradationReasons.join("; ")}); treat empty change set as unknown, not clean`
      : undefined,
    input.headChanged ? "git head changed since snapshot" : undefined,
    input.unplannedEditedFiles.length > 0 ? `${input.unplannedEditedFiles.length} edited file(s) outside planned scope` : undefined,
    input.unplannedChangedSymbols.length > 0 ? `${input.unplannedChangedSymbols.length} changed symbol(s) outside requested symbol target` : undefined,
    input.unindexedEditedFiles.length > 0 ? `${input.unindexedEditedFiles.length} changed-since-snapshot file(s) are not indexed` : undefined,
    input.symbolDeltas.some((delta) => delta.newSymbols.length > 0 || delta.removedSymbols.length > 0)
      ? `${input.symbolDeltas.reduce((sum, delta) => sum + delta.newSymbols.length + delta.removedSymbols.length, 0)} symbol delta(s) detected`
      : undefined,
    input.riskDeltas.some((delta) => delta.delta > 0) ? `${input.riskDeltas.filter((delta) => delta.delta > 0).length} file(s) increased risk` : undefined,
    missingWorkflowCheckCount > 0 ? `${missingWorkflowCheckCount} required workflow check(s) missing` : undefined,
    missingDependencyCheckCount > 0 ? `${missingDependencyCheckCount} required dependency check(s) missing` : undefined,
    hasDegradedSnapshotTests ? `${input.degradedSnapshotTests.length} planned snapshot test(s) degraded by provenance` : undefined,
    input.quality?.level === "low" ? "low context quality after edit" : undefined,
    riskEscalationsNeedInspection ? `${input.riskEscalations.length} high-risk or unplanned target(s)` : undefined,
    input.waivedVerification.length > 0 ? `${input.waivedVerification.length} verification item(s) explicitly waived` : undefined,
    input.hasActualEditedFiles && input.testsNotRun.length > 0 && !input.hasTestVerificationAccounting
      ? "recommended tests have not been accounted for"
      : undefined,
    input.hasActualEditedFiles && input.testsNotRun.length > 0 && input.hasTestVerificationAccounting ? `${input.testsNotRun.length} recommended test(s) remain unaccounted for` : undefined,
    input.noVerificationProofForEditedFiles ? "edited files have no credible verification evidence" : undefined
  ].filter((reason): reason is string => Boolean(reason));
  const verdict: PostEditDecision["verdict"] =
    input.headChanged || input.unplannedEditedFiles.length >= 3 || input.quality?.level === "low"
      ? "replan"
      : !input.snapshot ||
          input.worktreeDegradationReasons.length > 0 ||
            input.unplannedEditedFiles.length > 0 ||
            Boolean(input.snapshotAmbiguity) ||
            input.unplannedChangedSymbols.length > 0 ||
            missingWorkflowCheckCount > 0 ||
            missingDependencyCheckCount > 0 ||
            hasDegradedSnapshotTests ||
            input.waivedVerification.length > 0 ||
            input.noVerificationProofForEditedFiles ||
            riskEscalationsNeedInspection ||
            input.quality?.level === "medium"
        ? "inspect"
        : input.hasActualEditedFiles && input.testsNotRun.length > 0
          ? "run_tests"
          : "continue";
  return {
    driftReasons,
    verdict,
    missingWorkflowCheckCount,
    missingDependencyCheckCount,
    riskEscalationsCoveredByVerification,
    riskEscalationsNeedInspection,
    hasDegradedSnapshotTests
  };
}
