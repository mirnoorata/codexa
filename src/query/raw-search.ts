import { runCommand } from "../command.js";
import { uniqueSorted } from "../util.js";

export interface RawSearchHit {
  path: string;
  line: number;
  text: string;
}

export interface RawSearchResult {
  hits: RawSearchHit[];
  files: string[];
  sufficient: boolean;
  command: string;
}

const RG_TIMEOUT_MS = 2_500;
const RG_MAX_BUFFER_BYTES = 512 * 1024;

export async function rawSearch(repoRoot: string, query: string, limit: number): Promise<RawSearchResult> {
  const command = `rg -n --fixed-strings -- ${JSON.stringify(query)} .`;
  const result = await runCommand("rg", ["-n", "--fixed-strings", "--max-count", "25", "--glob", "!.codex/**", "--", query, "."], {
    cwd: repoRoot,
    okExitCodes: [0, 1],
    timeoutMs: RG_TIMEOUT_MS,
    maxBufferBytes: RG_MAX_BUFFER_BYTES
  });
  const hits = parseRgHits(result.stdout, limit);
  return {
    hits,
    files: uniqueSorted(hits.map((hit) => hit.path)),
    sufficient: result.ok && exactish(query, hits) && uniqueSorted(hits.map((hit) => hit.path)).length <= 3 && hits.length <= 20,
    command
  };
}

export async function baselineSearchSummary(repoRoot: string, queryText: string): Promise<{ command: string; lines: number } | undefined> {
  const terms = uniqueSorted(
    queryText
      .split(/[^A-Za-z0-9_.@/-]+/)
      .map((term) => term.trim())
      .filter((term) => term.length >= 3)
      .sort((a, b) => b.length - a.length || a.localeCompare(b))
      .slice(0, 6)
  );
  if (terms.length === 0) {
    return undefined;
  }
  const args = ["-n", "--fixed-strings", "--max-count", "25", "--glob", "!.codex/**", ...terms.flatMap((term) => ["-e", term]), "."];
  const command = `rg -n --fixed-strings ${terms.map((term) => `-e ${JSON.stringify(term)}`).join(" ")} .`;
  const result = await runCommand("rg", args, {
    cwd: repoRoot,
    okExitCodes: [0, 1],
    timeoutMs: RG_TIMEOUT_MS,
    maxBufferBytes: RG_MAX_BUFFER_BYTES
  });
  return { command, lines: uniqueSorted(result.stdout.split(/\r?\n/).filter(Boolean)).length };
}

function parseRgHits(output: string, limit: number): RawSearchHit[] {
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
    hits.push({ path: pathValue.replace(/^\.\//, ""), line: lineNumber, text: line.slice(second + 1).trim().slice(0, 220) });
    if (hits.length >= limit) {
      break;
    }
  }
  return hits;
}

function exactish(query: string, hits: RawSearchHit[]): boolean {
  const normalizedQuery = query.trim().toLowerCase();
  return (
    normalizedQuery.length >= 3 &&
    hits.some((hit) => {
      const line = hit.text.toLowerCase();
      const filePath = hit.path.toLowerCase();
      return line.includes(normalizedQuery) || filePath.includes(normalizedQuery);
    })
  );
}
