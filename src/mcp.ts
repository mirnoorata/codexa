import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import path from "node:path";
import { z } from "zod";
import { statusQuery } from "./queries.js";
import type { QueryOptions, QueryResult } from "./types.js";
import type { QuerySession } from "./query/session.js";
import { semanticMayUseOpenWorldProvider } from "./semantic-retrieval.js";
import { resolveMcpRepoRoot, shouldPreferConfiguredRepoRoot } from "./mcp-repo-root.js";
import { compactMcpResult } from "./mcp/compaction.js";
import { createMcpOutputSchema, safeQuery, toToolResult, type McpToolPolicyOptions } from "./mcp/envelope.js";
import { registerWorkflowPrompts } from "./mcp/prompts.js";
import { registerArtifactResources } from "./mcp/resources.js";
import { createMcpRuntime, notifyResourceListChangedAfterRefresh, withSessionRuntime } from "./mcp/runtime.js";
import { withAutoRecordedSessionMemory } from "./mcp/session-memory.js";
import { registerMcpTools, type McpOptionalQueryInput } from "./mcp/tools.js";
export { compactMcpResult, compactNonPostEditMcpResult, compactPostEditMcpResult } from "./mcp/compaction.js";
export { MCP_TOOL_CATALOG, PRIMARY_CODEX_LOOP, PRIMARY_MCP_TOOL_NAMES } from "./mcp-tool-catalog.js";

export async function serveMcp(repoRoot: string, options: QueryOptions = { autoRefresh: true }): Promise<void> {
  const configuredRepoRoot = path.resolve(repoRoot);
  const queryOptions: QueryOptions = { ...options, autoRefresh: options.autoRefresh ?? true };
  const sessionMemoryMode = queryOptions.sessionMemory ?? "auto";
  const autoRecordSessionMemory = sessionMemoryMode !== "off";
  const preferConfiguredRoot = await shouldPreferConfiguredRepoRoot(configuredRepoRoot, queryOptions);
  const annotationRepoRoot = await resolveMcpRepoRoot(configuredRepoRoot, {
    workspaceFocusFile: queryOptions.workspaceFocusFile,
    workspaceSessionId: queryOptions.workspaceSessionId,
    preferConfiguredRoot
  })
    .then((resolution) => resolution.repoRoot)
    .catch(() => configuredRepoRoot);
  const mcpRuntime = createMcpRuntime({ configuredRepoRoot, queryOptions, preferConfiguredRoot });
  const server = new McpServer({
    name: "codexa",
    version: "0.1.0"
  });
  const outputSchema = createMcpOutputSchema();
  const sourceContextAnnotations = {
    readOnlyHint: !queryOptions.autoRefresh,
    destructiveHint: false,
    idempotentHint: !queryOptions.autoRefresh,
    openWorldHint: semanticMayUseOpenWorldProvider(annotationRepoRoot, queryOptions)
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
    openWorldHint: semanticMayUseOpenWorldProvider(annotationRepoRoot, queryOptions)
  };
  const memoryWriteAnnotations = autoRecordSessionMemory
    ? {
        ...sourceContextAnnotations,
        readOnlyHint: false,
        idempotentHint: false
      }
    : sourceContextAnnotations;
  const changeTypeSchema = z.enum(["style", "api", "behavior", "rename", "delete", "unknown"]);
  const semanticQuerySchema: Record<string, z.ZodTypeAny> = semanticEnabledForServer(queryOptions)
    ? {
        semantic: z.boolean().optional(),
        semanticProvider: z.enum(["openai", "local-command"]).optional(),
        semanticModel: z.string().min(1).max(120).optional(),
        semanticDimensions: z.number().int().positive().max(8192).optional(),
        semanticTimeoutMs: z.number().int().positive().max(120_000).optional(),
        semanticBatchSize: z.number().int().positive().max(256).optional()
      }
    : {};
  const lspQuerySchema: Record<string, z.ZodTypeAny> = {
    lsp: z.boolean().optional(),
    lspTimeoutMs: z.number().int().positive().max(60_000).optional(),
    lspMaxFiles: z.number().int().positive().max(12).optional()
  };
  const confidenceSchema = z.enum(["authoritative", "derived", "heuristic"]);
  const evidenceTierSchema = z.enum(["authoritative", "derived", "heuristic", "fallback"]);
  const sessionMemoryKindSchema = z.enum(["viewed", "claim", "ruled_out", "open_question", "next_read", "decision", "verification", "risk", "constraint"]);
  const sessionMemoryProvenanceSchema = z.enum(["codexa-derived", "agent-asserted", "user-asserted"]);
  const sessionMemoryStatusSchema = z.enum(["active", "stale", "superseded", "rejected", "resolved"]);
  const sessionMemoryRefSchema = z.object({
    kind: z.enum(["file", "symbol", "workflow", "endpoint", "test", "graph_edge", "outcome", "snapshot"]),
    id: z.string().min(1).max(240),
    path: z.string().max(500).optional(),
    edgeKind: z
      .enum([
        "DEFINES",
        "IMPORTS",
        "CALLS",
        "REFERENCES",
        "TESTS",
        "ROUTE",
        "JOB",
        "RISK",
        "ROUTE_HANDLES",
        "ROUTE_CALLS_STORE",
        "STORE_DISPATCHES_ADAPTER",
        "ADAPTER_REFERENCED_BY_MANIFEST",
        "UI_CALLS_ENDPOINT",
        "TEST_COVERS_WORKFLOW",
        "IMPLEMENTS",
        "EXTENDS",
        "EXPORTS",
        "TYPE_EXPORTS"
      ])
      .optional(),
    fromId: z.string().max(240).optional(),
    toId: z.string().max(240).optional(),
    evidenceTier: evidenceTierSchema,
    confidence: confidenceSchema
  });
  const sessionMemoryEvidenceSchema = z.object({
    id: z.string().min(1).max(240),
    provenance: sessionMemoryProvenanceSchema,
    source: z.enum(["agent", "mcp_tool", "task_snapshot", "post_edit_outcome", "hook_event", "index_fact", "codexa_cache"]),
    sourceRef: z.string().min(1).max(500),
    toolName: z.string().max(120).optional(),
    callId: z.string().max(120).optional(),
    taskId: z.string().max(120).optional(),
    path: z.string().max(500).optional(),
    range: z
      .object({
        startLine: z.number().int().nonnegative(),
        endLine: z.number().int().nonnegative(),
        startByte: z.number().int().nonnegative(),
        endByte: z.number().int().nonnegative()
      })
      .optional(),
    factType: z.string().max(120).optional(),
    edgeKind: z.string().max(120).optional(),
    evidenceTier: evidenceTierSchema,
    confidence: confidenceSchema,
    snapshotId: z.string().min(1).max(160),
    indexedAt: z.string().min(1).max(80),
    headCommit: z.string().max(80).nullable(),
    note: z.string().max(500).optional()
  });
  const sessionMemoryScopeSchema = z.object({
    files: z.array(z.string().max(500)).max(80).optional(),
    symbols: z.array(z.string().max(240)).max(80).optional(),
    tests: z.array(z.string().max(500)).max(80).optional(),
    workflows: z.array(z.string().max(240)).max(80).optional(),
    topics: z.array(z.string().max(280)).max(40).optional(),
    refs: z.array(sessionMemoryRefSchema).max(80).optional()
  });
  const toolQueryOptions = (input: McpOptionalQueryInput = {}): QueryOptions => ({
    ...queryOptions,
    semantic: input.semantic ?? queryOptions.semantic,
    semanticProvider: input.semanticProvider ?? queryOptions.semanticProvider,
    semanticModel: input.semanticModel ?? queryOptions.semanticModel,
    semanticDimensions: input.semanticDimensions ?? queryOptions.semanticDimensions,
    semanticTimeoutMs: input.semanticTimeoutMs ?? queryOptions.semanticTimeoutMs,
    semanticBatchSize: input.semanticBatchSize ?? queryOptions.semanticBatchSize,
    lsp: input.lsp ?? queryOptions.lsp,
    lspTimeoutMs: input.lspTimeoutMs ?? queryOptions.lspTimeoutMs,
    lspMaxFiles: input.lspMaxFiles ?? queryOptions.lspMaxFiles
  });
  const policyOptions: McpToolPolicyOptions = { autoRefresh: queryOptions.autoRefresh ?? true, sessionMemoryMode };
  const runTool = async (
    producer: (session: QuerySession) => Promise<QueryResult>,
    toolContext: string | { toolName: string; input?: Record<string, unknown>; autoRecord?: boolean }
  ) => {
    const toolName = typeof toolContext === "string" ? toolContext : toolContext.toolName;
    const toolInput = typeof toolContext === "string" ? undefined : toolContext.input;
    const autoRecord = typeof toolContext === "string" || toolContext.autoRecord === false ? undefined : toolContext;
    const activeRepoRoot = await mcpRuntime.resolveActiveRepoRoot();
    return toToolResult(
      await safeQuery(async () => {
        const session = await mcpRuntime.createQuerySession(activeRepoRoot);
        const rawResult = withSessionRuntime(await producer(session), session);
        const memoryResult = autoRecord && autoRecordSessionMemory ? await withAutoRecordedSessionMemory(session, rawResult, autoRecord.toolName, autoRecord.input) : rawResult;
        const result = compactMcpResult(memoryResult);
        await notifyResourceListChangedAfterRefresh(server, session);
        return result;
      }, activeRepoRoot),
      toolName,
      { ...policyOptions, input: toolInput }
    );
  };

  registerMcpTools({
    server,
    queryOptions,
    outputSchema,
    annotations: {
      pureRead: pureReadAnnotations,
      sourceContext: sourceContextAnnotations,
      cacheWrite: cacheWriteAnnotations,
      memoryWrite: memoryWriteAnnotations
    },
    schemas: {
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
    },
    toolQueryOptions,
    runTool,
    runFreshnessTool: async () => {
      const activeRepoRoot = await mcpRuntime.resolveActiveRepoRoot();
      return toToolResult(await safeQuery(() => statusQuery(activeRepoRoot, { recover: false }), activeRepoRoot), "freshness", policyOptions);
    }
  });

  await registerArtifactResources(server, mcpRuntime.resolveActiveRepoRoot);
  registerWorkflowPrompts(server);

  await server.connect(new StdioServerTransport());
  console.error(`codexa MCP server ready for ${configuredRepoRoot} (autoRefresh=${queryOptions.autoRefresh})`);
}


function semanticEnabledForServer(options: QueryOptions): boolean {
  return options.semantic === true || process.env.CODEXA_SEMANTIC === "1";
}
