import type { Confidence, ImportEdgeFact, ParseResult, SymbolFact, UsageSiteFact } from "../types.js";
import { stableId } from "../util.js";
import type { ExtractContext, ParseFileInput } from "./context.js";
import { baseFact, rangeFromOffsets } from "./facts.js";
import { addCommonRisks, addPatternRisks, addPlaceholderRisks } from "./risks.js";

export function parseMarkdownDocument(input: ParseFileInput, sourceText: string, empty: ParseResult): ParseResult {
  const ctx: ExtractContext = {
    path: input.relativePath,
    language: "markdown",
    sourceText,
    snapshotId: input.snapshotId,
    indexedAt: input.indexedAt,
    test: false,
    symbols: [],
    usageSites: [],
    imports: [],
    testEdges: [],
    risks: [],
    parserErrors: []
  };
  extractMarkdown(ctx);
  addCommonRisks(ctx);
  addPatternRisks(ctx);
  addPlaceholderRisks(ctx);
  return { ...empty, ...ctx, file: empty.file };
}

function extractMarkdown(ctx: ExtractContext): void {
  const lines = ctx.sourceText.split(/\r?\n/);
  const lineOffsets: number[] = [];
  let cursor = 0;
  for (const line of lines) {
    lineOffsets.push(cursor);
    cursor += line.length + 1;
  }

  const paragraphLines: string[] = [];
  let paragraphStart = 0;
  let paragraphCount = 0;
  const flushParagraph = (endLineIndex: number) => {
    const raw = paragraphLines.join(" ").replace(/\s+/g, " ").trim();
    if (raw.length >= 24 && paragraphCount < 80) {
      const startByte = lineOffsets[paragraphStart] ?? 0;
      const endByte = (lineOffsets[Math.max(paragraphStart, endLineIndex - 1)] ?? startByte) + (lines[Math.max(paragraphStart, endLineIndex - 1)]?.length ?? 0);
      const text = stripMarkdownInline(raw).slice(0, 240);
      ctx.usageSites.push(markdownUsageFact(ctx, "document text", "reference", text, startByte, endByte, "derived"));
      paragraphCount += 1;
    }
    paragraphLines.length = 0;
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const startByte = lineOffsets[index] ?? 0;
    const endByte = startByte + line.length;
    const heading = /^(#{1,6})\s+(.+?)\s*#*\s*$/u.exec(line);
    if (heading) {
      flushParagraph(index);
      const title = stripMarkdownInline(heading[2]).trim();
      if (title) {
        ctx.symbols.push(markdownHeadingFact(ctx, title, heading[1].length, startByte, endByte));
        ctx.usageSites.push(markdownUsageFact(ctx, title, "reference", `heading ${title}`, startByte, endByte, "authoritative"));
      }
      continue;
    }
    if (/^\s*(```|~~~)/u.test(line) || line.trim() === "" || /^\s{0,3}[-*+]\s+/u.test(line) || /^\s{0,3}\d+[.)]\s+/u.test(line)) {
      flushParagraph(index);
    } else {
      if (paragraphLines.length === 0) {
        paragraphStart = index;
      }
      paragraphLines.push(line);
    }
    extractMarkdownLinksFromLine(ctx, line, startByte);
    extractMarkdownCodeReferencesFromLine(ctx, line, startByte);
  }
  flushParagraph(lines.length);
}

function markdownHeadingFact(ctx: ExtractContext, title: string, level: number, startByte: number, endByte: number): SymbolFact {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-|-$/gu, "");
  return {
    ...baseFact("Symbol", ctx.path, ctx.snapshotId, ctx.indexedAt, "markdown", "authoritative", rangeFromOffsets(ctx.sourceText, startByte, endByte)),
    id: stableId("markdown-heading", ctx.path, slug || title, startByte),
    type: "Symbol",
    path: ctx.path,
    name: title,
    qualifiedName: `${ctx.path}#${slug || title}`,
    kind: "module",
    language: "markdown",
    exported: level <= 2,
    decorators: [`h${level}`]
  };
}

function markdownUsageFact(
  ctx: ExtractContext,
  name: string,
  kind: UsageSiteFact["kind"],
  text: string,
  startByte: number,
  endByte: number,
  confidence: Confidence
): UsageSiteFact {
  return {
    ...baseFact("UsageSite", ctx.path, ctx.snapshotId, ctx.indexedAt, "markdown", confidence, rangeFromOffsets(ctx.sourceText, startByte, endByte)),
    id: stableId("markdown-usage", ctx.path, name, kind, startByte),
    type: "UsageSite",
    path: ctx.path,
    name,
    kind,
    text: text.replace(/\s+/g, " ").slice(0, 240)
  };
}

function markdownImportFact(ctx: ExtractContext, specifier: string, startByte: number, endByte: number): ImportEdgeFact {
  return {
    ...baseFact("ImportEdge", ctx.path, ctx.snapshotId, ctx.indexedAt, "markdown", "derived", rangeFromOffsets(ctx.sourceText, startByte, endByte)),
    id: stableId("markdown-link-import", ctx.path, specifier, startByte),
    type: "ImportEdge",
    path: ctx.path,
    specifier,
    reExport: false,
    typeOnly: false
  };
}

function extractMarkdownLinksFromLine(ctx: ExtractContext, line: string, lineStartByte: number): void {
  const pattern = /!?\[([^\]]{1,160})\]\(([^)\s]+)(?:\s+"[^"]*")?\)/gu;
  for (const match of line.matchAll(pattern)) {
    const full = match[0];
    if (full.startsWith("!")) {
      continue;
    }
    const label = stripMarkdownInline(match[1]).trim();
    const target = match[2].trim();
    const startByte = lineStartByte + (match.index ?? 0);
    const endByte = startByte + full.length;
    ctx.usageSites.push(markdownUsageFact(ctx, target, "reference", `link ${label || target} -> ${target}`, startByte, endByte, "derived"));
    const specifier = markdownLocalLinkSpecifier(target);
    if (specifier) {
      ctx.imports.push(markdownImportFact(ctx, specifier, startByte, endByte));
    }
  }
}

function extractMarkdownCodeReferencesFromLine(ctx: ExtractContext, line: string, lineStartByte: number): void {
  const pattern = /`([^`\n]{2,180})`/gu;
  for (const match of line.matchAll(pattern)) {
    const value = match[1].trim();
    if (!looksLikePathReference(value) && !looksLikeCommandReference(value)) {
      continue;
    }
    const startByte = lineStartByte + (match.index ?? 0);
    const endByte = startByte + match[0].length;
    ctx.usageSites.push(markdownUsageFact(ctx, value, "reference", `inline reference ${value}`, startByte, endByte, "derived"));
    if (looksLikePathReference(value)) {
      const specifier = markdownLocalLinkSpecifier(value);
      if (specifier) {
        ctx.imports.push(markdownImportFact(ctx, specifier, startByte, endByte));
      }
    }
  }
}

function stripMarkdownInline(value: string): string {
  return value
    .replace(/`([^`]+)`/gu, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/gu, "$1")
    .replace(/[*_~]/gu, "")
    .trim();
}

function markdownLocalLinkSpecifier(target: string): string | undefined {
  const clean = target.split(/[?#]/u, 1)[0]?.trim();
  if (!clean || clean.startsWith("#") || /^[a-z][a-z0-9+.-]*:/iu.test(clean)) {
    return undefined;
  }
  if (clean.startsWith("/")) {
    return clean;
  }
  if (clean.startsWith("./") || clean.startsWith("../")) {
    return clean;
  }
  if (!looksLikePathReference(clean)) {
    return undefined;
  }
  return `./${clean}`;
}

function looksLikePathReference(value: string): boolean {
  return /(^|\/)[A-Za-z0-9_.-]+\.(?:[cm]?[jt]sx?|py|json|mdx?|rst|txt|toml|ya?ml|sh|service)$/u.test(value) || /^(?:\.{1,2}\/|\/)/u.test(value);
}

function looksLikeCommandReference(value: string): boolean {
  return /^(?:npm|pnpm|yarn|node|python3?|pytest|vitest|cargo|go|git|npx)\s+/u.test(value);
}
