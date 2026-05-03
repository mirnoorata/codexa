import { freshnessBanner, ambiguityResult } from "./runtime.js";
import { ensureQuerySession, type QuerySessionInput } from "./session.js";
import { resolveFileTarget, resolveSymbolTarget } from "./targets.js";
import { lspAssistForFiles, lspAssistForSymbol, lspOptionsFromQueryOptions, type LspAssistResult } from "../lsp/assist.js";
import type { QueryOptions, QueryResult } from "../types.js";
import { limitText } from "../util.js";

export async function symbolContextQuery(input: QuerySessionInput, symbolIdOrName: string, options: QueryOptions = {}): Promise<QueryResult> {
  const session = await ensureQuerySession(input, options);
  const { index, freshness, refresh, repoRoot } = session;
  const resolved = resolveSymbolTarget(index, symbolIdOrName);
  if (resolved.ambiguous.length > 0) {
    return ambiguityResult(freshness, refresh, "symbol", symbolIdOrName, resolved.ambiguous);
  }
  const symbol = resolved.symbol;
  if (!symbol) {
    return {
      freshness,
      refresh,
      text: `${freshnessBanner(freshness, refresh)}\nNo symbol found for ${symbolIdOrName}`,
      data: { symbol: null }
    };
  }
  const usages = index.usageSites.filter((usage) => usage.targetSymbolId === symbol.id || usage.name === symbol.name).slice(0, 30);
  const file = index.files.find((candidate) => candidate.path === symbol.path);
  const lspAssist = options.lsp || process.env.CODEXA_LSP === "1" ? await lspAssistForSymbol(repoRoot, index, symbol, lspOptionsFromQueryOptions(options)) : undefined;
  const text = [
    freshnessBanner(freshness, refresh),
    `Symbol: ${symbol.qualifiedName} (${symbol.kind}, ${symbol.language})`,
    `Location: ${symbol.path}:${symbol.range?.startLine ?? 1}`,
    `File rank: ${file?.rank.toFixed(2) ?? "unknown"}`,
    `Confidence: ${symbol.confidence} via ${symbol.source}`,
    "",
    "Usage sites:",
    ...usages.map((usage) => `- ${usage.path}:${usage.range?.startLine ?? 1} ${usage.kind} ${usage.confidence} ${usage.text}`),
    ...formatLspAssist(lspAssist)
  ].join("\n");
  return { freshness, refresh, text: limitText(text), data: { symbol, file, usages, lspAssist } };
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
