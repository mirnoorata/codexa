import path from "node:path";
import { indexGaps, formatGaps } from "./diff.js";
import { confidenceTier, tierScore, clampInt, fitLinesToTokenBudget } from "./formatting.js";
import { assessContextQuality, formatContextQuality, formatValueEstimate, valueEstimate } from "./quality.js";
import { baselineSearchSummary, rawSearch } from "./raw-search.js";
import { freshnessBanner } from "./runtime.js";
import { ensureQuerySession, type QuerySessionInput } from "./session.js";
import { formatTestRecommendations, recommendTests } from "./tests.js";
import { findFile } from "./targets.js";
import { retrieveForTask } from "../retrieval.js";
import type { CodexaIndex, FileFact, QueryOptions, QueryResult, SymbolFact, UsageSiteFact } from "../types.js";
import { limitText, uniqueSorted } from "../util.js";

interface RankedSearchResult {
  files: FileFact[];
  symbols: SymbolFact[];
  usageSites: UsageSiteFact[];
  exactTargets: FileFact[];
  reasons: Map<string, string[]>;
}

export async function repoMapQuery(input: QuerySessionInput, limit = 20, options: QueryOptions = {}, tokenBudget = 1500): Promise<QueryResult> {
  const session = await ensureQuerySession(input, options);
  const { index, freshness, refresh } = session;
  const budget = clampInt(tokenBudget, 400, 8000);
  const files = index.files.slice(0, limit);
  const modules = index.modules.slice(0, Math.min(10, limit));
  const symbolsByFile = new Map(
    files.map((file) => [
      file.path,
      index.symbols
        .filter((symbol) => symbol.path === file.path && (symbol.exported || symbol.kind === "route" || symbol.kind === "test" || symbol.kind === "node"))
        .sort((a, b) => tierScore(confidenceTier(a.confidence)) - tierScore(confidenceTier(b.confidence)) || (a.range?.startLine ?? 0) - (b.range?.startLine ?? 0))
        .slice(0, 3)
    ])
  );
  const quality = assessContextQuality({
    freshness,
    gaps: indexGaps(index, freshness),
    tiers: { authoritative: files.length, derived: 0, heuristic: index.parserErrors.length > 0 ? 1 : 0, fallback: 0 },
    selectedCount: files.length
  });
  const lines = [
    freshnessBanner(freshness, refresh),
    `Budget: ${budget} tokens approx; files: ${files.length}`,
    formatContextQuality(quality),
    "",
    "Top modules:",
    ...modules.map((mod) => `- ${mod.name}: ${mod.files.length} files, rank ${mod.rank.toFixed(2)}`),
    "",
    "Read first:",
    ...files.flatMap((file) => {
      const symbols = symbolsByFile.get(file.path) ?? [];
      const symbolSuffix = symbols.length > 0 ? `; symbols ${symbols.map((symbol) => `${symbol.qualifiedName}:${symbol.range?.startLine ?? 1}`).join(", ")}` : "";
      return [`- ${file.path}: rank ${file.rank.toFixed(2)}, risk ${file.riskScore.toFixed(1)}, ${file.language}${symbolSuffix}`];
    })
  ];
  return { freshness, refresh, text: fitLinesToTokenBudget(lines, budget), data: { modules, files, symbolsByFile: Object.fromEntries(symbolsByFile), quality } };
}

export async function findContextQuery(input: QuerySessionInput, query: string, limit = 12, options: QueryOptions = {}): Promise<QueryResult> {
  const session = await ensureQuerySession(input, options);
  const { index, freshness, refresh } = session;
  const needle = query.toLowerCase();
  const retrieval = retrieveForTask(index, query, limit);
  const symbolHits = index.symbols
    .filter((symbol) => [symbol.name, symbol.qualifiedName, symbol.path].some((value) => value.toLowerCase().includes(needle)))
    .slice(0, limit);
  const usageHits = index.usageSites
    .filter((usage) => [usage.name, usage.text, usage.path].some((value) => value.toLowerCase().includes(needle)))
    .slice(0, limit);
  const fileHits = uniqueFiles([...index.files.filter((file) => file.path.toLowerCase().includes(needle)), ...retrieval.matches.map((match) => match.file)]).slice(0, limit);
  const text = [
    freshnessBanner(freshness, refresh),
    `Context matches for "${query}":`,
    ...fileHits.map((file) => `- file ${file.path} rank ${file.rank.toFixed(2)}`),
    ...symbolHits.map((symbol) => `- symbol ${symbol.qualifiedName} (${symbol.kind}) at ${symbol.path}:${symbol.range?.startLine ?? 1}`),
    ...usageHits.map((usage) => `- usage ${usage.name} (${usage.kind}, ${usage.confidence}) at ${usage.path}:${usage.range?.startLine ?? 1}`),
    "",
    "Natural-language retrieval:",
    ...retrieval.matches.slice(0, limit).map((match) => `- ${match.file.path}: score ${match.score.toFixed(2)}; ${match.reasons.join("; ")}`)
  ].join("\n");
  return { freshness, refresh, text: limitText(text, 5000), data: { files: fileHits, symbols: symbolHits, usageSites: usageHits, retrieval } };
}

export async function searchQuery(
  input: QuerySessionInput,
  queryInput: { query: string; limit?: number; includeRaw?: boolean },
  options: QueryOptions = {}
): Promise<QueryResult> {
  const session = await ensureQuerySession(input, options);
  const { index, freshness, refresh, repoRoot } = session;
  const limit = clampInt(queryInput.limit ?? 12, 1, session.maxResults);
  const raw = await rawSearch(repoRoot, queryInput.query, Math.max(limit * 4, 20));
  const interpreted = rankedSearch(index, queryInput.query, limit);
  const retrieval = retrieveForTask(index, queryInput.query, Math.max(limit * 2, 12));
  const rawIndexedFiles = raw.files.map((filePath) => findFile(index, filePath)).filter((file): file is FileFact => Boolean(file));
  for (const file of rawIndexedFiles) {
    const existing = interpreted.reasons.get(file.path) ?? [];
    existing.unshift("raw exact hit");
    interpreted.reasons.set(file.path, existing);
  }
  for (const match of retrieval.matches) {
    const existing = interpreted.reasons.get(match.file.path) ?? [];
    existing.push(`BM25 task retrieval ${match.matchedTerms.slice(0, 5).join(", ") || "intent"}`);
    interpreted.reasons.set(match.file.path, existing);
  }
  const searchFiles = uniqueFiles(
    raw.sufficient
      ? [...rawIndexedFiles, ...interpreted.exactTargets]
      : [...interpreted.files, ...rawIndexedFiles, ...retrieval.matches.map((match) => match.file)]
  ).slice(0, limit);
  const tests = recommendTests(index, searchFiles.map((file) => file.path), repoRoot).slice(0, 10);
  const rawFileCount = raw.files.length;
  const quality = assessContextQuality({
    freshness,
    gaps: indexGaps(index, freshness),
    tiers: {
      authoritative: rawIndexedFiles.length,
      derived: interpreted.exactTargets.filter((file) => searchFiles.some((candidate) => candidate.path === file.path)).length,
      heuristic: Math.max(0, searchFiles.length - rawIndexedFiles.length - interpreted.exactTargets.length),
      fallback: 0
    },
    selectedCount: searchFiles.length,
    rawSufficient: raw.sufficient,
    queryBroad: retrieval.broad,
    testCount: tests.length
  });
  const value = valueEstimate("search", {
    rawFileCount,
    codexaFileCount: searchFiles.length,
    exactTargetCount: Math.max(interpreted.exactTargets.length, rawIndexedFiles.length),
    testCount: tests.length,
    parserErrors: index.parserErrors.length,
    quality
  });
  const text = [
    freshnessBanner(freshness, refresh),
    formatContextQuality(quality),
    formatValueEstimate(value),
    `Search: ${queryInput.query}`,
    raw.sufficient ? "Raw exact search looks sufficient. Prefer direct source reading unless you need impact/tests." : "Codexa adds ranking, target guesses, tests, or gap labels beyond raw search.",
    "",
    "Raw hits:",
    ...(queryInput.includeRaw ?? true
      ? raw.hits.slice(0, limit).map((hit) => `- ${hit.path}:${hit.line} ${hit.text}`)
      : raw.files.slice(0, limit).map((file) => `- ${file}`)),
    "",
    "Codexa target guesses:",
    ...searchFiles.map((file) => `- ${file.path}: rank ${file.rank.toFixed(2)}; ${interpreted.reasons.get(file.path)?.join("; ") ?? "match"}`),
    "",
    "Likely tests:",
    ...formatTestRecommendations(tests),
    "",
    "Known gaps:",
    ...formatGaps(indexGaps(index, freshness))
  ].join("\n");
  return {
    freshness,
    refresh,
    text: limitText(text, Math.min(6000, session.maxResultBytes)),
    data: {
      query: queryInput.query,
      raw,
      files: searchFiles,
      symbols: interpreted.symbols,
      usageSites: interpreted.usageSites,
      retrieval,
      tests,
      value,
      quality,
      gaps: indexGaps(index, freshness),
      session: { warnings: session.warnings, provenance: session.provenance }
    }
  };
}

export function rankedSearch(index: CodexaIndex, query: string, limit: number): RankedSearchResult {
  const scores = new Map<string, number>();
  const reasons = new Map<string, string[]>();
  const symbolHits: Array<{ symbol: SymbolFact; score: number }> = [];
  const usageHits: Array<{ usage: UsageSiteFact; score: number }> = [];
  const addScore = (filePath: string, reason: string, score: number) => {
    const file = findFile(index, filePath);
    if (!file || score <= 0) {
      return;
    }
    scores.set(file.path, (scores.get(file.path) ?? 0) + score);
    const existing = reasons.get(file.path) ?? [];
    existing.push(reason);
    reasons.set(file.path, existing);
  };

  for (const file of index.files) {
    const score = Math.max(matchScore(query, file.path), matchScore(query, path.posix.basename(file.path)));
    addScore(file.path, `file ${matchReason(score)}`, score);
  }

  for (const symbol of index.symbols) {
    const score = Math.max(matchScore(query, symbol.name), matchScore(query, symbol.qualifiedName), matchScore(query, symbol.path));
    if (score > 0) {
      symbolHits.push({ symbol, score });
      addScore(symbol.path, `symbol ${matchReason(score)} ${symbol.qualifiedName}`, score + (score >= 9 ? 20 : 0) + (symbol.exported ? 2 : 0));
    }
  }

  for (const usage of index.usageSites) {
    const score = Math.max(matchScore(query, usage.name), matchScore(query, usage.text), matchScore(query, usage.path));
    if (score > 0) {
      usageHits.push({ usage, score });
      addScore(usage.path, `usage ${matchReason(score)} ${usage.name} (${usage.confidence})`, Math.max(1, score - 1));
    }
  }

  const files = [...scores.entries()]
    .map(([filePath, score]) => ({ file: findFile(index, filePath), score }))
    .filter((entry): entry is { file: FileFact; score: number } => Boolean(entry.file))
    .sort((a, b) => b.score - a.score || b.file.rank - a.file.rank || a.file.path.localeCompare(b.file.path))
    .slice(0, limit)
    .map((entry) => entry.file);
  const symbols = symbolHits
    .sort(
      (a, b) =>
        b.score - a.score ||
        (findFile(index, b.symbol.path)?.rank ?? 0) - (findFile(index, a.symbol.path)?.rank ?? 0) ||
        a.symbol.qualifiedName.localeCompare(b.symbol.qualifiedName)
    )
    .slice(0, limit)
    .map((entry) => entry.symbol);
  const usageSites = usageHits
    .sort(
      (a, b) =>
        b.score - a.score ||
        (findFile(index, b.usage.path)?.rank ?? 0) - (findFile(index, a.usage.path)?.rank ?? 0) ||
        a.usage.path.localeCompare(b.usage.path)
    )
    .slice(0, limit)
    .map((entry) => entry.usage);
  const exactTargets = files.filter((file) => (reasons.get(file.path) ?? []).some((reason) => reason.includes("exact") || reason.includes("stem")));
  return { files, symbols, usageSites, exactTargets, reasons };
}

export function matchScore(query: string, value: string): number {
  const q = normalizeSearchText(query);
  const v = normalizeSearchText(value);
  if (!q || !v) {
    return 0;
  }
  const decoyPattern = /(?:^|\b|[._/-])(decoy|mock|old|backup|copy|fixture)(?:$|\b|[._/-])/;
  const compactDecoyPattern = /(decoy|mock|backup|fixture)/;
  const spacedValue = v.replace(/[_-]/g, " ");
  const spacedQuery = q.replace(/[_-]/g, " ");
  const compactValue = v.replace(/[^a-z0-9]+/g, "");
  const compactQuery = q.replace(/[^a-z0-9]+/g, "");
  const decoyish = decoyPattern.test(spacedValue) || compactDecoyPattern.test(compactValue);
  const queryAllowsDecoy = decoyPattern.test(spacedQuery) || compactDecoyPattern.test(compactQuery);
  const terms = uniqueSorted([q, ...queryTerms(query)]);
  let best = 0;
  const basenameStem = path.posix.basename(v).replace(/\.[^.]+$/, "");
  const valueTokens = tokenSet(value);
  for (const term of terms) {
    if (!term) {
      continue;
    }
    if (v === term) {
      best = Math.max(best, 10);
    } else if (basenameStem === term) {
      best = Math.max(best, 9);
    } else if (valueTokens.has(term)) {
      best = Math.max(best, 6);
    } else if (v.includes(term)) {
      best = Math.max(best, 2);
    }
  }
  if (decoyish && !queryAllowsDecoy && best < 9) {
    return 0;
  }
  return best;
}

export function matchReason(score: number): string {
  if (score >= 10) return "exact";
  if (score >= 9) return "stem";
  if (score >= 6) return "token";
  if (score > 0) return "substring";
  return "miss";
}

function queryTerms(query: string): string[] {
  return query
    .split(/[^A-Za-z0-9_./@-]+/)
    .map(normalizeSearchText)
    .filter((term) => term.length >= 2)
    .flatMap((term) => {
      const pathParts = term.includes("/") || term.includes(".") || term.includes("@") ? term.split(/[./@-]+/).filter((part) => part.length >= 2) : [];
      return [term, ...pathParts];
    });
}

function tokenSet(value: string): Set<string> {
  return new Set(
    normalizeSearchText(value)
      .split(/[^a-z0-9]+/)
      .filter(Boolean)
  );
}

export function normalizeSearchText(value: string): string {
  return value.trim().toLowerCase();
}

export function uniqueFiles(files: FileFact[]): FileFact[] {
  const seen = new Set<string>();
  const result: FileFact[] = [];
  for (const file of files) {
    if (!seen.has(file.path)) {
      seen.add(file.path);
      result.push(file);
    }
  }
  return result;
}

export function codeLikeQueryFromTask(task?: string): string {
  if (!task) {
    return "";
  }
  const stopWords = new Set([
    "add",
    "and",
    "project",
    "change",
    "choose",
    "codex",
    "current",
    "debug",
    "diff",
    "dirty",
    "edit",
    "fix",
    "focused",
    "make",
    "safe",
    "safely",
    "test",
    "the",
    "this",
    "update",
    "verify",
    "verification"
  ]);
  const terms = task
    .split(/[^A-Za-z0-9_./@:-]+/)
    .map((term) => term.trim().replace(/^[./@:-]+|[./@:-]+$/g, ""))
    .filter((term) => {
      if (term.length < 3) {
        return false;
      }
      const lower = term.toLowerCase();
      if (stopWords.has(lower)) {
        return false;
      }
      return /[._/@:-]/.test(term) || /[a-z][A-Z]/.test(term) || /[A-Z].*\d|\d.*[A-Z]/.test(term) || /^[A-Z0-9]{3,}$/.test(term);
    })
    .sort((a, b) => b.length - a.length || a.localeCompare(b));
  return uniqueSorted(terms).slice(0, 4).join(" ");
}

export function fileStemQueryTerms(stem: string): string[] {
  const normalized = stem.trim();
  if (!normalized) {
    return [];
  }
  const camel = normalized.replace(/[-_]+([A-Za-z0-9])/g, (_, char: string) => char.toUpperCase());
  return uniqueSorted([normalized, camel]);
}
