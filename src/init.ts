import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { assertCiWorkflowWritable, writeCiWorkflow } from "./ci-workflow.js";
import { buildIndexLocked } from "./indexer.js";
import {
  defaultServerName,
  detectExistingServerName,
  assertSafeManagedDirectory,
  assertSafeManagedFile,
  ensureSafeManagedStateDirectory,
  inspectClaudeMcpConfig,
  isCodexaMcpJsonEntry,
  isGitTracked,
  portableRepoArg,
  resolveGitRepoRoot,
  writeTextIfChanged,
  type ExistingClaudeMcpConfig
} from "./init-portability.js";
import { CORE_PROFILE_TOOL_NAMES } from "./mcp-tool-catalog.js";
import { pinnableNodeExecPath } from "./node-version.js";
import { assertPolicyPackWritable, initializePolicyPack } from "./policy-pack.js";
import type { InitOptions, InitResult, InitToolProfile } from "./types/init.js";
import { CODEXA_VERSION } from "./version.js";

export type { InitOptions, InitResult, InitToolProfile } from "./types/init.js";
export { renderSessionStartJson, renderSessionStartReceipt, SESSION_START_JSON_MAX_BYTES, sessionStartReceipt, sessionStartStrictFailures, sessionStartSummary } from "./session-start.js";
export type { SessionStartConfigState, SessionStartIndexState, SessionStartOptions, SessionStartReceipt, SessionStartToolProfile } from "./session-start.js";

const EDIT_HOOK_MATCHER = "Edit|MultiEdit|Write|NotebookEdit|apply_patch";

interface LaunchSpec {
  command: string;
  args: string[];
  pinnedNpx: boolean;
}

// An ephemeral runner cache path (npm's ~/.npm/_npx/<hash>/…, pnpm's
// …/pnpm/dlx/<hash>/…, yarn's $TMP/xfs-<hash>/dlx-<pid>/…) is evicted on
// cache prune or reboot; baking it into MCP config breaks server startup
// weeks later with no visible cause. Pin the published package version
// instead so the config stays launchable.
function resolveLaunchSpec(cliPath: string): LaunchSpec {
  // The yarn shape requires BOTH segments (xfs-<hex>/dlx-<id>): matching
  // a bare "dlx-" directory would mis-pin ordinary local installs that
  // happen to live under a dlx-named folder.
  const ephemeral = /[\\/]_npx[\\/]/u.test(cliPath) || /[\\/]pnpm[\\/]dlx[\\/]/u.test(cliPath) || /[\\/]xfs-[0-9a-f]+[\\/]dlx-[^\\/]+[\\/]/u.test(cliPath);
  if (ephemeral) {
    return { command: "npx", args: ["-y", `@mirnoorata/codexa@${CODEXA_VERSION}`], pinnedNpx: true };
  }
  return { command: "node", args: [cliPath], pinnedNpx: false };
}

// Pin the running interpreter only into untracked host-local wiring: an
// absolute path in a tracked file breaks other checkouts and leaks private
// home paths, so tracked wiring keeps PATH-"node" + the serve version guard.
function pinNodeLaunch(launch: LaunchSpec, repoRoot: string, targetRelPath: string): LaunchSpec {
  const execPath = launch.command === "node" ? pinnableNodeExecPath() : null;
  if (!execPath || isGitTracked(repoRoot, targetRelPath)) {
    return launch;
  }
  return { ...launch, command: execPath };
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
  const cliPath = path.resolve(options.cliPath);
  const launch = resolveLaunchSpec(cliPath);
  const configPath = path.join(codexDir, "config.toml");
  const hooksPath = path.join(codexDir, "hooks.json");
  const claudeMcpPath = options.claude ? path.join(repoRoot, ".mcp.json") : null;
  await assertSafeManagedDirectory(codexDir);
  const existingConfig = await readManagedTextIfExists(configPath);
  await assertSafeManagedFile(hooksPath);
  // Parse requested shared JSON before touching any other wiring so a bad
  // tracked file cannot leave a one-time portability migration half-applied.
  const existingClaudeMcp = claudeMcpPath ? inspectClaudeMcpConfig(await readManagedTextIfExists(claudeMcpPath), claudeMcpPath) : null;
  const serverName = validateServerName(
    options.serverName ?? detectExistingServerName(existingConfig) ?? existingClaudeMcp?.serverName ?? defaultServerName(repoRoot)
  );
  const writeHooks = options.hooks ?? true;
  const toolProfile = options.toolProfile ?? detectExistingToolProfile(existingConfig) ?? existingClaudeMcp?.toolProfile ?? "core";
  const autoRefresh = options.autoRefresh ?? true;

  if (options.policyPack) {
    await assertPolicyPackWritable(repoRoot);
  }
  if (options.ci) {
    await assertCiWorkflowWritable(repoRoot);
  }
  await mkdir(codexDir, { recursive: true });
  await assertSafeManagedDirectory(codexDir);
  await ensureSafeManagedStateDirectory(repoRoot, "cache");
  const hookOptions = {
    cliPath,
    launch: pinNodeLaunch(launch, repoRoot, path.join(".codex", "hooks.json")),
    repoArg: portableRepoArg(repoRoot, path.join(".codex", "hooks.json")),
    repoRoot
  };
  const configOptions = {
    autoRefresh,
    cliPath,
    launch: pinNodeLaunch(launch, repoRoot, path.join(".codex", "config.toml")),
    repoArg: portableRepoArg(repoRoot, path.join(".codex", "config.toml")),
    repoRoot,
    serverName,
    toolProfile
  };

  if (writeHooks) {
    await upsertHooksConfig(hooksPath, hookOptions);
    // Codex only exposes an edit-scoped PostToolUse hook here. It can review
    // the just-written dirty tree, but it runs before later shell verification
    // and is not a completion/Stop gate. Keep the MCP server unmarked so the
    // saved plan still offers one final post_edit_review after verification.
    await upsertCodexConfig(configPath, { ...configOptions, hooksFeature: true });
  } else {
    const removal = await planCodexaManagedHooksRemoval(hooksPath, hookOptions);
    if (removal.keepHooksFeature) {
      // Preserve host hook execution before removing only Codexa entries.
      // A later hooks-file conflict leaves user hooks enabled.
      await upsertCodexConfig(configPath, { ...configOptions, hooksFeature: true });
      await applyCodexaManagedHooksRemoval(hooksPath, removal);
    } else {
      // Disabling hooks is safe only after the guarded removal commits. If a
      // concurrent writer adds a user hook, the stale snapshot rejects before
      // config.toml can make that unchanged hook inert.
      await applyCodexaManagedHooksRemoval(hooksPath, removal);
      await upsertCodexConfig(configPath, { ...configOptions, hooksFeature: false });
    }
  }

  const agentsMdPath = options.agentsMd ? await upsertManagedDoc(repoRoot, "AGENTS.md", serverName) : null;
  const claudeMdPath = options.claudeMd ? await upsertManagedDoc(repoRoot, "CLAUDE.md", serverName) : null;
  if (claudeMcpPath && existingClaudeMcp) {
    await upsertClaudeMcpConfig(claudeMcpPath, existingClaudeMcp, {
      autoRefresh,
      launch,
      repoArg: portableRepoArg(repoRoot, ".mcp.json"),
      repoRoot,
      serverName,
      toolProfile
    });
  }

  const ciWorkflowPath = options.ci ? await writeCiWorkflow(repoRoot, CODEXA_VERSION) : null;
  const indexed =
    options.index === false
      ? null
      : summarizeIndex(await buildIndexLocked({ repoRoot, writeArtifacts: true }));
  const policyPack = options.policyPack ? await initializePolicyPack(repoRoot) : null;

  return {
    repoRoot,
    configPath,
    hooksPath: writeHooks ? hooksPath : null,
    agentsMdPath,
    claudeMdPath,
    claudeMcpPath,
    policyPack,
    ciWorkflowPath,
    serverName,
    launchNote: launch.pinnedNpx
      ? `Codexa CLI resolved inside the evictable npx cache; generated configs pin "npx -y @mirnoorata/codexa@${CODEXA_VERSION}" instead of the cache path.`
      : null,
    indexed
  };
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
  const gitRoot = resolveGitRepoRoot(candidate);
  if (!gitRoot) {
    throw new Error(`Codexa init requires a git repository: ${candidate}`);
  }
  return gitRoot;
}

async function upsertCodexConfig(
  configPath: string,
  options: {
    autoRefresh: boolean;
    cliPath: string;
    launch: LaunchSpec;
    repoArg?: string;
    repoRoot: string;
    serverName: string;
    hooksFeature: boolean;
    toolProfile: InitToolProfile;
  }
): Promise<void> {
  const existing = await readManagedTextIfExists(configPath);
  let next = stripManagedBlocks(existing);
  // Legacy detection keys on the real CLI path, never on launch args like
  // "-y", which would also match unrelated npx-launched server blocks.
  next = removeCodexaMcpServerBlocks(next, { cliPath: options.cliPath, repoRoot: options.repoRoot });
  next = removeMcpServerBlock(next, options.serverName);
  if (options.hooksFeature) {
    next = ensureHooksFeature(next);
  } else {
    next = removeHooksFeature(next);
  }
  next = trimTrailingBlankLines(next);
  if (next) {
    next += "\n\n";
  }
  next += renderMcpServerBlock(options);
  await writeTextIfChanged(configPath, existing, `${next}\n`);
}

function renderMcpServerBlock(options: { autoRefresh: boolean; launch: LaunchSpec; repoArg?: string; repoRoot: string; serverName: string; hooksFeature: boolean; toolProfile: InitToolProfile }): string {
  const args = [...options.launch.args, "serve"];
  if (options.repoArg) {
    args.push(options.repoArg);
  }
  args.push(options.autoRefresh ? "--auto-refresh" : "--no-auto-refresh");
  // Keep every generated profile explicit so checked-in config records the
  // intended exposure even though bare `serve` now defaults to core.
  args.push("--tools", options.toolProfile);
  const toolProfileLines =
    options.toolProfile === "core"
      ? [
          "# Core profile (default): fewer exposed tools means a smaller serialized tool-schema payload and simpler routing.",
          `# Re-run \`codexa init --tools full\` to expose every tool.`,
          `enabled_tools = [${CORE_PROFILE_TOOL_NAMES.map(tomlString).join(", ")}]`
        ]
      : [`# Full profile: every tool is exposed. \`codexa init\` (core default) exposes only ${CORE_PROFILE_TOOL_NAMES.join(", ")} to shrink the serialized tool-schema payload.`];
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
  existingConfig: ExistingClaudeMcpConfig,
  options: {
    autoRefresh: boolean;
    launch: LaunchSpec;
    repoArg?: string;
    repoRoot: string;
    serverName: string;
    toolProfile: InitToolProfile;
  }
): Promise<void> {
  const { contents: existing, parsed } = existingConfig;
  const servers = isPlainObject(parsed.mcpServers) ? { ...parsed.mcpServers } : {};
  for (const [name, entry] of Object.entries(servers)) {
    if (name === options.serverName || isCodexaMcpJsonEntry(entry)) {
      delete servers[name];
    }
  }
  const args = [...options.launch.args, "serve"];
  if (options.repoArg) {
    args.push(options.repoArg);
  }
  args.push(options.autoRefresh ? "--auto-refresh" : "--no-auto-refresh");
  args.push("--tools", options.toolProfile);
  servers[options.serverName] = {
    command: options.launch.command,
    args
  };
  await writeTextIfChanged(mcpPath, existing, `${JSON.stringify({ ...parsed, mcpServers: servers }, null, 2)}\n`);
}

// Only delete entries that are recognizably a codexa launch: the token
// immediately before the standalone "serve" arg must be the codexa binary,
// package, or CLI bundle. A loose substring match would also delete user
// servers that merely mention "codexa" somewhere in a path plus a serve.js.
const MANAGED_DOC_START = "<!-- >>> codexa managed -->";
const MANAGED_DOC_END = "<!-- <<< codexa managed -->";

// AGENTS.md (Codex) and CLAUDE.md (Claude Code) are different agent-instruction
// files read by different hosts, but the managed Codexa workflow block and its
// marker handling are identical for both.
async function upsertManagedDoc(repoRoot: string, fileName: string, serverName: string): Promise<string> {
  const docPath = path.join(repoRoot, fileName);
  const existing = await readManagedTextIfExists(docPath);
  assertBalancedManagedDocMarkers(existing, docPath);
  const block = [
    MANAGED_DOC_START,
    `## Codexa (\`${serverName}\` MCP server)`,
    "",
    "Codexa serves bounded, evidence-backed repository context when it saves more exploration than it costs.",
    "",
    "- Exact file/symbol/error, read-only check, or small local edit: use source tools and tests directly with zero Codexa calls.",
    "- Ambiguous target: call `search` once; when raw evidence is sufficient, stop Codexa and read the exact hits.",
    "- Non-trivial multi-file or high-risk edit: call `change_plan` with `saveSnapshot=true`, then edit and run its planned verification.",
    "- After planned verification, call `post_edit_review` once unless a true completion/Stop gate already owns final review, or when the user explicitly requests a formal review.",
    "- Do not stack `session_context`, `search`, and `task_brief`; normal agentic work usually needs no more than two Codexa calls. The only three-call safety exception is an ambiguous materially risky edit without a completion/Stop gate.",
    "- Call `test_plan` only when verification guidance remains unresolved; call `proof_card` only for policy, formal audit, release, or artifact handoff proof.",
    "- Inspect: use `capabilities` only for a concretely triggered non-core operation; full mode exposes every operation directly.",
    "",
    "Each tool description states its output cost; prefer the cheapest sufficient tool.",
    MANAGED_DOC_END
  ].join("\n");
  const stripped = stripManagedDocBlock(existing).replace(/\s+$/u, "");
  const next = stripped ? `${stripped}\n\n${block}\n` : `${block}\n`;
  await writeTextIfChanged(docPath, existing, next);
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

async function upsertHooksConfig(hooksPath: string, options: { cliPath: string; launch: LaunchSpec; repoArg?: string; repoRoot: string }): Promise<void> {
  const existing = await readManagedTextIfExists(hooksPath);
  const parsed = existing.trim() ? parseHooksJson(existing, hooksPath) : {};
  const hooks = isPlainObject(parsed.hooks) ? parsed.hooks : {};
  const cleanedSessionStart = cleanHookList(hooks.SessionStart, options);
  const cleanedPreToolUse = cleanHookList(hooks.PreToolUse, options);
  const cleanedPostToolUse = cleanHookList(hooks.PostToolUse, options);
  // Quote a pinned interpreter path only when it needs it; a bare command
  // name must stay unquoted so legacy entry matching keeps working.
  const launchCommand = /[\s'"\\]/u.test(options.launch.command) ? shellQuote(options.launch.command) : options.launch.command;
  const launchShell = [launchCommand, ...options.launch.args.map(shellQuote)].join(" ");

  cleanedSessionStart.push({
    codexaManaged: true,
    matcher: "startup|resume",
    hooks: [
      {
        codexaManaged: true,
        type: "command",
        command: renderHookCommand(launchShell, "session-start", options.repoArg),
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
        command: renderHookCommand(launchShell, "hook-pre-edit", options.repoArg),
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
        command: renderHookCommand(launchShell, "hook-post-edit", options.repoArg),
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
  await writeTextIfChanged(hooksPath, existing, `${JSON.stringify(next, null, 2)}\n`);
}

function renderHookCommand(launchShell: string, action: string, repoArg: string | undefined): string {
  return repoArg ? `${launchShell} ${action} ${shellQuote(repoArg)}` : `${launchShell} ${action}`;
}

interface CodexaManagedHooksRemoval {
  keepHooksFeature: boolean;
  original: string;
  contents: string;
}

async function planCodexaManagedHooksRemoval(hooksPath: string, options: { cliPath: string; repoRoot: string }): Promise<CodexaManagedHooksRemoval> {
  const existing = await readManagedTextIfExists(hooksPath);
  if (!existing.trim()) {
    return { keepHooksFeature: false, original: existing, contents: existing };
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
  const next = { ...parsed };
  if (Object.keys(cleanedHooks).length > 0) next.hooks = cleanedHooks;
  else delete next.hooks;
  return {
    keepHooksFeature: hasRemainingHooks,
    original: existing,
    contents: `${JSON.stringify(next, null, 2)}\n`
  };
}

async function applyCodexaManagedHooksRemoval(hooksPath: string, removal: CodexaManagedHooksRemoval): Promise<void> {
  await writeTextIfChanged(hooksPath, removal.original, removal.contents);
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
    const generatedPortable = `node ${shellQuote(options.cliPath)} ${action}`;
    const generatedPortableUnquoted = `node ${options.cliPath} ${action}`;
    const generatedPrefix = `node ${shellQuote(options.cliPath)} ${action} `;
    const generatedUnquotedPrefix = `node ${options.cliPath} ${action} `;
    if (
      trimmed === generated ||
      trimmed === generatedUnquoted ||
      trimmed === generatedPortable ||
      trimmed === generatedPortableUnquoted ||
      trimmed.startsWith(generatedPrefix) ||
      trimmed.startsWith(generatedUnquotedPrefix)
    ) {
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

async function readManagedTextIfExists(filePath: string): Promise<string> {
  await assertSafeManagedFile(filePath);
  return readTextIfExists(filePath);
}

function trimTrailingBlankLines(value: string): string {
  return value.replace(/\s+$/u, "");
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
