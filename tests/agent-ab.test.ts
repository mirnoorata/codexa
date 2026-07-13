import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(root, "scripts", "agent-ab.mjs");
const config = path.join(root, "benchmarks", "agent-ab", "experiment.json");

describe("agent A/B black-box harness", () => {
  it("validates the pinned external experiment without importing Codexa scoring", () => {
    const result = run(["validate", "--config", config]);

    expect(result.status).toBe(0);
    const value = JSON.parse(result.stdout);
    expect(value.framework).toEqual({ name: "harbor", version: "0.18.0" });
    expect(value.harness).toMatchObject({ controllerHash: expect.stringMatching(/^[a-f0-9]{64}$/), analyzerHash: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(value.primaryReward).toBe("verified_completion");
    expect(value.generalizationUnit).toBe("task");
    expect(value.registeredRuns).toBe(4);
  });

  it("rejects unknown configuration fields and task path escapes", async () => {
    const fixture = await copyBenchmark();
    const fixtureConfig = path.join(fixture, "experiment.json");
    const value = JSON.parse(await readFile(fixtureConfig, "utf8"));
    value.unregisteredClaim = true;
    await writeFile(fixtureConfig, `${JSON.stringify(value, null, 2)}\n`, "utf8");

    const unknown = run(["validate", "--config", fixtureConfig]);
    expect(unknown.status).toBe(1);
    expect(unknown.stderr).toContain("unknown field");

    delete value.unregisteredClaim;
    value.tasks[0].path = "../outside";
    await writeFile(fixtureConfig, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    const escape = run(["validate", "--config", fixtureConfig]);
    expect(escape.status).toBe(1);
    expect(escape.stderr).toContain("unsafe path segment");
  });

  it("registers deterministic paired assignments and refuses silent replacement", async () => {
    const output = await mkdtemp(path.join(os.tmpdir(), "codexa-agent-ab-registration-"));
    const env = { ...process.env, TEST_SECRET_VALUE: "must-not-be-recorded" };
    const args = ["register", "--config", config, "--output", output, "--agent", "codex", "--model", "openai/example-model"];

    const first = run(args, env);
    expect(first.status).toBe(0);
    const registration = JSON.parse(await readFile(path.join(output, "registration.json"), "utf8"));
    expect(registration.assignments).toHaveLength(4);
    expect(new Set(registration.assignments.map((entry: { arm: string }) => entry.arm))).toEqual(new Set(["control", "treatment"]));
    expect(JSON.stringify(registration)).not.toContain("must-not-be-recorded");

    const second = run(args, env);
    expect(second.status).toBe(1);
    expect(second.stderr).toContain("registration already exists");

    const resumed = run([...args, "--resume"], env);
    expect(resumed.status).toBe(0);
    expect(JSON.parse(resumed.stdout).assignments).toEqual(registration.assignments);
  });

  it("counts started-unfinalized and failed arms as intention-to-treat failures", async () => {
    const output = await registerExperiment();
    const registration = JSON.parse(await readFile(path.join(output, "registration.json"), "utf8"));
    const treatment = registration.assignments.find((entry: { arm: string; repetition: number }) => entry.arm === "treatment" && entry.repetition === 1);
    const control = registration.assignments.find((entry: { arm: string; repetition: number }) => entry.arm === "control" && entry.repetition === 1);
    if (!treatment || !control) {
      throw new Error("registration did not contain the expected pair");
    }
    await writeObservedRun(output, treatment, { verified_completion: 1, changed_files: 1 });
    await writeObservedRun(output, control, undefined, { exitCode: 17 });
    for (const assignment of registration.assignments) {
      if (assignment.runId !== treatment.runId && assignment.runId !== control.runId) {
        await writeAttempt(output, assignment, registration);
      }
    }

    const result = run(["analyze", "--config", config, "--output", output]);
    expect(result.status).toBe(0);
    const summary = JSON.parse(result.stdout);
    expect(summary.registeredRuns).toBe(4);
    expect(summary.startedRuns).toBe(4);
    expect(summary.observedRuns).toBe(2);
    expect(summary.neverStartedRuns).toBe(0);
    expect(summary.arms.treatment.successes).toBe(1);
    expect(summary.arms.control.successes).toBe(0);
    expect(summary.arms.control.failureClasses["harbor-error"]).toBe(1);
    expect(summary.arms.control.failureClasses["started-unfinalized"]).toBe(1);
    expect(summary.arms.treatment.failureClasses["started-unfinalized"]).toBe(1);
    expect(summary.effect.treatmentOnlyPairs).toBe(1);
    expect(summary.effect.bothFailPairs).toBe(1);
    expect(summary.effect.absoluteRiskDifference).toBe(0.5);
    expect(summary.claimStatus).toBe("non-confirmatory-pilot");
  });

  it("uses verifier rewards rather than successful-looking agent prose", async () => {
    const output = await registerExperiment();
    const registration = JSON.parse(await readFile(path.join(output, "registration.json"), "utf8"));
    for (const assignment of registration.assignments) {
      await writeObservedRun(output, assignment, assignment.arm === "treatment" ? { behavior: 1 } : { verified_completion: 0 }, {
        agentMetadata: { finalAnswer: "All checks passed; task complete." }
      });
    }

    const result = run(["analyze", "--config", config, "--output", output]);
    expect(result.status).toBe(0);
    const summary = JSON.parse(result.stdout);
    expect(summary.arms.control.successes).toBe(0);
    expect(summary.arms.treatment.successes).toBe(0);
    expect(summary.arms.treatment.failureClasses["missing-primary-reward"]).toBe(2);
  });

  it("parses the Harbor 0.18 aggregate job and per-trial result boundary", async () => {
    const output = await registerExperiment();
    const registration = JSON.parse(await readFile(path.join(output, "registration.json"), "utf8"));
    const assignment = registration.assignments.find((entry: { arm: string }) => entry.arm === "treatment");
    if (!assignment) {
      throw new Error("registration did not contain a treatment assignment");
    }
    await writeObservedRun(output, assignment, { verified_completion: 1, scope: 1 });

    const result = run(["analyze", "--config", config, "--output", output]);
    expect(result.status).toBe(0);
    const summary = JSON.parse(result.stdout);
    const outcome = summary.outcomes.find((entry: { runId: string }) => entry.runId === assignment.runId);
    expect(outcome).toMatchObject({
      success: true,
      failureClass: null,
      rewards: { verified_completion: 1, scope: 1 },
      inputTokens: 100,
      cacheTokens: 10,
      outputTokens: 20,
      costUsd: 0.01,
      agentElapsedMs: 250
    });
  });
});

function run(args: string[], env = process.env): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, [script, ...args], { cwd: root, env, encoding: "utf8" });
}

async function copyBenchmark(): Promise<string> {
  const parent = await mkdtemp(path.join(os.tmpdir(), "codexa-agent-ab-config-"));
  const target = path.join(parent, "agent-ab");
  await cp(path.join(root, "benchmarks", "agent-ab"), target, { recursive: true });
  return target;
}

async function registerExperiment(): Promise<string> {
  const output = await mkdtemp(path.join(os.tmpdir(), "codexa-agent-ab-analysis-"));
  const result = run([
    "register",
    "--config",
    config,
    "--output",
    output,
    "--agent",
    "codex",
    "--model",
    "openai/example-model"
  ]);
  expect(result.status).toBe(0);
  return output;
}

async function writeObservedRun(
  output: string,
  assignment: { runId: string; taskId: string; taskName: string; repetition: number; arm: string; order: number; jobName: string },
  rewards?: Record<string, number>,
  options: { exitCode?: number; agentMetadata?: Record<string, unknown> } = {}
): Promise<void> {
  const registration = JSON.parse(await readFile(path.join(output, "registration.json"), "utf8"));
  await writeAttempt(output, assignment, registration);
  const runs = path.join(output, "runs");
  const job = path.join(output, "jobs", assignment.jobName);
  await mkdir(runs, { recursive: true });
  await mkdir(job, { recursive: true });
  const trialName = `${assignment.taskId}__fixture`;
  const jobId = `job-${assignment.runId}`;
  const trial = path.join(job, trialName);
  await mkdir(trial, { recursive: true });
  await writeFile(
    path.join(job, "result.json"),
    `${JSON.stringify({
      id: jobId,
      started_at: "2026-07-13T00:00:00.000Z",
      finished_at: "2026-07-13T00:00:01.000Z",
      n_total_trials: 1,
      stats: {
        n_completed_trials: 1,
        n_errored_trials: 0,
        evals: {}
      }
    })}\n`,
    "utf8"
  );
  await writeFile(
    path.join(trial, "result.json"),
    `${JSON.stringify({
      id: `trial-${assignment.runId}`,
      task_name: assignment.taskName,
      trial_name: trialName,
      config: {
        job_id: jobId,
        task: {
          path: path.resolve(
            output,
            registration.inputs.tasks.find((entry: { id: string }) => entry.id === assignment.taskId).path
          )
        },
        agent: {
          name: registration.agent,
          model_name: registration.model,
          kwargs: { version: registration.runner.version, ...registration.runner.kwargs },
          mcp_servers: expectedMcpServers(assignment.arm)
        },
        extra_instruction_paths: expectedInstructionPaths(assignment.arm, output, registration)
      },
      verifier_result: rewards === undefined ? null : { rewards },
      agent_result: {
        n_input_tokens: 100,
        n_cache_tokens: 10,
        n_output_tokens: 20,
        cost_usd: 0.01,
        metadata: options.agentMetadata ?? null
      },
      agent_execution: {
        started_at: "2026-07-13T00:00:00.000Z",
        finished_at: "2026-07-13T00:00:00.250Z"
      },
      exception_info: null
    })}\n`,
    "utf8"
  );
  await writeFile(
    path.join(runs, `${assignment.runId}.json`),
    `${JSON.stringify({
      schemaVersion: 1,
      runId: assignment.runId,
      taskId: assignment.taskId,
      repetition: assignment.repetition,
      arm: assignment.arm,
      order: assignment.order,
      exitCode: options.exitCode ?? 0,
      timedOut: false,
      controllerElapsedMs: 500,
      jobResultPath: path.posix.join("jobs", assignment.jobName, "result.json")
    })}\n`,
    "utf8"
  );
}

async function writeAttempt(
  output: string,
  assignment: { runId: string; taskId: string; taskName: string; repetition: number; arm: string; order: number; jobName: string },
  registration: Record<string, unknown>
): Promise<void> {
  const attempts = path.join(output, "attempts");
  await mkdir(attempts, { recursive: true });
  await writeFile(
    path.join(attempts, `${assignment.runId}.json`),
    `${JSON.stringify({
      schemaVersion: 1,
      experimentId: registration.experimentId,
      configHash: registration.configHash,
      agent: registration.agent,
      model: registration.model,
      harness: registration.harness,
      runner: registration.runner,
      runId: assignment.runId,
      taskId: assignment.taskId,
      taskName: assignment.taskName,
      repetition: assignment.repetition,
      arm: assignment.arm,
      order: assignment.order,
      jobName: assignment.jobName,
      startedAt: "2026-07-13T00:00:00.000Z"
    })}\n`,
    "utf8"
  );
}

function expectedMcpServers(arm: string): Array<Record<string, unknown>> {
  return arm === "control"
    ? []
    : [{
        name: "codexa",
        transport: "stdio",
        url: null,
        command: "/opt/codexa-agent-ab/start-codexa-mcp",
        args: []
      }];
}

function expectedInstructionPaths(
  arm: string,
  output: string,
  registration: { inputs: { treatment: { extraInstruction: string } } }
): string[] {
  return arm === "control"
    ? []
    : [path.resolve(output, registration.inputs.treatment.extraInstruction)];
}
