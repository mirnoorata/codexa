import type { RetrievalLane } from "../retrieval.js";

export const STOP_WORDS = new Set([
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

export const SYNONYMS: Record<string, string[]> = {
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

export const BROAD_WORKFLOW_TERMS = new Set(["api", "app", "backend", "endpoint", "execution", "flow", "frontend", "handler", "path", "process", "route", "server", "workflow"]);
export const SUPPORT_WORKFLOW_TERMS = new Set(["store", "stores", "test", "tests", "pytest", "vitest", "spec", "specs", "verification"]);
export const LANE_WEIGHTS: Record<RetrievalLane, number> = {
  exact: 4,
  symbol: 3.2,
  bm25: 2,
  semantic: 2.6,
  graph: 0.65,
  workflow: 2.8,
  test: 2.5,
  dirty: 1.7
};
export const SEMANTIC_ANCHOR_MIN_SCORE = 9;
export const RETRIEVAL_RUNTIME_CACHE_LIMIT = 4;
