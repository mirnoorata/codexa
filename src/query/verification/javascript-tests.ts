import { uniqueSorted } from "../../util.js";
import { normalizeCandidateTarget, type CoverageAddInput } from "./command-scope.js";

type JavaScriptTestRunner = "vitest" | "jest" | "node-test" | "playwright";

interface JavaScriptCoverageContext {
  repoRoot: string;
  addCoverage: (coverage: CoverageAddInput) => void;
}

export function addJavaScriptTestCoverage(
  args: string[],
  cwd: string,
  commandText: string,
  source: string,
  runner: JavaScriptTestRunner,
  ctx: JavaScriptCoverageContext
): void {
  if (hasNonRunningJavaScriptTestArg(runner, args)) {
    return;
  }
  const targetArgs = runner === "vitest" ? withoutCommandOptionValues(args, ["--project"]) : args;
  const targets = targetArgs.map((arg) => normalizeCandidateTarget(arg, cwd, ctx.repoRoot)).filter((arg): arg is string => Boolean(arg));
  if (targets.length === 0 && runner === "vitest" && hasCommandOption(args, ["--project"])) {
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
  if (targets.length === 0) {
    ctx.addCoverage({ kind: "javascript-tests", command: commandText, source, scope: cwd, details: args });
    return;
  }
  addTargetedJavaScriptTestCoverage(targets, args, cwd, commandText, source, ctx);
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
  addTargetedJavaScriptTestCoverage(parsed.targets, testArgs, cwd, commandText, source, ctx);
}

function addTargetedJavaScriptTestCoverage(
  targets: string[],
  args: string[],
  cwd: string,
  commandText: string,
  source: string,
  ctx: Pick<JavaScriptCoverageContext, "addCoverage">
): void {
  for (const target of targets) {
    ctx.addCoverage({ kind: "javascript-tests", command: commandText, source, scope: cwd, targetPath: target, details: args });
    ctx.addCoverage({ kind: "targeted-test", command: commandText, source, scope: cwd, targetPath: target, details: args });
  }
}

function playwrightTestTargets(args: string[], cwd: string, repoRoot: string): { ok: true; targets: string[] } | { ok: false; reason: string } {
  const valueOptions = new Set([
    "-c",
    "--config",
    "-j",
    "--workers",
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
  const switchOptions = new Set(["--debug", "--fail-on-flaky-tests", "--forbid-only", "--fully-parallel", "--headed", "--no-deps", "--quiet", "-x"]);
  const targets: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") {
      continue;
    }
    const inlineOption = arg.startsWith("--") && arg.includes("=") ? arg.slice(0, arg.indexOf("=")) : undefined;
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

function hasCommandOption(args: string[], options: string[]): boolean {
  return args.some((arg) => options.some((option) => arg === option || arg.startsWith(`${option}=`)));
}

function withoutCommandOptionValues(args: string[], options: string[]): string[] {
  const remaining: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (options.some((option) => arg.startsWith(`${option}=`))) {
      continue;
    }
    if (options.includes(arg)) {
      index += 1;
      continue;
    }
    remaining.push(arg);
  }
  return remaining;
}

function hasNonRunningJavaScriptTestArg(runner: JavaScriptTestRunner, args: string[]): boolean {
  if (hasEnabledFlag(args, ["--version", "-v", "-V", "--help", "-h", "help", "--passWithNoTests", "--pass-with-no-tests"])) {
    return true;
  }
  if (runner === "vitest") {
    return (
      ["bench", "complete", "init", "list"].includes(args[0] ?? "") ||
      hasEnabledFlag(args, [
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
    return hasEnabledFlag(args, [
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
    return hasEnabledFlag(args, ["--watch", "--test-only", "--test-name-pattern", "--test-skip-pattern", "--test-shard", "--test-update-snapshots"]);
  }
  return hasEnabledFlag(args, [
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

function hasEnabledFlag(args: string[], flags: string[]): boolean {
  return args.some((arg) =>
    flags.some((flag) => {
      if (arg === flag) {
        return true;
      }
      if (!arg.startsWith(`${flag}=`)) {
        return false;
      }
      const value = arg.slice(flag.length + 1).toLowerCase();
      return value !== "false" && value !== "0" && value !== "off";
    })
  );
}
