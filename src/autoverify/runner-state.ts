import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { getGitStateAsync, repoRelativePath as gitRepoRelativePath } from "../git.js";
import { isSourcePath, isTestPath, shouldSkipPath } from "../language.js";
import type { AutoVerifyCandidate } from "../types.js";
import { stableId } from "../util.js";

const execFileAsync = promisify(execFile);
const MAX_OUTPUT_SUMMARY = 500;
const MAX_OUTPUT_CAPTURE = 20_000;

export interface RunnerDirtyState {
  headCommit: string | null;
  dirtyFiles: string[];
  dirtyFileHashes: Record<string, string>;
  allStatuses: Map<string, string>;
  protectedHashes: Map<string, string>;
  untrackedProtectedFiles: Set<string>;
  worktreeRoot: string;
  fullStatuses: Map<string, string>;
  fullProtectedHashes: Map<string, string>;
  fullUntrackedProtectedFiles: Set<string>;
  degradedReason?: string;
}

export async function runnerDirtyState(repoRoot: string, protectedPaths: string[]): Promise<RunnerDirtyState> {
  const repo = path.resolve(repoRoot);
  const [git, status] = await Promise.all([
    getGitStateAsync(repo, { includeFiles: false, includeChurn: false }).catch((error: unknown) => ({ error })),
    gitText(repo, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], false)
  ]);
  if ("error" in git) {
    return {
      headCommit: null,
      dirtyFiles: [],
      dirtyFileHashes: {},
      allStatuses: new Map(),
      protectedHashes: new Map(),
      untrackedProtectedFiles: new Set(),
      worktreeRoot: repo,
      fullStatuses: new Map(),
      fullProtectedHashes: new Map(),
      fullUntrackedProtectedFiles: new Set(),
      degradedReason: git.error instanceof Error ? git.error.message : "git state unavailable"
    };
  }
  const relativePrefix = git.gitRoot ? normalizePathLike(path.relative(git.gitRoot, repo)) : "";
  const rawStatuses = parsePorcelainStatus(status ?? "");
  const statuses = normalizeStatusPaths(rawStatuses, git.gitRoot, relativePrefix);
  const fullStatuses = normalizeFullStatusPaths(rawStatuses);
  const worktreeRoot = git.gitRoot ? path.resolve(git.gitRoot) : repo;
  const visibleDirtyFiles = git.dirtyFiles.filter((file) => !isCodexaGenerated(file)).sort();
  const dirtyFileHashes = await hashFiles(repo, visibleDirtyFiles);
  const protectedSet = new Set<string>([
    ...protectedPaths.map(normalizePathLike),
    ...[...statuses.keys()].filter((file) => protectedMutationPath(file) && statuses.get(file) !== undefined)
  ]);
  const fullProtectedSet = new Set<string>([...fullStatuses.keys()].filter((file) => protectedMutationPath(file)));
  const protectedHashes = await hashProtectedFiles(repo, [...protectedSet]);
  const untrackedProtectedFiles = new Set([...statuses.entries()].filter(([file, statusValue]) => statusValue === "??" && protectedMutationPath(file)).map(([file]) => file));
  const fullProtectedHashes = await hashProtectedFiles(worktreeRoot, [...fullProtectedSet]);
  const fullUntrackedProtectedFiles = new Set([...fullStatuses.entries()].filter(([file, statusValue]) => statusValue === "??" && protectedMutationPath(file)).map(([file]) => file));
  return {
    headCommit: git.headCommit,
    dirtyFiles: visibleDirtyFiles,
    dirtyFileHashes,
    allStatuses: statuses,
    protectedHashes,
    untrackedProtectedFiles,
    worktreeRoot,
    fullStatuses,
    fullProtectedHashes,
    fullUntrackedProtectedFiles,
    degradedReason: status === null ? "git status unavailable" : undefined
  };
}

export function sourceMutationBetween(before: RunnerDirtyState, after: RunnerDirtyState, protectedPaths: string[]): boolean {
  if (before.degradedReason || after.degradedReason) {
    return true;
  }
  const protectedSet = new Set(protectedPaths.map(normalizePathLike));
  for (const [file, beforeStatus] of before.allStatuses) {
    const afterStatus = after.allStatuses.get(file);
    if (afterStatus !== beforeStatus && protectedMutationPath(file)) {
      return true;
    }
  }
  for (const [file, afterStatus] of after.allStatuses) {
    const beforeStatus = before.allStatuses.get(file);
    if (beforeStatus !== afterStatus && protectedMutationPath(file)) {
      return true;
    }
  }
  for (const [file, beforeHash] of before.protectedHashes) {
    const afterHash = after.protectedHashes.get(file);
    if (afterHash !== beforeHash && (protectedSet.has(file) || protectedMutationPath(file))) {
      return true;
    }
  }
  for (const file of after.untrackedProtectedFiles) {
    if (!before.untrackedProtectedFiles.has(file)) {
      return true;
    }
  }
  for (const [file, beforeStatus] of before.fullStatuses) {
    const afterStatus = after.fullStatuses.get(file);
    if (afterStatus !== beforeStatus && protectedMutationPath(file)) {
      return true;
    }
  }
  for (const [file, afterStatus] of after.fullStatuses) {
    const beforeStatus = before.fullStatuses.get(file);
    if (beforeStatus !== afterStatus && protectedMutationPath(file)) {
      return true;
    }
  }
  for (const [file, beforeHash] of before.fullProtectedHashes) {
    const afterHash = after.fullProtectedHashes.get(file);
    if (afterHash !== beforeHash && protectedMutationPath(file)) {
      return true;
    }
  }
  for (const file of after.fullUntrackedProtectedFiles) {
    if (!before.fullUntrackedProtectedFiles.has(file)) {
      return true;
    }
  }
  return false;
}

export function dirtyStateHash(state: RunnerDirtyState): string {
  return autoVerifyDirtyHashFromParts({
    headCommit: state.headCommit,
    dirtyFiles: state.dirtyFiles,
    dirtyFileHashes: state.dirtyFileHashes
  });
}

export function autoVerifyDirtyHashFromParts(input: { headCommit: string | null; dirtyFiles: string[]; dirtyFileHashes: Record<string, string> }): string {
  return stableId(
    "autoverify-dirty-tree",
    input.headCommit ?? "null",
    JSON.stringify({
      dirtyFiles: [...input.dirtyFiles].sort(),
      dirtyFileHashes: Object.fromEntries(Object.entries(input.dirtyFileHashes).sort(([a], [b]) => a.localeCompare(b)))
    })
  );
}

export function candidateDigest(candidate: AutoVerifyCandidate): string {
  return stableId(
    "autoverify-candidate",
    candidate.taskId,
    candidate.snapshotDigest,
    candidate.commandId,
    candidate.command,
    candidate.commandCwd,
    candidate.commandExecutable,
    JSON.stringify(candidate.commandArgs),
    JSON.stringify(candidate.targetPaths)
  );
}

export async function createRunnerHome(): Promise<string> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "codexa-autoverify-home-"));
  await fs.mkdir(path.join(home, ".config"), { recursive: true });
  await fs.writeFile(path.join(home, ".npmrc"), "", "utf8");
  return home;
}

export function minimalChildEnv(home: string, pathEnv: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["TMPDIR", "TEMP", "TMP", "SystemRoot", "WINDIR"]) {
    if (process.env[key]) {
      env[key] = process.env[key];
    }
  }
  env.PATH = pathEnv;
  env.HOME = home;
  env.USERPROFILE = home;
  env.XDG_CONFIG_HOME = path.join(home, ".config");
  env.NPM_CONFIG_USERCONFIG = path.join(home, ".npmrc");
  env.NPM_CONFIG_CACHE = path.join(home, ".npm-cache");
  env.YARN_CACHE_FOLDER = path.join(home, ".yarn-cache");
  env.PIP_CONFIG_FILE = os.devNull;
  env.PYTHONNOUSERSITE = "1";
  env.CI = "1";
  env.NO_COLOR = "1";
  env.CODEXA_VERIFY = "1";
  return env;
}

async function gitText(repoRoot: string, args: string[], trim = true): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", repoRoot, ...args], {
      encoding: "utf8",
      maxBuffer: 2 * 1024 * 1024,
      timeout: 5_000,
      env: minimalGitEnv()
    });
    return trim ? stdout.trim() : stdout;
  } catch {
    return null;
  }
}

function minimalGitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "HOME", "TMPDIR", "TEMP", "TMP", "SystemRoot", "WINDIR"]) {
    if (process.env[key]) {
      env[key] = process.env[key];
    }
  }
  env.NO_COLOR = "1";
  return env;
}

function parsePorcelainStatus(value: string): Map<string, string> {
  const entries = value.split("\0").filter(Boolean);
  const statuses = new Map<string, string>();
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (!entry || entry.length < 4) {
      continue;
    }
    const status = entry.slice(0, 2);
    const file = normalizePathLike(entry.slice(3));
    if (status.includes("R") || status.includes("C")) {
      const oldPath = normalizePathLike(entries[index + 1] ?? "");
      statuses.set(file, status);
      if (oldPath) {
        statuses.set(oldPath, status);
      }
      index += 1;
      continue;
    }
    statuses.set(file, status);
  }
  return statuses;
}

function normalizeStatusPaths(statuses: Map<string, string>, gitRoot: string | null, relativePrefix: string): Map<string, string> {
  const normalized = new Map<string, string>();
  for (const [file, status] of statuses) {
    const relative = gitRepoRelativePath(file, gitRoot, relativePrefix);
    if (relative) {
      normalized.set(relative, status);
    }
  }
  return normalized;
}

function normalizeFullStatusPaths(statuses: Map<string, string>): Map<string, string> {
  const normalized = new Map<string, string>();
  for (const [file, status] of statuses) {
    normalized.set(normalizePathLike(file), status);
  }
  return normalized;
}

async function hashFiles(repoRoot: string, files: string[]): Promise<Record<string, string>> {
  const entries = await Promise.all(files.map(async (file) => [file, await hashFile(repoRoot, file, { metadataForNonSource: true })] as const));
  return Object.fromEntries(entries.sort(([a], [b]) => a.localeCompare(b)));
}

async function hashProtectedFiles(repoRoot: string, files: string[]): Promise<Map<string, string>> {
  const entries = await Promise.all(files.map(async (file) => [file, await hashFile(repoRoot, file, { metadataForNonSource: false })] as const));
  return new Map(entries);
}

async function hashFile(repoRoot: string, file: string, options: { metadataForNonSource: boolean }): Promise<string> {
  const absolute = path.join(repoRoot, file);
  try {
    const stat = await fs.lstat(absolute);
    if (!stat.isFile()) {
      return "non-file";
    }
    if (options.metadataForNonSource && (!isSourcePath(file) || stat.size > 2 * 1024 * 1024)) {
      return `metadata:${stat.size}:${Math.trunc(stat.mtimeMs)}`;
    }
    if (stat.size > 2 * 1024 * 1024) {
      return `metadata:${stat.size}:${Math.trunc(stat.mtimeMs)}`;
    }
    const content = await fs.readFile(absolute);
    return createHash("sha1").update(content).digest("hex");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    return code === "ENOENT" ? "missing" : `unreadable:${typeof code === "string" ? code : "unknown"}`;
  }
}

function isCodexaGenerated(file: string): boolean {
  const normalized = normalizePathLike(file);
  if (normalized === ".codex/static-analysis" || normalized.startsWith(".codex/static-analysis/")) {
    return false;
  }
  return normalized === ".codex" || normalized === ".codex/" || normalized.startsWith(".codex/");
}

function protectedMutationPath(file: string): boolean {
  const normalized = normalizePathLike(file);
  if (codexaProvenancePath(normalized)) {
    return true;
  }
  if (ignoredTestOutputPath(normalized)) {
    return false;
  }
  return isSourcePath(normalized) || isTestPath(normalized) || codexaProvenancePath(normalized);
}

function ignoredTestOutputPath(file: string): boolean {
  return shouldSkipPath(file) || file === "coverage" || file.startsWith("coverage/") || file === ".coverage" || file.startsWith(".pytest_cache/") || file.startsWith(".nyc_output/");
}

function codexaProvenancePath(file: string): boolean {
  const normalized = normalizePathLike(file);
  const codexPath = normalized.startsWith(".codex/")
    ? normalized
    : normalized.includes("/.codex/")
      ? normalized.slice(normalized.indexOf("/.codex/") + 1)
      : normalized;
  return (
    codexPath === ".codex/config.toml" ||
    codexPath.startsWith(".codex/cache/codexa-tasks/") ||
    codexPath.startsWith(".codex/cache/codexa-task-snapshots/") ||
    codexPath.startsWith(".codex/cache/codexa-outcomes/") ||
    codexPath.startsWith(".codex/cache/codexa-hooks/") ||
    codexPath.startsWith(".codex/codebase/")
  );
}

export async function realpathOrUndefined(value: string): Promise<string | undefined> {
  try {
    return await fs.realpath(value);
  } catch {
    return undefined;
  }
}

export function summarizeOutput(value: string, repoRoot: string): string | undefined {
  const clean = sanitizeAutoVerifyText(
    value
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(-8)
      .join(" "),
    repoRoot
  );
  return clean;
}

export function sanitizeAutoVerifyText(value: string | undefined, repoRoot: string): string | undefined {
  const clean = redactSecretText(value)
    ?.replaceAll(path.resolve(repoRoot), "<repo>")
    .replace(/(^|[\s([,{])\/[^\s;|)\]'",]+/gu, "$1<abs-path>")
    .replace(/(^|[\s([,{])(?:\.\.?\/)[^\s;|)\]'",]+/gu, "$1<rel-path>")
    .replace(/\s+/gu, " ")
    .trim();
  if (!clean) {
    return undefined;
  }
  return clean.length > MAX_OUTPUT_SUMMARY ? `${clean.slice(0, MAX_OUTPUT_SUMMARY - 3)}...` : clean;
}

export function boundedAppend(current: string, chunk: string): string {
  const next = current + chunk;
  return next.length > MAX_OUTPUT_CAPTURE ? next.slice(next.length - MAX_OUTPUT_CAPTURE) : next;
}

export function safeExecutableName(value: string): boolean {
  return /^(npm|pnpm|yarn|node|vitest|jest|pytest|uv|python|python3)$/u.test(value);
}

export function normalizePathLike(value: string): string {
  return value.split(path.sep).join("/").replace(/^\.\//u, "").replace(/\/+/gu, "/");
}

export function repoRelativeRealPath(repoRealRoot: string, fileRealpath: string): string {
  const relative = path.relative(repoRealRoot, fileRealpath).split(path.sep).join("/");
  return relative || ".";
}

export function redactSecretText(value: string | undefined): string | undefined {
  return value
    ?.replace(/(^|[\s([,{])((?:--?[a-z0-9-]*(?:token|secret|password|passwd|pwd|api[-_]?key|access[-_]?key|auth|credential|cookie)[a-z0-9-]*)(?:=|\s+))([^\s;|)\]'",]+)/giu, "$1$2<redacted>")
    .replace(/(\b[A-Z_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|PWD|API_?KEY|ACCESS_?KEY|AUTH|CREDENTIAL|COOKIE)[A-Z0-9_]*=)([^\s;|)\]'",]+)/gu, "$1<redacted>")
    .replace(/\b(Bearer)\s+[A-Za-z0-9._~+/-]+=*/giu, "$1 <redacted>");
}
