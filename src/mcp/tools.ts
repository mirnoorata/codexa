import type { McpServer, ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AnySchema, ShapeOutput, ZodRawShapeCompat } from "@modelcontextprotocol/sdk/server/zod-compat.js";
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
import { MCP_TOOL_NAMES, mcpToolRegistryEntry, type McpToolName, type McpToolRegistryEntry } from "./tool-registry.js";

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

const responseFormatSchema = {
  responseFormat: z
    .enum(["concise", "detailed"])
    .optional()
    .describe("concise compacts the packet to the summary tier under a small byte budget; detailed (default) returns the full packet")
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
  runFreshnessTool: () => Promise<CallToolResult>;
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
  const { server, queryOptions, outputSchema, toolQueryOptions, runTool, runFreshnessTool } = options;
  const { pureRead, sourceContext, cacheWrite, memoryWrite } = options.annotations;
  const toolDefinitions = new Map<McpToolName, () => void>();
  const defineTool = <OutputArgs extends ZodRawShapeCompat | AnySchema, InputArgs extends undefined | ZodRawShapeCompat | AnySchema = undefined>(
    name: McpToolName,
    config: RegisterToolConfig<OutputArgs, InputArgs>,
    handler: ToolCallback<InputArgs>
  ): void => {
    const metadata = requireMcpToolMetadata(name);
    toolDefinitions.set(metadata.name, () => {
      server.registerTool(
        metadata.name,
        {
          ...config,
          title: metadata.title,
          description: metadata.description
        },
        handler
      );
    });
  };
  const defineMcpTool = <InputSchema extends ZodRawShapeCompat>(tool: McpToolDefinition<InputSchema>): void => {
    const metadata = requireMcpToolMetadata(tool.name);
    toolDefinitions.set(metadata.name, () => registerMcpTool({ server, outputSchema }, tool));
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

  defineTool(
    "freshness",
    {
      inputSchema: {},
      outputSchema,
      annotations: pureRead
    },
    async () => runFreshnessTool()
  );

  defineTool(
    "repo_map",
    {
      inputSchema: { limit: z.number().int().positive().max(50).optional(), tokenBudget: z.number().int().min(400).max(8000).optional() },
      outputSchema,
      annotations: sourceContext
    },
    async ({ limit, tokenBudget }) => runTool((session) => repoMapQuery(session, limit ?? 20, queryOptions, tokenBudget ?? 1500), "repo_map")
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
    async (input) => runTool((session) => placeholderReportQuery(session, input, queryOptions), "placeholder_report")
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
        "symbol_context"
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
    "test_plan",
    {
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
      handler: async (input) => runTool((session) => callersQuery(session, input, queryOptions), "callers")
    },
    {
      name: "callees",
      inputSchema: graphTargetSchema,
      annotations: sourceContext,
      handler: async (input) => runTool((session) => calleesQuery(session, input, queryOptions), "callees")
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
  defineMcpTool(
    {
      name: "workflow_path",
      inputSchema: workflowPathSchema,
      annotations: sourceContext,
      handler: async (input) => runTool((session) => workflowPathQuery(session, input, toolQueryOptions(input)), "workflow_path")
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
          .optional(),
        ...responseFormatSchema,
        ...semanticQuerySchema
      },
      outputSchema,
      annotations: memoryWrite
    },
    async (input) => runTool((session) => postEditReviewQuery(session, { ...input, persistOutcome: false }, toolQueryOptions(input)), { toolName: "post_edit_review", input })
  );
  assertMcpToolRegistrationCoverage([...toolDefinitions.keys()]);
  for (const toolName of MCP_TOOL_NAMES) {
    const register = toolDefinitions.get(toolName);
    if (!register) {
      throw new Error(`MCP tool ${toolName} is missing an executable definition`);
    }
    // The coverage assertion above still proves every catalog tool has an
    // executable definition; the profile filter only limits registration.
    if (options.enabledTools && !options.enabledTools.has(toolName)) {
      continue;
    }
    register();
  }
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
