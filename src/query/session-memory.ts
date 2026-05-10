import { fitLinesToTokenBudget, clampInt } from "./formatting.js";
import { freshnessBanner } from "./runtime.js";
import { ensureQuerySession, type QuerySessionInput } from "./session.js";
import {
  compactSessionMemory,
  readSessionMemory,
  recordSessionMemory,
  summarizeSessionMemory,
  type SessionMemoryResult
} from "../session-memory.js";
import type { QueryOptions, QueryResult, SessionMemoryInput } from "../types.js";

export async function sessionMemoryQuery(input: QuerySessionInput, memoryInput: SessionMemoryInput = {}, options: QueryOptions = {}): Promise<QueryResult> {
  const session = await ensureQuerySession(input, options);
  const action = memoryInput.action ?? "summary";
  const tokenBudget = clampInt(memoryInput.tokenBudget ?? 1800, 500, 8000);
  const limit = clampInt(memoryInput.limit ?? 20, 1, session.maxResults);
  const base = {
    repoRoot: session.repoRoot,
    sessionId: memoryInput.sessionId,
    taskId: memoryInput.taskId,
    kinds: memoryInput.kinds,
    refs: memoryInput.refs,
    files: memoryInput.files,
    symbols: memoryInput.symbols,
    topics: memoryInput.topics,
    limit,
    includeStale: memoryInput.includeStale,
    freshness: session.freshness
  };
  if (action === "remember" && (!memoryInput.entries || memoryInput.entries.length === 0)) {
    throw new Error("session_memory remember requires at least one entry");
  }
  const result =
    action === "remember"
      ? await recordSessionMemory({
          repoRoot: session.repoRoot,
          sessionId: memoryInput.sessionId,
          taskId: memoryInput.taskId,
          task: memoryInput.task,
          freshness: session.freshness,
          entries: entriesWithTopLevelScope(memoryInput)
        })
      : action === "read"
        ? await readSessionMemory(base)
        : action === "compact"
          ? await compactSessionMemory(base)
          : await summarizeSessionMemory(base);

  return {
    freshness: session.freshness,
    refresh: session.refresh,
    text: fitLinesToTokenBudget(formatSessionMemoryText(action, result).split(/\r?\n/u), tokenBudget),
    data: {
      mode: "session_memory",
      action,
      sessionId: result.sessionId,
      taskId: result.taskId,
      revision: result.revision,
      memory: result.memory,
      writes: result.writes,
      warnings: result.warnings
    }
  };
}

function formatSessionMemoryText(action: NonNullable<SessionMemoryInput["action"]>, result: SessionMemoryResult): string {
  const lines = [
    `Codexa session memory (${action})`,
    `Session: ${result.sessionId}`,
    result.taskId ? `Task: ${result.taskId}` : undefined,
    `Revision: ${result.revision}`,
    result.writes ? `Writes: ${result.writes.recordedEntryIds.length} recorded; compacted ${result.writes.compacted ? "yes" : "no"}; ${result.writes.path}` : undefined,
    result.warnings.length > 0 ? `Warnings: ${result.warnings.join("; ")}` : undefined,
    "",
    result.memory.markdown ?? compactMemoryLines(result).join("\n")
  ];
  return lines.filter((line): line is string => line !== undefined).join("\n");
}

function compactMemoryLines(result: SessionMemoryResult): string[] {
  if (result.memory.entries.length === 0) {
    return ["No session memory entries matched."];
  }
  return result.memory.entries.map((entry) => `- ${entry.kind}: ${entry.summary} (${entry.provenance}; ${entry.evidenceTier}/${entry.confidence}; ${entry.status}; ${entry.id})`);
}

function entriesWithTopLevelScope(memoryInput: SessionMemoryInput): NonNullable<SessionMemoryInput["entries"]> {
  const entries = memoryInput.entries ?? [];
  const hasTopLevelScope = Boolean(memoryInput.refs?.length || memoryInput.files?.length || memoryInput.symbols?.length || memoryInput.topics?.length);
  if (!hasTopLevelScope) {
    return entries;
  }
  return entries.map((entry) => ({
    ...entry,
    scope: {
      ...entry.scope,
      refs: uniqueById([...(entry.scope?.refs ?? []), ...(memoryInput.refs ?? [])], refKey),
      files: uniqueStrings([...(entry.scope?.files ?? []), ...(memoryInput.files ?? [])]),
      symbols: uniqueStrings([...(entry.scope?.symbols ?? []), ...(memoryInput.symbols ?? [])]),
      topics: uniqueStrings([...(entry.scope?.topics ?? []), ...(memoryInput.topics ?? [])])
    }
  }));
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function uniqueById<T>(values: T[], key: (value: T) => string): T[] {
  const byKey = new Map<string, T>();
  for (const value of values) {
    byKey.set(key(value), value);
  }
  return [...byKey.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([, value]) => value);
}

function refKey(ref: NonNullable<SessionMemoryInput["refs"]>[number]): string {
  return [ref.kind, ref.id, ref.path ?? "", ref.edgeKind ?? "", ref.fromId ?? "", ref.toId ?? ""].join(":");
}
