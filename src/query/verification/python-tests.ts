import path from "node:path";
import type { CodexaIndex } from "../../types.js";
import { uniqueSorted } from "../../util.js";
import { normalizeCandidateTarget, normalizeCwd, normalizePathLike, type CoverageAddInput } from "./command-scope.js";
import { hasNonRunningPythonTestArg, stripQuotes } from "./shell.js";

interface PythonCoverageContext {
  index: Pick<CodexaIndex, "files">;
  repoRoot: string;
  addCoverage: (coverage: CoverageAddInput) => void;
}

const MAX_DISCOVERED_UNITTEST_TARGETS = 256;

export function addPythonTestCoverage(
  args: string[],
  cwd: string,
  commandText: string,
  source: string,
  ctx: PythonCoverageContext
): void {
  if (hasNonRunningPythonTestArg(args) || args.some((arg) => ["--collect-only", "--co", "--fixtures"].includes(arg))) {
    return;
  }
  const parsed = pythonTestTargets(args, cwd, ctx.repoRoot);
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
  if (parsed.targets.length === 0) {
    ctx.addCoverage({ kind: "python-tests", command: commandText, source, scope: cwd, details: args });
    return;
  }
  for (const target of parsed.targets) {
    ctx.addCoverage({ kind: "python-tests", command: commandText, source, scope: cwd, targetPath: target, details: args });
    ctx.addCoverage({ kind: "targeted-test", command: commandText, source, scope: cwd, targetPath: target, details: args });
  }
}

export function addPythonUnittestCoverage(
  args: string[],
  cwd: string,
  commandText: string,
  source: string,
  ctx: PythonCoverageContext
): void {
  const parsed = pythonUnittestDiscoverTargets(args, cwd, ctx);
  if (!parsed.ok) {
    ctx.addCoverage({ kind: "unknown", command: commandText, source: parsed.reason, confidence: "derived", scope: cwd, details: args });
    return;
  }
  for (const target of parsed.targets) {
    ctx.addCoverage({ kind: "python-tests", command: commandText, source, scope: parsed.scope, targetPath: target, details: args });
  }
}

function pythonUnittestDiscoverTargets(
  args: string[],
  cwd: string,
  ctx: PythonCoverageContext
): { ok: true; scope: string; targets: string[] } | { ok: false; reason: string } {
  if (args[0] !== "discover") {
    return { ok: false, reason: "Python unittest invocation is not explicit discovery" };
  }
  const switches = new Set(["-v", "--verbose", "-q", "--quiet", "-f", "--failfast", "-c", "--catch", "-b", "--buffer"]);
  let startDirectory = ".";
  let topLevelDirectory: string | undefined;
  let sawStartDirectory = false;
  let pattern = "test*.py";
  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index];
    if (switches.has(arg)) continue;
    const option = unittestValueOption(arg);
    if (!option && ["-s", "--start-directory", "-p", "--pattern", "-t", "--top-level-directory"].includes(arg)) {
      const rawValue = args[index + 1];
      if (!rawValue || rawValue.startsWith("-")) {
        return { ok: false, reason: `Python unittest option ${arg} is missing its value` };
      }
      const value = stripQuotes(rawValue);
      index += 1;
      if (arg === "-s" || arg === "--start-directory") {
        if (sawStartDirectory) return { ok: false, reason: "Python unittest discovery has multiple start directories" };
        startDirectory = value;
        sawStartDirectory = true;
      } else if (arg === "-p" || arg === "--pattern") {
        pattern = value;
      } else {
        topLevelDirectory = value;
      }
      continue;
    }
    if (option) {
      if (option.name === "--start-directory") {
        if (sawStartDirectory) return { ok: false, reason: "Python unittest discovery has multiple start directories" };
        startDirectory = option.value;
        sawStartDirectory = true;
      } else if (option.name === "--pattern") {
        pattern = option.value;
      } else {
        topLevelDirectory = option.value;
      }
      continue;
    }
    return { ok: false, reason: `Python unittest argument ${arg} has unsupported discovery semantics` };
  }
  if (pattern !== "test*.py") {
    return { ok: false, reason: `Python unittest pattern ${pattern} is not the complete default discovery pattern` };
  }
  const scope = normalizeUnittestDirectory(startDirectory, cwd, ctx.repoRoot);
  if (!scope) {
    return { ok: false, reason: `Python unittest start directory ${startDirectory} is outside the repository or unsafe` };
  }
  if (topLevelDirectory && !normalizeUnittestDirectory(topLevelDirectory, cwd, ctx.repoRoot)) {
    return { ok: false, reason: `Python unittest top-level directory ${topLevelDirectory} is outside the repository or unsafe` };
  }
  const indexedPaths = new Set(ctx.index.files.map((file) => normalizePathLike(file.path)));
  const targets = uniqueSorted(
    [...indexedPaths].filter((filePath) => unittestDiscoveryCoversPath(scope, filePath, indexedPaths))
  );
  if (targets.length === 0) {
    return { ok: false, reason: `Python unittest discovery under ${scope} matched no indexed default test modules` };
  }
  if (targets.length > MAX_DISCOVERED_UNITTEST_TARGETS) {
    return { ok: false, reason: `Python unittest discovery exceeds ${MAX_DISCOVERED_UNITTEST_TARGETS} indexed test modules` };
  }
  return { ok: true, scope, targets };
}

function unittestValueOption(arg: string): { name: "--start-directory" | "--pattern" | "--top-level-directory"; value: string } | undefined {
  for (const name of ["--start-directory", "--pattern", "--top-level-directory"] as const) {
    if (arg.startsWith(`${name}=`)) {
      const value = stripQuotes(arg.slice(name.length + 1));
      return value ? { name, value } : undefined;
    }
  }
  return undefined;
}

function normalizeUnittestDirectory(value: string, cwd: string, repoRoot: string): string | undefined {
  if (!value || cwd.startsWith("__outside_repo__:") || /[\0*?\[\]{}!]/u.test(value)) return undefined;
  const candidate = path.isAbsolute(value)
    ? normalizeCwd(value, repoRoot)
    : normalizeCwd(path.posix.join(cwd === "." ? "" : cwd, value), repoRoot);
  if (candidate.startsWith("__outside_repo__:") || candidate.split("/").includes("..")) return undefined;
  return normalizePathLike(candidate);
}

function unittestDiscoveryCoversPath(scope: string, filePath: string, indexedPaths: Set<string>): boolean {
  if (!/^test[A-Za-z0-9_]*\.py$/u.test(path.posix.basename(filePath))) return false;
  const relative = path.posix.relative(scope, filePath);
  if (!relative || relative.startsWith("../") || path.posix.isAbsolute(relative)) return false;
  const parent = path.posix.dirname(relative);
  if (parent === ".") return true;
  const segments = parent.split("/");
  let directory = scope;
  for (const segment of segments) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(segment)) return false;
    directory = normalizePathLike(path.posix.join(directory, segment));
    if (!indexedPaths.has(normalizePathLike(path.posix.join(directory, "__init__.py")))) return false;
  }
  return true;
}

function pythonTestTargets(
  args: string[],
  cwd: string,
  repoRoot: string
): { ok: true; targets: string[] } | { ok: false; reason: string } {
  const neutralSwitches = new Set([
    "-q",
    "--quiet",
    "-v",
    "--verbose",
    "-s",
    "--disable-warnings",
    "--strict-config",
    "--strict-markers"
  ]);
  const neutralValueOptions = new Set(["--capture", "--color", "--show-capture", "--tb"]);
  const targets: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") continue;
    const inlineOption = arg.startsWith("-") && arg.includes("=") ? arg.slice(0, arg.indexOf("=")) : undefined;
    if (inlineOption && neutralValueOptions.has(inlineOption)) continue;
    if (neutralValueOptions.has(arg)) {
      if (!args[index + 1]) {
        return { ok: false, reason: `Python test option ${arg} is missing its value` };
      }
      index += 1;
      continue;
    }
    if (neutralSwitches.has(arg)) continue;
    if (arg.startsWith("-")) {
      return { ok: false, reason: `Python test option ${arg} has unsupported scope semantics` };
    }
    const target = normalizeCandidateTarget(arg, cwd, repoRoot);
    if (!target || !(target.endsWith(".py") || target.startsWith("tests/"))) {
      return { ok: false, reason: `Python test selector ${arg} is not an explicit in-repository test path` };
    }
    targets.push(target);
  }
  return { ok: true, targets: uniqueSorted(targets) };
}
