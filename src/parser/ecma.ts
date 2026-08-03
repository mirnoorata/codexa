import ts from "typescript";
import type { Confidence, SymbolFact, UsageSiteFact } from "../types.js";
import { stableId } from "../util.js";
import type { ExtractContext, SyntaxNode } from "./context.js";
import { baseFact, importFact, rangeFromOffsets, rangeOf, riskFact, symbolFact, usageFact } from "./facts.js";
import { callName, dynamicImportSpecifier, jsxElementName } from "./nodes.js";
import { commanderBindings, nearestCommanderCommandCall } from "./ecma-commander.js";

const MAX_EXECUTION_SURFACES_PER_FILE = 64;
const MAX_EXECUTION_HANDLER_CALLS = 15;
const COMMANDER_EXECUTION_MARKER = "codexa:commander-command";
const MCP_EXECUTION_MARKER = "codexa:mcp-tool";
const EXECUTION_HANDLER_CALLS_PREFIX = "codexa:execution-handler-calls:";
const EXECUTION_SURFACES_PREFIX = "codexa:execution-surfaces:";

interface ExecutionSurfaceCandidate {
  marker: typeof COMMANDER_EXECUTION_MARKER | typeof MCP_EXECUTION_MARKER;
  name: string;
  qualifiedName: string;
  anchor: ts.Node;
  handler: ts.Node;
}

interface McpReceiverBinding {
  explicitMcpServer: boolean;
  topLevel: boolean;
}

interface McpReceiverBindings {
  byScope: Map<ts.Node, Map<string, McpReceiverBinding>>;
}

interface McpRegistrationHelpers {
  declarations: Set<ts.Identifier>;
  bindingsByScope: Map<ts.Node, Map<string, ts.Identifier>>;
}

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
  const callExpressions: ts.CallExpression[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      callExpressions.push(node);
    }
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
  addExecutionSurfaceAssist(ctx, sourceFile, callExpressions);
}

function addExecutionSurfaceAssist(ctx: ExtractContext, sourceFile: ts.SourceFile, calls: ts.CallExpression[]): void {
  if (ctx.test) return;
  const importsMcpSdk = ctx.imports.some(
    (entry) => entry.path === ctx.path && (entry.specifier === "@modelcontextprotocol/sdk" || entry.specifier.startsWith("@modelcontextprotocol/sdk/"))
  );
  const candidates: ExecutionSurfaceCandidate[] = [];

  const commander = commanderBindings(sourceFile);
  if (commander.constructorNames.size > 0 || commander.roots.size > 0 || commander.namespaces.size > 0) {
    for (const action of calls.filter((call) => callMethodName(call) === "action")) {
      const command = nearestCommanderCommandCall(action, commander);
      const handler = unwrapExpression(action.arguments[0]);
      const name = command ? literalStringArgument(command.arguments[0]) : undefined;
      if (!command || !handler || !name) {
        continue;
      }
      candidates.push({
        marker: COMMANDER_EXECUTION_MARKER,
        name,
        qualifiedName: `commander command ${name}`,
        anchor: action,
        handler
      });
    }
  }

  if (importsMcpSdk) {
    const receiverBindings = mcpReceiverBindings(sourceFile);
    const helpers = mcpRegistrationHelpers(sourceFile, receiverBindings);
    for (const registration of calls) {
      const calleeName = identifierCallName(registration);
      const directRegistration = isLikelyMcpRegistration(registration, receiverBindings);
      const wrapperRegistration = Boolean(calleeName && (calleeName === "defineTool" || calleeName === "defineMcpTool") && mcpHelperCallAvailable(registration, helpers));
      if (!directRegistration && !wrapperRegistration) {
        continue;
      }
      const definition = mcpToolDefinition(registration, calleeName, directRegistration);
      if (!definition) {
        continue;
      }
      candidates.push({
        marker: MCP_EXECUTION_MARKER,
        name: definition.name,
        qualifiedName: `MCP tool ${definition.name}`,
        anchor: registration,
        handler: definition.handler
      });
    }
    candidates.push(...mcpForOfToolCandidates(sourceFile, helpers));
  }

  const ordered = dedupeExecutionSurfaceCandidates(candidates)
    .sort((left, right) => left.anchor.getStart(sourceFile) - right.anchor.getStart(sourceFile) || left.qualifiedName.localeCompare(right.qualifiedName));
  const bounded = ordered.slice(0, MAX_EXECUTION_SURFACES_PER_FILE);
  const surfaces = bounded.map((candidate) => ({ candidate, symbol: addExecutionSurfaceSymbol(ctx, sourceFile, candidate) }));
  if (ordered.length > bounded.length) {
    for (const { symbol } of surfaces) symbol.decorators.push(`${EXECUTION_SURFACES_PREFIX}${ordered.length}:${bounded.length}`);
  }
  const sourceCallUsages = ctx.usageSites.filter((usage) => usage.kind === "call" && usage.range);
  const importedNames = new Set(ctx.imports.flatMap((entry) => [entry.localName, entry.importedName]).filter((name): name is string => Boolean(name)));
  const claimedUsageIds = new Set<string>();
  for (const { candidate, symbol } of surfaces.sort((left, right) => executionHandlerSpan(left.candidate) - executionHandlerSpan(right.candidate))) {
    if (isNamedExecutionHandler(candidate.handler)) {
      addNamedExecutionHandlerUsage(ctx, sourceFile, candidate.handler, symbol.id, candidate.qualifiedName);
      continue;
    }
    const handlerRange = nodeRange(ctx.sourceText, sourceFile, candidate.handler);
    const eligible = sourceCallUsages.filter((usage) => usage.range && rangeContains(handlerRange, usage.range) && !claimedUsageIds.has(usage.id));
    const usages = [...eligible]
      .sort((left, right) => Number(importedNames.has(right.name)) - Number(importedNames.has(left.name)) || (left.range?.startByte ?? 0) - (right.range?.startByte ?? 0) || left.name.localeCompare(right.name))
      .slice(0, MAX_EXECUTION_HANDLER_CALLS)
      .sort((left, right) => (left.range?.startByte ?? 0) - (right.range?.startByte ?? 0) || left.name.localeCompare(right.name));
    if (eligible.length > usages.length) symbol.decorators.push(`${EXECUTION_HANDLER_CALLS_PREFIX}${eligible.length}:${usages.length}`);
    for (const usage of usages) {
      addExecutionHandlerUsageAlias(ctx, usage, symbol.id, candidate.qualifiedName);
      claimedUsageIds.add(usage.id);
    }
  }
}

function addExecutionSurfaceSymbol(
  ctx: ExtractContext,
  sourceFile: ts.SourceFile,
  candidate: ExecutionSurfaceCandidate
): SymbolFact {
  const range = nodeRange(ctx.sourceText, sourceFile, candidate.anchor);
  const id = stableId("execution-surface", ctx.path, candidate.marker, candidate.name, range.startByte);
  const existing = ctx.symbols.find((symbol) => symbol.id === id);
  if (existing) {
    return existing;
  }
  const symbol: SymbolFact = {
    ...baseFact("Symbol", ctx.path, ctx.snapshotId, ctx.indexedAt, "typescript-syntax", "derived", range),
    id,
    type: "Symbol",
    path: ctx.path,
    name: candidate.name,
    qualifiedName: candidate.qualifiedName,
    kind: "module",
    language: ctx.language,
    exported: false,
    decorators: [candidate.marker]
  };
  ctx.symbols.push(symbol);
  return symbol;
}

function addNamedExecutionHandlerUsage(
  ctx: ExtractContext,
  sourceFile: ts.SourceFile,
  handler: ts.Node,
  usedBySymbolId: string,
  surfaceName: string
): void {
  const name = executionHandlerName(handler, sourceFile);
  if (!name) {
    return;
  }
  const range = nodeRange(ctx.sourceText, sourceFile, handler);
  ctx.usageSites.push({
    ...baseFact("UsageSite", ctx.path, ctx.snapshotId, ctx.indexedAt, "typescript-syntax", "derived", range),
    id: stableId("execution-handler", ctx.path, surfaceName, name, range.startByte),
    type: "UsageSite",
    path: ctx.path,
    name,
    kind: "call",
    usedBySymbolId,
    text: `${surfaceName} handler ${name}`.slice(0, 240)
  });
}

function addExecutionHandlerUsageAlias(ctx: ExtractContext, usage: UsageSiteFact, usedBySymbolId: string, surfaceName: string): void {
  ctx.usageSites.push({
    ...usage,
    id: stableId("execution-handler-call", usedBySymbolId, usage.id),
    source: "typescript-syntax",
    confidence: "derived",
    usedBySymbolId,
    text: `${surfaceName} call ${usage.name}`.slice(0, 240)
  });
}

function mcpToolDefinition(
  registration: ts.CallExpression,
  calleeName: string | undefined,
  directRegistration: boolean
): { name: string; handler: ts.Node } | undefined {
  if (calleeName === "defineMcpTool") {
    return mcpToolObjectDefinition(registration.arguments[0]);
  }
  if (calleeName !== "defineTool" && !directRegistration) {
    return undefined;
  }
  const name = literalStringArgument(registration.arguments[0]);
  const handler = unwrapExpression(registration.arguments[2]);
  return name && handler ? { name, handler } : undefined;
}

function mcpToolObjectDefinition(value: ts.Node | undefined): { name: string; handler: ts.Node } | undefined {
  const definition = unwrapExpression(value);
  if (!definition || !ts.isObjectLiteralExpression(definition)) return undefined;
  const name = propertyLiteralString(objectProperty(definition, "name"));
  const handler = propertyValueNode(objectProperty(definition, "handler"));
  return name && handler ? { name, handler } : undefined;
}

function isLikelyMcpRegistration(call: ts.CallExpression, bindings: McpReceiverBindings): boolean {
  if (!ts.isPropertyAccessExpression(call.expression) || call.expression.name.text !== "registerTool") return false;
  const receiver = unwrapExpression(call.expression.expression);
  if (receiver && ts.isIdentifier(receiver)) return /(?:^|mcp)server$/iu.test(receiver.text) && mcpReceiverBindingAvailable(receiver, bindings);
  return Boolean(receiver && ts.isPropertyAccessExpression(receiver) && /(?:^|mcp)server$/iu.test(receiver.name.text));
}

function mcpRegistrationHelpers(sourceFile: ts.SourceFile, receiverBindings: McpReceiverBindings): McpRegistrationHelpers {
  const declarationBodies = new Map<ts.Node, ts.Identifier>();
  const declarations = new Set<ts.Identifier>();
  const declarationNames = new Set<string>();
  const collectDeclarations = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name && node.body) {
      declarationBodies.set(node.body, node.name);
      declarations.add(node.name);
      declarationNames.add(node.name.text);
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const initializer = unwrapExpression(node.initializer);
      if (initializer && (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer))) {
        declarationBodies.set(initializer.body, node.name);
        declarations.add(node.name);
        declarationNames.add(node.name.text);
      }
    }
    ts.forEachChild(node, collectDeclarations);
  };
  collectDeclarations(sourceFile);
  const bindingsByScope = ecmaLexicalBindingsByScope(sourceFile, declarationNames);

  const directHelpers = new Set<ts.Identifier>();
  const dependencies = new Map<ts.Identifier, Set<ts.Identifier>>();
  const collectCalls = (node: ts.Node, owner?: ts.Identifier): void => {
    const activeOwner = declarationBodies.get(node) ?? owner;
    if (activeOwner && ts.isCallExpression(node)) {
      if (isLikelyMcpRegistration(node, receiverBindings)) directHelpers.add(activeOwner);
      const callee = mcpHelperDeclarationForCall(node, bindingsByScope);
      if (callee && declarations.has(callee) && callee !== activeOwner) {
        const callees = dependencies.get(activeOwner) ?? new Set<ts.Identifier>();
        callees.add(callee);
        dependencies.set(activeOwner, callees);
      }
    }
    ts.forEachChild(node, (child) => collectCalls(child, activeOwner));
  };
  collectCalls(sourceFile);

  const callersByCallee = new Map<ts.Identifier, Set<ts.Identifier>>();
  for (const [caller, callees] of dependencies) {
    for (const callee of callees) {
      const callers = callersByCallee.get(callee) ?? new Set<ts.Identifier>();
      callers.add(caller);
      callersByCallee.set(callee, callers);
    }
  }
  const helpers = new Set(directHelpers);
  const queue = [...directHelpers];
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    for (const caller of callersByCallee.get(queue[cursor]!) ?? []) {
      if (helpers.has(caller)) continue;
      helpers.add(caller);
      queue.push(caller);
    }
  }
  return { declarations: helpers, bindingsByScope };
}

function mcpHelperCallAvailable(call: ts.CallExpression, helpers: McpRegistrationHelpers): boolean {
  const declaration = mcpHelperDeclarationForCall(call, helpers.bindingsByScope);
  return Boolean(declaration && helpers.declarations.has(declaration));
}

function mcpHelperDeclarationForCall(
  call: ts.CallExpression,
  bindingsByScope: Map<ts.Node, Map<string, ts.Identifier>>
): ts.Identifier | undefined {
  return ts.isIdentifier(call.expression) ? ecmaLexicalBinding(call.expression, bindingsByScope) : undefined;
}

function mcpReceiverBindings(sourceFile: ts.SourceFile): McpReceiverBindings {
  const byScope = new Map<ts.Node, Map<string, McpReceiverBinding>>();
  const register = (scope: ts.Node, identifiers: ts.Identifier[], explicitMcpServer = false): void => {
    for (const identifier of identifiers) {
      if (!/(?:^|mcp)server$/iu.test(identifier.text)) continue;
      const names = byScope.get(scope) ?? new Map<string, McpReceiverBinding>();
      names.set(identifier.text, { explicitMcpServer, topLevel: scope === sourceFile });
      byScope.set(scope, names);
    }
  };
  const visit = (node: ts.Node, scope: ts.Node): void => {
    if (ts.isImportDeclaration(node) && node.importClause) {
      const clause = node.importClause;
      if (clause.name) register(sourceFile, [clause.name], true);
      if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) register(sourceFile, [clause.namedBindings.name], true);
      if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) register(sourceFile, clause.namedBindings.elements.map((element) => element.name), true);
    }
    if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name) register(scope, [node.name]);
    const nestedScope = ts.isFunctionLike(node) || ts.isBlock(node) || ts.isCatchClause(node) ? node : scope;
    if (ts.isParameter(node)) register(nestedScope, ecmaBindingIdentifiers(node.name), hasMcpServerEvidence(node, sourceFile));
    if (ts.isVariableDeclaration(node)) register(nestedScope, ecmaBindingIdentifiers(node.name), hasMcpServerEvidence(node, sourceFile));
    if (ts.isCatchClause(node) && node.variableDeclaration) register(nestedScope, ecmaBindingIdentifiers(node.variableDeclaration.name));
    ts.forEachChild(node, (child) => visit(child, nestedScope));
  };
  visit(sourceFile, sourceFile);
  return { byScope };
}

function mcpReceiverBindingAvailable(identifier: ts.Identifier, bindings: McpReceiverBindings): boolean {
  for (let current: ts.Node | undefined = identifier; current; current = current.parent) {
    const binding = bindings.byScope.get(current)?.get(identifier.text);
    if (binding) return binding.topLevel || binding.explicitMcpServer;
  }
  return false;
}

function hasMcpServerEvidence(node: ts.ParameterDeclaration | ts.VariableDeclaration, sourceFile: ts.SourceFile): boolean {
  return [node.type, ts.isVariableDeclaration(node) ? node.initializer : undefined]
    .some((value) => Boolean(value && /\bMcpServer\b/u.test(value.getText(sourceFile))));
}

function ecmaBindingIdentifiers(name: ts.BindingName): ts.Identifier[] {
  if (ts.isIdentifier(name)) return [name];
  return name.elements.flatMap((element) => ts.isOmittedExpression(element) ? [] : ecmaBindingIdentifiers(element.name));
}

function ecmaLexicalBindingsByScope(
  sourceFile: ts.SourceFile,
  trackedNames: Set<string>
): Map<ts.Node, Map<string, ts.Identifier>> {
  const scopes = new Map<ts.Node, Map<string, ts.Identifier>>();
  const register = (scope: ts.Node, identifiers: ts.Identifier[]): void => {
    for (const identifier of identifiers) {
      if (!trackedNames.has(identifier.text)) continue;
      const names = scopes.get(scope) ?? new Map<string, ts.Identifier>();
      names.set(identifier.text, identifier);
      scopes.set(scope, names);
    }
  };
  const visit = (node: ts.Node, scope: ts.Node): void => {
    if (ts.isImportDeclaration(node) && node.importClause) {
      const clause = node.importClause;
      if (clause.name) register(sourceFile, [clause.name]);
      if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) register(sourceFile, [clause.namedBindings.name]);
      if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) register(sourceFile, clause.namedBindings.elements.map((element) => element.name));
    }
    if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name) register(scope, [node.name]);
    const nestedScope = ts.isFunctionLike(node) || ts.isBlock(node) || ts.isCatchClause(node) ? node : scope;
    if (ts.isParameter(node)) register(nestedScope, ecmaBindingIdentifiers(node.name));
    if (ts.isVariableDeclaration(node)) register(nestedScope, ecmaBindingIdentifiers(node.name));
    if (ts.isCatchClause(node) && node.variableDeclaration) register(nestedScope, ecmaBindingIdentifiers(node.variableDeclaration.name));
    ts.forEachChild(node, (child) => visit(child, nestedScope));
  };
  visit(sourceFile, sourceFile);
  return scopes;
}

function ecmaLexicalBinding(
  identifier: ts.Identifier,
  bindingsByScope: Map<ts.Node, Map<string, ts.Identifier>>
): ts.Identifier | undefined {
  for (let current: ts.Node | undefined = identifier; current; current = current.parent) {
    const binding = bindingsByScope.get(current)?.get(identifier.text);
    if (binding) return binding;
  }
  return undefined;
}

function nodeContainsCall(node: ts.Node, predicate: (call: ts.CallExpression) => boolean): boolean {
  if (ts.isCallExpression(node) && predicate(node)) return true;
  let found = false;
  ts.forEachChild(node, (child) => {
    if (!found && nodeContainsCall(child, predicate)) found = true;
  });
  return found;
}

function mcpForOfToolCandidates(sourceFile: ts.SourceFile, helpers: McpRegistrationHelpers): ExecutionSurfaceCandidate[] {
  const arrays = new Map<ts.Identifier, ts.ArrayLiteralExpression>();
  const arrayNames = new Set<string>();
  const loops: ts.ForOfStatement[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const initializer = unwrapExpression(node.initializer);
      if (initializer && ts.isArrayLiteralExpression(initializer)) {
        arrays.set(node.name, initializer);
        arrayNames.add(node.name.text);
      }
    }
    if (ts.isForOfStatement(node)) loops.push(node);
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  const arrayBindingsByScope = ecmaLexicalBindingsByScope(sourceFile, arrayNames);
  const candidates: ExecutionSurfaceCandidate[] = [];
  for (const loop of loops) {
    if (!ts.isVariableDeclarationList(loop.initializer)) continue;
    const declaration = loop.initializer.declarations[0];
    const iterable = unwrapExpression(loop.expression);
    if (!declaration || !ts.isIdentifier(declaration.name) || !iterable || !ts.isIdentifier(iterable)) continue;
    const loopName = declaration.name.text;
    const registered = nodeContainsCall(loop.statement, (call) => {
      const callee = identifierCallName(call);
      const argument = unwrapExpression(call.arguments[0]);
      return Boolean(callee === "defineMcpTool" && mcpHelperCallAvailable(call, helpers) && argument && ts.isIdentifier(argument) && argument.text === loopName);
    });
    const iterableDeclaration = ecmaLexicalBinding(iterable, arrayBindingsByScope);
    const array = iterableDeclaration ? arrays.get(iterableDeclaration) : undefined;
    if (!registered || !array) continue;
    for (const element of array.elements) {
      const definition = mcpToolObjectDefinition(element);
      const anchor = unwrapExpression(element);
      if (!definition || !anchor) continue;
      candidates.push({ marker: MCP_EXECUTION_MARKER, name: definition.name, qualifiedName: `MCP tool ${definition.name}`, anchor, handler: definition.handler });
    }
  }
  return candidates;
}

function objectProperty(object: ts.ObjectLiteralExpression, name: string): ts.ObjectLiteralElementLike | undefined {
  return object.properties.find((property) => objectLiteralPropertyName(property.name, object.getSourceFile()) === name);
}

function propertyLiteralString(property: ts.ObjectLiteralElementLike | undefined): string | undefined {
  return property && ts.isPropertyAssignment(property) ? literalStringArgument(property.initializer) : undefined;
}

function propertyValueNode(property: ts.ObjectLiteralElementLike | undefined): ts.Node | undefined {
  if (!property) {
    return undefined;
  }
  if (ts.isPropertyAssignment(property)) {
    return unwrapExpression(property.initializer);
  }
  if (ts.isShorthandPropertyAssignment(property)) {
    return property.name;
  }
  return ts.isMethodDeclaration(property) ? property : undefined;
}

function literalStringArgument(node: ts.Node | undefined): string | undefined {
  const valueNode = unwrapExpression(node);
  if (!valueNode || (!ts.isStringLiteral(valueNode) && !ts.isNoSubstitutionTemplateLiteral(valueNode))) {
    return undefined;
  }
  const rawValue = valueNode.text;
  if (/[\u0000-\u001f\u007f]/u.test(rawValue)) {
    return undefined;
  }
  const value = rawValue.trim();
  return value.length > 0 && value.length <= 120 ? value : undefined;
}

function unwrapExpression(node: ts.Node | undefined): ts.Node | undefined {
  let current = node;
  while (current && (ts.isParenthesizedExpression(current) || ts.isAsExpression(current) || ts.isTypeAssertionExpression(current) || ts.isNonNullExpression(current) || ts.isSatisfiesExpression(current))) {
    current = current.expression;
  }
  return current;
}

function callMethodName(call: ts.CallExpression): string | undefined {
  return ts.isPropertyAccessExpression(call.expression) ? call.expression.name.text : undefined;
}

function identifierCallName(call: ts.CallExpression): string | undefined {
  return ts.isIdentifier(call.expression) ? call.expression.text : undefined;
}

function executionHandlerName(handler: ts.Node, sourceFile: ts.SourceFile): string | undefined {
  const value = unwrapExpression(handler);
  if (value && ts.isIdentifier(value)) {
    return value.text;
  }
  if (value && ts.isPropertyAccessExpression(value)) {
    const text = value.getText(sourceFile);
    return text.length <= 120 ? text : undefined;
  }
  return undefined;
}

function isNamedExecutionHandler(handler: ts.Node): boolean {
  const value = unwrapExpression(handler);
  return Boolean(value && (ts.isIdentifier(value) || ts.isPropertyAccessExpression(value)));
}

function nodeRange(sourceText: string, sourceFile: ts.SourceFile, node: ts.Node) {
  return rangeFromOffsets(sourceText, node.getStart(sourceFile), node.end);
}

function rangeContains(outer: { startByte: number; endByte: number }, inner: { startByte: number; endByte: number }): boolean {
  return inner.startByte >= outer.startByte && inner.endByte <= outer.endByte;
}

function executionHandlerSpan(candidate: ExecutionSurfaceCandidate): number {
  return Math.max(0, candidate.handler.end - candidate.handler.getStart());
}

function dedupeExecutionSurfaceCandidates(candidates: ExecutionSurfaceCandidate[]): ExecutionSurfaceCandidate[] {
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const key = `${candidate.marker}\0${candidate.name}\0${candidate.anchor.getStart()}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
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
