import type { ModuleClusterFact } from "./types.js";
import { stableId } from "./util.js";

export type ModuleArtifactIdentity = Pick<ModuleClusterFact, "id" | "name" | "clusterKind">;

const MAX_READABLE_SLUG_LENGTH = 64;

/**
 * Return a readable, deterministic filename for a generated module artifact.
 *
 * Module names are path-like labels, so a slug alone is not an identity:
 * `web/foo` and `web-foo` collapse to the same slug, while case-only names
 * collide on case-insensitive filesystems. The suffix fingerprints the exact
 * module identity and the bounded slug keeps the result portable.
 */
export function moduleArtifactFileName(module: ModuleArtifactIdentity): string {
  const slug = readableModuleSlug(module.name);
  const fingerprint = stableId("module-artifact-v1", module.id, module.clusterKind ?? "path", module.name);
  return `${slug}-${fingerprint}.md`;
}

function readableModuleSlug(name: string): string {
  const slug = name
    .replace(/[^A-Za-z0-9._-]+/gu, "-")
    .replace(/^[._-]+|[._-]+$/gu, "")
    .slice(0, MAX_READABLE_SLUG_LENGTH)
    .replace(/[._-]+$/gu, "")
    .toLowerCase();
  return slug || "root";
}
