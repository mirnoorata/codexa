import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(root, "scripts", "agent-ab.mjs");
const config = path.join(root, "benchmarks", "agent-ab", "experiment.json");
const reportPath = path.join(root, "reports", "benchmarks", "v0.10.0-agent-ab-pilot-v7.json");
const reportSha256 = "80e1d15bcbcbee26467757f67bed3e60779ecdd5b9c4edf9df1709be14a35eb8";
const historicalControllerHash = "56c79dc6e9bf26dfc5e6ca2f929e499826544153f5f7aa0b33d40c392472b54f";
const historicalAnalyzerHash = "e9628f0d786c0ac40bc1c98fb8efcc41099e78465dfa9f072125bb471319b2fb";
const metricFields = [
  "inputTokens",
  "cacheTokens",
  "outputTokens",
  "costUsd",
  "agentElapsedMs",
  "controllerElapsedMs",
  "codexaIndexElapsedMs"
] as const;
const timestampFields = ["attemptStartedAt", "agentStartedAt", "agentFinishedAt"] as const;
const rewardNames = [
  "behavior",
  "changed_files",
  "changed_lines",
  "genericity",
  "public_tests",
  "regression",
  "scope",
  "verified_completion"
] as const;
const binaryRewardNames = [
  "behavior",
  "genericity",
  "public_tests",
  "regression",
  "scope",
  "verified_completion"
] as const;
const expectedAssignments = [
  {
    runId: "297b57be9c02b536cdc7",
    taskId: "path-target-normalization",
    taskName: "codexa-agent-ab/path-target-normalization",
    repetition: 1,
    arm: "treatment",
    order: 1
  },
  {
    runId: "f5797d386b208c79f937",
    taskId: "path-target-normalization",
    taskName: "codexa-agent-ab/path-target-normalization",
    repetition: 1,
    arm: "control",
    order: 2
  },
  {
    runId: "d002dc6307c9560f0dd1",
    taskId: "path-target-normalization",
    taskName: "codexa-agent-ab/path-target-normalization",
    repetition: 2,
    arm: "control",
    order: 1
  },
  {
    runId: "1d7db228b186258956c9",
    taskId: "path-target-normalization",
    taskName: "codexa-agent-ab/path-target-normalization",
    repetition: 2,
    arm: "treatment",
    order: 2
  }
] as const;

type Arm = "control" | "treatment";
type MetricField = (typeof metricFields)[number];
type TimestampField = (typeof timestampFields)[number];

interface CodexaUsage {
  status: string;
  codexaInvoked: boolean | null;
  codexaCallCount: number | null;
  callsByTool: Record<string, number> | null;
}

interface CodexaSetup {
  status: string;
  evidenceTrust?: string | null;
  codexaVersion?: string | null;
  versionMatchesCandidate?: boolean | null;
  indexExitCode?: number | null;
  indexElapsedMs?: number | null;
}

interface Outcome {
  runId: string;
  taskId: string;
  taskName: string;
  repetition: number;
  arm: Arm;
  order: number;
  started: boolean;
  finalized: boolean;
  observed: boolean;
  success: boolean | null;
  failureClass: string | null;
  protocolStatus: string;
  protocolFailure: string | null;
  rewards: Record<string, number>;
  inputTokens: number | null;
  cacheTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  agentElapsedMs: number | null;
  controllerElapsedMs: number | null;
  codexaIndexElapsedMs: number | null;
  attemptStartedAt: string | null;
  agentStartedAt: string | null;
  agentFinishedAt: string | null;
  codexaUsage: CodexaUsage;
  codexaSetup: CodexaSetup;
}

describe("archived agent A/B report", () => {
  it("is a complete protocol-bound pilot whose aggregates recompute from all registered outcomes", async () => {
    const validated = spawnSync(process.execPath, [script, "validate", "--config", config], {
      cwd: root,
      encoding: "utf8"
    });
    expect(validated.status, validated.stderr).toBe(0);
    const validation = JSON.parse(validated.stdout);
    const reportBytes = await readFile(reportPath);
    expect(createHash("sha256").update(reportBytes).digest("hex")).toBe(reportSha256);
    const report = JSON.parse(reportBytes.toString("utf8"));

    expect(validation).toMatchObject({
      schemaVersion: 1,
      experimentId: "codexa-agent-ab-pilot-v7",
      framework: { name: "harbor", version: "0.18.0" },
      runner: {
        agent: "codex",
        version: "0.144.1",
        kwargs: { reasoning_effort: "high", web_search: "disabled" }
      },
      candidate: { codexaVersion: "0.10.0" },
      registeredRuns: 4,
      primaryReward: "verified_completion",
      generalizationUnit: "task"
    });
    expect(report).toMatchObject({
      schemaVersion: 1,
      experimentId: validation.experimentId,
      configHash: validation.configHash,
      framework: validation.framework,
      harness: {
        controllerHash: historicalControllerHash,
        analyzerHash: historicalAnalyzerHash
      },
      candidate: validation.candidate,
      runner: validation.runner,
      agent: "codex",
      model: "openai/gpt-5.6-sol",
      status: "complete",
      protocolStatus: "valid",
      protocolFailures: [],
      confirmatory: false,
      claimStatus: "non-confirmatory-pilot",
      primaryReward: validation.primaryReward,
      generalizationUnit: "task",
      registeredTasks: 1,
      registeredRuns: 4,
      startedRuns: 4,
      finalizedRuns: 4,
      observedRuns: 4,
      neverStartedRuns: 0,
      completePairs: 2,
      registeredArtifacts: {
        tasks: validation.tasks,
        treatment: validation.treatment,
        inputs: validation.inputs
      }
    });
    expect(report.estimand).toBe(
      "intention-to-treat effect of offering the Codexa MCP plus Codexa workflow-instruction bundle on verified completion"
    );
    expect(report.treatmentDefinition).toEqual({
      control: "Codexa MCP and Codexa workflow instruction are not offered",
      treatment: "Codexa MCP and Codexa workflow instruction are offered as one bundle",
      adherencePolicy: "usage telemetry is descriptive only; no run is excluded for adherence or contamination"
    });
    expect(Number.isFinite(Date.parse(report.registeredAt))).toBe(true);

    expect(Array.isArray(report.outcomes)).toBe(true);
    const outcomes = report.outcomes as Outcome[];
    expect(outcomes).toHaveLength(expectedAssignments.length);
    expect(new Set(outcomes.map((outcome) => outcome.runId)).size).toBe(expectedAssignments.length);
    expect(outcomes.map(outcomeIdentity)).toEqual(expectedAssignments);

    for (const outcome of outcomes) {
      expect(outcome).toMatchObject({
        started: true,
        finalized: true,
        observed: true,
        protocolStatus: "valid",
        protocolFailure: null
      });
      expect(typeof outcome.success).toBe("boolean");
      expect(Object.keys(outcome.rewards).sort()).toEqual([...rewardNames]);
      for (const reward of binaryRewardNames) {
        expect([0, 1]).toContain(outcome.rewards[reward]);
      }
      expect(Number.isInteger(outcome.rewards.changed_files)).toBe(true);
      expect(outcome.rewards.changed_files).toBeGreaterThanOrEqual(0);
      expect(Number.isInteger(outcome.rewards.changed_lines)).toBe(true);
      expect(outcome.rewards.changed_lines).toBeGreaterThanOrEqual(0);
      expect(outcome.success).toBe(outcome.rewards[report.primaryReward] === 1);
      expect(outcome.failureClass === null).toBe(outcome.success === true);

      for (const field of metricFields.filter((field) => field !== "codexaIndexElapsedMs")) {
        expect(Number.isFinite(outcome[field]), `${outcome.runId} ${field}`).toBe(true);
        expect(outcome[field], `${outcome.runId} ${field}`).toBeGreaterThanOrEqual(0);
      }
      for (const field of timestampFields) {
        expect(typeof outcome[field], `${outcome.runId} ${field}`).toBe("string");
        expect(Number.isFinite(Date.parse(outcome[field] as string)), `${outcome.runId} ${field}`).toBe(true);
      }
      expect(Date.parse(outcome.attemptStartedAt as string)).toBeLessThanOrEqual(
        Date.parse(outcome.agentStartedAt as string)
      );
      expect(Date.parse(outcome.agentStartedAt as string)).toBeLessThanOrEqual(
        Date.parse(outcome.agentFinishedAt as string)
      );

      assertCodexaTelemetry(outcome);
    }

    expect(report.startedRuns).toBe(outcomes.filter((outcome) => outcome.started).length);
    expect(report.finalizedRuns).toBe(outcomes.filter((outcome) => outcome.finalized).length);
    expect(report.observedRuns).toBe(outcomes.filter((outcome) => outcome.observed).length);
    expect(report.neverStartedRuns).toBe(expectedAssignments.length - report.startedRuns);

    expect(Object.keys(report.arms).sort()).toEqual(["control", "treatment"]);
    for (const arm of ["control", "treatment"] as const) {
      const registered = expectedAssignments.filter((assignment) => assignment.arm === arm);
      const selected = outcomes.filter((outcome) => outcome.arm === arm);
      const started = selected.filter((outcome) => outcome.started);
      const finalized = selected.filter((outcome) => outcome.finalized);
      const successful = started.filter((outcome) => outcome.success === true);
      const evaluable = started.filter((outcome) => typeof outcome.success === "boolean");
      expect(report.arms[arm]).toMatchObject({
        registeredRuns: registered.length,
        runs: started.length,
        startedRuns: started.length,
        finalizedRuns: finalized.length,
        neverStartedRuns: registered.length - started.length,
        protocolInvalidRuns: started.filter((outcome) => outcome.protocolStatus === "invalid").length,
        successes: successful.length,
        failures: evaluable.length - successful.length,
        successRate: evaluable.length === 0 ? null : successful.length / evaluable.length,
        failureClasses: countFailureClasses(started)
      });
      expect(Object.keys(report.arms[arm].metrics).sort()).toEqual([...metricFields].sort());
      expect(Object.keys(report.arms[arm].completionConditionedMetrics).sort()).toEqual([...metricFields].sort());
      for (const field of metricFields) {
        expect(report.arms[arm].metrics[field]).toEqual(summarize(started, field));
        expect(report.arms[arm].completionConditionedMetrics[field]).toEqual(summarize(successful, field));
      }
      expect(Object.keys(report.arms[arm].rewardMetrics).sort()).toEqual([...rewardNames]);
      for (const reward of rewardNames) {
        expect(report.arms[arm].rewardMetrics[reward]).toEqual(summarizeRewards(started, reward));
      }
    }

    const pairs = pairOutcomes(outcomes);
    expect(pairs).toHaveLength(2);
    expect(report.completePairs).toBe(pairs.length);
    const discordance = summarizeDiscordance(pairs);
    expect(report.effect).not.toBeNull();
    expect(report.effect).toMatchObject({
      absoluteRiskDifference: report.arms.treatment.successRate - report.arms.control.successRate,
      treatmentOnlyPairs: discordance.treatmentOnly,
      controlOnlyPairs: discordance.controlOnly,
      bothPassPairs: discordance.bothPass,
      bothFailPairs: discordance.bothFail,
      taskClusteredBootstrap: {
        lower: null,
        upper: null,
        samples: 0,
        tasks: 1,
        confidenceLevel: 0.95,
        note: "at least two tasks are required; a one-task pilot is non-confirmatory"
      }
    });

    expect(report.treatmentFidelity.candidateVersion).toBe("0.10.0");
    for (const arm of ["control", "treatment"] as const) {
      expect(report.treatmentFidelity[arm]).toMatchObject(summarizeFidelity(outcomes, arm));
    }

    expect(report.runWindow).toEqual({
      firstAttemptStartedAt: endpoint(outcomes, "attemptStartedAt", "first"),
      lastAttemptStartedAt: endpoint(outcomes, "attemptStartedAt", "last"),
      firstAgentStartedAt: endpoint(outcomes, "agentStartedAt", "first"),
      lastAgentFinishedAt: endpoint(outcomes, "agentFinishedAt", "last")
    });
    for (const value of Object.values(report.runWindow)) {
      expect(typeof value).toBe("string");
      expect(Number.isFinite(Date.parse(value as string))).toBe(true);
    }
    expect(Date.parse(report.registeredAt)).toBeLessThanOrEqual(Date.parse(report.runWindow.firstAttemptStartedAt));
    expect(Date.parse(report.runWindow.firstAttemptStartedAt)).toBeLessThanOrEqual(
      Date.parse(report.runWindow.lastAttemptStartedAt)
    );
    expect(Date.parse(report.runWindow.firstAgentStartedAt)).toBeLessThanOrEqual(
      Date.parse(report.runWindow.lastAgentFinishedAt)
    );
  });
});

function outcomeIdentity(outcome: Outcome): Record<string, string | number> {
  return {
    runId: outcome.runId,
    taskId: outcome.taskId,
    taskName: outcome.taskName,
    repetition: outcome.repetition,
    arm: outcome.arm,
    order: outcome.order
  };
}

function summarize(outcomes: Outcome[], field: MetricField): Record<string, number | null> {
  const present = outcomes.map((outcome) => outcome[field]).filter((value): value is number => Number.isFinite(value));
  return summarizeValues(present, outcomes.length);
}

function summarizeRewards(outcomes: Outcome[], reward: string): Record<string, number | null> {
  const present = outcomes.map((outcome) => outcome.rewards[reward]).filter((value) => Number.isFinite(value));
  return summarizeValues(present, outcomes.length);
}

function summarizeValues(present: number[], eligibleRuns: number): Record<string, number | null> {
  const total = present.length === 0 ? null : present.reduce((sum, value) => sum + value, 0);
  return {
    eligibleRuns,
    presentRuns: present.length,
    missingRuns: eligibleRuns - present.length,
    total,
    mean: total === null ? null : total / present.length
  };
}

function countFailureClasses(outcomes: Outcome[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const outcome of outcomes) {
    if (outcome.failureClass) {
      counts[outcome.failureClass] = (counts[outcome.failureClass] ?? 0) + 1;
    }
  }
  return counts;
}

function pairOutcomes(outcomes: Outcome[]): Array<{ control: Outcome; treatment: Outcome }> {
  const grouped = new Map<string, Partial<Record<Arm, Outcome>>>();
  for (const outcome of outcomes) {
    const key = `${outcome.taskId}\0${outcome.repetition}`;
    const pair = grouped.get(key) ?? {};
    expect(pair[outcome.arm], `duplicate ${outcome.arm} outcome for ${key}`).toBeUndefined();
    pair[outcome.arm] = outcome;
    grouped.set(key, pair);
  }
  const expectedPairKeys = [...new Set(
    expectedAssignments.map((assignment) => `${assignment.taskId}\0${assignment.repetition}`)
  )].sort();
  expect([...grouped.keys()].sort()).toEqual(expectedPairKeys);
  return [...grouped.values()].map((pair) => {
    expect(pair.control).toBeDefined();
    expect(pair.treatment).toBeDefined();
    return pair as { control: Outcome; treatment: Outcome };
  });
}

function summarizeDiscordance(pairs: Array<{ control: Outcome; treatment: Outcome }>): Record<string, number> {
  const summary = { treatmentOnly: 0, controlOnly: 0, bothPass: 0, bothFail: 0 };
  for (const pair of pairs) {
    if (pair.treatment.success && pair.control.success) {
      summary.bothPass += 1;
    } else if (pair.treatment.success) {
      summary.treatmentOnly += 1;
    } else if (pair.control.success) {
      summary.controlOnly += 1;
    } else {
      summary.bothFail += 1;
    }
  }
  return summary;
}

function assertCodexaTelemetry(outcome: Outcome): void {
  expect(outcome.codexaUsage.status).toBe("observed");
  expect(outcome.codexaUsage.callsByTool).not.toBeNull();
  const callsByTool = outcome.codexaUsage.callsByTool ?? {};
  const callCount = Object.values(callsByTool).reduce((sum, count) => sum + count, 0);
  expect(Object.values(callsByTool).every((count) => Number.isInteger(count) && count > 0)).toBe(true);
  expect(outcome.codexaUsage.codexaCallCount).toBe(callCount);
  expect(outcome.codexaUsage.codexaInvoked).toBe(callCount > 0);

  if (outcome.arm === "control") {
    expect(outcome.codexaSetup).toEqual({ status: "missing" });
    expect(outcome.codexaIndexElapsedMs).toBeNull();
    return;
  }

  expect(outcome.codexaSetup).toMatchObject({
    status: "observed",
    evidenceTrust: "agent-reported"
  });
  expect(typeof outcome.codexaSetup.codexaVersion).toBe("string");
  expect(typeof outcome.codexaSetup.versionMatchesCandidate).toBe("boolean");
  expect(Number.isInteger(outcome.codexaSetup.indexExitCode)).toBe(true);
  expect(Number.isFinite(outcome.codexaSetup.indexElapsedMs)).toBe(true);
  expect(outcome.codexaSetup.indexElapsedMs).toBe(outcome.codexaIndexElapsedMs);
  expect(outcome.codexaIndexElapsedMs).toBeGreaterThanOrEqual(0);
}

function summarizeFidelity(outcomes: Outcome[], arm: Arm): Record<string, unknown> {
  const selected = outcomes.filter((outcome) => outcome.arm === arm && outcome.started);
  const observed = selected.filter((outcome) => outcome.codexaUsage.status === "observed");
  const invoked = observed.filter((outcome) => outcome.codexaUsage.codexaInvoked);
  const setupObserved = selected.filter((outcome) => outcome.codexaSetup.status === "observed");
  return {
    startedRuns: selected.length,
    traceObservedRuns: observed.length,
    traceUnknownRuns: selected.length - observed.length,
    codexaInvokedRuns: invoked.length,
    codexaCallsByTool: mergeCallCounts(observed),
    noCodexaInvocationObservedRuns: observed.length - invoked.length,
    contaminationRuns: arm === "control" ? invoked.length : 0,
    nonadherentRuns: arm === "treatment" ? observed.length - invoked.length : 0,
    setupObservedRuns: setupObserved.length,
    setupSuccessfulRuns: setupObserved.filter((outcome) => outcome.codexaSetup.indexExitCode === 0).length,
    setupFailedRuns: setupObserved.filter(
      (outcome) =>
        typeof outcome.codexaSetup.indexExitCode === "number"
        && Number.isInteger(outcome.codexaSetup.indexExitCode)
        && outcome.codexaSetup.indexExitCode !== 0
    ).length,
    setupVersionMismatchRuns: setupObserved.filter(
      (outcome) => outcome.codexaSetup.versionMatchesCandidate === false
    ).length
  };
}

function mergeCallCounts(outcomes: Outcome[]): Record<string, number> {
  const merged: Record<string, number> = {};
  for (const outcome of outcomes) {
    for (const [tool, count] of Object.entries(outcome.codexaUsage.callsByTool ?? {})) {
      merged[tool] = (merged[tool] ?? 0) + count;
    }
  }
  return merged;
}

function endpoint(
  outcomes: Outcome[],
  field: TimestampField,
  position: "first" | "last"
): string | null {
  const timestamps = outcomes
    .map((outcome) => outcome[field])
    .filter((value): value is string => typeof value === "string")
    .sort();
  return position === "first" ? timestamps[0] ?? null : timestamps.at(-1) ?? null;
}
