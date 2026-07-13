import { createHash } from "node:crypto";
import type { FreshnessInfo } from "./types.js";

export function workspaceStateDigest(freshness: Pick<FreshnessInfo, "headCommit" | "dirtyFileHashes">): string {
  const dirtyFileHashes = Object.fromEntries(Object.entries(freshness.dirtyFileHashes).sort(([left], [right]) => left.localeCompare(right)));
  return createHash("sha256").update(JSON.stringify({ dirtyFileHashes, headCommit: freshness.headCommit })).digest("hex");
}
