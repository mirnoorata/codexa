import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Confidence } from "../types.js";
import { resolveToolInvocation } from "./verification/script-credit.js";
import {
  shellQuote,
  shellWords,
  splitShellSequence,
  stripLeadingEnvironment,
  stripPackageManagerFlags,
  stripShellControlWords
} from "./verification/shell.js";

export interface CandidateTestCommand {
  command: string;
  commandCwd: string;
  commandExecutable: string;
  commandArgs: string[];
  source: string;
  confidence: Confidence;
}

export function candidateTestCommand(repoRoot: string, testPath: string): CandidateTestCommand | undefined {
  if (/\.py$/.test(testPath)) {
    return pythonTestCommand(repoRoot, testPath);
  }
  if (/\.(test|spec|cy)\.[cm]?[jt]sx?$/.test(testPath)) {
    const packageRoot = nearestPackageRoot(repoRoot, testPath);
    const relativeTestPath = packageRoot === "." ? testPath : path.posix.relative(packageRoot, testPath);
    return packageTestCommand(repoRoot, packageRoot, relativeTestPath);
  }
  return undefined;
}

function nearestPackageRoot(repoRoot: string, testPath: string): string {
  let dir = path.posix.dirname(testPath);
  while (dir && dir !== ".") {
    if (existsSync(path.join(repoRoot, dir, "package.json"))) {
      return dir;
    }
    dir = path.posix.dirname(dir);
  }
  return ".";
}

function packageTestCommand(repoRoot: string, packageDir: string, relativeTestPath: string): CandidateTestCommand | undefined {
  const packageRoot = path.join(repoRoot, packageDir);
  const packageJsonPath = path.join(packageRoot, "package.json");
  if (!existsSync(packageJsonPath)) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { scripts?: Record<string, string> };
    const scripts = parsed.scripts ?? {};
    const scriptName =
      scripts.test && isKnownVerificationScript(scripts.test)
        ? "test"
        : Object.keys(scripts).find((name) => /^test:/u.test(name) && isKnownVerificationScript(scripts[name])) ?? (scripts.test ? "test" : undefined);
    if (!scriptName) {
      return undefined;
    }
    const packageManager = packageManagerFor(packageRoot, repoRoot);
    const cwd = packageDir === "." ? repoRoot : path.join(repoRoot, packageDir);
    const runner = packageManager === "npm" ? ["npm", "run", scriptName] : [packageManager, "run", scriptName];
    // Compile-only and unknown scripts are useful repository checks, but they
    // do not accept a test-file selector. Passing a path to `tsc --noEmit`, for
    // example, changes project-mode semantics and can bypass the tsconfig.
    const selectorArgs = testPathArguments(scripts[scriptName], relativeTestPath);
    const args = selectorArgs
      ? [...runner.slice(1), "--", ...selectorArgs]
      : runner.slice(1);
    return {
      command: shellJoin(["cd", cwd]) + " && " + shellJoin([runner[0], ...args]),
      commandCwd: cwd,
      commandExecutable: runner[0],
      commandArgs: args,
      source: `${packageDir === "." ? "" : `${packageDir}/`}package.json#scripts.${scriptName}`,
      confidence: "heuristic"
    };
  } catch {
    return undefined;
  }
}

function testPathArguments(script: string, testPath: string): string[] | undefined {
  const runner = selectorForwardingRunner(script);
  if (!runner) return undefined;
  return runner === "cypress" ? ["--spec", testPath] : [testPath];
}

function selectorForwardingRunner(script: string): "vitest" | "jest" | "playwright" | "cypress" | "node-test" | undefined {
  const segments = splitShellSequence(script);
  if (segments.length !== 1 || segments[0]?.operator !== "start" || /(?:\$\(|`|[<>])/u.test(script)) {
    return undefined;
  }
  const words = stripPackageManagerFlags(
    stripShellControlWords(stripLeadingEnvironment(shellWords(segments[0].text)))
  );
  const invocation = resolveToolInvocation(words);
  if (!invocation.executesResolvedTool) return undefined;
  if (invocation.command === "vitest" && (invocation.args.length === 0 || (invocation.args.length === 1 && invocation.args[0] === "run"))) {
    return "vitest";
  }
  if (invocation.command === "jest" && invocation.args.length === 0) return "jest";
  if (invocation.command === "playwright" && invocation.args.length === 1 && invocation.args[0] === "test") return "playwright";
  if (invocation.command === "cypress" && invocation.args.length === 1 && invocation.args[0] === "run") return "cypress";
  if (invocation.command === "node" && invocation.args.length === 1 && invocation.args[0] === "--test") return "node-test";
  return undefined;
}

function supportsTestPath(script: string): boolean {
  return /\b(?:vitest|jest|mocha|ava|tap|playwright\s+test|cypress\s+run|node\s+--test|bun\s+test|deno\s+test|tsx\s+--test)\b/u.test(script);
}

function isKnownVerificationScript(script: string): boolean {
  return supportsTestPath(script) || /\b(?:tsc|vue-tsc)\b/u.test(script);
}

function packageManagerFor(packageRoot: string, repoRoot: string): "npm" | "pnpm" | "yarn" {
  if (existsSync(path.join(packageRoot, "pnpm-lock.yaml"))) {
    return "pnpm";
  }
  if (existsSync(path.join(packageRoot, "yarn.lock"))) {
    return "yarn";
  }
  if (packageRoot !== repoRoot && existsSync(path.join(repoRoot, "pnpm-lock.yaml"))) {
    return "pnpm";
  }
  if (packageRoot !== repoRoot && existsSync(path.join(repoRoot, "yarn.lock"))) {
    return "yarn";
  }
  return "npm";
}

function pythonTestCommand(repoRoot: string, testPath: string): CandidateTestCommand | undefined {
  const pyprojectPath = path.join(repoRoot, "pyproject.toml");
  const pytestIniPath = path.join(repoRoot, "pytest.ini");
  const toxIniPath = path.join(repoRoot, "tox.ini");
  const setupCfgPath = path.join(repoRoot, "setup.cfg");
  const requirements = ["requirements.txt", "requirements-dev.txt", "requirements-test.txt"]
    .map((file) => path.join(repoRoot, file))
    .filter((file) => existsSync(file));
  const metadataSources: string[] = [];
  let hasPytestEvidence = false;
  for (const candidate of [pyprojectPath, pytestIniPath, toxIniPath, setupCfgPath, ...requirements]) {
    if (!existsSync(candidate)) {
      continue;
    }
    const relative = path.relative(repoRoot, candidate) || path.basename(candidate);
    const text = readFileSync(candidate, "utf8");
    if (/pytest/i.test(text) || path.basename(candidate) === "pytest.ini") {
      hasPytestEvidence = true;
      metadataSources.push(relative);
    }
  }
  if (!hasPytestEvidence) {
    return undefined;
  }
  const runner = existsSync(path.join(repoRoot, "uv.lock")) ? ["uv", "run", "pytest"] : ["pytest"];
  const args = [...runner.slice(1), testPath];
  return {
    command: shellJoin(["cd", repoRoot]) + " && " + shellJoin([runner[0], ...args]),
    commandCwd: repoRoot,
    commandExecutable: runner[0],
    commandArgs: args,
    source: metadataSources.slice(0, 3).join(", "),
    confidence: "heuristic"
  };
}

function shellJoin(parts: string[]): string {
  return parts.map(shellQuote).join(" ");
}
