import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { FreshnessInfo } from "./types.js";

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
