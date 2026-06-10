import type { EvalResult } from "../eval.js";

export function renderEval(data: EvalResult["data"]): string {
  const qualityObservations = [
    ...data.calibrationSummary.rawRgBetterScenarios.map((id) => `- raw baseline better: ${id}`),
    ...(data.calibrationSummary.missingExpectedTests.length > 0 ? [`- missing expected tests: ${data.calibrationSummary.missingExpectedTests.join(", ")}`] : []),
    ...(data.calibrationSummary.missingExpectedChangedFiles.length > 0 ? [`- missing planned changed files: ${data.calibrationSummary.missingExpectedChangedFiles.join(", ")}`] : []),
    ...(data.calibrationSummary.heuristicHeavyScenarios.length > 0 ? [`- heuristic-heavy scenarios: ${data.calibrationSummary.heuristicHeavyScenarios.join(", ")}`] : []),
    ...(data.calibrationSummary.overBudgetedOutputScenarios.length > 0 ? [`- over-budgeted output: ${data.calibrationSummary.overBudgetedOutputScenarios.join(", ")}`] : []),
    ...(data.calibrationSummary.overBudgetedStructuredDataScenarios.length > 0 ? [`- over-budgeted structured data: ${data.calibrationSummary.overBudgetedStructuredDataScenarios.join(", ")}`] : []),
    ...(data.calibrationSummary.postEditMissedTests.length > 0 ? [`- post-edit missed tests: ${data.calibrationSummary.postEditMissedTests.join(", ")}`] : []),
    ...(data.calibrationSummary.postEditRequiredChecksMissingScenarios.length > 0 ? [`- post-edit missing required checks: ${data.calibrationSummary.postEditRequiredChecksMissingScenarios.join(", ")}`] : []),
    ...(data.calibrationSummary.postEditAggregateCoverageScenarios.length > 0 ? [`- post-edit aggregate command coverage: ${data.calibrationSummary.postEditAggregateCoverageScenarios.join(", ")}`] : []),
    ...(data.calibrationSummary.postEditVerificationMissingScenarios.length > 0 ? [`- post-edit verification still missing: ${data.calibrationSummary.postEditVerificationMissingScenarios.join(", ")}`] : []),
    ...(data.calibrationSummary.postEditCalibrationLabels.length > 0 ? [`- post-edit labels: ${data.calibrationSummary.postEditCalibrationLabels.join(", ")}`] : [])
  ];
  const lines = [
    "Codexa eval benchmark",
    `Suite: ${data.suite}`,
    `Seed: ${data.seed}`,
    `Pass: ${data.passed ? "yes" : "no"}`,
    `Score: ${data.score.toFixed(3)}`,
    "",
    "Anti-cheat controls:",
    ...data.antiCheat.map((item) => `- ${item}`),
    "",
	    "Codexa quality observations:",
	    ...(qualityObservations.length > 0 ? qualityObservations : ["- none"]),
	    data.centralityExperiment ? "" : undefined,
	    data.centralityExperiment ? "Transitive centrality experiment:" : undefined,
	    data.centralityExperiment ? `- overlap with current top 10: ${data.centralityExperiment.overlapWithCurrentTop10}/10` : undefined,
	    ...(data.centralityExperiment?.topFiles.slice(0, 8).map((entry) => `- ${entry.path}: centrality ${entry.score.toFixed(4)}, current rank ${entry.currentRank.toFixed(2)}`) ?? []),
	    ""
	  ];
  for (const scenario of data.scenarios) {
    lines.push(
      `Scenario: ${scenario.id}`,
      `- suite: ${scenario.suite}`,
      `- pass: ${scenario.passed ? "yes" : "no"}`,
      `- score: ${scenario.scored ? scenario.score.toFixed(3) : "smoke"}`,
      `- baseline lines: ${scenario.baselineLines ?? "n/a"}`,
      `- file recall: ${formatMetric(scenario.metrics.fileRecall)}, changed-file recall: ${formatMetric(scenario.metrics.changedFileRecall)}, test recall: ${formatMetric(scenario.metrics.testRecall)}, precision@k: ${formatMetric(scenario.metrics.precisionAtK)}, selected/baseline: ${formatMetric(scenario.metrics.selectedToBaselineRatio)}`,
      `- text chars: ${scenario.metrics.textChars}, data bytes: ${scenario.metrics.dataBytes}, refreshed: ${scenario.metrics.refreshed ? "yes" : "no"}`,
      `- without Codexa: files ${scenario.comparison.baselineFileCount}, tests ${scenario.comparison.baselineTestCount}, file recall ${formatMetric(scenario.comparison.baselineFileRecall)}, test recall ${formatMetric(scenario.comparison.baselineTestRecall)}, precision@k ${formatMetric(scenario.comparison.baselinePrecisionAtK)}`,
      `- Codexa delta: file recall ${formatDelta(scenario.comparison.fileRecallDelta)}, test recall ${formatDelta(scenario.comparison.testRecallDelta)}, precision@k ${formatDelta(scenario.comparison.precisionDelta)}, file count ratio ${formatMetric(scenario.comparison.codexaToBaselineFileRatio)}`,
      `- calibration: false positives ${scenario.calibration.falsePositiveFiles.length}, missing files ${scenario.calibration.missingExpectedFiles.length}, missing tests ${scenario.calibration.missingExpectedTests.length}, heuristic-heavy ${scenario.calibration.heuristicHeavy ? "yes" : "no"}, raw rg better ${scenario.calibration.rawRgBetter ? "yes" : "no"}, over text budget ${scenario.calibration.overBudgetedOutput ? "yes" : "no"}, over data budget ${scenario.calibration.overBudgetedStructuredData ? "yes" : "no"}`,
      ...(scenario.calibration.rawRgBetterReason ? [`- raw rg better reason: ${scenario.calibration.rawRgBetterReason}`] : []),
      ...(scenario.failures.length > 0 ? [`- failures: ${scenario.failures.join("; ")}`] : []),
      "- selected files:",
      ...scenario.files.slice(0, 10).map((file) => `  - ${file}`),
      "- planned changed files:",
      ...(scenario.plannedFiles.length > 0 ? scenario.plannedFiles.slice(0, 10).map((file) => `  - ${file}`) : ["  - none"]),
      "- baseline files:",
      ...(scenario.baselineFiles.length > 0 ? scenario.baselineFiles.slice(0, 10).map((file) => `  - ${file}`) : ["  - none"]),
      "- selected tests:",
      ...(scenario.tests.length > 0 ? scenario.tests.slice(0, 10).map((file) => `  - ${file}`) : ["  - none"]),
      "- codexa sample:",
      indent(scenario.sample),
      ""
    );
  }
  return lines.join("\n");
}

function formatMetric(value: number | null): string {
  return value === null ? "n/a" : value.toFixed(2);
}

function formatDelta(value: number | null): string {
  if (value === null) {
    return "n/a";
  }
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}`;
}

function indent(value: string): string {
  return value
    .split(/\r?\n/)
    .map((line) => `  ${line}`)
    .join("\n");
}
