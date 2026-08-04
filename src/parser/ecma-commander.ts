import ts from "typescript";

export interface CommanderBindings {
  constructorNames: Set<string>;
  roots: Set<string>;
  rootDeclarations: Set<ts.Identifier>;
  lexicalBindingsByScope: Map<ts.Node, Map<string, ts.Identifier>>;
  namespaces: Set<string>;
  guardedNames: Set<string>;
  shadowingScopes: Map<ts.Node, Set<string>>;
  aliases: Map<ts.Identifier, ts.Node>;
}

export function nearestCommanderCommandCall(action: ts.CallExpression, bindings: CommanderBindings): ts.CallExpression | undefined {
  return ts.isPropertyAccessExpression(action.expression)
    ? commanderCommandOnSpine(action.expression.expression, bindings, new Set())
    : undefined;
}

function commanderCommandOnSpine(node: ts.Node, bindings: CommanderBindings, visiting: Set<string>): ts.CallExpression | undefined {
  const current = unwrapExpression(node);
  if (!current) return undefined;
  if (ts.isIdentifier(current)) {
    if (visiting.has(current.text)) return undefined;
    const alias = commanderAliasForIdentifier(current, bindings);
    if (!alias) return undefined;
    visiting.add(current.text);
    const command = commanderCommandOnSpine(alias, bindings, visiting);
    visiting.delete(current.text);
    return command;
  }
  if (!ts.isCallExpression(current)) return undefined;
  if (ts.isPropertyAccessExpression(current.expression)) {
    if (current.expression.name.text === "command" && literalStringArgument(current.arguments[0]) && isCommanderReceiver(current.expression.expression, bindings, new Set())) return current;
    return commanderCommandOnSpine(current.expression.expression, bindings, visiting);
  }
  const firstArgument = current.arguments[0];
  return firstArgument && isCommanderReceiver(firstArgument, bindings, new Set())
    ? commanderCommandOnSpine(firstArgument, bindings, visiting)
    : undefined;
}

function isCommanderReceiver(node: ts.Node, bindings: CommanderBindings, visiting: Set<string>): boolean {
  const current = unwrapExpression(node);
  if (!current) return false;
  if (ts.isIdentifier(current)) {
    if (bindings.roots.has(current.text) && commanderRootBindingAvailable(current, bindings)) return true;
    if (visiting.has(current.text)) return false;
    const alias = commanderAliasForIdentifier(current, bindings);
    if (!alias) return false;
    visiting.add(current.text);
    const result = isCommanderReceiver(alias, bindings, visiting);
    visiting.delete(current.text);
    return result;
  }
  if (ts.isPropertyAccessExpression(current)) {
    if (current.name.text === "program" && ts.isIdentifier(current.expression) && bindings.namespaces.has(current.expression.text) && commanderBindingAvailable(current.expression, bindings)) return true;
    return isCommanderReceiver(current.expression, bindings, visiting);
  }
  if (ts.isNewExpression(current)) {
    return ts.isIdentifier(current.expression)
      && bindings.constructorNames.has(current.expression.text)
      && commanderBindingAvailable(current.expression, bindings);
  }
  if (!ts.isCallExpression(current)) return false;
  if (ts.isPropertyAccessExpression(current.expression)) return isCommanderReceiver(current.expression.expression, bindings, visiting);
  return false;
}

export function commanderBindings(sourceFile: ts.SourceFile): CommanderBindings {
  const constructorNames = new Set<string>();
  const roots = new Set<string>();
  const namespaces = new Set<string>();
  const guardedNames = new Set<string>();
  const guardedDeclarations = new Set<ts.Identifier>();
  const rootDeclarations = new Set<ts.Identifier>();
  const aliases = new Map<ts.Identifier, ts.Node>();
  const commonJsRequireAvailable = !topLevelBindsName(sourceFile, "require");
  const registerGuarded = (collection: Set<string>, name: ts.Identifier): void => {
    collection.add(name.text);
    guardedNames.add(name.text);
    guardedDeclarations.add(name);
  };
  const registerRoot = (name: ts.Identifier): void => {
    registerGuarded(roots, name);
    rootDeclarations.add(name);
  };

  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier) && statement.moduleSpecifier.text === "commander") {
      const clause = statement.importClause;
      if (!clause || clause.isTypeOnly || !clause.namedBindings) continue;
      if (ts.isNamespaceImport(clause.namedBindings)) {
        registerGuarded(namespaces, clause.namedBindings.name);
        continue;
      }
      for (const element of clause.namedBindings.elements) {
        if (element.isTypeOnly) continue;
        const importedName = (element.propertyName ?? element.name).text;
        if (importedName === "Command") registerGuarded(constructorNames, element.name);
        if (importedName === "program") registerRoot(element.name);
      }
      continue;
    }
    if (!ts.isVariableStatement(statement) || !commonJsRequireAvailable) continue;
    for (const declaration of statement.declarationList.declarations) {
      const initializer = unwrapExpression(declaration.initializer);
      if (!initializer) continue;
      if (isCommanderRequireCall(initializer)) {
        if (ts.isObjectBindingPattern(declaration.name)) {
          for (const element of declaration.name.elements) {
            if (!ts.isIdentifier(element.name)) continue;
            const importedName = element.propertyName && ts.isIdentifier(element.propertyName) ? element.propertyName.text : element.name.text;
            if (importedName === "Command") registerGuarded(constructorNames, element.name);
            if (importedName === "program") registerRoot(element.name);
          }
        } else if (ts.isIdentifier(declaration.name)) {
          // Modern Commander exposes `.program`; older CommonJS releases also
          // exposed the singleton directly as the conventional `program` name.
          if (declaration.name.text === "program") registerRoot(declaration.name);
          else registerGuarded(namespaces, declaration.name);
        }
        continue;
      }
      if (ts.isIdentifier(declaration.name) && ts.isPropertyAccessExpression(initializer) && isCommanderRequireCall(unwrapExpression(initializer.expression))) {
        if (initializer.name.text === "Command") registerGuarded(constructorNames, declaration.name);
        if (initializer.name.text === "program") registerRoot(declaration.name);
      }
    }
  }

  const constructorShadowingScopes = commanderShadowingScopes(sourceFile, guardedNames, guardedDeclarations);
  const visit = (node: ts.Node): void => {
    if (ts.isParameter(node) && ts.isIdentifier(node.name) && node.type && [...constructorNames].some((name) => new RegExp(`\\b${name}\\b`, "u").test(node.type!.getText(sourceFile)))) registerRoot(node.name);
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const initializer = unwrapExpression(node.initializer);
      if (initializer && ts.isNewExpression(initializer) && ts.isIdentifier(initializer.expression) && constructorNames.has(initializer.expression.text)
        && commanderGuardedBindingAvailable(initializer.expression, guardedNames, constructorShadowingScopes)) registerRoot(node.name);
      else if (!guardedDeclarations.has(node.name)) aliases.set(node.name, node.initializer);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return {
    constructorNames,
    roots,
    rootDeclarations,
    lexicalBindingsByScope: commanderLexicalBindingsByScope(sourceFile, new Set([
      ...roots,
      ...[...aliases.keys()].map((identifier) => identifier.text)
    ])),
    namespaces,
    guardedNames,
    shadowingScopes: commanderShadowingScopes(sourceFile, guardedNames, guardedDeclarations),
    aliases
  };
}

function commanderLexicalBindingsByScope(
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
    if (ts.isParameter(node)) register(nestedScope, bindingIdentifiers(node.name));
    if (ts.isVariableDeclaration(node)) register(nestedScope, bindingIdentifiers(node.name));
    if (ts.isCatchClause(node) && node.variableDeclaration) register(nestedScope, bindingIdentifiers(node.variableDeclaration.name));
    ts.forEachChild(node, (child) => visit(child, nestedScope));
  };
  visit(sourceFile, sourceFile);
  return scopes;
}

function isCommanderRequireCall(node: ts.Node | undefined): node is ts.CallExpression {
  const current = unwrapExpression(node);
  return Boolean(
    current
    && ts.isCallExpression(current)
    && ts.isIdentifier(current.expression)
    && current.expression.text === "require"
    && current.arguments.length === 1
    && ts.isStringLiteral(current.arguments[0])
    && current.arguments[0].text === "commander"
  );
}

function topLevelBindsName(sourceFile: ts.SourceFile, name: string): boolean {
  return sourceFile.statements.some((statement) => {
    if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name?.text === name) return true;
    if (ts.isImportDeclaration(statement) && statement.importClause) {
      const clause = statement.importClause;
      if (clause.name?.text === name) return true;
      if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings) && clause.namedBindings.name.text === name) return true;
      if (clause.namedBindings && ts.isNamedImports(clause.namedBindings) && clause.namedBindings.elements.some((element) => element.name.text === name)) return true;
    }
    return ts.isVariableStatement(statement)
      && statement.declarationList.declarations.some((declaration) => bindingIdentifiers(declaration.name).some((identifier) => identifier.text === name));
  });
}

function commanderShadowingScopes(
  sourceFile: ts.SourceFile,
  guardedNames: Set<string>,
  guardedDeclarations: Set<ts.Identifier>
): Map<ts.Node, Set<string>> {
  const scopes = new Map<ts.Node, Set<string>>();
  const register = (scope: ts.Node, identifiers: ts.Identifier[]): void => {
    for (const identifier of identifiers) {
      if (!guardedNames.has(identifier.text) || guardedDeclarations.has(identifier)) continue;
      const names = scopes.get(scope) ?? new Set<string>();
      names.add(identifier.text);
      scopes.set(scope, names);
    }
  };
  const visit = (node: ts.Node, scope: ts.Node): void => {
    if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name) register(scope, [node.name]);
    const nestedScope = ts.isFunctionLike(node) || ts.isBlock(node) || ts.isCatchClause(node) ? node : scope;
    if (ts.isParameter(node)) register(nestedScope, bindingIdentifiers(node.name));
    if (ts.isVariableDeclaration(node)) register(nestedScope, bindingIdentifiers(node.name));
    if (ts.isCatchClause(node) && node.variableDeclaration) register(nestedScope, bindingIdentifiers(node.variableDeclaration.name));
    ts.forEachChild(node, (child) => visit(child, nestedScope));
  };
  visit(sourceFile, sourceFile);
  return scopes;
}

function commanderBindingAvailable(identifier: ts.Identifier, bindings: CommanderBindings): boolean {
  return commanderGuardedBindingAvailable(identifier, bindings.guardedNames, bindings.shadowingScopes);
}

function commanderGuardedBindingAvailable(
  identifier: ts.Identifier,
  guardedNames: Set<string>,
  shadowingScopes: Map<ts.Node, Set<string>>
): boolean {
  if (!guardedNames.has(identifier.text)) return true;
  for (let current: ts.Node | undefined = identifier; current; current = current.parent) {
    if (shadowingScopes.get(current)?.has(identifier.text)) return false;
  }
  return true;
}

function commanderRootBindingAvailable(identifier: ts.Identifier, bindings: CommanderBindings): boolean {
  for (let current: ts.Node | undefined = identifier; current; current = current.parent) {
    const binding = bindings.lexicalBindingsByScope.get(current)?.get(identifier.text);
    if (binding) return bindings.rootDeclarations.has(binding);
  }
  return false;
}

function commanderAliasForIdentifier(identifier: ts.Identifier, bindings: CommanderBindings): ts.Node | undefined {
  for (let current: ts.Node | undefined = identifier; current; current = current.parent) {
    const binding = bindings.lexicalBindingsByScope.get(current)?.get(identifier.text);
    if (binding) return bindings.aliases.get(binding);
  }
  return undefined;
}

function bindingIdentifiers(name: ts.BindingName): ts.Identifier[] {
  if (ts.isIdentifier(name)) return [name];
  return name.elements.flatMap((element) => ts.isOmittedExpression(element) ? [] : bindingIdentifiers(element.name));
}

function unwrapExpression(node: ts.Node | undefined): ts.Node | undefined {
  let current = node;
  while (current && (ts.isParenthesizedExpression(current) || ts.isAsExpression(current) || ts.isTypeAssertionExpression(current) || ts.isNonNullExpression(current) || ts.isSatisfiesExpression(current))) {
    current = current.expression;
  }
  return current;
}

function literalStringArgument(node: ts.Node | undefined): string | undefined {
  const value = unwrapExpression(node);
  if (!value || (!ts.isStringLiteral(value) && !ts.isNoSubstitutionTemplateLiteral(value))) return undefined;
  if (/[\u0000-\u001f\u007f]/u.test(value.text)) return undefined;
  const normalized = value.text.trim();
  return normalized.length > 0 && normalized.length <= 120 ? normalized : undefined;
}
