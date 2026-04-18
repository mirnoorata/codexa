import path from "node:path";
import type { CodexaIndex, Confidence, ImportEdgeFact, Range, RiskSignalFact, SymbolFact, TestEdgeFact, UsageSiteFact } from "../types.js";
import { stableId } from "../util.js";

export interface PythonSemanticSourceFile {
  path: string;
  sourceText: string;
  contentHash: string;
}

interface PythonContext {
  snapshotId: string;
  indexedAt: string;
  sourceByPath: Map<string, string>;
  symbols: SymbolFact[];
  usageSites: UsageSiteFact[];
  imports: ImportEdgeFact[];
  testEdges: TestEdgeFact[];
  risks: RiskSignalFact[];
  symbolsById: Map<string, SymbolFact>;
  symbolsByPath: Map<string, SymbolFact[]>;
  symbolsByPathAndName: Map<string, SymbolFact[]>;
  fixtureByScopeAndName: Map<string, SymbolFact[]>;
}

interface FixtureCandidate {
  symbol: SymbolFact;
  confidence: Confidence;
  reason: string;
}

interface CeleryTaskCandidate {
  taskName: string;
  functionName: string;
  definingPath: string;
  symbol?: SymbolFact;
}

export function applyPythonSemanticAssist(
  index: CodexaIndex,
  options: {
    files: PythonSemanticSourceFile[];
  }
): CodexaIndex {
  const sourceByPath = new Map(options.files.filter((file) => file.path.endsWith(".py")).map((file) => [file.path, file.sourceText]));
  if (sourceByPath.size === 0) {
    return index;
  }

  const context: PythonContext = {
    snapshotId: index.snapshot.snapshotId,
    indexedAt: index.snapshot.indexedAt,
    sourceByPath,
    symbols: index.symbols.map((symbol) => ({ ...symbol })),
    usageSites: index.usageSites.map((usage) => ({ ...usage })),
    imports: index.imports.map((imp) => ({ ...imp })),
    testEdges: index.testEdges.map((edge) => ({ ...edge })),
    risks: index.risks.map((risk) => ({ ...risk })),
    symbolsById: new Map(),
    symbolsByPath: new Map(),
    symbolsByPathAndName: new Map(),
    fixtureByScopeAndName: new Map()
  };
  rebuildSymbolMaps(context);

  resolvePythonImports(context);
  addAssignmentReExportBindings(context);
  addStarImportBindingsFromAll(context);
  addPackageExportEvidence(context);
  addPytestFixtureEvidence(context);
  addPythonFrameworkEvidence(context);
  addPythonModelAttributeEvidence(context);

  return {
    ...index,
    symbols: sortSymbols(dedupeSymbols(context.symbols)),
    usageSites: sortUsages(dedupeUsages(context.usageSites)),
    imports: sortImports(dedupeImports(context.imports)),
    testEdges: sortTestEdges(dedupeTestEdges(context.testEdges)),
    risks: sortRisks(dedupeRisks(context.risks))
  };
}

function resolvePythonImports(context: PythonContext): void {
  const files = new Set(context.sourceByPath.keys());
  context.imports = context.imports.map((imp) => {
    if (!imp.path.endsWith(".py") || imp.resolvedPath) {
      return imp;
    }
    const resolved = resolvePythonImportPathWithRoots(imp, files);
    return resolved ? { ...imp, resolvedPath: resolved.path, confidence: resolved.confidence } : imp;
  });
}

function addStarImportBindingsFromAll(context: PythonContext): void {
  const additions: ImportEdgeFact[] = [];
  for (const imp of context.imports) {
    if (!imp.path.endsWith(".py") || imp.importedName !== "*" || !imp.resolvedPath?.endsWith("__init__.py")) {
      continue;
    }
    const sourceText = context.sourceByPath.get(imp.resolvedPath);
    if (!sourceText) {
      continue;
    }
    for (const name of pythonAllNames(sourceText)) {
      additions.push({
        ...imp,
        id: stableId("python-star-import", imp.path, imp.specifier, name, imp.range?.startByte ?? 0),
        importedName: name,
        localName: name,
        confidence: "derived"
      });
    }
  }
  context.imports.push(...additions);
}

function addAssignmentReExportBindings(context: PythonContext): void {
  const additions: ImportEdgeFact[] = [];
  for (const [filePath, sourceText] of context.sourceByPath) {
    if (!filePath.endsWith("__init__.py")) {
      continue;
    }
    for (const match of sourceText.matchAll(/^([A-Za-z_]\w*)\s*=\s*([A-Za-z_]\w*)\.([A-Za-z_]\w*)\b/gm)) {
      const exportedName = match[1];
      const namespaceName = match[2];
      const memberName = match[3];
      if (!exportedName || !namespaceName || !memberName) {
        continue;
      }
      const namespaceImport = context.imports.find(
        (imp) => imp.path === filePath && imp.resolvedPath && (imp.localName === namespaceName || imp.importedName === namespaceName || imp.specifier.endsWith(`.${namespaceName}`))
      );
      if (!namespaceImport?.resolvedPath) {
        continue;
      }
      additions.push({
        id: stableId("python-assignment-reexport", filePath, exportedName, namespaceName, memberName, match.index ?? 0),
        type: "ImportEdge",
        path: filePath,
        source: "tree-sitter",
        confidence: "derived",
        snapshotId: context.snapshotId,
        indexedAt: context.indexedAt,
        range: rangeFromOffsets(sourceText, match.index ?? 0, (match.index ?? 0) + match[0].length),
        specifier: namespaceImport.specifier,
        importedName: memberName,
        localName: exportedName,
        reExport: true,
        resolvedPath: namespaceImport.resolvedPath
      });
    }
  }
  context.imports.push(...additions);
}

function addPackageExportEvidence(context: PythonContext): void {
  for (const [filePath, sourceText] of context.sourceByPath) {
    if (!filePath.endsWith("__init__.py")) {
      continue;
    }
    const exportedNames = pythonAllNames(sourceText);
    if (exportedNames.length === 0) {
      continue;
    }
    for (const name of exportedNames) {
      const localSymbols = context.symbolsByPathAndName.get(`${filePath}\0${name}`) ?? [];
      const reExportTarget = reExportTargetForName(context, filePath, name);
      const target = reExportTarget ?? singleSymbol(localSymbols);
      if (!target) {
        context.risks.push(
          riskFact(context, filePath, "python-package-export-unresolved", 0.8, `__all__ lists ${name}, but Codexa could not resolve a local or re-exported symbol`, sourceText.indexOf(name))
        );
        continue;
      }
      context.usageSites.push(
        usageFact(context, {
          path: filePath,
          name,
          kind: "reference",
          text: `__all__ export ${name}`,
          confidence: "derived",
          sourceText,
          startByte: sourceText.indexOf(name),
          targetSymbolId: target.id
        })
      );
      markExported(context, target.id);
    }
  }
}

function addPytestFixtureEvidence(context: PythonContext): void {
  for (const symbol of context.symbols) {
    if (symbol.language !== "python" || symbol.kind !== "fixture") {
      continue;
    }
    addFixtureCandidate(context, symbol);
  }

  const nextUsages: UsageSiteFact[] = [];
  for (const usage of context.usageSites) {
    if (usage.kind !== "test_reference" || usage.targetSymbolId || !usage.path.endsWith(".py")) {
      nextUsages.push(usage);
      continue;
    }
    const fixture = visibleFixtureForUsage(context, usage);
    if (!fixture) {
      nextUsages.push(usage);
      continue;
    }
    nextUsages.push({
      ...usage,
      targetSymbolId: fixture.symbol.id,
      confidence: betterConfidence(usage.confidence, fixture.confidence)
    });
    if (usage.path !== fixture.symbol.path) {
      context.testEdges.push(
        testEdgeFact(context, usage.path, fixture.symbol.path, `pytest fixture ${usage.name}${fixture.reason ? ` (${fixture.reason})` : ""}`, fixture.confidence, usage.range)
      );
    }
  }
  context.usageSites = nextUsages;

  for (const fixture of context.symbols.filter((symbol) => symbol.language === "python" && symbol.kind === "fixture" && isAutouseFixture(symbol))) {
    for (const testPath of visibleTestFilesForAutouseFixture(context, fixture)) {
      if (testPath === fixture.path) {
        continue;
      }
      context.testEdges.push(testEdgeFact(context, testPath, fixture.path, `pytest autouse fixture ${fixture.name}`, "heuristic", fixture.range));
    }
  }
}

function addPythonFrameworkEvidence(context: PythonContext): void {
  const celeryTasks = celeryTasksInProject(context);
  const celeryTasksByName = uniqueCeleryTasksByName(celeryTasks);
  for (const [filePath, sourceText] of context.sourceByPath) {
    const dependsNames = fastApiDependsNames(context, filePath, sourceText);
    for (const dependsName of dependsNames) {
      const pattern = new RegExp(`\\b${escapeRegExp(dependsName)}\\s*\\(\\s*([A-Za-z_][\\w.]*)`, "g");
      for (const match of sourceText.matchAll(pattern)) {
        const name = match[1];
        if (!name || ["None", "True", "False"].includes(name)) {
          continue;
        }
        const target = resolveNameInFileOrUnique(context, filePath, name.split(".").at(-1) ?? name);
        context.usageSites.push(
          usageFact(context, {
            path: filePath,
            name,
            kind: "reference",
            text: `FastAPI Depends(${name})`,
            confidence: "heuristic",
            sourceText,
            startByte: match.index ?? 0,
            targetSymbolId: target?.id
          })
        );
        context.risks.push(riskFact(context, filePath, "fastapi-dependency", 1.4, `FastAPI dependency ${name} is runtime-injected`, match.index ?? 0));
      }
    }

    for (const match of sourceText.matchAll(/@\s*([A-Za-z_][\w.]*(?:\.task|shared_task|task))\s*(?:\(|$)/g)) {
      const decorator = match[1] ?? "task";
      context.risks.push(riskFact(context, filePath, "celery-task", 1.8, `Celery task decorator ${decorator}`, match.index ?? 0));
    }
    for (const match of sourceText.matchAll(/\.send_task\s*\(\s*["']([^"']+)["']/g)) {
      const taskName = match[1];
      if (!taskName) {
        continue;
      }
      const task = celeryTasksByName.get(taskName);
      context.usageSites.push(
        usageFact(context, {
          path: filePath,
          name: taskName,
          kind: "reference",
          text: `Celery send_task(${taskName})`,
          confidence: "heuristic",
          sourceText,
          startByte: match.index ?? 0,
          targetSymbolId: task?.symbol?.id
        })
      );
    }
    for (const task of celeryTasks) {
      for (const callName of celeryTaskCallNamesForFile(context, filePath, task)) {
        for (const match of sourceText.matchAll(new RegExp(`\\b${escapeRegExp(callName)}\\.(?:delay|apply_async)\\s*\\(`, "g"))) {
          context.usageSites.push(
            usageFact(context, {
              path: filePath,
              name: callName,
              kind: "call",
              text: `Celery task call ${callName}`,
              confidence: filePath === task.definingPath ? "derived" : "heuristic",
              sourceText,
              startByte: match.index ?? 0,
              targetSymbolId: task.symbol?.id
            })
          );
        }
      }
    }

    for (const classSymbol of pythonClassesInFile(context, filePath)) {
      if (isPydanticModelClass(context, classSymbol)) {
        context.risks.push(riskFact(context, filePath, "pydantic-model", 1.8, `${classSymbol.qualifiedName} inherits from Pydantic BaseModel`, classSymbol.range?.startByte ?? 0));
      }
      if (isSqlAlchemyModelClass(context, classSymbol)) {
        context.risks.push(riskFact(context, filePath, "sqlalchemy-model", 1.8, `${classSymbol.qualifiedName} looks like a SQLAlchemy/SQLModel model`, classSymbol.range?.startByte ?? 0));
      }
    }
  }
}

function fastApiDependsNames(context: PythonContext, filePath: string, _sourceText: string): string[] {
  const names = new Set<string>();
  for (const imp of context.imports) {
    if (imp.path !== filePath) {
      continue;
    }
    if (imp.specifier === "fastapi" && imp.importedName === "Depends") {
      names.add(imp.localName ?? "Depends");
    }
    if (imp.specifier === "fastapi" && imp.importedName === "*") {
      names.add(`${imp.localName ?? "fastapi"}.Depends`);
    }
  }
  return [...names].sort((a, b) => b.length - a.length || a.localeCompare(b));
}

function celeryTasksInProject(context: PythonContext): CeleryTaskCandidate[] {
  const tasks: CeleryTaskCandidate[] = [];
  for (const [filePath, sourceText] of context.sourceByPath) {
    tasks.push(...celeryTasksInFile(context, filePath, sourceText));
  }
  return tasks;
}

function uniqueCeleryTasksByName(tasks: CeleryTaskCandidate[]): Map<string, CeleryTaskCandidate> {
  const byName = new Map<string, CeleryTaskCandidate[]>();
  for (const task of tasks) {
    const existing = byName.get(task.taskName) ?? [];
    existing.push(task);
    byName.set(task.taskName, existing);
  }
  const result = new Map<string, CeleryTaskCandidate>();
  for (const [name, candidates] of byName) {
    if (candidates.length === 1) {
      result.set(name, candidates[0]);
    }
  }
  return result;
}

function celeryTaskCallNamesForFile(context: PythonContext, filePath: string, task: CeleryTaskCandidate): string[] {
  const names = new Set<string>();
  if (filePath === task.definingPath) {
    names.add(task.functionName);
  }
  for (const imp of context.imports) {
    if (imp.path !== filePath || imp.resolvedPath !== task.definingPath) {
      continue;
    }
    if (imp.importedName === task.functionName) {
      names.add(imp.localName ?? task.functionName);
    }
    if (imp.importedName === "*") {
      if (imp.localName === "*") {
        names.add(task.functionName);
      } else if (imp.specifier.endsWith(`.${path.posix.basename(task.definingPath, ".py")}`) || imp.specifier.replace(/\./g, "/") === task.definingPath.replace(/\.py$/, "")) {
        const firstSpecifierPart = imp.specifier.split(".")[0];
        const namespace = imp.localName && imp.localName !== firstSpecifierPart ? imp.localName : imp.specifier;
        names.add(`${namespace}.${task.functionName}`);
      } else {
        names.add(task.functionName);
      }
    }
  }
  return [...names].filter(Boolean).sort((a, b) => b.length - a.length || a.localeCompare(b));
}

function celeryTasksInFile(
  context: PythonContext,
  filePath: string,
  sourceText: string
): CeleryTaskCandidate[] {
  const result: CeleryTaskCandidate[] = [];
  const pattern = /@\s*(?:[A-Za-z_][\w.]*\.task|shared_task|task)\s*(?:\(([^)]*)\))?\s*(?:\r?\n)+\s*(?:async\s+def|def)\s+([A-Za-z_]\w*)/g;
  for (const match of sourceText.matchAll(pattern)) {
    const args = match[1] ?? "";
    const functionName = match[2];
    if (!functionName) {
      continue;
    }
    const explicitName = /\bname\s*=\s*["']([^"']+)["']/.exec(args)?.[1];
    const symbol = resolveNameInFileOrUnique(context, filePath, functionName);
    result.push({ taskName: explicitName ?? functionName, functionName, definingPath: filePath, symbol });
  }
  return result;
}

function classHeaderText(context: PythonContext, classSymbol: SymbolFact): string {
  const text = classText(context, classSymbol);
  return text.split(/\r?\n/, 1)[0] ?? "";
}

function isPydanticModelClass(context: PythonContext, classSymbol: SymbolFact): boolean {
  const sourceText = context.sourceByPath.get(classSymbol.path);
  if (!sourceText || !classSymbol.range) {
    return false;
  }
  const header = classHeaderText(context, classSymbol);
  const pydanticBaseNames = importedFrameworkNames(context, classSymbol.path, "pydantic", "BaseModel", "BaseModel");
  return pydanticBaseNames.some((name) => hasWord(header, name)) || /\bpydantic\.BaseModel\b/.test(header);
}

function isSqlAlchemyModelClass(context: PythonContext, classSymbol: SymbolFact): boolean {
  if (!classSymbol.range || !hasSqlAlchemyImport(context, classSymbol.path)) {
    return false;
  }
  const text = classText(context, classSymbol);
  const header = classHeaderText(context, classSymbol);
  if (!/\b(mapped_column|Column|relationship|Field|__tablename__)\b/.test(text)) {
    return false;
  }
  if (/\b(DeclarativeBase|SQLModel)\b/.test(header)) {
    return true;
  }
  if (/\bBase\b/.test(header)) {
    const sourceText = context.sourceByPath.get(classSymbol.path) ?? "";
    return /\bclass\s+Base\s*\(\s*(DeclarativeBase|SQLModel)\s*\)/.test(sourceText) || /\bBase\s*=\s*declarative_base\s*\(/.test(sourceText);
  }
  return false;
}

function pythonModelFieldConstructorPattern(context: PythonContext, classSymbol: SymbolFact): RegExp | undefined {
  if (isSqlAlchemyModelClass(context, classSymbol)) {
    return /\b(mapped_column|Column|relationship|Field)\b/;
  }
  if (isPydanticModelClass(context, classSymbol)) {
    return /\bField\b/;
  }
  return undefined;
}

function importedFrameworkNames(context: PythonContext, filePath: string, specifier: string, importedName: string, defaultName: string): string[] {
  const names = new Set<string>();
  for (const imp of context.imports) {
    if (imp.path === filePath && imp.specifier === specifier && imp.importedName === importedName) {
      names.add(imp.localName ?? defaultName);
    }
  }
  return [...names].sort();
}

function hasSqlAlchemyImport(context: PythonContext, filePath: string): boolean {
  return context.imports.some((imp) => imp.path === filePath && /^(sqlalchemy|sqlmodel)(\.|$)/.test(imp.specifier));
}

function hasModelFrameworkImport(context: PythonContext, filePath: string): boolean {
  return hasSqlAlchemyImport(context, filePath) || context.imports.some((imp) => imp.path === filePath && /^(pydantic)(\.|$)/.test(imp.specifier));
}

function hasWord(text: string, name: string): boolean {
  return new RegExp(`\\b${escapeRegExp(name)}\\b`).test(text);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function addPythonModelAttributeEvidence(context: PythonContext): void {
  for (const classSymbol of context.symbols.filter((symbol) => symbol.language === "python" && symbol.kind === "class" && symbol.range)) {
    const sourceText = context.sourceByPath.get(classSymbol.path);
    if (!sourceText || !classSymbol.range) {
      continue;
    }
    if (!hasModelFrameworkImport(context, classSymbol.path)) {
      continue;
    }
    const constructorPattern = pythonModelFieldConstructorPattern(context, classSymbol);
    if (!constructorPattern) {
      continue;
    }
    const text = classText(context, classSymbol);
    if (!constructorPattern.test(text)) {
      continue;
    }
    const classStart = classSymbol.range.startByte;
    const classIndent = leadingWhitespace(sourceText, classStart).length;
    const pattern = /^([ \t]+)([A-Za-z_]\w*)\s*(?::[^=\n]+)?=\s*(mapped_column|Column|relationship|Field)\b/gm;
    for (const match of text.matchAll(pattern)) {
      const indent = match[1] ?? "";
      const name = match[2];
      const constructor = match[3];
      if (!name || !constructor || indent.length <= classIndent || !constructorPattern.test(constructor)) {
        continue;
      }
      const startByte = classStart + (match.index ?? 0) + indent.length;
      const qualifiedName = `${classSymbol.qualifiedName}.${name}`;
      if (!hasSymbol(context, classSymbol.path, qualifiedName)) {
        const symbol: SymbolFact = {
          id: stableId("python-model-attribute", classSymbol.path, qualifiedName, startByte),
          type: "Symbol",
          path: classSymbol.path,
          source: "heuristic",
          confidence: "heuristic",
          snapshotId: context.snapshotId,
          indexedAt: context.indexedAt,
          range: rangeFromOffsets(sourceText, startByte, startByte + name.length),
          name,
          qualifiedName,
          kind: "variable",
          language: "python",
          exported: false,
          decorators: [],
          parentSymbolId: classSymbol.id
        };
        context.symbols.push(symbol);
        addSymbolToMaps(context, symbol);
      }
      context.risks.push(riskFact(context, classSymbol.path, "python-model-field", 1.2, `${qualifiedName} uses ${constructor}`, startByte));
    }
  }
}

function pythonAllNames(sourceText: string): string[] {
  const match = /__all__\s*=\s*(?:\(([\s\S]*?)\)|\[([\s\S]*?)\])/m.exec(sourceText);
  const body = match?.[1] ?? match?.[2];
  if (!body) {
    return [];
  }
  return [...body.matchAll(/["']([A-Za-z_][\w]*)["']/g)].map((entry) => entry[1]).filter(Boolean).sort();
}

function reExportTargetForName(context: PythonContext, filePath: string, name: string): SymbolFact | undefined {
  const files = new Set(context.sourceByPath.keys());
  for (const imp of context.imports.filter((entry) => entry.path === filePath && (entry.localName === name || entry.importedName === name))) {
    const resolvedPath = imp.resolvedPath ?? resolvePythonImportPath(imp, files);
    if (!resolvedPath) {
      continue;
    }
    const candidates = context.symbolsByPath.get(resolvedPath) ?? [];
    const importedName = imp.importedName && imp.importedName !== "*" ? imp.importedName : name;
    const exact = singleSymbol(candidates.filter((symbol) => symbol.name === importedName || symbol.qualifiedName === importedName || symbol.qualifiedName.endsWith(`.${importedName}`)));
    if (exact) {
      return exact;
    }
  }
  return undefined;
}

function resolvePythonImportPath(imp: ImportEdgeFact, files: Set<string>): string | undefined {
  return resolvePythonImportPathWithRoots(imp, files)?.path;
}

function resolvePythonImportPathWithRoots(imp: ImportEdgeFact, files: Set<string>): { path: string; confidence: Confidence } | undefined {
  const specifierPath = imp.specifier.startsWith(".") ? pythonRelativeImportCandidate(imp.path, imp.specifier) : imp.specifier.replace(/\./g, "/");
  if (imp.importedName && imp.importedName !== "*") {
    const importedAsModule = resolvePythonCandidate(path.posix.join(specifierPath, imp.importedName), files);
    if (importedAsModule) {
      return { path: importedAsModule, confidence: pythonImportConfidence(importedAsModule, files) };
    }
  }
  const direct = resolvePythonCandidate(specifierPath, files);
  if (direct) {
    return { path: direct, confidence: pythonImportConfidence(direct, files) };
  }
  if (!imp.specifier.startsWith(".")) {
    for (const root of pythonSourceRoots(files)) {
      const packageName = specifierPath.split("/")[0];
      if (!packageName || !files.has(path.posix.join(root, packageName, "__init__.py"))) {
        continue;
      }
      const rooted = path.posix.join(root, specifierPath);
      if (imp.importedName && imp.importedName !== "*") {
        const importedAsRootedModule = resolvePythonCandidate(path.posix.join(rooted, imp.importedName), files);
        if (importedAsRootedModule) {
          return { path: importedAsRootedModule, confidence: "derived" };
        }
      }
      const rootedResolved = resolvePythonCandidate(rooted, files);
      if (rootedResolved) {
        return { path: rootedResolved, confidence: "derived" };
      }
    }
  }
  return undefined;
}

function pythonRelativeImportCandidate(importerPath: string, specifier: string): string {
  const dotMatch = /^(\.+)(.*)$/.exec(specifier);
  if (!dotMatch) {
    return path.posix.join(path.posix.dirname(importerPath), specifier);
  }
  const [, dots, rest] = dotMatch;
  let anchor = path.posix.dirname(importerPath);
  for (let index = 1; index < dots.length; index += 1) {
    anchor = path.posix.dirname(anchor);
  }
  return path.posix.normalize(path.posix.join(anchor, rest.replace(/\./g, "/")));
}

function resolvePythonCandidate(candidate: string, files: Set<string>): string | undefined {
  const variants = [candidate, `${candidate}.py`, `${candidate}/__init__.py`];
  return variants.find((variant) => files.has(variant));
}

function pythonImportConfidence(resolvedPath: string, files: Set<string>): Confidence {
  return pythonPackageDirsHaveInit(resolvedPath, files) ? "authoritative" : "derived";
}

function pythonPackageDirsHaveInit(resolvedPath: string, files: Set<string>): boolean {
  let dir = path.posix.dirname(resolvedPath);
  if (!dir || dir === ".") {
    return true;
  }
  const parts = dir.split("/");
  let current = "";
  for (const part of parts) {
    current = current ? path.posix.join(current, part) : part;
    if (!files.has(path.posix.join(current, "__init__.py"))) {
      return false;
    }
  }
  return true;
}

function pythonSourceRoots(files: Set<string>): string[] {
  const roots = ["src"];
  return roots.filter((root) => [...files].some((file) => file.startsWith(`${root}/`)));
}

function addFixtureCandidate(context: PythonContext, symbol: SymbolFact): void {
  const names: string[] = [];
  const parent = symbol.parentSymbolId ? context.symbolsById.get(symbol.parentSymbolId) : undefined;
  if (parent && isPythonClassScope(parent)) {
    names.push(fixtureScopeKey(`${symbol.path}:${parent.id}`, "class"));
  } else {
    names.push(fixtureScopeKey(symbol.path, "file"));
  }
  const conftestDir = path.posix.basename(symbol.path) === "conftest.py" ? normalizeDir(path.posix.dirname(symbol.path)) : undefined;
  if (conftestDir !== undefined && !(parent && isPythonClassScope(parent))) {
    names.push(fixtureScopeKey(conftestDir, "conftest"));
  }
  for (const key of names) {
    const scopedKey = `${key}\0${symbol.name}`;
    const existing = context.fixtureByScopeAndName.get(scopedKey) ?? [];
    existing.push(symbol);
    context.fixtureByScopeAndName.set(scopedKey, existing);
  }
}

function visibleFixtureForUsage(context: PythonContext, usage: UsageSiteFact): FixtureCandidate | undefined {
  const usedBy = usage.usedBySymbolId ? context.symbolsById.get(usage.usedBySymbolId) : undefined;
  const usedByClassId = usedBy?.parentSymbolId;
  const usedByClass = usedByClassId ? context.symbolsById.get(usedByClassId) : undefined;
  if (usedByClass?.range && usage.range && rangeContains(usedByClass.range, usage.range)) {
    const classFixture = singleSymbol(context.fixtureByScopeAndName.get(`${fixtureScopeKey(`${usage.path}:${usedByClass.id}`, "class")}\0${usage.name}`) ?? []);
    if (classFixture) {
      return { symbol: classFixture, confidence: "authoritative", reason: "same test class" };
    }
  }
  const sameFile = singleSymbol(context.fixtureByScopeAndName.get(`${fixtureScopeKey(usage.path, "file")}\0${usage.name}`) ?? []);
  if (sameFile) {
    return { symbol: sameFile, confidence: "authoritative", reason: "same file" };
  }
  for (const dir of ancestorDirs(path.posix.dirname(usage.path))) {
    const scoped = singleSymbol(context.fixtureByScopeAndName.get(`${fixtureScopeKey(dir, "conftest")}\0${usage.name}`) ?? []);
    if (scoped) {
      return { symbol: scoped, confidence: "authoritative", reason: `conftest ${scoped.path}` };
    }
  }
  const importedFixture = uniqueImportedFixture(context, usage.path, usage.name);
  if (importedFixture) {
    return { symbol: importedFixture, confidence: "derived", reason: "imported fixture" };
  }
  const allFixtures = context.symbols.filter((symbol) => symbol.language === "python" && symbol.kind === "fixture" && !symbol.parentSymbolId && symbol.name === usage.name);
  const unique = singleSymbol(allFixtures);
  return unique ? { symbol: unique, confidence: "heuristic", reason: "unique fixture name" } : undefined;
}

function uniqueImportedFixture(context: PythonContext, filePath: string, name: string): SymbolFact | undefined {
  const importedUsage = context.usageSites.find((usage) => usage.path === filePath && usage.kind === "import" && usage.name === name && usage.targetSymbolId);
  const target = importedUsage?.targetSymbolId ? context.symbolsById.get(importedUsage.targetSymbolId) : undefined;
  return target?.kind === "fixture" ? target : undefined;
}

function visibleTestFilesForAutouseFixture(context: PythonContext, fixture: SymbolFact): string[] {
  const fixtureDir = normalizeDir(path.posix.dirname(fixture.path));
  const conftest = path.posix.basename(fixture.path) === "conftest.py";
  const result = new Set<string>();
  for (const symbol of context.symbols) {
    if (symbol.language !== "python" || symbol.kind !== "test") {
      continue;
    }
    if (conftest) {
      if (symbol.path === fixture.path || (fixtureDir ? symbol.path.startsWith(`${fixtureDir}/`) : true)) {
        result.add(symbol.path);
      }
      continue;
    }
    if (symbol.path === fixture.path) {
      result.add(symbol.path);
    }
  }
  return [...result].sort();
}

function isAutouseFixture(symbol: SymbolFact): boolean {
  return symbol.decorators.some((decorator) => /\bfixture\s*\([^)]*autouse\s*=\s*True\b/.test(decorator));
}

function fixtureScopeKey(value: string, kind: "file" | "conftest" | "class"): string {
  return `${kind}:${value}`;
}

function ancestorDirs(startDir: string): string[] {
  const result: string[] = [];
  let dir = normalizeDir(startDir);
  while (true) {
    result.push(dir);
    if (!dir) {
      break;
    }
    const next = path.posix.dirname(dir);
    dir = next === "." ? "" : next;
  }
  return result;
}

function normalizeDir(dir: string): string {
  return dir === "." ? "" : dir;
}

function isPythonClassScope(symbol: SymbolFact): boolean {
  return symbol.language === "python" && (symbol.kind === "class" || (symbol.kind === "test" && !symbol.parentSymbolId && /^[A-Z]/.test(symbol.name)));
}

function rangeContains(container: Range, candidate: Range): boolean {
  return candidate.startByte >= container.startByte && candidate.endByte <= container.endByte;
}

function pythonClassesInFile(context: PythonContext, filePath: string): SymbolFact[] {
  return (context.symbolsByPath.get(filePath) ?? []).filter((symbol) => symbol.kind === "class" && symbol.language === "python");
}

function classText(context: PythonContext, classSymbol: SymbolFact): string {
  const sourceText = context.sourceByPath.get(classSymbol.path);
  if (!sourceText || !classSymbol.range) {
    return "";
  }
  return sourceText.slice(classSymbol.range.startByte, classEndOffset(sourceText, classSymbol.range.startByte));
}

function classEndOffset(sourceText: string, classStart: number): number {
  const classIndent = leadingWhitespace(sourceText, classStart).length;
  const nextClassOrFunction = new RegExp(`^ {0,${classIndent}}(?:class|def|async\\s+def)\\s+`, "gm");
  nextClassOrFunction.lastIndex = classStart + 1;
  const match = nextClassOrFunction.exec(sourceText);
  return match?.index ?? sourceText.length;
}

function leadingWhitespace(sourceText: string, offset: number): string {
  const lineStart = sourceText.lastIndexOf("\n", Math.max(0, offset - 1)) + 1;
  const line = sourceText.slice(lineStart, offset);
  return /^[ \t]*/.exec(line)?.[0] ?? "";
}

function resolveNameInFileOrUnique(context: PythonContext, filePath: string, name: string): SymbolFact | undefined {
  const sameFile = singleSymbol(context.symbolsByPathAndName.get(`${filePath}\0${name}`) ?? []);
  if (sameFile) {
    return sameFile;
  }
  return singleSymbol(context.symbols.filter((symbol) => symbol.language === "python" && (symbol.name === name || symbol.qualifiedName === name)));
}

function hasSymbol(context: PythonContext, filePath: string, qualifiedName: string): boolean {
  return (context.symbolsByPath.get(filePath) ?? []).some((symbol) => symbol.qualifiedName === qualifiedName);
}

function markExported(context: PythonContext, symbolId: string): void {
  context.symbols = context.symbols.map((symbol) => (symbol.id === symbolId ? { ...symbol, exported: true } : symbol));
  rebuildSymbolMaps(context);
}

function addSymbolToMaps(context: PythonContext, symbol: SymbolFact): void {
  context.symbolsById.set(symbol.id, symbol);
  const byPath = context.symbolsByPath.get(symbol.path) ?? [];
  byPath.push(symbol);
  context.symbolsByPath.set(symbol.path, byPath);
  for (const name of [symbol.name, symbol.qualifiedName]) {
    const key = `${symbol.path}\0${name}`;
    const existing = context.symbolsByPathAndName.get(key) ?? [];
    existing.push(symbol);
    context.symbolsByPathAndName.set(key, existing);
  }
}

function rebuildSymbolMaps(context: PythonContext): void {
  context.symbolsById = new Map();
  context.symbolsByPath = new Map();
  context.symbolsByPathAndName = new Map();
  for (const symbol of context.symbols) {
    addSymbolToMaps(context, symbol);
  }
}

function usageFact(
  context: PythonContext,
  input: {
    path: string;
    name: string;
    kind: UsageSiteFact["kind"];
    text: string;
    confidence: Confidence;
    sourceText: string;
    startByte: number;
    targetSymbolId?: string;
  }
): UsageSiteFact {
  const startByte = Math.max(0, input.startByte);
  return {
    id: stableId("python-semantic-usage", input.path, input.name, input.kind, startByte, input.targetSymbolId),
    type: "UsageSite",
    path: input.path,
    source: input.confidence === "heuristic" ? "heuristic" : "tree-sitter",
    confidence: input.confidence,
    snapshotId: context.snapshotId,
    indexedAt: context.indexedAt,
    range: rangeFromOffsets(input.sourceText, startByte, startByte + input.name.length),
    name: input.name,
    kind: input.kind,
    text: input.text.replace(/\s+/g, " ").slice(0, 240),
    targetSymbolId: input.targetSymbolId
  };
}

function testEdgeFact(
  context: PythonContext,
  testPath: string,
  targetPath: string,
  reason: string,
  confidence: Confidence,
  range?: Range
): TestEdgeFact {
  return {
    id: stableId("python-semantic-test-edge", testPath, targetPath, reason, range?.startByte ?? 0),
    type: "TestEdge",
    path: testPath,
    targetPath,
    reason,
    source: confidence === "heuristic" ? "heuristic" : "tree-sitter",
    confidence,
    snapshotId: context.snapshotId,
    indexedAt: context.indexedAt,
    range
  };
}

function riskFact(context: PythonContext, filePath: string, signal: string, score: number, reason: string, startByte = 0): RiskSignalFact {
  const sourceText = context.sourceByPath.get(filePath) ?? "";
  return {
    id: stableId("python-semantic-risk", filePath, signal, reason, startByte),
    type: "RiskSignal",
    path: filePath,
    source: "heuristic",
    confidence: "heuristic",
    snapshotId: context.snapshotId,
    indexedAt: context.indexedAt,
    range: sourceText ? rangeFromOffsets(sourceText, Math.max(0, startByte), Math.max(0, startByte) + Math.min(reason.length, 80)) : undefined,
    signal,
    score,
    reason
  };
}

function rangeFromOffsets(sourceText: string, startByte: number, endByte: number): Range {
  const safeStart = Math.max(0, Math.min(startByte, sourceText.length));
  const safeEnd = Math.max(safeStart, Math.min(endByte, sourceText.length));
  return {
    startLine: lineForOffset(sourceText, safeStart),
    endLine: lineForOffset(sourceText, safeEnd),
    startByte: safeStart,
    endByte: safeEnd
  };
}

function lineForOffset(sourceText: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset && index < sourceText.length; index += 1) {
    if (sourceText.charCodeAt(index) === 10) {
      line += 1;
    }
  }
  return line;
}

function singleSymbol(symbols: SymbolFact[]): SymbolFact | undefined {
  return symbols.length === 1 ? symbols[0] : undefined;
}

function betterConfidence(current: Confidence, candidate: Confidence): Confidence {
  const rank: Record<Confidence, number> = { authoritative: 0, derived: 1, heuristic: 2 };
  return rank[candidate] < rank[current] ? candidate : current;
}

function dedupeSymbols(symbols: SymbolFact[]): SymbolFact[] {
  return dedupeBy(symbols, (symbol) => `${symbol.path}\0${symbol.qualifiedName}\0${symbol.kind}\0${symbol.range?.startByte ?? symbol.id}`);
}

function dedupeUsages(usages: UsageSiteFact[]): UsageSiteFact[] {
  return dedupeBy(usages, (usage) => `${usage.path}\0${usage.name}\0${usage.kind}\0${usage.targetSymbolId ?? ""}\0${usage.range?.startByte ?? 0}\0${usage.text}`);
}

function dedupeImports(imports: ImportEdgeFact[]): ImportEdgeFact[] {
  return dedupeBy(
    imports,
    (imp) => `${imp.path}\0${imp.specifier}\0${imp.importedName ?? ""}\0${imp.localName ?? ""}\0${imp.resolvedPath ?? ""}\0${imp.range?.startByte ?? 0}`
  );
}

function dedupeTestEdges(edges: TestEdgeFact[]): TestEdgeFact[] {
  return dedupeBy(edges, (edge) => `${edge.path}\0${edge.targetPath ?? ""}\0${edge.reason}\0${edge.range?.startByte ?? 0}`);
}

function dedupeRisks(risks: RiskSignalFact[]): RiskSignalFact[] {
  return dedupeBy(risks, (risk) => `${risk.path}\0${risk.signal}\0${risk.reason}\0${risk.range?.startByte ?? 0}`);
}

function dedupeBy<T>(items: T[], keyFor: (item: T) => string): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const item of items) {
    const key = keyFor(item);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(item);
  }
  return result;
}

function sortSymbols(symbols: SymbolFact[]): SymbolFact[] {
  return symbols.sort((a, b) => a.path.localeCompare(b.path) || a.qualifiedName.localeCompare(b.qualifiedName) || a.kind.localeCompare(b.kind));
}

function sortUsages(usages: UsageSiteFact[]): UsageSiteFact[] {
  return usages.sort((a, b) => a.path.localeCompare(b.path) || a.name.localeCompare(b.name) || a.kind.localeCompare(b.kind) || (a.range?.startByte ?? 0) - (b.range?.startByte ?? 0));
}

function sortImports(imports: ImportEdgeFact[]): ImportEdgeFact[] {
  return imports.sort(
    (a, b) =>
      a.path.localeCompare(b.path) ||
      a.specifier.localeCompare(b.specifier) ||
      (a.importedName ?? "").localeCompare(b.importedName ?? "") ||
      (a.localName ?? "").localeCompare(b.localName ?? "")
  );
}

function sortTestEdges(edges: TestEdgeFact[]): TestEdgeFact[] {
  return edges.sort((a, b) => a.path.localeCompare(b.path) || (a.targetPath ?? "").localeCompare(b.targetPath ?? "") || a.reason.localeCompare(b.reason));
}

function sortRisks(risks: RiskSignalFact[]): RiskSignalFact[] {
  return risks.sort((a, b) => a.path.localeCompare(b.path) || b.score - a.score || a.signal.localeCompare(b.signal) || a.reason.localeCompare(b.reason));
}
