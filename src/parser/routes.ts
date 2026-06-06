export function isRouteDecorator(decorator: string): boolean {
  return /\.(get|post|put|patch|delete|route|websocket|api_route)\s*\(/.test(decorator);
}

export function isTaskDecorator(decorator: string): boolean {
  return /(task|job|worker|celery|rq|on_event)/i.test(decorator);
}

export function decoratorName(decorator: string): string {
  return decorator.replace(/^@/, "").split("(")[0];
}

export function routeEndpointsFromDecorator(decorator: string): string[] {
  const methodRaw = /\.(get|post|put|patch|delete|route|websocket|api_route)\s*\(/.exec(decorator)?.[1];
  if (!methodRaw) {
    return [];
  }
  const pathValue = routePathLiteralFromDecorator(decorator);
  if (!pathValue) {
    return [];
  }
  let method = methodRaw === "api_route" || methodRaw === "route" ? "ANY" : methodRaw.toUpperCase();
  const methods = /methods\s*=\s*\[([^\]]+)\]/.exec(decorator)?.[1];
  if (methods) {
    const parsed = [...methods.matchAll(/["']([A-Za-z]+)["']/g)].map((match) => match[1].toUpperCase());
    if (parsed.length > 0) {
      return [...new Set(parsed)].sort().map((parsedMethod) => `${parsedMethod} ${normalizeEndpointPath(pathValue)}`);
    }
  }
  if (methodRaw === "websocket") {
    method = "WEBSOCKET";
  }
  return [`${method} ${normalizeEndpointPath(pathValue)}`];
}

function routePathLiteralFromDecorator(decorator: string): string | undefined {
  const firstArg = firstDecoratorArgument(decorator);
  const firstArgPath = firstArg ? routePathFromStringExpression(firstArg) : undefined;
  if (firstArgPath) {
    return firstArgPath;
  }
  const keywordPath = /(?:path|url_path)\s*=\s*((?:[rubfRUBF]*["'][^"']*["']\s*(?:\+\s*)?)+)/.exec(decorator)?.[1];
  return keywordPath ? routePathFromStringExpression(keywordPath) : undefined;
}

function firstDecoratorArgument(decorator: string): string | undefined {
  const open = decorator.indexOf("(");
  if (open < 0) {
    return undefined;
  }
  let depth = 0;
  let quote: string | undefined;
  let escaped = false;
  for (let index = open + 1; index < decorator.length; index += 1) {
    const char = decorator[index];
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        quote = undefined;
      }
      continue;
    }
    if (char === "\"" || char === "'") {
      quote = char;
      continue;
    }
    if (char === "(" || char === "[" || char === "{") {
      depth += 1;
      continue;
    }
    if (char === ")" && depth === 0) {
      return decorator.slice(open + 1, index).trim();
    }
    if (char === ")" || char === "]" || char === "}") {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (char === "," && depth === 0) {
      return decorator.slice(open + 1, index).trim();
    }
  }
  return decorator.slice(open + 1).trim();
}

function routePathFromStringExpression(expression: string): string | undefined {
  if (!/^\s*[rubfRUBF]*["']/.test(expression)) {
    return undefined;
  }
  const parts = [...expression.matchAll(/[rubfRUBF]*["']([^"']*)["']/g)].map((match) => match[1]);
  if (parts.length === 0 || !parts[0].startsWith("/")) {
    return undefined;
  }
  return parts.join("");
}

export function normalizeEndpointPath(value: string): string {
  return value.replace(/\/+/g, "/").replace(/\/$/, "") || "/";
}
