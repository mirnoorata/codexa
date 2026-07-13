import { mkdir, mkdtemp, readFile, symlink, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
// The harness is intentionally plain ESM so it can run without the TypeScript build.
// @ts-expect-error the JavaScript experiment module does not publish declarations
import { analyzeAgentAb } from "../scripts/agent-ab-analysis.mjs";

type Arm = "control" | "treatment";
type Assignment = {
  runId: string;
  taskId: string;
  taskName: string;
  repetition: number;
  arm: Arm;
  order: number;
  jobName: string;
};
type PostEditStepFixture = {
  [key: string]: unknown;
  observation: {
    results: Array<{ source_call_id: string; content: unknown }>;
  };
};
const EXPERIMENT_ID = "analysis-validity-test";
const CONFIG_HASH = "config-hash";
const AGENT = "codex";
const MODEL = "openai/test-model";
const RUNNER = { agent: "codex", version: "0.144.1", kwargs: { reasoning_effort: "high", web_search: "disabled" } };
const HARNESS = { controllerHash: "controller-hash", analyzerHash: "analyzer-hash" };

describe("agent A/B analysis validity", () => {
  it("does not turn never-started assignments into ITT failures", async () => {
    const experiment = await createExperiment(["task-a"]);
    const control = findAssignment(experiment.assignments, "task-a", "control");
    await writeAttempt(experiment.output, control);

    const summary = analyzeAgentAb(experiment);
    const treatmentOutcome = summary.outcomes.find((outcome: { arm: Arm }) => outcome.arm === "treatment");
    const controlOutcome = summary.outcomes.find((outcome: { arm: Arm }) => outcome.arm === "control");

    expect(summary.status).toBe("incomplete");
    expect(summary.effect).toBeNull();
    expect(summary.neverStartedRuns).toBe(1);
    expect(controlOutcome).toMatchObject({ started: true, finalized: false, success: false, failureClass: "started-unfinalized" });
    expect(treatmentOutcome).toMatchObject({ started: false, finalized: false, success: null, failureClass: null });
    expect(summary.arms.control.failures).toBe(1);
    expect(summary.arms.treatment.failures).toBe(0);
  });

  it("requires the pre-spawn journal and exact assignment binding", async () => {
    const missingJournal = await createExperiment(["task-a"]);
    const missingControl = findAssignment(missingJournal.assignments, "task-a", "control");
    await writeFinalizedRun(missingJournal.output, missingControl, { writeAttemptJournal: false });
    expect(() => analyzeAgentAb(missingJournal)).toThrow("missing its pre-spawn attempt journal");

    const mismatched = await createExperiment(["task-a"]);
    const control = findAssignment(mismatched.assignments, "task-a", "control");
    await writeAttempt(mismatched.output, control);
    await writeRunMetadata(mismatched.output, control, { arm: "treatment" });
    expect(() => analyzeAgentAb(mismatched)).toThrow("mismatched arm");
  });

  it("rejects a swapped job path and does not accept a mismatched Harbor trial", async () => {
    const swapped = await createExperiment(["task-a"]);
    const swappedControl = findAssignment(swapped.assignments, "task-a", "control");
    await writeAttempt(swapped.output, swappedControl);
    await writeRunMetadata(swapped.output, swappedControl, { jobResultPath: "jobs/a-sibling-job/result.json" });
    expect(() => analyzeAgentAb(swapped)).toThrow("is not bound to registered job");

    const wrongTrial = await createExperiment(["task-a"]);
    for (const assignment of wrongTrial.assignments) {
      await writeFinalizedRun(wrongTrial.output, assignment, {
        taskName: assignment.arm === "control" ? "codexa-agent-ab/not-the-registered-task" : undefined,
        rewards: { verified_completion: 1 }
      });
    }
    const summary = analyzeAgentAb(wrongTrial);
    const controlOutcome = summary.outcomes.find((outcome: { arm: Arm }) => outcome.arm === "control");
    expect(controlOutcome).toMatchObject({ success: null, failureClass: null, protocolStatus: "invalid" });
    expect(summary.protocolStatus).toBe("invalid");
    expect(summary.effect).toBeNull();
  });

  it("binds each Harbor trial to its exact registered immutable task snapshot", async () => {
    const experiment = await createExperiment(["task-a", "task-b"]);
    for (const assignment of experiment.assignments) {
      await writeFinalizedRun(experiment.output, assignment, {
        taskPath: assignment.taskId === "task-a" && assignment.arm === "control"
          ? expectedTaskPath(experiment.output, "task-b")
          : undefined
      });
    }

    const summary = analyzeAgentAb(experiment);
    const mismatched = summary.outcomes.find((outcome: { runId: string }) => outcome.runId === "task-a-control");
    const sibling = summary.outcomes.find((outcome: { runId: string }) => outcome.runId === "task-b-control");

    expect(mismatched).toMatchObject({
      success: null,
      failureClass: null,
      protocolStatus: "invalid",
      protocolFailure: "trial task path does not match the registered immutable snapshot for task-a"
    });
    expect(sibling).toMatchObject({ success: true, protocolStatus: "valid" });
    expect(summary.protocolStatus).toBe("invalid");
    expect(summary.effect).toBeNull();
  });

  it("binds aggregate and trial job identity and rejects symlinked trial results", async () => {
    const mismatchedJob = await createExperiment(["task-a"]);
    for (const assignment of mismatchedJob.assignments) {
      await writeFinalizedRun(mismatchedJob.output, assignment, {
        trialJobId: assignment.arm === "control" ? "a-different-job" : undefined
      });
    }
    const mismatchedSummary = analyzeAgentAb(mismatchedJob);
    const mismatchedControl = mismatchedSummary.outcomes.find((outcome: { arm: Arm }) => outcome.arm === "control");
    expect(mismatchedControl).toMatchObject({ success: null, failureClass: null, protocolStatus: "invalid" });
    expect(mismatchedSummary.effect).toBeNull();

    const symlinked = await createExperiment(["task-a"]);
    for (const assignment of symlinked.assignments) {
      await writeFinalizedRun(symlinked.output, assignment);
    }
    const control = findAssignment(symlinked.assignments, "task-a", "control");
    const resultPath = trialResultPath(symlinked.output, control);
    const targetPath = path.join(symlinked.output, "agent-controlled-result.json");
    await writeFile(targetPath, await readFile(resultPath));
    await unlink(resultPath);
    await symlink(targetPath, resultPath);

    const symlinkSummary = analyzeAgentAb(symlinked);
    const symlinkControl = symlinkSummary.outcomes.find((outcome: { arm: Arm }) => outcome.arm === "control");
    expect(symlinkControl).toMatchObject({ success: null, failureClass: null, protocolStatus: "invalid" });
    expect(symlinkSummary.effect).toBeNull();

    const malformed = await createExperiment(["task-a"]);
    for (const assignment of malformed.assignments) {
      await writeFinalizedRun(malformed.output, assignment);
    }
    const malformedControl = findAssignment(malformed.assignments, "task-a", "control");
    await writeFile(path.join(malformed.output, "jobs", malformedControl.jobName, "result.json"), "not-json\n", "utf8");
    const malformedSummary = analyzeAgentAb(malformed);
    expect(malformedSummary.protocolStatus).toBe("invalid");
    expect(malformedSummary.effect).toBeNull();
    expect(malformedSummary.protocolFailures[0].reason).toContain("cannot establish evaluator result schema");
  });

  it("invalidates the protocol instead of scoring a misconfigured arm as a product failure", async () => {
    const experiment = await createExperiment(["task-a"]);
    const control = findAssignment(experiment.assignments, "task-a", "control");
    const treatment = findAssignment(experiment.assignments, "task-a", "treatment");
    await writeFinalizedRun(experiment.output, control);
    await writeFinalizedRun(experiment.output, treatment, { mcpServers: [] });

    const summary = analyzeAgentAb(experiment);
    const treatmentOutcome = summary.outcomes.find((outcome: { arm: Arm }) => outcome.arm === "treatment");

    expect(summary.status).toBe("complete");
    expect(summary.protocolStatus).toBe("invalid");
    expect(summary.claimStatus).toBe("invalid-protocol-no-effect-estimate");
    expect(summary.effect).toBeNull();
    expect(treatmentOutcome).toMatchObject({
      success: null,
      failureClass: null,
      protocolStatus: "invalid"
    });
    expect(summary.arms.treatment.failures).toBe(0);

    const wrongModel = await createExperiment(["task-a"]);
    for (const assignment of wrongModel.assignments) {
      await writeFinalizedRun(wrongModel.output, assignment, {
        modelName: assignment.arm === "control" ? "openai/not-the-registered-model" : undefined
      });
    }
    const wrongModelSummary = analyzeAgentAb(wrongModel);
    expect(wrongModelSummary.protocolStatus).toBe("invalid");
    expect(wrongModelSummary.effect).toBeNull();
    expect(wrongModelSummary.protocolFailures[0].reason).toContain("does not match registered model");
  });

  it("binds exact runner kwargs and treatment instruction identity", async () => {
    const wrongKwargs = await createExperiment(["task-a"]);
    for (const assignment of wrongKwargs.assignments) {
      await writeFinalizedRun(wrongKwargs.output, assignment, {
        runnerKwargs: assignment.arm === "control"
          ? { version: RUNNER.version, reasoning_effort: "low", web_search: "disabled" }
          : undefined
      });
    }
    const wrongKwargsSummary = analyzeAgentAb(wrongKwargs);
    expect(wrongKwargsSummary.protocolStatus).toBe("invalid");
    expect(wrongKwargsSummary.effect).toBeNull();
    expect(wrongKwargsSummary.protocolFailures[0].reason).toContain("runner kwargs");

    const wrongInstruction = await createExperiment(["task-a"]);
    for (const assignment of wrongInstruction.assignments) {
      await writeFinalizedRun(wrongInstruction.output, assignment, {
        extraInstructionPaths: assignment.arm === "treatment"
          ? [path.join(wrongInstruction.output, "other", "codexa-instructions.md")]
          : undefined
      });
    }
    const wrongInstructionSummary = analyzeAgentAb(wrongInstruction);
    expect(wrongInstructionSummary.protocolStatus).toBe("invalid");
    expect(wrongInstructionSummary.effect).toBeNull();
    expect(wrongInstructionSummary.protocolFailures[0].reason).toContain("workflow-instruction bundle");

  });

  it("keeps agent-reported setup telemetry descriptive even when it claims the wrong version", async () => {
    const wrongVersion = await createExperiment(["task-a"]);
    for (const assignment of wrongVersion.assignments) {
      await writeFinalizedRun(wrongVersion.output, assignment, {
        codexaSetup: assignment.arm === "treatment"
          ? { codexaVersion: "0.9.0", indexExitCode: 0, indexElapsedMs: 75 }
          : undefined
      });
    }
    const wrongVersionSummary = analyzeAgentAb(wrongVersion);
    const treatment = wrongVersionSummary.outcomes.find((outcome: { arm: Arm }) => outcome.arm === "treatment");
    expect(wrongVersionSummary.protocolStatus).toBe("valid");
    expect(wrongVersionSummary.effect).not.toBeNull();
    expect(wrongVersionSummary.protocolFailures).toEqual([]);
    expect(treatment).toMatchObject({
      success: true,
      protocolStatus: "valid",
      codexaSetup: {
        status: "observed",
        evidenceTrust: "agent-reported",
        codexaVersion: "0.9.0",
        versionMatchesCandidate: false
      }
    });
    expect(wrongVersionSummary.treatmentFidelity.treatment).toMatchObject({
      setupVersionMismatchRuns: 1,
      note: "agent-reported trajectory and setup telemetry are descriptive and never change ITT inclusion"
    });
  });

  it("uses the configured confidence label and marks a one-task run non-confirmatory", async () => {
    const experiment = await createExperiment(["task-a"], 0.9);
    const control = findAssignment(experiment.assignments, "task-a", "control");
    const treatment = findAssignment(experiment.assignments, "task-a", "treatment");
    await writeFinalizedRun(experiment.output, control, {
      rewards: { verified_completion: 0 },
      agentResult: {}
    });
    await writeFinalizedRun(experiment.output, treatment, {
      rewards: { verified_completion: 1, treatment_only_metric: 7 },
      agentResult: { n_input_tokens: 120, n_cache_tokens: 40, n_output_tokens: 30, cost_usd: 0.02 }
    });

    const summary = analyzeAgentAb(experiment);
    const markdown = await readFile(path.join(experiment.output, "summary.md"), "utf8");

    expect(summary.status).toBe("complete");
    expect(summary.confirmatory).toBe(false);
    expect(summary.claimStatus).toBe("non-confirmatory-pilot");
    expect(summary.configHash).toBe(CONFIG_HASH);
    expect(summary.registeredArtifacts).toEqual({
      tasks: [{ id: "task-a", name: "agent-ab-validity/task-a", hash: "hash-task-a" }],
      treatment: { mcpConfigHash: "mcp-hash", extraInstructionHash: "instruction-hash" },
      inputs: expectedInputs()
    });
    expect(summary.harness).toEqual(HARNESS);
    expect(summary.registeredAt).toBe("2026-07-13T00:00:00.000Z");
    expect(summary.runWindow).toEqual({
      firstAttemptStartedAt: "2026-07-13T00:00:00.000Z",
      lastAttemptStartedAt: "2026-07-13T00:00:00.000Z",
      firstAgentStartedAt: "2026-07-13T00:00:00.000Z",
      lastAgentFinishedAt: "2026-07-13T00:00:00.250Z"
    });
    expect(summary.effect.taskClusteredBootstrap.confidenceLevel).toBe(0.9);
    expect(markdown).toContain("Task-clustered 90% interval");
    expect(markdown).not.toContain("McNemar");
    expect(summary.arms.control.metrics.inputTokens).toEqual({
      eligibleRuns: 1,
      presentRuns: 0,
      missingRuns: 1,
      total: null,
      mean: null
    });
    expect(summary.arms.treatment.metrics.inputTokens.mean).toBe(120);
    expect(summary.arms.treatment.metrics.cacheTokens.mean).toBe(40);
    expect(summary.arms.treatment.rewardMetrics.verified_completion).toEqual({
      eligibleRuns: 1,
      presentRuns: 1,
      missingRuns: 0,
      total: 1,
      mean: 1
    });
    expect(summary.arms.control.rewardMetrics.treatment_only_metric).toEqual({
      eligibleRuns: 1,
      presentRuns: 0,
      missingRuns: 1,
      total: null,
      mean: null
    });
    expect(summary.arms.treatment.completionConditionedMetrics.inputTokens).toMatchObject({
      eligibleRuns: 1,
      presentRuns: 1,
      missingRuns: 0,
      mean: 120
    });
    expect(summary.arms.control.completionConditionedMetrics.inputTokens.eligibleRuns).toBe(0);
  });

  it("reports structured adherence and contamination without excluding outcomes", async () => {
    const experiment = await createExperiment(["task-a"]);
    const control = findAssignment(experiment.assignments, "task-a", "control");
    const treatment = findAssignment(experiment.assignments, "task-a", "treatment");
    await writeFinalizedRun(experiment.output, control, {
      rewards: { verified_completion: 1 },
      trajectory: {
        schema_version: "ATIF-v1.7",
        steps: [
          {
            is_copied_context: true,
            tool_calls: [{
              tool_call_id: "copied-control",
              function_name: "mcp__codexa__task_brief",
              arguments: { task: "prior interaction" }
            }]
          },
          {
            tool_calls: [{
              tool_call_id: "call-control",
              function_name: "shell",
              arguments: { command: "echo codexa brief . --task check" }
            }]
          }
        ]
      }
    });
    await writeFinalizedRun(experiment.output, treatment, {
      rewards: { verified_completion: 1 },
      codexaSetup: { codexaVersion: "0.10.0", indexExitCode: 0, indexElapsedMs: 75 },
      trajectory: {
        schema_version: "ATIF-v1.7",
        steps: [{
          tool_calls: [{
            tool_call_id: "call-treatment",
            function_name: "exec",
            arguments: { input: "const result = await tools.mcp__codexa__task_brief({ task: 'check' });" }
          }]
        }]
      }
    });

    const summary = analyzeAgentAb(experiment);

    expect(summary.arms.control.successes).toBe(1);
    expect(summary.arms.treatment.successes).toBe(1);
    expect(summary.treatmentFidelity.control).toMatchObject({ traceObservedRuns: 1, codexaInvokedRuns: 0, contaminationRuns: 0 });
    expect(summary.treatmentFidelity.treatment).toMatchObject({ traceObservedRuns: 1, codexaInvokedRuns: 1, nonadherentRuns: 0 });
    expect(summary.treatmentFidelity.treatment).toMatchObject({
      setupObservedRuns: 1,
      setupSuccessfulRuns: 1,
      setupFailedRuns: 0,
      setupVersionMismatchRuns: 0
    });
    expect(summary.treatmentFidelity.control.codexaCallsByTool).toEqual({});
    expect(summary.treatmentFidelity.treatment.codexaCallsByTool).toEqual({ task_brief: 1 });
  });

  it("parses stringified shell arguments without treating prose as a Codexa invocation", async () => {
    const experiment = await createExperiment(["task-a"]);
    const control = findAssignment(experiment.assignments, "task-a", "control");
    const treatment = findAssignment(experiment.assignments, "task-a", "treatment");
    await writeFinalizedRun(experiment.output, control, {
      trajectory: {
        schema_version: "ATIF-v1.7",
        steps: [{
          tool_calls: [
            {
              tool_call_id: "call-control-prose",
              function_name: "shell",
              arguments: "For example, use {\"command\":\"codexa brief .\"} in an agent trajectory."
            },
            {
              tool_call_id: "call-control-json",
              function_name: "shell",
              arguments: JSON.stringify({ note: "codexa brief .", command: "echo codexa brief ." })
            }
          ]
        }]
      }
    });
    await writeFinalizedRun(experiment.output, treatment, {
      trajectory: {
        schema_version: "ATIF-v1.7",
        steps: [{
          tool_calls: [{
            tool_call_id: "call-treatment-json",
            function_name: "shell",
            arguments: JSON.stringify({ command: "codexa brief ." })
          }]
        }]
      }
    });

    const summary = analyzeAgentAb(experiment);

    expect(summary.treatmentFidelity.control).toMatchObject({ codexaInvokedRuns: 0, contaminationRuns: 0 });
    expect(summary.treatmentFidelity.control.codexaCallsByTool).toEqual({});
    expect(summary.treatmentFidelity.treatment).toMatchObject({ codexaInvokedRuns: 1, nonadherentRuns: 0 });
    expect(summary.treatmentFidelity.treatment.codexaCallsByTool).toEqual({ "cli:brief": 1 });
  });

  it("reports ordered post-edit decisions without changing verified completion or ITT", async () => {
    const experiment = await createExperiment(["task-a"]);
    const control = findAssignment(experiment.assignments, "task-a", "control");
    const treatment = findAssignment(experiment.assignments, "task-a", "treatment");
    await writeFinalizedRun(experiment.output, control, {
      rewards: { verified_completion: 1 },
      trajectory: { schema_version: "ATIF-v1.7", steps: [] }
    });
    await writeFinalizedRun(experiment.output, treatment, {
      rewards: { verified_completion: 1 },
      trajectory: {
        schema_version: "ATIF-v1.7",
        steps: [
          postEditReviewStep(1, "inspect", "blocking", "blocking_inspect", "python-repr"),
          postEditReviewStep(2, "continue", "none", "complete")
        ]
      }
    });

    const summary = analyzeAgentAb(experiment);
    const markdown = await readFile(path.join(experiment.output, "summary.md"), "utf8");
    const controlOutcome = summary.outcomes.find((outcome: { arm: Arm }) => outcome.arm === "control");
    const treatmentOutcome = summary.outcomes.find((outcome: { arm: Arm }) => outcome.arm === "treatment");

    expect(summary.arms.control.successes).toBe(1);
    expect(summary.arms.treatment.successes).toBe(1);
    expect(summary.effect.absoluteRiskDifference).toBe(0);
    expect(summary.treatmentDefinition.adherencePolicy).toBe(
      "usage telemetry is descriptive only; no run is excluded for adherence or contamination"
    );
    expect(controlOutcome.codexaUsage.postEditDecisionTrace).toMatchObject({
      schemaVersion: 1,
      status: "not-invoked",
      reviewCallCount: 0,
      finalState: "not-reviewed"
    });
    expect(treatmentOutcome.codexaUsage.postEditDecisionTrace).toMatchObject({
      schemaVersion: 1,
      evidenceTrust: "agent-reported-structured-trajectory",
      status: "observed",
      reviewCallCount: 2,
      decisions: [
        {
          verdict: "inspect",
          completionAuthority: "blocking_inspect"
        },
        {
          verdict: "continue",
          completionAuthority: "complete"
        }
      ],
      finalState: "nonblocking-after-blocking"
    });
    expect(summary.treatmentFidelity.control.postEditFinalStateCounts).toMatchObject({
      "not-reviewed": 1,
      unknown: 0
    });
    expect(summary.treatmentFidelity.treatment).toMatchObject({
      postEditReviewObservedRuns: 1,
      postEditFinalStateCounts: {
        "nonblocking-after-blocking": 1,
        unknown: 0
      }
    });
    expect(markdown).toContain("Post-edit decision telemetry is agent-reported and descriptive");
    expect(markdown).not.toMatch(/\b(useful|prevented|ignored|overridden)\b/iu);
  });

  it("keeps advisory, unresolved, and unknown review states distinct", async () => {
    const experiment = await createExperiment(["task-a", "task-b"]);
    const taskAControl = findAssignment(experiment.assignments, "task-a", "control");
    const taskATreatment = findAssignment(experiment.assignments, "task-a", "treatment");
    const taskBControl = findAssignment(experiment.assignments, "task-b", "control");
    const taskBTreatment = findAssignment(experiment.assignments, "task-b", "treatment");

    const duplicateResult = postEditReviewStep(1, "continue", "none", "complete");
    duplicateResult.observation.results.push({ ...duplicateResult.observation.results[0] });
    await writeFinalizedRun(experiment.output, taskAControl, {
      trajectory: { schema_version: "ATIF-v1.7", steps: [duplicateResult] }
    });
    await writeFinalizedRun(experiment.output, taskATreatment, {
      trajectory: {
        schema_version: "ATIF-v1.7",
        steps: [postEditReviewStep(1, "inspect", "advisory", "advisory_inspect")]
      }
    });
    const decoyResult = postEditReviewStep(1, "continue", "none", "complete");
    decoyResult.observation.results[0].content = JSON.stringify({
      note: "unrelated object",
      data: {
        mode: "post_edit_review",
        verdict: "continue",
        inspectMode: "none",
        completionAuthority: "complete"
      }
    });
    await writeFinalizedRun(experiment.output, taskBControl, {
      trajectory: {
        schema_version: "ATIF-v1.7",
        steps: [decoyResult]
      }
    });
    await writeFinalizedRun(experiment.output, taskBTreatment, {
      trajectory: {
        schema_version: "ATIF-v1.7",
        steps: [postEditReviewStep(1, "replan", "none", "replan_required")]
      }
    });

    const summary = analyzeAgentAb(experiment);
    const byRunId = new Map(summary.outcomes.map((outcome: { runId: string }) => [outcome.runId, outcome]));

    expect(summary.arms.control.successes).toBe(2);
    expect(summary.arms.treatment.successes).toBe(2);
    expect(summary.effect.absoluteRiskDifference).toBe(0);
    expect(byRunId.get("task-a-control").codexaUsage.postEditDecisionTrace).toMatchObject({
      status: "unknown",
      reviewCallCount: 1,
      finalState: "unknown"
    });
    expect(byRunId.get("task-a-treatment").codexaUsage.postEditDecisionTrace).toMatchObject({
      status: "observed",
      finalState: "advisory"
    });
    expect(byRunId.get("task-b-control").codexaUsage.postEditDecisionTrace).toMatchObject({
      status: "unknown",
      finalState: "unknown"
    });
    expect(byRunId.get("task-b-treatment").codexaUsage.postEditDecisionTrace).toMatchObject({
      status: "observed",
      finalState: "blocking-unresolved"
    });
    expect(summary.treatmentFidelity.control).toMatchObject({
      postEditReviewObservedRuns: 2,
      postEditFinalStateCounts: { unknown: 2 }
    });
    expect(summary.treatmentFidelity.treatment).toMatchObject({
      postEditReviewObservedRuns: 2,
      postEditFinalStateCounts: { advisory: 1, "blocking-unresolved": 1, unknown: 0 }
    });
  });

  it("does not infer decisions across steps or incomplete trajectory lineage", async () => {
    const experiment = await createExperiment(["task-a", "task-b"]);
    const { observation: lateObservation, ...crossStepCall } =
      postEditReviewStep(1, "continue", "none", "complete");

    await writeFinalizedRun(
      experiment.output,
      findAssignment(experiment.assignments, "task-a", "control"),
      {
        trajectory: {
          schema_version: "ATIF-v1.7",
          steps: [
            crossStepCall,
            { step_id: 2, observation: lateObservation }
          ]
        }
      }
    );
    await writeFinalizedRun(
      experiment.output,
      findAssignment(experiment.assignments, "task-a", "treatment"),
      {
        trajectory: {
          schema_version: "ATIF-v1.7",
          continued_trajectory_ref: "next-segment.json",
          steps: [postEditReviewStep(1, "continue", "none", "complete")]
        }
      }
    );
    await writeFinalizedRun(
      experiment.output,
      findAssignment(experiment.assignments, "task-b", "control"),
      {
        trajectory: {
          schema_version: "ATIF-v1.7",
          steps: [{ step_id: 1, tool_calls: [{}] }]
        }
      }
    );
    await writeFinalizedRun(
      experiment.output,
      findAssignment(experiment.assignments, "task-b", "treatment"),
      {
        trajectory: {
          schema_version: "ATIF-v1.7",
          steps: [],
          subagent_trajectories: [{
            schema_version: "ATIF-v1.7",
            trajectory_id: "delegated-agent",
            steps: [postEditReviewStep(1, "continue", "none", "complete")]
          }]
        }
      }
    );

    const summary = analyzeAgentAb(experiment);
    const byRunId = new Map(summary.outcomes.map((outcome: { runId: string }) => [outcome.runId, outcome]));

    expect(summary.arms.control.successes).toBe(2);
    expect(summary.arms.treatment.successes).toBe(2);
    expect(summary.effect.absoluteRiskDifference).toBe(0);
    expect(byRunId.get("task-a-control").codexaUsage.postEditDecisionTrace).toMatchObject({
      status: "unknown",
      reviewCallCount: 1,
      finalState: "unknown"
    });
    expect(byRunId.get("task-a-treatment").codexaUsage).toMatchObject({
      status: "partial",
      codexaInvoked: null,
      codexaCallCount: null,
      callsByTool: null,
      postEditDecisionTrace: {
        status: "unknown",
        reviewCallCount: 1,
        finalState: "unknown"
      }
    });
    expect(byRunId.get("task-b-control").codexaUsage).toMatchObject({
      status: "partial",
      codexaInvoked: null,
      codexaCallCount: null,
      callsByTool: null,
      postEditDecisionTrace: {
        status: "unknown",
        reviewCallCount: 0,
        finalState: "unknown"
      }
    });
    expect(byRunId.get("task-b-treatment").codexaUsage).toMatchObject({
      status: "partial",
      codexaInvoked: null,
      postEditDecisionTrace: {
        status: "unknown",
        finalState: "unknown"
      }
    });
  });

  it("resamples tasks while preserving repetitions as within-task observations", async () => {
    const experiment = await createExperiment(["task-a", "task-b"], 0.9, 2_000);
    for (const assignment of experiment.assignments) {
      const treatmentWins = assignment.taskId === "task-a";
      const success = assignment.arm === "treatment" ? treatmentWins : !treatmentWins;
      await writeFinalizedRun(experiment.output, assignment, { rewards: { verified_completion: Number(success) } });
    }

    const summary = analyzeAgentAb(experiment);

    expect(summary.effect.absoluteRiskDifference).toBe(0);
    expect(summary.effect.taskClusteredBootstrap).toMatchObject({
      lower: -1,
      upper: 1,
      tasks: 2,
      samples: 2_000,
      confidenceLevel: 0.9
    });
  });
});

function postEditReviewStep(
  stepId: number,
  verdict: "continue" | "run_tests" | "inspect" | "replan",
  inspectMode: "none" | "advisory" | "blocking",
  completionAuthority: "complete" | "tests_required" | "advisory_inspect" | "blocking_inspect" | "replan_required",
  carrier: "json" | "python-repr" = "json"
): PostEditStepFixture {
  const toolCallId = `review-${stepId}`;
  const serialized = JSON.stringify({
    structuredContent: {
      schemaVersion: 1,
      mode: "post_edit_review",
      data: { mode: "post_edit_review", verdict, inspectMode, completionAuthority }
    }
  });
  return {
    step_id: stepId,
    source: "agent",
    message: "",
    tool_calls: [{
      tool_call_id: toolCallId,
      function_name: "exec",
      arguments: {
        input: "const r = await tools.mcp__codexa__post_edit_review({taskId:'generic-task'}); text(r);"
      }
    }],
    observation: {
      results: [{
        source_call_id: toolCallId,
        content: carrier === "python-repr"
          ? `[{'type': 'input_text', 'text': '${serialized}'}]`
          : serialized
      }]
    }
  };
}

async function createExperiment(taskIds: string[], confidenceLevel = 0.95, bootstrapSamples = 1_000) {
  const output = await mkdtemp(path.join(os.tmpdir(), "codexa-agent-ab-validity-"));
  const assignments = taskIds.flatMap((taskId) => [
    assignment(taskId, "control", 1),
    assignment(taskId, "treatment", 2)
  ]);
  const config = {
    design: { seed: "validity-test-seed" },
    treatment: { extraInstruction: "config/codexa-instructions.md" },
    analysis: { primaryReward: "verified_completion", bootstrapSamples, confidenceLevel }
  };
  await writeFile(
    path.join(output, "registration.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      experimentId: EXPERIMENT_ID,
      createdAt: "2026-07-13T00:00:00.000Z",
      configHash: CONFIG_HASH,
      framework: { name: "harbor", version: "0.18.0" },
      harness: HARNESS,
      candidate: { codexaVersion: "0.10.0" },
      agent: AGENT,
      model: MODEL,
      runner: RUNNER,
      treatment: { mcpConfigHash: "mcp-hash", extraInstructionHash: "instruction-hash" },
      tasks: taskIds.map((id) => ({ id, name: `agent-ab-validity/${id}`, hash: `hash-${id}` })),
      inputs: expectedInputs(taskIds),
      assignments
    }, null, 2)}\n`,
    "utf8"
  );
  return { config, outputDir: output, output, assignments };
}

function assignment(taskId: string, arm: Arm, order: number): Assignment {
  const runId = `${taskId}-${arm}`;
  return { runId, taskId, taskName: `agent-ab-validity/${taskId}`, repetition: 1, arm, order, jobName: `agent-ab-${runId}` };
}

function findAssignment(assignments: Assignment[], taskId: string, arm: Arm): Assignment {
  const found = assignments.find((entry) => entry.taskId === taskId && entry.arm === arm);
  if (!found) {
    throw new Error(`missing ${taskId} ${arm} assignment`);
  }
  return found;
}

async function writeAttempt(output: string, assignment: Assignment): Promise<void> {
  const attempts = path.join(output, "attempts");
  await mkdir(attempts, { recursive: true });
  await writeFile(
    path.join(attempts, `${assignment.runId}.json`),
    `${JSON.stringify({
      schemaVersion: 1,
      experimentId: EXPERIMENT_ID,
      configHash: CONFIG_HASH,
      agent: AGENT,
      model: MODEL,
      harness: HARNESS,
      runner: RUNNER,
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

async function writeRunMetadata(output: string, assignment: Assignment, overrides: Record<string, unknown> = {}): Promise<void> {
  const runs = path.join(output, "runs");
  await mkdir(runs, { recursive: true });
  await writeFile(
    path.join(runs, `${assignment.runId}.json`),
    `${JSON.stringify({
      schemaVersion: 1,
      runId: assignment.runId,
      taskId: assignment.taskId,
      repetition: assignment.repetition,
      arm: assignment.arm,
      order: assignment.order,
      exitCode: 0,
      timedOut: false,
      controllerElapsedMs: 500,
      jobResultPath: path.posix.join("jobs", assignment.jobName, "result.json"),
      ...overrides
    })}\n`,
    "utf8"
  );
}

async function writeFinalizedRun(
  output: string,
  assignment: Assignment,
  options: {
    writeAttemptJournal?: boolean;
    rewards?: Record<string, number>;
    agentResult?: Record<string, unknown>;
    taskName?: string;
    trialJobId?: string;
    agentName?: string;
    modelName?: string;
    runnerKwargs?: Record<string, string>;
    taskPath?: string;
    mcpServers?: Array<Record<string, unknown>>;
    extraInstructionPaths?: string[];
    trajectory?: Record<string, unknown>;
    codexaSetup?: { codexaVersion: string; indexExitCode: number; indexElapsedMs: number };
  } = {}
): Promise<void> {
  if (options.writeAttemptJournal !== false) {
    await writeAttempt(output, assignment);
  }
  await writeRunMetadata(output, assignment);
  const job = path.join(output, "jobs", assignment.jobName);
  const jobId = `job-${assignment.runId}`;
  const trialName = `${assignment.taskId}__fixture`;
  const trial = path.join(job, trialName);
  await mkdir(trial, { recursive: true });
  await writeFile(
    path.join(job, "result.json"),
    `${JSON.stringify({
      id: jobId,
      n_total_trials: 1,
      stats: { n_completed_trials: 1, n_errored_trials: 0 }
    })}\n`,
    "utf8"
  );
  await writeFile(
    path.join(trial, "result.json"),
    `${JSON.stringify({
      id: `trial-${assignment.runId}`,
      task_name: options.taskName ?? assignment.taskName,
      trial_name: trialName,
      config: {
        job_id: options.trialJobId ?? jobId,
        task: { path: options.taskPath ?? expectedTaskPath(output, assignment.taskId) },
        agent: {
          name: options.agentName ?? AGENT,
          model_name: options.modelName ?? MODEL,
          kwargs: options.runnerKwargs ?? { version: RUNNER.version, ...RUNNER.kwargs },
          mcp_servers: options.mcpServers ?? expectedMcpServers(assignment.arm)
        },
        extra_instruction_paths: options.extraInstructionPaths ?? expectedExtraInstructionPaths(assignment.arm, output)
      },
      verifier_result: { rewards: options.rewards ?? { verified_completion: 1 } },
      agent_result: options.agentResult ?? { n_input_tokens: 100, n_output_tokens: 20, cost_usd: 0.01 },
      agent_execution: {
        started_at: "2026-07-13T00:00:00.000Z",
        finished_at: "2026-07-13T00:00:00.250Z"
      },
      exception_info: null
    })}\n`,
    "utf8"
  );
  if (options.trajectory) {
    await writeFile(path.join(trial, "trajectory.json"), `${JSON.stringify(options.trajectory)}\n`, "utf8");
  }
  if (options.codexaSetup) {
    await writeFile(path.join(trial, "codexa-setup.json"), `${JSON.stringify(options.codexaSetup)}\n`, "utf8");
  }
}

function trialResultPath(output: string, assignment: Assignment): string {
  return path.join(output, "jobs", assignment.jobName, `${assignment.taskId}__fixture`, "result.json");
}

function expectedMcpServers(arm: Arm): Array<Record<string, unknown>> {
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

function expectedExtraInstructionPaths(arm: Arm, output: string): string[] {
  return arm === "control" ? [] : [path.join(output, "inputs", "treatment", "instruction", "codexa-instructions.md")];
}

function expectedTaskPath(output: string, taskId: string): string {
  return path.join(output, "inputs", "tasks", taskId);
}

function expectedInputs(taskIds = ["task-a"]): Record<string, unknown> {
  return {
    schemaVersion: 1,
    tasks: taskIds.map((id) => ({ id, path: path.posix.join("inputs", "tasks", id) })),
    treatment: {
      mcpConfig: "inputs/treatment/mcp/codexa-mcp.json",
      extraInstruction: "inputs/treatment/instruction/codexa-instructions.md"
    }
  };
}
