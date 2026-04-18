import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  contextPackQuery,
  callersQuery,
  calleesQuery,
  changePlanQuery,
  dependencyPathQuery,
  diffImpactQuery,
  findContextQuery,
  focusBriefQuery,
  impactQuery,
  postEditReviewQuery,
  repoMapQuery,
  searchQuery,
  statusQuery,
  symbolContextQuery,
  taskBriefQuery,
  testPlanQuery,
  workflowPathQuery
} from "./queries.js";
import { CURRENT_VERIFICATION_PROVENANCE } from "./types.js";
import type { FreshnessInfo, QueryOptions, QueryResult } from "./types.js";
import { createQuerySession, type QuerySession } from "./query/session.js";
import { RAW_SEARCH_EXPLICIT_PATTERN_LIMIT } from "./query/raw-search.js";

export async function serveMcp(repoRoot: string, options: QueryOptions = { autoRefresh: true }): Promise<void> {
  const queryOptions = { autoRefresh: options.autoRefresh ?? true };
  const server = new McpServer({
    name: "codexa",
    version: "0.1.0"
  });
  const outputSchema = {
    data: z.unknown(),
    freshness: z.unknown(),
    refresh: z.unknown()
  };
  const sourceContextAnnotations = {
    readOnlyHint: !queryOptions.autoRefresh,
    destructiveHint: false,
    idempotentHint: !queryOptions.autoRefresh,
    openWorldHint: false
  };
  const pureReadAnnotations = {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false
  };
  const cacheWriteAnnotations = {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false
  };
  const changeTypeSchema = z.enum(["style", "api", "behavior", "rename", "delete", "unknown"]);
  const runTool = async (producer: (session: QuerySession) => Promise<QueryResult>) =>
    toToolResult(
      await safeQuery(async () => {
        const session = await createQuerySession(repoRoot, queryOptions);
        return compactMcpResult(withSessionRuntime(await producer(session), session));
      }, repoRoot)
    );

  server.registerTool(
    "freshness",
    {
      title: "Codexa freshness",
      description: "Report whether the Codexa index is present, fresh, stale, or missing.",
      inputSchema: {},
      outputSchema,
      annotations: pureReadAnnotations
    },
    async () => toToolResult(await safeQuery(() => statusQuery(repoRoot), repoRoot))
  );

  server.registerTool(
    "repo_map",
    {
      title: "Codexa repo map",
      description: "Return the top-ranked modules and files, refreshing stale Codexa artifacts first when auto-refresh is enabled.",
      inputSchema: { limit: z.number().int().positive().max(50).optional(), tokenBudget: z.number().int().min(400).max(8000).optional() },
      outputSchema,
      annotations: sourceContextAnnotations
    },
    async ({ limit, tokenBudget }) => runTool((session) => repoMapQuery(session, limit ?? 20, queryOptions, tokenBudget ?? 1500))
  );

  server.registerTool(
    "find_context",
    {
      title: "Codexa find context",
      description: "Find matching files, symbols, and usage sites, refreshing stale Codexa artifacts first when auto-refresh is enabled.",
      inputSchema: { query: z.string().min(1), limit: z.number().int().positive().max(30).optional() },
      outputSchema,
      annotations: sourceContextAnnotations
    },
    async ({ query, limit }) => runTool((session) => findContextQuery(session, query, limit ?? 12, queryOptions))
  );

  server.registerTool(
    "search",
    {
      title: "Codexa search comparison",
      description:
        `Compare raw string search with Codexa-ranked files, symbols, likely tests, and value/gap labels. Pass up to ${RAW_SEARCH_EXPLICIT_PATTERN_LIMIT} patterns to add literal identifier variants to the query in one raw pass.`,
      inputSchema: {
        query: z.string().min(1),
        patterns: z.array(z.string().min(1)).max(RAW_SEARCH_EXPLICIT_PATTERN_LIMIT).optional(),
        limit: z.number().int().positive().max(50).optional(),
        includeRaw: z.boolean().optional()
      },
      outputSchema,
      annotations: sourceContextAnnotations
    },
    async ({ query, patterns, limit, includeRaw }) =>
      runTool((session) => searchQuery(session, { query, patterns, limit: limit ?? 12, includeRaw: includeRaw ?? true }, queryOptions))
  );

  server.registerTool(
    "symbol_context",
    {
      title: "Codexa symbol context",
      description: "Return compact context and usage sites for a symbol id or name, refreshing stale Codexa artifacts first when auto-refresh is enabled.",
      inputSchema: { symbol: z.string().min(1) },
      outputSchema,
      annotations: sourceContextAnnotations
    },
    async ({ symbol }) => runTool((session) => symbolContextQuery(session, symbol, queryOptions))
  );

  server.registerTool(
    "impact",
    {
      title: "Codexa impact",
      description: "Return blast-radius evidence for a file or symbol, refreshing stale Codexa artifacts first when auto-refresh is enabled.",
      inputSchema: {
        file: z.string().optional(),
        symbol: z.string().optional(),
        changeType: changeTypeSchema.optional(),
        depth: z.number().int().min(1).max(3).optional()
      },
      outputSchema,
      annotations: sourceContextAnnotations
    },
    async ({ file, symbol, changeType, depth }) => runTool((session) => impactQuery(session, { file, symbol, changeType, depth }, queryOptions))
  );

  server.registerTool(
    "diff_impact",
    {
      title: "Codexa diff impact",
      description: "Return high-level impact context for the current dirty git diff, refreshing stale Codexa artifacts first when auto-refresh is enabled.",
      inputSchema: {},
      outputSchema,
      annotations: sourceContextAnnotations
    },
    async () => runTool((session) => diffImpactQuery(session, queryOptions))
  );

  server.registerTool(
    "test_plan",
    {
      title: "Codexa test plan",
      description: "Recommend targeted tests for the current diff or top-ranked files, refreshing stale Codexa artifacts first when auto-refresh is enabled.",
      inputSchema: { diff: z.boolean().optional() },
      outputSchema,
      annotations: sourceContextAnnotations
    },
    async ({ diff }) => runTool((session) => testPlanQuery(session, diff ?? true, queryOptions))
  );

  server.registerTool(
    "task_brief",
    {
      title: "Codexa task brief",
      description:
        "Default first Codexa call before editing, debugging, or reviewing code. Returns a bounded task packet with read-first files, impact expansion, risks, likely tests, freshness, confidence labels, and snippets.",
      inputSchema: {
        task: z.string().optional(),
        files: z.array(z.string()).max(20).optional(),
        symbols: z.array(z.string()).max(20).optional(),
        query: z.string().optional(),
        changeType: changeTypeSchema.optional(),
        diff: z.boolean().optional(),
        tokenBudget: z.number().int().min(500).max(12000).optional(),
        limit: z.number().int().positive().max(40).optional(),
        includeSnippets: z.boolean().optional()
      },
      outputSchema,
      annotations: sourceContextAnnotations
    },
    async (input) => runTool((session) => taskBriefQuery(session, input, queryOptions))
  );

  server.registerTool(
    "context_pack",
    {
      title: "Codexa context pack",
      description: "Build one compact task-shaped context packet with focus files, bounded impact expansion, evidence snippets, impact groups, tests, freshness, and provenance.",
      inputSchema: {
        task: z.string().optional(),
        files: z.array(z.string()).max(20).optional(),
        symbols: z.array(z.string()).max(20).optional(),
        query: z.string().optional(),
        changeType: changeTypeSchema.optional(),
        diff: z.boolean().optional(),
        tokenBudget: z.number().int().min(500).max(12000).optional(),
        limit: z.number().int().positive().max(40).optional(),
        includeSnippets: z.boolean().optional()
      },
      outputSchema,
      annotations: sourceContextAnnotations
    },
    async (input) => runTool((session) => contextPackQuery(session, input, queryOptions))
  );

  server.registerTool(
    "focus_brief",
    {
      title: "Codexa focus brief",
      description: "Use for broad natural-language tasks or session startup. Classifies the task, picks likely subsystems, and recommends the next Codexa tool call.",
      inputSchema: {
        task: z.string().optional(),
        tokenBudget: z.number().int().min(600).max(8000).optional(),
        limit: z.number().int().positive().max(30).optional(),
        diff: z.boolean().optional()
      },
      outputSchema,
      annotations: sourceContextAnnotations
    },
    async (input) => runTool((session) => focusBriefQuery(session, input, queryOptions))
  );

  server.registerTool(
    "session_context",
    {
      title: "Codexa session context",
      description: "Alias for focus_brief tuned for startup/focus events. Returns project focus, dirty groups, likely workflows, and next Codexa call.",
      inputSchema: {
        task: z.string().optional(),
        tokenBudget: z.number().int().min(600).max(8000).optional(),
        limit: z.number().int().positive().max(30).optional(),
        diff: z.boolean().optional()
      },
      outputSchema,
      annotations: sourceContextAnnotations
    },
    async (input) => runTool((session) => focusBriefQuery(session, input, queryOptions))
  );

  const graphTargetSchema = {
    file: z.string().optional(),
    symbol: z.string().optional(),
    limit: z.number().int().positive().max(80).optional()
  };

  server.registerTool(
    "callers",
    {
      title: "Codexa callers",
      description: "Return typed graph evidence for files/symbols that call, reference, import, or test the target.",
      inputSchema: graphTargetSchema,
      outputSchema,
      annotations: sourceContextAnnotations
    },
    async (input) => runTool((session) => callersQuery(session, input, queryOptions))
  );

  server.registerTool(
    "callees",
    {
      title: "Codexa callees",
      description: "Return typed graph evidence for symbols/files the target calls, references, imports, tests, or risks.",
      inputSchema: graphTargetSchema,
      outputSchema,
      annotations: sourceContextAnnotations
    },
    async (input) => runTool((session) => calleesQuery(session, input, queryOptions))
  );

  server.registerTool(
    "dependency_path",
    {
      title: "Codexa dependency path",
      description: "Find a bounded typed graph path between two files or symbols.",
      inputSchema: {
        fromFile: z.string().optional(),
        fromSymbol: z.string().optional(),
        toFile: z.string().optional(),
        toSymbol: z.string().optional(),
        maxDepth: z.number().int().min(1).max(10).optional()
      },
      outputSchema,
      annotations: sourceContextAnnotations
    },
    async (input) => runTool((session) => dependencyPathQuery(session, input, queryOptions))
  );

  server.registerTool(
    "workflow_path",
    {
      title: "Codexa workflow path",
      description: "Return route/job/manifest workflow traces related to a natural-language query, file, or symbol.",
      inputSchema: {
        query: z.string().optional(),
        file: z.string().optional(),
        symbol: z.string().optional(),
        limit: z.number().int().positive().max(30).optional()
      },
      outputSchema,
      annotations: sourceContextAnnotations
    },
    async (input) => runTool((session) => workflowPathQuery(session, input, queryOptions))
  );

  server.registerTool(
    "change_plan",
    {
      title: "Codexa change plan",
      description: "Build a concise Codex edit plan from focus brief, context pack, graph/workflow signals, tests, freshness, and known gaps. Set saveSnapshot=true before edits to enable post_edit_review drift checks.",
      inputSchema: {
        task: z.string().optional(),
        files: z.array(z.string()).max(20).optional(),
        symbols: z.array(z.string()).max(20).optional(),
        query: z.string().optional(),
        changeType: changeTypeSchema.optional(),
        diff: z.boolean().optional(),
        tokenBudget: z.number().int().min(500).max(12000).optional(),
        limit: z.number().int().positive().max(40).optional(),
        includeSnippets: z.boolean().optional(),
        saveSnapshot: z.boolean().optional(),
        taskId: z.string().optional()
      },
      outputSchema,
      annotations: cacheWriteAnnotations
    },
    async (input) => runTool((session) => changePlanQuery(session, input, queryOptions))
  );

  server.registerTool(
    "post_edit_review",
    {
      title: "Codexa post-edit review",
      description:
        "After editing, compare the dirty tree against the latest or requested change_plan snapshot. Reports changed files grouped by module, planned-vs-actual drift, symbol/risk deltas, affected callers/tests/workflows, and targeted tests still unaccounted for. MCP calls do not persist outcome files; use the CLI for persisted outcomes.",
      inputSchema: {
        task: z.string().optional(),
        taskId: z.string().optional(),
        files: z.array(z.string()).max(20).optional(),
        symbols: z.array(z.string()).max(20).optional(),
        changeType: changeTypeSchema.optional(),
        tokenBudget: z.number().int().min(600).max(10000).optional(),
        limit: z.number().int().positive().max(30).optional(),
        includeSnippets: z.boolean().optional(),
        ranTests: z.array(z.string()).max(30).optional(),
        ranCommands: z.array(z.string()).max(30).optional(),
        ranCommandReports: z
          .array(
            z.object({
              command: z.string().min(1),
              cwd: z.string().optional(),
              packageManager: z.string().optional(),
              workspace: z.string().optional(),
              packageRoot: z.string().optional(),
              packageName: z.string().optional(),
              scriptName: z.string().optional(),
              args: z.array(z.string()).max(80).optional(),
              exitCode: z.number().int().nonnegative(),
              durationMs: z.number().nonnegative().optional(),
              stdoutSummary: z.string().max(1000).optional(),
              stderrSummary: z.string().max(1000).optional(),
              outputSummary: z.string().max(1000).optional()
            })
          )
          .max(30)
          .optional(),
        waivedChecks: z.array(z.string()).max(30).optional(),
        waivers: z
          .array(
            z.object({
              kind: z.enum(["test", "workflow", "dependency"]),
              target: z.string(),
              reason: z.string()
            })
          )
          .max(30)
          .optional()
      },
      outputSchema,
      annotations: pureReadAnnotations
    },
    async (input) =>
      toToolResult(
        await safeQuery(async () => {
          const readOnlyOptions = { ...queryOptions, autoRefresh: false };
          const session = await createQuerySession(repoRoot, readOnlyOptions);
          return compactMcpResult(withSessionRuntime(await postEditReviewQuery(session, { ...input, persistOutcome: false }, readOnlyOptions), session));
        }, repoRoot)
      )
  );

  await registerArtifactResources(server, repoRoot);
  registerWorkflowPrompts(server);

  await server.connect(new StdioServerTransport());
  console.error(`codexa MCP server ready for ${repoRoot} (autoRefresh=${queryOptions.autoRefresh})`);
}

const MCP_STRUCTURED_DATA_TARGET_BYTES = 96_000;

type McpTruncation = Record<string, { total: number; returned: number }>;

interface McpCompactionResult {
  data: Record<string, unknown>;
  truncation: McpTruncation;
  compacted: boolean;
}

export function compactMcpResult(result: QueryResult): QueryResult {
  if (!result.data || typeof result.data !== "object" || Array.isArray(result.data)) {
    return result;
  }
  const originalData = result.data as Record<string, unknown>;
  const originalBytes = structuredByteLength(originalData);
  const mode = typeof originalData.mode === "string" ? originalData.mode : inferMcpDataMode(originalData);
  const effectiveMode = mode ?? "unknown";
  const compaction = compactMcpDataByMode(originalData, mode) ?? compactGenericMcpData(originalData, effectiveMode);
  const clamped = clampLargeStrings(compaction.data);
  const dataWithoutMetrics = withMergedTruncation(clamped.value as Record<string, unknown>, compaction.truncation);
  const compactedBytes = structuredByteLength(dataWithoutMetrics);
  const structuredData = {
    compacted: compaction.compacted || compactedBytes < originalBytes,
    originalBytes,
    targetBytes: MCP_STRUCTURED_DATA_TARGET_BYTES,
    stringTruncations: clamped.stringTruncations,
    mode: effectiveMode,
    verificationProvenance: isRecord(originalData.verificationProvenance) ? originalData.verificationProvenance : undefined
  };
  let data = attachMcpMetrics(dataWithoutMetrics, structuredData);
  const returnedBytes = structuredByteLength(data);
  if (returnedBytes > MCP_STRUCTURED_DATA_TARGET_BYTES) {
    data = enforceMcpStructuredBudget(dataWithoutMetrics, structuredData, returnedBytes, effectiveMode);
  }
  return {
    ...result,
    data
  };
}

export function compactNonPostEditMcpResult(result: QueryResult): QueryResult {
  return compactMcpResult(result);
}

function inferMcpDataMode(data: Record<string, unknown>): string | undefined {
  if (Array.isArray(data.verificationCommands) && Array.isArray(data.verificationCoverage) && Array.isArray(data.tests)) {
    return Array.isArray(data.focusFiles) || Array.isArray(data.nextReads) ? "context_pack" : "test_plan";
  }
  return undefined;
}

function compactMcpDataByMode(data: Record<string, unknown>, mode: string | undefined): McpCompactionResult | undefined {
  if (mode === "post_edit_review") {
    const compacted = compactPostEditMcpResult({ freshness: {} as FreshnessInfo, text: "", data });
    return { data: compacted.data as Record<string, unknown>, truncation: ((compacted.data as Record<string, unknown>).truncation as Record<string, { total: number; returned: number }>) ?? {}, compacted: true };
  }
  if (mode === "context_pack" || mode === "task_brief") {
    return compactContextPacketData(data, mode);
  }
  if (mode === "focus_brief") {
    return compactFocusBriefData(data);
  }
  if (mode === "change_plan") {
    return compactChangePlanData(data);
  }
  if (mode === "test_plan") {
    return compactTestPlanData(data);
  }
  return undefined;
}

function compactGenericMcpData(data: Record<string, unknown>, mode: string): McpCompactionResult {
  const truncation: McpTruncation = {};
  const compacted = compactGenericValue(data, { arrayLimit: 40, objectKeyLimit: 80, maxDepth: 8 }, truncation);
  const record = isRecord(compacted) ? compacted : { value: compacted };
  const dataWithMode = typeof record.mode === "string" ? record : { mode, ...record };
  return { data: dataWithMode, truncation, compacted: true };
}

function enforceMcpStructuredBudget(
  dataWithoutMetrics: Record<string, unknown>,
  structuredData: Record<string, unknown>,
  preEnforcementBytes: number,
  mode: string
): Record<string, unknown> {
  const hardTruncation = mergeTruncation(truncationFromValue(dataWithoutMetrics.truncation), {
    "__mcp.hardBudget": { total: preEnforcementBytes, returned: MCP_STRUCTURED_DATA_TARGET_BYTES }
  });
  const hardCompacted = compactGenericValue(dataWithoutMetrics, { arrayLimit: 12, objectKeyLimit: 40, maxDepth: 6 }, hardTruncation);
  const hardClamped = clampLargeStrings(hardCompacted, 240);
  const hardRecord = isRecord(hardClamped.value) ? hardClamped.value : { value: hardClamped.value };
  const hardData = withMergedTruncation(typeof hardRecord.mode === "string" ? hardRecord : { mode, ...hardRecord }, hardTruncation);
  const hardResult = attachMcpMetrics(hardData, {
    ...structuredData,
    compacted: true,
    hardBudgetEnforced: true,
    preEnforcementBytes,
    budgetCompaction: "hard",
    stringTruncations: metricNumber(structuredData, "stringTruncations") + hardClamped.stringTruncations
  });
  if (structuredByteLength(hardResult) <= MCP_STRUCTURED_DATA_TARGET_BYTES) {
    return hardResult;
  }

  const summaryTruncation = mergeTruncation(hardTruncation, {
    "__mcp.summaryBudget": { total: structuredByteLength(hardResult), returned: MCP_STRUCTURED_DATA_TARGET_BYTES }
  });
  const summaryClamped = clampLargeStrings(buildMcpBudgetSummaryData(dataWithoutMetrics, mode, summaryTruncation), 160);
  const summaryRecord = isRecord(summaryClamped.value) ? summaryClamped.value : { value: summaryClamped.value };
  const summaryResult = attachMcpMetrics(withMergedTruncation(summaryRecord, summaryTruncation), {
    ...structuredData,
    compacted: true,
    hardBudgetEnforced: true,
    preEnforcementBytes,
    budgetCompaction: "summary",
    stringTruncations: metricNumber(structuredData, "stringTruncations") + hardClamped.stringTruncations + summaryClamped.stringTruncations
  });
  if (structuredByteLength(summaryResult) <= MCP_STRUCTURED_DATA_TARGET_BYTES) {
    return summaryResult;
  }

  const fallbackTruncation = mergeTruncation(summaryTruncation, {
    "__mcp.fallbackBudget": { total: structuredByteLength(summaryResult), returned: MCP_STRUCTURED_DATA_TARGET_BYTES }
  });
  return attachMcpMetrics(
    {
      mode,
      task: typeof dataWithoutMetrics.task === "string" ? dataWithoutMetrics.task.slice(0, 160) : dataWithoutMetrics.task,
      verdict: dataWithoutMetrics.verdict,
      packetVerdict: dataWithoutMetrics.packetVerdict,
      verificationProvenance: dataWithoutMetrics.verificationProvenance,
      runtime: compactSession(dataWithoutMetrics.runtime),
      truncation: fallbackTruncation
    },
    {
      ...structuredData,
      compacted: true,
      hardBudgetEnforced: true,
      preEnforcementBytes,
      budgetCompaction: "fallback",
      stringTruncations: metricNumber(structuredData, "stringTruncations") + hardClamped.stringTruncations + summaryClamped.stringTruncations
    }
  );
}

function buildMcpBudgetSummaryData(data: Record<string, unknown>, mode: string, truncation: McpTruncation): Record<string, unknown> {
  return {
    mode,
    task: data.task,
    verdict: data.verdict,
    packetVerdict: data.packetVerdict,
    files: compactSummaryArray("files", data.files, 12, truncation),
    plannedEditTargets: compactSummaryArray("plannedEditTargets", data.plannedEditTargets, 12, truncation),
    changedFiles: compactSummaryArray("changedFiles", data.changedFiles, 12, truncation),
    tests: compactSummaryArray("tests", data.tests, 12, truncation, compactTestRecommendation),
    verificationCommands: compactSummaryArray("verificationCommands", data.verificationCommands, 10, truncation),
    verificationProvenance: data.verificationProvenance,
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
    requiredWorkflowCheckCount: Array.isArray(value.requiredWorkflowChecks) ? value.requiredWorkflowChecks.length : undefined,
    requiredDependencyCheckCount: Array.isArray(value.requiredDependencyChecks) ? value.requiredDependencyChecks.length : undefined
  };
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
  const data = result.data as Record<string, unknown>;
  const snapshot = data.snapshot && typeof data.snapshot === "object" ? (data.snapshot as Record<string, unknown>) : undefined;
  const outcome = data.outcome && typeof data.outcome === "object" ? (data.outcome as Record<string, unknown>) : undefined;
  const truncation = compactPostEditTruncation(data, snapshot, outcome);
  return {
    ...result,
    data: {
      mode: data.mode,
      task: data.task,
      verdict: data.verdict,
      files: data.files,
      reviewTargets: data.reviewTargets,
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
      waivedVerification: limitArray(data.waivedVerification, 30),
      unindexedEditedFiles: data.unindexedEditedFiles,
      riskEscalations: limitArray(data.riskEscalations, 20),
      workflows: limitArray(data.workflows, 12),
      workflowChecks: limitArray(data.workflowChecks, 20),
      dependencyChecks: limitArray(data.dependencyChecks, 30),
      quality: data.quality,
      driftReasons: data.driftReasons,
      nextActions: data.nextActions,
      truncation: Object.keys(truncation).length > 0 ? truncation : undefined,
      snapshotLoad: compactSnapshotLoad(data.snapshotLoad),
      snapshot: snapshot
        ? {
            taskId: snapshot.taskId,
            createdAt: snapshot.createdAt,
            changeType: snapshot.changeType,
            plannedEditTargets: limitArray(snapshot.plannedEditTargets, 30),
            plannedFiles: limitArray(snapshot.plannedFiles, 40),
            plannedTests: limitArray(snapshot.plannedTests, 20),
            requiredWorkflowCheckCount: Array.isArray(snapshot.requiredWorkflowChecks) ? snapshot.requiredWorkflowChecks.length : 0,
            requiredDependencyCheckCount: Array.isArray(snapshot.requiredDependencyChecks) ? snapshot.requiredDependencyChecks.length : 0
          }
        : undefined,
      outcome: outcome
        ? {
            outcomeId: outcome.outcomeId,
            persisted: outcome.persisted,
            verdict: outcome.verdict,
            path: outcome.path,
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
            waivedVerification: limitArray(outcome.waivedVerification ?? data.waivedVerification, 30),
            modifiedPublicSymbols: limitArray(outcome.modifiedPublicSymbols, 40),
            hookSummary: outcome.hookSummary,
            truncation: nestedTruncation("outcome", truncation)
          }
        : undefined
    }
  };
}

function compactPostEditTruncation(
  data: Record<string, unknown>,
  snapshot: Record<string, unknown> | undefined,
  outcome: Record<string, unknown> | undefined
): Record<string, { total: number; returned: number }> {
  return {
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
    ...truncatedArray("workflows", data.workflows, 12),
    ...truncatedArray("workflowChecks", data.workflowChecks, 20),
    ...truncatedArray("dependencyChecks", data.dependencyChecks, 30),
    ...truncatedArray("snapshot.plannedEditTargets", snapshot?.plannedEditTargets, 30),
    ...truncatedArray("snapshot.plannedFiles", snapshot?.plannedFiles, 40),
    ...truncatedArray("snapshot.plannedTests", snapshot?.plannedTests, 20),
    ...truncatedArray("outcome.testsNotRun", outcome?.testsNotRun, 30),
    ...truncatedArray("outcome.missedLikelyTests", outcome?.missedLikelyTests, 30),
    ...truncatedArray("outcome.ranCommandReports", outcome?.ranCommandReports, 30),
    ...truncatedArray("outcome.commandEnvelopes", outcome?.commandEnvelopes, 30),
    ...truncatedArray("outcome.verificationCoverage", outcome?.verificationCoverage, 40),
    ...truncatedArray("outcome.verificationLedger", outcome?.verificationLedger, 60),
    ...truncatedArray("outcome.waivedVerification", outcome ? (outcome.waivedVerification ?? data.waivedVerification) : undefined, 30),
    ...truncatedArray("outcome.modifiedPublicSymbols", outcome?.modifiedPublicSymbols, 40)
  };
}

function compactContextPacketData(data: Record<string, unknown>, mode: string): McpCompactionResult {
  const limit = createArrayLimiter();
  const compacted = {
    mode,
    task: data.task,
    changeType: data.changeType,
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
    gaps: limit("gaps", data.gaps, 30),
    session: compactSession(data.session),
    runtime: data.runtime,
    truncation: Object.keys(limit.truncation).length > 0 ? limit.truncation : undefined
  };
  return { data: compacted, truncation: limit.truncation, compacted: true };
}

function compactFocusBriefData(data: Record<string, unknown>): McpCompactionResult {
  const limit = createArrayLimiter();
  const compacted = {
    mode: data.mode,
    task: data.task,
    retrieval: compactRetrieval(data.retrieval),
    packetVerdict: data.packetVerdict,
    diagnostics: limit("diagnostics", data.diagnostics, 20),
    focusFiles: limit("focusFiles", data.focusFiles, 20, compactFileFact),
    workflows: limit("workflows", data.workflows, 12, compactWorkflow),
    modules: limit("modules", data.modules, 20, compactModule),
    groups: limit("groups", data.groups, 20, compactGroup),
    tests: limit("tests", data.tests, 30, compactTestRecommendation),
    nextCall: data.nextCall,
    quality: data.quality,
    gaps: limit("gaps", data.gaps, 30),
    runtime: data.runtime,
    truncation: Object.keys(limit.truncation).length > 0 ? limit.truncation : undefined
  };
  return { data: compacted, truncation: limit.truncation, compacted: true };
}

function compactChangePlanData(data: Record<string, unknown>): McpCompactionResult {
  const limit = createArrayLimiter();
  const compactFocus = data.focus && typeof data.focus === "object" && !Array.isArray(data.focus) ? compactFocusBriefData(data.focus as Record<string, unknown>) : undefined;
  const compactContext = data.context && typeof data.context === "object" && !Array.isArray(data.context) ? compactContextPacketData(data.context as Record<string, unknown>, "context_pack") : undefined;
  const snapshotLimit = createArrayLimiter();
  const snapshotDirtyLimit = createArrayLimiter();
  const snapshot = data.snapshot && typeof data.snapshot === "object" && !Array.isArray(data.snapshot) ? (data.snapshot as Record<string, unknown>) : undefined;
  const compacted = {
    mode: data.mode,
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
    snapshot: snapshot
      ? {
          taskId: snapshot.taskId,
          createdAt: snapshot.createdAt,
          changeType: snapshot.changeType,
          task: snapshot.task,
          plannedEditTargets: snapshotLimit("plannedEditTargets", snapshot.plannedEditTargets, 30),
          plannedFiles: snapshotLimit("plannedFiles", snapshot.plannedFiles, 40),
          focusFiles: snapshotLimit("focusFiles", snapshot.focusFiles, 20, compactFileFact),
          plannedTests: snapshotLimit("plannedTests", snapshot.plannedTests, 20, compactTestRecommendation),
          requiredWorkflowCheckCount: Array.isArray(snapshot.requiredWorkflowChecks) ? snapshot.requiredWorkflowChecks.length : 0,
          requiredDependencyCheckCount: Array.isArray(snapshot.requiredDependencyChecks) ? snapshot.requiredDependencyChecks.length : 0,
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
    ...prefixTruncation("focus", compactFocus?.truncation),
    ...prefixTruncation("context", compactContext?.truncation)
  };
  return { data: compacted, truncation, compacted: true };
}

function compactTestPlanData(data: Record<string, unknown>): McpCompactionResult {
  const limit = createArrayLimiter();
  const compacted = {
    changedFiles: limit("changedFiles", data.changedFiles, 40),
    changedEntries: limit("changedEntries", data.changedEntries, 40, compactChangedEntry),
    changedSymbols: limit("changedSymbols", data.changedSymbols, 40, compactSymbolLike),
    unindexedChanged: limit("unindexedChanged", data.unindexedChanged, 40),
    groups: limit("groups", data.groups, 20, compactGroup),
    tests: limit("tests", data.tests, 30, compactTestRecommendation),
    verificationCommands: limit("verificationCommands", data.verificationCommands, 20),
    verificationCoverage: limit("verificationCoverage", data.verificationCoverage, 40, compactVerificationCoverage),
    verificationCommandPlan: limit("verificationCommandPlan", data.verificationCommandPlan, 30, compactVerificationPlan),
    verificationLedgerPreview: limit("verificationLedgerPreview", data.verificationLedgerPreview, 60, compactVerificationLedgerEntry),
    gaps: limit("gaps", data.gaps, 30),
    runtime: data.runtime,
    truncation: Object.keys(limit.truncation).length > 0 ? limit.truncation : undefined
  };
  return { data: compacted, truncation: limit.truncation, compacted: true };
}

function createArrayLimiter(): ((name: string, value: unknown, limit: number, map?: (entry: unknown) => unknown) => unknown) & {
  truncation: Record<string, { total: number; returned: number }>;
} {
  const truncation: Record<string, { total: number; returned: number }> = {};
  const limiter = ((name: string, value: unknown, limit: number, map?: (entry: unknown) => unknown): unknown => {
    if (!Array.isArray(value)) {
      return value;
    }
    const returned = value.slice(0, limit).map((entry) => (map ? map(entry) : entry));
    if (value.length > limit) {
      truncation[name] = { total: value.length, returned: limit };
    }
    return returned;
  }) as ((name: string, value: unknown, limit: number, map?: (entry: unknown) => unknown) => unknown) & {
    truncation: Record<string, { total: number; returned: number }>;
  };
  limiter.truncation = truncation;
  return limiter;
}

function prefixTruncation(prefix: string, truncation: Record<string, { total: number; returned: number }> | undefined): Record<string, { total: number; returned: number }> {
  if (!truncation) {
    return {};
  }
  return Object.fromEntries(Object.entries(truncation).map(([key, value]) => [`${prefix}.${key}`, value]));
}

function nestedTruncation(prefix: string, truncation: Record<string, { total: number; returned: number }>): Record<string, { total: number; returned: number }> | undefined {
  const nestedPrefix = `${prefix}.`;
  const nested = Object.fromEntries(Object.entries(truncation).filter(([key]) => key.startsWith(nestedPrefix)).map(([key, value]) => [key.slice(nestedPrefix.length), value]));
  return Object.keys(nested).length > 0 ? nested : undefined;
}

function compactFileFact(value: unknown): unknown {
  if (!isRecord(value)) {
    return value;
  }
  const record = value;
  return {
    id: record.id,
    type: record.type,
    path: record.path,
    language: record.language,
    dirty: record.dirty,
    generated: record.generated,
    test: record.test,
    rank: record.rank,
    symbolCount: record.symbolCount,
    usageCount: record.usageCount,
    importCount: record.importCount,
    riskScore: record.riskScore,
    source: record.source,
    confidence: record.confidence
  };
}

function compactFocusEntry(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  const record = value as Record<string, unknown>;
  const truncation: Record<string, { total: number; returned: number }> = {};
  const reasons = compactArrayField("reasons", record.reasons, 10, truncation);
  const matchedTerms = compactArrayField("matchedTerms", record.matchedTerms, 12, truncation);
  return {
    file: compactFileFact(record.file),
    reasons: reasons.value,
    rank: record.rank,
    score: record.score,
    tier: record.tier,
    matchedTerms: matchedTerms.value,
    truncation: Object.keys(truncation).length > 0 ? truncation : undefined
  };
}

function compactTestRecommendation(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  const record = value as Record<string, unknown>;
  return {
    path: record.path,
    reason: record.reason,
    rank: record.rank,
    evidenceTier: record.evidenceTier,
    command: record.command,
    commandSource: record.commandSource,
    commandConfidence: record.commandConfidence
  };
}

function compactCommandEnvelope(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  const record = value as Record<string, unknown>;
  return {
    command: typeof record.command === "string" ? redactMcpText(record.command) : record.command,
    cwd: typeof record.cwd === "string" ? redactMcpText(record.cwd) : record.cwd,
    packageManager: typeof record.packageManager === "string" ? redactMcpText(record.packageManager) : record.packageManager,
    workspace: typeof record.workspace === "string" ? redactMcpText(record.workspace) : record.workspace,
    packageRoot: typeof record.packageRoot === "string" ? redactMcpText(record.packageRoot) : record.packageRoot,
    packageName: typeof record.packageName === "string" ? redactMcpText(record.packageName) : record.packageName,
    scriptName: typeof record.scriptName === "string" ? redactMcpText(record.scriptName) : record.scriptName,
    args: Array.isArray(record.args) ? sanitizeCommandArgs(record.args.slice(0, 20)) : record.args,
    argsTruncated: Array.isArray(record.args) && record.args.length > 20 ? { total: record.args.length, returned: 20 } : undefined,
    exitCode: record.exitCode,
    durationMs: record.durationMs,
    stdoutSummary: typeof record.stdoutSummary === "string" ? redactMcpText(record.stdoutSummary) : record.stdoutSummary,
    stderrSummary: typeof record.stderrSummary === "string" ? redactMcpText(record.stderrSummary) : record.stderrSummary,
    outputSummary: typeof record.outputSummary === "string" ? redactMcpText(record.outputSummary) : record.outputSummary,
    source: record.source,
    scopeStatus: record.scopeStatus,
    classifierVersion: record.classifierVersion
  };
}

function compactCommandReportList(value: unknown, limit: number): unknown {
  return Array.isArray(value) ? value.slice(0, limit).map(compactCommandReport) : value;
}

function compactCommandEnvelopeList(value: unknown, limit: number): unknown {
  return Array.isArray(value) ? value.slice(0, limit).map(compactCommandEnvelope) : value;
}

function compactCommandReport(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  const record = value as Record<string, unknown>;
  return {
    ...record,
    command: typeof record.command === "string" ? redactMcpText(record.command) : record.command,
    cwd: typeof record.cwd === "string" ? redactMcpText(record.cwd) : record.cwd,
    workspace: typeof record.workspace === "string" ? redactMcpText(record.workspace) : record.workspace,
    packageRoot: typeof record.packageRoot === "string" ? redactMcpText(record.packageRoot) : record.packageRoot,
    packageName: typeof record.packageName === "string" ? redactMcpText(record.packageName) : record.packageName,
    packageManager: typeof record.packageManager === "string" ? redactMcpText(record.packageManager) : record.packageManager,
    scriptName: typeof record.scriptName === "string" ? redactMcpText(record.scriptName) : record.scriptName,
    args: Array.isArray(record.args) ? sanitizeCommandArgs(record.args) : record.args,
    stdoutSummary: typeof record.stdoutSummary === "string" ? redactMcpText(record.stdoutSummary) : record.stdoutSummary,
    stderrSummary: typeof record.stderrSummary === "string" ? redactMcpText(record.stderrSummary) : record.stderrSummary,
    outputSummary: typeof record.outputSummary === "string" ? redactMcpText(record.outputSummary) : record.outputSummary
  };
}

function sanitizeCommandArgs(args: unknown[]): unknown[] {
  let redactNext = false;
  return args.map((arg) => {
    if (typeof arg !== "string") {
      return arg;
    }
    if (redactNext) {
      redactNext = false;
      return "<redacted>";
    }
    if (isSecretFlag(arg) && !arg.includes("=")) {
      redactNext = true;
      return redactMcpText(arg) ?? "";
    }
    return redactMcpText(redactSecretArg(arg)) ?? "";
  });
}

function redactMcpText(value: string | undefined): string | undefined {
  return redactSecretText(value)
    ?.replace(/(^|[\s([,{])\/[^\s;|)\]'",]+/gu, "$1<abs-path>")
    .replace(/(^|[\s([,{])(?:\.\.?\/)[^\s;|)\]'",]+/gu, "$1<rel-path>");
}

function redactSecretText(value: string | undefined): string | undefined {
  return value
    ?.replace(/((?:--?|[A-Z_]*)(?:token|secret|password|passwd|pwd|api[-_]?key|access[-_]?key|auth|credential|cookie)[A-Z0-9_-]*(?:=|\s+))([^\s;|)\]'",]+)/giu, "$1<redacted>")
    .replace(/\b(Bearer)\s+[A-Za-z0-9._~+/-]+=*/giu, "$1 <redacted>");
}

function redactSecretArg(value: string): string {
  if (/^Bearer\s+/iu.test(value)) {
    return "Bearer <redacted>";
  }
  if (isSecretFlag(value) && value.includes("=")) {
    return value.replace(/=.*/u, "=<redacted>");
  }
  if (/^(?:[A-Z_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|PWD|API_?KEY|ACCESS_?KEY|AUTH|CREDENTIAL|COOKIE)[A-Z0-9_]*)=/iu.test(value)) {
    return value.replace(/=.*/u, "=<redacted>");
  }
  return value;
}

function isSecretFlag(value: string): boolean {
  return /^--?[a-z0-9-]*(?:token|secret|password|passwd|pwd|api-?key|access-?key|auth|credential|cookie)[a-z0-9-]*(?:=.*)?$/iu.test(value);
}

function compactWorkflow(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  const record = value as Record<string, unknown>;
  const truncation: Record<string, { total: number; returned: number }> = {};
  const relatedFiles = compactArrayField("relatedFiles", record.relatedFiles, 20, truncation);
  const tests = compactArrayField("tests", record.tests, 20, truncation);
  const steps = compactArrayField("steps", record.steps, 16, truncation, compactWorkflowStep);
  return {
    id: record.id,
    title: record.title,
    workflowKind: record.workflowKind,
    entryPath: record.entryPath,
    relatedFiles: relatedFiles.value,
    tests: tests.value,
    summary: record.summary,
    rank: record.rank,
    confidence: record.confidence,
    steps: steps.value,
    truncation: Object.keys(truncation).length > 0 ? truncation : undefined
  };
}

function compactWorkflowStep(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  const record = value as Record<string, unknown>;
  return {
    kind: record.kind,
    label: record.label,
    path: record.path,
    line: record.line,
    targetPath: record.targetPath,
    confidence: record.confidence,
    reason: record.reason
  };
}

function compactModule(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  const record = value as Record<string, unknown>;
  const truncation: Record<string, { total: number; returned: number }> = {};
  const files = compactArrayField("files", record.files, 20, truncation);
  const reasons = compactArrayField("reasons", record.reasons, 10, truncation);
  return {
    name: record.name,
    score: record.score,
    rank: record.rank,
    summary: record.summary,
    files: files.value,
    reasons: reasons.value,
    truncation: Object.keys(truncation).length > 0 ? truncation : undefined
  };
}

function compactGroup(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  const record = value as Record<string, unknown>;
  const truncation: Record<string, { total: number; returned: number }> = {};
  const files = compactArrayField("files", record.files, 30, truncation);
  const symbols = compactArrayField("symbols", record.symbols, 20, truncation);
  return {
    name: record.name,
    module: record.module,
    kind: record.kind,
    language: record.language,
    risk: record.risk,
    files: files.value,
    changes: record.changes,
    symbols: symbols.value,
    truncation: Object.keys(truncation).length > 0 ? truncation : undefined
  };
}

function compactChangedEntry(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  const record = value as Record<string, unknown>;
  return { path: record.path, status: record.status, oldPath: record.oldPath };
}

function compactSymbolLike(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  const record = value as Record<string, unknown>;
  return {
    id: record.id,
    path: record.path,
    name: record.name,
    qualifiedName: record.qualifiedName,
    kind: record.kind,
    exported: record.exported,
    line: typeof record.line === "number" ? record.line : undefined,
    range: record.range
  };
}

function compactVerificationCoverage(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  const record = value as Record<string, unknown>;
  const truncation: Record<string, { total: number; returned: number }> = {};
  const details = compactArrayField("details", record.details, 8, truncation);
  return {
    kind: record.kind,
    command: record.command,
    source: record.source,
    confidence: record.confidence,
    scope: record.scope,
    targetPath: record.targetPath,
    details: details.value,
    exitCode: record.exitCode,
    durationMs: record.durationMs,
    outputSummary: record.outputSummary,
    commandEnvelope: compactCommandEnvelope(record.commandEnvelope),
    truncation: Object.keys(truncation).length > 0 ? truncation : undefined
  };
}

function compactVerificationPlan(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  const record = value as Record<string, unknown>;
  const truncation: Record<string, { total: number; returned: number }> = {};
  const covers = compactArrayField("covers", record.covers, 12, truncation);
  const targetPaths = compactArrayField("targetPaths", record.targetPaths, 20, truncation);
  const scopes = compactArrayField("scopes", record.scopes, 12, truncation);
  const sources = compactArrayField("sources", record.sources, 12, truncation);
  return {
    command: record.command,
    covers: covers.value,
    targetPaths: targetPaths.value,
    scopes: scopes.value,
    sources: sources.value,
    confidence: record.confidence,
    truncation: Object.keys(truncation).length > 0 ? truncation : undefined
  };
}

function compactVerificationLedgerEntry(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  const record = value as Record<string, unknown>;
  const truncation: Record<string, { total: number; returned: number }> = {};
  const evidence = compactArrayField("evidence", record.evidence, 8, truncation);
  const coverageKinds = compactArrayField("coverageKinds", record.coverageKinds, 12, truncation);
  return {
    kind: record.kind,
    recommended: record.recommended,
    target: record.target,
    status: record.status,
    evidence: evidence.value,
    missingReason: record.missingReason,
    waiverReason: record.waiverReason,
    notApplicableReason: record.notApplicableReason,
    coverageKinds: coverageKinds.value,
    command: record.command,
    source: record.source,
    truncation: Object.keys(truncation).length > 0 ? truncation : undefined
  };
}

function compactCheck(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  const record = value as Record<string, unknown>;
  const truncation: Record<string, { total: number; returned: number }> = {};
  const evidence = compactArrayField("evidence", record.evidence, 8, truncation);
  return {
    kind: record.kind,
    target: record.target,
    status: record.status,
    reason: record.reason,
    evidence: evidence.value,
    truncation: Object.keys(truncation).length > 0 ? truncation : undefined
  };
}

function compactRetrieval(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  const record = value as Record<string, unknown>;
  const limit = createArrayLimiter();
  const intentConfidence = compactIntentConfidence(record.intentConfidence);
  return {
    broad: record.broad,
    intents: limit("intents", record.intents, 12),
    diagnostics: limit("diagnostics", record.diagnostics, 20),
    intentConfidence,
    modules: limit("modules", record.modules, 20, compactModule),
    workflows: limit("workflows", record.workflows, 12, compactWorkflow),
    matchCount: Array.isArray(record.matches) ? record.matches.length : undefined,
    matches: limit("matches", record.matches, 20, compactFocusEntry),
    truncation: Object.keys(limit.truncation).length > 0 ? limit.truncation : undefined
  };
}

function compactIntentConfidence(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  const record = value as Record<string, unknown>;
  const limit = createArrayLimiter();
  const compacted = {
    ...record,
    anchors: limit("anchors", record.anchors, 6),
    missingAnchors: limit("missingAnchors", record.missingAnchors, 6),
    reasons: limit("reasons", record.reasons, 12)
  };
  return {
    ...compacted,
    truncation: Object.keys(limit.truncation).length > 0 ? limit.truncation : undefined
  };
}

function compactSession(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  const record = value as Record<string, unknown>;
  const limit = createArrayLimiter();
  const compacted = {
    commandBudgetMs: record.commandBudgetMs,
    maxResultBytes: record.maxResultBytes,
    maxResults: record.maxResults,
    provenance: limit("provenance", record.provenance, 30)
  };
  return {
    ...compacted,
    truncation: Object.keys(limit.truncation).length > 0 ? limit.truncation : undefined
  };
}

function compactArrayField(
  name: string,
  value: unknown,
  limit: number,
  truncation: Record<string, { total: number; returned: number }>,
  map?: (entry: unknown) => unknown
): { value: unknown; truncation?: Record<string, { total: number; returned: number }> } {
  if (!Array.isArray(value)) {
    return { value };
  }
  const returned = value.slice(0, limit).map((entry) => (map ? map(entry) : entry));
  if (value.length > limit) {
    truncation[name] = { total: value.length, returned: limit };
  }
  return { value: returned, truncation: value.length > limit ? { [name]: { total: value.length, returned: limit } } : undefined };
}

interface GenericCompactOptions {
  arrayLimit: number;
  objectKeyLimit: number;
  maxDepth: number;
}

function compactGenericValue(value: unknown, options: GenericCompactOptions, truncation: McpTruncation, pathName = "value", depth = options.maxDepth): unknown {
  if (Array.isArray(value)) {
    const returned = value.slice(0, options.arrayLimit).map((entry) => compactGenericValue(entry, options, truncation, pathName, depth - 1));
    if (value.length > options.arrayLimit) {
      truncation[pathName] = { total: value.length, returned: options.arrayLimit };
    }
    return returned;
  }
  if (!isRecord(value)) {
    return value;
  }
  const entries = Object.entries(value).filter(([key]) => key !== "mcp");
  if (depth <= 0) {
    const keys = entries.map(([key]) => key);
    if (keys.length > options.objectKeyLimit) {
      truncation[`${pathName}.__keys`] = { total: keys.length, returned: options.objectKeyLimit };
    }
    return {
      compactedObject: true,
      keyCount: keys.length,
      keys: keys.slice(0, options.objectKeyLimit)
    };
  }
  const selected = entries.slice(0, options.objectKeyLimit);
  if (entries.length > options.objectKeyLimit) {
    truncation[`${pathName}.__keys`] = { total: entries.length, returned: options.objectKeyLimit };
  }
  return Object.fromEntries(
    selected.map(([key, entry]) => [key, compactGenericValue(entry, options, truncation, pathName === "value" ? key : `${pathName}.${key}`, depth - 1)])
  );
}

function compactSummaryArray(name: string, value: unknown, limit: number, truncation: McpTruncation, map?: (entry: unknown) => unknown): unknown {
  if (!Array.isArray(value)) {
    return value;
  }
  const returned = value.slice(0, limit).map((entry) => (map ? map(entry) : entry));
  if (value.length > limit) {
    const previous = truncation[name];
    truncation[name] = { total: Math.max(previous?.total ?? 0, value.length), returned: limit };
  }
  return returned;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function clampLargeStrings(value: unknown, maxLength = 1000): { value: unknown; stringTruncations: number } {
  let stringTruncations = 0;
  const visit = (entry: unknown, depth: number): unknown => {
    if (typeof entry === "string") {
      if (entry.length <= maxLength) {
        return entry;
      }
      stringTruncations += 1;
      return `${entry.slice(0, maxLength - 3)}...`;
    }
    if (depth <= 0 || !entry || typeof entry !== "object") {
      return entry;
    }
    if (Array.isArray(entry)) {
      return entry.map((item) => visit(item, depth - 1));
    }
    return Object.fromEntries(Object.entries(entry as Record<string, unknown>).map(([key, item]) => [key, visit(item, depth - 1)]));
  };
  return { value: visit(value, 12), stringTruncations };
}

function structuredByteLength(value: unknown): number {
  try {
    const serialized = JSON.stringify(value);
    return serialized ? Buffer.byteLength(serialized, "utf8") : 0;
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

function truncatedArray(name: string, value: unknown, limit: number): Record<string, { total: number; returned: number }> {
  return Array.isArray(value) && value.length > limit ? { [name]: { total: value.length, returned: limit } } : {};
}

function withSessionRuntime(result: QueryResult, session: QuerySession): QueryResult {
  const runtime = {
    repoRoot: session.repoRoot,
    indexLoaded: Boolean(session.index),
    freshness: session.freshness.reason,
    stale: session.freshness.stale,
    gitHead: session.gitState.headCommit,
    dirtyFileCount: session.gitState.dirtyFiles.length,
    changedFilesLoaded: session.provenance.some((entry) => entry.startsWith("changed-files:")),
    commandBudgetMs: session.commandBudgetMs,
    commandBudgetUsedMs: session.commandBudgetUsedMs(),
    commandBudgetRemainingMs: session.commandBudgetRemainingMs(),
    maxResultBytes: session.maxResultBytes,
    resultBytes: Buffer.byteLength(result.text, "utf8"),
    maxResults: session.maxResults,
    warnings: session.warnings.slice(0, 20),
    provenance: session.provenance.slice(0, 30)
  };
  let text = result.text;
  let data = addRuntimeData(result.data, runtime);
  if (runtime.resultBytes > session.maxResultBytes) {
    const suffix = `\n\n[Codexa result truncated to ${session.maxResultBytes} bytes for MCP transport.]`;
    text = `${result.text.slice(0, Math.max(0, session.maxResultBytes - suffix.length))}${suffix}`;
    session.warnings.push(`result truncated to ${session.maxResultBytes} bytes`);
    data = addRuntimeData(result.data, {
      ...runtime,
      resultBytes: Buffer.byteLength(text, "utf8"),
      resultTruncated: true,
      warnings: session.warnings.slice(0, 20)
    });
  }
  return {
    ...result,
    text,
    data
  };
}

function addRuntimeData(data: unknown, runtime: Record<string, unknown>): unknown {
  if (data && typeof data === "object" && !Array.isArray(data)) {
    return { ...(data as Record<string, unknown>), runtime };
  }
  return { value: data, runtime };
}

function limitArray(value: unknown, limit: number): unknown {
  return Array.isArray(value) ? value.slice(0, limit) : value;
}

function compactSnapshotLoad(value: unknown): unknown {
  if (!value || typeof value !== "object") {
    return value;
  }
  const record = value as Record<string, unknown>;
  return {
    taskId: record.taskId,
    path: typeof record.path === "string" ? record.path.split("/.codex/").pop()?.replace(/^/, ".codex/") ?? record.path : record.path,
    missingReason: record.missingReason,
    error: record.error,
    recoveredLatest: record.recoveredLatest
  };
}

function toToolResult(result: { text: string; data: unknown; freshness: unknown; refresh?: unknown }) {
  return {
    content: [
      {
        type: "text" as const,
        text: result.text
      }
    ],
    structuredContent: {
      data: result.data,
      freshness: result.freshness,
      refresh: result.refresh ?? { refreshed: false }
    }
  };
}

async function safeQuery(producer: () => Promise<QueryResult>, repoRoot: string): Promise<QueryResult> {
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

async function registerArtifactResources(server: McpServer, repoRoot: string): Promise<void> {
  const artifacts = [
    ["codebase-readme", "codexa://repo/codebase/README.md", ".codex/codebase/README.md", "text/markdown", "Codexa artifact overview"],
    ["codex-contract", "codexa://repo/codebase/codex-contract.md", ".codex/codebase/codex-contract.md", "text/markdown", "Codex automatic-use contract"],
    ["repo-map", "codexa://repo/codebase/repo-map.md", ".codex/codebase/repo-map.md", "text/markdown", "Ranked repository map"],
    ["risk-map", "codexa://repo/codebase/risk-map.md", ".codex/codebase/risk-map.md", "text/markdown", "Risk-ranked files and signals"],
    ["test-map", "codexa://repo/codebase/test-map.md", ".codex/codebase/test-map.md", "text/markdown", "Detected test files and test edges"],
    ["conventions", "codexa://repo/codebase/conventions.md", ".codex/codebase/conventions.md", "text/markdown", "Detected project conventions"],
    ["workflows", "codexa://repo/codebase/workflows.md", ".codex/codebase/workflows.md", "text/markdown", "Detected workflow traces"],
    ["playbooks", "codexa://repo/codebase/playbooks/README.md", ".codex/codebase/playbooks/README.md", "text/markdown", "Generated Codexa change playbook index"],
    ["freshness-json", "codexa://repo/codebase/freshness.json", ".codex/codebase/freshness.json", "application/json", "Codexa freshness snapshot"]
  ] as const;

  for (const [name, uri, relativePath, mimeType, description] of artifacts) {
    server.registerResource(
      name,
      uri,
      {
        title: `Codexa ${name}`,
        description,
        mimeType
      },
      async () => ({
        contents: [
          {
            uri,
            mimeType,
            text: await readArtifact(repoRoot, relativePath)
          }
        ]
      })
    );
  }

  server.registerResource(
    "module-index",
    "codexa://repo/codebase/modules",
    {
      title: "Codexa module index",
      description: "List generated Codexa module artifact names.",
      mimeType: "text/markdown"
    },
    async () => {
      const modulesDir = path.join(repoRoot, ".codex/codebase/modules");
      let text = "# Codexa Modules\n\n";
      try {
        const allNames = (await fs.readdir(modulesDir)).filter((name) => name.endsWith(".md")).sort();
        const names = allNames.slice(0, 80);
        text += names.map((name) => `- codexa://repo/codebase/modules/${encodeURIComponent(name)}`).join("\n") || "- none";
        if (allNames.length > names.length) {
          text += `\n- ... ${allNames.length - names.length} more modules omitted from this bounded index`;
        }
      } catch {
        text += "- modules unavailable; run `codexa index <repo>` first";
      }
      return { contents: [{ uri: "codexa://repo/codebase/modules", mimeType: "text/markdown", text }] };
    }
  );

  server.registerResource(
    "module-artifact",
    new ResourceTemplate("codexa://repo/codebase/modules/{name}", {
      list: async () => ({
        resources: await listMarkdownArtifacts(repoRoot, ".codex/codebase/modules", "codexa://repo/codebase/modules", "Codexa module", "Generated Codexa module artifact")
      })
    }),
    {
      title: "Codexa module artifact",
      description: "Read a generated Codexa module artifact by filename.",
      mimeType: "text/markdown"
    },
    async (uri, variables) => {
      const name = artifactNameVariable(variables.name);
      return {
        contents: [
          {
            uri: uri.toString(),
            mimeType: "text/markdown",
            text: await readArtifact(repoRoot, `.codex/codebase/modules/${name}`)
          }
        ]
      };
    }
  );

  server.registerResource(
    "playbook-artifact",
    new ResourceTemplate("codexa://repo/codebase/playbooks/{name}", {
      list: async () => ({
        resources: await listMarkdownArtifacts(
          repoRoot,
          ".codex/codebase/playbooks",
          "codexa://repo/codebase/playbooks",
          "Codexa playbook",
          "Generated Codexa change playbook",
          (name) => name !== "README.md"
        )
      })
    }),
    {
      title: "Codexa playbook artifact",
      description: "Read a generated Codexa change playbook by filename.",
      mimeType: "text/markdown"
    },
    async (uri, variables) => {
      const name = artifactNameVariable(variables.name);
      return {
        contents: [
          {
            uri: uri.toString(),
            mimeType: "text/markdown",
            text: await readArtifact(repoRoot, `.codex/codebase/playbooks/${name}`)
          }
        ]
      };
    }
  );
}

async function readArtifact(repoRoot: string, relativePath: string): Promise<string> {
  try {
    return await fs.readFile(path.join(repoRoot, relativePath), "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Codexa artifact missing: ${relativePath}. Run: codexa index ${repoRoot}. ${message}`);
  }
}

async function listMarkdownArtifacts(
  repoRoot: string,
  relativeDir: string,
  uriPrefix: string,
  titlePrefix: string,
  descriptionPrefix: string,
  include: (name: string) => boolean = () => true
) {
  try {
    const names = (await fs.readdir(path.join(repoRoot, relativeDir))).filter((name) => name.endsWith(".md") && include(name)).sort().slice(0, 80);
    return names.map((name) => ({
      name: `${titlePrefix} ${name}`,
      uri: `${uriPrefix}/${encodeURIComponent(name)}`,
      title: `${titlePrefix} ${name}`,
      description: `${descriptionPrefix} ${name}`,
      mimeType: "text/markdown"
    }));
  } catch {
    return [];
  }
}

function artifactNameVariable(value: string | string[]): string {
  const name = Array.isArray(value) ? value.join("/") : value;
  if (!name || name.includes("/") || name.includes("\\") || name === "." || name === ".." || !name.endsWith(".md")) {
    throw new Error(`Invalid Codexa artifact name: ${name}`);
  }
  return name;
}

function registerWorkflowPrompts(server: McpServer): void {
  server.registerPrompt(
    "impact_before_edit",
    {
      title: "Codexa impact before edit",
      description: "Use Codexa to gather blast-radius context before changing a file or symbol.",
      argsSchema: {
        target: z.string().describe("File path, symbol name, or symbol id to inspect before editing."),
        task: z.string().optional().describe("Short task description.")
      }
    },
    async ({ target, task }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: [
              `Use Codexa before editing ${target}.`,
              task ? `Task: ${task}` : undefined,
              "Call `change_plan` with `saveSnapshot: true` for the target and task before editing.",
              "Call `impact` only if the plan reports medium/low quality, broad fanout, or a high-risk public contract.",
              "After editing, call `post_edit_review` with the returned task snapshot id.",
              "Read the returned freshness, confidence labels, known gaps, affected files, and likely tests before modifying code."
            ]
              .filter((line): line is string => Boolean(line))
              .join("\n")
          }
        }
      ]
    })
  );

  server.registerPrompt(
    "dirty_diff_review",
    {
      title: "Codexa dirty diff review",
      description: "Review the current dirty tree with grouped impact and targeted verification.",
      argsSchema: {
        task: z.string().optional().describe("What the dirty diff is supposed to accomplish.")
      }
    },
    async ({ task }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: [
              "Use Codexa to review the current dirty diff.",
              task ? `Expected intent: ${task}` : undefined,
              "Call `post_edit_review` first if a change_plan snapshot exists; otherwise call `task_brief` with `diff: true`.",
              "Then call `diff_impact` or `test_plan` only if the review or brief leaves a gap.",
              "Check changed-but-unindexed files, parser errors, heuristic-only links, and candidate test command provenance."
            ]
              .filter((line): line is string => Boolean(line))
              .join("\n")
          }
        }
      ]
    })
  );

  server.registerPrompt(
    "snapshot_edit_loop",
    {
      title: "Codexa snapshot edit loop",
      description: "Use a plan-time snapshot before editing and a drift review after editing.",
      argsSchema: {
        task: z.string().describe("Short description of the intended edit."),
        target: z.string().optional().describe("Optional file path, symbol name, or symbol id to change.")
      }
    },
    async ({ task, target }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: [
              "Use Codexa's snapshot edit loop.",
              `Task: ${task}`,
              target ? `Target: ${target}` : undefined,
              "Before editing, call `change_plan` with `saveSnapshot: true` and a short `taskId`.",
              "Use the returned planned files, tests, workflows, quality, and gaps to guide source reads.",
              "After editing, call `post_edit_review` with that `taskId` and any tests already run.",
              "If the review says `inspect` or `replan`, resolve that drift before claiming the edit is complete."
            ]
              .filter((line): line is string => Boolean(line))
              .join("\n")
          }
        }
      ]
    })
  );

  server.registerPrompt(
    "targeted_test_plan",
    {
      title: "Codexa targeted test plan",
      description: "Generate a focused test plan with command provenance for current changes.",
      argsSchema: {
        task: z.string().optional().describe("Short description of the change being verified.")
      }
    },
    async ({ task }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: [
              "Use Codexa to create a targeted test plan.",
              task ? `Change under test: ${task}` : undefined,
              "Call `test_plan` with `diff: true` and prefer tests whose commands have package or Python metadata provenance.",
              "If command provenance is missing, inspect the repo scripts before running a command."
            ]
              .filter((line): line is string => Boolean(line))
              .join("\n")
          }
        }
      ]
    })
  );
}
