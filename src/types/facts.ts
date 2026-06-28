export type LanguageId =
  | "typescript"
  | "javascript"
  | "python"
  | "json"
  | "markdown"
  | "rust"
  | "go"
  | "java"
  | "csharp"
  | "cpp"
  | "c"
  | "ruby"
  | "php"
  | "unknown";

export type FactSource =
  | "tree-sitter"
  | "typescript-syntax"
  | "typescript-compiler"
  | "git"
  | "manifest"
  | "markdown"
  | "heuristic"
  | "static-analysis"
  | "lsp"
  | "mcp-tool"
  | "codex-agent"
  | "codexa-cache";

export type Confidence = "authoritative" | "derived" | "heuristic";

export type EvidenceTier = "authoritative" | "derived" | "heuristic" | "fallback";

export type FactType =
  | "RepoSnapshot"
  | "File"
  | "Symbol"
  | "UsageSite"
  | "ImportEdge"
  | "TestEdge"
  | "GraphEdge"
  | "WorkflowTrace"
  | "ModuleCluster"
  | "RiskSignal"
  | "ParserError"
  | "SessionMemoryEntry";

export type GraphEdgeKind =
  | "DEFINES"
  | "IMPORTS"
  | "CALLS"
  | "REFERENCES"
  | "TESTS"
  | "ROUTE"
  | "JOB"
  | "RISK"
  | "ROUTE_HANDLES"
  | "ROUTE_CALLS_STORE"
  | "STORE_DISPATCHES_ADAPTER"
  | "ADAPTER_REFERENCED_BY_MANIFEST"
  | "UI_CALLS_ENDPOINT"
  | "TEST_COVERS_WORKFLOW"
  | "IMPLEMENTS"
  | "EXTENDS"
  | "EXPORTS"
  | "TYPE_EXPORTS";

export type GraphNodeKind = "file" | "symbol" | "usage" | "test" | "risk" | "workflow" | "endpoint";

export interface Range {
  startLine: number;
  endLine: number;
  startByte: number;
  endByte: number;
}

export interface BaseFact {
  id: string;
  type: FactType;
  path?: string;
  range?: Range;
  source: FactSource;
  confidence: Confidence;
  snapshotId: string;
  indexedAt: string;
}

export interface RepoSnapshotFact extends BaseFact {
  type: "RepoSnapshot";
  repoRoot: string;
  gitRoot: string | null;
  headCommit: string | null;
  dirtyFiles: string[];
}

export interface FileFact extends BaseFact {
  type: "File";
  path: string;
  language: LanguageId;
  sizeBytes: number;
  dirty: boolean;
  generated: boolean;
  test: boolean;
  rank: number;
  rankReasons: Record<string, number>;
  symbolCount: number;
  usageCount: number;
  importCount: number;
  riskScore: number;
}

export interface SymbolFact extends BaseFact {
  type: "Symbol";
  path: string;
  name: string;
  qualifiedName: string;
  kind:
    | "module"
    | "class"
    | "interface"
    | "type"
    | "enum"
    | "function"
    | "method"
    | "variable"
    | "route"
    | "fixture"
    | "test"
    | "node"
    | "unknown";
  language: LanguageId;
  exported: boolean;
  decorators: string[];
  parentSymbolId?: string;
}

export interface UsageSiteFact extends BaseFact {
  type: "UsageSite";
  path: string;
  name: string;
  kind: "call" | "import" | "reference" | "type_reference" | "endpoint_reference" | "route_handler" | "test_reference" | "decorator";
  targetSymbolId?: string;
  usedBySymbolId?: string;
  text: string;
}

export interface ImportEdgeFact extends BaseFact {
  type: "ImportEdge";
  path: string;
  specifier: string;
  importedName?: string;
  localName?: string;
  reExport?: boolean;
  typeOnly?: boolean;
  resolvedPath?: string;
}

export interface TestEdgeFact extends BaseFact {
  type: "TestEdge";
  path: string;
  targetPath?: string;
  reason: string;
}

export interface GraphEdgeFact extends BaseFact {
  type: "GraphEdge";
  edgeKind: GraphEdgeKind;
  fromId: string;
  toId: string;
  fromKind: GraphNodeKind;
  toKind: GraphNodeKind;
  fromPath?: string;
  toPath?: string;
  fromSymbolId?: string;
  toSymbolId?: string;
  reason: string;
  weight: number;
}

export interface EdgeEvidenceV1 {
  schemaVersion: 1;
  id: string;
  edgeKind: GraphEdgeKind;
  fromId: string;
  toId: string;
  fromPath?: string;
  toPath?: string;
  fromSymbolId?: string;
  toSymbolId?: string;
  source: FactSource;
  confidence: Confidence;
  reason: string;
  range?: Range;
  degraded: boolean;
  stale: boolean;
}

export interface CodexaSymbolReportSymbolV1 {
  id?: string;
  name: string;
  qualifiedName?: string;
  kind?: SymbolFact["kind"];
  path: string;
  line?: number;
  endLine?: number;
  exported?: boolean;
  parentId?: string;
  confidence?: Confidence;
  reason?: string;
}

export interface CodexaSymbolReportRelationshipV1 {
  kind: Extract<GraphEdgeKind, "DEFINES" | "CALLS" | "REFERENCES" | "IMPORTS" | "IMPLEMENTS" | "EXTENDS" | "EXPORTS" | "TYPE_EXPORTS">;
  fromSymbol?: string;
  fromPath?: string;
  toSymbol?: string;
  toPath?: string;
  line?: number;
  endLine?: number;
  confidence?: Confidence;
  reason?: string;
}

export interface CodexaSymbolReportV1 {
  schemaVersion: 1;
  tool: string;
  generatedBy?: string;
  language: string;
  symbols: CodexaSymbolReportSymbolV1[];
  relationships?: CodexaSymbolReportRelationshipV1[];
}

export interface WorkflowStep {
  kind: "entry" | "call" | "reference" | "import" | "risk" | "test" | "endpoint" | "ui" | "store" | "adapter" | "manifest" | "type";
  label: string;
  path: string;
  line?: number;
  symbolId?: string;
  targetSymbolId?: string;
  targetPath?: string;
  confidence: Confidence;
  reason: string;
}

export type PacketSummarySource = "deterministic" | "external" | "llm-ready";

export interface PacketEvidenceProfile {
  symbolSources?: Partial<Record<FactSource, number>>;
  edgeSources?: Partial<Record<FactSource, number>>;
  edgeConfidence?: Partial<Record<Confidence, number>>;
  workflowConfidence?: Partial<Record<Confidence, number>>;
  riskConfidence?: Partial<Record<Confidence, number>>;
  staticAnalysisSymbolCount?: number;
  lspSymbolCount?: number;
  deterministicSymbolCount?: number;
}

export interface WorkflowTraceFact extends BaseFact {
  type: "WorkflowTrace";
  workflowKind: "route" | "job" | "test" | "manifest" | "module";
  title: string;
  entryPath: string;
  entrySymbolId?: string;
  relatedFiles: string[];
  tests: string[];
  steps: WorkflowStep[];
  summary: string;
  rank: number;
  processKind?: "entry-process" | "intra-module-process" | "cross-module-process";
  entryScore?: number;
  terminalFiles?: string[];
  relatedModules?: string[];
  stepCounts?: Partial<Record<WorkflowStep["kind"], number>>;
  evidenceCounts?: Partial<Record<Confidence, number>>;
  evidenceProfile?: PacketEvidenceProfile;
  summarySource?: PacketSummarySource;
  summaryPrompt?: string;
  truncation?: {
    relatedFiles?: { total: number; returned: number };
    tests?: { total: number; returned: number };
    steps?: { total: number; returned: number };
  };
}

export interface ModuleClusterFact extends BaseFact {
  type: "ModuleCluster";
  name: string;
  files: string[];
  summary: string;
  rank: number;
  clusterKind?: "path" | "functional";
  sourceModules?: string[];
  communityScore?: number;
  topFiles?: string[];
  topSymbols?: string[];
  workflows?: string[];
  tests?: string[];
  risks?: string[];
  relationCount?: number;
  crossModuleRelationCount?: number;
  evidenceCounts?: Partial<Record<Confidence, number>>;
  evidenceProfile?: PacketEvidenceProfile;
  summarySource?: PacketSummarySource;
  summaryPrompt?: string;
  truncation?: {
    files?: { total: number; returned: number };
    symbols?: { total: number; returned: number };
    workflows?: { total: number; returned: number };
    tests?: { total: number; returned: number };
    risks?: { total: number; returned: number };
  };
}

export interface RiskSignalFact extends BaseFact {
  type: "RiskSignal";
  path: string;
  signal: string;
  score: number;
  reason: string;
}

export interface ParserErrorFact extends BaseFact {
  type: "ParserError";
  path: string;
  message: string;
}

export type SessionMemoryKind =
  | "viewed"
  | "claim"
  | "ruled_out"
  | "open_question"
  | "next_read"
  | "decision"
  | "verification"
  | "risk"
  | "constraint";

export type SessionMemoryProvenance = "codexa-derived" | "agent-asserted" | "user-asserted";

export type SessionMemoryStatus = "active" | "stale" | "superseded" | "rejected" | "resolved";

export interface SessionMemoryRef {
  kind: "file" | "symbol" | "workflow" | "endpoint" | "test" | "graph_edge" | "outcome" | "snapshot";
  id: string;
  path?: string;
  edgeKind?: GraphEdgeKind;
  fromId?: string;
  toId?: string;
  evidenceTier: EvidenceTier;
  confidence: Confidence;
}

export interface SessionMemoryScope {
  files: string[];
  symbols: string[];
  tests: string[];
  workflows: string[];
  topics: string[];
  refs: SessionMemoryRef[];
}

export interface SessionMemoryEvidence {
  id: string;
  provenance: SessionMemoryProvenance;
  source: "agent" | "mcp_tool" | "task_snapshot" | "post_edit_outcome" | "hook_event" | "index_fact" | "codexa_cache";
  sourceRef: string;
  toolName?: string;
  callId?: string;
  taskId?: string;
  path?: string;
  range?: Range;
  factType?: FactType;
  edgeKind?: GraphEdgeKind;
  evidenceTier: EvidenceTier;
  confidence: Confidence;
  snapshotId: string;
  indexedAt: string;
  headCommit: string | null;
  note?: string;
}

export interface SessionMemoryEntryFact extends BaseFact {
  type: "SessionMemoryEntry";
  sessionId: string;
  taskId?: string;
  kind: SessionMemoryKind;
  key: string;
  summary: string;
  details?: string;
  provenance: SessionMemoryProvenance;
  status: SessionMemoryStatus;
  evidenceTier: EvidenceTier;
  scope: SessionMemoryScope;
  evidence: SessionMemoryEvidence[];
  createdAt: string;
  updatedAt: string;
  supersedes: string[];
  supersededBy?: string;
  staleBecause: string[];
}

export interface SessionMemoryStore {
  schemaVersion: 1;
  sessionId: string;
  repoRoot: ".";
  createdAt: string;
  updatedAt: string;
  revision: number;
  activeTaskId?: string;
  entries: SessionMemoryEntryFact[];
  compaction: {
    compactedAt?: string;
    sourceEventCount: number;
    retainedEntryCount: number;
    droppedEntryCount: number;
  };
}

export type CodexaFact =
  | RepoSnapshotFact
  | FileFact
  | SymbolFact
  | UsageSiteFact
  | ImportEdgeFact
  | TestEdgeFact
  | GraphEdgeFact
  | WorkflowTraceFact
  | ModuleClusterFact
  | RiskSignalFact
  | ParserErrorFact;
