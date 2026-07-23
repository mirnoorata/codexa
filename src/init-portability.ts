import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { InitToolProfile } from "./types/init.js";
import { CODEXA_VERSION } from "./version.js";

const CURRENT_CODEXA_CLI_PATH = fileURLToPath(new URL("./cli.js", import.meta.url));

export interface ExistingClaudeMcpConfig {
  contents: string;
  parsed: Record<string, unknown>;
  serverName?: string;
  toolProfile?: InitToolProfile;
}

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

export function inspectClaudeMcpConfig(contents: string, mcpPath: string): ExistingClaudeMcpConfig {
  const parsed = contents.trim() ? parseJsonObject(contents, mcpPath) : {};
  const servers = isPlainObject(parsed.mcpServers) ? parsed.mcpServers : {};
  const codexaEntries = Object.entries(servers).filter(([, entry]) => isCodexaMcpJsonEntry(entry));
  if (codexaEntries.length !== 1) return { contents, parsed };
  const [serverName, entry] = codexaEntries[0];
  return {
    contents,
    parsed,
    serverName: /^[A-Za-z0-9_-]{1,64}$/u.test(serverName) ? serverName : undefined,
    toolProfile: detectClaudeMcpToolProfile(entry)
  };
}

export function isCodexaMcpJsonEntry(entry: unknown): boolean {
  if (!isPlainObject(entry)) return false;
  const command = typeof entry.command === "string" ? entry.command : "";
  const args = Array.isArray(entry.args) ? entry.args.filter((value): value is string => typeof value === "string") : [];
  const serveIndex = args.indexOf("serve");
  if (serveIndex === -1) return false;
  const launcherToken = serveIndex === 0 ? command : args[serveIndex - 1];
  return isCodexaLauncherToken(launcherToken);
}

/** Recognizes only launcher shapes emitted by init or their portable direct-command equivalent. */
export function isRecognizedCodexaLauncher(command: string, args: string[], serveIndex = args.indexOf("serve")): boolean {
  if (serveIndex < 0) return false;
  const launcherToken = serveIndex === 0 ? command : args[serveIndex - 1];
  // `init` no longer emits a bare PATH launcher. Accepting one here would let
  // strict startup attest an executable whose package identity/version cannot
  // be proven without running untrusted configuration.
  if (serveIndex === 0) return false;
  if (command === "npx" || command === "npx.cmd") {
    return serveIndex === 2 && args[0] === "-y" && launcherToken === `@mirnoorata/codexa@${CODEXA_VERSION}`;
  }
  return serveIndex === 1 && isRecognizedNodeCommand(command) && isPotentialCodexaCliPath(launcherToken);
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

function detectClaudeMcpToolProfile(entry: unknown): InitToolProfile | undefined {
  if (!isPlainObject(entry) || !Array.isArray(entry.args)) return undefined;
  const args = entry.args.filter((value): value is string => typeof value === "string");
  const profile = args[args.lastIndexOf("--tools") + 1];
  if (profile === "core" || profile === "full") return profile;
  // Generated entries predating explicit profiles exposed the full catalog.
  return isCodexaMcpJsonEntry(entry) ? "full" : undefined;
}

export function isCodexaLauncherToken(token: string | undefined): boolean {
  if (!token) return false;
  return (
    token === "codexa" ||
    /^@mirnoorata\/codexa(?:@[^\s]*)?$/u.test(token) ||
    isCodexaCliPath(token)
  );
}

function isCodexaCliPath(token: string | undefined): boolean {
  return Boolean(token && (
    sameExecutablePath(token, CURRENT_CODEXA_CLI_PATH) ||
    /[\\/]codexa[\\/]dist[\\/]cli\.js$/u.test(token) ||
    /[\\/]@mirnoorata[\\/]codexa[\\/]dist[\\/]cli\.js$/u.test(token)
  ));
}

function isPotentialCodexaCliPath(token: string | undefined): boolean {
  return Boolean(token && path.isAbsolute(token) && (
    isCodexaCliPath(token) || /[\\/]dist[\\/]cli\.js$/u.test(token)
  ));
}

export function isRecognizedNodeCommand(command: string): boolean {
  return command === "node" || (path.isAbsolute(command) && /^node(?:js)?(?:\.exe)?$/iu.test(path.basename(command)));
}

function sameExecutablePath(left: string, right: string): boolean {
  if (!path.isAbsolute(left) || !path.isAbsolute(right)) return false;
  const normalize = (value: string): string => process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value);
  return normalize(left) === normalize(right);
}

function parseJsonObject(value: string, filePath: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value);
    if (!isPlainObject(parsed)) throw new Error("top-level JSON value must be an object");
    return parsed;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Cannot update ${filePath}: ${message}`);
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function slugify(value: string): string {
  const slug = value.toLowerCase().replace(/[^a-z0-9_-]+/gu, "-").replace(/^-+|-+$/gu, "");
  return slug || "repo";
}
