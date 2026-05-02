import { isGeneratedPath, isTestPath } from "../language.js";
import { isPlaceholderRisk, placeholderCategory } from "../placeholder-signals.js";
import type { CodexaIndex, FileFact, QueryOptions, QueryResult, RiskSignalFact } from "../types.js";
import { limitText, uniqueSorted } from "../util.js";
import { clampInt } from "./formatting.js";
import { freshnessBanner } from "./runtime.js";
import { ensureQuerySession, type QuerySessionInput } from "./session.js";

export interface PlaceholderReportInput {
  includeTests?: boolean;
  includeDocs?: boolean;
  includeGenerated?: boolean;
  limit?: number;
  tokenBudget?: number;
}

interface PlaceholderFinding {
  path: string;
  line: number;
  signal: string;
  category: string;
  score: number;
  confidence: RiskSignalFact["confidence"];
  source: RiskSignalFact["source"];
  reason: string;
  context: PlaceholderContext;
}

type PlaceholderContext = "production" | "test" | "docs" | "generated";

export async function placeholderReportQuery(input: QuerySessionInput, reportInput: PlaceholderReportInput = {}, options: QueryOptions = {}): Promise<QueryResult> {
  const session = await ensureQuerySession(input, options);
  const { index, freshness, refresh } = session;
  const limit = clampInt(reportInput.limit ?? 40, 1, session.maxResults);
  const tokenBudget = clampInt(reportInput.tokenBudget ?? 2400, 500, 8000);
  const allFindings = placeholderFindings(index);
  const filteredFindings = allFindings
    .filter((finding) => reportInput.includeTests || finding.context !== "test")
    .filter((finding) => reportInput.includeDocs || finding.context !== "docs")
    .filter((finding) => reportInput.includeGenerated || finding.context !== "generated");
  const findings = filteredFindings.slice(0, limit);
  const excludedByFilter = allFindings.length - filteredFindings.length;
  const hiddenByLimit = Math.max(0, filteredFindings.length - findings.length);
  const grouped = groupBy(filteredFindings, (finding) => finding.category);
  const categoryLines = Object.entries(grouped).map(([category, values]) => `- ${category}: ${values.length}`);
  const topFiles = placeholderFileSummary(filteredFindings).slice(0, Math.min(12, limit));
  const lines = [
    freshnessBanner(freshness, refresh),
    "Codexa placeholder report",
    `Findings: ${findings.length}${hiddenByLimit > 0 ? ` shown, ${hiddenByLimit} hidden by limit` : ""}${excludedByFilter > 0 ? `, ${excludedByFilter} excluded by context filters` : ""}`,
    `Filters: tests ${reportInput.includeTests ? "included" : "excluded"}, docs ${reportInput.includeDocs ? "included" : "excluded"}, generated ${reportInput.includeGenerated ? "included" : "excluded"}`,
    "",
    "Categories:",
    ...(categoryLines.length > 0 ? categoryLines : ["- none"]),
    "",
    "Top files:",
    ...(topFiles.length > 0 ? topFiles.map((entry) => `- ${entry.path}: ${entry.count} finding(s), score ${entry.score.toFixed(2)}`) : ["- none"]),
    "",
    "Findings:",
    ...(findings.length > 0
      ? findings.map((finding) => `- ${finding.path}:${finding.line} ${finding.signal} score ${finding.score.toFixed(2)} ${finding.confidence}; ${finding.reason}`)
      : ["- none"]),
    "",
    "Tracking:",
    "- Placeholder findings are indexed as risk signals.",
    "- change_plan snapshots store the current placeholder/risk baseline.",
    "- post_edit_review reports newly introduced placeholder signals and removed signals within the saved baseline scope as risk deltas."
  ];
  return {
    freshness,
    refresh,
    text: limitText(lines.join("\n"), tokenBudget * 4),
    data: {
      findings,
      totalFindings: allFindings.length,
      excludedByFilter,
      hiddenByLimit,
      categories: Object.fromEntries(Object.entries(grouped).map(([category, values]) => [category, values.length])),
      topFiles,
      filters: {
        includeTests: Boolean(reportInput.includeTests),
        includeDocs: Boolean(reportInput.includeDocs),
        includeGenerated: Boolean(reportInput.includeGenerated)
      }
    }
  };
}

export function placeholderFindings(index: CodexaIndex): PlaceholderFinding[] {
  const filesByPath = new Map(index.files.map((file) => [file.path, file]));
  return index.risks
    .filter(isPlaceholderRisk)
    .map((risk) => {
      const file = filesByPath.get(risk.path);
      return {
        path: risk.path,
        line: risk.range?.startLine ?? 1,
        signal: risk.signal,
        category: placeholderCategory(risk.signal),
        score: risk.score,
        confidence: risk.confidence,
        source: risk.source,
        reason: risk.reason,
        context: placeholderContext(risk.path, file)
      };
    })
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path) || a.line - b.line || a.signal.localeCompare(b.signal));
}

function placeholderFileSummary(findings: PlaceholderFinding[]): Array<{ path: string; count: number; score: number; categories: string[] }> {
  const byPath = new Map<string, PlaceholderFinding[]>();
  for (const finding of findings) {
    const values = byPath.get(finding.path) ?? [];
    values.push(finding);
    byPath.set(finding.path, values);
  }
  return [...byPath.entries()]
    .map(([path, values]) => ({
      path,
      count: values.length,
      score: values.reduce((sum, finding) => sum + finding.score, 0),
      categories: uniqueSorted(values.map((finding) => finding.category))
    }))
    .sort((a, b) => b.score - a.score || b.count - a.count || a.path.localeCompare(b.path));
}

function groupBy<T>(values: T[], keyFor: (value: T) => string): Record<string, T[]> {
  const groups: Record<string, T[]> = {};
  for (const value of values) {
    const key = keyFor(value);
    groups[key] ??= [];
    groups[key].push(value);
  }
  return Object.fromEntries(Object.entries(groups).sort(([a], [b]) => a.localeCompare(b)));
}

function placeholderContext(filePath: string, file?: FileFact): PlaceholderContext {
  if (file?.generated || isGeneratedPath(filePath)) {
    return "generated";
  }
  if (file?.test || isTestPath(filePath)) {
    return "test";
  }
  if (file?.language === "markdown" || /(^|\/)docs?\//u.test(filePath)) {
    return "docs";
  }
  return "production";
}
