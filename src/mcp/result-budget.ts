import { CURRENT_VERIFICATION_PROVENANCE } from "../types.js";
import { MCP_DETAILED_PROJECTION_TARGET_BYTES } from "./compaction.js";
import { compactTerminalDecisionKernel, mcpDecisionKernel } from "./decision-kernel.js";
import { isRecord, stringValue } from "./compaction-helpers.js";

/** Ordinary calls must never receive an accidentally detailed packet. */
export const MCP_TOOL_RESULT_MAX_BYTES = 24 * 1_024;
/** Preserve the 512 KiB detailed data contract plus bounded envelope overhead. */
export const MCP_TOOL_RESULT_DETAILED_MAX_BYTES = MCP_DETAILED_PROJECTION_TARGET_BYTES + 64 * 1_024;

const TEXT_MAX_BYTES = 4 * 1_024;
const ACTIONABILITY = new Set(["orientation", "edit_ready", "blocked", "review", "verify", "done", "needs_target", "raw_search_better", "raw_search_sufficient", "inspect_first"]);
const PHASES = new Set(["orientation", "brief", "plan", "review", "verify", "inspect"]);

type McpToolResultShape = {
  content: Array<Record<string, unknown>>;
  structuredContent: Record<string, unknown>;
};

/** Enforce a cap on the serialized ToolResult, not only structuredContent.data. */
export function boundMcpToolResult<T extends McpToolResultShape>(result: T): T {
  // Capture the caller-visible shape before transport-specific freshness/text
  // compaction so truncation provenance describes what was actually omitted.
  const originalBytes = byteLength(result);
  const detailed = requestedFormat(result.structuredContent) === "detailed";
  const maxBytes = detailed ? MCP_TOOL_RESULT_DETAILED_MAX_BYTES : MCP_TOOL_RESULT_MAX_BYTES;
  // The budgeter is a lossless pass-through until the full serialized result
  // actually exceeds its tier. In particular, explicit detailed responses do
  // not silently lose freshness evidence merely because a compact tier exists.
  if (originalBytes <= maxBytes) return result;
  const envelope = {
    ...result.structuredContent,
    freshness: compactFreshness(result.structuredContent.freshness),
    refresh: compactRefresh(result.structuredContent.refresh)
  };
  const candidate = {
    ...result,
    content: compactContent(result.content, detailed ? MCP_TOOL_RESULT_DETAILED_MAX_BYTES : TEXT_MAX_BYTES),
    structuredContent: envelope
  } as T;
  const receipt = withActualReturnedBytes(budgetReceipt(candidate, originalBytes, maxBytes));
  return (byteLength(receipt) <= maxBytes
    ? receipt
    : withActualReturnedBytes(emergencyReceipt(candidate, originalBytes, maxBytes))) as T;
}

function budgetReceipt(result: McpToolResultShape, originalBytes: number, maxBytes: number): McpToolResultShape {
  const envelope = result.structuredContent;
  const sourceData = isRecord(envelope.data) ? envelope.data : {};
  const mode = bounded(stringValue(envelope.mode) ?? stringValue(sourceData.mode) ?? "unknown", 60);
  const sourceKernel = isRecord(sourceData.decisionKernel) ? sourceData.decisionKernel : mcpDecisionKernel(sourceData, mode, envelope.freshness);
  const compactedKernel = compactTerminalDecisionKernel(sourceKernel);
  const sourceAuthority = isRecord(compactedKernel.authority) ? compactedKernel.authority : {};
  const originalActionability = validActionability(sourceAuthority.originalActionability ?? sourceAuthority.actionability ?? envelope.actionability);
  const sourceDelivery = compactDelivery(sourceData.delivery) ?? {
    schemaVersion: 1,
    requestedFormat: requestedFormat(envelope) ?? "auto",
    effectiveFormat: "concise"
  };
  const resultUri = detailedResultUri(sourceDelivery.resultUri);
  const terminalDetailRequired = compactedKernel.detailsRequired === true;
  const sourceNextTools = authoritativeNextTools(envelope, sourceData, sourceKernel);
  const sourceNextTool = sourceNextTools[0];
  const completeNextTool = completeNextToolContract(sourceNextTool);
  const sourceNextToolIncomplete = isRecord(sourceNextTool) && !completeNextTool;
  const sourceNextToolTruncated = hasFirstNextToolContractTruncation(sourceNextTool, envelope.truncation, sourceData.truncation, sourceKernel.truncation);

  const buildReceipt = (nextToolContractOmitted: boolean, projectedNextTools: unknown[]): McpToolResultShape => {
    const effectiveDetailRequired = terminalDetailRequired || nextToolContractOmitted;
    // Freshness is itself an orientation summary: stale/reason/count authority
    // remains complete after its unbounded path/hash lists are removed. It has
    // no narrower MCP form, so direct users to source control for exact paths.
    const compactSummarySufficient = mode === "freshness";
    const detailUnavailable = !resultUri && !compactSummarySufficient;
    const systemMessage = compactSummarySufficient && !resultUri
      ? "Freshness detail was compacted; stale state, reason, and dirty count remain authoritative. Use git status --short for exact paths; no further Codexa call is required."
      : detailUnavailable
        ? "Result detail was omitted to enforce the MCP transport budget; do not act on missing evidence. Retry with a narrower request."
        : nextToolContractOmitted
          ? "Executable next-tool arguments were omitted to enforce the MCP transport budget; read the linked detailed result before acting."
        : terminalDetailRequired
          ? optionalBounded(compactedKernel.systemMessage, 240) ?? "Required detailed evidence is omitted from this bounded receipt; read the linked detailed result before acting."
          : optionalBounded(sourceData.systemMessage ?? envelope.systemMessage, 240);
    // The terminal kernel is the authority after transport compaction. Exact
    // lifecycle modes intentionally fail closed until their linked detail is
    // read, so the envelope must not retain the pre-compaction edit authority.
    const authorityBlocked = detailUnavailable || nextToolContractOmitted;
    const actionability = authorityBlocked ? "blocked" : validActionability(sourceAuthority.actionability);
    const authority = authorityBlocked
      ? defined({ ...sourceAuthority, actionability, originalActionability })
      : sourceAuthority;
    const projectedNextToolNames = toolNames(projectedNextTools, 1, 80);
    const kernel = authorityBlocked
      ? defined({ ...compactedKernel, authority, nextTools: [], systemMessage, detailsRequired: true })
      : compactSummarySufficient
        ? defined({ ...compactedKernel, authority, nextTools: [], systemMessage, detailsRequired: undefined })
        : projectedNextToolNames.length > 0
          ? defined({ ...compactedKernel, nextTools: projectedNextToolNames })
          : compactedKernel;
    const delivery = defined({
      ...sourceDelivery,
      resultUri,
      effectiveFormat: "concise",
      detailAvailable: resultUri ? true : false,
      detailRequired: effectiveDetailRequired || detailUnavailable || sourceDelivery.detailRequired === true,
      requiredDetailReason: sourceDelivery.requiredDetailReason ?? (effectiveDetailRequired || detailUnavailable ? "tool-result-budget" : undefined),
      escalationReason: sourceDelivery.escalationReason ?? "tool-result-budget"
    });
    const truncation = { "__mcp.toolResultBudget": { total: originalBytes, returned: maxBytes } };
    const data = defined({
      mode,
      actionability,
      verdict: optionalBounded(authority.verdict ?? sourceData.verdict, 80),
      packetVerdict: optionalBounded(authority.packetVerdict ?? sourceData.packetVerdict, 80),
      completionAuthority: optionalBounded(authority.completionAuthority ?? sourceData.completionAuthority, 80),
      inspectMode: optionalBounded(authority.inspectMode ?? sourceData.inspectMode, 80),
      delivery,
      decisionKernel: kernel,
      systemMessage,
      truncation,
      mcp: { compacted: true, targetBytes: maxBytes, hardBudgetEnforced: true, budgetCompaction: "tool-result" }
    });
    const nextTools = authorityBlocked || terminalDetailRequired ? [] : projectedNextTools;
    const lifecycleNextTools = toolNames(nextTools, 1, 80);
    const relatedResources = resultUri
      ? [{ uri: resultUri, name: "Codexa detailed MCP result", mimeType: "application/json", description: "Content-addressed detailed packet" }]
      : [];
    const structuredContent = {
      schemaVersion: 1,
      mode,
      actionability,
      data,
      freshness: minimalFreshness(envelope.freshness),
      refresh: compactRefresh(envelope.refresh),
      lifecycle: compactLifecycle(
        envelope.lifecycle,
        lifecycleNextTools,
        effectiveDetailRequired
          ? resultUri
            ? "Read the linked detailed result before acting"
            : "MCP transport budget omitted required detail"
          : detailUnavailable
            ? "MCP transport budget omitted required detail"
            : undefined
      ),
      worktree: compactWorktree(envelope.worktree),
      verificationProvenance: CURRENT_VERIFICATION_PROVENANCE,
      truncation,
      nextTools,
      systemMessage,
      relatedResources
    };
    const text = [
      `Codexa ${mode} result compacted to the MCP transport budget.`,
      `Actionability: ${actionability}`,
      stringValue(authority.verdict) ? `Verdict: ${bounded(stringValue(authority.verdict)!, 100)}` : undefined,
      stringValue(authority.completionAuthority) ? `Completion authority: ${bounded(stringValue(authority.completionAuthority)!, 100)}` : undefined,
      stringValue(delivery?.escalationReason) ? `Delivery: ${bounded(stringValue(delivery?.escalationReason)!, 160)}` : undefined,
      resultUri ? `Detailed result: ${resultUri}` : undefined,
      systemMessage
    ].filter((line): line is string => Boolean(line)).join("\n");
    return {
      content: [{ type: "text", text }, ...relatedResources.map((resource) => ({ type: "resource_link", ...resource }))],
      structuredContent
    };
  };

  if (completeNextTool && !sourceNextToolTruncated) {
    const contractReceipt = withActualReturnedBytes(buildReceipt(false, [completeNextTool]));
    if (byteLength(contractReceipt) <= maxBytes) return contractReceipt;
    return buildReceipt(true, []);
  }
  if (sourceNextToolTruncated || sourceNextToolIncomplete) return buildReceipt(true, []);
  return buildReceipt(false, toolNames(compactedKernel.nextTools, 1, 80));
}

/** Fixed-shape fail-closed receipt for any future field-growth regression. */
function emergencyReceipt(result: McpToolResultShape, originalBytes: number, maxBytes: number): McpToolResultShape {
  const envelope = result.structuredContent;
  const sourceData = isRecord(envelope.data) ? envelope.data : {};
  const sourceKernel = isRecord(sourceData.decisionKernel)
    ? sourceData.decisionKernel
    : mcpDecisionKernel(sourceData, stringValue(envelope.mode) ?? "unknown", envelope.freshness);
  const authority = isRecord(sourceKernel.authority) ? sourceKernel.authority : {};
  const mode = ascii(stringValue(envelope.mode) ?? stringValue(sourceData.mode) ?? "unknown", 40);
  const sourceDelivery = isRecord(sourceData.delivery) ? sourceData.delivery : {};
  const resultUri = typeof sourceDelivery.resultUri === "string" && /^codexa:\/\/repo\/mcp-results\/rr_[a-f0-9]{32}\/mr_[a-f0-9]{64}$/u.test(sourceDelivery.resultUri)
    ? sourceDelivery.resultUri
    : undefined;
  const delivery = defined({
    schemaVersion: 1,
    requestedFormat: sourceDelivery.requestedFormat === "detailed" || sourceDelivery.requestedFormat === "concise" ? sourceDelivery.requestedFormat : "auto",
    effectiveFormat: "concise",
    resultUri,
    detailAvailable: Boolean(resultUri),
    detailRequired: true,
    requiredDetailReason: optionalAscii(sourceDelivery.requiredDetailReason, 80) ?? "tool-result-budget",
    escalationReason: optionalAscii(sourceDelivery.escalationReason, 80) ?? "tool-result-budget"
  });
  const decisionKernel = {
    schemaVersion: 1,
    mode,
    authority: defined({
      actionability: "blocked",
      originalActionability: validActionability(authority.originalActionability ?? authority.actionability ?? envelope.actionability),
      verdict: optionalAscii(authority.verdict ?? sourceData.verdict, 40),
      completionAuthority: optionalAscii(authority.completionAuthority ?? sourceData.completionAuthority, 40)
    }),
    detailsRequired: true
  };
  const truncation = { "__mcp.toolResultBudget": { total: originalBytes, returned: maxBytes } };
  const relatedResources = resultUri ? [{ uri: resultUri, name: "Codexa detailed MCP result", mimeType: "application/json" }] : [];
  const message = "Result detail was omitted to enforce the MCP transport budget; do not edit from this receipt alone.";
  return {
    content: [
      { type: "text", text: `Codexa ${mode} result compacted to the MCP transport budget.\nActionability: blocked${resultUri ? `\nDetailed result: ${resultUri}` : ""}` },
      ...relatedResources.map((resource) => ({ type: "resource_link", ...resource }))
    ],
    structuredContent: {
      schemaVersion: 1,
      mode,
      actionability: "blocked",
      data: { mode, actionability: "blocked", delivery, decisionKernel, truncation, mcp: { compacted: true, targetBytes: maxBytes, hardBudgetEnforced: true, budgetCompaction: "tool-result-emergency" } },
      freshness: emptyFreshness(envelope.freshness),
      refresh: { refreshed: false },
      lifecycle: { phase: "inspect", preconditions: [], blockingReasons: ["MCP transport budget omitted required detail"], nextTools: [] },
      worktree: { knownClean: false, unknown: true, degraded: true, dirtyFileCount: 0, degradedReasons: ["MCP transport budget omitted worktree detail"] },
      verificationProvenance: CURRENT_VERIFICATION_PROVENANCE,
      truncation,
      nextTools: [],
      systemMessage: message,
      relatedResources
    }
  };
}

function compactFreshness(value: unknown): Record<string, unknown> {
  const source = isRecord(value) ? value : {};
  return {
    schemaVersion: 1,
    snapshotId: bounded(stringValue(source.snapshotId) ?? "unknown", 120),
    repoRoot: bounded(stringValue(source.repoRoot) ?? "", 280),
    gitRoot: source.gitRoot === null ? null : optionalBounded(source.gitRoot, 280) ?? null,
    headCommit: source.headCommit === null ? null : optionalBounded(source.headCommit, 100) ?? null,
    indexedAt: bounded(stringValue(source.indexedAt) ?? "", 80),
    dirtyFiles: strings(source.dirtyFiles, 12, 280),
    dirtyFileCount: number(source.dirtyFileCount) || (Array.isArray(source.dirtyFiles) ? source.dirtyFiles.length : 0),
    dirtyFileHashes: stringRecord(source.dirtyFileHashes, 12),
    indexedDirtyFileHashes: stringRecord(source.indexedDirtyFileHashes, 12),
    indexedDirtyFiles: strings(source.indexedDirtyFiles, 12, 280),
    indexedDirtyFileCount: number(source.indexedDirtyFileCount) || (Array.isArray(source.indexedDirtyFiles) ? source.indexedDirtyFiles.length : 0),
    missing: source.missing === true,
    stale: source.stale === true,
    reason: bounded(typeof source.reason === "string" ? source.reason : "", 240),
    parserErrorCount: number(source.parserErrorCount)
  };
}

function minimalFreshness(value: unknown): Record<string, unknown> {
  const source = compactFreshness(value);
  return { ...source, dirtyFiles: [], dirtyFileHashes: {}, indexedDirtyFileHashes: {}, indexedDirtyFiles: [] };
}

function emptyFreshness(value: unknown): Record<string, unknown> {
  const source = isRecord(value) ? value : {};
  return { schemaVersion: 1, snapshotId: "omitted", repoRoot: "", gitRoot: null, headCommit: null, indexedAt: "", dirtyFiles: [], dirtyFileHashes: {}, indexedDirtyFileHashes: {}, indexedDirtyFiles: [], missing: source.missing === true, stale: source.stale === true, reason: "transport-budget", parserErrorCount: 0 };
}

function compactRefresh(value: unknown): Record<string, unknown> {
  const source = isRecord(value) ? value : {};
  return defined({ refreshed: source.refreshed === true, reason: optionalBounded(source.reason, 160), indexedAt: optionalBounded(source.indexedAt, 80) });
}

function compactLifecycle(value: unknown, nextTools: string[], detailBlockReason?: string): Record<string, unknown> {
  const source = isRecord(value) ? value : {};
  return {
    phase: PHASES.has(String(source.phase)) ? source.phase : "inspect",
    preconditions: strings(source.preconditions, 2, 160),
    blockingReasons: [
      ...strings(source.blockingReasons, detailBlockReason ? 2 : 3, 180),
      ...(detailBlockReason ? [detailBlockReason] : [])
    ],
    nextTools
  };
}

function compactWorktree(value: unknown): Record<string, unknown> {
  const source = isRecord(value) ? value : {};
  return { knownClean: source.knownClean === true, unknown: source.unknown === true, degraded: source.degraded === true, dirtyFileCount: number(source.dirtyFileCount), degradedReasons: strings(source.degradedReasons, 3, 180) };
}

function compactDelivery(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  return defined({
    schemaVersion: 1,
    requestedFormat: value.requestedFormat === "detailed" || value.requestedFormat === "concise" ? value.requestedFormat : "auto",
    effectiveFormat: value.effectiveFormat === "detailed" ? "detailed" : "concise",
    resultId: optionalBounded(value.resultId, 100),
    resultUri: optionalBounded(value.resultUri, 500),
    detailAvailable: typeof value.detailAvailable === "boolean" ? value.detailAvailable : undefined,
    detailRequired: typeof value.detailRequired === "boolean" ? value.detailRequired : undefined,
    requiredDetailReason: optionalBounded(value.requiredDetailReason, 160),
    unchangedReceipt: value.unchangedReceipt === true || undefined,
    escalationReason: optionalBounded(value.escalationReason, 160)
  });
}

function authoritativeNextTools(envelope: Record<string, unknown>, data: Record<string, unknown>, kernel: Record<string, unknown>): unknown[] {
  if (Array.isArray(envelope.nextTools)) return envelope.nextTools;
  if (Array.isArray(data.nextTools)) return data.nextTools;
  return Array.isArray(kernel.nextTools) ? kernel.nextTools : [];
}

function completeNextToolContract(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)
    || !stringValue(value.tool)
    || !isRecord(value.requiredInputs)
    || typeof value.readOnly !== "boolean"
    || !Array.isArray(value.writes)
    || !value.writes.every((entry) => typeof entry === "string")) {
    return undefined;
  }
  return value;
}

function hasFirstNextToolContractTruncation(...values: unknown[]): boolean {
  return values.some((value) => hasTruncationPath(value, "", 0));
}

function hasTruncationPath(value: unknown, pathName: string, depth: number): boolean {
  if (depth > 8 || !isRecord(value)) return false;
  return Object.entries(value).some(([key, entry]) => {
    const entryPath = pathName ? `${pathName}.${key}` : key;
    if (/(?:^|\.)nextTools\.(?:0|entry)\.(?:requiredInputs|writes)(?:\.|$)/u.test(entryPath)) return true;
    return isRecord(entry) && hasTruncationPath(entry, entryPath, depth + 1);
  });
}

function toolNames(value: unknown, limit: number, width: number): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (typeof entry === "string") return [bounded(entry, width)];
    return isRecord(entry) && typeof entry.tool === "string" ? [bounded(entry.tool, width)] : [];
  }).slice(0, limit);
}

function compactContent(content: Array<Record<string, unknown>>, maxTextBytes: number): Array<Record<string, unknown>> {
  return content.slice(0, 6).flatMap((entry) => {
    if (entry.type === "text" && typeof entry.text === "string") return [{ type: "text", text: clipUtf8(entry.text, maxTextBytes) }];
    if (entry.type !== "resource_link" || typeof entry.uri !== "string") return [];
    return [defined({ type: "resource_link", uri: bounded(entry.uri, 500), name: optionalBounded(entry.name, 120), mimeType: optionalBounded(entry.mimeType, 100), description: optionalBounded(entry.description, 180) })];
  });
}

function requestedFormat(envelope: Record<string, unknown>): string | undefined {
  const data = isRecord(envelope.data) ? envelope.data : undefined;
  return stringValue(isRecord(data?.delivery) ? data.delivery.requestedFormat : undefined);
}

function detailedResultUri(value: unknown): string | undefined {
  return typeof value === "string" && /^codexa:\/\/repo\/mcp-results\/rr_[a-f0-9]{32}\/mr_[a-f0-9]{64}$/u.test(value)
    ? value
    : undefined;
}

function strings(value: unknown, limit: number, width: number): string[] {
  return Array.isArray(value) ? value.slice(0, limit).map((entry) => bounded(typeof entry === "string" ? entry : String(entry), width)) : [];
}

function stringRecord(value: unknown, limit: number): Record<string, string> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(Object.entries(value).slice(0, limit).map(([key, entry]) => [bounded(key, 280), bounded(typeof entry === "string" ? entry : String(entry), 160)]));
}

function validActionability(value: unknown): string {
  return typeof value === "string" && ACTIONABILITY.has(value) ? value : "blocked";
}

function number(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function optionalBounded(value: unknown, limit: number): string | undefined {
  return typeof value === "string" && value.length > 0 ? bounded(value, limit) : undefined;
}

function bounded(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, Math.max(0, limit - 1))}…`;
}

function optionalAscii(value: unknown, limit: number): string | undefined {
  return typeof value === "string" && value.length > 0 ? ascii(value, limit) : undefined;
}

function ascii(value: string, limit: number): string {
  return bounded(value.replace(/[^\x20-\x7e]/gu, "?"), limit);
}

function clipUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  const suffix = "\n[Codexa text truncated to transport budget]";
  const prefix = Buffer.from(value, "utf8").subarray(0, maxBytes - Buffer.byteLength(suffix, "utf8")).toString("utf8").replace(/\uFFFD+$/u, "");
  return `${prefix}${suffix}`;
}

function byteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function withActualReturnedBytes(result: McpToolResultShape): McpToolResultShape {
  let measured = byteLength(result);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    setReturnedBytes(result.structuredContent.truncation, measured);
    const data = isRecord(result.structuredContent.data) ? result.structuredContent.data : undefined;
    setReturnedBytes(data?.truncation, measured);
    const next = byteLength(result);
    if (next === measured) return result;
    measured = next;
  }
  setReturnedBytes(result.structuredContent.truncation, measured);
  const data = isRecord(result.structuredContent.data) ? result.structuredContent.data : undefined;
  setReturnedBytes(data?.truncation, measured);
  return result;
}

function setReturnedBytes(value: unknown, returned: number): void {
  if (!isRecord(value)) return;
  const budget = isRecord(value["__mcp.toolResultBudget"]) ? value["__mcp.toolResultBudget"] : undefined;
  if (budget) budget.returned = returned;
}

function defined(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
}
