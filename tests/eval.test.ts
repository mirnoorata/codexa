import { describe, expect, it } from "vitest";
import { runEval, scoreStructuredOutputForTest } from "../src/eval.js";
import type { QueryResult } from "../src/types.js";

describe("Codexa eval benchmark", () => {
  it("runs randomized synthetic holdouts with structured scoring", async () => {
    const result = await runEval("/srv/atlas", { autoRefresh: false }, { suite: "synthetic", seed: "unit-seed", failOnRefresh: true });
    const second = await runEval("/srv/atlas", { autoRefresh: false }, { suite: "synthetic", seed: "unit-seed-alt", failOnRefresh: true });

    expect(result.passed).toBe(true);
    expect(second.passed).toBe(true);
    expect(result.data.scenarios.length).toBeGreaterThanOrEqual(4);
    expect(second.data.scenarios.length).toBe(result.data.scenarios.length);
    expect(result.text).toContain("Anti-cheat controls");
    expect(result.data.scenarios.every((scenario) => scenario.metrics.refreshed === false)).toBe(true);
    expect(result.data.scenarios.some((scenario) => scenario.id === "synthetic-ts-impact-decoy-control")).toBe(true);
    expect(result.data.scenarios.some((scenario) => scenario.id === "synthetic-session-context-seedless")).toBe(true);
    expect(result.data.calibrationSummary).toBeTruthy();
    expect(Object.values(result.data.calibrationSummary.postEditVerdicts).reduce((sum, value) => sum + value, 0)).toBeGreaterThanOrEqual(1);
    expect(result.data.calibrationSummary.outcomeRecords.some((entry) => entry.startsWith(".codex/cache/codexa-outcomes/"))).toBe(true);
    const tsScenario = result.data.scenarios.find((scenario) => scenario.id === "synthetic-ts-impact-decoy-control");
    expect(tsScenario?.comparison.baselineFileCount).toBeGreaterThan(tsScenario?.comparison.codexaFileCount ?? 0);
    expect(tsScenario?.comparison.precisionDelta).toBeGreaterThanOrEqual(0);
  });

  it("uses a fresh synthetic seed by default to reduce fixture memorization", async () => {
    const first = await runEval("/srv/atlas", { autoRefresh: false }, { suite: "synthetic", failOnRefresh: true });
    const second = await runEval("/srv/atlas", { autoRefresh: false }, { suite: "synthetic", failOnRefresh: true });

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
});

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
