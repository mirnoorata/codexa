import { promises as fs } from "node:fs";
import path from "node:path";
import { buildPostEditComplexityReview, formatComplexityReview } from "./complexity.js";
import { groupDiffImpact, formatDiffGroups, formatGaps, indexGaps } from "./diff.js";
import { clampInt, fitLinesToTokenBudget, formatReasons } from "./formatting.js";
import { affectedWorkflowGraphEdges, testsFromGraphEdges } from "./graph.js";
import { focusBriefQuery } from "./context.js";
import { formatContextQuality } from "./quality.js";
import {
  assertFreshnessAuthorityCurrent,
  FreshnessAuthorityChangedError,
  freshnessAuthorityBlockReason,
  freshnessBanner
} from "./runtime.js";
import { ensureQuerySession, type QuerySessionInput } from "./session.js";
import { normalizeSearchText } from "./search.js";
import { formatTestRecommendations, narrowTestRecommendationsByChangeType, recommendTests, uniqueTests } from "./tests.js";
import { normalizeInputPaths, resolveFileTarget } from "./targets.js";
import { formatVerificationCoverage, formatVerificationLedger, verificationEvidenceForCommandReports, verificationLedgerForPostEdit } from "./verification.js";
import {
  sanitizeCommandEnvelopeForDisplay,
  sanitizeCommandReportForDisplay,
  sanitizeCommandText,
  sanitizeCoverageForDisplay,
  sanitizeLedgerForDisplay,
  sanitizeSummary,
  type DisplayCommandReport
} from "./verification-display.js";
import { evaluateRequiredChecks } from "./required-checks.js";
import { isCodexaControlPath, formatChangedEntry } from "./worktree.js";
import { postEditDirtyScope } from "./post-edit/dirty-scope.js";
import { postEditNextActions, postEditStructuredNextTools } from "./post-edit/next-actions.js";
import { compactSnapshotTests, reconcileSnapshotTests, snapshotRiskBaseline, snapshotSymbolBaseline } from "./post-edit/snapshot-contract.js";
import { buildPostEditOutcome, type PostEditCheckResult, type PostEditOutcomeInput } from "../post-edit-outcomes.js";
import { MAX_POST_EDIT_REVIEW_TARGETS_PER_PASS } from "../post-edit-review-coverage.js";
import { pointerForSessionMemory, readSessionMemory } from "../session-memory.js";
import { loadTaskSnapshot, saveBlockedTaskSnapshot, saveTaskSnapshot, type TaskSnapshotLoadResult } from "../task-snapshots.js";
import { CURRENT_VERIFICATION_PROVENANCE } from "../types.js";
import type { SemanticRetrievalSummary } from "../semantic-retrieval.js";
import type { AutoVerifyCommandReport } from "../autoverify.js";
import type {
  ChangedFileEntry,
  ChangePlanInput,
  ChangeType,
  CodexaIndex,
  FileFact,
  FreshnessInfo,
  GraphEdgeFact,
  PostEditReviewInput,
  QueryOptions,
  QueryResult,
  RefreshInfo,
  SymbolFact,
  TaskSnapshot,
  TaskSnapshotRiskFile,
  TaskSnapshotSymbol,
  TestRecommendation,
  VerificationCommandEnvelope,
  VerificationCommandReport,
  WorkflowTraceFact
} from "../types.js";
import { limitText, stableId, uniqueSorted } from "../util.js";
import { reviewTrustedRunnerReports, stripRunnerMetadata, type AutoVerifyRunnerReviewEntry } from "./post-edit/runner-review.js";
import { reviewTaskInvariants } from "../task-lifecycle.js";
import { buildPostEditLifecycleDecision, formatPostEditLifecycle, persistPostEditLifecycleOutcome, postEditLifecycleData, type PostEditLifecycleInput } from "./post-edit/lifecycle.js";
import { buildAutoVerifyCandidates, buildPostEditReviewCoverage, compactContextData, compactSnapshotForData, formatPostEditReviewCoverage, hasRelevantVerificationEvidence, limitArray, stableSessionMemoryHash } from "./post-edit/support.js";
import { applyArtifactRequiredChecks, failedVerificationArtifactIds, formatPostEditArtifacts } from "./post-edit/artifacts.js";
import { postEditExplicitSymbolTargets, postEditReviewContext, postEditReviewPasses, type PostEditReviewContextData } from "./post-edit/context-passes.js";
import { evaluateVerificationArtifacts, loadVerificationArtifacts } from "../verification-artifacts.js";
import { validateArtifactIds } from "../lifecycle-contract.js";
import { buildChangeEvidenceChains, formatChangeEvidenceChains } from "./change-plan/evidence-chains.js";
import { workflowMatchesAnyPath } from "../workflow-membership.js";
interface PostEditReviewInternalInput { trustedRunnerReports?: AutoVerifyCommandReport[]; }

export async function postEditReviewQuery(
  sessionInput: QuerySessionInput,
  input: PostEditReviewInput = {},
  options: QueryOptions = {}
): Promise<QueryResult> {
  return postEditReviewQueryInternal(sessionInput, input, options, {});
}
export async function postEditReviewWithTrustedRunnerReports(
  sessionInput: QuerySessionInput,
  input: PostEditReviewInput = {},
  trustedRunnerReports: AutoVerifyCommandReport[] = [],
  options: QueryOptions = {}
): Promise<QueryResult> {
  return postEditReviewQueryInternal(sessionInput, input, options, { trustedRunnerReports });
}

async function postEditReviewQueryInternal(
  sessionInput: QuerySessionInput,
  input: PostEditReviewInput,
  options: QueryOptions,
  internal: PostEditReviewInternalInput
): Promise<QueryResult> {
  const session = await ensureQuerySession(sessionInput, options);
  const { index, freshness, refresh, repoRoot } = session;
  const indexedFileByPath = new Map(index.files.map((file) => [file.path, file]));
  const tokenBudget = clampInt(input.tokenBudget ?? 2800, 600, 10000);
  const limit = clampInt(
    input.limit ?? 10,
    3,
    Math.min(MAX_POST_EDIT_REVIEW_TARGETS_PER_PASS, session.maxResults)
  );
  const loadedSnapshot = await loadTaskSnapshot(repoRoot, input.taskId);
  if (loadedSnapshot.missingReason === "invalid-json" && /^task lifecycle\b/iu.test(loadedSnapshot.error ?? "")) {
    throw new Error(loadedSnapshot.error);
  }
  const snapshot = loadedSnapshot.snapshot;
  const freshnessBlockReason = freshnessAuthorityBlockReason(freshness);
  if (freshnessBlockReason) {
    return postEditFreshnessBlockedResult({ freshness, refresh, repoRoot, input, loadedSnapshot, reason: freshnessBlockReason });
  }
  const snapshotAmbiguity = !input.taskId && snapshot ? await latestSnapshotAmbiguity(repoRoot, snapshot.taskId) : undefined;
  const currentEntries = await session.getChangedFileEntries();
  const dirtyScope = postEditDirtyScope({ snapshot, currentEntries, freshness, index });
  const { currentDirtyPaths, changedSinceSnapshot, resolvedBaselineFiles, editPaths, unindexedEditedFiles } = dirtyScope;
  const editPathSet = new Set(editPaths);
  const currentDirtyPathSet = new Set(currentDirtyPaths);
  const changedSymbols = (await session.getChangedSymbols()).filter((entry) => editPathSet.has(entry.symbol.path));
  const requestedSymbolNames = new Set([...(snapshot?.input.symbols ?? []), ...(input.symbols ?? [])].map(normalizeSearchText));
  const plannedSymbolIds = requestedSymbolIds(snapshot, requestedSymbolNames);
  const unplannedChangedSymbols =
    requestedSymbolNames.size > 0 && plannedSymbolIds.size > 0
      ? changedSymbols.filter((entry) => !plannedSymbolIds.has(entry.symbol.id) && plannedScopeContainsSymbolFile(snapshot, entry.symbol.path))
      : [];
  const changedGroups = groupDiffImpact(index, changedSinceSnapshot, changedSymbols, unindexedEditedFiles);
  const explicitFiles = normalizeInputPaths(input.files ?? [], repoRoot);
  const { resolvedFiles: explicitSymbolFiles, unresolvedTargets: unresolvedExplicitSymbolTargets } =
    postEditExplicitSymbolTargets(index, input.symbols);
  const plannedScope = snapshot ? (snapshot.plannedEditTargets.length > 0 ? snapshot.plannedEditTargets : snapshot.plannedFiles) : [];
  const plannedScopeSet = new Set(plannedScope);
  const plannedRenames = snapshot
    ? changedSinceSnapshot.filter((entry) => entry.oldPath && plannedScopeSet.has(entry.oldPath) && !plannedScopeSet.has(entry.path))
    : [];
  const unplannedEditedFiles =
    snapshot && plannedScopeSet.size > 0
      ? changedSinceSnapshot
          .filter((entry) => !isCodexaControlPath(entry.path))
          .filter((entry) => !plannedScopeSet.has(entry.path) && !(entry.oldPath && plannedScopeSet.has(entry.oldPath)))
          .map((entry) => entry.path)
      : [];
  const unplannedEditedFileSet = new Set(unplannedEditedFiles);
  const renamedAwayPaths = new Set(changedSinceSnapshot.flatMap((entry) => (entry.oldPath ? [entry.oldPath] : [])));
  const plannedButUntouchedFiles = snapshot
    ? plannedScope.filter((filePath) => !editPathSet.has(filePath) && !currentDirtyPathSet.has(filePath) && !renamedAwayPaths.has(filePath))
    : [];
  const headChanged = Boolean(snapshot && snapshot.dirtyBaseline.headCommit !== freshness.headCommit);
  const task = input.task ?? snapshot?.task ?? "Post-edit review";
  const effectiveTaskId = snapshot?.taskId ?? loadedSnapshot.latestTaskId ?? input.taskId;
  const planRevision = snapshot?.planRevision ?? 1;
  const invariants = snapshot?.invariants ?? [];
  const invariantReview = reviewTaskInvariants(invariants, input.invariantReviews);
  const changeType = input.changeType ?? snapshot?.changeType ?? "unknown";
  // Priority order, then cap: actually-edited files must never be dropped
  // in favor of alphabetically-earlier explicit inputs (uniqueSorted+slice
  // did exactly that, silently shrinking verdict-relevant test accounting).
  const reviewTargetPool = [
    ...editPaths,
    ...explicitFiles,
    ...explicitSymbolFiles,
    ...unresolvedExplicitSymbolTargets,
    ...(editPaths.length === 0 && explicitFiles.length === 0 && explicitSymbolFiles.length === 0 && snapshot ? snapshot.plannedFiles.slice(0, limit) : [])
  ];
  const seenReviewTargets = new Set<string>();
  const orderedReviewTargets: string[] = [];
  for (const target of reviewTargetPool) {
    if (!seenReviewTargets.has(target)) {
      seenReviewTargets.add(target);
      orderedReviewTargets.push(target);
    }
  }
  const reviewPasses = postEditReviewPasses(orderedReviewTargets, limit);
  const reviewContext = await postEditReviewContext({
    session,
    task,
    reviewPasses,
    unresolvedTargets: unresolvedExplicitSymbolTargets,
    symbols: input.symbols,
    changeType,
    includeDiff: !snapshot,
    tokenBudget,
    limit,
    includeSnippets: input.includeSnippets ?? false,
    options
  });
  const context = reviewContext.context;
  const reviewTargets = reviewContext.analyzedTargets;
  const contextData = context.data as PostEditReviewContextData;
  const semanticReviewContext = contextData.retrieval?.semantic;
  const priorSessionMemory = await readSessionMemory({
    repoRoot,
    taskId: effectiveTaskId,
    files: reviewTargets,
    kinds: ["claim", "ruled_out", "open_question", "decision"],
    freshness,
    limit: 8,
    includeStale: true
  }).catch(() => undefined);
  const selectedFiles = [...new Set([...reviewTargets, ...(contextData.focusFiles ?? []).map((entry) => entry.file.path)])];
  const authorityPaths = uniqueSorted([...reviewTargets, ...editPaths]);
  const reviewTargetSet = new Set(reviewTargets);
  const symbolDeltas = compareSnapshotSymbols(snapshot, index, authorityPaths);
  const modifiedSymbols = changedSymbols
    .map((entry) => `${entry.symbol.qualifiedName} (${entry.symbol.kind}) in ${entry.symbol.path}`)
    .sort((a, b) => a.localeCompare(b));
  const modifiedPublicSymbols = changedSymbols
    .filter((entry) => entry.symbol.exported || ["route", "node"].includes(entry.symbol.kind))
    .map((entry) => `${entry.symbol.qualifiedName} (${entry.symbol.kind}) in ${entry.symbol.path}`)
    .sort((a, b) => a.localeCompare(b));
  const riskDeltas = compareSnapshotRisks(snapshot, index, authorityPaths);
  const affectedEdges = affectedWorkflowGraphEdges(index, reviewTargets);
  const affectedTests = uniqueSorted([
    ...testsFromGraphEdges(affectedEdges),
    ...index.testEdges.filter((edge) => edge.targetPath && reviewTargetSet.has(edge.targetPath)).map((edge) => edge.path)
  ]);
  const reviewScope = reviewTargets.length > 0 ? reviewTargets : currentDirtyPaths;
  const snapshotTestScope = snapshot ? (snapshot.plannedEditTargets.length > 0 ? snapshot.plannedEditTargets : snapshot.plannedFiles) : [];
  const freshReviewTests = recommendTests(index, reviewScope, repoRoot, changeType);
  const freshReviewTestPaths = new Set(
    [...(contextData.tests ?? []), ...freshReviewTests]
      .filter((test) => test.provenance?.degraded !== true)
      .map((test) => test.path)
  );
  const reconciledSnapshotTests = reconcileSnapshotTests(snapshot?.plannedTests ?? [], reviewScope, snapshotTestScope);
  const degradedSnapshotTests = reconciledSnapshotTests.degraded.filter((test) => !freshReviewTestPaths.has(test.path));
  const supersededDegradedSnapshotTests = reconciledSnapshotTests.degraded.filter((test) => freshReviewTestPaths.has(test.path));
  const mergedTests = uniqueTests([
    ...reconciledSnapshotTests.trusted,
    ...(contextData.tests ?? []),
    ...freshReviewTests
  ]);
  const tests = narrowTestRecommendationsByChangeType(
    mergedTests,
    reviewScope,
    changeType
  );
  const evidenceChains = buildChangeEvidenceChains({
    index,
    task,
    anchors: reviewTargets.map((filePath) => ({
      path: filePath,
      authority: editPathSet.has(filePath) ? "observed-edit" as const : "explicit-target" as const
    })),
    editTargets: snapshot && snapshot.origin !== "hook-implicit" ? snapshot.plannedEditTargets : [],
    tests,
    freshness
  });
  const ranTests = input.ranTests ?? [];
  const ranCommands = input.ranCommands ?? [];
  const manualRanCommandReports = (input.ranCommandReports ?? []).map(stripRunnerMetadata);
  const runnerReview = await reviewTrustedRunnerReports(internal.trustedRunnerReports ?? [], {
    freshness,
    snapshot,
    repoRoot
  });
  const displayedRanCommandReports = [...manualRanCommandReports, ...runnerReview.displayReports];
  const waivedChecks = input.waivedChecks ?? [];
  const waivers = input.waivers ?? [];
  const preliminaryVerificationCoverage = verificationEvidenceForCommandReports(index, ranCommands, manualRanCommandReports, repoRoot, {
    trustedCommandReports: runnerReview.coveringReports
  }).coverage;
  const hasActualEditedFiles = editPaths.length > 0;
  const riskEscalations = reviewTargets
    .map((filePath) => indexedFileByPath.get(filePath))
    .filter((file): file is FileFact => Boolean(file))
    .filter((file) => file.riskScore >= 4 || unplannedEditedFileSet.has(file.path))
    .sort((a, b) => b.riskScore - a.riskScore || b.rank - a.rank || a.path.localeCompare(b.path));
  const workflows = index.workflows
    .filter((workflow) => workflowMatchesAnyPath(workflow, reviewTargetSet, index))
    .sort((a, b) => b.rank - a.rank || a.title.localeCompare(b.title));
  const rawWorkflowChecks = evaluateRequiredChecks(snapshot?.requiredWorkflowChecks ?? [], {
    editPaths,
    reviewTargets,
    selectedFiles,
    workflows,
    affectedEdges,
    affectedTests,
    tests,
    ranTests,
    verificationCoverage: preliminaryVerificationCoverage
  });
  const rawDependencyChecks = evaluateRequiredChecks(snapshot?.requiredDependencyChecks ?? [], {
    editPaths,
    reviewTargets,
    selectedFiles,
    workflows,
    affectedEdges,
    affectedTests,
    tests,
    ranTests,
    verificationCoverage: preliminaryVerificationCoverage
  });
  const artifactIds = validateArtifactIds(input.artifactIds) ?? [];
  const verificationArtifacts = evaluateVerificationArtifacts(await loadVerificationArtifacts(repoRoot, artifactIds), {
    taskId: effectiveTaskId,
    freshness,
    requiredChecks: [
      ...(snapshot?.requiredWorkflowChecks ?? []).map((check) => ({ kind: check.kind, target: check.target })),
      ...(snapshot?.requiredDependencyChecks ?? []).map((check) => ({ kind: check.kind, target: check.target }))
    ]
  });
  const workflowChecks = applyArtifactRequiredChecks(rawWorkflowChecks, verificationArtifacts);
  const dependencyChecks = applyArtifactRequiredChecks(rawDependencyChecks, verificationArtifacts);
  const failedArtifactIds = failedVerificationArtifactIds(verificationArtifacts);
  const selectedArtifactIds = verificationArtifacts.selected.map((artifact) => artifact.artifactId).sort();
  const verification = verificationLedgerForPostEdit({
    index,
    tests,
    ranTests,
    ranCommands,
    ranCommandReports: manualRanCommandReports,
    trustedCommandReports: runnerReview.coveringReports,
    waivedChecks,
    waivers,
    repoRoot,
    workflowChecks,
    dependencyChecks
  });
  const verificationCoverage = verification.coverage;
  const reviewCoverage = buildPostEditReviewCoverage({
    candidateTargets: orderedReviewTargets, analyzedTargets: reviewTargets, targetLimit: limit,
    analysisPassCount: Math.max(1, Math.ceil(reviewTargets.length / limit)),
    taskId: effectiveTaskId ?? null, planRevision, snapshotCreatedAt: snapshot?.createdAt ?? null,
    snapshotPublicationSequence: snapshot?.publicationSequence ?? null
  });
  const commandEnvelopes = verification.commandEnvelopes;
  const verificationLedger = verification.ledger;
  const testsNotRun = verification.testsNotRun;
  const waivedVerification = verificationLedger.filter((entry) => entry.status === "waived");
  const dataRanCommandReports = displayedRanCommandReports.map((report) => sanitizeCommandReportForDisplay(report, repoRoot));
  const dataRanCommands = ranCommands.map((command) => sanitizeCommandText(command, repoRoot));
  const dataCommandEnvelopes = commandEnvelopes.map((envelope) => sanitizeCommandEnvelopeForDisplay(envelope, repoRoot));
  const dataVerificationCoverage = verificationCoverage.map((entry) => sanitizeCoverageForDisplay(entry, repoRoot));
  const dataVerificationLedger = verificationLedger.map((entry) => sanitizeLedgerForDisplay(entry, repoRoot));
  const dataWaivedVerification = dataVerificationLedger.filter((entry) => entry.status === "waived");
  const missedLikelyTests = testsNotRun;
  const autoVerifyCandidates = buildAutoVerifyCandidates({
    snapshot,
    testsNotRun,
    reviewTargets,
    repoRoot
  });
  const hasTestVerificationAccounting = verificationLedger.some((entry) => entry.kind === "test" && (entry.status === "covered" || entry.status === "waived"));
  const hasCredibleVerificationEvidence = hasRelevantVerificationEvidence({
    verificationLedger,
    verificationCoverage,
    ranTests,
    tests,
    workflowChecks,
    dependencyChecks,
    reviewTargets,
    editPaths
  });
  const noVerificationProofForEditedFiles =
    hasActualEditedFiles && !hasCredibleVerificationEvidence && tests.length === 0 && workflowChecks.length === 0 && dependencyChecks.length === 0;
  const decisionInput = {
    snapshot,
    implicitBaseline: snapshot?.origin === "hook-implicit",
    loadedSnapshot,
    snapshotAmbiguity,
    worktreeDegradationReasons: session.worktreeDegradationReasons,
    headChanged,
    unplannedEditedFiles,
    unplannedChangedSymbols,
    unindexedEditedFiles,
    symbolDeltas,
    riskDeltas,
    workflowChecks,
    dependencyChecks,
    degradedSnapshotTests,
    quality: contextData.quality,
    riskEscalations,
    waivedVerification,
    hasActualEditedFiles,
    testsNotRun,
    hasTestVerificationAccounting,
    noVerificationProofForEditedFiles,
    reviewCoverage,
    reviewCoverageContext: {
      taskId: effectiveTaskId ?? null, planRevision, snapshotCreatedAt: snapshot?.createdAt ?? null,
      snapshotPublicationSequence: snapshot?.publicationSequence ?? null,
      candidateTargets: orderedReviewTargets, analyzedTargets: reviewTargets
    },
    missingInvariantCount: invariantReview.missing.length,
    violatedInvariantCount: invariantReview.violated.length,
    loopReplanReasons: []
  };
  const lifecycleTaskId = effectiveTaskId ?? stableId("unbound-post-edit-task", task);
  const lifecycleInput: PostEditLifecycleInput = {
    repoRoot,
    lifecycleTaskId,
    planRevision,
    decisionInput,
    currentEntries,
    modifiedSymbolCount: modifiedSymbols.length,
    invariantReview,
    verification: { ranTests, ranCommands, commandReports: dataRanCommandReports, reviewTargets, noVerificationProofForEditedFiles },
    changedFiles: editPaths,
    artifactIds: selectedArtifactIds,
    externalCheckFailedTargets: failedArtifactIds,
    expectedInvariants: invariants,
    requireExistingState: snapshot?.planRevision !== undefined,
    beforePersist: async () => {
      await assertFreshnessAuthorityCurrent(repoRoot, index, freshness);
    }
  };
  const previewLifecycle = await buildPostEditLifecycleDecision(lifecycleInput);
  const { decision: previewDecision, failureSignals: previewFailureSignals, diffFootprint: previewDiffFootprint, loopReview: previewLoopReview } = previewLifecycle;
  const {
    driftReasons: previewDriftReasons,
    verdict: previewVerdict,
    inspectMode: previewInspectMode,
    inspectReasons: previewInspectReasons,
    completionAuthority: previewCompletionAuthority
  } = previewDecision;
  const complexityReview = buildPostEditComplexityReview({
    changedSinceSnapshot,
    unplannedEditedFiles,
    plannedScope,
    testsNotRun,
    noVerificationProofForEditedFiles,
    hasActualEditedFiles
  });
  const quality = contextData.quality;
  const sessionMemoryPointer = priorSessionMemory
    ? {
        sessionId: priorSessionMemory.sessionId,
        revision: priorSessionMemory.revision,
        entryIds: priorSessionMemory.memory.entries.map((entry) => entry.id).slice(0, 20),
        summaryHash: stableSessionMemoryHash(priorSessionMemory.memory.entries.map((entry) => entry.summary).join("\n"))
      }
    : undefined;
  const outcomeInput: PostEditOutcomeInput = {
    repoRoot,
    task,
    taskId: effectiveTaskId,
    snapshotPath: loadedSnapshot.path ? path.relative(repoRoot, loadedSnapshot.path).split(path.sep).join("/") : undefined,
    snapshotCreatedAt: snapshot?.createdAt,
    snapshotPublicationSequence: snapshot?.publicationSequence,
    verdict: previewVerdict,
    inspectMode: previewInspectMode,
    inspectReasons: previewInspectReasons,
    completionAuthority: previewCompletionAuthority,
    freshness,
    ...postEditLifecycleData(planRevision, invariants, invariantReview, previewFailureSignals, previewDiffFootprint, previewLoopReview),
    changedFiles: editPaths,
    plannedEditTargets: plannedScope,
    reviewTargets,
    reviewCandidateTargets: orderedReviewTargets,
    reviewCoverage,
    unplannedEditedFiles,
    unindexedEditedFiles,
    modifiedSymbols,
    modifiedPublicSymbols,
    affectedWorkflows: workflows.map((workflow) => workflow.title),
    workflowChecks,
    dependencyChecks,
	    driftReasons: previewDriftReasons,
	    tests,
	    degradedSnapshotTests,
	    testsNotRun,
    missedLikelyTests,
    ranTests,
    ranCommands,
    ranCommandReports: displayedRanCommandReports,
    commandEnvelopes,
    waivedChecks,
    waivers,
    verificationCoverage,
    verificationLedger,
    verificationArtifacts: verificationArtifacts.selected,
    verificationProvenance: CURRENT_VERIFICATION_PROVENANCE,
    sessionMemory: sessionMemoryPointer,
    riskDeltas: riskDeltas.map((delta) => ({
      path: delta.path,
      beforeRisk: delta.before.riskScore,
      afterRisk: delta.after.riskScore,
      delta: delta.delta
    })),
    quality,
    confidence: quality?.counts
  };
  const persistOutcome = input.persistOutcome ?? true;
  let savedOutcome: Awaited<ReturnType<typeof persistPostEditLifecycleOutcome>> | undefined;
  if (persistOutcome) {
    try {
      savedOutcome = await persistPostEditLifecycleOutcome(lifecycleInput, outcomeInput);
    } catch (error) {
      if (error instanceof FreshnessAuthorityChangedError) {
        return postEditFreshnessBlockedResult({
          freshness: error.freshness,
          refresh: { refreshed: false },
          repoRoot,
          input,
          loadedSnapshot,
          reason: error.reason
        });
      }
      throw error;
    }
  }
  const lifecycle = savedOutcome?.lifecycle ?? previewLifecycle;
  const { decision, failureSignals, diffFootprint, loopReview } = lifecycle;
  const {
    driftReasons,
    verdict,
    missingWorkflowCheckCount,
    missingDependencyCheckCount,
    riskEscalationsCoveredByVerification,
    riskEscalationsNeedInspection
  } = decision;
  const { inspectMode, inspectReasons, completionAuthority } = decision;
  const nextActions = postEditNextActions(verdict, {
    snapshot,
    unplannedEditedFiles,
    testsNotRun,
    riskEscalations,
    reviewTargets,
    reviewCoverage,
    workflows,
    missingChecks: [...workflowChecks, ...dependencyChecks].filter((check) => check.status === "missing"),
    noVerificationProofForEditedFiles,
    degradedSnapshotTests
  });
  const structuredNextTools = postEditStructuredNextTools(verdict, {
    taskId: effectiveTaskId,
    reviewScope,
    changeType,
    testsNotRun,
    degradedSnapshotTests,
    riskEscalationsNeedInspection,
    riskEscalations
  });
  const outcome = savedOutcome?.outcome ?? buildPostEditOutcome(outcomeInput);
  const outcomePath = savedOutcome?.relativePath;
  const text = [
    freshnessBanner(freshness, refresh),
    quality ? formatContextQuality(quality) : undefined,
    "Codexa post-edit review",
    "Review gate: first-class post-edit review; reconcile snapshot, dirty diff, semantic context, and verification before finalizing.",
    `Task: ${task}`,
    snapshot
      ? `Snapshot: ${snapshot.taskId} (${snapshot.createdAt}${snapshot.origin === "hook-implicit" ? "; implicit pre-edit baseline" : ""})`
      : `Snapshot: unavailable${loadedSnapshot.missingReason ? ` (${loadedSnapshot.missingReason})` : ""}; using current dirty tree only`,
    `Verdict: ${verdict}`,
    `Inspect classification: ${inspectMode}; authority ${completionAuthority}`,
    ...formatPostEditLifecycle(invariants, invariantReview, loopReview, planRevision),
    ...formatPostEditArtifacts(verificationArtifacts.selected),
    semanticReviewContext ? formatPostEditSemanticReviewContext(semanticReviewContext) : undefined,
    `Outcome record: ${outcomePath ?? "not persisted"}`,
    formatPostEditReviewCoverage(reviewCoverage),
    // Verdict-relevant summaries render BEFORE the bulk sections: small
    // token budgets truncate from the end, and a hook consuming this text
    // needs the drift reasons and next actions to survive, not the
    // thirtieth changed-file entry.
    "",
    "Drift reasons:",
    ...(driftReasons.length > 0 ? driftReasons.map((reason) => `- ${reason}`) : ["- none"]),
    inspectReasons.length > 0 ? "" : undefined,
    inspectReasons.length > 0 ? "Inspect reasons:" : undefined,
    ...inspectReasons.map((reason) => `- ${reason}`),
    "",
    "Next actions:",
    ...nextActions.map((action) => `- ${action}`),
    missedLikelyTests.length > 0 ? `Tests still unaccounted for: ${missedLikelyTests.slice(0, 8).map((test) => test.path).join(", ")}` : "Tests still unaccounted for: none",
    `Causal change evidence: ${evidenceChains.chains.length} bounded chain(s); ${evidenceChains.representedTargetCount ?? 0}/${evidenceChains.analyzedTargetCount} analyzed target(s) represented; advisory only`,
    "",
    ...formatComplexityReview(complexityReview),
    "",
    "Changed since snapshot:",
    ...(changedSinceSnapshot.length > 0 ? changedSinceSnapshot.slice(0, 30).map(formatChangedEntry) : ["- none detected"]),
    "",
    "Changed files grouped by module:",
    ...formatDiffGroups(changedGroups.slice(0, 16)),
    resolvedBaselineFiles.length > 0 ? "" : undefined,
    resolvedBaselineFiles.length > 0 ? "Baseline dirty files now clean or absent:" : undefined,
    ...resolvedBaselineFiles.slice(0, 20).map((filePath) => `- ${filePath}`),
    "",
    "Plan drift:",
    snapshot
      ? snapshot.origin === "hook-implicit"
        ? "- Planned edit targets: none declared (implicit baseline); call change_plan with saveSnapshot=true to declare scope and tests"
        : `- Planned edit targets: ${plannedScope.slice(0, 20).join(", ") || "none"}${plannedScope.length > 20 ? `; +${plannedScope.length - 20} more` : ""}`
      : "- Planned edit targets: unavailable",
    `- Actual edited files since snapshot: ${editPaths.slice(0, 30).join(", ") || "none"}`,
    unplannedEditedFiles.length > 0 ? `- Unplanned edited files: ${unplannedEditedFiles.join(", ")}` : "- No unplanned edits detected against the saved planned scope.",
    plannedRenames.length > 0 ? `- Planned renames: ${plannedRenames.map((entry) => `${entry.oldPath} -> ${entry.path}`).join(", ")}` : undefined,
    unplannedChangedSymbols.length > 0
      ? `- Changed symbols outside requested target: ${unplannedChangedSymbols.slice(0, 12).map((entry) => entry.symbol.qualifiedName).join(", ")}`
      : requestedSymbolNames.size > 0
        ? "- No changed symbols outside the requested symbol target detected."
        : undefined,
    snapshot && plannedButUntouchedFiles.length > 0
      ? `- Planned targets not touched yet: ${plannedButUntouchedFiles.slice(0, 12).join(", ")}${plannedButUntouchedFiles.length > 12 ? `; +${plannedButUntouchedFiles.length - 12} more` : ""}`
      : undefined,
    headChanged ? `- Snapshot commit ${snapshot?.dirtyBaseline.headCommit ?? "none"} differs from current ${freshness.headCommit ?? "none"}` : undefined,
    "",
    "Symbol delta:",
    ...formatSymbolDeltas(symbolDeltas),
    "Modified symbols:",
    ...formatModifiedSymbols(modifiedSymbols, modifiedPublicSymbols),
    "",
    "Risk deltas:",
    ...formatRiskDeltas(riskDeltas),
    "",
    "Risk and workflow signals:",
    ...(riskEscalations.length > 0 ? riskEscalations.map((file) => `- ${file.path}: risk ${file.riskScore.toFixed(1)}, rank ${file.rank.toFixed(2)}`) : ["- none above threshold"]),
    ...workflows.slice(0, 4).map((workflow) => `- workflow ${workflow.title}: ${workflow.confidence}; ${workflow.relatedFiles.slice(0, 5).join(", ")}`),
    ...affectedEdges.slice(0, 10).map((edge) => `- edge ${edge.edgeKind}: ${edge.fromPath ?? edge.fromId} -> ${edge.toPath ?? edge.toId}; ${edge.confidence}; ${edge.reason}`),
    affectedTests.length > 0 ? `- Affected tests/workflows: ${affectedTests.slice(0, 10).join(", ")}` : "- Affected tests/workflows: none proven from typed graph edges",
    priorSessionMemory && priorSessionMemory.memory.entries.length > 0 ? "" : undefined,
    priorSessionMemory && priorSessionMemory.memory.entries.length > 0 ? "Session memory:" : undefined,
    ...(priorSessionMemory?.memory.entries.slice(0, 8).map((entry) => `- ${entry.kind}: ${entry.summary} (${entry.evidenceTier}/${entry.confidence}; ${entry.status})`) ?? []),
    "",
    "Required workflow checks:",
    ...formatCheckResults(workflowChecks),
	    "",
	    "Required dependency checks:",
	    ...formatCheckResults(dependencyChecks),
	    "",
	    "Recommended tests:",
	    ...formatTestRecommendations(tests.slice(0, 12)),
	    degradedSnapshotTests.length > 0 ? "" : undefined,
	    degradedSnapshotTests.length > 0 ? "Degraded planned snapshot tests:" : undefined,
	    ...degradedSnapshotTests.map((test) => `- ${test.path}: ${test.provenance?.degradedReason ?? "provenance does not match current review scope"}`),
	    ranTests.length > 0 ? `Reported ran tests: ${ranTests.join(", ")}` : "Reported ran tests: none",
    dataRanCommands.length > 0 ? `Reported ran commands: ${dataRanCommands.join(" | ")}` : "Reported ran commands: none",
	    dataRanCommandReports.length > 0 ? `Reported command reports: ${dataRanCommandReports.map(formatCommandReport).join(" | ")}` : "Reported command reports: none",
	    runnerReview.reviewEntries.length > 0 ? `AutoVerify runner evidence: ${runnerReview.reviewEntries.map(formatRunnerReviewEntry).join(" | ")}` : undefined,
	    dataCommandEnvelopes.length > 0 ? `Command envelopes: ${dataCommandEnvelopes.map(formatCommandEnvelope).join(" | ")}` : "Command envelopes: none",
    waivedChecks.length > 0 ? `Explicit waivers: ${waivedChecks.join(" | ")}` : "Explicit waivers: none",
    waivers.length > 0 ? `Structured waivers: ${waivers.map((waiver) => `${waiver.kind}:${waiver.target} (${waiver.reason})`).join(" | ")}` : "Structured waivers: none",
    "",
    "Verification coverage inferred from commands:",
    ...formatVerificationCoverage(dataVerificationCoverage),
    "",
    "Verification ledger:",
    ...formatVerificationLedger(dataVerificationLedger),
    "",
    "Known gaps:",
    ...formatGaps(uniqueSorted([...(contextData.gaps ?? []), ...indexGaps(index, freshness, unindexedEditedFiles)])),
    "",
    "Causal change evidence:",
    ...formatChangeEvidenceChains(evidenceChains)
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");

  return {
    freshness,
    refresh,
    text: fitLinesToTokenBudget(text.split(/\r?\n/), tokenBudget),
    data: {
      mode: "post_edit_review",
      task,
      taskId: effectiveTaskId,
      verdict,
      inspectMode,
      inspectReasons,
      completionAuthority,
      reviewCoverage,
      ...postEditLifecycleData(planRevision, invariants, invariantReview, failureSignals, diffFootprint, loopReview),
      snapshot: compactSnapshotForData(snapshot),
      snapshotLoad: {
        taskId: loadedSnapshot.latestTaskId,
        path: loadedSnapshot.path,
        missingReason: loadedSnapshot.missingReason,
        error: loadedSnapshot.error,
        recoveredLatest: loadedSnapshot.recoveredLatest,
        ambiguousLatest: Boolean(snapshotAmbiguity),
        ambiguityReason: snapshotAmbiguity
      },
      files: limitArray(selectedFiles, 60),
      reviewCandidateTargets: orderedReviewTargets,
      reviewTargets,
      changedSinceSnapshot: limitArray(changedSinceSnapshot, 40),
      changedGroups: limitArray(changedGroups, 20),
      resolvedBaselineFiles: limitArray(resolvedBaselineFiles, 30),
      unplannedEditedFiles,
      worktree: {
        knownClean: session.worktreeDegradationReasons.length === 0 && currentDirtyPaths.length === 0,
        degraded: session.worktreeDegradationReasons.length > 0,
        dirtyFileCount: currentDirtyPaths.length,
        symbolCount: changedSymbols.length,
        degradedReasons: session.worktreeDegradationReasons
      },
      worktreeDegradationReasons: session.worktreeDegradationReasons,
      plannedRenames: limitArray(plannedRenames, 20),
      unplannedChangedSymbols: limitArray(unplannedChangedSymbols, 20),
      plannedButUntouchedFiles: limitArray(plannedButUntouchedFiles, 30),
      headChanged,
      symbolDeltas: limitArray(symbolDeltas, 20),
      modifiedSymbols: limitArray(modifiedSymbols, 40),
      modifiedPublicSymbols: limitArray(modifiedPublicSymbols, 40),
      riskDeltas: limitArray(riskDeltas, 20),
	      affectedEdges: limitArray(affectedEdges, 30),
	      affectedTests: limitArray(affectedTests, 30),
	      evidenceChains,
	      tests: limitArray(tests, 30),
	      degradedSnapshotTests: limitArray(degradedSnapshotTests, 30),
	      supersededDegradedSnapshotTests: limitArray(supersededDegradedSnapshotTests, 30),
	      testsNotRun: limitArray(testsNotRun, 30),
      missedLikelyTests: limitArray(missedLikelyTests, 30),
      ranTests,
      ranCommands: dataRanCommands,
	      ranCommandReports: dataRanCommandReports,
	      autoVerifyCandidates: limitArray(autoVerifyCandidates, 30),
	      autoVerifyRunnerEvidence: runnerReview.reviewEntries.map((entry) => ({
	        command: sanitizeCommandText(entry.command, repoRoot),
	        covering: entry.covering,
	        reason: sanitizeSummary(entry.reason, repoRoot) ?? entry.reason,
	        policyId: entry.policyId,
	        sourceMutationDetected: entry.sourceMutationDetected,
	        timedOut: entry.timedOut
	      })),
      commandEnvelopes: dataCommandEnvelopes,
      waivedChecks,
      waivers,
      verificationCoverage: limitArray(dataVerificationCoverage, 40),
      verificationLedger: limitArray(dataVerificationLedger, 60),
      verificationArtifacts: verificationArtifacts.selected,
      verificationProvenance: CURRENT_VERIFICATION_PROVENANCE,
      sessionMemory: sessionMemoryPointer,
      priorSessionMemory: priorSessionMemory
        ? {
            sessionId: priorSessionMemory.sessionId,
            revision: priorSessionMemory.revision,
            entries: priorSessionMemory.memory.entries.slice(0, 8),
            warnings: priorSessionMemory.warnings
          }
        : undefined,
      waivedVerification: limitArray(dataWaivedVerification, 30),
      unindexedEditedFiles,
      riskEscalations: limitArray(riskEscalations, 20),
      riskEscalationsCoveredByVerification,
      riskEscalationsNeedInspection,
      workflows: limitArray(workflows, 12),
      workflowChecks: limitArray(workflowChecks, 20),
      dependencyChecks: limitArray(dependencyChecks, 30),
      complexityReview,
      context: compactContextData(context.data),
      quality,
      semanticReviewContext,
      driftReasons,
      nextActions,
      nextTools: structuredNextTools,
      systemMessage: structuredNextTools[0]?.reason,
      outcome: {
        ...outcome,
        persisted: Boolean(savedOutcome),
        path: outcomePath
      }
    }
  };
}

function postEditFreshnessBlockedResult(input: {
  freshness: FreshnessInfo;
  refresh?: RefreshInfo;
  repoRoot: string;
  input: PostEditReviewInput;
  loadedSnapshot: TaskSnapshotLoadResult;
  reason: string;
}): QueryResult {
  const snapshot = input.loadedSnapshot.snapshot;
  const task = input.input.task ?? snapshot?.task ?? "Post-edit review";
  return {
    freshness: input.freshness,
    refresh: input.refresh,
    text: [
      freshnessBanner(input.freshness, input.refresh),
      "Codexa post-edit review blocked.",
      input.reason,
      `Run: codexa index ${input.repoRoot}`,
      "No post-edit outcome or lifecycle attempt was persisted."
    ].join("\n"),
    data: {
      mode: "post_edit_review",
      actionability: "blocked",
      task,
      taskId: snapshot?.taskId ?? input.input.taskId,
      verdict: "inspect",
      inspectMode: "blocking",
      inspectReasons: [input.reason],
      completionAuthority: "blocking_inspect",
      planRevision: snapshot?.planRevision ?? 1,
      invariants: snapshot?.invariants ?? [],
      invariantReviews: [],
      snapshot: compactSnapshotForData(snapshot),
      snapshotLoad: {
        taskId: input.loadedSnapshot.latestTaskId,
        path: input.loadedSnapshot.path,
        missingReason: input.loadedSnapshot.missingReason,
        error: input.loadedSnapshot.error,
        recoveredLatest: input.loadedSnapshot.recoveredLatest
      },
      files: [],
      reviewTargets: [],
      changedSinceSnapshot: [],
      unplannedEditedFiles: [],
      testsNotRun: snapshot?.plannedTests ?? [],
      verificationLedger: [],
      riskEscalationsNeedInspection: true,
      loopReview: {
        status: "not-evaluated",
        reasons: ["freshness authority blocked before lifecycle evaluation"]
      },
      failureSignals: [],
      outcome: { persisted: false },
      nextTools: [],
      systemMessage: `Run codexa index ${input.repoRoot}, then retry post_edit_review.`,
      gaps: [input.reason]
    }
  };
}

function formatPostEditSemanticReviewContext(summary: SemanticRetrievalSummary): string {
  if (summary.status === "ok") {
    return `Semantic review context: ok (${summary.provider ?? "provider"} ${summary.model ?? "model"}; ${summary.chunkCount ?? 0} chunks)`;
  }
  if (summary.status === "unavailable") {
    return `Semantic review context: unavailable${summary.diagnostics.length > 0 ? ` (${summary.diagnostics.join("; ")})` : ""}`;
  }
  return "Semantic review context: disabled";
}

function compareSnapshotSymbols(
  snapshot: TaskSnapshot | undefined,
  index: CodexaIndex,
  paths: string[]
): Array<{ path: string; newSymbols: TaskSnapshotSymbol[]; removedSymbols: TaskSnapshotSymbol[] }> {
  if (!snapshot?.symbolBaseline) return [];
  const afterByPath = snapshotSymbolBaseline(index, paths);
  return uniqueSorted(paths)
    .map((filePath) => {
      const before = snapshot.symbolBaseline?.[filePath] ?? [];
      const after = afterByPath[filePath] ?? [];
      const beforeKeys = new Set(before.map(symbolDeltaKey));
      const afterKeys = new Set(after.map(symbolDeltaKey));
      return {
        path: filePath,
        newSymbols: after.filter((symbol) => !beforeKeys.has(symbolDeltaKey(symbol))),
        removedSymbols: before.filter((symbol) => !afterKeys.has(symbolDeltaKey(symbol)))
      };
    })
    .filter((delta) => delta.newSymbols.length > 0 || delta.removedSymbols.length > 0);
}

function requestedSymbolIds(snapshot: TaskSnapshot | undefined, requestedSymbols: Set<string>): Set<string> {
  const ids = new Set<string>();
  if (!snapshot?.symbolBaseline || requestedSymbols.size === 0) {
    return ids;
  }
  for (const symbols of Object.values(snapshot.symbolBaseline)) {
    for (const symbol of symbols) {
      if (
        requestedSymbols.has(normalizeSearchText(symbol.id)) ||
        requestedSymbols.has(normalizeSearchText(symbol.name)) ||
        requestedSymbols.has(normalizeSearchText(symbol.qualifiedName))
      ) {
        ids.add(symbol.id);
      }
    }
  }
  return ids;
}

async function latestSnapshotAmbiguity(repoRoot: string, latestTaskId: string): Promise<string | undefined> {
  const dir = path.join(repoRoot, ".codex/cache/codexa-tasks");
  try {
    const entries = await fs.readdir(dir);
    const taskSnapshots = entries.filter((entry) => entry.endsWith(".json") && entry !== "latest.json" && !entry.endsWith(".blocked.json"));
    const otherSnapshots = taskSnapshots.filter((entry) => entry !== `${latestTaskId}.json`);
    if (otherSnapshots.length === 0) return undefined;
    return `post_edit_review used latest snapshot ${latestTaskId} without an explicit taskId while ${otherSnapshots.length} other snapshot(s) exist; pass taskId to bind review to the intended plan`;
  } catch {
    return undefined;
  }
}

function plannedScopeContainsSymbolFile(snapshot: TaskSnapshot | undefined, filePath: string): boolean {
  if (!snapshot) return false;
  const planned = snapshot.plannedEditTargets.length > 0 ? snapshot.plannedEditTargets : snapshot.plannedFiles;
  return planned.includes(filePath);
}

function compareSnapshotRisks(
  snapshot: TaskSnapshot | undefined,
  index: CodexaIndex,
  paths: string[]
): Array<{ path: string; before: TaskSnapshotRiskFile; after: TaskSnapshotRiskFile; delta: number; newSignals: string[]; removedSignals: string[] }> {
  if (!snapshot?.riskBaseline) return [];
  const afterByPath = snapshotRiskBaseline(index, paths);
  return uniqueSorted(paths)
    .map((filePath) => {
      const before = snapshot.riskBaseline?.[filePath] ?? { riskScore: 0, signals: [] };
      const after = afterByPath[filePath] ?? { riskScore: 0, signals: [] };
      return {
        path: filePath,
        before,
        after,
        delta: after.riskScore - before.riskScore,
        newSignals: multisetDifference(after.signals, before.signals),
        removedSignals: multisetDifference(before.signals, after.signals)
      };
    })
    .filter((delta) => Math.abs(delta.delta) > 0.01 || delta.newSignals.length > 0 || delta.removedSignals.length > 0)
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta) || a.path.localeCompare(b.path));
}

function multisetDifference(values: string[], baseline: string[]): string[] {
  const remaining = new Map<string, number>();
  for (const value of baseline) {
    remaining.set(value, (remaining.get(value) ?? 0) + 1);
  }
  const result: string[] = [];
  for (const value of values) {
    const count = remaining.get(value) ?? 0;
    if (count > 0) {
      remaining.set(value, count - 1);
      continue;
    }
    result.push(value);
  }
  return result;
}

function symbolDeltaKey(symbol: TaskSnapshotSymbol): string {
  return `${symbol.kind}\0${symbol.qualifiedName}\0${symbol.name}`;
}

function formatSymbolDeltas(deltas: Array<{ path: string; newSymbols: TaskSnapshotSymbol[]; removedSymbols: TaskSnapshotSymbol[] }>): string[] {
  if (deltas.length === 0) {
    return ["- none detected or no symbol baseline available"];
  }
  return deltas.flatMap((delta) => [
    `- ${delta.path}`,
    ...(delta.newSymbols.length > 0 ? [`  new: ${delta.newSymbols.slice(0, 8).map((symbol) => `${symbol.qualifiedName} (${symbol.kind})`).join(", ")}`] : []),
    ...(delta.removedSymbols.length > 0 ? [`  removed: ${delta.removedSymbols.slice(0, 8).map((symbol) => `${symbol.qualifiedName} (${symbol.kind})`).join(", ")}`] : [])
  ]);
}

function formatModifiedSymbols(modifiedSymbols: string[], modifiedPublicSymbols: string[]): string[] {
  if (modifiedSymbols.length === 0) {
    return ["- none detected from changed line ranges"];
  }
  const publicSuffix = modifiedPublicSymbols.length > 0 ? `; public/runtime ${modifiedPublicSymbols.slice(0, 8).join(", ")}` : "";
  return [`- ${modifiedSymbols.slice(0, 12).join(", ")}${modifiedSymbols.length > 12 ? ", ..." : ""}${publicSuffix}`];
}

function formatCheckResults(checks: PostEditCheckResult[]): string[] {
  if (checks.length === 0) {
    return ["- none saved in the task snapshot"];
  }
  return checks.slice(0, 12).map((check) => `- ${check.status}: ${check.target}; trust ${check.trustTier}; ${check.confidence}; ${check.reason}`);
}

function formatCommandReport(report: VerificationCommandReport): string {
  const status = report.exitCode === undefined ? "exit unknown" : `exit ${report.exitCode}`;
  const cwd = report.cwd ? `; cwd ${report.cwd}` : "";
  const duration = report.durationMs === undefined ? "" : `; ${report.durationMs}ms`;
  const summary = report.outputSummary ?? report.stderrSummary ?? report.stdoutSummary;
  return `${report.command} (${status}${cwd}${duration}${summary ? `; ${summary}` : ""})`;
}

function formatRunnerReviewEntry(entry: AutoVerifyRunnerReviewEntry): string {
  return `${entry.covering ? "trusted" : "non-covering"} ${entry.command} (${entry.reason})`;
}

function formatCommandEnvelope(envelope: VerificationCommandEnvelope): string {
  const manager = envelope.packageManager ? `${envelope.packageManager}` : "unknown manager";
  const script = envelope.scriptName ? ` ${envelope.scriptName}` : "";
  const scope = envelope.packageRoot ? `; scope ${envelope.packageRoot}` : envelope.cwd ? `; cwd ${envelope.cwd}` : "";
  const args = envelope.args.length > 0 ? `; args ${envelope.args.slice(0, 5).join(" ")}` : "";
  return `${manager}${script} (${envelope.scopeStatus}; ${envelope.source}${scope}${args})`;
}

function formatRiskDeltas(
  deltas: Array<{ path: string; before: TaskSnapshotRiskFile; after: TaskSnapshotRiskFile; delta: number; newSignals: string[]; removedSignals: string[] }>
): string[] {
  if (deltas.length === 0) {
    return ["- none detected or no risk baseline available"];
  }
  return deltas.slice(0, 12).map((delta) => {
    const direction = delta.delta > 0 ? "+" : "";
    const newText = delta.newSignals.length > 0 ? `; new ${delta.newSignals.slice(0, 3).join(" | ")}` : "";
    const removedText = delta.removedSignals.length > 0 ? `; removed ${delta.removedSignals.slice(0, 3).join(" | ")}` : "";
    return `- ${delta.path}: ${delta.before.riskScore.toFixed(1)} -> ${delta.after.riskScore.toFixed(1)} (${direction}${delta.delta.toFixed(1)})${newText}${removedText}`;
  });
}
