import type { McpServer, ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import { normalizeObjectSchema, type AnySchema, type ShapeOutput, type ZodRawShapeCompat } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import { toJsonSchemaCompat } from "@modelcontextprotocol/sdk/server/zod-json-schema-compat.js";
import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  callersQuery,
  calleesQuery,
  changePlanQuery,
  changeReviewQuery,
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
import { proveQuery } from "../prove.js";
import {
  MAX_TASK_INVARIANTS,
  MAX_TASK_INVARIANT_REVIEWS,
  MAX_VERIFICATION_ARTIFACT_IDS,
  taskInvariantReviewSchema,
  taskInvariantStatementSchema,
  verificationArtifactIdSchema
} from "../lifecycle-contract.js";
import type { QueryOptions, QueryResult, SessionMemoryInput } from "../types.js";
import type { QuerySession } from "../query/session.js";
import { RAW_SEARCH_EXPLICIT_PATTERN_LIMIT } from "../query/raw-search.js";
import { ADVANCED_MCP_TOOL_NAMES, MCP_TOOL_NAMES, MCP_TOOL_REGISTRY, mcpToolRegistryEntry, type McpToolName, type McpToolRegistryEntry } from "./tool-registry.js";

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

type McpToolContext = string | {
  toolName: string;
  input?: Record<string, unknown>;
  autoRecord?: boolean;
  transportToolName?: string;
  transportInput?: Record<string, unknown>;
};
type ChangeType = "style" | "api" | "behavior" | "rename" | "delete" | "unknown";

const responseFormatSchema = {
  responseFormat: z
    .enum(["auto", "concise", "detailed"])
    .optional()
    .describe("auto (default) safely compacts; concise links the detailed result; detailed returns it inline")
} satisfies z.ZodRawShape;

interface McpToolDefinition<InputSchema extends ZodRawShapeCompat> {
  name: McpToolName;
  inputSchema: InputSchema;
  annotations: ToolAnnotations;
  handler: (input: ShapeOutput<InputSchema>) => Promise<CallToolResult>;
}

interface RegisterMcpToolsOptions {
  server: McpServer;
  queryOptions: QueryOptions;
  outputSchema: ZodRawShapeCompat;
  enabledTools?: ReadonlySet<string>;
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
  runFreshnessTool: (toolContext: Exclude<McpToolContext, string>) => Promise<CallToolResult>;
}

type RegisterToolConfig<OutputArgs extends ZodRawShapeCompat | AnySchema, InputArgs extends undefined | ZodRawShapeCompat | AnySchema = undefined> = {
  title?: string;
  description?: string;
  inputSchema?: InputArgs;
  outputSchema?: OutputArgs;
  annotations?: ToolAnnotations;
  _meta?: Record<string, unknown>;
};

function registerMcpTool<InputSchema extends ZodRawShapeCompat>(
  { server, outputSchema }: Pick<RegisterMcpToolsOptions, "server" | "outputSchema">,
  tool: McpToolDefinition<InputSchema>
): void {
  const metadata = requireMcpToolMetadata(tool.name);
  // Keep the MCP SDK's conditional callback cast inside this adapter helper.
  const handler = (async (input: ShapeOutput<InputSchema>) => tool.handler(input)) as unknown as ToolCallback<InputSchema>;
  server.registerTool(
    tool.name,
    {
      title: metadata.title,
      description: metadata.description,
      inputSchema: tool.inputSchema,
      outputSchema,
      annotations: tool.annotations
    },
    handler
  );
}

function requireMcpToolMetadata(name: string): McpToolRegistryEntry & { name: McpToolName } {
  const metadata = mcpToolRegistryEntry(name);
  if (!metadata) {
    throw new Error(`MCP tool ${name} is not declared in MCP_TOOL_REGISTRY`);
  }
  return metadata as McpToolRegistryEntry & { name: McpToolName };
}

function assertMcpToolRegistrationCoverage(registeredToolNames: string[]): void {
  const registered = new Set(registeredToolNames);
  const expected = new Set<string>(MCP_TOOL_NAMES);
  const missing = [...expected].filter((name) => !registered.has(name));
  const extra = [...registered].filter((name) => !expected.has(name));
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(`MCP tool registry mismatch; missing=${missing.join(",") || "none"} extra=${extra.join(",") || "none"}`);
  }
}

export const MCP_REGISTERED_TOOL_NAMES = MCP_TOOL_NAMES;

export function registerMcpTools(options: RegisterMcpToolsOptions): void {
  const { server, queryOptions, outputSchema, toolQueryOptions, runFreshnessTool } = options;
  const { pureRead, sourceContext, cacheWrite, memoryWrite } = options.annotations;
  type DispatchContext = {
    responseFormat?: "auto" | "concise" | "detailed";
    operationInput?: Record<string, unknown>;
    transportToolName?: string;
    transportInput?: Record<string, unknown>;
  };
  const dispatchContext = new AsyncLocalStorage<DispatchContext>();
  const withDispatchContext = <T>(next: DispatchContext, invoke: () => T): T => dispatchContext.run({ ...(dispatchContext.getStore() ?? {}), ...next }, invoke);
  const runTool: RegisterMcpToolsOptions["runTool"] = (producer, context) => {
    const activeDispatch = dispatchContext.getStore();
    if (!activeDispatch) return options.runTool(producer, context);
    const routedContext =
      typeof context === "string"
        ? {
            toolName: context,
            input: activeDispatch.responseFormat
              ? { ...(activeDispatch.operationInput ?? {}), responseFormat: activeDispatch.responseFormat }
              : activeDispatch.operationInput,
            autoRecord: false,
            transportToolName: activeDispatch.transportToolName,
            transportInput: activeDispatch.transportInput
          }
        : {
            ...context,
            input: activeDispatch.responseFormat ? { ...(context.input ?? {}), responseFormat: activeDispatch.responseFormat } : context.input,
            transportToolName: activeDispatch.transportToolName,
            transportInput: activeDispatch.transportInput
          };
    return options.runTool(producer, routedContext);
  };
  type ExecutableToolDefinition = {
    register: () => void;
    invoke: (input: Record<string, unknown>) => Promise<CallToolResult>;
    inputSchema: ZodRawShapeCompat | AnySchema | undefined;
  };
  const toolDefinitions = new Map<McpToolName, ExecutableToolDefinition>();
  const withToolInvocationContext = <T>(toolName: McpToolName, input: unknown, invoke: () => T): T => {
    const active = dispatchContext.getStore();
    const operationInput = isPlainArgumentObject(input) ? (input as Record<string, unknown>) : undefined;
    const responseFormat = isResponseFormatInput(input) ? input.responseFormat : active?.responseFormat;
    return withDispatchContext(
      {
        responseFormat,
        operationInput,
        transportToolName: active?.transportToolName ?? toolName,
        transportInput: active?.transportInput ?? operationInput
      },
      invoke
    );
  };
  const defineTool = <OutputArgs extends ZodRawShapeCompat | AnySchema, InputArgs extends undefined | ZodRawShapeCompat | AnySchema = undefined>(
    name: McpToolName,
    config: RegisterToolConfig<OutputArgs, InputArgs>,
    handler: ToolCallback<InputArgs>
  ): void => {
    const metadata = requireMcpToolMetadata(name);
    const effectiveInputSchema = metadata.name === "freshness" ? config.inputSchema : withResponseFormatSchema(config.inputSchema);
    const invokeHandler = async (input: unknown, extra?: unknown) => {
      const invoke = () => (handler as unknown as (value: unknown, callbackExtra?: unknown) => Promise<CallToolResult>)(input, extra);
      return withToolInvocationContext(metadata.name, input, invoke);
    };
    toolDefinitions.set(metadata.name, {
      inputSchema: effectiveInputSchema,
      register: () => {
        server.registerTool(
          metadata.name,
          {
            ...config,
            inputSchema: effectiveInputSchema as InputArgs,
            title: metadata.title,
            description: metadata.description
          },
          invokeHandler as unknown as ToolCallback<InputArgs>
        );
      },
      invoke: async (input) => {
        const parsed = parseMcpToolInput(effectiveInputSchema, input);
        return invokeHandler(parsed);
      }
    });
  };
  const defineMcpTool = <InputSchema extends ZodRawShapeCompat>(tool: McpToolDefinition<InputSchema>): void => {
    const metadata = requireMcpToolMetadata(tool.name);
    const inputSchema = withResponseFormatSchema(tool.inputSchema) as InputSchema;
    const execute = async (parsed: ShapeOutput<InputSchema>) => {
      return withToolInvocationContext(metadata.name, parsed, () => tool.handler(parsed));
    };
    const invoke = async (input: Record<string, unknown>) => {
      const parsed = z.object(inputSchema as z.ZodRawShape).parse(input) as ShapeOutput<InputSchema>;
      return execute(parsed);
    };
    toolDefinitions.set(metadata.name, {
      inputSchema,
      register: () => registerMcpTool({ server, outputSchema }, { ...tool, inputSchema, handler: execute }),
      invoke
    });
  };
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
  const ranCommandReportSchema = z.object({
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
  });
  const verificationWaiverSchema = z.object({
    kind: z.enum(["test", "workflow", "dependency"]),
    target: z.string(),
    reason: z.string()
  });
  const verificationEvidenceSchema = {
    ranTests: z.array(z.string()).max(30).optional(),
    ranCommands: z.array(z.string()).max(30).optional(),
    ranCommandReports: z.array(ranCommandReportSchema).max(30).optional(),
    waivedChecks: z.array(z.string()).max(30).optional(),
    waivers: z.array(verificationWaiverSchema).max(30).optional()
  } satisfies z.ZodRawShape;

  defineTool(
    "freshness",
    {
      inputSchema: {},
      outputSchema,
      annotations: pureRead
    },
    async (input) => {
      const activeDispatch = dispatchContext.getStore();
      return runFreshnessTool({
        toolName: "freshness",
        input,
        transportToolName: activeDispatch?.transportToolName ?? "freshness",
        transportInput: activeDispatch?.transportInput ?? input
      });
    }
  );

  defineTool(
    "repo_map",
    {
      inputSchema: { limit: z.number().int().positive().max(50).optional(), tokenBudget: z.number().int().min(400).max(8000).optional() },
      outputSchema,
      annotations: sourceContext
    },
    async (input) => runTool((session) => repoMapQuery(session, input.limit ?? 20, queryOptions, input.tokenBudget ?? 1500), { toolName: "repo_map", input })
  );

  defineTool(
    "find_context",
    {
      inputSchema: { query: z.string().min(1), limit: z.number().int().positive().max(30).optional(), ...semanticQuerySchema },
      outputSchema,
      annotations: memoryWrite
    },
    async (input) => runTool((session) => findContextQuery(session, input.query, input.limit ?? 12, toolQueryOptions(input)), { toolName: "find_context", input })
  );

  defineTool(
    "search",
    {
      inputSchema: {
        query: z.string().min(1),
        patterns: z.array(z.string().min(1)).max(RAW_SEARCH_EXPLICIT_PATTERN_LIMIT).optional(),
        limit: z.number().int().positive().max(50).optional(),
        includeRaw: z.boolean().optional(),
        ...responseFormatSchema,
        ...semanticQuerySchema
      },
      outputSchema,
      annotations: sourceContext
    },
    async (input) =>
      runTool((session) => searchQuery(session, { query: input.query, patterns: input.patterns, limit: input.limit ?? 12, includeRaw: input.includeRaw ?? true }, toolQueryOptions(input)), {
        toolName: "search",
        input,
        autoRecord: false
      })
  );

  defineTool(
    "placeholder_report",
    {
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
    async (input) => runTool((session) => placeholderReportQuery(session, input, queryOptions), { toolName: "placeholder_report", input })
  );

  defineTool(
    "symbol_context",
    {
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
        { toolName: "symbol_context", input }
      )
  );

  defineTool(
    "impact",
    {
      inputSchema: {
        file: z.string().optional(),
        symbol: z.string().optional(),
        changeType: changeTypeSchema.optional(),
        depth: z.number().int().min(1).max(3).optional(),
        ...responseFormatSchema
      },
      outputSchema,
      annotations: memoryWrite
    },
    async (input) => runTool((session) => impactQuery(session, { file: input.file, symbol: input.symbol, changeType: input.changeType, depth: input.depth }, queryOptions), { toolName: "impact", input })
  );

  defineTool(
    "diff_impact",
    {
      inputSchema: { ...responseFormatSchema },
      outputSchema,
      annotations: sourceContext
    },
    async (input) => runTool((session) => diffImpactQuery(session, queryOptions), { toolName: "diff_impact", input, autoRecord: false })
  );

  defineTool(
    "change_review",
    {
      inputSchema: {
        base: z.string().min(1).max(256),
        head: z.string().min(1).max(256).optional(),
        mode: z.enum(["observe", "warn", "fail"]).optional(),
        changeType: changeTypeSchema.optional(),
        taskId: z.string().min(1).max(120).optional(),
        planSnapshot: z.string().min(1).max(500).optional(),
        ranTests: z.array(z.string().min(1).max(2_000)).max(30).optional(),
        ranCommands: z.array(z.string().min(1).max(2_000)).max(30).optional(),
        ranCommandReports: z.array(ranCommandReportSchema).max(30).optional(),
        ...responseFormatSchema
      },
      outputSchema,
      annotations: sourceContext
    },
    async (input) => runTool(
      (session) => changeReviewQuery(session, {
        base: input.base,
        head: input.head,
        mode: input.mode,
        changeType: input.changeType,
        taskId: input.taskId,
        planSnapshot: input.planSnapshot,
        ranTests: input.ranTests,
        ranCommands: input.ranCommands,
        ranCommandReports: input.ranCommandReports
      }, toolQueryOptions(input)),
      { toolName: "change_review", input, autoRecord: false }
    )
  );

  defineTool(
    "test_plan",
    {
      inputSchema: { files: z.array(z.string()).max(20).optional(), diff: z.boolean().optional(), changeType: changeTypeSchema.optional() },
      outputSchema,
      annotations: memoryWrite
    },
    async (input) =>
      runTool(
        (session) =>
          testPlanQuery(session, input.diff ?? true, {
            ...queryOptions,
            files: input.files,
            changeType: input.changeType as ChangeType | undefined
          }),
        { toolName: "test_plan", input }
      )
  );

  defineTool(
    "task_brief",
    {
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
        ...responseFormatSchema,
        ...semanticQuerySchema,
        ...lspQuerySchema
      },
      outputSchema,
      annotations: memoryWrite
    },
    async (input) => runTool((session) => taskBriefQuery(session, input, toolQueryOptions(input)), { toolName: "task_brief", input })
  );

  defineTool(
    "context_pack",
    {
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
        ...responseFormatSchema,
        ...semanticQuerySchema,
        ...lspQuerySchema
      },
      outputSchema,
      annotations: memoryWrite
    },
    async (input) => runTool((session) => contextPackQuery(session, input, toolQueryOptions(input)), { toolName: "context_pack", input })
  );

  defineTool(
    "focus_brief",
    {
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

  defineTool(
    "session_context",
    {
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

  defineTool(
    "session_memory",
    {
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
      inputSchema: graphTargetSchema,
      annotations: sourceContext,
      handler: async (input) => runTool((session) => callersQuery(session, input, queryOptions), { toolName: "callers", input })
    },
    {
      name: "callees",
      inputSchema: graphTargetSchema,
      annotations: sourceContext,
      handler: async (input) => runTool((session) => calleesQuery(session, input, queryOptions), { toolName: "callees", input })
    }
  ] satisfies Array<McpToolDefinition<typeof graphTargetSchema>>;
  for (const tool of graphTools) {
    defineMcpTool(tool);
  }

  const dependencyPathSchema = {
    fromFile: z.string().optional(),
    fromSymbol: z.string().optional(),
    toFile: z.string().optional(),
    toSymbol: z.string().optional(),
    maxDepth: z.number().int().min(1).max(10).optional()
  } satisfies z.ZodRawShape;
  defineMcpTool(
    {
      name: "dependency_path",
      inputSchema: dependencyPathSchema,
      annotations: sourceContext,
      handler: async (input) => runTool((session) => dependencyPathQuery(session, input, queryOptions), { toolName: "dependency_path", input })
    }
  );

  const workflowPathSchema = {
    query: z.string().optional(),
    file: z.string().optional(),
    symbol: z.string().optional(),
    limit: z.number().int().positive().max(30).optional(),
    ...semanticQuerySchema
  } satisfies z.ZodRawShape;
  defineMcpTool(
    {
      name: "workflow_path",
      inputSchema: workflowPathSchema,
      annotations: sourceContext,
      handler: async (input) => runTool((session) => workflowPathQuery(session, input, toolQueryOptions(input)), { toolName: "workflow_path", input })
    }
  );

  defineTool(
    "change_plan",
    {
      inputSchema: {
        task: z.string().optional(),
        // Planning surfaces accept more files than the context tools: a
        // 20-file cap forced legitimately large changes to under-declare
        // scope, guaranteeing false unplanned-edit drift at review time.
        files: z.array(z.string()).max(64).optional(),
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
        invariants: z.array(taskInvariantStatementSchema).max(MAX_TASK_INVARIANTS).optional(),
        ...responseFormatSchema,
        ...semanticQuerySchema,
        ...lspQuerySchema
      },
      outputSchema,
      annotations: cacheWrite
    },
    async (input) => runTool((session) => changePlanQuery(session, input, toolQueryOptions(input)), { toolName: "change_plan", input })
  );

  defineTool(
    "post_edit_review",
    {
      inputSchema: {
        task: z.string().optional(),
        taskId: z.string().optional(),
        files: z.array(z.string()).max(64).optional(),
        symbols: z.array(z.string()).max(20).optional(),
        changeType: changeTypeSchema.optional(),
        tokenBudget: z.number().int().min(600).max(10000).optional(),
        limit: z.number().int().positive().max(30).optional(),
        includeSnippets: z.boolean().optional(),
        invariantReviews: z.array(taskInvariantReviewSchema).max(MAX_TASK_INVARIANT_REVIEWS).optional(),
        artifactIds: z.array(verificationArtifactIdSchema).max(MAX_VERIFICATION_ARTIFACT_IDS).optional(),
        ...verificationEvidenceSchema,
        ...responseFormatSchema,
        ...semanticQuerySchema
      },
      outputSchema,
      annotations: cacheWrite
    },
    async (input) => runTool((session) => postEditReviewQuery(session, { ...input, persistOutcome: true }, toolQueryOptions(input)), { toolName: "post_edit_review", input })
  );

  defineTool(
    "proof_card",
    {
      inputSchema: {
        task: z.string().optional(),
        taskId: z.string().optional(),
        files: z.array(z.string()).max(20).optional(),
        diff: z.boolean().optional(),
        changeType: changeTypeSchema.optional(),
        tokenBudget: z.number().int().min(600).max(8000).optional(),
        artifactIds: z.array(verificationArtifactIdSchema).max(MAX_VERIFICATION_ARTIFACT_IDS).optional(),
        ...verificationEvidenceSchema,
        ...responseFormatSchema,
        ...semanticQuerySchema
      },
      outputSchema,
      annotations: memoryWrite
    },
    async (input) =>
      runTool(
        (session) =>
          proveQuery(session.repoRoot, {
            ...toolQueryOptions(input),
            task: input.task,
            taskId: input.taskId,
            files: input.files,
            diff: input.diff ?? true,
            changeType: input.changeType as ChangeType | undefined,
            tokenBudget: input.tokenBudget,
            ranTests: input.ranTests,
            ranCommands: input.ranCommands,
            ranCommandReports: input.ranCommandReports,
            waivedChecks: input.waivedChecks,
            waivers: input.waivers,
            artifactIds: input.artifactIds
          }),
        { toolName: "proof_card", input }
      )
  );

  // Keep this shallow: the selected operation's exact schema is the one and
  // only recursive validator. An independent generic cap would reject inputs
  // that are legal for large session-memory or verification operations.
  const capabilityArgumentsSchema = z.unknown().refine(isPlainArgumentObject, "capability arguments must be a plain object");

  defineTool(
    "capabilities",
    {
      inputSchema: {
        action: z.enum(["list", "describe", "invoke"]).optional(),
        operation: z.enum(ADVANCED_MCP_TOOL_NAMES as unknown as [string, ...string[]]).optional(),
        arguments: capabilityArgumentsSchema.optional(),
        ...responseFormatSchema
      },
      outputSchema,
      annotations: cacheWrite
    },
    async (input) => {
      const action = input.action ?? (input.operation ? (input.arguments === undefined ? "describe" : "invoke") : "list");
      if (action === "invoke") {
        if (!input.operation) throw new Error("capabilities action=invoke requires operation");
        const definition = toolDefinitions.get(input.operation as McpToolName);
        if (!definition || !ADVANCED_MCP_TOOL_NAMES.includes(input.operation as (typeof ADVANCED_MCP_TOOL_NAMES)[number])) {
          throw new Error(`Unknown advanced Codexa capability: ${input.operation}`);
        }
        const operationArguments = input.arguments as Record<string, unknown> | undefined;
        const argumentFormat = isResponseFormatInput(operationArguments) ? operationArguments.responseFormat : undefined;
        if (input.responseFormat && argumentFormat && input.responseFormat !== argumentFormat) {
          throw new Error(`Conflicting responseFormat values for capability ${input.operation}; provide it once or use matching values`);
        }
        const invoke = () => definition.invoke(operationArguments ?? {});
        return withDispatchContext(
          {
            responseFormat: input.responseFormat ?? argumentFormat,
            transportToolName: "capabilities",
            transportInput: input as Record<string, unknown>
          },
          invoke
        );
      }
      if (action === "describe" && !input.operation) throw new Error("capabilities action=describe requires operation");
      if (action === "list" && input.operation) throw new Error("capabilities action=list does not accept operation");
      const operations = MCP_TOOL_REGISTRY.filter((entry) => entry.tier === "advanced").map(({ name, title, phase, cost, readOnly, writeEffects, useWhen, avoidWhen }) => {
        const schema = canonicalCapabilitySchema(toolDefinitions.get(name as McpToolName)?.inputSchema);
        return {
          name,
          title,
          phase,
          cost,
          readOnly,
          writeEffects,
          useWhen,
          avoidWhen,
          requiredInputs: schema.required ?? [],
          inputNames: Object.keys(schema.properties),
          schemaHash: capabilitySchemaHash(schema)
        };
      });
      const capabilityHash = createHash("sha256").update(JSON.stringify(operations)).digest("hex");
      const described = input.operation
        ? (() => {
            const definition = toolDefinitions.get(input.operation as McpToolName);
            if (!definition) throw new Error(`Unknown advanced Codexa capability: ${input.operation}`);
            const schema = canonicalCapabilitySchema(definition.inputSchema);
            return {
              operation: input.operation,
              schema,
              schemaHash: capabilitySchemaHash(schema)
            };
          })()
        : undefined;
      return runTool(
        async (session) => ({
          freshness: session.freshness,
          refresh: session.refresh,
          text: described
            ? [`Codexa capability: ${described.operation}`, `Schema hash: ${described.schemaHash}`, `Required: ${described.schema.required?.join(", ") || "none"}`, `Inputs: ${Object.keys(described.schema.properties).join(", ") || "none"}`].join("\n")
            : [`Codexa advanced capabilities (${operations.length})`, `Capability hash: ${capabilityHash}`, ...operations.map((entry) => `- ${entry.name} [${entry.cost}/${entry.phase}]; required ${entry.requiredInputs.join(",") || "none"}: ${entry.useWhen}`)].join("\n"),
          data: {
            mode: "capabilities",
            actionability: "orientation",
            capabilityHash,
            operationCount: operations.length,
            ...(described ? { described } : { operations })
          }
        }),
        { toolName: "capabilities", input }
      );
    }
  );
  assertMcpToolRegistrationCoverage([...toolDefinitions.keys()]);
  for (const toolName of MCP_TOOL_NAMES) {
    const definition = toolDefinitions.get(toolName);
    if (!definition) {
      throw new Error(`MCP tool ${toolName} is missing an executable definition`);
    }
    // The coverage assertion above still proves every catalog tool has an
    // executable definition; the profile filter only limits registration.
    if (options.enabledTools && !options.enabledTools.has(toolName)) {
      continue;
    }
    definition.register();
  }
}

function withResponseFormatSchema(schema: ZodRawShapeCompat | AnySchema | undefined): ZodRawShapeCompat | AnySchema {
  if (schema && typeof schema === "object" && "parse" in schema && typeof (schema as { parse?: unknown }).parse === "function") {
    return schema;
  }
  return { ...((schema ?? {}) as ZodRawShapeCompat), ...responseFormatSchema };
}

function parseMcpToolInput(schema: ZodRawShapeCompat | AnySchema | undefined, input: Record<string, unknown>): unknown {
  if (schema && typeof schema === "object" && "parse" in schema && typeof (schema as { parse?: unknown }).parse === "function") {
    return (schema as unknown as z.ZodTypeAny).parse(input);
  }
  return z.object((schema ?? {}) as z.ZodRawShape).parse(input);
}

type CanonicalCapabilitySchema = Record<string, unknown> & {
  type: "object";
  required?: string[];
  properties: Record<string, Record<string, unknown>>;
};

function canonicalCapabilitySchema(schema: ZodRawShapeCompat | AnySchema | undefined): CanonicalCapabilitySchema {
  const normalized = normalizeObjectSchema(schema);
  const raw = normalized
    ? toJsonSchemaCompat(normalized, { strictUnions: true, pipeStrategy: "input" })
    : { type: "object", properties: {}, $schema: "http://json-schema.org/draft-07/schema#" };
  const canonical = JSON.parse(canonicalJson(raw)) as Record<string, unknown>;
  const properties = canonical.properties && typeof canonical.properties === "object" && !Array.isArray(canonical.properties)
    ? (canonical.properties as Record<string, Record<string, unknown>>)
    : {};
  if (canonical.type !== "object") throw new Error("Capability input schema must be an object schema");
  return Object.assign(canonical, { type: "object" as const, properties }) as CanonicalCapabilitySchema;
}

function capabilitySchemaHash(schema: CanonicalCapabilitySchema): string {
  return createHash("sha256").update(canonicalJson(schema)).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
  }
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error("Capability schema contains a non-JSON value");
  return serialized;
}

function isResponseFormatInput(value: unknown): value is { responseFormat: "auto" | "concise" | "detailed" } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const responseFormat = (value as Record<string, unknown>).responseFormat;
  return responseFormat === "auto" || responseFormat === "concise" || responseFormat === "detailed";
}

function isPlainArgumentObject(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
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
