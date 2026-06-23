import { formatBytes } from "./parsing.js";
import type { CodexaIndex, ParserErrorFact, RiskSignalFact } from "../types.js";
import type { ExternalRiskReportDiagnostic } from "../risk-ingest.js";
import type { ExternalSymbolReportDiagnostic, loadExternalSymbolReportFacts } from "../symbol-report-ingest.js";
import { stableId } from "../util.js";

export function applyExternalSymbolFacts(index: CodexaIndex, external: Awaited<ReturnType<typeof loadExternalSymbolReportFacts>>): CodexaIndex {
  const existingFiles = new Set(index.files.map((file) => file.path));
  const existingSymbols = new Set(index.symbols.map((symbol) => `${symbol.path}\0${symbol.qualifiedName}\0${symbol.kind}\0${symbol.range?.startLine ?? 0}`));
  return {
    ...index,
    files: [
      ...index.files,
      ...external.files.filter((file) => !existingFiles.has(file.path))
    ],
    symbols: [
      ...index.symbols,
      ...external.symbols.filter((symbol) => !existingSymbols.has(`${symbol.path}\0${symbol.qualifiedName}\0${symbol.kind}\0${symbol.range?.startLine ?? 0}`))
    ]
  };
}

export function dedupeRiskSignals(risks: RiskSignalFact[]): RiskSignalFact[] {
  const seen = new Set<string>();
  const result: RiskSignalFact[] = [];
  for (const risk of risks) {
    const key = `${risk.path}\0${risk.signal}\0${risk.range?.startLine ?? 0}\0${risk.reason}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(risk);
  }
  return result.sort((a, b) => a.path.localeCompare(b.path) || b.score - a.score || a.signal.localeCompare(b.signal));
}

export function riskReportParserError(diagnostic: ExternalRiskReportDiagnostic, snapshotId: string, indexedAt: string): ParserErrorFact {
  return {
    id: stableId("external-risk-report-diagnostic", diagnostic.path, diagnostic.reason, diagnostic.sizeBytes ?? 0, diagnostic.limitBytes ?? 0),
    type: "ParserError",
    path: diagnostic.path,
    source: "static-analysis",
    confidence: "heuristic",
    snapshotId,
    indexedAt,
    message:
      diagnostic.reason === "report-too-large"
        ? `Skipped external risk report ${diagnostic.path}: ${formatBytes(diagnostic.sizeBytes ?? 0)} exceeds Codexa's ${formatBytes(diagnostic.limitBytes ?? 0)} report cap`
        : `Skipped external risk report ${diagnostic.path}: invalid JSON`
  };
}

export function symbolReportParserError(diagnostic: ExternalSymbolReportDiagnostic, snapshotId: string, indexedAt: string): ParserErrorFact {
  return {
    id: stableId("external-symbol-report-diagnostic", diagnostic.path, diagnostic.reason, diagnostic.sizeBytes ?? 0, diagnostic.limitBytes ?? 0),
    type: "ParserError",
    path: diagnostic.path,
    source: "static-analysis",
    confidence: "heuristic",
    snapshotId,
    indexedAt,
    message:
      diagnostic.reason === "report-too-large"
        ? `Skipped external symbol report ${diagnostic.path}: ${formatBytes(diagnostic.sizeBytes ?? 0)} exceeds Codexa's ${formatBytes(diagnostic.limitBytes ?? 0)} report cap`
        : diagnostic.reason === "invalid-symbol-report"
          ? `Skipped external symbol report ${diagnostic.path}: valid JSON did not match CodexaSymbolReportV1 or referenced files outside the repository`
        : `Skipped external symbol report ${diagnostic.path}: invalid JSON`
  };
}
