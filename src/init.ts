import { execFileSync } from "node:child_process";
import path from "node:path";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { renderCodexUseContract } from "./codex-contract.js";
import { buildIndexLocked } from "./indexer.js";
import { CORE_PROFILE_TOOL_NAMES, PRIMARY_CODEX_LOOP } from "./mcp-tool-catalog.js";
import { resolveMcpRepoRoot } from "./mcp-repo-root.js";
import { statusQuery } from "./queries.js";
import { CODEXA_VERSION } from "./version.js";

const EDIT_HOOK_MATCHER = "Edit|MultiEdit|Write|NotebookEdit|apply_patch";

export type InitToolProfile = "core" | "full";

export interface InitOptions {
  autoRefresh?: boolean;
  cliPath: string;
  hooks?: boolean;
  index?: boolean;
  serverName?: string;
  toolProfile?: InitToolProfile;
  agentsMd?: boolean;
  claudeMd?: boolean;
  claude?: boolean;
}

export interface InitResult {
  repoRoot: string;
  configPath: string;
  hooksPath: string | null;
  agentsMdPath: string | null;
  claudeMdPath: string | null;
  claudeMcpPath: string | null;
  serverName: string;
  launchNote: string | null;
  indexed: {
    files: number;
    symbols: number;
    usageSites: number;
  } | null;
}

interface LaunchSpec {
  command: string;
  args: string[];
  pinnedNpx: boolean;
}

// An ephemeral runner cache path (npm's ~/.npm/_npx/<hash>/…, pnpm's
// …/pnpm/dlx/<hash>/…) is evicted on cache prune; baking it into MCP config
// breaks server startup weeks later with no visible cause. Pin the published
// package version instead so the config stays launchable.
function resolveLaunchSpec(cliPath: string): LaunchSpec {
  if (/[\\/]_npx[\\/]/u.test(cliPath) || /[\\/]pnpm[\\/]dlx[\\/]/u.test(cliPath)) {
    return { command: "npx", args: ["-y", `@mirnoorata/codexa@${CODEXA_VERSION}`], pinnedNpx: true };
  }
  return { command: "node", args: [cliPath], pinnedNpx: false };
}

// Re-running plain `codexa init` must not silently change an existing
// install's tool exposure (the rendered managed block historically told
// full-profile users to refresh with exactly `codexa init`). When --tools is
// not passed, the previously rendered profile wins; "core" only applies to
// fresh installs.
function detectExistingToolProfile(existingConfig: string): InitToolProfile | undefined {
  if (!existingConfig.includes("# >>> codexa managed")) {
    return undefined;
  }
  const lines = existingConfig.split(/\r?\n/);
  let inManaged = false;
  let sawManaged = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "# >>> codexa managed") {
      inManaged = true;
      sawManaged = true;
      continue;
    }
    if (trimmed === "# <<< codexa managed") {
      inManaged = false;
      continue;
    }
    if (inManaged && /^enabled_tools\s*=/u.test(trimmed)) {
      return "core";
    }
  }
  return sawManaged ? "full" : undefined;
}

export async function initializeProject(repoInput: string | undefined, options: InitOptions): Promise<InitResult> {
  const repoRoot = resolveInitRepo(repoInput);
  const codexDir = path.join(repoRoot, ".codex");
  const serverName = validateServerName(options.serverName ?? `codexa-${slugify(path.basename(repoRoot))}`);
  const cliPath = path.resolve(options.cliPath);
  const launch = resolveLaunchSpec(cliPath);
  const configPath = path.join(codexDir, "config.toml");
  const hooksPath = path.join(codexDir, "hooks.json");
  const writeHooks = options.hooks ?? true;
  const toolProfile = options.toolProfile ?? detectExistingToolProfile(await readTextIfExists(configPath)) ?? "core";
  const autoRefresh = options.autoRefresh ?? true;

  await mkdir(codexDir, { recursive: true });
  const keepHooksFeature = writeHooks
    ? true
    : await removeCodexaManagedHooksConfig(hooksPath, {
        cliPath,
        repoRoot
      });
  await upsertCodexConfig(configPath, {
    autoRefresh,
    cliPath,
    launch,
    repoRoot,
    serverName,
    hooks: keepHooksFeature,
    toolProfile
  });

  if (writeHooks) {
    await upsertHooksConfig(hooksPath, {
      cliPath,
      launch,
      repoRoot
    });
  }

  const agentsMdPath = options.agentsMd ? await upsertManagedDoc(repoRoot, "AGENTS.md", serverName) : null;
  const claudeMdPath = options.claudeMd ? await upsertManagedDoc(repoRoot, "CLAUDE.md", serverName) : null;
  const claudeMcpPath = options.claude ? path.join(repoRoot, ".mcp.json") : null;
  if (claudeMcpPath) {
    await upsertClaudeMcpConfig(claudeMcpPath, { autoRefresh, launch, repoRoot, serverName, toolProfile });
  }

  const indexed =
    options.index === false
      ? null
      : summarizeIndex(await buildIndexLocked({ repoRoot, writeArtifacts: true }));

  return {
    repoRoot,
    configPath,
    hooksPath: writeHooks ? hooksPath : null,
    agentsMdPath,
    claudeMdPath,
    claudeMcpPath,
    serverName,
    launchNote: launch.pinnedNpx
      ? `Codexa CLI resolved inside the evictable npx cache; generated configs pin "npx -y @mirnoorata/codexa@${CODEXA_VERSION}" instead of the cache path.`
      : null,
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
  lines.push(`Automatic-use contract: primary loop ${PRIMARY_CODEX_LOOP}; broad task -> session_context then search if actionability needs a target; resume/reuse working memory -> session_memory; workflow/runtime change -> workflow_path; API/rename/delete -> callers/callees/dependency_path.`);
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
    launch: LaunchSpec;
    repoRoot: string;
    serverName: string;
    hooks: boolean;
    toolProfile: InitToolProfile;
  }
): Promise<void> {
  const existing = await readTextIfExists(configPath);
  let next = stripManagedBlocks(existing);
  // Legacy detection keys on the real CLI path, never on launch args like
  // "-y", which would also match unrelated npx-launched server blocks.
  next = removeCodexaMcpServerBlocks(next, { cliPath: options.cliPath, repoRoot: options.repoRoot });
  next = removeMcpServerBlock(next, options.serverName);
  if (options.hooks) {
    next = ensureHooksFeature(next);
	  } else {
	    next = removeHooksFeature(next);
	  }
  next = trimTrailingBlankLines(next);
  if (next) {
    next += "\n\n";
  }
  next += renderMcpServerBlock(options);
  await writeFile(configPath, `${next}\n`, "utf8");
}

function renderMcpServerBlock(options: { autoRefresh: boolean; launch: LaunchSpec; repoRoot: string; serverName: string; toolProfile: InitToolProfile }): string {
  const args = [...options.launch.args, "serve", options.repoRoot];
  args.push(options.autoRefresh ? "--auto-refresh" : "--no-auto-refresh");
  const toolProfileLines =
    options.toolProfile === "core"
      ? [
          "# Core profile (default): fewer exposed tools means less per-turn schema cost and better routing.",
          `# Re-run \`codexa init --tools full\` to expose every tool.`,
          `enabled_tools = [${CORE_PROFILE_TOOL_NAMES.map(tomlString).join(", ")}]`
        ]
      : [`# Full profile: every tool is exposed. \`codexa init\` (core default) exposes only ${CORE_PROFILE_TOOL_NAMES.join(", ")} to cut per-turn token cost.`];
  const refreshCommand = options.toolProfile === "core" ? "codexa init" : "codexa init --tools full";
  return [
    "# >>> codexa managed",
    `# Re-run \`${refreshCommand}\` from this repository to refresh this block.`,
    `[mcp_servers.${options.serverName}]`,
    `command = ${tomlString(options.launch.command)}`,
    `args = [${args.map(tomlString).join(", ")}]`,
    "startup_timeout_sec = 20",
    "tool_timeout_sec = 60",
    ...toolProfileLines,
    "# <<< codexa managed"
  ].join("\n");
}

// Repo-root .mcp.json is Claude Code's project-scope MCP config and is a
// shared, often-committed file: only the codexa entry is managed; every
// other server entry and unknown top-level key is preserved verbatim.
// Malformed JSON aborts instead of being silently replaced.
async function upsertClaudeMcpConfig(
  mcpPath: string,
  options: {
    autoRefresh: boolean;
    launch: LaunchSpec;
    repoRoot: string;
    serverName: string;
    toolProfile: InitToolProfile;
  }
): Promise<void> {
  const existing = await readTextIfExists(mcpPath);
  const parsed = existing.trim() ? parseHooksJson(existing, mcpPath) : {};
  const servers = isPlainObject(parsed.mcpServers) ? { ...parsed.mcpServers } : {};
  for (const [name, entry] of Object.entries(servers)) {
    if (name === options.serverName || isCodexaMcpJsonEntry(entry)) {
      delete servers[name];
    }
  }
  const args = [...options.launch.args, "serve", options.repoRoot];
  args.push(options.autoRefresh ? "--auto-refresh" : "--no-auto-refresh");
  if (options.toolProfile === "core") {
    args.push("--tools", "core");
  }
  servers[options.serverName] = {
    command: options.launch.command,
    args
  };
  await writeFile(mcpPath, `${JSON.stringify({ ...parsed, mcpServers: servers }, null, 2)}\n`, "utf8");
}

// Only delete entries that are recognizably a codexa launch: the token
// immediately before the standalone "serve" arg must be the codexa binary,
// package, or CLI bundle. A loose substring match would also delete user
// servers that merely mention "codexa" somewhere in a path plus a serve.js.
function isCodexaMcpJsonEntry(entry: unknown): boolean {
  if (!isPlainObject(entry)) {
    return false;
  }
  const command = typeof entry.command === "string" ? entry.command : "";
  const args = Array.isArray(entry.args) ? entry.args.filter((value): value is string => typeof value === "string") : [];
  const serveIndex = args.indexOf("serve");
  if (serveIndex === -1) {
    return false;
  }
  const launcherToken = serveIndex === 0 ? command : args[serveIndex - 1];
  return isCodexaLauncherToken(launcherToken);
}

function isCodexaLauncherToken(token: string | undefined): boolean {
  if (!token) {
    return false;
  }
  return (
    token === "codexa" ||
    /^@mirnoorata\/codexa(?:@[^\s]*)?$/u.test(token) ||
    /[\\/]codexa[\\/]dist[\\/]cli\.js$/u.test(token) ||
    /[\\/]@mirnoorata[\\/]codexa[\\/]dist[\\/]cli\.js$/u.test(token)
  );
}

const MANAGED_DOC_START = "<!-- >>> codexa managed -->";
const MANAGED_DOC_END = "<!-- <<< codexa managed -->";

// AGENTS.md (Codex) and CLAUDE.md (Claude Code) are different agent-instruction
// files read by different hosts, but the managed Codexa workflow block and its
// marker handling are identical for both.
async function upsertManagedDoc(repoRoot: string, fileName: string, serverName: string): Promise<string> {
  const docPath = path.join(repoRoot, fileName);
  const existing = await readTextIfExists(docPath);
  assertBalancedManagedDocMarkers(existing, docPath);
  const block = [
    MANAGED_DOC_START,
    `## Codexa (\`${serverName}\` MCP server)`,
    "",
    "Codexa serves evidence-backed repository context. Prefer it over raw grep for cross-file questions.",
    "",
    "- Orient: call `session_context` at session start; `search` when the target is unclear.",
    "- Before non-trivial edits: `task_brief`, then `change_plan` with `saveSnapshot=true`.",
    "- After edits: `post_edit_review` with the commands that actually ran; finish with `test_plan`.",
    "- Inspect: `impact` before API/rename/delete changes; `callers`/`callees` for graph evidence.",
    "",
    "Each tool description states its output cost; prefer the cheapest sufficient tool.",
    MANAGED_DOC_END
  ].join("\n");
  const stripped = stripManagedDocBlock(existing).replace(/\s+$/u, "");
  const next = stripped ? `${stripped}\n\n${block}\n` : `${block}\n`;
  await writeFile(docPath, next, "utf8");
  return docPath;
}

function stripManagedDocBlock(content: string): string {
  const lines = content.split(/\r?\n/);
  const kept: string[] = [];
  let skipping = false;
  for (const line of lines) {
    if (line.trim() === MANAGED_DOC_START) {
      skipping = true;
      continue;
    }
    if (line.trim() === MANAGED_DOC_END) {
      skipping = false;
      continue;
    }
    if (!skipping) {
      kept.push(line);
    }
  }
  return kept.join("\n");
}

// AGENTS.md / CLAUDE.md are hand-authored user content; a stray or unbalanced
// marker must abort instead of silently deleting everything after it.
function assertBalancedManagedDocMarkers(content: string, docPath: string): void {
  let skipping = false;
  for (const line of content.split(/\r?\n/)) {
    if (line.trim() === MANAGED_DOC_START) {
      if (skipping) {
        throw new Error(`Cannot update ${docPath}: nested '${MANAGED_DOC_START}' marker found; fix the file manually and re-run.`);
      }
      skipping = true;
    } else if (line.trim() === MANAGED_DOC_END) {
      if (!skipping) {
        throw new Error(`Cannot update ${docPath}: orphan '${MANAGED_DOC_END}' marker found; fix the file manually and re-run.`);
      }
      skipping = false;
    }
  }
  if (skipping) {
    throw new Error(`Cannot update ${docPath}: unterminated '${MANAGED_DOC_START}' marker found; fix the file manually and re-run.`);
  }
}

async function upsertHooksConfig(hooksPath: string, options: { cliPath: string; launch: LaunchSpec; repoRoot: string }): Promise<void> {
  const existing = await readTextIfExists(hooksPath);
  const parsed = existing.trim() ? parseHooksJson(existing, hooksPath) : {};
  const hooks = isPlainObject(parsed.hooks) ? parsed.hooks : {};
  const cleanedSessionStart = cleanHookList(hooks.SessionStart, options);
  const cleanedPreToolUse = cleanHookList(hooks.PreToolUse, options);
  const cleanedPostToolUse = cleanHookList(hooks.PostToolUse, options);
  const launchShell = [options.launch.command, ...options.launch.args.map(shellQuote)].join(" ");

  cleanedSessionStart.push({
    codexaManaged: true,
    matcher: "startup|resume",
    hooks: [
      {
        codexaManaged: true,
        type: "command",
        command: `${launchShell} session-start ${shellQuote(options.repoRoot)}`,
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
        command: `${launchShell} hook-pre-edit ${shellQuote(options.repoRoot)}`,
        statusMessage: "Saving Codexa pre-edit baseline",
        timeout: 10
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
        command: `${launchShell} hook-post-edit ${shellQuote(options.repoRoot)}`,
        statusMessage: "Running Codexa post-edit review",
        timeout: 90
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

async function removeCodexaManagedHooksConfig(hooksPath: string, options: { cliPath: string; repoRoot: string }): Promise<boolean> {
  const existing = await readTextIfExists(hooksPath);
  if (!existing.trim()) {
    await rm(hooksPath, { force: true });
    return false;
  }
  const parsed = parseHooksJson(existing, hooksPath);
  const hooks = isPlainObject(parsed.hooks) ? parsed.hooks : {};
  const cleanedHooks: Record<string, unknown> = { ...hooks };
  for (const key of ["SessionStart", "PreToolUse", "PostToolUse"]) {
    const cleaned = cleanHookList(hooks[key], options);
    if (cleaned.length > 0) {
      cleanedHooks[key] = cleaned;
    } else {
      delete cleanedHooks[key];
    }
  }
  const hasRemainingHooks = Object.values(cleanedHooks).some((value) => Array.isArray(value) && value.length > 0);
  if (!hasRemainingHooks) {
    await rm(hooksPath, { force: true });
    return false;
  }
  await writeFile(hooksPath, `${JSON.stringify({ ...parsed, hooks: cleanedHooks }, null, 2)}\n`, "utf8");
  return true;
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
  const trimmed = command.trim();
  if (/^codexa-sessionstart(?:\s|$)/u.test(trimmed) || /(?:^|\/)codexa-sessionstart-[^/\s]+\.sh(?:\s|$)/u.test(trimmed)) {
    return true;
  }
  // Pinned-npx form written when init ran from an evictable npx cache.
  if (/^npx\s+(?:'-y'|-y)\s+'?@mirnoorata\/codexa(?:@[^\s']*)?'?\s+(?:session-start|hook-pre-edit|hook-post-edit)(?:\s|$)/u.test(trimmed)) {
    return true;
  }
  for (const action of ["session-start", "hook-pre-edit", "hook-post-edit"]) {
    const generated = `node ${shellQuote(options.cliPath)} ${action} ${shellQuote(options.repoRoot)}`;
    const generatedUnquoted = `node ${options.cliPath} ${action} ${options.repoRoot}`;
    const generatedPrefix = `node ${shellQuote(options.cliPath)} ${action} `;
    const generatedUnquotedPrefix = `node ${options.cliPath} ${action} `;
    if (trimmed === generated || trimmed === generatedUnquoted || trimmed.startsWith(generatedPrefix) || trimmed.startsWith(generatedUnquotedPrefix)) {
      return true;
    }
  }
  return false;
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

function ensureHooksFeature(config: string): string {
  const lines = config.split(/\r?\n/);
  const featureStart = lines.findIndex((line) => line.trim() === "[features]");
  if (featureStart === -1) {
    return ["[features]", "hooks = true", "", ...lines].join("\n");
  }

  let sectionEnd = lines.length;
  for (let index = featureStart + 1; index < lines.length; index += 1) {
    const trimmed = lines[index].trim();
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      sectionEnd = index;
      break;
    }
  }

  let hooksLine = -1;
  let deprecatedLine = -1;
  for (let index = featureStart + 1; index < sectionEnd; index += 1) {
    const trimmed = lines[index].trim();
    if (/^hooks\s*=/u.test(trimmed)) {
      hooksLine = index;
    } else if (/^codex_hooks\s*=/u.test(trimmed)) {
      deprecatedLine = index;
    }
  }

  if (deprecatedLine !== -1) {
    lines.splice(deprecatedLine, 1);
    if (hooksLine > deprecatedLine) {
      hooksLine -= 1;
    }
  }

  if (hooksLine === -1) {
    const insertAt = deprecatedLine === -1 ? featureStart + 1 : deprecatedLine;
    lines.splice(insertAt, 0, "hooks = true");
  } else {
    lines[hooksLine] = "hooks = true";
  }
  return lines.join("\n");
}

function removeHooksFeature(config: string): string {
  const lines = config.split(/\r?\n/);
  const featureStart = lines.findIndex((line) => line.trim() === "[features]");
  if (featureStart === -1) {
    return config;
  }

  let sectionEnd = lines.length;
  for (let index = featureStart + 1; index < lines.length; index += 1) {
    const trimmed = lines[index].trim();
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      sectionEnd = index;
      break;
    }
  }

	  return lines
	    .filter((line, index) => index <= featureStart || index >= sectionEnd || !/^(?:codex_)?hooks\s*=/u.test(line.trim()))
	    .join("\n");
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
