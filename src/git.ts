import path from "node:path";
import { runCommand, type CommandResult, type RunCommandOptions } from "./command.js";
import { normalizePath } from "./util.js";

export interface GitState {
  repoRoot: string;
  gitRoot: string | null;
  headCommit: string | null;
  files: string[];
  dirtyFiles: string[];
  churnByPath: Map<string, number>;
  degradedReasons: string[];
}

export type GitCommandRunner = (command: string, args: string[], options?: RunCommandOptions) => Promise<CommandResult>;

export interface GitStateOptions {
  includeFiles?: boolean;
  includeChurn?: boolean;
  commandRunner?: GitCommandRunner;
}

// One truth for git-state limits: the index build (this file) and the review
// path (src/query/worktree.ts) must degrade at the same threshold instead of
// telling two different stories about the same tree.
export const GIT_STATE_TIMEOUT_MS = 5_000;
export const GIT_STATE_MAX_BUFFER_BYTES = 16 * 1024 * 1024;

const asyncGitStateInflight = new Map<string, Promise<GitState>>();

export async function getGitStateAsync(repoRoot: string, options: GitStateOptions = {}): Promise<GitState> {
  if (options.commandRunner) {
    return readGitStateAsync(repoRoot, options);
  }
  const key = gitStateCacheKey(repoRoot, options);
  const existing = asyncGitStateInflight.get(key);
  if (existing) {
    return existing;
  }
  const pending = readGitStateAsync(repoRoot, options).finally(() => {
    asyncGitStateInflight.delete(key);
  });
  asyncGitStateInflight.set(key, pending);
  return pending;
}

async function readGitStateAsync(repoRoot: string, options: GitStateOptions = {}): Promise<GitState> {
  const resolvedRoot = path.resolve(repoRoot);
  const runner = options.commandRunner ?? runCommand;
  const degradedReasons: string[] = [];

  const gitRootResult = await runGitCapture(runner, resolvedRoot, ["rev-parse", "--show-toplevel"]);
  if (!gitRootResult.ok) {
    throw new Error(`Codexa requires a git repository: ${resolvedRoot}`);
  }
  const gitRoot = gitRootResult.stdout.trim();
  const headResult = await runGitCapture(runner, resolvedRoot, ["rev-parse", "HEAD"]);
  const headCommit = headResult.ok ? headResult.stdout.trim() : null;
  const includeFiles = options.includeFiles ?? true;
  const includeChurn = options.includeChurn ?? true;
  const pathspec = repoRootPathspec();

  let fileOutput = "";
  if (includeFiles) {
    const filesResult = await runGitCapture(runner, resolvedRoot, ["ls-files", "-co", "--exclude-standard", "-z", ...pathspec]);
    const partial = partialNulOutput("git ls-files", filesResult);
    if (partial.degradedReason) {
      degradedReasons.push(partial.degradedReason);
    }
    if (partial.output === null) {
      throw new Error(`Failed to list git-visible files in ${resolvedRoot}`);
    }
    fileOutput = partial.output;
  }

  const statusResult = await runGitCapture(runner, resolvedRoot, ["status", "--porcelain=v1", "-z", "--untracked-files=all", ...pathspec]);
  const statusPartial = partialNulOutput("git status", statusResult);
  if (statusPartial.degradedReason) {
    degradedReasons.push(statusPartial.degradedReason);
  }
  if (statusPartial.output === null) {
    throw new Error(`Failed to read git status in ${resolvedRoot}`);
  }
  const statusOutput = statusPartial.output;

  let churnOutput = "";
  if (includeChurn) {
    const churnResult = await runGitCapture(runner, resolvedRoot, ["log", "--since=180 days ago", "--name-only", "--pretty=format:", ...pathspec]);
    if (churnResult.ok) {
      churnOutput = churnResult.stdout.trim();
    } else {
      degradedReasons.push(`${commandFailureReason("git log churn", churnResult)}; ranking proceeds without churn`);
    }
  }

  const relativePrefix = gitRoot ? normalizePath(path.relative(gitRoot, resolvedRoot)) : "";
  const files = splitNul(fileOutput)
    .map((file) => normalizePath(file))
    .filter((file) => file.length > 0);

  const dirtyFiles = parsePorcelain(statusOutput)
    .map((file) => repoRelativePath(file, gitRoot, relativePrefix))
    .filter((file): file is string => Boolean(file))
    .filter((file) => !isCodexaGenerated(file));

  const churnByPath = new Map<string, number>();
  for (const file of churnOutput.split(/\r?\n/).map((line) => normalizePath(line.trim())).filter(Boolean)) {
    if (isCodexaGenerated(file)) {
      continue;
    }
    const rel = repoRelativePath(file, gitRoot, relativePrefix);
    if (!rel || isCodexaGenerated(rel)) {
      continue;
    }
    churnByPath.set(rel, (churnByPath.get(rel) ?? 0) + 1);
  }

  return {
    repoRoot: resolvedRoot,
    gitRoot: gitRoot ? path.resolve(gitRoot) : null,
    headCommit,
    files,
    dirtyFiles: [...new Set(dirtyFiles)].sort(),
    churnByPath,
    degradedReasons
  };
}

async function runGitCapture(runner: GitCommandRunner, repoRoot: string, args: string[]): Promise<CommandResult> {
  return runner("git", ["-C", repoRoot, ...args], {
    timeoutMs: GIT_STATE_TIMEOUT_MS,
    maxBufferBytes: GIT_STATE_MAX_BUFFER_BYTES
  });
}

// Size/time overflows DEGRADE instead of failing the whole state read: the
// partial output is clamped to the last complete NUL-terminated entry so a
// truncated half-path never enters the file lists (and porcelain rename
// pairing never mis-pairs on a cut fragment). Real git failures — non-zero
// exit without overflow, spawn errors — return a null output; the callers'
// hard-throw contract for a broken repo is unchanged.
function partialNulOutput(label: string, result: CommandResult): { output: string | null; degradedReason: string | null } {
  if (result.ok) {
    return { output: result.stdout, degradedReason: null };
  }
  if (result.truncated || result.timedOut) {
    const lastNul = result.stdout.lastIndexOf("\0");
    return {
      output: lastNul === -1 ? "" : result.stdout.slice(0, lastNul + 1),
      degradedReason: commandFailureReason(label, result)
    };
  }
  return { output: null, degradedReason: null };
}

export function commandFailureReason(label: string, result: CommandResult): string {
  if (result.timedOut) {
    return `${label} timed out`;
  }
  if (result.truncated) {
    return `${label} output truncated`;
  }
  if (typeof result.exitCode === "number" && result.exitCode !== 0) {
    return `${label} exited with code ${result.exitCode}`;
  }
  return `${label} failed`;
}

function gitStateCacheKey(repoRoot: string, options: GitStateOptions): string {
  return JSON.stringify({
    repoRoot: path.resolve(repoRoot),
    includeFiles: options.includeFiles ?? true,
    includeChurn: options.includeChurn ?? true
  });
}

function repoRootPathspec(): string[] {
  return ["--", "."];
}

export function isCodexaGenerated(file: string): boolean {
  const normalized = normalizePath(file);
  if (isCodexaInput(normalized)) {
    return false;
  }
  return normalized === ".codex" || normalized === ".codex/" || normalized.startsWith(".codex/");
}

export function isCodexaInput(file: string): boolean {
  const normalized = normalizePath(file);
  return normalized === ".codex/static-analysis" || normalized.startsWith(".codex/static-analysis/");
}

export function repoRelativePath(file: string, gitRoot: string | null, relativePrefix: string): string | undefined {
  const normalized = normalizePath(file);
  if (!gitRoot || !relativePrefix) {
    return normalized && !normalized.startsWith("..") ? normalized : undefined;
  }
  if (!(normalized === relativePrefix || normalized.startsWith(`${relativePrefix}/`))) {
    return undefined;
  }
  const relative = normalizePath(path.relative(relativePrefix, normalized));
  return relative && !relative.startsWith("..") ? relative : undefined;
}

function splitNul(value: string): string[] {
  return value.split("\0").filter(Boolean);
}

function parsePorcelain(value: string): string[] {
  const entries = splitNul(value);
  const paths: string[] = [];
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    if (!entry || entry.length < 4) {
      continue;
    }
    const status = entry.slice(0, 2);
    const firstPath = entry.slice(3);
    if (status.includes("R") || status.includes("C")) {
      paths.push(firstPath);
      i += 1;
    } else {
      paths.push(firstPath);
    }
  }
  return paths;
}
