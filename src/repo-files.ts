import { createReadStream, promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { getGitStateAsync, type GitState } from "./git.js";
import { isSourcePath, shouldSkipPath } from "./language.js";
import { mapLimit, normalizePath } from "./util.js";

// Per-file streaming cap for dirty-file content hashing (low memory, no whole-
// file buffer) and a per-call total budget so a pathological untracked tree
// cannot force unbounded I/O on every freshness check. Files past either cap
// fall back to a metadata hash (documented residual collision for very large
// dirty files).
const MAX_DIRTY_CONTENT_HASH_BYTES = 64 * 1024 * 1024;
const MAX_DIRTY_TOTAL_HASH_BYTES = 256 * 1024 * 1024;
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

// Returns undefined when the file exceeds maxBytes mid-stream (it grew past the
// per-file cap between the stat pass and now), so the caller falls back to a
// fresh metadata hash and per-file I/O stays bounded even if a dirty file grows.
async function streamSha1(filePath: string, maxBytes: number): Promise<string | undefined> {
  const hash = createHash("sha1");
  const stream = createReadStream(filePath);
  let read = 0;
  for await (const chunk of stream) {
    read += chunk.length;
    if (read > maxBytes) {
      stream.destroy();
      return undefined;
    }
    hash.update(chunk);
  }
  return hash.digest("hex");
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
  const stats = await mapLimit(sorted, SOURCE_DISCOVERY_CONCURRENCY, async (file): Promise<[string, { size: number; mtimeMs: number } | { sentinel: string }]> => {
    try {
      const stat = await fs.lstat(path.join(repoRoot, file));
      return [file, stat.isFile() ? { size: stat.size, mtimeMs: stat.mtimeMs } : { sentinel: "non-file" }];
    } catch (error) {
      return [file, { sentinel: unreadableSentinel(error) }];
    }
  });

  let reservedBytes = 0;
  const resolved = new Map<string, string>();
  const contentTargets: string[] = [];
  for (const [file, info] of stats) {
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

  const contentHashes = await mapLimit(contentTargets, SOURCE_DISCOVERY_CONCURRENCY, async (file): Promise<[string, string]> => {
    const absolutePath = path.join(repoRoot, file);
    try {
      const hash = await streamSha1(absolutePath, MAX_DIRTY_CONTENT_HASH_BYTES);
      if (hash !== undefined) {
        return [file, hash];
      }
      // Grew past the per-file cap mid-stream; fall back to fresh metadata.
      return [file, metadataHash(await fs.lstat(absolutePath))];
    } catch (error) {
      return [file, unreadableSentinel(error)];
    }
  });
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
