import ts from "typescript";
import type { Confidence, SymbolFact, UsageSiteFact } from "../types.js";
import { stableId } from "../util.js";
import type { ExtractContext, SyntaxNode } from "./context.js";
import { baseFact, importFact, rangeFromOffsets, rangeOf, riskFact, symbolFact, usageFact } from "./facts.js";
import { callName, dynamicImportSpecifier, jsxElementName } from "./nodes.js";

export function extractEcma(root: SyntaxNode, ctx: ExtractContext): void {
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
        ctx.imports.push(importFact(ctx, node, imp.specifier, imp.importedName, imp.localName, true, imp.typeOnly));
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

export function addTypeScriptCompilerAssist(ctx: ExtractContext): void {
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
          symbol.qualifiedName === qualifiedName &&
          symbol.kind === kind &&
          Math.abs((symbol.range?.startByte ?? -1) - range.startByte) < 4
      )
    ) {
      return;
    }
    ctx.symbols.push({
      ...baseFact("Symbol", ctx.path, ctx.snapshotId, ctx.indexedAt, "typescript-syntax", "authoritative", range),
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
      ...baseFact("UsageSite", ctx.path, ctx.snapshotId, ctx.indexedAt, "typescript-syntax", confidence, range),
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
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && ts.isObjectLiteralExpression(node.initializer)) {
      const exported = variableDeclarationExported(node);
      for (const property of node.initializer.properties) {
        const propertyName = objectLiteralPropertyName(property.name, sourceFile);
        if (!propertyName) {
          continue;
        }
        if (
          ts.isMethodDeclaration(property) ||
          (ts.isPropertyAssignment(property) &&
            (ts.isFunctionExpression(property.initializer) || ts.isArrowFunction(property.initializer)))
        ) {
          addSymbol(property, propertyName, `${node.name.text}.${propertyName}`, "method", exported);
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
    if (ts.isCallExpression(node) && isReactCreateElementCall(node, sourceFile)) {
      const firstArg = node.arguments[0];
      if (firstArg && ts.isIdentifier(firstArg) && /^[A-Z]/.test(firstArg.text)) {
        addUsage(firstArg, firstArg.text, "reference", `React.createElement ${firstArg.text}`, undefined, "derived");
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

function ecmaReExports(node: SyntaxNode): Array<{ specifier: string; importedName?: string; localName?: string; typeOnly?: boolean }> {
  const text = node.text;
  const specifier = /from\s+["']([^"']+)["']/.exec(text)?.[1];
  if (!specifier) {
    return [];
  }
  const statementTypeOnly = /^export\s+type\b/.test(text);
  const namespaceName = /export\s+\*\s+as\s+([A-Za-z_$][\w$]*)\s+from/u.exec(text)?.[1];
  if (namespaceName) {
    return [{ specifier, importedName: "*", localName: namespaceName, typeOnly: statementTypeOnly }];
  }
  if (/export\s+\*/.test(text)) {
    return [{ specifier, importedName: "*", localName: "*", typeOnly: statementTypeOnly }];
  }
  const named = /\{([^}]+)\}/.exec(text)?.[1];
  if (!named) {
    return [{ specifier, typeOnly: statementTypeOnly }];
  }
  return named
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const typeOnly = statementTypeOnly || part.startsWith("type ");
      const [name, alias] = part.replace(/^type\s+/, "").split(/\s+as\s+/);
      return { specifier, importedName: name, localName: alias ?? name, typeOnly };
    });
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

function variableDeclarationExported(node: ts.VariableDeclaration): boolean {
  const statement = node.parent?.parent;
  return Boolean(statement && ts.isVariableStatement(statement) && ts.getModifiers(statement)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword));
}

function objectLiteralPropertyName(name: ts.PropertyName | undefined, sourceFile: ts.SourceFile): string | undefined {
  if (!name) {
    return undefined;
  }
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  const text = name.getText(sourceFile).replace(/^["']|["']$/g, "");
  return /^[A-Za-z_$][\w$]*$/.test(text) ? text : undefined;
}

function isReactCreateElementCall(node: ts.CallExpression, sourceFile: ts.SourceFile): boolean {
  const expression = node.expression.getText(sourceFile);
  return expression === "React.createElement" || expression.endsWith(".createElement");
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

export function addEcmaFrameworkHints(ctx: ExtractContext, node: SyntaxNode, symbol: SymbolFact): void {
  if (ctx.language !== "typescript" && ctx.language !== "javascript") {
    return;
  }
  if (/^use[A-Z0-9]/.test(symbol.name)) {
    ctx.risks.push(riskFact(ctx, node, "react-hook", 1.5, `${symbol.name} follows React hook naming`));
  }
  if (/\.(tsx|jsx)$/.test(ctx.path) && /^[A-Z]/.test(symbol.name)) {
    ctx.risks.push(riskFact(ctx, node, "react-component", 1, `${symbol.name} follows React component naming`));
  }
  if (ctx.path.includes("generator-node-template")) {
    ctx.risks.push(riskFact(ctx, node, "generator-template", 1.5, "generator node template contract"));
  }
}
