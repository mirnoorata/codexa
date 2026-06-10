import type { BaseFact, Confidence, FactSource, ImportEdgeFact, ParserErrorFact, Range, RiskSignalFact, SymbolFact, UsageSiteFact } from "../types.js";
import { stableId } from "../util.js";
import type { ExtractContext, SyntaxNode } from "./context.js";

export function symbolFact(
  ctx: ExtractContext,
  node: SyntaxNode,
  name: string,
  qualifiedName: string,
  kind: SymbolFact["kind"],
  decorators: string[],
  parentSymbolId?: string,
  exported = false
): SymbolFact {
  return {
    ...baseFact("Symbol", ctx.path, ctx.snapshotId, ctx.indexedAt, "tree-sitter", "authoritative", rangeOf(node)),
    id: stableId("symbol", ctx.path, qualifiedName, kind, node.startIndex),
    type: "Symbol",
    path: ctx.path,
    name,
    qualifiedName,
    kind,
    language: ctx.language,
    exported,
    decorators,
    parentSymbolId
  };
}

export function usageFact(
  ctx: ExtractContext,
  node: SyntaxNode,
  name: string,
  kind: UsageSiteFact["kind"],
  text: string,
  usedBySymbolId?: string,
  confidence: Confidence = "derived"
): UsageSiteFact {
  return {
    ...baseFact("UsageSite", ctx.path, ctx.snapshotId, ctx.indexedAt, "tree-sitter", confidence, rangeOf(node)),
    id: stableId("usage", ctx.path, name, kind, node.startIndex),
    type: "UsageSite",
    path: ctx.path,
    name,
    kind,
    usedBySymbolId,
    text: text.replace(/\s+/g, " ").slice(0, 240)
  };
}

export function importFact(ctx: ExtractContext, node: SyntaxNode, specifier: string, importedName?: string, localName?: string, reExport = false, typeOnly = false): ImportEdgeFact {
  return {
    ...baseFact("ImportEdge", ctx.path, ctx.snapshotId, ctx.indexedAt, "tree-sitter", "authoritative", rangeOf(node)),
    id: stableId("import", ctx.path, specifier, importedName, localName, node.startIndex),
    type: "ImportEdge",
    path: ctx.path,
    specifier,
    importedName,
    localName,
    reExport,
    typeOnly
  };
}

export function riskFact(ctx: ExtractContext, node: SyntaxNode | undefined, signal: string, score: number, reason: string): RiskSignalFact {
  return {
    ...baseFact("RiskSignal", ctx.path, ctx.snapshotId, ctx.indexedAt, "heuristic", "heuristic", node ? rangeOf(node) : undefined),
    id: stableId("risk", ctx.path, signal, reason, node?.startIndex ?? 0),
    type: "RiskSignal",
    path: ctx.path,
    signal,
    score,
    reason
  };
}

export function patternRiskFact(ctx: ExtractContext, signal: string, score: number, reason: string, start: number, end: number): RiskSignalFact {
  return {
    ...baseFact("RiskSignal", ctx.path, ctx.snapshotId, ctx.indexedAt, "heuristic", "heuristic", rangeFromOffsets(ctx.sourceText, start, end)),
    id: stableId("risk", ctx.path, signal, start),
    type: "RiskSignal",
    path: ctx.path,
    signal,
    score,
    reason
  };
}

export function syntaxErrorFacts(ctx: ExtractContext, root: SyntaxNode): ParserErrorFact[] {
  const errors: SyntaxNode[] = [];
  const stack = [root];
  while (stack.length > 0 && errors.length < 8) {
    const node = stack.pop()!;
    if (node.type === "ERROR") {
      errors.push(node);
    }
    for (let i = node.childCount - 1; i >= 0; i -= 1) {
      const child = node.child(i);
      if (child?.hasError || child?.type === "ERROR") {
        stack.push(child);
      }
    }
  }
  if (errors.length === 0) {
    return [parserError(ctx, root, "Tree-sitter reported syntax errors")];
  }
  return errors.map((node, index) => parserError(ctx, node, `Tree-sitter syntax error ${index + 1}${snippetNear(ctx.sourceText, node.startIndex)}`));
}

export function parserError(ctx: ExtractContext, node: SyntaxNode, message: string): ParserErrorFact {
  return {
    ...baseFact("ParserError", ctx.path, ctx.snapshotId, ctx.indexedAt, "tree-sitter", "heuristic", rangeOf(node)),
    id: stableId("parser-error", ctx.path, message, node.startIndex),
    type: "ParserError",
    path: ctx.path,
    message
  };
}

export function baseFact(
  type: BaseFact["type"],
  path: string,
  snapshotId: string,
  indexedAt: string,
  source: FactSource,
  confidence: Confidence,
  range?: Range
): BaseFact {
  return {
    id: stableId(type, path, range?.startByte ?? 0),
    type,
    path,
    range,
    source,
    confidence,
    snapshotId,
    indexedAt
  };
}

export function rangeOf(node: SyntaxNode): Range {
  return {
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    startByte: node.startIndex,
    endByte: node.endIndex
  };
}

export function rangeFromOffsets(sourceText: string, startByte: number, endByte: number): Range {
  const startLine = lineForOffset(sourceText, startByte);
  return {
    startLine,
    endLine: lineForOffset(sourceText, endByte),
    startByte,
    endByte
  };
}

function lineForOffset(sourceText: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < sourceText.length; i += 1) {
    if (sourceText.charCodeAt(i) === 10) {
      line += 1;
    }
  }
  return line;
}

function snippetNear(sourceText: string, offset: number): string {
  const lineStart = sourceText.lastIndexOf("\n", Math.max(0, offset - 1)) + 1;
  const lineEnd = sourceText.indexOf("\n", offset);
  const raw = sourceText.slice(lineStart, lineEnd === -1 ? undefined : lineEnd).trim().replace(/\s+/g, " ");
  return raw ? ` near "${raw.slice(0, 120)}"` : "";
}
