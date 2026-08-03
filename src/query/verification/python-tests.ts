import { uniqueSorted } from "../../util.js";
import { normalizeCandidateTarget, type CoverageAddInput } from "./command-scope.js";
import { hasNonRunningPythonTestArg } from "./shell.js";

interface PythonCoverageContext {
  repoRoot: string;
  addCoverage: (coverage: CoverageAddInput) => void;
}

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
