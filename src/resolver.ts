import path from "node:path";
import { isTestPath } from "./language.js";
import type { CodexaIndex, ImportEdgeFact, SymbolFact, TestEdgeFact, UsageSiteFact } from "./types.js";
import { normalizePath, stableId } from "./util.js";

export interface ImportAliasRule {
  prefix: string;
  targetPrefix: string;
  exact?: boolean;
  scopePrefix?: string;
}

export function resolveIndexLinks(index: CodexaIndex, aliases: ImportAliasRule[] = []): CodexaIndex {
  const files = new Set(index.files.map((file) => file.path));
  const symbolsByName = new Map<string, SymbolFact[]>();
  const symbolsByPathAndName = new Map<string, SymbolFact>();
  const symbolsByPath = new Map<string, SymbolFact[]>();

  for (const symbol of index.symbols) {
    const existing = symbolsByName.get(symbol.name) ?? [];
    existing.push(symbol);
    symbolsByName.set(symbol.name, existing);
    symbolsByPathAndName.set(`${symbol.path}\0${symbol.name}`, symbol);
    symbolsByPathAndName.set(`${symbol.path}\0${symbol.qualifiedName}`, symbol);
    const inPath = symbolsByPath.get(symbol.path) ?? [];
    inPath.push(symbol);
    symbolsByPath.set(symbol.path, inPath);
  }

  const resolvedImports = index.imports.map((imp) => ({
    ...imp,
    resolvedPath: imp.resolvedPath ?? resolveImportPath(imp, files, aliases)
  }));
  const importBindings = buildImportBindings(resolvedImports, symbolsByPath);
  const importedLocalsByPath = importedLocalNamesByPath(resolvedImports);

  const usageSites = index.usageSites.map((usage) => {
    if (usage.targetSymbolId) {
      return usage;
    }
    if (usage.kind === "import") {
      return usage;
    }
    const importedSymbol = resolveImportedUsage(usage, importBindings);
    if (importedSymbol) {
      return { ...usage, targetSymbolId: importedSymbol.id };
    }
    if (usesImportedLocal(usage, importedLocalsByPath)) {
      return usage;
    }
    if (usage.kind === "test_reference") {
      return usage;
    }
    const sameFile = symbolsByPathAndName.get(`${usage.path}\0${usage.name}`);
    if (sameFile) {
      return { ...usage, targetSymbolId: sameFile.id };
    }
    if (usage.kind !== "call") {
      const exactMatches = symbolsByName.get(usage.name);
      if (exactMatches?.length === 1) {
        return { ...usage, targetSymbolId: exactMatches[0].id };
      }
      const shortName = usage.name.split(".").at(-1) ?? usage.name;
      const matches = symbolsByName.get(shortName);
      if (matches?.length === 1) {
        return { ...usage, targetSymbolId: matches[0].id };
      }
    }
    return usage;
  });

  const testEdges = index.testEdges.map((edge) => {
    if (edge.targetPath) {
      return edge;
    }
    const targetPath = inferTestTarget(edge.path, files);
    return targetPath ? { ...edge, targetPath } : edge;
  });
  for (const edge of importTestEdges(resolvedImports, index.snapshot.snapshotId, index.snapshot.indexedAt)) {
    if (!testEdges.some((candidate) => candidate.path === edge.path && candidate.targetPath === edge.targetPath && candidate.reason === edge.reason)) {
      testEdges.push(edge);
    }
  }

  return {
    ...index,
    imports: resolvedImports,
    usageSites,
    testEdges
  };
}

function importedLocalNamesByPath(imports: ImportEdgeFact[]): Map<string, Set<string>> {
  const result = new Map<string, Set<string>>();
  for (const imp of imports) {
    const localName = imp.localName ?? imp.importedName;
    if (!localName || localName === "*" || localName === "default") {
      continue;
    }
    const names = result.get(imp.path) ?? new Set<string>();
    names.add(localName);
    result.set(imp.path, names);
  }
  return result;
}

function usesImportedLocal(usage: UsageSiteFact, importedLocalsByPath: Map<string, Set<string>>): boolean {
  const names = importedLocalsByPath.get(usage.path);
  if (!names || names.size === 0) {
    return false;
  }
  const rootName = usage.name.split(".")[0];
  return names.has(usage.name) || names.has(rootName);
}

function resolveImportPath(imp: ImportEdgeFact, files: Set<string>, aliases: ImportAliasRule[]): string | undefined {
  if (imp.specifier.startsWith(".")) {
    const candidate = pythonOrEcmaRelativeCandidate(imp.path, imp.specifier);
    if (imp.path.endsWith(".py") && imp.importedName && imp.importedName !== "*") {
      const importedAsModule = resolveCandidate(path.posix.join(candidate, imp.importedName), files);
      if (importedAsModule) {
        return importedAsModule;
      }
    }
    const resolved = resolveCandidate(candidate, files);
    if (resolved) {
      return resolved;
    }
    return undefined;
  }
  if (imp.path.endsWith(".rs")) {
    const rustCandidate = rustImportCandidate(imp.path, imp.specifier);
    if (rustCandidate) {
      const resolved = resolveCandidate(rustCandidate, files);
      if (resolved) {
        return resolved;
      }
    }
  }
  const aliasCandidate = resolveAliasCandidate(imp.specifier, imp.path, aliases);
  if (aliasCandidate !== undefined) {
    const resolved = resolveCandidate(aliasCandidate, files) ?? (imp.path.endsWith(".go") ? resolvePackageDirectoryCandidate(aliasCandidate, files, ".go") : undefined);
    if (resolved) {
      return resolved;
    }
  }
  if (imp.path.endsWith(".go")) {
    if (!imp.specifier.includes("/")) {
      return undefined;
    }
    return resolveCandidate(imp.specifier, files) ?? resolvePackageDirectoryCandidate(imp.specifier, files, ".go");
  }
  const dottedCandidate = imp.specifier.replace(/\./g, "/");
  const directResolved = resolveCandidate(imp.specifier, files);
  if (directResolved) {
    return directResolved;
  }
  if (imp.importedName && imp.importedName !== "*") {
    const importedDottedResolved = resolveCandidate(path.posix.join(dottedCandidate, imp.importedName), files);
    if (importedDottedResolved) {
      return importedDottedResolved;
    }
  }
  const dottedResolved = resolveCandidate(dottedCandidate, files);
  if (dottedResolved) {
    return dottedResolved;
  }
  if (imp.specifier.startsWith("/")) {
    return resolveCandidate(imp.specifier.slice(1), files);
  }
  return undefined;
}

function rustImportCandidate(importerPath: string, specifier: string): string | undefined {
  const normalized = specifier.replace(/::/gu, "/");
  if (specifier === "crate") {
    return "src";
  }
  if (specifier === "self") {
    return normalizePath(path.posix.dirname(importerPath));
  }
  if (specifier === "super") {
    return normalizePath(path.posix.dirname(path.posix.dirname(importerPath)));
  }
  if (specifier.startsWith("crate::")) {
    return normalizePath(path.posix.join("src", normalized.slice("crate/".length)));
  }
  if (specifier.startsWith("self::")) {
    return normalizePath(path.posix.join(path.posix.dirname(importerPath), normalized.slice("self/".length)));
  }
  if (specifier.startsWith("super::")) {
    let anchor = path.posix.dirname(importerPath);
    let rest = specifier;
    while (rest.startsWith("super::")) {
      anchor = path.posix.dirname(anchor);
      rest = rest.slice("super::".length);
    }
    return normalizePath(path.posix.join(anchor, rest.replace(/::/gu, "/")));
  }
  return undefined;
}

function resolveAliasCandidate(specifier: string, importerPath: string, aliases: ImportAliasRule[]): string | undefined {
  for (const alias of aliases) {
    if (alias.scopePrefix && importerPath !== alias.scopePrefix && !importerPath.startsWith(`${alias.scopePrefix}/`)) {
      continue;
    }
    if (alias.exact && specifier === alias.prefix) {
      return alias.targetPrefix;
    }
    if (!alias.exact && specifier.startsWith(alias.prefix)) {
      return normalizePath(`${alias.targetPrefix}${specifier.slice(alias.prefix.length)}`);
    }
  }
  return undefined;
}

function pythonOrEcmaRelativeCandidate(importerPath: string, specifier: string): string {
  const base = path.posix.dirname(importerPath);
  const dotMatch = /^(\.+)(.*)$/.exec(specifier);
  if (!dotMatch) {
    return normalizePath(path.posix.normalize(path.posix.join(base, specifier)));
  }
  const [, dots, rest] = dotMatch;
  let anchor = base;
  for (let i = 1; i < dots.length; i += 1) {
    anchor = path.posix.dirname(anchor);
  }
  const normalizedRest = importerPath.endsWith(".py") ? rest.replace(/\./g, "/") : rest;
  return normalizePath(path.posix.normalize(path.posix.join(anchor, normalizedRest)));
}

function resolveCandidate(candidate: string, files: Set<string>): string | undefined {
  const ext = path.posix.extname(candidate);
  const stem = ext ? candidate.slice(0, -ext.length) : candidate;
  const variants = [
    candidate,
    ...(ext === ".js" || ext === ".mjs" || ext === ".cjs" ? [`${stem}.ts`, `${stem}.tsx`, `${stem}.js`, `${stem}.jsx`] : []),
    ...(ext === ".jsx" ? [`${stem}.tsx`, `${stem}.jsx`] : []),
    `${candidate}.ts`,
    `${candidate}.tsx`,
    `${candidate}.js`,
    `${candidate}.jsx`,
    `${candidate}.py`,
    `${candidate}.rs`,
    `${candidate}.go`,
    `${candidate}.java`,
    `src/main/java/${candidate}.java`,
    `src/test/java/${candidate}.java`,
    `${candidate}.md`,
    `${candidate}.mdx`,
    `${candidate}.rst`,
    `${candidate}.txt`,
    `${candidate}/index.ts`,
    `${candidate}/index.tsx`,
    `${candidate}/index.js`,
    `${candidate}/__init__.py`,
    `${candidate}/lib.rs`,
    `${candidate}/mod.rs`
  ];
  return variants.find((variant) => files.has(variant));
}

function resolvePackageDirectoryCandidate(candidate: string, files: Set<string>, ext: ".go"): string | undefined {
  const normalized = candidate.replace(/\/+$/u, "");
  const prefix = normalized ? `${normalized}/` : "";
  const matches = [...files]
    .filter((file) => file.startsWith(prefix) && file.endsWith(ext) && !isTestPath(file) && (normalized || !file.includes("/")))
    .sort((a, b) => {
      const aDepth = a.slice(prefix.length).split("/").length;
      const bDepth = b.slice(prefix.length).split("/").length;
      if (aDepth !== bDepth) {
        return aDepth - bDepth;
      }
      return a.localeCompare(b);
    });
  return matches[0];
}

interface ImportBindings {
  exactByPath: Map<string, Map<string, SymbolFact>>;
  typeOnlyLocalsByPath: Map<string, Set<string>>;
  namespaceByPath: Map<string, Map<string, string>>;
  symbolsByPath: Map<string, SymbolFact[]>;
  reExports: ReExportBindings;
}

interface ReExportBindings {
  symbolsByPath: Map<string, Map<string, SymbolFact>>;
  ambiguousByPath: Map<string, Set<string>>;
}

function buildImportBindings(imports: ImportEdgeFact[], symbolsByPath: Map<string, SymbolFact[]>): ImportBindings {
  const exactByPath = new Map<string, Map<string, SymbolFact>>();
  const typeOnlyLocalsByPath = new Map<string, Set<string>>();
  const namespaceByPath = new Map<string, Map<string, string>>();
  const reExports = buildReExportBindings(imports, symbolsByPath);
  const addExact = (filePath: string, localName: string, symbol: SymbolFact) => {
    const existing = exactByPath.get(filePath) ?? new Map<string, SymbolFact>();
    existing.set(localName, symbol);
    exactByPath.set(filePath, existing);
  };
  const addNamespace = (filePath: string, localName: string, resolvedPath: string) => {
    const existing = namespaceByPath.get(filePath) ?? new Map<string, string>();
    existing.set(localName, resolvedPath);
    namespaceByPath.set(filePath, existing);
  };
  const addTypeOnlyLocal = (filePath: string, localName: string) => {
    const existing = typeOnlyLocalsByPath.get(filePath) ?? new Set<string>();
    existing.add(localName);
    typeOnlyLocalsByPath.set(filePath, existing);
  };

  for (const imp of imports) {
    if (!imp.resolvedPath) {
      continue;
    }
    const localName = imp.localName ?? imp.importedName;
    if (!localName) {
      continue;
    }
    if (imp.typeOnly && localName !== "*" && localName !== "default") {
      addTypeOnlyLocal(imp.path, localName);
    }
    if (imp.importedName === "*") {
      addNamespace(imp.path, localName, imp.resolvedPath);
      continue;
    }
    const target = resolveImportedSymbol(imp, symbolsByPath, reExports);
    if (target) {
      addExact(imp.path, localName, target);
    } else if (imp.localName && !imp.importedName) {
      addNamespace(imp.path, imp.localName, imp.resolvedPath);
    } else if (imp.localName && importedNameLooksLikeResolvedModule(imp)) {
      addNamespace(imp.path, imp.localName, imp.resolvedPath);
    }
  }

  return { exactByPath, typeOnlyLocalsByPath, namespaceByPath, symbolsByPath, reExports };
}

function importedNameLooksLikeResolvedModule(imp: ImportEdgeFact): boolean {
  if (!imp.resolvedPath || !imp.importedName || imp.importedName === "default") {
    return false;
  }
  const stem = path.posix.basename(imp.resolvedPath).replace(/\.[^.]+$/, "");
  const parent = path.posix.basename(path.posix.dirname(imp.resolvedPath));
  return imp.importedName === stem || (stem === "__init__" && imp.importedName === parent);
}

function buildReExportBindings(imports: ImportEdgeFact[], symbolsByPath: Map<string, SymbolFact[]>): ReExportBindings {
  const result: ReExportBindings = { symbolsByPath: new Map(), ambiguousByPath: new Map() };
  const add = (filePath: string, name: string, symbol: SymbolFact): boolean => {
    if (isAmbiguousReExport(result, filePath, name)) {
      return false;
    }
    const existing = result.symbolsByPath.get(filePath) ?? new Map<string, SymbolFact>();
    const previous = existing.get(name);
    if (previous && previous.id !== symbol.id) {
      existing.delete(name);
      result.symbolsByPath.set(filePath, existing);
      const ambiguous = result.ambiguousByPath.get(filePath) ?? new Set<string>();
      ambiguous.add(name);
      result.ambiguousByPath.set(filePath, ambiguous);
      return true;
    }
    if (previous?.id === symbol.id) {
      return false;
    }
    existing.set(name, symbol);
    result.symbolsByPath.set(filePath, existing);
    return true;
  };
  for (let pass = 0; pass < 8; pass += 1) {
    let changed = false;
    for (const imp of imports) {
      if (!imp.resolvedPath || (!imp.reExport && !imp.path.endsWith("__init__.py"))) {
        continue;
      }
      const candidates = symbolsByPath.get(imp.resolvedPath) ?? [];
      if (imp.importedName === "default" && imp.localName) {
        const defaultMatch = exactSymbolInPath(candidates, "default") ?? lookupReExport(result, imp.resolvedPath, "default");
        if (defaultMatch) {
          changed = add(imp.path, imp.localName, defaultMatch) || changed;
          if (imp.localName === "default") {
            changed = add(imp.path, "default", defaultMatch) || changed;
          }
        }
        continue;
      }
      if (imp.importedName === "*") {
        for (const symbol of candidates.filter((candidate) => candidate.exported || !candidate.parentSymbolId)) {
          changed = add(imp.path, symbol.name, symbol) || changed;
          changed = add(imp.path, symbol.qualifiedName, symbol) || changed;
        }
        for (const [name, symbol] of result.symbolsByPath.get(imp.resolvedPath) ?? []) {
          changed = add(imp.path, name, symbol) || changed;
        }
        for (const name of result.ambiguousByPath.get(imp.resolvedPath) ?? []) {
          markAmbiguous(result, imp.path, name);
        }
        continue;
      }
      const names = uniqueNames([imp.importedName, imp.localName].filter((name): name is string => Boolean(name)));
      for (const name of names) {
        const matched = exactSymbolInPath(candidates, name) ?? lookupReExport(result, imp.resolvedPath, name);
        if (matched) {
          changed = add(imp.path, name, matched) || changed;
          if (imp.localName) {
            changed = add(imp.path, imp.localName, matched) || changed;
          }
        }
      }
    }
    if (!changed) {
      break;
    }
  }
  return result;
}

function isAmbiguousReExport(bindings: ReExportBindings, filePath: string, name: string): boolean {
  return bindings.ambiguousByPath.get(filePath)?.has(name) ?? false;
}

function markAmbiguous(bindings: ReExportBindings, filePath: string, name: string): void {
  bindings.symbolsByPath.get(filePath)?.delete(name);
  const ambiguous = bindings.ambiguousByPath.get(filePath) ?? new Set<string>();
  ambiguous.add(name);
  bindings.ambiguousByPath.set(filePath, ambiguous);
}

function lookupReExport(bindings: ReExportBindings, filePath: string, name: string): SymbolFact | undefined {
  if (isAmbiguousReExport(bindings, filePath, name)) {
    return undefined;
  }
  return bindings.symbolsByPath.get(filePath)?.get(name);
}

function resolveImportedSymbol(
  imp: ImportEdgeFact,
  symbolsByPath: Map<string, SymbolFact[]>,
  reExports: ReExportBindings
): SymbolFact | undefined {
  if (!imp.resolvedPath) {
    return undefined;
  }
  const candidates = symbolsByPath.get(imp.resolvedPath) ?? [];
  if (imp.importedName === "default" && imp.localName) {
    const defaultMatch = exactSymbolInPath(candidates, "default") ?? lookupReExport(reExports, imp.resolvedPath, "default");
    if (defaultMatch) {
      return defaultMatch;
    }
    return undefined;
  }
  const names = uniqueNames([imp.importedName, imp.localName].filter((name): name is string => Boolean(name) && name !== "*" && name !== "default"));
  for (const name of names) {
    if (imp.resolvedPath.endsWith("__init__.py")) {
      const reExport = lookupReExport(reExports, imp.resolvedPath, name);
      if (reExport) {
        return reExport;
      }
    }
    const matched = exactSymbolInPath(candidates, name);
    if (matched) {
      return matched;
    }
    const reExport = lookupReExport(reExports, imp.resolvedPath, name);
    if (reExport) {
      return reExport;
    }
  }
  return undefined;
}

function resolveImportedUsage(usage: UsageSiteFact, bindings: ImportBindings): SymbolFact | undefined {
  const exact = bindings.exactByPath.get(usage.path);
  if (usage.kind !== "type_reference" && importedLocalMatches(usage, bindings.typeOnlyLocalsByPath)) {
    return undefined;
  }
  const direct = exact?.get(usage.name);
  if (direct) {
    return direct;
  }

  const [prefix, ...rest] = usage.name.split(".");
  if (!prefix || rest.length === 0) {
    return undefined;
  }
  const prefixTarget = exact?.get(prefix);
  if (prefixTarget) {
    if (prefixTarget.kind === "variable") {
      const candidates = bindings.symbolsByPath.get(prefixTarget.path) ?? [];
      const memberChain = rest.join(".");
      return exactSymbolInPath(candidates, `${prefixTarget.qualifiedName}.${memberChain}`) ?? exactSymbolInPath(candidates, `${prefixTarget.name}.${memberChain}`);
    }
    const qualifiedMember = `${prefixTarget.qualifiedName}.${rest.join(".")}`;
    const memberChain = rest.join(".");
    const member = rest.at(-1);
    const candidates = bindings.symbolsByPath.get(prefixTarget.path) ?? [];
    return member
      ? exactSymbolInPath(candidates, qualifiedMember) ??
          exactSymbolInPath(candidates, memberChain) ??
          exactSymbolInPath(candidates, member) ??
          lookupReExport(bindings.reExports, prefixTarget.path, memberChain) ??
          lookupReExport(bindings.reExports, prefixTarget.path, member)
      : undefined;
  }
  const namespacePath = bindings.namespaceByPath.get(usage.path)?.get(prefix);
  if (!namespacePath) {
    return undefined;
  }
  const memberChain = rest.join(".");
  const member = rest.at(-1);
  if (!member) {
    return undefined;
  }
  const candidates = namespaceSymbols(namespacePath, bindings);
  return (
    exactSymbolInPath(candidates, memberChain) ??
    exactSymbolInPath(candidates, member) ??
    lookupReExport(bindings.reExports, namespacePath, memberChain) ??
    lookupReExport(bindings.reExports, namespacePath, member)
  );
}

function namespaceSymbols(namespacePath: string, bindings: ImportBindings): SymbolFact[] {
  const direct = bindings.symbolsByPath.get(namespacePath) ?? [];
  if (!namespacePath.endsWith(".go")) {
    return direct;
  }
  const packageDir = path.posix.dirname(namespacePath);
  const symbols = new Map<string, SymbolFact>();
  for (const [filePath, fileSymbols] of bindings.symbolsByPath) {
    if (filePath.endsWith(".go") && !isTestPath(filePath) && path.posix.dirname(filePath) === packageDir) {
      for (const symbol of fileSymbols) {
        symbols.set(symbol.id, symbol);
      }
    }
  }
  return [...symbols.values()];
}

function importedLocalMatches(usage: UsageSiteFact, localsByPath: Map<string, Set<string>>): boolean {
  const locals = localsByPath.get(usage.path);
  if (!locals) {
    return false;
  }
  const root = usage.name.split(".")[0];
  return locals.has(usage.name) || locals.has(root);
}

function exactSymbolInPath(symbols: SymbolFact[], name: string): SymbolFact | undefined {
  const matches = symbols.filter((symbol) => symbol.name === name || symbol.qualifiedName === name || symbol.qualifiedName.endsWith(`.${name}`));
  if (matches.length === 1) {
    return matches[0];
  }
  const topLevel = matches.filter((symbol) => !symbol.parentSymbolId);
  if (topLevel.length === 1) {
    return topLevel[0];
  }
  const exported = matches.filter((symbol) => symbol.exported);
  if (exported.length === 1) {
    return exported[0];
  }
  return undefined;
}

function importTestEdges(imports: ImportEdgeFact[], snapshotId: string, indexedAt: string): TestEdgeFact[] {
  return imports
    .filter((imp) => !imp.typeOnly && isTestPath(imp.path) && Boolean(imp.resolvedPath) && imp.resolvedPath !== imp.path)
    .map((imp) => ({
      id: stableId("test-edge-import", imp.path, imp.resolvedPath, imp.localName ?? imp.importedName ?? imp.specifier, imp.range?.startByte ?? 0),
      type: "TestEdge" as const,
      path: imp.path,
      targetPath: imp.resolvedPath,
      reason: `imports ${imp.resolvedPath}`,
      source: "tree-sitter" as const,
      confidence: "authoritative" as const,
      snapshotId,
      indexedAt,
      range: imp.range
    }));
}

function uniqueNames(names: string[]): string[] {
  return [...new Set(names)];
}

function inferTestTarget(testPath: string, files: Set<string>): string | undefined {
  const normalized = testPath
    .replace(/(^|\/)tests\//, "$1")
    .replace(/(^|\/)__tests__\//, "$1")
    .replace(/\.test\.([cm]?[jt]sx?)$/, ".$1")
    .replace(/\.spec\.([cm]?[jt]sx?)$/, ".$1")
    .replace(/(^|\/)test_([^/]+)\.py$/, "$1$2.py")
    .replace(/(^|\/)([^/]+)_test\.py$/, "$1$2.py");
  if (files.has(normalized)) {
    return normalized;
  }
  // Prefer a unique file whose path ends with the full normalized relative path,
  // so tests/api/test_handlers.py -> api/handlers.py binds to src/api/handlers.py
  // even when another package also has a handlers.py.
  const suffixMatches = [...files].filter((file) => file === normalized || file.endsWith(`/${normalized}`));
  if (suffixMatches.length === 1) {
    return suffixMatches[0];
  }
  // Basename-only fallback: bind the test to a source file iff exactly one file
  // in the repo carries that basename. With duplicate basenames (handlers.py,
  // index.ts, utils.py across packages) an arbitrary first-match would emit a
  // cross-module TESTS edge that corrupts blast radius and test recommendations.
  // A wrong edge is worse than no edge, so refuse the guess when ambiguous.
  const base = path.posix.basename(normalized);
  const candidates = [...files].filter((file) => path.posix.basename(file) === base);
  return candidates.length === 1 ? candidates[0] : undefined;
}

export function relinkUsageIds(index: CodexaIndex): CodexaIndex {
  const usageSites = index.usageSites.map((usage) => ({
    ...usage,
    id: stableId("usage", usage.path, usage.name, usage.kind, usage.range?.startByte ?? 0, usage.targetSymbolId)
  }));
  return { ...index, usageSites };
}
