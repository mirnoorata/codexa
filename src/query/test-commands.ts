import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Confidence } from "../types.js";

export interface CandidateTestCommand {
  command: string;
  source: string;
  confidence: Confidence;
}

export function candidateTestCommand(repoRoot: string, testPath: string): CandidateTestCommand | undefined {
  if (testPath.startsWith("web/") && /\.(test|spec)\.[cm]?[jt]sx?$/.test(testPath)) {
    return packageTestCommand(repoRoot, "web", testPath.slice("web/".length));
  }
  if (/\.py$/.test(testPath)) {
    return pythonTestCommand(repoRoot, testPath);
  }
  if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(testPath)) {
    return packageTestCommand(repoRoot, ".", testPath);
  }
  return undefined;
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
      Object.keys(scripts).find((name) => /^test(:|$)/.test(name) && /\b(vitest|jest|node --test|tsx|tsc)\b/.test(scripts[name])) ??
      (scripts.test ? "test" : undefined);
    if (!scriptName) {
      return undefined;
    }
    const packageManager = packageManagerFor(packageRoot);
    const cwd = packageDir === "." ? repoRoot : path.join(repoRoot, packageDir);
    const runner = packageManager === "npm" ? ["npm", "run", scriptName] : [packageManager, "run", scriptName];
    return {
      command: shellJoin(["cd", cwd]) + " && " + shellJoin([...runner, "--", relativeTestPath]),
      source: `${packageDir === "." ? "" : `${packageDir}/`}package.json#scripts.${scriptName}`,
      confidence: "heuristic"
    };
  } catch {
    return undefined;
  }
}

function packageManagerFor(packageRoot: string): "npm" | "pnpm" | "yarn" {
  if (existsSync(path.join(packageRoot, "pnpm-lock.yaml"))) {
    return "pnpm";
  }
  if (existsSync(path.join(packageRoot, "yarn.lock"))) {
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
  return {
    command: shellJoin(["cd", repoRoot]) + " && " + shellJoin([...runner, testPath]),
    source: metadataSources.slice(0, 3).join(", "),
    confidence: "heuristic"
  };
}

function shellJoin(parts: string[]): string {
  return parts.map(shellQuote).join(" ");
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) {
    return value;
  }
  return `'${value.replace(/'/g, "'\\''")}'`;
}
