import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildIndex } from "./indexer.js";
import { isTestPath } from "./language.js";
import { MCP_TOOL_CATALOG } from "./mcp-tool-catalog.js";
import { changePlanQuery, contextPackQuery, diffImpactQuery, focusBriefQuery, impactQuery, postEditReviewQuery, searchQuery, taskBriefQuery, testPlanQuery, workflowPathQuery } from "./queries.js";
import type { QueryOptions, QueryResult, TestRecommendation } from "./types.js";
import { externalHistoricalTaskPackScenarios, historicalFixtureScenarios } from "./eval/historical.js";
import type { EvalOracle, EvalScenario, EvalSuite } from "./eval/types.js";
export type { EvalOracle, EvalScenario, EvalScenarioSuite, EvalSuite } from "./eval/types.js";

interface EvalVerificationProvenance {
  schemaVersion?: number;
  commandCoverageClassifier?: string;
  commandCoverageClassifierVersion?: string;
  commandEnvelopeRulesetVersion?: string;
  verificationLedgerVersion?: string;
}

export interface ScoredEvalScenario {
  id: string;
  suite: string;
  description: string;
  passed: boolean;
  score: number;
  scored: boolean;
  baselineLines: number | null;
  baselineFiles: string[];
  baselineTests: string[];
  files: string[];
  plannedFiles: string[];
  tests: string[];
  metrics: {
    fileRecall: number | null;
    changedFileRecall: number | null;
    testRecall: number | null;
    precisionAtK: number | null;
    selectedToBaselineRatio: number | null;
    textChars: number;
    dataBytes: number;
    refreshed: boolean;
    structuredBytes: number;
    toolHopsToEditReady: number | null;
    verificationProvenancePresent: boolean;
  };
  comparison: {
    baselineFileRecall: number | null;
    baselineTestRecall: number | null;
    baselinePrecisionAtK: number | null;
    fileRecallDelta: number | null;
    testRecallDelta: number | null;
    precisionDelta: number | null;
    codexaFileCount: number;
    baselineFileCount: number;
    codexaTestCount: number;
    baselineTestCount: number;
    codexaToBaselineFileRatio: number | null;
  };
  calibration: {
    falsePositiveFiles: string[];
    missingExpectedFiles: string[];
    missingExpectedChangedFiles: string[];
    missingExpectedTests: string[];
    heuristicHeavy: boolean;
    broadRetrievalFailure: boolean;
    rawRgBetter: boolean;
    rawRgBetterReason?: string;
    overBudgetedOutput: boolean;
    overBudgetedStructuredData: boolean;
    postEditOutcome?: {
      verdict?: string;
      outcomeId?: string;
      path?: string;
      driftReasons: string[];
      calibrationLabels: string[];
      testsNotRun: string[];
      missedLikelyTests: string[];
      modifiedPublicSymbols: string[];
      requiredChecksMissing: number;
      ranCommands: string[];
      commandEnvelopes: Array<{
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
      }>;
      verificationProvenance?: EvalVerificationProvenance;
      verificationCovered: number;
      verificationMissing: number;
      verificationWaived: number;
      verificationNotApplicable: number;
    };
  };
  failures: string[];
  sample: string;
}

export interface EvalOptions {
  suite?: EvalSuite;
  seed?: string;
  json?: boolean;
  failOnRefresh?: boolean;
  taskPackPath?: string;
  centralityExperiment?: boolean;
}

const DEFAULT_SEED = "codexa-v1-benchmark";

export interface EvalResult {
  passed: boolean;
  text: string;
  data: {
    seed: string;
    suite: EvalSuite;
    passed: boolean;
    score: number;
    antiCheat: string[];
    calibrationSummary: {
      falsePositiveFiles: string[];
      missingExpectedChangedFiles: string[];
      missingExpectedTests: string[];
      heuristicHeavyScenarios: string[];
      broadRetrievalFailures: string[];
      rawRgBetterScenarios: string[];
      overBudgetedOutputScenarios: string[];
      overBudgetedStructuredDataScenarios: string[];
      postEditMissedTests: string[];
      postEditModifiedPublicSymbols: string[];
      postEditCalibrationLabels: string[];
      postEditRequiredChecksMissingScenarios: string[];
      postEditAggregateCoverageScenarios: string[];
      postEditVerificationMissingScenarios: string[];
      postEditVerdicts: Record<string, number>;
      outcomeRecords: string[];
    };
	    scenarios: ScoredEvalScenario[];
	    centralityExperiment?: {
	      enabled: boolean;
	      topFiles: Array<{ path: string; score: number; currentRank: number }>;
	      overlapWithCurrentTop10: number;
	      note: string;
	    };
	  };
	}

export async function runEval(
  repoRoot: string,
  options: QueryOptions = { autoRefresh: false },
  evalOptions: EvalOptions = {}
): Promise<EvalResult> {
  const repo = path.resolve(repoRoot);
  const seed = evalOptions.seed ?? `${DEFAULT_SEED}-${randomUUID()}`;
  const suite = evalOptions.suite ?? "all";
  const failOnRefresh = evalOptions.failOnRefresh ?? true;
  if (suite === "task-pack" && !evalOptions.taskPackPath) {
    throw new Error("codexa eval --suite task-pack requires --task-pack <path>");
  }
  const scenarios = [
    ...(suite === "all" || suite === "project" ? projectScenarios(repo, options) : []),
    ...(suite === "all" || suite === "synthetic" ? await syntheticScenarios(seed) : []),
    ...(suite === "all" || suite === "historical-fixture" ? await historicalFixtureScenarios(seed, options) : []),
    ...(evalOptions.taskPackPath ? await externalHistoricalTaskPackScenarios(repo, options, evalOptions.taskPackPath) : [])
  ];
  const antiCheat = [
    "Scores use structured QueryResult.data, not human-readable prose substrings.",
    "Synthetic scenarios use seed-generated identifiers and decoy files.",
    "Historical fixtures use generated repositories or explicit task packs rather than private project strings.",
    "Patch-task scenarios score read-first files, targeted tests, and false-positive cost without applying hardcoded edits.",
    "Benchmark scenarios run with auto-refresh disabled unless explicitly requested.",
    "Refresh is scored separately and fails the benchmark when failOnRefresh is enabled."
  ];

  const scored: ScoredEvalScenario[] = [];
  try {
    for (const scenario of scenarios) {
      let baseline: BaselineRun[] | null = null;
      try {
        baseline = runScenarioBaselines(scenario);
      } catch (error) {
        scored.push(baselineFailureScenario(scenario, error));
        continue;
      }
      const result = await scenario.codexa();
      scored.push(scoreScenario(scenario, result, baseline, failOnRefresh, scenario.privatePack ?? false));
    }
  } finally {
    await cleanupScenarioRepos(scenarios);
  }

  const passed = scored.every((scenario) => scenario.passed);
  const scoredOnly = scored.filter((scenario) => scenario.scored);
  const score = scoredOnly.length > 0 ? scoredOnly.reduce((sum, scenario) => sum + scenario.score, 0) / scoredOnly.length : 0;
  const centralityExperiment = evalOptions.centralityExperiment ? await runTransitiveCentralityExperiment(repo) : undefined;
  const data = { seed, suite, passed, score, antiCheat, calibrationSummary: calibrationSummary(scored), scenarios: scored, centralityExperiment };
  await saveEvalData(repo, seed, data);
  return {
    passed,
    data,
    text: evalOptions.json ? `${JSON.stringify(data, null, 2)}\n` : renderEval(data)
  };
}

function projectScenarios(repo: string, options: QueryOptions): EvalScenario[] {
  const queryOptions = { autoRefresh: options.autoRefresh ?? false };
  const scenarios: EvalScenario[] = [];

  scenarios.push({
    id: "project-dirty-context-pack",
    suite: "project",
    description: "Current repository dirty tree should produce bounded grouped context, not a raw git-status dump.",
    repoRoot: repo,
    baselineCommand: ["git", "status", "--short"],
    codexa: async () =>
      contextPackQuery(
        repo,
        {
          task: "Understand the current dirty repository diff and choose focused verification.",
          diff: true,
          tokenBudget: 2500,
          limit: 10
        },
        queryOptions
      ),
    oracle: {
      maxTextChars: 2500 * 4 + 80,
      maxSelectedToBaselineRatio: 0.35
    }
  });

  if (fileExists(path.join(repo, "web/src/components/ui/button.tsx"))) {
    scenarios.push({
      id: "project-ts-alias-component-impact",
      suite: "project",
      description: "TypeScript alias imports should resolve to the component file.",
      repoRoot: repo,
      baselineCommand: ["rg", "-n", "@/components/ui/button", "web/src"],
      codexa: async () => impactQuery(repo, { file: "web/src/components/ui/button.tsx" }, queryOptions),
      oracle: {
        expectedFiles: ["web/src/components/ui/button.tsx"],
        minFileRecall: 1,
        minFilePrecisionAtK: 0.2,
        maxSelectedToBaselineRatio: 1.1
      }
    });
  }

  scenarios.push({
    id: "project-diff-test-plan",
    suite: "project",
    description: "Current dirty diff test plan should expose grouped changes and test candidates.",
    repoRoot: repo,
    baselineCommand: ["git", "status", "--short"],
    codexa: async () => {
      const diff = await diffImpactQuery(repo, queryOptions);
      const plan = await testPlanQuery(repo, true, queryOptions);
      return {
        freshness: plan.freshness,
        refresh: plan.refresh,
        text: `${diff.text}\n${plan.text}`,
        data: {
          diff: compactEvalQueryData(diff.data),
          plan: compactEvalQueryData(plan.data),
          tests: testsFromData(plan.data),
          files: filesFromData(diff.data)
        }
      };
    },
    oracle: {
      maxTextChars: 12000
    }
  });

  scenarios.push(...historicalProjectScenarios(repo, queryOptions));
  return scenarios;
}

function compactEvalQueryData(data: unknown): unknown {
  if (!data || typeof data !== "object") {
    return data;
  }
  const record = data as Record<string, unknown>;
  return {
    changedFiles: Array.isArray(record.changedFiles) ? record.changedFiles.slice(0, 120) : undefined,
    selectedFiles: Array.isArray(record.selectedFiles) ? record.selectedFiles.slice(0, 60) : undefined,
    readFirstFiles: Array.isArray(record.readFirstFiles) ? record.readFirstFiles.slice(0, 60) : undefined,
    focusFiles: Array.isArray(record.focusFiles) ? record.focusFiles.slice(0, 30) : undefined,
    groups: Array.isArray(record.groups) ? record.groups.slice(0, 12) : undefined,
    tests: Array.isArray(record.tests) ? record.tests.slice(0, 30) : undefined,
    verificationCommands: Array.isArray(record.verificationCommands) ? record.verificationCommands.slice(0, 30) : undefined,
    verificationCommandPlan: Array.isArray(record.verificationCommandPlan) ? record.verificationCommandPlan.slice(0, 30) : undefined,
    verificationLedgerPreview: Array.isArray(record.verificationLedgerPreview) ? record.verificationLedgerPreview.slice(0, 40) : undefined,
    gaps: record.gaps,
    quality: record.quality,
    value: record.value,
    packetVerdict: record.packetVerdict
  };
}

function historicalProjectScenarios(repo: string, queryOptions: QueryOptions): EvalScenario[] {
  const reportPath = [path.join(repo, "reports/evaluations/historical-tasks.json"), path.join(repo, "reports/evaluations/historical-project-tasks.json")].find((candidate) => existsSync(candidate));
  if (!reportPath) {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(reportPath, "utf8"));
  } catch {
    return [];
  }
  const entries = Array.isArray(parsed) ? parsed : Array.isArray((parsed as { scenarios?: unknown }).scenarios) ? (parsed as { scenarios: unknown[] }).scenarios : [];
  return entries.flatMap((entry) => historicalScenarioFromEntry(repo, queryOptions, entry));
}

function historicalScenarioFromEntry(repo: string, queryOptions: QueryOptions, entry: unknown): EvalScenario[] {
  if (!entry || typeof entry !== "object") {
    return [];
  }
  const record = entry as Record<string, unknown>;
  const id = typeof record.id === "string" ? record.id : undefined;
  const description = typeof record.description === "string" ? record.description : id;
  const query = typeof record.query === "string" ? record.query : description;
  const tool = typeof record.tool === "string" ? record.tool : "task_brief";
  if (!id || !description || !query) {
    return [];
  }
  const files = Array.isArray(record.files) ? record.files.filter((value): value is string => typeof value === "string") : undefined;
  const symbols = Array.isArray(record.symbols) ? record.symbols.filter((value): value is string => typeof value === "string") : undefined;
  const expectedFiles = Array.isArray(record.expectedFiles) ? record.expectedFiles.filter((value): value is string => typeof value === "string") : undefined;
  const expectedTests = Array.isArray(record.expectedTests) ? record.expectedTests.filter((value): value is string => typeof value === "string") : undefined;
  const baselineCommand = Array.isArray(record.baselineCommand) ? record.baselineCommand.filter((value): value is string => typeof value === "string") : undefined;
  const baselineCommands = Array.isArray(record.baselineCommands)
    ? record.baselineCommands.filter((value): value is string[] => Array.isArray(value) && value.every((entry) => typeof entry === "string"))
    : undefined;
  return [
    {
      id: `historical-${id}`,
      suite: "project",
      description,
      repoRoot: repo,
      baselineCommand,
      baselineCommands,
      codexa: async () => {
        const multiTarget = (files?.length ?? 0) + (symbols?.length ?? 0) > 1;
        if (multiTarget && (tool === "impact" || tool === "workflow_path")) {
          return contextPackQuery(repo, { task: query, files, symbols, diff: false, tokenBudget: 2200, limit: 10 }, queryOptions);
        }
        if (tool === "impact") {
          return impactQuery(repo, { file: files?.[0], symbol: symbols?.[0], changeType: "behavior" }, queryOptions);
        }
        if (tool === "workflow_path") {
          return workflowPathQuery(repo, { query, file: files?.[0], symbol: symbols?.[0], limit: 10 }, queryOptions);
        }
        if (tool === "context_pack") {
          return contextPackQuery(repo, { task: query, files, symbols, diff: false, tokenBudget: 2200, limit: 10 }, queryOptions);
        }
        if (tool === "change_plan") {
          return changePlanQuery(repo, { task: query, files, symbols, diff: false, tokenBudget: 2200, limit: 10 }, queryOptions);
        }
        return taskBriefQuery(repo, { task: query, files, symbols, diff: false, tokenBudget: 2200, limit: 10 }, queryOptions);
      },
      oracle: {
        expectedFiles,
        expectedTests,
        minFileRecall: expectedFiles?.length ? 0.5 : undefined,
        minTestRecall: expectedTests?.length ? 0.5 : undefined,
        minFilePrecisionAtK: expectedFiles?.length ? 0.2 : undefined,
        maxSelectedToBaselineRatio: 1
      }
    }
  ];
}

async function syntheticScenarios(seed: string): Promise<EvalScenario[]> {
  const fixture = await createSyntheticRepo(seed);
  const queryOptions = { autoRefresh: false };
  const scenarios: EvalScenario[] = [
    {
      id: "synthetic-search-exact-raw-sufficient",
      suite: "synthetic",
      description: "Exact randomized search should admit when raw search is already sufficient while still returning structured targets.",
      repoRoot: fixture.repoRoot,
      baselineCommand: ["rg", "-n", fixture.shared.uniqueLiteral, "."],
      codexa: async () => searchQuery(fixture.repoRoot, { query: fixture.shared.uniqueLiteral, limit: 8 }, queryOptions),
      oracle: {
        expectedFiles: [fixture.shared.leafPath],
        topFiles: [fixture.shared.leafPath],
        minFileRecall: 1,
        minFilePrecisionAtK: 1,
        maxSelectedToBaselineRatio: 1
      }
    },
    {
      id: "synthetic-shared-style-fanout",
      suite: "synthetic",
      description: "Style-shaped shared-module impact should collapse repeated consumers and keep tests/read-first small.",
      repoRoot: fixture.repoRoot,
      baselineCommand: ["rg", "-n", fixture.shared.exportedSymbol, "."],
      codexa: async () => impactQuery(fixture.repoRoot, { file: fixture.shared.sharedPath, changeType: "style", depth: 2 }, queryOptions),
      oracle: {
        expectedFiles: [fixture.shared.sharedPath, fixture.shared.testPath],
        expectedTests: [fixture.shared.testPath],
        topFiles: [fixture.shared.sharedPath],
        minFileRecall: 1,
        minTestRecall: 1,
        minFilePrecisionAtK: 0.5,
        maxSelectedToBaselineRatio: 0.8
      }
    },
    {
      id: "synthetic-shared-api-fanout",
      suite: "synthetic",
      description: "API-shaped shared-module impact should preserve broader importer and test coverage.",
      repoRoot: fixture.repoRoot,
      baselineCommand: ["rg", "-n", fixture.shared.exportedSymbol, "."],
      codexa: async () => impactQuery(fixture.repoRoot, { file: fixture.shared.sharedPath, changeType: "api", depth: 2 }, queryOptions),
      oracle: {
        expectedFiles: [fixture.shared.sharedPath, fixture.shared.consumerPath, fixture.shared.secondConsumerPath, fixture.shared.testPath],
        expectedTests: [fixture.shared.testPath],
        forbiddenFiles: [fixture.shared.decoyPath],
        topFiles: [fixture.shared.sharedPath],
        minFileRecall: 0.75,
        minTestRecall: 1,
        minFilePrecisionAtK: 0.5,
        maxSelectedToBaselineRatio: 1
      }
    },
    {
      id: "synthetic-task-brief-impact-expansion",
      suite: "synthetic",
      description: "Task brief should include bounded impact consumers and covering tests from a requested source file.",
      repoRoot: fixture.repoRoot,
      baselineCommand: ["rg", "-n", fixture.shared.exportedSymbol, "."],
      codexa: async () =>
        taskBriefQuery(
          fixture.repoRoot,
          {
            task: `Change ${fixture.shared.exportedSymbol} without missing callers`,
            files: [fixture.shared.sharedPath],
            changeType: "api",
            diff: false,
            tokenBudget: 1400,
            limit: 7
          },
          queryOptions
        ),
      oracle: {
        expectedFiles: [fixture.shared.sharedPath, fixture.shared.consumerPath, fixture.shared.secondConsumerPath, fixture.shared.testPath],
        expectedTests: [fixture.shared.testPath],
        topFiles: [fixture.shared.sharedPath],
        minFileRecall: 0.75,
        minTestRecall: 1,
        minFilePrecisionAtK: 0.5,
        maxSelectedToBaselineRatio: 1
      }
    },
    {
      id: "synthetic-ts-impact-decoy-control",
      suite: "synthetic",
      description: "Randomized TypeScript impact should include true dependents and exclude similarly named decoys.",
      repoRoot: fixture.repoRoot,
      baselineCommand: ["rg", "-n", fixture.ts.helperSymbol, "."],
      codexa: async () => impactQuery(fixture.repoRoot, { file: fixture.ts.helperPath }, queryOptions),
      oracle: {
        expectedFiles: [fixture.ts.helperPath, fixture.ts.featurePath, fixture.ts.testPath],
        expectedTests: [fixture.ts.testPath],
        forbiddenFiles: [fixture.ts.decoyPath],
        topFiles: [fixture.ts.helperPath],
        minFileRecall: 0.66,
        minTestRecall: 1,
        minFilePrecisionAtK: 0.5,
        maxSelectedToBaselineRatio: 0.75
      }
    },
    {
      id: "synthetic-python-impact-decoy-control",
      suite: "synthetic",
      description: "Randomized Python helper impact should include importer and pytest file without fabricated commands.",
      repoRoot: fixture.repoRoot,
      baselineCommand: ["rg", "-n", fixture.python.helperSymbol, "."],
      codexa: async () => impactQuery(fixture.repoRoot, { file: fixture.python.helperPath }, queryOptions),
      oracle: {
        expectedFiles: [fixture.python.helperPath, fixture.python.appPath, fixture.python.testPath],
        expectedTests: [fixture.python.testPath],
        forbiddenFiles: [fixture.python.decoyPath],
        topFiles: [fixture.python.helperPath],
        minFileRecall: 0.66,
        minTestRecall: 1,
        minFilePrecisionAtK: 0.5,
        maxSelectedToBaselineRatio: 0.75
      }
    },
    {
      id: "synthetic-manifest-impact",
      suite: "synthetic",
      description: "Randomized node manifest should link node id references without hardcoded project names.",
      repoRoot: fixture.repoRoot,
      baselineCommand: ["rg", "-n", fixture.manifest.typeId, "."],
      codexa: async () => impactQuery(fixture.repoRoot, { file: fixture.manifest.path }, queryOptions),
      oracle: {
        expectedFiles: [fixture.manifest.path, fixture.manifest.webReferencePath],
        forbiddenFiles: [fixture.manifest.decoyPath],
        minFileRecall: 0.5,
        minFilePrecisionAtK: 0.4,
        maxSelectedToBaselineRatio: 1
      }
    },
    {
      id: "synthetic-dirty-diff-context-pack",
      suite: "synthetic",
      description: "Dirty diff context should report stale/gap state and still select focused changed context.",
      repoRoot: fixture.repoRoot,
      baselineCommand: ["git", "status", "--short"],
      codexa: async () =>
        contextPackQuery(
          fixture.repoRoot,
          {
            task: `Safely change ${fixture.python.helperSymbol}`,
            files: [fixture.python.helperPath],
            query: fixture.python.helperSymbol,
            diff: true,
            tokenBudget: 1200,
            limit: 6
          },
          queryOptions
        ),
      oracle: {
        expectedFiles: [fixture.python.helperPath, fixture.python.appPath],
        expectedTests: [fixture.python.testPath],
        maxTextChars: 1200 * 4 + 80,
        minFileRecall: 0.5,
        minTestRecall: 1,
        minFilePrecisionAtK: 0.4,
        maxSelectedToBaselineRatio: 2
      }
    },
    {
      id: "synthetic-broad-focus-brief",
      suite: "synthetic",
      description: "Natural-language broad task should identify a workflow subsystem without explicit file seeds.",
      repoRoot: fixture.repoRoot,
      baselineCommand: ["rg", "-n", "workflow route adapter queue polling", "."],
      codexa: async () =>
        focusBriefQuery(
          fixture.repoRoot,
          {
            task: `How does the ${fixture.python.helperSymbol} route workflow behave and what should be tested?`,
            diff: false,
            tokenBudget: 1400,
            limit: 8
          },
          queryOptions
        ),
      oracle: {
        expectedFiles: [fixture.python.appPath, fixture.python.helperPath],
        expectedTests: [fixture.python.testPath],
        forbiddenFiles: [fixture.python.decoyPath],
        minFileRecall: 0.66,
        minTestRecall: 1,
        minFilePrecisionAtK: 0.4,
        maxSelectedToBaselineRatio: 3
      }
    },
    {
      id: "synthetic-session-context-seedless",
      suite: "synthetic",
      description: "Seedless session-context style focus should run without refresh and expose fallback quality instead of pretending evidence.",
      repoRoot: fixture.repoRoot,
      scored: false,
      codexa: async () =>
        focusBriefQuery(
          fixture.repoRoot,
          {
            task: "narlple frondicate zindle",
            diff: false,
            tokenBudget: 900,
            limit: 4
          },
          queryOptions
        ),
      oracle: {
        maxTextChars: 900 * 4 + 80
      }
    },
    {
      id: "synthetic-patch-task-change-plan",
      suite: "synthetic",
      description: "Patch-task change plan should select enough context, tests, and verification hints to avoid blind shared-helper edits.",
      repoRoot: fixture.repoRoot,
      baselineCommand: ["rg", "-n", fixture.shared.exportedSymbol, "."],
      codexa: async () =>
        changePlanQuery(
          fixture.repoRoot,
          {
            task: `Refactor ${fixture.shared.exportedSymbol} API without breaking callers`,
            files: [fixture.shared.sharedPath],
            changeType: "api",
            diff: false,
            tokenBudget: 1800,
            limit: 8
          },
          queryOptions
        ),
      oracle: {
        expectedFiles: [fixture.shared.sharedPath, fixture.shared.consumerPath, fixture.shared.secondConsumerPath, fixture.shared.testPath],
        expectedTests: [fixture.shared.testPath],
        forbiddenFiles: [fixture.shared.decoyPath],
        topFiles: [fixture.shared.sharedPath],
        minFileRecall: 0.75,
        minTestRecall: 1,
        minFilePrecisionAtK: 0.5,
        maxSelectedToBaselineRatio: 1
      }
    },
    {
      id: "synthetic-patch-task-post-edit-review",
      suite: "synthetic",
      description: "Post-edit review should compare an actual edit against the saved task snapshot and keep tests/consumers visible.",
      repoRoot: fixture.repoRoot,
      baselineCommand: ["rg", "-n", fixture.shared.exportedSymbol, "."],
      codexa: async () => {
        await changePlanQuery(
          fixture.repoRoot,
          {
            task: `Refactor ${fixture.shared.exportedSymbol} API without breaking callers`,
            files: [fixture.shared.sharedPath],
            changeType: "api",
            diff: false,
            tokenBudget: 1600,
            limit: 7,
            saveSnapshot: true,
            taskId: "eval-post-edit-shared"
          },
          queryOptions
        );
        await writeFile(
          path.join(fixture.repoRoot, fixture.shared.sharedPath),
          `export function ${fixture.shared.exportedSymbol}(value: string) {\n  return value.trim().toUpperCase()\n}\n`,
          "utf8"
        );
        return postEditReviewQuery(
          fixture.repoRoot,
          {
            taskId: "eval-post-edit-shared",
            ranCommands: ["npm run check"],
            tokenBudget: 1600,
            limit: 7
          },
          queryOptions
        );
      },
      oracle: {
        expectedFiles: [fixture.shared.sharedPath, fixture.shared.consumerPath, fixture.shared.secondConsumerPath, fixture.shared.testPath],
        expectedTests: [fixture.shared.testPath],
        forbiddenFiles: [fixture.shared.decoyPath],
        topFiles: [fixture.shared.sharedPath],
        minFileRecall: 0.75,
        minTestRecall: 1,
        minFilePrecisionAtK: 0.5,
        maxSelectedToBaselineRatio: 1
      }
    }
  ];
  return scenarios.map((scenario) => ({ cleanupRepoRoot: fixture.repoRoot, ...scenario }));
}

interface BaselineRun {
  command: string[];
  output: string;
}

function scoreScenario(scenario: EvalScenario, result: QueryResult, baseline: BaselineRun[] | null, failOnRefresh: boolean, redactSample = false): ScoredEvalScenario {
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
  if (
    scenario.oracle.maxSelectedToBaselineRatio !== undefined &&
    selectedToBaselineRatio !== null &&
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

async function saveEvalData(repoRoot: string, seed: string, data: EvalResult["data"]): Promise<void> {
  const dir = path.join(repoRoot, ".codex/cache/codexa-evals");
  await mkdir(dir, { recursive: true });
  const safeSeed = seed.replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 160) || "eval";
  const filePath = path.join(dir, `${safeSeed}.json`);
  await atomicJsonWrite(filePath, data);
  await atomicJsonWrite(path.join(dir, "latest.json"), {
    schemaVersion: 1,
    seed: data.seed,
    suite: data.suite,
    passed: data.passed,
    score: data.score,
    path: path.basename(filePath),
    repoRoot,
    headCommit: gitHeadCommit(repoRoot),
    mcpCatalogTools: MCP_TOOL_CATALOG.map((tool) => tool.name),
    createdAt: new Date().toISOString()
  });
}

function gitHeadCommit(repoRoot: string): string | null {
  try {
    return execFileSync("git", ["-C", repoRoot, "rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
  } catch {
    return null;
  }
}

async function atomicJsonWrite(filePath: string, value: unknown): Promise<void> {
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(tmp, filePath);
}

function calibrationSummary(scenarios: ScoredEvalScenario[]): EvalResult["data"]["calibrationSummary"] {
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

async function runTransitiveCentralityExperiment(repoRoot: string): Promise<NonNullable<EvalResult["data"]["centralityExperiment"]>> {
  const index = await buildIndex({ repoRoot, writeArtifacts: false });
  const scores = new Map(index.files.map((file) => [file.path, 1]));
  for (let iteration = 0; iteration < 8; iteration += 1) {
    const next = new Map(index.files.map((file) => [file.path, 0.15]));
    for (const edge of index.graphEdges) {
      if (!edge.fromPath || !edge.toPath) {
        continue;
      }
      const contribution = (scores.get(edge.fromPath) ?? 1) * Math.max(0.1, Math.min(edge.weight, 4)) * 0.12;
      next.set(edge.toPath, (next.get(edge.toPath) ?? 0.15) + contribution);
      if (edge.edgeKind === "IMPORTS" || edge.edgeKind === "CALLS" || edge.edgeKind === "REFERENCES") {
        next.set(edge.fromPath, (next.get(edge.fromPath) ?? 0.15) + (scores.get(edge.toPath) ?? 1) * 0.04);
      }
    }
    for (const [filePath, value] of next) {
      scores.set(filePath, Math.min(50, value));
    }
  }
  const currentTop = new Set(index.files.slice(0, 10).map((file) => file.path));
  const byFile = new Map(index.files.map((file) => [file.path, file]));
  const topFiles = [...scores.entries()]
    .sort(([pathA, scoreA], [pathB, scoreB]) => scoreB - scoreA || pathA.localeCompare(pathB))
    .slice(0, 20)
    .map(([filePath, scoreValue]) => ({ path: filePath, score: Number(scoreValue.toFixed(4)), currentRank: Number((byFile.get(filePath)?.rank ?? 0).toFixed(4)) }));
  return {
    enabled: true,
    topFiles,
    overlapWithCurrentTop10: topFiles.slice(0, 10).filter((entry) => currentTop.has(entry.path)).length,
    note: "Eval-only transitive centrality experiment; default file.rank is unchanged unless future benchmark metrics justify enabling it."
  };
}

function filesFromData(data: unknown): string[] {
  if (!data || typeof data !== "object") {
    return [];
  }
  const record = data as Record<string, unknown>;
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
    const readFirst = (record.fanout as Record<string, unknown>).readFirst;
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
  const nested = ["diff", "plan"].flatMap((key) => filesFromData(record[key]));
  return uniqueInOrder(nested);
}

function plannedFilesFromData(data: unknown): string[] {
  if (!data || typeof data !== "object") {
    return [];
  }
  const record = data as Record<string, unknown>;
  if (Array.isArray(record.plannedEditTargets)) {
    return uniqueInOrder(record.plannedEditTargets.flatMap(filePathFromUnknown));
  }
  if (record.snapshot && typeof record.snapshot === "object") {
    const snapshot = record.snapshot as Record<string, unknown>;
    if (Array.isArray(snapshot.plannedEditTargets)) {
      return uniqueInOrder(snapshot.plannedEditTargets.flatMap(filePathFromUnknown));
    }
  }
  if (Array.isArray(record.reviewTargets)) {
    return uniqueInOrder(record.reviewTargets.flatMap(filePathFromUnknown));
  }
  const nested = ["focus", "context", "diff", "plan"].flatMap((key) => plannedFilesFromData(record[key]));
  return uniqueInOrder(nested);
}

function callTraceFromData(data: unknown): string[] {
  if (!data || typeof data !== "object") {
    return [];
  }
  const record = data as Record<string, unknown>;
  if (Array.isArray(record.callTrace)) {
    return record.callTrace.filter((entry): entry is string => typeof entry === "string");
  }
  return [];
}

function testsFromData(data: unknown): string[] {
  if (!data || typeof data !== "object") {
    return [];
  }
  const record = data as Record<string, unknown>;
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
  const nested = ["diff", "plan"].flatMap((key) => testsFromData(record[key]));
  return uniqueInOrder([...direct, ...workflowTests, ...nested]);
}

function qualityFromData(data: unknown): { level: string; counts: { authoritative: number; derived: number; heuristic: number; fallback: number } } | null {
  if (!data || typeof data !== "object") {
    return null;
  }
  const record = data as Record<string, unknown>;
  const quality = record.quality;
  if (quality && typeof quality === "object") {
    const q = quality as Record<string, unknown>;
    const counts = q.counts && typeof q.counts === "object" ? (q.counts as Record<string, unknown>) : {};
    return {
      level: typeof q.level === "string" ? q.level : "unknown",
      counts: {
        authoritative: numericCount(counts.authoritative),
        derived: numericCount(counts.derived),
        heuristic: numericCount(counts.heuristic),
        fallback: numericCount(counts.fallback)
      }
    };
  }
  for (const key of ["focus", "context", "diff", "plan"]) {
    const nested = qualityFromData(record[key]);
    if (nested) {
      return nested;
    }
  }
  return null;
}

function postEditOutcomeFromData(data: unknown): ScoredEvalScenario["calibration"]["postEditOutcome"] {
  if (!data || typeof data !== "object") {
    return undefined;
  }
  const record = data as Record<string, unknown>;
  const candidate = record.outcome && typeof record.outcome === "object" ? (record.outcome as Record<string, unknown>) : record;
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
  for (const key of ["review", "postEdit", "post_edit", "plan"]) {
    const nested = postEditOutcomeFromData(record[key]);
    if (nested) {
      return nested;
    }
  }
  return undefined;
}

function toolHopsToEditReadyFromData(data: unknown): number | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return null;
  }
  const record = data as Record<string, unknown>;
  const mode = typeof record.mode === "string" ? record.mode : undefined;
  const actionability = typeof record.actionability === "string" ? record.actionability : undefined;
  const editReady = actionability === "edit_ready" || record.packetVerdict === "edit-ready" || (record.editReadiness && typeof record.editReadiness === "object" && (record.editReadiness as { editable?: unknown }).editable === true);
  if (editReady) {
    if (mode === "session_context" || mode === "focus_brief") return 2;
    if (mode === "task_brief" || mode === "context_pack") return 1;
    return 0;
  }
  for (const key of ["focus", "context", "diff", "plan", "data"]) {
    const nested = toolHopsToEditReadyFromData(record[key]);
    if (nested !== null) {
      return nested;
    }
  }
  return null;
}

function verificationProvenanceFromData(data: unknown): EvalVerificationProvenance | undefined {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return undefined;
  }
  const record = data as Record<string, unknown>;
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

function uniqueInOrder(values: string[]): string[] {
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

function renderEval(data: EvalResult["data"]): string {
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

function serializedByteLength(value: unknown): number {
  try {
    const serialized = JSON.stringify(value);
    return serialized ? Buffer.byteLength(serialized, "utf8") : 0;
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

interface SyntheticRepo {
  repoRoot: string;
  ts: {
    helperPath: string;
    featurePath: string;
    testPath: string;
    decoyPath: string;
    helperSymbol: string;
  };
  python: {
    helperPath: string;
    appPath: string;
    testPath: string;
    decoyPath: string;
    helperSymbol: string;
  };
  manifest: {
    path: string;
    webReferencePath: string;
    decoyPath: string;
    typeId: string;
  };
  shared: {
    sharedPath: string;
    consumerPath: string;
    secondConsumerPath: string;
    testPath: string;
    leafPath: string;
    decoyPath: string;
    exportedSymbol: string;
    uniqueLiteral: string;
  };
}

async function createSyntheticRepo(seed: string): Promise<SyntheticRepo> {
  const rng = seeded(seed);
  const token = alphaToken(rng, 8);
  const camel = `${token[0].toUpperCase()}${token.slice(1)}`;
  const repo = await mkdtemp(path.join(os.tmpdir(), `codexa-eval-${token}-`));
  execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Codexa Eval"], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "codexa-eval@example.invalid"], { cwd: repo, stdio: "ignore" });

  const tsHelper = `make${camel}Value`;
  const pyHelper = `normalize_${token}`;
  const typeId = `${token}.audio.speech_to_speech`;
  const sharedSymbol = `format${camel}Label`;
  const uniqueLiteral = `unique_${token}_literal`;
  const ts = {
    helperPath: `src/${token}_core.ts`,
    featurePath: `src/${token}_feature.ts`,
    testPath: `src/${token}_core.test.ts`,
    decoyPath: `src/${token}_core_decoy.ts`,
    helperSymbol: tsHelper
  };
  const python = {
    helperPath: `service_${token}/helpers.py`,
    appPath: `service_${token}/app.py`,
    testPath: `tests/test_${token}.py`,
    decoyPath: `service_${token}/helpers_decoy.py`,
    helperSymbol: pyHelper
  };
  const manifest = {
    path: `manifests/${token}.node.json`,
    webReferencePath: `web/src/${token}_node.ts`,
    decoyPath: `web/src/${token}_node_decoy.ts`,
    typeId
  };
  const shared = {
    sharedPath: `src/${token}_shared.ts`,
    consumerPath: `src/${token}_consumer_a.ts`,
    secondConsumerPath: `src/${token}_consumer_b.ts`,
    testPath: `src/${token}_shared.test.ts`,
    leafPath: `src/${token}_leaf.ts`,
    decoyPath: `src/${token}_shared_decoy.ts`,
    exportedSymbol: sharedSymbol,
    uniqueLiteral
  };

  await mkdir(path.join(repo, "src"), { recursive: true });
  await mkdir(path.join(repo, `service_${token}`), { recursive: true });
  await mkdir(path.join(repo, "tests"), { recursive: true });
  await mkdir(path.join(repo, "web/src"), { recursive: true });
  await mkdir(path.join(repo, "manifests"), { recursive: true });
  await writeFile(path.join(repo, "package.json"), JSON.stringify({ scripts: { typecheck: "tsc -p tsconfig.json --noEmit", test: "vitest run", check: "npm run typecheck && npm test" } }, null, 2), "utf8");
  await writeFile(path.join(repo, "pyproject.toml"), `[project]\ndependencies = ["pytest>=8"]\n[tool.pytest.ini_options]\ntestpaths = ["tests"]\n`, "utf8");
  await writeFile(path.join(repo, ts.helperPath), `export function ${tsHelper}() {\n  return "${token}"\n}\n`, "utf8");
  await writeFile(path.join(repo, ts.featurePath), `import { ${tsHelper} } from "./${token}_core"\nexport function use${camel}Feature() {\n  return ${tsHelper}()\n}\n`, "utf8");
  await writeFile(path.join(repo, ts.testPath), `import { ${tsHelper} } from "./${token}_core"\ntest("${token}", () => {\n  expect(${tsHelper}()).toBe("${token}")\n})\n`, "utf8");
  await writeFile(path.join(repo, ts.decoyPath), `export function ${tsHelper}Decoy() {\n  return "${token}-decoy"\n}\n`, "utf8");
  await writeFile(path.join(repo, shared.sharedPath), `export function ${sharedSymbol}(value: string) {\n  return value.trim()\n}\n`, "utf8");
  await writeFile(path.join(repo, shared.consumerPath), `import { ${sharedSymbol} } from "./${token}_shared"\nexport function render${camel}A(value: string) {\n  return ${sharedSymbol}(value)\n}\n`, "utf8");
  await writeFile(path.join(repo, shared.secondConsumerPath), `import { ${sharedSymbol} } from "./${token}_shared"\nexport function render${camel}B(value: string) {\n  return ${sharedSymbol}(value).toUpperCase()\n}\n`, "utf8");
  await writeFile(path.join(repo, shared.testPath), `import { ${sharedSymbol} } from "./${token}_shared"\ntest("${token}-shared", () => {\n  expect(${sharedSymbol}(" A ")).toBe("A")\n})\n`, "utf8");
  await writeFile(path.join(repo, shared.leafPath), `export const ${token}LeafMarker = "${uniqueLiteral}"\n`, "utf8");
  await writeFile(path.join(repo, shared.decoyPath), `export function ${sharedSymbol}Decoy(value: string) {\n  return value\n}\n`, "utf8");
  await writeFile(path.join(repo, python.helperPath), `def ${pyHelper}(value):\n    return value.strip().lower()\n`, "utf8");
  await writeFile(
    path.join(repo, python.appPath),
    `from .helpers import ${pyHelper}\n\n@router.post("/${token}")\ndef route_${token}(value):\n    return ${pyHelper}(value)\n`,
    "utf8"
  );
  await writeFile(
    path.join(repo, python.testPath),
    `from service_${token}.app import route_${token}\n\ndef test_${token}_route():\n    assert route_${token}(" A ") == "a"\n`,
    "utf8"
  );
  await writeFile(path.join(repo, python.decoyPath), `def ${pyHelper}_decoy(value):\n    return value\n`, "utf8");
  await writeFile(
    path.join(repo, manifest.path),
    JSON.stringify({ nodes: [{ type_id: typeId, title: `${camel} Node`, adapter_key: `${token}.adapter` }] }, null, 2),
    "utf8"
  );
  await writeFile(path.join(repo, manifest.webReferencePath), `export const nodeType = "${typeId}"\n`, "utf8");
  await writeFile(path.join(repo, manifest.decoyPath), `export const nodeType = "${typeId}.decoy"\n`, "utf8");
  execFileSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "synthetic benchmark fixture"], { cwd: repo, stdio: "ignore" });
  await buildIndex({ repoRoot: repo, writeArtifacts: true });
  await writeFile(path.join(repo, python.helperPath), `def ${pyHelper}(value):\n    return value.strip().casefold()\n`, "utf8");

  return { repoRoot: repo, ts, python, manifest, shared };
}

function seeded(seed: string): () => number {
  let state = 2166136261;
  for (let i = 0; i < seed.length; i += 1) {
    state ^= seed.charCodeAt(i);
    state = Math.imul(state, 16777619);
  }
  return () => {
    state = Math.imul(state ^ (state >>> 15), 2246822507);
    state = Math.imul(state ^ (state >>> 13), 3266489909);
    state ^= state >>> 16;
    return (state >>> 0) / 0xffffffff;
  };
}

function alphaToken(rng: () => number, length: number): string {
  const letters = "abcdefghijklmnopqrstuvwxyz";
  let value = "";
  for (let i = 0; i < length; i += 1) {
    value += letters[Math.floor(rng() * letters.length) % letters.length];
  }
  return value;
}

function runBaseline(command: string[], cwd: string): string {
  assertAllowedBaseline(command);
  if (command[0] === "rg") {
    return runRipgrepBaseline(command.slice(1), cwd);
  }
  return runBaselineCommand(command, cwd);
}

function runScenarioBaselines(scenario: EvalScenario): BaselineRun[] | null {
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

async function cleanupScenarioRepos(scenarios: EvalScenario[]): Promise<void> {
  const roots = uniqueInOrder(scenarios.flatMap((scenario) => [...(scenario.cleanupRepoRoots ?? []), ...(scenario.cleanupRepoRoot ? [scenario.cleanupRepoRoot] : [])]));
  for (const root of roots) {
    await rm(root, { recursive: true, force: true });
  }
}

function isMissingExecutable(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT");
}

function baselineFailureScenario(scenario: EvalScenario, error: unknown): ScoredEvalScenario {
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

function formatBaselineCommands(scenario: EvalScenario): string {
  const commands = scenario.baselineCommands?.length ? scenario.baselineCommands : scenario.baselineCommand ? [scenario.baselineCommand] : [];
  return commands.length > 0 ? commands.map((command) => command.join(" ")).join(" && ") : "unknown";
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

function fileExists(filePath: string): boolean {
  return existsSync(filePath);
}

function indent(value: string): string {
  return value
    .split(/\r?\n/)
    .map((line) => `  ${line}`)
    .join("\n");
}
