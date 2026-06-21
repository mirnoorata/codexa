import type { PostEditCheckResult, PostEditCompletionAuthority, PostEditInspectMode } from "../../post-edit-outcomes.js";
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

const ADVISORY_UNINDEXED_FILE_PATTERN =
  /\.(?:avif|bmp|css|gif|ico|ini|jpe?g|jsonc?|less|lock|mdx?|otf|pcss|png|postcss|rst|sass|scss|svg|toml|ttf|txt|webp|woff2?|ya?ml)$/iu;
const ADVISORY_UNINDEXED_BASENAME_PATTERN = /(^|\/)(?:dockerfile|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb)$/iu;

export interface PostEditDecision {
  driftReasons: string[];
  verdict: "continue" | "run_tests" | "inspect" | "replan";
  inspectMode: PostEditInspectMode;
  inspectReasons: string[];
  completionAuthority: PostEditCompletionAuthority;
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
  // True for hook-saved implicit baselines. An implicit baseline is not a
  // plan: a commit during the session is normal work, not drift, so
  // headChanged must not escalate to replan or a blocking inspect.
  implicitBaseline: boolean;
}): PostEditDecision {
  const missingWorkflowCheckCount = input.workflowChecks.filter((check) => check.status === "missing").length;
  const missingDependencyCheckCount = input.dependencyChecks.filter((check) => check.status === "missing").length;
  const blockingUnindexedEditedFiles = input.unindexedEditedFiles.filter((filePath) => !isAdvisoryUnindexedEditedFile(filePath));
  const advisoryUnindexedEditedFiles = input.unindexedEditedFiles.filter((filePath) => isAdvisoryUnindexedEditedFile(filePath));
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
    input.headChanged
      ? input.implicitBaseline
        ? "git head changed since the implicit baseline (a commit during the session; informational)"
        : "git head changed since snapshot"
      : undefined,
    input.unplannedEditedFiles.length > 0 ? `${input.unplannedEditedFiles.length} edited file(s) outside planned scope` : undefined,
    input.unplannedChangedSymbols.length > 0 ? `${input.unplannedChangedSymbols.length} changed symbol(s) outside requested symbol target` : undefined,
    input.unindexedEditedFiles.length > 0 ? `${input.unindexedEditedFiles.length} changed-since-snapshot file(s) lack indexed source/symbol context` : undefined,
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
  const headChangedBlocking = input.headChanged && !input.implicitBaseline;
  // Quality-low likewise floors at inspect for implicit baselines: "replan"
  // is advice about a plan, and an implicit baseline carries none.
  const qualityLowReplan = input.quality?.level === "low" && !input.implicitBaseline;
  const verdict: PostEditDecision["verdict"] =
    headChangedBlocking || input.unplannedEditedFiles.length >= 3 || qualityLowReplan
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
            input.quality?.level === "medium" ||
            input.quality?.level === "low"
        ? "inspect"
        : input.hasActualEditedFiles && input.testsNotRun.length > 0
          ? "run_tests"
          : "continue";
  const inspect = inspectClassification(verdict, {
    snapshot: input.snapshot,
    snapshotAmbiguity: input.snapshotAmbiguity,
    worktreeDegradationReasons: input.worktreeDegradationReasons,
    headChanged: headChangedBlocking,
    unplannedEditedFiles: input.unplannedEditedFiles,
    unplannedChangedSymbols: input.unplannedChangedSymbols,
    blockingUnindexedEditedFiles,
    advisoryUnindexedEditedFiles,
    symbolDeltas: input.symbolDeltas,
    riskDeltas: input.riskDeltas,
    missingWorkflowCheckCount,
    missingDependencyCheckCount,
    hasDegradedSnapshotTests,
    quality: input.quality,
    riskEscalationsNeedInspection,
    waivedVerification: input.waivedVerification,
    noVerificationProofForEditedFiles: input.noVerificationProofForEditedFiles
  });
  return {
    driftReasons,
    verdict,
    inspectMode: inspect.mode,
    inspectReasons: inspect.reasons,
    completionAuthority: completionAuthority(verdict, inspect.mode),
    missingWorkflowCheckCount,
    missingDependencyCheckCount,
    riskEscalationsCoveredByVerification,
    riskEscalationsNeedInspection,
    hasDegradedSnapshotTests
  };
}

function isAdvisoryUnindexedEditedFile(filePath: string): boolean {
  return ADVISORY_UNINDEXED_FILE_PATTERN.test(filePath) || ADVISORY_UNINDEXED_BASENAME_PATTERN.test(filePath);
}

function inspectClassification(
  verdict: PostEditDecision["verdict"],
  input: {
    snapshot: TaskSnapshot | undefined;
    snapshotAmbiguity: string | undefined;
    worktreeDegradationReasons: string[];
    headChanged: boolean;
    unplannedEditedFiles: string[];
    unplannedChangedSymbols: Array<{ symbol: SymbolFact }>;
    blockingUnindexedEditedFiles: string[];
    advisoryUnindexedEditedFiles: string[];
    symbolDeltas: Array<{ path: string; newSymbols: TaskSnapshotSymbol[]; removedSymbols: TaskSnapshotSymbol[] }>;
    riskDeltas: Array<{ path: string; before: TaskSnapshotRiskFile; after: TaskSnapshotRiskFile; delta: number }>;
    missingWorkflowCheckCount: number;
    missingDependencyCheckCount: number;
    hasDegradedSnapshotTests: boolean;
    quality: ContextQuality | undefined;
    riskEscalationsNeedInspection: boolean;
    waivedVerification: VerificationLedgerEntry[];
    noVerificationProofForEditedFiles: boolean;
  }
): { mode: PostEditInspectMode; reasons: string[] } {
  if (verdict !== "inspect") {
    return { mode: "none", reasons: [] };
  }
  const blockingReasonsWithoutQuality = [
    input.headChanged ? "snapshot commit changed" : undefined,
    input.worktreeDegradationReasons.length > 0 ? "worktree state unavailable" : undefined,
    input.unplannedEditedFiles.length > 0 ? "edited files outside planned scope" : undefined,
    input.unplannedChangedSymbols.length > 0 ? "changed symbols outside requested symbol target" : undefined,
    input.blockingUnindexedEditedFiles.length > 0 ? "source-like edited files are not indexed" : undefined,
    input.missingWorkflowCheckCount > 0 ? "required workflow checks missing" : undefined,
    input.missingDependencyCheckCount > 0 ? "required dependency checks missing" : undefined,
    input.riskEscalationsNeedInspection ? "high-risk target lacks complete verification accounting" : undefined,
    input.waivedVerification.length > 0 ? "verification was waived" : undefined,
    input.noVerificationProofForEditedFiles ? "edited files have no credible verification evidence" : undefined
  ].filter((reason): reason is string => Boolean(reason));
  const qualityBlockingReason =
    input.quality?.level === "low" ? "context quality is low" : input.quality?.level === "medium" && blockingReasonsWithoutQuality.length > 0 ? "context quality is not high" : undefined;
  const blockingReasons = [...blockingReasonsWithoutQuality, qualityBlockingReason].filter((reason): reason is string => Boolean(reason));
  if (blockingReasons.length > 0) {
    return { mode: "blocking", reasons: blockingReasons };
  }

  const advisoryReasons = [
    !input.snapshot ? "no saved task snapshot" : undefined,
    input.snapshotAmbiguity ? "latest snapshot was ambiguous" : undefined,
    input.advisoryUnindexedEditedFiles.length > 0 ? "edited non-source files lack symbol ranges" : undefined,
    input.hasDegradedSnapshotTests ? "planned snapshot tests have degraded provenance" : undefined,
    input.symbolDeltas.some((delta) => delta.newSymbols.length > 0 || delta.removedSymbols.length > 0) ? "symbol inventory changed" : undefined,
    input.riskDeltas.some((delta) => delta.delta > 0) ? "risk score changed but blocking risk checks are covered" : undefined,
    input.quality?.level === "medium" ? "context quality is medium" : undefined
  ].filter((reason): reason is string => Boolean(reason));
  return { mode: "advisory", reasons: advisoryReasons.length > 0 ? advisoryReasons : ["inspect is advisory; no blocking drift signal was found"] };
}

function completionAuthority(verdict: PostEditDecision["verdict"], inspectMode: PostEditInspectMode): PostEditCompletionAuthority {
  if (verdict === "replan") {
    return "replan_required";
  }
  if (verdict === "run_tests") {
    return "tests_required";
  }
  if (verdict === "inspect") {
    return inspectMode === "blocking" ? "blocking_inspect" : "advisory_inspect";
  }
  return "complete";
}
