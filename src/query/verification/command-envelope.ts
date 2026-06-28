import { CURRENT_VERIFICATION_PROVENANCE } from "../../types.js";
import type { VerificationCommandEnvelope, VerificationCommandReport } from "../../types.js";
import { commandNeedsFullMaskingAnalysis } from "./masking.js";
import { isNonRunningCommand, shellWords, shellWrappedCommand, stripLeadingEnvironment, stripPackageManagerFlags, stripShellControlWords } from "./shell.js";
import {
  normalizeCwd,
  packageNameForRoot,
  packageRootForCwd,
  readFlagArgument,
  scopedPackageCommand,
  splitSimpleCommand,
  type CommandEnvelopeContext
} from "./command-scope.js";

export interface NormalizedCommandReport extends VerificationCommandReport {
  fromReport: boolean;
  missingExitCode?: boolean;
  missingCwd?: boolean;
}

export function structuredRawSuppressionKey(
  report: NormalizedCommandReport,
  envelope: VerificationCommandEnvelope,
  ctx: CommandEnvelopeContext
): string | undefined {
  if (!report.fromReport) {
    return undefined;
  }
  if (envelope.source === "reported" && !reportedEnvelopeMatchesCommand(envelope, report.command, ctx)) {
    return undefined;
  }
  return commandEnvelopeSemanticKey(envelope, { requireRepoScope: false });
}

export function commandEnvelopeSemanticKey(envelope: VerificationCommandEnvelope, options: { requireRepoScope?: boolean } = { requireRepoScope: true }): string | undefined {
  if (!envelope.packageManager || !envelope.scriptName) {
    return undefined;
  }
  if (options.requireRepoScope !== false && envelope.scopeStatus !== "repo") {
    return undefined;
  }
  return [envelope.packageManager, envelope.packageRoot ?? "", envelope.workspace ?? "", envelope.scriptName, envelope.args.join("\u0001")].join("\0");
}

export function redactSecretDetails(details: string[]): string[] {
  let redactNext = false;
  return details.map((detail) => {
    if (redactNext) {
      redactNext = false;
      return "<redacted>";
    }
    if (isSecretFlag(detail) && !detail.includes("=")) {
      redactNext = true;
      return detail;
    }
    return redactSecretArg(detail);
  });
}

function redactSecretArg(value: string): string {
  if (/^Bearer\s+/iu.test(value)) {
    return "Bearer <redacted>";
  }
  if (isSecretFlag(value) && value.includes("=")) {
    return value.replace(/=.*/u, "=<redacted>");
  }
  if (/^(?:[A-Z_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|PWD|API_?KEY|ACCESS_?KEY|AUTH|CREDENTIAL|COOKIE)[A-Z0-9_]*)=/iu.test(value)) {
    return value.replace(/=.*/u, "=<redacted>");
  }
  return value;
}

function isSecretFlag(value: string): boolean {
  return /^--?[a-z0-9-]*(?:token|secret|password|passwd|pwd|api-?key|access-?key|auth|credential|cookie)[a-z0-9-]*(?:=.*)?$/iu.test(value);
}

export function normalizeCommandReports(ranCommands: string[], ranCommandReports: VerificationCommandReport[], repoRoot: string): NormalizedCommandReport[] {
  const rawReports: NormalizedCommandReport[] = [];
  const structuredReports: NormalizedCommandReport[] = [];
  const structuredCommandScopes = new Set<string>();
  const structuredCommands = new Set<string>();
  for (const command of ranCommands) {
    const cleanCommand = command.trim();
    if (!cleanCommand) {
      continue;
    }
    rawReports.push({ command: cleanCommand, fromReport: false });
  }
  for (const report of ranCommandReports) {
    const cleanCommand = report.command.trim();
    if (!cleanCommand) {
      continue;
    }
    structuredCommands.add(cleanCommand);
    const cleanCwd = typeof report.cwd === "string" && report.cwd.trim().length > 0 ? report.cwd.trim() : undefined;
    const compacted = compactCommandReport({ ...report, command: cleanCommand, cwd: cleanCwd });
    const missingCwd = cleanCwd === undefined;
    structuredReports.push({ ...compacted, fromReport: true, missingExitCode: compacted.exitCode === undefined, missingCwd });
    if (!missingCwd) {
      structuredCommandScopes.add(commandScopeKey(cleanCommand, compacted.cwd, repoRoot));
    }
  }
  return [...structuredReports, ...rawReports.filter((report) => !structuredCommands.has(report.command) && !structuredCommandScopes.has(commandScopeKey(report.command, report.cwd, repoRoot)))];
}

function commandScopeKey(command: string, cwd: string | undefined, repoRoot: string): string {
  return `${cwd ? normalizeCwd(cwd, repoRoot) : "."}\0${command}`;
}

function compactCommandReport(report: VerificationCommandReport): VerificationCommandReport {
  return {
    command: report.command,
    cwd: report.cwd,
    packageManager: clampToken(report.packageManager),
    workspace: clampToken(report.workspace),
    packageRoot: clampToken(report.packageRoot),
    packageName: clampToken(report.packageName),
    scriptName: clampToken(report.scriptName),
    args: report.args !== undefined ? compactArgs(report.args) ?? [] : undefined,
    exitCode: report.exitCode,
    durationMs: report.durationMs,
    stdoutSummary: clampSummary(report.stdoutSummary),
    stderrSummary: clampSummary(report.stderrSummary),
    outputSummary: clampSummary(report.outputSummary)
  };
}

function compactArgs(args: string[] | undefined): string[] | undefined {
  const clean = args?.map((arg) => clampToken(arg)).filter((arg): arg is string => Boolean(arg));
  return clean && clean.length > 0 ? clean.slice(0, 40) : undefined;
}

function clampToken(value: string | undefined): string | undefined {
  const clean = value?.replace(/\s+/gu, " ").trim();
  if (!clean) {
    return undefined;
  }
  return clean.length > 160 ? clean.slice(0, 160) : clean;
}

export function commandOutputSummary(report: VerificationCommandReport): string | undefined {
  const parts = [
    report.outputSummary ? `output: ${report.outputSummary}` : undefined,
    report.stdoutSummary ? `stdout: ${report.stdoutSummary}` : undefined,
    report.stderrSummary ? `stderr: ${report.stderrSummary}` : undefined
  ].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? clampSummary(parts.join(" | ")) : undefined;
}

export function commandEnvelopeForReport(report: NormalizedCommandReport, initialCwd: string, ctx: CommandEnvelopeContext): VerificationCommandEnvelope {
  const derived = deriveCommandEnvelope(report.command, initialCwd, ctx);
  const hasReportedEnvelope =
    report.packageManager !== undefined ||
    report.workspace !== undefined ||
    report.packageRoot !== undefined ||
    report.packageName !== undefined ||
    report.scriptName !== undefined ||
    report.args !== undefined;
  const packageRoot = normalizeEnvelopePackageRoot(report.packageRoot, ctx.repoRoot) ?? derived.packageRoot ?? packageRootForCwd(initialCwd, ctx.scripts, ctx.packageRoots);
  const normalizedCwd = report.cwd ? normalizeCwd(report.cwd, ctx.repoRoot) : undefined;
  const packageName = clampToken(report.packageName) ?? (isRepoPackageRoot(packageRoot) ? packageNameForRoot(packageRoot, ctx.repoRoot, ctx.packageNamesByRoot) : undefined);
  return compactCommandEnvelope({
    command: report.command,
    cwd: report.cwd ?? (report.fromReport ? undefined : ctx.repoRoot),
    packageManager: clampToken(report.packageManager) ?? derived.packageManager,
    workspace: clampToken(report.workspace) ?? derived.workspace,
    packageRoot,
    packageName,
    scriptName: clampToken(report.scriptName) ?? derived.scriptName,
    args: report.args !== undefined ? compactArgs(report.args) ?? [] : derived.args ?? [],
    exitCode: report.exitCode,
    durationMs: report.durationMs,
    stdoutSummary: report.stdoutSummary,
    stderrSummary: report.stderrSummary,
    outputSummary: commandOutputSummary(report),
    source: hasReportedEnvelope ? "reported" : report.fromReport ? "derived-from-report" : "derived-from-raw-command",
    scopeStatus: commandScopeStatus(report, normalizedCwd, packageRoot),
    classifierVersion: CURRENT_VERIFICATION_PROVENANCE.commandCoverageClassifierVersion
  });
}

function compactCommandEnvelope(envelope: VerificationCommandEnvelope): VerificationCommandEnvelope {
  return {
    command: envelope.command,
    cwd: envelope.cwd,
    packageManager: clampToken(envelope.packageManager),
    workspace: clampToken(envelope.workspace),
    packageRoot: clampToken(envelope.packageRoot),
    packageName: clampToken(envelope.packageName),
    scriptName: clampToken(envelope.scriptName),
    args: envelope.args.map((arg) => clampToken(arg)).filter((arg): arg is string => Boolean(arg)).slice(0, 40),
    exitCode: envelope.exitCode,
    durationMs: envelope.durationMs,
    stdoutSummary: clampSummary(envelope.stdoutSummary),
    stderrSummary: clampSummary(envelope.stderrSummary),
    outputSummary: clampSummary(envelope.outputSummary),
    source: envelope.source,
    scopeStatus: envelope.scopeStatus,
    classifierVersion: clampToken(envelope.classifierVersion) ?? CURRENT_VERIFICATION_PROVENANCE.commandCoverageClassifierVersion
  };
}

function commandScopeStatus(
  report: NormalizedCommandReport,
  normalizedCwd: string | undefined,
  packageRoot: string | undefined
): VerificationCommandEnvelope["scopeStatus"] {
  if (report.missingCwd) {
    return "missing-cwd";
  }
  if (packageRoot?.startsWith("__outside_repo__:unresolved-package:")) {
    return "unresolved-package";
  }
  if (normalizedCwd?.startsWith("__outside_repo__:") || packageRoot?.startsWith("__outside_repo__:")) {
    return "outside-repo";
  }
  return packageRoot ? "repo" : "unknown";
}

function normalizeEnvelopePackageRoot(value: string | undefined, repoRoot: string): string | undefined {
  if (!value) {
    return undefined;
  }
  return normalizeCwd(value, repoRoot);
}

function isRepoPackageRoot(value: string | undefined): value is string {
  return Boolean(value && !value.startsWith("__outside_repo__:"));
}

function deriveCommandEnvelope(command: string, initialCwd: string, ctx: CommandEnvelopeContext): Partial<VerificationCommandEnvelope> {
  for (const segment of splitSimpleCommand(command, initialCwd, ctx.repoRoot)) {
    if (segment.cd) {
      continue;
    }
    const derived = deriveSegmentEnvelope(segment.text, segment.cwd, ctx);
    if (derived.packageManager || derived.scriptName || (derived.args?.length ?? 0) > 0 || derived.workspace) {
      return derived;
    }
  }
  const packageRoot = packageRootForCwd(initialCwd, ctx.scripts, ctx.packageRoots);
  return {
    packageRoot,
    packageName: isRepoPackageRoot(packageRoot) ? packageNameForRoot(packageRoot, ctx.repoRoot, ctx.packageNamesByRoot) : undefined,
    args: []
  };
}

function deriveSegmentEnvelope(segment: string, cwd: string, ctx: CommandEnvelopeContext): Partial<VerificationCommandEnvelope> {
  const words = stripShellControlWords(stripLeadingEnvironment(shellWords(segment)));
  if (words.length === 0 || isNonRunningCommand(words)) {
    return { args: [] };
  }
  const shellWrapped = shellWrappedCommand(words);
  if (shellWrapped) {
    return deriveCommandEnvelope(shellWrapped, cwd, ctx);
  }
  const workspace = workspaceSpecifierFromWords(words);
  const scoped = scopedPackageCommand(words, ctx.repoRoot, ctx.packageRoots, ctx.packageNamesByRoot) ?? scopedPackageCommand(stripPackageManagerFlags(words), ctx.repoRoot, ctx.packageRoots, ctx.packageNamesByRoot);
  if (scoped) {
    const derived = deriveSegmentEnvelope(scoped.words.join(" "), scoped.cwd, ctx);
    return { ...derived, workspace: derived.workspace ?? workspace };
  }
  const effectiveWords = stripPackageManagerFlags(words);
  const first = effectiveWords[0];
  const packageRoot = packageRootForCwd(cwd, ctx.scripts, ctx.packageRoots);
  const packageName = isRepoPackageRoot(packageRoot) ? packageNameForRoot(packageRoot, ctx.repoRoot, ctx.packageNamesByRoot) : undefined;
  const base = { packageRoot, packageName, workspace, args: [] };
  if ((first === "npm" || first === "pnpm") && effectiveWords[1] === "run" && effectiveWords[2]) {
    return { ...base, packageManager: first, scriptName: effectiveWords[2], args: effectiveWords.slice(3) };
  }
  if ((first === "npm" || first === "pnpm") && (effectiveWords[1] === "test" || effectiveWords[1] === "t")) {
    return { ...base, packageManager: first, scriptName: "test", args: effectiveWords.slice(2) };
  }
  if (first === "yarn" && effectiveWords[1]) {
    return { ...base, packageManager: "yarn", scriptName: effectiveWords[1] === "run" ? effectiveWords[2] : effectiveWords[1], args: effectiveWords.slice(effectiveWords[1] === "run" ? 3 : 2) };
  }
  if (first === "vitest" || first === "jest") {
    return { ...base, packageManager: first, scriptName: first, args: effectiveWords.slice(1) };
  }
  if (first === "npx" && (effectiveWords[1] === "vitest" || effectiveWords[1] === "jest" || effectiveWords[1] === "tsc")) {
    return { ...base, packageManager: effectiveWords[1], scriptName: effectiveWords[1], args: effectiveWords.slice(2) };
  }
  if (first === "pytest") {
    return { ...base, packageManager: "pytest", scriptName: "pytest", args: effectiveWords.slice(1) };
  }
  if ((first === "python" || first === "python3") && effectiveWords[1] === "-m" && effectiveWords[2] === "pytest") {
    return { ...base, packageManager: first, scriptName: "pytest", args: effectiveWords.slice(3) };
  }
  if (first === "tsc") {
    return { ...base, packageManager: "tsc", scriptName: "tsc", args: effectiveWords.slice(1) };
  }
  if (first === "npm" && effectiveWords[1] === "audit") {
    return { ...base, packageManager: "npm", scriptName: "audit", args: effectiveWords.slice(2) };
  }
  return { ...base, packageManager: first, args: effectiveWords.slice(1) };
}

function workspaceSpecifierFromWords(words: string[]): string | undefined {
  const first = words[0];
  const npmWorkspace = first === "npm" ? readFlagArgument(words, 1, ["-w", "--workspace"]) : undefined;
  if (npmWorkspace) {
    return npmWorkspace.value;
  }
  const pnpmFilter = first === "pnpm" ? readFlagArgument(words, 1, ["--filter", "-F"]) : undefined;
  if (pnpmFilter) {
    return pnpmFilter.value;
  }
  if (first === "yarn" && words[1] === "workspace" && words[2]) {
    return words[2];
  }
  return undefined;
}


export function reportedEnvelopeMatchesCommand(envelope: VerificationCommandEnvelope, commandText: string, ctx: CommandEnvelopeContext): boolean {
  const initialCwd = envelope.cwd ? normalizeCwd(envelope.cwd, ctx.repoRoot) : envelope.packageRoot ?? ".";
  const derived = deriveCommandEnvelope(commandText, initialCwd, ctx);
  if (envelope.packageManager && derived.packageManager !== envelope.packageManager) {
    return false;
  }
  if (envelope.scriptName && derived.scriptName !== envelope.scriptName) {
    return false;
  }
  if (envelope.packageRoot && derived.packageRoot !== envelope.packageRoot) {
    return false;
  }
  if (envelope.workspace && derived.workspace !== envelope.workspace) {
    return false;
  }
  if (!arrayEquals(envelope.args, derived.args ?? [])) {
    return false;
  }
  return true;
}

function arrayEquals(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function clampSummary(value: string | undefined): string | undefined {
  const clean = value?.replace(/\s+/gu, " ").trim();
  if (!clean) {
    return undefined;
  }
  return clean.length > 500 ? `${clean.slice(0, 497)}...` : clean;
}
