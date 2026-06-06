import { promises as fs } from "node:fs";
import path from "node:path";
import { isTestPath } from "../language.js";
import { groupDiffImpact, formatDiffGroups, formatGaps, indexGaps } from "./diff.js";
import { clampInt, fitLinesToTokenBudget, formatReasons } from "./formatting.js";
import { affectedWorkflowGraphEdges, testsFromGraphEdges } from "./graph.js";
import { contextPackQuery, focusBriefQuery } from "./context.js";
import { formatContextQuality, type ContextQuality } from "./quality.js";
import { freshnessBanner } from "./runtime.js";
import { ensureQuerySession, type QuerySession, type QuerySessionInput } from "./session.js";
import { normalizeSearchText } from "./search.js";
import { formatTestRecommendations, narrowTestRecommendationsByChangeType, recommendTests, uniqueTests } from "./tests.js";
import { findFile, normalizeInputPaths, resolveFileTarget, resolveSymbolTarget } from "./targets.js";
import { formatVerificationCoverage, formatVerificationLedger, verificationEvidenceForCommandReports, verificationLedgerForPostEdit } from "./verification.js";
import { isCodexaControlPath, formatChangedEntry } from "./worktree.js";
import { postEditDecision } from "./post-edit/decision.js";
import { postEditDirtyScope } from "./post-edit/dirty-scope.js";
import { postEditNextActions, postEditStructuredNextTools } from "./post-edit/next-actions.js";
import { compactSnapshotTests, reconcileSnapshotTests, snapshotRiskBaseline, snapshotSymbolBaseline } from "./post-edit/snapshot-contract.js";
import { buildPostEditOutcome, savePostEditOutcome, type PostEditCheckResult, type PostEditOutcomeInput } from "../post-edit-outcomes.js";
import { pointerForSessionMemory, readSessionMemory } from "../session-memory.js";
import { loadTaskSnapshot, saveBlockedTaskSnapshot, saveTaskSnapshot, type TaskSnapshotLoadResult } from "../task-snapshots.js";
import { CURRENT_VERIFICATION_PROVENANCE } from "../types.js";
import { isTrustedAutoVerifyCommandReport } from "../autoverify.js";
import { AUTO_VERIFY_POLICY_DIGEST, AUTO_VERIFY_POLICY_ID } from "../autoverify/policy.js";
import type { SemanticRetrievalSummary } from "../semantic-retrieval.js";
import type { AutoVerifyCommandReport, AutoVerifyReportRunner } from "../autoverify.js";
import type {
  AutoVerifyCandidate,
  ChangedFileEntry,
  ChangePlanInput,
  ChangeType,
  CodexaIndex,
  DiffImpactGroup,
  EvidenceTier,
  FileFact,
  GraphEdgeFact,
  PostEditReviewInput,
  QueryOptions,
  QueryResult,
  SymbolFact,
  TaskSnapshot,
  TaskSnapshotRequiredCheck,
  TaskSnapshotRiskFile,
  TaskSnapshotSymbol,
  TestRecommendation,
  TestRecommendationProvenance,
  VerificationCommandEnvelope,
  VerificationCoverage,
  VerificationCommandReport,
  VerificationLedgerEntry,
  WorkflowTraceFact
} from "../types.js";
import { limitText, stableId, uniqueSorted } from "../util.js";

interface PostEditReviewInternalInput {
  trustedRunnerReports?: AutoVerifyCommandReport[];
}

type DisplayCommandReport = VerificationCommandReport & { runner?: AutoVerifyReportRunner };

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
  const tokenBudget = clampInt(input.tokenBudget ?? 2800, 600, 10000);
  const limit = clampInt(input.limit ?? 10, 3, 30);
  const loadedSnapshot = await loadTaskSnapshot(repoRoot, input.taskId);
  const snapshot = loadedSnapshot.snapshot;
  const snapshotAmbiguity = !input.taskId && snapshot ? await latestSnapshotAmbiguity(repoRoot, snapshot.taskId) : undefined;
  const currentEntries = await session.getChangedFileEntries();
  const dirtyScope = postEditDirtyScope({ snapshot, currentEntries, freshness, index });
  const { currentDirtyPaths, changedSinceSnapshot, resolvedBaselineFiles, editPaths, unindexedEditedFiles } = dirtyScope;
  const changedSymbols = (await session.getChangedSymbols()).filter((entry) => editPaths.includes(entry.symbol.path));
  const requestedSymbolNames = new Set([...(snapshot?.input.symbols ?? []), ...(input.symbols ?? [])].map(normalizeSearchText));
  const plannedSymbolIds = requestedSymbolIds(snapshot, requestedSymbolNames);
  const unplannedChangedSymbols =
    requestedSymbolNames.size > 0 && plannedSymbolIds.size > 0
      ? changedSymbols.filter((entry) => !plannedSymbolIds.has(entry.symbol.id) && plannedScopeContainsSymbolFile(snapshot, entry.symbol.path))
      : [];
  const changedGroups = groupDiffImpact(index, changedSinceSnapshot, changedSymbols, unindexedEditedFiles);
  const explicitFiles = normalizeInputPaths(input.files ?? [], repoRoot);
  const explicitSymbolFiles = (input.symbols ?? [])
    .flatMap((symbol) => {
      const resolved = resolveSymbolTarget(index, symbol);
      return resolved.symbol ? [resolved.symbol.path] : [];
    })
    .filter(Boolean);
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
  const plannedButUntouchedFiles = snapshot ? plannedScope.filter((filePath) => !editPaths.includes(filePath) && !currentDirtyPaths.includes(filePath)) : [];
  const headChanged = Boolean(snapshot && snapshot.dirtyBaseline.headCommit !== freshness.headCommit);
  const task = input.task ?? snapshot?.task ?? "Post-edit review";
  const effectiveTaskId = snapshot?.taskId ?? loadedSnapshot.latestTaskId ?? input.taskId;
  const changeType = input.changeType ?? snapshot?.changeType ?? "unknown";
  const reviewTargets = uniqueSorted([
    ...(editPaths.length > 0 ? editPaths : []),
    ...explicitFiles,
    ...explicitSymbolFiles,
    ...(editPaths.length === 0 && explicitFiles.length === 0 && explicitSymbolFiles.length === 0 && snapshot ? snapshot.plannedFiles.slice(0, limit) : [])
  ]).slice(0, Math.max(limit, 3));
  const context = await contextPackQuery(
    session,
    {
      task,
      files: reviewTargets,
      symbols: input.symbols,
      changeType,
      diff: !snapshot,
      tokenBudget: Math.min(tokenBudget, 3600),
      limit,
      includeSnippets: input.includeSnippets ?? false
    },
    { ...options, autoRefresh: false }
  );
  const contextData = context.data as {
    focusFiles?: Array<{ file: FileFact; reasons: string[]; tier: EvidenceTier }>;
    changedFiles?: string[];
    unindexedChanged?: string[];
    groups?: DiffImpactGroup[];
    tests?: TestRecommendation[];
    recipes?: string[];
    quality?: ContextQuality;
    gaps?: string[];
    warnings?: string[];
    retrieval?: { semantic?: SemanticRetrievalSummary };
  };
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
  const selectedFiles = [...new Set([...reviewTargets, ...(contextData.focusFiles ?? []).map((entry) => entry.file.path)])].slice(0, Math.max(limit * 2, 12));
  const symbolDeltas = compareSnapshotSymbols(snapshot, index, uniqueSorted([...reviewTargets, ...editPaths]));
  const modifiedSymbols = changedSymbols
    .map((entry) => `${entry.symbol.qualifiedName} (${entry.symbol.kind}) in ${entry.symbol.path}`)
    .sort((a, b) => a.localeCompare(b));
  const modifiedPublicSymbols = changedSymbols
    .filter((entry) => entry.symbol.exported || ["route", "node"].includes(entry.symbol.kind))
    .map((entry) => `${entry.symbol.qualifiedName} (${entry.symbol.kind}) in ${entry.symbol.path}`)
    .sort((a, b) => a.localeCompare(b));
  const riskDeltas = compareSnapshotRisks(snapshot, index, uniqueSorted([...reviewTargets, ...editPaths]));
  const affectedEdges = affectedWorkflowGraphEdges(index, reviewTargets).slice(0, 20);
  const affectedTests = uniqueSorted([
    ...testsFromGraphEdges(affectedEdges),
    ...index.testEdges.filter((edge) => edge.targetPath && reviewTargets.includes(edge.targetPath)).map((edge) => edge.path)
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
  ).slice(0, 12);
  const ranTests = input.ranTests ?? [];
  const ranCommands = input.ranCommands ?? [];
  const manualRanCommandReports = (input.ranCommandReports ?? []).map(stripRunnerMetadata);
  const runnerReview = await reviewTrustedRunnerReports(internal.trustedRunnerReports ?? [], {
    freshness,
    snapshot,
    repoRoot
  });
  const ranCommandReports = [...manualRanCommandReports, ...runnerReview.coveringReports];
  const displayedRanCommandReports = [...manualRanCommandReports, ...runnerReview.displayReports];
  const waivedChecks = input.waivedChecks ?? [];
  const waivers = input.waivers ?? [];
  const preliminaryVerificationCoverage = verificationEvidenceForCommandReports(index, ranCommands, ranCommandReports, repoRoot).coverage;
  const hasActualEditedFiles = editPaths.length > 0;
  const riskEscalations = reviewTargets
    .map((filePath) => findFile(index, filePath))
    .filter((file): file is FileFact => Boolean(file))
    .filter((file) => file.riskScore >= 4 || unplannedEditedFiles.includes(file.path))
    .sort((a, b) => b.riskScore - a.riskScore || b.rank - a.rank || a.path.localeCompare(b.path))
    .slice(0, 10);
  const workflows = index.workflows
    .filter((workflow) => reviewTargets.some((filePath) => workflow.relatedFiles.includes(filePath) || workflow.entryPath === filePath))
    .sort((a, b) => b.rank - a.rank || a.title.localeCompare(b.title))
    .slice(0, 6);
  const workflowChecks = evaluateRequiredChecks(snapshot?.requiredWorkflowChecks ?? [], {
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
  const dependencyChecks = evaluateRequiredChecks(snapshot?.requiredDependencyChecks ?? [], {
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
  const verification = verificationLedgerForPostEdit({
    index,
    tests,
    ranTests,
    ranCommands,
    ranCommandReports,
    waivedChecks,
    waivers,
    repoRoot,
    workflowChecks,
    dependencyChecks
  });
  const verificationCoverage = verification.coverage;
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
  const decision = postEditDecision({
    snapshot,
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
    noVerificationProofForEditedFiles
  });
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
    workflows,
    missingChecks: [...workflowChecks, ...dependencyChecks].filter((check) => check.status === "missing"),
    noVerificationProofForEditedFiles,
    degradedSnapshotTests
  });
  const structuredNextTools = postEditStructuredNextTools(verdict, {
    reviewScope,
    changeType,
    testsNotRun,
    degradedSnapshotTests,
    riskEscalationsNeedInspection,
    riskEscalations
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
    verdict,
    inspectMode,
    inspectReasons,
    completionAuthority,
    freshness,
    changedFiles: editPaths,
    plannedEditTargets: plannedScope,
    reviewTargets,
    unplannedEditedFiles,
    unindexedEditedFiles,
    modifiedSymbols,
    modifiedPublicSymbols,
    affectedWorkflows: workflows.map((workflow) => workflow.title),
    workflowChecks,
    dependencyChecks,
	    driftReasons,
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
  const savedOutcome = persistOutcome ? await savePostEditOutcome(outcomeInput) : undefined;
  const outcome = savedOutcome?.outcome ?? buildPostEditOutcome(outcomeInput);
  const outcomePath = savedOutcome?.relativePath;
  const text = [
    freshnessBanner(freshness, refresh),
    quality ? formatContextQuality(quality) : undefined,
    "Codexa post-edit review",
    "Review gate: first-class post-edit review; reconcile snapshot, dirty diff, semantic context, and verification before finalizing.",
    `Task: ${task}`,
    snapshot ? `Snapshot: ${snapshot.taskId} (${snapshot.createdAt})` : `Snapshot: unavailable${loadedSnapshot.missingReason ? ` (${loadedSnapshot.missingReason})` : ""}; using current dirty tree only`,
    `Verdict: ${verdict}`,
    `Inspect classification: ${inspectMode}; authority ${completionAuthority}`,
    semanticReviewContext ? formatPostEditSemanticReviewContext(semanticReviewContext) : undefined,
    `Outcome record: ${outcomePath ?? "not persisted"}`,
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
    snapshot ? `- Planned edit targets: ${plannedScope.slice(0, 20).join(", ") || "none"}` : "- Planned edit targets: unavailable",
    `- Actual edited files since snapshot: ${editPaths.slice(0, 30).join(", ") || "none"}`,
    unplannedEditedFiles.length > 0 ? `- Unplanned edited files: ${unplannedEditedFiles.join(", ")}` : "- No unplanned edits detected against the saved planned scope.",
    plannedRenames.length > 0 ? `- Planned renames: ${plannedRenames.map((entry) => `${entry.oldPath} -> ${entry.path}`).join(", ")}` : undefined,
    unplannedChangedSymbols.length > 0
      ? `- Changed symbols outside requested target: ${unplannedChangedSymbols.slice(0, 12).map((entry) => entry.symbol.qualifiedName).join(", ")}`
      : requestedSymbolNames.size > 0
        ? "- No changed symbols outside the requested symbol target detected."
        : undefined,
    snapshot && plannedButUntouchedFiles.length > 0 ? `- Planned targets not touched yet: ${plannedButUntouchedFiles.slice(0, 12).join(", ")}` : undefined,
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
	    ...formatTestRecommendations(tests),
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
    missedLikelyTests.length > 0 ? `Tests still unaccounted for: ${missedLikelyTests.slice(0, 8).map((test) => test.path).join(", ")}` : "Tests still unaccounted for: none",
    "",
    "Drift reasons:",
    ...(driftReasons.length > 0 ? driftReasons.map((reason) => `- ${reason}`) : ["- none"]),
    inspectReasons.length > 0 ? "" : undefined,
    inspectReasons.length > 0 ? "Inspect reasons:" : undefined,
    ...inspectReasons.map((reason) => `- ${reason}`),
    "",
    "Next actions:",
    ...nextActions.map((action) => `- ${action}`),
    "",
    "Known gaps:",
    ...formatGaps(uniqueSorted([...(contextData.gaps ?? []), ...indexGaps(index, freshness, unindexedEditedFiles)]))
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
      verdict,
      inspectMode,
      inspectReasons,
      completionAuthority,
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
      files: selectedFiles,
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
  if (!snapshot?.symbolBaseline) {
    return [];
  }
  return uniqueSorted(paths)
    .map((filePath) => {
      const before = snapshot.symbolBaseline?.[filePath] ?? [];
      const after = snapshotSymbolBaseline(index, [filePath])[filePath] ?? [];
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
    if (otherSnapshots.length === 0) {
      return undefined;
    }
    return `post_edit_review used latest snapshot ${latestTaskId} without an explicit taskId while ${otherSnapshots.length} other snapshot(s) exist; pass taskId to bind review to the intended plan`;
  } catch {
    return undefined;
  }
}

function plannedScopeContainsSymbolFile(snapshot: TaskSnapshot | undefined, filePath: string): boolean {
  if (!snapshot) {
    return false;
  }
  const planned = snapshot.plannedEditTargets.length > 0 ? snapshot.plannedEditTargets : snapshot.plannedFiles;
  return planned.includes(filePath);
}

function compareSnapshotRisks(
  snapshot: TaskSnapshot | undefined,
  index: CodexaIndex,
  paths: string[]
): Array<{ path: string; before: TaskSnapshotRiskFile; after: TaskSnapshotRiskFile; delta: number; newSignals: string[]; removedSignals: string[] }> {
  if (!snapshot?.riskBaseline) {
    return [];
  }
  return uniqueSorted(paths)
    .map((filePath) => {
      const before = snapshot.riskBaseline?.[filePath] ?? { riskScore: 0, signals: [] };
      const after = snapshotRiskBaseline(index, [filePath])[filePath] ?? { riskScore: 0, signals: [] };
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

function evaluateRequiredChecks(
  checks: TaskSnapshotRequiredCheck[],
  input: {
    editPaths: string[];
    reviewTargets: string[];
    selectedFiles: string[];
    workflows: WorkflowTraceFact[];
    affectedEdges: GraphEdgeFact[];
    affectedTests: string[];
    tests: TestRecommendation[];
    ranTests: string[];
    verificationCoverage: VerificationCoverage[];
  }
): PostEditCheckResult[] {
  if (checks.length === 0) {
    return [];
  }
  const editSet = new Set(input.editPaths);
  const reviewSet = new Set(input.reviewTargets);
  const selectedSet = new Set(input.selectedFiles);
  const affectedTestSet = new Set(input.affectedTests);
  const workflowTitles = new Set(input.workflows.map((workflow) => workflow.title));
  const edgePaths = new Set(input.affectedEdges.flatMap((edge) => [edge.fromPath, edge.toPath]).filter((filePath): filePath is string => Boolean(filePath)));
  return checks.map((check) => {
    const relevant = input.editPaths.length === 0 || check.paths.some((filePath) => editSet.has(filePath) || reviewSet.has(filePath));
    const evidencePaths = check.paths.filter((filePath) => !editSet.has(filePath));
    const hasNonEditedEvidence = evidencePaths.some((filePath) => edgePaths.has(filePath) || selectedSet.has(filePath) || affectedTestSet.has(filePath));
    if (!relevant) {
      return { ...check, status: "not_applicable" };
    }
    const covered =
      check.kind === "workflow"
        ? workflowTitles.has(check.target) && hasNonEditedEvidence
        : hasNonEditedEvidence || dependencyCheckCoveredByVerification(check, input);
    return { ...check, status: covered ? "covered" : "missing" };
  });
}

function dependencyCheckCoveredByVerification(
  check: TaskSnapshotRequiredCheck,
  input: {
    tests: TestRecommendation[];
    ranTests: string[];
    verificationCoverage: VerificationCoverage[];
  }
): boolean {
  const checkPaths = check.paths.map(normalizePathLike);
  const testPaths = check.paths.filter(isTestPath);
  if (
    testPaths.some((testPath) =>
      input.ranTests.some((ranTest) => normalizePathLike(ranTest) === normalizePathLike(testPath)) ||
      input.verificationCoverage.some((coverage) => coverage.kind === (testPath.endsWith(".py") ? "python-tests" : "javascript-tests") && coverageCoversPath(coverage, testPath))
    )
  ) {
    return true;
  }
    const sourcePaths = check.paths.filter((filePath) => !isTestPath(filePath));
    return input.verificationCoverage.some((coverage) => {
      if (coverage.targetPath) {
        return checkPaths.includes(normalizePathLike(coverage.targetPath)) && coverageKindCompatibleWithSourcePath(coverage.kind, coverage.targetPath);
      }
      return sourcePaths.some((filePath) => coverageKindCompatibleWithSourcePath(coverage.kind, filePath) && coverageCoversPath(coverage, filePath));
    });
  }

function coverageKindCompatibleWithSourcePath(kind: VerificationCoverage["kind"], filePath: string): boolean {
  const normalized = normalizePathLike(filePath).toLowerCase();
  if (normalized.endsWith(".py")) {
    return kind === "python-tests";
  }
  if (/\.(?:cjs|cts|js|jsx|mjs|mts|ts|tsx)$/u.test(normalized)) {
    return kind === "build" || kind === "typescript-syntax" || kind === "javascript-tests";
  }
  return kind === "build";
}

function coverageCoversPath(coverage: VerificationCoverage, filePath: string): boolean {
  const normalizedPath = normalizePathLike(filePath);
  if (coverage.targetPath) {
    return normalizePathLike(coverage.targetPath) === normalizedPath;
  }
  const normalizedScope = normalizePathLike(coverage.scope ?? ".");
  return normalizedScope === "." || normalizedPath === normalizedScope || normalizedPath.startsWith(`${normalizedScope}/`);
}

function normalizePathLike(value: string): string {
  return value.replace(/\\/gu, "/").replace(/^\.\//u, "").replace(/\/+/gu, "/");
}

function formatCheckResults(checks: PostEditCheckResult[]): string[] {
  if (checks.length === 0) {
    return ["- none saved in the task snapshot"];
  }
  return checks.slice(0, 12).map((check) => `- ${check.status}: ${check.target}; ${check.confidence}; ${check.reason}`);
}

interface AutoVerifyRunnerReviewEntry {
  command: string;
  covering: boolean;
  reason: string;
  policyId?: string;
  sourceMutationDetected?: boolean;
  timedOut?: boolean;
}

async function reviewTrustedRunnerReports(
  reports: AutoVerifyCommandReport[],
  ctx: { freshness: { headCommit: string | null; dirtyFiles: string[]; dirtyFileHashes: Record<string, string> }; snapshot: TaskSnapshot | undefined; repoRoot: string }
): Promise<{ coveringReports: AutoVerifyCommandReport[]; displayReports: AutoVerifyCommandReport[]; reviewEntries: AutoVerifyRunnerReviewEntry[] }> {
  const repoRealRoot = await fs.realpath(ctx.repoRoot).catch(() => path.resolve(ctx.repoRoot));
  const currentDirtyHash = dirtyHashFromFreshness(ctx.freshness);
  const snapshotDigest = ctx.snapshot ? autoVerifySnapshotDigest(ctx.snapshot) : undefined;
  const coveringReports: AutoVerifyCommandReport[] = [];
  const displayReports: AutoVerifyCommandReport[] = [];
  const reviewEntries: AutoVerifyRunnerReviewEntry[] = [];
  for (const report of reports) {
    const reasons = runnerReportRejectionReasons(report, {
      currentDirtyHash,
      snapshotDigest,
      taskId: ctx.snapshot?.taskId,
      repoRealRoot
    });
    displayReports.push(report);
    const covering = reasons.length === 0;
    if (covering) {
      coveringReports.push(report);
    }
    reviewEntries.push({
      command: sanitizeCommandText(report.command, ctx.repoRoot),
      covering,
      reason: sanitizeSummary(covering ? "fresh trusted AutoVerify report" : reasons.join("; "), ctx.repoRoot) ?? "runner evidence unavailable",
      policyId: report.runner?.policyId,
      sourceMutationDetected: report.runner?.sourceMutationDetected,
      timedOut: report.runner?.timedOut
    });
  }
  return { coveringReports, displayReports, reviewEntries };
}

function runnerReportRejectionReasons(
  report: AutoVerifyCommandReport,
  ctx: { currentDirtyHash: string; snapshotDigest?: string; taskId?: string; repoRealRoot: string }
): string[] {
  const runner = report.runner;
  const reasons: string[] = [];
  if (!isTrustedAutoVerifyCommandReport(report)) {
    return ["missing internal AutoVerify trust marker"];
  }
  if (!runner || runner.schemaVersion !== 1 || runner.reportKind !== "codexa-autoverify-report" || runner.runnerName !== "codexa") {
    return ["missing trusted AutoVerify runner metadata"];
  }
  if (runner.policyId !== AUTO_VERIFY_POLICY_ID) reasons.push("unexpected runner policy");
  if (runner.policyDigest !== AUTO_VERIFY_POLICY_DIGEST) reasons.push("unexpected runner policy digest");
  if (runner.envMode !== "minimal") reasons.push("unexpected runner environment");
  if (!runner.outputRedacted) reasons.push("runner output was not redacted");
  if (report.exitCode !== 0) reasons.push(report.exitCode === undefined ? "missing exit code" : `exit code ${report.exitCode}`);
  if (!report.cwd) reasons.push("missing cwd");
  if (runner.timedOut) reasons.push("runner timed out");
  if (runner.sourceMutationDetected) reasons.push("source mutation detected");
  if (runner.skippedReason) reasons.push(runner.skippedReason);
  if (ctx.taskId && runner.taskId !== ctx.taskId) reasons.push("task id mismatch");
  if (ctx.snapshotDigest && runner.snapshotDigest !== ctx.snapshotDigest) reasons.push("snapshot digest mismatch");
  if (runner.dirtyHashAfter !== ctx.currentDirtyHash) reasons.push("stale dirty tree");
  if (!absoluteSubpath(runner.cwdRealpath, ctx.repoRealRoot)) reasons.push("runner cwd outside repo");
  if (runner.targetRealpaths.length === 0) reasons.push("missing runner targets");
  if (runner.targetRealpaths.some((target) => !absoluteSubpath(target, ctx.repoRealRoot))) reasons.push("runner target outside repo");
  if (runner.canonicalDigest !== runnerReportDigest(report, runner)) reasons.push("runner digest mismatch");
  return reasons;
}

function runnerReportDigest(report: AutoVerifyCommandReport, runner: AutoVerifyReportRunner): string {
  return stableId(
    "codexa-autoverify-report",
    report.command,
    report.exitCode,
    runner.policyId,
    runner.policyDigest,
    runner.taskId,
    runner.snapshotDigest,
    runner.commandId,
    runner.candidateDigest,
    runner.headCommit ?? "null",
    runner.dirtyHashBefore,
    runner.dirtyHashAfter,
    runner.cwdRealpath,
    JSON.stringify(runner.targetRealpaths),
    runner.envMode,
    JSON.stringify(runner.allowedBy),
    runner.sourceMutationDetected ? "mutated" : "clean",
    runner.timedOut ? "timed-out" : "not-timed-out",
    runner.outputRedacted ? "redacted" : "not-redacted",
    runner.signal ?? "",
    runner.skippedReason ?? ""
  );
}

function stripRunnerMetadata(report: VerificationCommandReport): VerificationCommandReport {
  return {
    command: report.command,
    cwd: report.cwd,
    packageManager: report.packageManager,
    workspace: report.workspace,
    packageRoot: report.packageRoot,
    packageName: report.packageName,
    scriptName: report.scriptName,
    args: report.args,
    exitCode: report.exitCode,
    durationMs: report.durationMs,
    stdoutSummary: report.stdoutSummary,
    stderrSummary: report.stderrSummary,
    outputSummary: report.outputSummary
  };
}

function dirtyHashFromFreshness(freshness: { headCommit: string | null; dirtyFiles: string[]; dirtyFileHashes: Record<string, string> }): string {
  return stableId(
    "autoverify-dirty-tree",
    freshness.headCommit ?? "null",
    JSON.stringify({
      dirtyFiles: [...freshness.dirtyFiles].sort(),
      dirtyFileHashes: Object.fromEntries(Object.entries(freshness.dirtyFileHashes).sort(([a], [b]) => a.localeCompare(b)))
    })
  );
}

function autoVerifySnapshotDigest(snapshot: TaskSnapshot): string {
  return stableId("autoverify-snapshot", snapshot.taskId, snapshot.createdAt, JSON.stringify(snapshot.plannedEditTargets), JSON.stringify(snapshot.plannedTests.map((test) => test.path)));
}

function absoluteSubpath(candidate: string, parent: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function sanitizeCommandReportForDisplay(report: DisplayCommandReport, repoRoot: string): DisplayCommandReport {
  return {
    ...report,
    command: sanitizeCommandText(report.command, repoRoot),
    cwd: sanitizePathField(report.cwd, repoRoot),
    packageManager: sanitizeSummary(report.packageManager, repoRoot),
    workspace: sanitizeSummary(report.workspace, repoRoot),
    packageRoot: sanitizePathField(report.packageRoot, repoRoot),
    packageName: sanitizeSummary(report.packageName, repoRoot),
    scriptName: sanitizeSummary(report.scriptName, repoRoot),
    stdoutSummary: sanitizeSummary(report.stdoutSummary, repoRoot),
    stderrSummary: sanitizeSummary(report.stderrSummary, repoRoot),
    outputSummary: sanitizeSummary(report.outputSummary, repoRoot),
    args: sanitizeCommandArgs(report.args, repoRoot),
    runner: sanitizeRunnerForDisplay(report.runner, repoRoot)
  };
}

function sanitizeRunnerForDisplay(runner: AutoVerifyReportRunner | undefined, repoRoot: string): AutoVerifyReportRunner | undefined {
  if (!runner) {
    return undefined;
  }
  return {
    ...runner,
    cwdRealpath: sanitizePathField(runner.cwdRealpath, repoRoot) ?? runner.cwdRealpath,
    targetRealpaths: runner.targetRealpaths.map((target) => sanitizePathField(target, repoRoot) ?? target),
    allowedBy: runner.allowedBy.map((reason) => sanitizeSummary(reason, repoRoot) ?? reason),
    skippedReason: sanitizeSummary(runner.skippedReason, repoRoot)
  };
}

function sanitizeCommandEnvelopeForDisplay(envelope: VerificationCommandEnvelope, repoRoot: string): VerificationCommandEnvelope {
  return {
    ...envelope,
    command: sanitizeCommandText(envelope.command, repoRoot),
    cwd: sanitizePathField(envelope.cwd, repoRoot),
    packageManager: sanitizeSummary(envelope.packageManager, repoRoot),
    workspace: sanitizeSummary(envelope.workspace, repoRoot),
    packageRoot: sanitizePathField(envelope.packageRoot, repoRoot),
    packageName: sanitizeSummary(envelope.packageName, repoRoot),
    scriptName: sanitizeSummary(envelope.scriptName, repoRoot),
    stdoutSummary: sanitizeSummary(envelope.stdoutSummary, repoRoot),
    stderrSummary: sanitizeSummary(envelope.stderrSummary, repoRoot),
    outputSummary: sanitizeSummary(envelope.outputSummary, repoRoot),
    args: sanitizeCommandArgs(envelope.args, repoRoot) ?? []
  };
}

function sanitizeCoverageForDisplay(entry: VerificationCoverage, repoRoot: string): VerificationCoverage {
  return {
    ...entry,
    command: sanitizeCommandText(entry.command, repoRoot),
    source: sanitizeSummary(entry.source, repoRoot) ?? entry.source,
    scope: sanitizePathField(entry.scope, repoRoot),
    targetPath: sanitizePathField(entry.targetPath, repoRoot),
    details: entry.details.map((detail) => sanitizeSummary(detail, repoRoot) ?? "").filter(Boolean),
    outputSummary: sanitizeSummary(entry.outputSummary, repoRoot),
    commandEnvelope: entry.commandEnvelope ? sanitizeCommandEnvelopeForDisplay(entry.commandEnvelope, repoRoot) : undefined
  };
}

function sanitizeLedgerForDisplay(entry: VerificationLedgerEntry, repoRoot: string): VerificationLedgerEntry {
  return {
    ...entry,
    command: entry.command ? sanitizeCommandText(entry.command, repoRoot) : undefined,
    evidence: entry.evidence.map((item) => sanitizeSummary(item, repoRoot) ?? "").filter(Boolean)
  };
}

function sanitizeCommandText(value: string, repoRoot: string): string {
  return sanitizeSummary(value, repoRoot) ?? "";
}

function sanitizeSummary(value: string | undefined, repoRoot: string): string | undefined {
  const clean = redactSecretText(value)
    ?.replaceAll(repoRoot, "<repo>")
    .replace(/__outside_repo__:[^\s;|)]+/gu, "__outside_repo__:<outside-repo>")
    .replace(/(^|[\s([,{])\/[^\s;|)\]'",]+/gu, "$1<abs-path>")
    .replace(/(^|[\s([,{])(?:\.\.?\/)[^\s;|)\]'",]+/gu, "$1<rel-path>")
    .replace(/\s+/gu, " ")
    .trim();
  if (!clean) {
    return undefined;
  }
  return clean.length > 500 ? `${clean.slice(0, 497)}...` : clean;
}

function sanitizeCommandArgs(args: string[] | undefined, repoRoot: string): string[] | undefined {
  if (!args) {
    return undefined;
  }
  let redactNext = false;
  return args.map((arg) => {
    if (redactNext) {
      redactNext = false;
      return "<redacted>";
    }
    if (isSecretFlag(arg) && !arg.includes("=")) {
      redactNext = true;
      return sanitizeSummary(arg, repoRoot) ?? "";
    }
    return sanitizeSummary(redactSecretArg(arg), repoRoot) ?? "";
  });
}

function redactSecretText(value: string | undefined): string | undefined {
  return value
    ?.replace(/(^|[\s([,{])((?:--?[a-z0-9-]*(?:token|secret|password|passwd|pwd|api[-_]?key|access[-_]?key|auth|credential|cookie)[a-z0-9-]*)(?:=|\s+))([^\s;|)\]'",]+)/giu, "$1$2<redacted>")
    .replace(/(\b[A-Z_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|PWD|API_?KEY|ACCESS_?KEY|AUTH|CREDENTIAL|COOKIE)[A-Z0-9_]*=)([^\s;|)\]'",]+)/gu, "$1<redacted>")
    .replace(/\b(Bearer)\s+[A-Za-z0-9._~+/-]+=*/giu, "$1 <redacted>");
}

function redactSecretArg(value: string): string {
  if (/^Bearer\s+/iu.test(value)) {
    return "Bearer <redacted>";
  }
  if (isSecretFlag(value) && value.includes("=")) {
    return value.replace(/=.*/u, "=<redacted>");
  }
  if (/^(?:[A-Z_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|PWD|API_?KEY|ACCESS_?KEY|AUTH|CREDENTIAL|COOKIE)[A-Z0-9_]*)=/iu.test(value)) {
    return value.replace(/=.*/u, "=<redacted>");
  }
  return value;
}

function isSecretFlag(value: string): boolean {
  return /^--?[a-z0-9-]*(?:token|secret|password|passwd|pwd|api-?key|access-?key|auth|credential|cookie)[a-z0-9-]*(?:=.*)?$/iu.test(value);
}

function sanitizePathField(value: string | undefined, repoRoot: string): string | undefined {
  if (!value) {
    return undefined;
  }
  if (value.startsWith("__outside_repo__:")) {
    return "__outside_repo__:<outside-repo>";
  }
  if (value === "." || value === "./") {
    return ".";
  }
  if (value === ".." || value.startsWith("../")) {
    return "<outside-repo>";
  }
  if (value.startsWith("./")) {
    const relative = normalizePathLike(value);
    return relative === "." ? "." : `<repo>/${relative}`;
  }
  if (path.isAbsolute(value)) {
    const relative = path.relative(repoRoot, value);
    if (relative === "") {
      return "<repo>";
    }
    return !relative.startsWith("..") && !path.isAbsolute(relative) ? `<repo>/${relative.split(path.sep).join("/")}` : "<outside-repo>";
  }
  return sanitizeSummary(value, repoRoot);
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

function limitArray<T>(value: T[], limit: number): T[] {
  return value.slice(0, limit);
}

function compactSnapshotForData(snapshot: TaskSnapshot | undefined): unknown {
  if (!snapshot) {
    return undefined;
  }
  return {
    taskId: snapshot.taskId,
    createdAt: snapshot.createdAt,
    changeType: snapshot.changeType,
    plannedEditTargets: limitArray(snapshot.plannedEditTargets, 30),
    plannedFiles: limitArray(snapshot.plannedFiles, 40),
    plannedTests: limitArray(snapshot.plannedTests, 20),
    requiredWorkflowCheckCount: snapshot.requiredWorkflowChecks.length,
    requiredDependencyCheckCount: snapshot.requiredDependencyChecks.length
  };
}

function buildAutoVerifyCandidates(input: { snapshot: TaskSnapshot | undefined; testsNotRun: TestRecommendation[]; reviewTargets: string[]; repoRoot: string }): AutoVerifyCandidate[] {
  const snapshot = input.snapshot;
  if (!snapshot) {
    return [];
  }
  const snapshotDigest = autoVerifySnapshotDigest(snapshot);
  return input.testsNotRun
    .filter((test) => test.command && test.commandCwd && test.commandExecutable && test.commandArgs)
    .map((test, index) => {
      const command = test.command!;
      const commandCwd = test.commandCwd!;
      const commandExecutable = test.commandExecutable!;
      const commandArgs = test.commandArgs!;
      return {
        schemaVersion: 1,
        taskId: snapshot.taskId,
        snapshotDigest,
        commandId: stableId("autoverify-command", snapshot.taskId, command, commandCwd, JSON.stringify(commandArgs)),
        command,
        commandExecutable,
        commandArgs,
        commandCwd,
        targetPaths: uniqueSorted([test.path, ...(test.provenance?.targetPaths ?? input.reviewTargets)]),
        source: autoVerifyCandidateSource(test.provenance),
        rank: test.rank - index / 100
      } satisfies AutoVerifyCandidate;
    });
}

function autoVerifyCandidateSource(provenance: TestRecommendationProvenance | undefined): AutoVerifyCandidate["source"] {
  const sources = provenance?.sources ?? [];
  if (sources.includes("explicit_target")) return "explicit";
  if (sources.includes("authoritative_test_edge")) return "authoritative-test-edge";
  if (sources.includes("derived_import") || sources.includes("derived_impact_expansion") || sources.includes("package_import") || sources.includes("outcome_history")) return "derived-impact";
  if (sources.length > 0) return "heuristic";
  return "legacy";
}

function stableSessionMemoryHash(value: string): string {
  return stableId("session-memory-summary", value);
}

function compactContextData(data: unknown): unknown {
  if (!data || typeof data !== "object") {
    return undefined;
  }
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

function hasRelevantVerificationEvidence(input: {
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
  if (
    input.verificationLedger.some(
      (entry) => (entry.status === "covered" || entry.status === "waived") && (checkedTargets.size === 0 || checkedTargets.has(normalizeReviewPath(entry.target)))
    )
  ) {
    return true;
  }

  const recommendedTests = new Set(input.tests.map((test) => normalizeReviewPath(test.path)));
  if (input.ranTests.some((test) => recommendedTests.has(normalizeReviewPath(test)))) {
    return true;
  }

  const changedTargets = uniqueSorted([...input.editPaths, ...input.reviewTargets].map(normalizeReviewPath).filter(Boolean));
  return input.verificationCoverage.some((coverage) => coverageIsRelevantProof(coverage, changedTargets, recommendedTests));
}

function coverageIsRelevantProof(coverage: VerificationCoverage, changedTargets: string[], recommendedTests: Set<string>): boolean {
  if (coverage.kind === "unknown" || coverage.kind === "audit" || coverage.kind === "privacy" || coverage.kind === "lint") {
    return false;
  }
  const target = coverage.targetPath ? normalizeReviewPath(coverage.targetPath) : undefined;
  if (target) {
    return changedTargets.includes(target) || recommendedTests.has(target) || changedTargets.some((changed) => pathIntersects(target, changed));
  }
  if (coverage.kind === "javascript-tests" || coverage.kind === "python-tests" || coverage.kind === "targeted-test") {
    return recommendedTests.size === 0 && changedTargets.some((changed) => scopeCoversReviewPath(coverage.scope ?? ".", changed));
  }
  if (coverage.kind === "build" || coverage.kind === "typescript-syntax") {
    return changedTargets.some((changed) => sourcePathFitsCoverageKind(changed, coverage.kind) && scopeCoversReviewPath(coverage.scope ?? ".", changed));
  }
  return false;
}

function sourcePathFitsCoverageKind(filePath: string, kind: VerificationCoverage["kind"]): boolean {
  if (kind === "typescript-syntax") {
    return /\.(?:[cm]?[jt]sx?)$/iu.test(filePath);
  }
  if (kind === "build") {
    return !isTestPath(filePath);
  }
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
