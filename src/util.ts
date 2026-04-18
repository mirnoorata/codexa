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

export function isSubpath(candidate: string, parent: string): boolean {
  const rel = path.relative(parent, candidate);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}
