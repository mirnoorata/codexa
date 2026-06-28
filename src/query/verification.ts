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
import {
  hasBalancedQuotes,
  hasNonRunningCommandArg,
  hasNonRunningJavaScriptTestArg,
  hasNonRunningPythonTestArg,
  hasPnpmWorkspaceFlag,
  isNonRunningCommand,
  segmentTruthiness,
  shellQuote,
  shellWrappedCommand,
  shellWrapperBodyIsAmbiguous,
  shellWords,
  stripCommandSubstitutions,
  stripLeadingEnvironment,
  stripPackageManagerFlags,
  stripShellControlWords,
  type ShellTruthiness
} from "./verification/shell.js";
import { commandNeedsFullMaskingAnalysis, segmentMasksExit, stripFlowPrefix } from "./verification/masking.js";
import {
  isNonCompilingTscCommand,
  NON_COMPILING_TSC_FLAG,
  scriptBodyIsNonCompilingTsc,
  scriptNameCreditUnsafe,
  scriptNameTrustUnsafe,
  scriptToolEvidence
} from "./verification/script-credit.js";
import {
  commandPlanScore,
  dedupeCommandEnvelopes,
  dedupeCoverage,
  maskedCoverageCtx,
  mergeConfidence,
  normalizeCandidateTarget,
  normalizeCwd,
  normalizePathLike,
  packageManagerRunCommand,
  packageNameForRoot,
  packageRootForCwd,
  packageRootForPath,
  packageRootsFromIndex,
  packageScriptsFromIndex,
  readFlagArgument,
  scopedPackageCommand,
  splitSimpleCommand,
  topLevelCommand,
  waiverKey,
  waiversForMatching,
  forwardedScriptArgs,
  type CommandEnvelopeContext,
  type CoverageAddInput,
  type CoverageAnalysisCtx,
  type PackageScript
} from "./verification/command-scope.js";
import {
  commandEnvelopeForReport,
  commandEnvelopeSemanticKey,
  commandOutputSummary,
  normalizeCommandReports,
  redactSecretDetails,
  reportedEnvelopeMatchesCommand,
  structuredRawSuppressionKey,
  type NormalizedCommandReport
} from "./verification/command-envelope.js";

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
	      .map(({ report, commandEnvelope }) => structuredRawSuppressionKey(report, commandEnvelope, envelopeContext))
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

export function coverageForDisplay(index: CodexaIndex, commands: string[], repoRoot = index.snapshot.repoRoot): VerificationCoverage[] {
  return verificationCoverageForCommands(index, commands, repoRoot);
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
  // The reported-envelope shortcut derives coverage from the matched runner
  // segment and would miss a trailing `|| true` / `| tee` / `&` that masks it,
  // or a masking operator hidden inside a shell wrapper's quoted body that a
  // top-level scan cannot see. Defer to analyzeCommand, which unwraps and
  // applies precise per-segment masking plus a fail-closed quote-balance check.
  if (commandNeedsFullMaskingAnalysis(commandText)) {
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
    if (args.some((arg) => NON_COMPILING_TSC_FLAG.test(arg))) {
      ctx.addCoverage({ kind: "unknown", command: commandText, source: "reported tsc envelope is a non-compiling invocation", confidence: "heuristic", scope: cwd, details: args });
      return true;
    }
    ctx.addCoverage({ kind: "typescript-syntax", command: commandText, source: "reported command envelope tsc", scope: cwd, details: args });
    return true;
  }
  return false;
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
  // Statically-dead `if false` bodies are skipped entirely. The counter tracks
  // nested `if`s inside the dead branch so an inner `fi` cannot end the skip.
  let deadIfDepth = 0;
  // Compounds whose exit decouples from the commands inside them: a runner in
  // the body of `if <unknown-cond>; then ...; fi`, `while ...; done`, or
  // `case ...; esac` may never run while the construct still exits 0, so
  // coverage inside one is downgraded to unknown. EVERY compound pushes an
  // entry (an `if true` pushes a non-masking one) so each terminator pops its
  // own opener and an inner `fi` can never drain an outer compound's entry.
  // Openers are detected after stripping leading flow keywords, so a nested
  // opener glued behind `then`/`do`/`else` (`then if b`) still pushes.
  // Each entry restores chainTruthiness at its pop: segments inside a masked or
  // dead compound body may never run, so a truthiness they set must not govern
  // `&&`/`||` short-circuits after the compound closes.
  const compoundStack: Array<{ terminator: string; masks: boolean; restoreTruthiness: ShellTruthiness }> = [];
  const insideMaskingCompound = () => compoundStack.some((entry) => entry.masks);
  const segments = splitSimpleCommand(command, cwd, ctx.repoRoot);
  for (let i = 0; i < segments.length; i += 1) {
    const segment = segments[i];
    cwd = segment.cwd;
    const words = stripLeadingEnvironment(shellWords(segment.text));
    const openerWords = stripFlowPrefix(words);
    // A glued group-closer (`done)`, `fi; }`) must still match its terminator,
    // or a subshell-wrapped compound would never pop and over-mask what follows.
    // A glued closer only counts when it stands alone (`fi)` from a wrapped
    // `(if ...; fi)`); with trailing words it is a case-pattern label, not a
    // terminator.
    const terminatorWord = words.length === 1 ? words[0]?.replace(/[)}]+$/u, "") : words[0];
    if (deadIfDepth > 0) {
      if (openerWords[0] === "if") {
        deadIfDepth += 1;
      } else if (terminatorWord === "fi") {
        deadIfDepth -= 1;
        if (deadIfDepth === 0) {
          // `if false; then ...; fi` completes with exit 0 (no branch taken).
          chainTruthiness = "true";
        }
      }
      continue;
    }
    if (segment.cd) {
      // A cd in a dead chain position never runs — keep the known truthiness so
      // the short-circuit still skips what follows (`false && cd x && npm test`).
      if ((segment.operator === "&&" && chainTruthiness === "false") || (segment.operator === "||" && chainTruthiness === "true")) {
        continue;
      }
      chainTruthiness = "unknown";
      continue;
    }
    const top = compoundStack[compoundStack.length - 1];
    if (top && terminatorWord === top.terminator) {
      compoundStack.pop();
      chainTruthiness = top.restoreTruthiness;
      continue;
    }
    // An `elif` marks the rest of its `if` as conditionally-reached even when
    // the original condition was statically true, so the enclosing entry must
    // mask from here on.
    if (words[0] === "elif" && top?.terminator === "fi") {
      top.masks = true;
      continue;
    }
    // A compound opener in a dead chain position (`true || if ...`) never runs
    // at all, and one in a SPECULATIVE `||` position (`git fetch || if true;
    // then pytest; fi`) may never run — either way its whole body must mask
    // regardless of condition truthiness, and the chain state after it is the
    // saved dead value or unknown respectively. A LIVE compound that completes
    // restores "true": in a report whose overall exit is 0, a completed
    // if/while/case either exited 0 or the report would be nonzero — so
    // `if x; then echo; fi || pytest` provably never ran pytest.
    const deadChainPosition = (segment.operator === "&&" && chainTruthiness === "false") || (segment.operator === "||" && chainTruthiness === "true");
    const speculativePosition = !deadChainPosition && segment.operator === "||" && chainTruthiness !== "false";
    const conditionallyReached = deadChainPosition || speculativePosition;
    const restoreTruthiness: ShellTruthiness = deadChainPosition ? chainTruthiness : speculativePosition ? "unknown" : "true";
    const ifTruthiness = ifConditionTruthiness(openerWords);
    if (ifTruthiness) {
      if (conditionallyReached) {
        compoundStack.push({ terminator: "fi", masks: true, restoreTruthiness });
      } else if (ifTruthiness === "false") {
        deadIfDepth = 1;
      } else {
        compoundStack.push({ terminator: "fi", masks: ifTruthiness === "unknown", restoreTruthiness });
      }
      if (!conditionallyReached) {
        chainTruthiness = ifTruthiness;
      }
      continue;
    }
    const opener = openerWords[0];
    if (opener === "while" || opener === "until" || opener === "for" || opener === "select") {
      compoundStack.push({ terminator: "done", masks: true, restoreTruthiness });
      continue;
    }
    if (opener === "case") {
      compoundStack.push({ terminator: "esac", masks: true, restoreTruthiness });
      continue;
    }
    if (segment.operator === "&&" && chainTruthiness === "false") {
      continue;
    }
    if (segment.operator === "||" && chainTruthiness === "true") {
      continue;
    }
    // This segment's exit code is masked if a later segment runs on its failure
    // and overrides the aggregate exit (`|| X`, `; X`, `| X`, `& X`), or if it
    // sits inside an open exit-decoupling compound. `&&` is safe (a failure
    // short-circuits and stays the exit). A `||` FALLBACK only provably ran
    // when the left side provably failed — `git fetch || pytest` with exit 0
    // most plausibly means git fetch succeeded and pytest never executed, so an
    // unknown-truthiness left side downgrades the fallback's coverage. When
    // masked, downgrade any coverage the segment (and its recursive expansion)
    // would claim to unknown — the reported exit 0 does not prove this runner
    // passed.
    const speculativeFallback: boolean = segment.operator === "||" && chainTruthiness !== "false";
    const exitMasked = speculativeFallback || insideMaskingCompound() || segments.slice(i + 1).some(segmentMasksExit);
    analyzeSegment(segment.text, cwd, chain, exitMasked ? maskedCoverageCtx(ctx) : ctx);
    // A speculative fallback may never have executed, so its literal truthiness
    // (`|| false`) cannot govern later short-circuits — `cmd || false || pytest`
    // must not treat the chain as provably failed.
    chainTruthiness = speculativeFallback ? "unknown" : segmentTruthiness(segment.text);
  }
}

function ifConditionTruthiness(words: string[]): ShellTruthiness | undefined {
  if (words[0] !== "if") {
    return undefined;
  }
  return segmentTruthiness(words.slice(1).join(" "));
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
    // The word tokenizer cannot represent nested or escaped quoting, so a
    // doubly-wrapped command (`sh -c "sh -c '... || true'"`) or an escaped-quote
    // body (`bash -lc "npm test --grep \"x\" || true"`) unwraps to a mangled,
    // truncated string whose masking operators are silently lost on
    // re-tokenization. Fail closed when the unwrap is unbalanced OR the wrapper
    // body could not be cleanly isolated — we cannot prove the exit was unmasked,
    // so record unknown rather than crediting a hidden runner.
    if (!hasBalancedQuotes(shellWrapped) || shellWrapperBodyIsAmbiguous(words)) {
      ctx.addCoverage({ kind: "unknown", command: commandText, source: "shell-wrapped command with unbalanced quotes (cannot verify exit was unmasked)", confidence: "heuristic", scope: cwd, details: chain });
      return;
    }
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
    if (isNonCompilingTscCommand(effectiveWords)) {
      // tsc --help / --version / --init / --showConfig / --listFilesOnly do not
      // typecheck; they must not satisfy a TypeScript verification check.
      ctx.addCoverage({ kind: "unknown", command: commandText, source: "tsc invoked with a non-compiling flag", confidence: "heuristic", scope: cwd, details: chain });
      return;
    }
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
  // Name-based coverage (a script named "typecheck"/"build" credits that check)
  // is only sound when the script body's exit faithfully reflects it. When the
  // body masks its own exit (`tsc --noEmit || true`, a trailing newline command,
  // a masked wrapper body), suppress the pre-credit entirely and let the body's
  // per-segment analysis below be authoritative. When only the NAME cannot be
  // trusted (a carrier-discarded substitution decides nothing while a carrier
  // ends the chain, e.g. `export X=$(tsc) && echo passed`), keep the pre-credit
  // but restrict it to regex evidence on the substitution-stripped body — a
  // runner the regexes can still see runs outside any substitution and stays
  // exit-faithful via && short-circuit.
  if (!scriptNameCreditUnsafe(script.command)) {
    addScriptNameCoverage(script, commandText, ctx, !scriptNameTrustUnsafe(script.command));
  }
  const forwardedArgs = forwardedScriptArgs(args);
  const expanded = forwardedArgs.length > 0 ? `${script.command} ${forwardedArgs.map(shellQuote).join(" ")}` : script.command;
  analyzeCommand(expanded, script.packageRoot, [...commandText.split(" -> "), script.source], ctx);
  ctx.visitedScripts.delete(key);
}

function addScriptNameCoverage(
  script: PackageScript,
  commandText: string,
  ctx: { addCoverage: (coverage: CoverageAddInput) => void },
  // When the body's exit cannot vouch for its NAME (scriptNameTrustUnsafe),
  // only regex evidence on the stripped body may credit — never the name alone.
  allowNameOnly: boolean
): void {
  const lowerName = script.scriptName.toLowerCase();
  // Tool evidence comes from command-position tokens of the substitution-
  // stripped body — never a substring scan, so paths (`scripts/run-tsc.mjs`),
  // env-var names (`TSC=1`), and prose cannot masquerade as invocations, while
  // `./node_modules/.bin/tsc` still counts via its basename.
  const evidence = scriptToolEvidence(stripCommandSubstitutions(script.command));
  // A "typecheck"/"build" script whose body is actually `tsc --help`/`--version`
  // (etc.) cannot vouch for its NAME. Tool evidence is already per-invocation
  // (recordToolEvidence skips informational flags), so an unrelated `tsc
  // --version` in the body does not veto a real `vite build` next to it.
  const nonCompilingTsc = scriptBodyIsNonCompilingTsc(script.command);
  if ((allowNameOnly && lowerName === "build" && !nonCompilingTsc && !evidence.tscNoEmit) || evidence.bundlerBuild || evidence.tscCompile) {
    ctx.addCoverage({ kind: "build", command: commandText, source: script.source, scope: script.packageRoot, details: [script.command] });
  }
  if ((allowNameOnly && lowerName.includes("type") && !nonCompilingTsc) || evidence.tscCompile || evidence.tscNoEmit) {
    ctx.addCoverage({ kind: "typescript-syntax", command: commandText, source: script.source, scope: script.packageRoot, details: [script.command] });
  }
  if ((allowNameOnly && lowerName.includes("lint")) || evidence.lint) {
    ctx.addCoverage({ kind: "lint", command: commandText, source: script.source, scope: script.packageRoot, details: [script.command] });
  }
  if ((allowNameOnly && lowerName.includes("privacy")) || evidence.privacy) {
    ctx.addCoverage({ kind: "privacy", command: commandText, source: script.source, scope: script.packageRoot, details: [script.command] });
  }
  if ((allowNameOnly && lowerName.includes("audit")) || evidence.audit) {
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
