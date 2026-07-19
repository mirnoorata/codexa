import { promises as fs } from "node:fs";
import path from "node:path";
import { freshnessBanner, ambiguityResult } from "./runtime.js";
import type { CodexaIndex, FileFact, QueryResult, SymbolFact } from "../types.js";
import { isSubpath, normalizePath } from "../util.js";

export type ResolvedGraphTarget = {
  label: string;
  paths: Set<string>;
  file?: FileFact;
  symbol?: SymbolFact;
};

export function resolveSymbolTarget(index: CodexaIndex, symbolIdOrName: string): { symbol?: SymbolFact; ambiguous: SymbolFact[] } {
  const byId = index.symbols.find((symbol) => symbol.id === symbolIdOrName);
  if (byId) {
    return { symbol: byId, ambiguous: [] };
  }
  const byQualified = index.symbols.filter((symbol) => symbol.qualifiedName === symbolIdOrName);
  if (byQualified.length === 1) {
    return { symbol: byQualified[0], ambiguous: [] };
  }
  if (byQualified.length > 1) {
    return { ambiguous: byQualified };
  }
  const byName = index.symbols.filter((symbol) => symbol.name === symbolIdOrName);
  if (byName.length === 1) {
    return { symbol: byName[0], ambiguous: [] };
  }
  return { ambiguous: byName };
}

export function findFile(index: CodexaIndex, filePath: string): FileFact | undefined {
  return index.files.find((file) => file.path === filePath);
}

export function resolveFileTarget(index: CodexaIndex, filePath: string, repoRoot: string): { file?: FileFact; ambiguous: FileFact[] } {
  const normalized = normalizeInputPath(filePath, repoRoot);
  if (!normalized) {
    return { ambiguous: [] };
  }
  const exact = findFile(index, normalized);
  if (exact) {
    return { file: exact, ambiguous: [] };
  }
  return { ambiguous: index.files.filter((file) => file.path.endsWith(normalized)) };
}

export function normalizeInputPath(filePath: string, repoRoot: string): string | undefined {
  const portablePath = filePath.trim();
  if (/^(?:~(?:[\\/]|$)|\$[A-Za-z_][A-Za-z0-9_]*(?:[\\/]|$)|file:\/\/|[A-Za-z]:[\\/]|\\\\|\/\/)/u.test(portablePath)) return undefined;
  if (portablePath.replaceAll("\\", "/").split("/").includes("..")) return undefined;
  const absoluteRoot = path.resolve(repoRoot);
  const absoluteTarget = path.resolve(absoluteRoot, portablePath);
  const relative = path.relative(absoluteRoot, absoluteTarget);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return undefined;
  return relative.split(path.sep).join("/");
}

export function normalizeInputPaths(filePaths: string[], repoRoot: string): string[] {
  return filePaths.flatMap((filePath) => {
    const normalized = normalizeInputPath(filePath, repoRoot);
    return normalized ? [normalizePath(normalized)] : [];
  });
}

export type RepositoryTargetPathAuthority = {
  requestedPath: string;
  path?: string;
  status: "indexed" | "existing-unindexed" | "missing" | "invalid";
  viaSymlink: boolean;
  reason?: string;
};

/**
 * Resolve a proposed repository target against both the filesystem and the
 * current index. `normalizeInputPath` supplies the lexical containment check;
 * this additional filesystem walk keeps an existing ignored file or a
 * symlink alias from being mistaken for a brand-new destination.
 */
export async function repositoryTargetPathAuthority(
  filePath: string,
  repoRoot: string,
  repositoryFiles: Iterable<string>
): Promise<RepositoryTargetPathAuthority> {
  const requestedPath = filePath;
  const normalized = normalizeInputPath(filePath, repoRoot);
  if (!normalized) {
    return { requestedPath, status: "invalid", viaSymlink: false, reason: "target is not a contained repository-relative path" };
  }

  const absoluteRoot = path.resolve(repoRoot);
  const repoReal = await fs.realpath(absoluteRoot).catch(() => "");
  if (!repoReal) {
    return { requestedPath, status: "invalid", viaSymlink: false, reason: "repository root could not be resolved" };
  }

  let probe = absoluteRoot;
  let viaSymlink = false;
  for (const segment of normalized.split("/")) {
    probe = path.join(probe, segment);
    const stat = await fs.lstat(probe).catch((error: unknown) => errorCode(error) === "ENOENT" ? undefined : null);
    if (stat === null) {
      return { requestedPath, path: normalized, status: "invalid", viaSymlink, reason: "target path could not be inspected safely" };
    }
    if (!stat) {
      if (viaSymlink) {
        return { requestedPath, path: normalized, status: "invalid", viaSymlink, reason: "missing target traverses a symlink alias" };
      }
      return { requestedPath, path: normalized, status: "missing", viaSymlink: false };
    }
    viaSymlink ||= stat.isSymbolicLink();
  }

  const realTarget = await fs.realpath(path.resolve(absoluteRoot, normalized)).catch(() => "");
  if (!realTarget || !isSubpath(realTarget, repoReal)) {
    return { requestedPath, path: normalized, status: "invalid", viaSymlink, reason: "target resolves outside the repository" };
  }
  const canonicalPath = normalizePath(path.relative(repoReal, realTarget));
  if (!canonicalPath || canonicalPath === ".." || canonicalPath.startsWith("../")) {
    return { requestedPath, status: "invalid", viaSymlink, reason: "target does not resolve to a repository file path" };
  }
  const indexedPaths = new Set(repositoryFiles);
  return {
    requestedPath,
    path: canonicalPath,
    status: indexedPaths.has(canonicalPath) ? "indexed" : "existing-unindexed",
    viaSymlink
  };
}

export async function newTargetPathIsContained(filePath: string, repoRoot: string): Promise<boolean> {
  return (await repositoryTargetPathAuthority(filePath, repoRoot, [])).status === "missing";
}

function errorCode(error: unknown): string {
  return error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code) : "";
}

export function resolveGraphTarget(
  index: CodexaIndex,
  repoRoot: string,
  input: { file?: string; symbol?: string }
): ResolvedGraphTarget | { result: QueryResult } {
  if (input.symbol) {
    const resolved = resolveSymbolTarget(index, input.symbol);
    if (resolved.ambiguous.length > 0) {
      return { result: ambiguityResult(index.freshness, undefined, "symbol", input.symbol, resolved.ambiguous) };
    }
    if (resolved.symbol) {
      return { label: `symbol ${resolved.symbol.qualifiedName}`, paths: new Set(), symbol: resolved.symbol };
    }
  }
  if (input.file) {
    const resolved = resolveFileTarget(index, input.file, repoRoot);
    if (resolved.ambiguous.length > 0) {
      return { result: ambiguityResult(index.freshness, undefined, "file", input.file, resolved.ambiguous) };
    }
    if (resolved.file) {
      return { label: `file ${resolved.file.path}`, paths: new Set([resolved.file.path]), file: resolved.file };
    }
  }
  return {
    result: {
      freshness: index.freshness,
      text: `${freshnessBanner(index.freshness)}\nNo graph target matched. Provide a file or symbol.`,
      data: { target: null },
      refresh: { refreshed: false }
    }
  };
}

export function graphNodeIdsForTarget(index: CodexaIndex, target: ResolvedGraphTarget): Set<string> {
  const ids = new Set<string>();
  if (target.file) {
    ids.add(target.file.id);
    for (const symbol of index.symbols.filter((candidate) => candidate.path === target.file!.path)) {
      ids.add(symbol.id);
    }
  }
  if (target.symbol) {
    ids.add(target.symbol.id);
  }
  for (const filePath of target.paths) {
    const file = findFile(index, filePath);
    if (file) {
      ids.add(file.id);
    }
  }
  return ids;
}
