import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { getGitStateAsync, type GitState } from "./git.js";
import { isSourcePath, shouldSkipPath } from "./language.js";
import { normalizePath } from "./util.js";

const MAX_DIRTY_CONTENT_HASH_BYTES = 2 * 1024 * 1024;

export interface RepoFiles {
  git: GitState;
  dirtyFileHashes: Record<string, string>;
  files: Array<{ path: string; absolutePath: string; dirty: boolean; sizeBytes: number; contentHash: string; sourceText: string }>;
}

export interface RepoFreshnessFiles {
  git: GitState;
  dirtyFileHashes: Record<string, string>;
}

export async function discoverRepoFiles(repoRoot: string): Promise<RepoFiles> {
  const git = await getGitStateAsync(repoRoot);
  const dirtySet = new Set(git.dirtyFiles);
  const dirtyFileHashes = await hashDirtyFiles(git.repoRoot, git.dirtyFiles);
  const selected = new Map<string, { path: string; absolutePath: string; dirty: boolean; sizeBytes: number; contentHash: string; sourceText: string }>();

  for (const file of git.files) {
    const normalized = normalizePath(file);
    if (!isSourcePath(normalized) || shouldSkipPath(normalized)) {
      continue;
    }
    const absolutePath = path.join(git.repoRoot, normalized);
    const stat = await safeLstat(absolutePath);
    if (!stat?.isFile()) {
      continue;
    }
    const sourceText = await fs.readFile(absolutePath, "utf8");
    selected.set(normalized, {
      path: normalized,
      absolutePath,
      dirty: dirtySet.has(normalized),
      sizeBytes: stat.size,
      contentHash: hashText(sourceText),
      sourceText
    });
  }

  return {
    git,
    dirtyFileHashes,
    files: [...selected.values()].sort((a, b) => a.path.localeCompare(b.path))
  };
}

export async function discoverRepoFreshness(repoRoot: string): Promise<RepoFreshnessFiles> {
  const git = await getGitStateAsync(repoRoot, { includeFiles: false, includeChurn: false });
  return {
    git,
    dirtyFileHashes: await hashDirtyFiles(git.repoRoot, git.dirtyFiles)
  };
}

function hashText(sourceText: string): string {
  return createHash("sha1").update(sourceText).digest("hex");
}

async function hashDirtyFiles(repoRoot: string, dirtyFiles: string[]): Promise<Record<string, string>> {
  const hashes: Record<string, string> = {};
  await Promise.all(
    dirtyFiles.map(async (file) => {
      const absolutePath = path.join(repoRoot, file);
      try {
        const stat = await fs.lstat(absolutePath);
        if (!stat.isFile()) {
          hashes[file] = "non-file";
          return;
        }
        if (!isSourcePath(file) || stat.size > MAX_DIRTY_CONTENT_HASH_BYTES) {
          hashes[file] = `metadata:${stat.size}:${Math.trunc(stat.mtimeMs)}`;
          return;
        }
        const content = await fs.readFile(absolutePath);
        hashes[file] = createHash("sha1").update(content).digest("hex");
      } catch {
        hashes[file] = "missing";
      }
    })
  );
  return Object.fromEntries(Object.entries(hashes).sort(([a], [b]) => a.localeCompare(b)));
}

async function safeLstat(filePath: string) {
  try {
    return await fs.lstat(filePath);
  } catch {
    return null;
  }
}
