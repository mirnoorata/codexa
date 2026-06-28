import path from "node:path";
import { parseAutonomyMode } from "../autonomy.js";
import type { LiveIndexEvent } from "../live-index.js";
import type { McpTransportKind } from "../mcp.js";
import { resolveMcpRepoRoot, shouldPreferConfiguredRepoRoot, type McpRepoRootResolutionOptions } from "../mcp-repo-root.js";
import { semanticProviderFromValue, type SemanticProviderKind } from "../semantic-retrieval.js";
import type { ChangeType, QueryOptions, SessionMemoryInput, VerificationCommandReport, VerificationWaiver } from "../types.js";

export function printQuery(result: { text: string }) {
  console.log(result.text);
}

export async function resolveQueryRepoRoot(repo: string, opts: CliQueryOptions = {}): Promise<string> {
  const configuredRoot = path.resolve(repo);
  const routingOptions = workspaceRoutingOptionsFromCli(opts);
  return (
    await resolveMcpRepoRoot(configuredRoot, {
      ...routingOptions,
      preferConfiguredRoot: await shouldPreferConfiguredRepoRoot(configuredRoot, routingOptions)
    })
  ).repoRoot;
}

function workspaceRoutingOptionsFromCli(opts: CliQueryOptions): McpRepoRootResolutionOptions {
  return {
    workspaceFocusFile: opts.workspaceFocusFile ? path.resolve(opts.workspaceFocusFile) : undefined,
    workspaceSessionId: opts.workspaceSession
  };
}

export function invokedCliName(): string {
  const basename = path.basename(process.argv[1] ?? "codexa").replace(/\.[cm]?[jt]sx?$/u, "");
  return basename && basename !== "cli" ? basename : "codexa";
}

export type CliQueryOptions = {
  autoRefresh?: boolean;
  semantic?: boolean;
  semanticProvider?: SemanticProviderKind;
  semanticModel?: string;
  semanticDimensions?: number;
  semanticCommand?: string;
  semanticArg?: string[];
  semanticTimeoutMs?: number;
  semanticBatchSize?: number;
  lsp?: boolean;
  lspTimeoutMs?: number;
  lspMaxFiles?: number;
  sessionMemory?: "auto" | "off";
  workspaceFocusFile?: string;
  workspaceSession?: string;
};

export function queryOptionsFromCli(opts: CliQueryOptions): QueryOptions {
  return {
    autoRefresh: opts.autoRefresh,
    semantic: opts.semantic,
    semanticProvider: opts.semanticProvider,
    semanticModel: opts.semanticModel,
    semanticDimensions: opts.semanticDimensions,
    semanticCommand: opts.semanticCommand,
    semanticArgs: opts.semanticArg,
    semanticTimeoutMs: opts.semanticTimeoutMs,
    semanticBatchSize: opts.semanticBatchSize,
    lsp: opts.lsp,
    lspTimeoutMs: opts.lspTimeoutMs,
    lspMaxFiles: opts.lspMaxFiles,
    sessionMemory: opts.sessionMemory,
    workspaceFocusFile: opts.workspaceFocusFile ? path.resolve(opts.workspaceFocusFile) : undefined,
    workspaceSessionId: opts.workspaceSession
  };
}

export function parseSessionMemoryMode(value: string): "auto" | "off" {
  if (value === "auto" || value === "off") {
    return value;
  }
  throw new Error("session memory mode must be auto or off");
}

export function parseMcpTransport(value: string): McpTransportKind {
  if (value === "stdio" || value === "http") {
    return value;
  }
  throw new Error("MCP transport must be stdio or http");
}

export function parseIntOption(value: string): number {
  const trimmed = value.trim();
  if (!/^[+-]?\d+$/u.test(trimmed)) {
    throw new Error(`Invalid integer: ${value}`);
  }
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`Invalid integer: ${value}`);
  }
  return parsed;
}

export function parseAutonomyOption(value: string) {
  return parseAutonomyMode(value);
}

export function parseToolProfile(value: string): "core" | "full" {
  if (value === "core" || value === "full") {
    return value;
  }
  throw new Error(`Invalid tool profile: ${value} (expected core or full)`);
}

export function parseChangeType(value: string): ChangeType {
  const allowed = new Set<ChangeType>(["style", "api", "behavior", "rename", "delete", "unknown"]);
  if (allowed.has(value as ChangeType)) {
    return value as ChangeType;
  }
  throw new Error(`Invalid change type: ${value}`);
}

export function parseSessionMemoryAction(value: string): NonNullable<SessionMemoryInput["action"]> {
  const allowed = new Set<NonNullable<SessionMemoryInput["action"]>>(["read", "remember", "summary", "compact"]);
  if (allowed.has(value as NonNullable<SessionMemoryInput["action"]>)) {
    return value as NonNullable<SessionMemoryInput["action"]>;
  }
  throw new Error(`Invalid session memory action: ${value}`);
}

export function parseSessionMemoryKinds(values: string[] | undefined): SessionMemoryInput["kinds"] | undefined {
  return values?.map(parseSessionMemoryKind);
}

export function parseSessionMemoryKind(value: string): NonNullable<SessionMemoryInput["kinds"]>[number] {
  const allowed = new Set<NonNullable<SessionMemoryInput["kinds"]>[number]>([
    "viewed",
    "claim",
    "ruled_out",
    "open_question",
    "next_read",
    "decision",
    "verification",
    "risk",
    "constraint"
  ]);
  if (allowed.has(value as NonNullable<SessionMemoryInput["kinds"]>[number])) {
    return value as NonNullable<SessionMemoryInput["kinds"]>[number];
  }
  throw new Error(`Invalid session memory kind: ${value}`);
}

export function parseSessionMemoryEntries(values: string[] | undefined): SessionMemoryInput["entries"] | undefined {
  if (!values?.length) {
    return undefined;
  }
  return values.map((value) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new Error(`Invalid session memory entry JSON: ${value}`);
    }
    if (!isCliRecord(parsed)) {
      throw new Error(`Invalid session memory entry JSON: ${value}`);
    }
    const entry = parsed as NonNullable<SessionMemoryInput["entries"]>[number];
    if (typeof entry.summary !== "string" || entry.summary.trim().length === 0) {
      throw new Error(`Invalid session memory entry JSON: summary is required`);
    }
    const kind = parseSessionMemoryKind(String(entry.kind));
    if (entry.confidence !== "authoritative" && entry.confidence !== "derived" && entry.confidence !== "heuristic") {
      throw new Error(`Invalid session memory entry JSON: confidence is required`);
    }
    if (entry.evidenceTier !== "authoritative" && entry.evidenceTier !== "derived" && entry.evidenceTier !== "heuristic" && entry.evidenceTier !== "fallback") {
      throw new Error(`Invalid session memory entry JSON: evidenceTier is required`);
    }
    return {
      ...entry,
      kind,
      summary: entry.summary.trim()
    };
  });
}

export function parseSemanticProvider(value: string): SemanticProviderKind {
  const provider = semanticProviderFromValue(value);
  if (!provider) {
    throw new Error(`Invalid semantic provider: ${value}`);
  }
  return provider;
}

export function parseWaiverOptions(values: string[] | undefined): VerificationWaiver[] | undefined {
  if (!values?.length) {
    return undefined;
  }
  return values.map((value) => {
    let parsed: Partial<VerificationWaiver>;
    try {
      parsed = JSON.parse(value) as Partial<VerificationWaiver>;
    } catch {
      throw new Error(`Invalid waiver JSON: ${value}`);
    }
    if ((parsed.kind !== "test" && parsed.kind !== "workflow" && parsed.kind !== "dependency") || typeof parsed.target !== "string" || typeof parsed.reason !== "string") {
      throw new Error(`Invalid waiver JSON: ${value}`);
    }
    return { kind: parsed.kind, target: parsed.target, reason: parsed.reason };
  });
}

export function isCliRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export function parseCommandReportOptions(values: string[] | undefined): VerificationCommandReport[] | undefined {
  if (!values?.length) {
    return undefined;
  }
  return values.map((value) => {
    let parsed: Partial<VerificationCommandReport>;
    try {
      parsed = JSON.parse(value) as Partial<VerificationCommandReport>;
    } catch {
      throw new Error(`Invalid command report JSON: ${value}`);
    }
    if (typeof parsed.command !== "string" || parsed.command.trim().length === 0) {
      throw new Error(`Invalid command report JSON: ${value}`);
    }
    if (parsed.cwd !== undefined && typeof parsed.cwd !== "string") {
      throw new Error(`Invalid command report JSON: ${value}`);
    }
    for (const field of ["packageManager", "workspace", "packageRoot", "packageName", "scriptName"] as const) {
      if (parsed[field] !== undefined && typeof parsed[field] !== "string") {
        throw new Error(`Invalid command report JSON: ${value}`);
      }
    }
    if (parsed.args !== undefined && (!Array.isArray(parsed.args) || parsed.args.some((arg) => typeof arg !== "string"))) {
      throw new Error(`Invalid command report JSON: ${value}`);
    }
    if (parsed.args !== undefined && parsed.args.length > 80) {
      throw new Error(`Invalid command report JSON: args exceeds 80 entries`);
    }
    if (parsed.exitCode !== undefined && (!Number.isInteger(parsed.exitCode) || parsed.exitCode < 0)) {
      throw new Error(`Invalid command report JSON: ${value}`);
    }
    if (parsed.durationMs !== undefined && (!Number.isFinite(parsed.durationMs) || parsed.durationMs < 0)) {
      throw new Error(`Invalid command report JSON: ${value}`);
    }
    for (const field of ["stdoutSummary", "stderrSummary", "outputSummary"] as const) {
      if (parsed[field] !== undefined && typeof parsed[field] !== "string") {
        throw new Error(`Invalid command report JSON: ${value}`);
      }
      if (typeof parsed[field] === "string" && parsed[field].length > 1000) {
        throw new Error(`Invalid command report JSON: ${field} exceeds 1000 characters`);
      }
    }
    return {
      command: parsed.command,
      cwd: parsed.cwd,
      packageManager: parsed.packageManager,
      workspace: parsed.workspace,
      packageRoot: parsed.packageRoot,
      packageName: parsed.packageName,
      scriptName: parsed.scriptName,
      args: parsed.args,
      exitCode: parsed.exitCode,
      durationMs: parsed.durationMs,
      stdoutSummary: parsed.stdoutSummary,
      stderrSummary: parsed.stderrSummary,
      outputSummary: parsed.outputSummary
    };
  });
}

export function logLiveIndexEvent(event: LiveIndexEvent): void {
  if (event.type === "watch-ready") {
    console.error(`Codexa watch ready: ${event.repoRoot} (${event.directories} dirs, debounce ${event.debounceMs}ms, poll ${event.pollMs}ms)`);
    return;
  }
  if (event.type === "index-start") {
    console.error(`Codexa indexing started (${event.reason}).`);
    return;
  }
  if (event.type === "index-complete") {
    console.error(`Codexa indexed ${event.files} files, ${event.symbols} symbols, ${event.usageSites} usage sites in ${event.durationMs}ms (${event.reason}).`);
    return;
  }
  if (event.type === "watch-warning") {
    console.error(`Codexa watch warning: ${event.message}`);
    return;
  }
  if (event.type === "watch-stopped") {
    console.error(`Codexa watch stopped after ${event.runs} index run(s).`);
  }
}
