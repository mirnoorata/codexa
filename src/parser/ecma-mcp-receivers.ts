import ts from "typescript";
import { ecmaBindingDeclaration, ecmaBindingIdentifiers, ecmaLexicalBinding, ecmaLexicalBindingsByScope } from "./ecma-bindings.js";

export interface McpReceiverBinding {
  explicitMcpServer: boolean;
  topLevel: boolean;
}

export interface McpReceiverBindings {
  byScope: Map<ts.Node, Map<string, McpReceiverBinding>>;
}

interface McpReceiverTypeContext {
  containerProperties: Map<string, Set<string>>;
  bindingsByScope: Map<ts.Node, Map<string, ts.Identifier>>;
}

export function mcpReceiverBindings(sourceFile: ts.SourceFile): McpReceiverBindings {
  const byScope = new Map<ts.Node, Map<string, McpReceiverBinding>>();
  const typeContext = mcpReceiverTypeContext(sourceFile);
  const register = (
    scope: ts.Node,
    identifiers: ts.Identifier[],
    declaration?: ts.ParameterDeclaration | ts.VariableDeclaration,
    explicitMcpServer = false
  ): void => {
    for (const identifier of identifiers) {
      if (!mcpReceiverName(identifier.text)) continue;
      const names = byScope.get(scope) ?? new Map<string, McpReceiverBinding>();
      names.set(identifier.text, {
        explicitMcpServer: explicitMcpServer || Boolean(declaration && hasMcpServerEvidence(declaration, identifier, sourceFile, typeContext)),
        topLevel: scope === sourceFile
      });
      byScope.set(scope, names);
    }
  };
  const visit = (node: ts.Node, scope: ts.Node): void => {
    if (ts.isImportDeclaration(node) && node.importClause) {
      const clause = node.importClause;
      if (clause.name) register(sourceFile, [clause.name], undefined, true);
      if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) register(sourceFile, [clause.namedBindings.name], undefined, true);
      if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) register(sourceFile, clause.namedBindings.elements.map((element) => element.name), undefined, true);
    }
    if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name) register(scope, [node.name]);
    const nestedScope = ts.isFunctionLike(node) || ts.isBlock(node) || ts.isCatchClause(node) ? node : scope;
    if (ts.isParameter(node)) register(nestedScope, ecmaBindingIdentifiers(node.name), node);
    if (ts.isVariableDeclaration(node)) register(nestedScope, ecmaBindingIdentifiers(node.name), node);
    if (ts.isCatchClause(node) && node.variableDeclaration) register(nestedScope, ecmaBindingIdentifiers(node.variableDeclaration.name));
    ts.forEachChild(node, (child) => visit(child, nestedScope));
  };
  visit(sourceFile, sourceFile);
  return { byScope };
}

export function mcpReceiverBindingAvailable(identifier: ts.Identifier, bindings: McpReceiverBindings): boolean {
  for (let current: ts.Node | undefined = identifier; current; current = current.parent) {
    const binding = bindings.byScope.get(current)?.get(identifier.text);
    if (binding) return binding.topLevel || binding.explicitMcpServer;
  }
  return false;
}

function hasMcpServerEvidence(
  node: ts.ParameterDeclaration | ts.VariableDeclaration,
  identifier: ts.Identifier,
  sourceFile: ts.SourceFile,
  context: McpReceiverTypeContext
): boolean {
  if (
    [node.type, ts.isVariableDeclaration(node) ? node.initializer : undefined]
      .some((value) => Boolean(value && /\bMcpServer\b/u.test(value.getText(sourceFile))))
  ) {
    return true;
  }
  const destructuredProperty = mcpReceiverBindingProperty(identifier, sourceFile);
  if (destructuredProperty && typeCarriesMcpServer(node.type, destructuredProperty, context.containerProperties, sourceFile)) {
    return true;
  }
  if (!ts.isVariableDeclaration(node)) {
    return false;
  }
  const initializer = unwrapExpression(node.initializer);
  if (!initializer) return false;
  const propertyReceiver = ts.isPropertyAccessExpression(initializer) ? unwrapExpression(initializer.expression) : undefined;
  const sourceIdentifier = destructuredProperty && ts.isIdentifier(initializer)
    ? initializer
    : ts.isPropertyAccessExpression(initializer) && mcpReceiverName(initializer.name.text) && propertyReceiver && ts.isIdentifier(propertyReceiver)
      ? propertyReceiver
      : undefined;
  const sourceProperty = ts.isPropertyAccessExpression(initializer) ? initializer.name.text : destructuredProperty;
  if (!sourceIdentifier) return false;
  const sourceBinding = ecmaLexicalBinding(sourceIdentifier, context.bindingsByScope);
  const sourceDeclaration = sourceBinding ? ecmaBindingDeclaration(sourceBinding) : undefined;
  return Boolean(
    sourceProperty &&
    sourceDeclaration &&
    typeCarriesMcpServer(sourceDeclaration.type, sourceProperty, context.containerProperties, sourceFile)
  );
}

function mcpReceiverTypeContext(sourceFile: ts.SourceFile): McpReceiverTypeContext {
  const bindingNames = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isParameter(node) || ts.isVariableDeclaration(node)) {
      for (const identifier of ecmaBindingIdentifiers(node.name)) bindingNames.add(identifier.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return {
    containerProperties: mcpServerContainerProperties(sourceFile),
    bindingsByScope: ecmaLexicalBindingsByScope(sourceFile, bindingNames)
  };
}

function mcpServerContainerProperties(sourceFile: ts.SourceFile): Map<string, Set<string>> {
  const trusted = new Map<string, Set<string>>();
  for (const statement of sourceFile.statements) {
    if (ts.isInterfaceDeclaration(statement)) {
      const properties = mcpServerProperties(statement.members, sourceFile);
      if (properties.size > 0) trusted.set(statement.name.text, properties);
    }
    if (ts.isTypeAliasDeclaration(statement) && ts.isTypeLiteralNode(statement.type)) {
      const properties = mcpServerProperties(statement.type.members, sourceFile);
      if (properties.size > 0) trusted.set(statement.name.text, properties);
    }
  }
  return trusted;
}

function mcpServerProperties(members: ts.NodeArray<ts.TypeElement>, sourceFile: ts.SourceFile): Set<string> {
  return new Set(
    members.flatMap((member) => {
      if (!ts.isPropertySignature(member) || !member.type || !typeContainsIdentifier(member.type, "McpServer")) return [];
      const name = propertyName(member.name, sourceFile);
      return mcpReceiverName(name) ? [name!] : [];
    })
  );
}

function typeCarriesMcpServer(
  type: ts.TypeNode | undefined,
  receiverProperty: string,
  containerProperties: Map<string, Set<string>>,
  sourceFile: ts.SourceFile
): boolean {
  if (!type) return false;
  if (ts.isParenthesizedTypeNode(type)) return typeCarriesMcpServer(type.type, receiverProperty, containerProperties, sourceFile);
  if (ts.isUnionTypeNode(type) || ts.isIntersectionTypeNode(type)) {
    return type.types.some((entry) => typeCarriesMcpServer(entry, receiverProperty, containerProperties, sourceFile));
  }
  if (ts.isTypeLiteralNode(type)) return mcpServerProperties(type.members, sourceFile).has(receiverProperty);
  if (!ts.isTypeReferenceNode(type)) return false;
  const name = type.typeName.getText(sourceFile);
  if (name === "McpServer" || containerProperties.get(name)?.has(receiverProperty)) return true;
  if (name === "Pick") {
    const [sourceType, keys] = type.typeArguments ?? [];
    return Boolean(
      sourceType &&
      keys &&
      typeCarriesMcpServer(sourceType, receiverProperty, containerProperties, sourceFile) &&
      typeSelectsReceiver(keys, receiverProperty)
    );
  }
  if (["Readonly", "Required", "Partial"].includes(name)) {
    return Boolean(
      type.typeArguments?.[0] &&
      typeCarriesMcpServer(type.typeArguments[0], receiverProperty, containerProperties, sourceFile)
    );
  }
  return false;
}

function typeSelectsReceiver(type: ts.TypeNode, receiverProperty: string): boolean {
  if (ts.isParenthesizedTypeNode(type)) return typeSelectsReceiver(type.type, receiverProperty);
  if (ts.isUnionTypeNode(type)) return type.types.some((entry) => typeSelectsReceiver(entry, receiverProperty));
  return ts.isLiteralTypeNode(type) && ts.isStringLiteral(type.literal) && type.literal.text === receiverProperty;
}

function typeContainsIdentifier(node: ts.Node, name: string): boolean {
  if (ts.isIdentifier(node) && node.text === name) return true;
  let found = false;
  ts.forEachChild(node, (child) => {
    if (!found && typeContainsIdentifier(child, name)) found = true;
  });
  return found;
}

function mcpReceiverBindingProperty(identifier: ts.Identifier, sourceFile: ts.SourceFile): string | undefined {
  const parent = identifier.parent;
  if (!ts.isBindingElement(parent)) return undefined;
  const bindingProperty = parent.propertyName ?? (ts.isIdentifier(parent.name) ? parent.name : undefined);
  const name = propertyName(bindingProperty, sourceFile);
  return mcpReceiverName(name) ? name : undefined;
}

function mcpReceiverName(name: string | undefined): boolean {
  return Boolean(name && /(?:^|mcp)server$/iu.test(name));
}

function propertyName(name: ts.PropertyName | undefined, sourceFile: ts.SourceFile): string | undefined {
  if (!name) return undefined;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  const text = name.getText(sourceFile).replace(/^["']|["']$/g, "");
  return /^[A-Za-z_$][\w$]*$/u.test(text) ? text : undefined;
}

function unwrapExpression(node: ts.Node | undefined): ts.Node | undefined {
  let current = node;
  while (current && (ts.isParenthesizedExpression(current) || ts.isAsExpression(current) || ts.isTypeAssertionExpression(current) || ts.isNonNullExpression(current) || ts.isSatisfiesExpression(current))) {
    current = current.expression;
  }
  return current;
}
