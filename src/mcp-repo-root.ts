import { promises as fs } from "node:fs";
import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import { runCommand } from "./command.js";
import { assertSafeManagedDirectory, assertSafeManagedFile } from "./init-portability.js";
import { readSessionStartFocusFile } from "./session-start-file-read.js";

export interface McpRepoRootResolutionOptions {
  skipDefaultFocusFile?: boolean;
  workspaceFocusFile?: string;
  workspaceSessionId?: string;
  preferConfiguredRoot?: boolean;
  requireValidDeclaredFocus?: boolean;
  ignoreAmbientWorkspaceSelectors?: boolean;
}

export interface McpRepoRootResolution {
  configuredRoot: string;
  repoRoot: string;
  source: "configured-root" | "environment" | "workspace-focus-file";
  focusFile?: string;
  focusReason?: "selected-session" | "explicit-focus" | "active-session" | "workspace-default" | "environment";
  workspaceSessionId?: string;
  warnings?: string[];
  focusFileContents?: string;
}

interface CandidateRepoRoot {
  path: string;
  source: McpRepoRootResolution["source"];
  focusFile?: string;
  focusReason?: McpRepoRootResolution["focusReason"];
  workspaceSessionId?: string;
  strict?: boolean;
  warnings?: string[];
  focusFileContents?: string;
}

interface FocusFileRepoSelection {
  paths: string[];
  focusReason?: McpRepoRootResolution["focusReason"];
  workspaceSessionId?: string;
  strict: boolean;
  warnings: string[];
  contents?: string;
}

interface FocusFileCandidate {
  path: string;
  managedDefault: boolean;
}

interface RoutingSnapshot {
  focusSelections: Map<string, Promise<FocusFileRepoSelection>>;
  gitRoots: Map<string, Promise<string | null>>;
  localConfigPaths: Map<string, Promise<boolean>>;
  realPaths: Map<string, Promise<string>>;
}

const routingSnapshotContext = new AsyncLocalStorage<RoutingSnapshot>();

const FOCUSED_REPO_LINE_PATTERN = /\bfocused\s+(?:project|repo|repository)\s*:\s*(?:`([^`]+)`|([^\r\n#]+))/iu;
const DEFAULT_REPO_LINE_PATTERN = /\bdefault\s+(?:repo|repository)\s*:\s*(?:`([^`]+)`|([^\r\n#|]+))/iu;
const ACTIVE_PROJECT_FOCUS_LINE_PATTERN = /\bactive\s+project\s+focus\s*:/iu;
const ACTIVE_PROJECT_FOCUS_REPO_PATTERN = /\b(?:via\s+)?(?:repo|repository)\s*:?\s*(?:`(\/[^`]+)`|(\/[^\s#|.,;:]+))/iu;
const ACTIVE_PROJECT_FOCUS_DIRECT_PATH_PATTERN = /\bactive\s+project\s+focus\s*:\s*(?:`(\/[^`]+)`|(\/[^\s#|.,;:]+))\s*$/iu;
const COMPACT_PROJECT_LINE_PATTERN = /^\s*(?:[-*]\s*)?project\s*:\s*(?:`([^`]+)`|([^\r\n#]+))/iu;
const HEADING_PATTERN = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/u;
const INACTIVE_SESSION_STATUSES = new Set([
  "done",
  "stale",
  "merged",
  "superseded",
  "removed",
  "shipped",
  "shipped+live",
  "live",
  "released",
  "closed",
  "abandoned",
  "cleaning",
  "merged-live-verified",
  "released+verified"
]);
const WORKSPACE_SESSION_ID_MAX = 128;

export async function shouldPreferConfiguredRepoRoot(configuredRootInput: string, options: McpRepoRootResolutionOptions = {}): Promise<boolean> {
  const configuredRoot = path.resolve(configuredRootInput);
  const configuredRootIsGitRepo = (await gitRootFor(configuredRoot)) !== null;
  const effectiveOptions = configuredRootIsGitRepo && await hasLocalCodexaConfigPath(configuredRoot)
    ? { ...options, ignoreAmbientWorkspaceSelectors: true }
    : options;
  if (effectiveOptions.workspaceFocusFile || effectiveOptions.workspaceSessionId) {
    return false;
  }
  if (
    !effectiveOptions.ignoreAmbientWorkspaceSelectors &&
    (explicitFocusFile(effectiveOptions) || declaredWorkspaceSession(effectiveOptions))
  ) {
    return false;
  }
  if (!configuredRootIsGitRepo) {
    return false;
  }
  return !(await localWorkspaceFocusOverridesConfiguredRoot(configuredRoot));
}

export async function resolveMcpRepoRootOnce(
  configuredRootInput: string,
  options: McpRepoRootResolutionOptions = {}
): Promise<McpRepoRootResolution> {
  return routingSnapshotContext.run(
    {
      focusSelections: new Map(),
      gitRoots: new Map(),
      localConfigPaths: new Map(),
      realPaths: new Map()
    },
    async () => {
      const preferConfiguredRoot = options.preferConfiguredRoot ??
        await shouldPreferConfiguredRepoRoot(configuredRootInput, options);
      return resolveMcpRepoRoot(configuredRootInput, {
        ...options,
        preferConfiguredRoot
      });
    }
  );
}

export async function resolveMcpRepoRoot(configuredRootInput: string, options: McpRepoRootResolutionOptions = {}): Promise<McpRepoRootResolution> {
  const configuredRoot = path.resolve(configuredRootInput);
  const configuredRootIsGitRepo = (await gitRootFor(configuredRoot)) !== null;
  const effectiveOptions = configuredRootIsGitRepo && await hasLocalCodexaConfigPath(configuredRoot)
    ? { ...options, ignoreAmbientWorkspaceSelectors: true }
    : options;
  const declaredSession = declaredWorkspaceSession(effectiveOptions);
  const explicitRoutingRequested = Boolean(effectiveOptions.workspaceFocusFile || effectiveOptions.workspaceSessionId);
  const workspaceRoutingRequested = explicitRoutingRequested ||
    (!effectiveOptions.preferConfiguredRoot && Boolean(explicitFocusFile(effectiveOptions) || declaredSession));

  if (configuredRootIsGitRepo && effectiveOptions.preferConfiguredRoot && !explicitRoutingRequested && !effectiveOptions.requireValidDeclaredFocus) {
    if (!effectiveOptions.skipDefaultFocusFile) await assertSafeDefaultFocusFile(configuredRoot);
    return { configuredRoot, repoRoot: configuredRoot, source: "configured-root" };
  }

  for await (const candidate of focusFileRepoCandidates(configuredRoot, effectiveOptions)) {
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
        warnings: candidate.warnings,
        focusFileContents: candidate.focusFileContents
      };
    }
    if (candidate.strict || effectiveOptions.requireValidDeclaredFocus) {
      throw new Error(
        `Codexa MCP workspace session${candidate.workspaceSessionId ? ` ${candidate.workspaceSessionId}` : ""} resolved to an invalid or out-of-workspace repo in ${candidate.focusFile ?? "workspace focus"}: ${candidate.path}`
      );
    }
  }

  if (configuredRootIsGitRepo) {
    // Explicit routing is an identity contract, not a preference. Falling
    // back to the workspace monorepo would return plausible wrong-repo
    // evidence, so fail before any index or query is selected.
    if (workspaceRoutingRequested) {
      throw new Error(
        `Codexa MCP workspace routing requested${declaredSession ? ` (session ${declaredSession})` : ""} but no focus row matched; refusing to serve the configured root ${configuredRoot}`
      );
    }
    return { configuredRoot, repoRoot: configuredRoot, source: "configured-root" };
  }

  for (const candidate of environmentRepoCandidates()) {
    const repoRoot = await validatedRepoRoot(candidate);
    if (repoRoot) {
      return { configuredRoot, repoRoot, source: candidate.source, focusReason: "environment" };
    }
  }

  const focusFiles = focusFileCandidates(configuredRoot, effectiveOptions).map((candidate) => candidate.path);
  const focusHint =
    focusFiles.length > 0
      ? ` Add an "Active Focus" project line or "Focused project: /absolute/path/to/repo" to ${focusFiles.join(" or ")}.`
      : "";
  throw new Error(
    `Codexa MCP configured root is not a git repository and no focused git repository could be resolved: ${configuredRoot}. Set CODEXA_REPO or CODEXA_FOCUSED_REPO to a git repository.${focusHint}`
  );
}

async function hasLocalCodexaConfigPath(configuredRoot: string): Promise<boolean> {
  const key = path.resolve(configuredRoot);
  const snapshot = routingSnapshotContext.getStore();
  const inspect = async (): Promise<boolean> => {
    try {
      await fs.lstat(path.join(configuredRoot, ".codex", "config.toml"));
      return true;
    } catch {
      return false;
    }
  };
  if (!snapshot) return inspect();
  const existing = snapshot.localConfigPaths.get(key);
  if (existing) return existing;
  const pending = inspect();
  snapshot.localConfigPaths.set(key, pending);
  return pending;
}

function environmentRepoCandidates(): CandidateRepoRoot[] {
  return [process.env.CODEXA_REPO, process.env.CODEXA_FOCUSED_REPO]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .map((value) => ({ path: value, source: "environment" }));
}

async function* focusFileRepoCandidates(configuredRoot: string, options: McpRepoRootResolutionOptions): AsyncGenerator<CandidateRepoRoot> {
  for (const focusFile of focusFileCandidates(configuredRoot, options)) {
    if (focusFile.managedDefault) await assertSafeDefaultFocusFile(configuredRoot);
    const focusFilePath = focusFile.path;
    const selection = await readFocusedRepoPaths(focusFilePath, options, configuredRoot);
    for (const repoPath of selection.paths) {
      yield {
        path: repoPath,
        source: "workspace-focus-file",
        focusFile: focusFilePath,
        focusReason: selection.focusReason,
        workspaceSessionId: selection.workspaceSessionId,
        strict: selection.strict,
        warnings: selection.warnings,
        focusFileContents: selection.contents
      };
    }
  }
}

function focusFileCandidates(configuredRoot: string, options: McpRepoRootResolutionOptions): FocusFileCandidate[] {
  const explicit = explicitFocusFile(options);
  if (explicit) return [{ path: path.resolve(explicit), managedDefault: false }];
  if (options.skipDefaultFocusFile) return [];
  return [{ path: defaultFocusFile(configuredRoot), managedDefault: true }];
}

function explicitFocusFile(options: McpRepoRootResolutionOptions): string | undefined {
  const candidate = options.workspaceFocusFile ??
    (options.workspaceSessionId || options.ignoreAmbientWorkspaceSelectors
      ? undefined
      : process.env.CODEXA_WORKSPACE_FOCUS_FILE);
  return typeof candidate === "string" && candidate.trim().length > 0 ? candidate : undefined;
}

function declaredWorkspaceSession(options: McpRepoRootResolutionOptions): string | undefined {
  const candidate = options.workspaceSessionId ??
    (options.ignoreAmbientWorkspaceSelectors ? undefined : process.env.CODEXA_WORKSPACE_SESSION);
  return typeof candidate === "string" && candidate.trim().length > 0 ? candidate : undefined;
}

function defaultFocusFile(configuredRoot: string): string {
  return path.join(configuredRoot, ".codex", "WORKING.md");
}

async function assertSafeDefaultFocusFile(configuredRoot: string): Promise<void> {
  const codexDir = path.join(configuredRoot, ".codex");
  await assertSafeManagedDirectory(codexDir);
  await assertSafeManagedFile(path.join(codexDir, "WORKING.md"));
}

async function readFocusedRepoPaths(focusFile: string, options: McpRepoRootResolutionOptions, configuredRoot?: string): Promise<FocusFileRepoSelection> {
  const snapshot = routingSnapshotContext.getStore();
  if (!snapshot) {
    return readFocusedRepoPathsUncached(focusFile, options, configuredRoot);
  }
  const key = JSON.stringify([
    path.resolve(focusFile),
    normalizeWorkspaceSessionId(declaredWorkspaceSession(options)),
    configuredRoot ? path.resolve(configuredRoot) : null
  ]);
  const existing = snapshot.focusSelections.get(key);
  if (existing) return existing;
  const pending = readFocusedRepoPathsUncached(focusFile, options, configuredRoot);
  snapshot.focusSelections.set(key, pending);
  return pending;
}

async function readFocusedRepoPathsUncached(
  focusFile: string,
  options: McpRepoRootResolutionOptions,
  configuredRoot?: string
): Promise<FocusFileRepoSelection> {
  let text: string;
  try {
    text = await readSessionStartFocusFile(focusFile);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return emptyFocusFileSelection();
    throw error;
  }

  const workspaceSessionId = normalizeWorkspaceSessionId(declaredWorkspaceSession(options), true);
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
        if (isRoutableWorkspaceSessionStatus(status)) {
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
  const selection = await firstUnambiguousPriority(
    [
      { paths: selectedSessionPaths, focusReason: "selected-session", allowFallbackWhenAmbiguous: false, strict: true, workspaceSessionId },
      { paths: explicitPaths, focusReason: "explicit-focus", allowFallbackWhenAmbiguous: false, strict: false, conflictPaths: [...defaultPathGroups.focused, ...activeSessionPaths] },
      { paths: defaultPathGroups.focused, focusReason: "workspace-default", allowFallbackWhenAmbiguous: false, strict: false },
      { paths: activeSessionPaths, focusReason: "active-session", allowFallbackWhenAmbiguous: false, strict: false },
      { paths: defaultPathGroups.invalid, focusReason: "workspace-default", allowFallbackWhenAmbiguous: false, strict: false },
      { paths: defaultPathGroups.configuredRoot, focusReason: "workspace-default", allowFallbackWhenAmbiguous: false, strict: false }
    ],
    focusFile,
    configuredRoot
  );
  return { ...selection, contents: text };
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

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
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

export function isRoutableWorkspaceSessionStatus(status: string | undefined): boolean {
  const normalized = String(status ?? "").trim().toLowerCase();
  if (!normalized || normalized === "status") {
    return false;
  }
  return !INACTIVE_SESSION_STATUSES.has(normalized);
}

function normalizeCandidatePath(candidate: string): string | null {
  const trimmed = candidate.trim();
  if (!trimmed || !path.isAbsolute(trimmed)) {
    return null;
  }
  return path.resolve(trimmed);
}

function normalizeWorkspaceSessionId(candidate: string | undefined, strict = false): string | undefined {
  const trimmed = candidate?.trim().replace(/^`|`$/gu, "");
  if (!trimmed) return undefined;
  if (trimmed.length > WORKSPACE_SESSION_ID_MAX || /[\u0000-\u001f\u007f]/u.test(trimmed)) {
    if (strict) throw new Error(`Codexa workspace session id must be printable and at most ${WORKSPACE_SESSION_ID_MAX} characters`);
    return undefined;
  }
  return trimmed;
}

async function validatedRepoRoot(candidate: CandidateRepoRoot): Promise<string | null> {
  const repoRoot = normalizeCandidatePath(candidate.path);
  return repoRoot ? await gitRootFor(repoRoot) : null;
}

async function gitRootFor(candidate: string): Promise<string | null> {
  const key = path.resolve(candidate);
  const snapshot = routingSnapshotContext.getStore();
  const existing = snapshot?.gitRoots.get(key);
  if (existing) return existing;
  const pending = gitRootForUncached(candidate);
  snapshot?.gitRoots.set(key, pending);
  return pending;
}

async function gitRootForUncached(candidate: string): Promise<string | null> {
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
  const key = path.resolve(candidate);
  const snapshot = routingSnapshotContext.getStore();
  const existing = snapshot?.realPaths.get(key);
  if (existing) return existing;
  const pending = (async (): Promise<string> => {
    try {
      return await fs.realpath(candidate);
    } catch {
      return path.resolve(candidate);
    }
  })();
  snapshot?.realPaths.set(key, pending);
  return pending;
}

async function localWorkspaceFocusOverridesConfiguredRoot(configuredRoot: string): Promise<boolean> {
  const focusFile = defaultFocusFile(configuredRoot);
  await assertSafeDefaultFocusFile(configuredRoot);
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
      return true;
    }
    if (!(await isSamePath(repoRoot, configuredRoot))) {
      return true;
    }
  }
  return false;
}

async function partitionDefaultPaths(paths: string[], configuredRoot?: string): Promise<{ focused: string[]; configuredRoot: string[]; invalid: string[] }> {
  if (!configuredRoot) {
    return { focused: paths, configuredRoot: [], invalid: [] };
  }
  const focused: string[] = [];
  const configuredRootPaths: string[] = [];
  const invalid: string[] = [];
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
      continue;
    }
    invalid.push(candidate);
  }
  return { focused, configuredRoot: configuredRootPaths, invalid };
}
