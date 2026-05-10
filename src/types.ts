export type LanguageId = "typescript" | "javascript" | "python" | "json" | "markdown" | "unknown";

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
}

export interface ModuleClusterFact extends BaseFact {
  type: "ModuleCluster";
  name: string;
  files: string[];
  summary: string;
  rank: number;
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

export interface FreshnessInfo {
  schemaVersion: 1;
  snapshotId: string;
  repoRoot: string;
  gitRoot: string | null;
  headCommit: string | null;
  indexedAt: string;
  dirtyFiles: string[];
  dirtyFileHashes: Record<string, string>;
  indexedDirtyFileHashes: Record<string, string>;
  indexedDirtyFiles: string[];
  missing: boolean;
  stale: boolean;
  reason: string;
  parserErrorCount: number;
}

export interface CodexaIndex {
  schemaVersion: 1;
  snapshot: RepoSnapshotFact;
  freshness: FreshnessInfo;
  files: FileFact[];
  symbols: SymbolFact[];
  usageSites: UsageSiteFact[];
  imports: ImportEdgeFact[];
  testEdges: TestEdgeFact[];
  graphEdges: GraphEdgeFact[];
  workflows: WorkflowTraceFact[];
  modules: ModuleClusterFact[];
  risks: RiskSignalFact[];
  parserErrors: ParserErrorFact[];
}

export interface ParseResult {
  file: Omit<FileFact, "rank" | "rankReasons" | "riskScore" | "symbolCount" | "usageCount" | "importCount">;
  symbols: SymbolFact[];
  usageSites: UsageSiteFact[];
  imports: ImportEdgeFact[];
  testEdges: TestEdgeFact[];
  risks: RiskSignalFact[];
  parserErrors: ParserErrorFact[];
}

export interface IndexOptions {
  repoRoot: string;
  outputDir?: string;
  writeArtifacts?: boolean;
}

export interface QueryResult {
  freshness: FreshnessInfo;
  text: string;
  data: unknown;
  refresh?: RefreshInfo;
}

export interface RefreshInfo {
  refreshed: boolean;
  reason?: string;
  indexedAt?: string;
}

export interface QueryOptions {
  autoRefresh?: boolean;
  commandBudgetMs?: number;
  maxResultBytes?: number;
  maxResults?: number;
  lsp?: boolean;
  lspTimeoutMs?: number;
  lspMaxFiles?: number;
  lspServers?: Partial<Record<LanguageId, { command: string; args?: string[]; cwd?: string }>>;
  semantic?: boolean;
  semanticProvider?: "openai" | "local-command";
  semanticModel?: string;
  semanticDimensions?: number;
  semanticCommand?: string;
  semanticArgs?: string[];
  semanticTimeoutMs?: number;
  semanticBatchSize?: number;
  semanticMaxFiles?: number;
  workspaceFocusFile?: string;
}

export type ChangeType = "style" | "api" | "behavior" | "rename" | "delete" | "unknown";

export interface ContextPackInput {
  task?: string;
  files?: string[];
  symbols?: string[];
  query?: string;
  diff?: boolean;
  tokenBudget?: number;
  limit?: number;
  includeSnippets?: boolean;
  changeType?: ChangeType;
}

export interface ChangePlanInput extends ContextPackInput {
  saveSnapshot?: boolean;
  taskId?: string;
}

export interface SessionMemoryInput {
  action?: "read" | "remember" | "summary" | "compact";
  sessionId?: string;
  taskId?: string;
  task?: string;
  kinds?: SessionMemoryKind[];
  refs?: SessionMemoryRef[];
  files?: string[];
  symbols?: string[];
  topics?: string[];
  limit?: number;
  tokenBudget?: number;
  includeStale?: boolean;
  entries?: Array<{
    kind: SessionMemoryKind;
    key?: string;
    summary: string;
    details?: string;
    provenance?: SessionMemoryProvenance;
    status?: SessionMemoryStatus;
    confidence: Confidence;
    evidenceTier: EvidenceTier;
    scope?: Partial<SessionMemoryScope>;
    evidence?: SessionMemoryEvidence[];
    supersedes?: string[];
  }>;
}

export interface PostEditReviewInput {
  task?: string;
  taskId?: string;
  files?: string[];
  symbols?: string[];
  changeType?: ChangeType;
  tokenBudget?: number;
  limit?: number;
  includeSnippets?: boolean;
  ranTests?: string[];
  ranCommands?: string[];
  ranCommandReports?: VerificationCommandReport[];
  waivedChecks?: string[];
  waivers?: VerificationWaiver[];
  persistOutcome?: boolean;
}

export interface FocusBriefInput {
  task?: string;
  tokenBudget?: number;
  limit?: number;
  diff?: boolean;
}

export interface TestRecommendation {
  path: string;
  reason: string;
  rank: number;
  evidenceTier?: EvidenceTier;
  command?: string;
  commandSource?: string;
  commandConfidence?: Confidence;
}

export type VerificationCoverageKind =
  | "javascript-tests"
  | "python-tests"
  | "typescript-syntax"
  | "build"
  | "lint"
  | "privacy"
  | "audit"
  | "targeted-test"
  | "unknown";

export type VerificationLedgerStatus = "covered" | "missing" | "waived" | "not_applicable";

export const VERIFICATION_PROVENANCE_SCHEMA_VERSION = 1 as const;
export const VERIFICATION_COMMAND_COVERAGE_CLASSIFIER_VERSION = "command-coverage-v3";
export const VERIFICATION_COMMAND_ENVELOPE_RULESET_VERSION = "command-envelope-v2";
export const VERIFICATION_LEDGER_VERSION = "verification-ledger-v2";

export interface VerificationProvenance {
  schemaVersion: typeof VERIFICATION_PROVENANCE_SCHEMA_VERSION;
  commandCoverageClassifier: "codexa-command-coverage";
  commandCoverageClassifierVersion: string;
  commandEnvelopeRulesetVersion: string;
  verificationLedgerVersion: string;
}

export const CURRENT_VERIFICATION_PROVENANCE: VerificationProvenance = {
  schemaVersion: VERIFICATION_PROVENANCE_SCHEMA_VERSION,
  commandCoverageClassifier: "codexa-command-coverage",
  commandCoverageClassifierVersion: VERIFICATION_COMMAND_COVERAGE_CLASSIFIER_VERSION,
  commandEnvelopeRulesetVersion: VERIFICATION_COMMAND_ENVELOPE_RULESET_VERSION,
  verificationLedgerVersion: VERIFICATION_LEDGER_VERSION
};

export interface VerificationCoverage {
  kind: VerificationCoverageKind;
  command: string;
  source: string;
  confidence: Confidence;
  scope?: string;
  targetPath?: string;
  details: string[];
  exitCode?: number;
  durationMs?: number;
  outputSummary?: string;
  commandEnvelope?: VerificationCommandEnvelope;
}

export interface VerificationCommandReport {
  command: string;
  cwd?: string;
  packageManager?: string;
  workspace?: string;
  packageRoot?: string;
  packageName?: string;
  scriptName?: string;
  args?: string[];
  exitCode?: number;
  durationMs?: number;
  stdoutSummary?: string;
  stderrSummary?: string;
  outputSummary?: string;
}

export type VerificationCommandEnvelopeSource = "reported" | "derived-from-report" | "derived-from-raw-command";
export type VerificationCommandEnvelopeScopeStatus = "repo" | "missing-cwd" | "outside-repo" | "unresolved-package" | "unknown";

export interface VerificationCommandEnvelope {
  command: string;
  cwd?: string;
  packageManager?: string;
  workspace?: string;
  packageRoot?: string;
  packageName?: string;
  scriptName?: string;
  args: string[];
  exitCode?: number;
  durationMs?: number;
  stdoutSummary?: string;
  stderrSummary?: string;
  outputSummary?: string;
  source: VerificationCommandEnvelopeSource;
  scopeStatus: VerificationCommandEnvelopeScopeStatus;
  classifierVersion: string;
}

export interface VerificationCommandPlanEntry {
  command: string;
  covers: VerificationCoverageKind[];
  targetPaths: string[];
  scopes: string[];
  sources: string[];
  confidence: Confidence;
}

export interface VerificationLedgerEntry {
  kind: "test" | "workflow" | "dependency";
  recommended: string;
  target: string;
  status: VerificationLedgerStatus;
  evidence: string[];
  missingReason?: string;
  waiverReason?: string;
  notApplicableReason?: string;
  coverageKinds: VerificationCoverageKind[];
  command?: string;
  source?: string;
}

export interface VerificationWaiver {
  kind: "test" | "workflow" | "dependency";
  target: string;
  reason: string;
}

export interface ChangedSymbol {
  symbol: SymbolFact;
  changedLines: string[];
}

export interface ChangedFileEntry {
  path: string;
  oldPath?: string;
  status: string;
  kind: "added" | "modified" | "deleted" | "renamed" | "copied" | "untracked" | "unknown";
  staged: boolean;
  worktree: boolean;
}

export interface DiffImpactGroup {
  key: string;
  module: string;
  kind: "source" | "test" | "config" | "docs" | "generated" | "unknown";
  language: LanguageId;
  files: string[];
  diffKinds: ChangedFileEntry["kind"][];
  changedSymbols: ChangedSymbol[];
  unindexedFiles: string[];
  rank: number;
  risk: number;
}

export interface TaskSnapshotFocusFile {
  path: string;
  tier: EvidenceTier;
  reasons: string[];
  rank: number;
  riskScore: number;
}

export interface TaskSnapshotSymbol {
  id: string;
  path: string;
  name: string;
  qualifiedName: string;
  kind: SymbolFact["kind"];
  range?: Range;
}

export interface TaskSnapshotRiskFile {
  riskScore: number;
  signals: string[];
}

export interface TaskSnapshotRequiredCheck {
  kind: "workflow" | "dependency";
  target: string;
  reason: string;
  evidenceTier: EvidenceTier;
  confidence: Confidence;
  paths: string[];
}

export interface TaskSnapshot {
  schemaVersion: 1;
  taskId: string;
  repoRoot: string;
  task?: string;
  changeType: ChangeType;
  createdAt: string;
  snapshotFreshness: FreshnessInfo;
  input: ChangePlanInput;
  plannedEditTargets: string[];
  plannedFiles: string[];
  focusFiles: TaskSnapshotFocusFile[];
  plannedTests: TestRecommendation[];
  sessionMemory?: SessionMemoryPointer;
  requiredWorkflowChecks: TaskSnapshotRequiredCheck[];
  requiredDependencyChecks: TaskSnapshotRequiredCheck[];
  symbolBaseline?: Record<string, TaskSnapshotSymbol[]>;
  riskBaseline?: Record<string, TaskSnapshotRiskFile>;
  recipes: string[];
  dirtyBaseline: {
    changedEntries: ChangedFileEntry[];
    dirtyFiles: string[];
    dirtyFileHashes: Record<string, string>;
    headCommit: string | null;
    indexedAt: string;
  };
  quality?: unknown;
  gaps: string[];
  warnings: string[];
}

export interface SessionMemoryPointer {
  sessionId: string;
  revision: number;
  entryIds: string[];
  summaryHash: string;
}
