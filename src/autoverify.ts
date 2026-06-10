import { createHash } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { getGitStateAsync, repoRelativePath as gitRepoRelativePath } from "./git.js";
import { effectiveAutonomyMode } from "./autonomy.js";
import { isSourcePath, isTestPath, shouldSkipPath } from "./language.js";
import { AUTO_VERIFY_POLICY_DIGEST, AUTO_VERIFY_POLICY_ID, autoVerifyPolicySignature as policySignature, isTrustedAutoVerifyReport, markTrustedAutoVerifyReport } from "./autoverify/policy.js";
import type { AutoVerifyCandidate, VerificationCommandReport } from "./types.js";
import { shellWords } from "./query/verification/shell.js";
import { isSubpath, stableId, uniqueSorted } from "./util.js";

const execFileAsync = promisify(execFile);
const DEFAULT_MAX_COMMANDS = 2;
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_OUTPUT_SUMMARY = 500;
const MAX_OUTPUT_CAPTURE = 20_000;
interface AutoVerifyCandidateInternal extends AutoVerifyCandidate {
  protectedPaths: string[];
}

interface SafeAutoVerifyCommand {
  candidate: AutoVerifyCandidateInternal;
  command: string;
  cwd: string;
  spawnCwd: string;
  executable: string;
  spawnExecutable: string;
  spawnArgs: string[];
  args: string[];
  reportArgs?: string[];
  packageManager?: string;
  packageRoot?: string;
  scriptName?: string;
  targetRealpaths: string[];
  allowedBy: string[];
  pathEnv: string;
}

interface ResolvedExecutable {
  executablePath: string;
  spawnExecutable: string;
  spawnArgs: string[];
  pathEnvExecutable: string;
}

interface RunnerDirtyState {
  headCommit: string | null;
  dirtyFiles: string[];
  dirtyFileHashes: Record<string, string>;
  allStatuses: Map<string, string>;
  protectedHashes: Map<string, string>;
  untrackedProtectedFiles: Set<string>;
  worktreeRoot: string;
  fullStatuses: Map<string, string>;
  fullProtectedHashes: Map<string, string>;
  fullUntrackedProtectedFiles: Set<string>;
  degradedReason?: string;
}

export interface AutoVerifyResult {
  reports: AutoVerifyCommandReport[];
  attempted: string[];
  skipped: string[];
}

export interface AutoVerifyCommandReport extends VerificationCommandReport {
  runner: AutoVerifyReportRunner;
}

export function isTrustedAutoVerifyCommandReport(report: unknown): report is AutoVerifyCommandReport {
  return isTrustedAutoVerifyReport(report);
}

export function autoVerifyPolicySignature(): string {
  return policySignature();
}

export interface AutoVerifyReportRunner {
  schemaVersion: 1;
  reportKind: "codexa-autoverify-report";
  runnerName: "codexa";
  runnerVersion: string;
  policyId: "local-targeted-tests-v1";
  policyDigest: string;
  taskId: string;
  snapshotDigest: string;
  commandId: string;
  candidateDigest: string;
  headCommit: string | null;
  dirtyHashBefore: string;
  dirtyHashAfter: string;
  cwdRealpath: string;
  targetRealpaths: string[];
  envMode: "minimal";
  allowedBy: string[];
  sourceMutationDetected: boolean;
  timedOut: boolean;
  startedAt: string;
  finishedAt: string;
  signal?: string;
  outputRedacted: boolean;
  canonicalDigest: string;
  skippedReason?: string;
}

export async function runAutoVerifyForPostEdit(repoRoot: string, data: unknown): Promise<AutoVerifyResult> {
  const candidates = autoVerifyCandidates(repoRoot, data);
  const reports: AutoVerifyCommandReport[] = [];
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
    const before = await runnerDirtyState(repoRoot, safe.command.candidate.protectedPaths);
    const report = await runVerificationCommand(repoRoot, safe.command, before, DEFAULT_TIMEOUT_MS);
    reports.push(report);
    if (report.exitCode !== 0 || report.runner?.sourceMutationDetected) {
      break;
    }
  }
  return { reports, attempted, skipped };
}

export function autoVerifyDirtyHashFromParts(input: { headCommit: string | null; dirtyFiles: string[]; dirtyFileHashes: Record<string, string> }): string {
  return stableId(
    "autoverify-dirty-tree",
    input.headCommit ?? "null",
    JSON.stringify({
      dirtyFiles: [...input.dirtyFiles].sort(),
      dirtyFileHashes: Object.fromEntries(Object.entries(input.dirtyFileHashes).sort(([a], [b]) => a.localeCompare(b)))
    })
  );
}

export function sanitizeAutoVerifyText(value: string | undefined, repoRoot: string): string | undefined {
  const clean = redactSecretText(value)
    ?.replaceAll(path.resolve(repoRoot), "<repo>")
    .replace(/(^|[\s([,{])\/[^\s;|)\]'",]+/gu, "$1<abs-path>")
    .replace(/(^|[\s([,{])(?:\.\.?\/)[^\s;|)\]'",]+/gu, "$1<rel-path>")
    .replace(/\s+/gu, " ")
    .trim();
  if (!clean) {
    return undefined;
  }
  return clean.length > MAX_OUTPUT_SUMMARY ? `${clean.slice(0, MAX_OUTPUT_SUMMARY - 3)}...` : clean;
}

async function autoVerifyTrusted(repoRoot: string): Promise<{ enabled: true } | { enabled: false; reason: string }> {
  const autonomy = await effectiveAutonomyMode(repoRoot);
  if (autonomy.mode === "full-access") {
    return { enabled: true };
  }
  return { enabled: false, reason: `AutoVerify execution requires user full-access autonomy (current: ${autonomy.mode} via ${autonomy.source})` };
}

function autoVerifyCandidates(repoRoot: string, data: unknown): AutoVerifyCandidateInternal[] {
  if (!data || typeof data !== "object") {
    return [];
  }
  const record = data as Record<string, unknown>;
  const reviewPaths = pathsFromUnknown(record.reviewTargets);
  const structured = Array.isArray(record.autoVerifyCandidates)
    ? record.autoVerifyCandidates
        .map((item) => normalizeStructuredCandidate(repoRoot, item, reviewPaths))
        .filter((candidate): candidate is AutoVerifyCandidateInternal => Boolean(candidate))
    : [];
  if (structured.length > 0) {
    return uniqueCandidates(structured);
  }
  return uniqueCandidates(legacyAutoVerifyCandidates(repoRoot, record, reviewPaths));
}

function normalizeStructuredCandidate(repoRoot: string, item: unknown, reviewPaths: string[]): AutoVerifyCandidateInternal | undefined {
  if (!item || typeof item !== "object") {
    return undefined;
  }
  const entry = item as Partial<AutoVerifyCandidate>;
  if (
    entry.schemaVersion !== 1 ||
    typeof entry.taskId !== "string" ||
    typeof entry.snapshotDigest !== "string" ||
    typeof entry.commandId !== "string" ||
    typeof entry.command !== "string" ||
    typeof entry.commandExecutable !== "string" ||
    !Array.isArray(entry.commandArgs) ||
    !entry.commandArgs.every((arg) => typeof arg === "string") ||
    typeof entry.commandCwd !== "string"
  ) {
    return undefined;
  }
  const targetPaths = pathsFromUnknown(entry.targetPaths);
  return {
    schemaVersion: 1,
    taskId: entry.taskId,
    snapshotDigest: entry.snapshotDigest,
    commandId: entry.commandId,
    command: materializeDisplayCommand(repoRoot, entry.command),
    commandExecutable: entry.commandExecutable,
    commandArgs: entry.commandArgs.map((arg) => materializePathValue(repoRoot, arg)),
    commandCwd: materializePathValue(repoRoot, entry.commandCwd),
    targetPaths,
    source: entry.source ?? "legacy",
    rank: typeof entry.rank === "number" ? entry.rank : 0,
    protectedPaths: uniqueSorted([...reviewPaths, ...targetPaths])
  };
}

function legacyAutoVerifyCandidates(repoRoot: string, record: Record<string, unknown>, reviewPaths: string[]): AutoVerifyCandidateInternal[] {
  const taskId = snapshotTaskId(record) ?? "latest";
  const snapshotDigest = stableId("legacy-autoverify-snapshot", JSON.stringify(record.snapshot ?? record.snapshotLoad ?? {}));
  const seen = new Set<string>();
  const candidates: AutoVerifyCandidateInternal[] = [];
  const add = (items: unknown, baseRank: number) => {
    if (!Array.isArray(items)) {
      return;
    }
    items.forEach((item, index) => {
      if (!item || typeof item !== "object") {
        return;
      }
      const entry = item as { command?: unknown; commandCwd?: unknown; commandExecutable?: unknown; commandArgs?: unknown; path?: unknown; provenance?: unknown; rank?: unknown };
      const command = entry.command;
      if (typeof command !== "string" || !command.trim() || seen.has(command)) {
        return;
      }
      const commandExecutable = typeof entry.commandExecutable === "string" ? entry.commandExecutable : undefined;
      const commandArgs = Array.isArray(entry.commandArgs) && entry.commandArgs.every((arg) => typeof arg === "string") ? entry.commandArgs : undefined;
      const commandCwd = typeof entry.commandCwd === "string" ? entry.commandCwd : undefined;
      if (!commandExecutable || !commandArgs || !commandCwd) {
        return;
      }
      seen.add(command);
      const targetPaths = uniqueSorted([
        ...(typeof entry.path === "string" ? [entry.path] : []),
        ...provenanceTargetPaths(entry.provenance)
      ]);
      const rank = typeof entry.rank === "number" ? entry.rank : baseRank - index;
      const commandId = stableId("autoverify-command", taskId, command, commandCwd, JSON.stringify(commandArgs));
      candidates.push({
        schemaVersion: 1,
        taskId,
        snapshotDigest,
        commandId,
        command: materializeDisplayCommand(repoRoot, command),
        commandExecutable,
        commandArgs: commandArgs.map((arg) => materializePathValue(repoRoot, arg)),
        commandCwd: materializePathValue(repoRoot, commandCwd),
        targetPaths,
        source: provenanceSource(entry.provenance),
        rank,
        protectedPaths: uniqueSorted([...reviewPaths, ...targetPaths])
      });
    });
  };
  add(record.testsNotRun, 2000);
  add(record.missedLikelyTests, 1000);
  return candidates.sort((a, b) => b.rank - a.rank || a.command.localeCompare(b.command));
}

function uniqueCandidates(candidates: AutoVerifyCandidateInternal[]): AutoVerifyCandidateInternal[] {
  const byCommand = new Map<string, AutoVerifyCandidateInternal>();
  for (const candidate of candidates) {
    const key = `${candidate.commandCwd}\0${candidate.commandExecutable}\0${candidate.commandArgs.join("\0")}`;
    const existing = byCommand.get(key);
    if (!existing || candidate.rank > existing.rank) {
      byCommand.set(key, candidate);
    }
  }
  return [...byCommand.values()].sort((a, b) => b.rank - a.rank || a.command.localeCompare(b.command));
}

function snapshotTaskId(record: Record<string, unknown>): string | undefined {
  const snapshot = record.snapshot;
  if (snapshot && typeof snapshot === "object" && typeof (snapshot as { taskId?: unknown }).taskId === "string") {
    return (snapshot as { taskId: string }).taskId;
  }
  const snapshotLoad = record.snapshotLoad;
  if (snapshotLoad && typeof snapshotLoad === "object" && typeof (snapshotLoad as { taskId?: unknown }).taskId === "string") {
    return (snapshotLoad as { taskId: string }).taskId;
  }
  return undefined;
}

function pathsFromUnknown(value: unknown): string[] {
  return Array.isArray(value) ? uniqueSorted(value.filter((entry): entry is string => typeof entry === "string")) : [];
}

function provenanceTargetPaths(value: unknown): string[] {
  if (!value || typeof value !== "object") {
    return [];
  }
  return pathsFromUnknown((value as { targetPaths?: unknown }).targetPaths);
}

function provenanceSource(value: unknown): AutoVerifyCandidate["source"] {
  if (!value || typeof value !== "object" || !Array.isArray((value as { sources?: unknown }).sources)) {
    return "legacy";
  }
  const sources = (value as { sources: unknown[] }).sources;
  if (sources.includes("explicit_target")) return "explicit";
  if (sources.includes("authoritative_test_edge")) return "authoritative-test-edge";
  if (sources.includes("derived_import") || sources.includes("derived_impact_expansion") || sources.includes("package_import") || sources.includes("outcome_history")) return "derived-impact";
  return "heuristic";
}

function materializeDisplayCommand(repoRoot: string, command: string): string {
  return command.replace(/<repo>(\/[^\s&|;]*)?/gu, (_match, suffix: string | undefined) => path.join(repoRoot, suffix ?? ""));
}

function materializePathValue(repoRoot: string, value: string): string {
  return value.replace(/<repo>(\/[^\s]*)?/gu, (_match, suffix: string | undefined) => path.join(repoRoot, suffix ?? ""));
}

async function safeAutoVerifyCommand(repoRoot: string, candidate: AutoVerifyCandidateInternal): Promise<{ ok: true; command: SafeAutoVerifyCommand } | { ok: false; reason: string }> {
  if (candidate.command.length > 1000 || /[\0\r\n]/u.test(candidate.command)) {
    return { ok: false, reason: "unsupported command display" };
  }
  if (!safeExecutableName(candidate.commandExecutable) || candidate.commandArgs.some((arg) => /[\0\r\n]/u.test(arg))) {
    return { ok: false, reason: "unsupported command argv" };
  }
  const repoRealRoot = await realpathOrUndefined(repoRoot);
  if (!repoRealRoot) {
    return { ok: false, reason: "repo root is unavailable" };
  }
  const cwd = path.isAbsolute(candidate.commandCwd) ? path.resolve(candidate.commandCwd) : path.resolve(repoRoot, candidate.commandCwd);
  if (!isSubpath(cwd, repoRoot)) {
    return { ok: false, reason: "command cwd is outside repo" };
  }
  const cwdReal = await realpathOrUndefined(cwd);
  if (!cwdReal || !isSubpath(cwdReal, repoRealRoot)) {
    return { ok: false, reason: "command cwd is outside repo" };
  }
  const words = [candidate.commandExecutable, ...candidate.commandArgs];
  const safety = await safeRunnerInvocation(repoRoot, repoRealRoot, cwd, cwdReal, words);
  if (!safety.ok) {
    return safety;
  }
  const executable = safety.executable ?? candidate.commandExecutable;
  const args = safety.args ?? candidate.commandArgs;
  const resolvedExecutable = await resolveAllowlistedExecutable(executable, repoRealRoot, { packageBinRoot: safety.packageBinRoot, args });
  if (!resolvedExecutable) {
    return { ok: false, reason: "runner executable is unavailable or unsafe" };
  }
  const pathEnv = await safeRunnerPathEnv(repoRealRoot, cwdReal, resolvedExecutable.pathEnvExecutable);
  return {
    ok: true,
    command: {
      candidate,
      command: candidate.command,
      cwd,
      spawnCwd: cwdReal,
      executable,
      spawnExecutable: resolvedExecutable.spawnExecutable,
      spawnArgs: resolvedExecutable.spawnArgs,
      args,
      reportArgs: safety.reportArgs,
      packageManager: safety.packageManager,
      packageRoot: safety.packageRoot,
      scriptName: safety.scriptName,
      targetRealpaths: safety.targetRealpaths,
      allowedBy: safety.allowedBy,
      pathEnv
    }
  };
}

type SafeRunnerInvocationResult =
  | {
      ok: true;
      targetRealpaths: string[];
      allowedBy: string[];
      reportArgs?: string[];
      executable?: string;
      args?: string[];
      packageBinRoot?: string;
      packageManager?: string;
      packageRoot?: string;
      scriptName?: string;
    }
  | { ok: false; reason: string };

async function safeRunnerInvocation(repoRoot: string, repoRealRoot: string, cwd: string, cwdReal: string, words: string[]): Promise<SafeRunnerInvocationResult> {
  const first = words[0];
  if ((first === "npm" || first === "pnpm") && words[1] === "run" && words[2]) {
    return safePackageTestScript(repoRoot, repoRealRoot, cwd, cwdReal, first, words[2], words.slice(3));
  }
  if ((first === "npm" || first === "pnpm") && (words[1] === "test" || words[1] === "t")) {
    return safePackageTestScript(repoRoot, repoRealRoot, cwd, cwdReal, first, "test", words.slice(2));
  }
  if (first === "yarn" && words[1]) {
    const scriptName = words[1] === "run" ? words[2] : words[1];
    return scriptName ? safePackageTestScript(repoRoot, repoRealRoot, cwd, cwdReal, "yarn", scriptName, words.slice(words[1] === "run" ? 3 : 2)) : { ok: false, reason: "missing yarn script" };
  }
  if (first === "node" && words[1] === "--test") {
    const target = await safeTargetArgs(repoRoot, repoRealRoot, cwd, cwdReal, words.slice(2), { runner: "node" });
    return target.ok ? { ok: true, targetRealpaths: target.targetRealpaths, allowedBy: ["direct node --test target"], reportArgs: words.slice(1), packageManager: "node", scriptName: "node --test" } : target;
  }
  if (first === "vitest" || first === "jest") {
    const runnerArgs = first === "vitest" && words[1] === "run" ? words.slice(2) : words.slice(1);
    const target = await safeTargetArgs(repoRoot, repoRealRoot, cwd, cwdReal, runnerArgs, { runner: first });
    return target.ok ? { ok: true, targetRealpaths: target.targetRealpaths, allowedBy: [`direct ${first} target`], reportArgs: words.slice(1), packageManager: first, scriptName: first } : target;
  }
  if (first === "pytest") {
    const target = await safeTargetArgs(repoRoot, repoRealRoot, cwd, cwdReal, words.slice(1), { runner: "pytest" });
    return target.ok ? { ok: true, targetRealpaths: target.targetRealpaths, allowedBy: ["direct pytest target"], reportArgs: words.slice(1), packageManager: "pytest", scriptName: "pytest" } : target;
  }
  if (first === "uv" && words[1] === "run" && words[2] === "pytest") {
    const target = await safeTargetArgs(repoRoot, repoRealRoot, cwd, cwdReal, words.slice(3), { runner: "pytest" });
    return target.ok ? { ok: true, targetRealpaths: target.targetRealpaths, allowedBy: ["direct uv pytest target"], reportArgs: words.slice(1), packageManager: "pytest", scriptName: "pytest" } : target;
  }
  if ((first === "python" || first === "python3") && words[1] === "-m" && words[2] === "pytest") {
    const target = await safeTargetArgs(repoRoot, repoRealRoot, cwd, cwdReal, words.slice(3), { runner: "pytest" });
    return target.ok ? { ok: true, targetRealpaths: target.targetRealpaths, allowedBy: [`direct ${first} -m pytest target`], reportArgs: words.slice(1), packageManager: "pytest", scriptName: "pytest" } : target;
  }
  return { ok: false, reason: "runner is not allowlisted" };
}

async function safePackageTestScript(
  repoRoot: string,
  repoRealRoot: string,
  cwd: string,
  cwdReal: string,
  packageManager: "npm" | "pnpm" | "yarn",
  scriptName: string,
  args: string[]
): Promise<SafeRunnerInvocationResult> {
  if (!/^test(?::[\w:-]+)?$/u.test(scriptName)) {
    return { ok: false, reason: "package script is not a test script" };
  }
  const forwarded = args[0] === "--" ? args.slice(1) : args;
  const target = await safeTargetArgs(repoRoot, repoRealRoot, cwd, cwdReal, forwarded, { runner: "package" });
  if (!target.ok) {
    return target;
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
  const invocation = directPackageScriptInvocation(shellWords(script), forwarded);
  if (!invocation) {
    return { ok: false, reason: "package test script is not safe to auto-run" };
  }
  return {
    ok: true,
    targetRealpaths: target.targetRealpaths,
    allowedBy: [`${packageManager} ${scriptName} targeted test script via direct ${invocation.executable} runner`],
    reportArgs: args,
    executable: invocation.executable,
    args: invocation.args,
    packageBinRoot: cwdReal,
    packageManager,
    packageRoot: repoRelativeRealPath(repoRealRoot, cwdReal),
    scriptName
  };
}

function directPackageScriptInvocation(words: string[], forwarded: string[]): { executable: string; args: string[] } | undefined {
  const first = words[0];
  if (first === "node" && words[1] === "--test" && words.length === 2) {
    return { executable: "node", args: ["--test", ...forwarded] };
  }
  if (first === "vitest" && (words.length === 1 || (words.length === 2 && words[1] === "run"))) {
    return { executable: "vitest", args: ["run", ...forwarded] };
  }
  if ((first === "jest" || first === "pytest") && words.length === 1) {
    return { executable: first, args: forwarded };
  }
  if ((first === "python" || first === "python3") && words.length === 3 && words[1] === "-m" && words[2] === "pytest") {
    return { executable: first, args: ["-m", "pytest", ...forwarded] };
  }
  if (first === "uv" && words.length === 3 && words[1] === "run" && words[2] === "pytest") {
    return { executable: "uv", args: ["run", "pytest", ...forwarded] };
  }
  return undefined;
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
  const words = shellWords(script);
  if (words.some((word) => /^[A-Za-z_][A-Za-z0-9_]*=/u.test(word))) {
    return false;
  }
  const first = words[0];
  if (first === "vitest") {
    return words.length === 1 || (words.length === 2 && words[1] === "run");
  }
  if (first === "jest" || first === "pytest") {
    return words.length === 1;
  }
  if (first === "node") {
    return words.length === 2 && words[1] === "--test";
  }
  if (first === "python" || first === "python3") {
    return words.length === 3 && words[1] === "-m" && words[2] === "pytest";
  }
  if (first === "uv") {
    return words.length === 3 && words[1] === "run" && words[2] === "pytest";
  }
  return false;
}

async function safeTargetArgs(
  repoRoot: string,
  repoRealRoot: string,
  cwd: string,
  cwdReal: string,
  args: string[],
  options: { runner: string }
): Promise<{ ok: true; targetRealpaths: string[] } | { ok: false; reason: string }> {
  const targets: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") {
      continue;
    }
    if (arg.startsWith("-")) {
      return { ok: false, reason: `${options.runner} command uses unsupported flag ${arg}` };
    }
    targets.push(arg);
  }
  if (targets.length === 0) {
    return { ok: false, reason: `${options.runner} command is not targeted` };
  }
  const targetRealpaths: string[] = [];
  for (const target of targets) {
    const real = await repoTestTargetRealpath(repoRoot, repoRealRoot, cwd, cwdReal, target);
    if (!real) {
      return { ok: false, reason: `${options.runner} command is not targeted` };
    }
    targetRealpaths.push(real);
  }
  return { ok: true, targetRealpaths: uniqueSorted(targetRealpaths) };
}

async function repoTestTargetRealpath(repoRoot: string, repoRealRoot: string, cwd: string, cwdReal: string, value: string): Promise<string | undefined> {
  if (/[\0\r\n;&|`$<>:*?[\]{}]/u.test(value)) {
    return undefined;
  }
  const absolute = path.resolve(cwd, value);
  if (!isSubpath(absolute, repoRoot)) {
    return undefined;
  }
  const real = await realpathOrUndefined(path.resolve(cwdReal, path.relative(cwd, absolute)));
  if (!real || !isSubpath(real, repoRealRoot)) {
    return undefined;
  }
  const relative = path.relative(repoRoot, absolute).split(path.sep).join("/");
  const realRelative = path.relative(repoRealRoot, real).split(path.sep).join("/");
  return isTestPath(relative) || isTestPath(realRelative) ? real : undefined;
}

async function resolveAllowlistedExecutable(executable: string, repoRealRoot: string, options: { packageBinRoot?: string; args?: string[] } = {}): Promise<ResolvedExecutable | undefined> {
  const args = options.args ?? [];
  if (executable === "node") {
    const nodeReal = await realpathOrUndefined(process.execPath);
    return nodeReal && !isUnsafeExecutableRealpath(nodeReal, repoRealRoot) ? directExecutableResolution(nodeReal, args) : undefined;
  }
  if (options.packageBinRoot) {
    const localBin = await packageLocalBinExecutable(executable, options.packageBinRoot);
    if (localBin) {
      return await packageLocalBinResolution(localBin, args, repoRealRoot);
    }
  }
  const pathValue = process.env.PATH ?? "";
  for (const dir of pathValue.split(path.delimiter)) {
    if (!dir || !path.isAbsolute(dir)) {
      continue;
    }
    const absoluteDir = path.resolve(dir);
    if (isUnsafePathCandidate(absoluteDir, repoRealRoot)) {
      continue;
    }
    if (await isUnsafeSearchDir(absoluteDir, repoRealRoot)) {
      continue;
    }
    const candidate = path.join(absoluteDir, executable);
    if (isUnsafePathCandidate(candidate, repoRealRoot)) {
      continue;
    }
    const real = await executableRealpath(candidate);
    if (!real || isUnsafeExecutableRealpath(real, repoRealRoot) || (await isWorldWritableDir(path.dirname(real)))) {
      continue;
    }
    return directExecutableResolution(real, args);
  }
  return undefined;
}

function directExecutableResolution(executablePath: string, args: string[]): ResolvedExecutable {
  return {
    executablePath,
    spawnExecutable: executablePath,
    spawnArgs: args,
    pathEnvExecutable: executablePath
  };
}

async function packageLocalBinResolution(localBin: string, args: string[], repoRealRoot: string): Promise<ResolvedExecutable | undefined> {
  if (process.platform !== "win32" || path.extname(localBin).toLowerCase() !== ".cmd") {
    return directExecutableResolution(localBin, args);
  }
  if (![localBin, ...args].every(isSafeWindowsCmdArgument)) {
    return undefined;
  }
  const shell = await resolveWindowsCommandShell(repoRealRoot);
  if (!shell) {
    return undefined;
  }
  return {
    executablePath: localBin,
    spawnExecutable: shell,
    spawnArgs: ["/d", "/v:off", "/c", "call", localBin, ...args],
    pathEnvExecutable: shell
  };
}

async function resolveWindowsCommandShell(repoRealRoot: string): Promise<string | undefined> {
  const comspec = process.env.ComSpec;
  if (comspec && path.isAbsolute(comspec)) {
    const real = await executableRealpath(comspec);
    if (real && !isUnsafeExecutableRealpath(real, repoRealRoot) && !(await isWorldWritableDir(path.dirname(real)))) {
      return real;
    }
  }
  const pathValue = process.env.PATH ?? "";
  for (const dir of pathValue.split(path.delimiter)) {
    if (!dir || !path.isAbsolute(dir)) {
      continue;
    }
    const absoluteDir = path.resolve(dir);
    if (isUnsafePathCandidate(absoluteDir, repoRealRoot) || (await isUnsafeSearchDir(absoluteDir, repoRealRoot))) {
      continue;
    }
    const candidate = path.join(absoluteDir, "cmd.exe");
    const real = await executableRealpath(candidate);
    if (real && !isUnsafeExecutableRealpath(real, repoRealRoot) && !(await isWorldWritableDir(path.dirname(real)))) {
      return real;
    }
  }
  return undefined;
}

function isSafeWindowsCmdArgument(value: string): boolean {
  return value.length > 0 && !/[\0\r\n"%!^]/u.test(value);
}

async function packageLocalBinExecutable(executable: string, packageRoot: string): Promise<string | undefined> {
  const nodeModules = path.join(packageRoot, "node_modules");
  const nodeModulesReal = await realpathOrUndefined(nodeModules);
  if (!nodeModulesReal) {
    return undefined;
  }
  const binCandidates = process.platform === "win32"
    ? [path.join(nodeModules, ".bin", `${executable}.cmd`), path.join(nodeModules, ".bin", executable)]
    : [path.join(nodeModules, ".bin", executable)];
  for (const candidate of binCandidates) {
    const real = await executableRealpath(candidate);
    if (real && isSubpath(real, nodeModulesReal)) {
      return real;
    }
  }
  return undefined;
}

function isUnsafePathCandidate(candidate: string, repoRealRoot: string): boolean {
  const normalized = normalizePathLike(candidate);
  return isSubpath(candidate, repoRealRoot) || hasNodeModulesBinSegment(normalized);
}

function hasNodeModulesBinSegment(value: string): boolean {
  const segments = value.split("/");
  return segments.some((segment, index) => segment === "node_modules" && segments[index + 1] === ".bin");
}

async function isUnsafeSearchDir(dir: string, repoRealRoot: string): Promise<boolean> {
  const real = await realpathOrUndefined(dir);
  return !real || isUnsafePathCandidate(real, repoRealRoot) || (await isWorldWritableDir(real));
}

async function isWorldWritableDir(dir: string): Promise<boolean> {
  try {
    const stat = await fs.stat(dir);
    return stat.isDirectory() && (stat.mode & 0o002) !== 0;
  } catch {
    return true;
  }
}

async function executableRealpath(candidate: string): Promise<string | undefined> {
  try {
    await fs.access(candidate, fsConstants.X_OK);
    const stat = await fs.stat(candidate);
    if (!stat.isFile()) {
      return undefined;
    }
    return await fs.realpath(candidate);
  } catch {
    return undefined;
  }
}

function isUnsafeExecutableRealpath(realpathValue: string, repoRealRoot: string): boolean {
  return isUnsafePathCandidate(realpathValue, repoRealRoot);
}

async function safeRunnerPathEnv(repoRealRoot: string, cwdReal: string, executableRealpathValue: string): Promise<string> {
  const dirs = new Set<string>([path.dirname(process.execPath)]);
  const executableDir = path.dirname(executableRealpathValue);
  if (!isUnsafePathCandidate(executableDir, repoRealRoot) && !(await isUnsafeSearchDir(executableDir, repoRealRoot))) {
    dirs.add(executableDir);
  }
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir || !path.isAbsolute(dir)) {
      continue;
    }
    const absoluteDir = path.resolve(dir);
    if (isUnsafePathCandidate(absoluteDir, repoRealRoot) || isSubpath(absoluteDir, cwdReal) || (await isUnsafeSearchDir(absoluteDir, repoRealRoot))) {
      continue;
    }
    const real = await realpathOrUndefined(path.resolve(dir));
    if (!real || isUnsafePathCandidate(real, repoRealRoot) || isSubpath(real, cwdReal) || (await isWorldWritableDir(real))) {
      continue;
    }
    dirs.add(real);
  }
  return [...dirs].join(path.delimiter);
}

async function runVerificationCommand(repoRoot: string, command: SafeAutoVerifyCommand, before: RunnerDirtyState, timeoutMs: number): Promise<AutoVerifyCommandReport> {
  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();
  const tempHome = await createRunnerHome();
  let result: { exitCode: number; stdout: string; stderr: string; timedOut: boolean; signal?: string };
  try {
    result = await new Promise<{ exitCode: number; stdout: string; stderr: string; timedOut: boolean; signal?: string }>((resolve) => {
      const detached = process.platform !== "win32";
      const child = spawn(command.spawnExecutable, command.spawnArgs, {
        cwd: command.spawnCwd,
        env: minimalChildEnv(tempHome, command.pathEnv),
        detached,
        stdio: ["ignore", "pipe", "pipe"]
      });
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let closed = false;
      let killTimer: NodeJS.Timeout | undefined;
      let hardKillTimer: NodeJS.Timeout | undefined;
      const killChild = (signal: NodeJS.Signals) => {
        if (!child.pid || closed) {
          return;
        }
        try {
          process.kill(detached ? -child.pid : child.pid, signal);
        } catch {
          // The process may already have exited; the close handler will settle the report.
        }
      };
      killTimer = setTimeout(() => {
        timedOut = true;
        killChild("SIGTERM");
        hardKillTimer = setTimeout(() => killChild("SIGKILL"), 2_000);
        hardKillTimer.unref();
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
      child.on("close", (code, signal) => {
        closed = true;
        if (killTimer) clearTimeout(killTimer);
        if (hardKillTimer) clearTimeout(hardKillTimer);
        resolve({ exitCode: timedOut ? 124 : code ?? 1, stdout, stderr, timedOut, signal: signal ?? undefined });
      });
    });
  } finally {
    await fs.rm(tempHome, { recursive: true, force: true }).catch(() => undefined);
  }
  const after = await runnerDirtyState(repoRoot, command.candidate.protectedPaths);
  const sourceMutationDetected = sourceMutationBetween(before, after, command.candidate.protectedPaths);
  const finishedAt = new Date().toISOString();
  const runnerBase: Omit<AutoVerifyReportRunner, "canonicalDigest"> = {
    schemaVersion: 1,
    reportKind: "codexa-autoverify-report",
    runnerName: "codexa",
    runnerVersion: process.env.npm_package_version ?? "0.0.0",
    policyId: AUTO_VERIFY_POLICY_ID,
    policyDigest: AUTO_VERIFY_POLICY_DIGEST,
    taskId: command.candidate.taskId,
    snapshotDigest: command.candidate.snapshotDigest,
    commandId: command.candidate.commandId,
    candidateDigest: candidateDigest(command.candidate),
    headCommit: after.headCommit,
    dirtyHashBefore: dirtyStateHash(before),
    dirtyHashAfter: dirtyStateHash(after),
    cwdRealpath: command.spawnCwd,
    targetRealpaths: command.targetRealpaths,
    envMode: "minimal",
    allowedBy: command.allowedBy,
    sourceMutationDetected,
    timedOut: result.timedOut,
    startedAt,
    finishedAt,
    signal: result.signal,
    outputRedacted: true,
    skippedReason: before.degradedReason ?? after.degradedReason
  };
  const stdoutSummary = summarizeOutput(result.stdout, repoRoot);
  const stderrSummary = summarizeOutput(result.timedOut ? `${result.stderr}\nTimed out after ${timeoutMs}ms` : result.stderr, repoRoot);
  const report: AutoVerifyCommandReport = {
    command: command.command,
    cwd: command.cwd,
    packageManager: command.packageManager,
    packageRoot: command.packageRoot,
    scriptName: command.scriptName,
    args: command.reportArgs ?? command.args,
    exitCode: result.exitCode,
    durationMs: Date.now() - startedAtMs,
    stdoutSummary,
    stderrSummary,
    runner: {
      ...runnerBase,
      canonicalDigest: stableId(
        "codexa-autoverify-report",
        command.command,
        result.exitCode,
        runnerBase.policyId,
        runnerBase.policyDigest,
        runnerBase.taskId,
        runnerBase.snapshotDigest,
        runnerBase.commandId,
        runnerBase.candidateDigest,
        runnerBase.headCommit ?? "null",
        runnerBase.dirtyHashBefore,
        runnerBase.dirtyHashAfter,
        runnerBase.cwdRealpath,
        JSON.stringify(runnerBase.targetRealpaths),
        runnerBase.envMode,
        JSON.stringify(runnerBase.allowedBy),
        runnerBase.sourceMutationDetected ? "mutated" : "clean",
        runnerBase.timedOut ? "timed-out" : "not-timed-out",
        runnerBase.outputRedacted ? "redacted" : "not-redacted",
        runnerBase.signal ?? "",
        runnerBase.skippedReason ?? ""
      )
    }
  };
  markTrustedAutoVerifyReport(report);
  Object.freeze(report.runner.targetRealpaths);
  Object.freeze(report.runner.allowedBy);
  Object.freeze(report.runner);
  if (report.args) {
    Object.freeze(report.args);
  }
  Object.freeze(report);
  return report;
}

async function runnerDirtyState(repoRoot: string, protectedPaths: string[]): Promise<RunnerDirtyState> {
  const repo = path.resolve(repoRoot);
  const [git, status] = await Promise.all([
    getGitStateAsync(repo, { includeFiles: false, includeChurn: false }).catch((error: unknown) => ({ error })),
    gitText(repo, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], false)
  ]);
  if ("error" in git) {
    return {
      headCommit: null,
      dirtyFiles: [],
      dirtyFileHashes: {},
      allStatuses: new Map(),
      protectedHashes: new Map(),
      untrackedProtectedFiles: new Set(),
      worktreeRoot: repo,
      fullStatuses: new Map(),
      fullProtectedHashes: new Map(),
      fullUntrackedProtectedFiles: new Set(),
      degradedReason: git.error instanceof Error ? git.error.message : "git state unavailable"
    };
  }
  const relativePrefix = git.gitRoot ? normalizePathLike(path.relative(git.gitRoot, repo)) : "";
  const rawStatuses = parsePorcelainStatus(status ?? "");
  const statuses = normalizeStatusPaths(rawStatuses, git.gitRoot, relativePrefix);
  const fullStatuses = normalizeFullStatusPaths(rawStatuses);
  const worktreeRoot = git.gitRoot ? path.resolve(git.gitRoot) : repo;
  const visibleDirtyFiles = git.dirtyFiles.filter((file) => !isCodexaGenerated(file)).sort();
  const dirtyFileHashes = await hashFiles(repo, visibleDirtyFiles);
  const protectedSet = new Set<string>([
    ...protectedPaths.map(normalizePathLike),
    ...[...statuses.keys()].filter((file) => protectedMutationPath(file) && statuses.get(file) !== undefined)
  ]);
  const fullProtectedSet = new Set<string>([...fullStatuses.keys()].filter((file) => protectedMutationPath(file)));
  const protectedHashes = await hashProtectedFiles(repo, [...protectedSet]);
  const untrackedProtectedFiles = new Set([...statuses.entries()].filter(([file, statusValue]) => statusValue === "??" && protectedMutationPath(file)).map(([file]) => file));
  const fullProtectedHashes = await hashProtectedFiles(worktreeRoot, [...fullProtectedSet]);
  const fullUntrackedProtectedFiles = new Set([...fullStatuses.entries()].filter(([file, statusValue]) => statusValue === "??" && protectedMutationPath(file)).map(([file]) => file));
  return {
    headCommit: git.headCommit,
    dirtyFiles: visibleDirtyFiles,
    dirtyFileHashes,
    allStatuses: statuses,
    protectedHashes,
    untrackedProtectedFiles,
    worktreeRoot,
    fullStatuses,
    fullProtectedHashes,
    fullUntrackedProtectedFiles,
    degradedReason: status === null ? "git status unavailable" : undefined
  };
}

function sourceMutationBetween(before: RunnerDirtyState, after: RunnerDirtyState, protectedPaths: string[]): boolean {
  if (before.degradedReason || after.degradedReason) {
    return true;
  }
  const protectedSet = new Set(protectedPaths.map(normalizePathLike));
  for (const [file, beforeStatus] of before.allStatuses) {
    const afterStatus = after.allStatuses.get(file);
    if (afterStatus !== beforeStatus && protectedMutationPath(file)) {
      return true;
    }
  }
  for (const [file, afterStatus] of after.allStatuses) {
    const beforeStatus = before.allStatuses.get(file);
    if (beforeStatus !== afterStatus && protectedMutationPath(file)) {
      return true;
    }
  }
  for (const [file, beforeHash] of before.protectedHashes) {
    const afterHash = after.protectedHashes.get(file);
    if (afterHash !== beforeHash && (protectedSet.has(file) || protectedMutationPath(file))) {
      return true;
    }
  }
  for (const file of after.untrackedProtectedFiles) {
    if (!before.untrackedProtectedFiles.has(file)) {
      return true;
    }
  }
  for (const [file, beforeStatus] of before.fullStatuses) {
    const afterStatus = after.fullStatuses.get(file);
    if (afterStatus !== beforeStatus && protectedMutationPath(file)) {
      return true;
    }
  }
  for (const [file, afterStatus] of after.fullStatuses) {
    const beforeStatus = before.fullStatuses.get(file);
    if (beforeStatus !== afterStatus && protectedMutationPath(file)) {
      return true;
    }
  }
  for (const [file, beforeHash] of before.fullProtectedHashes) {
    const afterHash = after.fullProtectedHashes.get(file);
    if (afterHash !== beforeHash && protectedMutationPath(file)) {
      return true;
    }
  }
  for (const file of after.fullUntrackedProtectedFiles) {
    if (!before.fullUntrackedProtectedFiles.has(file)) {
      return true;
    }
  }
  return false;
}

function dirtyStateHash(state: RunnerDirtyState): string {
  return autoVerifyDirtyHashFromParts({
    headCommit: state.headCommit,
    dirtyFiles: state.dirtyFiles,
    dirtyFileHashes: state.dirtyFileHashes
  });
}

function candidateDigest(candidate: AutoVerifyCandidate): string {
  return stableId(
    "autoverify-candidate",
    candidate.taskId,
    candidate.snapshotDigest,
    candidate.commandId,
    candidate.command,
    candidate.commandCwd,
    candidate.commandExecutable,
    JSON.stringify(candidate.commandArgs),
    JSON.stringify(candidate.targetPaths)
  );
}

async function createRunnerHome(): Promise<string> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "codexa-autoverify-home-"));
  await fs.mkdir(path.join(home, ".config"), { recursive: true });
  await fs.writeFile(path.join(home, ".npmrc"), "", "utf8");
  return home;
}

function minimalChildEnv(home: string, pathEnv: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["TMPDIR", "TEMP", "TMP", "SystemRoot", "WINDIR"]) {
    if (process.env[key]) {
      env[key] = process.env[key];
    }
  }
  env.PATH = pathEnv;
  env.HOME = home;
  env.USERPROFILE = home;
  env.XDG_CONFIG_HOME = path.join(home, ".config");
  env.NPM_CONFIG_USERCONFIG = path.join(home, ".npmrc");
  env.NPM_CONFIG_CACHE = path.join(home, ".npm-cache");
  env.YARN_CACHE_FOLDER = path.join(home, ".yarn-cache");
  env.PIP_CONFIG_FILE = os.devNull;
  env.PYTHONNOUSERSITE = "1";
  env.CI = "1";
  env.NO_COLOR = "1";
  env.CODEXA_VERIFY = "1";
  return env;
}

async function gitText(repoRoot: string, args: string[], trim = true): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", repoRoot, ...args], {
      encoding: "utf8",
      maxBuffer: 2 * 1024 * 1024,
      timeout: 5_000,
      env: minimalGitEnv()
    });
    return trim ? stdout.trim() : stdout;
  } catch {
    return null;
  }
}

function minimalGitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "HOME", "TMPDIR", "TEMP", "TMP", "SystemRoot", "WINDIR"]) {
    if (process.env[key]) {
      env[key] = process.env[key];
    }
  }
  env.NO_COLOR = "1";
  return env;
}

function parsePorcelainStatus(value: string): Map<string, string> {
  const entries = value.split("\0").filter(Boolean);
  const statuses = new Map<string, string>();
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (!entry || entry.length < 4) {
      continue;
    }
    const status = entry.slice(0, 2);
    const file = normalizePathLike(entry.slice(3));
    if (status.includes("R") || status.includes("C")) {
      const oldPath = normalizePathLike(entries[index + 1] ?? "");
      statuses.set(file, status);
      if (oldPath) {
        statuses.set(oldPath, status);
      }
      index += 1;
      continue;
    }
    statuses.set(file, status);
  }
  return statuses;
}

function normalizeStatusPaths(statuses: Map<string, string>, gitRoot: string | null, relativePrefix: string): Map<string, string> {
  const normalized = new Map<string, string>();
  for (const [file, status] of statuses) {
    const relative = gitRepoRelativePath(file, gitRoot, relativePrefix);
    if (relative) {
      normalized.set(relative, status);
    }
  }
  return normalized;
}

function normalizeFullStatusPaths(statuses: Map<string, string>): Map<string, string> {
  const normalized = new Map<string, string>();
  for (const [file, status] of statuses) {
    normalized.set(normalizePathLike(file), status);
  }
  return normalized;
}

async function hashFiles(repoRoot: string, files: string[]): Promise<Record<string, string>> {
  const entries = await Promise.all(files.map(async (file) => [file, await hashFile(repoRoot, file, { metadataForNonSource: true })] as const));
  return Object.fromEntries(entries.sort(([a], [b]) => a.localeCompare(b)));
}

async function hashProtectedFiles(repoRoot: string, files: string[]): Promise<Map<string, string>> {
  const entries = await Promise.all(files.map(async (file) => [file, await hashFile(repoRoot, file, { metadataForNonSource: false })] as const));
  return new Map(entries);
}

async function hashFile(repoRoot: string, file: string, options: { metadataForNonSource: boolean }): Promise<string> {
  const absolute = path.join(repoRoot, file);
  try {
    const stat = await fs.lstat(absolute);
    if (!stat.isFile()) {
      return "non-file";
    }
    if (options.metadataForNonSource && (!isSourcePath(file) || stat.size > 2 * 1024 * 1024)) {
      return `metadata:${stat.size}:${Math.trunc(stat.mtimeMs)}`;
    }
    if (stat.size > 2 * 1024 * 1024) {
      return `metadata:${stat.size}:${Math.trunc(stat.mtimeMs)}`;
    }
    const content = await fs.readFile(absolute);
    return createHash("sha1").update(content).digest("hex");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    return code === "ENOENT" ? "missing" : `unreadable:${typeof code === "string" ? code : "unknown"}`;
  }
}

function isCodexaGenerated(file: string): boolean {
  const normalized = normalizePathLike(file);
  if (normalized === ".codex/static-analysis" || normalized.startsWith(".codex/static-analysis/")) {
    return false;
  }
  return normalized === ".codex" || normalized === ".codex/" || normalized.startsWith(".codex/");
}

function protectedMutationPath(file: string): boolean {
  const normalized = normalizePathLike(file);
  if (codexaProvenancePath(normalized)) {
    return true;
  }
  if (ignoredTestOutputPath(normalized)) {
    return false;
  }
  return isSourcePath(normalized) || isTestPath(normalized) || codexaProvenancePath(normalized);
}

function ignoredTestOutputPath(file: string): boolean {
  return shouldSkipPath(file) || file === "coverage" || file.startsWith("coverage/") || file === ".coverage" || file.startsWith(".pytest_cache/") || file.startsWith(".nyc_output/");
}

function codexaProvenancePath(file: string): boolean {
  const normalized = normalizePathLike(file);
  const codexPath = normalized.startsWith(".codex/")
    ? normalized
    : normalized.includes("/.codex/")
      ? normalized.slice(normalized.indexOf("/.codex/") + 1)
      : normalized;
  return (
    codexPath === ".codex/config.toml" ||
    codexPath.startsWith(".codex/cache/codexa-tasks/") ||
    codexPath.startsWith(".codex/cache/codexa-task-snapshots/") ||
    codexPath.startsWith(".codex/cache/codexa-outcomes/") ||
    codexPath.startsWith(".codex/cache/codexa-hooks/") ||
    codexPath.startsWith(".codex/codebase/")
  );
}

async function realpathOrUndefined(value: string): Promise<string | undefined> {
  try {
    return await fs.realpath(value);
  } catch {
    return undefined;
  }
}

function summarizeOutput(value: string, repoRoot: string): string | undefined {
  const clean = sanitizeAutoVerifyText(
    value
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(-8)
      .join(" "),
    repoRoot
  );
  return clean;
}

function boundedAppend(current: string, chunk: string): string {
  const next = current + chunk;
  return next.length > MAX_OUTPUT_CAPTURE ? next.slice(next.length - MAX_OUTPUT_CAPTURE) : next;
}

function safeExecutableName(value: string): boolean {
  return /^(npm|pnpm|yarn|node|vitest|jest|pytest|uv|python|python3)$/u.test(value);
}

function normalizePathLike(value: string): string {
  return value.split(path.sep).join("/").replace(/^\.\//u, "").replace(/\/+/gu, "/");
}

function repoRelativeRealPath(repoRealRoot: string, fileRealpath: string): string {
  const relative = path.relative(repoRealRoot, fileRealpath).split(path.sep).join("/");
  return relative || ".";
}

function redactSecretText(value: string | undefined): string | undefined {
  return value
    ?.replace(/(^|[\s([,{])((?:--?[a-z0-9-]*(?:token|secret|password|passwd|pwd|api[-_]?key|access[-_]?key|auth|credential|cookie)[a-z0-9-]*)(?:=|\s+))([^\s;|)\]'",]+)/giu, "$1$2<redacted>")
    .replace(/(\b[A-Z_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|PWD|API_?KEY|ACCESS_?KEY|AUTH|CREDENTIAL|COOKIE)[A-Z0-9_]*=)([^\s;|)\]'",]+)/gu, "$1<redacted>")
    .replace(/\b(Bearer)\s+[A-Za-z0-9._~+/-]+=*/giu, "$1 <redacted>");
}
