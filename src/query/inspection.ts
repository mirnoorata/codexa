import { freshnessBanner, ambiguityResult } from "./runtime.js";
import { ensureQuerySession, type QuerySessionInput } from "./session.js";
import { edgeEvidenceForGraphEdges } from "./edge-evidence.js";
import { nextTool } from "./next-tools.js";
import { resolveFileTarget } from "./targets.js";
import { graphEdgeSort } from "./graph.js";
import { recommendTests } from "./tests.js";
import { lspAssistForFiles, lspAssistForSymbol, lspOptionsFromQueryOptions, type LspAssistResult } from "../lsp/assist.js";
import type { GraphEdgeFact, LanguageId, QueryOptions, QueryResult, SymbolFact } from "../types.js";
import { limitText, uniqueSorted } from "../util.js";

export interface SymbolContextQueryOptions {
  depth?: number;
  includeEvidence?: boolean;
  language?: LanguageId | string;
}

export async function symbolContextQuery(input: QuerySessionInput, symbolIdOrName: string, options: QueryOptions = {}, symbolOptions: SymbolContextQueryOptions = {}): Promise<QueryResult> {
  const session = await ensureQuerySession(input, options);
  const { index, freshness, refresh, repoRoot } = session;
  const depth = Math.max(1, Math.min(symbolOptions.depth ?? 1, 3));
  const includeEvidence = symbolOptions.includeEvidence ?? true;
  const resolved = resolveSymbolForContext(index.symbols, symbolIdOrName, symbolOptions.language);
  if (resolved.ambiguous.length > 0) {
    const nextTools = [nextTool("symbol_context", "symbol name is ambiguous; rerun with an exact stable symbol id", { symbol: resolved.ambiguous[0]?.id, depth, includeEvidence })];
    return {
      freshness,
      refresh,
      text: [
        freshnessBanner(freshness, refresh),
        `Ambiguous symbol target "${symbolIdOrName}". Use an exact symbol id or qualified name.`,
        ...resolved.ambiguous.slice(0, 20).map((candidate) => `- ${candidate.id} ${candidate.qualifiedName} (${candidate.kind}, ${candidate.language}) at ${candidate.path}:${candidate.range?.startLine ?? 1}`)
      ].join("\n"),
      data: {
        mode: "symbol_context",
        symbol: null,
        ambiguous: true,
        candidates: resolved.ambiguous.slice(0, 20).map(compactSymbolCandidate),
        nextTools,
        systemMessage: nextTools[0]?.reason
      }
    };
  }
  const symbol = resolved.symbol;
  if (!symbol) {
    const nextTools = [nextTool("search", "no exact symbol matched; search lexical and semantic context for the target", { query: symbolIdOrName })];
    return {
      freshness,
      refresh,
      text: `${freshnessBanner(freshness, refresh)}\nNo symbol found for ${symbolIdOrName}`,
      data: { mode: "symbol_context", symbol: null, nextTools, systemMessage: nextTools[0]?.reason }
    };
  }
  const directEdges = directSymbolEdges(index.graphEdges, symbol);
  const neighborhoodEdges = symbolNeighborhoodEdges(index.graphEdges, symbol, depth);
  const callers = directEdges.incoming.filter((edge) => ["CALLS", "REFERENCES", "IMPORTS", "IMPLEMENTS", "EXTENDS", "TESTS", "TEST_COVERS_WORKFLOW"].includes(edge.edgeKind)).slice(0, 30);
  const callees = directEdges.outgoing.filter((edge) => ["CALLS", "REFERENCES", "IMPORTS", "IMPLEMENTS", "EXTENDS", "EXPORTS", "TYPE_EXPORTS"].includes(edge.edgeKind)).slice(0, 30);
  const importers = index.imports.filter((imp) => imp.resolvedPath === symbol.path).slice(0, 30);
  const references = index.usageSites.filter((usage) => usage.targetSymbolId === symbol.id).slice(0, 30);
  const implementations = directEdges.incoming.filter((edge) => edge.edgeKind === "IMPLEMENTS" || edge.edgeKind === "EXTENDS").slice(0, 30);
  const tests = recommendTests(index, [symbol.path], repoRoot).slice(0, 12);
  const risks = index.risks.filter((risk) => risk.path === symbol.path).slice(0, 20);
  const containingSymbol = symbol.parentSymbolId ? index.symbols.find((candidate) => candidate.id === symbol.parentSymbolId) : undefined;
  const file = index.files.find((candidate) => candidate.path === symbol.path);
  const lspAssist = options.lsp || process.env.CODEXA_LSP === "1" ? await lspAssistForSymbol(repoRoot, index, symbol, lspOptionsFromQueryOptions(options)) : undefined;
  const impactedFiles = uniqueSorted(neighborhoodEdges.flatMap((edge) => [edge.fromPath, edge.toPath].filter((value): value is string => Boolean(value))));
  const nextTools = [
    nextTool("impact", "inspect blast radius and verification for this symbol", { symbol: symbol.id, depth }),
    callers.length > 0 ? nextTool("callers", "inspect direct callers/importers with edge evidence", { symbol: symbol.id }) : undefined,
    callees.length > 0 ? nextTool("callees", "inspect direct dependencies with edge evidence", { symbol: symbol.id }) : undefined,
    tests.length > 0 ? nextTool("test_plan", "choose targeted verification for this symbol neighborhood", { files: [symbol.path] }) : undefined
  ].filter((tool): tool is ReturnType<typeof nextTool> => Boolean(tool));
  const text = [
    freshnessBanner(freshness, refresh),
    `Symbol: ${symbol.qualifiedName} (${symbol.kind}, ${symbol.language})`,
    `Location: ${symbol.path}:${symbol.range?.startLine ?? 1}`,
    containingSymbol ? `Containing symbol: ${containingSymbol.qualifiedName}` : undefined,
    `File rank: ${file?.rank.toFixed(2) ?? "unknown"}`,
    `Confidence: ${symbol.confidence} via ${symbol.source}`,
    `Neighborhood: depth ${depth}; callers ${callers.length}; callees ${callees.length}; references ${references.length}; tests ${tests.length}; impacted files ${impactedFiles.length}`,
    "",
    "Direct callers:",
    ...(callers.length > 0 ? callers.map(formatSymbolEdge) : ["- none"]),
    "",
    "Direct callees:",
    ...(callees.length > 0 ? callees.map(formatSymbolEdge) : ["- none"]),
    "",
    "Importers:",
    ...(importers.length > 0 ? importers.map((imp) => `- ${imp.path}: ${imp.importedName ?? "*"} from ${imp.specifier} (${imp.confidence})`) : ["- none"]),
    "",
    "References:",
    ...(references.length > 0 ? references.map((usage) => `- ${usage.path}:${usage.range?.startLine ?? 1} ${usage.kind} ${usage.confidence} ${usage.text}`) : ["- none"]),
    "",
    "Implementations/extends:",
    ...(implementations.length > 0 ? implementations.map(formatSymbolEdge) : ["- none"]),
    "",
    "Covering tests:",
    ...(tests.length > 0 ? tests.map((test) => `- ${test.path}: ${test.evidenceTier}; ${test.reason}`) : ["- none proven"]),
    "",
    "Related risks:",
    ...(risks.length > 0 ? risks.map((risk) => `- ${risk.signal}: ${risk.reason} (${risk.confidence})`) : ["- none"]),
    "",
    "Recommended next tools:",
    ...nextTools.map((tool) => `- ${tool.tool}: ${tool.reason}`),
    ...formatLspAssist(lspAssist)
  ].filter((line): line is string => line !== undefined).join("\n");
  return {
    freshness,
    refresh,
    text: limitText(text, 7000),
    data: {
      mode: "symbol_context",
      symbol,
      file,
      containingSymbol,
      callers,
      callees,
      importers,
      references,
      implementations,
      tests,
      risks,
      impactRadius: {
        depth,
        fileCount: impactedFiles.length,
        files: impactedFiles.slice(0, 60),
        edgeCount: neighborhoodEdges.length
      },
      edgeEvidence: includeEvidence ? edgeEvidenceForGraphEdges(neighborhoodEdges, freshness, 80) : [],
      nextTools,
      systemMessage: nextTools[0]?.reason,
      lspAssist
    }
  };
}

function resolveSymbolForContext(symbols: SymbolFact[], query: string, language?: string): { symbol?: SymbolFact; ambiguous: SymbolFact[] } {
  const filterLanguage = language?.trim();
  const candidates = filterLanguage ? symbols.filter((symbol) => symbol.language === filterLanguage) : symbols;
  const byId = candidates.find((symbol) => symbol.id === query);
  if (byId) {
    return { symbol: byId, ambiguous: [] };
  }
  const byQualified = candidates.filter((symbol) => symbol.qualifiedName === query);
  if (byQualified.length === 1) {
    return { symbol: byQualified[0], ambiguous: [] };
  }
  if (byQualified.length > 1) {
    return { ambiguous: byQualified };
  }
  const byName = candidates.filter((symbol) => symbol.name === query);
  if (byName.length === 1) {
    return { symbol: byName[0], ambiguous: [] };
  }
  return { ambiguous: byName };
}

function directSymbolEdges(edges: GraphEdgeFact[], symbol: SymbolFact): { incoming: GraphEdgeFact[]; outgoing: GraphEdgeFact[] } {
  const incoming = edges
    .filter((edge) => edge.toSymbolId === symbol.id || edge.toId === symbol.id)
    .sort(graphEdgeSort);
  const outgoing = edges
    .filter((edge) => edge.fromSymbolId === symbol.id || edge.fromId === symbol.id)
    .sort(graphEdgeSort);
  return { incoming, outgoing };
}

function symbolNeighborhoodEdges(edges: GraphEdgeFact[], symbol: SymbolFact, depth: number): GraphEdgeFact[] {
  const result: GraphEdgeFact[] = [];
  const seenEdges = new Set<string>();
  const seenNodes = new Set<string>([symbol.id]);
  let frontier = new Set<string>([symbol.id]);
  for (let currentDepth = 0; currentDepth < depth; currentDepth += 1) {
    const nextFrontier = new Set<string>();
    for (const edge of edges) {
      if (!frontier.has(edge.fromId) && !frontier.has(edge.toId) && (!edge.fromSymbolId || !frontier.has(edge.fromSymbolId)) && (!edge.toSymbolId || !frontier.has(edge.toSymbolId))) {
        continue;
      }
      if (!seenEdges.has(edge.id)) {
        seenEdges.add(edge.id);
        result.push(edge);
      }
      for (const node of [edge.fromId, edge.toId, edge.fromSymbolId, edge.toSymbolId]) {
        if (node && !seenNodes.has(node)) {
          seenNodes.add(node);
          nextFrontier.add(node);
        }
      }
    }
    frontier = nextFrontier;
    if (frontier.size === 0) {
      break;
    }
  }
  return result.sort(graphEdgeSort).slice(0, 120);
}

function formatSymbolEdge(edge: GraphEdgeFact): string {
  return `- ${edge.edgeKind}: ${edge.fromPath ?? edge.fromId} -> ${edge.toPath ?? edge.toId}; ${edge.confidence}; ${edge.reason}`;
}

function compactSymbolCandidate(symbol: SymbolFact): Pick<SymbolFact, "id" | "name" | "qualifiedName" | "kind" | "path" | "language" | "range" | "confidence" | "source"> {
  return {
    id: symbol.id,
    name: symbol.name,
    qualifiedName: symbol.qualifiedName,
    kind: symbol.kind,
    path: symbol.path,
    language: symbol.language,
    range: symbol.range,
    confidence: symbol.confidence,
    source: symbol.source
  };
}

export async function fileContextQuery(input: QuerySessionInput, filePath: string, options: QueryOptions = {}): Promise<QueryResult> {
  const session = await ensureQuerySession(input, options);
  const { index, freshness, refresh, repoRoot } = session;
  const resolved = resolveFileTarget(index, filePath, repoRoot);
  if (resolved.ambiguous.length > 0) {
    return ambiguityResult(freshness, refresh, "file", filePath, resolved.ambiguous);
  }
  const file = resolved.file;
  if (!file) {
    return {
      freshness,
      refresh,
      text: `${freshnessBanner(freshness, refresh)}\nNo file found for ${filePath}`,
      data: { file: null }
    };
  }
  const symbols = index.symbols.filter((symbol) => symbol.path === file.path).slice(0, 40);
  const imports = index.imports.filter((imp) => imp.path === file.path).slice(0, 30);
  const usages = index.usageSites.filter((usage) => usage.path === file.path).slice(0, 30);
  const risks = index.risks.filter((risk) => risk.path === file.path).slice(0, 20);
  const parserErrors = index.parserErrors.filter((error) => error.path === file.path).slice(0, 12);
  const importedBy = index.imports.filter((imp) => imp.resolvedPath === file.path).slice(0, 30);
  const testedBy = index.testEdges.filter((edge) => edge.targetPath === file.path).slice(0, 20);
  const definedSymbolIds = new Set(symbols.map((symbol) => symbol.id));
  const externalUsages = index.usageSites
    .filter((usage) => usage.targetSymbolId && definedSymbolIds.has(usage.targetSymbolId) && usage.path !== file.path)
    .slice(0, 30);
  const lspAssist = options.lsp || process.env.CODEXA_LSP === "1" ? (await lspAssistForFiles(repoRoot, [file], lspOptionsFromQueryOptions(options)))[0] : undefined;
  const text = [
    freshnessBanner(freshness, refresh),
    `File: ${file.path} (${file.language})`,
    `Rank: ${file.rank.toFixed(2)}; risk: ${file.riskScore.toFixed(1)}; dirty: ${file.dirty ? "yes" : "no"}`,
    "",
    "Parser errors:",
    ...(parserErrors.length > 0
      ? parserErrors.map((error) => `- ${error.message} at ${error.path}:${error.range?.startLine ?? 1}`)
      : ["- none"]),
    "",
    "Symbols:",
    ...symbols.map((symbol) => `- ${symbol.qualifiedName} (${symbol.kind}, ${symbol.confidence}) at ${symbol.range?.startLine ?? 1}`),
    "",
    "Imports:",
    ...imports.map((imp) => {
      const imported = imp.importedName ?? "*";
      const local = imp.localName && imp.localName !== imported ? ` as ${imp.localName}` : "";
      return `- ${imported}${local} from ${imp.specifier}${imp.resolvedPath ? ` -> ${imp.resolvedPath}` : ""}`;
    }),
    "",
    "Imported by:",
    ...(importedBy.length > 0
      ? importedBy.map((imp) => `- ${imp.path}: ${imp.importedName ?? "*"}${imp.localName && imp.localName !== imp.importedName ? ` as ${imp.localName}` : ""}`)
      : ["- none"]),
    "",
    "External usage sites:",
    ...(externalUsages.length > 0
      ? externalUsages.map((usage) => `- ${usage.path}:${usage.range?.startLine ?? 1} ${usage.kind} ${usage.name} (${usage.confidence})`)
      : ["- none"]),
    "",
    "Covered by tests:",
    ...(testedBy.length > 0 ? testedBy.map((edge) => `- ${edge.path}: ${edge.reason} (${edge.confidence})`) : ["- none"]),
    "",
    "Usage samples:",
    ...usages.map((usage) => `- ${usage.name} (${usage.kind}, ${usage.confidence}) at ${usage.range?.startLine ?? 1}`),
    "",
    "Risk signals:",
    ...risks.map((risk) => `- ${risk.signal}: ${risk.reason} (${risk.confidence})`),
    ...formatLspAssist(lspAssist)
  ].join("\n");
  return { freshness, refresh, text: limitText(text, 6500), data: { file, symbols, imports, importedBy, usages, externalUsages, testedBy, risks, parserErrors, lspAssist } };
}

function formatLspAssist(assist: LspAssistResult | undefined): string[] {
  if (!assist) {
    return [];
  }
  return [
    "",
    `LSP assist: ${assist.status}${assist.server ? ` via ${assist.server}` : ""}`,
    ...assist.warnings.map((warning) => `- warning: ${warning}`),
    assist.documentSymbols.length > 0 ? "LSP document symbols:" : undefined,
    ...assist.documentSymbols.slice(0, 12).map((symbol) => `- ${symbol.name}${symbol.line ? `:${symbol.line}` : ""}`),
    assist.definitions.length > 0 ? "LSP definitions:" : undefined,
    ...assist.definitions.slice(0, 12).map((loc) => `- ${loc.path ?? loc.uri}${loc.line ? `:${loc.line}` : ""}`),
    assist.references.length > 0 ? "LSP references:" : undefined,
    ...assist.references.slice(0, 12).map((loc) => `- ${loc.path ?? loc.uri}${loc.line ? `:${loc.line}` : ""}`),
    assist.diagnostics.length > 0 ? "LSP diagnostics:" : undefined,
    ...assist.diagnostics.slice(0, 12).map((diagnostic) => `- ${diagnostic.line ?? 1}: ${diagnostic.message}`)
  ].filter((line): line is string => typeof line === "string");
}
