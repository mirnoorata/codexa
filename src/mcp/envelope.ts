import path from "node:path";
import { z } from "zod";
import { MCP_TOOL_CATALOG } from "../mcp-tool-catalog.js";
import { nextToolNames } from "../query/next-tools.js";
import { CURRENT_VERIFICATION_PROVENANCE } from "../types.js";
import type { FreshnessInfo, QueryResult } from "../types.js";
import { compactNextTools, inferMcpDataMode } from "./compaction.js";
import { MEMORY_RECORDING_MCP_TOOL_NAMES, SOURCE_CONTEXT_MCP_TOOL_NAMES } from "./tool-registry.js";

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
    degraded: z.boolean(),
    dirtyFileCount: z.number(),
    degradedReasons: z.array(z.string())
  });
  const verificationProvenanceSchema = z.object({
    schemaVersion: z.literal(1),
    commandCoverageClassifier: z.literal("codexa-command-coverage"),
    commandCoverageClassifierVersion: z.string(),
    commandEnvelopeRulesetVersion: z.string(),
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
  return {
    content: [
      {
        type: "text" as const,
        text: result.text
      },
      ...envelope.relatedResources.map((resource) => ({ type: "resource_link" as const, ...resource }))
    ],
    structuredContent: envelope
  };
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
  const data = ensureMcpDataMode(result.data);
  const record = isRecord(data) ? data : {};
  const mode = typeof record.mode === "string" ? record.mode : "unknown";
  const lifecycle = lifecycleForMcpData(mode, record);
  if (policyOptions.enabledTools) {
    const enabled = policyOptions.enabledTools;
    lifecycle.nextTools = lifecycle.nextTools.filter((tool) => enabled.has(tool));
  }
  const guidance = guidanceForMcpEnvelope(record, lifecycle.nextTools, policyOptions.enabledTools);
  const relatedResources = relatedResourcesForMode(mode);
  const worktree = worktreeForMcpData(record);
  const toolPolicy = mcpToolPolicyForTool(toolName, { ...policyOptions, data: record });
  return {
    schemaVersion: 1,
    mode,
    actionability: actionabilityForMcpData(mode, record, lifecycle),
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

function guidanceForMcpEnvelope(
  record: Record<string, unknown>,
  lifecycleNextTools: string[],
  enabledTools?: ReadonlySet<string>
): { nextTools: unknown[]; systemMessage?: string } {
  const explicitNextTools = Array.isArray(record.nextTools);
  const rawNextTools = explicitNextTools ? (compactNextTools(record.nextTools) as unknown[]) : lifecycleNextTools;
  const nextTools = enabledTools
    ? rawNextTools.filter((entry) => {
        const name = typeof entry === "string" ? entry : isRecord(entry) && typeof entry.tool === "string" ? entry.tool : undefined;
        return name === undefined || enabledTools.has(name);
      })
    : rawNextTools;
  const explicitSystemMessage = stringValue(record.systemMessage);
  const lifecycleFallback = typeof nextTools[0] === "string" ? (nextTools[0] as string) : undefined;
  return {
    nextTools,
    systemMessage: explicitSystemMessage ?? (explicitNextTools ? undefined : lifecycleFallback)
  };
}

function mcpToolPolicyForTool(toolName: string, options: McpToolPolicyOptions): McpToolPolicy | undefined {
  const tool = MCP_TOOL_CATALOG.find((entry) => entry.name === toolName);
  if (!tool) {
    return undefined;
  }
  const readOnly = effectiveMcpToolReadOnly(tool.name, options);
  return {
    name: tool.name,
    tier: tool.tier,
    phase: tool.phase,
    readOnly,
    writeEffects: effectiveMcpToolWriteEffects(tool.name, tool.writeEffects, options, readOnly),
    useWhen: tool.useWhen,
    avoidWhen: tool.avoidWhen,
    nextToolUse: [...tool.nextToolUse]
  };
}

function effectiveMcpToolReadOnly(toolName: string, options: McpToolPolicyOptions): boolean {
  if (toolName === "freshness") {
    return true;
  }
  if (toolName === "change_plan") {
    return !options.autoRefresh && options.sessionMemoryMode === "off" && !changePlanWritesTaskSnapshot(options);
  }
  if (toolName === "session_memory") {
    return !options.autoRefresh && !sessionMemoryActionWrites(options.input);
  }
  if (memoryRecordingToolNames.has(toolName)) {
    return options.sessionMemoryMode === "off" && !options.autoRefresh;
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
  const nextTools = nextToolsForMode(mode, data, snapshotStatus);
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
  if (mode === "change_plan") return ["task_brief or explicit target should identify edit-ready files", "use saveSnapshot=true before editing"];
  if (mode === "post_edit_review") return snapshotStatus === "loaded" || snapshotStatus === "saved" ? ["saved change_plan snapshot loaded"] : ["exact taskId is recommended when more than one snapshot exists"];
  if (mode === "test_plan") return ["run after edits or when selecting verification for a focused diff"];
  if (mode === "proof_card") return ["reported commands/tests are classified as evidence but are not executed by Codexa"];
  return [];
}

function nextToolsForMode(mode: string, data: Record<string, unknown>, snapshotStatus: string | undefined): string[] {
  const structured = nextToolNames(data.nextTools);
  if (structured.length > 0) {
    return structured;
  }
  if (mode === "focus_brief" || mode === "session_context") return ["task_brief", "search"];
  if (mode === "task_brief" || mode === "context_pack") return ["change_plan"];
  if (mode === "change_plan") return snapshotStatus === "blocked" ? ["search", "task_brief"] : ["post_edit_review"];
  if (mode === "post_edit_review") return ["test_plan"];
  if (mode === "test_plan") return stringArray(data.verificationCommands).length > 0 ? ["proof_card"] : ["search"];
  if (mode === "proof_card") {
    const verification = isRecord(data.verification) ? data.verification : undefined;
    const reported = isRecord(verification?.reported) ? verification.reported : undefined;
    return reported?.hasEvidence === true ? [] : ["test_plan"];
  }
  return [];
}

function actionabilityForMcpData(
  mode: string,
  data: Record<string, unknown>,
  lifecycle: { blockingReasons: string[]; snapshotStatus?: string }
): McpActionability {
  if (lifecycle.blockingReasons.length > 0 || lifecycle.snapshotStatus === "blocked") {
    return "blocked";
  }
  const queryActionability = mcpActionabilityValue(data.actionability);
  if (queryActionability) {
    return queryActionability;
  }
  if (mode === "post_edit_review") return "review";
  if (mode === "test_plan" || mode === "proof_card") return "verify";
  const editReadiness = isRecord(data.editReadiness) ? data.editReadiness : undefined;
  if (editReadiness?.editable === true || data.packetVerdict === "edit-ready") {
    return "edit_ready";
  }
  if (mode === "change_plan" && Array.isArray(data.plannedEditTargets) && data.plannedEditTargets.length > 0) {
    return "edit_ready";
  }
  return "orientation";
}

function mcpActionabilityValue(value: unknown): McpActionability | undefined {
  return typeof value === "string" && (MCP_ACTIONABILITY_VALUES as readonly string[]).includes(value) ? (value as McpActionability) : undefined;
}

function worktreeForMcpData(data: Record<string, unknown>): { knownClean: boolean; degraded: boolean; dirtyFileCount: number; degradedReasons: string[] } {
  const worktree = isRecord(data.worktree) ? data.worktree : undefined;
  const runtime = isRecord(data.runtime) ? data.runtime : isRecord(data.session) ? data.session : undefined;
  const changedFiles = stringArray(data.changedFiles);
  const dirtyFileCount = numberValue(worktree?.dirtyFileCount) ?? numberValue(runtime?.dirtyFileCount) ?? changedFiles.length;
  const degradedReasons = [...stringArray(worktree?.degradedReasons), ...stringArray(data.worktreeDegradationReasons)].filter(Boolean);
  return {
    knownClean: dirtyFileCount === 0 && degradedReasons.length === 0,
    degraded: degradedReasons.length > 0,
    dirtyFileCount,
    degradedReasons
  };
}

function relatedResourcesForMode(mode: string): Array<{ uri: string; name: string; mimeType?: string; description?: string }> {
  const resources = [
    {
      uri: "codexa://repo/codebase/codex-contract.md",
      name: "Codexa Codex contract",
      mimeType: "text/markdown",
      description: "Automatic-use rules for Codex in this repository"
    }
  ];
  if (mode === "repo_map" || mode === "focus_brief" || mode === "session_context" || mode === "task_brief" || mode === "context_pack") {
    resources.push({
      uri: "codexa://repo/codebase/repo-map.md",
      name: "Codexa repo map",
      mimeType: "text/markdown",
      description: "Ranked repository map generated by Codexa"
    });
  }
  if (mode === "test_plan" || mode === "post_edit_review" || mode === "change_plan" || mode === "proof_card") {
    resources.push({
      uri: "codexa://repo/codebase/test-map.md",
      name: "Codexa test map",
      mimeType: "text/markdown",
      description: "Detected tests and test relationships"
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
