import { stableId } from "../util.js";
import type { ExtractContext } from "./context.js";
import { baseFact, rangeFromOffsets } from "./facts.js";
import { normalizeEndpointPath } from "./routes.js";

export function extractDottedStringReferences(ctx: ExtractContext): void {
  const seen = new Set<string>();
  const pattern = /\b[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*)+\b/gi;
  for (const match of ctx.sourceText.matchAll(pattern)) {
    const name = match[0];
    const start = match.index ?? 0;
    const end = start + name.length;
    if (!shouldIndexDottedStringReference(name) || !isStandaloneQuotedDottedStringReference(ctx.sourceText, start, end)) {
      continue;
    }
    const key = `${name}:${start}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    ctx.usageSites.push({
      ...baseFact("UsageSite", ctx.path, ctx.snapshotId, ctx.indexedAt, "heuristic", "heuristic", rangeFromOffsets(ctx.sourceText, start, start + name.length)),
      id: stableId("dotted-string-reference", ctx.path, name, start),
      type: "UsageSite",
      path: ctx.path,
      name,
      kind: "reference",
      text: name
    });
  }
}

function isStandaloneQuotedDottedStringReference(sourceText: string, start: number, end: number): boolean {
  const quote = sourceText[start - 1];
  return (quote === "'" || quote === "\"" || quote === "`") && sourceText[end] === quote;
}

function shouldIndexDottedStringReference(value: string): boolean {
  const normalized = value.trim();
  if (!normalized || normalized.split(".").length < 2) {
    return false;
  }
  if (/^(?:https?:\/\/|www\.)/iu.test(normalized)) {
    return false;
  }
  if (/^\d+(?:\.\d+)+$/u.test(normalized) || /^v\d+(?:\.\d+)+$/iu.test(normalized) || /^\d+\.\d+$/u.test(normalized)) {
    return false;
  }
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/u.test(normalized)) {
    return false;
  }
  if (/^\d{4}[./-]\d{2}[./-]\d{2}(?:[Tt _-]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)?$/u.test(normalized)) {
    return false;
  }
  if (looksLikeCommonDomain(normalized)) {
    return false;
  }
  return true;
}

function looksLikeCommonDomain(value: string): boolean {
  const parts = value.split(".");
  if (parts.length < 2 || parts.length > 6) {
    return false;
  }
  const tld = parts.at(-1)?.toLowerCase();
  if (!tld) {
    return false;
  }
  const commonTlds = new Set([
    "ai",
    "app",
    "biz",
    "ca",
    "ch",
    "co",
    "com",
    "de",
    "dev",
    "edu",
    "fr",
    "gov",
    "hk",
    "info",
    "io",
    "jp",
    "me",
    "net",
    "nl",
    "no",
    "org",
    "pl",
    "pt",
    "ru",
    "se",
    "sg",
    "uk",
    "us",
    "xyz"
  ]);
  if (!commonTlds.has(tld)) {
    return false;
  }
  return parts.every((part, index) => (index === 0 ? /^[a-z][a-z0-9_-]*$/iu.test(part) : /^[a-z0-9-]+$/iu.test(part)));
}

export function extractEndpointStringReferences(ctx: ExtractContext): void {
  const seen = new Set<string>();
  const pattern = /(["'`])(\/[A-Za-z0-9_./:${}()?=&%+-]{1,180})\1/g;
  for (const match of ctx.sourceText.matchAll(pattern)) {
    const rawPath = match[2];
    const start = match.index ?? 0;
    if (!shouldKeepEndpointString(ctx, rawPath, start)) {
      continue;
    }
    const method = inferEndpointMethod(ctx.sourceText, start);
    const name = `${method} ${endpointPathForReference(ctx, rawPath, start)}`;
    const key = `${name}:${start}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    ctx.usageSites.push({
      ...baseFact("UsageSite", ctx.path, ctx.snapshotId, ctx.indexedAt, "heuristic", ctx.test ? "derived" : "heuristic", rangeFromOffsets(ctx.sourceText, start, start + match[0].length)),
      id: stableId("endpoint-string-reference", ctx.path, name, start),
      type: "UsageSite",
      path: ctx.path,
      name,
      kind: "endpoint_reference",
      text: ctx.sourceText.slice(Math.max(0, start - 80), Math.min(ctx.sourceText.length, start + match[0].length + 120)).replace(/\s+/g, " ").slice(0, 240)
    });
  }
}

function shouldKeepEndpointString(ctx: ExtractContext, rawPath: string, start: number): boolean {
  const lineStart = ctx.sourceText.lastIndexOf("\n", start);
  const linePrefix = ctx.sourceText.slice(lineStart + 1, start);
  if (
    ctx.language === "python" &&
    (/@(?:router|app)\.(?:get|post|put|patch|delete|route|api_route|websocket)\s*\([^)]*$/i.test(linePrefix) || isInsidePythonRouteDecorator(ctx.sourceText, start))
  ) {
    return false;
  }
  const window = ctx.sourceText.slice(Math.max(0, start - 140), Math.min(ctx.sourceText.length, start + 220));
  if (/@(?:router|app)\.(?:get|post|put|patch|delete|route|api_route|websocket)\s*\(/.test(window)) {
    return true;
  }
  if (ctx.test && /(?:client|api|request|fetch)\.(?:get|post|put|patch|delete)\s*\(|fetch\s*\(|\bapi(?:<[^>]+>)?\s*\(/i.test(window)) {
    return true;
  }
  return /(?:fetch|apiFetch|request|axios|client\.(?:get|post|put|patch|delete)|http\.(?:get|post|put|patch|delete))\s*\(|\bapi(?:<[^>]+>)?\s*\(/i.test(window);
}

function isInsidePythonRouteDecorator(sourceText: string, start: number): boolean {
  const before = sourceText.slice(Math.max(0, start - 600), start);
  const match = /@(?:router|app)\.(?:get|post|put|patch|delete|route|api_route|websocket)\s*\(/gi;
  let last: RegExpExecArray | null = null;
  for (let next = match.exec(before); next; next = match.exec(before)) {
    last = next;
  }
  if (!last) {
    return false;
  }
  const tail = before.slice(last.index);
  return tail.lastIndexOf("(") > tail.lastIndexOf(")");
}

function inferEndpointMethod(sourceText: string, start: number): string {
  const before = sourceText.slice(Math.max(0, start - 180), start);
  const after = sourceText.slice(start, Math.min(sourceText.length, start + 240));
  const afterLine = after.split(/\r?\n/, 1)[0] ?? after;
  const callWindow = enclosingCallWindow(sourceText, start);
  const decoratorMethod = /@(?:router|app)\.(get|post|put|patch|delete|websocket|api_route|route)\s*\([^@\n]*$/i.exec(before)?.[1];
  if (decoratorMethod) {
    if (/websocket/i.test(decoratorMethod)) {
      return "WEBSOCKET";
    }
    if (/api_route|route/i.test(decoratorMethod)) {
      const methods = /methods\s*=\s*\[([^\]]+)\]/i.exec(after)?.[1] ?? /methods\s*=\s*\[([^\]]+)\]/i.exec(before)?.[1];
      const parsed = methods ? [...methods.matchAll(/["']([A-Za-z]+)["']/g)].map((match) => match[1].toUpperCase()) : [];
      return parsed.length === 1 ? parsed[0] : "ANY";
    }
    return decoratorMethod.toUpperCase();
  }
  const clientMethod = /\.(get|post|put|patch|delete)\s*\([^.\n]*$/i.exec(before)?.[1];
  if (clientMethod) {
    return clientMethod.toUpperCase();
  }
  const explicitMethod =
    /method\s*:\s*["']([A-Za-z]+)["']/i.exec(callWindow)?.[1] ??
    /method\s*:\s*["']([A-Za-z]+)["']/i.exec(afterLine)?.[1] ??
    /method\s*:\s*["']([A-Za-z]+)["']/i.exec(before)?.[1];
  if (explicitMethod) {
    return explicitMethod.toUpperCase();
  }
  return /fetch\s*\([^)\n]*$/i.test(before) ? "GET" : "ANY";
}

function enclosingCallWindow(sourceText: string, start: number): string {
  const before = sourceText.slice(Math.max(0, start - 220), start);
  const callPattern = /(?:fetch|apiFetch|request|axios|client\.(?:get|post|put|patch|delete)|http\.(?:get|post|put|patch|delete)|\bapi(?:<[^>]+>)?)\s*\(/gi;
  let last: RegExpExecArray | null = null;
  for (let next = callPattern.exec(before); next; next = callPattern.exec(before)) {
    last = next;
  }
  if (!last) {
    return "";
  }
  const callStart = start - before.length + last.index;
  return sourceText.slice(callStart, Math.min(sourceText.length, start + 800));
}

function endpointPathForReference(ctx: ExtractContext, rawPath: string, start: number): string {
  const before = ctx.sourceText.slice(Math.max(0, start - 140), start);
  const shouldPrefixApi = ctx.language !== "python" && !rawPath.startsWith("/api/") && /\bapi(?:<[^>]+>)?\s*\([^)\n]*$/i.test(before);
  return normalizeEndpointPath(shouldPrefixApi ? `/api${rawPath}` : rawPath);
}
