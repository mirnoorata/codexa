import type { Confidence, EdgeEvidenceV1 } from "./facts.js";
import type { TestRecommendation } from "./verification.js";

export const CHANGE_EVIDENCE_LIMITS = {
  maxChains: 3,
  maxSegmentsPerChain: 6,
  maxDepth: 4,
  maxPathsPerChain: 12,
  maxTestsPerChain: 4,
  maxGaps: 4,
  maxVisitedNodes: 4_096,
  maxExaminedEdges: 16_384
} as const;

export const CHANGE_EVIDENCE_TEXT_LIMITS = {
  path: 500,
  summary: 320,
  reason: 500,
  command: 2_000,
  subsystemLabel: 240,
  gap: 240
} as const;

export interface ChangeEvidenceTruncationCountV1 {
  total: number;
  returned: number;
  /** False means total is the observed lower bound because traversal was capped. */
  exact?: boolean;
}

export type ChangeEvidencePurpose = "runtime" | "blast-radius" | "verification" | "risk";
export type ChangeEvidenceAnchorAuthority =
  | "explicit-target"
  | "orientation-candidate"
  | "observed-edit"
  | "committed-change"
  | "proof-target";

export type ChangeEvidenceTestV1 = Pick<
  TestRecommendation,
  "path" | "reason" | "evidenceTier" | "command" | "commandCwd"
>;

export interface ChangeEvidenceChainV1 {
  schemaVersion: 1;
  chainId: string;
  purpose: ChangeEvidencePurpose;
  summary: string;
  confidence: Confidence;
  anchor: {
    candidateId?: string;
    path: string;
    symbolId?: string;
    authority: ChangeEvidenceAnchorAuthority;
  };
  subsystem?: {
    kind: "workflow" | "module";
    id: string;
    label: string;
    confidence: Confidence;
  };
  /** Original graph direction and provenance are retained on every segment. */
  segments: EdgeEvidenceV1[];
  roles: {
    /** Chain-local paths copied from caller-provided authority; never inferred. */
    editTargets: string[];
    readDependencies: string[];
    verifyTargets: string[];
  };
  tests: ChangeEvidenceTestV1[];
  gaps: string[];
  truncated?: {
    segments?: ChangeEvidenceTruncationCountV1;
    paths?: ChangeEvidenceTruncationCountV1;
    tests?: ChangeEvidenceTruncationCountV1;
  };
}

export interface ChangeEvidenceBundleV1 {
  schemaVersion: 1;
  snapshotId: string;
  taskFingerprint: string;
  fingerprint: string;
  requestedTargetCount: number;
  analyzedTargetCount: number;
  omittedTargetCount: number;
  /** Present on current writers; optional so schema-v1 snapshots remain readable. */
  representedTargetCount?: number;
  unrepresentedTargetCount?: number;
  chains: ChangeEvidenceChainV1[];
  limits: typeof CHANGE_EVIDENCE_LIMITS;
  traversal: {
    visitedNodes: number;
    examinedEdges: number;
    capped: boolean;
  };
  gaps: string[];
  truncation?: {
    targets?: ChangeEvidenceTruncationCountV1;
    chains?: ChangeEvidenceTruncationCountV1;
  };
}

/** Strict enough for repository-carried portable task snapshots. */
export function isChangeEvidenceBundleV1(value: unknown): value is ChangeEvidenceBundleV1 {
  if (!record(value) || value.schemaVersion !== 1) return false;
  if (!boundedId(value.snapshotId, 160) || !stableFingerprint(value.taskFingerprint) || !stableFingerprint(value.fingerprint)) return false;
  if (!boundedCount(value.requestedTargetCount) || !boundedCount(value.analyzedTargetCount) || !boundedCount(value.omittedTargetCount)) return false;
  if (value.analyzedTargetCount > value.requestedTargetCount || value.omittedTargetCount !== value.requestedTargetCount - value.analyzedTargetCount) return false;
  if ((value.representedTargetCount === undefined) !== (value.unrepresentedTargetCount === undefined)) return false;
  if (value.representedTargetCount !== undefined && (!boundedCount(value.representedTargetCount, value.analyzedTargetCount)
    || !boundedCount(value.unrepresentedTargetCount, value.analyzedTargetCount)
    || value.unrepresentedTargetCount !== value.analyzedTargetCount - value.representedTargetCount)) return false;
  if (!sameLimits(value.limits) || !validTraversal(value.traversal)) return false;
  if (!Array.isArray(value.chains) || value.chains.length > CHANGE_EVIDENCE_LIMITS.maxChains || !value.chains.every(validChain)) return false;
  if (!boundedStrings(value.gaps, CHANGE_EVIDENCE_LIMITS.maxGaps, CHANGE_EVIDENCE_TEXT_LIMITS.gap)) return false;
  return value.truncation === undefined || validBundleTruncation(value.truncation);
}

export function isPlanSnapshotChangeEvidenceBundleV1(value: unknown, snapshotId: unknown, plannedEditTargets: unknown): boolean {
  if (value === undefined) return true;
  if (!isChangeEvidenceBundleV1(value) || !Array.isArray(plannedEditTargets)) return false;
  const planned = new Set(plannedEditTargets.filter((entry): entry is string => typeof entry === "string"));
  return value.snapshotId === snapshotId && value.chains.every((chain) => chain.anchor.authority === "explicit-target"
    && planned.has(chain.anchor.path) && chain.roles.editTargets.includes(chain.anchor.path)
    && chain.roles.editTargets.every((filePath) => planned.has(filePath)));
}

function validChain(value: unknown): value is ChangeEvidenceChainV1 {
  if (!record(value) || value.schemaVersion !== 1 || !stableFingerprint(value.chainId)) return false;
  if (!["runtime", "blast-radius", "verification", "risk"].includes(String(value.purpose))) return false;
  if (!boundedId(value.summary, CHANGE_EVIDENCE_TEXT_LIMITS.summary) || !confidence(value.confidence) || !validAnchor(value.anchor)) return false;
  if (value.subsystem !== undefined && !validSubsystem(value.subsystem)) return false;
  if (!Array.isArray(value.segments) || value.segments.length > CHANGE_EVIDENCE_LIMITS.maxSegmentsPerChain || !value.segments.every(validEdgeEvidence)) return false;
  if (!validRoles(value.roles) || !validTests(value.tests) || !boundedStrings(value.gaps, CHANGE_EVIDENCE_LIMITS.maxGaps, CHANGE_EVIDENCE_TEXT_LIMITS.gap)) return false;
  return value.truncated === undefined || validChainTruncation(value.truncated);
}

function validAnchor(value: unknown): boolean {
  return record(value)
    && safeRepoPath(value.path)
    && (value.candidateId === undefined || boundedId(value.candidateId, 160))
    && (value.symbolId === undefined || boundedId(value.symbolId, 240))
    && ["explicit-target", "orientation-candidate", "observed-edit", "committed-change", "proof-target"].includes(String(value.authority));
}

function validSubsystem(value: unknown): boolean {
  return record(value)
    && (value.kind === "workflow" || value.kind === "module")
    && boundedId(value.id, 200)
    && boundedId(value.label, CHANGE_EVIDENCE_TEXT_LIMITS.subsystemLabel)
    && confidence(value.confidence);
}

function validEdgeEvidence(value: unknown): boolean {
  if (!record(value) || value.schemaVersion !== 1) return false;
  return boundedId(value.id, 200)
    && boundedId(value.edgeKind, 80)
    && boundedId(value.fromId, 240)
    && boundedId(value.toId, 240)
    && (value.fromPath === undefined || safeRepoPath(value.fromPath))
    && (value.toPath === undefined || safeRepoPath(value.toPath))
    && (value.fromSymbolId === undefined || boundedId(value.fromSymbolId, 240))
    && (value.toSymbolId === undefined || boundedId(value.toSymbolId, 240))
    && boundedId(value.source, 80)
    && confidence(value.confidence)
    && boundedId(value.reason, CHANGE_EVIDENCE_TEXT_LIMITS.reason)
    && typeof value.degraded === "boolean"
    && typeof value.stale === "boolean"
    && (value.range === undefined || validRange(value.range));
}

function validRoles(value: unknown): boolean {
  return record(value)
    && boundedPaths(value.editTargets, CHANGE_EVIDENCE_LIMITS.maxPathsPerChain)
    && boundedPaths(value.readDependencies, CHANGE_EVIDENCE_LIMITS.maxPathsPerChain)
    && boundedPaths(value.verifyTargets, CHANGE_EVIDENCE_LIMITS.maxTestsPerChain);
}

function validTests(value: unknown): boolean {
  return Array.isArray(value) && value.length <= CHANGE_EVIDENCE_LIMITS.maxTestsPerChain && value.every((entry) => {
    if (!record(entry) || !safeRepoPath(entry.path) || !boundedId(entry.reason, CHANGE_EVIDENCE_TEXT_LIMITS.reason)) return false;
    return (entry.evidenceTier === undefined || ["authoritative", "derived", "heuristic", "fallback"].includes(String(entry.evidenceTier)))
      && (entry.command === undefined || boundedId(entry.command, CHANGE_EVIDENCE_TEXT_LIMITS.command))
      && (entry.commandCwd === undefined || (entry.commandCwd === "." || safeRepoPath(entry.commandCwd)));
  });
}

function validTraversal(value: unknown): boolean {
  return record(value)
    && boundedCount(value.visitedNodes, CHANGE_EVIDENCE_LIMITS.maxVisitedNodes)
    && boundedCount(value.examinedEdges, CHANGE_EVIDENCE_LIMITS.maxExaminedEdges)
    && typeof value.capped === "boolean";
}

function sameLimits(value: unknown): boolean {
  return record(value) && Object.entries(CHANGE_EVIDENCE_LIMITS).every(([key, expected]) => value[key] === expected);
}

function validBundleTruncation(value: unknown): boolean {
  return record(value)
    && Object.keys(value).every((key) => key === "targets" || key === "chains")
    && (value.targets === undefined || validTruncationCount(value.targets))
    && (value.chains === undefined || validTruncationCount(value.chains));
}

function validChainTruncation(value: unknown): boolean {
  return record(value)
    && Object.keys(value).every((key) => key === "segments" || key === "paths" || key === "tests")
    && (value.segments === undefined || validTruncationCount(value.segments))
    && (value.paths === undefined || validTruncationCount(value.paths))
    && (value.tests === undefined || validTruncationCount(value.tests));
}

function validTruncationCount(value: unknown): boolean {
  return record(value)
    && Object.keys(value).every((key) => key === "total" || key === "returned" || key === "exact")
    && boundedCount(value.total)
    && boundedCount(value.returned)
    && value.returned <= value.total
    && (value.exact === undefined || typeof value.exact === "boolean");
}

function validRange(value: unknown): boolean {
  return record(value)
    && [value.startLine, value.endLine, value.startByte, value.endByte].every((entry) => Number.isSafeInteger(entry) && entry >= 0)
    && value.endLine >= value.startLine
    && value.endByte >= value.startByte;
}

function boundedPaths(value: unknown, limit: number): boolean {
  return Array.isArray(value) && value.length <= limit && value.every(safeRepoPath) && new Set(value).size === value.length;
}

function boundedStrings(value: unknown, limit: number, length: number): boolean {
  return Array.isArray(value) && value.length <= limit && value.every((entry) => boundedId(entry, length));
}

function safeRepoPath(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= CHANGE_EVIDENCE_TEXT_LIMITS.path
    && !value.startsWith("/")
    && !/^[A-Za-z]:[\\/]/u.test(value)
    && !/[\u0000-\u001f\u007f]/u.test(value)
    && !value.split(/[\\/]/u).some((segment) => segment === "." || segment === "..");
}

function stableFingerprint(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{16}$/u.test(value);
}

function boundedId(value: unknown, limit: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= limit && !/[\u0000-\u001f\u007f]/u.test(value);
}

function confidence(value: unknown): value is Confidence {
  return value === "authoritative" || value === "derived" || value === "heuristic";
}

function boundedCount(value: unknown, limit = Number.MAX_SAFE_INTEGER): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= limit;
}

function record(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
