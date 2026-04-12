import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildIndex } from "./indexer.js";
import { isTestPath } from "./language.js";
import { changePlanQuery, contextPackQuery, diffImpactQuery, focusBriefQuery, impactQuery, postEditReviewQuery, searchQuery, taskBriefQuery, testPlanQuery, workflowPathQuery } from "./queries.js";
import type { QueryOptions, QueryResult, TestRecommendation } from "./types.js";

type EvalSuite = "all" | "project" | "synthetic";

interface EvalScenario {
  id: string;
  suite: "project" | "synthetic";
  description: string;
  repoRoot: string;
  scored?: boolean;
  baselineCommand?: string[];
  baselineCwd?: string;
  codexa: () => Promise<QueryResult>;
  oracle: EvalOracle;
}

interface EvalOracle {
  expectedFiles?: string[];
  expectedTests?: string[];
  forbiddenFiles?: string[];
  topFiles?: string[];
  maxTextChars?: number;
  minFileRecall?: number;
  minTestRecall?: number;
  minFilePrecisionAtK?: number;
  maxSelectedToBaselineRatio?: number;
}

interface ScoredEvalScenario {
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
  tests: string[];
  metrics: {
    fileRecall: number | null;
    testRecall: number | null;
    precisionAtK: number | null;
    selectedToBaselineRatio: number | null;
    textChars: number;
    refreshed: boolean;
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
    missingExpectedTests: string[];
    heuristicHeavy: boolean;
    broadRetrievalFailure: boolean;
    rawRgBetter: boolean;
    rawRgBetterReason?: string;
    postEditOutcome?: {
      verdict?: string;
      outcomeId?: string;
      path?: string;
      driftReasons: string[];
      calibrationLabels: string[];
      testsNotRun: string[];
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
      missingExpectedTests: string[];
      heuristicHeavyScenarios: string[];
      broadRetrievalFailures: string[];
      rawRgBetterScenarios: string[];
      postEditVerdicts: Record<string, number>;
      outcomeRecords: string[];
    };
    scenarios: ScoredEvalScenario[];
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
  const scenarios = [
    ...(suite === "all" || suite === "project" ? projectScenarios(repo, options) : []),
    ...(suite === "all" || suite === "synthetic" ? await syntheticScenarios(seed) : [])
  ];
  const antiCheat = [
    "Scores use structured QueryResult.data, not human-readable prose substrings.",
    "Synthetic scenarios use seed-generated identifiers and decoy files.",
    "Patch-task scenarios score read-first files, targeted tests, and false-positive cost without applying hardcoded edits.",
    "Benchmark scenarios run with auto-refresh disabled unless explicitly requested.",
    "Refresh is scored separately and fails the benchmark when failOnRefresh is enabled."
  ];

  const scored: ScoredEvalScenario[] = [];
  for (const scenario of scenarios) {
    let baseline: string | null = null;
    try {
      baseline = scenario.baselineCommand ? runBaseline(scenario.baselineCommand, scenario.baselineCwd ?? scenario.repoRoot) : null;
    } catch (error) {
      scored.push(baselineFailureScenario(scenario, error));
      continue;
    }
    const result = await scenario.codexa();
    scored.push(scoreScenario(scenario, result, baseline, failOnRefresh));
  }

  const passed = scored.every((scenario) => scenario.passed);
  const scoredOnly = scored.filter((scenario) => scenario.scored);
  const score = scoredOnly.length > 0 ? scoredOnly.reduce((sum, scenario) => sum + scenario.score, 0) / scoredOnly.length : 0;
  const data = { seed, suite, passed, score, antiCheat, calibrationSummary: calibrationSummary(scored), scenarios: scored };
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
    description: "Current Project dirty tree should produce bounded grouped context, not a raw git-status dump.",
    repoRoot: repo,
    baselineCommand: ["git", "status", "--short"],
    codexa: async () =>
      contextPackQuery(
        repo,
        {
          task: "Understand the current dirty Project diff and choose focused verification.",
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

  const runPolling = path.join(repo, "web/src/features/project/use-run-polling.ts");
  if (fileExists(runPolling)) {
    scenarios.push({
      id: "project-use-run-polling-impact",
      suite: "project",
      description: "Exact frontend hook impact should surface the hook file and targeted test.",
      repoRoot: repo,
      baselineCommand: ["rg", "-n", "useRunPolling", "web/src", "tests"],
      codexa: async () => impactQuery(repo, { symbol: "useRunPolling" }, queryOptions),
      oracle: {
        expectedFiles: ["web/src/features/project/use-run-polling.ts"],
        expectedTests: ["web/src/features/project/use-run-polling.test.tsx"],
        minFileRecall: 1,
        minTestRecall: 0.5,
        minFilePrecisionAtK: 0.25,
        maxSelectedToBaselineRatio: 0.75
      }
    });
    scenarios.push({
      id: "project-queue-polling-workflow",
      suite: "project",
      description: "Historical Project queue polling workflow should connect frontend hook, UI dashboard, backend queue routes, store, and tests.",
      repoRoot: repo,
      baselineCommand: ["rg", "-n", "queue|poll|/api/runs|/api/queue", "web/src/features/project", "web/src/lib", "sample_api", "tests"],
      codexa: async () =>
        workflowPathQuery(
          repo,
          {
            query: "queue polling frontend backend workflow api runs queue store tests",
            limit: 8
          },
          queryOptions
        ),
      oracle: {
        expectedFiles: [
          "web/src/features/project/use-run-polling.ts",
          "web/src/features/project/queue-dashboard.tsx",
          "sample_api/app.py",
          "sample_api/store.py"
        ],
        expectedTests: ["web/src/features/project/use-run-polling.test.tsx", "tests/test_queue.py"],
        minFileRecall: 0.5,
        minTestRecall: 0.5,
        minFilePrecisionAtK: 0.2,
        maxSelectedToBaselineRatio: 0.5
      }
    });
  } else {
    scenarios.push(missingRequiredProjectScenario(repo, "project-use-run-polling-impact", "web/src/features/project/use-run-polling.ts"));
    scenarios.push(missingRequiredProjectScenario(repo, "project-queue-polling-workflow", "web/src/features/project/use-run-polling.ts"));
  }

  if (fileExists(path.join(repo, "sample_api/packages/project.s2s.json"))) {
    scenarios.push({
      id: "project-s2s-manifest-impact",
      suite: "project",
      description: "Project S2S manifest impact should connect package, runtime, and tests.",
      repoRoot: repo,
      baselineCommand: ["rg", "-n", "s2s\\.audio\\.speech_to_speech", "sample_api", "tests", "web/src"],
      codexa: async () => impactQuery(repo, { file: "sample_api/packages/project.s2s.json" }, queryOptions),
      oracle: {
        expectedFiles: ["sample_api/packages/project.s2s.json", "sample_api/adapters/s2s.py"],
        expectedTests: ["tests/test_s2s_adapter.py"],
        minFileRecall: 0.5,
        minTestRecall: 0.5,
        minFilePrecisionAtK: 0.25,
        maxSelectedToBaselineRatio: 0.9
      }
    });
  } else {
    scenarios.push(missingRequiredProjectScenario(repo, "project-s2s-manifest-impact", "sample_api/packages/project.s2s.json"));
  }

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
          diff: diff.data,
          plan: plan.data,
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

function missingRequiredProjectScenario(repo: string, id: string, missingPath: string): EvalScenario {
  return {
    id,
    suite: "project",
    description: `Required Project benchmark file is missing: ${missingPath}`,
    repoRoot: repo,
    codexa: async () => ({
      freshness: {
        schemaVersion: 1,
        snapshotId: "missing-required-project-file",
        repoRoot: repo,
        gitRoot: repo,
        headCommit: null,
        indexedAt: "",
        dirtyFiles: [],
        dirtyFileHashes: {},
        indexedDirtyFileHashes: {},
        indexedDirtyFiles: [],
        missing: true,
        stale: true,
        reason: "missing-index",
        parserErrorCount: 0
      },
      text: `Missing required Project benchmark file: ${missingPath}`,
      data: {},
      refresh: { refreshed: false }
    }),
    oracle: {
      expectedFiles: [missingPath],
      minFileRecall: 1
    }
  };
}

function historicalProjectScenarios(repo: string, queryOptions: QueryOptions): EvalScenario[] {
  const reportPath = path.join(repo, "reports/evaluations/historical-project-tasks.json");
  if (!existsSync(reportPath)) {
    return [missingRequiredProjectScenario(repo, "project-historical-tasks", "reports/evaluations/historical-project-tasks.json")];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(reportPath, "utf8"));
  } catch {
    return [missingRequiredProjectScenario(repo, "project-historical-tasks-valid-json", "reports/evaluations/historical-project-tasks.json")];
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
  return [
    {
      id: `historical-${id}`,
      suite: "project",
      description,
      repoRoot: repo,
      baselineCommand,
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
  return [
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
      description: "Randomized Project-style manifest should link node id references without hardcoded Project names.",
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
            ranTests: [],
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
}

function scoreScenario(scenario: EvalScenario, result: QueryResult, baseline: string | null, failOnRefresh: boolean): ScoredEvalScenario {
  const files = filesFromData(result.data);
  const tests = testsFromData(result.data);
  const baselineFiles = baseline === null ? [] : baselineFilesFromOutput(scenario.baselineCommand ?? [], baseline);
  const baselineTests = baselineFiles.filter(isTestPath);
  const expectedFiles = scenario.oracle.expectedFiles ?? [];
  const expectedTests = scenario.oracle.expectedTests ?? [];
  const forbiddenFiles = scenario.oracle.forbiddenFiles ?? [];
  const failures: string[] = [];
  const scored = scenario.scored ?? true;
  const fileRecall = expectedFiles.length > 0 ? recall(files, expectedFiles) : null;
  const testRecall = expectedTests.length > 0 ? recall(tests, expectedTests) : null;
  const precisionK = Math.max(1, expectedFiles.length || scenario.oracle.topFiles?.length || 5);
  const precisionAtK = expectedFiles.length > 0 ? precision(files.slice(0, precisionK), expectedFiles) : null;
  const baselineLines = baseline === null ? null : baseline.split(/\r?\n/).filter(Boolean).length;
  const selectedToBaselineRatio = baselineLines && baselineLines > 0 ? files.length / baselineLines : null;
  const baselineFileRecall = expectedFiles.length > 0 ? recall(baselineFiles, expectedFiles) : null;
  const baselineTestRecall = expectedTests.length > 0 ? recall(baselineTests, expectedTests) : null;
  const baselinePrecisionAtK = expectedFiles.length > 0 ? precision(baselineFiles.slice(0, precisionK), expectedFiles) : null;
  const codexaToBaselineFileRatio = baselineFiles.length > 0 ? files.length / baselineFiles.length : null;
  const minFileRecall = scenario.oracle.minFileRecall ?? 1;
  const minTestRecall = scenario.oracle.minTestRecall ?? 1;
  const minPrecision = scenario.oracle.minFilePrecisionAtK ?? 0;
  const refreshed = Boolean(result.refresh?.refreshed);
  const quality = qualityFromData(result.data);
  const falsePositiveFiles = expectedFiles.length > 0 ? files.filter((file) => !expectedFiles.includes(file) && !expectedTests.includes(file)) : [];
  const missingExpectedFiles = expectedFiles.filter((file) => !files.includes(file));
  const missingExpectedTests = expectedTests.filter((test) => !tests.includes(test));
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
  const postEditOutcome = postEditOutcomeFromData(result.data);

  if (fileRecall !== null && fileRecall < minFileRecall) {
    failures.push(`file recall ${fileRecall.toFixed(2)} < ${minFileRecall.toFixed(2)}`);
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
  for (const file of scenario.oracle.topFiles ?? []) {
    if (!files.slice(0, precisionK).includes(file)) {
      failures.push(`expected top-${precisionK} file missing: ${file}`);
    }
  }
  if (scenario.oracle.maxTextChars && result.text.length > scenario.oracle.maxTextChars) {
    failures.push(`text length ${result.text.length} > ${scenario.oracle.maxTextChars}`);
  }
  if (failOnRefresh && refreshed) {
    failures.push(`query auto-refreshed from ${result.refresh?.reason ?? "unknown"}`);
  }

  const measured = [fileRecall, testRecall, precisionAtK].filter((value): value is number => value !== null);
  const baseScore = measured.length > 0 ? measured.reduce((sum, value) => sum + value, 0) / measured.length : failures.length === 0 ? 1 : 0;
  const score = scored ? Math.max(0, baseScore - Math.min(0.5, failures.length * 0.1)) : 0;
  return {
    id: scenario.id,
    suite: scenario.suite,
    description: scenario.description,
    passed: failures.length === 0,
    score,
    scored,
    baselineLines,
    baselineFiles,
    baselineTests,
    files,
    tests,
    metrics: {
      fileRecall,
      testRecall,
      precisionAtK,
      selectedToBaselineRatio,
      textChars: result.text.length,
      refreshed
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
      missingExpectedTests,
      heuristicHeavy,
      broadRetrievalFailure,
      rawRgBetter,
      rawRgBetterReason,
      postEditOutcome
    },
    failures,
    sample: result.text.split(/\r?\n/).slice(0, 14).join("\n")
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
    createdAt: new Date().toISOString()
  });
}

async function atomicJsonWrite(filePath: string, value: unknown): Promise<void> {
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(tmp, filePath);
}

function calibrationSummary(scenarios: ScoredEvalScenario[]): EvalResult["data"]["calibrationSummary"] {
  const postEditVerdicts: Record<string, number> = {};
  const outcomeRecords: string[] = [];
  for (const scenario of scenarios) {
    const verdict = scenario.calibration.postEditOutcome?.verdict;
    if (verdict) {
      postEditVerdicts[verdict] = (postEditVerdicts[verdict] ?? 0) + 1;
    }
    const outcomePath = scenario.calibration.postEditOutcome?.path;
    if (outcomePath) {
      outcomeRecords.push(outcomePath);
    }
  }
  return {
    falsePositiveFiles: uniqueInOrder(scenarios.flatMap((scenario) => scenario.calibration.falsePositiveFiles)),
    missingExpectedTests: uniqueInOrder(scenarios.flatMap((scenario) => scenario.calibration.missingExpectedTests)),
    heuristicHeavyScenarios: scenarios.filter((scenario) => scenario.calibration.heuristicHeavy).map((scenario) => scenario.id),
    broadRetrievalFailures: scenarios.filter((scenario) => scenario.calibration.broadRetrievalFailure).map((scenario) => scenario.id),
    rawRgBetterScenarios: scenarios.filter((scenario) => scenario.calibration.rawRgBetter).map((scenario) => scenario.id),
    postEditVerdicts,
    outcomeRecords: uniqueInOrder(outcomeRecords)
  };
}

export function scoreStructuredOutputForTest(result: QueryResult, oracle: EvalOracle): ScoredEvalScenario {
  return scoreScenario(
    {
      id: "test",
      suite: "synthetic",
      description: "test",
      repoRoot: "",
      codexa: async () => result,
      oracle
    },
    result,
    null,
    true
  );
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
  const outcome = record.outcome;
  if (outcome && typeof outcome === "object") {
    const value = outcome as Record<string, unknown>;
    const testsNotRun = Array.isArray(value.testsNotRun)
      ? value.testsNotRun.flatMap((entry) => {
          if (typeof entry === "string") {
            return [entry];
          }
          if (entry && typeof entry === "object" && typeof (entry as { path?: unknown }).path === "string") {
            return [(entry as { path: string }).path];
          }
          return [];
        })
      : [];
    return {
      verdict: typeof value.verdict === "string" ? value.verdict : undefined,
      outcomeId: typeof value.outcomeId === "string" ? value.outcomeId : undefined,
      path: typeof value.path === "string" ? value.path : undefined,
      driftReasons: Array.isArray(value.driftReasons) ? value.driftReasons.filter((entry): entry is string => typeof entry === "string") : [],
      calibrationLabels: Array.isArray(value.calibrationLabels) ? value.calibrationLabels.filter((entry): entry is string => typeof entry === "string") : [],
      testsNotRun
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
  const lines = [
    "Codexa eval benchmark",
    `Suite: ${data.suite}`,
    `Seed: ${data.seed}`,
    `Pass: ${data.passed ? "yes" : "no"}`,
    `Score: ${data.score.toFixed(3)}`,
    "",
    "Anti-cheat controls:",
    ...data.antiCheat.map((item) => `- ${item}`),
    ""
  ];
  for (const scenario of data.scenarios) {
    lines.push(
      `Scenario: ${scenario.id}`,
      `- suite: ${scenario.suite}`,
      `- pass: ${scenario.passed ? "yes" : "no"}`,
      `- score: ${scenario.scored ? scenario.score.toFixed(3) : "smoke"}`,
      `- baseline lines: ${scenario.baselineLines ?? "n/a"}`,
      `- file recall: ${formatMetric(scenario.metrics.fileRecall)}, test recall: ${formatMetric(scenario.metrics.testRecall)}, precision@k: ${formatMetric(scenario.metrics.precisionAtK)}, selected/baseline: ${formatMetric(scenario.metrics.selectedToBaselineRatio)}`,
      `- without Codexa: files ${scenario.comparison.baselineFileCount}, tests ${scenario.comparison.baselineTestCount}, file recall ${formatMetric(scenario.comparison.baselineFileRecall)}, test recall ${formatMetric(scenario.comparison.baselineTestRecall)}, precision@k ${formatMetric(scenario.comparison.baselinePrecisionAtK)}`,
      `- Codexa delta: file recall ${formatDelta(scenario.comparison.fileRecallDelta)}, test recall ${formatDelta(scenario.comparison.testRecallDelta)}, precision@k ${formatDelta(scenario.comparison.precisionDelta)}, file count ratio ${formatMetric(scenario.comparison.codexaToBaselineFileRatio)}`,
      `- calibration: false positives ${scenario.calibration.falsePositiveFiles.length}, missing files ${scenario.calibration.missingExpectedFiles.length}, missing tests ${scenario.calibration.missingExpectedTests.length}, heuristic-heavy ${scenario.calibration.heuristicHeavy ? "yes" : "no"}, raw rg better ${scenario.calibration.rawRgBetter ? "yes" : "no"}`,
      ...(scenario.calibration.rawRgBetterReason ? [`- raw rg better reason: ${scenario.calibration.rawRgBetterReason}`] : []),
      `- text chars: ${scenario.metrics.textChars}, refreshed: ${scenario.metrics.refreshed ? "yes" : "no"}`,
      ...(scenario.failures.length > 0 ? [`- failures: ${scenario.failures.join("; ")}`] : []),
      "- selected files:",
      ...scenario.files.slice(0, 10).map((file) => `  - ${file}`),
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
    path: `sample_api/packages/project.${token}.json`,
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
  await mkdir(path.join(repo, "sample_api/packages"), { recursive: true });
  await writeFile(path.join(repo, "package.json"), JSON.stringify({ scripts: { test: "vitest run" } }, null, 2), "utf8");
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
  try {
    return execFileSync(command[0], command.slice(1), {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    });
  } catch (error) {
    const status = error && typeof error === "object" && "status" in error ? Number((error as { status?: unknown }).status) : undefined;
    if (status !== undefined && status > 1) {
      throw error;
    }
    if (error && typeof error === "object" && "stdout" in error) {
      return String((error as { stdout?: unknown }).stdout ?? "");
    }
    return "";
  }
}

function baselineFailureScenario(scenario: EvalScenario, error: unknown): ScoredEvalScenario {
  const message = error instanceof Error ? error.message : String(error);
  return {
    id: scenario.id,
    suite: scenario.suite,
    description: scenario.description,
    passed: false,
    score: 0,
    scored: scenario.scored ?? true,
    baselineLines: null,
    baselineFiles: [],
    baselineTests: [],
    files: [],
    tests: [],
    metrics: {
      fileRecall: null,
      testRecall: null,
      precisionAtK: null,
      selectedToBaselineRatio: null,
      textChars: 0,
      refreshed: false
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
      missingExpectedTests: scenario.oracle.expectedTests ?? [],
      heuristicHeavy: false,
      broadRetrievalFailure: false,
      rawRgBetter: false
    },
    failures: [`baseline command failed: ${scenario.baselineCommand?.join(" ") ?? "unknown"}; ${message}`],
    sample: ""
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

function fileExists(filePath: string): boolean {
  return existsSync(filePath);
}

function indent(value: string): string {
  return value
    .split(/\r?\n/)
    .map((line) => `  ${line}`)
    .join("\n");
}
