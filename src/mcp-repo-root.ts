import { promises as fs } from "node:fs";
import path from "node:path";
import { runCommand } from "./command.js";

export interface McpRepoRootResolutionOptions {
  workspaceFocusFile?: string;
}

export interface McpRepoRootResolution {
  configuredRoot: string;
  repoRoot: string;
  source: "configured-root" | "environment" | "workspace-focus-file";
  focusFile?: string;
}

interface CandidateRepoRoot {
  path: string;
  source: McpRepoRootResolution["source"];
  focusFile?: string;
}

const FOCUSED_REPO_LINE_PATTERN = /\bfocused\s+(?:project|repo|repository)\s*:\s*(?:`([^`]+)`|([^\r\n#]+))/iu;
const DEFAULT_REPO_LINE_PATTERN = /\bdefault\s+(?:repo|repository)\s*:\s*(?:`([^`]+)`|([^\r\n#|]+))/iu;
const COMPACT_PROJECT_LINE_PATTERN = /^\s*(?:[-*]\s*)?project\s*:\s*(?:`([^`]+)`|([^\r\n#]+))/iu;
const HEADING_PATTERN = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/u;

export async function resolveMcpRepoRoot(configuredRootInput: string, options: McpRepoRootResolutionOptions = {}): Promise<McpRepoRootResolution> {
  const configuredRoot = path.resolve(configuredRootInput);
  const configuredRootIsGitRepo = (await gitRootFor(configuredRoot)) !== null;

  for await (const candidate of focusFileRepoCandidates(configuredRoot, options)) {
    const repoRoot = await validatedRepoRoot(candidate);
    if (repoRoot && (await isInsideOrSamePath(repoRoot, configuredRoot))) {
      return {
        configuredRoot,
        repoRoot,
        source: candidate.source,
        focusFile: candidate.focusFile
      };
    }
  }

  if (configuredRootIsGitRepo) {
    return { configuredRoot, repoRoot: configuredRoot, source: "configured-root" };
  }

  for (const candidate of environmentRepoCandidates()) {
    const repoRoot = await validatedRepoRoot(candidate);
    if (repoRoot) {
      return { configuredRoot, repoRoot, source: candidate.source };
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
    for (const repoPath of await readFocusedRepoPaths(focusFile)) {
      yield { path: repoPath, source: "workspace-focus-file", focusFile: path.resolve(focusFile) };
    }
  }
}

function focusFileCandidates(configuredRoot: string, options: McpRepoRootResolutionOptions): string[] {
  const candidates = [
    options.workspaceFocusFile,
    process.env.CODEXA_WORKSPACE_FOCUS_FILE,
    path.join(configuredRoot, ".codex", "WORKING.md")
  ].filter((value): value is string => typeof value === "string" && value.trim().length > 0);
  return [...new Set(candidates.map((candidate) => path.resolve(candidate)))];
}

async function readFocusedRepoPaths(focusFile: string): Promise<string[]> {
  let text: string;
  try {
    text = await fs.readFile(focusFile, "utf8");
  } catch {
    return [];
  }

  const explicitPaths: string[] = [];
  const activeSessionPaths: string[] = [];
  const defaultPaths: string[] = [];
  let inActiveFocusSection = false;
  let inActiveSessionsSection = false;
  let activeSessionRepoColumn = -1;
  let activeSessionStatusColumn = -1;
  for (const line of text.split(/\r?\n/u)) {
    const heading = HEADING_PATTERN.exec(line);
    if (heading) {
      const headingText = heading[1].trim().toLowerCase();
      inActiveFocusSection = headingText === "active focus";
      inActiveSessionsSection = headingText === "active sessions";
      activeSessionRepoColumn = -1;
      activeSessionStatusColumn = -1;
      continue;
    }

    const focusedMatch = FOCUSED_REPO_LINE_PATTERN.exec(line);
    if (focusedMatch) {
      pushFocusedRepoPath(explicitPaths, focusedMatch[1] ?? focusedMatch[2] ?? "");
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
        activeSessionRepoColumn = repoColumn;
        activeSessionStatusColumn = lowerCells.indexOf("status");
        continue;
      }
      if (activeSessionRepoColumn >= 0 && activeSessionRepoColumn < cells.length) {
        const status = activeSessionStatusColumn >= 0 ? cells[activeSessionStatusColumn]?.trim().toLowerCase() : "";
        if (isActiveSessionStatus(status)) {
          pushFocusedRepoPath(activeSessionPaths, cells[activeSessionRepoColumn] ?? "");
        }
      }
    }
  }
  return firstUnambiguousPriority(
    [
      { paths: explicitPaths, allowFallbackWhenAmbiguous: false },
      { paths: activeSessionPaths, allowFallbackWhenAmbiguous: true },
      { paths: defaultPaths, allowFallbackWhenAmbiguous: false }
    ],
    focusFile
  );
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

function firstUnambiguousPriority(groups: Array<{ paths: string[]; allowFallbackWhenAmbiguous: boolean }>, focusFile: string): string[] {
  let deferredAmbiguity: string[] | null = null;
  for (const group of groups) {
    const paths = uniquePaths(group.paths);
    if (paths.length === 0) {
      continue;
    }
    const normalized = uniquePaths(paths.map((entry) => normalizeCandidatePath(entry)).filter((entry): entry is string => Boolean(entry)));
    if (normalized.length > 1) {
      if (group.allowFallbackWhenAmbiguous) {
        deferredAmbiguity = deferredAmbiguity ?? normalized;
        continue;
      }
      throw new Error(`Codexa MCP workspace focus is ambiguous in ${path.resolve(focusFile)}: ${normalized.join(", ")}`);
    }
    return paths;
  }
  if (deferredAmbiguity) {
    throw new Error(`Codexa MCP workspace focus is ambiguous in ${path.resolve(focusFile)}: ${deferredAmbiguity.join(", ")}`);
  }
  return [];
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
  return ["active", "in_progress", "running"].includes(String(status ?? "").trim().toLowerCase());
}

function normalizeCandidatePath(candidate: string): string | null {
  const trimmed = candidate.trim();
  if (!trimmed || !path.isAbsolute(trimmed)) {
    return null;
  }
  return path.resolve(trimmed);
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

async function realPathOrResolved(candidate: string): Promise<string> {
  try {
    return await fs.realpath(candidate);
  } catch {
    return path.resolve(candidate);
  }
}
