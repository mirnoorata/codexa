import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";

export function resolveGitRepoRoot(repoInput: string | undefined): string | null {
  const candidate = path.resolve(repoInput ?? process.cwd());
  const gitRoot = runGit(candidate, ["rev-parse", "--show-toplevel"]);
  return gitRoot ? path.resolve(gitRoot) : null;
}

export function resolveImplicitGitRepoRoot(): string | null {
  const claudeProjectDir = process.env.CLAUDE_PROJECT_DIR?.trim();
  if (claudeProjectDir) {
    const claudeRoot = resolveGitRepoRoot(claudeProjectDir);
    if (claudeRoot) return claudeRoot;
  }
  return resolveGitRepoRoot(undefined);
}

export function portableRepoArg(repoRoot: string, targetRelPath: string): string | undefined {
  return isGitTracked(repoRoot, targetRelPath) ? undefined : repoRoot;
}

export function isGitTracked(repoRoot: string, relPath: string): boolean {
  try {
    execFileSync("git", ["-C", repoRoot, "ls-files", "--error-unmatch", relPath], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export function detectExistingServerName(config: string): string | undefined {
  let inManagedBlock = false;
  for (const line of config.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed === "# >>> codexa managed") {
      inManagedBlock = true;
      continue;
    }
    if (trimmed === "# <<< codexa managed") {
      inManagedBlock = false;
      continue;
    }
    if (inManagedBlock) {
      const match = /^\[mcp_servers\.([A-Za-z0-9_-]{1,64})\]$/u.exec(trimmed);
      if (match) return match[1];
    }
  }
  return undefined;
}

export function defaultServerName(repoRoot: string): string {
  const commonDir = runGit(repoRoot, ["rev-parse", "--git-common-dir"]);
  if (!commonDir) return `codexa-${slugify(path.basename(repoRoot))}`;
  const resolvedCommonDir = path.resolve(repoRoot, commonDir);
  const commonBase = path.basename(resolvedCommonDir);
  const repoName = commonBase === ".git" ? path.basename(path.dirname(resolvedCommonDir)) : commonBase.replace(/\.git$/u, "");
  return `codexa-${slugify(repoName)}`;
}

export async function writeTextIfChanged(filePath: string, existing: string, contents: string): Promise<void> {
  if (existing !== contents) await writeFile(filePath, contents, "utf8");
}

function runGit(cwd: string, args: string[]): string | null {
  try {
    return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

function slugify(value: string): string {
  const slug = value.toLowerCase().replace(/[^a-z0-9_-]+/gu, "-").replace(/^-+|-+$/gu, "");
  return slug || "repo";
}
