import path from "node:path";
import { z } from "zod";
import { MCP_TOOL_CATALOG } from "../mcp-tool-catalog.js";
import { nextToolNames } from "../query/next-tools.js";
import { CURRENT_VERIFICATION_PROVENANCE } from "../types.js";
import type { FreshnessInfo, QueryResult, RefreshInfo } from "../types.js";
import { compactNextTools, inferMcpDataMode } from "./compaction.js";
import { deriveMcpActionability, mcpAuthorityBlocked, renderMcpConciseText } from "./decision-kernel.js";
import { boundMcpToolResult } from "./result-budget.js";
import { DISPATCHABLE_MCP_TOOL_NAMES, MEMORY_RECORDING_MCP_TOOL_NAMES, SOURCE_CONTEXT_MCP_TOOL_NAMES } from "./tool-registry.js";

export const MCP_ACTIONABILITY_VALUES = ["orientation", "edit_ready", "blocked", "review", "verify", "done", "needs_target", "raw_search_better", "raw_search_sufficient", "inspect_first"] as const;
type McpActionability = (typeof MCP_ACTIONABILITY_VALUES)[number];

export type McpToolPolicyOptions = {
  autoRefresh: boolean;
  sessionMemoryMode: string;
  // When the server runs a reduced tool profile, guidance (nextTools,
  // derived systemMessage) must not steer the model to unregistered tools.
  enabledTools?: ReadonlySet<string>;
  input?: Record<string, unknown>;
  data?: Record<string, unknown>;
};

type McpToolPolicy = {
  name: string;
  tier: string;
  phase: string;
  readOnly: boolean;
  writeEffects: string;
  useWhen: string;
  avoidWhen: string;
  nextToolUse: string[];
};

const sourceContextToolNames = new Set<string>(SOURCE_CONTEXT_MCP_TOOL_NAMES);
const memoryRecordingToolNames = new Set<string>(MEMORY_RECORDING_MCP_TOOL_NAMES);

export type McpOutputSchemaDetail = "compact" | "full";

export function mcpOutputSchemaDetail(): McpOutputSchemaDetail {
  return process.env.CODEXA_MCP_OUTPUT_SCHEMA === "full" ? "full" : "compact";
}

export function createMcpOutputSchema(detail: McpOutputSchemaDetail = mcpOutputSchemaDetail()): Record<string, z.ZodTypeAny> {
  // Every tool repeats this schema in tools/list, so its serialized size is a
  // per-session token tax multiplied by the tool count. The compact default
  // keeps the envelope's top-level contract (keys, required/optional, enums)
  // and relaxes nested object internals to permissive records — every
  // envelope that validates against the full schema also validates here.
  // CODEXA_MCP_OUTPUT_SCHEMA=full restores the deep self-describing schema.
  if (detail === "compact") {
    const looseRecord = z.record(z.string(), z.unknown());
    return {
      schemaVersion: z.literal(1),
      mode: z.string(),
      actionability: z.enum(MCP_ACTIONABILITY_VALUES),
      data: z.object({ mode: z.string() }).catchall(z.unknown()),
      freshness: looseRecord,
      refresh: looseRecord,
      quality: z.unknown().optional(),
      lifecycle: looseRecord,
      toolPolicy: looseRecord.optional(),
      worktree: looseRecord,
      verificationProvenance: looseRecord,
      truncation: z.record(z.string(), z.object({ total: z.number(), returned: z.number() })).optional(),
      nextTools: z.array(z.unknown()).optional(),
      systemMessage: z.string().optional(),
      relatedResources: z.array(looseRecord).optional()
    };
  }
  const mcpTruncationSchema = z.record(z.string(), z.object({ total: z.number(), returned: z.number() }));
  const mcpRelatedResourceSchema = z.object({
    uri: z.string(),
    name: z.string(),
    mimeType: z.string().optional(),
    description: z.string().optional()
  });
  const mcpDataSchema = z
    .object({
      mode: z.string()
    })
    .catchall(z.unknown());
  const freshnessSchema = z.object({
    schemaVersion: z.literal(1),
    snapshotId: z.string(),
    repoRoot: z.string(),
    gitRoot: z.string().nullable(),
    headCommit: z.string().nullable(),
    indexedAt: z.string(),
    dirtyFiles: z.array(z.string()),
    dirtyFileHashes: z.record(z.string(), z.string()),
    indexedDirtyFileHashes: z.record(z.string(), z.string()),
    indexedDirtyFiles: z.array(z.string()),
    missing: z.boolean(),
    stale: z.boolean(),
    reason: z.string(),
    parserErrorCount: z.number(),
    externalRiskReportHashes: z.record(z.string(), z.string()).optional(),
    indexedExternalRiskReportHashes: z.record(z.string(), z.string()).optional(),
    externalRiskReportDiagnostics: z.array(z.object({ path: z.string(), reason: z.string(), sizeBytes: z.number().optional(), limitBytes: z.number().optional() })).optional()
  });
  const refreshSchema = z.object({
    refreshed: z.boolean(),
    reason: z.string().optional(),
    indexedAt: z.string().optional()
  });
  const lifecycleSchema = z.object({
    phase: z.enum(["orientation", "brief", "plan", "review", "verify", "inspect"]),
    taskId: z.string().optional(),
    snapshotStatus: z.enum(["blocked", "saved", "loaded", "missing-or-ambiguous"]).optional(),
    preconditions: z.array(z.string()),
    blockingReasons: z.array(z.string()),
    nextTools: z.array(z.string())
  });
  const guidedNextToolSchema = z.object({
    schemaVersion: z.literal(1),
    tool: z.string(),
    reason: z.string(),
    requiredInputs: z.record(z.string(), z.unknown()).optional(),
    readOnly: z.boolean(),
    writes: z.array(z.string())
  });
  const toolPolicySchema = z.object({
    name: z.string(),
    tier: z.string(),
    phase: z.string(),
    readOnly: z.boolean(),
    writeEffects: z.string(),
    useWhen: z.string(),
    avoidWhen: z.string(),
    nextToolUse: z.array(z.string())
  });
  const worktreeSchema = z.object({
    knownClean: z.boolean(),
    // True when the packet carried no worktree signal at all: knownClean is
    // then false-by-honesty, not a verified clean tree.
    unknown: z.boolean(),
    degraded: z.boolean(),
    dirtyFileCount: z.number(),
    degradedReasons: z.array(z.string())
  });
  const verificationProvenanceSchema = z.object({
    schemaVersion: z.literal(1),
    commandCoverageClassifier: z.literal("codexa-command-coverage"),
    commandCoverageClassifierVersion: z.string(),
    commandEnvelopeRulesetVersion: z.string(),
    verificationCoverageVersion: z.string(),
    verificationLedgerVersion: z.string()
  });
  return {
    schemaVersion: z.literal(1),
    mode: z.string(),
    actionability: z.enum(MCP_ACTIONABILITY_VALUES),
    data: mcpDataSchema,
    freshness: freshnessSchema,
    refresh: refreshSchema,
    quality: z.unknown().optional(),
    lifecycle: lifecycleSchema,
    toolPolicy: toolPolicySchema.optional(),
    worktree: worktreeSchema,
    verificationProvenance: verificationProvenanceSchema,
    truncation: mcpTruncationSchema.optional(),
    nextTools: z.array(guidedNextToolSchema.or(z.string())).optional(),
    systemMessage: z.string().optional(),
    relatedResources: z.array(mcpRelatedResourceSchema).optional()
  };
}

export function toToolResult(result: { text: string; data: unknown; freshness: unknown; refresh?: unknown }, toolName: string, policyOptions: McpToolPolicyOptions) {
  const envelope = buildMcpEnvelope(result, toolName, policyOptions);
  const envelopeData = isRecord(envelope.data) ? envelope.data : {};
  const delivery = isRecord(envelopeData.delivery) ? envelopeData.delivery : undefined;
  const text = delivery?.effectiveFormat === "concise" || policyOptions.enabledTools
    ? renderMcpConciseText({ text: result.text, data: envelopeData, freshness: envelope.freshness as FreshnessInfo, refresh: envelope.refresh as RefreshInfo })
    : result.text;
  return boundMcpToolResult({
    content: [
      {
        type: "text" as const,
        text
      },
      ...envelope.relatedResources.map((resource) => ({ type: "resource_link" as const, ...resource }))
    ],
    structuredContent: envelope
  });
}

function buildMcpEnvelope(result: { data: unknown; freshness: unknown; refresh?: unknown }, toolName: string, policyOptions: McpToolPolicyOptions): Record<string, unknown> & {
  schemaVersion: 1;
  mode: string;
  actionability: McpActionability;
  data: unknown;
  freshness: unknown;
  refresh: unknown;
  relatedResources: Array<{ uri: string; name: string; mimeType?: string; description?: string }>;
} {
  const normalizedData = ensureMcpDataMode(result.data);
  const sourceRecord = isRecord(normalizedData) ? normalizedData : {};
  const record = routeMcpGuidanceForProfile(sourceRecord, policyOptions.enabledTools);
  const data = record;
  const mode = typeof record.mode === "string" ? record.mode : "unknown";
  const lifecycle = lifecycleForMcpData(mode, record);
  if (policyOptions.enabledTools) {
    const enabled = policyOptions.enabledTools;
    lifecycle.nextTools = lifecycle.nextTools.filter((tool) => enabled.has(tool));
  }
  const guidance = guidanceForMcpEnvelope(record, policyOptions.enabledTools);
  const relatedResources = relatedResourcesForData(record);
  const worktree = worktreeForMcpData(record);
  const toolPolicy = mcpToolPolicyForTool(toolName, { ...policyOptions, data: record });
  return {
    schemaVersion: 1,
    mode,
    actionability: actionabilityForMcpData(mode, record, result.freshness, lifecycle),
    data,
    freshness: result.freshness,
    refresh: result.refresh ?? { refreshed: false },
    quality: record.quality,
    lifecycle,
    toolPolicy,
    worktree,
    verificationProvenance: record.verificationProvenance ?? CURRENT_VERIFICATION_PROVENANCE,
    truncation: record.truncation,
    nextTools: guidance.nextTools,
    systemMessage: guidance.systemMessage,
    relatedResources
  };
}

function routeMcpGuidanceForProfile(record: Record<string, unknown>, enabledTools?: ReadonlySet<string>): Record<string, unknown> {
  if (!enabledTools) return record;
  const routed = routeNextToolsForProfile(record.nextTools, enabledTools);
  const routedNextCall = routeNextCallForProfile(record.nextCall, enabledTools);
  const routedIntentConfidence = routeRecommendedToolForProfile(record.intentConfidence, enabledTools);
  const sourceRetrieval = isRecord(record.retrieval) ? record.retrieval : undefined;
  const routedRetrieval = sourceRetrieval
    ? { ...sourceRetrieval, intentConfidence: routeRecommendedToolForProfile(sourceRetrieval.intentConfidence, enabledTools) }
    : record.retrieval;
  const routedEditReadiness = routeRecommendedToolForProfile(record.editReadiness, enabledTools);
  const sourceKernel = isRecord(record.decisionKernel) ? record.decisionKernel : undefined;
  const routedKernel = sourceKernel
    ? routeNextToolsForProfile(sourceKernel.nextTools, enabledTools)
    : { nextTools: [], dispatches: [] };
  const authoritativeKernelNextTools = Array.isArray(record.nextTools) ? routed : routedKernel;
  const sourceAuthority = sourceKernel && isRecord(sourceKernel.authority) ? sourceKernel.authority : undefined;
  const sourceScope = sourceKernel && isRecord(sourceKernel.scope) ? sourceKernel.scope : undefined;
  const routedKernelNextCall = routeNextCallForProfile(sourceScope?.nextCall, enabledTools);
  const authoritativeKernelNextCall = Object.hasOwn(record, "nextCall") ? routedNextCall : routedKernelNextCall;
  const dispatches = [
    ...routed.dispatches,
    ...authoritativeKernelNextTools.dispatches,
    ...(routedNextCall.dispatch ? [routedNextCall.dispatch] : []),
    ...(authoritativeKernelNextCall.dispatch ? [authoritativeKernelNextCall.dispatch] : [])
  ];
  const primaryDispatch = dispatches[0];
  const systemMessage = primaryDispatch
    ? `Use capabilities once with ${JSON.stringify({
        action: primaryDispatch.action,
        operation: primaryDispatch.operation,
        ...(primaryDispatch.action === "invoke" ? { arguments: primaryDispatch.arguments ?? {} } : {})
      })}; ${primaryDispatch.operation} is not registered directly in the core profile.`
    : routeGuidanceTextForProfile(record.systemMessage, enabledTools);
  const decisionKernel = sourceKernel
    ? {
        ...sourceKernel,
        ...(sourceAuthority ? { authority: { ...sourceAuthority, editReadiness: routeRecommendedToolForProfile(sourceAuthority.editReadiness, enabledTools) } } : {}),
        ...(sourceScope ? { scope: { ...sourceScope, nextCall: authoritativeKernelNextCall.nextCall } } : {}),
        ...(Array.isArray(sourceKernel.nextTools) ? { nextTools: authoritativeKernelNextTools.nextTools } : {}),
        ...(systemMessage ? { systemMessage } : {})
      }
    : record.decisionKernel;
  return {
    ...record,
    ...(Array.isArray(record.nextTools) ? { nextTools: routed.nextTools } : {}),
    ...(Object.hasOwn(record, "nextCall") ? { nextCall: routedNextCall.nextCall } : {}),
    ...(Object.hasOwn(record, "intentConfidence") ? { intentConfidence: routedIntentConfidence } : {}),
    ...(Object.hasOwn(record, "retrieval") ? { retrieval: routedRetrieval } : {}),
    ...(Object.hasOwn(record, "editReadiness") ? { editReadiness: routedEditReadiness } : {}),
    ...(Array.isArray(record.steps) ? { steps: routeGuidanceStringsForProfile(record.steps, enabledTools) } : {}),
    ...(Array.isArray(record.nextActions) ? { nextActions: routeGuidanceStringsForProfile(record.nextActions, enabledTools) } : {}),
    ...(systemMessage ? { systemMessage } : {}),
    ...(decisionKernel === undefined ? {} : { decisionKernel })
  };
}

function routeNextCallForProfile(
  value: unknown,
  enabledTools: ReadonlySet<string>
): { nextCall: unknown; dispatch?: { action: "invoke" | "describe"; operation: string; arguments?: Record<string, unknown> } } {
  if (!isRecord(value) || typeof value.tool !== "string") return { nextCall: value };
  const name = value.tool;
  if (name === "source" || enabledTools.has(name)) return { nextCall: value };
  if (!enabledTools.has("capabilities") || !DISPATCHABLE_MCP_TOOL_NAMES.includes(name as (typeof DISPATCHABLE_MCP_TOOL_NAMES)[number])) {
    return { nextCall: undefined };
  }
  const operationArguments = isRecord(value.arguments) ? value.arguments : undefined;
  const action = operationArguments ? "invoke" : "describe";
  return {
    nextCall: {
      ...value,
      tool: "capabilities",
      reason: `Use the core dispatcher for ${name}: ${typeof value.reason === "string" ? value.reason : `inspect the ${name} operation`}`,
      arguments: action === "invoke"
        ? { action, operation: name, arguments: operationArguments }
        : { action, operation: name }
    },
    dispatch: { action, operation: name, ...(operationArguments ? { arguments: operationArguments } : {}) }
  };
}

function routeRecommendedToolForProfile(value: unknown, enabledTools: ReadonlySet<string>): unknown {
  if (!isRecord(value) || typeof value.recommendedNextTool !== "string") return value;
  const name = value.recommendedNextTool;
  if (name === "source" || enabledTools.has(name)) return value;
  if (!enabledTools.has("capabilities") || !DISPATCHABLE_MCP_TOOL_NAMES.includes(name as (typeof DISPATCHABLE_MCP_TOOL_NAMES)[number])) {
    return { ...value, recommendedNextTool: undefined };
  }
  return { ...value, recommendedNextTool: "capabilities", recommendedOperation: name };
}

function routeGuidanceStringsForProfile(value: unknown[], enabledTools: ReadonlySet<string>): unknown[] {
  return value.map((entry) => typeof entry === "string" ? routeGuidanceTextForProfile(entry, enabledTools) : entry);
}

function routeGuidanceTextForProfile(value: unknown, enabledTools: ReadonlySet<string>): string | undefined {
  if (typeof value !== "string") return undefined;
  const unavailableNames = DISPATCHABLE_MCP_TOOL_NAMES.filter((name) => !enabledTools.has(name) && new RegExp(`\\b${name}\\b`, "u").test(value));
  if (unavailableNames.length === 0) return value;
  if (/\bcodexa index\b/u.test(value)) {
    let routed = value;
    for (const name of unavailableNames) {
      routed = routed.replace(new RegExp(`\\bretry\\s+${name}\\b`, "gu"), "retry the same operation through capabilities with its original arguments");
    }
    return routed;
  }
  return "Use direct source inspection for this conditional follow-up. Invoke capabilities only when the operation and all required arguments are concrete.";
}

function routeNextToolsForProfile(
  value: unknown,
  enabledTools: ReadonlySet<string>
): { nextTools: unknown[]; dispatches: Array<{ action: "invoke"; operation: string; arguments: Record<string, unknown> }> } {
  if (!Array.isArray(value)) return { nextTools: [], dispatches: [] };
  const dispatchable = new Set<string>(DISPATCHABLE_MCP_TOOL_NAMES);
  const canDispatch = enabledTools.has("capabilities");
  const dispatches: Array<{ action: "invoke"; operation: string; arguments: Record<string, unknown> }> = [];
  const nextTools = value.flatMap((entry) => {
    const name = typeof entry === "string" ? entry : isRecord(entry) && typeof entry.tool === "string" ? entry.tool : undefined;
    if (!name) return [];
    if (enabledTools.has(name)) return [entry];
    if (!canDispatch || !dispatchable.has(name)) return [];
    const requiredInputs = isRecord(entry) && isRecord(entry.requiredInputs) ? entry.requiredInputs : {};
    dispatches.push({ action: "invoke", operation: name, arguments: requiredInputs });
    const reason = isRecord(entry) && typeof entry.reason === "string" ? entry.reason : `invoke the ${name} operation`;
    return [{
      schemaVersion: 1,
      tool: "capabilities",
      reason: `Invoke the requested operation through the core dispatcher: ${reason}`,
      requiredInputs: { action: "invoke", operation: name, arguments: requiredInputs },
      readOnly: isRecord(entry) && typeof entry.readOnly === "boolean" ? entry.readOnly : false,
      writes: isRecord(entry) && Array.isArray(entry.writes) ? entry.writes : []
    }];
  });
  return { nextTools, dispatches };
}

function guidanceForMcpEnvelope(
  record: Record<string, unknown>,
  enabledTools?: ReadonlySet<string>
): { nextTools: unknown[]; systemMessage?: string } {
  const explicitNextTools = Array.isArray(record.nextTools);
  const rawNextTools = explicitNextTools ? (compactNextTools(record.nextTools) as unknown[]) : [];
  const nextTools = enabledTools
    ? rawNextTools.filter((entry) => {
        const name = typeof entry === "string" ? entry : isRecord(entry) && typeof entry.tool === "string" ? entry.tool : undefined;
        return name === undefined || enabledTools.has(name);
      })
    : rawNextTools;
  const explicitSystemMessage = stringValue(record.systemMessage);
  return {
    nextTools,
    systemMessage: explicitSystemMessage
  };
}

function mcpToolPolicyForTool(toolName: string, options: McpToolPolicyOptions): McpToolPolicy | undefined {
  const tool = MCP_TOOL_CATALOG.find((entry) => entry.name === toolName);
  if (!tool) {
    return undefined;
  }
  const readOnly = effectiveMcpToolReadOnly(tool.name, options);
  const useWhen = options.enabledTools ? routeGuidanceTextForProfile(tool.useWhen, options.enabledTools) ?? tool.useWhen : tool.useWhen;
  const avoidWhen = options.enabledTools ? routeGuidanceTextForProfile(tool.avoidWhen, options.enabledTools) ?? tool.avoidWhen : tool.avoidWhen;
  const nextToolUse = options.enabledTools
    ? routeGuidanceStringsForProfile(tool.nextToolUse, options.enabledTools).filter((entry): entry is string => typeof entry === "string")
    : [...tool.nextToolUse];
  return {
    name: tool.name,
    tier: tool.tier,
    phase: tool.phase,
    readOnly,
    writeEffects: effectiveMcpToolWriteEffects(tool.name, tool.writeEffects, options, readOnly),
    useWhen,
    avoidWhen,
    nextToolUse
  };
}

function effectiveMcpToolReadOnly(toolName: string, options: McpToolPolicyOptions): boolean {
  if (toolName === "freshness") {
    return true;
  }
  if (mcpResultCacheWrites(options.data)) {
    return false;
  }
  if (toolName === "change_plan") {
    return !options.autoRefresh && options.sessionMemoryMode === "off" && !changePlanWritesTaskSnapshot(options);
  }
  if (toolName === "session_memory") {
    return !options.autoRefresh && !sessionMemoryActionWrites(options.input);
  }
  if (memoryRecordingToolNames.has(toolName)) {
    const catalog = MCP_TOOL_CATALOG.find((entry) => entry.name === toolName);
    const hasNonMemoryWrite = catalog?.writeEffects.split("+").some((effect) => effect !== "none" && effect !== "session-memory-auto") ?? false;
    return !hasNonMemoryWrite && options.sessionMemoryMode === "off" && !options.autoRefresh;
  }
  if (sourceContextToolNames.has(toolName)) {
    return !options.autoRefresh;
  }
  return false;
}

function effectiveMcpToolWriteEffects(toolName: string, catalogWriteEffects: string, options: McpToolPolicyOptions, readOnly: boolean): string {
  if (readOnly) {
    return "none";
  }
  const effects = new Set<string>();
  if (mcpResultCacheWrites(options.data)) {
    effects.add("mcp-detailed-result-cache");
  }
  if (toolName === "change_plan") {
    if (changePlanWritesTaskSnapshot(options)) {
      effects.add("task-snapshot-cache");
    }
    if (options.sessionMemoryMode !== "off") {
      effects.add("session-memory-auto");
    }
  } else if (toolName === "session_memory") {
    if (sessionMemoryActionWrites(options.input)) {
      effects.add("explicit-memory-cache");
    }
  } else if (memoryRecordingToolNames.has(toolName)) {
    for (const effect of catalogWriteEffects.split("+")) {
      if (effect !== "none" && effect !== "session-memory-auto") {
        effects.add(effect);
      }
    }
    if (options.sessionMemoryMode !== "off") {
      effects.add("session-memory-auto");
    }
  } else if (catalogWriteEffects !== "session-memory-auto" && catalogWriteEffects !== "none") {
    effects.add(catalogWriteEffects);
  } else if (catalogWriteEffects !== "none" && options.sessionMemoryMode !== "off") {
    effects.add("session-memory-auto");
  }
  if (options.autoRefresh && (sourceContextToolNames.has(toolName) || memoryRecordingToolNames.has(toolName) || toolName === "change_plan" || toolName === "session_memory")) {
    effects.add("index-cache-if-auto-refresh");
  }
  if (effects.size === 0 && memoryRecordingToolNames.has(toolName) && options.sessionMemoryMode === "off") {
    return "none";
  }
  if (effects.size === 0 && (toolName === "change_plan" || toolName === "session_memory")) {
    return "none";
  }
  return effects.size > 0 ? [...effects].join("+") : catalogWriteEffects === "none" ? "none" : catalogWriteEffects;
}

function mcpResultCacheWrites(data: Record<string, unknown> | undefined): boolean {
  const delivery = isRecord(data?.delivery) ? data.delivery : undefined;
  return typeof delivery?.resultUri === "string";
}

function inputBoolean(input: Record<string, unknown> | undefined, key: string): boolean {
  return input?.[key] === true;
}

function changePlanWritesTaskSnapshot(options: McpToolPolicyOptions): boolean {
  return inputBoolean(options.input, "saveSnapshot") || isRecord(options.data?.snapshot) || isRecord(options.data?.snapshotBlock);
}

function sessionMemoryActionWrites(input: Record<string, unknown> | undefined): boolean {
  const action = typeof input?.action === "string" ? input.action : "summary";
  return action === "remember" || action === "compact";
}

function ensureMcpDataMode(data: unknown): unknown {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return { mode: "unknown", value: data };
  }
  const record = data as Record<string, unknown>;
  if (typeof record.mode === "string") {
    return record;
  }
  return { mode: inferMcpDataMode(record) ?? "unknown", ...record };
}

function lifecycleForMcpData(mode: string, data: Record<string, unknown>): {
  phase: string;
  taskId?: string;
  snapshotStatus?: string;
  preconditions: string[];
  blockingReasons: string[];
  nextTools: string[];
} {
  const snapshot = isRecord(data.snapshot) ? data.snapshot : undefined;
  const snapshotBlock = isRecord(data.snapshotBlock) ? data.snapshotBlock : undefined;
  const snapshotLoad = isRecord(data.snapshotLoad) ? data.snapshotLoad : undefined;
  const taskId = stringValue(data.taskId) ?? stringValue(snapshot?.taskId) ?? stringValue(snapshotBlock?.taskId);
  const blockingReasons = [
    stringValue(snapshotBlock?.reason),
    stringValue(snapshotLoad?.missingReason),
    ...stringArray(data.driftReasons).slice(0, 6),
    ...stringArray(data.gaps).filter((gap) => gap.startsWith("worktree state unavailable")).slice(0, 2)
  ].filter((entry): entry is string => Boolean(entry));
  const snapshotStatus = snapshotBlock ? "blocked" : snapshot ? "saved" : snapshotLoad ? "loaded" : mode === "post_edit_review" ? "missing-or-ambiguous" : undefined;
  const nextTools = nextToolNames(data.nextTools);
  return {
    phase: lifecyclePhaseForMode(mode),
    taskId,
    snapshotStatus,
    preconditions: preconditionsForMode(mode, snapshotStatus),
    blockingReasons,
    nextTools
  };
}

function lifecyclePhaseForMode(mode: string): string {
  if (mode === "focus_brief" || mode === "session_context") return "orientation";
  if (mode === "task_brief" || mode === "context_pack") return "brief";
  if (mode === "change_plan") return "plan";
  if (mode === "post_edit_review") return "review";
  if (mode === "test_plan" || mode === "proof_card") return "verify";
  return "inspect";
}

function preconditionsForMode(mode: string, snapshotStatus: string | undefined): string[] {
  if (mode === "change_plan") return ["an explicit bounded target or edit-ready context should identify the files", "use saveSnapshot=true before editing"];
  if (mode === "post_edit_review") return snapshotStatus === "loaded" || snapshotStatus === "saved" ? ["saved change_plan snapshot loaded"] : ["exact taskId is recommended when more than one snapshot exists"];
  if (mode === "test_plan") return ["use when change_plan or post_edit_review leaves verification guidance unresolved"];
  if (mode === "proof_card") return ["use for policy, formal audit, release, or artifact handoff proof", "reported commands/tests are classified as evidence but are not executed by Codexa"];
  return [];
}

function actionabilityForMcpData(
  mode: string,
  data: Record<string, unknown>,
  freshness: unknown,
  lifecycle: { blockingReasons: string[]; snapshotStatus?: string }
): McpActionability {
  return mcpActionabilityValue(deriveMcpActionability(mode, data, mcpAuthorityBlocked(data, freshness) || lifecycle.blockingReasons.length > 0 || lifecycle.snapshotStatus === "blocked")) ?? "blocked";
}

function mcpActionabilityValue(value: unknown): McpActionability | undefined {
  return typeof value === "string" && (MCP_ACTIONABILITY_VALUES as readonly string[]).includes(value) ? (value as McpActionability) : undefined;
}

function worktreeForMcpData(data: Record<string, unknown>): { knownClean: boolean; unknown: boolean; degraded: boolean; dirtyFileCount: number; degradedReasons: string[] } {
  const worktree = isRecord(data.worktree) ? data.worktree : undefined;
  const runtime = isRecord(data.runtime) ? data.runtime : isRecord(data.session) ? data.session : undefined;
  const changedFiles = stringArray(data.changedFiles);
  const knownDirtyCount = numberValue(worktree?.dirtyFileCount) ?? numberValue(runtime?.dirtyFileCount);
  const degradedReasons = [...stringArray(worktree?.degradedReasons), ...stringArray(data.worktreeDegradationReasons)].filter(Boolean);
  // No worktree signal at all must not render as a verified-clean tree:
  // absence of evidence is not evidence of cleanliness.
  const hasSignal = knownDirtyCount !== undefined || Array.isArray(data.changedFiles) || degradedReasons.length > 0;
  if (!hasSignal) {
    return { knownClean: false, unknown: true, degraded: false, dirtyFileCount: 0, degradedReasons: [] };
  }
  const dirtyFileCount = knownDirtyCount ?? changedFiles.length;
  return {
    knownClean: dirtyFileCount === 0 && degradedReasons.length === 0,
    unknown: false,
    degraded: degradedReasons.length > 0,
    dirtyFileCount,
    degradedReasons
  };
}

function relatedResourcesForData(data: Record<string, unknown>): Array<{ uri: string; name: string; mimeType?: string; description?: string }> {
  const resources: Array<{ uri: string; name: string; mimeType?: string; description?: string }> = [];
  const delivery = isRecord(data.delivery) ? data.delivery : undefined;
  const resultUri = stringValue(delivery?.resultUri);
  if (resultUri?.match(/^codexa:\/\/repo\/mcp-results\/rr_[a-f0-9]{32}\/mr_[a-f0-9]{64}$/u)) {
    resources.push({
      uri: resultUri,
      name: "Codexa detailed MCP result",
      mimeType: "application/json",
      description: "Content-addressed detailed packet for this concise decision receipt"
    });
  }
  return resources;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

export async function safeQuery(producer: () => Promise<QueryResult>, repoRoot: string): Promise<QueryResult> {
  try {
    return await producer();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.startsWith("Missing Codexa index.")) {
      throw error;
    }
    const freshness: FreshnessInfo = {
      schemaVersion: 1,
      snapshotId: "missing-index",
      repoRoot: path.resolve(repoRoot),
      gitRoot: null,
      headCommit: null,
      indexedAt: "",
      dirtyFiles: [],
      dirtyFileHashes: {},
      indexedDirtyFileHashes: {},
      indexedDirtyFiles: [],
      missing: true,
      parserErrorCount: 0,
      stale: true,
      reason: "missing-index"
    };
    const text = [
      "Codexa index missing.",
      `Repo: ${path.resolve(repoRoot)}`,
      `Run: codexa index ${path.resolve(repoRoot)}`,
      "For startup/focus flows with auto-refresh disabled, enable auto-refresh or index once before relying on Codexa context."
    ].join("\n");
    return {
      freshness,
      refresh: { refreshed: false },
      text,
      data: { missingIndex: true, repoRoot: path.resolve(repoRoot), command: `codexa index ${path.resolve(repoRoot)}` }
    };
  }
}
