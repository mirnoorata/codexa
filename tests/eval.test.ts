import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runEval, scoreStructuredOutputForTest } from "../src/eval.js";
import { buildIndex } from "../src/indexer.js";
import { CURRENT_VERIFICATION_PROVENANCE } from "../src/types.js";
import type { QueryResult } from "../src/types.js";

describe("Codexa eval benchmark", () => {
  it("runs randomized synthetic holdouts with structured scoring", async () => {
    const result = await runEval("/tmp/codexa-eval-target", { autoRefresh: false }, { suite: "synthetic", seed: "unit-seed", failOnRefresh: true });
    const second = await runEval("/tmp/codexa-eval-target", { autoRefresh: false }, { suite: "synthetic", seed: "unit-seed-alt", failOnRefresh: true });

    expect(result.passed).toBe(true);
    expect(second.passed).toBe(true);
    expect(result.data.scenarios.length).toBeGreaterThanOrEqual(4);
    expect(second.data.scenarios.length).toBe(result.data.scenarios.length);
    expect(result.text).toContain("Anti-cheat controls");
    expect(result.text).toContain("Codexa quality observations");
    expect(result.text).not.toContain("Codexa made it worse signals");
    const qualityObservationSection = result.text.split("Codexa quality observations:\n")[1]?.split("\n\n")[0] ?? "";
    expect(qualityObservationSection).not.toMatch(/^- none\n-/m);
    expect(result.data.scenarios.every((scenario) => scenario.metrics.refreshed === false)).toBe(true);
    expect(result.data.scenarios.some((scenario) => scenario.id === "synthetic-ts-impact-decoy-control")).toBe(true);
    expect(result.data.scenarios.some((scenario) => scenario.id === "synthetic-session-context-seedless")).toBe(true);
    expect(result.data.calibrationSummary).toBeTruthy();
    expect(Object.values(result.data.calibrationSummary.postEditVerdicts).reduce((sum, value) => sum + value, 0)).toBeGreaterThanOrEqual(1);
    expect(result.data.calibrationSummary.outcomeRecords.some((entry) => entry.startsWith(".codex/cache/codexa-outcomes/"))).toBe(true);
    expect(result.data.calibrationSummary.postEditAggregateCoverageScenarios).toContain("synthetic-patch-task-post-edit-review");
    expect(result.data.calibrationSummary.postEditCalibrationLabels).toContain("false-missing-test-warning-avoided");
    expect(result.data.calibrationSummary.postEditCalibrationLabels.length).toBeGreaterThan(0);
    const tsScenario = result.data.scenarios.find((scenario) => scenario.id === "synthetic-ts-impact-decoy-control");
    expect(tsScenario?.comparison.baselineFileCount).toBeGreaterThan(tsScenario?.comparison.codexaFileCount ?? 0);
    expect(tsScenario?.comparison.precisionDelta).toBeGreaterThanOrEqual(0);
  });

  it("keeps synthetic baseline comparisons valid when ripgrep is unavailable", async () => {
    const result = await withoutRipgrep(() =>
      runEval("/tmp/codexa-eval-target", { autoRefresh: false }, { suite: "synthetic", seed: "unit-seed-no-rg", failOnRefresh: true })
    );

    expect(result.passed).toBe(true);
    const tsScenario = result.data.scenarios.find((scenario) => scenario.id === "synthetic-ts-impact-decoy-control");
    expect(tsScenario?.comparison.baselineFileCount).toBeGreaterThan(tsScenario?.comparison.codexaFileCount ?? 0);
  });

  it("runs historical fixture holdouts with call traces and raw-better calibration", async () => {
    const result = await runEval("/tmp/codexa-eval-target", { autoRefresh: false }, { suite: "historical-fixture", seed: "unit-historical", failOnRefresh: true });

    expect(result.passed).toBe(true);
    expect(result.data.scenarios).toHaveLength(6);
    expect(result.data.scenarios.every((scenario) => scenario.suite === "historical-fixture")).toBe(true);
    expect(result.data.scenarios.some((scenario) => scenario.id === "historical-fixture-post-edit-drift")).toBe(true);
    expect(result.data.scenarios.some((scenario) => scenario.id === "historical-fixture-target-led-broad-dirty")).toBe(true);
    const changePlanScenario = result.data.scenarios.find((scenario) => scenario.id === "historical-fixture-exact-shared-api");
    const postEditScenario = result.data.scenarios.find((scenario) => scenario.id === "historical-fixture-post-edit-drift");
    const broadDirtyScenario = result.data.scenarios.find((scenario) => scenario.id === "historical-fixture-target-led-broad-dirty");
    expect(changePlanScenario?.plannedFiles).toContain("src/shared.ts");
    expect(postEditScenario?.plannedFiles).toContain("src/shared.ts");
    expect(broadDirtyScenario?.files).toContain("src/shared.ts");
    expect(broadDirtyScenario?.tests).toContain("src/feature.test.ts");
    expect(result.data.calibrationSummary.rawRgBetterScenarios).toHaveLength(0);
    expect(result.text).toContain("Codexa quality observations");
  });

  it("loads strict external historical task packs without leaking source samples", async () => {
    const repo = await createExternalPackRepo();
    try {
      const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
      const packPath = path.join(repo, "external-pack.json");
      await writeFile(packPath, `${JSON.stringify(externalPack(commit, [["rg", "-n", "makeExternalValue", "."], ["rg", "-n", "setupDrift", "."]]), null, 2)}\n`, "utf8");

      const result = await runEval(repo, { autoRefresh: false }, { suite: "task-pack", seed: "unit-task-pack", taskPackPath: packPath, failOnRefresh: true });
      const scenario = result.data.scenarios.find((entry) => entry.id === "historical-task-pack-external-change-plan");

      expect(result.data.scenarios).toHaveLength(1);
      expect(scenario?.passed).toBe(true);
      expect(scenario?.description).not.toContain("makeExternalValue");
      expect(scenario?.plannedFiles).toContain("src/external.ts");
      expect(scenario?.plannedFiles).toContain("src/setup.ts");
      expect(scenario?.baselineFiles).toContain("src/setup.ts");
      expect(scenario?.sample).toBe("[redacted for external historical task pack]");
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("rejects stale or unsafe external historical task packs", async () => {
    const repo = await createExternalPackRepo();
    try {
      const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
      const stalePackPath = path.join(repo, "stale-pack.json");
      await writeFile(stalePackPath, `${JSON.stringify(externalPack("deadbeef", [["rg", "-n", "makeExternalValue", "."]]), null, 2)}\n`, "utf8");

      await expect(runEval(repo, { autoRefresh: false }, { suite: "task-pack", seed: "unit-stale-pack", taskPackPath: stalePackPath, failOnRefresh: true })).rejects.toThrow(
        "does not match target repo HEAD"
      );

      const unsafePackPath = path.join(repo, "unsafe-pack.json");
      await writeFile(unsafePackPath, `${JSON.stringify(externalPack(commit, [["rg", "-n", "makeExternalValue", "/tmp"]]), null, 2)}\n`, "utf8");

      await expect(runEval(repo, { autoRefresh: false }, { suite: "task-pack", seed: "unit-unsafe-pack", taskPackPath: unsafePackPath, failOnRefresh: true })).rejects.toThrow(
        "unsafe baseline argument"
      );

      const unsafeRgFlagPackPath = path.join(repo, "unsafe-rg-flag-pack.json");
      await writeFile(unsafeRgFlagPackPath, `${JSON.stringify(externalPack(commit, [["rg", "--pre", "sh -c bad", "makeExternalValue", "."]]), null, 2)}\n`, "utf8");

      await expect(runEval(repo, { autoRefresh: false }, { suite: "task-pack", seed: "unit-unsafe-rg-flag-pack", taskPackPath: unsafeRgFlagPackPath, failOnRefresh: true })).rejects.toThrow(
        /unsafe baseline argument|unsupported baseline executable/
      );
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("restores temporary dirty historical patches when a scenario fails", async () => {
    const repo = await createExternalPackRepo();
    try {
      const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
      const dirtyFailurePackPath = path.join(repo, "dirty-failure-pack.json");
      await writeFile(dirtyFailurePackPath, `${JSON.stringify(dirtyFailurePack(commit), null, 2)}\n`, "utf8");

      await expect(runEval(repo, { autoRefresh: false }, { suite: "task-pack", seed: "unit-dirty-failure-pack", taskPackPath: dirtyFailurePackPath, failOnRefresh: true })).rejects.toThrow(
        "replacement string was not found"
      );

      const status = execFileSync("git", ["status", "--short", "--", "src/setup-dirty.ts", "src/external.ts"], { cwd: repo, encoding: "utf8" });
      expect(status.trim()).toBe("");
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("uses a fresh synthetic seed by default to reduce fixture memorization", async () => {
    const first = await runEval("/tmp/codexa-eval-target", { autoRefresh: false }, { suite: "synthetic", failOnRefresh: true });
    const second = await runEval("/tmp/codexa-eval-target", { autoRefresh: false }, { suite: "synthetic", failOnRefresh: true });

    expect(first.data.seed).not.toBe(second.data.seed);
    expect(first.text).toContain(first.data.seed);
    expect(second.text).toContain(second.data.seed);
  });

  it("does not pass a result that only mentions expected files in prose", () => {
    const fake = fakeQueryResult("A confident answer mentions src/real.ts and tests/real.test.ts but returns no structured data.", {});

    const scored = scoreStructuredOutputForTest(fake, {
      expectedFiles: ["src/real.ts"],
      expectedTests: ["tests/real.test.ts"],
      minFileRecall: 1,
      minTestRecall: 1
    });

    expect(scored.passed).toBe(false);
    expect(scored.failures.join("\n")).toContain("file recall");
    expect(scored.failures.join("\n")).toContain("test recall");
  });

  it("scores selected read-first files instead of collapsed fanout or prose", () => {
    const fake = fakeQueryResult("Prose mentions src/real.ts and tests/real.test.ts.", {
      selectedFiles: ["src/noisy.ts"],
      affectedFiles: [{ file: { path: "src/real.ts" } }, { file: { path: "tests/real.test.ts" } }],
      tests: [{ path: "tests/wrong.test.ts" }]
    });

    const scored = scoreStructuredOutputForTest(fake, {
      expectedFiles: ["src/real.ts"],
      expectedTests: ["tests/real.test.ts"],
      minFileRecall: 1,
      minTestRecall: 1
    });

    expect(scored.passed).toBe(false);
    expect(scored.files).toEqual(["src/noisy.ts"]);
    expect(scored.failures.join("\n")).toContain("file recall");
    expect(scored.failures.join("\n")).toContain("test recall");
  });

  it("keeps raw-better calibration active when raw search outperforms Codexa", () => {
    const scored = scoreStructuredOutputForTest(
      fakeQueryResult("Structured data selected the wrong file.", {
        selectedFiles: ["src/noise.ts"],
        tests: []
      }),
      {
        expectedFiles: ["src/real.ts"],
        maxFalsePositiveFiles: 0,
        minFileRecall: 0
      },
      {
        command: ["rg", "-n", "real", "."],
        output: "src/real.ts:1:export const real = true\n"
      }
    );

    expect(scored.calibration.rawRgBetter).toBe(true);
    expect(scored.calibration.rawRgBetterReason).toContain("file recall");
  });

  it("labels over-budgeted output as a calibration signal", () => {
    const scored = scoreStructuredOutputForTest(
      fakeQueryResult("x".repeat(80), {
        selectedFiles: ["src/real.ts"],
        tests: []
      }),
      {
        expectedFiles: ["src/real.ts"],
        maxTextChars: 20
      }
    );

    expect(scored.passed).toBe(false);
    expect(scored.calibration.overBudgetedOutput).toBe(true);
    expect(scored.failures.join("\n")).toContain("text length");
  });

  it("labels over-budget structured data as a calibration signal", () => {
    const scored = scoreStructuredOutputForTest(
      fakeQueryResult("short", {
        summary: {
          notes: "x".repeat(256)
        }
      }),
      {
        maxTextChars: 1000,
        maxDataBytes: 64
      }
    );

    expect(scored.passed).toBe(false);
    expect(scored.metrics.dataBytes).toBeGreaterThan(64);
    expect(scored.calibration.overBudgetedOutput).toBe(false);
    expect(scored.calibration.overBudgetedStructuredData).toBe(true);
    expect(scored.failures.join("\n")).toContain("structured data size");
  });

  it("extracts flattened post-edit verification signals without requiring a nested outcome wrapper", () => {
    const scored = scoreStructuredOutputForTest(
      fakeQueryResult("post-edit packet", {
        verdict: "inspect",
        outcomeId: "flat-123",
        path: ".codex/cache/codexa-outcomes/flat-123.json",
        driftReasons: ["aggregate command coverage"],
        calibrationLabels: ["aggregate-command-coverage"],
        testsNotRun: ["tests/unit.test.ts"],
        missedLikelyTests: ["tests/integration.test.ts"],
        modifiedPublicSymbols: ["src/api.ts#exported"],
        ranCommands: ["npm run check"],
        commandEnvelopes: [
          {
            command: "npm run check",
            cwd: "<repo>",
            packageManager: "npm",
            packageRoot: ".",
            scriptName: "check",
            args: [],
            source: "reported",
            scopeStatus: "repo",
            exitCode: 0,
            classifierVersion: CURRENT_VERIFICATION_PROVENANCE.commandCoverageClassifierVersion
          }
        ],
        verificationProvenance: CURRENT_VERIFICATION_PROVENANCE,
        verificationLedger: [{ status: "covered" }, { status: "missing" }, { status: "waived" }, { status: "not_applicable" }],
        workflowChecks: [{ status: "missing" }],
        dependencyChecks: [{ status: "covered" }]
      }),
      {}
    );

    expect(scored.calibration.postEditOutcome).toMatchObject({
      verdict: "inspect",
      outcomeId: "flat-123",
      path: ".codex/cache/codexa-outcomes/flat-123.json",
      driftReasons: ["aggregate command coverage"],
      calibrationLabels: ["aggregate-command-coverage"],
      testsNotRun: ["tests/unit.test.ts"],
      missedLikelyTests: ["tests/integration.test.ts"],
      modifiedPublicSymbols: ["src/api.ts#exported"],
      requiredChecksMissing: 1,
      ranCommands: ["npm run check"],
      commandEnvelopes: [
        {
          command: "npm run check",
          cwd: "<repo>",
          packageManager: "npm",
          packageRoot: ".",
          scriptName: "check",
          args: [],
          source: "reported",
          scopeStatus: "repo",
          exitCode: 0,
          classifierVersion: CURRENT_VERIFICATION_PROVENANCE.commandCoverageClassifierVersion
        }
      ],
      verificationProvenance: CURRENT_VERIFICATION_PROVENANCE,
      verificationCovered: 1,
      verificationMissing: 1,
      verificationWaived: 1,
      verificationNotApplicable: 1
    });
  });

  it("extracts nested post-edit command-envelope signals from outcome payloads", () => {
    const scored = scoreStructuredOutputForTest(
      fakeQueryResult("post-edit packet", {
        outcome: {
          verdict: "inspect",
          outcomeId: "nested-123",
          calibrationLabels: ["aggregate-command-coverage"],
          testsNotRun: [{ path: "tests/unit.test.ts" }],
          ranCommands: ["npm test"],
          commandEnvelopes: [
            {
              command: "npm test",
              cwd: "<repo>",
              packageManager: "npm",
              packageRoot: ".",
              scriptName: "test",
              args: [],
              source: "reported",
              scopeStatus: "repo",
              exitCode: 0,
              classifierVersion: CURRENT_VERIFICATION_PROVENANCE.commandCoverageClassifierVersion
            }
          ],
          verificationProvenance: CURRENT_VERIFICATION_PROVENANCE,
          verificationLedger: [{ status: "covered" }, { status: "missing" }]
        },
        workflowChecks: [{ status: "covered" }],
        dependencyChecks: [{ status: "missing" }]
      }),
      {}
    );

    expect(scored.calibration.postEditOutcome).toMatchObject({
      verdict: "inspect",
      outcomeId: "nested-123",
      calibrationLabels: ["aggregate-command-coverage"],
      testsNotRun: ["tests/unit.test.ts"],
      requiredChecksMissing: 1,
      ranCommands: ["npm test"],
      commandEnvelopes: [
        {
          command: "npm test",
          cwd: "<repo>",
          packageManager: "npm",
          packageRoot: ".",
          scriptName: "test",
          args: [],
          source: "reported",
          scopeStatus: "repo",
          exitCode: 0,
          classifierVersion: CURRENT_VERIFICATION_PROVENANCE.commandCoverageClassifierVersion
        }
      ],
      verificationProvenance: CURRENT_VERIFICATION_PROVENANCE,
      verificationCovered: 1,
      verificationMissing: 1
    });
  });

  it("fails when planned changed files or false-positive caps are missed", () => {
    const scored = scoreStructuredOutputForTest(
      fakeQueryResult("Structured data is intentionally noisy.", {
        selectedFiles: ["src/real.ts", "src/noise.ts"],
        plannedEditTargets: ["src/noise.ts"],
        tests: []
      }),
      {
        expectedFiles: ["src/real.ts"],
        expectedChangedFiles: ["src/real.ts"],
        expectedTests: ["tests/real.test.ts"],
        maxFalsePositiveFiles: 0
      }
    );

    expect(scored.passed).toBe(false);
    expect(scored.failures.join("\n")).toContain("planned changed-file recall");
    expect(scored.failures.join("\n")).toContain("false-positive files");
    expect(scored.failures.join("\n")).toContain("test recall");
  });
});

async function withoutRipgrep<T>(run: () => Promise<T>): Promise<T> {
  const gitPath = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  const binDir = await mkdtemp(path.join(os.tmpdir(), "codexa-eval-bin-"));
  await symlink(gitPath, path.join(binDir, "git"));
  const oldPath = process.env.PATH;
  process.env.PATH = binDir;
  try {
    return await run();
  } finally {
    process.env.PATH = oldPath;
  }
}

async function createExternalPackRepo(): Promise<string> {
  const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-external-pack-"));
  execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Codexa Eval"], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "codexa-eval@example.invalid"], { cwd: repo, stdio: "ignore" });
  await mkdir(path.join(repo, "src"), { recursive: true });
  await mkdir(path.join(repo, "tests"), { recursive: true });
  await writeFile(path.join(repo, "package.json"), JSON.stringify({ scripts: { test: "vitest run" } }, null, 2), "utf8");
  await writeFile(path.join(repo, "src/external.ts"), "export function makeExternalValue() {\n  return 'external'\n}\n", "utf8");
  await writeFile(path.join(repo, "tests/external.test.ts"), "import { makeExternalValue } from '../src/external'\ntest('external', () => expect(makeExternalValue()).toBe('external'))\n", "utf8");
  execFileSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "external historical fixture"], { cwd: repo, stdio: "ignore" });
  await buildIndex({ repoRoot: repo, writeArtifacts: true });
  return repo;
}

function externalPack(repoCommit: string, baselineCommands: string[][]): unknown {
  return {
    schemaVersion: 1,
    packId: "external-pack",
    repoCommit,
    tasks: [
      {
        id: "external-change-plan",
        suite: "external-fixture",
        task: "Change makeExternalValue without missing its test",
        tool: "change_plan",
        repoFixture: "external-pack-repo",
        setupPatch: [
          {
            path: "src/setup.ts",
            content: "export const setupDrift = true\n"
          }
        ],
        files: ["src/external.ts", "src/setup.ts"],
        expectedReadFirst: ["src/external.ts", "src/setup.ts", "tests/external.test.ts"],
        expectedChangedFiles: ["src/external.ts", "src/setup.ts"],
        expectedTests: ["tests/external.test.ts"],
        baselineCommands,
        expectedCodexaCalls: ["change_plan"],
        maxFalsePositiveFiles: 1
      }
    ]
  };
}

function dirtyFailurePack(repoCommit: string): unknown {
  return {
    schemaVersion: 1,
    packId: "dirty-failure-pack",
    repoCommit,
    tasks: [
      {
        id: "dirty-failure",
        task: "Use dirty patches without leaking failed setup edits",
        tool: "context_pack",
        files: ["src/external.ts"],
        dirtyPatch: [
          {
            path: "src/setup-dirty.ts",
            append: "export const leakedDirtyPatch = true\n"
          },
          {
            path: "src/external.ts",
            replace: [{ from: "missingExternalNeedle", to: "replacement" }]
          }
        ],
        expectedReadFirst: ["src/external.ts"],
        expectedCodexaCalls: ["context_pack"]
      }
    ]
  };
}

function fakeQueryResult(text: string, data: unknown): QueryResult {
  return {
    freshness: {
      schemaVersion: 1,
      snapshotId: "test",
      repoRoot: "/tmp/repo",
      gitRoot: "/tmp/repo",
      headCommit: "abc",
      indexedAt: "2026-04-11T00:00:00.000Z",
      dirtyFiles: [],
      dirtyFileHashes: {},
      indexedDirtyFileHashes: {},
      indexedDirtyFiles: [],
      missing: false,
      stale: false,
      reason: "fresh",
      parserErrorCount: 0
    },
    text,
    data,
    refresh: { refreshed: false }
  };
}
