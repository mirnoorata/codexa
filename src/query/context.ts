import { promises as fs } from "node:fs";
import path from "node:path";
import type { ChangedSymbol, CodexaIndex, ContextPackInput, EvidenceTier, FileFact, FocusBriefInput, QueryOptions, QueryResult } from "../types.js";
import { limitText, uniqueSorted } from "../util.js";
import { formatDiffGroups, formatGaps, groupDiffImpact, indexGaps } from "./diff.js";
import { addContextPackImpactExpansion, verificationRecipes } from "./impact.js";
import { betterTier, clampInt, confidenceTier, fitLinesToTokenBudget, focusTierCounts, formatReasons, formatRecipes, limitTextToTokens, tierScore } from "./formatting.js";
import { formatWorkflowSummary, recommendNextCodexaCall } from "./graph.js";
import { assessContextQuality, formatContextQuality, formatValueEstimate, type ContextQuality, valueEstimate } from "./quality.js";
import { baselineSearchSummary } from "./raw-search.js";
import { codeLikeQueryFromTask, fileStemQueryTerms, matchReason, matchScore, uniqueFiles } from "./search.js";
import { freshnessBanner } from "./runtime.js";
import { ensureQuerySession, type QuerySessionInput } from "./session.js";
import { formatTestRecommendations, recommendTests } from "./tests.js";
import { findFile, resolveFileTarget, resolveSymbolTarget } from "./targets.js";
import { retrieveForTask } from "../retrieval.js";

export async function contextPackQuery(input: QuerySessionInput, contextInput: ContextPackInput = {}, options: QueryOptions = {}): Promise<QueryResult> {
  const session = await ensureQuerySession(input, options);
  const { index, freshness, refresh, repoRoot } = session;
  const tokenBudget = clampInt(contextInput.tokenBudget ?? 4000, 500, 12000);
  const limit = clampInt(contextInput.limit ?? 12, 3, session.maxResults);
  const includeSnippets = contextInput.includeSnippets ?? true;
  const changeType = contextInput.changeType ?? "unknown";
  const warnings = [...session.warnings];
  const focus = new Map<string, { file: FileFact; reasons: Set<string>; rank: number; tier: EvidenceTier }>();
  const impactSeeds = new Map<string, string>();
  const addFocus = (filePath: string, reason: string, rank = 1, tier: EvidenceTier = "derived") => {
    const file = findFile(index, filePath);
    if (!file) {
      warnings.push(`unindexed file ${filePath}`);
      return;
    }
    const existing = focus.get(file.path) ?? { file, reasons: new Set<string>(), rank: file.rank, tier };
    existing.reasons.add(reason);
    existing.rank += rank;
    existing.tier = betterTier(existing.tier, tier);
    focus.set(file.path, existing);
  };

  const requestedFiles = contextInput.files ?? [];
  for (const requested of requestedFiles) {
    const resolved = resolveFileTarget(index, requested, repoRoot);
    if (resolved.ambiguous.length > 0) {
      warnings.push(`ambiguous file ${requested}`);
      continue;
    }
    if (resolved.file) {
      addFocus(resolved.file.path, "requested file", 100, "authoritative");
      impactSeeds.set(resolved.file.path, "requested file");
    } else {
      warnings.push(`missing file ${requested}`);
    }
  }

  const requestedSymbols = contextInput.symbols ?? [];
  for (const requested of requestedSymbols) {
    const resolved = resolveSymbolTarget(index, requested);
    if (resolved.ambiguous.length > 0) {
      warnings.push(`ambiguous symbol ${requested}`);
      continue;
    }
    if (resolved.symbol) {
      addFocus(resolved.symbol.path, `requested symbol ${resolved.symbol.qualifiedName}`, 100, "authoritative");
      impactSeeds.set(resolved.symbol.path, `requested symbol ${resolved.symbol.qualifiedName}`);
      for (const usage of index.usageSites.filter((site) => site.targetSymbolId === resolved.symbol!.id).slice(0, 12)) {
        addFocus(usage.path, `uses ${resolved.symbol.qualifiedName}`, 4, confidenceTier(usage.confidence));
      }
    } else {
      warnings.push(`missing symbol ${requested}`);
    }
  }

  const explicitQuery = contextInput.query?.trim() ?? "";
  const naturalRetrieval = contextInput.task ? retrieveForTask(index, contextInput.task, Math.max(limit * 2, 12)) : undefined;
  const naturalRetrievalFocused = Boolean(naturalRetrieval && naturalRetrieval.matches.length > 0);
  const explicitTargetProvided = requestedFiles.length > 0 || requestedSymbols.length > 0;
  const derivedTaskQuery = explicitQuery || explicitTargetProvided ? "" : codeLikeQueryFromTask(contextInput.task);
  const queryText = explicitQuery || derivedTaskQuery;
  const explicitFocusProvided = explicitTargetProvided || Boolean(queryText) || naturalRetrievalFocused;
  if (queryText.trim()) {
    for (const file of index.files) {
      const score = matchScore(queryText, file.path);
      if (score > 0) {
        addFocus(file.path, `path ${matchReason(score)} ${queryText}`, score, score >= 9 ? "derived" : "heuristic");
      }
    }
    for (const symbol of index.symbols) {
      const score = Math.max(matchScore(queryText, symbol.name), matchScore(queryText, symbol.qualifiedName), matchScore(queryText, symbol.path));
      if (score > 0) {
        addFocus(symbol.path, `symbol ${matchReason(score)} ${symbol.qualifiedName}`, score + 1, score >= 9 ? confidenceTier(symbol.confidence) : "heuristic");
      }
    }
    for (const usage of index.usageSites) {
      const score = Math.max(matchScore(queryText, usage.name), matchScore(queryText, usage.text), matchScore(queryText, usage.path));
      if (score > 0) {
        addFocus(usage.path, `usage ${matchReason(score)} ${usage.name}`, score, confidenceTier(usage.confidence));
      }
    }
  }

  if (!queryText.trim() && naturalRetrieval && !explicitTargetProvided) {
    for (const match of naturalRetrieval.matches.slice(0, limit * 2)) {
      addFocus(match.file.path, `natural task retrieval ${match.matchedTerms.slice(0, 6).join(", ") || "intent"}: ${formatReasons(match.reasons, 3)}`, Math.max(2, match.score), match.score >= 4 ? "derived" : "heuristic");
      if (match.score >= 4) {
        impactSeeds.set(match.file.path, "natural task retrieval");
      }
    }
    for (const workflow of naturalRetrieval.workflows.slice(0, 4)) {
      for (const filePath of workflow.relatedFiles.slice(0, 6)) {
        addFocus(filePath, `workflow ${workflow.title}`, Math.max(2, workflow.rank / 4), confidenceTier(workflow.confidence));
      }
    }
  }

  const includeDiff = contextInput.diff ?? true;
  const changedEntries = includeDiff ? await session.getChangedFileEntries() : [];
  const changed = changedEntries.map((entry) => entry.path);
  const changedSymbols = includeDiff ? await session.getChangedSymbols() : [];
  const indexedPaths = new Set(index.files.map((file) => file.path));
  const unindexedChanged = changed.filter((file) => !indexedPaths.has(file));
  const groups = groupDiffImpact(index, changedEntries, changedSymbols, unindexedChanged).slice(0, 12);
  const broadDirty = changed.length > Math.max(8, limit);
  const dirtyDrivesFocus = changed.length > 0 && (!explicitFocusProvided || !broadDirty);
  if (changed.length > 0 && explicitFocusProvided && broadDirty) {
    warnings.push(`broad dirty tree (${changed.length} files) kept as diff context, not read-first focus`);
  }
  if (dirtyDrivesFocus) {
    for (const file of changed.filter((candidate) => indexedPaths.has(candidate)).slice(0, limit * 2)) {
      addFocus(file, "dirty diff", 6, "authoritative");
      impactSeeds.set(file, "dirty diff");
    }
    for (const entry of changedSymbols.slice(0, limit * 2)) {
      addFocus(entry.symbol.path, `changed symbol ${entry.symbol.qualifiedName}`, 6, "derived");
      impactSeeds.set(entry.symbol.path, `changed symbol ${entry.symbol.qualifiedName}`);
    }
    for (const group of groups) {
      const representative = group.files
        .map((filePath) => findFile(index, filePath))
        .filter((file): file is FileFact => Boolean(file))
        .sort((a, b) => b.riskScore - a.riskScore || b.rank - a.rank || a.path.localeCompare(b.path))[0];
      if (representative) {
        addFocus(representative.path, `change-group representative ${group.module}`, 5, group.kind === "unknown" ? "fallback" : "derived");
      }
    }
  }

  addContextPackImpactExpansion(index, impactSeeds, changeType, limit, addFocus);
  if (requestedFiles.length > 0 || requestedSymbols.length > 0 || queryText.trim()) {
    const testSeedPaths = uniqueSorted([...impactSeeds.keys(), ...focus.keys()]);
    for (const test of recommendTests(index, testSeedPaths, repoRoot).slice(0, Math.max(1, Math.min(4, Math.floor(limit / 2))))) {
      addFocus(test.path, `likely test: ${test.reason}`, test.evidenceTier === "authoritative" ? 18 : test.evidenceTier === "derived" ? 14 : 8, test.evidenceTier ?? "derived");
    }
  }

  if (focus.size === 0) {
    for (const file of index.files.slice(0, limit)) {
      addFocus(file.path, "top-ranked fallback", 1, "fallback");
    }
  }

  const focusEntries = [...focus.values()].sort((a, b) => tierScore(a.tier) - tierScore(b.tier) || b.rank - a.rank || a.file.path.localeCompare(b.file.path)).slice(0, limit);
  const focusPaths = focusEntries.map((entry) => entry.file.path);
  const contextSeedPaths = dirtyDrivesFocus ? uniqueSorted([...focusPaths, ...changed]) : focusPaths;
  const snippetChangedSymbols = dirtyDrivesFocus ? changedSymbols : changedSymbols.filter((entry) => impactSeeds.has(entry.symbol.path));
  const tests = recommendTests(index, contextSeedPaths, repoRoot).slice(0, 12);
  const snippetQueryText =
    queryText ||
    contextInput.task ||
    requestedSymbols.join(" ") ||
    requestedFiles
      .flatMap((filePath) => fileStemQueryTerms(path.posix.basename(filePath).replace(/\.[^.]+$/, "")))
      .join(" ");
  const snippets = includeSnippets ? await contextSnippets(repoRoot, index, focusPaths, snippetChangedSymbols, snippetQueryText, limit) : [];
  const nextReads = focusEntries.slice(0, Math.min(8, focusEntries.length)).map((entry) => entry.file.path);
  const baseline = explicitQuery ? await baselineSearchSummary(repoRoot, queryText) : undefined;
  const gaps = indexGaps(index, freshness, unindexedChanged);
  const recipes = verificationRecipes(index, contextSeedPaths, changeType).slice(0, 8);
  const quality = assessContextQuality({
    freshness,
    gaps,
    tiers: focusTierCounts(focusEntries),
    selectedCount: focusEntries.length,
    fanoutCount: dirtyDrivesFocus ? changed.length : focusEntries.length
  });
  const value = valueEstimate("context_pack", {
    rawFileCount: baseline?.lines,
    codexaFileCount: focusEntries.length,
    exactTargetCount: requestedFiles.length + requestedSymbols.length,
    testCount: tests.length,
    parserErrors: index.parserErrors.length,
    affectedCount: changed.length,
    quality
  });

  const text = [
    freshnessBanner(freshness, refresh),
    formatContextQuality(quality),
    formatValueEstimate(value),
    "Codexa context pack",
    contextInput.task ? `Task: ${contextInput.task}` : undefined,
    `Change type: ${changeType}`,
    `Budget: ${tokenBudget} tokens approx; focus files: ${focusEntries.length}; changed files: ${changed.length}`,
    baseline ? `Baseline search: ${baseline.command} returned ${baseline.lines} non-empty lines; Codexa selected ${focusEntries.length} focus files.` : undefined,
    warnings.length > 0 ? `Warnings: ${uniqueSorted(warnings).join("; ")}` : undefined,
    "",
    "Read first:",
    ...focusEntries.map((entry) => `- ${entry.file.path}: ${entry.tier}; rank ${entry.file.rank.toFixed(2)}, risk ${entry.file.riskScore.toFixed(1)}; ${formatReasons(entry.reasons)}`),
    groups.length > 0 ? "" : undefined,
    groups.length > 0 ? "Change groups:" : undefined,
    ...formatDiffGroups(groups),
    "",
    "Likely tests:",
    ...formatTestRecommendations(tests),
    "",
    "Known gaps:",
    ...formatGaps(gaps),
    "",
    "Verification recipes:",
    ...formatRecipes(recipes),
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
      task: contextInput.task,
      changeType,
      tokenBudget,
      focusFiles: focusEntries.map((entry) => ({ file: entry.file, reasons: uniqueSorted(entry.reasons), rank: entry.rank, tier: entry.tier })),
      changedFiles: changed,
      changedEntries,
      changedSymbols,
      unindexedChanged,
      groups,
      tests,
      snippets,
      warnings: uniqueSorted(warnings),
      nextReads,
      baseline,
      retrieval: naturalRetrieval,
      recipes,
      value,
      quality,
      gaps,
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
  const retrieval = retrieveForTask(index, task, limit);
  const includeDiff = focusInput.diff ?? true;
  const changedEntries = includeDiff ? await session.getChangedFileEntries() : [];
  const changed = changedEntries.map((entry) => entry.path);
  const indexedPaths = new Set(index.files.map((file) => file.path));
  const unindexedChanged = changed.filter((file) => !indexedPaths.has(file));
  const groups = includeDiff ? groupDiffImpact(index, changedEntries, includeDiff ? await session.getChangedSymbols() : [], unindexedChanged).slice(0, 8) : [];
  const exactMatches = exactFocusFileMatches(index, task).map((file) => ({
    file,
    score: file.rank + 100,
    reasons: ["exact path in task"],
    matchedTerms: [file.path],
    tier: "derived" as EvidenceTier
  }));
  const selected: Array<{ file: FileFact; score: number; reasons: string[]; matchedTerms: string[]; tier: EvidenceTier }> =
    retrieval.matches.length > 0 || exactMatches.length > 0
      ? uniqueFocusEntries([...exactMatches, ...retrieval.matches.map((match) => ({ ...match, tier: focusMatchTier(match.file, task) }))]).slice(0, limit)
      : index.files.slice(0, limit).map((file) => ({ file, score: file.rank, reasons: ["ranked project entry point fallback"], matchedTerms: [], tier: "fallback" }));
  const focusFiles = uniqueFiles(selected.map((entry) => entry.file)).slice(0, limit);
  const tiersByPath = new Map(selected.map((entry) => [entry.file.path, entry.tier]));
  const tests = recommendTests(index, focusFiles.map((file) => file.path), repoRoot).slice(0, 10);
  const nextCall = recommendNextCodexaCall(retrieval.intents, retrieval.workflows, changed.length, task);
  const gaps = indexGaps(index, freshness, unindexedChanged);
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
    centralFileCount: focusFiles.filter((file) => file.rank >= index.files[Math.min(index.files.length - 1, 5)]?.rank).length
  });
  const text = [
    freshnessBanner(freshness, refresh),
    formatContextQuality(quality),
    "Codexa focus brief",
    `Task: ${task}`,
    `Intent: ${retrieval.intents.join(", ")}`,
    `Recommended next MCP call: ${nextCall.tool} - ${nextCall.reason}`,
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
    ...formatDiffGroups(groups),
    "",
    "Likely tests:",
    ...formatTestRecommendations(tests),
    "",
    "Known gaps:",
    ...formatGaps(gaps)
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
  return {
    freshness,
    refresh,
    text: limitTextToTokens(text, tokenBudget),
    data: { mode: "focus_brief", task, retrieval, focusFiles, workflows: retrieval.workflows, modules: retrieval.modules, groups, tests, nextCall, quality, gaps }
  };
}

function focusMatchTier(file: FileFact, task: string): EvidenceTier {
  const lowerTask = task.toLowerCase();
  const lowerPath = file.path.toLowerCase();
  const baseName = path.posix.basename(lowerPath);
  const stem = baseName.replace(/\.[^.]+$/u, "");
  if (lowerTask.includes(lowerPath) || lowerTask.includes(baseName) || (stem.length >= 4 && lowerTask.includes(stem))) {
    return "derived";
  }
  return "heuristic";
}

function exactFocusFileMatches(index: { files: FileFact[] }, task: string): FileFact[] {
  const lowerTask = task.toLowerCase();
  return index.files
    .filter((file) => {
      const lowerPath = file.path.toLowerCase();
      const baseName = path.posix.basename(lowerPath);
      return lowerTask.includes(lowerPath) || lowerTask.includes(baseName);
    })
    .sort((a, b) => b.rank - a.rank || a.path.localeCompare(b.path));
}

function uniqueFocusEntries<T extends { file: FileFact; score: number; tier: EvidenceTier }>(entries: T[]): T[] {
  const byPath = new Map<string, T>();
  for (const entry of entries.sort((a, b) => tierScore(a.tier) - tierScore(b.tier) || b.score - a.score || a.file.path.localeCompare(b.file.path))) {
    if (!byPath.has(entry.file.path)) {
      byPath.set(entry.file.path, entry);
    }
  }
  return [...byPath.values()];
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
    if (snippet) {
      snippets.push(`- ${filePath}:${line} ${reason}\n${snippet}`);
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

async function readSnippet(repoRoot: string, filePath: string, centerLine: number, radius: number): Promise<string> {
  try {
    const source = await fs.readFile(path.join(repoRoot, filePath), "utf8");
    const lines = source.split(/\r?\n/);
    const start = Math.max(1, centerLine - radius);
    const end = Math.min(lines.length, centerLine + radius);
    return lines
      .slice(start - 1, end)
      .map((line, index) => `  ${String(start + index).padStart(4, " ")} | ${line.slice(0, 180)}`)
      .join("\n");
  } catch {
    return "";
  }
}
