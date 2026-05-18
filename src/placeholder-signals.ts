import { isGeneratedPath, isTestPath } from "./language.js";
import type { Confidence, LanguageId, Range, RiskSignalFact } from "./types.js";
import { stableId } from "./util.js";

export const PLACEHOLDER_SIGNAL_PREFIX = "placeholder.";
const MAX_PLACEHOLDER_RISKS_PER_FILE = 12;
const EMPTY_METHOD_BODY_PATTERN = /(?:^|[;{}\s])(?:async\s+)?(?!(?:if|for|while|switch|catch|function)\b)(?:constructor|[A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{\s*\}/gu;
const EMPTY_METHOD_BODY_START_PATTERN = /(?:^|[;{}\s])(?:async\s+)?(?!(?:if|for|while|switch|catch|function)\b)(?:constructor|[A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{\s*$/gu;
const TYPESCRIPT_PARAMETER_PROPERTY_MODIFIERS = new Set(["private", "protected", "public", "readonly", "override", "accessor"]);

export interface PlaceholderScanInput {
  path: string;
  language: LanguageId;
  sourceText: string;
  snapshotId: string;
  indexedAt: string;
  test?: boolean;
}

type PlaceholderContext = "production" | "test" | "docs" | "generated";

interface PlaceholderCandidate {
  signal: string;
  baseScore: number;
  confidence: Confidence;
  reason: string;
  range: Range;
}

export function isPlaceholderRisk(risk: { signal: string }): boolean {
  return risk.signal.startsWith(PLACEHOLDER_SIGNAL_PREFIX);
}

export function placeholderCategory(signal: string): string {
  return signal.startsWith(PLACEHOLDER_SIGNAL_PREFIX) ? signal.slice(PLACEHOLDER_SIGNAL_PREFIX.length).split(".")[0] || "unknown" : "unknown";
}

export function detectPlaceholderRisks(input: PlaceholderScanInput): RiskSignalFact[] {
  const context = placeholderContext(input);
  const candidates = dedupeCandidates([...executableStubCandidates(input), ...dummyDataCandidates(input), ...commentCandidates(input)]);
  return candidates
    .map((candidate) => candidateToRisk(input, candidate, context))
    .sort((a, b) => b.score - a.score || (a.range?.startLine ?? 0) - (b.range?.startLine ?? 0) || a.signal.localeCompare(b.signal))
    .slice(0, MAX_PLACEHOLDER_RISKS_PER_FILE);
}

function executableStubCandidates(input: PlaceholderScanInput): PlaceholderCandidate[] {
  const candidates: PlaceholderCandidate[] = [];
  const lines = sourceLines(input.sourceText);
  for (const line of lines) {
    const text = line.text;
    const codeText = stripInlineComment(input.language, text);
    const trimmed = codeText.trim();
    if (input.language === "python") {
      if (/^raise\s+NotImplementedError\b/.test(trimmed)) {
        candidates.push(candidate(input, line, "placeholder.not-implemented", 3.5, "derived", "raises NotImplementedError"));
      }
      if (/^(pass|\.\.\.)\s*(?:#.*)?$/.test(trimmed)) {
        candidates.push(candidate(input, line, "placeholder.no-op-body", 1.8, "heuristic", `Python ${trimmed.startsWith("pass") ? "pass" : "ellipsis"} body`));
      }
    }
    if (input.language === "typescript" || input.language === "javascript") {
      if (hasOutsideStringMatch(codeText, /\bthrow\s+new\s+Error\s*\(\s*['"`][^'"`]*(?:todo|tbd|not implemented|unimplemented|placeholder|stub)[^'"`]*['"`]/giu)) {
        candidates.push(candidate(input, line, "placeholder.not-implemented", 3.5, "derived", "throws a placeholder/not-implemented error"));
      }
      if (hasOutsideStringMatch(codeText, /\bfunction\s+[A-Za-z_$][\w$]*\s*\([^)]*\)\s*\{\s*\}/gu)) {
        candidates.push(candidate(input, line, "placeholder.no-op-body", 2.2, "derived", "empty function body"));
      }
      if (hasReportableEmptyMethodBody(input.language, codeText, EMPTY_METHOD_BODY_PATTERN)) {
        candidates.push(candidate(input, line, "placeholder.no-op-body", 2.0, "heuristic", "empty method body"));
      }
      if (hasOutsideStringMatch(codeText, /(?:^|[=(:,]\s*)(?:async\s*)?\([^)]*\)\s*=>\s*\{\s*\}/gu)) {
        candidates.push(candidate(input, line, "placeholder.no-op-body", 1.8, "heuristic", "empty arrow function body"));
      }
      if (hasOutsideStringMatch(codeText, /(?:^|[=(:,]\s*)(?:async\s+)?[A-Za-z_$][\w$]*\s*=>\s*\{\s*\}/gu)) {
        candidates.push(candidate(input, line, "placeholder.no-op-body", 1.8, "heuristic", "empty arrow function body"));
      }
    }
  }
  return [...candidates, ...multilineEmptyBodyCandidates(input, lines)];
}

function multilineEmptyBodyCandidates(input: PlaceholderScanInput, lines: SourceLine[]): PlaceholderCandidate[] {
  if (input.language !== "typescript" && input.language !== "javascript") {
    return [];
  }
  const candidates: PlaceholderCandidate[] = [];
  for (let index = 0; index < lines.length - 1; index += 1) {
    const currentCode = stripInlineComment(input.language, lines[index].text);
    const startsEmptyFunction =
      hasOutsideStringMatch(currentCode, /\bfunction\s+[A-Za-z_$][\w$]*\s*\([^)]*\)\s*\{\s*$/gu) ||
      hasReportableEmptyMethodBody(input.language, currentCode, EMPTY_METHOD_BODY_START_PATTERN) ||
      hasOutsideStringMatch(currentCode, /(?:^|[=(:,]\s*)(?:async\s*)?\([^)]*\)\s*=>\s*\{\s*$/gu) ||
      hasOutsideStringMatch(currentCode, /(?:^|[=(:,]\s*)(?:async\s+)?[A-Za-z_$][\w$]*\s*=>\s*\{\s*$/gu);
    if (!startsEmptyFunction) {
      continue;
    }
    const next = nextNonEmptyCodeLine(input, lines, index + 1);
    if (next?.code === "}") {
      candidates.push(candidate(input, lines[index], "placeholder.no-op-body", 2.2, "derived", "empty function body"));
    }
  }
  return candidates;
}

function nextNonEmptyCodeLine(input: PlaceholderScanInput, lines: SourceLine[], startIndex: number): { line: SourceLine; code: string } | undefined {
  for (let index = startIndex; index < lines.length; index += 1) {
    const code = stripInlineComment(input.language, lines[index].text).trim();
    if (code) {
      return { line: lines[index], code };
    }
  }
  return undefined;
}

function dummyDataCandidates(input: PlaceholderScanInput): PlaceholderCandidate[] {
  const candidates: PlaceholderCandidate[] = [];
  const lines = sourceLines(input.sourceText);
  for (const line of lines) {
    const text = line.text;
    const stripped = stripInlineComment(input.language, text);
    if (
      hasOutsideStringMatch(stripped, /\b(?:const|let|var)\s+(?:dummy|fake|mock|sample)[A-Za-z0-9_$]*\s*=/gu) ||
      hasOutsideStringMatch(stripped, /\b(?:const|let|var)\s+placeholder(?:Data|Value|Token|User|Item|Response|Payload|Text|Id|Email|Name|Url|Config)\s*=/gu)
    ) {
      candidates.push(candidate(input, line, "placeholder.dummy-data", 1.7, "heuristic", "dummy/fake/sample variable assignment"));
    }
    if (input.language === "python" && (/^\s*(?:dummy|fake|mock|sample)[A-Za-z0-9_]*\s*=/u.test(stripped) || /^\s*placeholder(?:_data|_value|_token|_user|_item|_response|_payload|_text|_id|_email|_name|_url|_config)\s*=/u.test(stripped))) {
      candidates.push(candidate(input, line, "placeholder.dummy-data", 1.7, "heuristic", "dummy/fake/sample variable assignment"));
    }
    if (input.language === "json" && (/"(?:dummy|fake|mock|sample)[A-Za-z0-9_-]*"\s*:/iu.test(stripped) || /"placeholder(?:Data|Value|Token|User|Item|Response|Payload|Text|Id|Email|Name|Url|Config)?"\s*:/u.test(stripped))) {
      candidates.push(candidate(input, line, "placeholder.dummy-data", 1.5, "heuristic", "dummy/fake/sample JSON key"));
    }
    if (hasPlaceholderLiteral(stripped)) {
      candidates.push(candidate(input, line, "placeholder.dummy-literal", 1.4, "heuristic", "placeholder-like literal value"));
    }
  }
  return candidates;
}

function commentCandidates(input: PlaceholderScanInput): PlaceholderCandidate[] {
  const candidates: PlaceholderCandidate[] = [];
  const lines = sourceLines(input.sourceText);
  let inBlockComment = false;
  for (const line of lines) {
    const fragment = commentFragment(input.language, line.text, inBlockComment);
    inBlockComment = fragment.inBlockComment;
    const comment = fragment.comment;
    if (!comment) {
      continue;
    }
    const marker = /\b(TODO|FIXME|HACK|XXX|TBD)\b/iu.exec(comment)?.[1];
    if (marker) {
      candidates.push(candidate(input, line, "placeholder.todo-comment", 0.9, "heuristic", `${marker.toUpperCase()} comment`));
      continue;
    }
    if (/\b(?:placeholder|stub|dummy|fake|not implemented|unimplemented|replace me)\b/iu.test(comment)) {
      candidates.push(candidate(input, line, "placeholder.placeholder-comment", 0.8, "heuristic", "placeholder-like comment"));
    }
  }
  return candidates;
}

function candidate(
  input: PlaceholderScanInput,
  line: SourceLine,
  signal: string,
  baseScore: number,
  confidence: Confidence,
  reason: string
): PlaceholderCandidate {
  return {
    signal,
    baseScore,
    confidence,
    reason,
    range: {
      startLine: line.number,
      endLine: line.number,
      startByte: line.startByte,
      endByte: line.startByte + Buffer.byteLength(line.text, "utf8")
    }
  };
}

function candidateToRisk(input: PlaceholderScanInput, candidate: PlaceholderCandidate, context: PlaceholderContext): RiskSignalFact {
  const score = Number((candidate.baseScore * contextMultiplier(context)).toFixed(2));
  const confidence = context === "production" && candidate.confidence === "derived" ? "derived" : "heuristic";
  const reason = `${context}: ${candidate.reason}`;
  return {
    id: stableId("placeholder-risk", input.path, candidate.signal, candidate.range.startByte, reason),
    type: "RiskSignal",
    path: input.path,
    range: candidate.range,
    source: "heuristic",
    confidence,
    snapshotId: input.snapshotId,
    indexedAt: input.indexedAt,
    signal: candidate.signal,
    score,
    reason
  };
}

function placeholderContext(input: PlaceholderScanInput): PlaceholderContext {
  if (isGeneratedPath(input.path)) {
    return "generated";
  }
  if (input.test || isTestPath(input.path)) {
    return "test";
  }
  if (input.language === "markdown" || /(^|\/)docs?\//u.test(input.path)) {
    return "docs";
  }
  return "production";
}

function contextMultiplier(context: PlaceholderContext): number {
  if (context === "production") {
    return 1;
  }
  if (context === "test") {
    return 0.35;
  }
  if (context === "docs") {
    return 0.25;
  }
  return 0.2;
}

function dedupeCandidates(candidates: PlaceholderCandidate[]): PlaceholderCandidate[] {
  const seen = new Set<string>();
  const result: PlaceholderCandidate[] = [];
  for (const candidate of candidates) {
    const key = `${candidate.signal}\0${candidate.range.startLine}\0${candidate.reason}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(candidate);
  }
  return result;
}

interface SourceLine {
  number: number;
  startByte: number;
  text: string;
}

function sourceLines(sourceText: string): SourceLine[] {
  const lines: SourceLine[] = [];
  let startByte = 0;
  const rawLines = sourceText.split(/\n/u);
  for (let index = 0; index < rawLines.length; index += 1) {
    const text = rawLines[index].replace(/\r$/u, "");
    lines.push({ number: index + 1, startByte, text });
    startByte += Buffer.byteLength(rawLines[index], "utf8") + 1;
  }
  return lines;
}

function commentFragment(language: LanguageId, line: string, inBlockComment: boolean): { comment?: string; inBlockComment: boolean } {
  const trimmed = line.trim();
  if (language === "python") {
    const index = lineCommentIndex(line, "#");
    return { comment: index >= 0 ? line.slice(index + 1) : undefined, inBlockComment: false };
  }
  if (language === "typescript" || language === "javascript" || language === "json") {
    if (inBlockComment) {
      const blockEnd = line.indexOf("*/");
      return {
        comment: blockEnd >= 0 ? line.slice(0, blockEnd) : line,
        inBlockComment: blockEnd < 0
      };
    }
    const slash = lineCommentIndex(line, "//");
    if (slash >= 0) {
      return { comment: line.slice(slash + 2), inBlockComment: false };
    }
    const blockStart = lineCommentIndex(line, "/*");
    if (blockStart >= 0) {
      const blockEnd = line.indexOf("*/", blockStart + 2);
      return {
        comment: blockEnd >= 0 ? line.slice(blockStart + 2, blockEnd) : line.slice(blockStart + 2),
        inBlockComment: blockEnd < 0
      };
    }
  }
  if (language === "markdown") {
    return { comment: trimmed, inBlockComment: false };
  }
  return { inBlockComment: false };
}

function stripInlineComment(language: LanguageId, line: string): string {
  if (language === "python") {
    const hash = lineCommentIndex(line, "#");
    return hash >= 0 ? line.slice(0, hash) : line;
  }
  if (language === "typescript" || language === "javascript") {
    const slash = lineCommentIndex(line, "//");
    return slash >= 0 ? line.slice(0, slash) : line;
  }
  return line;
}

function hasPlaceholderLiteral(line: string): boolean {
  for (const value of quotedLiteralValues(line)) {
    if (isPlaceholderLiteralValue(value)) {
      return true;
    }
  }
  return false;
}

function quotedLiteralValues(line: string): string[] {
  const values: string[] = [];
  let quote: "'" | "\"" | "`" | undefined;
  let literalStart = 0;
  let escaped = false;
  let inRegex = false;
  let inRegexClass = false;
  let regexEscaped = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (inRegex) {
      if (regexEscaped) {
        regexEscaped = false;
        continue;
      }
      if (char === "\\") {
        regexEscaped = true;
        continue;
      }
      if (char === "[" && !inRegexClass) {
        inRegexClass = true;
        continue;
      }
      if (char === "]" && inRegexClass) {
        inRegexClass = false;
        continue;
      }
      if (char === "/" && !inRegexClass) {
        inRegex = false;
      }
      continue;
    }
    if (quote) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === quote) {
        values.push(line.slice(literalStart, index).trim());
        quote = undefined;
      }
      continue;
    }
    if (char === "/" && isRegexLiteralStart(line, index)) {
      inRegex = true;
      inRegexClass = false;
      regexEscaped = false;
      continue;
    }
    if (char === "'" || char === "\"" || char === "`") {
      quote = char;
      literalStart = index + 1;
    }
  }
  return values;
}

function isRegexLiteralStart(line: string, slashIndex: number): boolean {
  const next = line[slashIndex + 1];
  if (!next || next === "/" || next === "*") {
    return false;
  }
  for (let index = slashIndex - 1; index >= 0; index -= 1) {
    const char = line[index];
    if (/\s/u.test(char)) {
      continue;
    }
    if ("([{,:;=!?&|".includes(char)) {
      return true;
    }
    const prefix = line.slice(0, index + 1);
    return /\b(?:return|throw|case|yield|await|typeof|instanceof|in|of|delete|void|new)$/u.test(prefix.trim());
  }
  return true;
}

function isPlaceholderLiteralValue(value: string): boolean {
  if (value.length > 80) {
    return false;
  }
  return (
    /^(?:placeholder|dummy|fake|sample|stub|todo|tbd|fixme|replace[-_ ]?me|REPLACE_ME)$/iu.test(value) ||
    /^YOUR_[A-Z0-9_]+$/u.test(value) ||
    /^(?:api[_-]?key[_-]?here|example@example\.com)$/iu.test(value) ||
    /\b(?:not implemented|unimplemented|lorem ipsum)\b/iu.test(value)
  );
}

function hasOutsideStringMatch(line: string, pattern: RegExp): boolean {
  return hasOutsideStringMatchWhere(line, pattern, () => true);
}

function hasOutsideStringMatchWhere(line: string, pattern: RegExp, predicate: (match: RegExpMatchArray) => boolean): boolean {
  const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
  const matcher = new RegExp(pattern.source, flags);
  for (const match of line.matchAll(matcher)) {
    if (!isInsideQuotedString(line, match.index ?? 0) && predicate(match)) {
      return true;
    }
  }
  return false;
}

function hasReportableEmptyMethodBody(language: LanguageId, line: string, pattern: RegExp): boolean {
  return hasOutsideStringMatchWhere(line, pattern, (match) => !isTypeScriptParameterPropertyConstructor(language, match[0]));
}

function isTypeScriptParameterPropertyConstructor(language: LanguageId, matchText: string): boolean {
  if (language !== "typescript") {
    return false;
  }
  const constructorMatch = /(?:^|[;{}\s])(?:async\s+)?constructor\s*\(([^)]*)\)\s*\{\s*(?:\})?\s*$/u.exec(matchText.trim());
  return Boolean(constructorMatch?.[1] && hasTypeScriptParameterProperty(constructorMatch[1]));
}

function hasTypeScriptParameterProperty(parameters: string): boolean {
  return splitTopLevelParameters(parameters).some((parameter) => {
    const text = stripLeadingParameterDecorators(parameter).trimStart();
    let remaining = text;
    let sawModifier = false;
    while (true) {
      const modifier = /^[A-Za-z_$][\w$]*/u.exec(remaining)?.[0];
      if (!modifier || !TYPESCRIPT_PARAMETER_PROPERTY_MODIFIERS.has(modifier)) {
        break;
      }
      sawModifier = true;
      remaining = remaining.slice(modifier.length).trimStart();
    }
    return sawModifier && /^[A-Za-z_$][\w$]*\s*[?!]?\s*(?::|=|$)/u.test(remaining);
  });
}

function stripLeadingParameterDecorators(parameter: string): string {
  return parameter.replace(/^(?:\s*@[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*(?:\([^)]*\))?)+/u, "");
}

function splitTopLevelParameters(parameters: string): string[] {
  const result: string[] = [];
  let start = 0;
  let parenDepth = 0;
  let braceDepth = 0;
  let bracketDepth = 0;
  let quote: "'" | "\"" | "`" | undefined;
  let escaped = false;

  for (let index = 0; index < parameters.length; index += 1) {
    const char = parameters[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quote) {
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === quote) {
        quote = undefined;
      }
      continue;
    }
    if (char === "'" || char === "\"" || char === "`") {
      quote = char;
      continue;
    }
    if (char === "(") {
      parenDepth += 1;
      continue;
    }
    if (char === ")" && parenDepth > 0) {
      parenDepth -= 1;
      continue;
    }
    if (char === "{") {
      braceDepth += 1;
      continue;
    }
    if (char === "}" && braceDepth > 0) {
      braceDepth -= 1;
      continue;
    }
    if (char === "[") {
      bracketDepth += 1;
      continue;
    }
    if (char === "]" && bracketDepth > 0) {
      bracketDepth -= 1;
      continue;
    }
    if (char === "," && parenDepth === 0 && braceDepth === 0 && bracketDepth === 0) {
      result.push(parameters.slice(start, index));
      start = index + 1;
    }
  }
  result.push(parameters.slice(start));
  return result;
}

function isInsideQuotedString(line: string, offset: number): boolean {
  let quote: "'" | "\"" | "`" | undefined;
  let escaped = false;
  for (let index = 0; index < Math.min(offset, line.length); index += 1) {
    const char = line[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = Boolean(quote);
      continue;
    }
    if (quote) {
      if (char === quote) {
        quote = undefined;
      }
      continue;
    }
    if (char === "'" || char === "\"" || char === "`") {
      quote = char;
    }
  }
  return Boolean(quote);
}

function lineCommentIndex(line: string, marker: "#" | "//" | "/*"): number {
  let quote: "'" | "\"" | "`" | undefined;
  let escaped = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = Boolean(quote);
      continue;
    }
    if (quote) {
      if (char === quote) {
        quote = undefined;
      }
      continue;
    }
    if (char === "'" || char === "\"" || char === "`") {
      quote = char;
      continue;
    }
    if (marker === "#" && char === "#") {
      return index;
    }
    if (marker === "//" && char === "/" && line[index + 1] === "/") {
      return index;
    }
    if (marker === "/*" && char === "/" && line[index + 1] === "*") {
      return index;
    }
  }
  return -1;
}
