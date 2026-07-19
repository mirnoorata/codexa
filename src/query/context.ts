import path from "node:path";
import { isTestPath, moduleNameForPath } from "../language.js";
import type { ChangedSymbol, CodexaIndex, ContextPackInput, DiffImpactGroup, EvidenceTier, FileFact, FocusBriefInput, QueryOptions, QueryResult } from "../types.js";
import { limitText, uniqueSorted } from "../util.js";
import { formatDiffGroups, formatGaps, groupDiffImpact, indexGaps } from "./diff.js";
import { addContextPackImpactExpansion, verificationRecipes } from "./impact.js";
import { lspAssistForFiles, lspOptionsFromQueryOptions } from "../lsp/assist.js";
import { betterTier, clampInt, confidenceTier, fitLinesToTokenBudget, focusTierCounts, formatReasons, formatRecipes, limitTextToTokens, tierScore } from "./formatting.js";
import { ambiguousFocusSymbolTargetCandidateGroups, ambiguousFocusSymbolTargetCandidates, ambiguousFocusTargetCandidateGroups, ambiguousFocusTargetCandidates, classifyChangePlanNeed, focusFilesAndSymbolsInTaskOrder, focusFilesInTaskOrder, formatWorkflowSummary, isLikelyPathTypo, isStructuralEditTask, narrowAmbiguousTargetGroupsToScope, normalizeTaskRepositoryPaths, plannedNewFocusPathTargets, recommendNextCodexaCall, unknownFocusPathTargets, unresolvedFocusPathTargets } from "./graph.js";
import { nextTool } from "./next-tools.js";
import { assessContextQuality, formatContextQuality, formatValueEstimate, type ContextQuality, valueEstimate } from "./quality.js";
import { baselineSearchSummary } from "./raw-search.js";
import { codeLikeQueryFromTask, fileStemQueryTerms, matchReason, matchScore, uniqueFiles } from "./search.js";
import { freshnessBanner } from "./runtime.js";
import { ensureQuerySession, type QuerySessionInput } from "./session.js";
import { compactWorktreeState, getWorktreeState, worktreeStateGaps, worktreeStateText } from "./worktree-state.js";
import { isCodexaControlPath } from "./worktree.js";
import { formatTestRecommendations, recommendTests } from "./tests.js";
import { findFile, repositoryTargetPathAuthority, resolveFileTarget, resolveSymbolTarget } from "./targets.js";
import {
  asVerificationCoveragePreview,
  formatVerificationCoverage,
  verificationCommandPlan,
  verificationCommandsForContext,
  verificationCoverageForCommands
} from "./verification.js";
import { classifyTaskIntent, retrieveForTask, retrieveIntentOnly, type IntentConfidence, type RetrievalMatch, type RetrievalResult, type TaskIntent } from "../retrieval.js";
import { semanticOptionsFromQueryOptions } from "../semantic-retrieval.js";
import { compactChangedSymbol, compactDiffGroup, compactFileFact, compactRetrievalResult, compactWorkflowTrace } from "./compact-data.js";
import { pruneMissingFiles, prunedFilesGap } from "./prune-missing.js";
import { summarizeSessionMemory } from "../session-memory.js";
import { workspaceGuidancePreview } from "./workspace-guidance.js";
import { applicableSkillHints, loadSkillHints, targetPlaybookHints } from "../skill-hints.js";
import {
  actionabilityFromPacketVerdict,
  addDirtyWorktreeFocus,
  addExplicitTargetsToContextFocus,
  addLexicalQueryFocus,
  addNaturalRetrievalFocus,
  createContextFocusState,
  dirtyScopeSummary,
  dirtyScopeMode,
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
import { readContextSnippet } from "./context/snippets.js";
import { inspectPlannedTargetAuthority, structuredNewTargetAuthority } from "./context/target-authority.js";
import { terminalContextPackResult, terminalFocusBriefResult } from "./context/terminal.js";

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
  const repositoryFiles = index.files.map((file) => file.path);
  const repositoryPathSet = new Set(repositoryFiles);
  const requestedFileAuthorities = await Promise.all(requestedFiles.map((filePath) => repositoryTargetPathAuthority(filePath, repoRoot, repositoryFiles)));
  const targetTask = contextInput.task ? normalizeTaskRepositoryPaths(contextInput.task, repoRoot) : "";
  const structuredNewTargetMode = structuredNewTargetAuthority(contextInput.task, changeType);
  const directlyResolvedPaths = addExplicitTargetsToContextFocus({ index, repoRoot, requestedFiles, requestedSymbols, focus: focusState, warnings });
  const canonicalRequestedPaths = requestedFileAuthorities.filter((entry) => entry.status === "indexed" && entry.path && !directlyResolvedPaths.includes(entry.path)).flatMap((entry) => entry.path ? [entry.path] : []);
  const requestedResolvedPaths = [...directlyResolvedPaths, ...canonicalRequestedPaths];
  for (const filePath of requestedResolvedPaths) {
    if (focus.has(filePath)) continue;
    addFocus(filePath, "canonical explicit target", 120, "authoritative", "explicit_target");
    impactSeeds.set(filePath, "canonical explicit target");
  }
  const explicitDisambiguatesNaturalTarget = [...ambiguousFocusTargetCandidateGroups(targetTask, repositoryFiles), ...ambiguousFocusSymbolTargetCandidateGroups(targetTask, index.symbols)]
    .some((group) => group.some((filePath) => requestedResolvedPaths.includes(filePath)));
  const naturalTargetAuthority = await inspectPlannedTargetAuthority(targetTask ? plannedNewFocusPathTargets(targetTask, repositoryFiles) : [], repoRoot, repositoryFiles, targetTask ? unknownFocusPathTargets(targetTask, repositoryFiles) : []);
  const detectedNaturalNewTargets = naturalTargetAuthority.newTargets;
  const matchedNaturalPlanTargets = contextInput.task ? focusFilesAndSymbolsInTaskOrder(targetTask, [...repositoryFiles, ...detectedNaturalNewTargets], [...repositoryFiles, ...detectedNaturalNewTargets], index.symbols) : [];
  const tentativeNaturalPlanTargets = contextInput.task ? [...new Set([...matchedNaturalPlanTargets, ...naturalTargetAuthority.indexedTargets])] : [];
  const naturalStructuralSourcePresent = tentativeNaturalPlanTargets.some((filePath) => repositoryPathSet.has(filePath)) || explicitDisambiguatesNaturalTarget;
  const naturalNewTargets = structuredNewTargetMode.structural && !naturalStructuralSourcePresent ? [] : detectedNaturalNewTargets;
  const naturalPlanTargets = naturalNewTargets === detectedNaturalNewTargets ? tentativeNaturalPlanTargets : contextInput.task ? [...new Set([...focusFilesAndSymbolsInTaskOrder(targetTask, repositoryFiles, repositoryFiles, index.symbols), ...naturalTargetAuthority.indexedTargets])] : [];
  const naturalPathPlanTargets = contextInput.task ? [...new Set([...focusFilesInTaskOrder(targetTask, [...repositoryFiles, ...naturalNewTargets], [...repositoryFiles, ...naturalNewTargets]), ...naturalTargetAuthority.indexedTargets])] : [];
  const explicitRootNewPaths = new Set(requestedFileAuthorities.flatMap((entry) => entry.status === "missing" && entry.requestedPath.replaceAll("\\", "/").startsWith("./") && entry.path ? [entry.path] : []));
  const requestedNewPaths: string[] = [];
  for (const authority of requestedFileAuthorities) {
    const filePath = authority.path;
    if (!filePath || authority.status !== "missing" || repositoryPathSet.has(filePath)) continue;
    if (explicitRootNewPaths.has(filePath) && structuredNewTargetMode.allowed && (!structuredNewTargetMode.structural || naturalStructuralSourcePresent)) {
      requestedNewPaths.push(filePath);
      continue;
    }
    const resolution = resolveFileTarget(index, filePath, repoRoot);
    if (resolution.ambiguous.length > 0) continue;
    if (naturalNewTargets.includes(filePath)) {
      if (structuredNewTargetMode.structural && !naturalStructuralSourcePresent) continue;
      requestedNewPaths.push(filePath);
      continue;
    }
    if (!structuredNewTargetMode.allowed) continue;
    if (structuredNewTargetMode.structural) {
      const mentionedAsSource = targetTask.includes(filePath);
      if (!mentionedAsSource && requestedResolvedPaths.length > 0) requestedNewPaths.push(filePath);
      continue;
    }
    if (!isLikelyPathTypo(filePath, repositoryFiles)) requestedNewPaths.push(filePath);
  }
  const requestedTargetCount = requestedFiles.length + requestedSymbols.length;
  const unresolvedExplicitTarget = requestedResolvedPaths.length + requestedNewPaths.length < requestedTargetCount;

  const explicitQuery = contextInput.query?.trim() ?? "";
  const explicitTargetProvided = requestedFiles.length > 0 || requestedSymbols.length > 0;
  const explicitConfigTarget = requestedResolvedPaths.some(isConfigExpansionPath);
  const taskIntents = contextInput.task ? classifyTaskIntent(contextInput.task) : [];
  const intentOnly = contextInput.task ? retrieveIntentOnly(contextInput.task) : undefined;
  const dirtyContextHint = Boolean(contextInput.task && taskReferencesDirtyContext(contextInput.task) && !explicitTargetProvided && !explicitQuery);
  const includeDiff = contextInput.diff ?? true;
  const worktree = includeDiff ? await getWorktreeState(session) : undefined;
  const changedEntries = worktree?.entries ?? [];
  const changed = worktree?.files ?? [];
  const changedSymbols = worktree?.symbols ?? [];
  const dirtyContextTask = dirtyContextHint && includeDiff && !worktree?.degraded;
  const preliminaryNewTargets = [...new Set([...naturalPlanTargets, ...requestedNewPaths])];
  const pureNamedNewTarget = !dirtyContextTask && !explicitQuery && structuredNewTargetMode.allowed && intentOnly?.intentConfidence.mode === "edit"
    && !unresolvedExplicitTarget && preliminaryNewTargets.length > 0 && preliminaryNewTargets.every((filePath) => !repositoryPathSet.has(filePath))
    && unresolvedFocusPathTargets(targetTask, repositoryFiles, [...naturalNewTargets, ...naturalTargetAuthority.indexedTargetMentions]).length === 0
    && !classifyChangePlanNeed({ mode: "edit", task: contextInput.task, explicitTargetCount: preliminaryNewTargets.length, changeType, targetFiles: preliminaryNewTargets, repositoryFiles });
  const dirtyTargetRepositoryFiles = [...new Set([...repositoryFiles, ...changed.filter((filePath) => !isCodexaControlPath(filePath))])];
  const directDirtyTaskTargets = dirtyContextTask
    ? focusFilesAndSymbolsInTaskOrder(targetTask, dirtyTargetRepositoryFiles, dirtyTargetRepositoryFiles, index.symbols)
    : [];
  const changedPathSet = new Set(changed.filter((filePath) => !isCodexaControlPath(filePath)));
  const dirtyCandidateGroups = dirtyContextTask
    ? [...ambiguousFocusTargetCandidateGroups(targetTask, dirtyTargetRepositoryFiles), ...ambiguousFocusSymbolTargetCandidateGroups(targetTask, index.symbols, directDirtyTaskTargets)]
    : [];
  const narrowedDirtyCandidates = narrowAmbiguousTargetGroupsToScope(dirtyCandidateGroups, changedPathSet);
  const dirtyTaskTargets = [...new Set([...directDirtyTaskTargets, ...narrowedDirtyCandidates.resolved])];
  const dirtyTargetCandidates = narrowedDirtyCandidates.ambiguous;
  const dirtyTargetAuthority = await inspectPlannedTargetAuthority(dirtyContextTask ? plannedNewFocusPathTargets(targetTask, dirtyTargetRepositoryFiles) : [], repoRoot, dirtyTargetRepositoryFiles, dirtyContextTask ? unknownFocusPathTargets(targetTask, dirtyTargetRepositoryFiles) : []);
  const dirtyPlannedNewTargets = dirtyTargetAuthority.newTargets;
  const dirtyUnresolvedTargets = dirtyContextTask ? unresolvedFocusPathTargets(targetTask, dirtyTargetRepositoryFiles, [...dirtyPlannedNewTargets, ...dirtyTargetAuthority.indexedTargetMentions]) : [];
  const dirtyQualifierMentioned = dirtyTaskTargets.length > 0 || dirtyCandidateGroups.length > 0 || dirtyUnresolvedTargets.length > 0;
  const qualifiedDirtyTargets = dirtyTaskTargets.filter((filePath) => changedPathSet.has(filePath));
  const dirtyQualifierNoMatch = dirtyContextTask && ((dirtyTaskTargets.length > 0 && qualifiedDirtyTargets.length === 0) || narrowedDirtyCandidates.unmatched);
  const dirtyScopedChanged = dirtyContextTask && dirtyQualifierMentioned ? qualifiedDirtyTargets : changed;
  if (!explicitTargetProvided && !dirtyContextTask) {
    for (const filePath of naturalPlanTargets.filter((candidate) => repositoryPathSet.has(candidate))) {
      addFocus(filePath, "natural task target", 100, "authoritative", "explicit_target");
      impactSeeds.set(filePath, "natural task target");
    }
  }
  const derivedTaskQuery = explicitQuery || explicitTargetProvided || dirtyContextTask || pureNamedNewTarget ? "" : codeLikeQueryFromTask(contextInput.task);
  const queryText = explicitQuery || derivedTaskQuery;
  const naturalRetrieval =
    contextInput.task && !dirtyContextTask && !pureNamedNewTarget && shouldRunNaturalRetrieval(explicitTargetProvided, explicitConfigTarget, taskIntents)
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

  const indexedPaths = repositoryPathSet;
  const unindexedChanged = changed.filter((file) => !indexedPaths.has(file));
  const dirtyScopedPathSet = new Set(dirtyScopedChanged);
  const scopedChangedEntries = dirtyContextTask && dirtyQualifierMentioned ? changedEntries.filter((entry) => dirtyScopedPathSet.has(entry.path)) : changedEntries;
  const scopedChangedSymbols = dirtyContextTask && dirtyQualifierMentioned ? changedSymbols.filter((entry) => dirtyScopedPathSet.has(entry.symbol.path)) : changedSymbols;
  const scopedUnindexedChanged = dirtyScopedChanged.filter((file) => !indexedPaths.has(file));
  const groups = groupDiffImpact(index, scopedChangedEntries, scopedChangedSymbols, scopedUnindexedChanged).slice(0, 12);
  const { broadDirty, dirtyDrivesFocus } = addDirtyWorktreeFocus({
    index,
    changed: dirtyScopedChanged,
    changedSymbols: scopedChangedSymbols,
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

  if (focus.size === 0 && !dirtyContextTask && !pureNamedNewTarget) {
    for (const file of index.files.slice(0, limit)) {
      addFocus(file.path, "top-ranked fallback", 1, "fallback", "rank_fallback");
    }
  }

  const focusPrune = pruneMissingFiles(
    [...focus.values()].sort((a, b) => tierScore(a.tier) - tierScore(b.tier) || b.rank - a.rank || a.file.path.localeCompare(b.file.path)).slice(0, limit),
    repoRoot,
    (entry) => entry.file.path
  );
  const focusEntries = focusPrune.entries;
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
        task: contextInput.task,
        changed: dirtyScopedChanged,
        worktree,
        broadDirty,
        focusEntries
      })
    : undefined;
  const cleanDirtyScope = dirtyContextTask && !dirtyQualifierMentioned && dirtyScopedChanged.length === 0;
  if (pureNamedNewTarget && intentOnly) return terminalContextPackResult({ freshness, refresh, task: contextInput.task, intent: intentOnly.intentConfidence, targetPaths: preliminaryNewTargets, reason: "named new target has no indexed source dependency" });
  if (cleanDirtyScope && intentOnly) return terminalContextPackResult({ freshness, refresh, task: contextInput.task, intent: intentOnly.intentConfidence, targetPaths: [], reason: "requested dirty-worktree scope is clean", dirtyScope });
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
  const baseActionability = packetIntent
    ? actionabilityFromPacketVerdict(packetIntent.verdict)
    : explicitTargetProvided
      ? "inspect_first"
      : qualityLikeFallbackActionability(focusEntries);
  const baseline = explicitQuery ? await baselineSearchSummary(repoRoot, queryText) : undefined;
  const gaps = [
    ...indexGaps(index, freshness, unindexedChanged),
    ...(worktree ? worktreeStateGaps(worktree) : []),
    ...(focusPrune.prunedCount > 0 ? [prunedFilesGap(focusPrune.prunedCount)] : [])
  ];
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
  const verificationCoverage = suppressActionGuidance
    ? []
    : asVerificationCoveragePreview(verificationCoverageForCommands(index, verificationCommands, repoRoot));
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
  const skillHints = await loadSkillHints(repoRoot);
  const skillHintTargets = uniqueSorted([...requestedFiles, ...focusPaths]).slice(0, 40);
  const applicableSkills = applicableSkillHints(skillHints, skillHintTargets);
  const targetPlaybooks = await targetPlaybookHints(repoRoot, index, focusPaths);
  const contextSources = summarizeContextSources(focusEntries);
  const dirtyScopeChangePlan = dirtyScope?.mode === "edit" && dirtyScope.canPlan && packetIntent?.verdict === "edit-ready";
  const qualifiedDirtyScopePlan = dirtyScopeChangePlan && dirtyQualifierMentioned;
  const explicitPlanPaths = [...new Set([...requestedResolvedPaths, ...requestedNewPaths])];
  const materialChangeType = changeType === "api" || changeType === "rename" || changeType === "delete";
  const fallbackPlanMode = materialChangeType ? "edit" : contextInput.task ? dirtyScopeMode(taskIntents, contextInput.task) : "orientation";
  const structuredTargetMismatch = explicitTargetProvided
    && explicitPlanPaths.length > 0
    && naturalPathPlanTargets.length > 0
    && !explicitPlanPaths.some((filePath) => naturalPathPlanTargets.includes(filePath))
    && !explicitDisambiguatesNaturalTarget;
  const planPaths = explicitTargetProvided ? [...new Set([...naturalPathPlanTargets, ...explicitPlanPaths])] : qualifiedDirtyScopePlan ? qualifiedDirtyTargets : naturalPlanTargets;
  const naturalTargetCandidates = contextInput.task
    ? dirtyContextTask
      ? dirtyTargetCandidates
      : [...new Set([...ambiguousFocusTargetCandidates(targetTask, repositoryFiles, planPaths), ...ambiguousFocusSymbolTargetCandidates(targetTask, index.symbols, planPaths)])]
    : [];
  const unresolvedNaturalTargets = contextInput.task ? (dirtyContextTask ? dirtyUnresolvedTargets : unresolvedFocusPathTargets(targetTask, repositoryFiles, [...naturalNewTargets, ...naturalTargetAuthority.indexedTargetMentions])) : [];
  const changePlanNeed = classifyChangePlanNeed({
    mode: materialChangeType ? "edit" : packetIntent?.mode ?? fallbackPlanMode,
    task: contextInput.task,
    explicitTargetCount: planPaths.length,
    dirtyScopeFileCount: dirtyScopeChangePlan && !qualifiedDirtyScopePlan ? dirtyScope.changedFileCount : 0,
    changeType,
    targetFiles: planPaths,
    repositoryFiles
  });
  const changePlanInputs = dirtyScopeChangePlan && !qualifiedDirtyScopePlan
    ? { task: contextInput.task, diff: true, changeType, saveSnapshot: true }
    : { task: contextInput.task, files: planPaths.slice(0, 64), changeType, saveSnapshot: true };
  const editIntentWithoutTarget = !explicitTargetProvided && !dirtyContextTask && !dirtyScopeChangePlan && planPaths.length === 0 && (materialChangeType || packetIntent?.mode === "edit");
  const retrievalNeedsTarget = planPaths.length === 0 && (packetIntent?.verdict === "needs-target" || packetIntent?.verdict === "raw-search-better");
  const unresolvedTarget = unresolvedExplicitTarget || structuredTargetMismatch || naturalTargetCandidates.length > 0 || unresolvedNaturalTargets.length > 0 || editIntentWithoutTarget || retrievalNeedsTarget;
  const boundedPlanTargets = unresolvedTarget ? [] : planPaths.slice(0, 64);
  const riskyEditNeedsPlan = !dirtyQualifierNoMatch && !unresolvedTarget && (dirtyScopeChangePlan || planPaths.length > 0) && Boolean(changePlanNeed);
  const boundedEditTarget = !dirtyQualifierNoMatch && !unresolvedTarget && planPaths.length > 0 && (materialChangeType || packetIntent?.mode === "edit" || fallbackPlanMode === "edit");
  const recoveryQuery = [...new Set([contextInput.task, explicitQuery, ...requestedFiles, ...requestedSymbols].filter((value): value is string => Boolean(value?.trim())))].join(" ");
  const nextTools = unresolvedTarget
    ? recoveryQuery
      ? [nextTool("search", "context packet still needs one exact file or symbol target", { query: recoveryQuery })]
      : []
    : riskyEditNeedsPlan
      ? [
          nextTool(
            "change_plan",
            changePlanNeed?.reason ?? "save one bounded plan for this materially risky edit",
            changePlanInputs,
            false,
            [".codex/cache/codexa-tasks", ".codex/cache/codexa-task-lifecycle"]
          )
        ]
      : [];
  const newTargetNeedsNoRead = !unresolvedTarget
    && !riskyEditNeedsPlan
    && boundedEditTarget
    && planPaths.length > 0
    && planPaths.every((filePath) => !repositoryPathSet.has(filePath))
    && focusPaths.length === 0;
  const actionability = unresolvedTarget ? "needs_target" : riskyEditNeedsPlan || boundedEditTarget ? "edit_ready" : baseActionability;
  const packetVerdict = unresolvedTarget ? "needs-target" : riskyEditNeedsPlan || boundedEditTarget ? "edit-ready" : packetIntent?.verdict;
  const effectivePacketIntent = packetIntent
    ? unresolvedTarget
      ? { ...packetIntent, editReady: false, verdict: "needs-target" as const, missingAnchors: uniqueSorted([...packetIntent.missingAnchors, "unresolved explicit target"]) }
      : riskyEditNeedsPlan || boundedEditTarget
        ? { ...packetIntent, mode: "edit" as const, editReady: true, verdict: "edit-ready" as const, missingAnchors: [], reasons: uniqueSorted([...packetIntent.reasons, riskyEditNeedsPlan ? "bounded change plan required" : "bounded task target supplies edit authority"]) }
        : packetIntent
    : undefined;
  const effectivePacketDiagnostics = unresolvedTarget
    ? uniqueSorted([...packetDiagnostics, "needs one unambiguous explicit target before edit planning"])
    : riskyEditNeedsPlan || boundedEditTarget
      ? packetDiagnostics.filter((diagnostic) => !/needs explicit|raw search likely/iu.test(diagnostic))
      : packetDiagnostics;
  const contextHandoff = nextTools[0]
    ? `Recommended next MCP call: ${nextTools[0].tool}`
    : unresolvedTarget
      ? "Codexa needs a concrete task, file, or symbol before it can recommend an executable next call."
      : newTargetNeedsNoRead
        ? "Codexa handoff: no indexed source read is required; proceed with the named new target and stop Codexa."
      : "Codexa handoff: read the returned source files and verification guidance, then stop; do not stack another context packet.";
  const handoffIntent = effectivePacketIntent
    ? { ...effectivePacketIntent, recommendedNextTool: nextTools[0]?.tool ?? (newTargetNeedsNoRead ? "none" : "source") }
    : undefined;

  const text = [
    freshnessBanner(freshness, refresh),
    formatContextQuality(quality),
    formatValueEstimate(value),
    "Codexa context pack",
    contextInput.task ? `Task: ${contextInput.task}` : undefined,
    effectivePacketIntent ? `Packet verdict: ${effectivePacketIntent.verdict}; edit-ready ${effectivePacketIntent.editReady ? "yes" : "no"}; confidence ${Math.round(effectivePacketIntent.confidence * 100)}%` : undefined,
    `Actionability: ${actionability}`,
    effectivePacketIntent ? `Intent mode: ${effectivePacketIntent.mode}; primary ${effectivePacketIntent.intent}; anchors ${effectivePacketIntent.anchors.slice(0, 4).join(", ") || "none"}` : undefined,
    contextHandoff,
    effectivePacketDiagnostics.length ? `Retrieval diagnostics: ${effectivePacketDiagnostics.join("; ")}` : undefined,
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
    applicableSkills.length > 0 || targetPlaybooks.length > 0 ? "" : undefined,
    applicableSkills.length > 0 || targetPlaybooks.length > 0 ? "Skill and playbook hints:" : undefined,
    ...applicableSkills.map((skill) => `- skill ${skill.name}: ${skill.matchedGlob} matched ${skill.matchedPath}${skill.description ? `; ${skill.description}` : ""}`),
    ...targetPlaybooks.map((playbook) => `- playbook ${playbook.module}: ${playbook.uri}`),
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
      targetCandidates: naturalTargetCandidates,
      unresolvedTargets: unresolvedNaturalTargets,
      boundedPlanTargets,
      nextReads,
      baseline,
      retrieval: naturalRetrieval
        ? { ...compactRetrievalResult(naturalRetrieval), intentConfidence: handoffIntent }
        : undefined,
      lspAssist,
      sessionMemory: sessionMemory.data,
      workspaceGuidance: workspaceGuidance.data,
      skillHints: skillHints.configured || skillHints.warnings.length > 0
        ? {
            configPath: skillHints.configPath,
            configured: skillHints.configured,
            roots: skillHints.roots.slice(0, 12),
            applicableSkills,
            targetPlaybooks,
            warnings: skillHints.warnings.slice(0, 12)
          }
        : undefined,
      targetPlaybooks,
      intentConfidence: handoffIntent,
      packetVerdict,
      actionability,
      diagnostics: effectivePacketDiagnostics,
      actionGuidanceSuppressed: suppressActionGuidance,
      recipes,
      verificationCommands,
      verificationCoverage,
      verificationCommandPlan: commandPlan,
      value,
      quality,
	      gaps,
	      nextTools,
	      systemMessage: nextTools[0]?.reason ?? (unresolvedTarget ? "Provide one concrete task, file, or symbol before edit planning." : newTargetNeedsNoRead ? "No indexed source read is required; proceed with the named new target and stop Codexa." : "Read the returned source files and verification guidance; stop Codexa unless the task materially changes."),
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
  const targetTask = normalizeTaskRepositoryPaths(task, repoRoot);
  const limit = clampInt(focusInput.limit ?? 10, 3, session.maxResults);
  const tokenBudget = clampInt(focusInput.tokenBudget ?? 2400, 600, 8000);
  const includeDiff = focusInput.diff ?? true;
  const worktree = includeDiff ? await getWorktreeState(session) : undefined;
  const dirtyScopeRequested = includeDiff && Boolean(worktree) && taskReferencesDirtyContext(task) && !worktree?.degraded;
  const intentOnly = retrieveIntentOnly(task);
  const changedEntries = worktree?.entries ?? [];
  const changed = worktree?.files ?? [];
  const indexedPaths = new Set(index.files.map((file) => file.path));
  const unindexedChanged = changed.filter((file) => !indexedPaths.has(file));
  const groups = includeDiff ? groupDiffImpact(index, changedEntries, worktree?.symbols ?? [], unindexedChanged).slice(0, 8) : [];
  const exactMatches: FocusSelectionEntry[] = exactFocusFileMatches(index, targetTask).map((file) => ({
    file,
    score: file.rank + 100,
    reasons: ["exact path in task"],
    matchedTerms: [file.path],
    tier: "derived" as EvidenceTier
  }));
  const repositoryFiles = index.files.map((file) => file.path);
  const changedPlanFiles = changed.filter((filePath) => !isCodexaControlPath(filePath));
  const changedPlanFileSet = new Set(changedPlanFiles);
  const targetRepositoryFiles = dirtyScopeRequested ? [...new Set([...repositoryFiles, ...changedPlanFiles])] : repositoryFiles;
  const exactTaskPaths = exactMatches.map((entry) => entry.file.path);
  const taskTargetAuthority = await inspectPlannedTargetAuthority(plannedNewFocusPathTargets(targetTask, targetRepositoryFiles), repoRoot, targetRepositoryFiles, unknownFocusPathTargets(targetTask, targetRepositoryFiles));
  const detectedPlannedNewTargets = taskTargetAuthority.newTargets;
  const matchedTaskPlanTargets = focusFilesAndSymbolsInTaskOrder(targetTask, [...targetRepositoryFiles, ...detectedPlannedNewTargets], [...targetRepositoryFiles, ...detectedPlannedNewTargets], index.symbols);
  const tentativeTaskPlanTargets = [...new Set([...matchedTaskPlanTargets, ...taskTargetAuthority.indexedTargets])];
  const plannedNewTargets = isStructuralEditTask(targetTask) && !tentativeTaskPlanTargets.some((filePath) => repositoryFiles.includes(filePath)) ? [] : detectedPlannedNewTargets;
  const directTaskPlanTargets = plannedNewTargets === detectedPlannedNewTargets
    ? tentativeTaskPlanTargets
    : [...new Set([...focusFilesAndSymbolsInTaskOrder(targetTask, targetRepositoryFiles, targetRepositoryFiles, index.symbols), ...taskTargetAuthority.indexedTargets])];
  const ambiguityRepositoryFiles = dirtyScopeRequested ? targetRepositoryFiles : repositoryFiles;
  const targetCandidateGroups = [...ambiguousFocusTargetCandidateGroups(targetTask, ambiguityRepositoryFiles), ...ambiguousFocusSymbolTargetCandidateGroups(targetTask, index.symbols, exactTaskPaths)];
  const rawTargetCandidates = [...new Set(targetCandidateGroups.flat())];
  const narrowedDirtyCandidates = narrowAmbiguousTargetGroupsToScope(targetCandidateGroups, changedPlanFileSet);
  const taskPlanTargets = [...new Set([...directTaskPlanTargets, ...(dirtyScopeRequested ? narrowedDirtyCandidates.resolved : [])])];
  const confirmedMissingPlanTargets = new Set(taskTargetAuthority.inspections.flatMap((entry) => entry.status === "missing" && entry.path ? [entry.path] : []));
  const taskTargetMatches: FocusSelectionEntry[] = taskPlanTargets.flatMap((filePath) => {
    const file = index.files.find((candidate) => candidate.path === filePath);
    return file ? [{ file, score: file.rank + 90, reasons: ["named task target"], matchedTerms: [filePath], tier: "authoritative" as EvidenceTier }] : [];
  });
  const targetCandidates = dirtyScopeRequested ? narrowedDirtyCandidates.ambiguous : rawTargetCandidates;
  const unresolvedTargets = unresolvedFocusPathTargets(targetTask, targetRepositoryFiles, [...plannedNewTargets, ...taskTargetAuthority.indexedTargetMentions]);
  const ambiguousExplicitTarget = targetCandidates.length > 0;
  const unresolvedNaturalTarget = unresolvedTargets.length > 0;
  const dirtyQualifierMentioned = dirtyScopeRequested && (taskPlanTargets.length > 0 || rawTargetCandidates.length > 0 || unresolvedNaturalTarget);
  const qualifiedDirtyTargets = dirtyQualifierMentioned ? taskPlanTargets.filter((filePath) => changedPlanFileSet.has(filePath)) : [];
  const dirtyQualifierNoMatch = dirtyQualifierMentioned && ((taskPlanTargets.length > 0 && qualifiedDirtyTargets.length === 0) || narrowedDirtyCandidates.unmatched);
  const dirtyScopeEmpty = dirtyScopeRequested && !dirtyQualifierMentioned && changedPlanFiles.length === 0;
  const pureNamedNewTarget = !dirtyScopeRequested && intentOnly.intentConfidence.mode === "edit" && taskPlanTargets.length > 0
    && taskPlanTargets.every((filePath) => confirmedMissingPlanTargets.has(filePath) && !repositoryFiles.includes(filePath)) && !ambiguousExplicitTarget && !unresolvedNaturalTarget
    && !classifyChangePlanNeed({ mode: "edit", task, explicitTargetCount: taskPlanTargets.length, targetFiles: taskPlanTargets, repositoryFiles });
  const retrieval = dirtyScopeRequested || pureNamedNewTarget ? intentOnly : await retrieveForTask(index, task, limit, semanticOptionsFromQueryOptions(repoRoot, options));
  if (pureNamedNewTarget) return terminalFocusBriefResult({ freshness, refresh, task, intent: intentOnly.intentConfidence, targetPaths: taskPlanTargets, reason: "named new target has no indexed source dependency" });
  if (dirtyScopeEmpty) return terminalFocusBriefResult({ freshness, refresh, task, intent: intentOnly.intentConfidence, targetPaths: [], reason: "requested dirty-worktree scope is clean" });
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
  const selectedPrune = pruneMissingFiles(
    retrieval.matches.length > 0 || exactMatches.length > 0 || workflowMatches.length > 0
      ? uniqueFocusEntries([...exactMatches, ...taskTargetMatches, ...workflowMatches, ...workflowTestMatches, ...workflowScopedMatches]).slice(0, limit)
      : index.files.slice(0, limit).map((file) => ({ file, score: file.rank, reasons: ["ranked project entry point fallback"], matchedTerms: [], tier: "fallback" as EvidenceTier })),
    repoRoot,
    (entry) => entry.file.path
  );
  const selected: FocusSelectionEntry[] = dirtyScopeRequested
    ? selectedPrune.entries.filter((entry) => (dirtyQualifierMentioned ? qualifiedDirtyTargets : changedPlanFiles).includes(entry.file.path))
    : selectedPrune.entries;
  const focusFiles = uniqueFiles(selected.map((entry) => entry.file)).slice(0, limit);
  const tiersByPath = new Map(selected.map((entry) => [entry.file.path, entry.tier]));
  const tests = recommendTests(index, focusFiles.map((file) => file.path), repoRoot).slice(0, 10);
  const dirtyScopeFileCount = dirtyScopeRequested && !dirtyQualifierMentioned ? changedPlanFiles.length : 0;
  const routedPlanTargets = dirtyScopeRequested && dirtyQualifierMentioned ? qualifiedDirtyTargets : taskPlanTargets;
  const routingMode = dirtyQualifierNoMatch || dirtyScopeEmpty ? "orientation" as const : retrieval.intentConfidence.mode;
  const recommendedNextCall = recommendNextCodexaCall(
    retrieval.intents,
    retrieval.workflows,
    changed.length,
    task,
    focusFiles.map((file) => file.path),
    {
      mode: routingMode,
      explicitTargetCount: routedPlanTargets.length,
      dirtyScopeFileCount,
      targetFiles: routedPlanTargets,
      repositoryFiles,
      ambiguousExplicitTarget,
      unresolvedExplicitTarget: unresolvedNaturalTarget
    }
  );
  const newTargetNeedsNoRead = routingMode === "edit"
    && routedPlanTargets.length > 0
    && routedPlanTargets.every((filePath) => !repositoryFiles.includes(filePath))
    && focusFiles.length === 0
    && recommendedNextCall.tool === "source";
  const proposedNextCall = dirtyScopeEmpty && focusFiles.length === 0 && recommendedNextCall.tool === "source"
    ? { tool: "none", reason: "the requested dirty-worktree scope is clean; stop Codexa" }
    : newTargetNeedsNoRead
    ? { tool: "none", reason: "the named new target is edit-ready and there is no indexed source to read; proceed and stop Codexa" }
    : recommendedNextCall;
  const dirtyScopePlan = dirtyScopeFileCount > 0 && proposedNextCall.tool === "change_plan";
  const boundedPlan = routedPlanTargets.length > 0 && proposedNextCall.tool === "change_plan" && !ambiguousExplicitTarget && !unresolvedNaturalTarget;
  const boundedTargetReady = routingMode === "edit" && routedPlanTargets.length > 0 && !dirtyQualifierNoMatch && !ambiguousExplicitTarget && !unresolvedNaturalTarget;
  const noDirtyTarget = dirtyScopeEmpty || dirtyQualifierNoMatch;
  const effectiveIntent = dirtyScopePlan || boundedPlan || boundedTargetReady
    ? {
        ...retrieval.intentConfidence,
        mode: "edit" as const,
        confidence: Math.max(0.7, retrieval.intentConfidence.confidence),
        anchors: dirtyScopePlan ? changedPlanFiles.slice(0, 8) : routedPlanTargets.slice(0, 8),
        selectedAnchorCount: dirtyScopePlan ? dirtyScopeFileCount : routedPlanTargets.length,
        missingAnchors: [],
        editReady: true,
        verdict: "edit-ready" as const,
        reasons: uniqueSorted([...retrieval.intentConfidence.reasons, dirtyScopePlan ? "explicit dirty worktree scope" : "bounded task target supplies plan authority"])
      }
    : noDirtyTarget
      ? {
          ...retrieval.intentConfidence,
          mode: "orientation" as const,
          anchors: [],
          selectedAnchorCount: 0,
          missingAnchors: [],
          editReady: false,
          verdict: "orientation-only" as const,
          reasons: uniqueSorted([...retrieval.intentConfidence.reasons, dirtyScopeEmpty ? "no dirty files" : "no dirty files match the named qualifier"])
        }
      : ambiguousExplicitTarget || unresolvedNaturalTarget
      ? {
          ...retrieval.intentConfidence,
          anchors: [],
          selectedAnchorCount: 0,
          missingAnchors: uniqueSorted([...retrieval.intentConfidence.missingAnchors, ambiguousExplicitTarget ? "ambiguous repository target" : "unresolved repository path"]),
          editReady: false,
          verdict: "needs-target" as const,
          reasons: uniqueSorted([...retrieval.intentConfidence.reasons, ambiguousExplicitTarget ? "ambiguous repository target" : "unresolved repository path"])
        }
      : retrieval.intentConfidence;
  const effectiveDiagnostics = dirtyScopePlan || boundedPlan || boundedTargetReady
    ? uniqueSorted([...retrieval.diagnostics.filter((diagnostic) => !/needs explicit|raw search likely|workflow intent had no matching trace/iu.test(diagnostic)), dirtyScopePlan ? "explicit dirty worktree scope supplies plan targets" : "bounded task target supplies plan authority"])
    : noDirtyTarget
      ? uniqueSorted([...retrieval.diagnostics.filter((diagnostic) => !/needs explicit|raw search likely/iu.test(diagnostic)), dirtyScopeEmpty ? "no dirty files" : "no dirty files match the named qualifier"])
      : ambiguousExplicitTarget || unresolvedNaturalTarget
      ? uniqueSorted([...retrieval.diagnostics, ambiguousExplicitTarget ? "named target matches multiple repository paths" : "named path does not resolve to an indexed repository file"])
      : retrieval.diagnostics;
  const nextCall = !noDirtyTarget && !dirtyScopePlan && !boundedTargetReady && !ambiguousExplicitTarget && !unresolvedNaturalTarget && (effectiveIntent.verdict === "needs-target" || effectiveIntent.verdict === "raw-search-better")
    ? { tool: "search", reason: "the session packet still lacks one exact source target", arguments: { query: task } }
    : proposedNextCall;
  const actionability = actionabilityFromPacketVerdict(effectiveIntent.verdict);
  const handoff = nextCall.tool === "none"
    ? dirtyScopeEmpty
      ? "Codexa handoff: the worktree is clean; there are no current changes to inspect or edit, so stop Codexa."
      : "Codexa handoff: no indexed source read is required; proceed with the named new target and stop Codexa."
    : nextCall.tool === "source"
    ? "Codexa handoff: read the returned source files and tests, then stop; do not call task_brief, context_pack, or session_context again."
    : `Recommended next MCP call: ${nextCall.tool} - ${nextCall.reason}`;
  const handoffIntent = { ...effectiveIntent, recommendedNextTool: nextCall.tool };
  const gaps = [
    ...indexGaps(index, freshness, unindexedChanged),
    ...(worktree ? worktreeStateGaps(worktree) : []),
    ...(selectedPrune.prunedCount > 0 ? [prunedFilesGap(selectedPrune.prunedCount)] : [])
  ];
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
    packetVerdict: effectiveIntent.verdict,
    discardedAnchorCount: effectiveIntent.discardedAnchorCount
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
    `Packet verdict: ${effectiveIntent.verdict}; edit-ready ${effectiveIntent.editReady ? "yes" : "no"}; confidence ${Math.round(effectiveIntent.confidence * 100)}%`,
    `Actionability: ${actionability}`,
    `Intent mode: ${effectiveIntent.mode}; primary ${effectiveIntent.intent}; anchors ${effectiveIntent.anchors.slice(0, 4).join(", ") || "none"}`,
    effectiveDiagnostics.length > 0 ? `Retrieval diagnostics: ${effectiveDiagnostics.join("; ")}` : undefined,
    handoff,
    nextCall.arguments ? `Suggested arguments: ${JSON.stringify(nextCall.arguments)}` : undefined,
    "",
    dirtyScopeRequested ? undefined : "Likely subsystems:",
    ...(dirtyScopeRequested ? [] : retrieval.modules.length > 0
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
      retrieval: { ...compactRetrievalResult(retrieval), intentConfidence: handoffIntent },
      intentConfidence: handoffIntent,
      packetVerdict: effectiveIntent.verdict,
      actionability,
      diagnostics: effectiveDiagnostics,
      focusFiles: focusFiles.map(compactFileFact),
      workflows: retrieval.workflows.slice(0, 12).map(compactWorkflowTrace),
      modules: retrieval.modules.slice(0, 12).map((module) => ({ ...module, files: module.files.slice(0, 40), reasons: module.reasons.slice(0, 12) })),
      groups: groups.slice(0, 12).map(compactDiffGroup),
      worktree: worktree ? compactWorktreeState(worktree) : undefined,
      worktreeDegradationReasons: worktree?.degradedReasons ?? [],
      tests: tests.slice(0, 30),
      targetCandidates,
      unresolvedTargets,
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
    const snippet = await readContextSnippet(repoRoot, filePath, line, 3);
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
