import { isTestPath } from "../language.js";
import type { BaseQueryData, PostEditReviewData, QueryResult, TestRecommendation } from "../types.js";
import type { EvalResult, ScoredEvalScenario } from "../eval.js";
import { formatBaselineCommands, type BaselineRun } from "./baseline.js";
import type { EvalOracle, EvalScenario } from "./types.js";

export interface EvalVerificationProvenance {
  schemaVersion?: number;
  commandCoverageClassifier?: string;
  commandCoverageClassifierVersion?: string;
  commandEnvelopeRulesetVersion?: string;
  verificationLedgerVersion?: string;
}

export function scoreScenario(scenario: EvalScenario, result: QueryResult, baseline: BaselineRun[] | null, failOnRefresh: boolean, redactSample = false): ScoredEvalScenario {
  const structuredDataBytes = serializedByteLength(result.data);
  const files = filesFromData(result.data);
  const plannedFiles = plannedFilesFromData(result.data);
  const tests = testsFromData(result.data);
  const baselineFiles = baseline === null ? [] : uniqueInOrder(baseline.flatMap((entry) => baselineFilesFromOutput(entry.command, entry.output)));
  const baselineTests = baselineFiles.filter(isTestPath);
  const expectedFiles = scenario.oracle.expectedFiles ?? [];
  const expectedChangedFiles = scenario.oracle.expectedChangedFiles ?? [];
  const expectedTests = scenario.oracle.expectedTests ?? [];
  const forbiddenFiles = scenario.oracle.forbiddenFiles ?? [];
  const expectedReadFirstFiles = uniqueInOrder([...expectedFiles, ...expectedTests]);
  const failures: string[] = [];
  const scored = scenario.scored ?? true;
  const fileRecall = expectedFiles.length > 0 ? recall(files, expectedFiles) : null;
  const changedFileRecall = expectedChangedFiles.length > 0 ? recall(plannedFiles, expectedChangedFiles) : null;
  const testRecall = expectedTests.length > 0 ? recall(tests, expectedTests) : null;
  const precisionK = Math.max(1, expectedReadFirstFiles.length || scenario.oracle.topFiles?.length || 5);
  const precisionAtK = expectedReadFirstFiles.length > 0 ? precision(files.slice(0, precisionK), expectedReadFirstFiles) : null;
  const baselineLines = baseline === null ? null : baseline.reduce((sum, entry) => sum + entry.output.split(/\r?\n/).filter(Boolean).length, 0);
  const selectedToBaselineRatio = baselineLines && baselineLines > 0 ? files.length / baselineLines : null;
  const baselineFileRecall = expectedFiles.length > 0 ? recall(baselineFiles, expectedFiles) : null;
  const baselineTestRecall = expectedTests.length > 0 ? recall(baselineTests, expectedTests) : null;
  const baselinePrecisionAtK = expectedReadFirstFiles.length > 0 ? precision(baselineFiles.slice(0, precisionK), expectedReadFirstFiles) : null;
  const codexaToBaselineFileRatio = baselineFiles.length > 0 ? files.length / baselineFiles.length : null;
  const minFileRecall = scenario.oracle.minFileRecall ?? 1;
  const minChangedFileRecall = scenario.oracle.minChangedFileRecall ?? 1;
  const minTestRecall = scenario.oracle.minTestRecall ?? 1;
  const minPrecision = scenario.oracle.minFilePrecisionAtK ?? 0;
  const refreshed = Boolean(result.refresh?.refreshed);
  const quality = qualityFromData(result.data);
  const falsePositiveFiles = expectedFiles.length > 0 ? files.filter((file) => !expectedFiles.includes(file) && !expectedTests.includes(file)) : [];
  const missingExpectedFiles = expectedFiles.filter((file) => !files.includes(file));
  const missingExpectedChangedFiles = expectedChangedFiles.filter((file) => !plannedFiles.includes(file));
  const missingExpectedTests = expectedTests.filter((test) => !tests.includes(test));
  const actualCallTrace = callTraceFromData(result.data);
  const heuristicHeavy = Boolean(quality && quality.counts.heuristic > quality.counts.authoritative + quality.counts.derived && quality.counts.heuristic > 0);
  const broadRetrievalFailure = Boolean(quality?.level === "low" && /broad|natural|session|workflow/i.test(scenario.description));
  const rawRgBetter = Boolean(
    (baselineFileRecall !== null && fileRecall !== null && baselineFileRecall > fileRecall) ||
      (baselineTestRecall !== null && testRecall !== null && baselineTestRecall > testRecall) ||
      (baselinePrecisionAtK !== null && precisionAtK !== null && baselinePrecisionAtK > precisionAtK && fileRecall !== null && baselineFileRecall !== null && baselineFileRecall >= fileRecall)
  );
  const rawRgBetterReason = rawRgBetter
    ? [
        baselineFileRecall !== null && fileRecall !== null && baselineFileRecall > fileRecall ? `file recall baseline ${baselineFileRecall.toFixed(2)} > Codexa ${fileRecall.toFixed(2)}` : undefined,
        baselineTestRecall !== null && testRecall !== null && baselineTestRecall > testRecall ? `test recall baseline ${baselineTestRecall.toFixed(2)} > Codexa ${testRecall.toFixed(2)}` : undefined,
        baselinePrecisionAtK !== null && precisionAtK !== null && baselinePrecisionAtK > precisionAtK ? `precision baseline ${baselinePrecisionAtK.toFixed(2)} > Codexa ${precisionAtK.toFixed(2)}` : undefined
      ]
        .filter((entry): entry is string => Boolean(entry))
        .join("; ")
    : undefined;
  const overBudgetedOutput = Boolean(scenario.oracle.maxTextChars && result.text.length > scenario.oracle.maxTextChars);
  const structuredDataBudget = scenario.oracle.maxDataBytes ?? (scenario.oracle.maxTextChars ? Math.max(128_000, scenario.oracle.maxTextChars * 8) : 128_000);
  const overBudgetedStructuredData = structuredDataBytes > structuredDataBudget;
  const postEditOutcome = postEditOutcomeFromData(result.data);
  const toolHopsToEditReady = toolHopsToEditReadyFromData(result.data);
  const verificationProvenancePresent = Boolean(postEditOutcome?.verificationProvenance || verificationProvenanceFromData(result.data));

  if (fileRecall !== null && fileRecall < minFileRecall) {
    failures.push(`file recall ${fileRecall.toFixed(2)} < ${minFileRecall.toFixed(2)}`);
  }
  if (changedFileRecall !== null && changedFileRecall < minChangedFileRecall) {
    failures.push(`planned changed-file recall ${changedFileRecall.toFixed(2)} < ${minChangedFileRecall.toFixed(2)}`);
  }
  if (testRecall !== null && testRecall < minTestRecall) {
    failures.push(`test recall ${testRecall.toFixed(2)} < ${minTestRecall.toFixed(2)}`);
  }
  if (precisionAtK !== null && precisionAtK < minPrecision) {
    failures.push(`precision@${precisionK} ${precisionAtK.toFixed(2)} < ${minPrecision.toFixed(2)}`);
  }
  // The compactness ratio is meaningless against a tiny baseline: a 1-2
  // line `git status` makes ANY useful packet look bloated (ratio 5.00 for
  // ten context files against two dirty ones). Enforce only when the
  // baseline is substantial enough for the comparison to mean something.
  const MIN_BASELINE_LINES_FOR_RATIO = 5;
  if (
    scenario.oracle.maxSelectedToBaselineRatio !== undefined &&
    selectedToBaselineRatio !== null &&
    baselineLines !== null &&
    baselineLines >= MIN_BASELINE_LINES_FOR_RATIO &&
    selectedToBaselineRatio > scenario.oracle.maxSelectedToBaselineRatio
  ) {
    failures.push(`selected/baseline ratio ${selectedToBaselineRatio.toFixed(2)} > ${scenario.oracle.maxSelectedToBaselineRatio.toFixed(2)}`);
  }
  for (const file of forbiddenFiles) {
    if (files.includes(file)) {
      failures.push(`forbidden file returned: ${file}`);
    }
  }
  if (scenario.oracle.maxFalsePositiveFiles !== undefined && falsePositiveFiles.length > scenario.oracle.maxFalsePositiveFiles) {
    failures.push(`false-positive files ${falsePositiveFiles.length} > ${scenario.oracle.maxFalsePositiveFiles}`);
  }
  if (scenario.oracle.maxTestCount !== undefined && tests.length > scenario.oracle.maxTestCount) {
    failures.push(`test count ${tests.length} > ${scenario.oracle.maxTestCount}`);
  }
  for (const expectedCall of scenario.oracle.expectedCodexaCalls ?? []) {
    if (!actualCallTrace.includes(expectedCall)) {
      failures.push(`expected Codexa call missing from trace: ${expectedCall}`);
    }
  }
  for (const file of scenario.oracle.topFiles ?? []) {
    if (!files.slice(0, precisionK).includes(file)) {
      failures.push(`expected top-${precisionK} file missing: ${file}`);
    }
  }
  if (overBudgetedOutput && scenario.oracle.maxTextChars) {
    failures.push(`text length ${result.text.length} > ${scenario.oracle.maxTextChars}`);
  }
  if (overBudgetedStructuredData) {
    failures.push(`structured data size ${structuredDataBytes} > ${structuredDataBudget}`);
  }
  if (failOnRefresh && refreshed) {
    failures.push(`query auto-refreshed from ${result.refresh?.reason ?? "unknown"}`);
  }
  // The headline gate conditions, enforced — not just recorded as
  // calibration data. Without these, a ranking regression could sit at the
  // per-scenario minimum thresholds while raw grep strictly wins, and the
  // build would stay green under a step named "fails if raw grep wins".
  if (rawRgBetter) {
    failures.push(`raw baseline beat Codexa: ${rawRgBetterReason ?? "baseline metrics higher"}`);
  }
  if (heuristicHeavy) {
    failures.push("heuristic-heavy packet: heuristic evidence outweighs authoritative+derived");
  }

  const measured = [fileRecall, changedFileRecall, testRecall, precisionAtK].filter((value): value is number => value !== null);
  const baseScore = measured.length > 0 ? measured.reduce((sum, value) => sum + value, 0) / measured.length : failures.length === 0 ? 1 : 0;
  const score = scored ? Math.max(0, baseScore - Math.min(0.5, failures.length * 0.1)) : 0;
  return {
    id: scenario.id,
    suite: scenario.suite,
    description: redactSample ? `External historical task: ${scenario.id}` : scenario.description,
    passed: failures.length === 0,
    score,
    scored,
    baselineLines,
    baselineFiles,
    baselineTests,
    files,
    plannedFiles,
    tests,
    metrics: {
      fileRecall,
      changedFileRecall,
      testRecall,
      precisionAtK,
      selectedToBaselineRatio,
      textChars: result.text.length,
      dataBytes: structuredDataBytes,
      refreshed,
      structuredBytes: structuredDataBytes,
      toolHopsToEditReady,
      verificationProvenancePresent
    },
    comparison: {
      baselineFileRecall,
      baselineTestRecall,
      baselinePrecisionAtK,
      fileRecallDelta: delta(fileRecall, baselineFileRecall),
      testRecallDelta: delta(testRecall, baselineTestRecall),
      precisionDelta: delta(precisionAtK, baselinePrecisionAtK),
      codexaFileCount: files.length,
      baselineFileCount: baselineFiles.length,
      codexaTestCount: tests.length,
      baselineTestCount: baselineTests.length,
      codexaToBaselineFileRatio
    },
    calibration: {
      falsePositiveFiles,
      missingExpectedFiles,
      missingExpectedChangedFiles,
      missingExpectedTests,
      heuristicHeavy,
      broadRetrievalFailure,
      rawRgBetter,
      rawRgBetterReason,
      overBudgetedOutput,
      overBudgetedStructuredData,
      postEditOutcome
    },
    failures,
    sample: redactSample ? "[redacted for external historical task pack]" : result.text.split(/\r?\n/).slice(0, 14).join("\n")
  };
}

export function calibrationSummary(scenarios: ScoredEvalScenario[]): EvalResult["data"]["calibrationSummary"] {
  const postEditVerdicts: Record<string, number> = {};
  const outcomeRecords: string[] = [];
  const postEditRequiredChecksMissingScenarios: string[] = [];
  for (const scenario of scenarios) {
    const verdict = scenario.calibration.postEditOutcome?.verdict;
    if (verdict) {
      postEditVerdicts[verdict] = (postEditVerdicts[verdict] ?? 0) + 1;
    }
    const outcomePath = scenario.calibration.postEditOutcome?.path;
    if (outcomePath) {
      outcomeRecords.push(outcomePath);
    }
    if ((scenario.calibration.postEditOutcome?.requiredChecksMissing ?? 0) > 0) {
      postEditRequiredChecksMissingScenarios.push(scenario.id);
    }
  }
  return {
    falsePositiveFiles: uniqueInOrder(scenarios.flatMap((scenario) => scenario.calibration.falsePositiveFiles)),
    missingExpectedChangedFiles: uniqueInOrder(scenarios.flatMap((scenario) => scenario.calibration.missingExpectedChangedFiles)),
    missingExpectedTests: uniqueInOrder(scenarios.flatMap((scenario) => scenario.calibration.missingExpectedTests)),
    heuristicHeavyScenarios: scenarios.filter((scenario) => scenario.calibration.heuristicHeavy).map((scenario) => scenario.id),
    broadRetrievalFailures: scenarios.filter((scenario) => scenario.calibration.broadRetrievalFailure).map((scenario) => scenario.id),
    rawRgBetterScenarios: scenarios.filter((scenario) => scenario.calibration.rawRgBetter).map((scenario) => scenario.id),
    overBudgetedOutputScenarios: scenarios.filter((scenario) => scenario.calibration.overBudgetedOutput).map((scenario) => scenario.id),
    overBudgetedStructuredDataScenarios: scenarios.filter((scenario) => scenario.calibration.overBudgetedStructuredData).map((scenario) => scenario.id),
    postEditMissedTests: uniqueInOrder(scenarios.flatMap((scenario) => scenario.calibration.postEditOutcome?.missedLikelyTests ?? [])),
    postEditModifiedPublicSymbols: uniqueInOrder(scenarios.flatMap((scenario) => scenario.calibration.postEditOutcome?.modifiedPublicSymbols ?? [])),
    postEditCalibrationLabels: uniqueInOrder(scenarios.flatMap((scenario) => scenario.calibration.postEditOutcome?.calibrationLabels ?? [])),
    postEditRequiredChecksMissingScenarios: uniqueInOrder(postEditRequiredChecksMissingScenarios),
    postEditAggregateCoverageScenarios: scenarios
      .filter((scenario) => {
        const outcome = scenario.calibration.postEditOutcome;
        return Boolean(outcome?.calibrationLabels.includes("aggregate-command-coverage") && (outcome.ranCommands.length > 0 || outcome.commandEnvelopes.length > 0));
      })
      .map((scenario) => scenario.id),
    postEditVerificationMissingScenarios: scenarios.filter((scenario) => (scenario.calibration.postEditOutcome?.verificationMissing ?? 0) > 0).map((scenario) => scenario.id),
    postEditVerdicts,
    outcomeRecords: uniqueInOrder(outcomeRecords)
  };
}

export function scoreStructuredOutputForTest(result: QueryResult, oracle: EvalOracle, baseline?: { command: string[]; output: string }): ScoredEvalScenario {
  return scoreScenario(
    {
      id: "test",
      suite: "synthetic",
      description: "test",
      repoRoot: "",
      codexa: async () => result,
      baselineCommand: baseline?.command,
      oracle
    },
    result,
    baseline ? [baseline] : null,
    true
  );
}

type EvalNestedDataKey = "diff" | "plan" | "focus" | "context" | "review" | "postEdit" | "post_edit" | "data";

type EvalScoringData = BaseQueryData & {
  actionability?: string;
  selectedFiles?: unknown[];
  readFirstFiles?: unknown[];
  files?: unknown[];
  fanout?: { readFirst?: unknown };
  affectedFiles?: unknown[];
  focusFiles?: unknown[];
  nextReads?: unknown[];
  changedFiles?: unknown[];
  plannedEditTargets?: unknown[];
  reviewTargets?: unknown[];
  snapshot?: { plannedEditTargets?: unknown[] };
  callTrace?: unknown[];
  tests?: unknown[];
  workflows?: unknown[];
  quality?: { level?: unknown; counts?: { authoritative?: unknown; derived?: unknown; heuristic?: unknown; fallback?: unknown } };
  outcome?: PostEditReviewData["outcome"];
  testsNotRun?: unknown;
  missedLikelyTests?: unknown;
  modifiedPublicSymbols?: unknown;
  workflowChecks?: unknown;
  dependencyChecks?: unknown;
  ranCommands?: unknown;
  commandEnvelopes?: unknown;
  verificationLedger?: unknown;
  verdict?: unknown;
  outcomeId?: unknown;
  path?: unknown;
  driftReasons?: unknown;
  calibrationLabels?: unknown;
  packetVerdict?: unknown;
  editReadiness?: { editable?: unknown };
} & Partial<Record<EvalNestedDataKey, unknown>>;

function evalScoringData(data: unknown): EvalScoringData | undefined {
  return data && typeof data === "object" && !Array.isArray(data) ? (data as EvalScoringData) : undefined;
}

export function filesFromData(data: unknown): string[] {
  const record = evalScoringData(data);
  if (!record) {
    return [];
  }
  if (Array.isArray(record.selectedFiles)) {
    return uniqueInOrder(record.selectedFiles.flatMap(filePathFromUnknown));
  }
  if (Array.isArray(record.readFirstFiles)) {
    return uniqueInOrder(record.readFirstFiles.flatMap(filePathFromUnknown));
  }
  if (Array.isArray(record.files)) {
    return uniqueInOrder(record.files.flatMap(filePathFromUnknown));
  }
  if (record.fanout && typeof record.fanout === "object") {
    const readFirst = record.fanout.readFirst;
    if (Array.isArray(readFirst)) {
      return uniqueInOrder(readFirst.flatMap((entry: unknown) => filePathFromUnknown((entry as Record<string, unknown>).file ?? entry)));
    }
  }
  if (Array.isArray(record.affectedFiles)) {
    return uniqueInOrder(record.affectedFiles.flatMap((entry) => filePathFromUnknown((entry as Record<string, unknown>).file ?? entry)));
  }
  if (Array.isArray(record.focusFiles)) {
    return uniqueInOrder(record.focusFiles.flatMap((entry) => filePathFromUnknown((entry as Record<string, unknown>).file ?? entry)));
  }
  if (Array.isArray(record.nextReads)) {
    return uniqueInOrder(record.nextReads.flatMap(filePathFromUnknown));
  }
  if (Array.isArray(record.changedFiles)) {
    return uniqueInOrder(record.changedFiles.flatMap(filePathFromUnknown));
  }
  const nested = (["diff", "plan"] as const).flatMap((key) => filesFromData(record[key]));
  return uniqueInOrder(nested);
}

function plannedFilesFromData(data: unknown): string[] {
  const record = evalScoringData(data);
  if (!record) {
    return [];
  }
  if (Array.isArray(record.plannedEditTargets)) {
    return uniqueInOrder(record.plannedEditTargets.flatMap(filePathFromUnknown));
  }
  if (record.snapshot && typeof record.snapshot === "object") {
    if (Array.isArray(record.snapshot.plannedEditTargets)) {
      return uniqueInOrder(record.snapshot.plannedEditTargets.flatMap(filePathFromUnknown));
    }
  }
  if (Array.isArray(record.reviewTargets)) {
    return uniqueInOrder(record.reviewTargets.flatMap(filePathFromUnknown));
  }
  const nested = (["focus", "context", "diff", "plan"] as const).flatMap((key) => plannedFilesFromData(record[key]));
  return uniqueInOrder(nested);
}

function callTraceFromData(data: unknown): string[] {
  const record = evalScoringData(data);
  if (!record) {
    return [];
  }
  if (Array.isArray(record.callTrace)) {
    return record.callTrace.filter((entry): entry is string => typeof entry === "string");
  }
  return [];
}

export function testsFromData(data: unknown): string[] {
  const record = evalScoringData(data);
  if (!record) {
    return [];
  }
  const direct = Array.isArray(record.tests)
    ? record.tests.flatMap((entry) => {
        if (typeof entry === "string") {
          return [entry];
        }
        if (entry && typeof entry === "object" && typeof (entry as TestRecommendation).path === "string") {
          return [(entry as TestRecommendation).path];
        }
        return [];
      })
    : [];
  const workflowTests = Array.isArray(record.workflows)
    ? record.workflows.flatMap((workflow) => {
        if (!workflow || typeof workflow !== "object") {
          return [];
        }
        const tests = (workflow as { tests?: unknown }).tests;
        return Array.isArray(tests) ? tests.filter((entry): entry is string => typeof entry === "string") : [];
      })
    : [];
  const nested = (["diff", "plan"] as const).flatMap((key) => testsFromData(record[key]));
  return uniqueInOrder([...direct, ...workflowTests, ...nested]);
}

function qualityFromData(data: unknown): { level: string; counts: { authoritative: number; derived: number; heuristic: number; fallback: number } } | null {
  const record = evalScoringData(data);
  if (!record) {
    return null;
  }
  const quality = record.quality;
  if (quality) {
    const counts = quality.counts ?? {};
    return {
      level: typeof quality.level === "string" ? quality.level : "unknown",
      counts: {
        authoritative: numericCount(counts.authoritative),
        derived: numericCount(counts.derived),
        heuristic: numericCount(counts.heuristic),
        fallback: numericCount(counts.fallback)
      }
    };
  }
  for (const key of ["focus", "context", "diff", "plan"] as const) {
    const nested = qualityFromData(record[key]);
    if (nested) {
      return nested;
    }
  }
  return null;
}

function postEditOutcomeFromData(data: unknown): ScoredEvalScenario["calibration"]["postEditOutcome"] {
  const record = evalScoringData(data);
  if (!record) {
    return undefined;
  }
  const candidate = evalScoringData(record.outcome) ?? record;
  const testsNotRun = extractPaths(candidate.testsNotRun ?? record.testsNotRun);
  const missedLikelyTests = extractPaths(candidate.missedLikelyTests ?? record.missedLikelyTests);
  const modifiedPublicSymbols = extractStringArray(candidate.modifiedPublicSymbols ?? record.modifiedPublicSymbols);
  const workflowChecks = extractArray(candidate.workflowChecks ?? record.workflowChecks);
  const dependencyChecks = extractArray(candidate.dependencyChecks ?? record.dependencyChecks);
  const requiredChecksMissing = [...workflowChecks, ...dependencyChecks].filter((entry) => entry && typeof entry === "object" && (entry as { status?: unknown }).status === "missing").length;
  const ranCommands = extractStringArray(candidate.ranCommands ?? record.ranCommands);
  const commandEnvelopes = extractCommandEnvelopes(candidate.commandEnvelopes ?? record.commandEnvelopes);
  const verificationProvenance = extractVerificationProvenance(candidate.verificationProvenance ?? record.verificationProvenance);
  const verificationLedger = extractArray(candidate.verificationLedger ?? record.verificationLedger);
  const verificationStatusCount = (status: string) =>
    verificationLedger.filter((entry) => entry && typeof entry === "object" && (entry as { status?: unknown }).status === status).length;
  if (
    candidate !== record ||
    testsNotRun.length > 0 ||
    missedLikelyTests.length > 0 ||
    modifiedPublicSymbols.length > 0 ||
    workflowChecks.length > 0 ||
    dependencyChecks.length > 0 ||
    ranCommands.length > 0 ||
    commandEnvelopes.length > 0 ||
    verificationProvenance ||
    verificationLedger.length > 0 ||
    typeof candidate.verdict === "string" ||
    typeof candidate.outcomeId === "string" ||
    typeof candidate.path === "string" ||
    Array.isArray(candidate.driftReasons) ||
    Array.isArray(candidate.calibrationLabels)
  ) {
    return {
      verdict: typeof candidate.verdict === "string" ? candidate.verdict : undefined,
      outcomeId: typeof candidate.outcomeId === "string" ? candidate.outcomeId : undefined,
      path: typeof candidate.path === "string" ? candidate.path : undefined,
      driftReasons: extractStringArray(candidate.driftReasons),
      calibrationLabels: extractStringArray(candidate.calibrationLabels),
      testsNotRun,
      missedLikelyTests,
      modifiedPublicSymbols,
      requiredChecksMissing,
      ranCommands,
      commandEnvelopes,
      verificationProvenance,
      verificationCovered: verificationStatusCount("covered"),
      verificationMissing: verificationStatusCount("missing"),
      verificationWaived: verificationStatusCount("waived"),
      verificationNotApplicable: verificationStatusCount("not_applicable")
    };
  }
  for (const key of ["review", "postEdit", "post_edit", "plan"] as const) {
    const nested = postEditOutcomeFromData(record[key]);
    if (nested) {
      return nested;
    }
  }
  return undefined;
}

function toolHopsToEditReadyFromData(data: unknown): number | null {
  const record = evalScoringData(data);
  if (!record) {
    return null;
  }
  const mode = typeof record.mode === "string" ? record.mode : undefined;
  const actionability = typeof record.actionability === "string" ? record.actionability : undefined;
  const editReady = actionability === "edit_ready" || record.packetVerdict === "edit-ready" || (record.editReadiness && typeof record.editReadiness === "object" && (record.editReadiness as { editable?: unknown }).editable === true);
  if (editReady) {
    if (mode === "session_context" || mode === "focus_brief") return 2;
    if (mode === "task_brief" || mode === "context_pack") return 1;
    return 0;
  }
  for (const key of ["focus", "context", "diff", "plan", "data"] as const) {
    const nested = toolHopsToEditReadyFromData(record[key]);
    if (nested !== null) {
      return nested;
    }
  }
  return null;
}

function verificationProvenanceFromData(data: unknown): EvalVerificationProvenance | undefined {
  const record = evalScoringData(data);
  if (!record) {
    return undefined;
  }
  return extractVerificationProvenance(record.verificationProvenance) ?? verificationProvenanceFromData(record.data);
}

function extractVerificationProvenance(value: unknown): EvalVerificationProvenance | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  return {
    schemaVersion: typeof record.schemaVersion === "number" ? record.schemaVersion : undefined,
    commandCoverageClassifier: typeof record.commandCoverageClassifier === "string" ? record.commandCoverageClassifier : undefined,
    commandCoverageClassifierVersion: typeof record.commandCoverageClassifierVersion === "string" ? record.commandCoverageClassifierVersion : undefined,
    commandEnvelopeRulesetVersion: typeof record.commandEnvelopeRulesetVersion === "string" ? record.commandEnvelopeRulesetVersion : undefined,
    verificationLedgerVersion: typeof record.verificationLedgerVersion === "string" ? record.verificationLedgerVersion : undefined
  };
}

function numericCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function filePathFromUnknown(value: unknown): string[] {
  if (typeof value === "string") {
    return [value];
  }
  if (value && typeof value === "object" && typeof (value as { path?: unknown }).path === "string") {
    return [(value as { path: string }).path];
  }
  return [];
}

function extractStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function extractPaths(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((entry) => {
    if (typeof entry === "string") {
      return [entry];
    }
    if (entry && typeof entry === "object" && typeof (entry as { path?: unknown }).path === "string") {
      return [(entry as { path: string }).path];
    }
    return [];
  });
}

function extractArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function extractCommandEnvelopes(value: unknown): Array<{
  command?: string;
  cwd?: string;
  packageManager?: string;
  workspace?: string;
  packageRoot?: string;
  packageName?: string;
  scriptName?: string;
  args: string[];
  exitCode?: number;
  durationMs?: number;
  source?: string;
  scopeStatus?: string;
  classifierVersion?: string;
}> {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === "object" && !Array.isArray(entry)))
    .map((entry) => ({
      command: typeof entry.command === "string" ? entry.command : undefined,
      cwd: typeof entry.cwd === "string" ? entry.cwd : undefined,
      packageManager: typeof entry.packageManager === "string" ? entry.packageManager : undefined,
      workspace: typeof entry.workspace === "string" ? entry.workspace : undefined,
      packageRoot: typeof entry.packageRoot === "string" ? entry.packageRoot : undefined,
      packageName: typeof entry.packageName === "string" ? entry.packageName : undefined,
      scriptName: typeof entry.scriptName === "string" ? entry.scriptName : undefined,
      args: extractStringArray(entry.args),
      exitCode: typeof entry.exitCode === "number" ? entry.exitCode : undefined,
      durationMs: typeof entry.durationMs === "number" ? entry.durationMs : undefined,
      source: typeof entry.source === "string" ? entry.source : undefined,
      scopeStatus: typeof entry.scopeStatus === "string" ? entry.scopeStatus : undefined,
      classifierVersion: typeof entry.classifierVersion === "string" ? entry.classifierVersion : undefined
    }));
}

function recall(actual: string[], expected: string[]): number {
  if (expected.length === 0) {
    return 1;
  }
  const actualSet = new Set(actual);
  return expected.filter((item) => actualSet.has(item)).length / expected.length;
}

function precision(actual: string[], expected: string[]): number {
  if (actual.length === 0) {
    return expected.length === 0 ? 1 : 0;
  }
  const expectedSet = new Set(expected);
  return actual.filter((item) => expectedSet.has(item)).length / actual.length;
}

function delta(current: number | null, baseline: number | null): number | null {
  if (current === null || baseline === null) {
    return null;
  }
  return current - baseline;
}

export function uniqueInOrder(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (!seen.has(value)) {
      seen.add(value);
      result.push(value);
    }
  }
  return result;
}

function serializedByteLength(value: unknown): number {
  try {
    const serialized = JSON.stringify(value);
    return serialized ? Buffer.byteLength(serialized, "utf8") : 0;
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

export function baselineFailureScenario(scenario: EvalScenario, error: unknown): ScoredEvalScenario {
  const message = error instanceof Error ? error.message : String(error);
  const redactPrivate = scenario.privatePack ?? false;
  return {
    id: scenario.id,
    suite: scenario.suite,
    description: redactPrivate ? `External historical task: ${scenario.id}` : scenario.description,
    passed: false,
    score: 0,
    scored: scenario.scored ?? true,
    baselineLines: null,
    baselineFiles: [],
    baselineTests: [],
    files: [],
    plannedFiles: [],
    tests: [],
    metrics: {
      fileRecall: null,
      changedFileRecall: null,
      testRecall: null,
      precisionAtK: null,
      selectedToBaselineRatio: null,
      textChars: 0,
      dataBytes: 0,
      refreshed: false,
      structuredBytes: 0,
      toolHopsToEditReady: null,
      verificationProvenancePresent: false
    },
    comparison: {
      baselineFileRecall: null,
      baselineTestRecall: null,
      baselinePrecisionAtK: null,
      fileRecallDelta: null,
      testRecallDelta: null,
      precisionDelta: null,
      codexaFileCount: 0,
      baselineFileCount: 0,
      codexaTestCount: 0,
      baselineTestCount: 0,
      codexaToBaselineFileRatio: null
    },
    calibration: {
      falsePositiveFiles: [],
      missingExpectedFiles: scenario.oracle.expectedFiles ?? [],
      missingExpectedChangedFiles: scenario.oracle.expectedChangedFiles ?? [],
      missingExpectedTests: scenario.oracle.expectedTests ?? [],
      heuristicHeavy: false,
      broadRetrievalFailure: false,
      rawRgBetter: false,
      overBudgetedOutput: false,
      overBudgetedStructuredData: false
    },
    failures: [
      redactPrivate
        ? "baseline command failed for external historical task pack: details redacted"
        : `baseline command failed: ${formatBaselineCommands(scenario)}; ${message}`
    ],
    sample: redactPrivate ? "[redacted for external historical task pack]" : ""
  };
}

function baselineFilesFromOutput(command: string[], output: string): string[] {
  if (command[0] === "git" && command.includes("status")) {
    return uniqueInOrder(
      output
        .split(/\r?\n/)
        .flatMap((line) => {
          const trimmed = line.trim();
          if (!trimmed) {
            return [];
          }
          const rawPath = trimmed.slice(2).trim();
          const renamed = rawPath.includes(" -> ") ? rawPath.split(" -> ").at(-1) ?? rawPath : rawPath;
          return [normalizeBaselinePath(renamed.replace(/^"|"$/g, ""))];
        })
        .filter(Boolean)
    );
  }
  return uniqueInOrder(
    output
      .split(/\r?\n/)
      .flatMap((line) => {
        const match = /^(.+?):\d+(?::|$)/.exec(line);
        return match?.[1] ? [normalizeBaselinePath(match[1])] : [];
      })
      .filter(Boolean)
  );
}

function normalizeBaselinePath(filePath: string): string {
  return filePath.replace(/^\.\//, "");
}
