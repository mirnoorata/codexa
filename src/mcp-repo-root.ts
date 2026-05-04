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
      ? ` Add a line like "Focused project: /absolute/path/to/repo" to ${focusFiles.join(" or ")}.`
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

  const paths: string[] = [];
  let inActiveFocusSection = false;
  for (const line of text.split(/\r?\n/u)) {
    const heading = HEADING_PATTERN.exec(line);
    if (heading) {
      inActiveFocusSection = heading[1].trim().toLowerCase() === "active focus";
      continue;
    }

    const focusedMatch = FOCUSED_REPO_LINE_PATTERN.exec(line);
    if (focusedMatch) {
      pushFocusedRepoPath(paths, focusedMatch[1] ?? focusedMatch[2] ?? "");
      continue;
    }

    if (inActiveFocusSection) {
      const projectMatch = COMPACT_PROJECT_LINE_PATTERN.exec(line);
      if (projectMatch) {
        pushFocusedRepoPath(paths, projectMatch[1] ?? projectMatch[2] ?? "");
      }
    }
  }
  return paths;
}

function pushFocusedRepoPath(paths: string[], raw: string): void {
  const cleaned = raw.trim().replace(/[.,;:]+$/u, "");
  if (cleaned) {
    paths.push(cleaned);
  }
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
