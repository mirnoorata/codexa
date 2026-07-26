import { CURRENT_VERIFICATION_PROVENANCE } from "../types.js";
import { asCodexaQueryData, asPostEditReviewData } from "../query-data.js";
import { compactComplexityReview } from "../query/complexity.js";
import {
  clampLargeStringsPreservingMcpGuidance,
  compactChangedEntry,
  compactCheck,
  compactCommandEnvelope,
  compactCommandEnvelopeList,
  compactCommandReportList,
  compactFileFact,
  compactFocusEntry,
  compactGenericValue,
  compactGroup,
  compactModule,
  compactNextTools,
  compactRetrieval,
  compactSession,
  compactSummaryArray,
  compactSnapshotLoad,
  compactSymbolLike,
  compactTestRecommendation,
  compactVerificationCoverage,
  compactVerificationLedgerEntry,
  compactVerificationPlan,
  compactWorkflow,
  createArrayLimiter,
  isRecord,
  limitArray,
  nestedTruncation,
  nonEmptyArray,
  prefixTruncation,
  redactMcpText,
  stringValue,
  structuredByteLength,
  truncatedArray,
  type McpTruncation
} from "./compaction-helpers.js";
export { compactNextTools } from "./compaction-helpers.js";
import type { ChangePlanData, CodexaQueryData, ContextPacketData, FocusBriefData, FreshnessInfo, PostEditReviewData, ProofCardData, QueryResult, TestPlanData } from "../types.js";
import { attachMcpDecisionKernel, compactTerminalDecisionKernel, mcpDecisionKernel } from "./decision-kernel.js";
const DEFAULT_MCP_STRUCTURED_DATA_TARGET_BYTES = 96_000;
const MIN_MCP_STRUCTURED_DATA_TARGET_BYTES = 4_000;
const MAX_MCP_STRUCTURED_DATA_TARGET_BYTES = 512_000;
export const MCP_DETAILED_PROJECTION_TARGET_BYTES = MAX_MCP_STRUCTURED_DATA_TARGET_BYTES;
export function mcpStructuredDataTargetBytes(): number {
  return configuredMcpStructuredDataTargetBytes() ?? DEFAULT_MCP_STRUCTURED_DATA_TARGET_BYTES;
}
export function mcpDetailedProjectionTargetBytes(): number {
  return configuredMcpStructuredDataTargetBytes() ?? MCP_DETAILED_PROJECTION_TARGET_BYTES;
}

function configuredMcpStructuredDataTargetBytes(): number | undefined {
  const raw = process.env.CODEXA_MCP_STRUCTURED_BUDGET_BYTES;
  if (!raw) {
    return undefined;
  }
  if (!/^\d+$/u.test(raw.trim())) {
    return undefined;
  }
  const parsed = Number.parseInt(raw.trim(), 10);
  return Math.min(MAX_MCP_STRUCTURED_DATA_TARGET_BYTES, Math.max(MIN_MCP_STRUCTURED_DATA_TARGET_BYTES, parsed));
}

interface McpCompactionResult {
  data: Record<string, unknown>;
  truncation: McpTruncation;
  compacted: boolean;
}

const CONCISE_RESPONSE_TARGET_BYTES = 12_000;

export interface McpCompactionOptions {
  format?: "concise" | "detailed";
  targetBytes?: number;
}

export { conciseText } from "./decision-kernel.js";

export function compactMcpResult(result: QueryResult, options?: McpCompactionOptions): QueryResult {
  if (!result.data || typeof result.data !== "object" || Array.isArray(result.data)) {
    return result;
  }
  const originalData = result.data as Record<string, unknown>;
  const originalBytes = structuredByteLength(originalData);
  const mode = typeof originalData.mode === "string" ? originalData.mode : inferMcpDataMode(originalData);
  const effectiveMode = mode ?? "unknown";
  const typedData = asCodexaQueryData(originalData, mode);
  const compaction = (typedData ? compactMcpDataByMode(typedData) : undefined) ?? compactGenericMcpData(originalData, effectiveMode);
  const decisionKernel = mcpDecisionKernel(originalData, effectiveMode, result.freshness);
  const clamped = clampLargeStringsPreservingMcpGuidance(compaction.data);
  const dataWithoutMetrics = attachMcpDecisionKernel(withMergedTruncation(clamped.value as Record<string, unknown>, compaction.truncation), decisionKernel);
  const compactedBytes = structuredByteLength(dataWithoutMetrics);
  const baseTargetBytes = options?.targetBytes === undefined
    ? mcpStructuredDataTargetBytes()
    : Math.min(MAX_MCP_STRUCTURED_DATA_TARGET_BYTES, Math.max(MIN_MCP_STRUCTURED_DATA_TARGET_BYTES, Math.floor(options.targetBytes)));
  const targetBytes = options?.format === "concise" ? Math.min(baseTargetBytes, CONCISE_RESPONSE_TARGET_BYTES) : baseTargetBytes;
  const structuredData = {
    compacted: compaction.compacted || compactedBytes < originalBytes,
    originalBytes,
    targetBytes,
    stringTruncations: clamped.stringTruncations,
    mode: effectiveMode,
    verificationProvenance: boundedVerificationProvenance(originalData.verificationProvenance)
  };
  let data = attachMcpMetrics(dataWithoutMetrics, structuredData);
  const returnedBytes = structuredByteLength(data);
  if (returnedBytes > targetBytes) {
    data = enforceMcpStructuredBudget(dataWithoutMetrics, structuredData, returnedBytes, effectiveMode, targetBytes, decisionKernel);
  }
  return {
    ...result,
    data
  };
}

/**
 * Build the one detailed projection shared by inline and resource delivery.
 * Per-invocation command timings describe host scheduling, not query evidence;
 * retaining command outcomes and every other runtime field keeps exact-packet
 * identity sensitive to real behavioral changes.
 */
export function canonicalMcpDetailedProjection(result: QueryResult): QueryResult {
  const canonicalInput = isRecord(result.data)
    ? {
        ...result,
        data: {
          ...result.data,
          session: canonicalRuntimeTiming(result.data.session),
          runtime: canonicalRuntimeTiming(result.data.runtime)
        }
      }
    : result;
  const projected = compactMcpResult(canonicalInput, {
    format: "detailed",
    targetBytes: mcpDetailedProjectionTargetBytes()
  });
  if (!isRecord(projected.data)) {
    return projected;
  }
  return {
    ...projected,
    data: reconcileCanonicalProjectionBytes(projected.data)
  };
}

function reconcileCanonicalProjectionBytes(data: Record<string, unknown>): Record<string, unknown> {
  if (!isRecord(data.mcp)) return data;
  const { returnedBytes: _returnedBytes, ...metrics } = data.mcp;
  const { mcp: _mcp, ...payload } = data;
  return attachMcpMetrics(payload, metrics);
}

function canonicalRuntimeTiming(value: unknown): unknown {
  if (!isRecord(value)) {
    return value;
  }
  const { commandBudgetUsedMs: _commandBudgetUsedMs, commandBudgetRemainingMs: _commandBudgetRemainingMs, ...runtime } = value;
  return {
    ...runtime,
    provenance: Array.isArray(runtime.provenance)
      ? runtime.provenance.map((entry) =>
          typeof entry === "string" ? entry.replace(/^(command:.*:(?:ok|not-ok)):\d+ms$/u, "$1") : entry
        )
      : runtime.provenance
  };
}

export function compactNonPostEditMcpResult(result: QueryResult, options?: McpCompactionOptions): QueryResult {
  return compactMcpResult(result, options);
}

export function inferMcpDataMode(data: Record<string, unknown>): string | undefined {
  if (Array.isArray(data.verificationCommands) && Array.isArray(data.verificationCoverage) && Array.isArray(data.tests)) {
    return Array.isArray(data.focusFiles) || Array.isArray(data.nextReads) ? "context_pack" : "test_plan";
  }
  return undefined;
}

function compactMcpDataByMode(data: CodexaQueryData): McpCompactionResult | undefined {
  if (data.mode === "post_edit_review") {
    const compacted = compactPostEditMcpResult({ freshness: {} as FreshnessInfo, text: "", data });
    return { data: compacted.data as Record<string, unknown>, truncation: ((compacted.data as Record<string, unknown>).truncation as Record<string, { total: number; returned: number }>) ?? {}, compacted: true };
  }
  if (data.mode === "context_pack" || data.mode === "task_brief") {
    return compactContextPacketData(data, data.mode);
  }
  if (data.mode === "focus_brief" || data.mode === "session_context") {
    return compactFocusBriefData(data);
  }
  if (data.mode === "change_plan") {
    return compactChangePlanData(data);
  }
  if (data.mode === "test_plan") {
    return compactTestPlanData(data);
  }
  if (data.mode === "proof_card") {
    return compactProofCardData(data);
  }
  return undefined;
}

function compactGenericMcpData(data: Record<string, unknown>, mode: string): McpCompactionResult {
  const truncation: McpTruncation = {};
  // The capability descriptor is already schema-bounded, but legitimate
  // operation contracts (session_memory entries -> scope -> refs) are deeper
  // than ordinary query evidence. Preserve those names/required fields so an
  // agent can actually construct the dispatched call it just discovered.
  const compacted = compactGenericValue(data, { arrayLimit: 40, objectKeyLimit: 80, maxDepth: mode === "capabilities" ? 14 : 8 }, truncation);
  const record = isRecord(compacted) ? compacted : { value: compacted };
  const dataWithMode = typeof record.mode === "string" ? record : { mode, ...record };
  return { data: dataWithMode, truncation, compacted: true };
}

function enforceMcpStructuredBudget(
  dataWithoutMetrics: Record<string, unknown>,
  structuredData: Record<string, unknown>,
  preEnforcementBytes: number,
  mode: string,
  targetBytes: number,
  decisionKernel: Record<string, unknown>
): Record<string, unknown> {
  const hardTruncation = mergeTruncation(truncationFromValue(dataWithoutMetrics.truncation), {
    "__mcp.hardBudget": { total: preEnforcementBytes, returned: targetBytes }
  });
  const hardCompacted = compactGenericValue(dataWithoutMetrics, { arrayLimit: 12, objectKeyLimit: 40, maxDepth: 6 }, hardTruncation);
  const hardClamped = clampLargeStringsPreservingMcpGuidance(hardCompacted, 240);
  const hardRecord = isRecord(hardClamped.value) ? hardClamped.value : { value: hardClamped.value };
  const hardData = attachMcpDecisionKernel(
    withMergedTruncation(reattachGuidanceFields(typeof hardRecord.mode === "string" ? hardRecord : { mode, ...hardRecord }, dataWithoutMetrics, hardTruncation), hardTruncation),
    decisionKernel
  );
  const hardResult = attachMcpMetrics(hardData, {
    ...structuredData,
    compacted: true,
    hardBudgetEnforced: true,
    preEnforcementBytes,
    budgetCompaction: "hard",
    stringTruncations: metricNumber(structuredData, "stringTruncations") + hardClamped.stringTruncations
  });
  if (structuredByteLength(hardResult) <= targetBytes) {
    return hardResult;
  }

  const summaryTruncation = mergeTruncation(hardTruncation, {
    "__mcp.summaryBudget": { total: structuredByteLength(hardResult), returned: targetBytes }
  });
  const summaryClamped = clampLargeStringsPreservingMcpGuidance(buildMcpBudgetSummaryData(dataWithoutMetrics, mode, summaryTruncation), 160);
  const summaryRecord = isRecord(summaryClamped.value) ? summaryClamped.value : { value: summaryClamped.value };
  const summaryResult = attachMcpMetrics(attachMcpDecisionKernel(withMergedTruncation(summaryRecord, summaryTruncation), decisionKernel), {
    ...structuredData,
    compacted: true,
    hardBudgetEnforced: true,
    preEnforcementBytes,
    budgetCompaction: "summary",
    stringTruncations: metricNumber(structuredData, "stringTruncations") + hardClamped.stringTruncations + summaryClamped.stringTruncations
  });
  if (structuredByteLength(summaryResult) <= targetBytes) {
    return summaryResult;
  }

  const fallbackTruncation = mergeTruncation(summaryTruncation, {
    "__mcp.fallbackBudget": { total: structuredByteLength(summaryResult), returned: targetBytes }
  });
  const fallbackClamped = clampLargeStringsPreservingMcpGuidance(
    {
      mode,
      task: typeof dataWithoutMetrics.task === "string" ? dataWithoutMetrics.task.slice(0, 160) : dataWithoutMetrics.task,
      verdict: dataWithoutMetrics.verdict,
      editReadiness: dataWithoutMetrics.editReadiness,
      followCandidate: compactFollowCandidate(dataWithoutMetrics.followCandidate),
      snapshotBlock: compactSnapshotBlock(dataWithoutMetrics.snapshotBlock),
      targetCandidates: Array.isArray(dataWithoutMetrics.targetCandidates) ? dataWithoutMetrics.targetCandidates.slice(0, 8).map(compactTargetCandidate) : dataWithoutMetrics.targetCandidates,
      packetVerdict: dataWithoutMetrics.packetVerdict,
      complexityReview: compactComplexityReview(dataWithoutMetrics.complexityReview, 4),
      verificationProvenance: boundedVerificationProvenance(dataWithoutMetrics.verificationProvenance),
      nextCall: dataWithoutMetrics.nextCall,
      nextTools: compactNextTools(dataWithoutMetrics.nextTools, fallbackTruncation),
      systemMessage: stringValue(dataWithoutMetrics.systemMessage),
      runtime: compactSession(dataWithoutMetrics.runtime),
      truncation: fallbackTruncation
    },
    160
  );
  const fallbackRecord = isRecord(fallbackClamped.value) ? fallbackClamped.value : { value: fallbackClamped.value };
  const fallbackResult = attachMcpMetrics(attachMcpDecisionKernel(fallbackRecord, decisionKernel), {
    ...structuredData,
    compacted: true,
    hardBudgetEnforced: true,
    preEnforcementBytes,
    budgetCompaction: "fallback",
    stringTruncations: metricNumber(structuredData, "stringTruncations") + hardClamped.stringTruncations + summaryClamped.stringTruncations + fallbackClamped.stringTruncations
  });
  if (structuredByteLength(fallbackResult) <= targetBytes) {
    return fallbackResult;
  }
  // Last-resort tier: evidence-bearing fields are dropped entirely so the
  // verdict and routing guidance always fit the host's hard result limit.
  const minimalTruncation = mergeTruncation(fallbackTruncation, {
    "__mcp.minimalBudget": { total: structuredByteLength(fallbackResult), returned: targetBytes }
  });
  const minimalClamped = clampLargeStringsPreservingMcpGuidance(
    {
      mode,
      task: typeof dataWithoutMetrics.task === "string" ? dataWithoutMetrics.task.slice(0, 160) : undefined,
      verdict: dataWithoutMetrics.verdict,
      editReadiness: dataWithoutMetrics.editReadiness,
      packetVerdict: dataWithoutMetrics.packetVerdict,
      verificationProvenance: boundedVerificationProvenance(dataWithoutMetrics.verificationProvenance),
      nextCall: dataWithoutMetrics.nextCall,
      nextTools: compactNextTools(dataWithoutMetrics.nextTools, minimalTruncation),
      systemMessage: stringValue(dataWithoutMetrics.systemMessage),
      runtime: compactSession(dataWithoutMetrics.runtime),
      truncation: minimalTruncation
    },
    160
  );
  const minimalRecord = isRecord(minimalClamped.value) ? minimalClamped.value : { value: minimalClamped.value };
  const minimalMetrics = {
    ...structuredData,
    compacted: true,
    hardBudgetEnforced: true,
    preEnforcementBytes,
    budgetCompaction: "minimal",
    stringTruncations:
      metricNumber(structuredData, "stringTruncations") + hardClamped.stringTruncations + summaryClamped.stringTruncations + fallbackClamped.stringTruncations + minimalClamped.stringTruncations
  };
  const minimalResult = attachMcpMetrics(attachMcpDecisionKernel(minimalRecord, decisionKernel), minimalMetrics);
  if (structuredByteLength(minimalResult) <= targetBytes) {
    return minimalResult;
  }
  // Last-resort is still a fail-closed decision receipt, never a permissive
  // verdict-only packet. The full detailed packet is retrievable through the
  // delivery reference attached by the MCP runtime.
  const terminalKernel = compactTerminalDecisionKernel(decisionKernel);
  const authority = isRecord(terminalKernel.authority) ? terminalKernel.authority : {};
  const failClosedKernel = {
    ...terminalKernel,
    authority: {
      ...authority,
      originalActionability: authority.actionability,
      actionability: "blocked"
    },
    detailsRequired: true
  };
  const terminalResult = attachMcpMetrics(
    {
      mode,
      actionability: "blocked",
      verdict: authority.verdict,
      packetVerdict: authority.packetVerdict,
      completionAuthority: authority.completionAuthority,
      inspectMode: authority.inspectMode,
      decisionKernel: failClosedKernel,
      systemMessage: stringValue(dataWithoutMetrics.systemMessage)?.slice(0, 160),
      truncation: { "__mcp.verdictOnlyBudget": { total: structuredByteLength(minimalResult), returned: targetBytes } }
    },
    minimalMetrics
  );
  if (structuredByteLength(terminalResult) > targetBytes) {
    throw new Error(`Codexa mandatory decision kernel exceeds the ${targetBytes}-byte structured result budget; detailed delivery is required`);
  }
  return terminalResult;
}

function buildMcpBudgetSummaryData(data: Record<string, unknown>, mode: string, truncation: McpTruncation): Record<string, unknown> {
  return {
    mode,
    task: data.task,
    verdict: data.verdict,
    editReadiness: data.editReadiness,
    followCandidate: compactFollowCandidate(data.followCandidate),
    snapshotBlock: compactSnapshotBlock(data.snapshotBlock),
    targetCandidates: compactSummaryArray("targetCandidates", data.targetCandidates, 8, truncation, compactTargetCandidate),
    packetVerdict: data.packetVerdict,
    complexityReview: compactComplexityReview(data.complexityReview, 4),
    nextCall: data.nextCall,
    nextTools: compactNextTools(data.nextTools, truncation),
    systemMessage: stringValue(data.systemMessage),
    files: compactSummaryArray("files", data.files, 12, truncation),
    plannedEditTargets: compactSummaryArray("plannedEditTargets", data.plannedEditTargets, 12, truncation),
    changedFiles: compactSummaryArray("changedFiles", data.changedFiles, 12, truncation),
    tests: compactSummaryArray("tests", data.tests, 12, truncation, compactTestRecommendation),
    verificationCommands: compactSummaryArray("verificationCommands", data.verificationCommands, 10, truncation),
    verificationProvenance: boundedVerificationProvenance(data.verificationProvenance),
    commandEnvelopes: compactSummaryArray("commandEnvelopes", data.commandEnvelopes, 10, truncation, compactCommandEnvelope),
    verificationCommandPlan: compactSummaryArray("verificationCommandPlan", data.verificationCommandPlan, 10, truncation, compactVerificationPlan),
    verificationLedgerPreview: compactSummaryArray("verificationLedgerPreview", data.verificationLedgerPreview, 10, truncation, compactVerificationLedgerEntry),
    verificationLedger: compactSummaryArray("verificationLedger", data.verificationLedger, 10, truncation, compactVerificationLedgerEntry),
    driftReasons: compactSummaryArray("driftReasons", data.driftReasons, 8, truncation),
    nextActions: compactSummaryArray("nextActions", data.nextActions, 8, truncation),
    snapshot: compactBudgetSnapshot(data.snapshot, truncation),
    runtime: compactSession(data.runtime),
    truncation
  };
}

function reattachGuidanceFields(record: Record<string, unknown>, source: Record<string, unknown>, truncation: McpTruncation): Record<string, unknown> {
  const nextTools = compactNextTools(source.nextTools, truncation);
  return {
    ...record,
    ...(isRecord(source.nextCall) ? { nextCall: source.nextCall } : {}),
    ...(nextTools === undefined ? {} : { nextTools }),
    ...(typeof source.systemMessage === "string" ? { systemMessage: source.systemMessage } : {})
  };
}

function compactBudgetSnapshot(value: unknown, truncation: McpTruncation): unknown {
  if (!isRecord(value)) {
    return value;
  }
  return {
    taskId: value.taskId,
    createdAt: value.createdAt,
    changeType: value.changeType,
    plannedEditTargets: compactSummaryArray("snapshot.plannedEditTargets", value.plannedEditTargets, 10, truncation),
    plannedFiles: compactSummaryArray("snapshot.plannedFiles", value.plannedFiles, 10, truncation),
    plannedTests: compactSummaryArray("snapshot.plannedTests", value.plannedTests, 10, truncation, compactTestRecommendation),
    requiredWorkflowCheckCount: typeof value.requiredWorkflowCheckCount === "number" ? value.requiredWorkflowCheckCount : Array.isArray(value.requiredWorkflowChecks) ? value.requiredWorkflowChecks.length : undefined,
    requiredDependencyCheckCount: typeof value.requiredDependencyCheckCount === "number" ? value.requiredDependencyCheckCount : Array.isArray(value.requiredDependencyChecks) ? value.requiredDependencyChecks.length : undefined
  };
}

// The provenance marker is a small fixed shape in practice; an oversized one is
// untrusted input and must not ride into every compaction tier via the metrics.
function boundedVerificationProvenance(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  return structuredByteLength(value) <= 2_000 ? value : { truncated: true };
}

function attachMcpMetrics(dataWithoutMetrics: Record<string, unknown>, structuredData: Record<string, unknown>): Record<string, unknown> {
  let returnedBytes = 0;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const candidate = {
      ...dataWithoutMetrics,
      mcp: {
        ...structuredData,
        returnedBytes
      }
    };
    const bytes = structuredByteLength(candidate);
    if (bytes === returnedBytes) {
      return candidate;
    }
    returnedBytes = bytes;
  }
  const candidate = {
    ...dataWithoutMetrics,
    mcp: {
      ...structuredData,
      returnedBytes
    }
  };
  return candidate;
}

function withMergedTruncation(data: Record<string, unknown>, truncation: McpTruncation): Record<string, unknown> {
  const merged = mergeTruncation(truncationFromValue(data.truncation), truncation);
  if (Object.keys(merged).length === 0) {
    return data;
  }
  return { ...data, truncation: merged };
}

function mergeTruncation(...records: Array<McpTruncation | undefined>): McpTruncation {
  const merged: McpTruncation = {};
  for (const record of records) {
    if (!record) {
      continue;
    }
    for (const [key, value] of Object.entries(record)) {
      if (value && typeof value.total === "number" && typeof value.returned === "number") {
        merged[key] = value;
      }
    }
  }
  return merged;
}

function truncationFromValue(value: unknown): McpTruncation {
  if (!isRecord(value)) {
    return {};
  }
  const truncation: McpTruncation = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!isRecord(entry)) {
      continue;
    }
    const total = entry.total;
    const returned = entry.returned;
    if (typeof total === "number" && typeof returned === "number") {
      truncation[key] = { total, returned };
    }
  }
  return truncation;
}

function metricNumber(data: Record<string, unknown>, key: string): number {
  const value = data[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function compactPostEditMcpResult(result: QueryResult): QueryResult {
  if (!result.data || typeof result.data !== "object") {
    return result;
  }
  const data = asPostEditReviewData(result.data);
  if (!data) {
    return result;
  }
  const snapshot = data.snapshot && typeof data.snapshot === "object" ? (data.snapshot as Record<string, unknown>) : undefined;
  const outcome = data.outcome && typeof data.outcome === "object" ? (data.outcome as Record<string, unknown>) : undefined;
  const truncation = compactPostEditTruncation(data, snapshot, outcome);
  return {
    ...result,
    data: {
      mode: data.mode,
      task: data.task, taskId: data.taskId,
      verdict: data.verdict,
      inspectMode: data.inspectMode,
      inspectReasons: limitArray(data.inspectReasons, 12),
      completionAuthority: data.completionAuthority,
      reviewCoverage: data.reviewCoverage,
      planRevision: data.planRevision,
      invariants: limitArray(data.invariants, 12),
      invariantReviews: limitArray(data.invariantReviews, 12),
      failureSignals: limitArray(data.failureSignals, 24),
      diffFootprint: data.diffFootprint,
      loopReview: data.loopReview,
      verificationArtifacts: limitArray(data.verificationArtifacts, 20),
      files: data.files,
      reviewTargets: limitArray(data.reviewTargets, 30),
      changedSinceSnapshot: limitArray(data.changedSinceSnapshot, 40),
      changedGroups: limitArray(data.changedGroups, 20),
      resolvedBaselineFiles: limitArray(data.resolvedBaselineFiles, 30),
      unplannedEditedFiles: data.unplannedEditedFiles,
      plannedRenames: limitArray(data.plannedRenames, 20),
      unplannedChangedSymbols: limitArray(data.unplannedChangedSymbols, 20),
      plannedButUntouchedFiles: limitArray(data.plannedButUntouchedFiles, 30),
      headChanged: data.headChanged,
      symbolDeltas: limitArray(data.symbolDeltas, 20),
      modifiedSymbols: limitArray(data.modifiedSymbols, 40),
      modifiedPublicSymbols: limitArray(data.modifiedPublicSymbols, 40),
      riskDeltas: limitArray(data.riskDeltas, 20),
      affectedTests: limitArray(data.affectedTests, 30),
      tests: limitArray(data.tests, 30),
      testsNotRun: limitArray(data.testsNotRun, 30),
      missedLikelyTests: limitArray(data.missedLikelyTests, 30),
      ranTests: data.ranTests,
      ranCommands: Array.isArray(data.ranCommands) ? data.ranCommands.map((command) => (typeof command === "string" ? redactMcpText(command) : command)) : data.ranCommands,
      ranCommandReports: compactCommandReportList(data.ranCommandReports, 30),
      commandEnvelopes: compactCommandEnvelopeList(data.commandEnvelopes, 30),
      waivedChecks: data.waivedChecks,
      waivers: data.waivers,
      verificationCoverage: limitArray(data.verificationCoverage, 40),
      verificationLedger: limitArray(data.verificationLedger, 60),
      verificationProvenance: data.verificationProvenance ?? CURRENT_VERIFICATION_PROVENANCE,
      sessionMemory: data.sessionMemory,
      priorSessionMemory: data.priorSessionMemory,
      waivedVerification: limitArray(data.waivedVerification, 30),
      unindexedEditedFiles: data.unindexedEditedFiles,
      riskEscalations: limitArray(data.riskEscalations, 20),
      workflows: limitArray(data.workflows, 12),
      workflowChecks: limitArray(data.workflowChecks, 20),
      dependencyChecks: limitArray(data.dependencyChecks, 30),
      complexityReview: compactComplexityReview(data.complexityReview, 8),
      quality: data.quality,
      driftReasons: data.driftReasons,
      nextActions: data.nextActions,
      nextTools: compactNextTools(data.nextTools, truncation),
      systemMessage: stringValue(data.systemMessage),
      truncation: Object.keys(truncation).length > 0 ? truncation : undefined,
      snapshotLoad: compactSnapshotLoad(data.snapshotLoad),
      snapshot: snapshot
        ? {
            taskId: snapshot.taskId, publicationSequence: snapshot.publicationSequence,
            createdAt: snapshot.createdAt,
            origin: snapshot.origin,
            changeType: snapshot.changeType,
            planRevision: snapshot.planRevision,
            invariants: limitArray(snapshot.invariants, 12),
            plannedEditTargets: limitArray(snapshot.plannedEditTargets, 30),
            plannedFiles: limitArray(snapshot.plannedFiles, 40),
            plannedTests: limitArray(snapshot.plannedTests, 20),
            requiredWorkflowCheckCount: typeof snapshot.requiredWorkflowCheckCount === "number" ? snapshot.requiredWorkflowCheckCount : Array.isArray(snapshot.requiredWorkflowChecks) ? snapshot.requiredWorkflowChecks.length : 0,
            requiredDependencyCheckCount: typeof snapshot.requiredDependencyCheckCount === "number" ? snapshot.requiredDependencyCheckCount : Array.isArray(snapshot.requiredDependencyChecks) ? snapshot.requiredDependencyChecks.length : 0
          }
        : undefined,
      outcome: outcome
        ? {
            outcomeId: outcome.outcomeId,
            persisted: outcome.persisted,
            verdict: outcome.verdict,
            inspectMode: outcome.inspectMode,
            inspectReasons: limitArray(outcome.inspectReasons, 12),
            completionAuthority: outcome.completionAuthority,
            reviewCoverage: outcome.reviewCoverage,
            path: outcome.path,
            planRevision: outcome.planRevision,
            invariants: limitArray(outcome.invariants, 12),
            invariantReviews: limitArray(outcome.invariantReviews, 12),
            failureSignals: limitArray(outcome.failureSignals, 24),
            diffFootprint: outcome.diffFootprint,
            loopReview: outcome.loopReview,
            verificationArtifacts: limitArray(outcome.verificationArtifacts, 20),
            driftReasons: outcome.driftReasons,
            calibrationLabels: outcome.calibrationLabels,
            testsNotRun: limitArray(outcome.testsNotRun, 30),
            missedLikelyTests: limitArray(outcome.missedLikelyTests, 30),
            ranTests: outcome.ranTests,
            ranCommands: Array.isArray(outcome.ranCommands) ? outcome.ranCommands.map((command) => (typeof command === "string" ? redactMcpText(command) : command)) : outcome.ranCommands,
            ranCommandReports: compactCommandReportList(outcome.ranCommandReports, 30),
            commandEnvelopes: compactCommandEnvelopeList(outcome.commandEnvelopes, 30),
            waivedChecks: outcome.waivedChecks,
            waivers: outcome.waivers,
            verificationCoverage: limitArray(outcome.verificationCoverage, 40),
            verificationLedger: limitArray(outcome.verificationLedger, 60),
            verificationProvenance: outcome.verificationProvenance ?? data.verificationProvenance ?? CURRENT_VERIFICATION_PROVENANCE,
            waivedVerification: limitArray(nonEmptyArray(outcome.waivedVerification) ? outcome.waivedVerification : data.waivedVerification, 30),
            modifiedPublicSymbols: limitArray(outcome.modifiedPublicSymbols, 40),
            hookSummary: outcome.hookSummary,
            truncation: nestedTruncation("outcome", truncation)
          }
        : undefined
    }
  };
}

function compactPostEditTruncation(
  data: PostEditReviewData,
  snapshot: Record<string, unknown> | undefined,
  outcome: Record<string, unknown> | undefined
): Record<string, { total: number; returned: number }> {
  return {
    ...truncatedArray("reviewTargets", data.reviewTargets, 30),
    ...truncatedArray("changedSinceSnapshot", data.changedSinceSnapshot, 40),
    ...truncatedArray("changedGroups", data.changedGroups, 20),
    ...truncatedArray("resolvedBaselineFiles", data.resolvedBaselineFiles, 30),
    ...truncatedArray("plannedRenames", data.plannedRenames, 20),
    ...truncatedArray("unplannedChangedSymbols", data.unplannedChangedSymbols, 20),
    ...truncatedArray("plannedButUntouchedFiles", data.plannedButUntouchedFiles, 30),
    ...truncatedArray("symbolDeltas", data.symbolDeltas, 20),
    ...truncatedArray("modifiedSymbols", data.modifiedSymbols, 40),
    ...truncatedArray("modifiedPublicSymbols", data.modifiedPublicSymbols, 40),
    ...truncatedArray("riskDeltas", data.riskDeltas, 20),
    ...truncatedArray("affectedTests", data.affectedTests, 30),
    ...truncatedArray("tests", data.tests, 30),
    ...truncatedArray("testsNotRun", data.testsNotRun, 30),
    ...truncatedArray("missedLikelyTests", data.missedLikelyTests, 30),
    ...truncatedArray("ranCommandReports", data.ranCommandReports, 30),
    ...truncatedArray("commandEnvelopes", data.commandEnvelopes, 30),
    ...truncatedArray("verificationCoverage", data.verificationCoverage, 40),
    ...truncatedArray("verificationLedger", data.verificationLedger, 60),
    ...truncatedArray("waivedVerification", data.waivedVerification, 30),
    ...truncatedArray("riskEscalations", data.riskEscalations, 20),
    ...truncatedArray("invariants", data.invariants, 12),
    ...truncatedArray("invariantReviews", data.invariantReviews, 12),
    ...truncatedArray("failureSignals", data.failureSignals, 24),
    ...truncatedArray("verificationArtifacts", data.verificationArtifacts, 20),
    ...truncatedArray("workflows", data.workflows, 12),
    ...truncatedArray("workflowChecks", data.workflowChecks, 20),
    ...truncatedArray("dependencyChecks", data.dependencyChecks, 30),
    ...truncatedArray("snapshot.plannedEditTargets", snapshot?.plannedEditTargets, 30),
    ...truncatedArray("snapshot.plannedFiles", snapshot?.plannedFiles, 40),
    ...truncatedArray("snapshot.plannedTests", snapshot?.plannedTests, 20),
    ...truncatedArray("snapshot.invariants", snapshot?.invariants, 12),
    ...truncatedArray("outcome.testsNotRun", outcome?.testsNotRun, 30),
    ...truncatedArray("outcome.missedLikelyTests", outcome?.missedLikelyTests, 30),
    ...truncatedArray("outcome.ranCommandReports", outcome?.ranCommandReports, 30),
    ...truncatedArray("outcome.commandEnvelopes", outcome?.commandEnvelopes, 30),
    ...truncatedArray("outcome.verificationCoverage", outcome?.verificationCoverage, 40),
    ...truncatedArray("outcome.verificationLedger", outcome?.verificationLedger, 60),
    ...truncatedArray("outcome.waivedVerification", outcome ? (outcome.waivedVerification ?? data.waivedVerification) : undefined, 30),
    ...truncatedArray("outcome.modifiedPublicSymbols", outcome?.modifiedPublicSymbols, 40),
    ...truncatedArray("outcome.invariants", outcome?.invariants, 12),
    ...truncatedArray("outcome.invariantReviews", outcome?.invariantReviews, 12),
    ...truncatedArray("outcome.failureSignals", outcome?.failureSignals, 24),
    ...truncatedArray("outcome.verificationArtifacts", outcome?.verificationArtifacts, 20)
  };
}

function compactContextPacketData(data: ContextPacketData, mode: ContextPacketData["mode"]): McpCompactionResult {
  const limit = createArrayLimiter();
  const compacted = {
	    mode,
	    task: data.task,
	    changeType: data.changeType,
	    actionability: data.actionability,
	    tokenBudget: data.tokenBudget,
    packetVerdict: data.packetVerdict,
    focusFiles: limit("focusFiles", data.focusFiles, 20, compactFocusEntry),
    changedFiles: limit("changedFiles", data.changedFiles, 40),
    changedEntries: limit("changedEntries", data.changedEntries, 40, compactChangedEntry),
    changedSymbols: limit("changedSymbols", data.changedSymbols, 40, compactSymbolLike),
    unindexedChanged: limit("unindexedChanged", data.unindexedChanged, 40),
    groups: limit("groups", data.groups, 20, compactGroup),
    tests: limit("tests", data.tests, 30, compactTestRecommendation),
    snippets: limit("snippets", data.snippets, 12),
    contextSources: limit("contextSources", data.contextSources, 12),
    warnings: limit("warnings", data.warnings, 20),
    nextReads: limit("nextReads", data.nextReads, 20),
    baseline: data.baseline,
    retrieval: compactRetrieval(data.retrieval),
    diagnostics: limit("diagnostics", data.diagnostics, 20),
    recipes: limit("recipes", data.recipes, 12),
    verificationCommands: limit("verificationCommands", data.verificationCommands, 20),
    verificationCoverage: limit("verificationCoverage", data.verificationCoverage, 40, compactVerificationCoverage),
    verificationCommandPlan: limit("verificationCommandPlan", data.verificationCommandPlan, 30, compactVerificationPlan),
    value: data.value,
    quality: data.quality,
    worktree: data.worktree,
    worktreeDegradationReasons: data.worktreeDegradationReasons,
    gaps: limit("gaps", data.gaps, 30),
    nextTools: compactNextTools(data.nextTools, limit.truncation),
    systemMessage: stringValue(data.systemMessage),
    session: compactSession(data.session),
    sessionMemory: data.sessionMemory,
    workspaceGuidance: data.workspaceGuidance,
    skillHints: data.skillHints,
    targetPlaybooks: limit("targetPlaybooks", data.targetPlaybooks, 12),
    runtime: data.runtime,
    truncation: Object.keys(limit.truncation).length > 0 ? limit.truncation : undefined
  };
  return { data: compacted, truncation: limit.truncation, compacted: true };
}

function compactFocusBriefData(data: FocusBriefData): McpCompactionResult {
  const limit = createArrayLimiter();
  const compacted = {
	    mode: data.mode,
	    task: data.task,
	    actionability: data.actionability,
	    retrieval: compactRetrieval(data.retrieval),
    packetVerdict: data.packetVerdict,
    diagnostics: limit("diagnostics", data.diagnostics, 20),
    focusFiles: limit("focusFiles", data.focusFiles, 20, compactFileFact),
    workflows: limit("workflows", data.workflows, 12, compactWorkflow),
    modules: limit("modules", data.modules, 20, compactModule),
    groups: limit("groups", data.groups, 20, compactGroup),
    tests: limit("tests", data.tests, 30, compactTestRecommendation),
    nextCall: data.nextCall,
    sessionMemory: data.sessionMemory,
    quality: data.quality,
    worktree: data.worktree,
    worktreeDegradationReasons: data.worktreeDegradationReasons,
    gaps: limit("gaps", data.gaps, 30),
    nextTools: compactNextTools(data.nextTools, limit.truncation),
    systemMessage: stringValue(data.systemMessage),
    runtime: data.runtime,
    truncation: Object.keys(limit.truncation).length > 0 ? limit.truncation : undefined
  };
  return { data: compacted, truncation: limit.truncation, compacted: true };
}

function compactChangePlanData(data: ChangePlanData): McpCompactionResult {
  const limit = createArrayLimiter();
  const compactFocus = data.focus && typeof data.focus === "object" && !Array.isArray(data.focus) ? compactFocusBriefData(data.focus as FocusBriefData) : undefined;
  const compactContext = data.context && typeof data.context === "object" && !Array.isArray(data.context) ? compactContextPacketData(data.context as ContextPacketData, "context_pack") : undefined;
  const snapshotLimit = createArrayLimiter();
  const snapshotDirtyLimit = createArrayLimiter();
  const snapshot = data.snapshot && typeof data.snapshot === "object" && !Array.isArray(data.snapshot) ? (data.snapshot as Record<string, unknown>) : undefined;
  const compacted = {
    mode: data.mode,
    editReadiness: data.editReadiness,
    followCandidate: compactFollowCandidate(data.followCandidate),
    snapshotBlock: compactSnapshotBlock(data.snapshotBlock),
    targetCandidates: limit("targetCandidates", data.targetCandidates, 12, compactTargetCandidate),
    steps: limit("steps", data.steps, 12),
    focus: compactFocus?.data,
    context: compactContext?.data,
    files: limit("files", data.files, 30),
    plannedEditTargets: limit("plannedEditTargets", data.plannedEditTargets, 30),
    tests: limit("tests", data.tests, 30, compactTestRecommendation),
    recipes: limit("recipes", data.recipes, 12),
    quality: data.quality,
    requiredWorkflowChecks: limit("requiredWorkflowChecks", data.requiredWorkflowChecks, 20, compactCheck),
    requiredDependencyChecks: limit("requiredDependencyChecks", data.requiredDependencyChecks, 30, compactCheck),
    complexityReview: compactComplexityReview(data.complexityReview, 8),
    sessionMemory: data.sessionMemory,
    nextTools: compactNextTools(data.nextTools, limit.truncation),
    systemMessage: stringValue(data.systemMessage),
    snapshot: snapshot
      ? {
          taskId: snapshot.taskId,
          createdAt: snapshot.createdAt,
          origin: snapshot.origin,
          changeType: snapshot.changeType,
          planRevision: snapshot.planRevision,
          invariants: snapshotLimit("invariants", snapshot.invariants, 12),
          task: snapshot.task,
          plannedEditTargets: snapshotLimit("plannedEditTargets", snapshot.plannedEditTargets, 30),
          plannedFiles: snapshotLimit("plannedFiles", snapshot.plannedFiles, 40),
          focusFiles: snapshotLimit("focusFiles", snapshot.focusFiles, 20, compactFileFact),
          plannedTests: snapshotLimit("plannedTests", snapshot.plannedTests, 20, compactTestRecommendation),
          sessionMemory: snapshot.sessionMemory,
          requiredWorkflowCheckCount: typeof snapshot.requiredWorkflowCheckCount === "number" ? snapshot.requiredWorkflowCheckCount : Array.isArray(snapshot.requiredWorkflowChecks) ? snapshot.requiredWorkflowChecks.length : 0,
          requiredDependencyCheckCount: typeof snapshot.requiredDependencyCheckCount === "number" ? snapshot.requiredDependencyCheckCount : Array.isArray(snapshot.requiredDependencyChecks) ? snapshot.requiredDependencyChecks.length : 0,
          recipes: snapshotLimit("recipes", snapshot.recipes, 12),
          gaps: snapshotLimit("gaps", snapshot.gaps, 20),
          warnings: snapshotLimit("warnings", snapshot.warnings, 20),
          dirtyBaseline:
            snapshot.dirtyBaseline && typeof snapshot.dirtyBaseline === "object" && !Array.isArray(snapshot.dirtyBaseline)
              ? {
                  headCommit: (snapshot.dirtyBaseline as Record<string, unknown>).headCommit,
                  indexedAt: (snapshot.dirtyBaseline as Record<string, unknown>).indexedAt,
                  changedEntries: snapshotDirtyLimit("changedEntries", (snapshot.dirtyBaseline as Record<string, unknown>).changedEntries, 20, compactChangedEntry),
                  dirtyFiles: snapshotDirtyLimit("dirtyFiles", (snapshot.dirtyBaseline as Record<string, unknown>).dirtyFiles, 20),
                  truncation: Object.keys(snapshotDirtyLimit.truncation).length > 0 ? snapshotDirtyLimit.truncation : undefined
                }
              : undefined,
          baselineCounts: {
            symbolBaseline: isRecord(snapshot.symbolBaseline) ? Object.keys(snapshot.symbolBaseline).length : 0,
            riskBaseline: isRecord(snapshot.riskBaseline) ? Object.keys(snapshot.riskBaseline).length : 0
          },
          quality: snapshot.quality,
          truncation: Object.keys(snapshotLimit.truncation).length > 0 ? snapshotLimit.truncation : undefined
        }
      : undefined,
    runtime: data.runtime
  };
  const truncation = {
    ...limit.truncation,
    ...prefixTruncation("snapshot", snapshotLimit.truncation),
    ...prefixTruncation("snapshot.dirtyBaseline", snapshotDirtyLimit.truncation),
    ...prefixTruncation("focus", compactFocus?.truncation),
    ...prefixTruncation("context", compactContext?.truncation)
  };
  return { data: compacted, truncation, compacted: true };
}

function compactSnapshotBlock(value: unknown): unknown {
  if (!isRecord(value)) {
    return value;
  }
  return {
    taskId: value.taskId,
    path: value.path,
    status: value.status,
    reason: value.reason
  };
}

function compactFollowCandidate(value: unknown): unknown {
  if (!isRecord(value)) {
    return value;
  }
  return {
    status: value.status,
    requested: value.requested,
    candidateId: value.candidateId,
    rank: value.rank,
    kind: value.kind,
    path: value.path,
    reason: value.reason,
    plannedEditTargets: limitArray(value.plannedEditTargets, 8),
    validationReasons: limitArray(value.validationReasons, 8),
    snapshotLoad: isRecord(value.snapshotLoad)
      ? {
          latestTaskId: value.snapshotLoad.latestTaskId,
          missingReason: value.snapshotLoad.missingReason,
          error: value.snapshotLoad.error
        }
      : undefined
  };
}

function compactTargetCandidate(value: unknown): unknown {
  if (!isRecord(value)) {
    return value;
  }
  return {
    candidateId: value.candidateId,
    rank: value.rank,
    kind: value.kind,
    path: value.path,
    symbol: isRecord(value.symbol)
      ? {
          id: value.symbol.id,
          name: value.symbol.name,
          qualifiedName: value.symbol.qualifiedName,
          kind: value.symbol.kind
        }
      : undefined,
    score: value.score,
    confidence: value.confidence,
    evidence: limitArray(value.evidence, 8),
    missingAnchors: limitArray(value.missingAnchors, 8),
    validationStatus: value.validationStatus,
    validationReasons: limitArray(value.validationReasons, 8),
    wouldPlanEditTargets: limitArray(value.wouldPlanEditTargets, 8),
    wouldRecommendTests: limitArray(value.wouldRecommendTests, 8),
    candidateRisk: isRecord(value.candidateRisk)
      ? {
          score: value.candidateRisk.score,
          reasons: limitArray(value.candidateRisk.reasons, 6)
        }
      : undefined,
    nextChangePlanArgs: value.nextChangePlanArgs,
    rawSearchQueries: limitArray(value.rawSearchQueries, 4)
  };
}

function compactProofCardData(data: ProofCardData): McpCompactionResult {
  const limit = createArrayLimiter();
  const verification = isRecord(data.verification) ? data.verification : undefined;
  const reported = isRecord(verification?.reported) ? verification.reported : undefined;
  const compacted = {
    mode: data.mode,
    actionability: data.actionability,
    task: data.task,
    repoRoot: data.repoRoot,
    freshness: data.freshness,
    worktree: data.worktree,
    readFirst: limit("readFirst", data.readFirst, 12),
    snapshot: compactGenericValue(data.snapshot, { arrayLimit: 24, objectKeyLimit: 32, maxDepth: 5 }, limit.truncation, "snapshot"),
    verification: verification
      ? {
          recommendedCommands: limit("verification.recommendedCommands", verification.recommendedCommands, 20),
          commandPlan: limit("verification.commandPlan", verification.commandPlan, 30, compactVerificationPlan),
          ledgerPreview: limit("verification.ledgerPreview", verification.ledgerPreview, 60, compactVerificationLedgerEntry),
          tests: limit("verification.tests", verification.tests, 30, compactTestRecommendation),
          artifacts: compactGenericValue(verification.artifacts, { arrayLimit: 20, objectKeyLimit: 24, maxDepth: 5 }, limit.truncation, "verification.artifacts"),
          reported: reported
            ? {
                hasEvidence: reported.hasEvidence,
                ranTests: limit("verification.reported.ranTests", reported.ranTests, 30),
                ranCommands: Array.isArray(reported.ranCommands)
                  ? limit(
                      "verification.reported.ranCommands",
                      reported.ranCommands.map((command) => (typeof command === "string" ? redactMcpText(command) : command)),
                      30
                    )
                  : reported.ranCommands,
                ranCommandReports: compactCommandReportList(reported.ranCommandReports, 30),
                waivedChecks: limit("verification.reported.waivedChecks", reported.waivedChecks, 30),
                waivers: limit("verification.reported.waivers", reported.waivers, 30),
                coverage: limit("verification.reported.coverage", reported.coverage, 40, compactVerificationCoverage),
                commandEnvelopes: compactCommandEnvelopeList(reported.commandEnvelopes, 30),
                commandPlan: limit("verification.reported.commandPlan", reported.commandPlan, 30, compactVerificationPlan),
                ledger: limit("verification.reported.ledger", reported.ledger, 60, compactVerificationLedgerEntry),
                waivedVerification: limit("verification.reported.waivedVerification", reported.waivedVerification, 30, compactVerificationLedgerEntry),
                testsNotRun: limit("verification.reported.testsNotRun", reported.testsNotRun, 30, compactTestRecommendation),
                verificationProvenance: reported.verificationProvenance ?? data.verificationProvenance ?? CURRENT_VERIFICATION_PROVENANCE
              }
            : reported
        }
      : data.verification,
    policies: compactGenericValue(data.policies, { arrayLimit: 12, objectKeyLimit: 24, maxDepth: 5 }, limit.truncation, "policies"),
    decisionLog: compactGenericValue(data.decisionLog, { arrayLimit: 20, objectKeyLimit: 24, maxDepth: 6 }, limit.truncation, "decisionLog"),
    lifecycle: compactGenericValue(data.lifecycle, { arrayLimit: 20, objectKeyLimit: 24, maxDepth: 5 }, limit.truncation, "lifecycle"),
    verificationProvenance: data.verificationProvenance ?? CURRENT_VERIFICATION_PROVENANCE,
    trustPosture: limit("trustPosture", data.trustPosture, 12),
    gaps: limit("gaps", data.gaps, 30),
    nextCommands: limit("nextCommands", data.nextCommands, 12),
    sessionMemory: data.sessionMemory,
    nextTools: compactNextTools(data.nextTools, limit.truncation),
    systemMessage: stringValue(data.systemMessage),
    runtime: data.runtime,
    truncation: Object.keys(limit.truncation).length > 0 ? limit.truncation : undefined
  };
  return { data: compacted, truncation: limit.truncation, compacted: true };
}

function compactTestPlanData(data: TestPlanData): McpCompactionResult {
  const limit = createArrayLimiter();
  const compacted = {
    mode: data.mode ?? "test_plan",
    actionability: data.actionability,
    targetFiles: limit("targetFiles", data.targetFiles, 40),
    unindexedTargetFiles: limit("unindexedTargetFiles", data.unindexedTargetFiles, 40),
    rejectedTargetFiles: limit("rejectedTargetFiles", data.rejectedTargetFiles, 40),
    changedFiles: limit("changedFiles", data.changedFiles, 40),
    changedEntries: limit("changedEntries", data.changedEntries, 40, compactChangedEntry),
    changedSymbols: limit("changedSymbols", data.changedSymbols, 40, compactSymbolLike),
    unindexedChanged: limit("unindexedChanged", data.unindexedChanged, 40),
    groups: limit("groups", data.groups, 20, compactGroup),
    tests: limit("tests", data.tests, 30, compactTestRecommendation),
    outcomeLearning: limit("outcomeLearning", data.outcomeLearning, 12),
	    verificationCommands: limit("verificationCommands", data.verificationCommands, 20),
	    verificationCoverage: limit("verificationCoverage", data.verificationCoverage, 40, compactVerificationCoverage),
	    commandEnvelopes: limit("commandEnvelopes", data.commandEnvelopes, 60),
	    verificationCommandPlan: limit("verificationCommandPlan", data.verificationCommandPlan, 30, compactVerificationPlan),
	    verificationLedger: limit("verificationLedger", data.verificationLedger, 60, compactVerificationLedgerEntry),
	    verificationLedgerPreview: limit("verificationLedgerPreview", data.verificationLedgerPreview, 60, compactVerificationLedgerEntry),
	    verificationProvenance: data.verificationProvenance,
	    testsNotRun: limit("testsNotRun", data.testsNotRun, 30, compactTestRecommendation),
	    sessionMemory: data.sessionMemory,
    worktree: data.worktree,
    worktreeDegradationReasons: data.worktreeDegradationReasons,
    gaps: limit("gaps", data.gaps, 30),
    nextTools: compactNextTools(data.nextTools, limit.truncation),
    systemMessage: stringValue(data.systemMessage),
    runtime: data.runtime,
    truncation: Object.keys(limit.truncation).length > 0 ? limit.truncation : undefined
  };
  return { data: compacted, truncation: limit.truncation, compacted: true };
}
