import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import http from "node:http";
import type { AddressInfo } from "node:net";
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
import { NO_SOURCE_MUTATION_CONTRACT, PRIMARY_CODEX_LOOP } from "./mcp-tool-catalog.js";
import { CODEXA_VERSION } from "./version.js";
export { compactMcpResult, compactNonPostEditMcpResult, compactPostEditMcpResult } from "./mcp/compaction.js";
export { MCP_TOOL_CATALOG, PRIMARY_CODEX_LOOP, PRIMARY_MCP_TOOL_NAMES } from "./mcp-tool-catalog.js";

export type McpTransportKind = "stdio" | "http";

export interface ServeMcpHttpOptions {
  host?: string;
  port: number;
  endpoint?: string;
}

const MCP_SERVER_INSTRUCTIONS = [
  `Codexa is a Codex-native codebase context and edit-safety server. Loop: ${PRIMARY_CODEX_LOOP}.`,
  "Target unclear -> search first. Before edits -> change_plan(saveSnapshot=true). After edits -> post_edit_review with the commands that actually ran. Before final response -> test_plan.",
  "Each tool description states its typical output cost (compact/medium/large); prefer the cheapest sufficient tool. Tools refresh stale Codexa artifacts automatically when auto-refresh is enabled.",
  `Trust rules: ${NO_SOURCE_MUTATION_CONTRACT} Semantic retrieval is used only when configured; verify heuristic-heavy packets against source before editing.`,
  "Structured results are budget-compacted with truncation records naming dropped fields. Hosts with small MCP result limits can set CODEXA_MCP_STRUCTURED_BUDGET_BYTES."
].join("\n");

export async function serveMcp(repoRoot: string, options: QueryOptions = { autoRefresh: true }): Promise<void> {
  const { configuredRepoRoot, queryOptions, server } = await createCodexaMcpServer(repoRoot, options);
  await server.connect(new StdioServerTransport());
  console.error(`codexa MCP server ready for ${configuredRepoRoot} (transport=stdio, autoRefresh=${queryOptions.autoRefresh})`);
}

export async function serveMcpHttp(repoRoot: string, options: QueryOptions = { autoRefresh: true }, httpOptions: ServeMcpHttpOptions): Promise<void> {
  const configuredRepoRoot = path.resolve(repoRoot);
  const queryOptions: QueryOptions = { ...options, autoRefresh: options.autoRefresh ?? true };
  const host = httpOptions.host ?? "127.0.0.1";
  if (!isLoopbackHttpHost(host)) {
    throw new Error(`Codexa HTTP MCP transport requires a loopback host unless authentication/origin protection is added; received ${host}`);
  }
  const port = httpOptions.port;
  const endpoint = normalizeMcpEndpoint(httpOptions.endpoint ?? "/mcp");
  const httpServer = http.createServer(async (req, res) => {
    try {
      if (!isAllowedHttpOrigin(req.headers.origin)) {
        sendJsonRpcHttpError(res, 403, "MCP HTTP Origin is not allowed");
        return;
      }
      if (!isAllowedHttpHost(req.headers.host)) {
        sendJsonRpcHttpError(res, 403, "MCP HTTP Host is not allowed");
        return;
      }
      const requestUrl = new URL(req.url ?? "/", `http://${req.headers.host ?? `${host}:${port}`}`);
      if (requestUrl.pathname !== endpoint) {
        sendJsonRpcHttpError(res, 404, "MCP endpoint not found");
        return;
      }
      const { server } = await createCodexaMcpServer(configuredRepoRoot, queryOptions);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (error) {
      console.error(`codexa MCP HTTP request failed: ${error instanceof Error ? error.message : String(error)}`);
      if (!res.headersSent) {
        sendJsonRpcHttpError(res, 500, "MCP request failed");
      } else {
        res.end();
      }
    }
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    httpServer.once("error", onError);
    httpServer.listen(port, host, () => {
      httpServer.off("error", onError);
      resolve();
    });
  });
  const address = httpServer.address() as AddressInfo | string | null;
  const actualPort = typeof address === "object" && address ? address.port : port;
  console.error(`codexa MCP HTTP server ready for ${configuredRepoRoot} at http://${host}:${actualPort}${endpoint} (transport=http, autoRefresh=${queryOptions.autoRefresh})`);

  await new Promise<void>((resolve) => {
    let closing = false;
    const shutdown = () => {
      if (closing) {
        return;
      }
      closing = true;
      process.off("SIGINT", shutdown);
      process.off("SIGTERM", shutdown);
      httpServer.close(() => resolve());
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });
}

async function createCodexaMcpServer(repoRoot: string, options: QueryOptions): Promise<{ configuredRepoRoot: string; queryOptions: QueryOptions; server: McpServer }> {
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
  const server = new McpServer(
    {
      name: "codexa",
      version: CODEXA_VERSION
    },
    {
      instructions: MCP_SERVER_INSTRUCTIONS
    }
  );
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
        const responseFormat = toolInput?.responseFormat === "concise" ? ("concise" as const) : undefined;
        const result = compactMcpResult(memoryResult, responseFormat ? { format: responseFormat } : undefined);
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

  return { configuredRepoRoot, queryOptions, server };
}

function normalizeMcpEndpoint(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed === "/") {
    return "/mcp";
  }
  return trimmed.startsWith("/") ? trimmed.replace(/\/+$/u, "") || "/mcp" : `/${trimmed.replace(/\/+$/u, "")}`;
}

function isLoopbackHttpHost(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/^\[/u, "").replace(/\]$/u, "");
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1" || normalized === "0:0:0:0:0:0:0:1";
}

// Validate the Host header against the loopback allowlist. The SDK's
// streamable-HTTP transport has no DNS-rebinding protection of its own, so a
// rebound request (DNS flips evil.test -> 127.0.0.1, browser then posts with
// Host: evil.test) would otherwise reach the endpoint. Absent Host is rejected:
// HTTP/1.1 clients always send one. Origin handling is unchanged so non-browser
// loopback clients that omit Origin still work.
function isAllowedHttpHost(hostHeader: string | string[] | undefined): boolean {
  if (typeof hostHeader !== "string" || hostHeader.length === 0) {
    return false;
  }
  try {
    return isLoopbackHttpHost(new URL(`http://${hostHeader}`).hostname);
  } catch {
    return false;
  }
}

function isAllowedHttpOrigin(origin: string | string[] | undefined): boolean {
  if (!origin) {
    return true;
  }
  if (Array.isArray(origin)) {
    return false;
  }
  try {
    const parsed = new URL(origin);
    return (parsed.protocol === "http:" || parsed.protocol === "https:") && isLoopbackHttpHost(parsed.hostname);
  } catch {
    return false;
  }
}

function sendJsonRpcHttpError(res: http.ServerResponse, statusCode: number, message: string): void {
  res.writeHead(statusCode, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify({
      jsonrpc: "2.0",
      error: {
        code: -32000,
        message
      },
      id: null
    })
  );
}

function semanticEnabledForServer(options: QueryOptions): boolean {
  return options.semantic === true || process.env.CODEXA_SEMANTIC === "1";
}
