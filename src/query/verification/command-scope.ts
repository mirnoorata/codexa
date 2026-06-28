import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { CodexaIndex, Confidence, VerificationCommandEnvelope, VerificationCommandPlanEntry, VerificationCoverage, VerificationCoverageKind, VerificationWaiver } from "../../types.js";
import { uniqueSorted } from "../../util.js";
import { shellWords, splitShellSequence, stripLeadingEnvironment, stripQuotes, type ShellControlOperator } from "./shell.js";

export interface PackageScript {
  packageRoot: string;
  scriptName: string;
  command: string;
  source: string;
}

export interface ParsedSegment {
  cwd: string;
  text: string;
  operator: ShellControlOperator;
  // A `cd` segment: consumed for cwd tracking and never analyzed as a runner,
  // but kept in the list because `cd` exits 0 and so can mask a preceding
  // runner's failure (`pytest ; cd foo`) — segmentMasksExit must see it.
  cd?: boolean;
}

export interface CoverageAddInput {
  kind: VerificationCoverageKind;
  command: string;
  source: string;
  confidence?: Confidence;
  scope?: string;
  targetPath?: string;
  details?: string[];
  exitCode?: number;
  durationMs?: number;
  outputSummary?: string;
}

export interface CommandEnvelopeContext {
  repoRoot: string;
  scripts: Map<string, PackageScript>;
  packageRoots: string[];
  packageNamesByRoot: Map<string, string | undefined>;
}

export type CoverageAnalysisCtx = {
  index: CodexaIndex;
  repoRoot: string;
  scripts: Map<string, PackageScript>;
  packageRoots: string[];
  packageNamesByRoot: Map<string, string | undefined>;
  visitedScripts: Set<string>;
  addCoverage: (coverage: CoverageAddInput) => void;
};

// Wrap a ctx so every coverage it would emit is downgraded to `unknown`. Used
// for a runner segment whose exit is masked; the downgrade propagates through
// recursive shell-unwrap and package-script expansion because they thread ctx.
export function maskedCoverageCtx(ctx: CoverageAnalysisCtx): CoverageAnalysisCtx {
  return {
    ...ctx,
    addCoverage: (coverage) =>
      ctx.addCoverage(
        coverage.kind === "unknown"
          ? coverage
          : { kind: "unknown", command: coverage.command, source: `${coverage.source} (exit code masked by a trailing shell operator)`, confidence: "derived", scope: coverage.scope, details: coverage.details }
      )
  };
}

export function splitSimpleCommand(command: string, initialCwd: string, repoRoot: string): ParsedSegment[] {
  const segments = splitShellSequence(command);
  const result: ParsedSegment[] = [];
  let cwd = initialCwd;
  for (const segment of segments) {
    const words = stripLeadingEnvironment(shellWords(segment.text));
    if (words[0] === "cd" && words[1]) {
      cwd = normalizeCwd(words[1], repoRoot);
      result.push({ cwd, text: segment.text, operator: segment.operator, cd: true });
      continue;
    }
    result.push({ cwd, text: segment.text, operator: segment.operator });
  }
  return result;
}

export function packageScriptsFromIndex(index: CodexaIndex): Map<string, PackageScript> {
  const scripts = new Map<string, PackageScript>();
  for (const usage of index.usageSites) {
    if (usage.source !== "manifest" || !usage.path.endsWith("package.json") || !usage.name.startsWith("npm script ")) {
      continue;
    }
    const scriptName = usage.name.replace(/^npm script\s+/u, "");
    const packageRoot = normalizePackageRoot(path.posix.dirname(usage.path));
    const source = `${packageRoot === "." ? "" : `${packageRoot}/`}package.json#scripts.${scriptName}`;
    scripts.set(`${packageRoot}\0${scriptName}`, {
      packageRoot,
      scriptName,
      command: usage.text,
      source
    });
  }
  return scripts;
}

export function packageManagerRunCommand(repoRoot: string, packageRoot: string, scriptName: string): string {
  const absoluteRoot = path.join(repoRoot, packageRoot === "." ? "" : packageRoot);
  if (existsSync(path.join(absoluteRoot, "pnpm-lock.yaml")) || (packageRoot !== "." && existsSync(path.join(repoRoot, "pnpm-lock.yaml")))) {
    return scriptName === "test" ? "pnpm test" : `pnpm run ${scriptName}`;
  }
  if (existsSync(path.join(absoluteRoot, "yarn.lock")) || (packageRoot !== "." && existsSync(path.join(repoRoot, "yarn.lock")))) {
    return scriptName === "test" ? "yarn test" : `yarn ${scriptName}`;
  }
  return scriptName === "test" ? "npm test" : `npm run ${scriptName}`;
}

export function packageRootsFromIndex(index: CodexaIndex): string[] {
  return uniqueSorted(index.files.filter((file) => file.path.endsWith("package.json")).map((file) => normalizePackageRoot(path.posix.dirname(file.path))));
}

export function packageRootForCwd(cwd: string, scripts: Map<string, PackageScript>, packageRoots: string[]): string {
  if (cwd.startsWith("__outside_repo__:")) {
    return cwd;
  }
  const normalized = normalizePackageRoot(cwd);
  if ([...scripts.keys()].some((key) => key.startsWith(`${normalized}\0`))) {
    return normalized;
  }
  const candidates = uniqueSorted([...packageRoots, ...[...scripts.values()].map((script) => script.packageRoot)]).sort((a, b) => b.length - a.length);
  return candidates.find((candidate) => candidate !== "." && (normalized === candidate || normalized.startsWith(`${candidate}/`))) ?? ".";
}

export function packageRootForPath(filePath: string, packageRoots: string[]): string {
  const normalized = normalizePathLike(filePath);
  return uniqueSorted(packageRoots)
    .sort((a, b) => b.length - a.length)
    .find((candidate) => candidate !== "." && (normalized === candidate || normalized.startsWith(`${candidate}/`))) ?? ".";
}

export function scopedPackageCommand(
  words: string[],
  repoRoot: string,
  packageRoots: string[],
  packageNamesByRoot: Map<string, string | undefined>
): { cwd: string; words: string[] } | undefined {
  const first = words[0];
  if ((first === "npm" || first === "pnpm") && (words[1] === "--prefix" || words[1] === "-C" || words[1] === "--dir") && words[2]) {
    return { cwd: normalizeCwd(words[2], repoRoot), words: [first, ...words.slice(3)] };
  }
  const prefixValue = flagValue(words[1], ["--prefix", "-C", "--dir"]);
  if ((first === "npm" || first === "pnpm") && prefixValue) {
    return { cwd: normalizeCwd(prefixValue, repoRoot), words: [first, ...words.slice(2)] };
  }
  const npmWorkspace = readFlagArgument(words, 1, ["-w", "--workspace"]);
  if (first === "npm" && npmWorkspace) {
    return {
      cwd: resolvePackageSpecifier(npmWorkspace.value, repoRoot, packageRoots, packageNamesByRoot) ?? unresolvedPackageScope(npmWorkspace.value),
      words: [first, ...words.slice(npmWorkspace.nextIndex)]
    };
  }
  const pnpmFilter = readFlagArgument(words, 1, ["--filter", "-F"]);
  if (first === "pnpm" && pnpmFilter) {
    const cwd = resolvePackageSpecifier(pnpmFilter.value, repoRoot, packageRoots, packageNamesByRoot);
    return cwd ? { cwd, words: [first, ...words.slice(pnpmFilter.nextIndex)] } : undefined;
  }
  if (first === "yarn" && words[1] === "--cwd" && words[2]) {
    return { cwd: normalizeCwd(words[2], repoRoot), words: ["yarn", ...words.slice(3)] };
  }
  const yarnCwdValue = flagValue(words[1], ["--cwd"]);
  if (first === "yarn" && yarnCwdValue) {
    return { cwd: normalizeCwd(yarnCwdValue, repoRoot), words: ["yarn", ...words.slice(2)] };
  }
  if (first === "yarn" && words[1] === "workspace" && words[2]) {
    return { cwd: resolvePackageSpecifier(words[2], repoRoot, packageRoots, packageNamesByRoot) ?? unresolvedPackageScope(words[2]), words: ["yarn", ...words.slice(3)] };
  }
  return undefined;
}

export function readFlagArgument(words: string[], start: number, flags: string[]): { value: string; nextIndex: number } | undefined {
  const word = words[start];
  const inline = flagValue(word, flags);
  if (inline) {
    return { value: inline, nextIndex: start + 1 };
  }
  if (word && flags.includes(word) && words[start + 1]) {
    return { value: words[start + 1], nextIndex: start + 2 };
  }
  return undefined;
}

function flagValue(word: string | undefined, flags: string[]): string | undefined {
  if (!word) {
    return undefined;
  }
  for (const flag of flags) {
    if (word.startsWith(`${flag}=`)) {
      const value = word.slice(flag.length + 1);
      return value || undefined;
    }
  }
  return undefined;
}

export function forwardedScriptArgs(args: string[]): string[] {
  const delimiter = args.indexOf("--");
  return delimiter >= 0 ? args.slice(delimiter + 1) : args.filter((arg) => !arg.startsWith("-"));
}

function resolvePackageSpecifier(
  value: string,
  repoRoot: string,
  packageRoots: string[],
  packageNamesByRoot: Map<string, string | undefined>
): string | undefined {
  const clean = stripQuotes(value.trim());
  if (!clean || clean.startsWith("!") || /[*{},]/u.test(clean) || clean.includes("...")) {
    return undefined;
  }
  const pathCandidate = normalizeCwd(clean.replace(/^\.\//u, ""), repoRoot);
  if (!pathCandidate.startsWith("__outside_repo__:") && existsSync(path.join(repoRoot, pathCandidate === "." ? "" : pathCandidate, "package.json"))) {
    return pathCandidate;
  }
  for (const root of packageRoots) {
    if (packageNameForRoot(root, repoRoot, packageNamesByRoot) === clean) {
      return root;
    }
  }
  return undefined;
}

export function packageNameForRoot(root: string, repoRoot: string, packageNamesByRoot: Map<string, string | undefined>): string | undefined {
  if (packageNamesByRoot.has(root)) {
    return packageNamesByRoot.get(root);
  }
  const manifestPath = path.join(repoRoot, root === "." ? "" : root, "package.json");
  let packageName: string | undefined;
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { name?: unknown };
    if (typeof manifest.name === "string") {
      packageName = manifest.name;
    }
  } catch {
    packageName = undefined;
  }
  packageNamesByRoot.set(root, packageName);
  return packageName;
}

function unresolvedPackageScope(value: string): string {
  return `__outside_repo__:unresolved-package:${value}`;
}

export function normalizeCandidateTarget(value: string, cwd: string, repoRoot: string): string | undefined {
  if (value.startsWith("-") || /^[A-Z_][A-Z0-9_]*=/u.test(value)) {
    return undefined;
  }
  const clean = value.replace(/:\d+(?::\d+)?$/u, "").replace(/::.+$/u, "");
  if (!/(\.(?:test|spec)\.[cm]?[jt]sx?|\.py)$|^tests\//u.test(clean)) {
    return undefined;
  }
  const joined = path.isAbsolute(clean) ? relativeInsideRepo(clean, repoRoot) : path.posix.normalize(path.posix.join(normalizePackageRoot(cwd), clean));
  if (!joined) {
    return undefined;
  }
  return normalizePathLike(joined);
}

export function normalizeCwd(value: string, repoRoot: string): string {
  const clean = stripQuotes(value.trim());
  if (clean.startsWith("__outside_repo__:")) {
    return clean;
  }
  if (path.isAbsolute(clean)) {
    const relative = path.relative(repoRoot, clean);
    if (relative === "") {
      return ".";
    }
    return !relative.startsWith("..") && !path.isAbsolute(relative) ? normalizePackageRoot(relative) : `__outside_repo__:${clean}`;
  }
  const absolute = path.resolve(repoRoot, clean || ".");
  const relative = path.relative(repoRoot, absolute);
  if (relative === "") {
    return ".";
  }
  return !relative.startsWith("..") && !path.isAbsolute(relative) ? normalizePackageRoot(relative) : `__outside_repo__:${absolute}`;
}

function relativeInsideRepo(value: string, repoRoot: string): string | undefined {
  const relative = path.relative(repoRoot, value);
  if (relative === "") {
    return ".";
  }
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return undefined;
  }
  return relative;
}

export function normalizePackageRoot(value: string): string {
  const normalized = normalizePathLike(value || ".");
  return normalized === "" ? "." : normalized;
}

export function dedupeCoverage(coverage: VerificationCoverage[]): VerificationCoverage[] {
  const byKey = new Map<string, VerificationCoverage>();
  for (const entry of coverage) {
    const key = [entry.kind, entry.command, entry.source, entry.scope ?? "", entry.targetPath ?? "", entry.exitCode ?? "", entry.durationMs ?? "", entry.outputSummary ?? ""].join("\0");
    const existing = byKey.get(key);
    if (existing) {
      existing.details = uniqueSorted([...existing.details, ...entry.details]);
      existing.confidence = mergeConfidence(existing.confidence, entry.confidence);
      existing.commandEnvelope = existing.commandEnvelope ?? entry.commandEnvelope;
    } else {
      byKey.set(key, { ...entry, details: uniqueSorted(entry.details) });
    }
  }
  return [...byKey.values()].sort((a, b) => a.kind.localeCompare(b.kind) || (a.targetPath ?? "").localeCompare(b.targetPath ?? "") || a.command.localeCompare(b.command));
}

export function dedupeCommandEnvelopes(envelopes: VerificationCommandEnvelope[]): VerificationCommandEnvelope[] {
  const byKey = new Map<string, VerificationCommandEnvelope>();
  for (const envelope of envelopes) {
    const key = [
      envelope.command,
      envelope.cwd ?? "",
      envelope.packageManager ?? "",
      envelope.workspace ?? "",
      envelope.packageRoot ?? "",
      envelope.packageName ?? "",
      envelope.scriptName ?? "",
      envelope.args.join("\u0001"),
      envelope.exitCode ?? "",
      envelope.durationMs ?? "",
      envelope.stdoutSummary ?? "",
      envelope.stderrSummary ?? "",
      envelope.outputSummary ?? "",
      envelope.source,
      envelope.scopeStatus,
      envelope.classifierVersion
    ].join("\0");
    byKey.set(key, envelope);
  }
  return [...byKey.values()].sort(
    (a, b) =>
      a.command.localeCompare(b.command) ||
      (a.cwd ?? "").localeCompare(b.cwd ?? "") ||
      (a.packageRoot ?? "").localeCompare(b.packageRoot ?? "") ||
      (a.scriptName ?? "").localeCompare(b.scriptName ?? "")
  );
}

export function commandPlanScore(entry: VerificationCommandPlanEntry): number {
  const covers = new Set(entry.covers);
  return (
    (covers.has("targeted-test") ? 35 : 0) +
    (covers.has("javascript-tests") || covers.has("python-tests") ? 40 : 0) +
    (covers.has("typescript-syntax") ? 12 : 0) +
    (covers.has("build") ? 10 : 0) +
    (covers.has("lint") ? 4 : 0) +
    (covers.has("privacy") ? 3 : 0) +
    (covers.has("audit") ? 2 : 0) +
    (entry.targetPaths.length > 0 ? 25 : 0)
  );
}

export function topLevelCommand(command: string): string {
  return command.split(" -> ", 1)[0] ?? command;
}

export function mergeConfidence(a: Confidence, b: Confidence): Confidence {
  if (a === "authoritative" || b === "authoritative") {
    return "authoritative";
  }
  if (a === "derived" || b === "derived") {
    return "derived";
  }
  return "heuristic";
}

export function waiversForMatching(waivers: VerificationWaiver[], legacyWaivedChecks: string[]): Map<string, VerificationWaiver> {
  const result = new Map<string, VerificationWaiver>();
  for (const waiver of waivers) {
    if (!waiver.target || !waiver.reason) {
      continue;
    }
    result.set(waiverKey(waiver.kind, waiver.target), waiver);
  }
  for (const target of legacyWaivedChecks) {
    const reason = "legacy waivedChecks target";
    result.set(waiverKey("test", target), { kind: "test", target, reason });
  }
  return result;
}

export function waiverKey(kind: VerificationWaiver["kind"], target: string): string {
  return `${kind}\0${normalizeSearchText(target)}`;
}

function normalizeSearchText(value: string): string {
  return normalizePathLike(value).toLowerCase().replace(/[^a-z0-9./:_-]+/gu, " ").replace(/\s+/gu, " ").trim();
}

export function normalizePathLike(value: string): string {
  const normalized = value.replace(/\\/gu, "/").replace(/^\.\/+/u, "");
  const collapsed = path.posix.normalize(normalized);
  return collapsed === "." ? "." : collapsed.replace(/^\/+/u, "");
}
