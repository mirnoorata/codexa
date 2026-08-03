import type { Confidence, EvidenceTier, LanguageId, SymbolFact } from "./facts.js";

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

export type VerificationTestRunner = "vitest" | "jest" | "node-test" | "playwright" | "cypress";

export type VerificationLedgerStatus = "covered" | "missing" | "waived" | "not_applicable" | "would_cover";

export type VerificationTrustTier = "executed-by-autoverify" | "witnessed" | "artifact-corroborated" | "reported" | "none";

export type VerificationArtifactRunOutcome = "passed" | "failed" | "cancelled" | "timed_out" | "unknown";
export type VerificationArtifactCheckOutcome = "passed" | "failed" | "skipped" | "unknown";

export interface VerificationArtifactManifest {
  schemaVersion: 1;
  kind: "codexa-verification-summary";
  binding: {
    taskId: string;
    headCommit: string | null;
    workspaceStateDigest: string;
  };
  run: {
    id: string;
    category: string;
    outcome: VerificationArtifactRunOutcome;
    startedAt?: string;
    finishedAt?: string;
    durationMs?: number;
  };
  checks: Array<{
    kind: "workflow" | "dependency";
    target: string;
    outcome: VerificationArtifactCheckOutcome;
    summary?: string;
  }>;
  attachments?: Array<{
    name: string;
    sha256?: string;
    sizeBytes?: number;
    mediaType?: string;
  }>;
  producer?: {
    name: string;
    version?: string;
  };
}

export interface VerificationArtifactRecord {
  schemaVersion: 1;
  artifactId: string;
  ingestedAt: string;
  sourceSha256: string;
  manifest: VerificationArtifactManifest;
}

export interface VerificationArtifactSummary {
  artifactId: string;
  runId?: string;
  category?: string;
  outcome?: VerificationArtifactRunOutcome;
  status: "accepted" | "non_passing" | "missing" | "invalid" | "unbound" | "conflicting";
  trustTier: VerificationTrustTier;
  reasons: string[];
  checks: Array<{
    kind: "workflow" | "dependency";
    target: string;
    outcome: VerificationArtifactCheckOutcome;
  }>;
}

export interface VerificationArtifactLedgerEvidence {
  kind: "workflow" | "dependency";
  target: string;
  status: "covered" | "conflicting";
  trustTier: Extract<VerificationTrustTier, "reported" | "none">;
  artifactIds: string[];
  evidence: string[];
}

export const VERIFICATION_PROVENANCE_SCHEMA_VERSION = 1 as const;
export const VERIFICATION_COMMAND_COVERAGE_CLASSIFIER_VERSION = "command-coverage-v7";
export const VERIFICATION_COMMAND_ENVELOPE_RULESET_VERSION = "command-envelope-v2";
export const VERIFICATION_COVERAGE_VERSION = "verification-coverage-v5";
export const VERIFICATION_LEDGER_VERSION = "verification-ledger-v4";

export interface VerificationProvenance {
  schemaVersion: typeof VERIFICATION_PROVENANCE_SCHEMA_VERSION;
  commandCoverageClassifier: "codexa-command-coverage";
  commandCoverageClassifierVersion: string;
  commandEnvelopeRulesetVersion: string;
  verificationCoverageVersion: string;
  verificationLedgerVersion: string;
}

export const CURRENT_VERIFICATION_PROVENANCE: VerificationProvenance = {
  schemaVersion: VERIFICATION_PROVENANCE_SCHEMA_VERSION,
  commandCoverageClassifier: "codexa-command-coverage",
  commandCoverageClassifierVersion: VERIFICATION_COMMAND_COVERAGE_CLASSIFIER_VERSION,
  commandEnvelopeRulesetVersion: VERIFICATION_COMMAND_ENVELOPE_RULESET_VERSION,
  verificationCoverageVersion: VERIFICATION_COVERAGE_VERSION,
  verificationLedgerVersion: VERIFICATION_LEDGER_VERSION
};

export interface VerificationCoverage {
  kind: VerificationCoverageKind;
  command: string;
  source: string;
  confidence: Confidence;
  trustTier: VerificationTrustTier;
  scope?: string;
  targetPath?: string;
  testRunner?: VerificationTestRunner;
  details: string[];
  exitCode?: number;
  durationMs?: number;
  outputSummary?: string;
  commandEnvelope?: VerificationCommandEnvelope;
}

export type PostEditReviewCoverageStatus = "complete" | "partial";

export interface PostEditReviewCoverageBinding {
  taskId: string | null;
  planRevision: number;
  snapshotCreatedAt: string | null;
  snapshotPublicationSequence: number | null;
  candidateTargetsDigest: string;
  analyzedTargetsDigest: string;
}

/**
 * Bounded authority receipt for post-edit review. Individual omitted paths
 * stay internal; consumers validate the counts, exhaustive logical pass count,
 * and binding to the task snapshot and analyzed targets instead of copying the
 * full change set. Candidate count shares the task-lifecycle 2,000-file limit.
 */
interface PostEditReviewCoverageBase {
  binding: PostEditReviewCoverageBinding;
  status: PostEditReviewCoverageStatus;
  candidateTargetCount: number;
  analyzedTargetCount: number;
  omittedTargetCount: number;
  targetLimit: number;
}

export interface PostEditReviewCoverageV1 extends PostEditReviewCoverageBase {
  schemaVersion: 1;
  analysisPassCount?: never;
}

export interface PostEditReviewCoverageV2 extends PostEditReviewCoverageBase {
  schemaVersion: 2;
  analysisPassCount: number;
}

export type PostEditReviewCoverage = PostEditReviewCoverageV1 | PostEditReviewCoverageV2;

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
  trustTier: VerificationTrustTier;
}

export interface VerificationLedgerEntry {
  kind: "test" | "workflow" | "dependency";
  recommended: string;
  target: string;
  status: VerificationLedgerStatus;
  trustTier: VerificationTrustTier;
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
