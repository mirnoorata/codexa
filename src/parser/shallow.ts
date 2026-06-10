import type { ImportEdgeFact, SymbolFact, UsageSiteFact } from "../types.js";
import { stableId } from "../util.js";
import type { ExtractContext } from "./context.js";
import { baseFact, rangeFromOffsets } from "./facts.js";

interface LineInfo {
  text: string;
  start: number;
}

interface ScopeFrame {
  name: string;
  depth: number;
}

interface CommentState {
  blockComment: boolean;
  rawBacktickString: boolean;
  textBlockString: boolean;
  rustRawStringHashes?: number;
}

const CALL_SKIP = new Set([
  "catch",
  "for",
  "if",
  "import",
  "new",
  "return",
  "switch",
  "while"
]);

export function extractShallowSource(ctx: ExtractContext): void {
  if (ctx.language === "rust") {
    extractRust(ctx);
  } else if (ctx.language === "go") {
    extractGo(ctx);
  } else if (ctx.language === "java") {
    extractJava(ctx);
  }
}

export function supportsShallowSourceExtraction(language: ExtractContext["language"]): boolean {
  return language === "rust" || language === "go" || language === "java";
}

function extractRust(ctx: ExtractContext): void {
  let braceDepth = 0;
  let nextFunctionIsTest = false;
  const commentState: CommentState = { blockComment: false, rawBacktickString: false, textBlockString: false };
  const implScopes: ScopeFrame[] = [];
  const moduleScopes: ScopeFrame[] = [];

  for (const line of sourceLines(ctx.sourceText)) {
    const code = stripComments(line.text, commentState);
    const trimmed = code.trim();
    if (/^#\[\s*(?:[A-Za-z_]\w*::)?test\b/u.test(trimmed)) {
      nextFunctionIsTest = true;
      continue;
    }
    while (implScopes.length > 0 && braceDepth < implScopes[implScopes.length - 1].depth) {
      implScopes.pop();
    }
    while (moduleScopes.length > 0 && braceDepth < moduleScopes[moduleScopes.length - 1].depth) {
      moduleScopes.pop();
    }

    const moduleBlock = /^\s*(?:pub(?:\([^)]*\))?\s+)?mod\s+([A-Za-z_]\w*)\s*\{/u.exec(code);
    if (moduleBlock) {
      moduleScopes.push({ name: moduleBlock[1], depth: braceDepth + 1 });
    }

    const moduleImport = /^\s*(?:pub(?:\([^)]*\))?\s+)?mod\s+([A-Za-z_]\w*)\s*;/u.exec(code);
    if (moduleImport) {
      const name = moduleImport[1];
      addImport(ctx, line.start + code.indexOf("mod"), line.start + code.length, `./${name}`, name, name);
      addUsage(ctx, line.start + code.indexOf(name), line.start + code.indexOf(name) + name.length, name, "import", trimmed);
    }

    for (const imp of rustUseImports(trimmed)) {
      addImport(ctx, line.start, line.start + code.length, imp.specifier, imp.importedName, imp.localName);
      addUsage(ctx, line.start, line.start + code.length, imp.localName ?? imp.importedName ?? imp.specifier, "import", trimmed);
    }

    const implMatch = /^\s*impl(?:\s*<[^>]+>)?\s+(?:(?:[A-Za-z_]\w*(?:::[A-Za-z_]\w*)*)\s+for\s+)?([A-Za-z_]\w*)/u.exec(code);
    if (implMatch) {
      implScopes.push({ name: implMatch[1], depth: braceDepth + Math.max(1, countBraceDelta(code)) });
    }

    const typeMatch = /^\s*(pub(?:\([^)]*\))?\s+)?(struct|enum|trait|type)\s+([A-Za-z_]\w*)/u.exec(code);
    if (typeMatch) {
      const [, exportedPrefix, rustKind, name] = typeMatch;
      addSymbol(ctx, line.start + code.indexOf(name), line.start + code.indexOf(name) + name.length, name, qualify(moduleScopes, name), rustSymbolKind(rustKind), Boolean(exportedPrefix));
    }

    const functionMatch = /^\s*(pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)/u.exec(code);
    if (functionMatch) {
      const [, exportedPrefix, name] = functionMatch;
      const implScope = implScopes.at(-1);
      const qualifiedName = implScope ? `${implScope.name}.${name}` : qualify(moduleScopes, name);
      const symbol = addSymbol(ctx, line.start + code.indexOf(name), line.start + code.indexOf(name) + name.length, name, qualifiedName, implScope ? "method" : "function", Boolean(exportedPrefix));
      addTestEdge(ctx, symbol, nextFunctionIsTest || /^test_/u.test(name));
      nextFunctionIsTest = false;
    } else {
      addCallUsages(ctx, line, code);
    }

    braceDepth += countBraceDelta(code);
  }
}

function extractGo(ctx: ExtractContext): void {
  let inImportBlock = false;
  const commentState: CommentState = { blockComment: false, rawBacktickString: false, textBlockString: false };

  for (const line of sourceLines(ctx.sourceText)) {
    const code = stripComments(line.text, commentState);
    const trimmed = code.trim();
    if (!trimmed) {
      continue;
    }

    if (/^import\s*\(/u.test(trimmed)) {
      inImportBlock = true;
      continue;
    }
    if (inImportBlock && trimmed === ")") {
      inImportBlock = false;
      continue;
    }
    if (inImportBlock) {
      const imp = goImport(trimmed);
      if (imp) {
        const localName = imp.localName ?? packageNameFromSpecifier(imp.specifier);
        addImport(ctx, line.start, line.start + code.length, imp.specifier, undefined, localName);
        addUsage(ctx, line.start, line.start + code.length, localName, "import", trimmed);
      }
      continue;
    }

    const singleImport = /^import\s+(.+)$/u.exec(trimmed);
    if (singleImport) {
      const imp = goImport(singleImport[1]);
      if (imp) {
        const localName = imp.localName ?? packageNameFromSpecifier(imp.specifier);
        addImport(ctx, line.start, line.start + code.length, imp.specifier, undefined, localName);
        addUsage(ctx, line.start, line.start + code.length, localName, "import", trimmed);
      }
      continue;
    }

    const typeMatch = /^\s*type\s+([A-Za-z_]\w*)\s+(struct|interface|func|=|\w+)/u.exec(code);
    if (typeMatch) {
      const [, name, goKind] = typeMatch;
      addSymbol(ctx, line.start + code.indexOf(name), line.start + code.indexOf(name) + name.length, name, name, goSymbolKind(goKind), goNameExported(name));
    }

    const methodMatch = /^\s*func\s*\(\s*(?:[A-Za-z_]\w*\s+)?\*?([A-Za-z_]\w*)\s*\)\s*([A-Za-z_]\w*)\s*\(/u.exec(code);
    if (methodMatch) {
      const [, receiver, name] = methodMatch;
      const symbol = addSymbol(ctx, line.start + code.indexOf(name), line.start + code.indexOf(name) + name.length, name, `${receiver}.${name}`, "method", goNameExported(name));
      addTestEdge(ctx, symbol, goTestName(name));
      continue;
    }

    const functionMatch = /^\s*func\s+([A-Za-z_]\w*)\s*\(/u.exec(code);
    if (functionMatch) {
      const name = functionMatch[1];
      const symbol = addSymbol(ctx, line.start + code.indexOf(name), line.start + code.indexOf(name) + name.length, name, name, "function", goNameExported(name));
      addTestEdge(ctx, symbol, goTestName(name));
      continue;
    }

    const variableMatch = /^\s*(?:var|const)\s+([A-Za-z_]\w*)\b/u.exec(code);
    if (variableMatch) {
      const name = variableMatch[1];
      addSymbol(ctx, line.start + code.indexOf(name), line.start + code.indexOf(name) + name.length, name, name, "variable", goNameExported(name));
    }
    addCallUsages(ctx, line, code);
  }
}

function extractJava(ctx: ExtractContext): void {
  let braceDepth = 0;
  const commentState: CommentState = { blockComment: false, rawBacktickString: false, textBlockString: false };
  const classScopes: ScopeFrame[] = [];

  for (const line of sourceLines(ctx.sourceText)) {
    const code = stripComments(line.text, commentState);
    const trimmed = code.trim();
    while (classScopes.length > 0 && braceDepth < classScopes[classScopes.length - 1].depth) {
      classScopes.pop();
    }

    const importMatch = /^\s*import\s+(static\s+)?([A-Za-z_][\w.]*)(?:\.\*)?\s*;/u.exec(code);
    if (importMatch) {
      const isStatic = Boolean(importMatch[1]);
      const fullName = importMatch[2];
      const parts = fullName.split(".");
      const localName = parts.at(-1);
      const owner = isStatic ? parts.slice(0, -1).join(".") : fullName;
      addImport(ctx, line.start, line.start + code.length, owner, isStatic ? localName : undefined, localName);
      addUsage(ctx, line.start, line.start + code.length, localName ?? owner, "import", trimmed);
      braceDepth += countBraceDelta(code);
      continue;
    }

    const classMatch = /^\s*(public\s+)?(?:abstract\s+|final\s+|sealed\s+|non-sealed\s+)*?(class|interface|enum|record)\s+([A-Za-z_]\w*)/u.exec(code);
    if (classMatch) {
      const [, exportedPrefix, javaKind, name] = classMatch;
      const symbol = addSymbol(ctx, line.start + code.indexOf(name), line.start + code.indexOf(name) + name.length, name, qualify(classScopes, name), javaSymbolKind(javaKind), Boolean(exportedPrefix));
      classScopes.push({ name: symbol.qualifiedName, depth: braceDepth + Math.max(1, countBraceDelta(code)) });
      braceDepth += countBraceDelta(code);
      continue;
    }

    const methodMatch = /^\s*(?:(?:public|protected|private|static|final|synchronized|abstract|native|default)\s+)*(?:<[^>]+>\s*)?[\w<>\[\].?,]+\s+([A-Za-z_]\w*)\s*\([^;]*\)\s*(?:throws\s+[^{]+)?[{;]/u.exec(code);
    if (methodMatch && !CALL_SKIP.has(methodMatch[1])) {
      const name = methodMatch[1];
      const classScope = classScopes.at(-1);
      const symbol = addSymbol(ctx, line.start + code.indexOf(name), line.start + code.indexOf(name) + name.length, name, classScope ? `${classScope.name}.${name}` : name, classScope ? "method" : "function", /^\s*public\b/u.test(code));
      addTestEdge(ctx, symbol, /^test[A-Z_]/u.test(name));
    } else {
      addCallUsages(ctx, line, code);
    }

    braceDepth += countBraceDelta(code);
  }
}

function sourceLines(sourceText: string): LineInfo[] {
  const result: LineInfo[] = [];
  let start = 0;
  for (const text of sourceText.split(/(?<=\n)/u)) {
    result.push({ text, start });
    start += text.length;
  }
  return result;
}

function addSymbol(
  ctx: ExtractContext,
  start: number,
  end: number,
  name: string,
  qualifiedName: string,
  kind: SymbolFact["kind"],
  exported: boolean,
  parentSymbolId?: string
): SymbolFact {
  const range = rangeFromOffsets(ctx.sourceText, start, end);
  const symbol: SymbolFact = {
    ...baseFact("Symbol", ctx.path, ctx.snapshotId, ctx.indexedAt, "heuristic", "derived", range),
    id: stableId("shallow-symbol", ctx.path, qualifiedName, kind, range.startByte),
    type: "Symbol",
    path: ctx.path,
    name,
    qualifiedName,
    kind,
    language: ctx.language,
    exported,
    decorators: [],
    parentSymbolId
  };
  if (!ctx.symbols.some((candidate) => candidate.id === symbol.id)) {
    ctx.symbols.push(symbol);
  }
  return symbol;
}

function addImport(
  ctx: ExtractContext,
  start: number,
  end: number,
  specifier: string,
  importedName?: string,
  localName?: string
): ImportEdgeFact {
  const range = rangeFromOffsets(ctx.sourceText, start, end);
  const imp: ImportEdgeFact = {
    ...baseFact("ImportEdge", ctx.path, ctx.snapshotId, ctx.indexedAt, "heuristic", "derived", range),
    id: stableId("shallow-import", ctx.path, specifier, importedName, localName, range.startByte),
    type: "ImportEdge",
    path: ctx.path,
    specifier,
    importedName,
    localName
  };
  if (!ctx.imports.some((candidate) => candidate.id === imp.id)) {
    ctx.imports.push(imp);
  }
  return imp;
}

function addUsage(
  ctx: ExtractContext,
  start: number,
  end: number,
  name: string,
  kind: UsageSiteFact["kind"],
  text: string,
  usedBySymbolId?: string
): void {
  if (!name) {
    return;
  }
  const range = rangeFromOffsets(ctx.sourceText, start, end);
  const usage: UsageSiteFact = {
    ...baseFact("UsageSite", ctx.path, ctx.snapshotId, ctx.indexedAt, "heuristic", "derived", range),
    id: stableId("shallow-usage", ctx.path, name, kind, range.startByte),
    type: "UsageSite",
    path: ctx.path,
    name,
    kind,
    usedBySymbolId,
    text: text.replace(/\s+/g, " ").slice(0, 240)
  };
  if (!ctx.usageSites.some((candidate) => candidate.id === usage.id)) {
    ctx.usageSites.push(usage);
  }
}

function addCallUsages(ctx: ExtractContext, line: LineInfo, code: string): void {
  const callCode = maskStringLiterals(code);
  for (const match of callCode.matchAll(/\b([A-Za-z_]\w*(?:(?:\.|::)[A-Za-z_]\w*)?)\s*\(/gu)) {
    const name = match[1];
    const rootName = name.split(/\.|::/u)[0];
    if (CALL_SKIP.has(rootName)) {
      continue;
    }
    const start = line.start + (match.index ?? 0);
    addUsage(ctx, start, start + name.length, name, "call", code.trim());
  }
}

function addTestEdge(ctx: ExtractContext, symbol: SymbolFact, isTest: boolean): void {
  if (!ctx.test || !isTest) {
    return;
  }
  ctx.testEdges.push({
    ...baseFact("TestEdge", ctx.path, ctx.snapshotId, ctx.indexedAt, "heuristic", "derived", symbol.range),
    id: stableId("shallow-test-edge", ctx.path, symbol.qualifiedName),
    type: "TestEdge",
    path: ctx.path,
    reason: `${ctx.language} test symbol ${symbol.name}`
  });
}

function stripComments(line: string, state: CommentState): string {
  let quote: '"' | "'" | "`" | undefined;
  let escaped = false;
  let code = "";
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (state.rawBacktickString) {
      code += " ";
      if (char === "`") {
        state.rawBacktickString = false;
      }
      continue;
    }
    if (state.textBlockString) {
      if (line.startsWith("\"\"\"", i)) {
        code += "   ";
        i += 2;
        state.textBlockString = false;
      } else {
        code += " ";
      }
      continue;
    }
    if (state.rustRawStringHashes !== undefined) {
      code += " ";
      if (char === "\"" && rustRawStringTerminatorAt(line, i + 1, state.rustRawStringHashes)) {
        code += " ".repeat(state.rustRawStringHashes);
        i += state.rustRawStringHashes;
        state.rustRawStringHashes = undefined;
      }
      continue;
    }
    if (state.blockComment) {
      code += " ";
      if (char === "*" && line[i + 1] === "/") {
        code += " ";
        i += 1;
        state.blockComment = false;
      }
      continue;
    }
    if (quote) {
      code += char;
      if (quote !== "`" && escaped) {
        escaped = false;
      } else if (quote !== "`" && char === "\\") {
        escaped = true;
      } else if (char === quote) {
        quote = undefined;
      }
      continue;
    }
    const rustRawStart = rustRawStringStartAt(line, i);
    if (rustRawStart) {
      code += " ".repeat(rustRawStart.length);
      i += rustRawStart.length - 1;
      state.rustRawStringHashes = rustRawStart.hashes;
      continue;
    }
    if (line.startsWith("\"\"\"", i)) {
      code += "   ";
      i += 2;
      state.textBlockString = true;
      continue;
    }
    if (char === "`") {
      code += " ";
      state.rawBacktickString = true;
      continue;
    }
    if (char === "\"" || char === "`" || (char === "'" && isSingleQuotedLiteralStart(line, i))) {
      quote = char;
      code += char;
      continue;
    }
    if (char === "/" && line[i + 1] === "*") {
      code += "  ";
      i += 1;
      state.blockComment = true;
      continue;
    }
    if (char === "/" && line[i + 1] === "/") {
      return `${code}${" ".repeat(line.length - i)}`;
    }
    code += char;
  }
  return code;
}

function countBraceDelta(value: string): number {
  let delta = 0;
  for (const char of maskStringLiterals(value)) {
    if (char === "{") {
      delta += 1;
    } else if (char === "}") {
      delta -= 1;
    }
  }
  return delta;
}

function maskStringLiterals(value: string): string {
  let quote: '"' | "'" | "`" | undefined;
  let escaped = false;
  let masked = "";
  for (let i = 0; i < value.length; i += 1) {
    const char = value[i];
    if (quote) {
      masked += " ";
      if (quote !== "`" && escaped) {
        escaped = false;
      } else if (quote !== "`" && char === "\\") {
        escaped = true;
      } else if (char === quote) {
        quote = undefined;
      }
      continue;
    }
    if (char === "\"" || char === "`" || (char === "'" && isSingleQuotedLiteralStart(value, i))) {
      quote = char;
      masked += " ";
      continue;
    }
    masked += char;
  }
  return masked;
}

function isSingleQuotedLiteralStart(value: string, start: number): boolean {
  const previous = value[start - 1];
  if (previous && /[A-Za-z0-9_<&]/u.test(previous)) {
    return false;
  }
  let escaped = false;
  for (let i = start + 1; i < value.length; i += 1) {
    const char = value[i];
    if (char === "\n" || char === "\r") {
      return false;
    }
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === "'") {
      return i > start + 1;
    }
    if (/\s/u.test(char) || /[<>()\[\],;:&]/u.test(char)) {
      return false;
    }
  }
  return false;
}

function rustRawStringStartAt(value: string, start: number): { hashes: number; length: number } | undefined {
  const previous = value[start - 1];
  if (previous && /[A-Za-z0-9_]/u.test(previous)) {
    return undefined;
  }
  let cursor = start;
  if (value[cursor] === "b") {
    cursor += 1;
  }
  if (value[cursor] !== "r") {
    return undefined;
  }
  cursor += 1;
  let hashes = 0;
  while (value[cursor] === "#") {
    hashes += 1;
    cursor += 1;
  }
  if (value[cursor] !== "\"") {
    return undefined;
  }
  return { hashes, length: cursor - start + 1 };
}

function rustRawStringTerminatorAt(value: string, hashStart: number, hashes: number): boolean {
  for (let offset = 0; offset < hashes; offset += 1) {
    if (value[hashStart + offset] !== "#") {
      return false;
    }
  }
  return true;
}

function qualify(scopes: ScopeFrame[], name: string): string {
  return [...scopes.map((scope) => scope.name), name].join(".");
}

function rustSymbolKind(kind: string): SymbolFact["kind"] {
  if (kind === "trait") {
    return "interface";
  }
  return kind === "struct" || kind === "enum" || kind === "type" ? "type" : "unknown";
}

function rustUseImports(text: string): Array<{ specifier: string; importedName?: string; localName?: string }> {
  if (!text.startsWith("use ") || !text.endsWith(";")) {
    return [];
  }
  const raw = text.replace(/^use\s+/u, "").replace(/;$/u, "").trim();
  const brace = /^(.*)::\{(.+)\}$/u.exec(raw);
  if (brace) {
    const specifier = brace[1];
    return brace[2]
      .split(",")
      .map((part) => rustUseImportPart(specifier, part.trim()))
      .filter((part): part is { specifier: string; importedName?: string; localName?: string } => Boolean(part));
  }
  const parts = raw.split("::");
  const imported = parts.pop();
  const specifier = parts.join("::");
  return imported ? [rustUseImportPart(specifier || raw, imported)].filter((part): part is { specifier: string; importedName?: string; localName?: string } => Boolean(part)) : [];
}

function rustUseImportPart(specifier: string, rawPart: string): { specifier: string; importedName?: string; localName?: string } | null {
  if (!rawPart || rawPart === "self") {
    return null;
  }
  const alias = /^([A-Za-z_]\w*)\s+as\s+([A-Za-z_]\w*)$/u.exec(rawPart);
  if (alias) {
    return { specifier, importedName: alias[1], localName: alias[2] };
  }
  if (/^[A-Za-z_]\w*$|^\*$/u.test(rawPart)) {
    return { specifier, importedName: rawPart, localName: rawPart === "*" ? undefined : rawPart };
  }
  return null;
}

function goImport(text: string): { specifier: string; localName?: string } | null {
  const match = /^(?:(\.|_|[A-Za-z_]\w*)\s+)?["`]([^"`]+)["`]$/u.exec(text.trim());
  if (!match) {
    return null;
  }
  return { specifier: match[2], localName: match[1] && match[1] !== "_" ? match[1] : undefined };
}

function goSymbolKind(kind: string): SymbolFact["kind"] {
  if (kind === "struct") {
    return "class";
  }
  if (kind === "interface") {
    return "interface";
  }
  return "type";
}

function goNameExported(name: string): boolean {
  return /^[A-Z]/u.test(name);
}

function goTestName(name: string): boolean {
  return /^(Test|Benchmark|Fuzz)[A-Z_]/u.test(name);
}

function packageNameFromSpecifier(specifier: string): string {
  return specifier.split("/").at(-1) ?? specifier;
}

function javaSymbolKind(kind: string): SymbolFact["kind"] {
  if (kind === "class" || kind === "record") {
    return "class";
  }
  if (kind === "interface") {
    return "interface";
  }
  if (kind === "enum") {
    return "enum";
  }
  return "unknown";
}
