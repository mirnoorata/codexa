import { promises as fs } from "node:fs";
import path from "node:path";
import type { Confidence, RiskSignalFact } from "./types.js";
import { normalizePath, stableId } from "./util.js";

const RISK_REPORT_PATHS = [
  ".codex/static-analysis/risks.json",
  ".codex/static-analysis/semgrep.json",
  ".codex/static-analysis/codeql.sarif",
  ".codex/static-analysis/codeql-results.sarif",
  "reports/static-analysis/risks.json",
  "reports/static-analysis/codeql.sarif",
  "reports/semgrep.json",
  "reports/codeql.sarif",
  "reports/codeql-results.sarif",
  "codeql.sarif",
  "semgrep.json"
];

const RISK_REPORT_DIRS = [".codex/static-analysis", "reports/static-analysis"];

export async function loadExternalRiskSignals(repoRoot: string, snapshotId: string, indexedAt: string): Promise<RiskSignalFact[]> {
  const risks: RiskSignalFact[] = [];
  for (const relativePath of await candidateRiskReports(repoRoot)) {
    const absolutePath = path.join(repoRoot, relativePath);
    let parsed: unknown;
    try {
      parsed = JSON.parse(await fs.readFile(absolutePath, "utf8"));
    } catch {
      continue;
    }
    risks.push(...risksFromReport(parsed, relativePath, repoRoot, snapshotId, indexedAt));
  }
  return dedupeRisks(risks);
}

async function candidateRiskReports(repoRoot: string): Promise<string[]> {
  const candidates = new Set(RISK_REPORT_PATHS);
  for (const relativeDir of RISK_REPORT_DIRS) {
    const absoluteDir = path.join(repoRoot, relativeDir);
    for (const report of await walkReportDir(absoluteDir, relativeDir, 0)) {
      candidates.add(report);
      if (candidates.size >= 250) {
        break;
      }
    }
  }
  return [...candidates].sort((a, b) => a.localeCompare(b));
}

async function walkReportDir(absoluteDir: string, relativeDir: string, depth: number): Promise<string[]> {
  if (depth > 2) {
    return [];
  }
  let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
  try {
    entries = (await fs.readdir(absoluteDir, { withFileTypes: true })).map((entry) => ({
      name: entry.name.toString(),
      isDirectory: () => entry.isDirectory(),
      isFile: () => entry.isFile()
    }));
  } catch {
    return [];
  }
  const reports: string[] = [];
  for (const entry of entries) {
    const relativePath = normalizePath(path.posix.join(relativeDir, entry.name));
    const absolutePath = path.join(absoluteDir, entry.name);
    if (entry.isDirectory()) {
      reports.push(...(await walkReportDir(absolutePath, relativePath, depth + 1)));
      continue;
    }
    if (entry.isFile() && /\.(json|sarif)$/i.test(entry.name)) {
      reports.push(relativePath);
    }
  }
  return reports.sort((a, b) => a.localeCompare(b));
}

function risksFromReport(value: unknown, reportPath: string, repoRoot: string, snapshotId: string, indexedAt: string): RiskSignalFact[] {
  if (!value || typeof value !== "object") {
    return [];
  }
  const record = value as Record<string, unknown>;
  if (Array.isArray(record.runs)) {
    return record.runs.flatMap((run) => risksFromSarifRun(run, reportPath, repoRoot, snapshotId, indexedAt));
  }
  if (Array.isArray(record.results)) {
    return record.results.flatMap((entry) => riskFromSemgrepResult(entry, reportPath, repoRoot, snapshotId, indexedAt));
  }
  if (Array.isArray(record.risks)) {
    return record.risks.flatMap((entry) => riskFromGenericEntry(entry, reportPath, repoRoot, snapshotId, indexedAt));
  }
  if (Array.isArray(record.findings)) {
    return record.findings.flatMap((entry) => riskFromGenericEntry(entry, reportPath, repoRoot, snapshotId, indexedAt));
  }
  return [];
}

function risksFromSarifRun(value: unknown, reportPath: string, repoRoot: string, snapshotId: string, indexedAt: string): RiskSignalFact[] {
  if (!value || typeof value !== "object") {
    return [];
  }
  const run = value as Record<string, unknown>;
  const ruleInfoById = sarifRuleInfoById(run);
  const tool = sarifToolName(run);
  const results = Array.isArray(run.results) ? run.results : [];
  return results.flatMap((result) => {
    if (!result || typeof result !== "object") {
      return [];
    }
    const record = result as Record<string, unknown>;
    const signal = stringValue(record.ruleId) ?? "sarif-finding";
    const ruleInfo = ruleInfoById.get(signal);
    const reason = sarifMessageText(record.message) ?? ruleInfo?.message ?? signal;
    const locations = Array.isArray(record.locations) ? record.locations : [];
    if (locations.length === 0) {
      return [];
    }
    return locations.flatMap((location) => {
      if (!location || typeof location !== "object") {
        return [];
      }
      const physical = (location as Record<string, unknown>).physicalLocation as Record<string, unknown> | undefined;
      const artifact = physical?.artifactLocation as Record<string, unknown> | undefined;
      const region = physical?.region as Record<string, unknown> | undefined;
      const filePath = stringValue(artifact?.uri);
      if (!filePath) {
        return [];
      }
      const line = numberValue(region?.startLine);
      const normalizedPath = normalizeReportPath(filePath, repoRoot);
      if (!normalizedPath) {
        return [];
      }
      const tags = ruleInfo?.tags.length ? `; tags ${ruleInfo.tags.slice(0, 4).join(",")}` : "";
      return [
        {
          id: stableId("external-risk", reportPath, filePath, signal, line ?? 0, reason),
          type: "RiskSignal" as const,
          path: normalizedPath,
          range: line ? { startLine: line, endLine: line, startByte: 0, endByte: 0 } : undefined,
          source: "static-analysis" as const,
          confidence: sarifConfidence(record, ruleInfo),
          snapshotId,
          indexedAt,
          signal,
          score: sarifScore(record, ruleInfo),
          reason: `${reportPath}${tool ? ` ${tool}` : ""}: ${reason}${tags}`.slice(0, 240)
        }
      ];
    });
  });
}

function riskFromSemgrepResult(value: unknown, reportPath: string, repoRoot: string, snapshotId: string, indexedAt: string): RiskSignalFact[] {
  if (!value || typeof value !== "object") {
    return [];
  }
  const record = value as Record<string, unknown>;
  const filePath = stringValue(record.path);
  if (!filePath) {
    return [];
  }
  const extra = record.extra && typeof record.extra === "object" ? (record.extra as Record<string, unknown>) : {};
  const signal = stringValue(record.check_id) ?? "semgrep-finding";
  const severity = stringValue(extra.severity) ?? "INFO";
  const reason = stringValue(extra.message) ?? signal;
  const line = numberValue((record.start as Record<string, unknown> | undefined)?.line);
  const normalizedPath = normalizeReportPath(filePath, repoRoot);
  if (!normalizedPath) {
    return [];
  }
  return [
    {
      id: stableId("external-risk", reportPath, filePath, signal, line ?? 0, reason),
      type: "RiskSignal",
      path: normalizedPath,
      range: line ? { startLine: line, endLine: line, startByte: 0, endByte: 0 } : undefined,
      source: "static-analysis",
      confidence: confidenceFromSeverity(severity),
      snapshotId,
      indexedAt,
      signal,
      score: scoreFromSeverity(severity),
      reason: `${reportPath}: ${reason}`.slice(0, 240)
    }
  ];
}

function riskFromGenericEntry(value: unknown, reportPath: string, repoRoot: string, snapshotId: string, indexedAt: string): RiskSignalFact[] {
  if (!value || typeof value !== "object") {
    return [];
  }
  const record = value as Record<string, unknown>;
  const filePath = stringValue(record.path) ?? stringValue(record.file);
  if (!filePath) {
    return [];
  }
  const signal = stringValue(record.signal) ?? stringValue(record.rule) ?? stringValue(record.id) ?? "static-analysis-risk";
  const reason = stringValue(record.reason) ?? stringValue(record.message) ?? signal;
  const score = numberValue(record.score) ?? scoreFromSeverity(stringValue(record.severity) ?? "");
  const line = numberValue(record.line) ?? numberValue(record.startLine);
  const confidence = confidenceValue(record.confidence) ?? confidenceFromSeverity(stringValue(record.severity) ?? "");
  const normalizedPath = normalizeReportPath(filePath, repoRoot);
  if (!normalizedPath) {
    return [];
  }
  return [
    {
      id: stableId("external-risk", reportPath, filePath, signal, line ?? 0, reason),
      type: "RiskSignal",
      path: normalizedPath,
      range: line ? { startLine: line, endLine: line, startByte: 0, endByte: 0 } : undefined,
      source: "static-analysis",
      confidence,
      snapshotId,
      indexedAt,
      signal,
      score,
      reason: `${reportPath}: ${reason}`.slice(0, 240)
    }
  ];
}

function dedupeRisks(risks: RiskSignalFact[]): RiskSignalFact[] {
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

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function confidenceValue(value: unknown): Confidence | undefined {
  return value === "authoritative" || value === "derived" || value === "heuristic" ? value : undefined;
}

function scoreFromSeverity(value: string): number {
  const normalized = value.toUpperCase();
  if (/(ERROR|CRITICAL|HIGH)/.test(normalized)) {
    return 3;
  }
  if (/(WARNING|MEDIUM)/.test(normalized)) {
    return 2;
  }
  if (/(LOW|INFO)/.test(normalized)) {
    return 1;
  }
  return 1.5;
}

function confidenceFromSeverity(value: string): Confidence {
  const normalized = value.toUpperCase();
  if (/(ERROR|CRITICAL|HIGH|WARNING|MEDIUM)/.test(normalized)) {
    return "derived";
  }
  return "heuristic";
}

interface SarifRuleInfo {
  message?: string;
  precision?: string;
  severity?: string;
  securitySeverity?: number;
  tags: string[];
}

function sarifToolName(run: Record<string, unknown>): string | undefined {
  const tool = run.tool as Record<string, unknown> | undefined;
  const driver = tool?.driver as Record<string, unknown> | undefined;
  return stringValue(driver?.name);
}

function sarifRuleInfoById(run: Record<string, unknown>): Map<string, SarifRuleInfo> {
  const tool = run.tool as Record<string, unknown> | undefined;
  const driver = tool?.driver as Record<string, unknown> | undefined;
  const rules = Array.isArray(driver?.rules) ? driver.rules : [];
  const result = new Map<string, SarifRuleInfo>();
  for (const rule of rules) {
    if (!rule || typeof rule !== "object") {
      continue;
    }
    const record = rule as Record<string, unknown>;
    const id = stringValue(record.id);
    if (!id) {
      continue;
    }
    const properties = record.properties as Record<string, unknown> | undefined;
    const tags = Array.isArray(properties?.tags) ? properties.tags.filter((tag): tag is string => typeof tag === "string") : [];
    result.set(id, {
      message: sarifMessageText(record.shortDescription) ?? sarifMessageText(record.fullDescription) ?? stringValue(record.name),
      precision: stringValue(properties?.precision),
      severity: stringValue(properties?.["problem.severity"]) ?? stringValue(properties?.severity),
      securitySeverity: numericString(properties?.["security-severity"]),
      tags
    });
  }
  return result;
}

function sarifMessageText(value: unknown): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  return stringValue(record.text) ?? stringValue(record.markdown);
}

function sarifConfidence(record: Record<string, unknown>, ruleInfo: SarifRuleInfo | undefined): Confidence {
  const precision = (ruleInfo?.precision ?? "").toLowerCase();
  const severity = stringValue(record.level) ?? ruleInfo?.severity ?? "";
  if (precision === "high" || precision === "very-high" || /(error|warning|high|critical)/i.test(severity)) {
    return "derived";
  }
  return "heuristic";
}

function sarifScore(record: Record<string, unknown>, ruleInfo: SarifRuleInfo | undefined): number {
  const securitySeverity = ruleInfo?.securitySeverity;
  if (securitySeverity !== undefined) {
    if (securitySeverity >= 7) {
      return 3;
    }
    if (securitySeverity >= 4) {
      return 2;
    }
    return 1.5;
  }
  return scoreFromSeverity(stringValue(record.level) ?? ruleInfo?.severity ?? "");
}

function numericString(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function normalizeReportPath(value: string, repoRoot: string): string | undefined {
  let normalized = value.replace(/^file:\/\//, "");
  try {
    normalized = decodeURI(normalized);
  } catch {
    // Keep the raw path if the report contains a non-URI-encoded percent sequence.
  }
  const repo = path.resolve(repoRoot);
  const absolutePath = path.isAbsolute(normalized) ? path.resolve(normalized) : path.resolve(repo, normalized);
  const relative = path.relative(repo, absolutePath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    return undefined;
  }
  return relative.split(path.sep).join("/");
}
