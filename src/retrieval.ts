import path from "node:path";
import { isTestPath, moduleNameForPath } from "./language.js";
import { semanticLaneEntriesForQuery, type SemanticQueryOptions, type SemanticRetrievalSummary } from "./semantic-retrieval.js";
import type { CodexaIndex, Confidence, FileFact, GraphEdgeFact, ModuleClusterFact, SymbolFact, WorkflowTraceFact } from "./types.js";
import { rankLog2, uniqueSorted } from "./util.js";

export type TaskIntent =
  | "architecture"
  | "workflow"
  | "debugging"
  | "testing"
  | "frontend"
  | "backend"
  | "configuration"
  | "risk"
  | "implementation"
  | "unknown";

export type RetrievalLane = "exact" | "symbol" | "bm25" | "semantic" | "graph" | "workflow" | "test" | "dirty";
export type PromptMode = "orientation" | "edit";
export type PacketVerdict = "edit-ready" | "orientation-only" | "needs-target" | "raw-search-better";

export interface IntentConfidence {
  mode: PromptMode;
  intent: TaskIntent;
  confidence: number;
  anchors: string[];
  selectedAnchorCount?: number;
  discardedAnchorCount?: number;
  missingAnchors: string[];
  recommendedNextTool: string;
  editReady: boolean;
  verdict: PacketVerdict;
  reasons: string[];
}

export interface RetrievalMatch {
  file: FileFact;
  score: number;
  reasons: string[];
  matchedTerms: string[];
  lanes: Partial<Record<RetrievalLane, number>>;
}

export interface RetrievalAnchor {
  kind: "symbol" | "file";
  label: string;
  path: string;
  line?: number;
  symbolId?: string;
  score: number;
  lanes: RetrievalLane[];
  confidence: Confidence;
  reasons: string[];
}

export interface RetrievalProcessGroup {
  workflowId: string;
  title: string;
  workflowKind: WorkflowTraceFact["workflowKind"];
  processKind?: WorkflowTraceFact["processKind"];
  score: number;
  normalizedScore: number;
  entryPath: string;
  entryScore?: number;
  matchedFiles: string[];
  terminalFiles: string[];
  tests: string[];
  reasons: string[];
  confidence: Confidence;
}

export interface RetrievalClusterGroup {
  name: string;
  clusterKind?: ModuleClusterFact["clusterKind"];
  score: number;
  rank: number;
  summary: string;
  matchedFiles: string[];
  topFiles: string[];
  topSymbols: string[];
  workflows: string[];
  tests: string[];
  risks: string[];
  relationCount?: number;
  crossModuleRelationCount?: number;
  confidence: Confidence;
  reasons: string[];
}

export interface RetrievalResult {
  query: string;
  intents: TaskIntent[];
  terms: string[];
  matches: RetrievalMatch[];
  workflows: WorkflowTraceFact[];
  modules: Array<{ name: string; score: number; files: string[]; reasons: string[] }>;
  anchors: RetrievalAnchor[];
  processGroups: RetrievalProcessGroup[];
  clusterGroups: RetrievalClusterGroup[];
  broad: boolean;
  intentConfidence: IntentConfidence;
  diagnostics: string[];
  semantic: SemanticRetrievalSummary;
}

interface Document {
  file: FileFact;
  terms: string[];
  termCounts: Map<string, number>;
  reasonsByTerm: Map<string, Set<string>>;
  length: number;
}

interface LaneEntry {
  file: FileFact;
  score: number;
  reasons: string[];
  matchedTerms: string[];
}

interface RetrievalRuntime {
  docs: Document[];
  docFreq: Map<string, number>;
  avgLength: number;
  fileByPath: Map<string, FileFact>;
}

const STOP_WORDS = new Set([
  "a",
  "about",
  "all",
  "an",
  "and",
  "any",
  "are",
  "as",
  "at",
  "be",
  "by",
  "can",
  "code",
  "codex",
  "codexa",
  "does",
  "for",
  "from",
  "get",
  "how",
  "i",
  "in",
  "into",
  "is",
  "it",
  "make",
  "of",
  "on",
  "or",
  "project",
  "safe",
  "safely",
  "should",
  "system",
  "that",
  "the",
  "this",
  "to",
  "update",
  "use",
  "what",
  "when",
  "where",
  "why",
  "with",
  "work",
  "works"
]);

const SYNONYMS: Record<string, string[]> = {
  api: ["route", "router", "endpoint", "handler", "server", "app"],
  architecture: ["module", "indexer", "parser", "resolver", "query", "mcp", "graph", "workflow", "artifact"],
  project: ["adapter", "package", "manifest", "node", "workflow", "queue", "run"],
  automatic: ["init", "session", "hook", "config", "mcp"],
  backend: ["api", "route", "server", "python", "adapter", "store"],
  brief: ["task", "context", "pack", "query"],
  caller: ["call", "usage", "import", "reference"],
  change: ["impact", "diff", "risk"],
  dependency: ["import", "edge", "graph", "resolver"],
  frontend: ["tsx", "react", "component", "hook", "web"],
  graph: ["edge", "dependency", "call", "import", "reference", "workflow"],
  mcp: ["server", "tool", "resource", "prompt", "stdio"],
  parser: ["tree", "sitter", "symbol", "import", "usage"],
  polling: ["poll", "run", "queue", "status", "hook"],
  queue: ["polling", "run", "status", "dashboard"],
  route: ["api", "handler", "router", "endpoint"],
  session: ["init", "hook", "focus", "config"],
  test: ["pytest", "vitest", "spec", "fixture", "coverage"],
  workflow: ["route", "job", "flow", "execution", "process", "adapter", "store"]
};

const BROAD_WORKFLOW_TERMS = new Set(["api", "app", "backend", "endpoint", "execution", "flow", "frontend", "handler", "path", "process", "route", "server", "workflow"]);
const SUPPORT_WORKFLOW_TERMS = new Set(["store", "stores", "test", "tests", "pytest", "vitest", "spec", "specs", "verification"]);
const LANE_WEIGHTS: Record<RetrievalLane, number> = {
  exact: 4,
  symbol: 3.2,
  bm25: 2,
  semantic: 2.6,
  graph: 0.65,
  workflow: 2.8,
  test: 2.5,
  dirty: 1.7
};
const SEMANTIC_ANCHOR_MIN_SCORE = 9;
const RETRIEVAL_RUNTIME_CACHE_LIMIT = 4;
const retrievalRuntimeCache = new Map<string, RetrievalRuntime>();

export async function retrieveForTask(index: CodexaIndex, query: string, limit = 12, semanticOptions?: SemanticQueryOptions): Promise<RetrievalResult> {
  const rawTerms = tokenize(query);
  const terms = expandedQueryTerms(query);
  const intents = classifyTaskIntent(query, terms);
  const allowDecoys = queryAllowsDecoy(query);
  const runtime = retrievalRuntimeForIndex(index);
  const bm25Entries = runtime.docs
    .map((doc) => scoreDocument(doc, terms, intents, runtime.docFreq, runtime.docs.length, runtime.avgLength))
    .filter((entry): entry is LaneEntry => entry !== null && entry.score > 0);
  const exactEntries = exactLaneEntries(index, query);
  const symbolEntries = symbolLaneEntries(index, query, runtime.fileByPath);
  const semanticResult = semanticOptions
    ? await semanticLaneEntriesForQuery(index, query, runtime.fileByPath, semanticOptions)
    : {
        entries: [],
        summary: { enabled: false, status: "disabled" as const, diagnostics: [] }
      };
  const preliminaryMatches = fuseLaneRankings(index, [
    ["exact", exactEntries],
    ["symbol", symbolEntries],
    ["bm25", bm25Entries],
    ["semantic", semanticResult.entries]
  ])
    .filter((match) => allowDecoys || !isDecoyLikePath(match.file.path))
    .slice(0, Math.max(limit * 2, 20));
  const workflows = rankWorkflows(index, terms, preliminaryMatches).slice(0, Math.max(3, Math.min(10, limit)));
  const workflowEntries = workflowLaneEntries(index, workflows, query, runtime.fileByPath);
  const testEntries = testLaneEntries(index, [...preliminaryMatches.map((match) => match.file.path), ...workflowEntries.map((entry) => entry.file.path)], workflows, query, runtime.fileByPath);
  const dirtyEntries = dirtyLaneEntries(index, intents);
  const graphEntries = graphLaneEntries(index, intents, [
    ...bm25Entries,
    ...exactEntries,
    ...symbolEntries,
    ...workflowEntries,
    ...testEntries,
    ...dirtyEntries
  ], runtime.fileByPath);
  const matches = fuseLaneRankings(index, [
    ["exact", exactEntries],
    ["symbol", symbolEntries],
    ["bm25", bm25Entries],
    ["semantic", semanticResult.entries],
    ["workflow", workflowEntries],
    ["test", testEntries],
    ["dirty", dirtyEntries],
    ["graph", graphEntries]
  ])
    .filter((match) => allowDecoys || !isDecoyLikePath(match.file.path))
    .slice(0, limit);
  const modules = rankModules(index, matches, terms).slice(0, Math.max(3, Math.min(8, limit)));
  const anchors = buildRetrievalAnchors(index, matches, query, Math.max(4, Math.min(12, limit)));
  const processGroups = buildProcessGroups(workflows, matches).slice(0, Math.max(3, Math.min(8, limit)));
  const clusterGroups = buildClusterGroups(index, modules, matches).slice(0, Math.max(3, Math.min(8, limit)));
  const broad = rawTerms.length <= 2 || intents.includes("architecture") || intents.includes("workflow");
  const intentConfidence = analyzeIntentConfidence(query, intents, terms, matches, workflows, broad);
  const diagnostics = uniqueSorted([...retrievalDiagnostics(index, matches, workflows, broad, intentConfidence), ...semanticResult.summary.diagnostics.map((diagnostic) => `semantic: ${diagnostic}`)]);
  return { query, intents, terms, matches, workflows, modules, anchors, processGroups, clusterGroups, broad, intentConfidence, diagnostics, semantic: semanticResult.summary };
}

function retrievalRuntimeForIndex(index: CodexaIndex): RetrievalRuntime {
  const key = [
    index.snapshot.snapshotId,
    index.freshness.indexedAt,
    index.files.length,
    index.symbols.length,
    index.usageSites.length,
    index.imports.length,
    index.risks.length,
    index.workflows.length
  ].join(":");
  const cached = retrievalRuntimeCache.get(key);
  if (cached) {
    retrievalRuntimeCache.delete(key);
    retrievalRuntimeCache.set(key, cached);
    return cached;
  }
  const docs = buildDocuments(index);
  const runtime: RetrievalRuntime = {
    docs,
    docFreq: documentFrequency(docs),
    avgLength: docs.length > 0 ? docs.reduce((sum, doc) => sum + doc.length, 0) / docs.length : 1,
    fileByPath: new Map(index.files.map((file) => [file.path, file]))
  };
  retrievalRuntimeCache.set(key, runtime);
  while (retrievalRuntimeCache.size > RETRIEVAL_RUNTIME_CACHE_LIMIT) {
    const oldestKey = retrievalRuntimeCache.keys().next().value;
    if (!oldestKey) {
      break;
    }
    retrievalRuntimeCache.delete(oldestKey);
  }
  return runtime;
}

export function classifyTaskIntent(query: string, terms = expandedQueryTerms(query)): TaskIntent[] {
  const joined = `${query.toLowerCase()} ${terms.join(" ")}`;
  const intents: TaskIntent[] = [];
  const add = (intent: TaskIntent, pattern: RegExp) => {
    if (pattern.test(joined)) {
      intents.push(intent);
    }
  };
  add("architecture", /\b(architecture|understand|overview|map|module|subsystem|competitor|sourcegraph|aider|deepwiki)\b/);
  add("workflow", /\b(workflow|flow|execution|route|endpoint|job|process|queue|polling)\b|\b(?:workflow|dependency|call|execution)\s+path\b/);
  add("debugging", /\b(debug|bug|fix|error|failure|broken|trace|root cause)\b/);
  add("testing", /\b(test|verify|validation|pytest|vitest|coverage|regression)\b/);
  add("frontend", /\b(frontend|react|tsx|component|hook|ui|canvas|web)\b/);
  add("backend", /\b(backend|api|python|server|adapter|store|database|route)\b/);
  add("configuration", /\b(config|env|service|script|deploy|package|manifest|init|hook|session)\b/);
  add("risk", /\b(risk|security|shell|filesystem|sql|danger|unsafe|blast)\b/);
  add("implementation", /\b(add|implement|change|update|refactor|rename|delete|modify)\b/);
  return intents.length > 0 ? uniqueInOrder(intents) : ["unknown"];
}

export function expandedQueryTerms(query: string): string[] {
  const raw = tokenize(query);
  const expanded: string[] = [];
  for (const term of raw) {
    expanded.push(term);
    for (const synonym of SYNONYMS[term] ?? []) {
      expanded.push(synonym);
    }
  }
  return uniqueSorted(expanded).slice(0, 40);
}

function buildDocuments(index: CodexaIndex): Document[] {
  const symbolsByPath = groupByPath(index.symbols);
  const usagesByPath = groupByPath(index.usageSites);
  const importsByPath = groupByPath(index.imports);
  const risksByPath = groupByPath(index.risks);
  return index.files.map((file) => {
    const reasonsByTerm = new Map<string, Set<string>>();
    const terms: string[] = [];
    const add = (value: string, reason: string, weight = 1) => {
      for (const term of tokenize(value)) {
        for (let i = 0; i < weight; i += 1) {
          terms.push(term);
        }
        const reasons = reasonsByTerm.get(term) ?? new Set<string>();
        reasons.add(reason);
        reasonsByTerm.set(term, reasons);
      }
    };
    add(file.path, "path", 3);
    add(moduleNameForPath(file.path), "module", 2);
    add(path.posix.basename(file.path).replace(/\.[^.]+$/, ""), "file stem", 3);
    add(file.language, "language");
    if (file.test) add("test spec verification", "test file", 2);
    if (file.dirty) add("dirty changed worktree", "dirty file", 2);
    for (const symbol of symbolsByPath.get(file.path) ?? []) {
      add(symbol.name, `symbol ${symbol.name}`, symbol.exported ? 3 : 2);
      add(symbol.qualifiedName, `symbol ${symbol.qualifiedName}`, symbol.exported ? 3 : 2);
      add(symbol.kind, `symbol kind ${symbol.kind}`, 2);
      if (symbol.decorators.length > 0) add(symbol.decorators.join(" "), `decorator ${symbol.name}`, 2);
    }
    for (const usage of (usagesByPath.get(file.path) ?? []).slice(0, 80)) {
      add(usage.name, `usage ${usage.name}`, usage.confidence === "authoritative" ? 2 : 1);
      add(usage.text, `usage text ${usage.name}`);
      add(usage.kind, `usage kind ${usage.kind}`);
    }
    for (const imp of importsByPath.get(file.path) ?? []) {
      add(imp.specifier, `import ${imp.specifier}`, 2);
      if (imp.importedName) add(imp.importedName, `imported ${imp.importedName}`);
      if (imp.localName) add(imp.localName, `local import ${imp.localName}`);
      if (imp.resolvedPath) add(imp.resolvedPath, `imports ${imp.resolvedPath}`);
    }
    for (const risk of risksByPath.get(file.path) ?? []) {
      add(risk.signal, `risk ${risk.signal}`, 2);
      add(risk.reason, `risk ${risk.signal}`);
    }
    const termCounts = new Map<string, number>();
    for (const term of terms) {
      termCounts.set(term, (termCounts.get(term) ?? 0) + 1);
    }
    return { file, terms, termCounts, reasonsByTerm, length: Math.max(1, terms.length) };
  });
}

function groupByPath<T extends { path: string }>(items: T[]): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const item of items) {
    const list = grouped.get(item.path) ?? [];
    list.push(item);
    grouped.set(item.path, list);
  }
  return grouped;
}

function scoreDocument(
  doc: Document,
  queryTerms: string[],
  intents: TaskIntent[],
  docFreq: Map<string, number>,
  docCount: number,
  avgLength: number
): LaneEntry | null {
  const k1 = 1.2;
  const b = 0.72;
  const matchedTerms: string[] = [];
  let score = 0;
  const reasons = new Set<string>();
  for (const term of queryTerms) {
    const tf = doc.termCounts.get(term) ?? 0;
    if (tf === 0) {
      continue;
    }
    matchedTerms.push(term);
    const df = docFreq.get(term) ?? 0;
    const idf = Math.log(1 + (docCount - df + 0.5) / (df + 0.5));
    score += idf * ((tf * (k1 + 1)) / (tf + k1 * (1 - b + b * (doc.length / avgLength))));
    for (const reason of doc.reasonsByTerm.get(term) ?? []) {
      reasons.add(reason);
    }
  }
  score += intentBoost(doc.file, intents);
  if (matchedTerms.length === 0) {
    return null;
  }
  score += rankLog2(doc.file.rank) * 0.25;
  return {
    file: doc.file,
    score,
    reasons: [...reasons].sort().slice(0, 8),
    matchedTerms: uniqueSorted(matchedTerms)
  };
}

function exactLaneEntries(index: CodexaIndex, query: string): LaneEntry[] {
  const entries: LaneEntry[] = [];
  for (const file of index.files) {
    const basename = path.posix.basename(file.path);
    const stem = basename.replace(/\.[^.]+$/, "");
    const score = Math.max(matchScore(query, file.path), matchScore(query, basename), matchScore(query, stem));
    if (score >= 6) {
      entries.push({ file, score: score + 8, reasons: [`exact file/path ${stem}`], matchedTerms: matchedQueryTerms(query, `${file.path} ${basename} ${stem}`) });
    }
  }
  return entries.sort(sortLaneEntry);
}

function symbolLaneEntries(index: CodexaIndex, query: string, fileByPath: Map<string, FileFact>): LaneEntry[] {
  const byPath = new Map<string, LaneEntry>();
  const add = (filePath: string, score: number, reason: string, haystack: string) => {
    const file = fileByPath.get(filePath);
    if (!file || score <= 0) {
      return;
    }
    const existing = byPath.get(file.path) ?? { file, score: 0, reasons: [], matchedTerms: [] };
    existing.score += score;
    existing.reasons.push(reason);
    existing.matchedTerms.push(...matchedQueryTerms(query, haystack));
    byPath.set(file.path, existing);
  };
  for (const symbol of index.symbols) {
    const haystack = `${symbol.name} ${symbol.qualifiedName} ${symbol.kind} ${symbol.decorators.join(" ")}`;
    const score = Math.max(matchScore(query, symbol.name), matchScore(query, symbol.qualifiedName), matchScore(query, symbol.path));
    if (score > 0) {
      add(symbol.path, score + (symbol.exported ? 4 : 1), `symbol ${symbol.qualifiedName}`, haystack);
    }
  }
  for (const edge of index.imports) {
    const haystack = `${edge.specifier} ${edge.importedName ?? ""} ${edge.localName ?? ""} ${edge.resolvedPath ?? ""}`;
    const score = Math.max(matchScore(query, edge.specifier), matchScore(query, edge.importedName ?? ""), matchScore(query, edge.localName ?? ""), matchScore(query, edge.resolvedPath ?? ""));
    if (score > 0) {
      add(edge.path, score + 1, `import ${edge.specifier}`, haystack);
    }
  }
  for (const usage of index.usageSites) {
    const haystack = `${usage.name} ${usage.kind} ${usage.text}`;
    const score = Math.max(matchScore(query, usage.name), matchScore(query, usage.text), matchScore(query, usage.path));
    add(usage.path, Math.max(0, score - 1), `usage ${usage.name}`, haystack);
  }
  return [...byPath.values()]
    .map((entry) => ({ ...entry, reasons: uniqueSorted(entry.reasons).slice(0, 8), matchedTerms: uniqueSorted(entry.matchedTerms) }))
    .sort(sortLaneEntry);
}

function workflowLaneEntries(index: CodexaIndex, workflows: WorkflowTraceFact[], query: string, fileByPath: Map<string, FileFact>): LaneEntry[] {
  const byPath = new Map<string, LaneEntry>();
  const add = (filePath: string | undefined, score: number, reason: string) => {
    if (!filePath) {
      return;
    }
    const file = fileByPath.get(filePath);
    if (!file) {
      return;
    }
    const existing = byPath.get(file.path) ?? { file, score: 0, reasons: [], matchedTerms: [] };
    existing.score += score;
    existing.reasons.push(reason);
    existing.matchedTerms.push(...matchedQueryTerms(query, `${file.path} ${reason}`));
    byPath.set(file.path, existing);
  };
  for (const workflow of workflows) {
    add(workflow.entryPath, 18 + workflow.rank * 0.1, `workflow entry ${workflow.title}`);
    for (const step of workflow.steps) {
      const score =
        step.kind === "entry"
          ? 18
          : step.kind === "ui"
            ? 18
            : step.kind === "endpoint"
              ? 16
              : step.kind === "store" || step.kind === "adapter" || step.kind === "manifest"
                ? 15
                : step.kind === "test"
                  ? 12
                  : 7;
      add(step.path, score, `workflow ${workflow.title}: ${step.kind}`);
      add(step.targetPath, Math.max(5, score - 4), `workflow ${workflow.title}: target ${step.kind}`);
    }
    for (const file of workflow.relatedFiles) {
      add(file, 7, `workflow related ${workflow.title}`);
    }
  }
  return [...byPath.values()]
    .map((entry) => ({ ...entry, reasons: uniqueSorted(entry.reasons).slice(0, 8), matchedTerms: uniqueSorted(entry.matchedTerms) }))
    .sort(sortLaneEntry);
}

function testLaneEntries(index: CodexaIndex, seedPaths: string[], workflows: WorkflowTraceFact[], query: string, fileByPath: Map<string, FileFact>): LaneEntry[] {
  const seeds = new Set(seedPaths);
  for (const workflow of workflows) {
    for (const file of workflow.relatedFiles) {
      seeds.add(file);
    }
    for (const step of workflow.steps) {
      seeds.add(step.path);
      if (step.targetPath) {
        seeds.add(step.targetPath);
      }
    }
  }
  const byPath = new Map<string, LaneEntry>();
  const add = (filePath: string, score: number, reason: string) => {
    const file = fileByPath.get(filePath);
    if (!file?.test && !isTestPath(filePath)) {
      return;
    }
    if (!file) {
      return;
    }
    const existing = byPath.get(file.path) ?? { file, score: 0, reasons: [], matchedTerms: [] };
    existing.score += score;
    existing.reasons.push(reason);
    existing.matchedTerms.push(...matchedQueryTerms(query, `${file.path} ${reason}`));
    byPath.set(file.path, existing);
  };
  for (const workflow of workflows) {
    for (const test of workflow.tests) {
      add(test, 22, `workflow test ${workflow.title}`);
    }
  }
  for (const edge of index.testEdges) {
    if (edge.targetPath && seeds.has(edge.targetPath)) {
      add(edge.path, edge.confidence === "authoritative" ? 20 : edge.confidence === "derived" ? 16 : 10, `covers ${edge.targetPath}`);
    }
  }
  for (const file of index.files.filter((candidate) => candidate.test)) {
    const score = Math.max(matchScore(query, file.path), matchScore(query, path.posix.basename(file.path)));
    if (score > 0) {
      add(file.path, score + 4, "test path matches query");
    }
  }
  return [...byPath.values()]
    .map((entry) => ({ ...entry, reasons: uniqueSorted(entry.reasons).slice(0, 8), matchedTerms: uniqueSorted(entry.matchedTerms) }))
    .sort(sortLaneEntry);
}

function dirtyLaneEntries(index: CodexaIndex, intents: TaskIntent[]): LaneEntry[] {
  if (!intents.some((intent) => intent === "implementation" || intent === "debugging" || intent === "testing")) {
    return [];
  }
  return index.files
    .filter((file) => file.dirty)
    .map((file) => ({ file, score: 8 + file.rank * 0.02, reasons: ["dirty file relevant to edit/debug/test task"], matchedTerms: ["dirty"] }))
    .sort(sortLaneEntry);
}

function graphLaneEntries(index: CodexaIndex, intents: TaskIntent[], anchoredEntries: LaneEntry[], fileByPath: Map<string, FileFact>): LaneEntry[] {
  const anchored = new Set(anchoredEntries.map((entry) => entry.file.path));
  const anchorScores = new Map<string, number>();
  for (const entry of anchoredEntries) {
    anchorScores.set(entry.file.path, Math.max(anchorScores.get(entry.file.path) ?? 0, entry.score));
  }
  const includeArchitectureCore = intents.includes("architecture");
  const byPath = new Map<string, LaneEntry>();
  const add = (filePath: string | undefined, score: number, reason: string) => {
    if (!filePath) {
      return;
    }
    const file = fileByPath.get(filePath);
    if (!file) {
      return;
    }
    const existing = byPath.get(file.path) ?? { file, score: 0, reasons: [], matchedTerms: [] };
    existing.score += score;
    existing.reasons.push(reason);
    byPath.set(file.path, existing);
  };

  for (const file of index.files) {
    if (anchored.has(file.path) || (includeArchitectureCore && /src\/(indexer|parser|resolver|query|queries|mcp|artifacts|eval|init)\.ts$/.test(file.path))) {
      add(file.path, rankLog2(file.rank), "graph centrality tie-breaker");
    }
  }

  const topAnchors = [...anchorScores.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 18);
  const topAnchorSet = new Set(topAnchors.map(([filePath]) => filePath));
  const anchorBoost = (filePath: string, factor: number) => Math.min(18, 4 + (anchorScores.get(filePath) ?? 0) * factor);
  for (const edge of index.imports) {
    if (edge.resolvedPath && topAnchorSet.has(edge.resolvedPath)) {
      add(edge.path, anchorBoost(edge.resolvedPath, 0.12), `graph importer of ${edge.resolvedPath}`);
    }
    if (topAnchorSet.has(edge.path) && edge.resolvedPath) {
      add(edge.resolvedPath, anchorBoost(edge.path, 0.1), `graph dependency of ${edge.path}`);
    }
  }
  for (const edge of index.testEdges) {
    if (edge.targetPath && topAnchorSet.has(edge.targetPath)) {
      add(edge.path, anchorBoost(edge.targetPath, 0.1), `graph covering test for ${edge.targetPath}`);
    }
  }
  for (const edge of index.graphEdges.filter(isRetrievalExpansionEdge)) {
    if (edge.toPath && topAnchorSet.has(edge.toPath)) {
      add(edge.fromPath, anchorBoost(edge.toPath, 0.08), `graph ${edge.edgeKind.toLowerCase()} into ${edge.toPath}`);
    }
    if (edge.fromPath && topAnchorSet.has(edge.fromPath)) {
      add(edge.toPath, Math.max(3, anchorBoost(edge.fromPath, 0.06) - 2), `graph ${edge.edgeKind.toLowerCase()} from ${edge.fromPath}`);
    }
  }

  return [...byPath.values()]
    .map((entry) => ({ ...entry, reasons: uniqueSorted(entry.reasons).slice(0, 8), matchedTerms: [] }))
    .sort(sortLaneEntry);
}

function isRetrievalExpansionEdge(edge: GraphEdgeFact): boolean {
  return [
    "CALLS",
    "REFERENCES",
    "IMPORTS",
    "TESTS",
    "ROUTE_CALLS_STORE",
    "STORE_DISPATCHES_ADAPTER",
    "ADAPTER_REFERENCED_BY_MANIFEST",
    "UI_CALLS_ENDPOINT",
    "TEST_COVERS_WORKFLOW",
    "IMPLEMENTS",
    "EXTENDS"
  ].includes(edge.edgeKind);
}

function fuseLaneRankings(index: CodexaIndex, lanes: Array<[RetrievalLane, LaneEntry[]]>): RetrievalMatch[] {
  const byPath = new Map<string, RetrievalMatch & { rawScore: number }>();
  for (const [lane, entries] of lanes) {
    const sorted = entries.filter((entry) => entry.score > 0).sort(sortLaneEntry);
    for (let indexInLane = 0; indexInLane < sorted.length; indexInLane += 1) {
      const entry = sorted[indexInLane];
      const existing =
        byPath.get(entry.file.path) ??
        ({
          file: entry.file,
          score: 0,
          rawScore: 0,
          reasons: [],
          matchedTerms: [],
          lanes: {}
        } satisfies RetrievalMatch & { rawScore: number });
      const reciprocal = (LANE_WEIGHTS[lane] * 100) / (60 + indexInLane + 1);
      existing.score += reciprocal;
      existing.rawScore += entry.score * LANE_WEIGHTS[lane];
      existing.lanes[lane] = (existing.lanes[lane] ?? 0) + entry.score;
      existing.reasons.push(...entry.reasons);
      existing.matchedTerms.push(...entry.matchedTerms);
      byPath.set(entry.file.path, existing);
    }
  }
  return [...byPath.values()]
    .map((entry) => ({
      file: entry.file,
      score: entry.score + Math.log1p(entry.rawScore) + rankLog2(entry.file.rank) * 0.05,
      reasons: uniqueSorted(entry.reasons).slice(0, 10),
      matchedTerms: uniqueSorted(entry.matchedTerms),
      lanes: entry.lanes
    }))
    .sort((a, b) => b.score - a.score || b.file.rank - a.file.rank || a.file.path.localeCompare(b.file.path));
}

function analyzeIntentConfidence(
  query: string,
  intents: TaskIntent[],
  terms: string[],
  matches: RetrievalMatch[],
  workflows: WorkflowTraceFact[],
  broad: boolean
): IntentConfidence {
  const mode: PromptMode = intents.some((intent) => intent === "implementation" || intent === "debugging") ? "edit" : "orientation";
  const primaryIntent = intents.find((intent) => intent !== "unknown") ?? "unknown";
  const allowTestAnchors = /\b(test|tests|spec|specs|pytest|vitest|coverage|verification|verify)\b/i.test(query);
  const directAnchorMatches = matches.filter((match) => (match.lanes.exact ?? 0) > 0 || (match.lanes.symbol ?? 0) > 0 || (match.lanes.workflow ?? 0) > 0);
  const directAnchorPaths = new Set(directAnchorMatches.map((match) => match.file.path));
  const semanticAnchorMatches = matches.filter((match) => !directAnchorPaths.has(match.file.path) && (match.lanes.semantic ?? 0) >= SEMANTIC_ANCHOR_MIN_SCORE);
  const anchors = uniqueSorted(
    [...directAnchorMatches, ...semanticAnchorMatches]
      .filter((match) => allowTestAnchors || (!match.file.test && !isTestPath(match.file.path)))
      .map((match) => match.file.path)
  ).slice(0, 8);
  const semanticAnchorCount = semanticAnchorMatches.filter((match) => anchors.includes(match.file.path)).length;
  const testOnlyAnchorCount =
    allowTestAnchors || anchors.length > 0 ? 0 : [...directAnchorMatches, ...semanticAnchorMatches].filter((match) => match.file.test || isTestPath(match.file.path)).length;
  const missingAnchors: string[] = [];
  if (matches.length === 0) {
    missingAnchors.push("no retrieval matches");
  }
  if (mode === "edit" && anchors.length === 0) {
    missingAnchors.push("no authoritative or derived edit anchor");
  }
  if (mode === "edit" && !allowTestAnchors && testOnlyAnchorCount > 0) {
    missingAnchors.push("only test anchors for edit prompt");
  }
  if (intents.includes("workflow") && workflows.length === 0) {
    missingAnchors.push("no workflow trace matched");
  }
  if (broad && mode === "edit" && matches.length > 0 && anchors.length === 0) {
    missingAnchors.push("broad prompt matched only weak lexical evidence");
  }
  const rawSearchBetter = missingAnchors.includes("broad prompt matched only weak lexical evidence") || missingAnchors.includes("only test anchors for edit prompt");
  const confidence = Math.max(
    0,
    Math.min(
      1,
      0.18 +
        Math.min(0.36, anchors.length * 0.08) +
        (anchors.length > 0 && !broad ? 0.22 : 0) +
        Math.min(0.22, workflows.length * 0.05) +
        (allowTestAnchors && matches.some((match) => (match.lanes.test ?? 0) > 0) ? 0.1 : 0) -
        missingAnchors.length * 0.16 -
        (broad && mode === "edit" ? 0.08 : 0)
    )
  );
  const editReady = mode === "edit" && missingAnchors.length === 0 && confidence >= 0.48;
  const verdict: PacketVerdict =
    editReady ? "edit-ready" : rawSearchBetter ? "raw-search-better" : mode === "orientation" && confidence >= 0.3 ? "orientation-only" : "needs-target";
  const recommendedNextTool =
    verdict === "needs-target" || verdict === "raw-search-better"
      ? "search"
      : mode === "edit"
        ? "task_brief"
        : intents.includes("workflow")
          ? "workflow_path"
          : "find_context";
  const reasons = [
    `mode ${mode}`,
    `primary intent ${primaryIntent}`,
    broad ? "broad natural-language prompt" : "anchored prompt",
    anchors.length > 0 ? `${anchors.length} direct anchor(s)` : "no direct anchors",
    semanticAnchorCount > 0 ? `${semanticAnchorCount} semantic anchor(s)` : undefined,
    workflows.length > 0 ? `${workflows.length} workflow trace(s)` : undefined,
    ...missingAnchors.map((anchor) => `missing ${anchor}`)
  ].filter((entry): entry is string => Boolean(entry));
  return { mode, intent: primaryIntent, confidence, anchors, selectedAnchorCount: anchors.length, discardedAnchorCount: 0, missingAnchors, recommendedNextTool, editReady, verdict, reasons };
}

function retrievalDiagnostics(index: CodexaIndex, matches: RetrievalMatch[], workflows: WorkflowTraceFact[], broad: boolean, intent: IntentConfidence): string[] {
  const diagnostics: string[] = [];
  if (intent.verdict === "needs-target") {
    diagnostics.push("needs explicit file, symbol, or narrower search before edit planning");
  }
  if (intent.verdict === "raw-search-better") {
    diagnostics.push("raw search likely gives a cleaner first pass than this broad packet");
  }
  if (broad && new Set(matches.slice(0, 8).map((match) => moduleNameForPath(match.file.path))).size > 4) {
    diagnostics.push("top results span many modules");
  }
  const centralThreshold = index.files[Math.min(index.files.length - 1, 5)]?.rank ?? Number.POSITIVE_INFINITY;
  const taskSpecificLanes = (lanes: RetrievalMatch["lanes"]) => Object.keys(lanes).filter((lane) => lane !== "graph");
  if (matches.slice(0, 8).filter((match) => match.file.rank >= centralThreshold && taskSpecificLanes(match.lanes).length <= 1).length >= 4) {
    diagnostics.push("central files dominate without enough task-specific lane evidence");
  }
  if (workflows.length === 0 && intent.intent === "workflow") {
    diagnostics.push("workflow intent had no matching trace");
  }
  return uniqueSorted(diagnostics);
}

function sortLaneEntry(a: LaneEntry, b: LaneEntry): number {
  return b.score - a.score || b.file.rank - a.file.rank || a.file.path.localeCompare(b.file.path);
}

function matchedQueryTerms(query: string, haystack: string): string[] {
  const haystackTokens = new Set(tokenize(haystack));
  return expandedQueryTerms(query).filter((term) => haystackTokens.has(term));
}

function matchScore(query: string, value: string): number {
  const queryText = normalizeForMatch(query);
  const valueText = normalizeForMatch(value);
  if (!queryText || !valueText) {
    return 0;
  }
  if (valueText === queryText) {
    return 14;
  }
  if (valueText.includes(queryText)) {
    return 10;
  }
  const valueTokens = new Set(tokenize(value));
  const terms = expandedQueryTerms(query);
  const tokenHits = terms.filter((term) => valueTokens.has(term)).length;
  if (tokenHits > 0) {
    return Math.min(9, tokenHits * 2 + (tokenHits === terms.length ? 2 : 0));
  }
  const partialHits = terms.filter((term) => term.length >= 4 && valueText.includes(term)).length;
  return partialHits > 0 ? Math.min(6, partialHits * 1.5) : 0;
}

function normalizeForMatch(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function intentBoost(file: FileFact, intents: TaskIntent[]): number {
  let boost = 0;
  const p = file.path;
  if (intents.includes("frontend") && (p.startsWith("web/") || /\.(tsx|jsx)$/.test(p))) boost += 2.5;
  if (intents.includes("backend") && (/\.py$/.test(p) || p.includes("_api/") || p.includes("/adapters/"))) boost += 2.5;
  if (intents.includes("testing") && file.test) boost += 3;
  if (intents.includes("configuration") && /\.(json|toml|ya?ml|service|sh)$/.test(p)) boost += 2;
  if (intents.includes("architecture") && /src\/(indexer|parser|resolver|queries|mcp|artifacts|eval|init)\.ts$/.test(p)) boost += 4;
  if (intents.includes("workflow") && /(app|route|adapter|store|execution|queue|polling|workflow|run)/i.test(p)) boost += 3;
  if (intents.includes("risk") && file.riskScore > 0) boost += Math.min(4, file.riskScore / 4);
  if (file.dirty && intents.some((intent) => intent === "implementation" || intent === "debugging")) boost += 1.5;
  return boost;
}

function documentFrequency(docs: Document[]): Map<string, number> {
  const result = new Map<string, number>();
  for (const doc of docs) {
    for (const term of new Set(doc.terms)) {
      result.set(term, (result.get(term) ?? 0) + 1);
    }
  }
  return result;
}

function rankWorkflows(index: CodexaIndex, terms: string[], matches: RetrievalMatch[]): WorkflowTraceFact[] {
  const matchedFiles = new Set(matches.slice(0, 20).map((match) => match.file.path));
  const specificTerms = terms.filter((term) => !BROAD_WORKFLOW_TERMS.has(term));
  return [...index.workflows]
    .map((workflow) => {
      const titleTokens = new Set(tokenize(`${workflow.title} ${workflow.workflowKind} ${workflow.entryPath}`));
      const fileTokens = new Set(tokenize(workflow.relatedFiles.join(" ")));
      const stepTokens = new Set(tokenize(workflow.steps.map((step) => `${step.kind} ${step.label} ${step.reason}`).join(" ")));
      const primaryTokens = new Set(
        tokenize(
          [
            workflow.title,
            workflow.workflowKind,
            workflow.entryPath,
            ...workflow.steps
              .filter((step) => !["ui", "test", "risk"].includes(step.kind))
              .map((step) => `${step.kind} ${step.label} ${step.reason} ${step.path} ${step.targetPath ?? ""}`)
          ].join(" ")
        )
      );
      const titleScore = terms.reduce((sum, term) => sum + (titleTokens.has(term) ? 5 : 0), 0);
      const fileTermScore = terms.reduce((sum, term) => sum + (fileTokens.has(term) ? 2 : 0), 0);
      const stepScore = terms.reduce((sum, term) => sum + (stepTokens.has(term) ? 1.5 : 0), 0);
      const specificHits = specificTerms.filter((term) => titleTokens.has(term) || fileTokens.has(term) || stepTokens.has(term)).length;
      const highSignalTerms = specificTerms.filter((term) => !SUPPORT_WORKFLOW_TERMS.has(term));
      const primaryHighSignalHits = highSignalTerms.filter((term) => primaryTokens.has(term)).length;
      const specificityBoost = specificHits > 0 ? specificHits * 3 : 0;
      const primarySignalBoost = primaryHighSignalHits * 4;
      const primarySignalPenalty = highSignalTerms.length > 0 && primaryHighSignalHits === 0 ? 12 : 0;
      const fileScore = workflow.relatedFiles.filter((file) => matchedFiles.has(file)).length * 3;
      const sizePenalty = Math.log2(workflow.relatedFiles.length + workflow.steps.length + 2) * 0.75;
      const evidenceScore = titleScore + fileTermScore + stepScore + specificityBoost + primarySignalBoost + fileScore - sizePenalty - primarySignalPenalty;
      return { workflow, score: evidenceScore > 0 ? evidenceScore + rankLog2(workflow.rank) * 0.2 : 0 };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.workflow.title.localeCompare(b.workflow.title))
    .map((entry) => entry.workflow);
}

function rankModules(index: CodexaIndex, matches: RetrievalMatch[], terms: string[]): RetrievalResult["modules"] {
  const byModule = new Map<string, { name: string; score: number; files: Set<string>; reasons: Set<string> }>();
  for (const match of matches) {
    const moduleName = moduleNameForPath(match.file.path);
    const existing = byModule.get(moduleName) ?? { name: moduleName, score: 0, files: new Set<string>(), reasons: new Set<string>() };
    existing.score += match.score;
    existing.files.add(match.file.path);
    for (const term of match.matchedTerms.slice(0, 6)) {
      if (terms.includes(term)) {
        existing.reasons.add(`matched ${term}`);
      }
    }
    byModule.set(moduleName, existing);
  }
  return [...byModule.values()]
    .map((entry) => ({
      name: entry.name,
      score: entry.score,
      files: [...entry.files].sort(),
      reasons: [...entry.reasons].sort().slice(0, 6)
    }))
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
}

function buildRetrievalAnchors(index: CodexaIndex, matches: RetrievalMatch[], query: string, limit: number): RetrievalAnchor[] {
  const matchByPath = new Map(matches.map((match) => [match.file.path, match]));
  const allowTests = /\b(test|tests|spec|pytest|vitest|coverage|verification)\b/i.test(query);
  const symbolAnchors = index.symbols
    .filter((symbol) => matchByPath.has(symbol.path))
    .filter((symbol) => allowTests || (!isTestPath(symbol.path) && symbol.kind !== "test" && symbol.kind !== "fixture"))
    .map((symbol) => {
      const match = matchByPath.get(symbol.path)!;
      const queryScore = Math.max(matchScore(query, symbol.name), matchScore(query, symbol.qualifiedName));
      const score = match.score + queryScore * 1.8 + symbolAnchorBoost(symbol);
      return {
        kind: "symbol" as const,
        label: symbol.qualifiedName,
        path: symbol.path,
        line: symbol.range?.startLine,
        symbolId: symbol.id,
        score,
        lanes: activeLanes(match.lanes),
        confidence: symbol.confidence,
        reasons: uniqueSorted([`ranked symbol ${symbol.qualifiedName}`, ...match.reasons]).slice(0, 8)
      };
    })
    .filter((anchor) => anchor.score > 0)
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path) || (a.line ?? 0) - (b.line ?? 0))
    .slice(0, limit);
  if (symbolAnchors.length > 0) {
    return symbolAnchors;
  }
  return matches
    .filter((match) => allowTests || (!match.file.test && !isTestPath(match.file.path)))
    .slice(0, limit)
    .map((match) => ({
      kind: "file" as const,
      label: match.file.path,
      path: match.file.path,
      score: match.score,
      lanes: activeLanes(match.lanes),
      confidence: match.file.confidence,
      reasons: uniqueSorted(["ranked file anchor", ...match.reasons]).slice(0, 8)
    }));
}

function symbolAnchorBoost(symbol: SymbolFact): number {
  const kindBoost = ["route", "class", "function", "method", "node"].includes(symbol.kind) ? 4 : 0;
  return (symbol.exported ? 5 : 0) + kindBoost;
}

function buildProcessGroups(workflows: WorkflowTraceFact[], matches: RetrievalMatch[]): RetrievalProcessGroup[] {
  const matchScoreByPath = new Map(matches.map((match) => [match.file.path, match.score]));
  return workflows
    .map((workflow) => {
      const workflowFiles = uniqueSorted([
        workflow.entryPath,
        ...workflow.relatedFiles,
        ...workflow.steps.flatMap((step) => [step.path, step.targetPath].filter((filePath): filePath is string => typeof filePath === "string"))
      ]);
      const matchedFiles = workflowFiles.filter((filePath) => matchScoreByPath.has(filePath));
      const matchScore = matchedFiles.reduce((sum, filePath) => sum + (matchScoreByPath.get(filePath) ?? 0), 0);
      const score = matchScore + rankLog2(workflow.rank) * 0.4 + (workflow.entryScore ?? 0) * 0.04;
      const stepCount = Math.max(1, workflow.steps.length);
      return {
        workflowId: workflow.id,
        title: workflow.title,
        workflowKind: workflow.workflowKind,
        processKind: workflow.processKind,
        score,
        normalizedScore: score / Math.sqrt(stepCount),
        entryPath: workflow.entryPath,
        entryScore: workflow.entryScore,
        matchedFiles: matchedFiles.slice(0, 16),
        terminalFiles: (workflow.terminalFiles ?? []).slice(0, 8),
        tests: workflow.tests.slice(0, 8),
        reasons: uniqueSorted([
          workflow.processKind ? `process ${workflow.processKind}` : undefined,
          matchedFiles.length > 0 ? `${matchedFiles.length} matched file(s)` : undefined,
          workflow.entryScore ? `entry score ${workflow.entryScore}` : undefined
        ].filter((reason): reason is string => typeof reason === "string")),
        confidence: workflow.confidence
      };
    })
    .filter((group) => group.score > 0)
    .sort((a, b) => b.normalizedScore - a.normalizedScore || b.score - a.score || a.title.localeCompare(b.title));
}

function buildClusterGroups(index: CodexaIndex, modules: RetrievalResult["modules"], matches: RetrievalMatch[]): RetrievalClusterGroup[] {
  const moduleByName = new Map(index.modules.map((module) => [module.name, module]));
  const matchScoreByPath = new Map(matches.map((match) => [match.file.path, match.score]));
  return modules
    .map((moduleMatch) => {
      const module = moduleByName.get(moduleMatch.name);
      const files = module?.files ?? moduleMatch.files;
      const matchedFiles = files.filter((filePath) => matchScoreByPath.has(filePath)).sort((a, b) => (matchScoreByPath.get(b) ?? 0) - (matchScoreByPath.get(a) ?? 0) || a.localeCompare(b));
      return {
        name: moduleMatch.name,
        clusterKind: module?.clusterKind,
        score: moduleMatch.score + (module?.rank ?? 0) * 0.01,
        rank: module?.rank ?? moduleMatch.score,
        summary: module?.summary ?? `${moduleMatch.name} matched ${moduleMatch.files.length} file(s).`,
        matchedFiles: matchedFiles.slice(0, 16),
        topFiles: (module?.topFiles ?? files).slice(0, 8),
        topSymbols: (module?.topSymbols ?? []).slice(0, 12),
        workflows: (module?.workflows ?? []).slice(0, 8),
        tests: (module?.tests ?? []).slice(0, 8),
        risks: (module?.risks ?? []).slice(0, 8),
        relationCount: module?.relationCount,
        crossModuleRelationCount: module?.crossModuleRelationCount,
        confidence: module?.confidence ?? "heuristic",
        reasons: uniqueSorted(moduleMatch.reasons.length > 0 ? moduleMatch.reasons : ["cluster contains ranked retrieval matches"]).slice(0, 8)
      };
    })
    .filter((group) => group.score > 0)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
}

function activeLanes(lanes: RetrievalMatch["lanes"]): RetrievalLane[] {
  const order: RetrievalLane[] = ["exact", "symbol", "semantic", "bm25", "workflow", "test", "dirty", "graph"];
  return order.filter((lane) => (lanes[lane] ?? 0) > 0);
}

function tokenize(value: string): string[] {
  const expandedCamel = value.replace(/([a-z0-9])([A-Z])/g, "$1 $2");
  return uniqueSorted(
    expandedCamel
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .map((term) => term.trim())
      .filter((term) => term.length >= 2 && !STOP_WORDS.has(term))
  );
}

function isDecoyLikePath(filePath: string): boolean {
  const spaced = filePath.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
  return /(?:^|\b|[._/-])(decoy|mock|old|backup|copy|fixture)(?:$|\b|[._/-])/.test(spaced) || /(decoy|mock|backup|fixture)/.test(spaced.replace(/[^a-z0-9]+/g, ""));
}

function queryAllowsDecoy(query: string): boolean {
  return /\b(decoy|mock|fixture|backup|old|copy)\b/i.test(query);
}

function uniqueInOrder<T>(items: T[]): T[] {
  const seen = new Set<T>();
  const result: T[] = [];
  for (const item of items) {
    if (!seen.has(item)) {
      seen.add(item);
      result.push(item);
    }
  }
  return result;
}
