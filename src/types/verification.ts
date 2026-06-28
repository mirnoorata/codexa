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
