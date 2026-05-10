import { execFileSync } from "node:child_process";
import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { renderCodexUseContract } from "./codex-contract.js";
import { buildIndexLocked } from "./indexer.js";
import { resolveMcpRepoRoot } from "./mcp-repo-root.js";
import { statusQuery } from "./queries.js";

const EDIT_HOOK_MATCHER = "Edit|MultiEdit|Write|apply_patch";

export interface InitOptions {
  autoRefresh?: boolean;
  cliPath: string;
  hooks?: boolean;
  index?: boolean;
  serverName?: string;
}

export interface InitResult {
  repoRoot: string;
  configPath: string;
  hooksPath: string | null;
  serverName: string;
  indexed: {
    files: number;
    symbols: number;
    usageSites: number;
  } | null;
}

export async function initializeProject(repoInput: string | undefined, options: InitOptions): Promise<InitResult> {
  const repoRoot = resolveInitRepo(repoInput);
  const codexDir = path.join(repoRoot, ".codex");
  const serverName = validateServerName(options.serverName ?? `codexa-${slugify(path.basename(repoRoot))}`);
  const cliPath = path.resolve(options.cliPath);
  const configPath = path.join(codexDir, "config.toml");
  const hooksPath = path.join(codexDir, "hooks.json");
  const writeHooks = options.hooks ?? true;

  await mkdir(codexDir, { recursive: true });
  await upsertCodexConfig(configPath, {
    autoRefresh: options.autoRefresh ?? true,
    cliPath,
    repoRoot,
    serverName,
    hooks: writeHooks
  });

  if (writeHooks) {
    await upsertHooksConfig(hooksPath, {
      cliPath,
      repoRoot
    });
  }

  const indexed =
    options.index === false
      ? null
      : summarizeIndex(await buildIndexLocked({ repoRoot, writeArtifacts: true }));

  return {
    repoRoot,
    configPath,
    hooksPath: writeHooks ? hooksPath : null,
    serverName,
    indexed
  };
}

export async function sessionStartSummary(repoInput: string | undefined, includeContext: boolean, autoRefresh = false): Promise<string> {
  const configuredRoot = path.resolve(repoInput ?? process.cwd());
  let repoRoot: string;
  let resolutionNote: string | undefined;
  try {
    const resolution = await resolveMcpRepoRoot(configuredRoot);
    repoRoot = resolution.repoRoot;
    if (resolution.source !== "configured-root") {
      const via = resolution.focusFile ? `${resolution.source}:${resolution.focusFile}` : resolution.source;
      resolutionNote = `Workspace root: ${configuredRoot} -> focused repo via ${via}`;
    }
  } catch (error) {
    const lines = [`Codexa context for ${configuredRoot}:`];
    lines.push(`Codexa status unavailable: ${boundedErrorMessage(error)}`);
    lines.push("Codexa startup hook is advisory; continuing without blocking the session.");
    return lines.join("\n");
  }
  const lines = [`Codexa context for ${repoRoot}:`];
  if (resolutionNote) {
    lines.push(resolutionNote);
  }
  let status: Awaited<ReturnType<typeof statusQuery>>;
  try {
    status = await statusQuery(repoRoot);
    if (autoRefresh && status.freshness.stale) {
      await buildIndexLocked({ repoRoot, writeArtifacts: true });
      status = await statusQuery(repoRoot);
    }
  } catch (error) {
    lines.push(`Codexa status unavailable: ${boundedErrorMessage(error)}`);
    lines.push("Codexa startup hook is advisory; continuing without blocking the session.");
    return lines.join("\n");
  }
  lines.push(...status.text.split(/\r?\n/).slice(0, 6));

  if (includeContext) {
    lines.push("", ...renderCodexUseContract(status.freshness).split(/\r?\n/).slice(0, 78));
    lines.push(`Session-start auto-refresh: ${autoRefresh ? "enabled for follow-up MCP context calls" : "disabled for this cheap startup check"}.`);
  }

  lines.push("Codexa MCP is ready.");
  lines.push("Automatic-use contract: broad task -> focus_brief/session_context; code task -> task_brief; resume/reuse working memory -> session_memory; concrete edit -> change_plan with saveSnapshot=true before editing; after edits -> post_edit_review; workflow/runtime change -> workflow_path; API/rename/delete -> callers/callees/dependency_path; finish with test_plan.");
  return lines.join("\n");
}

function summarizeIndex(index: Awaited<ReturnType<typeof buildIndexLocked>>): InitResult["indexed"] {
  return {
    files: index.files.length,
    symbols: index.symbols.length,
    usageSites: index.usageSites.length
  };
}

function resolveInitRepo(repoInput: string | undefined): string {
  const candidate = path.resolve(repoInput ?? process.cwd());
  const gitRoot = runGit(candidate, ["rev-parse", "--show-toplevel"]);
  if (!gitRoot) {
    throw new Error(`Codexa init requires a git repository: ${candidate}`);
  }
  return path.resolve(gitRoot);
}

function runGit(cwd: string, args: string[]): string | null {
  try {
    return execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
  } catch {
    return null;
  }
}

async function upsertCodexConfig(
  configPath: string,
  options: {
    autoRefresh: boolean;
    cliPath: string;
    repoRoot: string;
    serverName: string;
    hooks: boolean;
  }
): Promise<void> {
  const existing = await readTextIfExists(configPath);
  let next = stripManagedBlocks(existing);
  next = removeCodexaMcpServerBlocks(next, options);
  next = removeMcpServerBlock(next, options.serverName);
  if (options.hooks) {
    next = ensureCodexHooksFeature(next);
  }
  next = trimTrailingBlankLines(next);
  if (next) {
    next += "\n\n";
  }
  next += renderMcpServerBlock(options);
  await writeFile(configPath, `${next}\n`, "utf8");
}

function renderMcpServerBlock(options: { autoRefresh: boolean; cliPath: string; repoRoot: string; serverName: string }): string {
  const args = [options.cliPath, "serve", options.repoRoot];
  args.push(options.autoRefresh ? "--auto-refresh" : "--no-auto-refresh");
  return [
    "# >>> codexa managed",
    `# Re-run \`codexa init\` from this repository to refresh this block.`,
    `[mcp_servers.${options.serverName}]`,
    `command = "node"`,
    `args = [${args.map(tomlString).join(", ")}]`,
    "startup_timeout_sec = 10",
    "tool_timeout_sec = 60",
    "# <<< codexa managed"
  ].join("\n");
}

async function upsertHooksConfig(hooksPath: string, options: { cliPath: string; repoRoot: string }): Promise<void> {
  const existing = await readTextIfExists(hooksPath);
  const parsed = existing.trim() ? parseHooksJson(existing, hooksPath) : {};
  const hooks = isPlainObject(parsed.hooks) ? parsed.hooks : {};
  const cleanedSessionStart = cleanHookList(hooks.SessionStart, options);
  const cleanedPreToolUse = cleanHookList(hooks.PreToolUse, options);
  const cleanedPostToolUse = cleanHookList(hooks.PostToolUse, options);

  cleanedSessionStart.push({
    codexaManaged: true,
    matcher: "startup|resume",
    hooks: [
      {
        codexaManaged: true,
        type: "command",
        command: `node ${shellQuote(options.cliPath)} session-start ${shellQuote(options.repoRoot)}`,
        statusMessage: "Loading Codexa context",
        timeout: 5
      }
    ]
  });
  cleanedPreToolUse.push({
    codexaManaged: true,
    matcher: EDIT_HOOK_MATCHER,
    hooks: [
      {
        codexaManaged: true,
        type: "command",
        command: `node ${shellQuote(options.cliPath)} hook-pre-edit ${shellQuote(options.repoRoot)}`,
        statusMessage: "Checking Codexa change-plan snapshot",
        timeout: 5
      }
    ]
  });
  cleanedPostToolUse.push({
    codexaManaged: true,
    matcher: EDIT_HOOK_MATCHER,
    hooks: [
      {
        codexaManaged: true,
        type: "command",
        command: `node ${shellQuote(options.cliPath)} hook-post-edit ${shellQuote(options.repoRoot)}`,
        statusMessage: "Running Codexa post-edit review",
        timeout: 20
      }
    ]
  });

  const next = {
    ...parsed,
    hooks: {
      ...hooks,
      SessionStart: cleanedSessionStart,
      PreToolUse: cleanedPreToolUse,
      PostToolUse: cleanedPostToolUse
    }
  };
  await writeFile(hooksPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
}

function cleanHookList(value: unknown, options: { cliPath: string; repoRoot: string }): Record<string, unknown>[] {
  const entries = Array.isArray(value) ? value : [];
  return entries
    .map((entry) => cleanHookEntry(entry, options))
    .filter((entry): entry is Record<string, unknown> => entry !== null);
}

function cleanHookEntry(entry: unknown, options: { cliPath: string; repoRoot: string }): Record<string, unknown> | null {
  if (!isPlainObject(entry)) {
    return null;
  }
  if (entry.codexaManaged === true) {
    return null;
  }
  const hooks = Array.isArray(entry.hooks) ? entry.hooks : [];
  const cleanedHooks = hooks.filter((hook) => {
    if (!isPlainObject(hook)) {
      return false;
    }
    if (hook.codexaManaged === true) {
      return false;
    }
    const command = typeof hook.command === "string" ? hook.command : "";
    return !isCodexaHookCommand(command, options);
  });
  if (cleanedHooks.length === 0) {
    return null;
  }
  return {
    ...entry,
    hooks: cleanedHooks
  };
}

function isCodexaHookCommand(command: string, options: { cliPath: string; repoRoot: string }): boolean {
  if (command.includes("codexa-sessionstart")) {
    return true;
  }
  if (!/\b(session-start|hook-pre-edit|hook-post-edit)\b/u.test(command)) {
    return false;
  }
  return (
    command.includes(shellQuote(options.cliPath)) ||
    command.includes(options.cliPath) ||
    command.includes(shellQuote(options.repoRoot)) ||
    command.includes(options.repoRoot)
  );
}

function parseHooksJson(value: string, hooksPath: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value);
    if (!isPlainObject(parsed)) {
      throw new Error("top-level JSON value must be an object");
    }
    return parsed;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Cannot update ${hooksPath}: ${message}`);
  }
}

function ensureCodexHooksFeature(config: string): string {
  const lines = config.split(/\r?\n/);
  const featureStart = lines.findIndex((line) => line.trim() === "[features]");
  if (featureStart === -1) {
    return ["[features]", "codex_hooks = true", "", ...lines].join("\n");
  }

  let sectionEnd = lines.length;
  for (let index = featureStart + 1; index < lines.length; index += 1) {
    const trimmed = lines[index].trim();
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      sectionEnd = index;
      break;
    }
  }

  const hookLine = lines.findIndex((line, index) => index > featureStart && index < sectionEnd && line.trim().startsWith("codex_hooks"));
  if (hookLine === -1) {
    lines.splice(featureStart + 1, 0, "codex_hooks = true");
  } else {
    lines[hookLine] = "codex_hooks = true";
  }
  return lines.join("\n");
}

function stripManagedBlocks(config: string): string {
  const lines = config.split(/\r?\n/);
  const kept: string[] = [];
  let skipping = false;
  for (const line of lines) {
    if (line.trim() === "# >>> codexa managed") {
      skipping = true;
      continue;
    }
    if (line.trim() === "# <<< codexa managed") {
      skipping = false;
      continue;
    }
    if (!skipping) {
      kept.push(line);
    }
  }
  return kept.join("\n");
}

function removeMcpServerBlock(config: string, serverName: string): string {
  const lines = config.split(/\r?\n/);
  const kept: string[] = [];
  const header = `[mcp_servers.${serverName}]`;
  const normalizedHeader = header.toLowerCase();
  let skipping = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.toLowerCase() === normalizedHeader) {
      skipping = true;
      continue;
    }
    if (skipping && trimmed.startsWith("[") && trimmed.endsWith("]")) {
      skipping = false;
    }
    if (!skipping) {
      kept.push(line);
    }
  }
  return kept.join("\n");
}

function removeCodexaMcpServerBlocks(config: string, options: { cliPath: string; repoRoot: string }): string {
  const lines = config.split(/\r?\n/);
  const kept: string[] = [];
  let skipping = false;
  let candidate: string[] = [];

  const flushCandidate = () => {
    if (candidate.length === 0) {
      return;
    }
    if (!isCodexaMcpServerBlock(candidate, options)) {
      kept.push(...candidate);
    }
    candidate = [];
  };

  for (const line of lines) {
    const trimmed = line.trim();
    const isSectionHeader = trimmed.startsWith("[") && trimmed.endsWith("]");
    if (isSectionHeader) {
      if (skipping) {
        flushCandidate();
      }
      skipping = /^\[mcp_servers\.[^\]]+\]$/iu.test(trimmed);
      if (skipping) {
        candidate = [line];
      } else {
        kept.push(line);
      }
      continue;
    }
    if (skipping) {
      candidate.push(line);
    } else {
      kept.push(line);
    }
  }
  if (skipping) {
    flushCandidate();
  }
  return kept.join("\n");
}

function isCodexaMcpServerBlock(lines: string[], options: { cliPath: string; repoRoot: string }): boolean {
  const block = lines.join("\n");
  const header = lines[0]?.trim().toLowerCase() ?? "";
  const blockWithoutRepoRoot = block.replaceAll(options.repoRoot, "");
  if (!/\bserve\b/u.test(block)) {
    return false;
  }
  if (/^\[mcp_servers\.codexa[-_.a-z0-9]*\]$/u.test(header) || /\bcodexa\b/u.test(blockWithoutRepoRoot)) {
    return true;
  }
  return block.includes(tomlString(options.cliPath)) && block.includes(tomlString(options.repoRoot));
}

async function readTextIfExists(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return "";
    }
    throw error;
  }
}

function trimTrailingBlankLines(value: string): string {
  return value.replace(/\s+$/u, "");
}

function slugify(value: string): string {
  const slug = value.toLowerCase().replace(/[^a-z0-9_-]+/gu, "-").replace(/^-+|-+$/gu, "");
  return slug || "repo";
}

function validateServerName(value: string): string {
  if (!/^[A-Za-z0-9_-]{1,64}$/u.test(value)) {
    throw new Error(`Invalid Codexa MCP server name: ${value}`);
  }
  return value;
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function boundedErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/gu, " ").trim().slice(0, 300) || "unknown error";
}
