import { createHash } from "node:crypto";
import path from "node:path";

export function normalizePath(filePath: string): string {
  return filePath.split(path.sep).join("/");
}

export function stableId(...parts: Array<string | number | undefined | null>): string {
  const hash = createHash("sha1");
  hash.update(parts.filter((part) => part !== undefined && part !== null).join("\0"));
  return hash.digest("hex").slice(0, 16);
}

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

export function topBy<T>(items: T[], score: (item: T) => number, limit: number): T[] {
  return [...items].sort((a, b) => score(b) - score(a) || stableSortKey(a).localeCompare(stableSortKey(b))).slice(0, limit);
}

export async function mapLimit<T, R>(items: T[], limit: number, mapper: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

function stableSortKey(item: unknown): string {
  if (item && typeof item === "object") {
    const record = item as Record<string, unknown>;
    for (const key of ["path", "qualifiedName", "name", "id"]) {
      if (typeof record[key] === "string") {
        return record[key];
      }
    }
  }
  return JSON.stringify(item);
}

export function relativeTo(base: string, target: string): string {
  return normalizePath(path.relative(base, target));
}

export function formatPathLine(filePath: string, line?: number): string {
  return line ? `${filePath}:${line}` : filePath;
}

export function escapeMarkdown(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll("\n", " ");
}

export function limitText(value: string, max = 2000): string {
  if (value.length <= max) {
    return value;
  }
  return `${value.slice(0, max - 20)}\n... truncated ...`;
}

// log2(rank+1) used as a ranking signal, made safe against the negative ranks a
// generated-file penalty can produce and against a non-finite rank from a
// corrupt/hand-edited cached index (Math.max(0, NaN) is still NaN, which would
// poison every score that sums it).
export function rankLog2(rank: number): number {
  return Math.log2((Number.isFinite(rank) ? Math.max(0, rank) : 0) + 1);
}

export function isSubpath(candidate: string, parent: string): boolean {
  const rel = path.relative(parent, candidate);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}
