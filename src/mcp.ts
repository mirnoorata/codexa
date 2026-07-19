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
import { canonicalMcpDetailedProjection, compactMcpResult } from "./mcp/compaction.js";
import { mcpAutoEscalationReason, renderMcpConciseText, withMcpDelivery, type McpResponseFormat } from "./mcp/decision-kernel.js";
import { createMcpOutputSchema, safeQuery, toToolResult, type McpToolPolicyOptions } from "./mcp/envelope.js";
import { registerWorkflowPrompts } from "./mcp/prompts.js";
import { registerArtifactResources, type McpDetailedResultReadEvent } from "./mcp/resources.js";
import { createMcpRuntime, notifyResourceListChangedAfterRefresh, withRoutingRuntime, withSessionRuntime } from "./mcp/runtime.js";
import { withAutoRecordedSessionMemory } from "./mcp/session-memory.js";
import { registerMcpTools, type McpOptionalQueryInput } from "./mcp/tools.js";
import { createMcpResultArtifactRouter, persistMcpResultArtifact, rememberProtectedMcpResultId, type McpResultArtifactBinding } from "./mcp/result-artifacts.js";
import {
  appendMcpOverheadTelemetryAtPath,
  finalizeMcpOverheadTelemetryAtPath,
  mcpTelemetryPath,
  mcpToolResultEffectiveFormat,
  mcpToolResultEscalationReason,
  mcpToolResultByteCounts,
  type McpOverheadTelemetryEvent
} from "./mcp/telemetry.js";
import { CORE_PROFILE_TOOL_NAMES, NO_SOURCE_MUTATION_CONTRACT, PRIMARY_CODEX_LOOP } from "./mcp-tool-catalog.js";
import { CODEXA_VERSION } from "./version.js";
export { compactMcpResult, compactNonPostEditMcpResult, compactPostEditMcpResult } from "./mcp/compaction.js";
export { DISPATCHABLE_MCP_TOOL_NAMES, MCP_TOOL_CATALOG, PRIMARY_CODEX_LOOP, PRIMARY_MCP_TOOL_NAMES } from "./mcp-tool-catalog.js";

export type McpTransportKind = "stdio" | "http";

export interface ServeMcpHttpOptions {
  host?: string;
  port: number;
  endpoint?: string;
}

interface McpDeliverySessionState {
  resultArtifactRouter: ReturnType<typeof createMcpResultArtifactRouter>;
  emittedResultIds: Set<string>;
  telemetry: { sequence: number; destinationPath?: string };
}

const MCP_SERVER_INSTRUCTIONS = [
  `Codexa is a selective codebase context and edit-safety server. Routing: ${PRIMARY_CODEX_LOOP}.`,
  "Known file/symbol/error or exact local task -> use source tools with zero Codexa calls. Ambiguous target -> make one search call; if raw evidence is sufficient, stop Codexa. Do not stack session_context, search, and task_brief for one task.",
  "Use change_plan only for non-trivial multi-file, API, runtime, persistence, security, or otherwise high-risk edits. Use post_edit_review once only when no deterministic host hook/completion gate already owns review. Most tasks need no more than two Codexa calls; the narrow three-call safety exception is an ambiguous materially risky edit on a hookless host: search, change_plan, then post_edit_review.",
  "Use test_plan only when verification guidance remains unresolved; use proof_card only for policy checks or a formal handoff; use session memory only to recover real context loss.",
  "Each tool description states its typical output cost (compact/medium/large); prefer the cheapest sufficient tool. Tools refresh stale Codexa artifacts automatically when auto-refresh is enabled.",
  `Trust rules: ${NO_SOURCE_MUTATION_CONTRACT} Semantic retrieval is used only when configured; verify heuristic-heavy packets against source before editing.`,
  "responseFormat defaults to auto: every automatic packet stays concise and links a content-addressed detailed result when persistence succeeds. If detail is unavailable, the self-contained decision kernel blocks whenever omitted evidence is required. Only an explicit responseFormat=detailed returns bounded detail inline.",
  "The core profile exposes search, change_plan, and a compact capabilities dispatcher. Use capabilities only for a concretely triggered non-core operation without paying every schema on every turn."
].join("\n");

export async function serveMcp(repoRoot: string, options: QueryOptions = { autoRefresh: true }): Promise<void> {
  const deliveryState = createMcpDeliverySessionState(repoRoot);
  const { configuredRepoRoot, queryOptions, server } = await createCodexaMcpServer(repoRoot, options, deliveryState);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // McpServer.connect installs its own transport close handler. Compose with
  // that handler after connection so telemetry finalization is not overwritten.
  const closeServer = transport.onclose;
  let telemetryFinalization: Promise<void> | undefined;
  const finalizeTelemetry = () => telemetryFinalization ??= finalizeMcpOverheadTelemetryAtPath(deliveryState.telemetry.destinationPath);
  let artifactFinalization: Promise<void> | undefined;
  const finalizeArtifacts = () => artifactFinalization ??= deliveryState.resultArtifactRouter.close();
  transport.onclose = () => {
    closeServer?.();
    void finalizeArtifacts().catch((error) => {
      console.error(`Codexa MCP result-lease finalization failed: ${error instanceof Error ? error.message : String(error)}`);
    });
    void finalizeTelemetry().catch((error) => {
      console.error(`Codexa MCP telemetry finalization failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  };
  console.error(`codexa MCP server ready for ${configuredRepoRoot} (transport=stdio, autoRefresh=${queryOptions.autoRefresh})`);
  await new Promise<void>((resolve) => {
    let closing = false;
    const shutdown = () => {
      if (closing) return;
      closing = true;
      process.stdin.off("end", shutdown);
      process.stdin.off("close", shutdown);
      process.off("SIGINT", shutdown);
      process.off("SIGTERM", shutdown);
      void server.close()
        .catch((error) => {
          console.error(`Codexa MCP stdio shutdown failed: ${error instanceof Error ? error.message : String(error)}`);
        })
        .then(finalizeArtifacts)
        .then(finalizeTelemetry)
        .catch((error) => {
          console.error(`Codexa MCP telemetry finalization failed: ${error instanceof Error ? error.message : String(error)}`);
        })
        .finally(resolve);
    };
    process.stdin.once("end", shutdown);
    process.stdin.once("close", shutdown);
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
    if (process.stdin.readableEnded) queueMicrotask(shutdown);
  });
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
  // Streamable HTTP is intentionally stateless at the protocol layer, so the
  // SDK server is request-scoped. Delivery references, duplicate receipts,
  // and telemetry ordering still belong to the listener lifetime: otherwise a
  // URI emitted by one request cannot be read by the next request.
  const deliveryState = createMcpDeliverySessionState(configuredRepoRoot);
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
      const { server } = await createCodexaMcpServer(configuredRepoRoot, queryOptions, deliveryState);
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
      httpServer.close(() => {
        void deliveryState.resultArtifactRouter.close().then(() => finalizeMcpOverheadTelemetryAtPath(deliveryState.telemetry.destinationPath)).then(resolve, (error) => {
          console.error(`Codexa MCP telemetry finalization failed: ${error instanceof Error ? error.message : String(error)}`);
          resolve();
        });
      });
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });
}

async function createCodexaMcpServer(
  repoRoot: string,
  options: QueryOptions,
  deliveryState?: McpDeliverySessionState
): Promise<{ configuredRepoRoot: string; queryOptions: QueryOptions; server: McpServer }> {
  const configuredRepoRoot = path.resolve(repoRoot);
  deliveryState ??= createMcpDeliverySessionState(configuredRepoRoot);
  const queryOptions: QueryOptions = { ...options, autoRefresh: options.autoRefresh ?? true };
  const sessionMemoryMode = queryOptions.sessionMemory ?? "auto";
  const autoRecordSessionMemory = sessionMemoryMode !== "off";
  const annotationRepoRoot = await resolveMcpRepoRoot(configuredRepoRoot, {
    workspaceFocusFile: queryOptions.workspaceFocusFile,
    workspaceSessionId: queryOptions.workspaceSessionId,
    preferConfiguredRoot: await shouldPreferConfiguredRepoRoot(configuredRepoRoot, queryOptions)
  })
    .then((resolution) => resolution.repoRoot)
    .catch(() => configuredRepoRoot);
  const mcpRuntime = createMcpRuntime({ configuredRepoRoot, queryOptions });
  const { resultArtifactRouter, emittedResultIds } = deliveryState;
  const telemetryProfile = queryOptions.toolProfile === "core" ? "core" as const : "full" as const;
  const emitTelemetry = (event: Omit<McpOverheadTelemetryEvent, "schemaVersion" | "sequence" | "profile">): void => {
    if (!deliveryState.telemetry.destinationPath) return;
    try {
      deliveryState.telemetry.sequence += 1;
      appendMcpOverheadTelemetryAtPath(deliveryState.telemetry.destinationPath, {
        schemaVersion: 1,
        sequence: deliveryState.telemetry.sequence,
        profile: telemetryProfile,
        ...event
      });
    } catch (error) {
      // Telemetry is opt-in evidence only. Serialization/configuration errors
      // must never alter the MCP response path.
      console.error(`Codexa MCP telemetry event dropped: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const server = new McpServer(
    {
      name: "codexa",
      version: CODEXA_VERSION
    },
    {
      instructions: MCP_SERVER_INSTRUCTIONS
    }
  );
  const notifyActiveRepoRootChanged = async () => {
    if (mcpRuntime.consumeActiveRepoRootChanged()) {
      await Promise.resolve(server.sendResourceListChanged());
    }
  };
  const outputSchema = createMcpOutputSchema();
  const sourceContextAnnotations = {
    // Auto/concise delivery writes only a bounded detailed-result cache. The
    // hint is conservative because the requested response format is not known
    // when tools/list is emitted.
    readOnlyHint: false,
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
  const enabledTools = queryOptions.toolProfile === "core" ? new Set<string>(CORE_PROFILE_TOOL_NAMES) : undefined;
  const policyOptions: McpToolPolicyOptions = { autoRefresh: queryOptions.autoRefresh ?? true, sessionMemoryMode, enabledTools };
  const runTool = async (
    producer: (session: QuerySession) => Promise<QueryResult>,
    toolContext: string | {
      toolName: string;
      input?: Record<string, unknown>;
      autoRecord?: boolean;
      transportToolName?: string;
      transportInput?: Record<string, unknown>;
    }
  ) => {
    const startedAt = deliveryState.telemetry.destinationPath ? performance.now() : 0;
    const toolName = typeof toolContext === "string" ? toolContext : toolContext.toolName;
    const toolInput = typeof toolContext === "string" ? undefined : toolContext.input;
    const transportToolName = typeof toolContext === "string" ? toolName : toolContext.transportToolName ?? toolName;
    const transportInput = typeof toolContext === "string" ? toolInput : toolContext.transportInput ?? toolInput;
    const requestedFormat: McpResponseFormat = toolInput?.responseFormat === "concise" || toolInput?.responseFormat === "detailed" ? toolInput.responseFormat : "auto";
    const telemetryRequestedFormat = requestedMcpResponseFormat(transportInput, requestedFormat);
    const autoRecord = typeof toolContext === "string" || toolContext.autoRecord === false ? undefined : toolContext;
    let activeRepoRoot = configuredRepoRoot;
    try {
      const activeResolution = await mcpRuntime.resolveActiveRepoRootResolution();
      await notifyActiveRepoRootChanged();
      activeRepoRoot = activeResolution.repoRoot;
    let rawResult: QueryResult;
    try {
      rawResult = await safeQuery(async () => {
          const session = await mcpRuntime.createQuerySession(activeRepoRoot);
          const runtimeResult = withSessionRuntime(await producer(session), session, activeResolution);
          const memoryResult = autoRecord && autoRecordSessionMemory ? await withAutoRecordedSessionMemory(session, runtimeResult, autoRecord.toolName, autoRecord.input) : runtimeResult;
          await notifyResourceListChangedAfterRefresh(server, session);
          return memoryResult;
        }, activeRepoRoot);
    } catch (error) {
      const authorityBlock = await lifecycleIdentityBlockResult(toolName, activeRepoRoot, toolInput, error);
      if (!authorityBlock) throw error;
      rawResult = withRoutingRuntime(authorityBlock, activeResolution);
    }
    const modeResult = withMcpQueryMode(rawResult, toolName);
    const semanticEscalation = requestedFormat === "auto" ? mcpAutoEscalationReason(modeResult, toolInput) : undefined;
    const needsResultReference = requestedFormat !== "detailed";
    const artifactDetailedResult = !needsResultReference
      ? undefined
      : canonicalMcpDetailedProjection(modeResult);
    let resultReference: Awaited<ReturnType<typeof persistMcpResultArtifact>> | undefined;
    let artifactFailure: string | undefined;
    if (needsResultReference) {
      try {
        resultReference = await persistMcpResultArtifact(activeRepoRoot, artifactDetailedResult!, mcpResultBinding(toolName, activeRepoRoot, artifactDetailedResult!), resultArtifactRouter, emittedResultIds);
      } catch (error) {
        artifactFailure = error instanceof Error ? error.message : String(error);
      }
    }
    const escalationReason = artifactFailure
      ? [semanticEscalation, "detailed-result-resource-unavailable"].filter(Boolean).join("+")
      : semanticEscalation;
    const effectiveFormat: "concise" | "detailed" = requestedFormat === "detailed" ? "detailed" : "concise";
    const unchangedReceipt = effectiveFormat === "concise" && requestedFormat === "auto" && Boolean(resultReference && emittedResultIds.has(resultReference.id));
    const delivery = {
      schemaVersion: 1 as const,
      requestedFormat,
      effectiveFormat,
      resultId: resultReference?.id,
      resultUri: resultReference?.uri,
      detailAvailable: requestedFormat === "detailed" || Boolean(resultReference),
      detailRequired: Boolean(semanticEscalation),
      requiredDetailReason: semanticEscalation,
      unchangedReceipt: unchangedReceipt || undefined,
      escalationReason
    };
    let deliveredResult: QueryResult;
    if (effectiveFormat === "detailed") {
      // Build the host-bounded detailed packet only when it will actually be
      // returned. Normal auto/concise calls therefore do artifact+concise
      // compaction, never an unused third serialization pass.
      deliveredResult = withMcpDelivery(canonicalMcpDetailedProjection(modeResult), delivery);
    } else {
      const conciseResult = withMcpDelivery(compactMcpResult(modeResult, { format: "concise" }), delivery);
      deliveredResult = unchangedReceipt ? unchangedMcpReceipt(conciseResult) : conciseResult;
      deliveredResult = { ...deliveredResult, text: renderMcpConciseText(deliveredResult) };
    }
    if (resultReference) {
      rememberProtectedMcpResultId(emittedResultIds, resultReference.id);
    }
    const toolResult = toToolResult(
      deliveredResult,
      toolName,
      { ...policyOptions, input: toolInput }
    );
    if (deliveryState.telemetry.destinationPath) {
      try {
        const elapsedMs = Math.max(0, Math.round((performance.now() - startedAt) * 1000) / 1000);
        const byteCounts = mcpToolResultByteCounts(toolResult);
        const deliveredFormat = mcpToolResultEffectiveFormat(toolResult, effectiveFormat);
        const deliveredEscalationReason = mcpToolResultEscalationReason(toolResult, escalationReason);
        emitTelemetry({
          eventKind: "tool",
          tool: transportToolName,
          logicalOperation: toolName,
          outcome: "ok",
          requestedFormat: telemetryRequestedFormat,
          effectiveFormat: deliveredFormat,
          escalationReason: deliveredEscalationReason,
          requestBytes: telemetryRequestBytes(transportInput),
          ...byteCounts,
          elapsedMs,
          resultReference: resultReference?.uri,
          unchangedReceipt
        });
      } catch (error) {
        console.error(`Codexa MCP telemetry event dropped: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return toolResult;
    } catch (error) {
      if (deliveryState.telemetry.destinationPath) {
        emitTelemetry({
          eventKind: "tool",
          tool: transportToolName,
          logicalOperation: toolName,
          outcome: "error",
          requestedFormat: telemetryRequestedFormat,
          effectiveFormat: telemetryRequestedFormat === "detailed" ? "detailed" : "concise",
          requestBytes: telemetryRequestBytes(transportInput),
          textBytes: 0,
          structuredBytes: 0,
          totalBytes: 0,
          elapsedMs: startedAt > 0 ? Math.max(0, Math.round((performance.now() - startedAt) * 1000) / 1000) : 0,
          unchangedReceipt: false
        });
      }
      throw error;
    }
  };

  registerMcpTools({
    server,
    queryOptions,
    outputSchema,
    enabledTools,
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
    runFreshnessTool: async (toolContext) => {
      const startedAt = deliveryState.telemetry.destinationPath ? performance.now() : 0;
      const transportToolName = toolContext.transportToolName ?? toolContext.toolName;
      const transportInput = toolContext.transportInput ?? toolContext.input;
      const requestedFormat = requestedMcpResponseFormat(transportInput, "auto");
      let activeRepoRoot = configuredRepoRoot;
      try {
        const activeResolution = await mcpRuntime.resolveActiveRepoRootResolution();
        activeRepoRoot = activeResolution.repoRoot;
        await notifyActiveRepoRootChanged();
        const result = toToolResult(
          await safeQuery(async () => withRoutingRuntime(await statusQuery(activeRepoRoot, { recover: false }), activeResolution), activeRepoRoot),
          "freshness",
          { ...policyOptions, input: toolContext.input }
        );
        if (deliveryState.telemetry.destinationPath) {
          try {
            const deliveredFormat = mcpToolResultEffectiveFormat(result, "detailed");
            const deliveredEscalationReason = mcpToolResultEscalationReason(result);
            emitTelemetry({
              eventKind: "tool",
              tool: transportToolName,
              logicalOperation: "freshness",
              outcome: "ok",
              requestedFormat,
              effectiveFormat: deliveredFormat,
              escalationReason: deliveredEscalationReason,
              requestBytes: telemetryRequestBytes(transportInput),
              ...mcpToolResultByteCounts(result),
              elapsedMs: Math.max(0, Math.round((performance.now() - startedAt) * 1000) / 1000),
              unchangedReceipt: false
            });
          } catch (error) {
            console.error(`Codexa MCP telemetry event dropped: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
        return result;
      } catch (error) {
        if (deliveryState.telemetry.destinationPath) {
          emitTelemetry({
            eventKind: "tool",
            tool: transportToolName,
            logicalOperation: "freshness",
            outcome: "error",
            requestedFormat,
            effectiveFormat: "detailed",
            requestBytes: telemetryRequestBytes(transportInput),
            textBytes: 0,
            structuredBytes: 0,
            totalBytes: 0,
            elapsedMs: startedAt > 0 ? Math.max(0, Math.round((performance.now() - startedAt) * 1000) / 1000) : 0,
            unchangedReceipt: false
          });
        }
        throw error;
      }
    }
  });

  const resolveResourceRepoRoot = async () => {
    const activeRepoRoot = await mcpRuntime.resolveActiveRepoRoot();
    await notifyActiveRepoRootChanged();
    return activeRepoRoot;
  };
  await registerArtifactResources(server, resolveResourceRepoRoot, async () => {
    const activeRepoRoot = await resolveResourceRepoRoot();
    const session = await mcpRuntime.createQuerySession(activeRepoRoot);
    if (session.freshness.stale) {
      throw new Error(
        `Codexa generated artifacts unavailable: index stale (${session.freshness.reason}) for ${activeRepoRoot}. ` +
          `Enable auto-refresh or run: codexa index ${activeRepoRoot}`
      );
    }
    await notifyResourceListChangedAfterRefresh(server, session);
    return activeRepoRoot;
  }, resultArtifactRouter, deliveryState.telemetry.destinationPath
    ? (event) => emitDetailedResourceTelemetry(event, emitTelemetry)
    : undefined);
  registerWorkflowPrompts(server, enabledTools);

  return { configuredRepoRoot, queryOptions, server };
}

function createMcpDeliverySessionState(configuredRepoRoot: string): McpDeliverySessionState {
  return {
    resultArtifactRouter: createMcpResultArtifactRouter(),
    emittedResultIds: new Set<string>(),
    telemetry: { sequence: 0, destinationPath: mcpTelemetryPath(path.resolve(configuredRepoRoot)) }
  };
}

function mcpResultBinding(tool: string, activeRepoRoot: string, result: QueryResult): McpResultArtifactBinding {
  const data = isRecord(result.data) ? result.data : {};
  const runtime = isRecord(data.runtime) ? data.runtime : {};
  const freshness: Record<string, unknown> = isRecord(result.freshness) ? result.freshness : {};
  return {
    tool,
    checkout: {
      repoRoot: typeof runtime.repoRoot === "string" ? runtime.repoRoot : activeRepoRoot,
      gitHead: typeof runtime.gitHead === "string" || runtime.gitHead === null ? runtime.gitHead : undefined,
      routingSource: typeof runtime.routingSource === "string" ? runtime.routingSource : undefined,
      workspaceSessionId: typeof runtime.workspaceSessionId === "string" ? runtime.workspaceSessionId : undefined
    },
    freshness: {
      snapshotId: typeof freshness.snapshotId === "string" ? freshness.snapshotId : undefined,
      headCommit: typeof freshness.headCommit === "string" || freshness.headCommit === null ? freshness.headCommit : undefined,
      indexedAt: typeof freshness.indexedAt === "string" ? freshness.indexedAt : undefined,
      missing: typeof freshness.missing === "boolean" ? freshness.missing : undefined,
      stale: typeof freshness.stale === "boolean" ? freshness.stale : undefined,
      reason: typeof freshness.reason === "string" ? freshness.reason : undefined
    }
  };
}

function withMcpQueryMode(result: QueryResult, toolName: string): QueryResult {
  if (!isRecord(result.data) || typeof result.data.mode === "string") return result;
  return { ...result, data: { mode: toolName, ...result.data } };
}

function unchangedMcpReceipt(result: QueryResult): QueryResult {
  if (!isRecord(result.data)) return result;
  const kernel = isRecord(result.data.decisionKernel) ? result.data.decisionKernel : undefined;
  const authority = kernel && isRecord(kernel.authority) ? kernel.authority : {};
  return {
    ...result,
    data: {
      mode: result.data.mode,
      actionability: authority.actionability ?? result.data.actionability ?? "blocked",
      verdict: authority.verdict,
      packetVerdict: authority.packetVerdict,
      completionAuthority: authority.completionAuthority,
      inspectMode: authority.inspectMode,
      decisionKernel: kernel,
      delivery: result.data.delivery,
      mcp: result.data.mcp
    }
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function requestedMcpResponseFormat(input: Record<string, unknown> | undefined, fallback: McpResponseFormat): McpResponseFormat {
  const direct = input?.responseFormat;
  if (direct === "auto" || direct === "concise" || direct === "detailed") return direct;
  const nested = isRecord(input?.arguments) ? input.arguments.responseFormat : undefined;
  return nested === "auto" || nested === "concise" || nested === "detailed" ? nested : fallback;
}

function telemetryRequestBytes(input: Record<string, unknown> | undefined): number {
  try {
    return Buffer.byteLength(JSON.stringify(input ?? {}), "utf8");
  } catch {
    return 0;
  }
}

function emitDetailedResourceTelemetry(
  event: McpDetailedResultReadEvent,
  emit: (telemetry: Omit<McpOverheadTelemetryEvent, "schemaVersion" | "sequence" | "profile">) => void
): void {
  const textBytes = typeof event.text === "string" ? Buffer.byteLength(event.text, "utf8") : 0;
  const totalBytes = event.response ? Buffer.byteLength(JSON.stringify(event.response), "utf8") : 0;
  emit({
    eventKind: "resource-read",
    tool: "read_mcp_resource",
    logicalOperation: "mcp-detailed-result",
    outcome: event.outcome,
    requestedFormat: "detailed",
    effectiveFormat: "detailed",
    requestBytes: telemetryRequestBytes({ server: "codexa", uri: event.uri }),
    textBytes,
    structuredBytes: 0,
    totalBytes,
    elapsedMs: event.elapsedMs,
    resultReference: event.uri,
    unchangedReceipt: false
  });
}

async function lifecycleIdentityBlockResult(
  toolName: string,
  repoRoot: string,
  input: Record<string, unknown> | undefined,
  error: unknown
): Promise<QueryResult | undefined> {
  const code = error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code) : "";
  if (code !== "CODEXA_INDEX_IDENTITY_MISMATCH" || (toolName !== "change_plan" && toolName !== "post_edit_review")) return undefined;
  const status = await statusQuery(repoRoot, { recover: false });
  const reason = error instanceof Error ? error.message : String(error);
  const taskId = typeof input?.taskId === "string" ? input.taskId : undefined;
  const task = typeof input?.task === "string" ? input.task : undefined;
  const common = {
    freshness: status.freshness,
    refresh: { refreshed: false },
    text: `${toolName === "change_plan" ? "Codexa change plan" : "Codexa post-edit review"} blocked.\n${reason}\nNo authoritative lifecycle state was persisted.`,
  };
  if (toolName === "change_plan") {
    return {
      ...common,
      data: {
        mode: "change_plan",
        actionability: "blocked",
        task,
        taskId,
        editReadiness: { editable: false, status: "orientation-only", reason, source: "insufficient-context", recommendedNextTool: "freshness", missingAnchors: ["fresh-index"], snapshotBlocked: input?.saveSnapshot === true },
        files: [],
        plannedEditTargets: [],
        tests: [],
        invariants: [],
        requiredWorkflowChecks: [],
        requiredDependencyChecks: [],
        snapshotBlock: { taskId, status: "not-saved", reason },
        nextTools: [],
        systemMessage: `Run codexa index ${repoRoot}, then retry change_plan.`,
        gaps: [reason]
      }
    };
  }
  return {
    ...common,
    data: {
      mode: "post_edit_review",
      actionability: "blocked",
      task: task ?? "Post-edit review",
      taskId,
      verdict: "inspect",
      inspectMode: "blocking",
      inspectReasons: [reason],
      completionAuthority: "blocking_inspect",
      files: [],
      reviewTargets: [],
      changedSinceSnapshot: [],
      unplannedEditedFiles: [],
      testsNotRun: [],
      verificationLedger: [],
      riskEscalationsNeedInspection: true,
      loopReview: { status: "not-evaluated", reasons: ["freshness authority blocked before lifecycle evaluation"] },
      failureSignals: [],
      outcome: { persisted: false },
      nextTools: [],
      systemMessage: `Run codexa index ${repoRoot}, then retry post_edit_review.`,
      gaps: [reason]
    }
  };
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
