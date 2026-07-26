import type { QueryResult } from "../types.js";
import { createHash } from "node:crypto";
import { compactNextTools, isRecord, stringValue, structuredByteLength } from "./compaction-helpers.js";
import { capabilitiesDecisionKernel, compactCapabilitiesKernel, renderCapabilitiesKernel } from "./capability-kernel.js";
import { advancedModeDecisionKernel, compactAdvancedModeKernel, renderAdvancedModeKernel } from "./advanced-mode-kernel.js";
import { renderKernelGuidance, skillGuidanceKernel, terminalGuidanceKernel } from "./decision-guidance.js";
import { decisionEntryPath, mcpAuthorityBlockReason, mcpProofEscalationReason, modeRequiresExactKernelDetail, postEditReviewCoverageBlockReason, renderDecisionReadScope } from "./decision-policy.js";
import { postEditOutcomeKernel, reviewCoverageKernel } from "./review-coverage-kernel.js";

export type McpResponseFormat = "auto" | "concise" | "detailed";

export interface McpDeliveryMetadata {
  schemaVersion: 1;
  requestedFormat: McpResponseFormat;
  effectiveFormat: "concise" | "detailed";
  resultId?: string;
  resultUri?: string;
  /** False when persistence failed and only the self-contained decision kernel is available. */
  detailAvailable?: boolean;
  /** True when this operation cannot authorize action without the omitted detailed projection. */
  detailRequired?: boolean;
  requiredDetailReason?: string;
  unchangedReceipt?: boolean;
  escalationReason?: string;
}

const CONCISE_TEXT_MAX_LINES = 30;
const CONCISE_TEXT_MAX_CHARS = 2_400;
const TERMINAL_MODE_IDENTITY_KEYS = ["plannedEditTargets", "reviewTargets", "targetFiles", "focusFiles", "files", "symbols", "targetCandidates", "nextReads", "changedSinceSnapshot", "workflows", "rawHits"] as const;

export function conciseText(text: string): string {
  const lines = text.split(/\r?\n/);
  if (lines.length <= CONCISE_TEXT_MAX_LINES && text.length <= CONCISE_TEXT_MAX_CHARS) return text;
  let kept = lines.slice(0, CONCISE_TEXT_MAX_LINES).join("\n");
  if (kept.length > CONCISE_TEXT_MAX_CHARS) {
    const clipped = kept.slice(0, CONCISE_TEXT_MAX_CHARS);
    const lastNewline = clipped.lastIndexOf("\n");
    kept = lastNewline > 0 ? clipped.slice(0, lastNewline) : clipped;
  }
  const omittedLines = Math.max(0, lines.length - kept.split(/\r?\n/).length);
  const omittedNote = omittedLines > 0 ? `${omittedLines} more line(s) omitted; ` : "";
  return `${kept}\n[concise] ${omittedNote}call with responseFormat "detailed" for the full packet.`;
}

/** Mandatory decision surface projected from the un-compacted query result. */
export function mcpDecisionKernel(data: Record<string, unknown>, suppliedMode?: string, freshnessValue?: unknown): Record<string, unknown> {
  const mode = suppliedMode ?? (typeof data.mode === "string" ? data.mode : inferKernelMode(data)) ?? "unknown";
  const runtime = isRecord(data.runtime) ? data.runtime : isRecord(data.session) ? data.session : undefined;
  const freshness = isRecord(freshnessValue) ? freshnessValue : isRecord(data.freshness) ? data.freshness : undefined;
  const coverageBlockReason = postEditReviewCoverageBlockReason(data, mode);
  const inspectReasons = [
    ...(Array.isArray(data.inspectReasons) ? data.inspectReasons.filter((reason): reason is string => typeof reason === "string") : []),
    ...(coverageBlockReason ? [coverageBlockReason] : [])
  ];
  const authority = definedRecord({
    actionability: deriveMcpActionability(mode, data, Boolean(coverageBlockReason) || mcpAuthorityBlocked(data, freshnessValue)),
    verdict: coverageBlockReason ? "inspect" : boundedString(data.verdict),
    packetVerdict: boundedString(data.packetVerdict),
    completionAuthority: coverageBlockReason ? "blocking_inspect" : boundedString(data.completionAuthority),
    inspectMode: coverageBlockReason ? "blocking" : boundedString(data.inspectMode),
    inspectReasons: kernelStrings(inspectReasons, 5),
    editReadiness: kernelRecord(data.editReadiness, ["status", "editable", "reason", "source", "recommendedNextTool", "missingAnchors", "snapshotBlocked"])
  });
  const identity = definedRecord({
    task: boundedString(data.task, 240),
    query: boundedString(data.query, 240),
    taskId: boundedString(data.taskId, 160),
    snapshot: kernelRecord(data.snapshot, ["taskId", "path", "status", "reason", "createdAt", "planRevision", "headCommit"]),
    snapshotBlock: kernelRecord(data.snapshotBlock, ["taskId", "path", "status", "reason"]),
    snapshotLoad: kernelRecord(data.snapshotLoad, ["taskId", "path", "missingReason", "error", "recoveredLatest", "ambiguousLatest", "ambiguityReason"]),
    checkout: kernelRecord(runtime, ["repoRoot", "routingSource", "focusReason", "workspaceSessionId", "gitHead", "indexLoaded", "stale"]),
    freshness: kernelRecord(freshness, ["snapshotId", "repoRoot", "gitRoot", "headCommit", "indexedAt", "missing", "stale", "reason", "parserErrorCount"])
  });
  const gapCount = arrayCount(data.gaps);
  const gaps = kernelStrings(data.gaps, 6);
  const reviewCoverage = reviewCoverageKernel(data.reviewCoverage);
  const common = {
    schemaVersion: 1,
    mode,
    authority,
    identity,
    worktree: kernelRecord(data.worktree ?? runtime, ["knownClean", "degraded", "dirtyFileCount", "degradedReasons", "warnings", "provenance", "repoRoot", "gitHead", "routingSource", "workspaceSessionId"]),
    quality: kernelRecord(data.quality, ["level", "score", "confidence", "warnings", "reasons"]),
    reviewCoverage,
    gapCount,
    gaps,
    gapsOmitted: Math.max(0, gapCount - gaps.length),
    nextTools: kernelEntries(compactNextTools(data.nextTools), 4),
    systemMessage: boundedString(data.systemMessage, 240),
    verificationProvenance: boundedVerificationProvenance(data.verificationProvenance)
  };
  const kernel = definedRecord({ ...common, ...modeDecisionKernel(mode, data) });
  if (structuredByteLength(kernel) <= 3_200) return kernel;
  const narrowedGaps = kernelStrings(kernel.gaps, 3);
  const narrowed = definedRecord({
    schemaVersion: 1,
    mode,
    authority,
    identity: definedRecord({
      task: identity.task,
      query: identity.query,
      taskId: identity.taskId,
      snapshot: identity.snapshot,
      snapshotBlock: identity.snapshotBlock,
      snapshotLoad: identity.snapshotLoad,
      checkout: identity.checkout,
      freshness: identity.freshness
    }),
    worktree: common.worktree,
    reviewCoverage,
    guidance: narrowKernelSection(kernel.guidance),
    capabilities: compactCapabilitiesKernel(kernel.capabilities),
    advanced: compactAdvancedModeKernel(kernel.advanced, "narrow"),
    search: narrowKernelSection(kernel.search),
    scope: narrowKernelSection(kernel.scope),
    invariants: Array.isArray(kernel.invariants) ? kernel.invariants.slice(0, 16).map(compactDecisionInvariantStatus) : undefined,
    loop: kernel.loop,
    lifecycle: narrowKernelSection(kernel.lifecycle),
    decisionLog: narrowKernelSection(kernel.decisionLog),
    verification: narrowKernelSection(kernel.verification),
    failureSignals: Array.isArray(kernel.failureSignals) ? kernel.failureSignals.slice(0, 12) : undefined,
    outcome: narrowKernelSection(kernel.outcome),
    planRevision: kernel.planRevision,
    gapCount: kernel.gapCount,
    gaps: narrowedGaps,
    gapsOmitted: Math.max(0, gapCount - narrowedGaps.length),
    nextTools: common.nextTools,
    systemMessage: common.systemMessage,
    detailsRequired: modeRequiresExactKernelDetail(mode) || undefined
  });
  if (structuredByteLength(narrowed) <= 2_800) return narrowed;
  const emergency = emergencyDecisionKernel(narrowed);
  return structuredByteLength(emergency) <= 2_600 ? emergency : terminalDecisionKernel(emergency, modeRequiresExactKernelDetail(mode));
}

export function withMcpDelivery(result: QueryResult, delivery: McpDeliveryMetadata): QueryResult {
  if (!isRecord(result.data)) return result;
  const mode = typeof result.data.mode === "string" ? result.data.mode : inferKernelMode(result.data) ?? "unknown";
  const projected = isRecord(result.data.decisionKernel) ? result.data.decisionKernel : mcpDecisionKernel(result.data, mode, result.freshness);
  const detailBlocked = delivery.effectiveFormat === "concise"
    && (projected.detailsRequired === true || (delivery.detailRequired === true && delivery.detailAvailable === false));
  const kernel = detailBlocked
    ? failClosedDecisionKernel(projected, delivery.detailAvailable === false, delivery.requiredDetailReason)
    : projected;
  const authority = isRecord(kernel.authority) ? kernel.authority : {};
  const delivered = reconcileMcpReturnedBytes({
    ...result.data,
    ...(detailBlocked ? { nextTools: [], systemMessage: kernel.systemMessage } : {}),
    actionability: authority.actionability ?? result.data.actionability,
    delivery,
    decisionKernel: kernel
  });
  const targetBytes = mcpTargetBytes(delivered);
  if (targetBytes === undefined || structuredByteLength(delivered) <= targetBytes) {
    return { ...result, data: delivered };
  }
  // Once adding the delivery reference itself crosses the host budget, use
  // the intrinsically bounded terminal kernel. Omitting detail is an
  // authority boundary even when the pre-delivery kernel narrowly fit.
  const terminalKernel = compactTerminalDecisionKernel(kernel);
  const terminalAuthority = isRecord(terminalKernel.authority) ? terminalKernel.authority : {};
  const fallback = reconcileMcpReturnedBytes(definedRecord({
    mode,
    actionability: terminalAuthority.actionability ?? authority.actionability ?? "blocked",
    verdict: terminalAuthority.verdict,
    packetVerdict: terminalAuthority.packetVerdict,
    completionAuthority: terminalAuthority.completionAuthority,
    inspectMode: terminalAuthority.inspectMode,
    delivery,
    decisionKernel: terminalKernel,
    systemMessage: boundedString(result.data.systemMessage, 120),
    truncation: { "__mcp.deliveryBudget": { total: structuredByteLength(delivered), returned: targetBytes } },
    mcp: compactMcpMetrics(result.data.mcp, targetBytes)
  }));
  if (structuredByteLength(fallback) <= targetBytes) return { ...result, data: fallback };

  const absoluteKernel = absoluteTerminalDecisionKernel(terminalKernel);
  const absoluteAuthority = isRecord(absoluteKernel.authority) ? absoluteKernel.authority : {};
  const absolute = reconcileMcpReturnedBytes(definedRecord({
    mode,
    actionability: "blocked",
    verdict: absoluteAuthority.verdict,
    completionAuthority: absoluteAuthority.completionAuthority,
    delivery,
    decisionKernel: absoluteKernel,
    mcp: { compacted: true, targetBytes, hardBudgetEnforced: true, budgetCompaction: "delivery-terminal" }
  }));
  // MIN_MCP_STRUCTURED_DATA_TARGET_BYTES is 4KB; every string and collection
  // in this last tier has a fixed cap whose aggregate is below that floor.
  return { ...result, data: absolute };
}

export function mcpAuthorityBlocked(data: Record<string, unknown>, freshnessValue?: unknown): boolean {
  const freshness = isRecord(freshnessValue) ? freshnessValue : isRecord(data.freshness) ? data.freshness : undefined;
  return Boolean(mcpAuthorityBlockReason(data, freshness));
}

export function mcpAutoEscalationReason(result: QueryResult, input?: Record<string, unknown>): string | undefined {
  const data = isRecord(result.data) ? result.data : {};
  const freshness: Record<string, unknown> = isRecord(result.freshness) ? result.freshness : {};
  const kernelOverflow = mcpDecisionKernel(data, typeof data.mode === "string" ? data.mode : undefined, result.freshness).detailsRequired === true;
  const authorityBlockReason = mcpAuthorityBlockReason(data, freshness);
  if (authorityBlockReason) return authorityBlockReason;
  if (data.mode === "capabilities" && isRecord(data.described)) return "capability-schema-requested";
  const proofEscalationReason = mcpProofEscalationReason(data);
  if (proofEscalationReason) return proofEscalationReason;
  const actionability = stringValue(data.actionability);
  if (actionability === "blocked" || actionability === "needs_target") return `actionability:${actionability}`;
  if (input?.saveSnapshot === true && data.mode === "change_plan" && !isRecord(data.snapshot)) return "requested-snapshot-not-saved";
  if (kernelOverflow) return "decision-kernel-overflow";
  return undefined;
}

export function renderMcpConciseText(result: QueryResult): string {
  const data = isRecord(result.data) ? result.data : {};
  const kernel = isRecord(data.decisionKernel) ? data.decisionKernel : mcpDecisionKernel(data, undefined, result.freshness);
  const authority = isRecord(kernel.authority) ? kernel.authority : {};
  const identity = isRecord(kernel.identity) ? kernel.identity : {};
  const delivery = isRecord(kernel.delivery) ? kernel.delivery : isRecord(data.delivery) ? data.delivery : {};
  const invariants = Array.isArray(kernel.invariants) ? kernel.invariants : [];
  const loop = isRecord(kernel.loop) ? kernel.loop : undefined;
  const verification = isRecord(kernel.verification) ? kernel.verification : undefined;
  const reviewCoverage = isRecord(kernel.reviewCoverage) ? kernel.reviewCoverage : undefined;
  const guidance = isRecord(kernel.guidance) ? kernel.guidance : undefined;
  const invariantLine = renderKernelInvariants(invariants);
  const capabilityLines = renderCapabilitiesKernel(kernel.capabilities);
  const advancedLines = renderAdvancedModeKernel(kernel.advanced);
  const priorityLines = [
    `Codexa ${stringValue(kernel.mode) ?? "result"} (concise decision receipt)`,
    `Actionability: ${stringValue(authority.actionability) ?? "blocked"}`,
    stringValue(authority.verdict) ? `Verdict: ${stringValue(authority.verdict)}` : undefined,
    stringValue(authority.completionAuthority) ? `Completion authority: ${stringValue(authority.completionAuthority)}` : undefined,
    stringValue(authority.inspectMode) ? `Inspect mode: ${stringValue(authority.inspectMode)}` : undefined,
    ...capabilityLines,
    ...advancedLines,
    renderKernelIdentity(identity),
    renderDecisionReadScope(kernel.scope),
    guidance ? renderKernelGuidance(guidance) : undefined,
    verification ? renderKernelVerification(verification) : undefined,
    reviewCoverage
      ? `Review coverage: ${stringValue(reviewCoverage.status) ?? "unknown"}; ${String(reviewCoverage.analyzedTargetCount ?? "?")}/${String(reviewCoverage.candidateTargetCount ?? "?")} analyzed; ${String(reviewCoverage.omittedTargetCount ?? "?")} omitted`
      : undefined,
    renderKernelGaps(kernel),
    Array.isArray(kernel.nextTools) && kernel.nextTools.length > 0 ? `Next: ${kernel.nextTools.slice(0, 2).map((entry) => boundedReceiptValue(renderKernelEntry(entry), 160)).join(" | ")}` : stringValue(kernel.systemMessage) ? `Next: ${boundedReceiptValue(stringValue(kernel.systemMessage)!, 220)}` : undefined
  ].filter((line): line is string => Boolean(line));
  const descriptiveLines = [
    stringValue(identity.task) ? `Task: ${stringValue(identity.task)}` : stringValue(identity.query) ? `Query: ${stringValue(identity.query)}` : undefined,
    invariantLine,
    loop ? `Loop: ${boundedReceiptValue(stringValue(loop.status) ?? "unknown", 60)}${kernelStrings(loop.reasons, 2).length ? `; ${kernelStrings(loop.reasons, 2).map((value) => boundedReceiptValue(value, 120)).join("; ")}` : ""}` : undefined
  ].filter((line): line is string => Boolean(line));
  const tail = [
    delivery.unchangedReceipt === true ? "Detailed result: unchanged from the prior receipt." : undefined,
    stringValue(delivery.resultUri) ? `Detailed result: ${stringValue(delivery.resultUri)}` : undefined,
    delivery.detailAvailable === false && delivery.detailRequired === true
      ? "Required detailed result unavailable; retry once with responseFormat \"detailed\"."
      : delivery.detailAvailable === false
        ? "Detailed result unavailable; rely only on this bounded decision receipt."
        : undefined
  ].filter((line): line is string => Boolean(line));
  return fitConciseReceipt([...priorityLines, ...descriptiveLines], tail);
}

export function deriveMcpActionability(mode: string, data: Record<string, unknown>, blocked = false): string {
  if (blocked) return "blocked";
  const explicit = stringValue(data.actionability);
  if (explicit && ["orientation", "edit_ready", "blocked", "review", "verify", "done", "needs_target", "raw_search_better", "raw_search_sufficient", "inspect_first"].includes(explicit)) return explicit;
  if (mode === "post_edit_review") return "review";
  if (mode === "test_plan" || mode === "proof_card") return "verify";
  const editReadiness = isRecord(data.editReadiness) ? data.editReadiness : undefined;
  if (editReadiness?.editable === true || data.packetVerdict === "edit-ready") return "edit_ready";
  if (mode === "change_plan" && Array.isArray(data.plannedEditTargets) && data.plannedEditTargets.length > 0) return "edit_ready";
  return "orientation";
}

export function attachMcpDecisionKernel(record: Record<string, unknown>, kernel: Record<string, unknown>): Record<string, unknown> {
  const authority = isRecord(kernel.authority) ? kernel.authority : {};
  return definedRecord({
    ...record,
    actionability: authority.actionability ?? record.actionability,
    verdict: authority.verdict ?? record.verdict,
    packetVerdict: authority.packetVerdict ?? record.packetVerdict,
    editReadiness: authority.editReadiness ?? record.editReadiness,
    completionAuthority: authority.completionAuthority ?? record.completionAuthority,
    inspectMode: authority.inspectMode ?? record.inspectMode,
    inspectReasons: authority.inspectReasons ?? record.inspectReasons,
    decisionKernel: kernel
  });
}

export function compactDecisionInvariantStatus(value: unknown): unknown {
  if (!isRecord(value)) return value;
  return definedRecord({ id: boundedString(value.id, 120), status: boundedString(value.status, 80) ?? "unreviewed" });
}

export function decisionKernelStrings(value: unknown, limit: number): string[] {
  return kernelStrings(value, limit);
}

export function compactDecisionKernelSection(value: unknown): Record<string, unknown> | undefined {
  return narrowKernelSection(value);
}

export function compactTerminalDecisionKernel(kernel: Record<string, unknown>): Record<string, unknown> {
  const mode = stringValue(kernel.mode) ?? "unknown";
  return terminalDecisionKernel(emergencyDecisionKernel(kernel), modeRequiresExactKernelDetail(mode));
}

function narrowKernelSection(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  const narrowed: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string") narrowed[key] = boundedString(entry, 160);
    else if (typeof entry === "number" || typeof entry === "boolean" || entry === null) narrowed[key] = entry;
    else if (Array.isArray(entry)) narrowed[key] = entry.slice(0, 8).map(kernelEntry);
    else if (isRecord(entry)) narrowed[key] = kernelRecord(entry, Object.keys(entry).slice(0, 12));
  }
  return definedRecord(narrowed);
}

function emergencyDecisionKernel(kernel: Record<string, unknown>): Record<string, unknown> {
  const authority = isRecord(kernel.authority) ? kernel.authority : {};
  const identity = isRecord(kernel.identity) ? kernel.identity : {};
  const checkout = isRecord(identity.checkout) ? identity.checkout : {};
  const freshness = isRecord(identity.freshness) ? identity.freshness : {};
  const invariants = Array.isArray(kernel.invariants) ? kernel.invariants : [];
  const gaps = kernelStrings(kernel.gaps, 2);
  const gapCount = typeof kernel.gapCount === "number" ? kernel.gapCount : arrayCount(kernel.gaps);
  const checkoutRepo = stringValue(checkout.repoRoot);
  const indexedRepo = stringValue(freshness.repoRoot);
  return definedRecord({
    schemaVersion: 1,
    mode: kernel.mode,
    authority: definedRecord({
      actionability: boundedString(authority.actionability, 40),
      verdict: boundedString(authority.verdict, 60),
      packetVerdict: boundedString(authority.packetVerdict, 60),
      completionAuthority: boundedString(authority.completionAuthority, 60),
      inspectMode: boundedString(authority.inspectMode, 60),
      editReadiness: kernelRecord(authority.editReadiness, ["status", "editable", "source", "recommendedNextTool", "snapshotBlocked"])
    }),
    identity: {
      task: compactTextIdentity(identity.task),
      query: compactTextIdentity(identity.query),
      taskId: compactStableIdentity(identity.taskId),
      snapshot: emergencyIdentityRecord(identity.snapshot),
      snapshotBlock: emergencyIdentityRecord(identity.snapshotBlock),
      snapshotLoad: emergencyIdentityRecord(identity.snapshotLoad),
      checkout: definedRecord({ repoRoot: compactPathIdentity(checkoutRepo), gitHead: boundedString(checkout.gitHead, 80), routingSource: boundedString(checkout.routingSource, 60) }),
      freshness: definedRecord({ snapshotId: boundedString(freshness.snapshotId, 80), repoMatchesCheckout: Boolean(checkoutRepo && indexedRepo && checkoutRepo === indexedRepo), repoRoot: checkoutRepo === indexedRepo ? undefined : compactPathIdentity(indexedRepo), headCommit: boundedString(freshness.headCommit, 80), missing: freshness.missing, stale: freshness.stale, reason: boundedString(freshness.reason, 80) })
    },
    invariants: invariants.map(invariantStateTuple),
    invariantCount: invariants.length,
    loop: emergencyLoopKernel(kernel.loop),
    verification: emergencyVerificationKernel(kernel.verification),
    lifecycle: emergencyLifecycleKernel(kernel.lifecycle),
    decisionLog: compactDecisionKernelSection(kernel.decisionLog),
    worktree: kernelRecord(kernel.worktree, ["knownClean", "degraded", "dirtyFileCount", "degradedReasons"]),
    quality: kernelRecord(kernel.quality, ["level", "score", "confidence"]),
    reviewCoverage: reviewCoverageKernel(kernel.reviewCoverage),
    verificationProvenance: kernelRecord(kernel.verificationProvenance, ["schemaVersion", "commandCoverageClassifierVersion", "commandEnvelopeRulesetVersion", "verificationCoverageVersion", "verificationLedgerVersion"]),
    guidance: emergencyModeSection(kernel.guidance),
    capabilities: compactCapabilitiesKernel(kernel.capabilities),
    advanced: compactAdvancedModeKernel(kernel.advanced, "emergency"),
    search: emergencyModeSection(kernel.search),
    scope: emergencyModeSection(kernel.scope),
    failureSignalCount: kernel.failureSignalCount ?? arrayCount(kernel.failureSignals),
    failureSignals: Array.isArray(kernel.failureSignals) ? kernel.failureSignals.slice(0, 2).map(kernelEntry) : undefined,
    outcome: emergencyIdentityRecord(kernel.outcome),
    nextTools: Array.isArray(kernel.nextTools) ? kernel.nextTools.slice(0, 2).map(kernelEntry) : undefined,
    gapCount,
    gaps,
    gapsOmitted: Math.max(0, gapCount - gaps.length),
    detailsRequired: modeRequiresExactKernelDetail(stringValue(kernel.mode) ?? "unknown") || undefined
  });
}

function terminalDecisionKernel(kernel: Record<string, unknown>, failClosed = true): Record<string, unknown> {
  const authority = isRecord(kernel.authority) ? kernel.authority : {};
  const lifecycle = isRecord(kernel.lifecycle) ? kernel.lifecycle : undefined;
  const pendingStop = isRecord(lifecycle?.pendingStop) ? lifecycle.pendingStop : undefined;
  const verification = isRecord(kernel.verification) ? kernel.verification : undefined;
  const decisionLog = isRecord(kernel.decisionLog) ? kernel.decisionLog : undefined;
  const originalActionability = authority.originalActionability ?? authority.actionability;
  const gapCount = typeof kernel.gapCount === "number" ? kernel.gapCount : arrayCount(kernel.gaps);
  return definedRecord({
    schemaVersion: 1,
    mode: kernel.mode,
    authority: definedRecord({
      actionability: failClosed ? "blocked" : boundedString(originalActionability, 40),
      originalActionability: failClosed ? boundedString(originalActionability, 40) : undefined,
      verdict: boundedString(authority.verdict, 60),
      packetVerdict: boundedString(authority.packetVerdict, 60),
      completionAuthority: boundedString(authority.completionAuthority, 60),
      inspectMode: boundedString(authority.inspectMode, 60),
      editReadiness: kernelRecord(authority.editReadiness, ["status", "editable", "snapshotBlocked"])
    }),
    identity: terminalIdentityKernel(kernel.identity),
    invariants: Array.isArray(kernel.invariants) ? kernel.invariants.slice(0, 16).map(invariantStateTuple) : undefined,
    invariantCount: kernel.invariantCount,
    invariantIdEncoding: "literal-or-sha256",
    loop: terminalLoopKernel(kernel.loop),
    verification: terminalVerificationKernel(verification),
    lifecycle: lifecycle
      ? definedRecord({
          status: lifecycle.status,
          planRevision: lifecycle.planRevision,
          pendingStop: pendingStop ? definedRecord({ attemptId: compactStableIdentity(pendingStop.attemptId), status: pendingStop.status, reasonCount: pendingStop.reasonCount }) : undefined,
          attemptCount: lifecycle.attemptCount
        })
      : undefined,
    decisionLog: decisionLog ? definedRecord({ status: decisionLog.status, baselineIntact: decisionLog.baselineIntact, summaryHashValid: decisionLog.summaryHashValid }) : undefined,
    worktree: kernelRecord(kernel.worktree, ["knownClean", "degraded", "dirtyFileCount"]),
    quality: kernelRecord(kernel.quality, ["level", "confidence"]),
    reviewCoverage: reviewCoverageKernel(kernel.reviewCoverage),
    verificationProvenance: kernelRecord(kernel.verificationProvenance, ["schemaVersion", "verificationCoverageVersion", "verificationLedgerVersion"]),
    guidance: terminalGuidanceKernel(kernel.guidance),
    capabilities: compactCapabilitiesKernel(kernel.capabilities),
    advanced: compactAdvancedModeKernel(kernel.advanced, "terminal"),
    search: terminalModeSection(kernel.search),
    scope: terminalModeSection(kernel.scope),
    failureSignalCount: kernel.failureSignalCount,
    outcome: emergencyIdentityRecord(kernel.outcome),
    nextTools: failClosed ? [] : compactTerminalNextTools(kernel.nextTools),
    systemMessage: failClosed
      ? "Required detailed evidence is omitted from this bounded receipt; read the linked detailed result before acting."
      : boundedString(kernel.systemMessage, 220),
    gapCount,
    gapsOmitted: gapCount,
    detailsRequired: failClosed || undefined
  });
}

function emergencyModeSection(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "number" || typeof entry === "boolean") output[key] = entry;
    else if (typeof entry === "string") output[key] = compactTextIdentity(entry);
    else if (Array.isArray(entry)) {
      output[`${key}Count`] = entry.length;
      output[key] = entry.slice(0, 2).map(kernelEntry);
      if (entry.length > 2) output[`${key}Omitted`] = entry.length - 2;
    }
  }
  return definedRecord(output);
}

function terminalModeSection(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "number" || typeof entry === "boolean" || key.endsWith("Count") || key.endsWith("Omitted")) output[key] = entry;
    else if (Array.isArray(entry) && !(`${key}Count` in value)) output[`${key}Count`] = entry.length;
  }
  let kept = 0;
  for (const key of TERMINAL_MODE_IDENTITY_KEYS) {
    const entry = value[key];
    if (!Array.isArray(entry) || entry.length === 0) continue;
    output[key] = entry.slice(0, 1).map(kernelEntry);
    kept += 1;
    if (kept === 2) break;
  }
  if (kept < 2 && isRecord(value.nextCall)) output.nextCall = kernelEntry(value.nextCall);
  return definedRecord(output);
}

function terminalIdentityKernel(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  const checkout = isRecord(value.checkout) ? value.checkout : {};
  const freshness = isRecord(value.freshness) ? value.freshness : {};
  return definedRecord({
    taskId: compactStableIdentity(value.taskId),
    snapshot: emergencyIdentityRecord(value.snapshot),
    snapshotBlock: emergencyIdentityRecord(value.snapshotBlock),
    snapshotLoad: emergencyIdentityRecord(value.snapshotLoad),
    checkout: definedRecord({
      repoRoot: compactPathIdentity(stringValue(checkout.repoRoot)),
      gitHead: boundedString(checkout.gitHead, 80),
      routingSource: boundedString(checkout.routingSource, 40)
    }),
    freshness: definedRecord({
      repoRoot: compactPathIdentity(stringValue(freshness.repoRoot)),
      snapshotId: compactStableIdentity(freshness.snapshotId),
      headCommit: boundedString(freshness.headCommit, 80),
      missing: freshness.missing,
      stale: freshness.stale,
      reason: boundedString(freshness.reason, 80)
    })
  });
}

function terminalLoopKernel(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  const recurring = Array.isArray(value.recurringFailureClasses)
    ? value.recurringFailureClasses
    : Array.isArray(value.recurringFailures)
      ? value.recurringFailures
      : [];
  const growth = Array.isArray(value.growth)
    ? value.growth.slice(0, 5)
    : isRecord(value.cumulativeDiffGrowth)
      ? [value.cumulativeDiffGrowth.firstTrackedLines, value.cumulativeDiffGrowth.currentTrackedLines, value.cumulativeDiffGrowth.peakTrackedLines, value.cumulativeDiffGrowth.newFilesSinceFirstAttempt, value.cumulativeDiffGrowth.peakModifiedSymbols]
      : undefined;
  return definedRecord({
    status: boundedString(value.status, 40),
    attemptStatus: boundedString(value.attemptStatus, 40),
    totalDistinctAttempts: value.totalDistinctAttempts,
    attemptsSincePlan: value.attemptsSincePlan,
    unresolvedAttemptsSincePlan: value.unresolvedAttemptsSincePlan,
    recurringFailureClassCount: recurring.length,
    recurringFailureClasses: recurring.slice(0, 3).map((entry) => {
      if (Array.isArray(entry)) return [boundedString(entry[0], 40) ?? "unknown", entry[1], entry[2]];
      if (!isRecord(entry)) return ["unknown"];
      return [boundedString(entry.class, 40) ?? "unknown", entry.count];
    }),
    growth
  });
}

function compactTerminalNextTools(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  return value.slice(0, 2).map((entry) => {
    if (typeof entry === "string") return boundedReceiptValue(entry, 80);
    if (!isRecord(entry)) return "unknown";
    return boundedReceiptValue(stringValue(entry.tool) ?? stringValue(entry.name) ?? stringValue(entry.action) ?? "unknown", 80);
  });
}

function absoluteTerminalDecisionKernel(kernel: Record<string, unknown>): Record<string, unknown> {
  const authority = isRecord(kernel.authority) ? kernel.authority : {};
  const lifecycle = isRecord(kernel.lifecycle) ? kernel.lifecycle : undefined;
  const pendingStop = isRecord(lifecycle?.pendingStop) ? lifecycle.pendingStop : undefined;
  const decisionLog = isRecord(kernel.decisionLog) ? kernel.decisionLog : undefined;
  const gapCount = typeof kernel.gapCount === "number" ? kernel.gapCount : arrayCount(kernel.gaps);
  return definedRecord({
    schemaVersion: 1,
    mode: boundedString(kernel.mode, 40) ?? "unknown",
    authority: definedRecord({
      actionability: "blocked",
      originalActionability: boundedString(authority.originalActionability, 40),
      verdict: boundedString(authority.verdict, 40),
      completionAuthority: boundedString(authority.completionAuthority, 40),
      inspectMode: boundedString(authority.inspectMode, 40),
      editReadiness: kernelRecord(authority.editReadiness, ["status", "editable", "snapshotBlocked"])
    }),
    identity: terminalIdentityKernel(kernel.identity),
    invariants: Array.isArray(kernel.invariants) ? kernel.invariants.slice(0, 16).map(invariantStateTuple) : undefined,
    invariantCount: kernel.invariantCount,
    invariantIdEncoding: "literal-or-sha256",
    loop: terminalLoopKernel(kernel.loop),
    verification: absoluteVerificationCounts(kernel.verification),
    lifecycle: lifecycle ? definedRecord({
      status: boundedString(lifecycle.status, 40),
      planRevision: lifecycle.planRevision,
      pendingStop: pendingStop ? definedRecord({ status: boundedString(pendingStop.status, 30), reasonCount: pendingStop.reasonCount }) : undefined,
      attemptCount: lifecycle.attemptCount
    }) : undefined,
    decisionLog: decisionLog ? definedRecord({ status: boundedString(decisionLog.status, 30), baselineIntact: decisionLog.baselineIntact, summaryHashValid: decisionLog.summaryHashValid }) : undefined,
    worktree: kernelRecord(kernel.worktree, ["knownClean", "degraded", "dirtyFileCount"]),
    quality: kernelRecord(kernel.quality, ["level"]),
    reviewCoverage: reviewCoverageKernel(kernel.reviewCoverage),
    capabilities: compactCapabilitiesKernel(kernel.capabilities),
    advanced: compactAdvancedModeKernel(kernel.advanced, "terminal"),
    search: terminalModeSection(kernel.search),
    scope: terminalModeSection(kernel.scope),
    failureSignalCount: kernel.failureSignalCount,
    gapCount,
    gapsOmitted: gapCount,
    nextTools: compactTerminalNextTools(kernel.nextTools),
    detailsRequired: true
  });
}

function absoluteVerificationCounts(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if ((key.endsWith("Count") || key.endsWith("Omitted") || typeof entry === "boolean") && (typeof entry === "number" || typeof entry === "boolean")) {
      output[key] = entry;
    } else if (isRecord(entry)) {
      const nested = absoluteVerificationCounts(entry);
      if (nested) output[key] = nested;
    }
  }
  return definedRecord(output);
}

function emergencyIdentityRecord(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  return definedRecord({
    taskId: compactStableIdentity(value.taskId),
    id: compactStableIdentity(value.id),
    path: compactPathIdentity(stringValue(value.path)),
    status: boundedString(value.status, 40),
    reason: compactTextIdentity(value.reason),
    missingReason: compactTextIdentity(value.missingReason),
    ambiguousLatest: value.ambiguousLatest,
    planRevision: value.planRevision
  });
}

function terminalVerificationKernel(value: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!value) return undefined;
  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key.endsWith("Count") || key.endsWith("Omitted") || typeof entry === "boolean") output[key] = entry;
    else if (Array.isArray(entry)) output[key] = entry.slice(0, 1).map(kernelEntry);
    else if (isRecord(entry)) output[key] = terminalVerificationKernel(entry);
  }
  return definedRecord(output);
}

function invariantStateTuple(value: unknown): [string, string] {
  if (Array.isArray(value)) return [compactStableIdentity(value[0]), boundedString(value[1], 20) ?? "unreviewed"];
  if (!isRecord(value)) return ["unknown", "unreviewed"];
  return [compactStableIdentity(value.id), boundedString(value.status, 20) ?? "unreviewed"];
}

function compactStableIdentity(value: unknown): string {
  const identity = typeof value === "string" && value.length > 0 ? value : "unknown";
  return identity.length <= 80 ? identity : `sha256:${createHash("sha256").update(identity).digest("hex")}`;
}

function compactTextIdentity(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  return value.length <= 120 ? value : `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function compactPathIdentity(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (value.length <= 240) return value;
  const suffix = value.slice(-80);
  return `sha256:${createHash("sha256").update(value).digest("hex")}:...${suffix}`;
}

function emergencyLoopKernel(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  const recurring = Array.isArray(value.recurringFailures) ? value.recurringFailures.filter(isRecord) : [];
  const byClass = new Map<string, { maxCount: number; fingerprints: number }>();
  for (const failure of recurring) {
    const failureClass = boundedString(failure.class, 60) ?? "unknown";
    const count = typeof failure.count === "number" ? failure.count : 0;
    const current = byClass.get(failureClass) ?? { maxCount: 0, fingerprints: 0 };
    byClass.set(failureClass, { maxCount: Math.max(current.maxCount, count), fingerprints: current.fingerprints + 1 });
  }
  const growth = isRecord(value.cumulativeDiffGrowth) ? value.cumulativeDiffGrowth : {};
  return definedRecord({
    status: boundedString(value.status, 40),
    attemptStatus: boundedString(value.attemptStatus, 40),
    totalDistinctAttempts: value.totalDistinctAttempts,
    attemptsSincePlan: value.attemptsSincePlan,
    unresolvedAttemptsSincePlan: value.unresolvedAttemptsSincePlan,
    recurringFailureClasses: [...byClass].map(([failureClass, counts]) => [failureClass, counts.maxCount, counts.fingerprints]),
    growth: [growth.firstTrackedLines, growth.currentTrackedLines, growth.peakTrackedLines, growth.newFilesSinceFirstAttempt, growth.peakModifiedSymbols]
  });
}

function emergencyVerificationKernel(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "number" || typeof entry === "boolean" || typeof entry === "string") output[key] = typeof entry === "string" ? entry.slice(0, 80) : entry;
    else if (Array.isArray(entry)) {
      const returned = entry.slice(0, 2).map(kernelEntry);
      if (typeof output[`${key}Count`] !== "number") output[`${key}Count`] = entry.length;
      output[key] = returned;
      if (entry.length > returned.length) output[`${key}Omitted`] = entry.length - returned.length;
    } else if (isRecord(entry)) {
      output[key] = emergencyVerificationKernel(entry);
    }
  }
  return definedRecord(output);
}

function emergencyLifecycleKernel(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  const pendingStop = isRecord(value.pendingStop) ? value.pendingStop : undefined;
  const attempts = Array.isArray(value.attempts) ? value.attempts : [];
  return definedRecord({
    status: boundedString(value.status, 40),
    planRevision: value.planRevision,
    pendingStop: pendingStop ? definedRecord({ attemptId: boundedString(pendingStop.attemptId, 80), status: boundedString(pendingStop.status, 40), reasonCount: typeof pendingStop.reasonCount === "number" ? pendingStop.reasonCount : arrayCount(pendingStop.reasons), reasons: kernelStrings(pendingStop.reasons, 2) }) : undefined,
    attemptCount: typeof value.attemptCount === "number" ? value.attemptCount : attempts.length,
    attempts: attempts.slice(-2).map(kernelEntry)
  });
}

function modeDecisionKernel(mode: string, data: Record<string, unknown>): Record<string, unknown> {
  if (mode === "capabilities") {
    return { capabilities: capabilitiesDecisionKernel(data) };
  }
  if (mode === "search") {
    const raw = isRecord(data.raw) ? data.raw : undefined;
    return { search: definedRecord({ rawSufficient: raw?.sufficient, rawExactHitCount: data.rawExactHitCount, rawExactFileCount: data.rawExactFileCount, patternCount: arrayCount(data.patterns), patterns: kernelStrings(data.patterns, 5), rawFiles: kernelStrings(raw?.files, 5), rawHits: kernelEntries(raw?.hits, 5), fileCount: arrayCount(data.files), files: kernelEntries(data.files, 6), symbolCount: arrayCount(data.symbols), symbols: kernelEntries(data.symbols, 6), usageCount: arrayCount(data.usageSites), diagnosticCount: arrayCount(data.diagnostics), diagnostics: kernelStrings(data.diagnostics, 5) }), verification: definedRecord({ testCount: arrayCount(data.tests), tests: kernelEntries(data.tests, 5), testsOmitted: Math.max(0, arrayCount(data.tests) - 5) }) };
  }
  if (["focus_brief", "session_context", "task_brief", "context_pack"].includes(mode)) {
    return { scope: definedRecord({ focusFileCount: arrayCount(data.focusFiles), focusFiles: kernelEntries(data.focusFiles, 8), nextReadCount: arrayCount(data.nextReads), nextReads: kernelStrings(data.nextReads, 6), changedFileCount: arrayCount(data.changedFiles), changedFiles: kernelStrings(data.changedFiles, 6), nextCall: kernelEntry(data.nextCall), workflowCount: arrayCount(data.workflows), workflows: kernelEntries(data.workflows, 4) }), guidance: skillGuidanceKernel(data), verification: definedRecord({ testCount: arrayCount(data.tests), tests: kernelEntries(data.tests, 6), commandCount: arrayCount(data.verificationCommands), commands: kernelEntries(data.verificationCommands, 5) }), advanced: advancedModeDecisionKernel(mode, data) };
  }
  if (mode === "change_plan") {
    return { scope: definedRecord({ fileCount: arrayCount(data.files), files: kernelStrings(data.files, 8), plannedEditTargetCount: arrayCount(data.plannedEditTargets), plannedEditTargets: kernelStrings(data.plannedEditTargets, 10), targetCandidateCount: arrayCount(data.targetCandidates), targetCandidates: kernelEntries(data.targetCandidates, 5) }), invariants: compactDeclaredInvariantKernel(snapshotValue(data, "invariants") ?? data.invariants, 16), verification: definedRecord({ testCount: arrayCount(data.tests), tests: kernelEntries(data.tests, 8), workflowCheckCount: arrayLength(data.requiredWorkflowChecks), dependencyCheckCount: arrayLength(data.requiredDependencyChecks), workflowChecks: kernelEntries(data.requiredWorkflowChecks, 5), dependencyChecks: kernelEntries(data.requiredDependencyChecks, 5) }) };
  }
  if (mode === "test_plan") {
    return { scope: definedRecord({ targetFileCount: arrayCount(data.targetFiles), targetFiles: kernelStrings(data.targetFiles, 10), unindexedTargetFileCount: arrayCount(data.unindexedTargetFiles), unindexedTargetFiles: kernelStrings(data.unindexedTargetFiles, 6), rejectedTargetFileCount: arrayCount(data.rejectedTargetFiles), rejectedTargetFiles: kernelStrings(data.rejectedTargetFiles, 6), changedFileCount: arrayCount(data.changedFiles), changedFiles: kernelStrings(data.changedFiles, 6) }), verification: definedRecord({ testCount: arrayCount(data.tests), tests: kernelEntries(data.tests, 8), commandCount: arrayCount(data.verificationCommands), commands: kernelEntries(data.verificationCommands, 8), testsNotRunCount: arrayCount(data.testsNotRun), testsNotRun: kernelEntries(data.testsNotRun, 6), ledgerCount: arrayCount(data.verificationLedgerPreview), ledger: kernelEntries(data.verificationLedgerPreview, 6) }) };
  }
  if (mode === "post_edit_review") {
    return { scope: definedRecord({ fileCount: arrayCount(data.files), files: kernelStrings(data.files, 8), reviewTargetCount: arrayCount(data.reviewTargets), reviewTargets: kernelStrings(data.reviewTargets, 8), reviewCoverage: reviewCoverageKernel(data.reviewCoverage), unplannedEditedFileCount: arrayCount(data.unplannedEditedFiles), unplannedEditedFiles: kernelStrings(data.unplannedEditedFiles, 6), changedSinceSnapshotCount: arrayCount(data.changedSinceSnapshot), changedSinceSnapshot: kernelEntries(data.changedSinceSnapshot, 6) }), invariants: compactInvariantKernel(data.invariants, data.invariantReviews, 16), loop: loopDecisionKernel(data.loopReview), failureSignalCount: arrayCount(data.failureSignals), failureSignals: kernelEntries(data.failureSignals, 8), verification: definedRecord({ testsNotRunCount: arrayCount(data.testsNotRun), testsNotRun: kernelEntries(data.testsNotRun, 6), missedLikelyTestCount: arrayCount(data.missedLikelyTests), missedLikelyTests: kernelEntries(data.missedLikelyTests, 5), ledgerCount: arrayCount(data.verificationLedger), ledger: kernelEntries(data.verificationLedger, 6), riskEscalationsNeedInspection: data.riskEscalationsNeedInspection }), outcome: postEditOutcomeKernel(data.outcome), planRevision: data.planRevision };
  }
  if (mode === "proof_card") {
    const verification = isRecord(data.verification) ? data.verification : undefined;
    return { invariants: compactInvariantKernel(pathValue(data, ["lifecycle", "invariants"]), pathValue(data, ["lifecycle", "invariantReviews"]), 16), lifecycle: proofLifecycleKernel(data.lifecycle), decisionLog: kernelRecord(data.decisionLog, ["status", "sessionId", "baselineRevision", "currentRevision", "baselineIntact", "summaryHashValid", "warnings"]), verification: definedRecord({ recommendedCommandCount: arrayCount(verification?.recommendedCommands), recommendedCommands: kernelStrings(verification?.recommendedCommands, 6), nextCommandCount: arrayCount(data.nextCommands), nextCommands: kernelStrings(data.nextCommands, 6), testCount: arrayCount(verification?.tests), tests: kernelEntries(verification?.tests, 6), reported: kernelRecord(verification?.reported, ["hasEvidence", "testsNotRun", "ledger"]), artifacts: proofArtifactKernel(verification?.artifacts) }) };
  }
  const advanced = advancedModeDecisionKernel(mode, data);
  return advanced ? { advanced } : {};
}

function compactInvariantKernel(invariantsValue: unknown, reviewsValue: unknown, limit: number): unknown[] | undefined {
  if (!Array.isArray(invariantsValue)) return undefined;
  const reviews = Array.isArray(reviewsValue) ? reviewsValue.filter(isRecord) : [];
  return invariantsValue.slice(0, limit).map((value) => {
    const invariant = isRecord(value) ? value : {};
    const id = stringValue(invariant.id) ?? stringValue(invariant.invariantId);
    const review = reviews.find((entry) => stringValue(entry.invariantId) === id || stringValue(entry.id) === id);
    return definedRecord({ id: id ? compactStableIdentity(id) : undefined, statement: boundedString(invariant.statement, 220), status: boundedString(review?.status ?? invariant.status, 80), reason: boundedString(review?.reason, 180) });
  });
}

function compactInvariantStatusKernel(invariantsValue: unknown, reviewsValue: unknown, limit: number): unknown[] | undefined {
  return compactInvariantKernel(invariantsValue, reviewsValue, limit)?.map(compactDecisionInvariantStatus);
}

function compactDeclaredInvariantKernel(invariantsValue: unknown, limit: number): unknown[] | undefined {
  return compactInvariantKernel(invariantsValue, undefined, limit)?.map((entry) => (isRecord(entry) ? { ...entry, status: "declared" } : entry));
}

function failClosedDecisionKernel(kernel: Record<string, unknown>, detailUnavailable = false, reason?: string): Record<string, unknown> {
  const authority = isRecord(kernel.authority) ? kernel.authority : {};
  return {
    ...kernel,
    authority: {
      ...authority,
      originalActionability: authority.actionability,
      actionability: "blocked"
    },
    nextTools: [],
    systemMessage: detailUnavailable
      ? `Required detailed evidence is unavailable${reason ? ` (${boundedReceiptValue(reason, 120)})` : ""}; do not act from this receipt. Retry once with responseFormat "detailed".`
      : "Required detailed evidence is omitted from this concise receipt; read the linked detailed result before acting.",
    detailsRequired: true
  };
}

function loopDecisionKernel(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  const growth = isRecord(value.cumulativeDiffGrowth) ? value.cumulativeDiffGrowth : undefined;
  const recurringFailures = Array.isArray(value.recurringFailures) ? value.recurringFailures.filter(isRecord).map((entry) => definedRecord({ class: boundedString(entry.class, 80), fingerprint: boundedString(entry.fingerprint, 160), count: typeof entry.count === "number" ? entry.count : undefined })) : undefined;
  return definedRecord({
    policyVersion: boundedString(value.policyVersion, 80), attemptId: boundedString(value.attemptId, 160), attemptStatus: boundedString(value.attemptStatus, 80), status: boundedString(value.status, 80), totalDistinctAttempts: typeof value.totalDistinctAttempts === "number" ? value.totalDistinctAttempts : undefined, attemptsSincePlan: typeof value.attemptsSincePlan === "number" ? value.attemptsSincePlan : undefined, unresolvedAttemptsSincePlan: typeof value.unresolvedAttemptsSincePlan === "number" ? value.unresolvedAttemptsSincePlan : undefined, recurringFailures,
    cumulativeDiffGrowth: growth ? definedRecord({ firstTrackedLines: typeof growth.firstTrackedLines === "number" || growth.firstTrackedLines === null ? growth.firstTrackedLines : undefined, currentTrackedLines: typeof growth.currentTrackedLines === "number" || growth.currentTrackedLines === null ? growth.currentTrackedLines : undefined, peakTrackedLines: typeof growth.peakTrackedLines === "number" || growth.peakTrackedLines === null ? growth.peakTrackedLines : undefined, newFilesSinceFirstAttempt: typeof growth.newFilesSinceFirstAttempt === "number" ? growth.newFilesSinceFirstAttempt : undefined, peakModifiedSymbols: typeof growth.peakModifiedSymbols === "number" ? growth.peakModifiedSymbols : undefined }) : undefined,
    reasons: kernelStrings(value.reasons, 8)
  });
}

function proofLifecycleKernel(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  const pendingStop = isRecord(value.pendingStop) ? value.pendingStop : undefined;
  const attempts = Array.isArray(value.attempts) ? value.attempts : [];
  return definedRecord({
    status: boundedString(value.status, 60),
    planRevision: value.planRevision,
    error: boundedString(value.error, 180),
    pendingStop: pendingStop
      ? definedRecord({
          attemptId: boundedString(pendingStop.attemptId, 160),
          status: boundedString(pendingStop.status, 60),
          planRevision: pendingStop.planRevision,
          reasonCount: arrayCount(pendingStop.reasons),
          reasons: kernelStrings(pendingStop.reasons, 6)
        })
      : undefined,
    attemptCount: attempts.length,
    attempts: attempts.slice(-3).map((attempt) => {
      if (!isRecord(attempt)) return kernelEntry(attempt);
      return definedRecord({
        attemptId: boundedString(attempt.attemptId, 160),
        attemptStatus: boundedString(attempt.attemptStatus, 60),
        failureSignalCount: arrayCount(attempt.failureSignals),
        changedFileCount: arrayCount(attempt.changedFiles)
      });
    })
  });
}

function kernelRecord(value: unknown, keys: readonly string[]): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  const record: Record<string, unknown> = {};
  for (const key of keys) {
    const entry = value[key];
    if (typeof entry === "string") record[key] = boundedString(entry);
    else if (typeof entry === "number" || typeof entry === "boolean" || entry === null) record[key] = entry;
    else if (Array.isArray(entry)) record[key] = key.toLowerCase().includes("reason") || key === "warnings" ? kernelStrings(entry, 5) : kernelEntries(entry, 5);
    else if (isRecord(entry)) record[key] = kernelEntry(entry);
  }
  return Object.keys(record).length > 0 ? record : undefined;
}

function kernelEntries(value: unknown, limit: number): unknown[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  return value.slice(0, limit).map(kernelEntry);
}

function kernelEntry(value: unknown): unknown {
  if (typeof value === "string") return boundedString(value, 220);
  if (!isRecord(value)) return value;
  return definedRecord({ id: boundedString(value.id ?? value.invariantId ?? value.artifactId, 120), candidateId: boundedString(value.candidateId, 120), path: boundedString(decisionEntryPath(value), 220), symbol: boundedString(value.symbol, 160), name: boundedString(value.name ?? value.label, 160), module: boundedString(value.module, 160), uri: boundedString(value.uri, 260), skillPath: boundedString(value.skillPath, 220), matchedGlob: boundedString(value.matchedGlob, 180), matchedPath: boundedString(value.matchedPath, 220), tool: boundedString(value.tool, 100), command: boundedString(value.command, 220), target: boundedString(value.target, 220), kind: boundedString(value.kind, 80), class: boundedString(value.class, 80), fingerprint: boundedString(value.fingerprint, 160), count: typeof value.count === "number" ? value.count : undefined, status: boundedString(value.status, 80), action: boundedString(value.action, 80), reason: boundedString(value.reason, 220), statement: boundedString(value.statement, 220), line: typeof value.line === "number" ? value.line : undefined, confidence: typeof value.confidence === "number" || typeof value.confidence === "string" ? value.confidence : undefined });
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

function pathValue(value: Record<string, unknown>, keys: readonly string[]): unknown {
  let current: unknown = value;
  for (const key of keys) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return current;
}

function snapshotValue(data: Record<string, unknown>, key: string): unknown {
  return isRecord(data.snapshot) ? data.snapshot[key] : undefined;
}

function arrayLength(value: unknown): number | undefined {
  return Array.isArray(value) ? value.length : undefined;
}

function arrayCount(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

function renderKernelEntry(value: unknown): string {
  if (typeof value === "string") return value;
  if (!isRecord(value)) return String(value);
  const label = stringValue(value.id) ?? stringValue(value.path) ?? stringValue(value.tool) ?? stringValue(value.command) ?? stringValue(value.target) ?? stringValue(value.name) ?? "item";
  const status = stringValue(value.status);
  const reason = stringValue(value.reason) ?? stringValue(value.statement);
  return `${label}${status ? `=${status}` : ""}${reason ? ` (${reason})` : ""}`;
}

function renderKernelInvariants(values: unknown[]): string | undefined {
  if (values.length === 0) return undefined;
  const states = values.slice(0, 16).map((value) => {
    if (Array.isArray(value)) return { id: compactStableIdentity(value[0]), status: boundedReceiptValue(String(value[1] ?? "unreviewed"), 20) };
    if (!isRecord(value)) return { id: "unknown", status: "unreviewed" };
    return { id: compactStableIdentity(value.id), status: boundedReceiptValue(stringValue(value.status) ?? "unreviewed", 20) };
  });
  const counts = new Map<string, number>();
  for (const state of states) counts.set(state.status, (counts.get(state.status) ?? 0) + 1);
  const attention = states.filter((state) => !["satisfied", "preserved", "pass"].includes(state.status));
  const aggregate = [...counts].map(([status, count]) => `${status}=${count}`).join(", ");
  const attentionText = attention.length > 0
    ? `; attention ${attention.slice(0, 4).map((state) => `${state.id}=${state.status}`).join(" | ")}${attention.length > 4 ? ` | +${attention.length - 4} more` : ""}`
    : "";
  return boundedReceiptValue(`Invariants (${values.length}; ${aggregate})${attentionText}`, 500);
}

function renderKernelGaps(kernel: Record<string, unknown>): string | undefined {
  const gaps = kernelStrings(kernel.gaps, 2);
  const count = typeof kernel.gapCount === "number" ? kernel.gapCount : gaps.length;
  if (count === 0) return undefined;
  return `Gaps (${count}): ${gaps.map((value) => boundedReceiptValue(value, 140)).join("; ") || "details required"}`;
}

function renderKernelIdentity(identity: Record<string, unknown>): string | undefined {
  const checkout = isRecord(identity.checkout) ? identity.checkout : undefined;
  const freshness = isRecord(identity.freshness) ? identity.freshness : undefined;
  if (!checkout && !freshness) return undefined;
  const repoRoot = stringValue(checkout?.repoRoot) ?? stringValue(freshness?.repoRoot) ?? "unknown";
  const activeHead = stringValue(checkout?.gitHead) ?? "unknown";
  const indexedHead = stringValue(freshness?.headCommit) ?? "unknown";
  const state = freshness?.missing === true ? "missing" : freshness?.stale === true ? `stale:${stringValue(freshness.reason) ?? "unknown"}` : "fresh";
  return `Checkout: ${repoRoot}; HEAD ${activeHead}; indexed HEAD ${indexedHead}; index ${state}`;
}

function renderKernelVerification(value: Record<string, unknown>): string | undefined {
  const testsNotRun = Array.isArray(value.testsNotRun) ? value.testsNotRun : [];
  const commands = Array.isArray(value.commands) ? value.commands : Array.isArray(value.nextCommands) ? value.nextCommands : [];
  const ledger = Array.isArray(value.ledger) ? value.ledger : Array.isArray(value.verificationLedger) ? value.verificationLedger : [];
  const testsNotRunCount = typeof value.testsNotRunCount === "number" ? value.testsNotRunCount : testsNotRun.length;
  const ledgerCount = typeof value.ledgerCount === "number" ? value.ledgerCount : ledger.length;
  const commandCount = typeof value.commandCount === "number" ? value.commandCount : typeof value.nextCommandCount === "number" ? value.nextCommandCount : commands.length;
  if (testsNotRunCount > 0) return `Verification unresolved (${testsNotRunCount}): ${testsNotRun.slice(0, 2).map((entry) => boundedReceiptValue(renderKernelEntry(entry), 160)).join(" | ") || "details required"}`;
  if (ledgerCount > 0) return `Verification ledger (${ledgerCount}): ${ledger.slice(0, 2).map((entry) => boundedReceiptValue(renderKernelEntry(entry), 160)).join(" | ") || "details required"}`;
  if (commandCount > 0) return `Verification (${commandCount}): ${commands.slice(0, 2).map((entry) => boundedReceiptValue(renderKernelEntry(entry), 160)).join(" | ") || "details required"}`;
  return undefined;
}

function fitConciseReceipt(lines: string[], tailLines: string[]): string {
  const tail = tailLines.map((line) => boundedReceiptValue(line, 500));
  const tailText = tail.join("\n");
  const maxHeadChars = Math.max(0, CONCISE_TEXT_MAX_CHARS - tailText.length - (tailText ? 1 : 0));
  const head: string[] = [];
  let used = 0;
  for (const rawLine of lines.slice(0, CONCISE_TEXT_MAX_LINES - tail.length)) {
    const line = boundedReceiptValue(rawLine, 500);
    const separator = head.length > 0 ? 1 : 0;
    if (used + separator + line.length > maxHeadChars) {
      const remaining = maxHeadChars - used - separator;
      if (remaining >= 24) head.push(boundedReceiptValue(line, remaining));
      break;
    }
    head.push(line);
    used += separator + line.length;
  }
  return [...head, ...tail].join("\n");
}

function boundedReceiptValue(value: string, limit: number): string {
  if (value.length <= limit) return value;
  if (limit <= 1) return value.slice(0, limit);
  return `${value.slice(0, limit - 1)}…`;
}

function mcpTargetBytes(data: Record<string, unknown>): number | undefined {
  const mcp = isRecord(data.mcp) ? data.mcp : undefined;
  return typeof mcp?.targetBytes === "number" && Number.isFinite(mcp.targetBytes) ? mcp.targetBytes : undefined;
}

function compactMcpMetrics(value: unknown, targetBytes: number): Record<string, unknown> {
  const mcp = isRecord(value) ? value : {};
  return definedRecord({
    compacted: true,
    originalBytes: mcp.originalBytes,
    targetBytes,
    mode: mcp.mode,
    hardBudgetEnforced: true,
    budgetCompaction: "delivery"
  });
}

function reconcileMcpReturnedBytes(data: Record<string, unknown>): Record<string, unknown> {
  const mcp = isRecord(data.mcp) ? data.mcp : undefined;
  if (!mcp) return data;
  let returnedBytes = 0;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const candidate = { ...data, mcp: { ...mcp, returnedBytes } };
    const bytes = structuredByteLength(candidate);
    if (bytes === returnedBytes) return candidate;
    returnedBytes = bytes;
  }
  return { ...data, mcp: { ...mcp, returnedBytes } };
}

function proofArtifactKernel(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  const selected = Array.isArray(value.selected) ? value.selected : [];
  const accepted = Array.isArray(value.accepted) ? value.accepted : [];
  const rejected = Array.isArray(value.rejected) ? value.rejected : [];
  const ledgerEvidence = Array.isArray(value.ledgerEvidence) ? value.ledgerEvidence : [];
  const nonPassingCount = rejected.filter((entry) => isRecord(entry) && entry.status === "non_passing").length;
  return definedRecord({
    selectedCount: selected.length,
    selected: selected.slice(0, 4).map(kernelEntry),
    acceptedCount: accepted.length,
    accepted: accepted.slice(0, 4).map(kernelEntry),
    rejectedCount: rejected.length,
    rejected: rejected.slice(0, 4).map(kernelEntry),
    nonPassingCount,
    ledgerEvidenceCount: ledgerEvidence.length,
    ledgerEvidence: ledgerEvidence.slice(0, 4).map(kernelEntry)
  });
}

function boundedVerificationProvenance(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  return structuredByteLength(value) <= 2_000 ? value : { truncated: true };
}

function inferKernelMode(data: Record<string, unknown>): string | undefined {
  if (Array.isArray(data.verificationCommands) && Array.isArray(data.verificationCoverage) && Array.isArray(data.tests)) {
    return Array.isArray(data.focusFiles) || Array.isArray(data.nextReads) ? "context_pack" : "test_plan";
  }
  return undefined;
}
