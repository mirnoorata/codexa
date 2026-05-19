import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { VerificationCommandReport } from "./types.js";

const DEFAULT_MAX_COMMANDS = 2;
const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_SUMMARY = 500;

interface AutoVerifyCandidate {
  command: string;
  cwd?: string;
  executable?: string;
  args?: string[];
  rank: number;
}

export interface AutoVerifyResult {
  reports: VerificationCommandReport[];
  attempted: string[];
  skipped: string[];
}

export async function runAutoVerifyForPostEdit(repoRoot: string, data: unknown): Promise<AutoVerifyResult> {
  const candidates = autoVerifyCandidates(repoRoot, data);
  const reports: VerificationCommandReport[] = [];
  const attempted: string[] = [];
  const skipped: string[] = [];
  const trust = await autoVerifyTrusted(repoRoot);
  if (!trust.enabled) {
    return {
      reports,
      attempted,
      skipped: candidates.map((candidate) => `${candidate.command} (${trust.reason})`)
    };
  }
  for (const candidate of candidates) {
    if (reports.length >= DEFAULT_MAX_COMMANDS) {
      skipped.push(`${candidate.command} (max auto-verify commands reached)`);
      continue;
    }
    const safe = await safeAutoVerifyCommand(repoRoot, candidate);
    if (!safe.ok) {
      skipped.push(`${candidate.command} (${safe.reason})`);
      continue;
    }
    attempted.push(candidate.command);
    const report = await runVerificationCommand(safe.command, DEFAULT_TIMEOUT_MS);
    reports.push(report);
    if (report.exitCode !== 0) {
      break;
    }
  }
  return { reports, attempted, skipped };
}

async function autoVerifyTrusted(repoRoot: string): Promise<{ enabled: true } | { enabled: false; reason: string }> {
  if (process.env.CODEXA_AUTOVERIFY === "1" || process.env.CODEXA_AUTOVERIFY?.toLowerCase() === "true") {
    return { enabled: true };
  }
  const configPath = path.join(repoRoot, ".codex/config.toml");
  try {
    const config = await fs.readFile(configPath, "utf8");
    if (/^\s*(auto_verify|autoverify)\s*=\s*true\s*$/imu.test(config)) {
      return { enabled: true };
    }
  } catch {
    // Missing config means the repo has not opted in to executing its own tests from hooks.
  }
  return { enabled: false, reason: "AutoVerify execution requires CODEXA_AUTOVERIFY=1 or auto_verify=true in .codex/config.toml" };
}

function autoVerifyCandidates(repoRoot: string, data: unknown): AutoVerifyCandidate[] {
  if (!data || typeof data !== "object") {
    return [];
  }
  const record = data as { testsNotRun?: unknown; missedLikelyTests?: unknown };
  const seen = new Set<string>();
  const candidates: AutoVerifyCandidate[] = [];
  const add = (items: unknown, baseRank: number) => {
    if (!Array.isArray(items)) {
      return;
    }
    items.forEach((item, index) => {
      if (!item || typeof item !== "object") {
        return;
      }
      const entry = item as { command?: unknown; commandCwd?: unknown; commandExecutable?: unknown; commandArgs?: unknown };
      const command = entry.command;
      if (typeof command !== "string" || !command.trim() || seen.has(command)) {
        return;
      }
      seen.add(command);
      candidates.push({
        command: materializeDisplayCommand(repoRoot, command),
        cwd: typeof entry.commandCwd === "string" ? materializePathValue(repoRoot, entry.commandCwd) : undefined,
        executable: typeof entry.commandExecutable === "string" ? entry.commandExecutable : undefined,
        args: Array.isArray(entry.commandArgs) && entry.commandArgs.every((arg) => typeof arg === "string") ? entry.commandArgs.map((arg) => materializePathValue(repoRoot, arg)) : undefined,
        rank: baseRank - index
      });
    });
  };
  add(record.testsNotRun, 2000);
  add(record.missedLikelyTests, 1000);
  return candidates.sort((a, b) => b.rank - a.rank || a.command.localeCompare(b.command));
}

function materializeDisplayCommand(repoRoot: string, command: string): string {
  return command.replace(/<repo>(\/[^\s&|;]*)?/gu, (_match, suffix: string | undefined) => path.join(repoRoot, suffix ?? ""));
}

function materializePathValue(repoRoot: string, value: string): string {
  return value.replace(/<repo>(\/[^\s]*)?/gu, (_match, suffix: string | undefined) => path.join(repoRoot, suffix ?? ""));
}

interface SafeAutoVerifyCommand {
  command: string;
  cwd: string;
  spawnCwd: string;
  executable: string;
  args: string[];
}

async function safeAutoVerifyCommand(repoRoot: string, candidate: AutoVerifyCandidate): Promise<{ ok: true; command: SafeAutoVerifyCommand } | { ok: false; reason: string }> {
  if (!candidate.cwd || !candidate.executable || !candidate.args) {
    return { ok: false, reason: "missing structured command fields" };
  }
  if (candidate.command.length > 1000 || /[\0\r\n]/u.test(candidate.command)) {
    return { ok: false, reason: "unsupported command display" };
  }
  if (!safeExecutableName(candidate.executable) || candidate.args.some((arg) => /[\0\r\n]/u.test(arg))) {
    return { ok: false, reason: "unsupported command argv" };
  }
  const repoRealRoot = await realpathOrUndefined(repoRoot);
  if (!repoRealRoot) {
    return { ok: false, reason: "repo root is unavailable" };
  }
  const cwd = path.isAbsolute(candidate.cwd) ? path.resolve(candidate.cwd) : path.resolve(repoRoot, candidate.cwd);
  if (!isSubpath(cwd, repoRoot)) {
    return { ok: false, reason: "command cwd is outside repo" };
  }
  const cwdReal = await realpathOrUndefined(cwd);
  if (!cwdReal || !isSubpath(cwdReal, repoRealRoot)) {
    return { ok: false, reason: "command cwd is outside repo" };
  }
  const words = [candidate.executable, ...candidate.args];
  const safety = await safeRunnerInvocation(repoRoot, repoRealRoot, cwd, cwdReal, words);
  return safety.ok ? { ok: true, command: { command: candidate.command, cwd, spawnCwd: cwdReal, executable: candidate.executable, args: candidate.args } } : safety;
}

async function safeRunnerInvocation(
  repoRoot: string,
  repoRealRoot: string,
  cwd: string,
  cwdReal: string,
  words: string[]
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const first = words[0];
  if ((first === "npm" || first === "pnpm") && words[1] === "run" && words[2]) {
    return safePackageTestScript(repoRoot, repoRealRoot, cwd, cwdReal, words[2], words.slice(3));
  }
  if ((first === "npm" || first === "pnpm") && (words[1] === "test" || words[1] === "t")) {
    return safePackageTestScript(repoRoot, repoRealRoot, cwd, cwdReal, "test", words.slice(2));
  }
  if (first === "yarn" && words[1]) {
    const scriptName = words[1] === "run" ? words[2] : words[1];
    return scriptName ? safePackageTestScript(repoRoot, repoRealRoot, cwd, cwdReal, scriptName, words.slice(words[1] === "run" ? 3 : 2)) : { ok: false, reason: "missing yarn script" };
  }
  if (first === "node" && words[1] === "--test") {
    return (await allArgsAreTestTargets(repoRoot, repoRealRoot, cwd, cwdReal, words.slice(2))) ? { ok: true } : { ok: false, reason: "node --test is not targeted" };
  }
  if (first === "vitest" || first === "jest") {
    return (await allArgsAreTestTargets(repoRoot, repoRealRoot, cwd, cwdReal, words.slice(1))) ? { ok: true } : { ok: false, reason: `${first} command is not targeted` };
  }
  if (first === "pytest") {
    return (await allArgsAreTestTargets(repoRoot, repoRealRoot, cwd, cwdReal, words.slice(1))) ? { ok: true } : { ok: false, reason: "pytest command is not targeted" };
  }
  if (first === "uv" && words[1] === "run" && words[2] === "pytest") {
    return (await allArgsAreTestTargets(repoRoot, repoRealRoot, cwd, cwdReal, words.slice(3))) ? { ok: true } : { ok: false, reason: "uv pytest command is not targeted" };
  }
  if ((first === "python" || first === "python3") && words[1] === "-m" && words[2] === "pytest") {
    return (await allArgsAreTestTargets(repoRoot, repoRealRoot, cwd, cwdReal, words.slice(3))) ? { ok: true } : { ok: false, reason: "python pytest command is not targeted" };
  }
  return { ok: false, reason: "runner is not allowlisted" };
}

async function safePackageTestScript(
  repoRoot: string,
  repoRealRoot: string,
  cwd: string,
  cwdReal: string,
  scriptName: string,
  args: string[]
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!/^test(?::[\w:-]+)?$/u.test(scriptName)) {
    return { ok: false, reason: "package script is not a test script" };
  }
  const forwarded = args[0] === "--" ? args.slice(1) : args;
  if (!(await allArgsAreTestTargets(repoRoot, repoRealRoot, cwd, cwdReal, forwarded))) {
    return { ok: false, reason: "package test command is not targeted" };
  }
  const scripts = await packageScripts(cwd);
  const script = scripts?.[scriptName];
  if (!script || typeof script !== "string") {
    return { ok: false, reason: "package test script was not found" };
  }
  if (scripts?.[`pre${scriptName}`] || scripts?.[`post${scriptName}`]) {
    return { ok: false, reason: "package test script has lifecycle hooks" };
  }
  if (!safeScriptBody(script)) {
    return { ok: false, reason: "package test script is not safe to auto-run" };
  }
  return { ok: true };
}

async function packageScripts(cwd: string): Promise<Record<string, unknown> | undefined> {
  const packagePath = path.join(cwd, "package.json");
  try {
    const parsed = JSON.parse(await fs.readFile(packagePath, "utf8")) as { scripts?: Record<string, unknown> };
    return parsed.scripts;
  } catch {
    return undefined;
  }
}

function safeScriptBody(script: string): boolean {
  if (/[\0\r\n;&|`$<>]/u.test(script) || /\$\(/u.test(script)) {
    return false;
  }
  const words = stripLeadingEnvironment(shellWords(script));
  const first = words[0];
  return (
    first === "vitest" ||
    first === "jest" ||
    first === "pytest" ||
    (first === "node" && words[1] === "--test") ||
    ((first === "python" || first === "python3") && words[1] === "-m" && words[2] === "pytest") ||
    (first === "uv" && words[1] === "run" && words[2] === "pytest")
  );
}

async function allArgsAreTestTargets(repoRoot: string, repoRealRoot: string, cwd: string, cwdReal: string, args: string[]): Promise<boolean> {
  const positional = args.filter((arg) => !arg.startsWith("-"));
  if (positional.length === 0) {
    return false;
  }
  for (const arg of positional) {
    if (!(await isRepoTestTarget(repoRoot, repoRealRoot, cwd, cwdReal, arg))) {
      return false;
    }
  }
  return true;
}

async function isRepoTestTarget(repoRoot: string, repoRealRoot: string, cwd: string, cwdReal: string, value: string): Promise<boolean> {
  if (/[\0\r\n;&|`$<>:*?[\]{}]/u.test(value)) {
    return false;
  }
  const absolute = path.resolve(cwd, value);
  if (!isSubpath(absolute, repoRoot)) {
    return false;
  }
  const real = await realpathOrUndefined(path.resolve(cwdReal, path.relative(cwd, absolute)));
  if (!real || !isSubpath(real, repoRealRoot)) {
    return false;
  }
  const relative = path.relative(repoRoot, absolute).split(path.sep).join("/");
  const realRelative = path.relative(repoRealRoot, real).split(path.sep).join("/");
  return isTestTargetPath(relative) || isTestTargetPath(realRelative);
}

async function runVerificationCommand(command: SafeAutoVerifyCommand, timeoutMs: number): Promise<VerificationCommandReport> {
  const startedAt = Date.now();
  const result = await new Promise<{ exitCode: number; stdout: string; stderr: string; timedOut: boolean }>((resolve) => {
    const detached = process.platform !== "win32";
    const child = spawn(command.executable, command.args, {
      cwd: command.spawnCwd,
      env: { ...process.env, CI: process.env.CI ?? "1" },
      detached,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const killChild = (signal: NodeJS.Signals) => {
      if (!child.pid) {
        return;
      }
      try {
        process.kill(detached ? -child.pid : child.pid, signal);
      } catch {
        // The process may already have exited; the close handler will settle the report.
      }
    };
    const killTimer = setTimeout(() => {
      timedOut = true;
      killChild("SIGTERM");
      setTimeout(() => killChild("SIGKILL"), 2_000).unref();
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout = boundedAppend(stdout, chunk);
    });
    child.stderr.on("data", (chunk: string) => {
      stderr = boundedAppend(stderr, chunk);
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      stderr = boundedAppend(stderr, error.message);
    });
    child.on("close", (code) => {
      clearTimeout(killTimer);
      resolve({ exitCode: timedOut ? 124 : code ?? 1, stdout, stderr, timedOut });
    });
  });
  return {
    command: command.command,
    cwd: command.cwd,
    args: command.args,
    exitCode: result.exitCode,
    durationMs: Date.now() - startedAt,
    stdoutSummary: summarizeOutput(result.stdout),
    stderrSummary: summarizeOutput(result.timedOut ? `${result.stderr}\nTimed out after ${timeoutMs}ms` : result.stderr)
  };
}

async function realpathOrUndefined(value: string): Promise<string | undefined> {
  try {
    return await fs.realpath(value);
  } catch {
    return undefined;
  }
}

function isTestTargetPath(value: string): boolean {
  return /(^|\/)(tests?|__tests__)\//u.test(value) || /\.(test|spec)\.[cm]?[jt]sx?$/u.test(value) || /(^|\/)test_[^/]+\.py$/u.test(value) || /_test\.py$/u.test(value);
}

function summarizeOutput(value: string): string | undefined {
  const clean = value
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-8)
    .join(" ")
    .replace(/\s+/gu, " ")
    .trim();
  if (!clean) {
    return undefined;
  }
  return clean.length > MAX_OUTPUT_SUMMARY ? `${clean.slice(0, MAX_OUTPUT_SUMMARY - 3)}...` : clean;
}

function boundedAppend(current: string, chunk: string): string {
  const next = current + chunk;
  return next.length > 20_000 ? next.slice(next.length - 20_000) : next;
}

function safeExecutableName(value: string): boolean {
  return /^(npm|pnpm|yarn|node|vitest|jest|pytest|uv|python|python3)$/u.test(value);
}

function shellWords(value: string): string[] {
  return [...value.matchAll(/'([^']*)'|"([^"]*)"|(\S+)/gu)].map((match) => stripQuotes(match[1] ?? match[2] ?? match[3] ?? ""));
}

function stripLeadingEnvironment(words: string[]): string[] {
  let index = 0;
  while (index < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/u.test(words[index])) {
    index += 1;
  }
  return words.slice(index);
}

function stripQuotes(value: string): string {
  return value.replace(/^['"]|['"]$/gu, "");
}

function isSubpath(candidate: string, parent: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
