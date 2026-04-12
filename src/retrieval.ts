import path from "node:path";
import { moduleNameForPath } from "./language.js";
import type { CodexaIndex, FileFact, WorkflowTraceFact } from "./types.js";
import { uniqueSorted } from "./util.js";

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

export interface RetrievalMatch {
  file: FileFact;
  score: number;
  reasons: string[];
  matchedTerms: string[];
}

export interface RetrievalResult {
  query: string;
  intents: TaskIntent[];
  terms: string[];
  matches: RetrievalMatch[];
  workflows: WorkflowTraceFact[];
  modules: Array<{ name: string; score: number; files: string[]; reasons: string[] }>;
  broad: boolean;
}

interface Document {
  file: FileFact;
  terms: string[];
  termCounts: Map<string, number>;
  reasonsByTerm: Map<string, Set<string>>;
  length: number;
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
  atlas: ["adapter", "package", "manifest", "node", "workflow", "queue", "run"],
  automatic: ["init", "session", "hook", "config", "mcp"],
  backend: ["api", "route", "server", "python", "adapter", "store"],
  brief: ["task", "context", "pack", "query"],
  caller: ["call", "usage", "import", "reference"],
  change: ["impact", "diff", "test", "risk"],
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

export function retrieveForTask(index: CodexaIndex, query: string, limit = 12): RetrievalResult {
  const terms = expandedQueryTerms(query);
  const intents = classifyTaskIntent(query, terms);
  const allowDecoys = queryAllowsDecoy(query);
  const docs = buildDocuments(index);
  const docFreq = documentFrequency(docs);
  const avgLength = docs.length > 0 ? docs.reduce((sum, doc) => sum + doc.length, 0) / docs.length : 1;
  const matches = docs
    .map((doc) => scoreDocument(doc, terms, intents, docFreq, docs.length, avgLength))
    .filter((match): match is RetrievalMatch => match !== null && match.score > 0)
    .filter((match) => allowDecoys || !isDecoyLikePath(match.file.path))
    .sort((a, b) => b.score - a.score || b.file.rank - a.file.rank || a.file.path.localeCompare(b.file.path))
    .slice(0, limit);
  const workflows = rankWorkflows(index, terms, matches).slice(0, Math.max(3, Math.min(10, limit)));
  const modules = rankModules(index, matches, terms).slice(0, Math.max(3, Math.min(8, limit)));
  const broad = terms.length <= 2 || intents.includes("architecture") || intents.includes("workflow");
  return { query, intents, terms, matches, workflows, modules, broad };
}

export function classifyTaskIntent(query: string, terms = expandedQueryTerms(query)): TaskIntent[] {
  const joined = `${query.toLowerCase()} ${terms.join(" ")}`;
  const intents: TaskIntent[] = [];
  const add = (intent: TaskIntent, pattern: RegExp) => {
    if (pattern.test(joined)) {
      intents.push(intent);
    }
  };
  add("architecture", /\b(architecture|understand|overview|map|module|subsystem|competitor|gitnexus|sourcegraph|aider|deepwiki)\b/);
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
): RetrievalMatch | null {
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
  if (matchedTerms.length === 0 && score <= 0) {
    return null;
  }
  score += Math.log2(doc.file.rank + 1) * 0.25;
  return {
    file: doc.file,
    score,
    reasons: [...reasons].sort().slice(0, 8),
    matchedTerms: uniqueSorted(matchedTerms)
  };
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
      return { workflow, score: evidenceScore > 0 ? evidenceScore + Math.log2(workflow.rank + 1) * 0.2 : 0 };
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
