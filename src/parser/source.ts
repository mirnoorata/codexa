import { promises as fs } from "node:fs";
import Parser from "tree-sitter";
import Python from "tree-sitter-python";
import TypeScriptGrammars from "tree-sitter-typescript";
import { isGeneratedPath, isTestPath, languageForPath } from "../language.js";
import type { Confidence, FactSource, LanguageId, ParseResult } from "../types.js";
import { stableId } from "../util.js";
import type { ExtractContext, ParseFileInput, TreeSitterLanguage } from "./context.js";
import { addTypeScriptCompilerAssist, extractEcma } from "./ecma.js";
import { baseFact, syntaxErrorFacts } from "./facts.js";
import { parseJsonManifest } from "./json.js";
import { parseMarkdownDocument } from "./markdown.js";
import { extractPython } from "./python.js";
import { extractDottedStringReferences, extractEndpointStringReferences } from "./references.js";
import { addCommonRisks, addPatternRisks, addPlaceholderRisks } from "./risks.js";

export type { ParseFileInput } from "./context.js";

const tsGrammar = TypeScriptGrammars as unknown as { typescript: TreeSitterLanguage; tsx: TreeSitterLanguage };

export async function parseFile(input: ParseFileInput): Promise<ParseResult> {
  const language = languageForPath(input.relativePath);
  const generated = isGeneratedPath(input.relativePath);
  const test = isTestPath(input.relativePath);
  const baseFile = {
    id: stableId("file", input.relativePath),
    type: "File" as const,
    path: input.relativePath,
    source: "git" as FactSource,
    confidence: "authoritative" as Confidence,
    snapshotId: input.snapshotId,
    indexedAt: input.indexedAt,
    language,
    sizeBytes: input.sizeBytes,
    dirty: input.dirty,
    generated,
    test
  };

  const empty: ParseResult = {
    file: baseFile,
    symbols: [],
    usageSites: [],
    imports: [],
    testEdges: [],
    risks: [],
    parserErrors: []
  };

  const sourceText = input.sourceText ?? (await fs.readFile(input.absolutePath, "utf8"));

  if (language === "json") {
    return parseJsonManifest(input, sourceText, empty);
  }
  if (language === "markdown") {
    return parseMarkdownDocument(input, sourceText, empty);
  }

  try {
    const ctx = createExtractContext(input, language, sourceText, test);
    if (!["typescript", "javascript", "python"].includes(language)) {
      addCommonRisks(ctx);
      addPatternRisks(ctx);
      addPlaceholderRisks(ctx);
      return { ...empty, ...ctx, file: baseFile };
    }

    const parser = new Parser();
    parser.setLanguage(languageForParser(language, input.relativePath));
    const tree = parser.parse((index) => (index < sourceText.length ? sourceText.slice(index, index + 4096) : null));

    if (language === "python") {
      extractPython(tree.rootNode, ctx);
    } else {
      extractEcma(tree.rootNode, ctx);
      addTypeScriptCompilerAssist(ctx);
    }

    extractDottedStringReferences(ctx);
    extractEndpointStringReferences(ctx);

    if (tree.rootNode.hasError) {
      ctx.parserErrors.push(...syntaxErrorFacts(ctx, tree.rootNode));
    }

    addCommonRisks(ctx);
    addPatternRisks(ctx);
    addPlaceholderRisks(ctx);
    return { ...empty, ...ctx, file: baseFile };
  } catch (error) {
    return {
      ...empty,
      parserErrors: [
        {
          ...baseFact("ParserError", input.relativePath, input.snapshotId, input.indexedAt, "tree-sitter", "heuristic"),
          id: stableId("parser-error", input.relativePath, String(error)),
          type: "ParserError",
          path: input.relativePath,
          message: error instanceof Error ? error.message : String(error)
        }
      ]
    };
  }
}

function createExtractContext(input: ParseFileInput, language: LanguageId, sourceText: string, test: boolean): ExtractContext {
  return {
    path: input.relativePath,
    language,
    sourceText,
    snapshotId: input.snapshotId,
    indexedAt: input.indexedAt,
    test,
    symbols: [],
    usageSites: [],
    imports: [],
    testEdges: [],
    risks: [],
    parserErrors: []
  };
}

function languageForParser(language: LanguageId, filePath: string): TreeSitterLanguage {
  if (language === "python") {
    return Python as unknown as TreeSitterLanguage;
  }
  if (filePath.endsWith(".tsx") || filePath.endsWith(".jsx")) {
    return tsGrammar.tsx;
  }
  return tsGrammar.typescript;
}
