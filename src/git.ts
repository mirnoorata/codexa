import { execFileSync } from "node:child_process";
import path from "node:path";
import { runCommand } from "./command.js";
import { normalizePath } from "./util.js";

export interface GitState {
  repoRoot: string;
  gitRoot: string | null;
  headCommit: string | null;
  files: string[];
  dirtyFiles: string[];
  churnByPath: Map<string, number>;
}

export interface GitStateOptions {
  includeFiles?: boolean;
  includeChurn?: boolean;
}

const asyncGitStateInflight = new Map<string, Promise<GitState>>();

function runGit(repoRoot: string, args: string[], trim = true): string | null {
  try {
    const output = execFileSync("git", ["-C", repoRoot, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    });
    return trim ? output.trim() : output;
  } catch {
    return null;
  }
}

async function runGitAsync(repoRoot: string, args: string[], trim = true): Promise<string | null> {
  const result = await runCommand("git", ["-C", repoRoot, ...args], {
    timeoutMs: 5_000,
    maxBufferBytes: 2 * 1024 * 1024
  });
  if (!result.ok) {
    return null;
  }
  return trim ? result.stdout.trim() : result.stdout;
}

export function getGitState(repoRoot: string, options: GitStateOptions = {}): GitState {
  const resolvedRoot = path.resolve(repoRoot);
  const gitRoot = runGit(resolvedRoot, ["rev-parse", "--show-toplevel"]);
  if (!gitRoot) {
    throw new Error(`Codexa requires a git repository: ${resolvedRoot}`);
  }
  const headCommit = runGit(resolvedRoot, ["rev-parse", "HEAD"]);
  const includeFiles = options.includeFiles ?? true;
  const includeChurn = options.includeChurn ?? true;
  const fileOutput = includeFiles ? runGit(resolvedRoot, ["ls-files", "-co", "--exclude-standard", "-z"], false) : "";
  if (includeFiles && fileOutput === null) {
    throw new Error(`Failed to list git-visible files in ${resolvedRoot}`);
  }
  const statusOutput = runGit(resolvedRoot, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], false);
  if (statusOutput === null) {
    throw new Error(`Failed to read git status in ${resolvedRoot}`);
  }
  const churnOutput = includeChurn ? (runGit(resolvedRoot, ["log", "--since=180 days ago", "--name-only", "--pretty=format:", "--"]) ?? "") : "";

  const relativePrefix = gitRoot ? normalizePath(path.relative(gitRoot, resolvedRoot)) : "";
  const files = splitNul(fileOutput ?? "")
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
    churnByPath
  };
}

export async function getGitStateAsync(repoRoot: string, options: GitStateOptions = {}): Promise<GitState> {
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
  const gitRoot = await runGitAsync(resolvedRoot, ["rev-parse", "--show-toplevel"]);
  if (!gitRoot) {
    throw new Error(`Codexa requires a git repository: ${resolvedRoot}`);
  }
  const headCommit = await runGitAsync(resolvedRoot, ["rev-parse", "HEAD"]);
  const includeFiles = options.includeFiles ?? true;
  const includeChurn = options.includeChurn ?? true;
  const fileOutput = includeFiles ? await runGitAsync(resolvedRoot, ["ls-files", "-co", "--exclude-standard", "-z"], false) : "";
  if (includeFiles && fileOutput === null) {
    throw new Error(`Failed to list git-visible files in ${resolvedRoot}`);
  }
  const statusOutput = await runGitAsync(resolvedRoot, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], false);
  if (statusOutput === null) {
    throw new Error(`Failed to read git status in ${resolvedRoot}`);
  }
  const churnOutput = includeChurn ? ((await runGitAsync(resolvedRoot, ["log", "--since=180 days ago", "--name-only", "--pretty=format:", "--"])) ?? "") : "";

  const relativePrefix = gitRoot ? normalizePath(path.relative(gitRoot, resolvedRoot)) : "";
  const files = splitNul(fileOutput ?? "")
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
    churnByPath
  };
}

function gitStateCacheKey(repoRoot: string, options: GitStateOptions): string {
  return JSON.stringify({
    repoRoot: path.resolve(repoRoot),
    includeFiles: options.includeFiles ?? true,
    includeChurn: options.includeChurn ?? true
  });
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
