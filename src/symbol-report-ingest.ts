import { promises as fs } from "node:fs";
import path from "node:path";
import { isGeneratedPath, isTestPath, languageForPath } from "./language.js";
import type {
  CodexaSymbolReportRelationshipV1,
  CodexaSymbolReportSymbolV1,
  CodexaSymbolReportV1,
  Confidence,
  FileFact,
  GraphEdgeFact,
  GraphEdgeKind,
  GraphNodeKind,
  LanguageId,
  SymbolFact
} from "./types.js";
import { isSubpath, normalizePath, stableId } from "./util.js";

const SYMBOL_REPORT_PATHS = [".codex/static-analysis/symbols.json", "reports/static-analysis/symbols.json"];
const SYMBOL_REPORT_DIRS = [".codex/static-analysis", "reports/static-analysis"];
const MAX_SYMBOL_REPORT_BYTES = 2 * 1024 * 1024;
const MAX_SYMBOL_REPORTS = 50;
const MAX_SYMBOL_REPORT_RELATIONSHIPS = 50_000;
const SUPPORTED_RELATIONSHIP_KINDS = new Set<GraphEdgeKind>(["DEFINES", "CALLS", "REFERENCES", "IMPORTS", "IMPLEMENTS", "EXTENDS", "EXPORTS", "TYPE_EXPORTS"]);

export interface ExternalSymbolFacts {
  files: FileFact[];
  symbols: SymbolFact[];
  graphEdges: GraphEdgeFact[];
}

export async function validateCodexaSymbolReportFile(repoRoot: string, sourceInput: string): Promise<void> {
  const parsed = await readSymbolReportFile(repoRoot, sourceInput, { strict: true, requireReportUnderRepo: false });
  if (!parsed) {
    throw new Error(`Symbol report is not a CodexaSymbolReportV1 JSON file: ${sourceInput}`);
  }
}

export async function loadExternalSymbolReportFacts(repoRoot: string, snapshotId: string, indexedAt: string, dirtyFiles: Set<string>): Promise<ExternalSymbolFacts> {
  const facts: ExternalSymbolFacts = { files: [], symbols: [], graphEdges: [] };
  const seenReports = new Set<string>();
  for (const reportPath of (await candidateSymbolReports(repoRoot)).slice(0, MAX_SYMBOL_REPORTS)) {
    const absolutePath = path.join(repoRoot, reportPath);
    const parsed = await readSymbolReportFile(repoRoot, absolutePath, { strict: false, requireReportUnderRepo: true });
    if (!parsed || seenReports.has(parsed.realPath)) {
      continue;
    }
    seenReports.add(parsed.realPath);
    const reportFacts = await factsFromSymbolReport(repoRoot, reportPath, parsed.report, snapshotId, indexedAt, dirtyFiles);
    facts.files.push(...reportFacts.files);
    facts.symbols.push(...reportFacts.symbols);
    facts.graphEdges.push(...reportFacts.graphEdges);
  }
  return {
    files: dedupeFiles(facts.files),
    symbols: dedupeSymbols(facts.symbols),
    graphEdges: dedupeGraphEdges(facts.graphEdges)
  };
}

async function factsFromSymbolReport(
  repoRoot: string,
  reportPath: string,
  report: CodexaSymbolReportV1,
  snapshotId: string,
  indexedAt: string,
  dirtyFiles: Set<string>
): Promise<ExternalSymbolFacts> {
  const pathSet = new Set<string>();
  const normalizedSymbols: Array<{ input: CodexaSymbolReportSymbolV1; path: string }> = [];
  for (const symbol of report.symbols.slice(0, 20_000)) {
    const normalizedPath = await normalizeExistingRepoFile(repoRoot, symbol.path);
    if (!normalizedPath) {
      continue;
    }
    pathSet.add(normalizedPath);
    normalizedSymbols.push({ input: symbol, path: normalizedPath });
  }
  for (const relationship of (report.relationships ?? []).slice(0, MAX_SYMBOL_REPORT_RELATIONSHIPS)) {
    const normalizedFromPath = relationship.fromPath ? await normalizeExistingRepoFile(repoRoot, relationship.fromPath) : undefined;
    const normalizedToPath = relationship.toPath ? await normalizeExistingRepoFile(repoRoot, relationship.toPath) : undefined;
    for (const candidate of [relationship.fromPath, relationship.toPath]) {
      const normalizedPath = candidate ? await normalizeExistingRepoFile(repoRoot, candidate) : undefined;
      if (normalizedPath) {
        pathSet.add(normalizedPath);
      }
    }
    if (normalizedFromPath) {
      relationship.fromPath = normalizedFromPath;
    }
    if (normalizedToPath) {
      relationship.toPath = normalizedToPath;
    }
  }

  const files = await Promise.all(
    [...pathSet].sort((a, b) => a.localeCompare(b)).map(async (relativePath): Promise<FileFact | undefined> => {
      const stat = await fs.stat(path.join(repoRoot, relativePath)).catch(() => null);
      if (!stat?.isFile()) {
        return undefined;
      }
      return {
        id: stableId("file", relativePath),
        type: "File",
        path: relativePath,
        source: "static-analysis",
        confidence: "derived",
        snapshotId,
        indexedAt,
        language: languageForExternalReportPath(relativePath, report.language),
        sizeBytes: stat.size,
        dirty: dirtyFiles.has(relativePath),
        generated: isGeneratedPath(relativePath),
        test: isTestPath(relativePath),
        rank: 0,
        rankReasons: { externalSymbolReport: 1 },
        symbolCount: 0,
        usageCount: 0,
        importCount: 0,
        riskScore: 0
      };
    })
  );
  const fileFacts = files.filter((file): file is FileFact => Boolean(file));
  const fileByPath = new Map(fileFacts.map((file) => [file.path, file]));
  const symbolInputsByKey = new Map<string, SymbolFact>();
  const symbols: SymbolFact[] = normalizedSymbols
    .map(({ input, path: symbolPath }) => {
      const line = safeLine(input.line);
      const endLine = Math.max(line ?? 1, safeLine(input.endLine) ?? line ?? 1);
      const qualifiedName = trimmed(input.qualifiedName) ?? input.name;
      const symbol: SymbolFact = {
        id: stableId("symbol-report-symbol", reportPath, trimmed(input.id) ?? "", symbolPath, qualifiedName, input.kind ?? "unknown", line ?? 0),
        type: "Symbol",
        path: symbolPath,
        range: line ? { startLine: line, endLine, startByte: 0, endByte: 0 } : undefined,
        source: "static-analysis",
        confidence: capConfidence(input.confidence),
        snapshotId,
        indexedAt,
        name: input.name,
        qualifiedName,
        kind: input.kind ?? "unknown",
        language: languageForExternalReportPath(symbolPath, report.language),
        exported: input.exported ?? false,
        decorators: [],
        parentSymbolId: input.parentId
      };
      for (const key of symbolKeys(input, symbol)) {
        if (!symbolInputsByKey.has(key)) {
          symbolInputsByKey.set(key, symbol);
        }
      }
      return symbol;
    })
    .filter((symbol) => fileByPath.has(symbol.path));

  const graphEdges: GraphEdgeFact[] = [];
  for (const relationship of (report.relationships ?? []).slice(0, MAX_SYMBOL_REPORT_RELATIONSHIPS)) {
    const edge = graphEdgeFromRelationship({
      relationship,
      reportPath,
      snapshotId,
      indexedAt,
      fileByPath,
      symbolByKey: symbolInputsByKey
    });
    if (edge) {
      graphEdges.push(edge);
    }
  }
  return { files: fileFacts, symbols, graphEdges };
}

function graphEdgeFromRelationship(input: {
  relationship: CodexaSymbolReportRelationshipV1;
  reportPath: string;
  snapshotId: string;
  indexedAt: string;
  fileByPath: Map<string, FileFact>;
  symbolByKey: Map<string, SymbolFact>;
}): GraphEdgeFact | undefined {
  const { relationship, reportPath, snapshotId, indexedAt, fileByPath, symbolByKey } = input;
  if (!SUPPORTED_RELATIONSHIP_KINDS.has(relationship.kind)) {
    return undefined;
  }
  const fromSymbol = lookupSymbol(symbolByKey, relationship.fromSymbol, relationship.fromPath);
  const toSymbol = lookupSymbol(symbolByKey, relationship.toSymbol, relationship.toPath);
  const fromPath = fromSymbol?.path ?? relationship.fromPath;
  const toPath = toSymbol?.path ?? relationship.toPath;
  const fromFile = fromPath ? fileByPath.get(normalizePath(fromPath)) : undefined;
  const toFile = toPath ? fileByPath.get(normalizePath(toPath)) : undefined;
  const from = fromSymbol ? graphTargetForSymbol(fromSymbol) : fromFile ? graphTargetForFile(fromFile) : undefined;
  const to = toSymbol ? graphTargetForSymbol(toSymbol) : toFile ? graphTargetForFile(toFile) : undefined;
  if (!from || !to) {
    return undefined;
  }
  const line = safeLine(relationship.line);
  const reason = trimmed(relationship.reason) ?? `${reportPath}: ${relationship.kind.toLowerCase()} relationship from ${from.label} to ${to.label}`;
  return {
    id: stableId("graph-edge", relationship.kind, from.id, to.id, reason, line ?? 0),
    type: "GraphEdge",
    edgeKind: relationship.kind,
    fromId: from.id,
    toId: to.id,
    fromKind: from.kind,
    toKind: to.kind,
    fromPath: from.path,
    toPath: to.path,
    fromSymbolId: from.symbolId,
    toSymbolId: to.symbolId,
    reason: reason.slice(0, 240),
    weight: weightForRelationship(relationship.kind),
    source: "static-analysis",
    confidence: capConfidence(relationship.confidence),
    snapshotId,
    indexedAt,
    range: line ? { startLine: line, endLine: Math.max(line, safeLine(relationship.endLine) ?? line), startByte: 0, endByte: 0 } : undefined
  };
}

async function candidateSymbolReports(repoRoot: string): Promise<string[]> {
  const candidates = new Set(SYMBOL_REPORT_PATHS);
  for (const relativeDir of SYMBOL_REPORT_DIRS) {
    const absoluteDir = path.join(repoRoot, relativeDir);
    for (const report of await walkReportDir(absoluteDir, relativeDir, 0)) {
      candidates.add(report);
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
    if (entry.isFile() && /\.json$/i.test(entry.name)) {
      reports.push(relativePath);
    }
  }
  return reports.sort((a, b) => a.localeCompare(b));
}

async function readSymbolReportFile(
  repoRoot: string,
  fileInput: string,
  options: { strict: boolean; requireReportUnderRepo: boolean }
): Promise<{ report: CodexaSymbolReportV1; realPath: string } | undefined> {
  const { strict, requireReportUnderRepo } = options;
  const source = path.resolve(fileInput);
  const stat = await fs.stat(source).catch(() => null);
  if (!stat?.isFile()) {
    if (strict) throw new Error(`Symbol report not found or not a file: ${fileInput}`);
    return undefined;
  }
  if (stat.size > MAX_SYMBOL_REPORT_BYTES) {
    if (strict) throw new Error(`Symbol report exceeds ${MAX_SYMBOL_REPORT_BYTES} bytes: ${fileInput}`);
    return undefined;
  }
  const repoReal = await fs.realpath(repoRoot);
  const realPath = await fs.realpath(source).catch(() => "");
  if (!realPath || (requireReportUnderRepo && !isSubpath(realPath, repoReal))) {
    if (strict) throw new Error(`Symbol report must resolve under the repository: ${fileInput}`);
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.readFile(realPath, "utf8"));
  } catch (error) {
    if (strict) throw new Error(`Symbol report is not valid JSON: ${(error as Error).message}`);
    return undefined;
  }
  if (strict) {
    const errors = strictSymbolReportErrors(parsed);
    if (errors.length > 0) {
      throw new Error(`Symbol report failed CodexaSymbolReportV1 validation: ${errors.slice(0, 5).join("; ")}`);
    }
  }
  const report = normalizeSymbolReport(parsed);
  if (!report) {
    if (strict) throw new Error("Symbol report must match CodexaSymbolReportV1.");
    return undefined;
  }
  const invalidPaths = await reportPathsOutsideRepo(repoRoot, report);
  if (invalidPaths.length > 0) {
    if (strict) throw new Error(`Symbol report references paths outside the repository or missing files: ${invalidPaths.slice(0, 5).join(", ")}`);
    return undefined;
  }
  return { report, realPath };
}

function strictSymbolReportErrors(value: unknown): string[] {
  const errors: string[] = [];
  if (!value || typeof value !== "object") {
    return ["report must be an object"];
  }
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== 1) errors.push("schemaVersion must be 1");
  if (!trimmed(record.tool)) errors.push("tool must be a non-empty string");
  if (!trimmed(record.language)) errors.push("language must be a non-empty string");
  const symbols = Array.isArray(record.symbols) ? record.symbols : undefined;
  if (!symbols) {
    errors.push("symbols must be an array");
  } else {
    symbols.forEach((entry, index) => {
      if (!entry || typeof entry !== "object") {
        errors.push(`symbols[${index}] must be an object`);
        return;
      }
      const symbol = entry as Record<string, unknown>;
      if (!trimmed(symbol.name)) errors.push(`symbols[${index}].name must be a non-empty string`);
      if (!trimmed(symbol.path)) errors.push(`symbols[${index}].path must be a non-empty string`);
      if (symbol.confidence !== undefined && symbol.confidence !== "authoritative" && symbol.confidence !== "derived" && symbol.confidence !== "heuristic") {
        errors.push(`symbols[${index}].confidence is unsupported`);
      }
      if (symbol.kind !== undefined && normalizeSymbolKind(symbol.kind) === "unknown" && symbol.kind !== "unknown") {
        errors.push(`symbols[${index}].kind is unsupported`);
      }
    });
  }
  if (record.relationships !== undefined && !Array.isArray(record.relationships)) {
    errors.push("relationships must be an array when present");
  }
  const relationships = Array.isArray(record.relationships) ? record.relationships : [];
  relationships.forEach((entry, index) => {
    if (!entry || typeof entry !== "object") {
      errors.push(`relationships[${index}] must be an object`);
      return;
    }
    const relationship = entry as Record<string, unknown>;
    if (!SUPPORTED_RELATIONSHIP_KINDS.has(relationship.kind as GraphEdgeKind)) {
      errors.push(`relationships[${index}].kind is unsupported`);
    }
    if (relationship.confidence !== undefined && relationship.confidence !== "authoritative" && relationship.confidence !== "derived" && relationship.confidence !== "heuristic") {
      errors.push(`relationships[${index}].confidence is unsupported`);
    }
  });
  return errors;
}

function normalizeSymbolReport(value: unknown): CodexaSymbolReportV1 | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== 1 || typeof record.tool !== "string" || typeof record.language !== "string" || !Array.isArray(record.symbols)) {
    return undefined;
  }
  const symbols = record.symbols.flatMap((entry) => {
    if (!entry || typeof entry !== "object") {
      return [];
    }
    const symbol = entry as Partial<CodexaSymbolReportSymbolV1>;
    if (!trimmed(symbol.name) || !trimmed(symbol.path)) {
      return [];
    }
    return [
      {
        ...symbol,
        name: trimmed(symbol.name)!,
        path: trimmed(symbol.path)!,
        confidence: capConfidence(symbol.confidence),
        kind: normalizeSymbolKind(symbol.kind)
      } satisfies CodexaSymbolReportSymbolV1
    ];
  });
  const relationships = Array.isArray(record.relationships)
    ? record.relationships.flatMap((entry) => {
        if (!entry || typeof entry !== "object") {
          return [];
        }
        const relationship = entry as Partial<CodexaSymbolReportRelationshipV1>;
        if (!relationship.kind || !SUPPORTED_RELATIONSHIP_KINDS.has(relationship.kind)) {
          return [];
        }
        return [{ ...relationship, kind: relationship.kind, confidence: capConfidence(relationship.confidence) } satisfies CodexaSymbolReportRelationshipV1];
      })
    : [];
  return { schemaVersion: 1, tool: record.tool.trim(), language: record.language.trim(), symbols, relationships };
}

async function reportPathsOutsideRepo(repoRoot: string, report: CodexaSymbolReportV1): Promise<string[]> {
  const invalid: string[] = [];
  for (const filePath of [
    ...report.symbols.map((symbol) => symbol.path),
    ...(report.relationships ?? []).flatMap((relationship) => [relationship.fromPath, relationship.toPath].filter((entry): entry is string => Boolean(entry)))
  ]) {
    if (!(await normalizeExistingRepoFile(repoRoot, filePath))) {
      invalid.push(filePath);
    }
  }
  return invalid;
}

async function normalizeExistingRepoFile(repoRoot: string, inputPath: string): Promise<string | undefined> {
  if (!inputPath || inputPath.includes("\0")) {
    return undefined;
  }
  const repoReal = await fs.realpath(repoRoot);
  const absolute = path.isAbsolute(inputPath) ? path.resolve(inputPath) : path.resolve(repoRoot, inputPath);
  const real = await fs.realpath(absolute).catch(() => "");
  if (!real || !isSubpath(real, repoReal)) {
    return undefined;
  }
  const stat = await fs.stat(real).catch(() => null);
  if (!stat?.isFile()) {
    return undefined;
  }
  return normalizePath(path.relative(repoReal, real));
}

function languageForExternalReportPath(filePath: string, reportLanguage: string): LanguageId {
  const pathLanguage = languageForPath(filePath);
  if (pathLanguage !== "unknown") {
    return pathLanguage;
  }
  const normalized = reportLanguage.trim().toLowerCase();
  if (normalized === "rust" || normalized === "go" || normalized === "java" || normalized === "ruby" || normalized === "php") {
    return normalized;
  }
  if (normalized === "csharp" || normalized === "c#") {
    return "csharp";
  }
  if (normalized === "cpp" || normalized === "c++") {
    return "cpp";
  }
  if (normalized === "c") {
    return "c";
  }
  return "unknown";
}

function symbolKeys(input: CodexaSymbolReportSymbolV1, symbol: SymbolFact): string[] {
  return [
    trimmed(input.id),
    symbol.id,
    symbol.name,
    symbol.qualifiedName,
    `${symbol.path}:${symbol.name}`,
    `${symbol.path}:${symbol.qualifiedName}`
  ].filter((entry): entry is string => Boolean(entry));
}

function lookupSymbol(symbolByKey: Map<string, SymbolFact>, key?: string, filePath?: string): SymbolFact | undefined {
  const normalizedKey = trimmed(key);
  if (!normalizedKey) {
    return undefined;
  }
  return symbolByKey.get(normalizedKey) ?? (filePath ? symbolByKey.get(`${normalizePath(filePath)}:${normalizedKey}`) : undefined);
}

function graphTargetForFile(file: FileFact): { id: string; kind: GraphNodeKind; path: string; label: string; symbolId?: string } {
  return { id: file.id, kind: "file", path: file.path, label: file.path };
}

function graphTargetForSymbol(symbol: SymbolFact): { id: string; kind: GraphNodeKind; path: string; label: string; symbolId: string } {
  return { id: symbol.id, kind: "symbol", path: symbol.path, symbolId: symbol.id, label: symbol.qualifiedName };
}

function weightForRelationship(kind: GraphEdgeKind): number {
  if (kind === "CALLS" || kind === "IMPORTS") return 2.5;
  if (kind === "IMPLEMENTS" || kind === "EXTENDS") return 2.3;
  if (kind === "EXPORTS" || kind === "TYPE_EXPORTS") return 2;
  return 1.5;
}

function capConfidence(value: unknown): Confidence {
  if (value === "heuristic") {
    return "heuristic";
  }
  return "derived";
}

function normalizeSymbolKind(value: unknown): SymbolFact["kind"] {
  return value === "module" ||
    value === "class" ||
    value === "interface" ||
    value === "type" ||
    value === "enum" ||
    value === "function" ||
    value === "method" ||
    value === "variable" ||
    value === "route" ||
    value === "fixture" ||
    value === "test" ||
    value === "node" ||
    value === "unknown"
    ? value
    : "unknown";
}

function safeLine(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function trimmed(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function dedupeFiles(files: FileFact[]): FileFact[] {
  const byPath = new Map<string, FileFact>();
  for (const file of files) {
    if (!byPath.has(file.path)) {
      byPath.set(file.path, file);
    }
  }
  return [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
}

function dedupeSymbols(symbols: SymbolFact[]): SymbolFact[] {
  const seen = new Set<string>();
  const result: SymbolFact[] = [];
  for (const symbol of symbols) {
    const key = `${symbol.path}\0${symbol.qualifiedName}\0${symbol.kind}\0${symbol.range?.startLine ?? 0}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(symbol);
  }
  return result.sort((a, b) => a.path.localeCompare(b.path) || a.qualifiedName.localeCompare(b.qualifiedName));
}

function dedupeGraphEdges(edges: GraphEdgeFact[]): GraphEdgeFact[] {
  const seen = new Set<string>();
  const result: GraphEdgeFact[] = [];
  for (const edge of edges) {
    if (seen.has(edge.id)) {
      continue;
    }
    seen.add(edge.id);
    result.push(edge);
  }
  return result.sort((a, b) => a.edgeKind.localeCompare(b.edgeKind) || (a.fromPath ?? "").localeCompare(b.fromPath ?? "") || (a.toPath ?? "").localeCompare(b.toPath ?? ""));
}
