import type { EvidenceTier, FileFact, GraphEdgeFact, SymbolFact, WorkflowTraceFact } from "./facts.js";
import type { ChangeType } from "./change.js";
import type { GuidedNextToolV1 } from "./runtime.js";
import type { TaskSnapshot, TaskSnapshotRequiredCheck } from "./snapshots.js";
import type { ChangedFileEntry, DiffImpactGroup, TestRecommendation, VerificationCommandEnvelope, VerificationCommandPlanEntry, VerificationCommandReport, VerificationCoverage, VerificationLedgerEntry, VerificationProvenance, VerificationWaiver } from "./verification.js";

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
  | "freshness"
  | "proof_card";

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
  actionability?: string;
  targetFiles?: string[];
  unindexedTargetFiles?: string[];
  rejectedTargetFiles?: string[];
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

export interface ProofCardData extends BaseQueryData {
  mode: "proof_card";
  actionability?: string;
  repoRoot?: string;
  freshness?: QueryObject;
  readFirst?: QueryObject[];
  snapshot?: QueryObject;
  verification?: QueryObject;
  policies?: QueryObject;
  trustPosture?: string[];
  nextCommands?: string[];
  gaps?: string[];
}

export type CodexaQueryData = ContextPacketData | FocusBriefData | ChangePlanData | PostEditReviewData | TestPlanData | ProofCardData;
