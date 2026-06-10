import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { getGitStateAsync, type GitState } from "./git.js";
import { isSourcePath, shouldSkipPath } from "./language.js";
import { mapLimit, normalizePath } from "./util.js";

const MAX_DIRTY_CONTENT_HASH_BYTES = 2 * 1024 * 1024;
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

function metadataHash(stat: { size: number; mtimeMs: number }): string {
  return `metadata:${stat.size}:${Math.trunc(stat.mtimeMs)}`;
}

async function hashDirtyFiles(repoRoot: string, dirtyFiles: string[]): Promise<Record<string, string>> {
  const entries = await mapLimit(dirtyFiles, SOURCE_DISCOVERY_CONCURRENCY, async (file): Promise<[string, string]> => {
    const absolutePath = path.join(repoRoot, file);
    try {
      const stat = await fs.lstat(absolutePath);
      if (!stat.isFile()) {
        return [file, "non-file"];
      }
      if (!isSourcePath(file) || stat.size > MAX_DIRTY_CONTENT_HASH_BYTES) {
        return [file, `metadata:${stat.size}:${Math.trunc(stat.mtimeMs)}`];
      }
      const content = await fs.readFile(absolutePath);
      return [file, createHash("sha1").update(content).digest("hex")];
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      return [file, code === "ENOENT" ? "missing" : `unreadable:${typeof code === "string" ? code : "unknown"}`];
    }
  });
  return Object.fromEntries(entries.sort(([a], [b]) => a.localeCompare(b)));
}

async function safeLstat(filePath: string) {
  try {
    return await fs.lstat(filePath);
  } catch {
    return null;
  }
}
