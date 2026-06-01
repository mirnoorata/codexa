import type { SymbolFact } from "../types.js";
import { stableId } from "../util.js";
import type { ExtractContext, SyntaxNode } from "./context.js";
import { baseFact, importFact, rangeOf, riskFact, symbolFact, usageFact } from "./facts.js";
import { callName, decoratorsForNode } from "./nodes.js";
import { decoratorName, isRouteDecorator, isTaskDecorator, routeEndpointsFromDecorator } from "./routes.js";

const PYTHON_DEFINITION_TYPES = new Set(["class_definition", "function_definition", "async_function_definition"]);

export function extractPython(root: SyntaxNode, ctx: ExtractContext): void {
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
          for (const baseName of pythonClassBaseNames(definition)) {
            ctx.usageSites.push(usageFact(ctx, definition, baseName, "type_reference", `extends ${baseName}`, symbol.id, "derived"));
          }
        } else {
          childScope = "function";
        }
        addPythonFrameworkHints(ctx, definition, symbol, pendingDecorators);
        if (kind === "fixture") {
          for (const param of pythonParameterNames(definition)) {
            ctx.usageSites.push(usageFact(ctx, definition, param, "test_reference", `fixture dependency ${param}`, symbol.id, "derived"));
          }
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
        addPythonImportFrameworkHint(ctx, node, imp);
      }
    }

    if (node.type === "call") {
      const name = callName(node);
      if (name) {
        ctx.usageSites.push(usageFact(ctx, node, name, "call", node.text, parentSymbolId, "derived"));
        addPythonCallFrameworkHint(ctx, node, name);
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
  const body = parameters.text.replace(/^\(/, "").replace(/\)$/, "");
  const result: string[] = [];
  for (const rawPart of splitTopLevel(body, ",")) {
    const cleaned = rawPart
      .trim()
      .replace(/^[*/\s]+/, "")
      .replace(/\s*=.*$/s, "")
      .replace(/\s*:.*$/s, "")
      .trim();
    if (!cleaned || ["self", "cls"].includes(cleaned)) {
      continue;
    }
    if (/^[A-Za-z_]\w*$/.test(cleaned)) {
      result.push(cleaned);
    }
  }
  return [...new Set(result)].sort();
}

function splitTopLevel(value: string, delimiter: string): string[] {
  const result: string[] = [];
  let current = "";
  let depth = 0;
  let quote: string | undefined;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    const previous = value[index - 1];
    if (quote) {
      current += char;
      if (char === quote && previous !== "\\") {
        quote = undefined;
      }
      continue;
    }
    if (char === "'" || char === "\"") {
      quote = char;
      current += char;
      continue;
    }
    if (char === "(" || char === "[" || char === "{") {
      depth += 1;
    } else if (char === ")" || char === "]" || char === "}") {
      depth = Math.max(0, depth - 1);
    }
    if (char === delimiter && depth === 0) {
      result.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  result.push(current);
  return result;
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

function pythonClassBaseNames(node: SyntaxNode): string[] {
  const match = /^class\s+[A-Za-z_][\w]*\s*\(([^)]*)\)/s.exec(node.text.trim());
  if (!match) {
    return [];
  }
  return match[1]
    .split(",")
    .map((part) =>
      part
        .trim()
        .replace(/\[.*$/s, "")
        .replace(/\(.*$/s, "")
        .split(".")
        .filter(Boolean)
        .join(".")
    )
    .filter(Boolean)
    .slice(0, 12);
}

function addPythonFrameworkHints(ctx: ExtractContext, node: SyntaxNode, symbol: SymbolFact, decorators: string[]): void {
  if (ctx.language !== "python") {
    return;
  }
  const bases = symbol.kind === "class" ? pythonClassBaseNames(node) : [];
  if (symbol.kind === "route") {
    ctx.risks.push(riskFact(ctx, node, "fastapi-route", 2, `${symbol.qualifiedName} is registered by a route decorator`));
  }
  if (decorators.some((decorator) => /(celery|shared_task|\.task|@task|@job)/i.test(decorator))) {
    ctx.risks.push(riskFact(ctx, node, "celery-task", 2, `${symbol.qualifiedName} is registered as a background task`));
  }
  if (bases.some((base) => /\b(BaseModel|pydantic\.BaseModel)\b/.test(base))) {
    ctx.risks.push(riskFact(ctx, node, "pydantic-model", 1.8, `${symbol.qualifiedName} inherits from Pydantic BaseModel`));
  }
  const importsSqlalchemy = /\bfrom\s+(sqlalchemy|sqlmodel)\b|\bimport\s+(sqlalchemy|sqlmodel)\b/i.test(ctx.sourceText);
  const hasDeclarativeBase =
    /\bclass\s+Base\s*\(\s*(DeclarativeBase|SQLModel)\s*\)/.test(ctx.sourceText) || /\bBase\s*=\s*declarative_base\s*\(/.test(ctx.sourceText);
  if (
    bases.some((base) => /\b(DeclarativeBase|SQLModel)\b/.test(base) || (importsSqlalchemy && hasDeclarativeBase && /\bBase\b/.test(base))) &&
    /\b(Column|mapped_column|relationship|__tablename__)\b/.test(node.text)
  ) {
    ctx.risks.push(riskFact(ctx, node, "sqlalchemy-model", 1.8, `${symbol.qualifiedName} looks like a SQLAlchemy/SQLModel model`));
  }
}

function addPythonImportFrameworkHint(
  ctx: ExtractContext,
  node: SyntaxNode,
  imp: { specifier: string; importedName?: string; localName?: string }
): void {
  const value = `${imp.specifier}.${imp.importedName ?? ""}.${imp.localName ?? ""}`;
  if (/\bfastapi\b/i.test(value)) {
    ctx.risks.push(riskFact(ctx, node, "fastapi-framework", 1.5, `imports ${imp.importedName ?? imp.specifier}`));
  }
  if (/\b(celery|shared_task)\b/i.test(value)) {
    ctx.risks.push(riskFact(ctx, node, "celery-framework", 1.5, `imports ${imp.importedName ?? imp.specifier}`));
  }
  if (/\bpydantic\b/i.test(value)) {
    ctx.risks.push(riskFact(ctx, node, "pydantic-framework", 1.5, `imports ${imp.importedName ?? imp.specifier}`));
  }
  if (/\b(sqlalchemy|sqlmodel)\b/i.test(value)) {
    ctx.risks.push(riskFact(ctx, node, "sqlalchemy-framework", 1.5, `imports ${imp.importedName ?? imp.specifier}`));
  }
}

function addPythonCallFrameworkHint(ctx: ExtractContext, node: SyntaxNode, name: string): void {
  if (/^(FastAPI|APIRouter|include_router|Depends)$|\.include_router$|\.dependency_overrides$/i.test(name)) {
    ctx.risks.push(riskFact(ctx, node, "fastapi-runtime-wiring", 1.5, `FastAPI runtime wiring call ${name}`));
  }
  if (/^(Celery|shared_task)$|\.task$|\.send_task$|\.delay$|\.apply_async$/i.test(name)) {
    ctx.risks.push(riskFact(ctx, node, "celery-runtime-wiring", 1.5, `background task call ${name}`));
  }
  if (/^(BaseModel|Field|model_validate|model_dump)$|\.model_validate$|\.model_dump$/i.test(name)) {
    ctx.risks.push(riskFact(ctx, node, "pydantic-runtime-wiring", 1.2, `Pydantic call ${name}`));
  }
  if (/^(Column|mapped_column|relationship|select|Session)$|\.execute$|\.scalars$|\.commit$/i.test(name)) {
    ctx.risks.push(riskFact(ctx, node, "sqlalchemy-runtime-wiring", 1.5, `SQLAlchemy call ${name}`));
  }
}
