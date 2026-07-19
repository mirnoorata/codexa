import type { Confidence, EvidenceTier, Range, SymbolFact } from "./facts.js";
import type { ChangeType } from "./change.js";
import type { ChangePlanInput } from "./inputs.js";
import type { FreshnessInfo } from "./runtime.js";
import type { ChangedFileEntry, TestRecommendation } from "./verification.js";

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

export interface TaskInvariant {
  id: string;
  statement: string;
}

export interface TaskInvariantReview {
  invariantId: string;
  status: "satisfied" | "violated";
  evidence: string[];
}

export interface DiffFootprintV1 {
  schemaVersion: 1;
  trackedInsertions: number | null;
  trackedDeletions: number | null;
  changedFileCount: number;
  modifiedSymbolCount: number;
  untrackedFileCount: number;
  fingerprint: string;
  degradedReasons: string[];
  contentHashes?: Record<string, string>;
  contentHashDegradedReasons?: string[];
}

export type TaskLoopFailureClass =
  | "plan-drift"
  | "context-unreliable"
  | "verification-missing"
  | "verification-failed"
  | "required-check-missing"
  | "risk-escalation"
  | "invariant-unreviewed"
  | "invariant-violated"
  | "external-check-failed";

export interface TaskLoopFailureSignal {
  class: TaskLoopFailureClass;
  fingerprint: string;
  targets: string[];
}

export interface TaskLoopReview {
  policyVersion: "task-loop-v1";
  attemptId: string;
  attemptStatus: "resolved" | "unresolved";
  totalDistinctAttempts: number;
  attemptsSincePlan: number;
  unresolvedAttemptsSincePlan: number;
  recurringFailures: Array<{
    class: TaskLoopFailureClass;
    fingerprint: string;
    count: number;
  }>;
  cumulativeDiffGrowth: {
    firstTrackedLines: number | null;
    currentTrackedLines: number | null;
    peakTrackedLines: number | null;
    newFilesSinceFirstAttempt: number;
    peakModifiedSymbols: number;
  };
  status: "within-budget" | "replan-required";
  reasons: string[];
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
  planRevision?: number;
  publicationSequence?: number;
  invariants?: TaskInvariant[];
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
  diffFootprint?: DiffFootprintV1;
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
