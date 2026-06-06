import type Parser from "tree-sitter";
import type {
  ImportEdgeFact,
  LanguageId,
  ParserErrorFact,
  RiskSignalFact,
  SymbolFact,
  TestEdgeFact,
  UsageSiteFact
} from "../types.js";

export type SyntaxNode = Parser.SyntaxNode;
export type TreeSitterLanguage = Parameters<Parser["setLanguage"]>[0];

export interface ParseFileInput {
  repoRoot: string;
  relativePath: string;
  absolutePath: string;
  dirty: boolean;
  sizeBytes: number;
  sourceText?: string;
  snapshotId: string;
  indexedAt: string;
}

export interface ExtractContext {
  path: string;
  language: LanguageId;
  sourceText: string;
  snapshotId: string;
  indexedAt: string;
  test: boolean;
  symbols: SymbolFact[];
  usageSites: UsageSiteFact[];
  imports: ImportEdgeFact[];
  testEdges: TestEdgeFact[];
  risks: RiskSignalFact[];
  parserErrors: ParserErrorFact[];
}
