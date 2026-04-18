import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import ts from "typescript";
import type {
  CodexaIndex,
  Confidence,
  FactSource,
  ImportEdgeFact,
  ParserErrorFact,
  Range,
  SymbolFact,
  UsageSiteFact
} from "../types.js";
import { isSubpath, normalizePath, stableId } from "../util.js";

export interface TypeScriptSemanticSourceFile {
  path: string;
  absolutePath: string;
  contentHash: string;
}

interface SemanticProject {
  key: string;
  tsconfigPath?: string;
  contextHash: string;
  files: TypeScriptSemanticSourceFile[];
}

interface CompilerProject {
  program: ts.Program;
  checker: ts.TypeChecker;
  warnings: ParserErrorFact[];
}

interface SemanticContext {
  repoRoot: string;
  snapshotId: string;
  indexedAt: string;
  indexedPaths: Set<string>;
  symbols: SymbolFact[];
  usageSites: UsageSiteFact[];
  imports: ImportEdgeFact[];
  parserErrors: ParserErrorFact[];
  symbolById: Map<string, SymbolFact>;
  symbolsByPath: Map<string, SymbolFact[]>;
}

const MAX_COMPILER_PROJECT_CACHE_ENTRIES = 6;
const compilerProjectCache = new Map<string, CompilerProject>();

export async function applyTypeScriptSemanticAssist(
  index: CodexaIndex,
  options: {
    repoRoot: string;
    files: TypeScriptSemanticSourceFile[];
  }
): Promise<CodexaIndex> {
  const repoRoot = path.resolve(options.repoRoot);
  const sourceFilesByPath = new Map(options.files.map((file) => [file.path, file.absolutePath]));
  const contentHashesByPath = new Map(options.files.map((file) => [file.path, file.contentHash]));
  const semanticFiles = index.files
    .filter((file) => (file.language === "typescript" || file.language === "javascript") && sourceFilesByPath.has(file.path))
    .map((file) => ({
      path: file.path,
      absolutePath: sourceFilesByPath.get(file.path)!,
      contentHash: contentHashesByPath.get(file.path) ?? ""
    }));

  if (semanticFiles.length === 0) {
    return index;
  }

  const context: SemanticContext = {
    repoRoot,
    snapshotId: index.snapshot.snapshotId,
    indexedAt: index.snapshot.indexedAt,
    indexedPaths: new Set(index.files.map((file) => file.path)),
    symbols: index.symbols.map((symbol) => ({ ...symbol })),
    usageSites: index.usageSites.map((usage) => ({ ...usage })),
    imports: index.imports.map((imp) => ({ ...imp })),
    parserErrors: index.parserErrors.map((error) => ({ ...error })),
    symbolById: new Map(),
    symbolsByPath: new Map()
  };
  rebuildSymbolMaps(context);

  const projects = groupSemanticProjects(index, semanticFiles, options.files);
  for (const project of projects) {
    try {
      const compilerProject = await loadCompilerProject(repoRoot, project, context.snapshotId, context.indexedAt);
      context.parserErrors.push(...compilerProject.warnings);
      analyzeCompilerProject(compilerProject, context, new Set(project.files.map((file) => file.path)));
    } catch (error) {
      context.parserErrors.push(
        semanticWarning(
          project.tsconfigPath ?? project.files[0]?.path ?? "tsconfig.json",
          context.snapshotId,
          context.indexedAt,
          `TypeScript semantic assist skipped: ${error instanceof Error ? error.message : String(error)}`
        )
      );
    }
  }

  return {
    ...index,
    symbols: sortSymbols(dedupeSymbols(context.symbols)),
    usageSites: sortUsages(dedupeUsages(context.usageSites)),
    imports: sortImports(dedupeImports(context.imports)),
    parserErrors: sortParserErrors(dedupeParserErrors(context.parserErrors))
  };
}

function groupSemanticProjects(index: CodexaIndex, files: TypeScriptSemanticSourceFile[], allFiles: TypeScriptSemanticSourceFile[]): SemanticProject[] {
  const tsconfigs = new Set(index.files.filter((file) => path.posix.basename(file.path) === "tsconfig.json").map((file) => file.path));
  const contextHash = hashText(
    allFiles
      .filter((file) => path.posix.basename(file.path) === "tsconfig.json" || path.posix.basename(file.path) === "package.json")
      .map((file) => `${file.path}:${file.contentHash}`)
      .sort()
      .join("\n")
  );
  const groups = new Map<string, SemanticProject>();
  for (const file of files) {
    const tsconfigPath = nearestTsconfig(file.path, tsconfigs);
    const key = tsconfigPath ?? "<implicit>";
    const existing = groups.get(key) ?? { key, tsconfigPath, contextHash, files: [] };
    existing.files.push(file);
    groups.set(key, existing);
  }
  return [...groups.values()]
    .map((project) => ({ ...project, files: project.files.sort((a, b) => a.path.localeCompare(b.path)) }))
    .sort((a, b) => a.key.localeCompare(b.key));
}

function nearestTsconfig(filePath: string, tsconfigs: Set<string>): string | undefined {
  let dir = path.posix.dirname(filePath);
  while (true) {
    const candidate = dir === "." ? "tsconfig.json" : `${dir}/tsconfig.json`;
    if (tsconfigs.has(candidate)) {
      return candidate;
    }
    if (dir === ".") {
      return undefined;
    }
    dir = path.posix.dirname(dir);
  }
}

async function loadCompilerProject(
  repoRoot: string,
  project: SemanticProject,
  snapshotId: string,
  indexedAt: string
): Promise<CompilerProject> {
  const config = await compilerOptionsForProject(repoRoot, project, snapshotId, indexedAt);
  const rootsHash = hashText(project.files.map((file) => `${file.path}:${file.contentHash}`).join("\n"));
  const cacheKey = `${repoRoot}:${project.key}:${config.configHash}:${project.contextHash}:${rootsHash}`;
  const cached = compilerProjectCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const rootNames = project.files.map((file) => file.absolutePath);
  const program = ts.createProgram({
    rootNames,
    options: config.options
  });
  const compilerProject = {
    program,
    checker: program.getTypeChecker(),
    warnings: config.warnings
  };
  rememberCompilerProject(cacheKey, compilerProject);
  return compilerProject;
}

function rememberCompilerProject(cacheKey: string, project: CompilerProject): void {
  compilerProjectCache.set(cacheKey, project);
  while (compilerProjectCache.size > MAX_COMPILER_PROJECT_CACHE_ENTRIES) {
    const oldestKey = compilerProjectCache.keys().next().value;
    if (!oldestKey) {
      break;
    }
    compilerProjectCache.delete(oldestKey);
  }
}

async function compilerOptionsForProject(
  repoRoot: string,
  project: SemanticProject,
  snapshotId: string,
  indexedAt: string
): Promise<{ options: ts.CompilerOptions; configHash: string; warnings: ParserErrorFact[] }> {
  const defaults: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    jsx: ts.JsxEmit.ReactJSX,
    allowJs: true,
    checkJs: false,
    noEmit: true,
    skipLibCheck: true,
    esModuleInterop: true,
    allowSyntheticDefaultImports: true
  };
  const warnings: ParserErrorFact[] = [];
  if (!project.tsconfigPath) {
    return { options: defaults, configHash: "implicit", warnings };
  }

  const configPath = path.join(repoRoot, project.tsconfigPath);
  let configText = "";
  try {
    configText = await fs.readFile(configPath, "utf8");
  } catch (error) {
    warnings.push(semanticWarning(project.tsconfigPath, snapshotId, indexedAt, `Unable to read tsconfig: ${String(error)}`));
    return { options: defaults, configHash: "missing", warnings };
  }

  const parsedJson = ts.parseConfigFileTextToJson(configPath, configText);
  if (parsedJson.error) {
    warnings.push(semanticWarning(project.tsconfigPath, snapshotId, indexedAt, flattenDiagnostic(parsedJson.error)));
    return { options: defaults, configHash: hashText(configText), warnings };
  }
  const parsed = ts.parseJsonConfigFileContent(parsedJson.config, ts.sys, path.dirname(configPath), defaults, configPath);
  for (const diagnostic of parsed.errors.slice(0, 5)) {
    warnings.push(semanticWarning(project.tsconfigPath, snapshotId, indexedAt, flattenDiagnostic(diagnostic)));
  }
  return {
    options: {
      ...defaults,
      ...parsed.options,
      noEmit: true,
      allowJs: true,
      checkJs: false,
      skipLibCheck: true
    },
    configHash: hashText(configText),
    warnings
  };
}

function analyzeCompilerProject(project: CompilerProject, context: SemanticContext, projectPaths: Set<string>): void {
  for (const sourceFile of project.program.getSourceFiles()) {
    const relativePath = repoRelativePath(context.repoRoot, sourceFile.fileName);
    if (!relativePath || !projectPaths.has(relativePath)) {
      continue;
    }
    analyzeImports(sourceFile, project, context, relativePath);
    analyzeExports(sourceFile, project, context, relativePath);
    analyzeReferences(sourceFile, project, context, relativePath);
  }
}

function analyzeImports(sourceFile: ts.SourceFile, project: CompilerProject, context: SemanticContext, relativePath: string): void {
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
      const specifier = node.moduleSpecifier.text;
      const resolvedPath = resolveModulePath(specifier, sourceFile.fileName, project.program.getCompilerOptions(), context);
      const clause = node.importClause;
      if (!clause) {
        mergeImport(context, importFact(context, sourceFile, node, relativePath, specifier, undefined, undefined, false, false, resolvedPath));
      } else {
        if (clause.name) {
          mergeImport(context, importFact(context, sourceFile, node, relativePath, specifier, "default", clause.name.text, false, Boolean(clause.isTypeOnly), resolvedPath));
        }
        if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
          mergeImport(context, importFact(context, sourceFile, node, relativePath, specifier, "*", clause.namedBindings.name.text, false, Boolean(clause.isTypeOnly), resolvedPath));
        }
        if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
          for (const spec of clause.namedBindings.elements) {
            mergeImport(
              context,
              importFact(
                context,
                sourceFile,
                spec,
                relativePath,
                specifier,
                (spec.propertyName ?? spec.name).text,
                spec.name.text,
                false,
                Boolean(clause.isTypeOnly || spec.isTypeOnly),
                resolvedPath
              )
            );
          }
        }
      }
    }
    if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
      const specifier = node.moduleSpecifier.text;
      const resolvedPath = resolveModulePath(specifier, sourceFile.fileName, project.program.getCompilerOptions(), context);
      const typeOnly = Boolean(node.isTypeOnly);
      if (!node.exportClause) {
        mergeImport(context, importFact(context, sourceFile, node, relativePath, specifier, "*", "*", true, typeOnly, resolvedPath));
      } else if (ts.isNamespaceExport(node.exportClause)) {
        mergeImport(context, importFact(context, sourceFile, node, relativePath, specifier, "*", node.exportClause.name.text, true, typeOnly, resolvedPath));
      } else if (ts.isNamedExports(node.exportClause)) {
        for (const spec of node.exportClause.elements) {
          mergeImport(
            context,
            importFact(
              context,
              sourceFile,
              spec,
              relativePath,
              specifier,
              (spec.propertyName ?? spec.name).text,
              spec.name.text,
              true,
              Boolean(typeOnly || spec.isTypeOnly),
              resolvedPath
            )
          );
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
}

function analyzeExports(sourceFile: ts.SourceFile, project: CompilerProject, context: SemanticContext, relativePath: string): void {
  const moduleSymbol = project.checker.getSymbolAtLocation(sourceFile);
  if (moduleSymbol) {
    for (const exportSymbol of project.checker.getExportsOfModule(moduleSymbol)) {
      const targetSymbol = symbolFromTsSymbol(exportSymbol, project, context);
      if (targetSymbol) {
        if (targetSymbol.path === relativePath) {
          targetSymbol.exported = true;
        }
        const exportDeclaration = exportSymbol.declarations?.find((declaration) => repoRelativePath(context.repoRoot, declaration.getSourceFile().fileName) === relativePath);
        if (exportDeclaration && targetSymbol.path !== relativePath) {
          mergeUsage(
            context,
            usageFact(context, sourceFile, exportDeclaration, relativePath, exportSymbol.name, typeUsageKind(targetSymbol), `re-export ${exportSymbol.name}`, targetSymbol.id, "authoritative")
          );
        }
      }
    }
  }

  const visit = (node: ts.Node) => {
    if (ts.isExportDeclaration(node) && !node.moduleSpecifier && node.exportClause && ts.isNamedExports(node.exportClause)) {
      for (const spec of node.exportClause.elements) {
        if (spec.name.text !== "default") {
          continue;
        }
        const target = symbolFromNode(spec.propertyName ?? spec.name, project, context);
        const targetKind = target?.kind ?? "unknown";
        const defaultSymbol = ensureSyntheticDefaultExport(context, sourceFile, spec.name, relativePath, targetKind);
        if (target) {
          mergeUsage(context, usageFact(context, sourceFile, spec, relativePath, (spec.propertyName ?? spec.name).text, typeUsageKind(target), "local default export alias", target.id, "authoritative"));
        }
        defaultSymbol.exported = true;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
}

function analyzeReferences(sourceFile: ts.SourceFile, project: CompilerProject, context: SemanticContext, relativePath: string): void {
  const visit = (node: ts.Node) => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const target = symbolFromNode(node.tagName, project, context);
      const name = node.tagName.getText(sourceFile);
      if (target && /^[A-Z]/.test(name)) {
        mergeUsage(context, usageFact(context, sourceFile, node.tagName, relativePath, name, "reference", `jsx component ${name}`, target.id, "authoritative"));
      }
    }

    if (ts.isPropertyAccessExpression(node)) {
      const target = symbolFromNode(node.name, project, context);
      if (target) {
        const name = compactTsName(node.getText(sourceFile));
        const isCall = ts.isCallExpression(node.parent) && node.parent.expression === node;
        mergeUsage(context, usageFact(context, sourceFile, node, relativePath, name, isCall ? "call" : "reference", isCall ? `method call ${name}` : `property reference ${name}`, target.id, "authoritative"));
      }
    }

    if (ts.isTypeReferenceNode(node)) {
      const target = symbolFromNode(node.typeName, project, context);
      if (target) {
        const name = compactTsName(node.typeName.getText(sourceFile));
        mergeUsage(context, usageFact(context, sourceFile, node.typeName, relativePath, name, "type_reference", `type reference ${name}`, target.id, "authoritative"));
      }
    }

    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
}

function symbolFromNode(node: ts.Node, project: CompilerProject, context: SemanticContext): SymbolFact | undefined {
  const symbol = project.checker.getSymbolAtLocation(node);
  return symbol ? symbolFromTsSymbol(symbol, project, context) : undefined;
}

function symbolFromTsSymbol(symbol: ts.Symbol, project: CompilerProject, context: SemanticContext): SymbolFact | undefined {
  const target = safeAliasedSymbol(project.checker, symbol);
  const declarations = target.declarations ?? symbol.declarations ?? [];
  for (const declaration of declarations) {
    const sourceFile = declaration.getSourceFile();
    const relativePath = repoRelativePath(context.repoRoot, sourceFile.fileName);
    if (!relativePath || !context.indexedPaths.has(relativePath)) {
      continue;
    }
    const symbolInfo = symbolInfoForDeclaration(declaration, sourceFile, target.name);
    if (!symbolInfo) {
      continue;
    }
    return ensureSymbol(context, sourceFile, declaration, relativePath, symbolInfo);
  }
  return undefined;
}

function safeAliasedSymbol(checker: ts.TypeChecker, symbol: ts.Symbol): ts.Symbol {
  if ((symbol.flags & ts.SymbolFlags.Alias) === 0) {
    return symbol;
  }
  try {
    return checker.getAliasedSymbol(symbol);
  } catch {
    return symbol;
  }
}

function symbolInfoForDeclaration(
  declaration: ts.Declaration,
  sourceFile: ts.SourceFile,
  fallbackName: string
): { name: string; qualifiedName: string; kind: SymbolFact["kind"]; exported: boolean } | undefined {
  if (ts.isFunctionDeclaration(declaration)) {
    const name = declaration.name?.text ?? (hasDefaultExport(declaration) ? "default" : fallbackName);
    return { name, qualifiedName: name === "default" ? "default export" : name, kind: "function", exported: isExportedDeclaration(declaration) };
  }
  if (ts.isClassDeclaration(declaration)) {
    const name = declaration.name?.text ?? (hasDefaultExport(declaration) ? "default" : fallbackName);
    return { name, qualifiedName: name === "default" ? "default export" : name, kind: "class", exported: isExportedDeclaration(declaration) };
  }
  if (ts.isInterfaceDeclaration(declaration)) {
    return { name: declaration.name.text, qualifiedName: declaration.name.text, kind: "interface", exported: isExportedDeclaration(declaration) };
  }
  if (ts.isTypeAliasDeclaration(declaration)) {
    return { name: declaration.name.text, qualifiedName: declaration.name.text, kind: "type", exported: isExportedDeclaration(declaration) };
  }
  if (ts.isEnumDeclaration(declaration)) {
    return { name: declaration.name.text, qualifiedName: declaration.name.text, kind: "enum", exported: isExportedDeclaration(declaration) };
  }
  if (ts.isMethodDeclaration(declaration) || ts.isMethodSignature(declaration)) {
    const name = propertyNameText(declaration.name, sourceFile);
    if (!name) {
      return undefined;
    }
    const parentName = declaration.parent && (ts.isClassLike(declaration.parent) || ts.isInterfaceDeclaration(declaration.parent)) ? declaration.parent.name?.text : undefined;
    const objectName =
      declaration.parent && ts.isObjectLiteralExpression(declaration.parent) ? objectLiteralOwnerName(declaration.parent) : undefined;
    return {
      name,
      qualifiedName: parentName ? `${parentName}.${name}` : objectName ? `${objectName}.${name}` : name,
      kind: "method",
      exported: Boolean(parentName && isExportedDeclaration(declaration.parent as ts.Declaration))
    };
  }
  if (ts.isPropertyAssignment(declaration)) {
    const name = propertyNameText(declaration.name, sourceFile);
    const objectName = declaration.parent && ts.isObjectLiteralExpression(declaration.parent) ? objectLiteralOwnerName(declaration.parent) : undefined;
    if (name && objectName && declaration.initializer && (ts.isArrowFunction(declaration.initializer) || ts.isFunctionExpression(declaration.initializer))) {
      return {
        name,
        qualifiedName: `${objectName}.${name}`,
        kind: "method",
        exported: objectLiteralOwnerExported(declaration.parent)
      };
    }
  }
  if (ts.isVariableDeclaration(declaration) && ts.isIdentifier(declaration.name)) {
    const name = declaration.name.text;
    return { name, qualifiedName: name, kind: variableSymbolKind(declaration), exported: variableDeclarationExported(declaration) };
  }
  if (ts.isFunctionExpression(declaration) && declaration.name) {
    return { name: declaration.name.text, qualifiedName: declaration.name.text, kind: "function", exported: isDefaultExportAssignment(declaration) };
  }
  return undefined;
}

function ensureSymbol(
  context: SemanticContext,
  sourceFile: ts.SourceFile,
  declaration: ts.Declaration,
  relativePath: string,
  symbolInfo: { name: string; qualifiedName: string; kind: SymbolFact["kind"]; exported: boolean }
): SymbolFact {
  const range = rangeFromNode(sourceFile, declaration);
  const existing = findExistingSymbol(context, relativePath, symbolInfo, range);
  if (existing) {
    if (symbolInfo.exported && !existing.exported) {
      existing.exported = true;
    }
    return existing;
  }
  const symbol: SymbolFact = {
    ...baseFact("Symbol", relativePath, context.snapshotId, context.indexedAt, "typescript-compiler", "authoritative", range),
    id: stableId("ts-semantic-symbol", relativePath, symbolInfo.qualifiedName, symbolInfo.kind, range.startByte),
    type: "Symbol",
    path: relativePath,
    name: symbolInfo.name,
    qualifiedName: symbolInfo.qualifiedName,
    kind: symbolInfo.kind,
    language: relativePath.endsWith(".js") || relativePath.endsWith(".jsx") ? "javascript" : "typescript",
    exported: symbolInfo.exported,
    decorators: []
  };
  context.symbols.push(symbol);
  addSymbolToMaps(context, symbol);
  return symbol;
}

function ensureSyntheticDefaultExport(
  context: SemanticContext,
  sourceFile: ts.SourceFile,
  node: ts.Node,
  relativePath: string,
  kind: SymbolFact["kind"]
): SymbolFact {
  const range = rangeFromNode(sourceFile, node);
  const existing = findExistingSymbol(context, relativePath, { name: "default", qualifiedName: "default export", kind }, range);
  if (existing) {
    existing.exported = true;
    return existing;
  }
  const symbol: SymbolFact = {
    ...baseFact("Symbol", relativePath, context.snapshotId, context.indexedAt, "typescript-compiler", "authoritative", range),
    id: stableId("ts-semantic-default", relativePath, range.startByte),
    type: "Symbol",
    path: relativePath,
    name: "default",
    qualifiedName: "default export",
    kind,
    language: relativePath.endsWith(".js") || relativePath.endsWith(".jsx") ? "javascript" : "typescript",
    exported: true,
    decorators: []
  };
  context.symbols.push(symbol);
  addSymbolToMaps(context, symbol);
  return symbol;
}

function findExistingSymbol(
  context: SemanticContext,
  relativePath: string,
  symbolInfo: { name: string; qualifiedName: string; kind: SymbolFact["kind"] },
  range: Range
): SymbolFact | undefined {
  const candidates = context.symbolsByPath.get(relativePath) ?? [];
  const requiresQualifiedMatch = symbolInfo.qualifiedName.includes(".");
  return (
    candidates.find(
      (symbol) =>
        symbol.kind === symbolInfo.kind &&
        (requiresQualifiedMatch ? symbol.qualifiedName === symbolInfo.qualifiedName : symbol.name === symbolInfo.name || symbol.qualifiedName === symbolInfo.qualifiedName) &&
        Math.abs((symbol.range?.startByte ?? -1) - range.startByte) <= 4
    ) ??
    candidates.find(
      (symbol) =>
        symbol.kind === symbolInfo.kind &&
        (requiresQualifiedMatch ? symbol.qualifiedName === symbolInfo.qualifiedName : symbol.name === symbolInfo.name || symbol.qualifiedName === symbolInfo.qualifiedName) &&
        !symbol.parentSymbolId
    )
  );
}

function mergeUsage(context: SemanticContext, usage: UsageSiteFact): void {
  const existing = context.usageSites.find(
    (candidate) =>
      candidate.path === usage.path &&
      candidate.name === usage.name &&
      candidate.kind === usage.kind &&
      Math.abs((candidate.range?.startByte ?? -1) - (usage.range?.startByte ?? -2)) <= 4
  );
  if (existing) {
    if (!existing.targetSymbolId && usage.targetSymbolId) {
      existing.targetSymbolId = usage.targetSymbolId;
      existing.source = usage.source;
      existing.confidence = usage.confidence;
      existing.text = usage.text;
    }
    return;
  }
  context.usageSites.push(usage);
}

function mergeImport(context: SemanticContext, imp: ImportEdgeFact): void {
  const existing = context.imports.find(
    (candidate) =>
      candidate.path === imp.path &&
      candidate.specifier === imp.specifier &&
      candidate.importedName === imp.importedName &&
      candidate.localName === imp.localName &&
      Boolean(candidate.reExport) === Boolean(imp.reExport) &&
      Boolean(candidate.typeOnly) === Boolean(imp.typeOnly)
  );
  if (existing) {
    if (!existing.resolvedPath && imp.resolvedPath) {
      existing.resolvedPath = imp.resolvedPath;
    }
    return;
  }
  context.imports.push(imp);
}

function importFact(
  context: SemanticContext,
  sourceFile: ts.SourceFile,
  node: ts.Node,
  relativePath: string,
  specifier: string,
  importedName?: string,
  localName?: string,
  reExport = false,
  typeOnly = false,
  resolvedPath?: string
): ImportEdgeFact {
  const range = rangeFromNode(sourceFile, node);
  return {
    ...baseFact("ImportEdge", relativePath, context.snapshotId, context.indexedAt, "typescript-compiler", "authoritative", range),
    id: stableId("ts-semantic-import", relativePath, specifier, importedName, localName, reExport ? "re-export" : "import", typeOnly ? "type" : "value", range.startByte),
    type: "ImportEdge",
    path: relativePath,
    specifier,
    importedName,
    localName,
    reExport,
    typeOnly,
    resolvedPath
  };
}

function usageFact(
  context: SemanticContext,
  sourceFile: ts.SourceFile,
  node: ts.Node,
  relativePath: string,
  name: string,
  kind: UsageSiteFact["kind"],
  text: string,
  targetSymbolId?: string,
  confidence: Confidence = "derived"
): UsageSiteFact {
  const range = rangeFromNode(sourceFile, node);
  return {
    ...baseFact("UsageSite", relativePath, context.snapshotId, context.indexedAt, "typescript-compiler", confidence, range),
    id: stableId("ts-semantic-usage", relativePath, name, kind, range.startByte, targetSymbolId),
    type: "UsageSite",
    path: relativePath,
    name,
    kind,
    targetSymbolId,
    usedBySymbolId: enclosingSymbolId(context, sourceFile, node, relativePath),
    text: text.replace(/\s+/g, " ").slice(0, 240)
  };
}

function enclosingSymbolId(context: SemanticContext, sourceFile: ts.SourceFile, node: ts.Node, relativePath: string): string | undefined {
  let current = node.parent;
  while (current) {
    const info = symbolInfoForDeclaration(current as ts.Declaration, sourceFile, "");
    if (info) {
      return findExistingSymbol(context, relativePath, info, rangeFromNode(sourceFile, current))?.id;
    }
    current = current.parent;
  }
  return undefined;
}

function resolveModulePath(specifier: string, containingFile: string, options: ts.CompilerOptions, context: SemanticContext): string | undefined {
  const resolved = ts.resolveModuleName(specifier, containingFile, options, ts.sys).resolvedModule?.resolvedFileName;
  if (!resolved) {
    return undefined;
  }
  const relativePath = repoRelativePath(context.repoRoot, resolved.replace(/\.d\.ts$/u, ".ts"));
  if (relativePath && context.indexedPaths.has(relativePath)) {
    return relativePath;
  }
  const directRelativePath = repoRelativePath(context.repoRoot, resolved);
  return directRelativePath && context.indexedPaths.has(directRelativePath) ? directRelativePath : undefined;
}

function repoRelativePath(repoRoot: string, fileName: string): string | undefined {
  const absolute = path.resolve(fileName);
  if (!isSubpath(absolute, repoRoot)) {
    return undefined;
  }
  const relative = normalizePath(path.relative(repoRoot, absolute));
  if (!relative || relative.startsWith("node_modules/")) {
    return undefined;
  }
  return relative;
}

function baseFact(
  type: "Symbol" | "UsageSite" | "ImportEdge" | "ParserError",
  filePath: string,
  snapshotId: string,
  indexedAt: string,
  source: FactSource,
  confidence: Confidence,
  range?: Range
) {
  return {
    type,
    path: filePath,
    source,
    confidence,
    snapshotId,
    indexedAt,
    range
  };
}

function semanticWarning(pathValue: string, snapshotId: string, indexedAt: string, message: string): ParserErrorFact {
  return {
    ...baseFact("ParserError", pathValue, snapshotId, indexedAt, "typescript-compiler", "heuristic"),
    id: stableId("ts-semantic-warning", pathValue, message),
    type: "ParserError",
    path: pathValue,
    message
  };
}

function rangeFromNode(sourceFile: ts.SourceFile, node: ts.Node): Range {
  const start = node.getStart(sourceFile);
  return rangeFromOffsets(sourceFile.text, start, node.end);
}

function rangeFromOffsets(sourceText: string, start: number, end: number): Range {
  let line = 1;
  let lineStart = 0;
  for (let index = 0; index < start; index += 1) {
    if (sourceText.charCodeAt(index) === 10) {
      line += 1;
      lineStart = index + 1;
    }
  }
  let endLine = line;
  for (let index = start; index < end; index += 1) {
    if (sourceText.charCodeAt(index) === 10) {
      endLine += 1;
    }
  }
  return {
    startLine: line,
    endLine,
    startByte: start,
    endByte: end
  };
}

function rebuildSymbolMaps(context: SemanticContext): void {
  context.symbolById = new Map();
  context.symbolsByPath = new Map();
  for (const symbol of context.symbols) {
    addSymbolToMaps(context, symbol);
  }
}

function addSymbolToMaps(context: SemanticContext, symbol: SymbolFact): void {
  context.symbolById.set(symbol.id, symbol);
  const inPath = context.symbolsByPath.get(symbol.path) ?? [];
  inPath.push(symbol);
  context.symbolsByPath.set(symbol.path, inPath);
}

function variableSymbolKind(declaration: ts.VariableDeclaration): SymbolFact["kind"] {
  const initializer = declaration.initializer;
  return initializer && (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)) ? "function" : "variable";
}

function variableDeclarationExported(declaration: ts.VariableDeclaration): boolean {
  const statement = declaration.parent?.parent;
  return Boolean(statement && ts.isVariableStatement(statement) && isExportedDeclaration(statement));
}

function objectLiteralOwnerName(node: ts.ObjectLiteralExpression): string | undefined {
  const parent = node.parent;
  return parent && ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name) ? parent.name.text : undefined;
}

function objectLiteralOwnerExported(node: ts.ObjectLiteralExpression): boolean {
  const parent = node.parent;
  return parent && ts.isVariableDeclaration(parent) ? variableDeclarationExported(parent) : false;
}

function isExportedDeclaration(declaration: ts.Declaration | ts.VariableStatement): boolean {
  return Boolean(ts.canHaveModifiers(declaration) && ts.getModifiers(declaration)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword));
}

function hasDefaultExport(node: ts.Node): boolean {
  return Boolean(ts.canHaveModifiers(node) && ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword));
}

function isDefaultExportAssignment(declaration: ts.FunctionExpression): boolean {
  let current: ts.Node | undefined = declaration.parent;
  while (current) {
    if (ts.isExportAssignment(current) && !current.isExportEquals) {
      return true;
    }
    current = current.parent;
  }
  return false;
}

function propertyNameText(name: ts.PropertyName | undefined, sourceFile: ts.SourceFile): string | undefined {
  if (!name) {
    return undefined;
  }
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  const text = name.getText(sourceFile).replace(/^["']|["']$/gu, "");
  return /^[A-Za-z_$][\w$]*$/u.test(text) ? text : undefined;
}

function typeUsageKind(symbol: SymbolFact): UsageSiteFact["kind"] {
  return symbol.kind === "interface" || symbol.kind === "type" || symbol.kind === "enum" ? "type_reference" : "reference";
}

function compactTsName(value: string): string {
  const compact = value.replace(/\s+/gu, " ").trim();
  return compact.length <= 120 ? compact : `${compact.slice(0, 117)}...`;
}

function flattenDiagnostic(diagnostic: ts.Diagnostic): string {
  return ts.flattenDiagnosticMessageText(diagnostic.messageText, " ").slice(0, 500);
}

function hashText(value: string): string {
  return createHash("sha1").update(value).digest("hex");
}

function dedupeSymbols(symbols: SymbolFact[]): SymbolFact[] {
  const byKey = new Map<string, SymbolFact>();
  for (const symbol of symbols) {
    const key = `${symbol.path}\0${symbol.qualifiedName}\0${symbol.kind}\0${symbol.range?.startByte ?? -1}`;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, symbol);
    } else if (factSourcePriority(symbol.source) > factSourcePriority(existing.source)) {
      byKey.set(key, { ...symbol, exported: symbol.exported || existing.exported });
    } else if (symbol.exported && !existing.exported) {
      existing.exported = true;
    }
  }
  return [...byKey.values()];
}

function dedupeUsages(usages: UsageSiteFact[]): UsageSiteFact[] {
  const byKey = new Map<string, UsageSiteFact>();
  for (const usage of usages) {
    const locationKey = usage.range ? String(usage.range.startByte) : `${usage.id}:${usage.text}`;
    const key = `${usage.path}\0${usage.name}\0${usage.kind}\0${locationKey}`;
    const existing = byKey.get(key);
    if (!existing || factSourcePriority(usage.source) > factSourcePriority(existing.source) || (!existing.targetSymbolId && usage.targetSymbolId)) {
      byKey.set(key, usage);
    }
  }
  return [...byKey.values()];
}

function dedupeImports(imports: ImportEdgeFact[]): ImportEdgeFact[] {
  const byKey = new Map<string, ImportEdgeFact>();
  for (const imp of imports) {
    const key = `${imp.path}\0${imp.specifier}\0${imp.importedName ?? ""}\0${imp.localName ?? ""}\0${Boolean(imp.reExport)}\0${Boolean(imp.typeOnly)}`;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, imp);
    } else if (!existing.resolvedPath && imp.resolvedPath) {
      existing.resolvedPath = imp.resolvedPath;
    }
  }
  return [...byKey.values()];
}

function factSourcePriority(source: string): number {
  if (source === "typescript-compiler") {
    return 3;
  }
  if (source === "typescript-syntax") {
    return 2;
  }
  return 1;
}

function dedupeParserErrors(errors: ParserErrorFact[]): ParserErrorFact[] {
  const seen = new Set<string>();
  const result: ParserErrorFact[] = [];
  for (const error of errors) {
    const key = `${error.path}\0${error.source}\0${error.message}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(error);
  }
  return result;
}

function sortSymbols(symbols: SymbolFact[]): SymbolFact[] {
  return symbols.sort((a, b) => a.path.localeCompare(b.path) || (a.range?.startByte ?? 0) - (b.range?.startByte ?? 0) || a.qualifiedName.localeCompare(b.qualifiedName));
}

function sortUsages(usages: UsageSiteFact[]): UsageSiteFact[] {
  return usages.sort((a, b) => a.path.localeCompare(b.path) || (a.range?.startByte ?? 0) - (b.range?.startByte ?? 0) || a.name.localeCompare(b.name));
}

function sortImports(imports: ImportEdgeFact[]): ImportEdgeFact[] {
  return imports.sort(
    (a, b) =>
      a.path.localeCompare(b.path) ||
      (a.range?.startByte ?? 0) - (b.range?.startByte ?? 0) ||
      a.specifier.localeCompare(b.specifier) ||
      (a.importedName ?? "").localeCompare(b.importedName ?? "") ||
      (a.localName ?? "").localeCompare(b.localName ?? "")
  );
}

function sortParserErrors(errors: ParserErrorFact[]): ParserErrorFact[] {
  return errors.sort((a, b) => a.path.localeCompare(b.path) || a.message.localeCompare(b.message));
}
