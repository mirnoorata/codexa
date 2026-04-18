import path from "node:path";
import { runCommand, type CommandResult, type RunCommandOptions } from "../command.js";
import type { ChangedFileEntry, ChangedSymbol, CodexaIndex } from "../types.js";
import { normalizePath } from "../util.js";

const GIT_TIMEOUT_MS = 5_000;
const GIT_MAX_BUFFER_BYTES = 1024 * 1024;
type WorktreeCommandRunner = (command: string, args: string[], options?: RunCommandOptions) => Promise<CommandResult>;

export async function getChangedFileEntries(repoRoot: string, commandRunner: WorktreeCommandRunner = runCommand): Promise<ChangedFileEntry[]> {
  const resolvedRepo = path.resolve(repoRoot);
  const gitRootResult = await commandRunner("git", ["-C", resolvedRepo, "rev-parse", "--show-toplevel"], {
    timeoutMs: 2_000,
    maxBufferBytes: 64 * 1024
  });
  if (!gitRootResult.ok) {
    return [];
  }
  const gitRoot = gitRootResult.stdout.trim();
  const relativePrefix = normalizePath(path.relative(gitRoot, resolvedRepo));
  const statusResult = await commandRunner("git", ["-C", resolvedRepo, "status", "--porcelain=v1", "-z", "--untracked-files=all"], {
    timeoutMs: GIT_TIMEOUT_MS,
    maxBufferBytes: GIT_MAX_BUFFER_BYTES
  });
  if (!statusResult.ok) {
    return [];
  }
  const entries = statusResult.stdout.split("\0").filter(Boolean);
  const files: ChangedFileEntry[] = [];
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    if (!entry || entry.length < 4) {
      continue;
    }
    const status = entry.slice(0, 2);
    const pathValue = repoRelativeStatusPath(entry.slice(3), relativePrefix);
    if (!pathValue) {
      if (status.includes("R") || status.includes("C")) {
        i += 1;
      }
      continue;
    }
    if (status.includes("R") || status.includes("C")) {
      files.push(changedEntry(pathValue, status, repoRelativeStatusPath(entries[i + 1] ?? "", relativePrefix)));
      i += 1;
    } else {
      files.push(changedEntry(pathValue, status));
    }
  }
  return files.filter((entry) => !isCodexaControlPath(entry.path)).sort((a, b) => a.path.localeCompare(b.path) || a.status.localeCompare(b.status));
}

export async function getChangedSymbols(repoRoot: string, index: CodexaIndex, commandRunner: WorktreeCommandRunner = runCommand): Promise<ChangedSymbol[]> {
  const rangesByPath = await getChangedRanges(repoRoot, commandRunner);
  if (rangesByPath.size === 0) {
    return [];
  }
  const changed: ChangedSymbol[] = [];
  for (const symbol of index.symbols) {
    if (!symbol.range) {
      continue;
    }
    const ranges = rangesByPath.get(symbol.path);
    if (!ranges?.length) {
      continue;
    }
    const touched = ranges.filter((range) => rangesIntersect(symbol.range!.startLine, symbol.range!.endLine, range.startLine, range.endLine));
    if (touched.length > 0) {
      changed.push({
        symbol,
        changedLines: touched.map((range) => (range.startLine === range.endLine ? String(range.startLine) : `${range.startLine}-${range.endLine}`))
      });
    }
  }
  return changed.sort(
    (a, b) =>
      a.symbol.path.localeCompare(b.symbol.path) ||
      (a.symbol.range?.startLine ?? 0) - (b.symbol.range?.startLine ?? 0) ||
      a.symbol.qualifiedName.localeCompare(b.symbol.qualifiedName)
  );
}

export function formatChangedEntry(entry: ChangedFileEntry): string {
  const old = entry.oldPath ? ` from ${entry.oldPath}` : "";
  return `- ${entry.path}: ${entry.kind} (${entry.status.trim() || "worktree"})${old}`;
}

function repoRelativeStatusPath(filePath: string, relativePrefix: string): string | undefined {
  const normalized = normalizePath(filePath);
  if (!relativePrefix) {
    return normalized;
  }
  if (!(normalized === relativePrefix || normalized.startsWith(`${relativePrefix}/`))) {
    return undefined;
  }
  const relative = normalizePath(path.relative(relativePrefix, normalized));
  return relative && !relative.startsWith("..") ? relative : undefined;
}

function changedEntry(filePath: string, status: string, oldPath?: string): ChangedFileEntry {
  const untracked = status === "??";
  const staged = !untracked && status[0] !== " " && status[0] !== "?";
  const worktree = untracked || (status[1] !== " " && status[1] !== "?");
  return {
    path: filePath,
    oldPath,
    status,
    kind: changedKind(status),
    staged,
    worktree
  };
}

function changedKind(status: string): ChangedFileEntry["kind"] {
  if (status === "??") {
    return "untracked";
  }
  if (status.includes("R")) {
    return "renamed";
  }
  if (status.includes("C")) {
    return "copied";
  }
  if (status.includes("A")) {
    return "added";
  }
  if (status.includes("D")) {
    return "deleted";
  }
  if (status.includes("M")) {
    return "modified";
  }
  return "unknown";
}

async function getChangedRanges(repoRoot: string, commandRunner: WorktreeCommandRunner): Promise<Map<string, Array<{ startLine: number; endLine: number }>>> {
  const [worktreeDiff, stagedDiff] = await Promise.all([
    gitDiff(repoRoot, ["diff", "--unified=0", "--no-ext-diff"], commandRunner),
    gitDiff(repoRoot, ["diff", "--cached", "--unified=0", "--no-ext-diff"], commandRunner)
  ]);
  const combined = [worktreeDiff, stagedDiff].filter(Boolean).join("\n");
  const ranges = new Map<string, Array<{ startLine: number; endLine: number }>>();
  let currentFile = "";
  for (const line of combined.split(/\r?\n/)) {
    if (line.startsWith("+++ b/")) {
      currentFile = normalizePath(line.slice("+++ b/".length));
      continue;
    }
    if (!line.startsWith("@@") || !currentFile || isCodexaControlPath(currentFile)) {
      continue;
    }
    const match = /\+(\d+)(?:,(\d+))?/.exec(line);
    if (!match) {
      continue;
    }
    const startLine = Number.parseInt(match[1], 10);
    const span = Number.parseInt(match[2] ?? "1", 10);
    const endLine = span === 0 ? startLine : startLine + span - 1;
    const existing = ranges.get(currentFile) ?? [];
    existing.push({ startLine, endLine });
    ranges.set(currentFile, existing);
  }
  return ranges;
}

async function gitDiff(repoRoot: string, args: string[], commandRunner: WorktreeCommandRunner): Promise<string> {
  const result = await commandRunner("git", ["-C", path.resolve(repoRoot), ...args], {
    timeoutMs: GIT_TIMEOUT_MS,
    maxBufferBytes: GIT_MAX_BUFFER_BYTES
  });
  return result.ok ? result.stdout : "";
}

function rangesIntersect(startA: number, endA: number, startB: number, endB: number): boolean {
  return startA <= endB && startB <= endA;
}

export function isCodexaControlPath(filePath: string): boolean {
  return filePath === ".codex" || filePath.startsWith(".codex/");
}
