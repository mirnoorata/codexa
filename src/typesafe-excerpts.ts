import type { SymbolFact } from "./types.js";
import { tokenizeRetrievalText } from "./retrieval/helpers.js";

export interface SourceWindow {
  startLine: number;
  endLine: number;
  text: string;
  truncated: boolean;
}

/** Bounded context selection, not semantic evidence or an absence proof. */
export function typeSafeSourceExcerpt(source: string, query: string, symbols: SymbolFact[]) {
  const lines = source.split("\n");
  const budget = 3000;
  if (source.length <= budget) return {
    totalLines: lines.length, truncated: false,
    windows: [{ startLine: 1, endLine: lines.length, text: source, truncated: false }]
  };
  const terms = new Set(tokenizeRetrievalText(query));
  const overlap = (value: string) => tokenizeRetrievalText(value).filter(term => terms.has(term)).length;
  const ranked = lines.map((line, position) => ({
    line: position + 1,
    // A comment can locate useful context, but repeated vocabulary must not
    // crowd out implementation. This is a heuristic, not language parsing.
    score: overlap(line) * (/^\s*(?:\/\/|\/\*|\*|#)/u.test(line) ? .25 : 1)
  }));
  for (const symbol of symbols) {
    const line = symbol.range?.startLine;
    if (line && ranked[line - 1]) ranked[line - 1].score += overlap(symbol.qualifiedName) * 2;
  }
  ranked.sort((a, b) => b.score - a.score || a.line - b.line);
  const windows: SourceWindow[] = [];
  let remaining = budget;
  for (const candidate of ranked) {
    if (windows.length === 3 || remaining <= 0) break;
    const start = Math.max(1, candidate.line - 3);
    const end = Math.min(lines.length, candidate.line + 12);
    if (windows.some(window => start <= window.endLine && end >= window.startLine)) continue;
    const raw = lines.slice(start - 1, end).join("\n");
    let text = raw.slice(0, Math.min(1000, remaining));
    // Do not split a UTF-16 surrogate pair at the request boundary.
    if (/[\uD800-\uDBFF]$/u.test(text)) text = text.slice(0, -1);
    windows.push({ startLine: start, endLine: start + text.split("\n").length - 1, text, truncated: text.length < raw.length });
    remaining -= text.length;
  }
  return { totalLines: lines.length, truncated: true, windows: windows.sort((a, b) => a.startLine - b.startLine) };
}
