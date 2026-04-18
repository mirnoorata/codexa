import { runCommand } from "../command.js";
import { uniqueSorted } from "../util.js";

export interface RawSearchHit {
  path: string;
  line: number;
  text: string;
  pattern?: string;
}

export interface RawSearchResult {
  hits: RawSearchHit[];
  files: string[];
  sufficient: boolean;
  command: string;
  patterns: string[];
}

const RG_TIMEOUT_MS = 2_500;
const RG_MAX_BUFFER_BYTES = 512 * 1024;
export const RAW_SEARCH_PATTERN_LIMIT = 8;
export const RAW_SEARCH_EXPLICIT_PATTERN_LIMIT = RAW_SEARCH_PATTERN_LIMIT - 1;

export async function rawSearch(repoRoot: string, query: string | string[], limit: number): Promise<RawSearchResult> {
  const patterns = normalizeRawSearchPatterns(query);
  assertRawSearchPatternLimit(patterns);
  if (patterns.length === 0) {
    return { hits: [], files: [], sufficient: false, command: "rg -n --fixed-strings .", patterns: [] };
  }
  const command = rawSearchCommand(patterns);
  const rgResult = await runCommand("rg", rawSearchArgs(patterns), {
    cwd: repoRoot,
    okExitCodes: [0, 1],
    timeoutMs: RG_TIMEOUT_MS,
    maxBufferBytes: RG_MAX_BUFFER_BYTES
  });
  const result = isMissingCommand(rgResult) ? await gitGrep(repoRoot, patterns) : rgResult;
  const hits = parseRgHits(result.stdout, limit, patterns);
  const files = uniqueSorted(hits.map((hit) => hit.path));
  return {
    hits,
    files,
    sufficient: result.ok && exactish(patterns, hits) && files.length <= 3 && hits.length <= 20,
    command: result === rgResult ? command : `${gitGrepCommand(patterns)} (fallback; rg unavailable)`,
    patterns
  };
}

export function assertRawSearchPatternLimit(patterns: string[]): void {
  if (patterns.length > RAW_SEARCH_PATTERN_LIMIT) {
    throw new Error(`Raw search supports at most ${RAW_SEARCH_PATTERN_LIMIT} literal patterns; received ${patterns.length}.`);
  }
}

export async function baselineSearchSummary(repoRoot: string, queryText: string): Promise<{ command: string; lines: number } | undefined> {
  const terms = rawSearchTermsFromText(queryText, 6);
  if (terms.length === 0) {
    return undefined;
  }
  const args = ["-n", "--fixed-strings", "--max-count", "25", "--glob", "!.codex/**", ...terms.flatMap((term) => ["-e", term]), "."];
  const command = `rg -n --fixed-strings ${terms.map((term) => `-e ${JSON.stringify(term)}`).join(" ")} .`;
  const rgResult = await runCommand("rg", args, {
    cwd: repoRoot,
    okExitCodes: [0, 1],
    timeoutMs: RG_TIMEOUT_MS,
    maxBufferBytes: RG_MAX_BUFFER_BYTES
  });
  const result = isMissingCommand(rgResult) ? await gitGrep(repoRoot, terms) : rgResult;
  return {
    command: result === rgResult ? command : `${gitGrepCommand(terms)} (fallback; rg unavailable)`,
    lines: uniqueSorted(result.stdout.split(/\r?\n/).filter(Boolean)).length
  };
}

export function rawSearchTermsFromText(queryText: string, maxTerms = 6): string[] {
  return uniqueSorted(
    queryText
      .split(/[^A-Za-z0-9_.@/-]+/)
      .map((term) => term.trim())
      .filter((term) => term.length >= 3)
      .sort((a, b) => b.length - a.length || a.localeCompare(b))
      .slice(0, maxTerms)
  );
}

export function normalizeRawSearchPatterns(query: string | string[]): string[] {
  const values = Array.isArray(query) ? query : [query];
  const seen = new Set<string>();
  const patterns: string[] = [];
  for (const value of values) {
    const pattern = value.trim();
    if (!pattern || seen.has(pattern)) {
      continue;
    }
    seen.add(pattern);
    patterns.push(pattern);
  }
  return patterns;
}

function rawSearchArgs(patterns: string[]): string[] {
  const base = ["-n", "--fixed-strings", "--max-count", "25", "--glob", "!.codex/**"];
  if (patterns.length === 1) {
    return [...base, "--", patterns[0], "."];
  }
  return [...base, ...patterns.flatMap((pattern) => ["-e", pattern]), "--", "."];
}

function rawSearchCommand(patterns: string[]): string {
  if (patterns.length === 1) {
    return `rg -n --fixed-strings -- ${JSON.stringify(patterns[0])} .`;
  }
  return `rg -n --fixed-strings ${patterns.map((pattern) => `-e ${JSON.stringify(pattern)}`).join(" ")} .`;
}

async function gitGrep(repoRoot: string, terms: string[]) {
  return await runCommand("git", ["grep", "-n", "-F", "--max-count", "25", ...terms.flatMap((term) => ["-e", term]), "--", ".", ":(exclude).codex/**"], {
    cwd: repoRoot,
    okExitCodes: [0, 1],
    timeoutMs: RG_TIMEOUT_MS,
    maxBufferBytes: RG_MAX_BUFFER_BYTES
  });
}

function gitGrepCommand(terms: string[]): string {
  return `git grep -n -F ${terms.map((term) => `-e ${JSON.stringify(term)}`).join(" ")} -- .`;
}

function isMissingCommand(result: { exitCode: number | null; error?: Error }): boolean {
  return result.exitCode === null && (result.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

function parseRgHits(output: string, limit: number, patterns: string[]): RawSearchHit[] {
  const hits: RawSearchHit[] = [];
  for (const line of output.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    const first = line.indexOf(":");
    const second = first >= 0 ? line.indexOf(":", first + 1) : -1;
    if (first <= 0 || second <= first) {
      continue;
    }
    const pathValue = line.slice(0, first);
    const lineNumber = Number.parseInt(line.slice(first + 1, second), 10);
    if (!Number.isFinite(lineNumber)) {
      continue;
    }
    const pathText = pathValue.replace(/^\.\//, "");
    const text = line.slice(second + 1).trim().slice(0, 220);
    hits.push({ path: pathText, line: lineNumber, text, pattern: matchingPattern(pathText, text, patterns) });
    if (hits.length >= limit) {
      break;
    }
  }
  return hits;
}

function exactish(patterns: string[], hits: RawSearchHit[]): boolean {
  return patterns.some((pattern) => {
    const normalizedPattern = pattern.trim().toLowerCase();
    return (
      normalizedPattern.length >= 3 &&
      hits.some((hit) => {
        const line = hit.text.toLowerCase();
        const filePath = hit.path.toLowerCase();
        return line.includes(normalizedPattern) || filePath.includes(normalizedPattern);
      })
    );
  });
}

function matchingPattern(filePath: string, text: string, patterns: string[]): string | undefined {
  const haystacks = [filePath.toLowerCase(), text.toLowerCase()];
  return patterns.find((pattern) => {
    const normalizedPattern = pattern.toLowerCase();
    return normalizedPattern.length >= 3 && haystacks.some((haystack) => haystack.includes(normalizedPattern));
  });
}
