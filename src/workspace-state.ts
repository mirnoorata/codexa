import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as fsConstants, promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { isCodexaGenerated } from "./git.js";
import type { FreshnessInfo } from "./types.js";
import { normalizePath } from "./util.js";

const execFileAsync = promisify(execFile);
const WORKSPACE_GIT_TIMEOUT_MS = 5_000;
const WORKSPACE_GIT_MAX_BUFFER_BYTES = 16 * 1024 * 1024;
const WORKSPACE_CONTENT_MAX_FILES = 20_000;
const WORKSPACE_CONTENT_MAX_BYTES = 256 * 1024 * 1024;
const WORKSPACE_CONTENT_TIMEOUT_MS = 5_000;

interface WorkspaceTreeEntry {
  mode: string;
  type: string;
  objectId: string;
  path: string;
}

interface WorkspaceStatusEntry {
  status: string;
  path: string;
  originalPath?: string;
}

interface WorkspaceRawEntry {
  contentDigest: string;
  mode: "100644" | "100755" | "120000";
  path: string;
  type: "file" | "symlink";
}

interface WorkspaceReadBudget {
  remainingBytes: number;
}

export function workspaceStateDigest(freshness: Pick<FreshnessInfo, "headCommit" | "dirtyFileHashes">): string {
  const dirtyFileHashes = Object.fromEntries(Object.entries(freshness.dirtyFileHashes).sort(([left], [right]) => left.localeCompare(right)));
  return createHash("sha256").update(JSON.stringify({ dirtyFileHashes, headCommit: freshness.headCommit })).digest("hex");
}

/**
 * Completion gates need a stricter identity than ordinary content-based
 * freshness. Git tracks whether any executable bit is set for regular files, so a
 * chmod on an already content-dirty file must invalidate a completed review
 * even though its content hash and dirty path set are unchanged.
 *
 * Returning null is deliberately fail-closed: non-regular, unreadable, or
 * racing paths are not exact enough to suppress a later review.
 */
export async function exactWorkspaceStateDigest(
  repoRootInput: string,
  freshness: Pick<FreshnessInfo, "headCommit" | "dirtyFiles" | "dirtyFileHashes">
): Promise<string | null> {
  const repoRoot = path.resolve(repoRootInput);
  const dirtyFiles = [...new Set(freshness.dirtyFiles)].sort();
  const hashedFiles = Object.keys(freshness.dirtyFileHashes).sort();
  if (dirtyFiles.length !== hashedFiles.length || dirtyFiles.some((file, index) => file !== hashedFiles[index])) {
    return null;
  }

  const dirtyFileModes: Record<string, "100644" | "100755" | "missing"> = {};
  for (const file of dirtyFiles) {
    const digest = freshness.dirtyFileHashes[file];
    const absolutePath = path.resolve(repoRoot, file);
    if (absolutePath === repoRoot || !absolutePath.startsWith(`${repoRoot}${path.sep}`)) {
      return null;
    }
    try {
      const stat = await fs.lstat(absolutePath);
      if (digest === "missing" || !stat.isFile() || stat.isSymbolicLink()) {
        return null;
      }
      dirtyFileModes[file] = (stat.mode & 0o111) !== 0 ? "100755" : "100644";
    } catch (error) {
      if (digest !== "missing" || (error as NodeJS.ErrnoException).code !== "ENOENT") {
        return null;
      }
      dirtyFileModes[file] = "missing";
    }
  }

  const dirtyFileHashes = Object.fromEntries(hashedFiles.map((file) => [file, freshness.dirtyFileHashes[file]]));
  return createHash("sha256")
    .update("codexa-exact-workspace-v2\0")
    .update(JSON.stringify({ dirtyFileHashes, dirtyFileModes, headCommit: freshness.headCommit }))
    .digest("hex");
}

/**
 * Return a HEAD-independent digest for the exact Git-visible workspace tree.
 *
 * A post-edit review normally observes a dirty checkout and a later process
 * observes the same bytes after they have been committed. The ordinary state
 * digest must change across that transition because it binds HEAD and the dirty
 * overlay. This digest projects the dirty path set onto HEAD, then reads every
 * resulting Git-visible path and hashes its raw bytes, type, and runtime mode.
 * Comparing raw workspace manifests is intentional: clean/smudge filters, EOL
 * normalization, core.fileMode, assume-unchanged, and skip-worktree must not
 * let unreviewed runtime bytes inherit completion.
 *
 * `null` is fail-closed. We refuse the identity when Git state races, output is
 * malformed or too large, the repository contains a submodule/sparse path that
 * cannot be observed exactly, or any path changes across the two full reads.
 */
export async function exactWorkspaceContentDigest(
  repoRootInput: string,
  freshness: Pick<FreshnessInfo, "headCommit" | "dirtyFiles" | "dirtyFileHashes">
): Promise<string | null> {
  const repoRoot = path.resolve(repoRootInput);
  if (!exactDirtyHashes(freshness) || !freshness.headCommit || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(freshness.headCommit)) {
    return null;
  }
  try {
    const initialHead = (await gitOutput(repoRoot, ["rev-parse", "HEAD"])).trim();
    if (initialHead !== freshness.headCommit) return null;
    const repoPrefix = normalizeGitPrefix(await gitOutput(repoRoot, ["rev-parse", "--show-prefix"]));
    if (repoPrefix === null) return null;
    const initialStatus = parseWorkspaceStatus(
      await gitOutput(repoRoot, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", "."]),
      repoPrefix
    );
    if (!initialStatus || !statusMatchesFreshness(initialStatus, freshness.dirtyFiles)) return null;
    const tree = parseWorkspaceTree(await gitOutput(repoRoot, ["ls-tree", "-r", "-z", "HEAD", "--", "."]));
    if (!tree || tree.length > WORKSPACE_CONTENT_MAX_FILES) return null;

    const entries = new Map(tree.map((entry) => [entry.path, entry]));
    for (const entry of initialStatus) {
      if (entry.status.includes("R") && entry.originalPath) entries.delete(entry.originalPath);
    }
    for (const file of [...new Set(freshness.dirtyFiles)].sort()) {
      const expectedHash = freshness.dirtyFileHashes[file];
      if (expectedHash === "missing") {
        entries.delete(file);
        continue;
      }
      entries.set(file, { mode: "100644", type: "blob", objectId: "", path: file });
    }
    if (entries.size > WORKSPACE_CONTENT_MAX_FILES) return null;

    const manifestEntries = [...entries.values()];
    const contentDeadlineAt = Date.now() + WORKSPACE_CONTENT_TIMEOUT_MS;
    const firstDigest = await exactRawWorkspaceDigest(repoRoot, manifestEntries, freshness.dirtyFileHashes, contentDeadlineAt);
    if (!firstDigest) return null;
    const secondDigest = await exactRawWorkspaceDigest(repoRoot, manifestEntries, freshness.dirtyFileHashes, contentDeadlineAt);
    if (!secondDigest || secondDigest !== firstDigest) return null;

    const finalStatus = parseWorkspaceStatus(
      await gitOutput(repoRoot, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", "."]),
      repoPrefix
    );
    if (!finalStatus || statusSignature(finalStatus) !== statusSignature(initialStatus)) return null;
    const finalHead = (await gitOutput(repoRoot, ["rev-parse", "HEAD"])).trim();
    if (finalHead !== freshness.headCommit) return null;
    return firstDigest;
  } catch {
    return null;
  }
}

function exactDirtyHashes(freshness: Pick<FreshnessInfo, "dirtyFiles" | "dirtyFileHashes">): boolean {
  const dirtyFiles = [...new Set(freshness.dirtyFiles)].sort();
  const hashedFiles = Object.keys(freshness.dirtyFileHashes).sort();
  return dirtyFiles.length === hashedFiles.length &&
    dirtyFiles.every((file, index) => file === hashedFiles[index] && safeRepoPath(file) === file) &&
    Object.values(freshness.dirtyFileHashes).every((digest) => digest === "missing" || /^[a-f0-9]{40}$/u.test(digest));
}

async function gitOutput(repoRoot: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", ["-C", repoRoot, ...args], {
    encoding: "utf8",
    timeout: WORKSPACE_GIT_TIMEOUT_MS,
    maxBuffer: WORKSPACE_GIT_MAX_BUFFER_BYTES,
    windowsHide: true
  });
  return result.stdout;
}

function parseWorkspaceTree(output: string): WorkspaceTreeEntry[] | null {
  if (output.includes("\ufffd")) return null;
  const entries: WorkspaceTreeEntry[] = [];
  const paths = new Set<string>();
  for (const raw of output.split("\0").filter(Boolean)) {
    const tab = raw.indexOf("\t");
    if (tab <= 0) return null;
    const [mode, type, objectId, ...extra] = raw.slice(0, tab).split(" ");
    const file = safeRepoPath(raw.slice(tab + 1));
    if (!file || extra.length > 0 || !/^(?:100644|100755|120000|160000)$/u.test(mode ?? "") ||
      !/^(?:blob|commit)$/u.test(type ?? "") || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(objectId ?? "") || paths.has(file)) {
      return null;
    }
    paths.add(file);
    if (!isCodexaGenerated(file)) entries.push({ mode: mode!, type: type!, objectId: objectId!, path: file });
  }
  return entries;
}

function parseWorkspaceStatus(output: string, repoPrefix: string): WorkspaceStatusEntry[] | null {
  if (output.includes("\ufffd")) return null;
  const rawEntries = output.split("\0").filter(Boolean);
  const entries: WorkspaceStatusEntry[] = [];
  for (let index = 0; index < rawEntries.length; index += 1) {
    const raw = rawEntries[index]!;
    if (raw.length < 4 || raw[2] !== " ") return null;
    const status = raw.slice(0, 2);
    const file = repoRelativeStatusPath(raw.slice(3), repoPrefix);
    if (!file) return null;
    let originalPath: string | undefined;
    if (status.includes("R") || status.includes("C")) {
      const original = rawEntries[++index];
      if (!original) return null;
      const parsedOriginal = repoRelativeStatusPath(original, repoPrefix);
      if (!parsedOriginal) return null;
      originalPath = parsedOriginal;
    }
    if (isCodexaGenerated(file)) continue;
    entries.push({ status, path: file, ...(!originalPath || isCodexaGenerated(originalPath) ? {} : { originalPath }) });
  }
  return entries;
}

function normalizeGitPrefix(output: string): string | null {
  const raw = output.trim();
  if (!raw) return "";
  const normalized = normalizePath(raw).replace(/\/+$/u, "");
  return safeRepoPath(normalized) ? `${normalized}/` : null;
}

function repoRelativeStatusPath(file: string, repoPrefix: string): string | null {
  const normalized = normalizePath(file);
  if (repoPrefix && !normalized.startsWith(repoPrefix)) return null;
  return safeRepoPath(repoPrefix ? normalized.slice(repoPrefix.length) : normalized);
}

function safeRepoPath(file: string): string | null {
  const normalized = normalizePath(file);
  return normalized.length > 0 && normalized === file && normalized !== "." && !path.posix.isAbsolute(normalized) &&
    normalized !== ".." && !normalized.startsWith("../") && !normalized.includes("\0")
    ? normalized
    : null;
}

function statusMatchesFreshness(status: WorkspaceStatusEntry[], dirtyFiles: string[]): boolean {
  const statusPaths = [...new Set(status.map((entry) => entry.path))].sort();
  const expectedPaths = [...new Set(dirtyFiles)].sort();
  return statusPaths.length === expectedPaths.length && statusPaths.every((file, index) => file === expectedPaths[index]);
}

function statusSignature(status: WorkspaceStatusEntry[]): string {
  return JSON.stringify(status.map((entry) => [entry.status, entry.path, entry.originalPath ?? null]));
}

async function exactRawWorkspaceDigest(
  repoRoot: string,
  entries: WorkspaceTreeEntry[],
  expectedDirtyHashes: Record<string, string>,
  deadlineAt: number
): Promise<string | null> {
  const budget: WorkspaceReadBudget = { remainingBytes: WORKSPACE_CONTENT_MAX_BYTES };
  const rawEntries: WorkspaceRawEntry[] = [];
  for (const entry of [...entries].sort((left, right) => left.path.localeCompare(right.path))) {
    if (Date.now() >= deadlineAt) return null;
    if (entry.type !== "blob") return null;
    const expectedHash = expectedDirtyHashes[entry.path];
    const raw = entry.mode === "120000" && expectedHash === undefined
      ? await stableWorkspaceSymlink(repoRoot, entry.path, budget, deadlineAt)
      : await stableWorkspaceFile(repoRoot, entry.path, expectedHash, budget, deadlineAt);
    if (!raw) return null;
    rawEntries.push({ ...raw, path: entry.path });
  }
  return workspaceRawDigest(rawEntries);
}

async function stableWorkspaceFile(
  repoRoot: string,
  file: string,
  expectedContentHash: string | undefined,
  budget: WorkspaceReadBudget,
  deadlineAt: number
): Promise<Omit<WorkspaceRawEntry, "path"> | null> {
  const absolutePath = path.resolve(repoRoot, file);
  if (absolutePath === repoRoot || !absolutePath.startsWith(`${repoRoot}${path.sep}`)) return null;
  let handle: fs.FileHandle | undefined;
  try {
    if (Date.now() >= deadlineAt) return null;
    const expected = await fs.lstat(absolutePath);
    if (!expected.isFile() || expected.isSymbolicLink()) return null;
    handle = await fs.open(absolutePath, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK | fsConstants.O_NOFOLLOW);
    const opened = await handle.stat();
    if (!sameFileIdentity(expected, opened)) return null;
    if (opened.size > budget.remainingBytes) return null;
    budget.remainingBytes -= opened.size;
    const freshnessHash = expectedContentHash ? createHash("sha1") : undefined;
    const contentHash = createHash("sha256");
    const chunk = Buffer.allocUnsafe(1024 * 1024);
    let position = 0;
    while (position < opened.size) {
      if (Date.now() >= deadlineAt) return null;
      const { bytesRead } = await handle.read(chunk, 0, Math.min(chunk.length, opened.size - position), position);
      if (bytesRead <= 0) return null;
      const bytes = chunk.subarray(0, bytesRead);
      freshnessHash?.update(bytes);
      contentHash.update(bytes);
      position += bytesRead;
    }
    if ((await handle.read(chunk, 0, 1, position)).bytesRead > 0) return null;
    const final = await handle.stat();
    const named = await fs.lstat(absolutePath);
    if (!sameFileIdentity(opened, final) || !sameFileIdentity(final, named) ||
      (freshnessHash && freshnessHash.digest("hex") !== expectedContentHash)) return null;
    return {
      contentDigest: contentHash.digest("hex"),
      mode: (final.mode & 0o111) !== 0 ? "100755" : "100644",
      type: "file"
    };
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function stableWorkspaceSymlink(
  repoRoot: string,
  file: string,
  budget: WorkspaceReadBudget,
  deadlineAt: number
): Promise<Omit<WorkspaceRawEntry, "path"> | null> {
  const absolutePath = path.resolve(repoRoot, file);
  if (absolutePath === repoRoot || !absolutePath.startsWith(`${repoRoot}${path.sep}`)) return null;
  try {
    if (Date.now() >= deadlineAt) return null;
    const expected = await fs.lstat(absolutePath);
    if (!expected.isSymbolicLink()) return null;
    const firstTarget = await fs.readlink(absolutePath, { encoding: "buffer" });
    const final = await fs.lstat(absolutePath);
    const secondTarget = await fs.readlink(absolutePath, { encoding: "buffer" });
    if (!sameNodeIdentity(expected, final) || !final.isSymbolicLink() || !firstTarget.equals(secondTarget) ||
      firstTarget.length > budget.remainingBytes) return null;
    budget.remainingBytes -= firstTarget.length;
    return {
      contentDigest: createHash("sha256").update(firstTarget).digest("hex"),
      mode: "120000",
      type: "symlink"
    };
  } catch {
    return null;
  }
}

function sameFileIdentity(left: Awaited<ReturnType<typeof fs.lstat>>, right: Awaited<ReturnType<typeof fs.lstat>>): boolean {
  return left.isFile() && right.isFile() && sameNodeIdentity(left, right);
}

function sameNodeIdentity(left: Awaited<ReturnType<typeof fs.lstat>>, right: Awaited<ReturnType<typeof fs.lstat>>): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode &&
    left.nlink === right.nlink && left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

function workspaceRawDigest(entries: WorkspaceRawEntry[]): string {
  const canonical = entries
    .sort((left, right) => left.path.localeCompare(right.path))
    .map((entry) => [entry.path, entry.mode, entry.type, entry.contentDigest]);
  return createHash("sha256").update("codexa-workspace-content-v2\0").update(JSON.stringify(canonical)).digest("hex");
}
