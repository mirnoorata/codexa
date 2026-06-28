import type { CodexaFact, FileFact, GraphEdgeFact, ImportEdgeFact, LanguageId, ModuleClusterFact, ParserErrorFact, RepoSnapshotFact, RiskSignalFact, SymbolFact, TestEdgeFact, UsageSiteFact, WorkflowTraceFact } from "./facts.js";

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
