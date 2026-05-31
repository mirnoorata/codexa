import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { effectiveAutonomyMode, type CodexaAutonomyStatus } from "./autonomy.js";
import { getFreshness } from "./indexer.js";
import { MCP_TOOL_CATALOG } from "./mcp-tool-catalog.js";
import { resolveMcpRepoRoot, type McpRepoRootResolution, type McpRepoRootResolutionOptions } from "./mcp-repo-root.js";
import { codexaHookEventsRelativePath, loadLatestCodexaHookEvent } from "./post-edit-outcomes.js";

export interface DoctorOptions {
  json?: boolean;
  mcpReadiness?: boolean;
  workspaceFocusFile?: string;
  workspaceSessionId?: string;
}

export interface DoctorCheck {
  name: string;
  status: "ok" | "warn" | "fail";
  message: string;
}

export interface DoctorResult {
  ok: boolean;
  text: string;
  data: {
    repoRoot: string;
    node: {
      version: string;
      supported: boolean;
    };
    git: {
      root: string | null;
      headCommit: string | null;
    };
    config: {
      path: string;
      exists: boolean;
      mcpServerConfigured: boolean;
      codexHooksEnabled: boolean;
    };
    hooks: {
      path: string;
      exists: boolean;
      sessionStart: boolean;
      preEdit: boolean;
      postEdit: boolean;
    };
    index: {
      missing: boolean;
      stale: boolean;
      reason: string;
      snapshotId: string;
      indexedAt: string;
      dirtyFiles: number;
      parserErrorCount: number;
    } | null;
    artifacts: Array<{
      path: string;
      exists: boolean;
      bytes?: number;
    }>;
    latestHookEvent: Awaited<ReturnType<typeof loadLatestCodexaHookEvent>>;
    hookEventsPath: string;
    latestOutcome: unknown;
    mcpReadiness?: Awaited<ReturnType<typeof checkMcpReadiness>>;
    checks: DoctorCheck[];
    nextActions: string[];
  };
}

export async function runDoctor(repoInput: string, options: DoctorOptions = {}): Promise<DoctorResult> {
  const configuredRoot = path.resolve(repoInput);
  const workspaceRoutingRequested = Boolean(options.workspaceFocusFile || options.workspaceSessionId);
  const routingOptions: McpRepoRootResolutionOptions = {
    workspaceFocusFile: options.workspaceFocusFile,
    workspaceSessionId: options.workspaceSessionId,
    preferConfiguredRoot: !workspaceRoutingRequested && (await codexaConfigExists(configuredRoot))
  };
  const mcpRouting = options.mcpReadiness ? await inspectMcpRouting(configuredRoot, routingOptions) : undefined;
  const repoRoot = mcpRouting?.resolution?.repoRoot ?? configuredRoot;
  const checks: DoctorCheck[] = [];
  const nextActions: string[] = [];
  const node = checkNode(checks);
  const git = checkGit(repoRoot, checks);
  const config = await checkConfig(repoRoot, checks, nextActions);
  const hooks = await checkHooks(repoRoot, checks, nextActions);
  const index = await checkIndex(repoRoot, checks, nextActions);
  const artifacts = await checkArtifacts(repoRoot);
  const latestHookEvent = await loadLatestCodexaHookEvent(repoRoot);
  checkLatestHookEvent(latestHookEvent, checks);
  const latestOutcome = await readJsonIfExists(path.join(repoRoot, ".codex/cache/codexa-outcomes/latest.json"));
  const hookEventsPath = codexaHookEventsRelativePath();
  const mcpReadiness = options.mcpReadiness ? await checkMcpReadiness(repoRoot, checks, nextActions, configuredRoot, mcpRouting) : undefined;

  const ok = checks.every((check) => check.status !== "fail");
  const data = {
    repoRoot,
    node,
    git,
    config,
    hooks,
    index,
    artifacts,
    latestHookEvent,
    hookEventsPath,
    latestOutcome,
    mcpReadiness,
    checks,
    nextActions
  };
  return {
    ok,
    data,
    text: options.json ? `${JSON.stringify(data, null, 2)}\n` : renderDoctor(data)
  };
}

type McpRoutingInspection =
  | { resolution: McpRepoRootResolution; error?: undefined }
  | { resolution?: undefined; error: string };

async function inspectMcpRouting(configuredRoot: string, options: McpRepoRootResolutionOptions): Promise<McpRoutingInspection> {
  try {
    return { resolution: await resolveMcpRepoRoot(configuredRoot, options) };
  } catch (error) {
    return { error: errorMessage(error) };
  }
}

async function checkMcpReadiness(
  repoRoot: string,
  checks: DoctorCheck[],
  nextActions: string[],
  configuredRoot: string,
  routing: McpRoutingInspection | undefined
): Promise<{
  routing: {
    configuredRoot: string;
    activeRepoRoot: string | null;
    source: McpRepoRootResolution["source"] | "unresolved";
    focusReason?: McpRepoRootResolution["focusReason"];
    focusFile?: string;
    workspaceSessionId?: string;
    warnings: string[];
    error?: string;
  };
  configPresent: boolean;
  serveConfigured: boolean;
  typedEnvelope: boolean;
  sessionMemoryMode: "auto" | "off";
  autoVerifyOptIn: boolean;
  autonomy: CodexaAutonomyStatus;
  semanticCache: boolean;
  lspConfigured: boolean;
  toolSurface: {
    primaryTools: string[];
    advancedToolCount: number;
    readOnlyPrimaryTools: string[];
    cacheWritingPrimaryTools: Array<{ name: string; writeEffects: string }>;
    sourceMutationTools: string[];
    registeredTools: string[];
    registrationSource: string | null;
    registrationError?: string;
    unregisteredCatalogTools: string[];
    uncatalogedRegisteredTools: string[];
  };
  packageMetadata: { name?: string; version?: string; mcpServer: string };
  latestEval?: unknown;
}> {
  const routingWarnings = routing?.resolution?.warnings ?? [];
  const routingData = routing?.resolution
    ? {
        configuredRoot,
        activeRepoRoot: routing.resolution.repoRoot,
        source: routing.resolution.source,
        focusReason: routing.resolution.focusReason,
        focusFile: routing.resolution.focusFile,
        workspaceSessionId: routing.resolution.workspaceSessionId,
        warnings: routingWarnings
      }
    : {
        configuredRoot,
        activeRepoRoot: null,
        source: "unresolved" as const,
        warnings: [],
        error: routing?.error ?? "MCP routing was not inspected."
      };
  const configText = await readTextIfExists(path.join(repoRoot, ".codex/config.toml"));
  const packageJson = await readJsonIfExists(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../package.json"));
  const packageRecord = packageJson && typeof packageJson === "object" ? (packageJson as Record<string, unknown>) : {};
  const sessionMemoryMode = /^\s*session_memory\s*=\s*"off"\s*$/imu.test(configText ?? "") ? "off" : "auto";
  const autonomy = await effectiveAutonomyMode(repoRoot);
  const autoVerifyOptIn = autonomy.mode === "full-access";
  const semanticCache = await exists(path.join(repoRoot, ".codex/cache/codexa-semantic-v1/manifest.json"));
  const lspConfigured = Boolean(process.env.CODEXA_LSP === "1" || process.env.CODEXA_LSP_TYPESCRIPT_COMMAND || process.env.CODEXA_LSP_JAVASCRIPT_COMMAND || process.env.CODEXA_LSP_PYTHON_COMMAND);
  const latestEval = await readJsonIfExists(path.join(repoRoot, ".codex/cache/codexa-evals/latest.json"));
  const serveConfigured = Boolean(configText && /\[mcp_servers\.[^\]]+\]/iu.test(configText) && /\bserve\b/u.test(configText));
  const toolSurface = await mcpToolSurface();
  if (routingData.error) {
    checks.push({
      name: "mcp-routing",
      status: "fail",
      message: `Codexa MCP could not resolve an active repo from ${configuredRoot}: ${routingData.error}`
    });
    nextActions.push("Set CODEXA_WORKSPACE_SESSION or pass --workspace-session when serving a shared workspace root.");
  } else if (routingWarnings.length > 0) {
    checks.push({
      name: "mcp-routing",
      status: "warn",
      message: `Codexa MCP resolved ${configuredRoot} to ${routingData.activeRepoRoot} with routing warning(s).`
    });
    nextActions.push("Pass --workspace-session <session> or set CODEXA_WORKSPACE_SESSION for shared workspace-root MCP launches.");
  } else {
    checks.push({
      name: "mcp-routing",
      status: "ok",
      message: `Codexa MCP resolves ${configuredRoot} to ${routingData.activeRepoRoot}.`
    });
  }
  checks.push({
    name: "mcp-readiness",
    status: serveConfigured ? "ok" : "warn",
    message: serveConfigured ? "Codexa MCP serve command is configured." : "Codexa MCP serve command is not configured for this repo."
  });
  checks.push({
    name: "mcp-envelope",
    status: "ok",
    message: "Codexa MCP tools use the schemaVersion=1 structured envelope."
  });
  checks.push({
    name: "mcp-primary-tools",
    status: toolSurface.sourceMutationTools.length === 0 ? "ok" : "fail",
    message:
      toolSurface.sourceMutationTools.length === 0
        ? `Primary MCP path exposes ${toolSurface.primaryTools.length} tools and no source-mutating tools.`
        : `Source-mutating MCP tools are exposed: ${toolSurface.sourceMutationTools.join(", ")}`
  });
  if (!toolSurface.registrationSource) {
    checks.push({
      name: "mcp-tool-parity",
      status: "warn",
      message: `Codexa could not inspect MCP server tool registration: ${toolSurface.registrationError ?? "unknown error"}.`
    });
    nextActions.push("Run `npm run build`, then rerun `codexa doctor <repo> --mcp-readiness` so tool registration parity can be inspected.");
  } else if (toolSurface.unregisteredCatalogTools.length > 0 || toolSurface.uncatalogedRegisteredTools.length > 0) {
    checks.push({
      name: "mcp-tool-parity",
      status: "fail",
      message: `MCP catalog/server drift detected; unregistered catalog tools: ${formatNameList(toolSurface.unregisteredCatalogTools)}; uncataloged registered tools: ${formatNameList(toolSurface.uncatalogedRegisteredTools)}.`
    });
    nextActions.push("Update MCP_TOOL_CATALOG and server.registerTool registrations together before publishing MCP readiness changes.");
  } else {
    checks.push({
      name: "mcp-tool-parity",
      status: "ok",
      message: `MCP catalog matches ${toolSurface.registeredTools.length} registered server tools.`
    });
  }
  checkLatestEval(latestEval, checks, nextActions, repoRoot, toolSurface);
  if (!autoVerifyOptIn) {
    checks.push({
      name: "autoverify-trust",
      status: "ok",
      message: "AutoVerify execution is not opted in; hooks will recommend commands without spawning repo tests."
    });
  }
  if (!serveConfigured) {
    nextActions.push("Run `codexa init <repo>` so Codex can discover the Codexa MCP server.");
  }
  return {
    routing: routingData,
    configPresent: configText !== null,
    serveConfigured,
    typedEnvelope: true,
    sessionMemoryMode,
    autoVerifyOptIn,
    autonomy,
    semanticCache,
    lspConfigured,
    toolSurface,
    packageMetadata: {
      name: typeof packageRecord.name === "string" ? packageRecord.name : undefined,
      version: typeof packageRecord.version === "string" ? packageRecord.version : undefined,
      mcpServer: "codexa"
    },
    latestEval
  };
}

async function mcpToolSurface(): Promise<{
  primaryTools: string[];
  advancedToolCount: number;
  readOnlyPrimaryTools: string[];
  cacheWritingPrimaryTools: Array<{ name: string; writeEffects: string }>;
  sourceMutationTools: string[];
  registeredTools: string[];
  registrationSource: string | null;
  registrationError?: string;
  unregisteredCatalogTools: string[];
  uncatalogedRegisteredTools: string[];
}> {
  const primary = MCP_TOOL_CATALOG.filter((tool) => tool.tier === "primary");
  const sourceMutationTools = MCP_TOOL_CATALOG.filter((tool) => /\bsource\b/iu.test(tool.writeEffects)).map((tool) => tool.name);
  const registered = await registeredMcpToolNamesFromServerSource();
  const catalogNames: string[] = MCP_TOOL_CATALOG.map((tool) => tool.name);
  return {
    primaryTools: primary.map((tool) => tool.name),
    advancedToolCount: MCP_TOOL_CATALOG.filter((tool) => tool.tier === "advanced").length,
    readOnlyPrimaryTools: primary.filter((tool) => tool.readOnly).map((tool) => tool.name),
    cacheWritingPrimaryTools: primary.filter((tool) => !tool.readOnly).map((tool) => ({ name: tool.name, writeEffects: tool.writeEffects })),
    sourceMutationTools,
    registeredTools: registered.names,
    registrationSource: registered.sourcePath ?? null,
    registrationError: registered.error,
    unregisteredCatalogTools: catalogNames.filter((name) => !registered.names.includes(name)),
    uncatalogedRegisteredTools: registered.names.filter((name) => !catalogNames.includes(name))
  };
}

async function registeredMcpToolNamesFromServerSource(): Promise<{ names: string[]; sourcePath?: string; error?: string }> {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [path.join(moduleDir, "mcp.js"), path.join(moduleDir, "mcp.ts")];
  const errors: string[] = [];
  for (const candidate of candidates) {
    const text = await readTextIfExists(candidate);
    if (text === null) {
      errors.push(`${candidate}: not found`);
      continue;
    }
    const names = [...text.matchAll(/server\.registerTool\(\s*["']([a-z0-9_:-]+)["']/giu)].map((match) => match[1]);
    if (names.length === 0) {
      errors.push(`${candidate}: no registerTool calls found`);
      continue;
    }
    return { names: [...new Set(names)], sourcePath: candidate };
  }
  return { names: [], error: errors.join("; ") };
}

async function codexaConfigExists(repoRoot: string): Promise<boolean> {
  try {
    await fs.access(path.join(repoRoot, ".codex", "config.toml"));
    return true;
  } catch {
    return false;
  }
}

function checkLatestEval(
  latestEval: unknown,
  checks: DoctorCheck[],
  nextActions: string[],
  repoRoot: string,
  toolSurface: Awaited<ReturnType<typeof mcpToolSurface>>
): void {
  if (!latestEval || typeof latestEval !== "object") {
    checks.push({
      name: "latest-eval",
      status: "warn",
      message: "No latest Codexa eval summary is recorded."
    });
    nextActions.push("Run `codexa eval <repo> --suite synthetic` before treating MCP readiness as release-grade.");
    return;
  }
  const record = latestEval as Record<string, unknown>;
  const passed = record.passed === true;
  const score = typeof record.score === "number" ? record.score : undefined;
  const metadataWarnings = latestEvalFreshnessWarnings(record, repoRoot, toolSurface);
  const status: DoctorCheck["status"] = !passed ? "fail" : metadataWarnings.length > 0 ? "warn" : "ok";
  checks.push({
    name: "latest-eval",
    status,
    message: passed
      ? `Latest Codexa eval passed${score !== undefined ? ` with score ${score.toFixed(3)}` : ""}${metadataWarnings.length > 0 ? `; metadata warning(s): ${metadataWarnings.join("; ")}` : ""}.`
      : `Latest Codexa eval did not pass${score !== undefined ? `; score ${score.toFixed(3)}` : ""}.`
  });
  if (!passed) {
    nextActions.push("Inspect `.codex/cache/codexa-evals/latest.json`, then fix failing eval dimensions before publishing MCP changes.");
  } else if (metadataWarnings.length > 0) {
    nextActions.push("Refresh `.codex/cache/codexa-evals/latest.json` with `codexa eval <repo> --suite synthetic` so readiness evidence matches the current commit and MCP catalog.");
  }
}

function latestEvalFreshnessWarnings(record: Record<string, unknown>, repoRoot: string, toolSurface: Awaited<ReturnType<typeof mcpToolSurface>>): string[] {
  const warnings: string[] = [];
  const currentHead = runGit(repoRoot, ["rev-parse", "HEAD"]);
  const evalHead = typeof record.headCommit === "string" ? record.headCommit : undefined;
  if (!evalHead) {
    warnings.push("missing headCommit");
  } else if (currentHead && evalHead !== currentHead) {
    warnings.push("headCommit differs from current HEAD");
  }
  const expectedCatalogTools = MCP_TOOL_CATALOG.map((tool) => tool.name);
  const evalCatalogTools = Array.isArray(record.mcpCatalogTools) ? record.mcpCatalogTools.filter((tool): tool is string => typeof tool === "string") : [];
  if (evalCatalogTools.length === 0) {
    warnings.push("missing MCP catalog tool metadata");
  } else if (!sameStringSet(evalCatalogTools, expectedCatalogTools)) {
    warnings.push("MCP catalog tools differ from current catalog");
  }
  if (toolSurface.registeredTools.length > 0 && evalCatalogTools.length > 0 && !sameStringSet(evalCatalogTools, toolSurface.registeredTools)) {
    warnings.push("MCP catalog metadata differs from registered server tools");
  }
  return warnings;
}

function sameStringSet(left: string[], right: string[]): boolean {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  return leftSet.size === rightSet.size && [...leftSet].every((value) => rightSet.has(value));
}

function checkNode(checks: DoctorCheck[]): DoctorResult["data"]["node"] {
  const major = Number(process.versions.node.split(".")[0]);
  const supported = Number.isFinite(major) && major >= 22;
  checks.push({
    name: "node",
    status: supported ? "ok" : "fail",
    message: supported ? `Node ${process.version} satisfies Codexa's >=22 requirement.` : `Node ${process.version} is below Codexa's >=22 requirement.`
  });
  return { version: process.version, supported };
}

function checkGit(repoRoot: string, checks: DoctorCheck[]): DoctorResult["data"]["git"] {
  const root = runGit(repoRoot, ["rev-parse", "--show-toplevel"]);
  const headCommit = root ? runGit(repoRoot, ["rev-parse", "HEAD"]) : null;
  checks.push({
    name: "git",
    status: root ? "ok" : "fail",
    message: root ? `Git root detected at ${root}.` : "Codexa needs to run inside a git repository."
  });
  return { root: root ? path.resolve(root) : null, headCommit };
}

async function checkConfig(repoRoot: string, checks: DoctorCheck[], nextActions: string[]): Promise<DoctorResult["data"]["config"]> {
  const configPath = path.join(repoRoot, ".codex/config.toml");
  const text = await readTextIfExists(configPath);
  const exists = text !== null;
  const mcpServerConfigured = Boolean(text && /\[mcp_servers\.[^\]]+\]/iu.test(text) && /\bserve\b/u.test(text));
  const codexHooksEnabled = Boolean(text && /^\s*hooks\s*=\s*true\s*$/imu.test(text));
  if (!exists || !mcpServerConfigured) {
    checks.push({ name: "config", status: "warn", message: "Codexa MCP config is missing or incomplete." });
    nextActions.push("Run `codexa init <repo>` to refresh repo-local MCP config.");
  } else {
    checks.push({ name: "config", status: "ok", message: "Codexa MCP config is present." });
  }
  return { path: configPath, exists, mcpServerConfigured, codexHooksEnabled };
}

async function checkHooks(repoRoot: string, checks: DoctorCheck[], nextActions: string[]): Promise<DoctorResult["data"]["hooks"]> {
  const hooksPath = path.join(repoRoot, ".codex/hooks.json");
  const parsed = await readJsonIfExists(hooksPath);
  const exists = parsed !== null;
  const commands = collectHookCommands(parsed);
  const sessionStart = commands.some((command) => /\bsession-start\b/u.test(command));
  const preEdit = commands.some((command) => /\bhook-pre-edit\b/u.test(command));
  const postEdit = commands.some((command) => /\bhook-post-edit\b/u.test(command));
  if (!exists || !sessionStart || !preEdit || !postEdit) {
    checks.push({ name: "hooks", status: "warn", message: "Codexa hook wiring is missing or incomplete." });
    nextActions.push("Run `codexa init <repo>` to refresh repo-local hooks.");
  } else {
    checks.push({ name: "hooks", status: "ok", message: "Codexa SessionStart, pre-edit, and post-edit hooks are wired." });
  }
  return { path: hooksPath, exists, sessionStart, preEdit, postEdit };
}

async function checkIndex(repoRoot: string, checks: DoctorCheck[], nextActions: string[]): Promise<DoctorResult["data"]["index"]> {
  try {
    const freshness = await getFreshness(repoRoot, undefined, { recover: false });
    const status = freshness.missing ? "warn" : freshness.stale ? "warn" : "ok";
    checks.push({
      name: "index",
      status,
      message: freshness.missing
        ? "Codexa index is missing."
        : freshness.stale
          ? `Codexa index is stale: ${freshness.reason}.`
          : `Codexa index is fresh: ${freshness.reason}.`
    });
    if (freshness.missing || freshness.stale) {
      nextActions.push("Run `codexa index <repo>` or use an auto-refreshing Codexa query.");
    }
    if (freshness.parserErrorCount > 0) {
      checks.push({ name: "parser-errors", status: "warn", message: `${freshness.parserErrorCount} parser error(s) are recorded in the current index.` });
    }
    return {
      missing: freshness.missing,
      stale: freshness.stale,
      reason: freshness.reason,
      snapshotId: freshness.snapshotId,
      indexedAt: freshness.indexedAt,
      dirtyFiles: freshness.dirtyFiles.length,
      parserErrorCount: freshness.parserErrorCount
    };
  } catch (error) {
    checks.push({ name: "index", status: "fail", message: `Cannot read Codexa freshness: ${errorMessage(error)}` });
    nextActions.push("Fix git/index access, then run `codexa index <repo>`.");
    return null;
  }
}

async function checkArtifacts(repoRoot: string): Promise<DoctorResult["data"]["artifacts"]> {
  const files = [
    ".codex/codebase/freshness.json",
    ".codex/codebase/index.json",
    ".codex/codebase/repo-map.md",
    ".codex/codebase/test-map.md",
    ".codex/cache/codexa-parse-cache.json",
    ".codex/cache/codexa-outcomes/latest.json",
    ".codex/cache/codexa-hooks/events.ndjson"
  ];
  return await Promise.all(
    files.map(async (relativePath) => {
      try {
        const stat = await fs.stat(path.join(repoRoot, relativePath));
        return { path: relativePath, exists: true, bytes: stat.size };
      } catch {
        return { path: relativePath, exists: false };
      }
    })
  );
}

function checkLatestHookEvent(event: DoctorResult["data"]["latestHookEvent"], checks: DoctorCheck[]): void {
  if (!event) {
    checks.push({ name: "hook-events", status: "ok", message: "No Codexa hook event has been recorded yet." });
    return;
  }
  checks.push({
    name: "hook-events",
    status: event.status === "failed" ? "warn" : "ok",
    message: `Latest hook event: ${event.hook} ${event.status}${event.reason ? ` (${event.reason})` : ""}.`
  });
}

function collectHookCommands(value: unknown): string[] {
  const commands: string[] = [];
  const visit = (entry: unknown) => {
    if (Array.isArray(entry)) {
      for (const item of entry) {
        visit(item);
      }
      return;
    }
    if (!entry || typeof entry !== "object") {
      return;
    }
    const record = entry as Record<string, unknown>;
    if (typeof record.command === "string") {
      commands.push(record.command);
    }
    for (const value of Object.values(record)) {
      visit(value);
    }
  };
  visit(value);
  return commands;
}

function renderDoctor(data: DoctorResult["data"]): string {
  const lines = [
    "Codexa doctor",
    `Repo: ${data.repoRoot}`,
    `Overall: ${data.checks.some((check) => check.status === "fail") ? "needs attention" : data.checks.some((check) => check.status === "warn") ? "usable with warnings" : "healthy"}`,
    "",
    "Checks:"
  ];
  for (const check of data.checks) {
    lines.push(`- ${check.status}: ${check.name} - ${check.message}`);
  }
  lines.push("", "Artifacts:");
  for (const artifact of data.artifacts) {
    lines.push(`- ${artifact.exists ? "ok" : "missing"}: ${artifact.path}${artifact.bytes !== undefined ? ` (${formatBytes(artifact.bytes)})` : ""}`);
  }
  if (data.latestHookEvent) {
    lines.push("", `Latest hook: ${data.latestHookEvent.hook} ${data.latestHookEvent.status} at ${data.latestHookEvent.createdAt}`);
    lines.push(`Hook log: ${data.hookEventsPath}`);
  }
  if (data.mcpReadiness) {
    lines.push("", "MCP readiness:");
    lines.push(`- configured root: ${data.mcpReadiness.routing.configuredRoot}`);
    lines.push(`- active repo: ${data.mcpReadiness.routing.activeRepoRoot ?? "unresolved"}`);
    lines.push(
      `- routing: ${data.mcpReadiness.routing.source}${data.mcpReadiness.routing.focusReason ? ` (${data.mcpReadiness.routing.focusReason})` : ""}${
        data.mcpReadiness.routing.workspaceSessionId ? ` session=${data.mcpReadiness.routing.workspaceSessionId}` : ""
      }`
    );
    if (data.mcpReadiness.routing.focusFile) {
      lines.push(`- focus file: ${data.mcpReadiness.routing.focusFile}`);
    }
    for (const warning of data.mcpReadiness.routing.warnings) {
      lines.push(`- routing warning: ${warning}`);
    }
    if (data.mcpReadiness.routing.error) {
      lines.push(`- routing error: ${data.mcpReadiness.routing.error}`);
    }
    lines.push(`- serve configured: ${data.mcpReadiness.serveConfigured ? "yes" : "no"}`);
    lines.push(`- typed envelope: ${data.mcpReadiness.typedEnvelope ? "yes" : "no"}`);
    lines.push(`- primary tools: ${data.mcpReadiness.toolSurface.primaryTools.join(", ")}`);
    lines.push(`- advanced tool count: ${data.mcpReadiness.toolSurface.advancedToolCount}`);
    lines.push(`- registered tools: ${data.mcpReadiness.toolSurface.registeredTools.length}`);
    lines.push(`- catalog/server parity: ${data.mcpReadiness.toolSurface.unregisteredCatalogTools.length === 0 && data.mcpReadiness.toolSurface.uncatalogedRegisteredTools.length === 0 ? "ok" : "drift"}`);
    lines.push(`- source mutation tools: ${data.mcpReadiness.toolSurface.sourceMutationTools.length > 0 ? data.mcpReadiness.toolSurface.sourceMutationTools.join(", ") : "none"}`);
    lines.push(`- latest eval: ${formatLatestEval(data.mcpReadiness.latestEval)}`);
    lines.push(`- session memory: ${data.mcpReadiness.sessionMemoryMode}`);
    lines.push(`- AutoVerify opted in: ${data.mcpReadiness.autoVerifyOptIn ? "yes" : "no"} (${data.mcpReadiness.autonomy.source})`);
    lines.push(`- semantic cache: ${data.mcpReadiness.semanticCache ? "present" : "missing"}`);
    lines.push(`- LSP configured: ${data.mcpReadiness.lspConfigured ? "yes" : "no"}`);
    lines.push(`- package: ${data.mcpReadiness.packageMetadata.name ?? "unknown"} ${data.mcpReadiness.packageMetadata.version ?? "unknown"}`);
  }
  if (data.nextActions.length > 0) {
    lines.push("", "Next actions:");
    for (const action of [...new Set(data.nextActions)]) {
      lines.push(`- ${action}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

function formatLatestEval(latestEval: unknown): string {
  if (!latestEval || typeof latestEval !== "object") {
    return "missing";
  }
  const record = latestEval as Record<string, unknown>;
  const status = record.passed === true ? "pass" : record.passed === false ? "fail" : "unknown";
  const score = typeof record.score === "number" ? ` score=${record.score.toFixed(3)}` : "";
  const suite = typeof record.suite === "string" ? ` suite=${record.suite}` : "";
  const seed = typeof record.seed === "string" ? ` seed=${record.seed}` : "";
  return `${status}${score}${suite}${seed}`;
}

function formatNameList(names: string[]): string {
  return names.length > 0 ? names.join(", ") : "none";
}

function runGit(repoRoot: string, args: string[]): string | null {
  try {
    return execFileSync("git", ["-C", repoRoot, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
  } catch {
    return null;
  }
}

async function readTextIfExists(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

async function readJsonIfExists(filePath: string): Promise<unknown | null> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.stat(filePath);
    return true;
  } catch {
    return false;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message.replace(/\s+/gu, " ").trim() : String(error);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KiB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}
