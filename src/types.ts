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
  externalRiskReportHashes?: Record<string, string>;
  indexedExternalRiskReportHashes?: Record<string, string>;
  externalRiskReportDiagnostics?: Array<{ path: string; reason: string; sizeBytes?: number; limitBytes?: number }>;
  externalSymbolReportHashes?: Record<string, string>;
  indexedExternalSymbolReportHashes?: Record<string, string>;
  externalSymbolReportDiagnostics?: Array<{ path: string; reason: string; sizeBytes?: number; limitBytes?: number }>;
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
  sessionMemory?: "auto" | "off";
  // MCP server-side tool exposure: "core" registers only the primary-loop
  // tools (for hosts without a client-side allowlist such as Claude Code).
  toolProfile?: "core" | "full";
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
  workspaceSessionId?: string;
}

export interface GuidedNextToolV1 {
  schemaVersion: 1;
  tool: string;
  reason: string;
  requiredInputs?: Record<string, unknown>;
  readOnly: boolean;
  writes: string[];
}

export type QueryPrimitive = string | number | boolean | null;
export type QueryValue = QueryPrimitive | VerificationProvenance | QueryValue[] | { [key: string]: QueryValue | undefined };
export type QueryObject = { [key: string]: QueryValue | undefined };

export type CompactFileFact = Pick<FileFact, "path" | "language" | "dirty" | "generated" | "test" | "rank" | "symbolCount" | "usageCount" | "importCount" | "riskScore">;
export type CompactSymbolFact = Pick<SymbolFact, "path" | "name" | "qualifiedName" | "kind" | "language" | "range" | "confidence">;

export interface CompactChangedSymbol {
  symbol: CompactSymbolFact;
  changedLines: string[];
}

export interface CompactDiffImpactGroup extends Omit<DiffImpactGroup, "changedSymbols"> {
  changedSymbols: CompactChangedSymbol[];
}

export type ContextSourceKind = "explicit_target" | "natural_retrieval" | "lexical_query" | "dirty_worktree" | "graph_impact" | "workflow_trace" | "test_evidence" | "rank_fallback";

export interface ContextSourceSummaryData {
  source: ContextSourceKind;
  fileCount: number;
  evidenceTierCounts: Record<EvidenceTier, number>;
  sampleFiles: string[];
  sampleReasons: string[];
}

export interface ContextPacketFocusFile {
  file: CompactFileFact;
  reasons: string[];
  rank: number;
  tier: EvidenceTier;
}

export interface RetrievalSummaryData extends QueryObject {
  query?: string;
  intents?: string[];
  terms?: string[];
  broad?: boolean;
  matches?: QueryObject[];
  workflows?: QueryObject[];
  modules?: QueryObject[];
  diagnostics?: string[];
}

export interface NextCallData extends QueryObject {
  tool?: string;
  reason?: string;
}

export interface SnapshotLoadData extends QueryObject {
  latestTaskId?: string;
  missingReason?: string;
  error?: string;
  ambiguousLatest?: boolean;
  ambiguityReason?: string;
}

export interface PostEditOutcomeData extends QueryObject {
  schemaVersion?: 1;
  outcomeId?: string;
  persisted?: boolean;
  verdict?: string;
  inspectMode?: "none" | "advisory" | "blocking";
  inspectReasons?: string[];
  completionAuthority?: "complete" | "tests_required" | "advisory_inspect" | "blocking_inspect" | "replan_required";
  path?: string;
  driftReasons?: string[];
  ranTests?: string[];
  ranCommands?: string[];
  verificationProvenance?: VerificationProvenance;
}

export type ComplexityReviewPhase = "plan" | "post-edit";
export type ComplexityReviewStatus = "lean" | "review";
export type ComplexityReviewItemKind = "yagni" | "stdlib" | "native" | "existing-dependency" | "abstraction" | "scope" | "verification" | "delete";
export type ComplexityReviewItemSeverity = "info" | "watch" | "review";

export interface ComplexityReviewItem extends QueryObject {
  kind: ComplexityReviewItemKind;
  severity: ComplexityReviewItemSeverity;
  message: string;
  paths?: string[];
  replacement?: string;
  rationale: string;
}

export interface ComplexityReviewData extends QueryObject {
  schemaVersion: 1;
  phase: ComplexityReviewPhase;
  status: ComplexityReviewStatus;
  blocking: false;
  summary: string;
  items: ComplexityReviewItem[];
  invariants: string[];
}

export type QueryResultMode =
  | "context_pack"
  | "task_brief"
  | "focus_brief"
  | "session_context"
  | "change_plan"
  | "post_edit_review"
  | "test_plan"
  | "repo_map"
  | "search"
  | "find_context"
  | "symbol_context"
  | "impact"
  | "diff_impact"
  | "callers"
  | "callees"
  | "dependency_path"
  | "workflow_path"
  | "placeholder_report"
  | "session_memory"
  | "freshness";

export interface BaseQueryData {
  mode: QueryResultMode;
  task?: string;
  quality?: QueryObject;
  worktree?: QueryObject;
  worktreeDegradationReasons?: string[];
  gaps?: string[];
  warnings?: string[];
  diagnostics?: string[];
  nextTools?: Array<GuidedNextToolV1 | string>;
  systemMessage?: string;
  sessionMemory?: QueryObject;
  workspaceGuidance?: QueryObject;
  priorSessionMemory?: QueryObject;
  runtime?: QueryObject;
  session?: QueryObject;
  truncation?: Record<string, { total: number; returned: number }>;
  verificationProvenance?: VerificationProvenance;
}

export interface ContextPacketData extends BaseQueryData {
  mode: "context_pack" | "task_brief";
  changeType?: ChangeType;
  actionability?: string;
  tokenBudget?: number;
  packetVerdict?: string;
  focusFiles?: ContextPacketFocusFile[];
  changedFiles?: string[];
  changedEntries?: ChangedFileEntry[];
  changedSymbols?: CompactChangedSymbol[];
  unindexedChanged?: string[];
  groups?: CompactDiffImpactGroup[];
  tests?: TestRecommendation[];
  snippets?: string[];
  contextSources?: ContextSourceSummaryData[];
  nextReads?: string[];
  baseline?: QueryObject;
  retrieval?: RetrievalSummaryData;
  recipes?: string[];
  verificationCommands?: string[];
  verificationCoverage?: VerificationCoverage[];
  verificationCommandPlan?: VerificationCommandPlanEntry[];
  value?: QueryObject;
}

export interface FocusBriefData extends BaseQueryData {
  mode: "focus_brief" | "session_context";
  actionability?: string;
  retrieval?: RetrievalSummaryData;
  packetVerdict?: string;
  focusFiles?: CompactFileFact[];
  workflows?: QueryObject[];
  modules?: QueryObject[];
  groups?: CompactDiffImpactGroup[];
  tests?: TestRecommendation[];
  nextCall?: NextCallData;
}

export interface ChangePlanData extends BaseQueryData {
  mode: "change_plan";
  editReadiness?: QueryObject;
  followCandidate?: QueryObject;
  snapshotBlock?: QueryObject;
  targetCandidates?: QueryObject[];
  steps?: string[];
  focus?: FocusBriefData | QueryObject;
  context?: ContextPacketData | QueryObject;
  files?: string[];
  plannedEditTargets?: string[];
  tests?: TestRecommendation[];
  recipes?: string[];
  requiredWorkflowChecks?: TaskSnapshotRequiredCheck[];
  requiredDependencyChecks?: TaskSnapshotRequiredCheck[];
  complexityReview?: ComplexityReviewData;
  snapshot?: TaskSnapshot | QueryObject;
}

export interface PostEditReviewData extends BaseQueryData {
  mode: "post_edit_review";
  verdict?: string;
  inspectMode?: "none" | "advisory" | "blocking";
  inspectReasons?: string[];
  completionAuthority?: "complete" | "tests_required" | "advisory_inspect" | "blocking_inspect" | "replan_required";
  files?: string[];
  reviewTargets?: string[];
  changedSinceSnapshot?: ChangedFileEntry[];
  changedGroups?: CompactDiffImpactGroup[];
  resolvedBaselineFiles?: string[];
  unplannedEditedFiles?: string[];
  plannedRenames?: QueryObject[];
  unplannedChangedSymbols?: CompactChangedSymbol[];
  plannedButUntouchedFiles?: string[];
  headChanged?: boolean;
  symbolDeltas?: QueryObject[];
  modifiedSymbols?: string[];
  modifiedPublicSymbols?: string[];
  riskDeltas?: QueryObject[];
  affectedEdges?: GraphEdgeFact[];
  affectedTests?: TestRecommendation[];
  tests?: TestRecommendation[];
  degradedSnapshotTests?: TestRecommendation[];
  supersededDegradedSnapshotTests?: TestRecommendation[];
  testsNotRun?: TestRecommendation[];
  missedLikelyTests?: TestRecommendation[];
  ranTests?: string[];
  ranCommands?: string[];
  ranCommandReports?: VerificationCommandReport[];
  commandEnvelopes?: VerificationCommandEnvelope[];
  waivedChecks?: string[];
  waivers?: VerificationWaiver[];
  verificationCoverage?: VerificationCoverage[];
  verificationLedger?: VerificationLedgerEntry[];
  waivedVerification?: VerificationLedgerEntry[];
  unindexedEditedFiles?: string[];
  riskEscalations?: QueryObject[];
  riskEscalationsCoveredByVerification?: boolean;
  riskEscalationsNeedInspection?: boolean;
  workflows?: WorkflowTraceFact[];
  workflowChecks?: TaskSnapshotRequiredCheck[];
  dependencyChecks?: TaskSnapshotRequiredCheck[];
  complexityReview?: ComplexityReviewData;
  driftReasons?: string[];
  nextActions?: string[];
  snapshotLoad?: SnapshotLoadData;
  snapshot?: TaskSnapshot | QueryObject;
  outcome?: PostEditOutcomeData;
  context?: ContextPacketData | QueryObject;
  autoVerifyCandidates?: QueryObject[];
  autoVerifyRunnerEvidence?: QueryObject[];
}

export interface TestPlanData extends BaseQueryData {
  mode: "test_plan";
  changedFiles?: string[];
  changedEntries?: ChangedFileEntry[];
  changedSymbols?: CompactChangedSymbol[];
  unindexedChanged?: string[];
  groups?: CompactDiffImpactGroup[];
  tests?: TestRecommendation[];
  outcomeLearning?: QueryObject[];
  verificationCommands?: string[];
  verificationCoverage?: VerificationCoverage[];
  verificationCommandPlan?: VerificationCommandPlanEntry[];
  commandEnvelopes?: VerificationCommandEnvelope[];
  verificationLedgerPreview?: VerificationLedgerEntry[];
  verificationLedger?: VerificationLedgerEntry[];
  testsNotRun?: TestRecommendation[];
}

export type CodexaQueryData = ContextPacketData | FocusBriefData | ChangePlanData | PostEditReviewData | TestPlanData;

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
  followCandidate?: string;
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

export interface AutoVerifyCandidate {
  schemaVersion: 1;
  taskId: string;
  snapshotDigest: string;
  commandId: string;
  command: string;
  commandExecutable: string;
  commandArgs: string[];
  commandCwd: string;
  targetPaths: string[];
  source: "explicit" | "authoritative-test-edge" | "derived-impact" | "heuristic" | "legacy";
  rank: number;
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
  provenance?: TestRecommendationProvenance;
  command?: string;
  commandCwd?: string;
  commandExecutable?: string;
  commandArgs?: string[];
  commandSource?: string;
  commandConfidence?: Confidence;
}

export type TestRecommendationProvenanceSource =
  | "explicit_target"
  | "authoritative_test_edge"
  | "derived_import"
  | "derived_impact_expansion"
  | "heuristic_match"
  | "package_import"
  | "natural_retrieval"
  | "snapshot_legacy"
  | "outcome_history";

export type TestRecommendationProvenanceOrigin = "current" | "context" | "snapshot" | "outcome";

export interface TestRecommendationProvenance {
  schemaVersion: 1;
  origin: TestRecommendationProvenanceOrigin;
  sources: TestRecommendationProvenanceSource[];
  targetPaths: string[];
  evidence: string[];
  degraded?: boolean;
  degradedReason?: string;
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

export type VerificationLedgerStatus = "covered" | "missing" | "waived" | "not_applicable" | "would_cover";

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
  // "hook-implicit" marks an auto-saved pre-edit baseline with no declared
  // plan scope; absent means an explicit change_plan snapshot.
  origin?: "hook-implicit";
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
