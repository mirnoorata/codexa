import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import { chmod, lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
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

// This is an optimistic conflict guard, not a universal filesystem lock:
// Codexa writers reject stale snapshots and changes observed before the final
// atomic rename. Unrelated editors do not participate in a portable lock, so
// callers must not claim serialization beyond those observable checks.
export async function writeTextIfChanged(filePath: string, existing: string, contents: string): Promise<void> {
  const initial = await managedFileSnapshot(filePath);
  if (initial.contents !== existing) {
    throw new Error(`Cannot update ${filePath}: the file changed while Codexa was preparing the update`);
  }
  if (existing === contents) return;
  const temporaryPath = `${filePath}.codexa-${process.pid}-${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, contents, { encoding: "utf8", flag: "wx", mode: initial.mode ?? 0o666 });
    if (initial.mode !== undefined) await chmod(temporaryPath, initial.mode);
    const current = await managedFileSnapshot(filePath);
    if (current.contents !== existing || !sameManagedFileIdentity(initial, current)) {
      throw new Error(`Cannot update ${filePath}: the file changed while Codexa was preparing the update`);
    }
    await rename(temporaryPath, filePath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

export async function assertSafeManagedFile(filePath: string): Promise<void> {
  try {
    const entry = await lstat(filePath);
    if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1) {
      throw new Error(`Codexa refuses redirected or non-regular managed file: ${filePath}`);
    }
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return;
    throw error;
  }
}

export async function assertSafeManagedDirectory(directoryPath: string): Promise<void> {
  try {
    const entry = await lstat(directoryPath);
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new Error(`Codexa refuses redirected or non-directory managed state: ${directoryPath}`);
    }
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return;
    throw error;
  }
}

export async function assertSafeManagedStateDirectory(repoRoot: string, ...childSegments: string[]): Promise<string> {
  const repo = path.resolve(repoRoot);
  const repoReal = await realpath(repo);
  const components = [".codex", ...validatedManagedStateSegments(childSegments)];
  let current = repo;
  for (const component of components) {
    current = path.join(current, component);
    await assertSafeManagedDirectory(current);
    try {
      const currentReal = await realpath(current);
      if (!isContainedPath(repoReal, currentReal)) {
        throw new Error(`Codexa refuses managed state outside the repository: ${current}`);
      }
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") continue;
      throw error;
    }
  }
  return path.join(repo, ...components);
}

export async function ensureSafeManagedStateDirectory(repoRoot: string, ...childSegments: string[]): Promise<string> {
  const repo = path.resolve(repoRoot);
  const repoReal = await realpath(repo);
  const components = [".codex", ...validatedManagedStateSegments(childSegments)];
  let current = repo;
  for (const component of components) {
    current = path.join(current, component);
    await assertSafeManagedDirectory(current);
    try {
      await mkdir(current, { mode: 0o700 });
    } catch (error) {
      if (!isNodeError(error) || error.code !== "EEXIST") throw error;
    }
    await assertSafeManagedDirectory(current);
    const currentReal = await realpath(current);
    if (!isContainedPath(repoReal, currentReal)) {
      throw new Error(`Codexa refuses managed state outside the repository: ${current}`);
    }
  }
  return path.join(repo, ...components);
}

function validatedManagedStateSegments(segments: string[]): string[] {
  for (const segment of segments) {
    if (
      !segment ||
      segment === "." ||
      segment === ".." ||
      path.isAbsolute(segment) ||
      segment.includes("/") ||
      segment.includes("\\")
    ) {
      throw new Error(`Invalid Codexa managed-state path segment: ${segment || "<empty>"}`);
    }
  }
  return segments;
}

function isContainedPath(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

interface ManagedFileSnapshot {
  contents: string;
  changedMs?: number;
  device?: number;
  inode?: number;
  mode?: number;
  modifiedMs?: number;
  size?: number;
}

async function managedFileSnapshot(filePath: string): Promise<ManagedFileSnapshot> {
  try {
    const before = await lstat(filePath);
    assertSafeManagedFileEntry(filePath, before);
    const contents = await readFile(filePath, "utf8");
    const after = await lstat(filePath);
    assertSafeManagedFileEntry(filePath, after);
    const beforeIdentity = managedFileIdentity(before);
    const afterIdentity = managedFileIdentity(after);
    if (!sameManagedFileIdentity(beforeIdentity, afterIdentity)) {
      throw new Error(`Cannot update ${filePath}: the file changed while Codexa was preparing the update`);
    }
    return { contents, ...afterIdentity };
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return { contents: "" };
    throw error;
  }
}

function assertSafeManagedFileEntry(filePath: string, entry: Stats): void {
  if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1) {
    throw new Error(`Codexa refuses redirected or non-regular managed file: ${filePath}`);
  }
}

function managedFileIdentity(entry: Stats): Omit<ManagedFileSnapshot, "contents"> {
  return {
    changedMs: entry.ctimeMs,
    device: entry.dev,
    inode: entry.ino,
    mode: entry.mode & 0o777,
    modifiedMs: entry.mtimeMs,
    size: entry.size
  };
}

function sameManagedFileIdentity(
  left: Omit<ManagedFileSnapshot, "contents">,
  right: Omit<ManagedFileSnapshot, "contents">
): boolean {
  return left.changedMs === right.changedMs &&
    left.device === right.device &&
    left.inode === right.inode &&
    left.mode === right.mode &&
    left.modifiedMs === right.modifiedMs &&
    left.size === right.size;
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

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function slugify(value: string): string {
  const slug = value.toLowerCase().replace(/[^a-z0-9_-]+/gu, "-").replace(/^-+|-+$/gu, "");
  return slug || "repo";
}
