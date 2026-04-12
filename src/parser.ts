import { promises as fs } from "node:fs";
import path from "node:path";
import Parser from "tree-sitter";
import Python from "tree-sitter-python";
import TypeScriptGrammars from "tree-sitter-typescript";
import ts from "typescript";
import { isGeneratedPath, isPublicSurfacePath, isTestPath, languageForPath } from "./language.js";
import { CODE_PATTERN_RULES } from "./rules.js";
import type {
  BaseFact,
  Confidence,
  FactSource,
  ImportEdgeFact,
  LanguageId,
  ParseResult,
  ParserErrorFact,
  Range,
  RiskSignalFact,
  SymbolFact,
  TestEdgeFact,
  UsageSiteFact
} from "./types.js";
import { stableId } from "./util.js";

type SyntaxNode = Parser.SyntaxNode;
type TreeSitterLanguage = Parameters<Parser["setLanguage"]>[0];

const tsGrammar = TypeScriptGrammars as unknown as { typescript: TreeSitterLanguage; tsx: TreeSitterLanguage };
const PYTHON_DEFINITION_TYPES = new Set(["class_definition", "function_definition", "async_function_definition"]);

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

  try {
    if (!["typescript", "javascript", "python"].includes(language)) {
      const ctx: ExtractContext = {
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
      addCommonRisks(ctx);
      addPatternRisks(ctx);
      return { ...empty, ...ctx, file: baseFile };
    }

    const parser = new Parser();
    parser.setLanguage(languageForParser(language, input.relativePath));
    const tree = parser.parse((index) => (index < sourceText.length ? sourceText.slice(index, index + 4096) : null));
    const ctx: ExtractContext = {
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

    if (language === "python") {
      extractPython(tree.rootNode, ctx);
    } else {
      extractEcma(tree.rootNode, ctx);
      addTypeScriptCompilerAssist(ctx);
    }

    extractAtlasStringReferences(ctx);
    extractEndpointStringReferences(ctx);

    if (tree.rootNode.hasError) {
      ctx.parserErrors.push(...syntaxErrorFacts(ctx, tree.rootNode));
    }

    addCommonRisks(ctx);
    addPatternRisks(ctx);
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

interface ExtractContext {
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

function languageForParser(language: LanguageId, filePath: string): TreeSitterLanguage {
  if (language === "python") {
    return Python as unknown as TreeSitterLanguage;
  }
  if (filePath.endsWith(".tsx") || filePath.endsWith(".jsx")) {
    return tsGrammar.tsx;
  }
  return tsGrammar.typescript;
}

function parseJsonManifest(input: ParseFileInput, sourceText: string, empty: ParseResult): ParseResult {
  const basename = path.posix.basename(input.relativePath);
  const isAtlasPackage = input.relativePath.startsWith("atlas_api/packages/") && basename.endsWith(".json");
  if (basename !== "package.json" && basename !== "tsconfig.json" && !isAtlasPackage) {
    return empty;
  }
  try {
    const parsed = JSON.parse(sourceText) as { scripts?: Record<string, string>; nodes?: Array<Record<string, unknown>>; namespace?: string; name?: string };
    const symbols: SymbolFact[] = [];
    const usageSites: UsageSiteFact[] = [];
    const risks: RiskSignalFact[] = [];
    const snapshotId = input.snapshotId;
    const indexedAt = input.indexedAt;
    if (basename === "package.json" && parsed.scripts && typeof parsed.scripts === "object") {
      for (const [name, command] of Object.entries(parsed.scripts)) {
        const id = stableId("manifest-script", input.relativePath, name);
        symbols.push({
          id,
          type: "Symbol",
          path: input.relativePath,
          source: "manifest",
          confidence: "authoritative",
          snapshotId,
          indexedAt,
          name,
          qualifiedName: `npm script ${name}`,
          kind: "variable",
          language: "json",
          exported: false,
          decorators: []
        });
        usageSites.push({
          id: stableId("manifest-usage", input.relativePath, name),
          type: "UsageSite",
          path: input.relativePath,
          source: "manifest",
          confidence: "authoritative",
          snapshotId,
          indexedAt,
          name: `npm script ${name}`,
          kind: "reference",
          text: String(command).slice(0, 240)
        });
        if (name.includes("test")) {
          risks.push({
            id: stableId("manifest-risk", input.relativePath, name),
            type: "RiskSignal",
            path: input.relativePath,
            source: "manifest",
            confidence: "authoritative",
            snapshotId,
            indexedAt,
            signal: "test-command",
            score: 0.5,
            reason: `${name}: ${command}`
          });
        }
      }
    }
    if (isAtlasPackage && Array.isArray(parsed.nodes)) {
      for (const node of parsed.nodes) {
        const typeId = typeof node.type_id === "string" ? node.type_id : "";
        if (!typeId) {
          continue;
        }
        const title = typeof node.title === "string" ? node.title : typeId;
        const adapterKey = typeof node.adapter_key === "string" ? node.adapter_key : "";
        const id = stableId("atlas-node", input.relativePath, typeId);
        symbols.push({
          id,
          type: "Symbol",
          path: input.relativePath,
          source: "manifest",
          confidence: "authoritative",
          snapshotId,
          indexedAt,
          name: typeId,
          qualifiedName: `atlas node ${typeId}`,
          kind: "node",
          language: "json",
          exported: true,
          decorators: []
        });
        usageSites.push({
          id: stableId("atlas-node-usage", input.relativePath, typeId),
          type: "UsageSite",
          path: input.relativePath,
          source: "manifest",
          confidence: "authoritative",
          snapshotId,
          indexedAt,
          name: typeId,
          kind: "reference",
          text: `${title}${adapterKey ? ` adapter ${adapterKey}` : ""}`.slice(0, 240)
        });
        if (adapterKey) {
          usageSites.push({
            id: stableId("atlas-node-adapter-usage", input.relativePath, typeId, adapterKey),
            type: "UsageSite",
            path: input.relativePath,
            source: "manifest",
            confidence: "derived",
            snapshotId,
            indexedAt,
            name: adapterKey,
            kind: "reference",
            text: `adapter_key ${adapterKey}`
          });
        }
        for (const manifestValue of atlasManifestReferenceValues(node)) {
          usageSites.push({
            id: stableId("atlas-node-field-usage", input.relativePath, typeId, manifestValue),
            type: "UsageSite",
            path: input.relativePath,
            source: "manifest",
            confidence: "heuristic",
            snapshotId,
            indexedAt,
            name: manifestValue,
            kind: "reference",
            text: manifestValue.slice(0, 240)
          });
        }
        risks.push({
          id: stableId("atlas-node-risk", input.relativePath, typeId),
          type: "RiskSignal",
          path: input.relativePath,
          source: "manifest",
          confidence: "authoritative",
          snapshotId,
          indexedAt,
          signal: "atlas-node-manifest",
          score: 1.5,
          reason: typeId
        });
      }
    }
    return { ...empty, symbols, usageSites, risks };
  } catch (error) {
    return {
      ...empty,
      parserErrors: [
        {
          id: stableId("json-parser-error", input.relativePath, String(error)),
          type: "ParserError",
          path: input.relativePath,
          source: "manifest",
          confidence: "heuristic",
          snapshotId: input.snapshotId,
          indexedAt: input.indexedAt,
          message: error instanceof Error ? error.message : String(error)
        }
      ]
    };
  }
}

function atlasManifestReferenceValues(node: Record<string, unknown>): string[] {
  const values = new Set<string>();
  const visit = (value: unknown) => {
    if (typeof value === "string") {
      if (/\b[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*){1,}\b/.test(value)) {
        values.add(value);
      }
      return;
    }
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (value && typeof value === "object") {
      for (const child of Object.values(value as Record<string, unknown>)) {
        visit(child);
      }
    }
  };
  visit(node);
  return [...values].sort();
}

function extractAtlasStringReferences(ctx: ExtractContext): void {
  const seen = new Set<string>();
  const pattern = /\b[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*){2,}\b/g;
  for (const match of ctx.sourceText.matchAll(pattern)) {
    const name = match[0];
    const start = match.index ?? 0;
    const key = `${name}:${start}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    ctx.usageSites.push({
      ...baseFact("UsageSite", ctx.path, ctx.snapshotId, ctx.indexedAt, "heuristic", "heuristic", rangeFromOffsets(ctx.sourceText, start, start + name.length)),
      id: stableId("atlas-string-reference", ctx.path, name, start),
      type: "UsageSite",
      path: ctx.path,
      name,
      kind: "reference",
      text: name
    });
  }
}

function extractPython(root: SyntaxNode, ctx: ExtractContext): void {
  const stack: Array<{
    node: SyntaxNode;
    parentSymbolId?: string;
    className?: string;
    decorators: string[];
    scope: "module" | "class" | "function";
    suppressDefinition?: boolean;
  }> = [
    { node: root, decorators: [], scope: "module" }
  ];

  while (stack.length > 0) {
    const current = stack.pop()!;
    const { node } = current;
    let parentSymbolId = current.parentSymbolId;
    let className = current.className;
    let pendingDecorators = current.decorators;
    let definition = node;
    let decoratedDefinition: SyntaxNode | undefined;
    let childScope = current.scope;

    if (node.type === "decorated_definition") {
      pendingDecorators = decoratorsForNode(node, ctx.sourceText);
      const childDefinition = node.namedChildren.find((child) =>
        PYTHON_DEFINITION_TYPES.has(child.type)
      );
      if (childDefinition) {
        definition = childDefinition;
        decoratedDefinition = childDefinition;
      }
    }

    if (PYTHON_DEFINITION_TYPES.has(definition.type) && !current.suppressDefinition) {
      const name = definition.childForFieldName("name")?.text;
      if (name) {
        const isMethod = definition.type === "function_definition" && className !== undefined;
        const kind = pythonSymbolKind(name, definition.type, pendingDecorators, ctx.test, isMethod);
        const qualifiedName = className && isMethod ? `${className}.${name}` : name;
        const symbol = symbolFact(ctx, definition, name, qualifiedName, kind, pendingDecorators, parentSymbolId);
        ctx.symbols.push(symbol);
        parentSymbolId = symbol.id;
        if (definition.type === "class_definition") {
          className = name;
          childScope = "class";
        } else {
          childScope = "function";
        }
        for (const decorator of pendingDecorators) {
          if (isRouteDecorator(decorator) || isTaskDecorator(decorator)) {
            ctx.usageSites.push(usageFact(ctx, definition, decoratorName(decorator), "decorator", decorator, symbol.id, "heuristic"));
            for (const endpoint of routeEndpointsFromDecorator(decorator)) {
              ctx.usageSites.push(usageFact(ctx, definition, endpoint, "route_handler", decorator, symbol.id, "derived"));
            }
            ctx.risks.push(riskFact(ctx, definition, isRouteDecorator(decorator) ? "route-handler" : "background-job", 2, decorator));
          }
          if (decorator.includes("fixture")) {
            ctx.risks.push(riskFact(ctx, definition, "pytest-fixture", 1, decorator));
          }
        }
      }
    }

    if (node.type === "assignment" && (current.scope === "module" || current.scope === "class")) {
      for (const name of pythonAssignmentNames(node)) {
        const qualifiedName = current.scope === "class" && className ? `${className}.${name}` : name;
        ctx.symbols.push(symbolFact(ctx, node, name, qualifiedName, "variable", [], current.scope === "class" ? parentSymbolId : undefined, current.scope === "module"));
      }
    }

    if (node.type === "import_statement" || node.type === "import_from_statement") {
      for (const imp of pythonImports(node, ctx.sourceText)) {
        ctx.imports.push(importFact(ctx, node, imp.specifier, imp.importedName, imp.localName));
        ctx.usageSites.push(usageFact(ctx, node, imp.localName ?? imp.importedName ?? imp.specifier, "import", node.text, parentSymbolId, "authoritative"));
      }
    }

    if (node.type === "call") {
      const name = callName(node);
      if (name) {
        ctx.usageSites.push(usageFact(ctx, node, name, "call", node.text, parentSymbolId, "derived"));
      }
    }

    if (ctx.test && PYTHON_DEFINITION_TYPES.has(node.type)) {
      const name = node.childForFieldName("name")?.text ?? "";
      if (name.startsWith("test") || name.startsWith("Test")) {
        ctx.testEdges.push({
          ...baseFact("TestEdge", ctx.path, ctx.snapshotId, ctx.indexedAt, "heuristic", "derived", rangeOf(node)),
          id: stableId("test-edge", ctx.path, name),
          type: "TestEdge",
          path: ctx.path,
          reason: `pytest-style test ${name}`
        });
        for (const param of pythonParameterNames(node)) {
          ctx.usageSites.push(usageFact(ctx, node, param, "test_reference", `fixture parameter ${param}`, parentSymbolId, "derived"));
        }
      }
    }

    for (let i = node.namedChildCount - 1; i >= 0; i -= 1) {
      const child = node.namedChild(i);
      if (child) {
        stack.push({
          node: child,
          parentSymbolId,
          className,
          decorators: [],
          scope: child === decoratedDefinition ? childScope : childScope,
          suppressDefinition: child === decoratedDefinition
        });
      }
    }
  }
}

function extractEcma(root: SyntaxNode, ctx: ExtractContext): void {
  const stack: Array<{ node: SyntaxNode; parentSymbolId?: string; className?: string; exported: boolean }> = [
    { node: root, exported: false }
  ];

  while (stack.length > 0) {
    const current = stack.pop()!;
    let { node, parentSymbolId, className, exported } = current;
    if (node.type === "export_statement") {
      exported = true;
    }
    let emittedSymbol = false;

    const symbolInfo = ecmaSymbolInfo(node, className, exported);
    if (symbolInfo) {
      const symbol = symbolFact(ctx, node, symbolInfo.name, symbolInfo.qualifiedName, symbolInfo.kind, [], parentSymbolId, exported);
      ctx.symbols.push(symbol);
      emittedSymbol = true;
      parentSymbolId = symbol.id;
      if (symbolInfo.kind === "class") {
        className = symbolInfo.name;
      }
      addEcmaFrameworkHints(ctx, node, symbol);
      if (ctx.test && /^test|should|it$|describe$/.test(symbolInfo.name)) {
        ctx.testEdges.push({
          ...baseFact("TestEdge", ctx.path, ctx.snapshotId, ctx.indexedAt, "heuristic", "derived", rangeOf(node)),
          id: stableId("test-edge", ctx.path, symbolInfo.name, node.startIndex),
          type: "TestEdge",
          path: ctx.path,
          reason: `test symbol ${symbolInfo.name}`
        });
      }
    }

    if (node.type === "import_statement") {
      for (const imp of ecmaImports(node)) {
        ctx.imports.push(importFact(ctx, node, imp.specifier, imp.importedName, imp.localName, false, imp.typeOnly));
        ctx.usageSites.push(usageFact(ctx, node, imp.localName ?? imp.importedName ?? imp.specifier, "import", node.text, parentSymbolId, "authoritative"));
      }
    }

    if (node.type === "export_statement") {
      for (const imp of ecmaReExports(node)) {
        ctx.imports.push(importFact(ctx, node, imp.specifier, imp.importedName, imp.localName, true));
        ctx.usageSites.push(usageFact(ctx, node, imp.localName ?? imp.importedName ?? imp.specifier, "import", node.text, parentSymbolId, "authoritative"));
      }
    }

    if (node.type === "call_expression") {
      const name = callName(node);
      const dynamicSpecifier = dynamicImportSpecifier(node);
      if (dynamicSpecifier) {
        ctx.imports.push(importFact(ctx, node, dynamicSpecifier));
      }
      if (name) {
        ctx.usageSites.push(usageFact(ctx, node, name, "call", node.text, parentSymbolId, "derived"));
      }
    }

    if (node.type === "jsx_opening_element" || node.type === "jsx_self_closing_element") {
      const name = jsxElementName(node);
      if (name && /^[A-Z]/.test(name)) {
        ctx.usageSites.push(usageFact(ctx, node, name, "reference", node.text, parentSymbolId, "derived"));
      }
    }

    for (let i = node.namedChildCount - 1; i >= 0; i -= 1) {
      const child = node.namedChild(i);
      if (child) {
        stack.push({ node: child, parentSymbolId, className, exported: emittedSymbol ? false : exported });
      }
    }
  }
}

function addTypeScriptCompilerAssist(ctx: ExtractContext): void {
  if (ctx.language !== "typescript" && ctx.language !== "javascript") {
    return;
  }
  const sourceFile = ts.createSourceFile(ctx.path, ctx.sourceText, ts.ScriptTarget.Latest, true, scriptKindForPath(ctx.path));
  const addSymbol = (node: ts.Node, name: string, qualifiedName: string, kind: SymbolFact["kind"], exported: boolean) => {
    const range = rangeFromOffsets(ctx.sourceText, node.getStart(sourceFile), node.end);
    if (
      ctx.symbols.some(
        (symbol) =>
          symbol.path === ctx.path &&
          symbol.name === name &&
          symbol.kind === kind &&
          Math.abs((symbol.range?.startByte ?? -1) - range.startByte) < 4
      )
    ) {
      return;
    }
    ctx.symbols.push({
      ...baseFact("Symbol", ctx.path, ctx.snapshotId, ctx.indexedAt, "typescript-compiler", "authoritative", range),
      id: stableId("ts-symbol", ctx.path, qualifiedName, kind, range.startByte),
      type: "Symbol",
      path: ctx.path,
      name,
      qualifiedName,
      kind,
      language: ctx.language,
      exported,
      decorators: []
    });
  };
  const addUsage = (node: ts.Node, name: string, kind: UsageSiteFact["kind"], text: string, usedBySymbolId?: string, confidence: Confidence = "derived") => {
    const range = rangeFromOffsets(ctx.sourceText, node.getStart(sourceFile), node.end);
    if (
      ctx.usageSites.some(
        (usage) =>
          usage.path === ctx.path &&
          usage.name === name &&
          usage.kind === kind &&
          Math.abs((usage.range?.startByte ?? -1) - range.startByte) < 4
      )
    ) {
      return;
    }
    ctx.usageSites.push({
      ...baseFact("UsageSite", ctx.path, ctx.snapshotId, ctx.indexedAt, "typescript-compiler", confidence, range),
      id: stableId("ts-usage", ctx.path, name, kind, range.startByte),
      type: "UsageSite",
      path: ctx.path,
      name,
      kind,
      usedBySymbolId,
      text: text.replace(/\s+/g, " ").slice(0, 240)
    });
  };
  const importedLocals = new Set(
    ctx.imports
      .filter((imp) => imp.path === ctx.path)
      .map((imp) => imp.localName ?? imp.importedName)
      .filter((name): name is string => Boolean(name) && name !== "*" && name !== "default")
  );
  const visit = (node: ts.Node) => {
    if (ts.isFunctionDeclaration(node) && hasDefaultExport(node)) {
      addSymbol(node, "default", "default export", "function", true);
    }
    if (ts.isClassDeclaration(node) && hasDefaultExport(node)) {
      addSymbol(node, "default", "default export", "class", true);
    }
    if (ts.isExportAssignment(node) && !node.isExportEquals) {
      const expression = node.expression.getText(sourceFile);
      addUsage(node.expression, expression, "reference", `default export ${expression}`, undefined, "authoritative");
      const wrapped = wrappedDefaultExportName(node.expression, sourceFile);
      if (wrapped) {
        addSymbol(node, "default", "default export", "function", true);
        addSymbol(node.expression, wrapped, wrapped, "function", true);
        if (/\.(tsx|jsx)$/.test(ctx.path) && /^[A-Z]/.test(wrapped)) {
          ctx.risks.push(riskFact(ctx, undefined, "react-component", 1, `${wrapped} follows React component naming`));
        }
      }
    }
    if ((ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node)) && node.name) {
      const usedBySymbolId = findLocalSymbolId(ctx, node.name.text);
      for (const clause of node.heritageClauses ?? []) {
        const relationship = clause.token === ts.SyntaxKind.ExtendsKeyword ? "extends" : "implements";
        for (const typeNode of clause.types) {
          const name = heritageExpressionName(typeNode.expression.getText(sourceFile));
          addUsage(typeNode.expression, name, "type_reference", `${relationship} ${name}`, usedBySymbolId, "authoritative");
        }
      }
    }
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const name = node.tagName.getText(sourceFile);
      if (/^[A-Z]/.test(name)) {
        addUsage(node.tagName, name, "reference", `jsx component ${name}`, undefined, "derived");
      }
    }
    if (ts.isIdentifier(node) && importedLocals.has(node.text) && isRuntimeReferenceIdentifier(node)) {
      addUsage(node, node.text, "reference", `identifier reference ${node.text}`, undefined, "derived");
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
}

function ecmaSymbolInfo(
  node: SyntaxNode,
  className?: string,
  exported = false
): { name: string; qualifiedName: string; kind: SymbolFact["kind"] } | null {
  if (node.type === "class_declaration") {
    const name = node.childForFieldName("name")?.text;
    return name ? { name, qualifiedName: name, kind: "class" } : null;
  }
  if (node.type === "interface_declaration") {
    const name = node.childForFieldName("name")?.text;
    return name ? { name, qualifiedName: name, kind: "interface" } : null;
  }
  if (node.type === "type_alias_declaration") {
    const name = node.childForFieldName("name")?.text;
    return name ? { name, qualifiedName: name, kind: "type" } : null;
  }
  if (node.type === "enum_declaration") {
    const name = node.childForFieldName("name")?.text;
    return name ? { name, qualifiedName: name, kind: "enum" } : null;
  }
  if (node.type === "function_declaration") {
    const name = node.childForFieldName("name")?.text;
    return name ? { name, qualifiedName: name, kind: "function" } : null;
  }
  if (node.type === "method_definition" || node.type === "method_signature") {
    const name = node.childForFieldName("name")?.text;
    return name ? { name, qualifiedName: className ? `${className}.${name}` : name, kind: "method" } : null;
  }
  if (node.type === "variable_declarator") {
    const name = node.childForFieldName("name")?.text;
    const value = node.childForFieldName("value");
    if (name && value && ["arrow_function", "function_expression"].includes(value.type)) {
      return { name, qualifiedName: name, kind: "function" };
    }
    if (name && exported) {
      return { name, qualifiedName: name, kind: "variable" };
    }
  }
  return null;
}

function pythonSymbolKind(
  name: string,
  nodeType: string,
  decorators: string[],
  test: boolean,
  isMethod: boolean
): SymbolFact["kind"] {
  if (nodeType === "class_definition") {
    return test && name.startsWith("Test") ? "test" : "class";
  }
  if (decorators.some((decorator) => decorator.includes("fixture"))) {
    return "fixture";
  }
  if (test && name.startsWith("test")) {
    return "test";
  }
  if (decorators.some((decorator) => isRouteDecorator(decorator))) {
    return "route";
  }
  return isMethod ? "method" : "function";
}

function pythonAssignmentNames(node: SyntaxNode): string[] {
  const left = node.childForFieldName("left") ?? node.namedChild(0);
  if (!left) {
    return [];
  }
  if (left.type === "identifier") {
    return [left.text];
  }
  if (left.type === "attribute") {
    const name = left.namedChildren.at(-1)?.text;
    return name ? [name] : [];
  }
  if (left.type === "pattern_list" || left.type === "tuple" || left.type === "list") {
    return left.namedChildren.filter((child) => child.type === "identifier").map((child) => child.text);
  }
  return [];
}

function pythonParameterNames(node: SyntaxNode): string[] {
  const parameters = node.childForFieldName("parameters") ?? node.namedChildren.find((child) => child.type === "parameters");
  if (!parameters) {
    return [];
  }
  const result: string[] = [];
  const stack = [parameters];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current.type === "identifier" && !["self", "cls"].includes(current.text)) {
      result.push(current.text);
      continue;
    }
    for (let i = current.namedChildCount - 1; i >= 0; i -= 1) {
      const child = current.namedChild(i);
      if (child) {
        stack.push(child);
      }
    }
  }
  return [...new Set(result)].sort();
}

function pythonImports(node: SyntaxNode, sourceText: string): Array<{ specifier: string; importedName?: string; localName?: string }> {
  const text = node.text
    .trim()
    .replace(/\\\r?\n/g, " ")
    .replace(/\r?\n/g, " ")
    .replace(/\s+/g, " ");
  if (node.type === "import_statement") {
    return text
      .replace(/^import\s+/, "")
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const [specifier, alias] = part.split(/\s+as\s+/);
        return { specifier, importedName: "*", localName: alias ?? specifier.split(".")[0] };
      });
  }
  const match = /^from\s+([.\w]+)\s+import\s+(.+)$/.exec(text);
  if (!match) {
    return [{ specifier: sourceText.slice(node.startIndex, node.endIndex), importedName: undefined }];
  }
  const [, specifier, names] = match;
  return names
    .replace(/^\(/, "")
    .replace(/\)$/, "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean)
    .map((name) => {
      const [importedName, alias] = name.split(/\s+as\s+/);
      return { specifier, importedName, localName: alias ?? importedName };
    });
}

function ecmaImports(node: SyntaxNode): Array<{ specifier: string; importedName?: string; localName?: string; typeOnly?: boolean }> {
  const text = node.text;
  const specifier = /from\s+["']([^"']+)["']/.exec(text)?.[1] ?? /^import\s+["']([^"']+)["']/.exec(text)?.[1];
  if (!specifier) {
    return [];
  }
  const statementTypeOnly = /^import\s+type\b/.test(text);
  const imports: Array<{ specifier: string; importedName?: string; localName?: string; typeOnly?: boolean }> = [];
  const namespaceName = /\*\s+as\s+([A-Za-z_$][\w$]*)/.exec(text)?.[1];
  if (namespaceName) {
    imports.push({ specifier, importedName: "*", localName: namespaceName, typeOnly: statementTypeOnly });
  }
  const named = /\{([^}]+)\}/.exec(text)?.[1];
  if (named) {
    for (const part of named.split(",")) {
      const rawPart = part.trim();
      const typeOnly = statementTypeOnly || rawPart.startsWith("type ");
      const [name, alias] = rawPart.replace(/^type\s+/, "").split(/\s+as\s+/);
      if (name) {
        imports.push({ specifier, importedName: name, localName: alias ?? name, typeOnly });
      }
    }
  }
  const defaultName = /^import\s+([A-Za-z_$][\w$]*)/.exec(text)?.[1];
  if (defaultName && defaultName !== "type") {
    imports.push({ specifier, importedName: "default", localName: defaultName });
  }
  const typeDefaultName = /^import\s+type\s+([A-Za-z_$][\w$]*)/.exec(text)?.[1];
  if (typeDefaultName) {
    imports.push({ specifier, importedName: "default", localName: typeDefaultName, typeOnly: true });
  }
  return imports.length > 0 ? imports : [{ specifier }];
}

function ecmaReExports(node: SyntaxNode): Array<{ specifier: string; importedName?: string; localName?: string }> {
  const text = node.text;
  const specifier = /from\s+["']([^"']+)["']/.exec(text)?.[1];
  if (!specifier) {
    return [];
  }
  if (/export\s+\*/.test(text)) {
    return [{ specifier, importedName: "*", localName: "*" }];
  }
  const named = /\{([^}]+)\}/.exec(text)?.[1];
  if (!named) {
    return [{ specifier }];
  }
  return named
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const [name, alias] = part.split(/\s+as\s+/);
      return { specifier, importedName: name, localName: alias ?? name };
    });
}

function decoratorsForNode(node: SyntaxNode, sourceText: string): string[] {
  const decorators: string[] = [];
  for (const child of node.namedChildren) {
    if (child.type === "decorator") {
      decorators.push(sourceText.slice(child.startIndex, child.endIndex).trim());
    }
  }
  return decorators;
}

function callName(node: SyntaxNode): string | null {
  const fn = node.childForFieldName("function") ?? node.namedChild(0);
  if (!fn) {
    return null;
  }
  const compact = compactCallableName(fn);
  if (compact) {
    return compact;
  }
  return fn.text.length <= 120 ? fn.text : truncateInline(fn.text, 120);
}

function dynamicImportSpecifier(node: SyntaxNode): string | undefined {
  const fn = node.childForFieldName("function") ?? node.namedChild(0);
  if (fn?.text !== "import") {
    return undefined;
  }
  const argument = node.namedChildren.find((child) => child !== fn && child.type === "arguments")?.namedChild(0);
  const text = argument?.text ?? "";
  return /^["'][^"']+["']$/.test(text) ? text.slice(1, -1) : undefined;
}

function compactCallableName(node: SyntaxNode): string | null {
  if (["identifier", "property_identifier"].includes(node.type)) {
    return node.text;
  }
  if (["attribute", "member_expression"].includes(node.type)) {
    const property = node.childForFieldName("property") ?? node.childForFieldName("attribute") ?? node.namedChildren.at(-1);
    const object = node.childForFieldName("object");
    const propertyName = property?.text;
    if (!propertyName) {
      return truncateInline(node.text, 120);
    }
    if (!object || ["call_expression", "subscript_expression"].includes(object.type)) {
      return truncateInline(propertyName, 120);
    }
    const objectName = compactCallableName(object);
    if (!objectName) {
      return truncateInline(propertyName, 120);
    }
    return compactDottedName(`${objectName}.${propertyName}`);
  }
  if (node.type === "subscript_expression") {
    const object = node.childForFieldName("object") ?? node.namedChild(0);
    const objectName = object ? compactCallableName(object) : undefined;
    return objectName ? `${objectName}[]` : truncateInline(node.text, 120);
  }
  return null;
}

function compactDottedName(value: string): string {
  const parts = value.split(".").filter(Boolean);
  return truncateInline(parts.slice(-3).join("."), 120);
}

function truncateInline(value: string, maxLength: number): string {
  const compact = value.replace(/\s+/g, " ").trim();
  if (compact.length <= maxLength) {
    return compact;
  }
  return `${compact.slice(0, Math.max(0, maxLength - 3))}...`;
}

function jsxElementName(node: SyntaxNode): string | null {
  const nameNode = node.childForFieldName("name") ?? node.namedChildren.find((child) => ["identifier", "nested_identifier", "member_expression"].includes(child.type));
  if (!nameNode) {
    return null;
  }
  return nameNode.text.length <= 120 ? nameNode.text : null;
}

function scriptKindForPath(filePath: string): ts.ScriptKind {
  if (/\.tsx$/i.test(filePath)) {
    return ts.ScriptKind.TSX;
  }
  if (/\.jsx$/i.test(filePath)) {
    return ts.ScriptKind.JSX;
  }
  if (/\.[cm]?js$/i.test(filePath)) {
    return ts.ScriptKind.JS;
  }
  return ts.ScriptKind.TS;
}

function hasDefaultExport(node: ts.Node): boolean {
  return ts.canHaveModifiers(node) && Boolean(ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword));
}

function wrappedDefaultExportName(node: ts.Expression, sourceFile: ts.SourceFile): string | undefined {
  if (ts.isFunctionExpression(node) && node.name) {
    return node.name.text;
  }
  if (ts.isIdentifier(node)) {
    return node.text;
  }
  if (!ts.isCallExpression(node)) {
    return undefined;
  }
  for (const arg of node.arguments) {
    const name = wrappedDefaultExportName(arg, sourceFile);
    if (name) {
      return name;
    }
  }
  const expression = node.expression.getText(sourceFile);
  return /^[A-Za-z_$][\w$]*$/.test(expression) ? expression : undefined;
}

function isRuntimeReferenceIdentifier(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (!parent) {
    return true;
  }
  if (
    ts.isImportSpecifier(parent) ||
    ts.isImportClause(parent) ||
    ts.isNamespaceImport(parent) ||
    ts.isExportSpecifier(parent) ||
    ts.isBindingElement(parent) ||
    ts.isParameter(parent) ||
    ts.isTypeReferenceNode(parent)
  ) {
    return false;
  }
  if (
    (ts.isVariableDeclaration(parent) && parent.name === node) ||
    (ts.isFunctionDeclaration(parent) && parent.name === node) ||
    (ts.isClassDeclaration(parent) && parent.name === node) ||
    (ts.isInterfaceDeclaration(parent) && parent.name === node) ||
    (ts.isTypeAliasDeclaration(parent) && parent.name === node) ||
    (ts.isEnumDeclaration(parent) && parent.name === node)
  ) {
    return false;
  }
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) {
    return false;
  }
  if (ts.isPropertyAssignment(parent) && parent.name === node) {
    return false;
  }
  return true;
}

function heritageExpressionName(value: string): string {
  return value
    .replace(/<.*$/s, "")
    .split(".")
    .filter(Boolean)
    .join(".");
}

function findLocalSymbolId(ctx: ExtractContext, name: string): string | undefined {
  return ctx.symbols.find((symbol) => symbol.path === ctx.path && (symbol.name === name || symbol.qualifiedName === name))?.id;
}

function isRouteDecorator(decorator: string): boolean {
  return /\.(get|post|put|patch|delete|route|websocket|api_route)\s*\(/.test(decorator);
}

function isTaskDecorator(decorator: string): boolean {
  return /(task|job|worker|celery|rq|on_event)/i.test(decorator);
}

function decoratorName(decorator: string): string {
  return decorator.replace(/^@/, "").split("(")[0];
}

function routeEndpointsFromDecorator(decorator: string): string[] {
  const methodRaw = /\.(get|post|put|patch|delete|route|websocket|api_route)\s*\(/.exec(decorator)?.[1];
  if (!methodRaw) {
    return [];
  }
  const pathValue = routePathLiteralFromDecorator(decorator);
  if (!pathValue) {
    return [];
  }
  let method = methodRaw === "api_route" || methodRaw === "route" ? "ANY" : methodRaw.toUpperCase();
  const methods = /methods\s*=\s*\[([^\]]+)\]/.exec(decorator)?.[1];
  if (methods) {
    const parsed = [...methods.matchAll(/["']([A-Za-z]+)["']/g)].map((match) => match[1].toUpperCase());
    if (parsed.length > 0) {
      return [...new Set(parsed)].sort().map((parsedMethod) => `${parsedMethod} ${normalizeEndpointPath(pathValue)}`);
    }
  }
  if (methodRaw === "websocket") {
    method = "WEBSOCKET";
  }
  return [`${method} ${normalizeEndpointPath(pathValue)}`];
}

function routePathLiteralFromDecorator(decorator: string): string | undefined {
  const firstArg = firstDecoratorArgument(decorator);
  const firstArgPath = firstArg ? routePathFromStringExpression(firstArg) : undefined;
  if (firstArgPath) {
    return firstArgPath;
  }
  const keywordPath = /(?:path|url_path)\s*=\s*((?:[rubfRUBF]*["'][^"']*["']\s*(?:\+\s*)?)+)/.exec(decorator)?.[1];
  return keywordPath ? routePathFromStringExpression(keywordPath) : undefined;
}

function firstDecoratorArgument(decorator: string): string | undefined {
  const open = decorator.indexOf("(");
  if (open < 0) {
    return undefined;
  }
  let depth = 0;
  let quote: string | undefined;
  let escaped = false;
  for (let index = open + 1; index < decorator.length; index += 1) {
    const char = decorator[index];
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        quote = undefined;
      }
      continue;
    }
    if (char === "\"" || char === "'") {
      quote = char;
      continue;
    }
    if (char === "(" || char === "[" || char === "{") {
      depth += 1;
      continue;
    }
    if (char === ")" && depth === 0) {
      return decorator.slice(open + 1, index).trim();
    }
    if (char === ")" || char === "]" || char === "}") {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (char === "," && depth === 0) {
      return decorator.slice(open + 1, index).trim();
    }
  }
  return decorator.slice(open + 1).trim();
}

function routePathFromStringExpression(expression: string): string | undefined {
  if (!/^\s*[rubfRUBF]*["']/.test(expression)) {
    return undefined;
  }
  const parts = [...expression.matchAll(/[rubfRUBF]*["']([^"']*)["']/g)].map((match) => match[1]);
  if (parts.length === 0 || !parts[0].startsWith("/")) {
    return undefined;
  }
  return parts.join("");
}

function extractEndpointStringReferences(ctx: ExtractContext): void {
  const seen = new Set<string>();
  const pattern = /(["'`])(\/[A-Za-z0-9_./:${}()?=&%+-]{1,180})\1/g;
  for (const match of ctx.sourceText.matchAll(pattern)) {
    const rawPath = match[2];
    const start = match.index ?? 0;
    if (!shouldKeepEndpointString(ctx, rawPath, start)) {
      continue;
    }
    const method = inferEndpointMethod(ctx.sourceText, start);
    const name = `${method} ${endpointPathForReference(ctx, rawPath, start)}`;
    const key = `${name}:${start}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    ctx.usageSites.push({
      ...baseFact("UsageSite", ctx.path, ctx.snapshotId, ctx.indexedAt, "heuristic", ctx.test ? "derived" : "heuristic", rangeFromOffsets(ctx.sourceText, start, start + match[0].length)),
      id: stableId("endpoint-string-reference", ctx.path, name, start),
      type: "UsageSite",
      path: ctx.path,
      name,
      kind: "endpoint_reference",
      text: ctx.sourceText.slice(Math.max(0, start - 80), Math.min(ctx.sourceText.length, start + match[0].length + 120)).replace(/\s+/g, " ").slice(0, 240)
    });
  }
}

function shouldKeepEndpointString(ctx: ExtractContext, rawPath: string, start: number): boolean {
  const lineStart = ctx.sourceText.lastIndexOf("\n", start);
  const linePrefix = ctx.sourceText.slice(lineStart + 1, start);
  if (
    ctx.language === "python" &&
    (/@(?:router|app)\.(?:get|post|put|patch|delete|route|api_route|websocket)\s*\([^)]*$/i.test(linePrefix) || isInsidePythonRouteDecorator(ctx.sourceText, start))
  ) {
    return false;
  }
  const window = ctx.sourceText.slice(Math.max(0, start - 140), Math.min(ctx.sourceText.length, start + 220));
  if (/@(?:router|app)\.(?:get|post|put|patch|delete|route|api_route|websocket)\s*\(/.test(window)) {
    return true;
  }
  if (ctx.test && /(?:client|api|request|fetch)\.(?:get|post|put|patch|delete)\s*\(|fetch\s*\(|\bapi(?:<[^>]+>)?\s*\(/i.test(window)) {
    return true;
  }
  return /(?:fetch|apiFetch|request|axios|client\.(?:get|post|put|patch|delete)|http\.(?:get|post|put|patch|delete))\s*\(|\bapi(?:<[^>]+>)?\s*\(/i.test(window);
}

function isInsidePythonRouteDecorator(sourceText: string, start: number): boolean {
  const before = sourceText.slice(Math.max(0, start - 600), start);
  const match = /@(?:router|app)\.(?:get|post|put|patch|delete|route|api_route|websocket)\s*\(/gi;
  let last: RegExpExecArray | null = null;
  for (let next = match.exec(before); next; next = match.exec(before)) {
    last = next;
  }
  if (!last) {
    return false;
  }
  const tail = before.slice(last.index);
  return tail.lastIndexOf("(") > tail.lastIndexOf(")");
}

function inferEndpointMethod(sourceText: string, start: number): string {
  const before = sourceText.slice(Math.max(0, start - 180), start);
  const after = sourceText.slice(start, Math.min(sourceText.length, start + 240));
  const afterLine = after.split(/\r?\n/, 1)[0] ?? after;
  const callWindow = enclosingCallWindow(sourceText, start);
  const decoratorMethod = /@(?:router|app)\.(get|post|put|patch|delete|websocket|api_route|route)\s*\([^@\n]*$/i.exec(before)?.[1];
  if (decoratorMethod) {
    if (/websocket/i.test(decoratorMethod)) {
      return "WEBSOCKET";
    }
    if (/api_route|route/i.test(decoratorMethod)) {
      const methods = /methods\s*=\s*\[([^\]]+)\]/i.exec(after)?.[1] ?? /methods\s*=\s*\[([^\]]+)\]/i.exec(before)?.[1];
      const parsed = methods ? [...methods.matchAll(/["']([A-Za-z]+)["']/g)].map((match) => match[1].toUpperCase()) : [];
      return parsed.length === 1 ? parsed[0] : "ANY";
    }
    return decoratorMethod.toUpperCase();
  }
  const clientMethod = /\.(get|post|put|patch|delete)\s*\([^.\n]*$/i.exec(before)?.[1];
  if (clientMethod) {
    return clientMethod.toUpperCase();
  }
  const explicitMethod =
    /method\s*:\s*["']([A-Za-z]+)["']/i.exec(callWindow)?.[1] ??
    /method\s*:\s*["']([A-Za-z]+)["']/i.exec(afterLine)?.[1] ??
    /method\s*:\s*["']([A-Za-z]+)["']/i.exec(before)?.[1];
  if (explicitMethod) {
    return explicitMethod.toUpperCase();
  }
  return /fetch\s*\([^)\n]*$/i.test(before) ? "GET" : "ANY";
}

function enclosingCallWindow(sourceText: string, start: number): string {
  const before = sourceText.slice(Math.max(0, start - 220), start);
  const callPattern = /(?:fetch|apiFetch|request|axios|client\.(?:get|post|put|patch|delete)|http\.(?:get|post|put|patch|delete)|\bapi(?:<[^>]+>)?)\s*\(/gi;
  let last: RegExpExecArray | null = null;
  for (let next = callPattern.exec(before); next; next = callPattern.exec(before)) {
    last = next;
  }
  if (!last) {
    return "";
  }
  const callStart = start - before.length + last.index;
  return sourceText.slice(callStart, Math.min(sourceText.length, start + 800));
}

function endpointPathForReference(ctx: ExtractContext, rawPath: string, start: number): string {
  const before = ctx.sourceText.slice(Math.max(0, start - 140), start);
  const shouldPrefixApi = ctx.language !== "python" && !rawPath.startsWith("/api/") && /\bapi(?:<[^>]+>)?\s*\([^)\n]*$/i.test(before);
  return normalizeEndpointPath(shouldPrefixApi ? `/api${rawPath}` : rawPath);
}

function normalizeEndpointPath(value: string): string {
  return value.replace(/\/+/g, "/").replace(/\/$/, "") || "/";
}

function addCommonRisks(ctx: ExtractContext): void {
  if (isPublicSurfacePath(ctx.path)) {
    ctx.risks.push(riskFact(ctx, undefined, "public-surface", 2, "entrypoint, API, adapter, package, or index file"));
  }
  if (ctx.path.includes("/adapters/")) {
    ctx.risks.push(riskFact(ctx, undefined, "atlas-adapter", 2, "Atlas adapter runtime boundary"));
  }
  if (ctx.path.includes("/packages/")) {
    ctx.risks.push(riskFact(ctx, undefined, "atlas-package-manifest", 1.5, "Atlas node package manifest"));
  }
  if (/^scripts\/(service|release|preview)-control\.sh$/.test(ctx.path) || ctx.path.endsWith(".service")) {
    ctx.risks.push(riskFact(ctx, undefined, "operator-runtime", 2, "service or release control surface"));
  }
  if (ctx.path.includes("migration") || ctx.path.includes("config") || ctx.path.endsWith(".service")) {
    ctx.risks.push(riskFact(ctx, undefined, "config-or-migration", 1.5, "configuration or migration-like path"));
  }
  if (ctx.test) {
    ctx.risks.push(riskFact(ctx, undefined, "test-file", 0.5, "test file"));
  }
}

function addPatternRisks(ctx: ExtractContext): void {
  const seen = new Set<string>();
  for (const rule of CODE_PATTERN_RULES) {
    if (rule.languages && !rule.languages.includes(ctx.language)) {
      continue;
    }
    if (rule.path && !rule.path.test(ctx.path)) {
      continue;
    }
    const flags = rule.pattern.flags.includes("g") ? rule.pattern.flags : `${rule.pattern.flags}g`;
    const pattern = new RegExp(rule.pattern.source, flags);
    let count = 0;
    for (const match of ctx.sourceText.matchAll(pattern)) {
      const start = match.index ?? 0;
      const key = `${rule.id}:${start}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      ctx.risks.push(patternRiskFact(ctx, rule.id, rule.score, rule.reason, start, start + match[0].length));
      count += 1;
      if (count >= 5) {
        break;
      }
    }
  }
}

function addEcmaFrameworkHints(ctx: ExtractContext, node: SyntaxNode, symbol: SymbolFact): void {
  if (ctx.language !== "typescript" && ctx.language !== "javascript") {
    return;
  }
  if (/^use[A-Z0-9]/.test(symbol.name)) {
    ctx.risks.push(riskFact(ctx, node, "react-hook", 1.5, `${symbol.name} follows React hook naming`));
  }
  if (/\.(tsx|jsx)$/.test(ctx.path) && /^[A-Z]/.test(symbol.name)) {
    ctx.risks.push(riskFact(ctx, node, "react-component", 1, `${symbol.name} follows React component naming`));
  }
  if (ctx.path.includes("atlas-generator-node-template")) {
    ctx.risks.push(riskFact(ctx, node, "atlas-generator-template", 1.5, "Atlas generator node template contract"));
  }
}

function symbolFact(
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

function usageFact(
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

function importFact(ctx: ExtractContext, node: SyntaxNode, specifier: string, importedName?: string, localName?: string, reExport = false, typeOnly = false): ImportEdgeFact {
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

function riskFact(ctx: ExtractContext, node: SyntaxNode | undefined, signal: string, score: number, reason: string): RiskSignalFact {
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

function patternRiskFact(ctx: ExtractContext, signal: string, score: number, reason: string, start: number, end: number): RiskSignalFact {
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

function syntaxErrorFacts(ctx: ExtractContext, root: SyntaxNode): ParserErrorFact[] {
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

function parserError(ctx: ExtractContext, node: SyntaxNode, message: string): ParserErrorFact {
  return {
    ...baseFact("ParserError", ctx.path, ctx.snapshotId, ctx.indexedAt, "tree-sitter", "heuristic", rangeOf(node)),
    id: stableId("parser-error", ctx.path, message, node.startIndex),
    type: "ParserError",
    path: ctx.path,
    message
  };
}

function baseFact(
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

function rangeOf(node: SyntaxNode): Range {
  return {
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    startByte: node.startIndex,
    endByte: node.endIndex
  };
}

function rangeFromOffsets(sourceText: string, startByte: number, endByte: number): Range {
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
