import { constants as fsConstants, promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import {
  checkpointSessionStartBudget,
  SessionStartBudgetExhausted,
  sessionStartDeadlineAt
} from "./session-start-budget.js";
import { getGitStateAsync, type GitState } from "./git.js";
import { isSourcePath, shouldSkipPath } from "./language.js";
import { mapLimit, mapLimitChecked, normalizePath } from "./util.js";

// Per-file streaming cap for dirty-file content hashing (low memory, no whole-
// file buffer) and a per-call total budget so a pathological untracked tree
// cannot force unbounded I/O on every freshness check. Files past either cap
// fall back to a metadata hash (documented residual collision for very large
// dirty files).
const MAX_DIRTY_CONTENT_HASH_BYTES = 64 * 1024 * 1024;
const MAX_DIRTY_TOTAL_HASH_BYTES = 256 * 1024 * 1024;
const DIRTY_FILE_HASH_TIMEOUT_MS = 5_000;
export const MAX_INDEXED_SOURCE_BYTES = 2 * 1024 * 1024;
const SOURCE_DISCOVERY_CONCURRENCY = 16;

export interface RepoSourceFile {
  path: string;
  absolutePath: string;
  dirty: boolean;
  sizeBytes: number;
  contentHash: string;
}

export interface RepoSkippedFile extends RepoSourceFile {
  reason: "source-file-too-large";
}

export interface RepoFiles {
  git: GitState;
  dirtyFileHashes: Record<string, string>;
  files: RepoSourceFile[];
  skippedFiles: RepoSkippedFile[];
}

export interface RepoFreshnessFiles {
  git: GitState;
  dirtyFileHashes: Record<string, string>;
}

export async function discoverRepoFiles(repoRoot: string): Promise<RepoFiles> {
  const git = await getGitStateAsync(repoRoot);
  const dirtySet = new Set(git.dirtyFiles);
  const dirtyFileHashes = await hashDirtyFiles(git.repoRoot, git.dirtyFiles);
  const selected = new Map<string, RepoSourceFile>();
  const skipped = new Map<string, RepoSkippedFile>();

  const discovered = await mapLimit(git.files, SOURCE_DISCOVERY_CONCURRENCY, async (file) => {
    const normalized = normalizePath(file);
    if (!isSourcePath(normalized) || shouldSkipPath(normalized)) {
      return null;
    }
    const absolutePath = path.join(git.repoRoot, normalized);
    const stat = await safeLstat(absolutePath);
    if (!stat?.isFile()) {
      return null;
    }
    if (stat.size > MAX_INDEXED_SOURCE_BYTES) {
      return {
        skipped: {
          path: normalized,
          absolutePath,
          dirty: dirtySet.has(normalized),
          sizeBytes: stat.size,
          contentHash: metadataHash(stat),
          reason: "source-file-too-large" as const
        }
      };
    }
    return {
      selected: {
        path: normalized,
        absolutePath,
        dirty: dirtySet.has(normalized),
        sizeBytes: stat.size,
        contentHash: await hashFileContent(absolutePath)
      }
    };
  });

  for (const result of discovered) {
    if (result?.selected) {
      selected.set(result.selected.path, result.selected);
    }
    if (result?.skipped) {
      skipped.set(result.skipped.path, result.skipped);
    }
  }

  return {
    git,
    dirtyFileHashes,
    files: [...selected.values()].sort((a, b) => a.path.localeCompare(b.path)),
    skippedFiles: [...skipped.values()].sort((a, b) => a.path.localeCompare(b.path))
  };
}

export async function discoverRepoFreshness(repoRoot: string): Promise<RepoFreshnessFiles> {
  const git = await getGitStateAsync(repoRoot, { includeFiles: false, includeChurn: false });
  return {
    git,
    dirtyFileHashes: await hashDirtyFiles(git.repoRoot, git.dirtyFiles)
  };
}

async function hashFileContent(filePath: string): Promise<string> {
  return createHash("sha1").update(await fs.readFile(filePath)).digest("hex");
}

// Returns undefined when the file exceeds maxBytes during the stable read, so
// the caller falls back to metadata. Opening with nonblocking/no-follow flags
// prevents a regular-to-special-file swap from stalling SessionStart.
async function streamSha1(filePath: string, maxBytes: number, deadlineAt: number): Promise<string | undefined> {
  assertDirtyHashDeadline(deadlineAt, "dirty-file-content");
  const expected = await fs.lstat(filePath);
  assertDirtyHashDeadline(deadlineAt, "dirty-file-content");
  if (!expected.isFile() || expected.isSymbolicLink()) {
    throw new Error("dirty-file-not-regular");
  }
  if (expected.size > maxBytes) return undefined;
  const hash = createHash("sha1");
  const handle = await fs.open(
    filePath,
    fsConstants.O_RDONLY | fsConstants.O_NONBLOCK | fsConstants.O_NOFOLLOW
  );
  try {
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      opened.dev !== expected.dev ||
      opened.ino !== expected.ino ||
      opened.mode !== expected.mode ||
      opened.nlink !== expected.nlink ||
      opened.size !== expected.size
    ) {
      throw new Error("dirty-file-changed-during-read");
    }
    const scratch = Buffer.allocUnsafe(1024 * 1024);
    let position = 0;
    while (position < expected.size) {
      assertDirtyHashDeadline(deadlineAt, "dirty-file-content");
      const length = Math.min(scratch.length, expected.size - position);
      const { bytesRead } = await handle.read(scratch, 0, length, position);
      if (bytesRead <= 0) throw new Error("dirty-file-changed-during-read");
      hash.update(scratch.subarray(0, bytesRead));
      position += bytesRead;
    }
    const probe = Buffer.allocUnsafe(1);
    if ((await handle.read(probe, 0, 1, position)).bytesRead > 0) return undefined;
    const final = await handle.stat();
    if (
      final.dev !== opened.dev ||
      final.ino !== opened.ino ||
      final.mode !== opened.mode ||
      final.nlink !== opened.nlink ||
      final.size !== opened.size ||
      final.mtimeMs !== opened.mtimeMs ||
      final.ctimeMs !== opened.ctimeMs
    ) {
      if (final.size > maxBytes) return undefined;
      throw new Error("dirty-file-changed-during-read");
    }
    const named = await fs.lstat(filePath);
    if (
      !named.isFile() ||
      named.isSymbolicLink() ||
      named.dev !== final.dev ||
      named.ino !== final.ino ||
      named.mode !== final.mode ||
      named.nlink !== final.nlink ||
      named.size !== final.size ||
      named.mtimeMs !== final.mtimeMs ||
      named.ctimeMs !== final.ctimeMs
    ) {
      throw new Error("dirty-file-changed-during-read");
    }
    assertDirtyHashDeadline(deadlineAt, "dirty-file-content");
    return hash.digest("hex");
  } finally {
    await handle.close();
  }
}

function assertDirtyHashDeadline(deadlineAt: number, stage: string): void {
  checkpointSessionStartBudget(stage);
  if (Date.now() >= deadlineAt) throw new Error("dirty-file-hash-timeout");
}

function metadataHash(stat: { size: number; mtimeMs: number }): string {
  return `metadata:${stat.size}:${Math.trunc(stat.mtimeMs)}`;
}

function unreadableSentinel(error: unknown): string {
  const code = (error as NodeJS.ErrnoException)?.code;
  return code === "ENOENT" ? "missing" : `unreadable:${typeof code === "string" ? code : "unknown"}`;
}

async function hashDirtyFiles(repoRoot: string, dirtyFiles: string[]): Promise<Record<string, string>> {
  // Stat every file first, then decide content-vs-metadata in a single sequential
  // pass over the sorted paths. Reserving the budget inside the concurrent stat
  // tasks would make which files straddling the per-call budget get a content
  // hash depend on lstat completion order, so identical on-disk state could hash
  // differently across freshness checks and report spurious drift.
  const sorted = [...dirtyFiles].sort((a, b) => a.localeCompare(b));
  const deadlineAt = sessionStartDeadlineAt(Date.now() + DIRTY_FILE_HASH_TIMEOUT_MS);
  const stats = await mapLimitChecked(
    sorted,
    SOURCE_DISCOVERY_CONCURRENCY,
    () => assertDirtyHashDeadline(deadlineAt, "dirty-file-stat"),
    async (file): Promise<[string, { size: number; mtimeMs: number } | { sentinel: string }]> => {
      try {
        const stat = await fs.lstat(path.join(repoRoot, file));
        return [file, stat.isFile() ? { size: stat.size, mtimeMs: stat.mtimeMs } : { sentinel: "non-file" }];
      } catch (error) {
        return [file, { sentinel: unreadableSentinel(error) }];
      }
    }
  );

  let reservedBytes = 0;
  const resolved = new Map<string, string>();
  const contentTargets: string[] = [];
  for (const [file, info] of stats) {
    assertDirtyHashDeadline(deadlineAt, "dirty-file-plan");
    if ("sentinel" in info) {
      resolved.set(file, info.sentinel);
      continue;
    }
    // Content-hash every dirty file regardless of extension: a metadata hash
    // collides for any same-length edit landing in the same coarse mtime tick,
    // silently reconciling a real change as "unchanged". Files past the per-file
    // cap or the deterministic per-call budget fall back to metadata.
    if (info.size > MAX_DIRTY_CONTENT_HASH_BYTES || reservedBytes + info.size > MAX_DIRTY_TOTAL_HASH_BYTES) {
      resolved.set(file, metadataHash(info));
      continue;
    }
    reservedBytes += info.size;
    contentTargets.push(file);
  }

  const contentHashes = await mapLimitChecked(
    contentTargets,
    SOURCE_DISCOVERY_CONCURRENCY,
    () => assertDirtyHashDeadline(deadlineAt, "dirty-file-content"),
    async (file): Promise<[string, string]> => {
      const absolutePath = path.join(repoRoot, file);
      try {
        const hash = await streamSha1(absolutePath, MAX_DIRTY_CONTENT_HASH_BYTES, deadlineAt);
        if (hash !== undefined) {
          return [file, hash];
        }
        // Grew past the per-file cap mid-stream; fall back to fresh metadata.
        return [file, metadataHash(await fs.lstat(absolutePath))];
      } catch (error) {
        if (error instanceof SessionStartBudgetExhausted) throw error;
        return [file, unreadableSentinel(error)];
      }
    }
  );
  for (const [file, hash] of contentHashes) {
    resolved.set(file, hash);
  }

  return Object.fromEntries([...resolved].sort(([a], [b]) => a.localeCompare(b)));
}

async function safeLstat(filePath: string) {
  try {
    return await fs.lstat(filePath);
  } catch {
    return null;
  }
}
