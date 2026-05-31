import type { McpServer, ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ShapeOutput, ZodRawShapeCompat } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  callersQuery,
  calleesQuery,
  changePlanQuery,
  contextPackQuery,
  dependencyPathQuery,
  diffImpactQuery,
  findContextQuery,
  focusBriefQuery,
  impactQuery,
  placeholderReportQuery,
  postEditReviewQuery,
  repoMapQuery,
  searchQuery,
  sessionMemoryQuery,
  statusQuery,
  symbolContextQuery,
  taskBriefQuery,
  testPlanQuery,
  workflowPathQuery
} from "../queries.js";
import type { QueryOptions, QueryResult, SessionMemoryInput } from "../types.js";
import type { QuerySession } from "../query/session.js";
import { RAW_SEARCH_EXPLICIT_PATTERN_LIMIT } from "../query/raw-search.js";

export type McpOptionalQueryInput = Record<string, unknown> & {
  semantic?: boolean;
  semanticProvider?: "openai" | "local-command";
  semanticModel?: string;
  semanticDimensions?: number;
  semanticTimeoutMs?: number;
  semanticBatchSize?: number;
  lsp?: boolean;
  lspTimeoutMs?: number;
  lspMaxFiles?: number;
};

type McpToolContext = string | { toolName: string; input?: Record<string, unknown>; autoRecord?: boolean };
type ChangeType = "style" | "api" | "behavior" | "rename" | "delete" | "unknown";

interface McpToolDefinition<InputSchema extends ZodRawShapeCompat> {
  name: string;
  title: string;
  description: string;
  inputSchema: InputSchema;
  annotations: ToolAnnotations;
  handler: (input: ShapeOutput<InputSchema>) => Promise<CallToolResult>;
}

interface RegisterMcpToolsOptions {
  server: McpServer;
  queryOptions: QueryOptions;
  outputSchema: ZodRawShapeCompat;
  annotations: {
    pureRead: ToolAnnotations;
    sourceContext: ToolAnnotations;
    cacheWrite: ToolAnnotations;
    memoryWrite: ToolAnnotations;
  };
  schemas: {
    changeType: z.ZodType<ChangeType>;
    semanticQuery: z.ZodRawShape;
    lspQuery: z.ZodRawShape;
    confidence: z.ZodTypeAny;
    evidenceTier: z.ZodTypeAny;
    sessionMemoryKind: z.ZodTypeAny;
    sessionMemoryProvenance: z.ZodTypeAny;
    sessionMemoryStatus: z.ZodTypeAny;
    sessionMemoryRef: z.ZodTypeAny;
    sessionMemoryScope: z.ZodTypeAny;
    sessionMemoryEvidence: z.ZodTypeAny;
  };
  toolQueryOptions: (input?: McpOptionalQueryInput) => QueryOptions;
  runTool: (producer: (session: QuerySession) => Promise<QueryResult>, toolContext: McpToolContext) => Promise<CallToolResult>;
  runFreshnessTool: () => Promise<CallToolResult>;
}

function registerMcpTool<InputSchema extends ZodRawShapeCompat>(
  { server, outputSchema }: Pick<RegisterMcpToolsOptions, "server" | "outputSchema">,
  tool: McpToolDefinition<InputSchema>
): void {
  // Keep the MCP SDK's conditional callback cast inside this adapter helper.
  const handler = (async (input: ShapeOutput<InputSchema>) => tool.handler(input)) as unknown as ToolCallback<InputSchema>;
  server.registerTool(
    tool.name,
    {
      title: tool.title,
      description: tool.description,
      inputSchema: tool.inputSchema,
      outputSchema,
      annotations: tool.annotations
    },
    handler
  );
}

export function registerMcpTools(options: RegisterMcpToolsOptions): void {
  const { server, queryOptions, outputSchema, toolQueryOptions, runTool, runFreshnessTool } = options;
  const { pureRead, sourceContext, cacheWrite, memoryWrite } = options.annotations;
  const {
    changeType: changeTypeSchema,
    semanticQuery: semanticQuerySchema,
    lspQuery: lspQuerySchema,
    confidence: confidenceSchema,
    evidenceTier: evidenceTierSchema,
    sessionMemoryKind: sessionMemoryKindSchema,
    sessionMemoryProvenance: sessionMemoryProvenanceSchema,
    sessionMemoryStatus: sessionMemoryStatusSchema,
    sessionMemoryRef: sessionMemoryRefSchema,
    sessionMemoryScope: sessionMemoryScopeSchema,
    sessionMemoryEvidence: sessionMemoryEvidenceSchema
  } = options.schemas;

  server.registerTool(
    "freshness",
    {
      title: "Codexa freshness",
      description: "Report whether the Codexa index is present, fresh, stale, or missing.",
      inputSchema: {},
      outputSchema,
      annotations: pureRead
    },
    async () => runFreshnessTool()
  );

  server.registerTool(
    "repo_map",
    {
      title: "Codexa repo map",
      description: "Return the top-ranked modules and files, refreshing stale Codexa artifacts first when auto-refresh is enabled.",
      inputSchema: { limit: z.number().int().positive().max(50).optional(), tokenBudget: z.number().int().min(400).max(8000).optional() },
      outputSchema,
      annotations: sourceContext
    },
    async ({ limit, tokenBudget }) => runTool((session) => repoMapQuery(session, limit ?? 20, queryOptions, tokenBudget ?? 1500), "repo_map")
  );

  server.registerTool(
    "find_context",
    {
      title: "Codexa find context",
      description: "Find matching files, symbols, and usage sites, refreshing stale Codexa artifacts first when auto-refresh is enabled.",
      inputSchema: { query: z.string().min(1), limit: z.number().int().positive().max(30).optional(), ...semanticQuerySchema },
      outputSchema,
      annotations: memoryWrite
    },
    async (input) => runTool((session) => findContextQuery(session, input.query, input.limit ?? 12, toolQueryOptions(input)), { toolName: "find_context", input })
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
        includeRaw: z.boolean().optional(),
        ...semanticQuerySchema
      },
      outputSchema,
      annotations: sourceContext
    },
    async (input) =>
      runTool((session) => searchQuery(session, { query: input.query, patterns: input.patterns, limit: input.limit ?? 12, includeRaw: input.includeRaw ?? true }, toolQueryOptions(input)), "search")
  );

  server.registerTool(
    "placeholder_report",
    {
      title: "Codexa placeholder report",
      description: "Report indexed placeholder, dummy, TODO, and stub code/data findings. Findings are tracked as risk signals and participate in post_edit_review deltas.",
      inputSchema: {
        includeTests: z.boolean().optional(),
        includeDocs: z.boolean().optional(),
        includeGenerated: z.boolean().optional(),
        limit: z.number().int().positive().max(50).optional(),
        tokenBudget: z.number().int().min(500).max(8000).optional()
      },
      outputSchema,
      annotations: sourceContext
    },
    async (input) => runTool((session) => placeholderReportQuery(session, input, queryOptions), "placeholder_report")
  );

  server.registerTool(
    "symbol_context",
    {
      title: "Codexa symbol context",
      description: "Return proof-carrying symbol neighborhood context for a symbol id or name, including callers, callees, references, tests, risks, evidence, and guided next tools.",
      inputSchema: {
        symbol: z.string().min(1),
        depth: z.number().int().min(1).max(3).optional(),
        includeEvidence: z.boolean().optional(),
        language: z.string().optional(),
        ...lspQuerySchema
      },
      outputSchema,
      annotations: sourceContext
    },
    async (input) =>
      runTool(
        (session) =>
          symbolContextQuery(session, input.symbol, toolQueryOptions(input), {
            depth: input.depth,
            includeEvidence: input.includeEvidence,
            language: input.language
          }),
        "symbol_context"
      )
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
      annotations: memoryWrite
    },
    async (input) => runTool((session) => impactQuery(session, { file: input.file, symbol: input.symbol, changeType: input.changeType, depth: input.depth }, queryOptions), { toolName: "impact", input })
  );

  server.registerTool(
    "diff_impact",
    {
      title: "Codexa diff impact",
      description: "Return high-level impact context for the current dirty git diff, refreshing stale Codexa artifacts first when auto-refresh is enabled.",
      inputSchema: {},
      outputSchema,
      annotations: sourceContext
    },
    async () => runTool((session) => diffImpactQuery(session, queryOptions), "diff_impact")
  );

  server.registerTool(
    "test_plan",
    {
      title: "Codexa test plan",
      description: "Recommend targeted tests for the current diff or top-ranked files, refreshing stale Codexa artifacts first when auto-refresh is enabled.",
      inputSchema: { diff: z.boolean().optional(), changeType: changeTypeSchema.optional() },
      outputSchema,
      annotations: memoryWrite
    },
    async (input) =>
      runTool(
        (session) =>
          testPlanQuery(session, input.diff ?? true, {
            ...queryOptions,
            changeType: input.changeType as ChangeType | undefined
          }),
        { toolName: "test_plan", input }
      )
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
        includeSnippets: z.boolean().optional(),
        ...semanticQuerySchema,
        ...lspQuerySchema
      },
      outputSchema,
      annotations: memoryWrite
    },
    async (input) => runTool((session) => taskBriefQuery(session, input, toolQueryOptions(input)), { toolName: "task_brief", input })
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
        includeSnippets: z.boolean().optional(),
        ...semanticQuerySchema,
        ...lspQuerySchema
      },
      outputSchema,
      annotations: memoryWrite
    },
    async (input) => runTool((session) => contextPackQuery(session, input, toolQueryOptions(input)), { toolName: "context_pack", input })
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
        diff: z.boolean().optional(),
        ...semanticQuerySchema
      },
      outputSchema,
      annotations: memoryWrite
    },
    async (input) => runTool((session) => focusBriefQuery(session, input, toolQueryOptions(input)), { toolName: "focus_brief", input })
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
        diff: z.boolean().optional(),
        ...semanticQuerySchema
      },
      outputSchema,
      annotations: memoryWrite
    },
    async (input) => runTool(async (session) => asSessionContextResult(await focusBriefQuery(session, input, toolQueryOptions(input))), { toolName: "session_context", input })
  );

  server.registerTool(
    "session_memory",
    {
      title: "Codexa session memory",
      description: "Read, summarize, compact, or explicitly remember durable structured working memory for this Codex session. Cache-only; does not mutate source.",
      inputSchema: {
        action: z.enum(["read", "remember", "summary", "compact"]).optional(),
        sessionId: z.string().min(1).max(120).optional(),
        taskId: z.string().min(1).max(120).optional(),
        task: z.string().max(500).optional(),
        kinds: z.array(sessionMemoryKindSchema).max(12).optional(),
        refs: z.array(sessionMemoryRefSchema).max(80).optional(),
        files: z.array(z.string().max(500)).max(80).optional(),
        symbols: z.array(z.string().max(240)).max(80).optional(),
        topics: z.array(z.string().max(280)).max(40).optional(),
        limit: z.number().int().positive().max(40).optional(),
        tokenBudget: z.number().int().min(500).max(8000).optional(),
        includeStale: z.boolean().optional(),
        entries: z
          .array(
            z.object({
              kind: sessionMemoryKindSchema,
              key: z.string().max(160).optional(),
              summary: z.string().min(1).max(500),
              details: z.string().max(4000).optional(),
              provenance: sessionMemoryProvenanceSchema.optional(),
              status: sessionMemoryStatusSchema.optional(),
              confidence: confidenceSchema,
              evidenceTier: evidenceTierSchema,
              scope: sessionMemoryScopeSchema.optional(),
              evidence: z.array(sessionMemoryEvidenceSchema).max(24).optional(),
              supersedes: z.array(z.string().max(240)).max(20).optional()
            })
          )
          .max(20)
          .optional()
      },
      outputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false
      }
    },
    async (input) => runTool((session) => sessionMemoryQuery(session, input as SessionMemoryInput, queryOptions), { toolName: "session_memory", input, autoRecord: false })
  );

  const graphTargetSchema = {
    file: z.string().optional(),
    symbol: z.string().optional(),
    limit: z.number().int().positive().max(80).optional()
  } satisfies z.ZodRawShape;

  const graphTools = [
    {
      name: "callers",
      title: "Codexa callers",
      description: "Return typed graph evidence for files/symbols that call, reference, import, or test the target.",
      inputSchema: graphTargetSchema,
      annotations: sourceContext,
      handler: async (input) => runTool((session) => callersQuery(session, input, queryOptions), "callers")
    },
    {
      name: "callees",
      title: "Codexa callees",
      description: "Return typed graph evidence for symbols/files the target calls, references, imports, tests, or risks.",
      inputSchema: graphTargetSchema,
      annotations: sourceContext,
      handler: async (input) => runTool((session) => calleesQuery(session, input, queryOptions), "callees")
    }
  ] satisfies Array<McpToolDefinition<typeof graphTargetSchema>>;
  for (const tool of graphTools) {
    registerMcpTool({ server, outputSchema }, tool);
  }

  const dependencyPathSchema = {
    fromFile: z.string().optional(),
    fromSymbol: z.string().optional(),
    toFile: z.string().optional(),
    toSymbol: z.string().optional(),
    maxDepth: z.number().int().min(1).max(10).optional()
  } satisfies z.ZodRawShape;
  registerMcpTool(
    { server, outputSchema },
    {
      name: "dependency_path",
      title: "Codexa dependency path",
      description: "Find a bounded typed graph path between two files or symbols.",
      inputSchema: dependencyPathSchema,
      annotations: sourceContext,
      handler: async (input) => runTool((session) => dependencyPathQuery(session, input, queryOptions), "dependency_path")
    }
  );

  const workflowPathSchema = {
    query: z.string().optional(),
    file: z.string().optional(),
    symbol: z.string().optional(),
    limit: z.number().int().positive().max(30).optional(),
    ...semanticQuerySchema
  } satisfies z.ZodRawShape;
  registerMcpTool(
    { server, outputSchema },
    {
      name: "workflow_path",
      title: "Codexa workflow path",
      description: "Return route/job/manifest workflow traces related to a natural-language query, file, or symbol.",
      inputSchema: workflowPathSchema,
      annotations: sourceContext,
      handler: async (input) => runTool((session) => workflowPathQuery(session, input, toolQueryOptions(input)), "workflow_path")
    }
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
        taskId: z.string().optional(),
        followCandidate: z.string().min(1).max(160).optional(),
        ...semanticQuerySchema,
        ...lspQuerySchema
      },
      outputSchema,
      annotations: cacheWrite
    },
    async (input) => runTool((session) => changePlanQuery(session, input, toolQueryOptions(input)), { toolName: "change_plan", input })
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
              exitCode: z.number().int().nonnegative().optional(),
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
      annotations: memoryWrite
    },
    async (input) => runTool((session) => postEditReviewQuery(session, { ...input, persistOutcome: false }, queryOptions), { toolName: "post_edit_review", input })
  );
}

function asSessionContextResult(result: QueryResult): QueryResult {
  if (!result.data || typeof result.data !== "object" || Array.isArray(result.data)) {
    return result;
  }
  return {
    ...result,
    text: result.text.replace("Codexa focus brief", "Codexa session context"),
    data: {
      ...(result.data as Record<string, unknown>),
      mode: "session_context"
    }
  };
}
