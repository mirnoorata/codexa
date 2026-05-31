import { isTestPath, languageForPath } from "../language.js";
import type { ChangeType, CodexaIndex, Confidence, EvidenceTier, FileFact, GraphEdgeFact, QueryOptions, QueryResult, SymbolFact } from "../types.js";
import { limitText, uniqueSorted } from "../util.js";
import { formatDiffGroups, formatGaps, groupDiffImpact, indexGaps } from "./diff.js";
import { compactChangedSymbol, compactDiffGroup, compactFileFact, compactSymbolFact } from "./compact-data.js";
import { confidenceTier, tierScore, tierCounts, formatReasons, formatRecipes, clampInt } from "./formatting.js";
import { graphEdgeSort, isImpactGraphEdge } from "./graph.js";
import { assessContextQuality, formatContextQuality, formatValueEstimate, type ContextQuality, valueEstimate } from "./quality.js";
import { freshnessBanner, ambiguityResult } from "./runtime.js";
import { ensureQuerySession, type QuerySessionInput } from "./session.js";
import { formatTestRecommendations, recommendTests } from "./tests.js";
import { findFile, resolveFileTarget, resolveSymbolTarget } from "./targets.js";
import { formatChangedEntry } from "./worktree.js";
import { compactWorktreeState, getWorktreeState, worktreeStateGaps, worktreeStateText } from "./worktree-state.js";

export type ImpactEntry = { file: FileFact; reasons: string[]; depth: number; confidence: Confidence };

export async function impactQuery(
  input: QuerySessionInput,
  impactInput: { file?: string; symbol?: string; changeType?: ChangeType; depth?: number },
  options: QueryOptions = {}
): Promise<QueryResult> {
  const session = await ensureQuerySession(input, options);
  const { index, freshness, refresh, repoRoot } = session;
  const gaps = indexGaps(index, freshness);
  const changeType = impactInput.changeType ?? "unknown";
  const defaultDepth = changeType === "api" || changeType === "rename" || changeType === "delete" ? 2 : 1;
  const maxDepth = clampInt(impactInput.depth ?? defaultDepth, 1, 3);
  const fileTarget = impactInput.file ? resolveFileTarget(index, impactInput.file, repoRoot) : { ambiguous: [] };
  if (fileTarget.ambiguous.length > 0) {
    return ambiguityResult(freshness, refresh, "file", impactInput.file ?? "", fileTarget.ambiguous);
  }
  const symbolTarget = impactInput.symbol ? resolveSymbolTarget(index, impactInput.symbol) : { ambiguous: [] };
  if (symbolTarget.ambiguous.length > 0) {
    return ambiguityResult(freshness, refresh, "symbol", impactInput.symbol ?? "", symbolTarget.ambiguous);
  }
  const symbol = "symbol" in symbolTarget ? symbolTarget.symbol : undefined;
  const file = "file" in fileTarget ? fileTarget.file : symbol ? index.files.find((candidate) => candidate.path === symbol.path) : undefined;
  if (!file && !symbol) {
    return {
      freshness,
      refresh,
      text: `${freshnessBanner(freshness, refresh)}\nNo file or symbol matched impact target.`,
      data: { mode: "impact", file: null, symbol: null }
    };
  }

  const affectedFiles = new Map<string, ImpactEntry>();
  const add = (candidatePath: string, reason: string, depth = 0, confidence: Confidence = "derived") => {
    const candidate = findFile(index, candidatePath);
    if (!candidate) {
      return;
    }
    const existing = affectedFiles.get(candidate.path) ?? { file: candidate, reasons: [], depth, confidence };
    existing.reasons.push(reason);
    existing.depth = Math.min(existing.depth, depth);
    existing.confidence = mergeConfidence(existing.confidence, confidence);
    affectedFiles.set(candidate.path, existing);
  };

  if (file) {
    add(file.path, "target", 0, "authoritative");
    for (const imp of index.imports.filter((edge) => edge.resolvedPath === file.path)) {
      add(imp.path, `imports ${file.path}`, 1, "authoritative");
    }
    const definedSymbolIds = new Set(index.symbols.filter((candidate) => candidate.path === file.path).map((candidate) => candidate.id));
    for (const usage of index.usageSites.filter((site) => site.targetSymbolId && definedSymbolIds.has(site.targetSymbolId))) {
      if (usage.path === file.path) {
        continue;
      }
      add(usage.path, `${usage.kind} ${usage.name} (${usage.confidence})`, 1, usage.confidence);
    }
    for (const test of index.testEdges.filter((edge) => edge.targetPath === file.path)) {
      add(test.path, `tests ${file.path}`, 1, test.confidence);
    }
  }

  if (symbol) {
    add(symbol.path, `defines ${symbol.qualifiedName}`, 0, "authoritative");
    for (const usage of index.usageSites.filter((site) => site.targetSymbolId === symbol.id)) {
      add(usage.path, `${usage.kind} ${symbol.name} (${usage.confidence})`, 1, usage.confidence);
    }
  }

  addTransitiveImpact(index, affectedFiles, maxDepth);
  addRecommendedTestsToImpact(index, affectedFiles, [...affectedFiles.keys()], repoRoot, maxDepth + 1);
  const ranked = [...affectedFiles.values()].sort((a, b) => impactSortScore(b) - impactSortScore(a) || b.file.rank - a.file.rank || a.file.path.localeCompare(b.file.path));
  const evidenceTiers = tierImpactEntries(ranked);
  const tierOrdered = [...evidenceTiers.authoritative, ...evidenceTiers.derived, ...evidenceTiers.heuristic];
  const fanout = summarizeFanout(tierOrdered, changeType);
  const tests = recommendTests(index, ranked.map((entry) => entry.file.path), repoRoot);
  const recipes = verificationRecipes(index, ranked.map((entry) => entry.file.path), changeType);
  const quality = assessContextQuality({
    freshness,
    gaps,
    tiers: tierCounts(evidenceTiers),
    selectedCount: fanout.readFirst.length,
    fanoutCount: ranked.length
  });
  const value = valueEstimate("impact", {
    rawFileCount: undefined,
    codexaFileCount: fanout.readFirst.length,
    exactTargetCount: fanout.readFirst.filter((entry) => entry.reasons.includes("target") || entry.reasons.some((reason) => reason.startsWith("defines "))).length,
    testCount: tests.length,
    parserErrors: index.parserErrors.length,
    affectedCount: ranked.length,
    quality
  });
  const text = [
    freshnessBanner(freshness, refresh),
    formatContextQuality(quality),
    formatValueEstimate(value),
    `Impact target: ${symbol ? `symbol ${symbol.qualifiedName}` : `file ${file?.path}`}`,
    `Change type: ${changeType}; traversal depth: ${maxDepth}`,
    "",
    fanout.summary,
    "Authoritative read first:",
    ...formatTierEntries(fanout.readFirst.filter((entry) => evidenceTierForImpact(entry) === "authoritative")),
    "",
    "Derived follow-up:",
    ...formatTierEntries(fanout.readFirst.filter((entry) => evidenceTierForImpact(entry) === "derived")),
    "",
    "Heuristic expansion:",
    ...formatTierEntries(fanout.readFirst.filter((entry) => evidenceTierForImpact(entry) === "heuristic")),
    fanout.collapsed.length > 0 ? "" : undefined,
    fanout.collapsed.length > 0 ? `Collapsed affected files (${fanout.collapsed.length}):` : undefined,
    ...fanout.collapsed.slice(0, 20).map((entry) => `- ${entry.file.path}: ${uniqueSorted(entry.reasons).slice(0, 3).join("; ")}`),
    "",
    "Recommended tests:",
    ...formatTestRecommendations(tests.slice(0, 20)),
    "",
    "Verification recipes:",
    ...formatRecipes(recipes),
    "",
    "Known gaps:",
    ...formatGaps(gaps)
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
  const readFirstFiles = fanout.readFirst.map((entry) => entry.file.path);
  return {
    freshness,
    refresh,
    text: limitText(text, 7000),
    data: {
      mode: "impact",
      target: { file: file ? compactFileFact(file) : undefined, symbol: symbol ? compactSymbolFact(symbol) : undefined },
      changeType,
      depth: maxDepth,
      readFirstFiles,
      selectedFiles: readFirstFiles,
      affectedFiles: ranked.map(compactImpactEntry),
      evidenceTiers: {
        authoritative: evidenceTiers.authoritative.map(compactImpactEntry),
        derived: evidenceTiers.derived.map(compactImpactEntry),
        heuristic: evidenceTiers.heuristic.map(compactImpactEntry)
      },
      fanout: {
        summary: fanout.summary,
        readFirst: fanout.readFirst.map(compactImpactEntry),
        collapsed: fanout.collapsed.slice(0, 40).map(compactImpactEntry)
      },
      tests: tests.slice(0, 30),
      recipes,
      value,
      quality,
      gaps
    }
  };
}

export async function diffImpactQuery(input: QuerySessionInput, options: QueryOptions = {}): Promise<QueryResult> {
  const session = await ensureQuerySession(input, options);
  const { index, freshness, refresh } = session;
  const worktree = await getWorktreeState(session);
  const changedEntries = worktree.entries;
  const changed = worktree.files;
  const changedSymbols = worktree.symbols;
  const indexedPaths = new Set(index.files.map((file) => file.path));
  const indexedChanged = changed.filter((file) => indexedPaths.has(file));
  const unindexedChanged = changed.filter((file) => !indexedPaths.has(file));
  const groups = groupDiffImpact(index, changedEntries, changedSymbols, unindexedChanged);
  const gaps = [...indexGaps(index, freshness, unindexedChanged), ...worktreeStateGaps(worktree)];
  const impacts = [];
  for (const file of indexedChanged.slice(0, 10)) {
    impacts.push(compactNestedImpactData((await impactQuery(session, { file }, { autoRefresh: false })).data));
  }
  const text = [
    freshnessBanner(freshness, refresh),
    `Changed files: ${changed.length}`,
    "",
    "Grouped impact:",
    ...formatDiffGroups(groups.slice(0, 20)),
    "",
    "Changed files:",
    ...changedEntries.slice(0, 30).map(formatChangedEntry),
    ...(changedSymbols.length > 0
      ? [
          "",
          "Changed symbols:",
          ...changedSymbols
            .slice(0, 30)
            .map((entry) => `- ${entry.symbol.qualifiedName} (${entry.symbol.kind}) at ${entry.symbol.path}:${entry.symbol.range?.startLine ?? 1} lines ${entry.changedLines.join(", ")}`)
        ]
      : []),
    ...(unindexedChanged.length > 0 ? ["", "Changed but not indexed:", ...unindexedChanged.slice(0, 20).map((file) => `- ${file}`)] : []),
    "",
    "Known gaps:",
    ...formatGaps(gaps),
    ...worktreeStateText(worktree),
    "",
    "Use codexa impact for individual files when this list is large."
  ].join("\n");
  return {
    freshness,
    refresh,
    text: limitText(text, 6000),
    data: {
      mode: "diff_impact",
      changedFiles: changed.slice(0, 120),
      changedEntries: changedEntries.slice(0, 120),
      changedSymbols: changedSymbols.slice(0, 80).map(compactChangedSymbol),
      indexedChanged: indexedChanged.slice(0, 120),
      unindexedChanged: unindexedChanged.slice(0, 80),
      worktree: compactWorktreeState(worktree),
      worktreeDegradationReasons: worktree.degradedReasons,
      groups: groups.slice(0, 20).map(compactDiffGroup),
      impacts,
      gaps
    }
  };
}

function compactImpactEntry(entry: ImpactEntry): { file: ReturnType<typeof compactFileFact>; reasons: string[]; depth: number; confidence: Confidence } {
  return {
    file: compactFileFact(entry.file),
    reasons: uniqueSorted(entry.reasons).slice(0, 12),
    depth: entry.depth,
    confidence: entry.confidence
  };
}

function compactNestedImpactData(data: unknown): unknown {
  if (!data || typeof data !== "object") {
    return data;
  }
  const record = data as Record<string, unknown>;
  return {
    target: record.target,
    changeType: record.changeType,
    depth: record.depth,
    readFirstFiles: Array.isArray(record.readFirstFiles) ? record.readFirstFiles.slice(0, 40) : undefined,
    selectedFiles: Array.isArray(record.selectedFiles) ? record.selectedFiles.slice(0, 40) : undefined,
    affectedFiles: Array.isArray(record.affectedFiles) ? record.affectedFiles.slice(0, 40) : undefined,
    tests: Array.isArray(record.tests) ? record.tests.slice(0, 20) : undefined,
    recipes: record.recipes,
    value: record.value,
    quality: record.quality,
    gaps: record.gaps
  };
}

export function impactSortScore(entry: { reasons: string[] }): number {
  const target = entry.reasons.some((reason) => reason === "target" || reason.startsWith("defines ")) ? 1000 : 0;
  return target;
}

export function evidenceTierForImpact(entry: ImpactEntry): EvidenceTier {
  if (entry.reasons.some((reason) => reason === "target" || reason.startsWith("defines "))) {
    return "authoritative";
  }
  return confidenceTier(entry.confidence);
}

export function tierImpactEntries(entries: ImpactEntry[]): Record<"authoritative" | "derived" | "heuristic", ImpactEntry[]> {
  const tiers: Record<"authoritative" | "derived" | "heuristic", ImpactEntry[]> = {
    authoritative: [],
    derived: [],
    heuristic: []
  };
  for (const entry of entries) {
    const tier = evidenceTierForImpact(entry);
    if (tier === "fallback") {
      continue;
    }
    tiers[tier].push(entry);
  }
  for (const values of Object.values(tiers)) {
    values.sort((a, b) => impactSortScore(b) - impactSortScore(a) || b.file.rank - a.file.rank || a.file.path.localeCompare(b.file.path));
  }
  return tiers;
}

export function formatTierEntries(entries: ImpactEntry[]): string[] {
  if (entries.length === 0) {
    return ["- none"];
  }
  return entries.map((entry) => `- ${entry.file.path}: ${formatReasons(entry.reasons, 5)}; depth ${entry.depth}; ${entry.confidence}`);
}

export function addTransitiveImpact(index: CodexaIndex, affected: Map<string, ImpactEntry>, maxDepth: number): void {
  const queue = [...affected.values()].map((entry) => ({ path: entry.file.path, depth: entry.depth }));
  const visited = new Set(queue.map((entry) => `${entry.path}:${entry.depth}`));
  const symbolsByPath = new Map<string, Set<string>>();
  const symbolsById = new Map(index.symbols.map((symbol) => [symbol.id, symbol]));
  for (const symbol of index.symbols) {
    const set = symbolsByPath.get(symbol.path) ?? new Set<string>();
    set.add(symbol.id);
    symbolsByPath.set(symbol.path, set);
  }
  const importsByResolvedPath = groupBy(index.imports.filter((edge) => edge.resolvedPath), (edge) => edge.resolvedPath ?? "");
  const testsByTargetPath = groupBy(
    index.testEdges.filter((edge) => edge.targetPath),
    (edge) => edge.targetPath ?? ""
  );
  const impactGraphEdges = index.graphEdges.filter((edge) => isImpactGraphEdge(edge.edgeKind));
  const graphEdgesByToPath = groupBy(
    impactGraphEdges.filter((edge) => edge.toPath),
    (edge) => edge.toPath ?? ""
  );
  const graphEdgesByToSymbolId = groupBy(
    impactGraphEdges.filter((edge) => edge.toSymbolId),
    (edge) => edge.toSymbolId ?? ""
  );
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const current = queue[cursor];
    if (current.depth >= maxDepth) {
      continue;
    }
    const nextDepth = current.depth + 1;
    const currentSymbolIds = symbolsByPath.get(current.path) ?? new Set<string>();
    const graphEdges = uniqueGraphEdges([
      ...(graphEdgesByToPath.get(current.path) ?? []),
      ...[...currentSymbolIds].flatMap((symbolId) => graphEdgesByToSymbolId.get(symbolId) ?? [])
    ]);
    const downstream = [
      ...(importsByResolvedPath.get(current.path) ?? [])
        .map((edge) => ({ path: edge.path, reason: `imports ${current.path} via depth ${nextDepth}`, confidence: "authoritative" as Confidence })),
      ...(testsByTargetPath.get(current.path) ?? [])
        .map((edge) => ({ path: edge.path, reason: `tests ${current.path} via depth ${nextDepth}`, confidence: edge.confidence })),
      ...graphEdges
        .map((edge) => graphEdgeToImpactCandidate(edge, symbolsById, current.path, nextDepth))
        .filter((edge): edge is { path: string; reason: string; confidence: Confidence } => Boolean(edge))
    ];
    for (const edge of downstream) {
      const file = findFile(index, edge.path);
      if (!file) {
        continue;
      }
      const existing = affected.get(file.path);
      if (existing) {
        existing.reasons.push(edge.reason);
        existing.depth = Math.min(existing.depth, nextDepth);
        existing.confidence = mergeConfidence(existing.confidence, edge.confidence);
      } else {
        affected.set(file.path, { file, reasons: [edge.reason], depth: nextDepth, confidence: edge.confidence });
      }
      const key = `${file.path}:${nextDepth}`;
      if (!visited.has(key)) {
        visited.add(key);
        queue.push({ path: file.path, depth: nextDepth });
      }
    }
  }
}

export function verificationRecipes(index: CodexaIndex, paths: string[], changeType: ChangeType): string[] {
  const recipes = new Set<string>();
  const files = paths
    .map((filePath) => findFile(index, filePath) ?? ({ path: filePath, language: languageForPath(filePath), test: isTestPath(filePath), riskScore: 0 } as FileFact))
    .filter(Boolean);
  const hasPython = files.some((file) => file.language === "python");
  const hasFrontend = files.some((file) => file.path.startsWith("web/src") || file.language === "typescript" || file.language === "javascript");
  const hasManifest = files.some((file) => file.path.endsWith(".json"));
  const hasAdapter = files.some((file) => /(^|\/)adapters\/.+\.py$/.test(file.path) || file.path.includes("adapter"));
  const hasRoute = files.some((file) => index.symbols.some((symbol) => symbol.path === file.path && symbol.kind === "route"));
  const hasOperator = files.some((file) => /\.(sh|service)$/.test(file.path) || file.path.startsWith("scripts/"));

  if (hasPython) {
    recipes.add("Run targeted pytest for linked tests; if no test command is emitted, inspect pyproject/pytest metadata before guessing.");
  }
  if (hasFrontend) {
    recipes.add("Run the nearest Vitest/TypeScript check for touched frontend files and read importers before API-shaped edits.");
  }
  if (hasManifest) {
    recipes.add("Validate package manifest loading and node type references across runtime registry and frontend definitions.");
  }
  if (hasAdapter) {
    recipes.add("Exercise adapter contract tests or at least import/load the adapter package after changes.");
  }
  if (hasRoute) {
    recipes.add("Verify API route behavior through route-level tests or a minimal request path, not just helper unit tests.");
  }
  if (hasOperator) {
    recipes.add("Run shell syntax checks or service dry-run validation before touching operator scripts or units.");
  }
  if (changeType === "api" || changeType === "rename" || changeType === "delete") {
    recipes.add("Widen verification to importers, public exports, and type/import checks because the change can break callers without local failures.");
  }
  if (changeType === "style") {
    recipes.add("Keep verification narrow unless style/class changes alter component props, DOM structure, or generated output.");
  }
  return [...recipes].sort();
}

export function addContextPackImpactExpansion(
  index: CodexaIndex,
  seeds: Map<string, string>,
  changeType: ChangeType,
  limit: number,
  addFocus: (filePath: string, reason: string, rank?: number, tier?: EvidenceTier, source?: "graph_impact") => void
): void {
  if (seeds.size === 0) {
    return;
  }
  const depth = changeType === "api" || changeType === "rename" || changeType === "delete" ? 2 : 1;
  const perSeedLimit = changeType === "style" ? 6 : changeType === "api" || changeType === "rename" || changeType === "delete" ? 14 : 10;
  const orderedSeeds = [...seeds.entries()]
    .map(([filePath, reason]) => ({ file: findFile(index, filePath), filePath, reason }))
    .filter((entry): entry is { file: FileFact; filePath: string; reason: string } => Boolean(entry.file))
    .sort((a, b) => b.file.rank - a.file.rank || a.file.path.localeCompare(b.file.path))
    .slice(0, Math.max(4, Math.min(10, limit)));

  for (const seed of orderedSeeds) {
    const entries = impactEntriesForFile(index, seed.file.path, depth)
      .filter((entry) => entry.file.path !== seed.file.path)
      .sort(
        (a, b) =>
          tierScore(evidenceTierForImpact(a)) - tierScore(evidenceTierForImpact(b)) ||
          impactSortScore(b) - impactSortScore(a) ||
          b.file.riskScore - a.file.riskScore ||
          b.file.rank - a.file.rank ||
          a.file.path.localeCompare(b.file.path)
      )
      .slice(0, perSeedLimit);
    for (const entry of entries) {
      const tier = evidenceTierForImpact(entry);
      const rank = tier === "authoritative" ? 10 : tier === "derived" ? 6 : 3;
      addFocus(entry.file.path, `impact from ${seed.reason}: ${formatReasons(entry.reasons, 3)}`, rank, tier, "graph_impact");
    }
  }
}

export function impactEntriesForFile(index: CodexaIndex, filePath: string, maxDepth: number): ImpactEntry[] {
  const file = findFile(index, filePath);
  if (!file) {
    return [];
  }
  const affectedFiles = new Map<string, ImpactEntry>();
  const add = (candidatePath: string, reason: string, depth = 0, confidence: Confidence = "derived") => {
    const candidate = findFile(index, candidatePath);
    if (!candidate) {
      return;
    }
    const existing = affectedFiles.get(candidate.path) ?? { file: candidate, reasons: [], depth, confidence };
    existing.reasons.push(reason);
    existing.depth = Math.min(existing.depth, depth);
    existing.confidence = mergeConfidence(existing.confidence, confidence);
    affectedFiles.set(candidate.path, existing);
  };

  add(file.path, "target", 0, "authoritative");
  for (const imp of index.imports.filter((edge) => edge.resolvedPath === file.path)) {
    add(imp.path, `imports ${file.path}`, 1, "authoritative");
  }
  const definedSymbolIds = new Set(index.symbols.filter((symbol) => symbol.path === file.path).map((symbol) => symbol.id));
  for (const usage of index.usageSites.filter((site) => site.targetSymbolId && definedSymbolIds.has(site.targetSymbolId))) {
    if (usage.path !== file.path) {
      add(usage.path, `${usage.kind} ${usage.name} (${usage.confidence})`, 1, usage.confidence);
    }
  }
  for (const test of index.testEdges.filter((edge) => edge.targetPath === file.path)) {
    add(test.path, `tests ${file.path}`, 1, test.confidence);
  }
  addTransitiveImpact(index, affectedFiles, maxDepth);
  return [...affectedFiles.values()];
}

function addRecommendedTestsToImpact(index: CodexaIndex, affectedFiles: Map<string, ImpactEntry>, sourcePaths: string[], repoRoot: string, depth: number): void {
  for (const test of recommendTests(index, sourcePaths, repoRoot).slice(0, 8)) {
    const file = findFile(index, test.path);
    if (!file) {
      continue;
    }
    const confidence: Confidence = test.evidenceTier === "authoritative" ? "authoritative" : test.evidenceTier === "derived" ? "derived" : "heuristic";
    const existing = affectedFiles.get(file.path);
    const reason = `recommended test ${test.reason}`;
    if (existing) {
      existing.reasons.push(reason);
      existing.depth = Math.min(existing.depth, depth);
      existing.confidence = mergeConfidence(existing.confidence, confidence);
    } else {
      affectedFiles.set(file.path, { file, reasons: [reason], depth, confidence });
    }
  }
}

function summarizeFanout(entries: ImpactEntry[], changeType: ChangeType): { summary: string; readFirst: ImpactEntry[]; collapsed: ImpactEntry[] } {
  const targets = entries.filter((entry) => entry.reasons.some((reason) => reason === "target" || reason.startsWith("defines ")));
  const tests = entries.filter((entry) => entry.file.test);
  const highRisk = entries
    .filter((entry) => !entry.file.test && !targets.includes(entry))
    .sort((a, b) => tierScore(evidenceTierForImpact(a)) - tierScore(evidenceTierForImpact(b)) || b.file.riskScore - a.file.riskScore || b.file.rank - a.file.rank || a.file.path.localeCompare(b.file.path));
  const breadthLimit = changeType === "style" ? 8 : changeType === "api" || changeType === "rename" || changeType === "delete" ? 24 : 14;
  const seed = [
    ...targets,
    ...tests.slice(0, changeType === "style" ? 3 : 6),
    ...highRisk.slice(0, Math.max(0, breadthLimit - targets.length - Math.min(tests.length, changeType === "style" ? 3 : 6)))
  ];
  const readFirst = uniqueEntries(seed).slice(0, breadthLimit);
  const readSet = new Set(readFirst.map((entry) => entry.file.path));
  const collapsed = entries.filter((entry) => !readSet.has(entry.file.path));
  const summary =
    changeType === "style"
      ? `Fanout: ${entries.length} affected files. Style-mode collapses repeated consumers; inspect public API consumers only if styling changes component contract.`
      : changeType === "api" || changeType === "rename" || changeType === "delete"
        ? `Fanout: ${entries.length} affected files. ${changeType}-mode keeps broader importer/test coverage because public contracts may break.`
        : `Fanout: ${entries.length} affected files. Balanced mode shows target, tests, high-risk consumers, and collapses lower-risk repetition.`;
  return { summary, readFirst, collapsed };
}

function groupBy<T>(items: T[], keyForItem: (item: T) => string): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const item of items) {
    const key = keyForItem(item);
    const list = grouped.get(key) ?? [];
    list.push(item);
    grouped.set(key, list);
  }
  return grouped;
}

function uniqueGraphEdges(edges: GraphEdgeFact[]): GraphEdgeFact[] {
  const seen = new Set<string>();
  const result: GraphEdgeFact[] = [];
  for (const edge of edges) {
    if (!seen.has(edge.id)) {
      seen.add(edge.id);
      result.push(edge);
    }
  }
  return result.sort(graphEdgeSort);
}

function graphEdgeToImpactCandidate(
  edge: GraphEdgeFact,
  symbolsById: Map<string, SymbolFact>,
  currentPath: string,
  nextDepth: number
): { path: string; reason: string; confidence: Confidence } | undefined {
  const fromPath = edge.fromPath ?? (edge.fromSymbolId ? symbolsById.get(edge.fromSymbolId)?.path : undefined);
  if (!fromPath) {
    return undefined;
  }
  return {
    path: fromPath,
    reason: `${edge.edgeKind.toLowerCase()} ${currentPath} via graph depth ${nextDepth}`,
    confidence: edge.confidence
  };
}

function mergeConfidence(a: Confidence, b: Confidence): Confidence {
  if (a === "authoritative" || b === "authoritative") return "authoritative";
  if (a === "derived" || b === "derived") return "derived";
  return "heuristic";
}

function uniqueEntries(entries: ImpactEntry[]): ImpactEntry[] {
  const seen = new Set<string>();
  const result: ImpactEntry[] = [];
  for (const entry of entries) {
    if (!seen.has(entry.file.path)) {
      seen.add(entry.file.path);
      result.push(entry);
    }
  }
  return result;
}
