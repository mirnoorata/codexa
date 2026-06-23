import { promises as fs } from "node:fs";
import path from "node:path";
import type { CodexaSymbolReportRelationshipV1, CodexaSymbolReportSymbolV1, CodexaSymbolReportV1, SymbolFact } from "./types.js";
import { isSubpath, normalizePath, stableId } from "./util.js";

const MAX_SCIP_JSON_BYTES = 16 * 1024 * 1024;
const MAX_SCIP_DOCUMENTS = 5_000;
const MAX_SCIP_OCCURRENCES = 100_000;
const MAX_SCIP_SYMBOLS = 20_000;
const MAX_SCIP_RELATIONSHIPS = 50_000;
const MAX_SCIP_ENCLOSING_RANGE_CHECKS = 1_000_000;
const MAX_SCIP_INT32 = 2_147_483_647;
const SCIP_ROLE_DEFINITION = 1;
const SCIP_ROLE_IMPORT = 2;
const SCIP_ROLE_FORWARD_DEFINITION = 64;
export const CODEXA_SCIP_SYMBOL_REPORT_GENERATOR = "codexa-scip-import";

type CodexaSymbolKind = SymbolFact["kind"];

interface ScipRange {
  startLine: number;
  startCharacter: number;
  endLine: number;
  endCharacter: number;
}

interface LocalSymbolInfo {
  symbol: string;
  path: string;
  line?: number;
  endLine?: number;
  bodyRange?: ScipRange;
  name: string;
  kind: CodexaSymbolKind;
}

interface DocumentInfo {
  path: string;
  language?: string;
  symbols: Map<string, LocalSymbolInfo>;
}

export async function convertScipJsonReportToSymbolReport(repoRootInput: string, sourceInput: string): Promise<CodexaSymbolReportV1> {
  const repoRoot = path.resolve(repoRootInput);
  const repoReal = await fs.realpath(repoRoot);
  const source = path.resolve(sourceInput);
  const stat = await fs.stat(source).catch(() => null);
  if (!stat?.isFile()) {
    throw new Error(`SCIP report not found or not a file: ${sourceInput}`);
  }
  if (stat.size > MAX_SCIP_JSON_BYTES) {
    throw new Error(`SCIP JSON report exceeds ${MAX_SCIP_JSON_BYTES} bytes: ${sourceInput}`);
  }

  const parsed = parseScipJson(await fs.readFile(source, "utf8"), sourceInput);
  const documents = arrayField(parsed, "documents");
  if (!documents) {
    throw new Error("SCIP JSON report must contain a documents array.");
  }
  if (documents.length > MAX_SCIP_DOCUMENTS) {
    throw new Error(`SCIP JSON report contains ${documents.length} documents; limit is ${MAX_SCIP_DOCUMENTS}.`);
  }

  let occurrenceCount = 0;
  let scipSymbolCount = 0;
  let scipRelationshipCount = 0;
  let scipContainmentCheckCount = 0;
  const documentInfos: DocumentInfo[] = [];
  const symbolByScipId = new Map<string, LocalSymbolInfo>();
  const convertedSymbols = new Map<string, CodexaSymbolReportSymbolV1>();

  for (let documentIndex = 0; documentIndex < documents.length; documentIndex += 1) {
    const document = objectValue(documents[documentIndex], `documents[${documentIndex}]`);
    const relativePath = documentPathField(document);
    if (!relativePath) {
      throw new Error(`SCIP document ${documentIndex} is missing relativePath.`);
    }
    const normalizedPath = await normalizeScipDocumentPath(repoReal, relativePath);
    const occurrences = arrayField(document, "occurrences") ?? [];
    const symbolInfos = arrayField(document, "symbols") ?? [];
    occurrenceCount += occurrences.length;
    scipSymbolCount += symbolInfos.length;
    if (occurrenceCount > MAX_SCIP_OCCURRENCES) {
      throw new Error(`SCIP JSON report contains more than ${MAX_SCIP_OCCURRENCES} occurrences.`);
    }
    if (scipSymbolCount > MAX_SCIP_SYMBOLS) {
      throw new Error(`SCIP JSON report contains more than ${MAX_SCIP_SYMBOLS} symbols.`);
    }

    const definitions = definitionRanges(occurrences, documentIndex);
    const documentSymbols = new Map<string, LocalSymbolInfo>();
    const language = stringField(document, "language") ?? languageFromPath(normalizedPath);

    for (let symbolIndex = 0; symbolIndex < symbolInfos.length; symbolIndex += 1) {
      const symbolInfo = objectValue(symbolInfos[symbolIndex], `documents[${documentIndex}].symbols[${symbolIndex}]`);
      const symbolId = stringField(symbolInfo, "symbol");
      if (!symbolId || isLocalScipSymbol(symbolId)) {
        continue;
      }
      const definition = definitions.get(symbolId);
      const localInfo: LocalSymbolInfo = {
        symbol: symbolId,
        path: normalizedPath,
        line: definition?.line,
        endLine: definition?.endLine,
        bodyRange: definition?.bodyRange,
        name: stringField(symbolInfo, "displayName", "display_name") ?? displayNameFromScipSymbol(symbolId),
        kind: scipSymbolKind(symbolInfo)
      };
      addSymbol(localInfo, convertedSymbols, symbolByScipId, documentSymbols);
    }

    for (const [symbolId, definition] of definitions) {
      if (isLocalScipSymbol(symbolId) || documentSymbols.has(symbolId)) {
        continue;
      }
      const localInfo: LocalSymbolInfo = {
        symbol: symbolId,
        path: normalizedPath,
        line: definition.line,
        endLine: definition.endLine,
        bodyRange: definition.bodyRange,
        name: displayNameFromScipSymbol(symbolId),
        kind: "unknown"
      };
      addSymbol(localInfo, convertedSymbols, symbolByScipId, documentSymbols);
    }

    documentInfos.push({ path: normalizedPath, language, symbols: documentSymbols });
  }

  const relationships = new Map<string, CodexaSymbolReportRelationshipV1>();
  const countRelationship = (): void => {
    scipRelationshipCount += 1;
    if (scipRelationshipCount > MAX_SCIP_RELATIONSHIPS) {
      throw new Error(`SCIP JSON report contains more than ${MAX_SCIP_RELATIONSHIPS} relationships.`);
    }
  };
  const countContainmentCheck = (): void => {
    scipContainmentCheckCount += 1;
    if (scipContainmentCheckCount > MAX_SCIP_ENCLOSING_RANGE_CHECKS) {
      throw new Error(`SCIP JSON report requires more than ${MAX_SCIP_ENCLOSING_RANGE_CHECKS} enclosing range checks.`);
    }
  };
  for (let documentIndex = 0; documentIndex < documents.length; documentIndex += 1) {
    const document = documents[documentIndex] as Record<string, unknown>;
    const documentInfo = documentInfos[documentIndex];
    addRelationshipsFromSymbolInfo(document, documentInfo, symbolByScipId, relationships, countRelationship);
    addRelationshipsFromOccurrences(document, documentInfo, symbolByScipId, relationships, countRelationship, countContainmentCheck);
  }

  const symbols = [...convertedSymbols.values()].sort(sortSymbols);
  const language = reportLanguage(documentInfos);
  return {
    schemaVersion: 1,
    tool: scipToolName(parsed),
    generatedBy: CODEXA_SCIP_SYMBOL_REPORT_GENERATOR,
    language,
    symbols,
    relationships: [...relationships.values()].sort(sortRelationships)
  };
}

function parseScipJson(content: string, sourceInput: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(content);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("top-level value must be an object");
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    throw new Error(`SCIP report must be JSON from "scip print --json"; binary index.scip files are not imported directly: ${(error as Error).message} (${sourceInput})`);
  }
}

async function normalizeScipDocumentPath(repoReal: string, relativePath: string): Promise<string> {
  if (
    !relativePath ||
    relativePath !== relativePath.trim() ||
    /[\x00-\x1f\x7f]/u.test(relativePath) ||
    relativePath.includes("\\") ||
    relativePath.startsWith("/") ||
    path.win32.isAbsolute(relativePath)
  ) {
    throw new Error(`SCIP document path is not a canonical relative path: ${relativePath}`);
  }
  const parts = relativePath.split("/");
  if (parts.some((part) => part.length === 0 || part === "." || part === "..")) {
    throw new Error(`SCIP document path is not a canonical relative path: ${relativePath}`);
  }
  const absolute = path.resolve(repoReal, relativePath);
  const lstat = await fs.lstat(absolute).catch(() => null);
  if (!lstat?.isFile() || lstat.isSymbolicLink()) {
    throw new Error(`SCIP document path must be an existing repository file: ${relativePath}`);
  }
  const real = await fs.realpath(absolute).catch(() => "");
  if (!real || !isSubpath(real, repoReal)) {
    throw new Error(`SCIP document path resolves outside the repository: ${relativePath}`);
  }
  return normalizePath(path.relative(repoReal, real));
}

function definitionRanges(occurrences: unknown[], documentIndex: number): Map<string, { line?: number; endLine?: number; bodyRange?: ScipRange }> {
  const definitions = new Map<string, { line?: number; endLine?: number; bodyRange?: ScipRange }>();
  for (let occurrenceIndex = 0; occurrenceIndex < occurrences.length; occurrenceIndex += 1) {
    const occurrence = objectValue(occurrences[occurrenceIndex], `documents[${documentIndex}].occurrences[${occurrenceIndex}]`);
    const symbol = stringField(occurrence, "symbol");
    if (!symbol || !hasDefinitionRole(occurrence, `documents[${documentIndex}].occurrences[${occurrenceIndex}]`)) {
      parseOptionalRange(occurrence, `documents[${documentIndex}].occurrences[${occurrenceIndex}]`);
      continue;
    }
    const range = parseOptionalRange(occurrence, `documents[${documentIndex}].occurrences[${occurrenceIndex}]`);
    const bodyRange = parseOptionalRange(occurrence, `documents[${documentIndex}].occurrences[${occurrenceIndex}].enclosingRange`, "enclosingRange", "enclosing_range");
    if (!definitions.has(symbol)) {
      definitions.set(symbol, {
        line: range ? range.startLine + 1 : undefined,
        endLine: range ? Math.max(range.endLine + 1, range.startLine + 1) : undefined,
        bodyRange
      });
    }
  }
  return definitions;
}

function addSymbol(
  localInfo: LocalSymbolInfo,
  convertedSymbols: Map<string, CodexaSymbolReportSymbolV1>,
  symbolByScipId: Map<string, LocalSymbolInfo>,
  documentSymbols: Map<string, LocalSymbolInfo>
): void {
  const symbolKey = `${localInfo.symbol}\0${localInfo.path}`;
  if (!convertedSymbols.has(symbolKey) && convertedSymbols.size >= MAX_SCIP_SYMBOLS) {
    throw new Error(`SCIP JSON report generates more than ${MAX_SCIP_SYMBOLS} symbols.`);
  }
  symbolByScipId.set(localInfo.symbol, localInfo);
  documentSymbols.set(localInfo.symbol, localInfo);
  convertedSymbols.set(symbolKey, {
    id: localInfo.symbol,
    name: localInfo.name,
    qualifiedName: localInfo.symbol,
    kind: localInfo.kind,
    path: localInfo.path,
    line: localInfo.line,
    endLine: localInfo.endLine,
    exported: false,
    confidence: "derived"
  });
}

function addRelationshipsFromSymbolInfo(
  document: Record<string, unknown>,
  documentInfo: DocumentInfo,
  symbolByScipId: Map<string, LocalSymbolInfo>,
  relationships: Map<string, CodexaSymbolReportRelationshipV1>,
  countRelationship: () => void
): void {
  for (const symbolInfoValue of arrayField(document, "symbols") ?? []) {
    const symbolInfo = objectValue(symbolInfoValue, "SCIP symbol information");
    const fromSymbol = stringField(symbolInfo, "symbol");
    const from = fromSymbol ? documentInfo.symbols.get(fromSymbol) : undefined;
    if (!from) {
      continue;
    }
    for (const relationshipValue of arrayField(symbolInfo, "relationships") ?? []) {
      countRelationship();
      const relationship = objectValue(relationshipValue, `SCIP relationships for ${fromSymbol}`);
      const toSymbol = stringField(relationship, "symbol");
      const to = toSymbol ? documentInfo.symbols.get(toSymbol) ?? symbolByScipId.get(toSymbol) : undefined;
      if (!to) {
        continue;
      }
      if (truthyField(relationship, "isImplementation", "is_implementation")) {
        addRelationship(relationships, "IMPLEMENTS", from, to, from.line, "SCIP implementation relationship");
      }
      if (truthyField(relationship, "isReference", "is_reference")) {
        addRelationship(relationships, "REFERENCES", from, to, from.line, "SCIP reference relationship");
      }
    }
  }
}

function addRelationshipsFromOccurrences(
  document: Record<string, unknown>,
  documentInfo: DocumentInfo,
  symbolByScipId: Map<string, LocalSymbolInfo>,
  relationships: Map<string, CodexaSymbolReportRelationshipV1>,
  countRelationship: () => void,
  countContainmentCheck: () => void
): void {
  const enclosingDefinitions = [...documentInfo.symbols.values()]
    .filter((symbol) => symbol.bodyRange)
    .sort((a, b) => compareRangeSpecificity(a.bodyRange!, b.bodyRange!) || a.symbol.localeCompare(b.symbol));
  for (const occurrenceValue of arrayField(document, "occurrences") ?? []) {
    const occurrence = objectValue(occurrenceValue, "SCIP occurrence");
    const toSymbolId = stringField(occurrence, "symbol");
    const to = toSymbolId ? documentInfo.symbols.get(toSymbolId) ?? symbolByScipId.get(toSymbolId) : undefined;
    if (!to || hasDefinitionRole(occurrence, "SCIP occurrence")) {
      continue;
    }
    const range = parseOptionalRange(occurrence, "SCIP occurrence");
    if (!range) {
      continue;
    }
    let from: LocalSymbolInfo | undefined;
    for (const candidate of enclosingDefinitions) {
      countContainmentCheck();
      if (candidate.bodyRange && rangeWithin(range, candidate.bodyRange)) {
        from = candidate;
        break;
      }
    }
    countRelationship();
    const kind = hasRole(occurrence, SCIP_ROLE_IMPORT, "SCIP occurrence") ? "IMPORTS" : "REFERENCES";
    if (from) {
      addRelationship(relationships, kind, from, to, range.startLine + 1, `SCIP ${kind.toLowerCase()} occurrence`);
    } else {
      addFileRelationship(relationships, kind, documentInfo.path, to, range.startLine + 1, `SCIP file-level ${kind.toLowerCase()} occurrence`);
    }
  }
}

function addRelationship(
  relationships: Map<string, CodexaSymbolReportRelationshipV1>,
  kind: CodexaSymbolReportRelationshipV1["kind"],
  from: LocalSymbolInfo,
  to: LocalSymbolInfo,
  line: number | undefined,
  reason: string
): void {
  const key = `${kind}\0${from.path}\0${from.symbol}\0${to.path}\0${to.symbol}\0${line ?? 0}`;
  if (!relationships.has(key) && relationships.size >= MAX_SCIP_RELATIONSHIPS) {
    throw new Error(`SCIP JSON report generates more than ${MAX_SCIP_RELATIONSHIPS} relationships.`);
  }
  const relationship: CodexaSymbolReportRelationshipV1 = {
    kind,
    fromSymbol: from.symbol,
    fromPath: from.path,
    toSymbol: to.symbol,
    toPath: to.path,
    line,
    confidence: "derived",
    reason
  };
  relationships.set(key, relationship);
}

function addFileRelationship(
  relationships: Map<string, CodexaSymbolReportRelationshipV1>,
  kind: CodexaSymbolReportRelationshipV1["kind"],
  fromPath: string,
  to: LocalSymbolInfo,
  line: number | undefined,
  reason: string
): void {
  const key = `${kind}\0${fromPath}\0${to.symbol}\0${line ?? 0}`;
  if (!relationships.has(key) && relationships.size >= MAX_SCIP_RELATIONSHIPS) {
    throw new Error(`SCIP JSON report generates more than ${MAX_SCIP_RELATIONSHIPS} relationships.`);
  }
  relationships.set(key, {
    kind,
    fromPath,
    toSymbol: to.symbol,
    toPath: to.path,
    line,
    confidence: "derived",
    reason
  });
}

function parseOptionalRange(record: Record<string, unknown>, context: string, camel = "range", snake = "range"): ScipRange | undefined {
  const typed = typedRange(record, camel === "enclosingRange" || camel === "enclosing_range");
  if (typed) {
    return typed;
  }
  const value = field(record, camel, snake);
  if (value === undefined) {
    return undefined;
  }
  const parsed = rangeValue(value, context);
  return parsed;
}

function typedRange(record: Record<string, unknown>, enclosing: boolean): ScipRange | undefined {
  const single = enclosing ? field(record, "singleLineEnclosingRange", "single_line_enclosing_range") : field(record, "singleLineRange", "single_line_range");
  if (single !== undefined) {
    if (!single || typeof single !== "object" || Array.isArray(single)) {
      throw new Error("SCIP typed range has a malformed range.");
    }
    const singleRecord = single as Record<string, unknown>;
    const line = numberField(singleRecord, "line");
    const startCharacter = numberField(singleRecord, "startCharacter", "start_character");
    const endCharacter = numberField(singleRecord, "endCharacter", "end_character");
    if (line === undefined || startCharacter === undefined || endCharacter === undefined) {
      throw new Error("SCIP typed range has a malformed range.");
    }
    return validatedRange({ startLine: line, startCharacter, endLine: line, endCharacter }, "typed range");
  }
  const multi = enclosing ? field(record, "multiLineEnclosingRange", "multi_line_enclosing_range") : field(record, "multiLineRange", "multi_line_range");
  if (multi !== undefined) {
    if (!multi || typeof multi !== "object" || Array.isArray(multi)) {
      throw new Error("SCIP typed range has a malformed range.");
    }
    const multiRecord = multi as Record<string, unknown>;
    const startLine = numberField(multiRecord, "startLine", "start_line");
    const startCharacter = numberField(multiRecord, "startCharacter", "start_character");
    const endLine = numberField(multiRecord, "endLine", "end_line");
    const endCharacter = numberField(multiRecord, "endCharacter", "end_character");
    if (startLine === undefined || startCharacter === undefined || endLine === undefined || endCharacter === undefined) {
      throw new Error("SCIP typed range has a malformed range.");
    }
    return validatedRange({ startLine, startCharacter, endLine, endCharacter }, "typed range");
  }
  return undefined;
}

function rangeValue(value: unknown, context: string): ScipRange {
  if (Array.isArray(value)) {
    const numbers = value.map((entry) => (typeof entry === "number" && Number.isSafeInteger(entry) && entry >= 0 && entry <= MAX_SCIP_INT32 ? entry : undefined));
    if ((numbers.length === 3 || numbers.length === 4) && numbers.every((entry) => entry !== undefined)) {
      return validatedRange(
        {
          startLine: numbers[0]!,
          startCharacter: numbers[1]!,
          endLine: numbers.length === 3 ? numbers[0]! : numbers[2]!,
          endCharacter: numbers.length === 3 ? numbers[2]! : numbers[3]!
        },
        context
      );
    }
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const single = field(record, "singleLineRange", "single_line_range");
    if (single && typeof single === "object") {
      const singleRecord = single as Record<string, unknown>;
      const line = numberField(singleRecord, "line");
      const startCharacter = numberField(singleRecord, "startCharacter", "start_character");
      const endCharacter = numberField(singleRecord, "endCharacter", "end_character");
      if (line !== undefined && startCharacter !== undefined && endCharacter !== undefined) return validatedRange({ startLine: line, startCharacter, endLine: line, endCharacter }, context);
    }
    const multi = field(record, "multiLineRange", "multi_line_range");
    if (multi && typeof multi === "object") {
      const multiRecord = multi as Record<string, unknown>;
      const startLine = numberField(multiRecord, "startLine", "start_line");
      const startCharacter = numberField(multiRecord, "startCharacter", "start_character");
      const endLine = numberField(multiRecord, "endLine", "end_line");
      const endCharacter = numberField(multiRecord, "endCharacter", "end_character");
      if (startLine !== undefined && startCharacter !== undefined && endLine !== undefined && endCharacter !== undefined) return validatedRange({ startLine, startCharacter, endLine, endCharacter }, context);
    }
    const startLine = requiredRangeIntegerField(record, context, "startLine", "start_line");
    const startCharacter = optionalRangeIntegerField(record, context, 0, "startCharacter", "start_character");
    const endLine = optionalRangeIntegerField(record, context, startLine, "endLine", "end_line");
    const endCharacter = optionalRangeIntegerField(record, context, startCharacter, "endCharacter", "end_character");
    if (startLine !== undefined && endLine !== undefined) {
      return validatedRange({ startLine, startCharacter, endLine, endCharacter }, context);
    }
  }
  throw new Error(`SCIP ${context} has a malformed range.`);
}

function validatedRange(range: ScipRange, context: string): ScipRange {
  if (range.endLine < range.startLine || (range.endLine === range.startLine && range.endCharacter < range.startCharacter)) {
    throw new Error(`SCIP ${context} has an invalid range.`);
  }
  return range;
}

function hasRole(record: Record<string, unknown>, bit: number, context: string): boolean {
  const value = field(record, "symbolRoles", "symbol_roles");
  if (value === undefined) {
    return false;
  }
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= MAX_SCIP_INT32) {
    return (value & bit) !== 0;
  }
  throw new Error(`SCIP ${context} symbolRoles must be a non-negative integer bitset.`);
}

function hasDefinitionRole(record: Record<string, unknown>, context: string): boolean {
  return hasRole(record, SCIP_ROLE_DEFINITION, context) || hasRole(record, SCIP_ROLE_FORWARD_DEFINITION, context);
}

function requiredRangeIntegerField(record: Record<string, unknown>, context: string, camel: string, snake = camel): number | undefined {
  const value = field(record, camel, snake);
  if (value === undefined) {
    return undefined;
  }
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= MAX_SCIP_INT32) {
    return value;
  }
  throw new Error(`SCIP ${context} has a malformed range.`);
}

function optionalRangeIntegerField(record: Record<string, unknown>, context: string, fallback: number | undefined, camel: string, snake = camel): number {
  const value = field(record, camel, snake);
  if (value === undefined) {
    return fallback ?? 0;
  }
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= MAX_SCIP_INT32) {
    return value;
  }
  throw new Error(`SCIP ${context} has a malformed range.`);
}

function scipSymbolKind(symbolInfo: Record<string, unknown>): CodexaSymbolKind {
  const value = field(symbolInfo, "kind");
  if (typeof value === "number") {
    return scipNumericKind(value);
  }
  if (typeof value !== "string") {
    return "unknown";
  }
  const normalized = value.toLowerCase();
  if (normalized.includes("method") || normalized.includes("constructor")) return "method";
  if (normalized.includes("function") || normalized.includes("macro")) return "function";
  if (normalized.includes("class") || normalized.includes("object") || normalized.includes("contract")) return "class";
  if (normalized.includes("interface") || normalized.includes("trait")) return "interface";
  if (normalized.includes("enum")) return "enum";
  if (normalized.includes("struct") || normalized.includes("type")) return "type";
  if (normalized.includes("module") || normalized.includes("namespace") || normalized.includes("package") || normalized.includes("library")) return "module";
  if (normalized.includes("variable") || normalized.includes("property") || normalized.includes("field") || normalized.includes("parameter") || normalized.includes("constant") || normalized.includes("value")) return "variable";
  return "unknown";
}

function scipNumericKind(value: number): CodexaSymbolKind {
  if ([9, 26, 80].includes(value)) return "method";
  if ([17, 25].includes(value)) return "function";
  if ([7, 62].includes(value)) return "class";
  if ([21, 53].includes(value)) return "interface";
  if ([11].includes(value)) return "enum";
  if ([49, 54, 55, 58].includes(value)) return "type";
  if ([29, 30, 35, 64].includes(value)) return "module";
  if ([8, 12, 15, 37, 41, 60, 61, 82].includes(value)) return "variable";
  return "unknown";
}

function displayNameFromScipSymbol(symbol: string): string {
  const token = symbol.trim().split(/\s+/).at(-1) ?? symbol;
  const withoutSuffix = token.replace(/[().:#[\]/!]+$/g, "");
  const parts = withoutSuffix.split(/[/.#:![\]()`]+/).filter(Boolean);
  return parts.at(-1)?.replaceAll("``", "`") || `scip-${stableId(symbol)}`;
}

function reportLanguage(documents: DocumentInfo[]): string {
  const languages = [...new Set(documents.map((document) => document.language).filter((value): value is string => Boolean(value)))].sort((a, b) => a.localeCompare(b));
  return languages.length === 1 ? languages[0] : languages.length > 1 ? "mixed" : "unknown";
}

function scipToolName(parsed: Record<string, unknown>): string {
  const metadata = field(parsed, "metadata");
  const toolInfo = metadata && typeof metadata === "object" ? field(metadata as Record<string, unknown>, "toolInfo", "tool_info") : undefined;
  const name = toolInfo && typeof toolInfo === "object" ? stringField(toolInfo as Record<string, unknown>, "name") : undefined;
  const version = toolInfo && typeof toolInfo === "object" ? stringField(toolInfo as Record<string, unknown>, "version") : undefined;
  return ["scip", name, version].filter(Boolean).join(":");
}

function languageFromPath(filePath: string): string | undefined {
  const ext = path.extname(filePath).toLowerCase();
  const languages: Record<string, string> = {
    ".rs": "rust",
    ".go": "go",
    ".java": "java",
    ".js": "javascript",
    ".jsx": "javascript",
    ".ts": "typescript",
    ".tsx": "typescript",
    ".py": "python",
    ".rb": "ruby",
    ".php": "php",
    ".cs": "csharp",
    ".cpp": "cpp",
    ".cc": "cpp",
    ".cxx": "cpp",
    ".c": "c"
  };
  return languages[ext];
}

function objectValue(value: unknown, context: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`SCIP ${context} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function arrayField(record: Record<string, unknown>, camel: string, snake = camel): unknown[] | undefined {
  const value = field(record, camel, snake);
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new Error(`SCIP ${camel} must be an array.`);
  }
  return value;
}

function stringField(record: Record<string, unknown>, camel: string, snake = camel): string | undefined {
  const value = field(record, camel, snake);
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function documentPathField(record: Record<string, unknown>): string | undefined {
  const value = field(record, "relativePath", "relative_path");
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberField(record: Record<string, unknown>, camel: string, snake = camel): number | undefined {
  const value = field(record, camel, snake);
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= MAX_SCIP_INT32 ? value : undefined;
}

function truthyField(record: Record<string, unknown>, camel: string, snake = camel): boolean {
  return field(record, camel, snake) === true;
}

function field(record: Record<string, unknown>, camel: string, snake = camel): unknown {
  return record[camel] ?? record[snake];
}

function isLocalScipSymbol(symbol: string): boolean {
  return symbol.trim().startsWith("local ");
}

function rangeWithin(candidate: ScipRange, container: ScipRange): boolean {
  return comparePosition(candidate.startLine, candidate.startCharacter, container.startLine, container.startCharacter) >= 0 && comparePosition(candidate.endLine, candidate.endCharacter, container.endLine, container.endCharacter) <= 0;
}

function compareRangeSpecificity(a: ScipRange, b: ScipRange): number {
  return (
    lineSpan(a) - lineSpan(b) ||
    comparePosition(b.startLine, b.startCharacter, a.startLine, a.startCharacter) ||
    comparePosition(a.endLine, a.endCharacter, b.endLine, b.endCharacter) ||
    characterSpan(a) - characterSpan(b)
  );
}

function lineSpan(range: ScipRange): number {
  return range.endLine - range.startLine;
}

function characterSpan(range: ScipRange): number {
  return range.endLine === range.startLine ? Math.max(0, range.endCharacter - range.startCharacter) : 0;
}

function comparePosition(lineA: number, characterA: number, lineB: number, characterB: number): number {
  return lineA - lineB || characterA - characterB;
}

function sortSymbols(a: CodexaSymbolReportSymbolV1, b: CodexaSymbolReportSymbolV1): number {
  return a.path.localeCompare(b.path) || (a.line ?? 0) - (b.line ?? 0) || a.name.localeCompare(b.name) || (a.id ?? "").localeCompare(b.id ?? "");
}

function sortRelationships(a: CodexaSymbolReportRelationshipV1, b: CodexaSymbolReportRelationshipV1): number {
  return (
    a.kind.localeCompare(b.kind) ||
    (a.fromPath ?? "").localeCompare(b.fromPath ?? "") ||
    (a.toPath ?? "").localeCompare(b.toPath ?? "") ||
    (a.fromSymbol ?? "").localeCompare(b.fromSymbol ?? "") ||
    (a.toSymbol ?? "").localeCompare(b.toSymbol ?? "") ||
    (a.line ?? 0) - (b.line ?? 0) ||
    (a.reason ?? "").localeCompare(b.reason ?? "")
  );
}
