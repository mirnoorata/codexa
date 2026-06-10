import type { QuerySession } from "../query/session.js";
import { recordViewedMemoryForTool } from "../session-memory.js";
import type { QueryResult } from "../types.js";

export async function withAutoRecordedSessionMemory(session: QuerySession, result: QueryResult, toolName: string, input: Record<string, unknown> | undefined): Promise<QueryResult> {
  try {
    const writes = await recordViewedMemoryForTool({
      repoRoot: session.repoRoot,
      taskId: typeof input?.taskId === "string" ? input.taskId : undefined,
      task: typeof input?.task === "string" ? input.task : undefined,
      toolName,
      result,
      index: session.index
    });
    if (!writes) {
      return result;
    }
    return {
      ...result,
      data: addSessionMemoryWrite(result.data, writes)
    };
  } catch (error) {
    const warning = `session memory auto-record failed for ${toolName}: ${error instanceof Error ? error.message : String(error)}`;
    return {
      ...result,
      data: addSessionMemoryWarning(result.data, warning)
    };
  }
}

function addSessionMemoryWrite(data: unknown, writes: unknown): unknown {
  if (!isRecord(data)) {
    return data;
  }
  const existing = isRecord(data.sessionMemory) ? data.sessionMemory : {};
  return {
    ...data,
    sessionMemory: {
      ...existing,
      autoRecorded: true,
      writes
    }
  };
}

function addSessionMemoryWarning(data: unknown, warning: string): unknown {
  if (!isRecord(data)) {
    return data;
  }
  const warnings = Array.isArray(data.warnings) ? data.warnings.filter((entry): entry is string => typeof entry === "string") : [];
  const existing = isRecord(data.sessionMemory) ? data.sessionMemory : {};
  return {
    ...data,
    warnings: [...warnings, warning],
    sessionMemory: {
      ...existing,
      autoRecorded: false,
      warning
    }
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
