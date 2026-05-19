import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getFreshness } from "./indexer.js";
import { codexaHookEventsRelativePath, loadLatestCodexaHookEvent } from "./post-edit-outcomes.js";

export interface DoctorOptions {
  json?: boolean;
  mcpReadiness?: boolean;
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
  const repoRoot = path.resolve(repoInput);
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
  const mcpReadiness = options.mcpReadiness ? await checkMcpReadiness(repoRoot, checks, nextActions) : undefined;

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

async function checkMcpReadiness(repoRoot: string, checks: DoctorCheck[], nextActions: string[]): Promise<{
  configPresent: boolean;
  serveConfigured: boolean;
  typedEnvelope: boolean;
  sessionMemoryMode: "auto" | "off";
  autoVerifyOptIn: boolean;
  semanticCache: boolean;
  lspConfigured: boolean;
  packageMetadata: { name?: string; version?: string; mcpServer: string };
  latestBenchmark?: unknown;
}> {
  const configText = await readTextIfExists(path.join(repoRoot, ".codex/config.toml"));
  const packageJson = await readJsonIfExists(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../package.json"));
  const packageRecord = packageJson && typeof packageJson === "object" ? (packageJson as Record<string, unknown>) : {};
  const sessionMemoryMode = /^\s*session_memory\s*=\s*"off"\s*$/imu.test(configText ?? "") ? "off" : "auto";
  const autoVerifyOptIn = process.env.CODEXA_AUTOVERIFY === "1" || /^\s*(auto_verify|autoverify)\s*=\s*true\s*$/imu.test(configText ?? "");
  const semanticCache = await exists(path.join(repoRoot, ".codex/cache/codexa-semantic-v1/manifest.json"));
  const lspConfigured = Boolean(process.env.CODEXA_LSP === "1" || process.env.CODEXA_LSP_TYPESCRIPT_COMMAND || process.env.CODEXA_LSP_JAVASCRIPT_COMMAND || process.env.CODEXA_LSP_PYTHON_COMMAND);
  const latestBenchmark = await readJsonIfExists(path.join(repoRoot, ".codex/cache/codexa-benchmarks/latest.json"));
  const serveConfigured = Boolean(configText && /\[mcp_servers\.[^\]]+\]/iu.test(configText) && /\bserve\b/u.test(configText));
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
    configPresent: configText !== null,
    serveConfigured,
    typedEnvelope: true,
    sessionMemoryMode,
    autoVerifyOptIn,
    semanticCache,
    lspConfigured,
    packageMetadata: {
      name: typeof packageRecord.name === "string" ? packageRecord.name : undefined,
      version: typeof packageRecord.version === "string" ? packageRecord.version : undefined,
      mcpServer: "codexa"
    },
    latestBenchmark
  };
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
  const codexHooksEnabled = Boolean(text && /^\s*codex_hooks\s*=\s*true\s*$/imu.test(text));
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
    lines.push(`- serve configured: ${data.mcpReadiness.serveConfigured ? "yes" : "no"}`);
    lines.push(`- typed envelope: ${data.mcpReadiness.typedEnvelope ? "yes" : "no"}`);
    lines.push(`- session memory: ${data.mcpReadiness.sessionMemoryMode}`);
    lines.push(`- AutoVerify opted in: ${data.mcpReadiness.autoVerifyOptIn ? "yes" : "no"}`);
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
