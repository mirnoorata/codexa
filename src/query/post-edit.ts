import { groupDiffImpact, formatDiffGroups, formatGaps, indexGaps } from "./diff.js";
import { clampInt, fitLinesToTokenBudget, formatReasons } from "./formatting.js";
import { affectedWorkflowGraphEdges, testsFromGraphEdges } from "./graph.js";
import { contextPackQuery, focusBriefQuery } from "./context.js";
import { formatContextQuality, type ContextQuality } from "./quality.js";
import { freshnessBanner } from "./runtime.js";
import { ensureQuerySession, type QuerySessionInput } from "./session.js";
import { normalizeSearchText } from "./search.js";
import { formatTestRecommendations, recommendTests, uniqueTests, wasTestRun } from "./tests.js";
import { findFile, normalizeInputPaths, resolveSymbolTarget } from "./targets.js";
import { isCodexaControlPath, formatChangedEntry } from "./worktree.js";
import { loadTaskSnapshot, saveTaskSnapshot } from "../task-snapshots.js";
import type {
  ChangedFileEntry,
  ChangePlanInput,
  ChangeType,
  CodexaIndex,
  DiffImpactGroup,
  EvidenceTier,
  FileFact,
  PostEditReviewInput,
  QueryOptions,
  QueryResult,
  TaskSnapshot,
  TaskSnapshotRiskFile,
  TaskSnapshotSymbol,
  TestRecommendation,
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
          plannedTests: tests,
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
    "Known gaps:",
    ...formatGaps(packData.gaps ?? [])
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
  return {
    freshness: pack.freshness,
    refresh: pack.refresh,
    text: limitText(text, 7000),
    data: { mode: "change_plan", steps: planSteps, focus: focus.data, context: pack.data, files, plannedEditTargets, tests, recipes, quality, snapshot: savedSnapshot?.snapshot }
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
  const riskDeltas = compareSnapshotRisks(snapshot, index, uniqueSorted([...reviewTargets, ...editPaths]));
  const affectedEdges = affectedWorkflowGraphEdges(index, reviewTargets).slice(0, 20);
  const affectedTests = uniqueSorted([
    ...testsFromGraphEdges(affectedEdges),
    ...index.testEdges.filter((edge) => edge.targetPath && reviewTargets.includes(edge.targetPath)).map((edge) => edge.path)
  ]);
  const tests = uniqueTests([...(contextData.tests ?? []), ...recommendTests(index, reviewTargets.length > 0 ? reviewTargets : currentDirtyPaths, repoRoot)]).slice(0, 12);
  const ranTests = input.ranTests ?? [];
  const testsNotRun = tests.filter((test) => !wasTestRun(test, ranTests));
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
    contextData.quality?.level === "low" ? "low context quality after edit" : undefined,
    hasActualEditedFiles && riskEscalations.length > 0 ? `${riskEscalations.length} high-risk or unplanned target(s)` : undefined,
    hasActualEditedFiles && tests.length > 0 && ranTests.length === 0 ? "recommended tests have not been reported as run" : undefined,
    hasActualEditedFiles && testsNotRun.length > 0 && ranTests.length > 0 ? `${testsNotRun.length} recommended test(s) not found in ranTests` : undefined
  ].filter((reason): reason is string => Boolean(reason));
  const verdict: "continue" | "run_tests" | "inspect" | "replan" =
    headChanged || unplannedEditedFiles.length >= 3 || contextData.quality?.level === "low"
      ? "replan"
      : !snapshot || unplannedEditedFiles.length > 0 || unplannedChangedSymbols.length > 0 || (hasActualEditedFiles && riskEscalations.length > 0) || contextData.quality?.level === "medium"
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
    workflows
  });
  const quality = contextData.quality;
  const text = [
    freshnessBanner(freshness, refresh),
    quality ? formatContextQuality(quality) : undefined,
    "Codexa post-edit review",
    `Task: ${task}`,
    snapshot ? `Snapshot: ${snapshot.taskId} (${snapshot.createdAt})` : `Snapshot: unavailable${loadedSnapshot.missingReason ? ` (${loadedSnapshot.missingReason})` : ""}; using current dirty tree only`,
    `Verdict: ${verdict}`,
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
    "Recommended tests:",
    ...formatTestRecommendations(tests),
    ranTests.length > 0 ? `Reported ran tests: ${ranTests.join(", ")}` : "Reported ran tests: none",
    testsNotRun.length > 0 ? `Tests still unaccounted for: ${testsNotRun.slice(0, 8).map((test) => test.path).join(", ")}` : "Tests still unaccounted for: none",
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
      snapshot,
      snapshotLoad: {
        taskId: loadedSnapshot.latestTaskId,
        path: loadedSnapshot.path,
        missingReason: loadedSnapshot.missingReason,
        error: loadedSnapshot.error,
        recoveredLatest: loadedSnapshot.recoveredLatest
      },
      files: selectedFiles,
      reviewTargets,
      changedSinceSnapshot,
      changedGroups,
      resolvedBaselineFiles,
      unplannedEditedFiles,
      plannedRenames,
      unplannedChangedSymbols,
      plannedButUntouchedFiles,
      headChanged,
      symbolDeltas,
      riskDeltas,
      affectedEdges,
      affectedTests,
      tests,
      testsNotRun,
      ranTests,
      unindexedEditedFiles,
      riskEscalations,
      workflows,
      context: context.data,
      quality,
      driftReasons,
      nextActions
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

function postEditNextActions(
  verdict: "continue" | "run_tests" | "inspect" | "replan",
  input: {
    snapshot?: TaskSnapshot;
    unplannedEditedFiles: string[];
    testsNotRun: TestRecommendation[];
    riskEscalations: FileFact[];
    reviewTargets: string[];
    workflows: WorkflowTraceFact[];
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
      input.testsNotRun.length > 0 ? `Run or explicitly account for: ${input.testsNotRun.slice(0, 6).map((test) => test.path).join(", ")}` : "Targeted tests are accounted for.",
      input.workflows.length > 0 ? `Call workflow_path for ${input.workflows[0].title} if behavior changed.` : "Call callers or dependency_path if the touched file changes a public contract."
    ];
  }
  if (verdict === "run_tests") {
    return [`Run or account for: ${input.testsNotRun.slice(0, 6).map((test) => test.path).join(", ")}`, "After tests pass, call post_edit_review again with ranTests."];
  }
  return ["No drift detected against the saved snapshot. Finish with the normal source diff review and targeted tests already reported."];
}
