import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Confidence } from "../types.js";

export interface CandidateTestCommand {
  command: string;
  source: string;
  confidence: Confidence;
}

export function candidateTestCommand(repoRoot: string, testPath: string): CandidateTestCommand | undefined {
  if (/\.py$/.test(testPath)) {
    return pythonTestCommand(repoRoot, testPath);
  }
  if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(testPath)) {
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
      scripts.test && /\b(vitest|jest|node --test|tsx|tsc)\b/.test(scripts.test)
        ? "test"
        : Object.keys(scripts).find((name) => /^test:/u.test(name) && /\b(vitest|jest|node --test|tsx|tsc)\b/.test(scripts[name])) ?? (scripts.test ? "test" : undefined);
    if (!scriptName) {
      return undefined;
    }
    const packageManager = packageManagerFor(packageRoot, repoRoot);
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
