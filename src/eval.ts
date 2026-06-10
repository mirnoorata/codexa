import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildIndex } from "./indexer.js";
import { MCP_TOOL_CATALOG } from "./mcp-tool-catalog.js";
import { changePlanQuery, contextPackQuery, diffImpactQuery, focusBriefQuery, impactQuery, postEditReviewQuery, searchQuery, taskBriefQuery, testPlanQuery, workflowPathQuery } from "./queries.js";
import type { QueryOptions } from "./types.js";
import { runScenarioBaselines, type BaselineRun } from "./eval/baseline.js";
import { externalHistoricalTaskPackScenarios, historicalFixtureScenarios } from "./eval/historical.js";
import { renderEval } from "./eval/render.js";
import { baselineFailureScenario, calibrationSummary, filesFromData, scoreScenario, testsFromData, type EvalVerificationProvenance } from "./eval/scoring.js";
import { cleanupScenarioRepos, createSyntheticRepo } from "./eval/synthetic.js";
import type { EvalScenario, EvalSuite } from "./eval/types.js";
export type { EvalOracle, EvalScenario, EvalScenarioSuite, EvalSuite } from "./eval/types.js";
export { scoreStructuredOutputForTest } from "./eval/scoring.js";

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

function fileExists(filePath: string): boolean {
  return existsSync(filePath);
}
