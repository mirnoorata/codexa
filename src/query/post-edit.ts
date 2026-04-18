import path from "node:path";
import { isTestPath } from "../language.js";
import { groupDiffImpact, formatDiffGroups, formatGaps, indexGaps } from "./diff.js";
import { clampInt, fitLinesToTokenBudget, formatReasons } from "./formatting.js";
import { affectedWorkflowGraphEdges, testsFromGraphEdges } from "./graph.js";
import { contextPackQuery, focusBriefQuery } from "./context.js";
import { formatContextQuality, type ContextQuality } from "./quality.js";
import { freshnessBanner } from "./runtime.js";
import { ensureQuerySession, type QuerySessionInput } from "./session.js";
import { normalizeSearchText } from "./search.js";
import { formatTestRecommendations, narrowTestRecommendationsByChangeType, recommendTests, uniqueTests } from "./tests.js";
import { findFile, normalizeInputPaths, resolveSymbolTarget } from "./targets.js";
import { formatVerificationCoverage, formatVerificationLedger, verificationEvidenceForCommandReports, verificationLedgerForPostEdit } from "./verification.js";
import { isCodexaControlPath, formatChangedEntry } from "./worktree.js";
import { buildPostEditOutcome, savePostEditOutcome, type PostEditCheckResult, type PostEditOutcomeInput } from "../post-edit-outcomes.js";
import { loadTaskSnapshot, saveTaskSnapshot } from "../task-snapshots.js";
import { CURRENT_VERIFICATION_PROVENANCE } from "../types.js";
import type {
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
  TaskSnapshot,
  TaskSnapshotRequiredCheck,
  TaskSnapshotRiskFile,
  TaskSnapshotSymbol,
  TestRecommendation,
  VerificationCommandEnvelope,
  VerificationCoverage,
  VerificationCommandReport,
  VerificationLedgerEntry,
  WorkflowTraceFact
} from "../types.js";
import { limitText, uniqueSorted } from "../util.js";

export async function changePlanQuery(
  sessionInput: QuerySessionInput,
  input: ChangePlanInput = {},
  options: QueryOptions = {}
): Promise<QueryResult> {
  const session = await ensureQuerySession(sessionInput, options);
  const repoRoot = session.repoRoot;
  const focus = await focusBriefQuery(session, { task: input.task, tokenBudget: Math.min(input.tokenBudget ?? 2600, 3000), limit: input.limit ?? 8, diff: input.diff }, options);
  const pack = await contextPackQuery(session, { ...input, tokenBudget: Math.min(input.tokenBudget ?? 3200, 4000), limit: input.limit ?? 10, includeSnippets: input.includeSnippets ?? false }, options);
  const packData = pack.data as {
    focusFiles?: Array<{ file: FileFact; reasons: string[]; tier: EvidenceTier }>;
    changedEntries?: ChangedFileEntry[];
    changedFiles?: string[];
    tests?: TestRecommendation[];
    recipes?: string[];
    quality?: ContextQuality;
    gaps?: string[];
    warnings?: string[];
  };
  const focusData = focus.data as { nextCall?: { tool: string; reason: string; arguments?: Record<string, unknown> }; workflows?: WorkflowTraceFact[]; modules?: unknown[] };
  const focusFiles = packData.focusFiles ?? [];
  const tests = packData.tests ?? [];
  const recipes = packData.recipes ?? [];
  const files = focusFiles.map((entry) => entry.file.path);
  const explicitFiles = normalizeInputPaths(input.files ?? [], repoRoot);
  const explicitSymbolFiles = focusFiles
    .filter((entry) => entry.reasons.some((reason) => reason.startsWith("requested symbol ")))
    .map((entry) => entry.file.path);
  const plannedEditTargets = uniqueSorted(explicitFiles.length > 0 || explicitSymbolFiles.length > 0 ? [...explicitFiles, ...explicitSymbolFiles] : files.slice(0, 6));
  const focusPathSet = new Set(files);
  const explicitWorkflowPaths = new Set(normalizeInputPaths(input.files ?? [], repoRoot));
  const workflowMatchPaths = explicitWorkflowPaths.size > 0 ? explicitWorkflowPaths : focusPathSet;
  const relatedWorkflow = focusData.workflows?.find((workflow) => workflow.relatedFiles.some((file) => workflowMatchPaths.has(file)));
  const requiredWorkflowChecks = requiredWorkflowChecksForPlan(focusData.workflows ?? [], workflowMatchPaths, input.changeType ?? "unknown").slice(0, 8);
  const requiredDependencyChecks = requiredDependencyChecksForPlan(session.index, plannedEditTargets, input.changeType ?? "unknown").slice(0, 12);
  const planSteps = [
    `1. Read ${files.slice(0, 6).join(", ") || "the focus files returned by Codexa"} before editing.`,
    relatedWorkflow
      ? `2. Inspect workflow_path for ${relatedWorkflow.title} if the change touches runtime flow.`
      : input.files?.length || input.symbols?.length
        ? "2. Use callers, callees, or dependency_path if this focused edit changes an exported API or runtime contract."
        : `2. Use ${focusData.nextCall?.tool ?? "task_brief"} next if the edit target is still ambiguous.`,
    tests.length > 0 ? `3. Keep these tests in scope: ${tests.slice(0, 5).map((test) => test.path).join(", ")}.` : "3. No targeted tests were proven; inspect repo test metadata before inventing a command.",
    recipes.length > 0 ? `4. Verification: ${recipes.slice(0, 3).join(" ")}` : "4. Run the narrowest verified test or type check that covers the touched files.",
    "5. Re-run Codexa task_brief after edits if freshness reports dirty-files-changed."
  ];
  const quality = packData.quality ?? (focus.data as { quality?: ContextQuality }).quality;
  const snapshotIndex = input.saveSnapshot ? session.index : undefined;
  const snapshotScope = uniqueSorted([...plannedEditTargets, ...files]);
  const savedSnapshot = input.saveSnapshot
    ? await saveTaskSnapshot({
        repoRoot,
        input,
        snapshot: {
          task: input.task,
          changeType: input.changeType ?? "unknown",
          snapshotFreshness: pack.freshness,
          plannedEditTargets,
          plannedFiles: files,
          focusFiles: focusFiles.map((entry) => ({
            path: entry.file.path,
            tier: entry.tier,
            reasons: uniqueSorted(entry.reasons),
            rank: entry.file.rank,
            riskScore: entry.file.riskScore
          })),
          plannedTests: compactSnapshotTests(tests, repoRoot),
          requiredWorkflowChecks,
          requiredDependencyChecks,
          symbolBaseline: snapshotIndex ? snapshotSymbolBaseline(snapshotIndex, snapshotScope) : undefined,
          riskBaseline: snapshotIndex ? snapshotRiskBaseline(snapshotIndex, snapshotScope) : undefined,
          recipes,
          dirtyBaseline: {
            changedEntries: packData.changedEntries ?? [],
            dirtyFiles: pack.freshness.dirtyFiles,
            dirtyFileHashes: pack.freshness.dirtyFileHashes,
            headCommit: pack.freshness.headCommit,
            indexedAt: pack.freshness.indexedAt
          },
          quality,
          gaps: packData.gaps ?? [],
          warnings: packData.warnings ?? []
        }
      })
    : undefined;
  const text = [
    freshnessBanner(pack.freshness, pack.refresh),
    quality ? formatContextQuality(quality) : undefined,
    "Codexa change plan",
    input.task ? `Task: ${input.task}` : undefined,
    savedSnapshot ? `Task snapshot: ${savedSnapshot.snapshot.taskId}` : undefined,
    "",
    ...planSteps,
    "",
    "Read first:",
    ...focusFiles.slice(0, 10).map((entry) => `- ${entry.file.path}: ${entry.tier}; ${entry.reasons.join("; ")}`),
    "",
    "Tests:",
    ...formatTestRecommendations(tests.slice(0, 12)),
    "",
    "Required workflow checks:",
    ...formatRequiredChecks(requiredWorkflowChecks),
    "",
    "Required dependency checks:",
    ...formatRequiredChecks(requiredDependencyChecks),
    "",
    "Known gaps:",
    ...formatGaps(packData.gaps ?? [])
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
  return {
    freshness: pack.freshness,
    refresh: pack.refresh,
    text: limitText(text, 7000),
    data: {
      mode: "change_plan",
      steps: planSteps,
      focus: focus.data,
      context: pack.data,
      files,
      plannedEditTargets,
      tests,
      recipes,
      quality,
      requiredWorkflowChecks,
      requiredDependencyChecks,
      snapshot: savedSnapshot?.snapshot
    }
  };
}

function snapshotSymbolBaseline(index: CodexaIndex, paths: string[]): Record<string, TaskSnapshotSymbol[]> {
  const pathSet = new Set(paths);
  const result: Record<string, TaskSnapshotSymbol[]> = {};
  for (const filePath of pathSet) {
    result[filePath] = index.symbols
      .filter((symbol) => symbol.path === filePath)
      .map((symbol) => ({
        id: symbol.id,
        path: symbol.path,
        name: symbol.name,
        qualifiedName: symbol.qualifiedName,
        kind: symbol.kind,
        range: symbol.range
      }))
      .sort((a, b) => (a.range?.startLine ?? 0) - (b.range?.startLine ?? 0) || a.qualifiedName.localeCompare(b.qualifiedName));
  }
  return result;
}

function snapshotRiskBaseline(index: CodexaIndex, paths: string[]): Record<string, TaskSnapshotRiskFile> {
  const pathSet = new Set(paths);
  const result: Record<string, TaskSnapshotRiskFile> = {};
  for (const filePath of pathSet) {
    const file = findFile(index, filePath);
    const signals = index.risks.filter((risk) => risk.path === filePath).map((risk) => `${risk.signal}: ${risk.reason}`).sort();
    result[filePath] = {
      riskScore: file?.riskScore ?? signals.length,
      signals
    };
  }
  return result;
}

function compactSnapshotTests(tests: TestRecommendation[], repoRoot: string): TestRecommendation[] {
  return tests.map((test) => ({
    ...test,
    command: test.command?.replaceAll(repoRoot, "<repo>")
  }));
}

function requiredWorkflowChecksForPlan(
  workflows: WorkflowTraceFact[],
  pathScope: Set<string>,
  changeType: ChangeType
): TaskSnapshotRequiredCheck[] {
  return workflows
    .filter((workflow) => workflow.relatedFiles.some((filePath) => pathScope.has(filePath)) || pathScope.has(workflow.entryPath))
    .sort((a, b) => b.rank - a.rank || a.title.localeCompare(b.title))
    .map((workflow) => ({
      kind: "workflow" as const,
      target: workflow.title,
      reason:
        changeType === "style"
          ? "workflow is adjacent to the planned edit; spot-check only if behavior changed"
          : `planned edit intersects ${workflow.workflowKind} workflow evidence`,
      evidenceTier: workflow.confidence === "authoritative" ? "authoritative" : workflow.confidence === "derived" ? "derived" : "heuristic",
      confidence: workflow.confidence,
      paths: uniqueSorted([workflow.entryPath, ...workflow.relatedFiles, ...workflow.tests]).slice(0, 20)
    }));
}

function requiredDependencyChecksForPlan(index: CodexaIndex, paths: string[], changeType: ChangeType): TaskSnapshotRequiredCheck[] {
  if (paths.length === 0) {
    return [];
  }
  const pathSet = new Set(paths);
  const edgeChecks = index.graphEdges
    .filter((edge) => pathSet.has(edge.fromPath ?? "") || pathSet.has(edge.toPath ?? ""))
    .filter((edge) => ["IMPORTS", "CALLS", "REFERENCES", "TESTS", "EXTENDS", "IMPLEMENTS", "EXPORTS", "TYPE_EXPORTS"].includes(edge.edgeKind))
    .sort((a, b) => b.weight - a.weight || a.edgeKind.localeCompare(b.edgeKind) || (a.fromPath ?? "").localeCompare(b.fromPath ?? "") || (a.toPath ?? "").localeCompare(b.toPath ?? ""))
    .slice(0, 10)
    .map((edge) => ({
      kind: "dependency" as const,
      target: `${edge.edgeKind}: ${edge.fromPath ?? edge.fromId} -> ${edge.toPath ?? edge.toId}`,
      reason:
        changeType === "style"
          ? "dependency edge is adjacent to the planned edit; verify if public behavior changed"
          : `planned edit has typed ${edge.edgeKind} dependency evidence`,
      evidenceTier: (edge.confidence === "authoritative" ? "authoritative" : edge.confidence === "derived" ? "derived" : "heuristic") as EvidenceTier,
      confidence: edge.confidence,
      paths: uniqueSorted([edge.fromPath, edge.toPath].filter((filePath): filePath is string => Boolean(filePath)))
    }));
  const publicFiles = index.files
    .filter((file) => pathSet.has(file.path))
    .filter((file) => file.rank >= 4 || file.riskScore >= 2)
    .sort((a, b) => b.rank - a.rank || b.riskScore - a.riskScore || a.path.localeCompare(b.path))
    .slice(0, 4)
    .map((file) => ({
      kind: "dependency" as const,
      target: `public-surface: ${file.path}`,
      reason: `planned target is ranked ${file.rank.toFixed(2)} with risk ${file.riskScore.toFixed(1)}; check callers/tests before completion`,
      evidenceTier: "derived" as const,
      confidence: "derived" as const,
      paths: uniqueSorted([
        file.path,
        ...index.graphEdges
          .filter((edge) => edge.fromPath === file.path || edge.toPath === file.path)
          .flatMap((edge) => [edge.fromPath, edge.toPath])
          .filter((filePath): filePath is string => Boolean(filePath) && filePath !== file.path)
      ]).slice(0, 12)
    }));
  return dedupeRequiredChecks([...edgeChecks, ...publicFiles]);
}

function dedupeRequiredChecks(checks: TaskSnapshotRequiredCheck[]): TaskSnapshotRequiredCheck[] {
  const seen = new Set<string>();
  const result: TaskSnapshotRequiredCheck[] = [];
  for (const check of checks) {
    const key = `${check.kind}\0${check.target}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(check);
  }
  return result;
}

function formatRequiredChecks(checks: TaskSnapshotRequiredCheck[]): string[] {
  if (checks.length === 0) {
    return ["- none proven from current graph evidence"];
  }
  return checks.slice(0, 10).map((check) => `- ${check.target}: ${check.confidence}; ${check.reason}`);
}

export async function postEditReviewQuery(
  sessionInput: QuerySessionInput,
  input: PostEditReviewInput = {},
  options: QueryOptions = {}
): Promise<QueryResult> {
  const session = await ensureQuerySession(sessionInput, options);
  const { index, freshness, refresh, repoRoot } = session;
  const tokenBudget = clampInt(input.tokenBudget ?? 2800, 600, 10000);
  const limit = clampInt(input.limit ?? 10, 3, 30);
  const loadedSnapshot = await loadTaskSnapshot(repoRoot, input.taskId);
  const snapshot = loadedSnapshot.snapshot;
  const currentEntries = await session.getChangedFileEntries();
  const currentDirtyPaths = currentEntries.map((entry) => entry.path);
  const baselinePaths = new Set(snapshot?.dirtyBaseline.dirtyFiles ?? snapshot?.dirtyBaseline.changedEntries.map((entry) => entry.path) ?? []);
  const baselineHashes = snapshot?.dirtyBaseline.dirtyFileHashes ?? {};
  const currentHashes = freshness.dirtyFileHashes;
  const changedSinceSnapshot = snapshot
    ? currentEntries.filter((entry) => !baselinePaths.has(entry.path) || baselineHashes[entry.path] !== currentHashes[entry.path])
    : currentEntries;
  const resolvedBaselineFiles = snapshot ? uniqueSorted([...baselinePaths].filter((filePath) => !currentDirtyPaths.includes(filePath))) : [];
  const editPaths = uniqueSorted(changedSinceSnapshot.map((entry) => entry.path).filter((filePath) => !isCodexaControlPath(filePath)));
  const indexedPaths = new Set(index.files.map((file) => file.path));
  const unindexedEditedFiles = editPaths.filter((filePath) => !indexedPaths.has(filePath));
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
    { autoRefresh: false }
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
  };
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
  const plannedSnapshotTests = snapshot?.plannedTests ?? [];
  // The snapshot's plannedTests and the context pack's tests were
  // collected without the current `changeType` override, so stale
  // heuristic cross-language recommendations (e.g. a Python pytest
  // surfaced only via package-scope naming) can leak through to
  // post-edit output. Re-narrow the merged list against the current
  // change-type so `--change-type style` gives the same quiet result
  // whether the snapshot was saved before or after the user decided
  // the edit was cosmetic.
  //
  // Known limitation: stale authoritative/derived entries from a
  // broader-scope snapshot (e.g. user ran `/codexa-plan` with many
  // files, then later runs `/codexa-review --change-type style`
  // against a narrower edit) will still survive the narrowing — the
  // filter deliberately preserves graph-proven coverage, and without
  // provenance tracking we can't tell "this authoritative entry was
  // proven against the OLD plan, not the current dirty tree." The
  // recommended workflow mitigates this: re-run `/codexa-plan` against
  // the narrower scope before `/codexa-review` so the snapshot's
  // plannedTests reflect the same targets as the review.
  const mergedTests = uniqueTests([
    ...plannedSnapshotTests,
    ...(contextData.tests ?? []),
    ...recommendTests(index, reviewTargets.length > 0 ? reviewTargets : currentDirtyPaths, repoRoot, changeType)
  ]);
  const tests = narrowTestRecommendationsByChangeType(
    mergedTests,
    reviewTargets.length > 0 ? reviewTargets : currentDirtyPaths,
    changeType
  ).slice(0, 12);
  const ranTests = input.ranTests ?? [];
  const ranCommands = input.ranCommands ?? [];
  const ranCommandReports = input.ranCommandReports ?? [];
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
  const dataRanCommandReports = ranCommandReports.map((report) => sanitizeCommandReportForDisplay(report, repoRoot));
  const dataRanCommands = ranCommands.map((command) => sanitizeCommandText(command, repoRoot));
  const dataCommandEnvelopes = commandEnvelopes.map((envelope) => sanitizeCommandEnvelopeForDisplay(envelope, repoRoot));
  const dataVerificationCoverage = verificationCoverage.map((entry) => sanitizeCoverageForDisplay(entry, repoRoot));
  const dataVerificationLedger = verificationLedger.map((entry) => sanitizeLedgerForDisplay(entry, repoRoot));
  const dataWaivedVerification = dataVerificationLedger.filter((entry) => entry.status === "waived");
  const missedLikelyTests = testsNotRun;
  const hasTestVerificationAccounting =
    ranTests.length > 0 ||
    waivedChecks.length > 0 ||
    waivers.some((waiver) => waiver.kind === "test") ||
    verificationLedger.some((entry) => entry.kind === "test" && (entry.status === "covered" || entry.status === "waived"));
  const driftReasons = [
    !snapshot ? `missing task snapshot${loadedSnapshot.missingReason ? `: ${loadedSnapshot.missingReason}` : ""}` : undefined,
    loadedSnapshot.missingReason === "invalid-json" ? loadedSnapshot.error : undefined,
    headChanged ? "git head changed since snapshot" : undefined,
    unplannedEditedFiles.length > 0 ? `${unplannedEditedFiles.length} edited file(s) outside planned scope` : undefined,
    unplannedChangedSymbols.length > 0 ? `${unplannedChangedSymbols.length} changed symbol(s) outside requested symbol target` : undefined,
    unindexedEditedFiles.length > 0 ? `${unindexedEditedFiles.length} changed-since-snapshot file(s) are not indexed` : undefined,
    symbolDeltas.some((delta) => delta.newSymbols.length > 0 || delta.removedSymbols.length > 0)
      ? `${symbolDeltas.reduce((sum, delta) => sum + delta.newSymbols.length + delta.removedSymbols.length, 0)} symbol delta(s) detected`
      : undefined,
    riskDeltas.some((delta) => delta.delta > 0) ? `${riskDeltas.filter((delta) => delta.delta > 0).length} file(s) increased risk` : undefined,
    workflowChecks.some((check) => check.status === "missing") ? `${workflowChecks.filter((check) => check.status === "missing").length} required workflow check(s) missing` : undefined,
    dependencyChecks.some((check) => check.status === "missing") ? `${dependencyChecks.filter((check) => check.status === "missing").length} required dependency check(s) missing` : undefined,
    contextData.quality?.level === "low" ? "low context quality after edit" : undefined,
    hasActualEditedFiles && riskEscalations.length > 0 ? `${riskEscalations.length} high-risk or unplanned target(s)` : undefined,
    waivedVerification.length > 0 ? `${waivedVerification.length} verification item(s) explicitly waived` : undefined,
    hasActualEditedFiles && testsNotRun.length > 0 && !hasTestVerificationAccounting
      ? "recommended tests have not been accounted for"
      : undefined,
    hasActualEditedFiles && testsNotRun.length > 0 && hasTestVerificationAccounting
      ? `${testsNotRun.length} recommended test(s) remain unaccounted for`
      : undefined
  ].filter((reason): reason is string => Boolean(reason));
  const verdict: "continue" | "run_tests" | "inspect" | "replan" =
    headChanged || unplannedEditedFiles.length >= 3 || contextData.quality?.level === "low"
      ? "replan"
      : !snapshot ||
          unplannedEditedFiles.length > 0 ||
          unplannedChangedSymbols.length > 0 ||
          workflowChecks.some((check) => check.status === "missing") ||
          dependencyChecks.some((check) => check.status === "missing") ||
          waivedVerification.length > 0 ||
          (hasActualEditedFiles && riskEscalations.length > 0) ||
          contextData.quality?.level === "medium"
        ? "inspect"
        : hasActualEditedFiles && testsNotRun.length > 0
          ? "run_tests"
          : "continue";
  const nextActions = postEditNextActions(verdict, {
    snapshot,
    unplannedEditedFiles,
    testsNotRun,
    riskEscalations,
    reviewTargets,
    workflows,
    missingChecks: [...workflowChecks, ...dependencyChecks].filter((check) => check.status === "missing")
  });
  const quality = contextData.quality;
  const outcomeInput: PostEditOutcomeInput = {
    repoRoot,
    task,
    taskId: snapshot?.taskId ?? loadedSnapshot.latestTaskId,
    snapshotPath: loadedSnapshot.path ? path.relative(repoRoot, loadedSnapshot.path).split(path.sep).join("/") : undefined,
    verdict,
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
    testsNotRun,
    missedLikelyTests,
    ranTests,
    ranCommands,
    ranCommandReports,
    commandEnvelopes,
    waivedChecks,
    waivers,
    verificationCoverage,
    verificationLedger,
    verificationProvenance: CURRENT_VERIFICATION_PROVENANCE,
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
    `Task: ${task}`,
    snapshot ? `Snapshot: ${snapshot.taskId} (${snapshot.createdAt})` : `Snapshot: unavailable${loadedSnapshot.missingReason ? ` (${loadedSnapshot.missingReason})` : ""}; using current dirty tree only`,
    `Verdict: ${verdict}`,
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
    "",
    "Required workflow checks:",
    ...formatCheckResults(workflowChecks),
    "",
    "Required dependency checks:",
    ...formatCheckResults(dependencyChecks),
    "",
    "Recommended tests:",
    ...formatTestRecommendations(tests),
    ranTests.length > 0 ? `Reported ran tests: ${ranTests.join(", ")}` : "Reported ran tests: none",
    dataRanCommands.length > 0 ? `Reported ran commands: ${dataRanCommands.join(" | ")}` : "Reported ran commands: none",
    dataRanCommandReports.length > 0 ? `Reported command reports: ${dataRanCommandReports.map(formatCommandReport).join(" | ")}` : "Reported command reports: none",
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
      snapshot: compactSnapshotForData(snapshot),
      snapshotLoad: {
        taskId: loadedSnapshot.latestTaskId,
        path: loadedSnapshot.path,
        missingReason: loadedSnapshot.missingReason,
        error: loadedSnapshot.error,
        recoveredLatest: loadedSnapshot.recoveredLatest
      },
      files: selectedFiles,
      reviewTargets,
      changedSinceSnapshot: limitArray(changedSinceSnapshot, 40),
      changedGroups: limitArray(changedGroups, 20),
      resolvedBaselineFiles: limitArray(resolvedBaselineFiles, 30),
      unplannedEditedFiles,
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
      testsNotRun: limitArray(testsNotRun, 30),
      missedLikelyTests: limitArray(missedLikelyTests, 30),
      ranTests,
      ranCommands: dataRanCommands,
      ranCommandReports: dataRanCommandReports,
      commandEnvelopes: dataCommandEnvelopes,
      waivedChecks,
      waivers,
      verificationCoverage: limitArray(dataVerificationCoverage, 40),
      verificationLedger: limitArray(dataVerificationLedger, 60),
      verificationProvenance: CURRENT_VERIFICATION_PROVENANCE,
      waivedVerification: limitArray(dataWaivedVerification, 30),
      unindexedEditedFiles,
      riskEscalations: limitArray(riskEscalations, 20),
      workflows: limitArray(workflows, 12),
      workflowChecks: limitArray(workflowChecks, 20),
      dependencyChecks: limitArray(dependencyChecks, 30),
      context: compactContextData(context.data),
      quality,
      driftReasons,
      nextActions,
      outcome: {
        ...outcome,
        persisted: Boolean(savedOutcome),
        path: outcomePath
      }
    }
  };
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
      const beforeSignals = new Set(before.signals);
      const afterSignals = new Set(after.signals);
      return {
        path: filePath,
        before,
        after,
        delta: after.riskScore - before.riskScore,
        newSignals: after.signals.filter((signal) => !beforeSignals.has(signal)),
        removedSignals: before.signals.filter((signal) => !afterSignals.has(signal))
      };
    })
    .filter((delta) => Math.abs(delta.delta) > 0.01 || delta.newSignals.length > 0 || delta.removedSignals.length > 0)
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta) || a.path.localeCompare(b.path));
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
    if (!["build", "typescript-syntax", "javascript-tests", "python-tests"].includes(coverage.kind)) {
      return false;
    }
    if (coverage.targetPath) {
      return checkPaths.includes(normalizePathLike(coverage.targetPath));
    }
    return sourcePaths.some((filePath) => coverageCoversPath(coverage, filePath));
  });
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

function sanitizeCommandReportForDisplay(report: VerificationCommandReport, repoRoot: string): VerificationCommandReport {
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
    args: sanitizeCommandArgs(report.args, repoRoot)
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
    ?.replace(/((?:--?|[A-Z_]*)(?:token|secret|password|passwd|pwd|api[-_]?key|access[-_]?key|auth|credential|cookie)[A-Z0-9_-]*(?:=|\s+))([^\s;|)\]'",]+)/giu, "$1<redacted>")
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

function postEditNextActions(
  verdict: "continue" | "run_tests" | "inspect" | "replan",
  input: {
    snapshot?: TaskSnapshot;
    unplannedEditedFiles: string[];
    testsNotRun: TestRecommendation[];
    riskEscalations: FileFact[];
    reviewTargets: string[];
    workflows: WorkflowTraceFact[];
    missingChecks: PostEditCheckResult[];
  }
): string[] {
  if (verdict === "replan") {
    return [
      "Call change_plan again with saveSnapshot=true before making more edits.",
      input.unplannedEditedFiles.length > 0 ? `Inspect unplanned edits first: ${input.unplannedEditedFiles.slice(0, 6).join(", ")}` : "Inspect the low-quality or stale evidence before continuing.",
      input.testsNotRun.length > 0 ? `Run or justify the top targeted tests: ${input.testsNotRun.slice(0, 4).map((test) => test.path).join(", ")}` : "Rebuild a narrow test plan after re-planning."
    ];
  }
  if (verdict === "inspect") {
    return [
      input.snapshot ? "Read the unplanned or high-risk files before treating the edit as complete." : "No saved task snapshot was available; treat this as a dirty-diff review, not a drift proof.",
      input.riskEscalations.length > 0 ? `Check risk targets: ${input.riskEscalations.slice(0, 5).map((file) => file.path).join(", ")}` : `Check review targets: ${input.reviewTargets.slice(0, 6).join(", ") || "none"}`,
      input.missingChecks.length > 0 ? `Resolve required checks: ${input.missingChecks.slice(0, 4).map((check) => check.target).join(", ")}` : "Required snapshot checks are covered.",
      input.testsNotRun.length > 0 ? `Run or explicitly account for: ${input.testsNotRun.slice(0, 6).map((test) => test.path).join(", ")}` : "Targeted tests are accounted for.",
      input.workflows.length > 0 ? `Call workflow_path for ${input.workflows[0].title} if behavior changed.` : "Call callers or dependency_path if the touched file changes a public contract."
    ];
  }
  if (verdict === "run_tests") {
    return [
      `Run or account for: ${input.testsNotRun.slice(0, 6).map((test) => test.path).join(", ")}`,
      "After checks pass, call post_edit_review again with ranCommands for commands you ran, or ranTests only for direct file/test accounting."
    ];
  }
  return ["No drift detected against the saved snapshot. Finish with the normal source diff review and targeted tests already reported."];
}
