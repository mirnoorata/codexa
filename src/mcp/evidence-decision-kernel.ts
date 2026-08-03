import { isRecord, structuredByteLength } from "./compaction-helpers.js";

type EvidenceDecisionTier = "narrow" | "emergency" | "terminal";

export function renderKernelEvidence(value: Record<string, unknown>): string | undefined {
  const chainCount = typeof value.chainCount === "number" ? value.chainCount : arrayCount(value.chains);
  const gapCount = typeof value.gapCount === "number" ? value.gapCount : arrayCount(value.gaps);
  const analyzedTargetCount = numeric(value.analyzedTargetCount);
  const representedTargetCount = numeric(value.representedTargetCount);
  const omittedTargetCount = numeric(value.omittedTargetCount) ?? 0;
  const chainTruncatedCount = numeric(value.chainTruncatedCount) ?? 0;
  const traversalCapped = value.traversalCapped === true;
  if (chainCount === 0 && gapCount === 0 && omittedTargetCount === 0) return undefined;
  const chains = Array.isArray(value.chains) ? value.chains.filter(isRecord) : [];
  const top = chains[0];
  const topSummary = top ? boundedString(top.summary, 160) : undefined;
  const targets = analyzedTargetCount === undefined
    ? ""
    : representedTargetCount === undefined
      ? ` across ${analyzedTargetCount} analyzed target(s)`
      : ` across ${representedTargetCount} of ${analyzedTargetCount} analyzed target(s)`;
  const omitted = omittedTargetCount > 0 ? `; ${omittedTargetCount} omitted` : "";
  const bounded = traversalCapped || chainTruncatedCount > 0 || value.truncated === true
    ? `; bounded${traversalCapped ? " traversal capped" : ""}${chainTruncatedCount > 0 ? `, ${chainTruncatedCount} chain(s) truncated` : ""}`
    : "";
  return `Causal evidence: ${chainCount} chain(s)${targets}; ${gapCount} gap(s)${omitted}${bounded}${topSummary ? `; ${topSummary}` : ""}`;
}

export function targetRoleDecisionScope(value: unknown): Record<string, unknown> {
  return isRecord(value) ? { editableTargetCount: arrayCount(value.editableTargets), editableTargets: kernelStrings(value.editableTargets, 6), readDependencyCount: arrayCount(value.readDependencies), readDependencies: kernelStrings(value.readDependencies, 6), excludedTargetCount: arrayCount(value.excludedTargets), excludedTargets: kernelStrings(value.excludedTargets, 6), hasReferenceCue: value.hasReferenceCue, unresolvedReferenceCue: value.unresolvedReferenceCue } : {};
}

export function evidenceChainDecisionKernel(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  const chains = Array.isArray(value.chains) ? value.chains.filter(isRecord) : [];
  const gaps = [...kernelStrings(value.gaps, 4), ...chains.flatMap((chain) => kernelStrings(chain.gaps, 4))].filter((gap, index, all) => all.indexOf(gap) === index);
  const chainCount = typeof value.chainCount === "number" ? value.chainCount : chains.length;
  const projectedChains = chains.slice(0, 2).map((chain) => compactChainIdentity(chain, "narrow"));
  const chainTruncatedCount = numeric(value.chainTruncatedCount) ?? chains.filter((chain) => isRecord(chain.truncated) && Object.keys(chain.truncated).length > 0).length;
  const chainsWithGaps = numeric(value.chainsWithGaps) ?? chains.filter((chain) => Array.isArray(chain.gaps) && chain.gaps.length > 0).length;
  const gapCount = numeric(value.gapCount) ?? gaps.length;
  return definedRecord({
    chainCount,
    chainsOmitted: Math.max(0, chainCount - projectedChains.length),
    requestedTargetCount: numeric(value.requestedTargetCount),
    analyzedTargetCount: numeric(value.analyzedTargetCount),
    representedTargetCount: numeric(value.representedTargetCount),
    unrepresentedTargetCount: numeric(value.unrepresentedTargetCount),
    omittedTargetCount: numeric(value.omittedTargetCount),
    truncated: (isRecord(value.truncation) && Object.keys(value.truncation).length > 0) || chainTruncatedCount > 0,
    traversalCapped: value.traversalCapped ?? (isRecord(value.traversal) ? value.traversal.capped : undefined),
    chainTruncatedCount,
    chainsWithGaps,
    gapCount,
    gaps: gaps.slice(0, 2),
    chains: projectedChains
  });
}

/**
 * Evidence is advisory. Keep its provenance identity and exact counts while
 * shrinking it independently from lifecycle authority.
 */
export function compactEvidenceDecisionSection(value: unknown, tier: EvidenceDecisionTier): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  const sourceChains = Array.isArray(value.chains) ? value.chains.filter(isRecord) : [];
  const chainCount = numeric(value.chainCount) ?? sourceChains.length;
  const limit = tier === "narrow" ? 2 : 1;
  const chains = sourceChains.slice(0, limit).map((chain) => compactChainIdentity(chain, tier));
  const existingOmitted = numeric(value.chainsOmitted) ?? 0;
  const gapCount = numeric(value.gapCount) ?? arrayCount(value.gaps);
  const gapLimit = tier === "narrow" ? 2 : tier === "emergency" ? 1 : 0;
  return definedRecord({
    chainCount,
    chainsOmitted: Math.max(existingOmitted, chainCount - chains.length),
    requestedTargetCount: numeric(value.requestedTargetCount),
    analyzedTargetCount: numeric(value.analyzedTargetCount),
    representedTargetCount: numeric(value.representedTargetCount),
    unrepresentedTargetCount: numeric(value.unrepresentedTargetCount),
    omittedTargetCount: numeric(value.omittedTargetCount),
    truncated: value.truncated === true,
    traversalCapped: value.traversalCapped === true,
    chainTruncatedCount: numeric(value.chainTruncatedCount),
    chainsWithGaps: numeric(value.chainsWithGaps),
    gapCount,
    gaps: kernelStrings(value.gaps, gapLimit),
    chains
  });
}

export function withCompactedDecisionEvidence(kernel: Record<string, unknown>, tier?: EvidenceDecisionTier): Record<string, unknown> {
  return definedRecord({ ...kernel, evidence: tier ? compactEvidenceDecisionSection(kernel.evidence, tier) : undefined });
}

/** Returns a same-authority kernel when only advisory evidence exceeds the cap. */
export function fitEvidenceWithinKernelBudget(kernel: Record<string, unknown>, targetBytes: number): Record<string, unknown> | undefined {
  if (kernel.evidence === undefined) return undefined;
  const authorityKernel = definedRecord({ ...kernel, evidence: undefined });
  if (structuredByteLength(authorityKernel) > targetBytes) return undefined;
  for (const tier of ["narrow", "emergency", "terminal"] as const) {
    const candidate = definedRecord({ ...authorityKernel, evidence: compactEvidenceDecisionSection(kernel.evidence, tier) });
    if (structuredByteLength(candidate) <= targetBytes) return candidate;
  }
  return authorityKernel;
}

/** Candidate delivery packets ordered from provenance-preserving to smallest. */
export function evidenceReducedDeliveryVariants(delivered: Record<string, unknown>, kernel: Record<string, unknown>): Record<string, unknown>[] {
  if (delivered.evidenceChains === undefined && kernel.evidence === undefined) return [];
  const reducedKernel = definedRecord({ ...kernel, evidence: compactEvidenceDecisionSection(kernel.evidence, "terminal") });
  const reduced = definedRecord({ ...delivered, evidenceChains: undefined, decisionKernel: reducedKernel });
  return [reduced, definedRecord({ ...reduced, decisionKernel: definedRecord({ ...reducedKernel, evidence: undefined }) })];
}

function compactChainIdentity(chain: Record<string, unknown>, tier: EvidenceDecisionTier): Record<string, unknown> {
  const anchor = isRecord(chain.anchor) ? chain.anchor : undefined;
  const roles = isRecord(chain.roles) ? chain.roles : undefined;
  const summaryLimit = tier === "narrow" ? 120 : tier === "emergency" ? 80 : 0;
  return definedRecord({
    chainId: boundedString(chain.chainId, 96),
    purpose: boundedString(chain.purpose, 32),
    summary: summaryLimit > 0 ? boundedString(chain.summary, summaryLimit) : undefined,
    confidence: boundedString(chain.confidence, 24),
    anchorPath: boundedString(chain.anchorPath ?? anchor?.path, tier === "narrow" ? 160 : 96),
    authority: boundedString(chain.authority ?? anchor?.authority, 32),
    editTargetCount: numeric(chain.editTargetCount) ?? arrayCount(roles?.editTargets),
    readDependencyCount: numeric(chain.readDependencyCount) ?? arrayCount(roles?.readDependencies),
    verifyTargetCount: numeric(chain.verifyTargetCount) ?? arrayCount(roles?.verifyTargets)
  });
}

function kernelStrings(value: unknown, limit: number): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string").slice(0, limit).map((entry) => entry.slice(0, 220)) : [];
}

function boundedString(value: unknown, limit = 220): string | undefined {
  return typeof value === "string" && value.length > 0 ? value.slice(0, limit) : undefined;
}

function definedRecord(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined && (!Array.isArray(entry) || entry.length > 0) && (!isRecord(entry) || Object.keys(entry).length > 0)));
}

function arrayCount(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

function numeric(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
