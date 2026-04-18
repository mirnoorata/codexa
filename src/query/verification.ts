import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { CURRENT_VERIFICATION_PROVENANCE } from "../types.js";
import type {
  CodexaIndex,
  Confidence,
  TestRecommendation,
  VerificationCoverage,
  VerificationCoverageKind,
  VerificationCommandEnvelope,
  VerificationCommandReport,
  VerificationCommandPlanEntry,
  VerificationLedgerEntry,
  VerificationLedgerStatus,
  VerificationWaiver
} from "../types.js";
import { uniqueSorted } from "../util.js";
import { wasTestRun } from "./tests.js";

interface PackageScript {
  packageRoot: string;
  scriptName: string;
  command: string;
  source: string;
}

interface ParsedSegment {
  cwd: string;
  text: string;
  operator: ShellControlOperator;
}

type ShellControlOperator = "start" | "&&" | "||" | "|" | ";";
type ShellTruthiness = "true" | "false" | "unknown";

interface CoverageAddInput {
  kind: VerificationCoverageKind;
  command: string;
  source: string;
  confidence?: Confidence;
  scope?: string;
  targetPath?: string;
  details?: string[];
  exitCode?: number;
  durationMs?: number;
  outputSummary?: string;
}

interface NormalizedCommandReport extends VerificationCommandReport {
  fromReport: boolean;
  missingExitCode?: boolean;
  missingCwd?: boolean;
}

interface VerificationEvidenceResult {
  coverage: VerificationCoverage[];
  commandEnvelopes: VerificationCommandEnvelope[];
}

interface PreparedCommandReport {
  report: NormalizedCommandReport;
  initialCwd: string;
  outputSummary: string | undefined;
  commandEnvelope: VerificationCommandEnvelope;
}

interface CommandEnvelopeContext {
  repoRoot: string;
  scripts: Map<string, PackageScript>;
  packageRoots: string[];
  packageNamesByRoot: Map<string, string | undefined>;
}

export function verificationCoverageForCommands(index: CodexaIndex, ranCommands: string[], repoRoot = index.snapshot.repoRoot): VerificationCoverage[] {
  return verificationCoverageForCommandReports(index, ranCommands, [], repoRoot);
}

export function verificationCoverageForCommandReports(
  index: CodexaIndex,
  ranCommands: string[],
  ranCommandReports: VerificationCommandReport[] = [],
  repoRoot = index.snapshot.repoRoot
): VerificationCoverage[] {
  return verificationEvidenceForCommandReports(index, ranCommands, ranCommandReports, repoRoot).coverage;
}

export function verificationEvidenceForCommandReports(
  index: CodexaIndex,
  ranCommands: string[],
  ranCommandReports: VerificationCommandReport[] = [],
  repoRoot = index.snapshot.repoRoot
): VerificationEvidenceResult {
  const scripts = packageScriptsFromIndex(index);
  const packageRoots = packageRootsFromIndex(index);
  const packageNamesByRoot = new Map<string, string | undefined>();
  const envelopeContext = { repoRoot, scripts, packageRoots, packageNamesByRoot };
  const coverage: VerificationCoverage[] = [];
  const commandEnvelopes: VerificationCommandEnvelope[] = [];
  const preparedReports = normalizeCommandReports(ranCommands, ranCommandReports, repoRoot).map((report) => {
    const initialCwd = report.cwd ? normalizeCwd(report.cwd, repoRoot) : ".";
    const outputSummary = commandOutputSummary(report);
    const commandEnvelope = commandEnvelopeForReport(report, initialCwd, envelopeContext);
    return { report, initialCwd, outputSummary, commandEnvelope } satisfies PreparedCommandReport;
  });
  const structuredSemanticKeys = new Set(
    preparedReports
      .filter(({ report, commandEnvelope }) => report.fromReport && structuredEnvelopeSuppressesRaw(report, commandEnvelope, envelopeContext))
      .map(({ commandEnvelope }) => commandEnvelopeSemanticKey(commandEnvelope))
      .filter((key): key is string => Boolean(key))
  );
  for (const { report, initialCwd, outputSummary, commandEnvelope } of preparedReports) {
    const rawSemanticKey = report.fromReport ? undefined : commandEnvelopeSemanticKey(commandEnvelope);
    if (rawSemanticKey && structuredSemanticKeys.has(rawSemanticKey)) {
      continue;
    }
    commandEnvelopes.push(commandEnvelope);
    const reportDetails = uniqueSorted([
      ...(report.durationMs !== undefined ? [`duration ${report.durationMs}ms`] : []),
      ...(outputSummary ? [outputSummary] : [])
    ]);
    const addCoverage = (input: CoverageAddInput) => {
      coverage.push({
        kind: input.kind,
        command: input.command,
        source: input.source,
        confidence: input.confidence ?? "derived",
        scope: input.scope,
        targetPath: input.targetPath,
        details: uniqueSorted([...redactSecretDetails(input.details ?? []), ...reportDetails]),
        exitCode: report.exitCode,
        durationMs: report.durationMs,
        outputSummary,
        commandEnvelope
      });
    };
    if (report.missingExitCode) {
      addCoverage({
        kind: "unknown",
        command: report.command,
        source: "command report missing exit code",
        confidence: "derived",
        scope: initialCwd,
        details: reportDetails
      });
      continue;
    }
    if (report.missingCwd) {
      addCoverage({
        kind: "unknown",
        command: report.command,
        source: "command report missing cwd",
        confidence: "derived",
        scope: initialCwd,
        details: reportDetails
      });
      continue;
    }
    if (report.exitCode !== undefined && report.exitCode !== 0) {
      addCoverage({
        kind: "unknown",
        command: report.command,
        source: `command failed with exit code ${report.exitCode}`,
        confidence: "derived",
        scope: initialCwd,
        details: reportDetails
      });
      continue;
    }
    if (analyzeCommandEnvelope(commandEnvelope, report.command, {
      index,
      repoRoot,
      scripts,
      packageRoots,
      packageNamesByRoot,
      visitedScripts: new Set<string>(),
      addCoverage
    })) {
      continue;
    }
    analyzeCommand(report.command, initialCwd, [report.command], {
      index,
      repoRoot,
      scripts,
      packageRoots,
      packageNamesByRoot,
      visitedScripts: new Set<string>(),
      addCoverage
    });
  }
  return { coverage: dedupeCoverage(coverage), commandEnvelopes: dedupeCommandEnvelopes(commandEnvelopes) };
}

function structuredEnvelopeSuppressesRaw(
  report: NormalizedCommandReport,
  envelope: VerificationCommandEnvelope,
  ctx: CommandEnvelopeContext
): boolean {
  if (report.exitCode !== 0) {
    return false;
  }
  if (envelope.scopeStatus !== "repo") {
    return false;
  }
  if (envelope.source === "reported" && !reportedEnvelopeMatchesCommand(envelope, report.command, ctx)) {
    return false;
  }
  return true;
}

function commandEnvelopeSemanticKey(envelope: VerificationCommandEnvelope): string | undefined {
  if (!envelope.packageManager || !envelope.scriptName || envelope.scopeStatus !== "repo") {
    return undefined;
  }
  return [envelope.packageManager, envelope.packageRoot ?? "", envelope.workspace ?? "", envelope.scriptName, envelope.args.join("\u0001")].join("\0");
}

function redactSecretDetails(details: string[]): string[] {
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

export function coverageForDisplay(index: CodexaIndex, commands: string[], repoRoot = index.snapshot.repoRoot): VerificationCoverage[] {
  return verificationCoverageForCommands(index, commands, repoRoot);
}

function normalizeCommandReports(ranCommands: string[], ranCommandReports: VerificationCommandReport[], repoRoot: string): NormalizedCommandReport[] {
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

function commandOutputSummary(report: VerificationCommandReport): string | undefined {
  const parts = [
    report.outputSummary ? `output: ${report.outputSummary}` : undefined,
    report.stdoutSummary ? `stdout: ${report.stdoutSummary}` : undefined,
    report.stderrSummary ? `stderr: ${report.stderrSummary}` : undefined
  ].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? clampSummary(parts.join(" | ")) : undefined;
}

function commandEnvelopeForReport(report: NormalizedCommandReport, initialCwd: string, ctx: CommandEnvelopeContext): VerificationCommandEnvelope {
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

function analyzeCommandEnvelope(
  envelope: VerificationCommandEnvelope,
  commandText: string,
  ctx: {
    index: CodexaIndex;
    repoRoot: string;
    scripts: Map<string, PackageScript>;
    packageRoots: string[];
    packageNamesByRoot: Map<string, string | undefined>;
    visitedScripts: Set<string>;
    addCoverage: (coverage: CoverageAddInput) => void;
  }
): boolean {
  if (envelope.source !== "reported" || envelope.scopeStatus !== "repo" || !envelope.packageManager) {
    return false;
  }
  if (!reportedEnvelopeMatchesCommand(envelope, commandText, ctx)) {
    ctx.addCoverage({
      kind: "unknown",
      command: commandText,
      source: "reported command envelope does not match command text",
      confidence: "derived",
      scope: envelope.packageRoot,
      details: [
        envelope.packageManager ? `reported package manager ${envelope.packageManager}` : undefined,
        envelope.scriptName ? `reported script ${envelope.scriptName}` : undefined,
        envelope.packageRoot ? `reported package root ${envelope.packageRoot}` : undefined
      ].filter((detail): detail is string => Boolean(detail))
    });
    return false;
  }
  const cwd = envelope.packageRoot ?? (envelope.cwd ? normalizeCwd(envelope.cwd, ctx.repoRoot) : ".");
  const manager = envelope.packageManager;
  const scriptName = envelope.scriptName;
  const args = envelope.args;
  if ((manager === "npm" || manager === "pnpm" || manager === "yarn") && scriptName) {
    expandPackageScript(scriptName, args, cwd, commandText, ctx);
    return true;
  }
  if (manager === "vitest" || manager === "jest") {
    addJavaScriptTestCoverage(args, cwd, commandText, `reported command envelope ${manager}`, ctx);
    return true;
  }
  if (manager === "pytest" || scriptName === "pytest") {
    addPythonTestCoverage(args, cwd, commandText, "reported command envelope pytest", ctx);
    return true;
  }
  if (manager === "tsc" || scriptName === "tsc") {
    ctx.addCoverage({ kind: "typescript-syntax", command: commandText, source: "reported command envelope tsc", scope: cwd, details: args });
    return true;
  }
  return false;
}

function reportedEnvelopeMatchesCommand(envelope: VerificationCommandEnvelope, commandText: string, ctx: CommandEnvelopeContext): boolean {
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

export function packageVerificationCommands(index: CodexaIndex, repoRoot = index.snapshot.repoRoot): string[] {
  const scripts = [...packageScriptsFromIndex(index).values()];
  const byRoot = new Map<string, Set<string>>();
  for (const script of scripts) {
    const set = byRoot.get(script.packageRoot) ?? new Set<string>();
    set.add(script.scriptName);
    byRoot.set(script.packageRoot, set);
  }
  const commands: string[] = [];
  for (const [packageRoot, names] of [...byRoot.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    for (const name of ["check", "test", "typecheck", "build", "lint", "audit", "privacy"]) {
      if (!names.has(name)) {
        continue;
      }
      const prefix = packageRoot === "." ? "" : `cd ${shellQuote(path.join(repoRoot, packageRoot))} && `;
      commands.push(`${prefix}${packageManagerRunCommand(repoRoot, packageRoot, name)}`);
    }
  }
  return uniqueSorted(commands);
}

export function verificationCommandsForContext(
  index: CodexaIndex,
  repoRoot: string,
  seedPaths: string[],
  tests: TestRecommendation[],
  limit = 16
): string[] {
  const aggregateCommands = packageVerificationCommands(index, repoRoot);
  const targetedCommandScores = new Map<string, number>();
  tests.forEach((test, index) => {
    if (!test.command) {
      return;
    }
    const current = targetedCommandScores.get(test.command) ?? 0;
    targetedCommandScores.set(test.command, Math.max(current, targetedCommandPriority(test, index)));
  });
  const targetedCommands = [...targetedCommandScores.keys()];
  const packageRoots = packageRootsFromIndex(index);
  const seedRoots = new Set(seedPaths.map((seedPath) => packageRootForPath(seedPath, packageRoots)));
  const seedPathSet = new Set(seedPaths.map(normalizePathLike));
  return uniqueSorted([...targetedCommands, ...aggregateCommands])
    .sort(
      (a, b) =>
        (targetedCommandScores.get(b) ?? 0) - (targetedCommandScores.get(a) ?? 0) ||
        verificationCommandScore(b, repoRoot, seedRoots, seedPathSet) - verificationCommandScore(a, repoRoot, seedRoots, seedPathSet) ||
        a.localeCompare(b)
    )
    .slice(0, limit);
}

function targetedCommandPriority(test: TestRecommendation, index: number): number {
  const tier =
    test.evidenceTier === "authoritative" ? 400 : test.evidenceTier === "derived" ? 300 : test.evidenceTier === "heuristic" ? 200 : test.evidenceTier === "fallback" ? 100 : 0;
  return 1000 + tier + test.rank * 10 - index / 100;
}

function verificationCommandScore(command: string, repoRoot: string, seedRoots: Set<string>, seedPaths: Set<string>): number {
  const normalizedCommand = normalizePathLike(command.replaceAll(repoRoot, ""));
  let score = 0;
  for (const seedPath of seedPaths) {
    if (normalizedCommand.includes(seedPath)) {
      score += 80;
    }
  }
  for (const root of seedRoots) {
    if (root === "." && !/^\s*cd\s/u.test(command)) {
      score += 20;
    } else if (root !== "." && normalizedCommand.includes(normalizePathLike(root))) {
      score += 60;
    }
  }
  if (/\b(?:test|vitest|pytest|jest)\b/u.test(command)) {
    score += 12;
  }
  if (/\bcheck\b/u.test(command)) {
    score += 8;
  }
  return score;
}

export function verificationLedgerForPostEdit(input: {
  index: CodexaIndex;
  tests: TestRecommendation[];
  ranTests: string[];
  ranCommands: string[];
  ranCommandReports?: VerificationCommandReport[];
  waivedChecks?: string[];
  waivers?: VerificationWaiver[];
  repoRoot?: string;
  workflowChecks?: Array<{ target: string; reason: string; status: VerificationLedgerStatus; confidence: Confidence; evidenceTier?: string; source?: string }>;
  dependencyChecks?: Array<{ target: string; reason: string; status: VerificationLedgerStatus; confidence: Confidence; evidenceTier?: string; source?: string }>;
}): { coverage: VerificationCoverage[]; commandEnvelopes: VerificationCommandEnvelope[]; ledger: VerificationLedgerEntry[]; testsNotRun: TestRecommendation[] } {
  const repoRoot = input.repoRoot ?? input.index.snapshot.repoRoot;
  const evidence = verificationEvidenceForCommandReports(input.index, input.ranCommands, input.ranCommandReports ?? [], repoRoot);
  const coverage = evidence.coverage;
  const waiverSet = waiversForMatching(input.waivers ?? [], input.waivedChecks ?? []);
  const ledger: VerificationLedgerEntry[] = [];
  const testsNotRun: TestRecommendation[] = [];

  for (const test of input.tests) {
    const match = testVerificationEvidence(test, input.ranTests, coverage, packageRootsFromIndex(input.index), new Set(input.index.files.map((file) => file.path)));
    const waiver = waiverSet.get(waiverKey("test", test.path)) ?? (test.command ? waiverSet.get(waiverKey("test", test.command)) : undefined);
    const status: VerificationLedgerStatus = match.covered ? "covered" : waiver ? "waived" : "missing";
    if (status === "missing") {
      testsNotRun.push(test);
    }
    ledger.push({
      kind: "test",
      recommended: test.path,
      target: test.path,
      status,
      evidence: status === "waived" ? [`waived: ${waiver?.reason ?? "explicit waiver"}`] : match.evidence,
      missingReason: status === "missing" ? "no reported test path, matching command, aggregate runner, or waiver covered this recommendation" : undefined,
      waiverReason: status === "waived" ? waiver?.reason : undefined,
      coverageKinds: uniqueSorted(match.coverage.map((entry) => entry.kind)) as VerificationCoverageKind[],
      command: test.command,
      source: test.commandSource
    });
  }

  for (const check of input.workflowChecks ?? []) {
    ledger.push(checkLedgerEntry("workflow", check, waiverSet));
  }
  for (const check of input.dependencyChecks ?? []) {
    ledger.push(checkLedgerEntry("dependency", check, waiverSet));
  }

  return { coverage, commandEnvelopes: evidence.commandEnvelopes, ledger, testsNotRun };
}

export function formatVerificationCoverage(coverage: VerificationCoverage[]): string[] {
  return formatVerificationCommandPlan(verificationCommandPlan(coverage));
}

export function verificationCommandPlan(coverage: VerificationCoverage[]): VerificationCommandPlanEntry[] {
  const byCommand = new Map<string, VerificationCommandPlanEntry>();
  for (const entry of coverage) {
    const command = topLevelCommand(entry.command);
    const plan =
      byCommand.get(command) ??
      ({
        command,
        covers: [],
        targetPaths: [],
        scopes: [],
        sources: [],
        confidence: entry.confidence
      } satisfies VerificationCommandPlanEntry);
    plan.covers = uniqueSorted([...plan.covers, entry.kind]) as VerificationCoverageKind[];
    plan.targetPaths = uniqueSorted([...plan.targetPaths, ...(entry.targetPath ? [entry.targetPath] : [])]);
    plan.scopes = uniqueSorted([...plan.scopes, ...(entry.scope ? [entry.scope] : [])]);
    plan.sources = uniqueSorted([...plan.sources, entry.source]);
    plan.confidence = mergeConfidence(plan.confidence, entry.confidence);
    byCommand.set(command, plan);
  }
  return [...byCommand.values()].sort((a, b) => commandPlanScore(b) - commandPlanScore(a) || a.command.localeCompare(b.command));
}

export function formatVerificationCommandPlan(plan: VerificationCommandPlanEntry[]): string[] {
  if (plan.length === 0) {
    return ["- none inferred from reported commands"];
  }
  return plan.slice(0, 16).map((entry) => {
    const targets = entry.targetPaths.length > 0 ? `; targets ${entry.targetPaths.slice(0, 4).join(", ")}` : "";
    const scopes = entry.scopes.length > 0 ? `; scopes ${entry.scopes.slice(0, 4).join(", ")}` : "";
    return `- ${entry.command}: covers ${entry.covers.join(", ")}${targets}${scopes}; ${entry.confidence}; ${entry.sources.slice(0, 3).join(", ")}`;
  });
}

export function formatVerificationLedger(ledger: VerificationLedgerEntry[]): string[] {
  if (ledger.length === 0) {
    return ["- none"];
  }
  return ledger.slice(0, 30).map((entry) => {
    const evidence = entry.evidence.length > 0 ? `; evidence: ${entry.evidence.slice(0, 3).join(" | ")}` : "";
    const missing = entry.missingReason ? `; missing: ${entry.missingReason}` : "";
    return `- ${entry.status}: ${entry.kind} ${entry.target}; ${entry.recommended}${evidence}${missing}`;
  });
}

function checkLedgerEntry(
  kind: "workflow" | "dependency",
  check: { target: string; reason: string; status: VerificationLedgerStatus; confidence: Confidence; source?: string },
  waivers: Map<string, VerificationWaiver>
): VerificationLedgerEntry {
  const waiver = check.status === "missing" ? waivers.get(waiverKey(kind, check.target)) : undefined;
  const status = waiver ? "waived" : check.status;
  return {
    kind,
    recommended: check.reason,
    target: check.target,
    status,
    evidence:
      status === "covered"
        ? [`${kind} evidence present`]
        : status === "not_applicable"
          ? ["not applicable to edited/reviewed paths"]
          : status === "waived"
            ? [`waived: ${waiver?.reason ?? "explicit waiver"}`]
            : [],
    missingReason: status === "missing" ? `${kind} check has no non-edited evidence in this review packet` : undefined,
    waiverReason: status === "waived" ? waiver?.reason : undefined,
    notApplicableReason: status === "not_applicable" ? "required check paths did not intersect edited or reviewed paths" : undefined,
    coverageKinds: [],
    source: check.source
  };
}

function testVerificationEvidence(
  test: TestRecommendation,
  ranTests: string[],
  coverage: VerificationCoverage[],
  packageRoots: string[],
  indexedPaths: Set<string>
): { covered: boolean; evidence: string[]; coverage: VerificationCoverage[] } {
  const directEvidence = wasTestRun(test, ranTests) ? [`reported ranTests matched ${test.path}`] : [];
  const commandCoverage = coverage.filter((entry) => coverageCoversTest(entry, test.path, packageRoots, indexedPaths));
  const commandEvidence = commandCoverage.map((entry) => {
    const target = entry.targetPath ? `target ${entry.targetPath}` : entry.scope ? `scope ${entry.scope}` : "repo scope";
    return `${entry.command} covers ${entry.kind} ${target}`;
  });
  return {
    covered: directEvidence.length > 0 || commandEvidence.length > 0,
    evidence: [...directEvidence, ...commandEvidence],
    coverage: commandCoverage
  };
}

function coverageCoversTest(coverage: VerificationCoverage, testPath: string, packageRoots: string[], indexedPaths: Set<string>): boolean {
  const expected = testPath.endsWith(".py") ? "python-tests" : "javascript-tests";
  if (coverage.kind !== expected) {
    return false;
  }
  if (coverage.targetPath) {
    return normalizePathLike(coverage.targetPath) === normalizePathLike(testPath);
  }
  if (!indexedPaths.has(testPath)) {
    return false;
  }
  return scopeCoversPath(coverage.scope ?? ".", testPath, packageRoots);
}

function scopeCoversPath(scope: string, filePath: string, packageRoots: string[]): boolean {
  const normalizedScope = normalizePathLike(scope);
  const normalizedPath = normalizePathLike(filePath);
  if (normalizedScope === ".") {
    return !packageRoots.some((root) => root !== "." && (normalizedPath === root || normalizedPath.startsWith(`${root}/`)));
  }
  return normalizedPath === normalizedScope || normalizedPath.startsWith(`${normalizedScope}/`);
}

function analyzeCommand(
  command: string,
  initialCwd: string,
  chain: string[],
  ctx: {
    index: CodexaIndex;
    repoRoot: string;
    scripts: Map<string, PackageScript>;
    packageRoots: string[];
    packageNamesByRoot: Map<string, string | undefined>;
    visitedScripts: Set<string>;
    addCoverage: (coverage: CoverageAddInput) => void;
  }
): void {
  let cwd = initialCwd;
  let chainTruthiness: ShellTruthiness = "unknown";
  for (const segment of splitSimpleCommand(command, cwd, ctx.repoRoot)) {
    cwd = segment.cwd;
    if (segment.operator === "&&" && chainTruthiness === "false") {
      continue;
    }
    if (segment.operator === "||" && chainTruthiness === "true") {
      continue;
    }
    analyzeSegment(segment.text, cwd, chain, ctx);
    chainTruthiness = segmentTruthiness(segment.text);
  }
}

function analyzeSegment(
  segment: string,
  cwd: string,
  chain: string[],
  ctx: {
    index: CodexaIndex;
    repoRoot: string;
    scripts: Map<string, PackageScript>;
    packageRoots: string[];
    packageNamesByRoot: Map<string, string | undefined>;
    visitedScripts: Set<string>;
    addCoverage: (coverage: CoverageAddInput) => void;
  }
): void {
  const words = stripShellControlWords(stripLeadingEnvironment(shellWords(segment)));
  if (words.length === 0 || isNonRunningCommand(words)) {
    return;
  }
  const commandText = [...chain, segment].join(" -> ");
  const shellWrapped = shellWrappedCommand(words);
  if (shellWrapped) {
    analyzeCommand(shellWrapped, cwd, chain, ctx);
    return;
  }
  const scoped = scopedPackageCommand(words, ctx.repoRoot, ctx.packageRoots, ctx.packageNamesByRoot) ?? scopedPackageCommand(stripPackageManagerFlags(words), ctx.repoRoot, ctx.packageRoots, ctx.packageNamesByRoot);
  if (scoped) {
    analyzeSegment(scoped.words.join(" "), scoped.cwd, chain, ctx);
    return;
  }
  const effectiveWords = stripPackageManagerFlags(words);
  const first = effectiveWords[0];
  if ((first === "npm" || first === "pnpm") && effectiveWords[1] === "run" && effectiveWords[2]) {
    expandPackageScript(effectiveWords[2], effectiveWords.slice(3), cwd, commandText, ctx);
    return;
  }
  if (first === "pnpm" && hasPnpmWorkspaceFlag(effectiveWords)) {
    ctx.addCoverage({ kind: "unknown", command: commandText, source: "unsupported pnpm workspace command", confidence: "heuristic", scope: cwd, details: chain });
    return;
  }
  if ((first === "npm" || first === "pnpm") && effectiveWords[1] === "exec" && (effectiveWords[2] === "vitest" || effectiveWords[2] === "jest")) {
    addJavaScriptTestCoverage(effectiveWords.slice(3), cwd, commandText, `direct ${first} exec ${effectiveWords[2]} command`, ctx);
    return;
  }
  if ((first === "npm" || first === "pnpm") && (effectiveWords[1] === "test" || effectiveWords[1] === "t")) {
    expandPackageScript("test", effectiveWords.slice(2), cwd, commandText, ctx);
    return;
  }
  if (first === "yarn" && effectiveWords[1]) {
    const scriptName = effectiveWords[1] === "run" ? effectiveWords[2] : effectiveWords[1];
    if (scriptName) {
      expandPackageScript(scriptName, effectiveWords.slice(effectiveWords[1] === "run" ? 3 : 2), cwd, commandText, ctx);
    }
    return;
  }
  if (first === "vitest" || first === "jest" || (first === "npx" && (effectiveWords[1] === "vitest" || effectiveWords[1] === "jest"))) {
    const runner = first === "npx" ? effectiveWords[1] : first;
    addJavaScriptTestCoverage(effectiveWords.slice(first === "npx" ? 2 : 1), cwd, commandText, `direct ${runner} command`, ctx);
    return;
  }
  if (first === "node" && effectiveWords.includes("--test")) {
    addJavaScriptTestCoverage(effectiveWords.slice(1), cwd, commandText, "direct node --test command", ctx);
    return;
  }
  if (first === "pytest" || (first === "uv" && effectiveWords[1] === "run" && effectiveWords[2] === "pytest")) {
    addPythonTestCoverage(effectiveWords.slice(first === "uv" ? 3 : 1), cwd, commandText, "direct pytest command", ctx);
    return;
  }
  if ((first === "python" || first === "python3") && effectiveWords[1] === "-m" && effectiveWords[2] === "pytest") {
    addPythonTestCoverage(effectiveWords.slice(3), cwd, commandText, "direct python -m pytest command", ctx);
    return;
  }
  if (first === "tsc" || (first === "npx" && effectiveWords[1] === "tsc")) {
    ctx.addCoverage({ kind: "typescript-syntax", command: commandText, source: "direct tsc command", scope: cwd, details: chain });
    return;
  }
  if (first === "npm" && effectiveWords[1] === "audit") {
    ctx.addCoverage({ kind: "audit", command: commandText, source: "direct npm audit command", scope: cwd, details: chain });
  }
}

function expandPackageScript(
  scriptName: string,
  args: string[],
  cwd: string,
  commandText: string,
  ctx: {
    index: CodexaIndex;
    repoRoot: string;
    scripts: Map<string, PackageScript>;
    packageRoots: string[];
    packageNamesByRoot: Map<string, string | undefined>;
    visitedScripts: Set<string>;
    addCoverage: (coverage: CoverageAddInput) => void;
  }
): void {
  const packageRoot = packageRootForCwd(cwd, ctx.scripts, ctx.packageRoots);
  const key = `${packageRoot}\0${scriptName}`;
  const script = ctx.scripts.get(key);
  if (!script) {
    ctx.addCoverage({ kind: "unknown", command: commandText, source: `${packageRoot}/package.json#scripts.${scriptName} missing`, confidence: "heuristic", scope: packageRoot });
    return;
  }
  if (hasNonRunningCommandArg(args)) {
    return;
  }
  if (ctx.visitedScripts.has(key)) {
    ctx.addCoverage({ kind: "unknown", command: commandText, source: `${script.source} recursive`, confidence: "heuristic", scope: packageRoot });
    return;
  }
  ctx.visitedScripts.add(key);
  addScriptNameCoverage(script, commandText, ctx);
  const forwardedArgs = forwardedScriptArgs(args);
  const expanded = forwardedArgs.length > 0 ? `${script.command} ${forwardedArgs.map(shellQuote).join(" ")}` : script.command;
  analyzeCommand(expanded, script.packageRoot, [...commandText.split(" -> "), script.source], ctx);
  ctx.visitedScripts.delete(key);
}

function addScriptNameCoverage(
  script: PackageScript,
  commandText: string,
  ctx: { addCoverage: (coverage: CoverageAddInput) => void }
): void {
  const lowerName = script.scriptName.toLowerCase();
  const lowerCommand = script.command.toLowerCase();
  const hasNoEmit = /(^|\s)--noEmit(\s|$)/u.test(script.command);
  if ((lowerName === "build" && !hasNoEmit) || /\b(vite\s+build|next\s+build)\b/u.test(lowerCommand) || (/\btsc\b/u.test(lowerCommand) && !hasNoEmit)) {
    ctx.addCoverage({ kind: "build", command: commandText, source: script.source, scope: script.packageRoot, details: [script.command] });
  }
  if (lowerName.includes("type") || /\btsc\b/u.test(lowerCommand)) {
    ctx.addCoverage({ kind: "typescript-syntax", command: commandText, source: script.source, scope: script.packageRoot, details: [script.command] });
  }
  if (lowerName.includes("lint") || /\b(eslint|biome|verify-source-hygiene)\b/u.test(lowerCommand)) {
    ctx.addCoverage({ kind: "lint", command: commandText, source: script.source, scope: script.packageRoot, details: [script.command] });
  }
  if (lowerName.includes("privacy") || /\bverify-public-hygiene\b/u.test(lowerCommand)) {
    ctx.addCoverage({ kind: "privacy", command: commandText, source: script.source, scope: script.packageRoot, details: [script.command] });
  }
  if (lowerName.includes("audit") || /\bnpm\s+audit\b/u.test(lowerCommand)) {
    ctx.addCoverage({ kind: "audit", command: commandText, source: script.source, scope: script.packageRoot, details: [script.command] });
  }
}

function addJavaScriptTestCoverage(
  args: string[],
  cwd: string,
  commandText: string,
  source: string,
  ctx: { repoRoot: string; addCoverage: (coverage: CoverageAddInput) => void }
): void {
  if (hasNonRunningJavaScriptTestArg(args)) {
    return;
  }
  const targets = args.map((arg) => normalizeCandidateTarget(arg, cwd, ctx.repoRoot)).filter((arg): arg is string => Boolean(arg));
  if (targets.length === 0) {
    ctx.addCoverage({ kind: "javascript-tests", command: commandText, source, scope: cwd, details: args });
    return;
  }
  for (const target of targets) {
    ctx.addCoverage({ kind: "javascript-tests", command: commandText, source, scope: cwd, targetPath: target, details: args });
    ctx.addCoverage({ kind: "targeted-test", command: commandText, source, scope: cwd, targetPath: target, details: args });
  }
}

function addPythonTestCoverage(
  args: string[],
  cwd: string,
  commandText: string,
  source: string,
  ctx: { repoRoot: string; addCoverage: (coverage: CoverageAddInput) => void }
): void {
  if (hasNonRunningPythonTestArg(args) || args.some((arg) => ["--collect-only", "--co", "--fixtures"].includes(arg))) {
    return;
  }
  const targets = args.map((arg) => normalizeCandidateTarget(arg, cwd, ctx.repoRoot)).filter((arg): arg is string => Boolean(arg));
  const testTargets = targets.filter((target) => target.endsWith(".py") || target.startsWith("tests/"));
  if (testTargets.length === 0) {
    ctx.addCoverage({ kind: "python-tests", command: commandText, source, scope: cwd, details: args });
    return;
  }
  for (const target of testTargets) {
    ctx.addCoverage({ kind: "python-tests", command: commandText, source, scope: cwd, targetPath: target, details: args });
    ctx.addCoverage({ kind: "targeted-test", command: commandText, source, scope: cwd, targetPath: target, details: args });
  }
}

function splitSimpleCommand(command: string, initialCwd: string, repoRoot: string): ParsedSegment[] {
  const segments = splitShellSequence(command);
  const result: ParsedSegment[] = [];
  let cwd = initialCwd;
  for (const segment of segments) {
    const words = stripLeadingEnvironment(shellWords(segment.text));
    if (words[0] === "cd" && words[1]) {
      cwd = normalizeCwd(words[1], repoRoot);
      continue;
    }
    result.push({ cwd, text: segment.text, operator: segment.operator });
  }
  return result;
}

function packageScriptsFromIndex(index: CodexaIndex): Map<string, PackageScript> {
  const scripts = new Map<string, PackageScript>();
  for (const usage of index.usageSites) {
    if (usage.source !== "manifest" || !usage.path.endsWith("package.json") || !usage.name.startsWith("npm script ")) {
      continue;
    }
    const scriptName = usage.name.replace(/^npm script\s+/u, "");
    const packageRoot = normalizePackageRoot(path.posix.dirname(usage.path));
    const source = `${packageRoot === "." ? "" : `${packageRoot}/`}package.json#scripts.${scriptName}`;
    scripts.set(`${packageRoot}\0${scriptName}`, {
      packageRoot,
      scriptName,
      command: usage.text,
      source
    });
  }
  return scripts;
}

function packageManagerRunCommand(repoRoot: string, packageRoot: string, scriptName: string): string {
  const absoluteRoot = path.join(repoRoot, packageRoot === "." ? "" : packageRoot);
  if (existsSync(path.join(absoluteRoot, "pnpm-lock.yaml")) || (packageRoot !== "." && existsSync(path.join(repoRoot, "pnpm-lock.yaml")))) {
    return scriptName === "test" ? "pnpm test" : `pnpm run ${scriptName}`;
  }
  if (existsSync(path.join(absoluteRoot, "yarn.lock")) || (packageRoot !== "." && existsSync(path.join(repoRoot, "yarn.lock")))) {
    return scriptName === "test" ? "yarn test" : `yarn ${scriptName}`;
  }
  return scriptName === "test" ? "npm test" : `npm run ${scriptName}`;
}

function packageRootsFromIndex(index: CodexaIndex): string[] {
  return uniqueSorted(index.files.filter((file) => file.path.endsWith("package.json")).map((file) => normalizePackageRoot(path.posix.dirname(file.path))));
}

function packageRootForCwd(cwd: string, scripts: Map<string, PackageScript>, packageRoots: string[]): string {
  if (cwd.startsWith("__outside_repo__:")) {
    return cwd;
  }
  const normalized = normalizePackageRoot(cwd);
  if ([...scripts.keys()].some((key) => key.startsWith(`${normalized}\0`))) {
    return normalized;
  }
  const candidates = uniqueSorted([...packageRoots, ...[...scripts.values()].map((script) => script.packageRoot)]).sort((a, b) => b.length - a.length);
  return candidates.find((candidate) => candidate !== "." && (normalized === candidate || normalized.startsWith(`${candidate}/`))) ?? ".";
}

function packageRootForPath(filePath: string, packageRoots: string[]): string {
  const normalized = normalizePathLike(filePath);
  return uniqueSorted(packageRoots)
    .sort((a, b) => b.length - a.length)
    .find((candidate) => candidate !== "." && (normalized === candidate || normalized.startsWith(`${candidate}/`))) ?? ".";
}

function scopedPackageCommand(
  words: string[],
  repoRoot: string,
  packageRoots: string[],
  packageNamesByRoot: Map<string, string | undefined>
): { cwd: string; words: string[] } | undefined {
  const first = words[0];
  if ((first === "npm" || first === "pnpm") && (words[1] === "--prefix" || words[1] === "-C" || words[1] === "--dir") && words[2]) {
    return { cwd: normalizeCwd(words[2], repoRoot), words: [first, ...words.slice(3)] };
  }
  const prefixValue = flagValue(words[1], ["--prefix", "-C", "--dir"]);
  if ((first === "npm" || first === "pnpm") && prefixValue) {
    return { cwd: normalizeCwd(prefixValue, repoRoot), words: [first, ...words.slice(2)] };
  }
  const npmWorkspace = readFlagArgument(words, 1, ["-w", "--workspace"]);
  if (first === "npm" && npmWorkspace) {
    return {
      cwd: resolvePackageSpecifier(npmWorkspace.value, repoRoot, packageRoots, packageNamesByRoot) ?? unresolvedPackageScope(npmWorkspace.value),
      words: [first, ...words.slice(npmWorkspace.nextIndex)]
    };
  }
  const pnpmFilter = readFlagArgument(words, 1, ["--filter", "-F"]);
  if (first === "pnpm" && pnpmFilter) {
    const cwd = resolvePackageSpecifier(pnpmFilter.value, repoRoot, packageRoots, packageNamesByRoot);
    return cwd ? { cwd, words: [first, ...words.slice(pnpmFilter.nextIndex)] } : undefined;
  }
  if (first === "yarn" && words[1] === "--cwd" && words[2]) {
    return { cwd: normalizeCwd(words[2], repoRoot), words: ["yarn", ...words.slice(3)] };
  }
  const yarnCwdValue = flagValue(words[1], ["--cwd"]);
  if (first === "yarn" && yarnCwdValue) {
    return { cwd: normalizeCwd(yarnCwdValue, repoRoot), words: ["yarn", ...words.slice(2)] };
  }
  if (first === "yarn" && words[1] === "workspace" && words[2]) {
    return { cwd: resolvePackageSpecifier(words[2], repoRoot, packageRoots, packageNamesByRoot) ?? unresolvedPackageScope(words[2]), words: ["yarn", ...words.slice(3)] };
  }
  return undefined;
}

function readFlagArgument(words: string[], start: number, flags: string[]): { value: string; nextIndex: number } | undefined {
  const word = words[start];
  const inline = flagValue(word, flags);
  if (inline) {
    return { value: inline, nextIndex: start + 1 };
  }
  if (word && flags.includes(word) && words[start + 1]) {
    return { value: words[start + 1], nextIndex: start + 2 };
  }
  return undefined;
}

function flagValue(word: string | undefined, flags: string[]): string | undefined {
  if (!word) {
    return undefined;
  }
  for (const flag of flags) {
    if (word.startsWith(`${flag}=`)) {
      const value = word.slice(flag.length + 1);
      return value || undefined;
    }
  }
  return undefined;
}

function forwardedScriptArgs(args: string[]): string[] {
  const delimiter = args.indexOf("--");
  return delimiter >= 0 ? args.slice(delimiter + 1) : args.filter((arg) => !arg.startsWith("-"));
}

function resolvePackageSpecifier(
  value: string,
  repoRoot: string,
  packageRoots: string[],
  packageNamesByRoot: Map<string, string | undefined>
): string | undefined {
  const clean = stripQuotes(value.trim());
  if (!clean || clean.startsWith("!") || /[*{},]/u.test(clean) || clean.includes("...")) {
    return undefined;
  }
  const pathCandidate = normalizeCwd(clean.replace(/^\.\//u, ""), repoRoot);
  if (!pathCandidate.startsWith("__outside_repo__:") && existsSync(path.join(repoRoot, pathCandidate === "." ? "" : pathCandidate, "package.json"))) {
    return pathCandidate;
  }
  for (const root of packageRoots) {
    if (packageNameForRoot(root, repoRoot, packageNamesByRoot) === clean) {
      return root;
    }
  }
  return undefined;
}

function packageNameForRoot(root: string, repoRoot: string, packageNamesByRoot: Map<string, string | undefined>): string | undefined {
  if (packageNamesByRoot.has(root)) {
    return packageNamesByRoot.get(root);
  }
  const manifestPath = path.join(repoRoot, root === "." ? "" : root, "package.json");
  let packageName: string | undefined;
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { name?: unknown };
    if (typeof manifest.name === "string") {
      packageName = manifest.name;
    }
  } catch {
    packageName = undefined;
  }
  packageNamesByRoot.set(root, packageName);
  return packageName;
}

function unresolvedPackageScope(value: string): string {
  return `__outside_repo__:unresolved-package:${value}`;
}

function normalizeCandidateTarget(value: string, cwd: string, repoRoot: string): string | undefined {
  if (value.startsWith("-") || /^[A-Z_][A-Z0-9_]*=/u.test(value)) {
    return undefined;
  }
  const clean = value.replace(/:\d+(?::\d+)?$/u, "").replace(/::.+$/u, "");
  if (!/(\.(?:test|spec)\.[cm]?[jt]sx?|\.py)$|^tests\//u.test(clean)) {
    return undefined;
  }
  const joined = path.isAbsolute(clean) ? relativeInsideRepo(clean, repoRoot) : path.posix.normalize(path.posix.join(normalizePackageRoot(cwd), clean));
  if (!joined) {
    return undefined;
  }
  return normalizePathLike(joined);
}

function normalizeCwd(value: string, repoRoot: string): string {
  const clean = stripQuotes(value.trim());
  if (clean.startsWith("__outside_repo__:")) {
    return clean;
  }
  if (path.isAbsolute(clean)) {
    const relative = path.relative(repoRoot, clean);
    if (relative === "") {
      return ".";
    }
    return !relative.startsWith("..") && !path.isAbsolute(relative) ? normalizePackageRoot(relative) : `__outside_repo__:${clean}`;
  }
  const absolute = path.resolve(repoRoot, clean || ".");
  const relative = path.relative(repoRoot, absolute);
  if (relative === "") {
    return ".";
  }
  return !relative.startsWith("..") && !path.isAbsolute(relative) ? normalizePackageRoot(relative) : `__outside_repo__:${absolute}`;
}

function relativeInsideRepo(value: string, repoRoot: string): string | undefined {
  const relative = path.relative(repoRoot, value);
  if (relative === "") {
    return ".";
  }
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return undefined;
  }
  return relative;
}

function splitShellSequence(command: string): Array<{ text: string; operator: ShellControlOperator }> {
  const segments: Array<{ text: string; operator: ShellControlOperator }> = [];
  let quote: "'" | "\"" | undefined;
  let current = "";
  let operator: ShellControlOperator = "start";
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    const next = command[index + 1];
    if ((char === "'" || char === "\"") && command[index - 1] !== "\\") {
      quote = quote === char ? undefined : quote ?? char;
      current += char;
      continue;
    }
    if (!quote && ((char === "&" && next === "&") || (char === "|" && next === "|"))) {
      if (current.trim()) {
        segments.push({ text: current.trim(), operator });
      }
      operator = char === "&" ? "&&" : "||";
      current = "";
      index += 1;
      continue;
    }
    if (!quote && char === "|") {
      if (current.trim()) {
        segments.push({ text: current.trim(), operator });
      }
      operator = "|";
      current = "";
      continue;
    }
    if (!quote && char === ";") {
      if (current.trim()) {
        segments.push({ text: current.trim(), operator });
      }
      operator = ";";
      current = "";
      continue;
    }
    current += char;
  }
  if (current.trim()) {
    segments.push({ text: current.trim(), operator });
  }
  return segments;
}

function segmentTruthiness(segment: string): ShellTruthiness {
  const words = stripShellControlWords(stripLeadingEnvironment(shellWords(segment)));
  const first = words[0];
  if (first === "true" || first === ":") {
    return "true";
  }
  if (first === "false") {
    return "false";
  }
  if (first === "exit" && words[1]) {
    const code = Number.parseInt(words[1], 10);
    if (Number.isFinite(code)) {
      return code === 0 ? "true" : "false";
    }
  }
  return "unknown";
}

function normalizePackageRoot(value: string): string {
  const normalized = normalizePathLike(value || ".");
  return normalized === "" ? "." : normalized;
}

function shellWords(value: string): string[] {
  return [...value.matchAll(/'([^']*)'|"([^"]*)"|(\S+)/gu)].map((match) => stripQuotes(match[1] ?? match[2] ?? match[3] ?? ""));
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/u.test(value)) {
    return value;
  }
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function stripQuotes(value: string): string {
  return value.replace(/^['"]|['"]$/gu, "");
}

function isNonRunningCommand(words: string[]): boolean {
  return words[0] === "echo" || words[0] === "printf";
}

function shellWrappedCommand(words: string[]): string | undefined {
  const first = words[0];
  if (first !== "bash" && first !== "sh" && first !== "zsh") {
    return undefined;
  }
  for (let index = 1; index < words.length; index += 1) {
    const word = words[index];
    if (word === "-c" || word === "-lc" || word === "-cl" || (word.startsWith("-") && word.includes("c"))) {
      return words[index + 1];
    }
  }
  return undefined;
}

function hasNonRunningJavaScriptTestArg(args: string[]): boolean {
  return args.some((arg) => ["--version", "-v", "-V", "--help", "-h", "help"].includes(arg));
}

function hasNonRunningPythonTestArg(args: string[]): boolean {
  return args.some((arg) => ["--version", "-V", "--help", "-h", "help"].includes(arg));
}

function hasNonRunningCommandArg(args: string[]): boolean {
  return args.some((arg) => ["--version", "-v", "-V", "--help", "-h", "help"].includes(arg));
}

function stripPackageManagerFlags(words: string[]): string[] {
  const first = words[0];
  if (first !== "npm" && first !== "pnpm" && first !== "yarn") {
    return words;
  }
  const noValueFlags = new Set(["--silent", "-s", "--no-progress", "--color", "--no-color"]);
  const valueFlags = new Set(["--loglevel", "--userconfig", "--cache"]);
  const stripped = [first];
  let index = 1;
  while (index < words.length) {
    const word = words[index];
    if (noValueFlags.has(word) || /^--(?:color|no-color|silent|no-progress)=/u.test(word)) {
      index += 1;
      continue;
    }
    if (valueFlags.has(word) && words[index + 1]) {
      index += 2;
      continue;
    }
    if (flagValue(word, [...valueFlags])) {
      index += 1;
      continue;
    }
    break;
  }
  return [...stripped, ...words.slice(index)];
}

function hasPnpmWorkspaceFlag(words: string[]): boolean {
  return words.some((word) => word === "-r" || word === "recursive" || word === "--recursive" || word === "--filter" || word === "-F" || word.startsWith("--filter=") || word.startsWith("-F="));
}

function stripLeadingEnvironment(words: string[]): string[] {
  let index = 0;
  if (words[index] === "env") {
    index += 1;
    while (index < words.length && (words[index] === "-i" || words[index] === "--ignore-environment")) {
      index += 1;
    }
  }
  while (index < words.length && isEnvironmentAssignment(words[index])) {
    index += 1;
  }
  return words.slice(index);
}

function stripShellControlWords(words: string[]): string[] {
  let index = 0;
  while (words[index] === "then" || words[index] === "do") {
    index += 1;
  }
  return words.slice(index);
}

function isEnvironmentAssignment(value: string | undefined): boolean {
  return Boolean(value && /^[A-Za-z_][A-Za-z0-9_]*=/u.test(value));
}

function dedupeCoverage(coverage: VerificationCoverage[]): VerificationCoverage[] {
  const byKey = new Map<string, VerificationCoverage>();
  for (const entry of coverage) {
    const key = [entry.kind, entry.command, entry.source, entry.scope ?? "", entry.targetPath ?? "", entry.exitCode ?? "", entry.durationMs ?? "", entry.outputSummary ?? ""].join("\0");
    const existing = byKey.get(key);
    if (existing) {
      existing.details = uniqueSorted([...existing.details, ...entry.details]);
      existing.confidence = mergeConfidence(existing.confidence, entry.confidence);
      existing.commandEnvelope = existing.commandEnvelope ?? entry.commandEnvelope;
    } else {
      byKey.set(key, { ...entry, details: uniqueSorted(entry.details) });
    }
  }
  return [...byKey.values()].sort((a, b) => a.kind.localeCompare(b.kind) || (a.targetPath ?? "").localeCompare(b.targetPath ?? "") || a.command.localeCompare(b.command));
}

function dedupeCommandEnvelopes(envelopes: VerificationCommandEnvelope[]): VerificationCommandEnvelope[] {
  const byKey = new Map<string, VerificationCommandEnvelope>();
  for (const envelope of envelopes) {
    const key = [
      envelope.command,
      envelope.cwd ?? "",
      envelope.packageManager ?? "",
      envelope.workspace ?? "",
      envelope.packageRoot ?? "",
      envelope.packageName ?? "",
      envelope.scriptName ?? "",
      envelope.args.join("\u0001"),
      envelope.exitCode ?? "",
      envelope.durationMs ?? "",
      envelope.stdoutSummary ?? "",
      envelope.stderrSummary ?? "",
      envelope.outputSummary ?? "",
      envelope.source,
      envelope.scopeStatus,
      envelope.classifierVersion
    ].join("\0");
    byKey.set(key, envelope);
  }
  return [...byKey.values()].sort(
    (a, b) =>
      a.command.localeCompare(b.command) ||
      (a.cwd ?? "").localeCompare(b.cwd ?? "") ||
      (a.packageRoot ?? "").localeCompare(b.packageRoot ?? "") ||
      (a.scriptName ?? "").localeCompare(b.scriptName ?? "")
  );
}

function commandPlanScore(entry: VerificationCommandPlanEntry): number {
  const covers = new Set(entry.covers);
  return (
    (covers.has("targeted-test") ? 35 : 0) +
    (covers.has("javascript-tests") || covers.has("python-tests") ? 40 : 0) +
    (covers.has("typescript-syntax") ? 12 : 0) +
    (covers.has("build") ? 10 : 0) +
    (covers.has("lint") ? 4 : 0) +
    (covers.has("privacy") ? 3 : 0) +
    (covers.has("audit") ? 2 : 0) +
    (entry.targetPaths.length > 0 ? 25 : 0)
  );
}

function topLevelCommand(command: string): string {
  return command.split(" -> ", 1)[0] ?? command;
}

function mergeConfidence(a: Confidence, b: Confidence): Confidence {
  if (a === "authoritative" || b === "authoritative") {
    return "authoritative";
  }
  if (a === "derived" || b === "derived") {
    return "derived";
  }
  return "heuristic";
}

function waiversForMatching(waivers: VerificationWaiver[], legacyWaivedChecks: string[]): Map<string, VerificationWaiver> {
  const result = new Map<string, VerificationWaiver>();
  for (const waiver of waivers) {
    if (!waiver.target || !waiver.reason) {
      continue;
    }
    result.set(waiverKey(waiver.kind, waiver.target), waiver);
  }
  for (const target of legacyWaivedChecks) {
    const reason = "legacy waivedChecks target";
    result.set(waiverKey("test", target), { kind: "test", target, reason });
  }
  return result;
}

function waiverKey(kind: VerificationWaiver["kind"], target: string): string {
  return `${kind}\0${normalizeSearchText(target)}`;
}

function normalizeSearchText(value: string): string {
  return normalizePathLike(value).toLowerCase().replace(/[^a-z0-9./:_-]+/gu, " ").replace(/\s+/gu, " ").trim();
}

function normalizePathLike(value: string): string {
  const normalized = value.replace(/\\/gu, "/").replace(/^\.\/+/u, "");
  const collapsed = path.posix.normalize(normalized);
  return collapsed === "." ? "." : collapsed.replace(/^\/+/u, "");
}
