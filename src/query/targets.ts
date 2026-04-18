import path from "node:path";
import { freshnessBanner, ambiguityResult } from "./runtime.js";
import type { CodexaIndex, FileFact, QueryResult, SymbolFact } from "../types.js";
import { normalizePath } from "../util.js";

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
  const normalized = filePath.split(path.sep).join("/");
  if (path.isAbsolute(filePath)) {
    const relative = path.relative(repoRoot, filePath).split(path.sep).join("/");
    return relative && !relative.startsWith("..") ? relative : undefined;
  }
  return normalized && !normalized.startsWith("..") ? normalized : undefined;
}

export function normalizeInputPaths(filePaths: string[], repoRoot: string): string[] {
  return filePaths.flatMap((filePath) => {
    const normalized = normalizeInputPath(filePath, repoRoot);
    return normalized ? [normalizePath(normalized)] : [];
  });
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
