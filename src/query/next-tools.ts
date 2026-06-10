import type { GuidedNextToolV1 } from "../types.js";

export function nextTool(
  tool: string,
  reason: string,
  requiredInputs: Record<string, unknown> = {},
  readOnly = true,
  writes: string[] = []
): GuidedNextToolV1 {
  return {
    schemaVersion: 1,
    tool,
    reason,
    requiredInputs,
    readOnly,
    writes
  };
}

export function nextToolNames(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((entry) => {
    if (typeof entry === "string") {
      return [entry];
    }
    if (entry && typeof entry === "object" && typeof (entry as Record<string, unknown>).tool === "string") {
      return [(entry as Record<string, string>).tool];
    }
    return [];
  });
}
