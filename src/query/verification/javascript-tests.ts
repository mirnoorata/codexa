import path from "node:path";
import type { CodexaIndex, VerificationTestRunner } from "../../types.js";
import { uniqueSorted } from "../../util.js";
import { normalizeCandidateTarget, normalizePathLike, type CoverageAddInput } from "./command-scope.js";

type JavaScriptTestRunner = VerificationTestRunner;

interface JavaScriptCoverageContext {
  index: Pick<CodexaIndex, "files">;
  repoRoot: string;
  addCoverage: (coverage: CoverageAddInput) => void;
}

const MAX_EXPANDED_TEST_TARGETS = 256;

export function addJavaScriptTestCoverage(
  args: string[],
  cwd: string,
  commandText: string,
  source: string,
  runner: Exclude<JavaScriptTestRunner, "playwright" | "cypress">,
  ctx: JavaScriptCoverageContext
): void {
  if (hasNonRunningJavaScriptTestArg(runner, args)) {
    return;
  }
  const parsed = javaScriptTestTargets(runner, args, cwd, ctx.repoRoot);
  if (!parsed.ok) {
    ctx.addCoverage({
      kind: "unknown",
      command: commandText,
      source: parsed.reason,
      confidence: "derived",
      scope: cwd,
      details: args
    });
    return;
  }
  if (parsed.targets.length === 0 && parsed.requiresExplicitTarget) {
    ctx.addCoverage({
      kind: "unknown",
      command: commandText,
      source: "Vitest project filter does not identify indexed test paths",
      confidence: "derived",
      scope: cwd,
      details: args
    });
    return;
  }
  if (parsed.targets.length === 0) {
    ctx.addCoverage({ kind: "javascript-tests", command: commandText, source, scope: cwd, testRunner: runner, details: args });
    return;
  }
  const expanded = runner === "node-test" ? expandNodeTestGlobs(parsed.targets, ctx.index) : { ok: true as const, targets: parsed.targets };
  if (!expanded.ok) {
    ctx.addCoverage({ kind: "unknown", command: commandText, source: expanded.reason, confidence: "derived", scope: cwd, details: args });
    return;
  }
  addTargetedJavaScriptTestCoverage(expanded.targets, args, cwd, commandText, source, runner, ctx);
}

function expandNodeTestGlobs(
  targets: string[],
  index: Pick<CodexaIndex, "files">
): { ok: true; targets: string[] } | { ok: false; reason: string } {
  const indexedTests = uniqueSorted(
    index.files
      .map((file) => normalizePathLike(file.path))
      .filter((filePath) => /\.(?:test|spec)\.[cm]?[jt]sx?$/iu.test(filePath))
  );
  const expanded: string[] = [];
  for (const target of targets) {
    if (!/[*?\[\]{}!]/u.test(target)) {
      expanded.push(target);
      continue;
    }
    if (!safeNodeTestGlob(target)) {
      return { ok: false, reason: `Node test glob ${target} is not a bounded in-repository test pattern` };
    }
    const matches = indexedTests.filter((filePath) => matchesBoundedTestGlob(filePath, target));
    if (matches.length === 0) {
      return { ok: false, reason: `Node test glob ${target} matched no indexed test paths` };
    }
    expanded.push(...matches);
    if (expanded.length > MAX_EXPANDED_TEST_TARGETS) {
      return { ok: false, reason: `Node test glob expansion exceeds ${MAX_EXPANDED_TEST_TARGETS} indexed test paths` };
    }
  }
  return { ok: true, targets: uniqueSorted(expanded) };
}

function safeNodeTestGlob(target: string): boolean {
  const segments = target.split("/");
  if (
    target.length > 512 ||
    target.startsWith("__outside_repo__:") ||
    path.posix.isAbsolute(target) ||
    segments.includes("..") ||
    segments.some((segment) => segment.length === 0 || (segment.includes("**") && segment !== "**")) ||
    /[\0?\[\]{}!]/u.test(target) ||
    /\*{3,}/u.test(target)
  ) {
    return false;
  }
  return [...target].filter((char) => char === "*").length <= 32;
}

function matchesBoundedTestGlob(filePath: string, pattern: string): boolean {
  const fileSegments = filePath.split("/");
  const patternSegments = pattern.split("/");
  let reachable = new Array<boolean>(fileSegments.length + 1).fill(false);
  reachable[0] = true;
  for (const patternSegment of patternSegments) {
    const next = new Array<boolean>(fileSegments.length + 1).fill(false);
    if (patternSegment === "**") {
      for (let index = 0; index <= fileSegments.length; index += 1) {
        if (reachable[index]) next[index] = true;
        if (index < fileSegments.length && next[index] && !fileSegments[index]!.startsWith(".")) next[index + 1] = true;
      }
      reachable = next;
      continue;
    }
    for (let index = 0; index < fileSegments.length; index += 1) {
      if (reachable[index] && matchesPathSegment(fileSegments[index]!, patternSegment)) next[index + 1] = true;
    }
    reachable = next;
  }
  return reachable[fileSegments.length] ?? false;
}

function matchesPathSegment(value: string, pattern: string): boolean {
  if (value.startsWith(".") && !pattern.startsWith(".")) return false;
  let valueIndex = 0;
  let patternIndex = 0;
  let starIndex = -1;
  let retryValueIndex = -1;
  while (valueIndex < value.length) {
    if (patternIndex < pattern.length && pattern[patternIndex] === value[valueIndex]) {
      patternIndex += 1;
      valueIndex += 1;
    } else if (patternIndex < pattern.length && pattern[patternIndex] === "*") {
      starIndex = patternIndex;
      retryValueIndex = valueIndex;
      patternIndex += 1;
    } else if (starIndex >= 0) {
      patternIndex = starIndex + 1;
      retryValueIndex += 1;
      valueIndex = retryValueIndex;
    } else {
      return false;
    }
  }
  while (patternIndex < pattern.length && pattern[patternIndex] === "*") patternIndex += 1;
  return patternIndex === pattern.length;
}

export function looksLikeExplicitTestSelector(
  arg: string,
  language: "javascript" | "python"
): boolean {
  if (/(?:<abs-path>|<outside-repo>|__outside_repo__:)/u.test(arg)) return true;
  const clean = arg.replace(/::.+$/u, "").replace(/:\d+(?::\d+)?$/u, "");
  if (language === "python") {
    return /(?:^|[\\/])tests?(?:[\\/]|$)/iu.test(clean) || /(?:^|[\\/])[^\\/]+\.py$/iu.test(clean) || /^[^\\/]+\.py$/iu.test(clean);
  }
  return /(?:^|[\\/])[^\\/]+\.(?:test|spec|cy)\.[cm]?[jt]sx?$/iu.test(clean) || /^[^\\/]+\.(?:test|spec|cy)\.[cm]?[jt]sx?$/iu.test(clean);
}

export function addPlaywrightCommandCoverage(
  args: string[],
  cwd: string,
  commandText: string,
  source: string,
  ctx: JavaScriptCoverageContext
): void {
  if (args[0] !== "test") {
    ctx.addCoverage({
      kind: "unknown",
      command: commandText,
      source: "Playwright subcommand does not run Playwright Test",
      confidence: "derived",
      scope: cwd,
      details: args
    });
    return;
  }
  const testArgs = args.slice(1);
  if (hasNonRunningJavaScriptTestArg("playwright", testArgs)) {
    ctx.addCoverage({
      kind: "unknown",
      command: commandText,
      source: "Playwright Test invocation does not prove complete test execution",
      confidence: "derived",
      scope: cwd,
      details: testArgs
    });
    return;
  }
  const parsed = playwrightTestTargets(testArgs, cwd, ctx.repoRoot);
  if (!parsed.ok || parsed.targets.length === 0) {
    ctx.addCoverage({
      kind: "unknown",
      command: commandText,
      source: parsed.ok ? "Playwright Test command lacks an explicit indexed test path" : parsed.reason,
      confidence: "derived",
      scope: cwd,
      details: testArgs
    });
    return;
  }
  addTargetedJavaScriptTestCoverage(parsed.targets, testArgs, cwd, commandText, source, "playwright", ctx);
}

export function addCypressCommandCoverage(
  args: string[],
  cwd: string,
  commandText: string,
  source: string,
  ctx: JavaScriptCoverageContext
): void {
  if (args[0] !== "run" || hasPresentFlag(args, ["--help", "-h", "--version", "-v"])) {
    ctx.addCoverage({
      kind: "unknown",
      command: commandText,
      source: "Cypress invocation does not prove a completed Cypress run",
      confidence: "derived",
      scope: cwd,
      details: args
    });
    return;
  }
  const runArgs = args.slice(1);
  if (runArgs.length === 0) {
    ctx.addCoverage({
      kind: "unknown",
      command: commandText,
      source: "Cypress run lacks an explicit indexed --spec test path",
      confidence: "derived",
      scope: cwd,
      details: args
    });
    return;
  }
  const spec =
    runArgs[0] === "--spec" && runArgs.length === 2
      ? runArgs[1]
      : runArgs.length === 1 && runArgs[0].startsWith("--spec=")
        ? runArgs[0].slice("--spec=".length)
        : undefined;
  const target = spec ? normalizeCandidateTarget(spec, cwd, ctx.repoRoot) : undefined;
  if (!target || !/\.(?:test|spec|cy)\.[cm]?[jt]sx?$/iu.test(target)) {
    ctx.addCoverage({
      kind: "unknown",
      command: commandText,
      source: "Cypress run must use one explicit in-repository --spec test path",
      confidence: "derived",
      scope: cwd,
      details: runArgs
    });
    return;
  }
  addTargetedJavaScriptTestCoverage([target], runArgs, cwd, commandText, source, "cypress", ctx);
}

function addTargetedJavaScriptTestCoverage(
  targets: string[],
  args: string[],
  cwd: string,
  commandText: string,
  source: string,
  testRunner: JavaScriptTestRunner,
  ctx: Pick<JavaScriptCoverageContext, "addCoverage">
): void {
  for (const target of targets) {
    ctx.addCoverage({ kind: "javascript-tests", command: commandText, source, scope: cwd, targetPath: target, testRunner, details: args });
    ctx.addCoverage({ kind: "targeted-test", command: commandText, source, scope: cwd, targetPath: target, testRunner, details: args });
  }
}

function playwrightTestTargets(args: string[], cwd: string, repoRoot: string): { ok: true; targets: string[] } | { ok: false; reason: string } {
  const valueOptions = new Set([
    "-b",
    "--browser",
    "-c",
    "--config",
    "-j",
    "--workers",
    "--global-timeout",
    "--last-failed-file",
    "--max-failures",
    "--output",
    "--project",
    "--repeat-each",
    "--reporter",
    "--retries",
    "--timeout",
    "--trace",
    "--tsconfig"
  ]);
  const switchOptions = new Set(["--fail-on-flaky-tests", "--forbid-only", "--fully-parallel", "--headed", "--no-deps", "--quiet", "-x"]);
  const targets: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") {
      continue;
    }
    const inlineOption = arg.startsWith("-") && arg.includes("=") ? arg.slice(0, arg.indexOf("=")) : undefined;
    if (inlineOption && valueOptions.has(inlineOption)) {
      continue;
    }
    if (valueOptions.has(arg)) {
      if (!args[index + 1]) {
        return { ok: false, reason: `Playwright Test option ${arg} is missing its value` };
      }
      index += 1;
      continue;
    }
    if (switchOptions.has(arg)) {
      continue;
    }
    if (arg.startsWith("-")) {
      return { ok: false, reason: `Playwright Test option ${arg} has unsupported scope semantics` };
    }
    const target = normalizeCandidateTarget(arg, cwd, repoRoot);
    if (!target) {
      return { ok: false, reason: `Playwright Test filter ${arg} is not an explicit indexed test path` };
    }
    targets.push(target);
  }
  return { ok: true, targets: uniqueSorted(targets) };
}

function javaScriptTestTargets(
  runner: Exclude<JavaScriptTestRunner, "playwright" | "cypress">,
  args: string[],
  cwd: string,
  repoRoot: string
): { ok: true; targets: string[]; requiresExplicitTarget: boolean } | { ok: false; reason: string } {
  const neutralSwitches = new Set(
    runner === "vitest"
      ? ["--coverage", "--globals", "--isolate", "--no-isolate", "--silent", "--logHeapUsage"]
      : runner === "jest"
        ? ["--ci", "--coverage", "--detectOpenHandles", "--forceExit", "--logHeapUsage", "--runInBand", "--silent", "--verbose"]
        : ["--test", "--experimental-test-coverage", "--test-force-exit"]
  );
  const neutralValueOptions = new Set(
    runner === "vitest"
      ? ["--bail", "--hookTimeout", "--maxWorkers", "--minWorkers", "--pool", "--reporter", "--retry", "--testTimeout"]
      : runner === "jest"
        ? ["--maxConcurrency", "--maxWorkers", "--reporters", "--testTimeout"]
        : ["--test-concurrency", "--test-reporter", "--test-reporter-destination", "--test-timeout"]
  );
  const targets: string[] = [];
  let requiresExplicitTarget = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") {
      continue;
    }
    if (runner === "vitest" && index === 0 && arg === "run") {
      continue;
    }
    if (runner === "vitest" && (arg === "--project" || arg.startsWith("--project="))) {
      requiresExplicitTarget = true;
      if (arg === "--project") {
        if (!args[index + 1]) {
          return { ok: false, reason: "Vitest project filter is missing its value" };
        }
        index += 1;
      }
      continue;
    }
    const inlineOption = arg.startsWith("-") && arg.includes("=") ? arg.slice(0, arg.indexOf("=")) : undefined;
    if (inlineOption && neutralValueOptions.has(inlineOption)) {
      continue;
    }
    if (neutralValueOptions.has(arg)) {
      if (!args[index + 1]) {
        return { ok: false, reason: `JavaScript test option ${arg} is missing its value` };
      }
      index += 1;
      continue;
    }
    if (neutralSwitches.has(arg)) {
      continue;
    }
    if (arg.startsWith("-")) {
      return { ok: false, reason: `JavaScript test option ${arg} has unsupported scope semantics` };
    }
    const target = normalizeCandidateTarget(arg, cwd, repoRoot);
    if (!target || !/\.(?:test|spec)\.[cm]?[jt]sx?$/iu.test(target)) {
      return { ok: false, reason: `JavaScript test selector ${arg} is not an explicit in-repository test path` };
    }
    targets.push(target);
  }
  return { ok: true, targets: uniqueSorted(targets), requiresExplicitTarget };
}

function hasNonRunningJavaScriptTestArg(runner: JavaScriptTestRunner, args: string[]): boolean {
  if (hasPresentFlag(args, ["--version", "-v", "-V", "--help", "-h", "help", "--passWithNoTests", "--pass-with-no-tests"])) {
    return true;
  }
  if (runner === "vitest") {
    return (
      ["bench", "complete", "init", "list"].includes(args[0] ?? "") ||
      hasPresentFlag(args, [
        "--standalone",
        "--mergeReports",
        "--merge-reports",
        "--listTags",
        "--list-tags",
        "--clearCache",
        "--clear-cache",
        "--ui",
        "--open",
        "--watch",
        "-w",
        "--update",
        "-u",
        "--testNamePattern",
        "--test-name-pattern",
        "-t",
        "--changed",
        "--shard",
        "--tagsFilter",
        "--tags-filter"
      ])
    );
  }
  if (runner === "jest") {
    return hasPresentFlag(args, [
      "--listTests",
      "--list-tests",
      "--showConfig",
      "--show-config",
      "--clearCache",
      "--clear-cache",
      "--init",
      "--watch",
      "--watchAll",
      "--watch-all",
      "--updateSnapshot",
      "--update-snapshot",
      "-u",
      "--testNamePattern",
      "--test-name-pattern",
      "-t",
      "--onlyChanged",
      "--only-changed",
      "-o",
      "--onlyFailures",
      "--only-failures",
      "-f",
      "--lastCommit",
      "--last-commit",
      "--changedSince",
      "--changed-since",
      "--changedFilesWithAncestor",
      "--changed-files-with-ancestor",
      "--shard",
      "--selectProjects",
      "--select-projects",
      "--ignoreProjects",
      "--ignore-projects"
    ]);
  }
  if (runner === "node-test") {
    return hasPresentFlag(args, ["--watch", "--test-only", "--test-name-pattern", "--test-skip-pattern", "--test-shard", "--test-update-snapshots"]);
  }
  return hasPresentFlag(args, [
    "--debug",
    "--list",
    "--ui",
    "--ui-host",
    "--ui-port",
    "--ignore-snapshots",
    "-u",
    "--update-snapshots",
    "--update-source-method",
    "--only-changed",
    "--last-failed",
    "--test-list",
    "--test-list-invert",
    "--shard",
    "-g",
    "--grep",
    "-G",
    "--grep-invert"
  ]);
}

function hasPresentFlag(args: string[], flags: string[]): boolean {
  return args.some((arg) => flags.some((flag) => arg === flag || arg.startsWith(`${flag}=`)));
}
