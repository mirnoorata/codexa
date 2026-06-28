import { promises as fs } from "node:fs";
import path from "node:path";
import { isTestPath, moduleNameForPath } from "../language.js";
import type { ChangedSymbol, CodexaIndex, ContextPackInput, DiffImpactGroup, EvidenceTier, FileFact, FocusBriefInput, QueryOptions, QueryResult } from "../types.js";
import { limitText, uniqueSorted } from "../util.js";
import { formatDiffGroups, formatGaps, groupDiffImpact, indexGaps } from "./diff.js";
import { addContextPackImpactExpansion, verificationRecipes } from "./impact.js";
import { lspAssistForFiles, lspOptionsFromQueryOptions } from "../lsp/assist.js";
import { betterTier, clampInt, confidenceTier, fitLinesToTokenBudget, focusTierCounts, formatReasons, formatRecipes, limitTextToTokens, tierScore } from "./formatting.js";
import { formatWorkflowSummary, recommendNextCodexaCall } from "./graph.js";
import { nextTool } from "./next-tools.js";
import { assessContextQuality, formatContextQuality, formatValueEstimate, type ContextQuality, valueEstimate } from "./quality.js";
import { baselineSearchSummary } from "./raw-search.js";
import { codeLikeQueryFromTask, fileStemQueryTerms, matchReason, matchScore, uniqueFiles } from "./search.js";
import { freshnessBanner } from "./runtime.js";
import { ensureQuerySession, type QuerySessionInput } from "./session.js";
import { compactWorktreeState, getWorktreeState, worktreeStateGaps, worktreeStateText } from "./worktree-state.js";
import { isCodexaControlPath } from "./worktree.js";
import { formatTestRecommendations, recommendTests } from "./tests.js";
import { findFile, resolveFileTarget, resolveSymbolTarget } from "./targets.js";
import { coverageForDisplay, formatVerificationCoverage, verificationCommandPlan, verificationCommandsForContext } from "./verification.js";
import { classifyTaskIntent, retrieveForTask, type IntentConfidence, type RetrievalMatch, type RetrievalResult, type TaskIntent } from "../retrieval.js";
import { semanticOptionsFromQueryOptions } from "../semantic-retrieval.js";
import { compactChangedSymbol, compactDiffGroup, compactFileFact, compactRetrievalResult, compactWorkflowTrace } from "./compact-data.js";
import { summarizeSessionMemory } from "../session-memory.js";
import { workspaceGuidancePreview } from "./workspace-guidance.js";
import {
  actionabilityFromPacketVerdict,
  addDirtyWorktreeFocus,
  addExplicitTargetsToContextFocus,
  addLexicalQueryFocus,
  addNaturalRetrievalFocus,
  createContextFocusState,
  dirtyScopeSummary,
  dirtyWorktreeIntentConfidence,
  exactFocusFileMatches,
  focusMatchTier,
  formatContextSources,
  hasExactRetrievalLane,
  isConfigExpansionPath,
  packetIntentConfidence,
  packetIntentDiagnostics,
  qualityLikeFallbackActionability,
  shouldRunNaturalRetrieval,
  summarizeContextSources,
  taskAsksForTests,
  taskReferencesDirtyContext,
  uniqueFocusEntries,
  workflowFocusEntries,
  type FocusSelectionEntry,
  type PacketFocusEntry
} from "./context/focus.js";

export async function contextPackQuery(input: QuerySessionInput, contextInput: ContextPackInput = {}, options: QueryOptions = {}): Promise<QueryResult> {
  const session = await ensureQuerySession(input, options);
  const { index, freshness, refresh, repoRoot } = session;
  const tokenBudget = clampInt(contextInput.tokenBudget ?? 4000, 500, 12000);
  const limit = clampInt(contextInput.limit ?? 12, 3, session.maxResults);
  const includeSnippets = contextInput.includeSnippets ?? true;
  const changeType = contextInput.changeType ?? "unknown";
  const warnings = [...session.warnings];
  const focusState = createContextFocusState(index, warnings);
  const { focus, impactSeeds, addFocus } = focusState;

  const requestedFiles = contextInput.files ?? [];
  const requestedSymbols = contextInput.symbols ?? [];
  const requestedResolvedPaths = addExplicitTargetsToContextFocus({
    index,
    repoRoot,
    requestedFiles,
    requestedSymbols,
    focus: focusState,
    warnings
  });

  const explicitQuery = contextInput.query?.trim() ?? "";
  const explicitTargetProvided = requestedFiles.length > 0 || requestedSymbols.length > 0;
  const explicitConfigTarget = requestedResolvedPaths.some(isConfigExpansionPath);
  const taskIntents = contextInput.task ? classifyTaskIntent(contextInput.task) : [];
  const dirtyContextHint = Boolean(contextInput.task && taskReferencesDirtyContext(contextInput.task) && !explicitTargetProvided && !explicitQuery);
  const includeDiff = contextInput.diff ?? true;
  const worktree = includeDiff ? await getWorktreeState(session) : undefined;
  const changedEntries = worktree?.entries ?? [];
  const changed = worktree?.files ?? [];
  const changedSymbols = worktree?.symbols ?? [];
  const dirtyContextTask = dirtyContextHint && includeDiff && changed.length > 0;
  const derivedTaskQuery = explicitQuery || explicitTargetProvided || dirtyContextTask ? "" : codeLikeQueryFromTask(contextInput.task);
  const queryText = explicitQuery || derivedTaskQuery;
  const naturalRetrieval =
    contextInput.task && !dirtyContextTask && shouldRunNaturalRetrieval(explicitTargetProvided, explicitConfigTarget, taskIntents)
      ? await retrieveForTask(index, contextInput.task, Math.max(limit * 2, 12), semanticOptionsFromQueryOptions(repoRoot, options))
      : undefined;
  const naturalExpansionAllowed = Boolean(
    naturalRetrieval &&
      !dirtyContextTask &&
      !queryText.trim() &&
      (!explicitTargetProvided ||
        (explicitConfigTarget &&
          (naturalRetrieval.intentConfidence.mode === "edit" ||
            naturalRetrieval.intentConfidence.anchors.length > 0 ||
            naturalRetrieval.intents.some((intent) => intent === "configuration" || intent === "testing"))))
  );
  const naturalRetrievalFocused = Boolean(naturalRetrieval && naturalRetrieval.matches.length > 0 && naturalExpansionAllowed);
  const explicitFocusProvided = explicitTargetProvided || Boolean(queryText) || naturalRetrievalFocused;
  if (queryText.trim()) {
    addLexicalQueryFocus(index, queryText, addFocus);
  }

  if (naturalExpansionAllowed && naturalRetrieval) {
    addNaturalRetrievalFocus({
      naturalRetrieval,
      explicitTargetProvided,
      explicitConfigTarget,
      limit,
      focus: focusState
    });
  }

  const indexedPaths = new Set(index.files.map((file) => file.path));
  const unindexedChanged = changed.filter((file) => !indexedPaths.has(file));
  const groups = groupDiffImpact(index, changedEntries, changedSymbols, unindexedChanged).slice(0, 12);
  const { broadDirty, dirtyDrivesFocus } = addDirtyWorktreeFocus({
    index,
    changed,
    changedSymbols,
    groups,
    indexedPaths,
    explicitFocusProvided,
    dirtyContextTask,
    limit,
    focus: focusState,
    warnings
  });

  if (!dirtyContextTask) {
    addContextPackImpactExpansion(index, impactSeeds, changeType, limit, addFocus);
  }
  if (requestedFiles.length > 0 || requestedSymbols.length > 0 || queryText.trim() || naturalExpansionAllowed) {
    const testSeedPaths = uniqueSorted([...impactSeeds.keys(), ...focus.keys()]);
    for (const test of recommendTests(index, testSeedPaths, repoRoot).slice(0, Math.max(1, Math.min(4, Math.floor(limit / 2))))) {
      addFocus(test.path, `likely test: ${test.reason}`, test.evidenceTier === "authoritative" ? 18 : test.evidenceTier === "derived" ? 14 : 8, test.evidenceTier ?? "derived", "test_evidence");
    }
  }

  if (focus.size === 0) {
    for (const file of index.files.slice(0, limit)) {
      addFocus(file.path, "top-ranked fallback", 1, "fallback", "rank_fallback");
    }
  }

  const focusEntries = [...focus.values()].sort((a, b) => tierScore(a.tier) - tierScore(b.tier) || b.rank - a.rank || a.file.path.localeCompare(b.file.path)).slice(0, limit);
  const focusPaths = focusEntries.map((entry) => entry.file.path);
  const contextSeedPaths = dirtyContextTask ? focusPaths : dirtyDrivesFocus ? uniqueSorted([...focusPaths, ...changed]) : focusPaths;
  const snippetChangedSymbols = dirtyDrivesFocus ? changedSymbols : changedSymbols.filter((entry) => impactSeeds.has(entry.symbol.path));
  const testLimit = dirtyContextTask ? Math.max(1, Math.min(2, contextSeedPaths.length)) : 12;
  const tests = recommendTests(index, contextSeedPaths, repoRoot).slice(0, testLimit);
  const snippetQueryText =
    queryText ||
    contextInput.task ||
    requestedSymbols.join(" ") ||
    requestedFiles
      .flatMap((filePath) => fileStemQueryTerms(path.posix.basename(filePath).replace(/\.[^.]+$/, "")))
      .join(" ");
  const snippets = includeSnippets ? await contextSnippets(repoRoot, index, focusPaths, snippetChangedSymbols, snippetQueryText, limit) : [];
  const nextReads = focusEntries.slice(0, Math.min(8, focusEntries.length)).map((entry) => entry.file.path);
  const dirtyScope = dirtyContextTask
    ? dirtyScopeSummary({
        taskIntents,
        changed,
        worktree,
        broadDirty,
        focusEntries
      })
    : undefined;
  const packetIntent = naturalRetrieval
    ? packetIntentConfidence(naturalRetrieval.intentConfidence, focusEntries, {
        explicitTargetProvided,
        dirtyAnchorAllowed: Boolean(contextInput.task && taskReferencesDirtyContext(contextInput.task) && dirtyDrivesFocus && !broadDirty)
      })
    : dirtyScope
      ? dirtyWorktreeIntentConfidence({
          taskIntents,
          dirtyScope,
          focusEntries,
          worktree
        })
    : undefined;
  const packetDiagnostics = packetIntent ? packetIntentDiagnostics(packetIntent, naturalRetrieval?.diagnostics ?? []) : [];
  const actionability = packetIntent
    ? actionabilityFromPacketVerdict(packetIntent.verdict)
    : explicitTargetProvided
      ? "inspect_first"
      : qualityLikeFallbackActionability(focusEntries);
  const baseline = explicitQuery ? await baselineSearchSummary(repoRoot, queryText) : undefined;
  const gaps = [...indexGaps(index, freshness, unindexedChanged), ...(worktree ? worktreeStateGaps(worktree) : [])];
  const quality = assessContextQuality({
    freshness,
    gaps,
    tiers: focusTierCounts(focusEntries),
    selectedCount: focusEntries.length,
    fanoutCount: dirtyDrivesFocus ? changed.length : focusEntries.length,
    testCount: tests.length,
    queryBroad: naturalRetrieval?.broad,
    centralFileCount: focusEntries.filter((entry) => entry.file.rank >= (index.files[Math.min(index.files.length - 1, 5)]?.rank ?? Number.POSITIVE_INFINITY)).length,
    packetVerdict: explicitTargetProvided ? undefined : packetIntent?.verdict,
    discardedAnchorCount: explicitTargetProvided ? 0 : packetIntent?.discardedAnchorCount
  });
  const suppressActionGuidance = quality.level === "low";
  const displayedTests = suppressActionGuidance ? [] : tests;
  const recipes = suppressActionGuidance ? [] : verificationRecipes(index, contextSeedPaths, changeType).slice(0, 8);
  const verificationCommands = suppressActionGuidance ? [] : verificationCommandsForContext(index, repoRoot, contextSeedPaths, displayedTests, 16);
  const verificationCoverage = suppressActionGuidance ? [] : coverageForDisplay(index, verificationCommands, repoRoot);
  const commandPlan = suppressActionGuidance ? [] : verificationCommandPlan(verificationCoverage);
  const value = valueEstimate("context_pack", {
    rawFileCount: baseline?.lines,
    codexaFileCount: focusEntries.length,
    exactTargetCount: requestedFiles.length + requestedSymbols.length,
    testCount: displayedTests.length,
    parserErrors: index.parserErrors.length,
    affectedCount: changed.length,
    quality
  });
  const lspAssist =
    options.lsp || process.env.CODEXA_LSP === "1"
      ? await lspAssistForFiles(
          repoRoot,
          focusEntries.map((entry) => entry.file),
          lspOptionsFromQueryOptions(options)
        )
      : [];
  const sessionMemory = await sessionMemoryPreview({
    repoRoot,
    freshness,
    files: focusPaths,
    symbols: requestedSymbols,
    topics: contextInput.task ? [contextInput.task] : explicitQuery ? [explicitQuery] : [],
    limit: 6
  });
  const workspaceGuidance = await workspaceGuidancePreview({
    repoRoot,
    task: contextInput.task,
    query: explicitQuery,
    files: uniqueSorted([...requestedFiles, ...focusPaths]).slice(0, 24),
    symbols: requestedSymbols,
    limit: 6
  });
  const contextSources = summarizeContextSources(focusEntries);
  const dirtyScopeChangePlan = dirtyScope?.mode === "edit" && dirtyScope.canPlan && packetIntent?.verdict === "edit-ready";
  const changePlanInputs = dirtyScopeChangePlan
    ? { task: contextInput.task, diff: true, changeType, saveSnapshot: true }
    : { task: contextInput.task, files: focusPaths.slice(0, 8), changeType, saveSnapshot: true };
  const nextTools = [
    packetIntent?.verdict === "needs-target" || packetIntent?.verdict === "orientation-only"
      ? nextTool(packetIntent.recommendedNextTool, "context packet needs a narrower edit target", { task: contextInput.task ?? explicitQuery })
      : undefined,
    focusPaths.length > 0
      ? nextTool(
          "change_plan",
          dirtyScopeChangePlan ? "save the full dirty-worktree edit plan and planned verification before editing" : "save the focused edit plan and planned verification before editing",
          changePlanInputs,
          true,
          [".codex/cache/codexa-task-snapshots"]
        )
      : undefined,
    displayedTests.length > 0 ? nextTool("test_plan", "inspect targeted verification for the focused files", { files: focusPaths.slice(0, 8) }) : undefined
  ].filter((tool): tool is ReturnType<typeof nextTool> => Boolean(tool));

  const text = [
    freshnessBanner(freshness, refresh),
    formatContextQuality(quality),
    formatValueEstimate(value),
    "Codexa context pack",
    contextInput.task ? `Task: ${contextInput.task}` : undefined,
    packetIntent ? `Packet verdict: ${packetIntent.verdict}; edit-ready ${packetIntent.editReady ? "yes" : "no"}; confidence ${Math.round(packetIntent.confidence * 100)}%` : undefined,
    `Actionability: ${actionability}`,
    packetIntent ? `Intent mode: ${packetIntent.mode}; primary ${packetIntent.intent}; anchors ${packetIntent.anchors.slice(0, 4).join(", ") || "none"}` : undefined,
    packetIntent ? `Recommended next MCP call: ${packetIntent.recommendedNextTool}` : undefined,
    packetDiagnostics.length ? `Retrieval diagnostics: ${packetDiagnostics.join("; ")}` : undefined,
    `Change type: ${changeType}`,
    `Budget: ${tokenBudget} tokens approx; focus files: ${focusEntries.length}; changed files: ${changed.length}`,
    contextSources.length > 0 ? `Context sources: ${formatContextSources(contextSources)}` : undefined,
    baseline ? `Baseline search: ${baseline.command} returned ${baseline.lines} non-empty lines; Codexa selected ${focusEntries.length} focus files.` : undefined,
    warnings.length + session.warnings.length > 0
      ? `Warnings: ${uniqueSorted([...session.warnings, ...warnings]).join("; ")}`
      : undefined,
    "",
    "Read first:",
    ...focusEntries.map((entry) => `- ${entry.file.path}: ${entry.tier}; rank ${entry.file.rank.toFixed(2)}, risk ${entry.file.riskScore.toFixed(1)}; ${formatReasons(entry.reasons)}`),
    groups.length > 0 ? "" : undefined,
    groups.length > 0 ? "Change groups:" : undefined,
    ...(groups.length > 0 ? formatDiffGroups(groups) : []),
    "",
    "Likely tests:",
    ...(suppressActionGuidance ? ["- deferred until Codexa has an explicit file, symbol, or higher-confidence packet."] : formatTestRecommendations(displayedTests)),
    "",
    "Known gaps:",
    ...formatGaps(gaps),
    ...(worktree ? worktreeStateText(worktree) : []),
    lspAssist.length > 0 ? "" : undefined,
    lspAssist.length > 0 ? "LSP assist:" : undefined,
    ...lspAssist.flatMap((assist) => [
      `- ${assist.file ?? "unknown"}: ${assist.status}${assist.server ? ` via ${assist.server}` : ""}; symbols ${assist.documentSymbols.length}; diagnostics ${assist.diagnostics.length}`,
      ...assist.warnings.slice(0, 3).map((warning) => `  warning: ${warning}`)
    ]),
    sessionMemory.lines.length > 0 ? "" : undefined,
    sessionMemory.lines.length > 0 ? "Session memory:" : undefined,
    ...sessionMemory.lines,
    workspaceGuidance.lines.length > 0 ? "" : undefined,
    workspaceGuidance.lines.length > 0 ? "Workspace guidance:" : undefined,
    ...workspaceGuidance.lines,
    suppressActionGuidance ? undefined : "",
    suppressActionGuidance ? undefined : "If run, these commands would cover:",
    ...(suppressActionGuidance ? [] : formatVerificationCoverage(verificationCoverage)),
    suppressActionGuidance ? undefined : "",
    suppressActionGuidance ? undefined : "Verification recipes:",
    ...(suppressActionGuidance ? [] : formatRecipes(recipes)),
    snippets.length > 0 ? "" : undefined,
    snippets.length > 0 ? "Evidence snippets:" : undefined,
    ...snippets,
    "",
    "Next inspection order:",
    ...nextReads.map((file) => `- ${file}`)
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");

  return {
    freshness,
    refresh,
    text: limitTextToTokens(text, tokenBudget),
    data: {
      mode: "context_pack",
      task: contextInput.task,
      changeType,
      tokenBudget,
      focusFiles: focusEntries.map((entry) => ({ file: compactFileFact(entry.file), reasons: uniqueSorted(entry.reasons).slice(0, 12), rank: entry.rank, tier: entry.tier })),
      changedFiles: changed.slice(0, 120),
      changedEntries: changedEntries.slice(0, 120),
      changedSymbols: changedSymbols.slice(0, 80).map(compactChangedSymbol),
      unindexedChanged: unindexedChanged.slice(0, 80),
      worktree: worktree ? compactWorktreeState(worktree) : undefined,
      worktreeDegradationReasons: worktree?.degradedReasons ?? [],
      dirtyScope,
      groups: groups.slice(0, 20).map(compactDiffGroup),
      tests: displayedTests.slice(0, 30),
      snippets,
      contextSources,
      warnings: uniqueSorted([...session.warnings, ...warnings]),
      nextReads,
      baseline,
      retrieval: naturalRetrieval ? compactRetrievalResult(naturalRetrieval) : undefined,
      lspAssist,
      sessionMemory: sessionMemory.data,
      workspaceGuidance: workspaceGuidance.data,
      intentConfidence: packetIntent,
      packetVerdict: packetIntent?.verdict,
      actionability,
      diagnostics: packetDiagnostics,
      actionGuidanceSuppressed: suppressActionGuidance,
      recipes,
      verificationCommands,
      verificationCoverage,
      verificationCommandPlan: commandPlan,
      value,
      quality,
	      gaps,
	      nextTools,
	      systemMessage: nextTools[0]?.reason,
	      session: { commandBudgetMs: session.commandBudgetMs, maxResultBytes: session.maxResultBytes, maxResults: session.maxResults, provenance: session.provenance }
    }
  };
}

export async function taskBriefQuery(input: QuerySessionInput, contextInput: ContextPackInput = {}, options: QueryOptions = {}): Promise<QueryResult> {
  const result = await contextPackQuery(
    input,
    {
      ...contextInput,
      tokenBudget: contextInput.tokenBudget ?? 3000,
      limit: contextInput.limit ?? 10,
      includeSnippets: contextInput.includeSnippets ?? true
    },
    options
  );
  return {
    ...result,
    text: result.text.replace("Codexa context pack", "Codexa task brief"),
    data: {
      ...(result.data && typeof result.data === "object" ? (result.data as Record<string, unknown>) : {}),
      mode: "task_brief"
    }
  };
}

export async function focusBriefQuery(input: QuerySessionInput, focusInput: FocusBriefInput = {}, options: QueryOptions = {}): Promise<QueryResult> {
  const session = await ensureQuerySession(input, options);
  const { index, freshness, refresh, repoRoot } = session;
  const task = focusInput.task?.trim() || "Session start: identify project focus, current changes, workflows, and next Codexa call";
  const limit = clampInt(focusInput.limit ?? 10, 3, session.maxResults);
  const tokenBudget = clampInt(focusInput.tokenBudget ?? 2400, 600, 8000);
  const retrieval = await retrieveForTask(index, task, limit, semanticOptionsFromQueryOptions(repoRoot, options));
  const includeDiff = focusInput.diff ?? true;
  const worktree = includeDiff ? await getWorktreeState(session) : undefined;
  const changedEntries = worktree?.entries ?? [];
  const changed = worktree?.files ?? [];
  const indexedPaths = new Set(index.files.map((file) => file.path));
  const unindexedChanged = changed.filter((file) => !indexedPaths.has(file));
  const groups = includeDiff ? groupDiffImpact(index, changedEntries, worktree?.symbols ?? [], unindexedChanged).slice(0, 8) : [];
  const exactMatches: FocusSelectionEntry[] = exactFocusFileMatches(index, task).map((file) => ({
    file,
    score: file.rank + 100,
    reasons: ["exact path in task"],
    matchedTerms: [file.path],
    tier: "derived" as EvidenceTier
  }));
  const workflowMatches = workflowFocusEntries(index, retrieval.workflows, task, limit);
  const workflowTestMatches: FocusSelectionEntry[] =
    workflowMatches.length > 0 && taskAsksForTests(task)
      ? recommendTests(
          index,
          uniqueSorted(workflowMatches.map((entry) => entry.file.path)),
          repoRoot
        )
          .slice(0, 4)
          .map((test) => {
            const file = findFile(index, test.path);
            return file
              ? {
                  file,
                  score: test.evidenceTier === "authoritative" ? 70 : test.evidenceTier === "derived" ? 62 : 48,
                  reasons: [`workflow test candidate: ${test.reason}`],
                  matchedTerms: [] as string[],
                  tier: test.evidenceTier ?? "derived"
                }
              : undefined;
          })
          .filter((entry): entry is FocusSelectionEntry => Boolean(entry))
      : [];
  const retrievalMatches: FocusSelectionEntry[] = retrieval.matches.map((match) => ({ ...match, tier: focusMatchTier(match.file, task, match) }));
  const workflowModules = new Set(workflowMatches.map((entry) => moduleNameForPath(entry.file.path)));
  const workflowScopedMatches =
    workflowMatches.length > 0 && retrieval.broad
      ? retrieval.matches
          .filter((match) => workflowModules.has(moduleNameForPath(match.file.path)) || hasExactRetrievalLane(match))
          .map((match) => ({ ...match, tier: focusMatchTier(match.file, task, match) }))
      : retrievalMatches;
  const selected: FocusSelectionEntry[] =
    retrieval.matches.length > 0 || exactMatches.length > 0 || workflowMatches.length > 0
      ? uniqueFocusEntries([...exactMatches, ...workflowMatches, ...workflowTestMatches, ...workflowScopedMatches]).slice(0, limit)
      : index.files.slice(0, limit).map((file) => ({ file, score: file.rank, reasons: ["ranked project entry point fallback"], matchedTerms: [], tier: "fallback" as EvidenceTier }));
  const focusFiles = uniqueFiles(selected.map((entry) => entry.file)).slice(0, limit);
  const tiersByPath = new Map(selected.map((entry) => [entry.file.path, entry.tier]));
  const tests = recommendTests(index, focusFiles.map((file) => file.path), repoRoot).slice(0, 10);
  const nextCall = recommendNextCodexaCall(retrieval.intents, retrieval.workflows, changed.length, task);
  const actionability = actionabilityFromPacketVerdict(retrieval.intentConfidence.verdict);
  const recommendedNextCall =
    retrieval.intentConfidence.recommendedNextTool === nextCall.tool
      ? `${nextCall.tool} - ${nextCall.reason}`
      : `${retrieval.intentConfidence.recommendedNextTool} - ${nextCall.reason}`;
  const gaps = [...indexGaps(index, freshness, unindexedChanged), ...(worktree ? worktreeStateGaps(worktree) : [])];
  const quality = assessContextQuality({
    freshness,
    gaps,
    tiers: {
      authoritative: 0,
      derived: focusFiles.filter((file) => tiersByPath.get(file.path) === "derived").length,
      heuristic:
        focusFiles.filter((file) => tiersByPath.get(file.path) === "heuristic").length +
        retrieval.workflows.filter((workflow) => workflow.confidence === "heuristic").length,
      fallback: focusFiles.filter((file) => tiersByPath.get(file.path) === "fallback").length
    },
    selectedCount: focusFiles.length,
    testCount: tests.length,
    queryBroad: retrieval.broad,
    centralFileCount: focusFiles.filter((file) => file.rank >= index.files[Math.min(index.files.length - 1, 5)]?.rank).length,
    packetVerdict: retrieval.intentConfidence.verdict,
    discardedAnchorCount: retrieval.intentConfidence.discardedAnchorCount
  });
  const sessionMemory = await sessionMemoryPreview({
    repoRoot,
    freshness,
    files: focusFiles.map((file) => file.path),
    topics: [task],
    limit: 6
  });
  const workspaceGuidance = await workspaceGuidancePreview({
    repoRoot,
    task,
    files: focusFiles.map((file) => file.path),
    limit: 6
  });
  const text = [
    freshnessBanner(freshness, refresh),
    formatContextQuality(quality),
    "Codexa focus brief",
    `Task: ${task}`,
    `Intent: ${retrieval.intents.join(", ")}`,
    `Packet verdict: ${retrieval.intentConfidence.verdict}; edit-ready ${retrieval.intentConfidence.editReady ? "yes" : "no"}; confidence ${Math.round(retrieval.intentConfidence.confidence * 100)}%`,
    `Actionability: ${actionability}`,
    `Intent mode: ${retrieval.intentConfidence.mode}; primary ${retrieval.intentConfidence.intent}; anchors ${retrieval.intentConfidence.anchors.slice(0, 4).join(", ") || "none"}`,
    retrieval.diagnostics.length > 0 ? `Retrieval diagnostics: ${retrieval.diagnostics.join("; ")}` : undefined,
    `Recommended next MCP call: ${recommendedNextCall}`,
    nextCall.arguments ? `Suggested arguments: ${JSON.stringify(nextCall.arguments)}` : undefined,
    "",
    "Likely subsystems:",
    ...(retrieval.modules.length > 0
      ? retrieval.modules.map((module) => `- ${module.name}: score ${module.score.toFixed(2)}; files ${module.files.slice(0, 5).join(", ")}; ${module.reasons.join("; ") || "task intent match"}`)
      : index.modules.slice(0, 5).map((module) => `- ${module.name}: rank ${module.rank.toFixed(2)}; ${module.summary}`)),
    "",
    "Read first:",
    ...focusFiles.map((file) => {
      const match = selected.find((entry) => entry.file.path === file.path);
      const reasons = match?.reasons.length ? match.reasons.join("; ") : "ranked project entry point";
      return `- ${file.path}: score ${(match?.score ?? file.rank).toFixed(2)}, rank ${file.rank.toFixed(2)}, risk ${file.riskScore.toFixed(1)}; ${reasons}`;
    }),
    retrieval.workflows.length > 0 ? "" : undefined,
    retrieval.workflows.length > 0 ? "Likely workflows:" : undefined,
    ...retrieval.workflows.slice(0, 6).map(formatWorkflowSummary),
    groups.length > 0 ? "" : undefined,
    groups.length > 0 ? "Current change groups:" : undefined,
    ...(groups.length > 0 ? formatDiffGroups(groups) : []),
    sessionMemory.lines.length > 0 ? "" : undefined,
    sessionMemory.lines.length > 0 ? "Session memory:" : undefined,
    ...sessionMemory.lines,
    workspaceGuidance.lines.length > 0 ? "" : undefined,
    workspaceGuidance.lines.length > 0 ? "Workspace guidance:" : undefined,
    ...workspaceGuidance.lines,
    "",
    "Likely tests:",
    ...formatTestRecommendations(tests),
    "",
    "Known gaps:",
    ...formatGaps(gaps),
    ...(worktree ? worktreeStateText(worktree) : [])
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
  return {
    freshness,
    refresh,
    text: limitTextToTokens(text, tokenBudget),
    data: {
      mode: "focus_brief",
      task,
      retrieval: compactRetrievalResult(retrieval),
      intentConfidence: retrieval.intentConfidence,
      packetVerdict: retrieval.intentConfidence.verdict,
      actionability,
      diagnostics: retrieval.diagnostics,
      focusFiles: focusFiles.map(compactFileFact),
      workflows: retrieval.workflows.slice(0, 12).map(compactWorkflowTrace),
      modules: retrieval.modules.slice(0, 12).map((module) => ({ ...module, files: module.files.slice(0, 40), reasons: module.reasons.slice(0, 12) })),
      groups: groups.slice(0, 12).map(compactDiffGroup),
      worktree: worktree ? compactWorktreeState(worktree) : undefined,
      worktreeDegradationReasons: worktree?.degradedReasons ?? [],
      tests: tests.slice(0, 30),
      nextCall,
      sessionMemory: sessionMemory.data,
      workspaceGuidance: workspaceGuidance.data,
      quality,
      gaps
    }
  };
}

async function contextSnippets(
  repoRoot: string,
  index: CodexaIndex,
  focusPaths: string[],
  changedSymbols: ChangedSymbol[],
  queryText: string,
  limit: number
): Promise<string[]> {
  const snippets: string[] = [];
  const used = new Set<string>();
  const unreadableFiles = new Set<string>();
  const add = async (filePath: string, line: number, reason: string) => {
    if (snippets.length >= Math.min(10, limit)) {
      return;
    }
    const key = `${filePath}:${line}`;
    if (used.has(key)) {
      return;
    }
    used.add(key);
    const snippet = await readSnippet(repoRoot, filePath, line, 3);
    if ("unreadable" in snippet) {
      if (!unreadableFiles.has(filePath)) {
        unreadableFiles.add(filePath);
        snippets.push(`- ${filePath}:${line} ${reason}\n  <snippet unavailable: ${snippet.unreadable}>`);
      }
      return;
    }
    if (snippet.text) {
      snippets.push(`- ${filePath}:${line} ${reason}\n${snippet.text}`);
    }
  };

  for (const entry of changedSymbols.slice(0, limit)) {
    await add(entry.symbol.path, entry.symbol.range?.startLine ?? 1, `changed ${entry.symbol.qualifiedName}`);
  }

  const focusSet = new Set(focusPaths);
  const hasQuery = Boolean(queryText.trim());
  const symbols = index.symbols
    .filter((symbol) => focusSet.has(symbol.path))
    .sort((a, b) => {
      const fileA = findFile(index, a.path)?.rank ?? 0;
      const fileB = findFile(index, b.path)?.rank ?? 0;
      return fileB - fileA || (a.range?.startLine ?? 0) - (b.range?.startLine ?? 0) || a.qualifiedName.localeCompare(b.qualifiedName);
    });
  if (hasQuery) {
    const usages = index.usageSites
      .map((usage) => ({
        usage,
        score: focusSet.has(usage.path) ? Math.max(matchScore(queryText, usage.name), matchScore(queryText, usage.text), matchScore(queryText, usage.path)) : 0
      }))
      .filter((entry) => entry.score > 0)
      .sort(
        (a, b) =>
          b.score - a.score ||
          Number(a.usage.kind === "import") - Number(b.usage.kind === "import") ||
          a.usage.path.localeCompare(b.usage.path) ||
          (a.usage.range?.startLine ?? 0) - (b.usage.range?.startLine ?? 0)
      )
      .slice(0, limit);
    for (const { usage } of usages) {
      await add(usage.path, usage.range?.startLine ?? 1, `usage ${usage.name} ${usage.confidence}`);
    }
  }

  const symbolCandidates = hasQuery
    ? symbols.filter((symbol) => Math.max(matchScore(queryText, symbol.name), matchScore(queryText, symbol.qualifiedName), matchScore(queryText, symbol.path)) > 0)
    : symbols;
  for (const symbol of symbolCandidates.slice(0, limit)) {
    await add(symbol.path, symbol.range?.startLine ?? 1, `${symbol.kind} ${symbol.qualifiedName}`);
  }
  return snippets;
}

async function sessionMemoryPreview(input: {
  repoRoot: string;
  freshness: import("../types.js").FreshnessInfo;
  files?: string[];
  symbols?: string[];
  topics?: string[];
  taskId?: string;
  limit: number;
}): Promise<{ lines: string[]; data?: unknown }> {
  try {
    const result = await summarizeSessionMemory({
      repoRoot: input.repoRoot,
      taskId: input.taskId,
      files: input.files,
      symbols: input.symbols,
      topics: input.topics,
      freshness: input.freshness,
      limit: input.limit,
      includeStale: true
    });
    if (result.memory.entries.length === 0) {
      return { lines: [] };
    }
    return {
      lines: (result.memory.markdown ?? "").split(/\r?\n/u).slice(0, 12),
      data: {
        sessionId: result.sessionId,
        revision: result.revision,
        entries: result.memory.entries.slice(0, input.limit),
        warnings: result.warnings
      }
    };
  } catch (error) {
    return {
      lines: [`- unavailable: ${error instanceof Error ? error.message : String(error)}`],
      data: { warning: error instanceof Error ? error.message : String(error) }
    };
  }
}

async function readSnippet(
  repoRoot: string,
  filePath: string,
  centerLine: number,
  radius: number
): Promise<{ text: string } | { unreadable: string }> {
  try {
    const source = await fs.readFile(path.join(repoRoot, filePath), "utf8");
    const lines = source.split(/\r?\n/);
    const start = Math.max(1, centerLine - radius);
    const end = Math.min(lines.length, centerLine + radius);
    const text = lines
      .slice(start - 1, end)
      .map((line, index) => `  ${String(start + index).padStart(4, " ")} | ${line.slice(0, 180)}`)
      .join("\n");
    return { text };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    return { unreadable: typeof code === "string" ? code : "ERR" };
  }
}
