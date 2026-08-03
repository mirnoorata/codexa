import { compactTestRecommendation, isRecord, limitArray, type McpTruncation } from "./compaction-helpers.js";

export function withoutEvidenceTruncation(value: McpTruncation): McpTruncation {
  return Object.fromEntries(Object.entries(value).filter(([path]) => !/(?:^|\.)evidenceChains(?:\.|$)/u.test(path) && !/^decisionKernel\.evidence(?:\.|$)/u.test(path)));
}

export function compactEvidenceBundle(value: unknown, chainLimit = 3): unknown {
  if (!isRecord(value)) return value;
  const sourceChains = Array.isArray(value.chains) ? value.chains : undefined;
  const chains = sourceChains?.slice(0, chainLimit).map(compactEvidenceChain);
  const sourceTruncation = isRecord(value.truncation) ? value.truncation : {};
  return {
    schemaVersion: value.schemaVersion,
    snapshotId: value.snapshotId,
    taskFingerprint: value.taskFingerprint,
    fingerprint: value.fingerprint,
    chainCount: typeof value.chainCount === "number" ? value.chainCount : sourceChains?.length,
    requestedTargetCount: value.requestedTargetCount,
    analyzedTargetCount: value.analyzedTargetCount,
    omittedTargetCount: value.omittedTargetCount,
    representedTargetCount: value.representedTargetCount,
    unrepresentedTargetCount: value.unrepresentedTargetCount,
    chains,
    limits: value.limits,
    traversal: value.traversal,
    gaps: limitArray(value.gaps, 4),
    truncation: {
      ...sourceTruncation,
      ...(sourceChains && sourceChains.length > chainLimit
        ? { chains: truncationCount(sourceTruncation.chains, sourceChains.length, chainLimit) }
        : {})
    }
  };
}

export function compactEvidenceBundleSummary(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const chains = Array.isArray(value.chains) ? value.chains.filter(isRecord) : [];
  const gaps = [
    ...stringArray(value.gaps),
    ...chains.flatMap((chain) => stringArray(chain.gaps))
  ].filter((gap, index, all) => all.indexOf(gap) === index);
  const chainTruncatedCount = chains.filter((chain) => isRecord(chain.truncated) && Object.keys(chain.truncated).length > 0).length;
  const chainsWithGaps = chains.filter((chain) => stringArray(chain.gaps).length > 0).length;
  return {
    schemaVersion: value.schemaVersion,
    snapshotId: value.snapshotId,
    fingerprint: value.fingerprint,
    taskFingerprint: value.taskFingerprint,
    chainCount: typeof value.chainCount === "number" ? value.chainCount : chains.length,
    requestedTargetCount: value.requestedTargetCount,
    analyzedTargetCount: value.analyzedTargetCount,
    omittedTargetCount: value.omittedTargetCount,
    representedTargetCount: value.representedTargetCount,
    unrepresentedTargetCount: value.unrepresentedTargetCount,
    gapCount: typeof value.gapCount === "number" ? value.gapCount : gaps.length,
    chainTruncatedCount: typeof value.chainTruncatedCount === "number" ? value.chainTruncatedCount : chainTruncatedCount,
    chainsWithGaps: typeof value.chainsWithGaps === "number" ? value.chainsWithGaps : chainsWithGaps,
    traversalCapped: typeof value.traversalCapped === "boolean"
      ? value.traversalCapped
      : isRecord(value.traversal) && typeof value.traversal.capped === "boolean"
        ? value.traversal.capped
        : undefined,
    chains: chains.slice(0, 1).map(compactEvidenceChainIdentity),
    truncation: value.truncation
  };
}

function compactEvidenceChainIdentity(value: Record<string, unknown>): Record<string, unknown> {
  const anchor = isRecord(value.anchor) ? value.anchor : undefined;
  const roles = isRecord(value.roles) ? value.roles : undefined;
  return {
    chainId: value.chainId,
    purpose: value.purpose,
    summary: typeof value.summary === "string" ? value.summary.slice(0, 120) : undefined,
    confidence: value.confidence,
    anchorPath: anchor?.path,
    authority: anchor?.authority,
    editTargetCount: Array.isArray(roles?.editTargets) ? roles.editTargets.length : value.editTargetCount,
    readDependencyCount: Array.isArray(roles?.readDependencies) ? roles.readDependencies.length : value.readDependencyCount,
    verifyTargetCount: Array.isArray(roles?.verifyTargets) ? roles.verifyTargets.length : value.verifyTargetCount
  };
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

export function compactEvidenceChain(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const segments = Array.isArray(value.segments) ? value.segments : undefined;
  const tests = Array.isArray(value.tests) ? value.tests : undefined;
  const sourceTruncated = isRecord(value.truncated) ? value.truncated : {};
  return {
    schemaVersion: value.schemaVersion,
    chainId: value.chainId,
    purpose: value.purpose,
    summary: value.summary,
    confidence: value.confidence,
    anchor: isRecord(value.anchor)
      ? {
          candidateId: value.anchor.candidateId,
          path: value.anchor.path,
          symbolId: value.anchor.symbolId,
          authority: value.anchor.authority
        }
      : undefined,
    subsystem: isRecord(value.subsystem)
      ? {
          kind: value.subsystem.kind,
          id: value.subsystem.id,
          label: value.subsystem.label,
          confidence: value.subsystem.confidence
        }
      : undefined,
    segments: segments?.slice(0, 6).map(compactEvidenceSegment),
    roles: isRecord(value.roles)
      ? {
          editTargets: limitArray(value.roles.editTargets, 12),
          readDependencies: limitArray(value.roles.readDependencies, 12),
          verifyTargets: limitArray(value.roles.verifyTargets, 4)
        }
      : undefined,
    tests: tests?.slice(0, 4).map(compactTestRecommendation),
    gaps: limitArray(value.gaps, 4),
    truncated: {
      ...sourceTruncated,
      ...(segments && segments.length > 6 ? { segments: truncationCount(sourceTruncated.segments, segments.length, 6) } : {}),
      ...(tests && tests.length > 4 ? { tests: truncationCount(sourceTruncated.tests, tests.length, 4) } : {})
    }
  };
}

export function compactEvidenceSegment(value: unknown): unknown {
  if (!isRecord(value)) return value;
  return {
    schemaVersion: value.schemaVersion,
    id: value.id,
    edgeKind: value.edgeKind,
    fromId: value.fromId,
    toId: value.toId,
    fromPath: value.fromPath,
    toPath: value.toPath,
    fromSymbolId: value.fromSymbolId,
    toSymbolId: value.toSymbolId,
    source: value.source,
    confidence: value.confidence,
    reason: value.reason,
    range: value.range,
    degraded: value.degraded,
    stale: value.stale
  };
}

function truncationCount(value: unknown, observedTotal: number, returned: number): { total: number; returned: number; exact?: boolean } {
  const priorTotal = isRecord(value) && typeof value.total === "number" ? value.total : 0;
  return { total: Math.max(priorTotal, observedTotal), returned, ...(isRecord(value) && value.exact === false ? { exact: false } : {}) };
}
