/** Content-free provider accounting. Absent token usage is unknown, not zero. */
export interface TypeSafeTelemetry {
  status: "disabled" | "skipped" | "ok" | "fallback";
  reason?: string;
  model?: string;
  requestAttempted: boolean;
  cacheHit: boolean;
  orderChanged: boolean;
  candidates?: number;
  latencyMs?: number;
  inputTokens?: number;
  outputTokens?: number;
}

export function typeSafeTelemetryFromResult(data: unknown): TypeSafeTelemetry | undefined {
  if (!record(data)) return undefined;
  const summary = data.typesafe ?? (record(data.retrieval) ? data.retrieval.typesafe : undefined);
  if (!record(summary) || !["disabled", "skipped", "ok", "fallback"].includes(String(summary.status)) || typeof summary.requestAttempted !== "boolean") return undefined;
  const count = (key: string, max: number) => Number.isSafeInteger(summary[key]) && Number(summary[key]) >= 0 && Number(summary[key]) <= max ? Number(summary[key]) : undefined;
  const label = (key: string) => typeof summary[key] === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,99}$/u.test(summary[key] as string) ? summary[key] as string : undefined;
  return {
    status: summary.status as TypeSafeTelemetry["status"],
    reason: label("reason"), model: label("model"),
    requestAttempted: summary.requestAttempted,
    cacheHit: summary.cacheHit === true,
    orderChanged: summary.orderChanged === true,
    candidates: count("candidates", 20),
    latencyMs: typeof summary.latencyMs === "number" && Number.isFinite(summary.latencyMs) && summary.latencyMs >= 0 && summary.latencyMs <= 3_600_000 ? summary.latencyMs : undefined,
    inputTokens: summary.requestAttempted ? count("inputTokens", 1_000_000_000) : 0,
    outputTokens: summary.requestAttempted ? count("outputTokens", 1_000_000_000) : 0
  };
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
