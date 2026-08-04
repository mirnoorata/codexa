import ts from "typescript";

export function ecmaBindingIdentifiers(name: ts.BindingName): ts.Identifier[] {
  if (ts.isIdentifier(name)) return [name];
  return name.elements.flatMap((element) => ts.isOmittedExpression(element) ? [] : ecmaBindingIdentifiers(element.name));
}

export function ecmaLexicalBindingsByScope(
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

export function ecmaLexicalBinding(
  identifier: ts.Identifier,
  bindingsByScope: Map<ts.Node, Map<string, ts.Identifier>>
): ts.Identifier | undefined {
  for (let current: ts.Node | undefined = identifier; current; current = current.parent) {
    const binding = bindingsByScope.get(current)?.get(identifier.text);
    if (binding) return binding;
  }
  return undefined;
}

export function ecmaBindingDeclaration(identifier: ts.Identifier): ts.ParameterDeclaration | ts.VariableDeclaration | undefined {
  for (let current: ts.Node | undefined = identifier; current; current = current.parent) {
    if (ts.isParameter(current) || ts.isVariableDeclaration(current)) return current;
    if (ts.isSourceFile(current)) return undefined;
  }
  return undefined;
}
