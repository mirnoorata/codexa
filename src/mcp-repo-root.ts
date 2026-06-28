import { promises as fs } from "node:fs";
import path from "node:path";
import { runCommand } from "./command.js";

export interface McpRepoRootResolutionOptions {
  workspaceFocusFile?: string;
  workspaceSessionId?: string;
  preferConfiguredRoot?: boolean;
}

export interface McpRepoRootResolution {
  configuredRoot: string;
  repoRoot: string;
  source: "configured-root" | "environment" | "workspace-focus-file";
  focusFile?: string;
  focusReason?: "selected-session" | "explicit-focus" | "active-session" | "workspace-default" | "environment";
  workspaceSessionId?: string;
  warnings?: string[];
}

interface CandidateRepoRoot {
  path: string;
  source: McpRepoRootResolution["source"];
  focusFile?: string;
  focusReason?: McpRepoRootResolution["focusReason"];
  workspaceSessionId?: string;
  strict?: boolean;
  warnings?: string[];
}

interface FocusFileRepoSelection {
  paths: string[];
  focusReason?: McpRepoRootResolution["focusReason"];
  workspaceSessionId?: string;
  strict: boolean;
  warnings: string[];
}

const FOCUSED_REPO_LINE_PATTERN = /\bfocused\s+(?:project|repo|repository)\s*:\s*(?:`([^`]+)`|([^\r\n#]+))/iu;
const DEFAULT_REPO_LINE_PATTERN = /\bdefault\s+(?:repo|repository)\s*:\s*(?:`([^`]+)`|([^\r\n#|]+))/iu;
const ACTIVE_PROJECT_FOCUS_LINE_PATTERN = /\bactive\s+project\s+focus\s*:/iu;
const ACTIVE_PROJECT_FOCUS_REPO_PATTERN = /\b(?:via\s+)?(?:repo|repository)\s*:?\s*(?:`(\/[^`]+)`|(\/[^\s#|.,;:]+))/iu;
const ACTIVE_PROJECT_FOCUS_DIRECT_PATH_PATTERN = /\bactive\s+project\s+focus\s*:\s*(?:`(\/[^`]+)`|(\/[^\s#|.,;:]+))\s*$/iu;
const COMPACT_PROJECT_LINE_PATTERN = /^\s*(?:[-*]\s*)?project\s*:\s*(?:`([^`]+)`|([^\r\n#]+))/iu;
const HEADING_PATTERN = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/u;
const INACTIVE_SESSION_STATUSES = new Set(["done", "stale", "parked", "merged", "superseded", "removed", "shipped", "shipped+live", "live", "released", "closed", "abandoned"]);
const TERMINAL_SESSION_STATUS_TOKENS = new Set(["done", "stale", "parked", "merged", "superseded", "removed", "shipped", "released", "closed", "abandoned"]);
const ACTIVE_SESSION_STATUS_TOKENS = new Set(["active", "dirty", "open", "pr", "review", "verified", "wip"]);

export async function shouldPreferConfiguredRepoRoot(configuredRootInput: string, options: McpRepoRootResolutionOptions = {}): Promise<boolean> {
  const configuredRoot = path.resolve(configuredRootInput);
  if (options.workspaceFocusFile || options.workspaceSessionId) {
    return false;
  }
  if ((await gitRootFor(configuredRoot)) === null) {
    return false;
  }
  return !(await localWorkspaceFocusOverridesConfiguredRoot(configuredRoot));
}

export async function resolveMcpRepoRoot(configuredRootInput: string, options: McpRepoRootResolutionOptions = {}): Promise<McpRepoRootResolution> {
  const configuredRoot = path.resolve(configuredRootInput);
  const configuredRootIsGitRepo = (await gitRootFor(configuredRoot)) !== null;
  const workspaceRoutingRequested = Boolean(options.workspaceFocusFile || options.workspaceSessionId);

  if (configuredRootIsGitRepo && options.preferConfiguredRoot && !workspaceRoutingRequested) {
    return { configuredRoot, repoRoot: configuredRoot, source: "configured-root" };
  }

  for await (const candidate of focusFileRepoCandidates(configuredRoot, options)) {
    const repoRoot = await validatedRepoRoot(candidate);
    const insideConfiguredRoot = repoRoot ? await isInsideOrSamePath(repoRoot, configuredRoot) : false;
    if (repoRoot && insideConfiguredRoot) {
      return {
        configuredRoot,
        repoRoot,
        source: candidate.source,
        focusFile: candidate.focusFile,
        focusReason: candidate.focusReason,
        workspaceSessionId: candidate.workspaceSessionId,
        warnings: candidate.warnings
      };
    }
    if (candidate.strict) {
      throw new Error(
        `Codexa MCP workspace session${candidate.workspaceSessionId ? ` ${candidate.workspaceSessionId}` : ""} resolved to an invalid or out-of-workspace repo in ${candidate.focusFile ?? "workspace focus"}: ${candidate.path}`
      );
    }
  }

  if (configuredRootIsGitRepo) {
    return { configuredRoot, repoRoot: configuredRoot, source: "configured-root" };
  }

  for (const candidate of environmentRepoCandidates()) {
    const repoRoot = await validatedRepoRoot(candidate);
    if (repoRoot) {
      return { configuredRoot, repoRoot, source: candidate.source, focusReason: "environment" };
    }
  }

  const focusFiles = focusFileCandidates(configuredRoot, options).map((file) => path.resolve(file));
  const focusHint =
    focusFiles.length > 0
      ? ` Add an "Active Focus" project line or "Focused project: /absolute/path/to/repo" to ${focusFiles.join(" or ")}.`
      : "";
  throw new Error(
    `Codexa MCP configured root is not a git repository and no focused git repository could be resolved: ${configuredRoot}. Set CODEXA_REPO or CODEXA_FOCUSED_REPO to a git repository.${focusHint}`
  );
}

function environmentRepoCandidates(): CandidateRepoRoot[] {
  return [process.env.CODEXA_REPO, process.env.CODEXA_FOCUSED_REPO]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .map((value) => ({ path: value, source: "environment" }));
}

async function* focusFileRepoCandidates(configuredRoot: string, options: McpRepoRootResolutionOptions): AsyncGenerator<CandidateRepoRoot> {
  for (const focusFile of focusFileCandidates(configuredRoot, options)) {
    const focusFilePath = path.resolve(focusFile);
    const selection = await readFocusedRepoPaths(focusFilePath, options, configuredRoot);
    for (const repoPath of selection.paths) {
      yield {
        path: repoPath,
        source: "workspace-focus-file",
        focusFile: focusFilePath,
        focusReason: selection.focusReason,
        workspaceSessionId: selection.workspaceSessionId,
        strict: selection.strict,
        warnings: selection.warnings
      };
    }
  }
}

function focusFileCandidates(configuredRoot: string, options: McpRepoRootResolutionOptions): string[] {
  const candidates = [
    options.workspaceFocusFile,
    options.workspaceSessionId ? undefined : process.env.CODEXA_WORKSPACE_FOCUS_FILE,
    path.join(configuredRoot, ".codex", "WORKING.md")
  ].filter((value): value is string => typeof value === "string" && value.trim().length > 0);
  return [...new Set(candidates.map((candidate) => path.resolve(candidate)))];
}

async function readFocusedRepoPaths(focusFile: string, options: McpRepoRootResolutionOptions, configuredRoot?: string): Promise<FocusFileRepoSelection> {
  let text: string;
  try {
    text = await fs.readFile(focusFile, "utf8");
  } catch {
    return emptyFocusFileSelection();
  }

  const workspaceSessionId = normalizeWorkspaceSessionId(options.workspaceSessionId ?? process.env.CODEXA_WORKSPACE_SESSION);
  const selectedSessionPaths: string[] = [];
  const explicitPaths: string[] = [];
  const activeSessionPaths: string[] = [];
  const defaultPaths: string[] = [];
  let inActiveFocusSection = false;
  let inActiveSessionsSection = false;
  let activeSessionSessionColumn = -1;
  let activeSessionRepoColumn = -1;
  let activeSessionStatusColumn = -1;
  for (const line of text.split(/\r?\n/u)) {
    const heading = HEADING_PATTERN.exec(line);
    if (heading) {
      const headingText = heading[1].trim().toLowerCase();
      inActiveFocusSection = headingText === "active focus";
      inActiveSessionsSection = headingText === "active sessions";
      activeSessionSessionColumn = -1;
      activeSessionRepoColumn = -1;
      activeSessionStatusColumn = -1;
      continue;
    }

    const focusedMatch = FOCUSED_REPO_LINE_PATTERN.exec(line);
    if (focusedMatch) {
      pushFocusedRepoPath(explicitPaths, focusedMatch[1] ?? focusedMatch[2] ?? "");
      continue;
    }

    const activeProjectFocusPath = activeProjectFocusPathFromLine(line);
    if (activeProjectFocusPath) {
      pushFocusedRepoPath(explicitPaths, activeProjectFocusPath);
      continue;
    }

    const defaultRepoMatch = DEFAULT_REPO_LINE_PATTERN.exec(line);
    if (defaultRepoMatch) {
      pushFocusedRepoPath(defaultPaths, defaultRepoMatch[1] ?? defaultRepoMatch[2] ?? "");
      continue;
    }

    if (inActiveFocusSection) {
      const projectMatch = COMPACT_PROJECT_LINE_PATTERN.exec(line);
      if (projectMatch) {
        pushFocusedRepoPath(explicitPaths, projectMatch[1] ?? projectMatch[2] ?? "");
      }
    }
    if (inActiveSessionsSection) {
      const cells = markdownTableCells(line);
      if (!cells) {
        continue;
      }
      if (isMarkdownSeparatorRow(cells)) {
        continue;
      }
      const lowerCells = cells.map((cell) => cell.trim().toLowerCase());
      const repoColumn = lowerCells.indexOf("repo");
      if (repoColumn >= 0) {
        activeSessionSessionColumn = lowerCells.indexOf("session");
        activeSessionRepoColumn = repoColumn;
        activeSessionStatusColumn = lowerCells.indexOf("status");
        continue;
      }
      if (activeSessionRepoColumn >= 0 && activeSessionRepoColumn < cells.length) {
        const status = activeSessionStatusColumn >= 0 ? cells[activeSessionStatusColumn]?.trim().toLowerCase() : "";
        if (isActiveSessionStatus(status)) {
          pushFocusedRepoPath(activeSessionPaths, cells[activeSessionRepoColumn] ?? "");
          if (workspaceSessionId && activeSessionSessionColumn >= 0 && normalizeWorkspaceSessionId(cells[activeSessionSessionColumn] ?? "") === workspaceSessionId) {
            pushFocusedRepoPath(selectedSessionPaths, cells[activeSessionRepoColumn] ?? "");
          }
        }
      }
    }
  }
  if (workspaceSessionId && selectedSessionPaths.length === 0) {
    throw new Error(`Codexa MCP workspace session ${workspaceSessionId} is not active in ${path.resolve(focusFile)}`);
  }
  const defaultPathGroups = await partitionDefaultPaths(defaultPaths, configuredRoot);
  return firstUnambiguousPriority(
    [
      { paths: selectedSessionPaths, focusReason: "selected-session", allowFallbackWhenAmbiguous: false, strict: true, workspaceSessionId },
      { paths: explicitPaths, focusReason: "explicit-focus", allowFallbackWhenAmbiguous: false, strict: false, conflictPaths: [...defaultPathGroups.focused, ...activeSessionPaths] },
      { paths: defaultPathGroups.focused, focusReason: "workspace-default", allowFallbackWhenAmbiguous: false, strict: false, conflictPaths: [...explicitPaths, ...activeSessionPaths] },
      { paths: activeSessionPaths, focusReason: "active-session", allowFallbackWhenAmbiguous: false, strict: false },
      { paths: defaultPathGroups.configuredRoot, focusReason: "workspace-default", allowFallbackWhenAmbiguous: false, strict: false }
    ],
    focusFile,
    configuredRoot
  );
}

function emptyFocusFileSelection(): FocusFileRepoSelection {
  return { paths: [], strict: false, warnings: [] };
}

function activeProjectFocusPathFromLine(line: string): string | undefined {
  if (!ACTIVE_PROJECT_FOCUS_LINE_PATTERN.test(line)) {
    return undefined;
  }
  const repoMatch = ACTIVE_PROJECT_FOCUS_REPO_PATTERN.exec(line);
  if (repoMatch) {
    return repoMatch[1] ?? repoMatch[2];
  }
  const directPathMatch = ACTIVE_PROJECT_FOCUS_DIRECT_PATH_PATTERN.exec(line);
  return directPathMatch?.[1] ?? directPathMatch?.[2];
}

function pushFocusedRepoPath(paths: string[], raw: string): void {
  const cleaned = raw.trim().replace(/^`|`$/gu, "").replace(/[.,;:]+$/u, "");
  if (cleaned) {
    paths.push(cleaned);
  }
}

function uniquePaths(paths: string[]): string[] {
  return [...new Set(paths)];
}

async function firstUnambiguousPriority(
  groups: Array<{
    paths: string[];
    focusReason: McpRepoRootResolution["focusReason"];
    allowFallbackWhenAmbiguous: boolean;
    strict: boolean;
    workspaceSessionId?: string;
    conflictPaths?: string[];
  }>,
  focusFile: string,
  configuredRoot?: string
): Promise<FocusFileRepoSelection> {
  let deferredAmbiguity: { focusReason: McpRepoRootResolution["focusReason"]; paths: string[] } | null = null;
  const warnings: string[] = [];
  for (const group of groups) {
    const paths = uniquePaths(group.paths);
    if (paths.length === 0) {
      continue;
    }
    const normalized = uniquePaths(paths.map((entry) => normalizeCandidatePath(entry)).filter((entry): entry is string => Boolean(entry)));
    if (normalized.length > 1) {
      if (group.allowFallbackWhenAmbiguous) {
        deferredAmbiguity = deferredAmbiguity ?? { focusReason: group.focusReason, paths: normalized };
        warnings.push(`Codexa MCP ${group.focusReason ?? "workspace"} focus is ambiguous in ${path.resolve(focusFile)}: ${normalized.join(", ")}. Falling back to lower-priority focus.`);
        continue;
      }
      throw new Error(`Codexa MCP workspace focus is ambiguous in ${path.resolve(focusFile)}: ${normalized.join(", ")}`);
    }
    const conflictingWorkspaceRoots = group.conflictPaths ? await conflictingWorkspaceRepoRoots(normalized[0], group.conflictPaths, configuredRoot) : [];
    if (conflictingWorkspaceRoots.length > 0) {
      throw new Error(
        `Codexa MCP workspace focus is ambiguous in ${path.resolve(focusFile)}: ${uniquePaths([normalized[0], ...conflictingWorkspaceRoots]).join(", ")}. Set CODEXA_WORKSPACE_SESSION or pass --workspace-session to select the current session.`
      );
    }
    return {
      paths,
      focusReason: group.focusReason,
      workspaceSessionId: group.workspaceSessionId,
      strict: group.strict,
      warnings
    };
  }
  if (deferredAmbiguity) {
    throw new Error(`Codexa MCP workspace focus is ambiguous in ${path.resolve(focusFile)}: ${deferredAmbiguity.paths.join(", ")}`);
  }
  return { paths: [], strict: false, warnings };
}

async function conflictingWorkspaceRepoRoots(candidatePath: string, conflictPaths: string[], configuredRoot?: string): Promise<string[]> {
  const candidateRepoRoot = await validatedRepoRoot({ path: candidatePath, source: "workspace-focus-file" });
  if (!candidateRepoRoot || (configuredRoot && !(await isInsideOrSamePath(candidateRepoRoot, configuredRoot)))) {
    return [];
  }
  const conflicts: string[] = [];
  for (const conflictPath of uniquePaths(conflictPaths)) {
    const conflictRepoRoot = await validatedRepoRoot({ path: conflictPath, source: "workspace-focus-file" });
    if (!conflictRepoRoot || (configuredRoot && !(await isInsideOrSamePath(conflictRepoRoot, configuredRoot)))) {
      continue;
    }
    if (!(await isSamePath(conflictRepoRoot, candidateRepoRoot))) {
      conflicts.push(conflictRepoRoot);
    }
  }
  return uniquePaths(conflicts.map((entry) => path.resolve(entry)));
}

function markdownTableCells(line: string): string[] | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|") || !trimmed.endsWith("|")) {
    return null;
  }
  return trimmed
    .slice(1, -1)
    .split("|")
    .map((cell) => cell.trim());
}

function isMarkdownSeparatorRow(cells: string[]): boolean {
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/u.test(cell.trim()));
}

function isActiveSessionStatus(status: string | undefined): boolean {
  const normalized = String(status ?? "").trim().toLowerCase();
  if (!normalized || normalized === "status") {
    return false;
  }
  if (INACTIVE_SESSION_STATUSES.has(normalized)) {
    return false;
  }
  const tokens = normalized.split(/[^a-z0-9]+/u).filter(Boolean);
  if (tokens.some((token) => TERMINAL_SESSION_STATUS_TOKENS.has(token))) {
    return false;
  }
  if (tokens.some((token) => ACTIVE_SESSION_STATUS_TOKENS.has(token))) {
    return true;
  }
  return !tokens.some((token) => INACTIVE_SESSION_STATUSES.has(token));
}

function normalizeCandidatePath(candidate: string): string | null {
  const trimmed = candidate.trim();
  if (!trimmed || !path.isAbsolute(trimmed)) {
    return null;
  }
  return path.resolve(trimmed);
}

function normalizeWorkspaceSessionId(candidate: string | undefined): string | undefined {
  const trimmed = candidate?.trim().replace(/^`|`$/gu, "");
  return trimmed ? trimmed : undefined;
}

async function validatedRepoRoot(candidate: CandidateRepoRoot): Promise<string | null> {
  const repoRoot = normalizeCandidatePath(candidate.path);
  return repoRoot ? await gitRootFor(repoRoot) : null;
}

async function gitRootFor(candidate: string): Promise<string | null> {
  try {
    const stat = await fs.stat(candidate);
    if (!stat.isDirectory()) {
      return null;
    }
  } catch {
    return null;
  }
  const result = await runCommand("git", ["-C", candidate, "rev-parse", "--show-toplevel"], {
    timeoutMs: 2_500,
    maxBufferBytes: 64 * 1024
  });
  const root = result.stdout.trim();
  return result.ok && root.length > 0 ? path.resolve(root) : null;
}

async function isInsideOrSamePath(candidate: string, root: string): Promise<boolean> {
  const [realCandidate, realRoot] = await Promise.all([realPathOrResolved(candidate), realPathOrResolved(root)]);
  const relative = path.relative(realRoot, realCandidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function isSamePath(left: string, right: string): Promise<boolean> {
  const [realLeft, realRight] = await Promise.all([realPathOrResolved(left), realPathOrResolved(right)]);
  return realLeft === realRight;
}

async function realPathOrResolved(candidate: string): Promise<string> {
  try {
    return await fs.realpath(candidate);
  } catch {
    return path.resolve(candidate);
  }
}

async function localWorkspaceFocusOverridesConfiguredRoot(configuredRoot: string): Promise<boolean> {
  const focusFile = path.join(configuredRoot, ".codex", "WORKING.md");
  try {
    await fs.access(focusFile);
  } catch {
    return false;
  }

  let selection: FocusFileRepoSelection;
  try {
    selection = await readFocusedRepoPaths(focusFile, {}, configuredRoot);
  } catch {
    return true;
  }

  for (const candidatePath of selection.paths) {
    const repoRoot = await validatedRepoRoot({ path: candidatePath, source: "workspace-focus-file" });
    if (!repoRoot || !(await isInsideOrSamePath(repoRoot, configuredRoot))) {
      continue;
    }
    if (!(await isSamePath(repoRoot, configuredRoot))) {
      return true;
    }
  }
  return false;
}

async function partitionDefaultPaths(paths: string[], configuredRoot?: string): Promise<{ focused: string[]; configuredRoot: string[] }> {
  if (!configuredRoot) {
    return { focused: paths, configuredRoot: [] };
  }
  const focused: string[] = [];
  const configuredRootPaths: string[] = [];
  for (const candidate of paths) {
    const normalized = normalizeCandidatePath(candidate);
    if (normalized && (await isSamePath(normalized, configuredRoot))) {
      configuredRootPaths.push(candidate);
      continue;
    }
    const repoRoot = normalized ? await gitRootFor(normalized) : null;
    if (repoRoot && (await isSamePath(repoRoot, configuredRoot))) {
      configuredRootPaths.push(candidate);
      continue;
    }
    if (repoRoot && (await isInsideOrSamePath(repoRoot, configuredRoot))) {
      focused.push(candidate);
    }
  }
  return { focused, configuredRoot: configuredRootPaths };
}
