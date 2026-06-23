import path from "node:path";
import type { RepoFreshnessFiles } from "../repo-files.js";
import type { ExternalRiskReportDiagnostic } from "../risk-ingest.js";
import type { ExternalSymbolReportDiagnostic } from "../symbol-report-ingest.js";
import type { FreshnessInfo } from "../types.js";

export interface RiskReportFreshnessSnapshot {
  reportHashes: Record<string, string>;
  diagnostics: ExternalRiskReportDiagnostic[];
}

export interface SymbolReportFreshnessSnapshot {
  reportHashes: Record<string, string>;
  diagnostics: ExternalSymbolReportDiagnostic[];
}

export function freshnessFromStored(repo: string, current: RepoFreshnessFiles, riskReports: RiskReportFreshnessSnapshot, symbolReports: SymbolReportFreshnessSnapshot, loaded: FreshnessInfo | null): FreshnessInfo {
  if (!loaded) {
    return {
      schemaVersion: 1,
      snapshotId: "missing",
      repoRoot: repo,
      gitRoot: current.git.gitRoot,
      headCommit: current.git.headCommit,
      indexedAt: "",
      dirtyFiles: current.git.dirtyFiles,
      indexedDirtyFiles: [],
      dirtyFileHashes: current.dirtyFileHashes,
      indexedDirtyFileHashes: {},
      externalRiskReportHashes: riskReports.reportHashes,
      indexedExternalRiskReportHashes: {},
      externalRiskReportDiagnostics: riskReports.diagnostics,
      externalSymbolReportHashes: symbolReports.reportHashes,
      indexedExternalSymbolReportHashes: {},
      externalSymbolReportDiagnostics: symbolReports.diagnostics,
      missing: true,
      stale: true,
      reason: "missing-index",
      parserErrorCount: 0
    };
  }

  const dirtyChanged =
    current.git.dirtyFiles.join("\n") !== loaded.indexedDirtyFiles.join("\n") ||
    stableJson(current.dirtyFileHashes) !== stableJson(loaded.indexedDirtyFileHashes ?? {});
  const indexedExternalRiskReportHashes = loaded.indexedExternalRiskReportHashes ?? loaded.externalRiskReportHashes ?? {};
  const externalRiskReportsChanged = stableJson(riskReports.reportHashes) !== stableJson(indexedExternalRiskReportHashes);
  const indexedExternalSymbolReportHashes = loaded.indexedExternalSymbolReportHashes ?? loaded.externalSymbolReportHashes ?? {};
  const externalSymbolReportsChanged = stableJson(symbolReports.reportHashes) !== stableJson(indexedExternalSymbolReportHashes);
  const commitChanged = current.git.headCommit !== loaded.headCommit;
  const repoRootChanged = path.resolve(loaded.repoRoot) !== repo || loaded.gitRoot !== current.git.gitRoot;
  const stale = dirtyChanged || externalRiskReportsChanged || externalSymbolReportsChanged || commitChanged || repoRootChanged;
  return {
    ...loaded,
    repoRoot: repo,
    gitRoot: current.git.gitRoot,
    dirtyFiles: current.git.dirtyFiles,
    dirtyFileHashes: current.dirtyFileHashes,
    externalRiskReportHashes: riskReports.reportHashes,
    indexedExternalRiskReportHashes,
    externalRiskReportDiagnostics: riskReports.diagnostics,
    externalSymbolReportHashes: symbolReports.reportHashes,
    indexedExternalSymbolReportHashes,
    externalSymbolReportDiagnostics: symbolReports.diagnostics,
    missing: false,
    stale,
    reason: stale
      ? commitChanged
        ? "head-commit-changed"
        : repoRootChanged
          ? "repo-root-changed"
          : externalRiskReportsChanged
            ? "external-risk-reports-changed"
            : externalSymbolReportsChanged
              ? "external-symbol-reports-changed"
              : "dirty-files-changed"
      : loaded.reason
  };
}

function stableJson(value: Record<string, string>): string {
  return JSON.stringify(Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))));
}
