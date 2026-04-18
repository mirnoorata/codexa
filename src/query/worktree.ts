import path from "node:path";
import { runCommand, type CommandResult, type RunCommandOptions } from "../command.js";
import type { ChangedFileEntry, ChangedSymbol, CodexaIndex } from "../types.js";
import { normalizePath } from "../util.js";

const GIT_TIMEOUT_MS = 5_000;
const GIT_MAX_BUFFER_BYTES = 1024 * 1024;
type WorktreeCommandRunner = (command: string, args: string[], options?: RunCommandOptions) => Promise<CommandResult>;

// A degraded worktree is one where git couldn't report state reliably
// (rev-parse failure, timeout, truncated output, etc.). Empty `entries`
// paired with a non-null `degradedReason` means "we don't know", which
// is NOT the same as "the tree is clean". Callers that act on emptiness
// (e.g. post-edit review) must surface the degradation rather than
// treating it as a clean state.
export interface ChangedFilesResult {
  entries: ChangedFileEntry[];
  degradedReason: string | null;
}

export interface ChangedSymbolsResult {
  symbols: ChangedSymbol[];
  degradedReason: string | null;
}

export async function getChangedFileEntries(repoRoot: string, commandRunner: WorktreeCommandRunner = runCommand): Promise<ChangedFilesResult> {
  const resolvedRepo = path.resolve(repoRoot);
  const gitRootResult = await commandRunner("git", ["-C", resolvedRepo, "rev-parse", "--show-toplevel"], {
    timeoutMs: 2_000,
    maxBufferBytes: 64 * 1024
  });
  if (!gitRootResult.ok) {
    return { entries: [], degradedReason: commandFailureReason("git rev-parse --show-toplevel", gitRootResult) };
  }
  const gitRoot = gitRootResult.stdout.trim();
  const relativePrefix = normalizePath(path.relative(gitRoot, resolvedRepo));
  const statusResult = await commandRunner("git", ["-C", resolvedRepo, "status", "--porcelain=v1", "-z", "--untracked-files=all"], {
    timeoutMs: GIT_TIMEOUT_MS,
    maxBufferBytes: GIT_MAX_BUFFER_BYTES
  });
  if (!statusResult.ok) {
    return { entries: [], degradedReason: commandFailureReason("git status --porcelain", statusResult) };
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
  return {
    entries: files.filter((entry) => !isCodexaControlPath(entry.path)).sort((a, b) => a.path.localeCompare(b.path) || a.status.localeCompare(b.status)),
    degradedReason: null
  };
}

export async function getChangedSymbols(repoRoot: string, index: CodexaIndex, commandRunner: WorktreeCommandRunner = runCommand): Promise<ChangedSymbolsResult> {
  const { rangesByPath, degradedReason } = await getChangedRanges(repoRoot, commandRunner);
  if (rangesByPath.size === 0) {
    return { symbols: [], degradedReason };
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
  return {
    symbols: changed.sort(
      (a, b) =>
        a.symbol.path.localeCompare(b.symbol.path) ||
        (a.symbol.range?.startLine ?? 0) - (b.symbol.range?.startLine ?? 0) ||
        a.symbol.qualifiedName.localeCompare(b.symbol.qualifiedName)
    ),
    degradedReason
  };
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

async function getChangedRanges(
  repoRoot: string,
  commandRunner: WorktreeCommandRunner
): Promise<{
  rangesByPath: Map<string, Array<{ startLine: number; endLine: number }>>;
  degradedReason: string | null;
}> {
  const [worktreeDiff, stagedDiff] = await Promise.all([
    gitDiff(repoRoot, ["diff", "--unified=0", "--no-ext-diff"], commandRunner),
    gitDiff(repoRoot, ["diff", "--cached", "--unified=0", "--no-ext-diff"], commandRunner)
  ]);
  const degradedReasons = [worktreeDiff.degradedReason, stagedDiff.degradedReason].filter(
    (reason): reason is string => Boolean(reason)
  );
  const combined = [worktreeDiff.stdout, stagedDiff.stdout].filter(Boolean).join("\n");
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
  return {
    rangesByPath: ranges,
    degradedReason: degradedReasons.length > 0 ? degradedReasons.join("; ") : null
  };
}

async function gitDiff(
  repoRoot: string,
  args: string[],
  commandRunner: WorktreeCommandRunner
): Promise<{ stdout: string; degradedReason: string | null }> {
  const result = await commandRunner("git", ["-C", path.resolve(repoRoot), ...args], {
    timeoutMs: GIT_TIMEOUT_MS,
    maxBufferBytes: GIT_MAX_BUFFER_BYTES
  });
  if (result.ok) {
    return { stdout: result.stdout, degradedReason: null };
  }
  return {
    stdout: "",
    degradedReason: commandFailureReason(`git ${args.join(" ")}`, result)
  };
}

function commandFailureReason(label: string, result: CommandResult): string {
  if (result.timedOut) {
    return `${label} timed out`;
  }
  if (result.truncated) {
    return `${label} output truncated`;
  }
  if (typeof result.exitCode === "number" && result.exitCode !== 0) {
    return `${label} exited with code ${result.exitCode}`;
  }
  return `${label} failed`;
}

function rangesIntersect(startA: number, endA: number, startB: number, endB: number): boolean {
  return startA <= endB && startB <= endA;
}

export function isCodexaControlPath(filePath: string): boolean {
  return filePath === ".codex" || filePath.startsWith(".codex/");
}
