import { promises as fs } from "node:fs";
import path from "node:path";
import { limitText, uniqueSorted } from "../util.js";

type WorkspaceGuidanceSource = "WORKING.md" | "MEMORY.md";

export interface WorkspaceGuidanceLine {
  source: WorkspaceGuidanceSource;
  line: number;
  text: string;
  score: number;
  reasons: string[];
}

export interface WorkspaceGuidancePreview {
  workspaceRoot: string;
  files: string[];
  lines: WorkspaceGuidanceLine[];
  warnings: string[];
}

export async function workspaceGuidancePreview(input: {
  repoRoot: string;
  task?: string;
  query?: string;
  files?: string[];
  symbols?: string[];
  limit: number;
}): Promise<{ lines: string[]; data?: WorkspaceGuidancePreview }> {
  const workspaceRoot = await findWorkspaceRoot(input.repoRoot);
  if (!workspaceRoot) {
    return { lines: [] };
  }

  const terms = guidanceTerms(input);
  if (terms.size === 0) {
    return { lines: [] };
  }

  const files = [
    { source: "WORKING.md" as const, path: path.join(workspaceRoot, ".codex", "WORKING.md"), maxLines: 320 },
    { source: "MEMORY.md" as const, path: path.join(workspaceRoot, ".codex", "MEMORY.md"), maxLines: 1200 }
  ];
  const warnings: string[] = [];
  const candidates: WorkspaceGuidanceLine[] = [];

  for (const file of files) {
    const read = await readGuidanceFile(file.path, file.maxLines);
    if (read.warning) {
      warnings.push(`${file.source}: ${read.warning}`);
      continue;
    }
    for (const entry of read.lines) {
      const scored = scoreGuidanceLine(entry.text, file.source, entry.line, terms, input.files ?? [], input.repoRoot);
      if (scored) {
        candidates.push(scored);
      }
    }
  }

  const selected = dedupeGuidanceLines(candidates)
    .sort((a, b) => b.score - a.score || sourcePriority(a.source) - sourcePriority(b.source) || a.line - b.line)
    .slice(0, Math.max(0, input.limit));

  if (selected.length === 0 && warnings.length === 0) {
    return { lines: [] };
  }

  return {
    lines: selected.map((line) => `- ${line.source}:${line.line}: ${line.text}`),
    data: {
      workspaceRoot,
      files: files.map((file) => path.relative(workspaceRoot, file.path)),
      lines: selected,
      warnings
    }
  };
}

async function findWorkspaceRoot(repoRoot: string): Promise<string | undefined> {
  let current = path.resolve(repoRoot);
  while (true) {
    const codexDir = path.join(current, ".codex");
    const hasWorking = await exists(path.join(codexDir, "WORKING.md"));
    const hasMemory = await exists(path.join(codexDir, "MEMORY.md"));
    if (hasWorking || hasMemory) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readGuidanceFile(filePath: string, maxLines: number): Promise<{ lines: Array<{ line: number; text: string }>; warning?: string }> {
  try {
    const source = await fs.readFile(filePath, "utf8");
    return {
      lines: source
        .split(/\r?\n/u)
        .slice(0, maxLines)
        .map((text, index) => ({ line: index + 1, text: text.trim() }))
        .filter((entry) => entry.text.length > 0)
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { lines: [] };
    }
    return { lines: [], warning: error instanceof Error ? error.message : String(error) };
  }
}

function guidanceTerms(input: { repoRoot: string; task?: string; query?: string; files?: string[]; symbols?: string[] }): Set<string> {
  const repoName = path.basename(path.resolve(input.repoRoot));
  const terms = new Set<string>();
  addGuidanceTerms(terms, [repoName], false);
  addGuidanceTerms(terms, [input.task ?? "", input.query ?? ""], true);
  addGuidanceTerms(terms, [...(input.files ?? []), ...(input.symbols ?? [])], true);
  return terms;
}

function addGuidanceTerms(terms: Set<string>, values: string[], splitPathish: boolean): void {
  for (const value of values) {
    for (const rawTerm of value.toLowerCase().split(/[^a-z0-9_.\/-]+/u)) {
      const candidates = splitPathish ? pathishTerms(rawTerm) : [rawTerm.trim()];
      for (const candidate of candidates) {
        if (candidate.length >= 3 && !STOP_TERMS.has(candidate)) {
          terms.add(candidate);
        }
      }
    }
  }
}

function pathishTerms(term: string): string[] {
  const stripped = term.trim().replace(/^["'`]+|["'`]+$/gu, "");
  if (!stripped) {
    return [];
  }
  const parts = stripped.split(/[\/_.-]+/u).filter(Boolean);
  return uniqueSorted([stripped, ...parts]);
}

function scoreGuidanceLine(text: string, source: WorkspaceGuidanceSource, line: number, terms: Set<string>, files: string[], repoRoot: string): WorkspaceGuidanceLine | undefined {
  if (/^#\s*(working|memory)\b/iu.test(text)) {
    return undefined;
  }
  const lower = text.toLowerCase();
  if (source === "WORKING.md" && containsAbsolutePath(lower) && !lower.includes(path.resolve(repoRoot).toLowerCase())) {
    return undefined;
  }
  const reasons: string[] = [];
  let score = 0;

  for (const file of files) {
    const normalized = file.toLowerCase();
    const base = path.posix.basename(normalized);
    if (normalized && lower.includes(normalized)) {
      score += 8;
      reasons.push(`file ${file}`);
    } else if (base && lower.includes(base)) {
      score += 4;
      reasons.push(`file ${base}`);
    }
  }

  for (const term of terms) {
    if (lower.includes(term)) {
      score += term.length >= 8 ? 3 : 1;
      reasons.push(`term ${term}`);
    }
  }

  if (score <= 0) {
    return undefined;
  }
  if (source === "WORKING.md" && /\b(active|focus|next|repo|task|claim|blocker)\b/u.test(lower)) {
    score += 2;
    reasons.push("working-state");
  }
  if (source === "MEMORY.md" && /\b(preference|pattern|gotcha|workflow|memory|guidance)\b/u.test(lower)) {
    score += 2;
    reasons.push("durable-guidance");
  }

  return {
    source,
    line,
    text: limitText(text.replace(/\s+/gu, " "), 220),
    score,
    reasons: uniqueSorted(reasons).slice(0, 8)
  };
}

function dedupeGuidanceLines(lines: WorkspaceGuidanceLine[]): WorkspaceGuidanceLine[] {
  const seen = new Set<string>();
  const deduped: WorkspaceGuidanceLine[] = [];
  for (const line of lines) {
    const key = `${line.source}:${line.text.toLowerCase()}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(line);
  }
  return deduped;
}

function sourcePriority(source: WorkspaceGuidanceSource): number {
  return source === "WORKING.md" ? 0 : 1;
}

function containsAbsolutePath(value: string): boolean {
  return /(?:^|[\s|`"'(])(?:\/[a-z0-9_.-]+){2,}/u.test(value);
}

const STOP_TERMS = new Set([
  "active",
  "and",
  "are",
  "but",
  "can",
  "current",
  "default",
  "diff",
  "does",
  "for",
  "from",
  "how",
  "into",
  "need",
  "other",
  "repo",
  "session",
  "safe",
  "selected",
  "task",
  "test",
  "tests",
  "the",
  "this",
  "what",
  "when",
  "with"
]);
