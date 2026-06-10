import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getFreshness } from "../indexer.js";
import { resolveMcpRepoRoot, type McpRepoRootResolution } from "../mcp-repo-root.js";
import { requireIndex } from "../query/runtime.js";
import { createQuerySessionFromIndexState, type QuerySession, type QuerySessionIndexState } from "../query/session.js";
import type { QueryOptions, QueryResult } from "../types.js";

export interface McpRuntime {
  resolveActiveRepoRoot(): Promise<string>;
  createQuerySession(activeRepoRoot: string): Promise<QuerySession>;
}

export interface CreateMcpRuntimeOptions {
  configuredRepoRoot: string;
  queryOptions: QueryOptions;
  preferConfiguredRoot: boolean;
}

export function createMcpRuntime({ configuredRepoRoot, queryOptions, preferConfiguredRoot }: CreateMcpRuntimeOptions): McpRuntime {
  let cachedIndexState: QuerySessionIndexState | undefined;
  let cachedIndexStateRepoRoot: string | undefined;
  let indexStateInflight: { repoRoot: string; promise: Promise<QuerySessionIndexState> } | undefined;
  let activeResolution: McpRepoRootResolution | undefined;

  const resolveActiveRepoRoot = async (): Promise<string> => {
    const resolution = await resolveMcpRepoRoot(configuredRepoRoot, {
      workspaceFocusFile: queryOptions.workspaceFocusFile,
      workspaceSessionId: queryOptions.workspaceSessionId,
      preferConfiguredRoot
    });
    if (activeResolution?.repoRoot !== resolution.repoRoot) {
      cachedIndexState = undefined;
      cachedIndexStateRepoRoot = undefined;
      indexStateInflight = undefined;
    }
    if (!sameResolution(activeResolution, resolution)) {
      activeResolution = resolution;
      if (resolution.source !== "configured-root") {
        const via = resolution.focusFile ? `${resolution.source}:${resolution.focusFile}` : resolution.source;
        console.error(`codexa MCP resolved ${resolution.configuredRoot} to focused repo ${resolution.repoRoot} via ${via}`);
      }
    }
    return resolution.repoRoot;
  };

  const loadIndexState = async (activeRepoRoot: string): Promise<QuerySessionIndexState> => {
    if (indexStateInflight?.repoRoot === activeRepoRoot) {
      return indexStateInflight.promise;
    }
    const pending = (async () => {
      if (cachedIndexState && cachedIndexStateRepoRoot === activeRepoRoot) {
        const freshness = await getFreshness(activeRepoRoot, cachedIndexState.index, { recover: false });
        if (!freshness.stale || !queryOptions.autoRefresh) {
          cachedIndexState = { ...cachedIndexState, freshness, refresh: { refreshed: false } };
          return cachedIndexState;
        }
      }
      const loaded = await requireIndex(activeRepoRoot, queryOptions);
      cachedIndexState = loaded;
      cachedIndexStateRepoRoot = activeRepoRoot;
      return loaded;
    })();
    indexStateInflight = { repoRoot: activeRepoRoot, promise: pending };
    void pending
      .finally(() => {
        if (indexStateInflight?.promise === pending) {
          indexStateInflight = undefined;
        }
      })
      .catch(() => undefined);
    return pending;
  };

  return {
    resolveActiveRepoRoot,
    async createQuerySession(activeRepoRoot: string): Promise<QuerySession> {
      const state = await loadIndexState(activeRepoRoot);
      return createQuerySessionFromIndexState(activeRepoRoot, state, queryOptions);
    }
  };
}

export async function notifyResourceListChangedAfterRefresh(server: McpServer, session: QuerySession): Promise<void> {
  if (!session.refresh?.refreshed) {
    return;
  }
  await Promise.resolve(server.sendResourceListChanged());
}

export function withSessionRuntime(result: QueryResult, session: QuerySession): QueryResult {
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

function sameResolution(previous: McpRepoRootResolution | undefined, next: McpRepoRootResolution): boolean {
  return (
    previous !== undefined &&
    previous.repoRoot === next.repoRoot &&
    previous.source === next.source &&
    previous.focusFile === next.focusFile &&
    previous.focusReason === next.focusReason &&
    previous.workspaceSessionId === next.workspaceSessionId
  );
}

function addRuntimeData(data: unknown, runtime: Record<string, unknown>): unknown {
  if (data && typeof data === "object" && !Array.isArray(data)) {
    return { ...(data as Record<string, unknown>), runtime };
  }
  return { value: data, runtime };
}
