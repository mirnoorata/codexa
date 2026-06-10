import { execFileSync } from "node:child_process";
import path from "node:path";
import type { EvalScenario } from "./types.js";

export interface BaselineRun {
  command: string[];
  output: string;
}

function runBaseline(command: string[], cwd: string): string {
  assertAllowedBaseline(command);
  if (command[0] === "rg") {
    return runRipgrepBaseline(command.slice(1), cwd);
  }
  return runBaselineCommand(command, cwd);
}

export function runScenarioBaselines(scenario: EvalScenario): BaselineRun[] | null {
  const commands = scenario.baselineCommands?.length ? scenario.baselineCommands : scenario.baselineCommand ? [scenario.baselineCommand] : [];
  if (commands.length === 0) {
    return null;
  }
  const cwd = scenario.baselineCwd ?? scenario.repoRoot;
  return commands.map((command) => ({ command, output: runBaseline(command, cwd) }));
}

function assertAllowedBaseline(command: string[]): void {
  const executable = command[0];
  for (const arg of command) {
    if (isUnsafeBaselineArgument(arg)) {
      throw new Error(`baseline command contains unsafe argument: ${arg}`);
    }
  }
  if (executable === "rg" && isAllowedRipgrepBaseline(command.slice(1))) {
    return;
  }
  if (isAllowedGitStatusBaseline(command) || isAllowedGitGrepBaseline(command)) {
    return;
  }
  throw new Error(`unsupported baseline executable: ${executable}`);
}

function isAllowedGitStatusBaseline(command: string[]): boolean {
  return command[0] === "git" && command[1] === "status" && command.length === 3 && (command[2] === "--short" || command[2] === "--porcelain");
}

function isAllowedGitGrepBaseline(command: string[]): boolean {
  if (command[0] !== "git" || command[1] !== "grep") {
    return false;
  }
  const allowedFlags = new Set(["-n", "--line-number", "-E", "-F", "-e", "-m", "--"]);
  for (let i = 2; i < command.length; i += 1) {
    const arg = command[i];
    if (command[i - 1] === "-e" || command[i - 1] === "-m") {
      continue;
    }
    if (arg.startsWith("-") && !allowedFlags.has(arg)) {
      return false;
    }
  }
  return true;
}

function isAllowedRipgrepBaseline(args: string[]): boolean {
  return parseRipgrepBaselineArgs(args) !== undefined;
}

function isUnsafeBaselineArgument(value: string): boolean {
  if (value === ".") {
    return false;
  }
  return path.isAbsolute(value) || value === ".codex" || value.includes(".codex/") || value.includes(".codex\\") || value.includes("../") || value.includes("..\\");
}

function runRipgrepBaseline(args: string[], cwd: string): string {
  try {
    return execFileSync("rg", args, {
      cwd,
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 2 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"]
    });
  } catch (error) {
    if (isMissingExecutable(error)) {
      return runGitGrepBaseline(args, cwd);
    }
    return handleBaselineError(error);
  }
}

function runGitGrepBaseline(rgArgs: string[], cwd: string): string {
  const parsed = parseRipgrepBaselineArgs(rgArgs);
  if (!parsed) {
    return "";
  }
  return runBaselineCommand(["git", "grep", "-n", "-E", "-m", "25", "-e", parsed.pattern, "--", ...parsed.paths, ":(exclude).codex/**"], cwd);
}

function parseRipgrepBaselineArgs(args: string[]): { pattern: string; paths: string[] } | undefined {
  let pattern: string | undefined;
  const paths: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "-n" || arg === "--line-number") {
      continue;
    }
    if (arg === "--") {
      continue;
    }
    if (arg === "-e") {
      if (!args[i + 1]) {
        return undefined;
      }
      pattern = args[i + 1];
      i += 1;
      continue;
    }
    if (arg.startsWith("-")) {
      return undefined;
    }
    if (!pattern) {
      pattern = arg;
      continue;
    }
    paths.push(arg);
  }
  return pattern ? { pattern, paths: paths.length > 0 ? paths : ["."] } : undefined;
}

function runBaselineCommand(command: string[], cwd: string): string {
  try {
    return execFileSync(command[0], command.slice(1), {
      cwd,
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 2 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"]
    });
  } catch (error) {
    return handleBaselineError(error);
  }
}

function handleBaselineError(error: unknown): string {
  const status = error && typeof error === "object" && "status" in error ? Number((error as { status?: unknown }).status) : undefined;
  if (status !== undefined && status > 1) {
    throw error;
  }
  if (error && typeof error === "object" && "stdout" in error) {
    return String((error as { stdout?: unknown }).stdout ?? "");
  }
  return "";
}

function isMissingExecutable(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT");
}

export function formatBaselineCommands(scenario: EvalScenario): string {
  const commands = scenario.baselineCommands?.length ? scenario.baselineCommands : scenario.baselineCommand ? [scenario.baselineCommand] : [];
  return commands.length > 0 ? commands.map((command) => command.join(" ")).join(" && ") : "unknown";
}
