import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
// @ts-expect-error the benchmark analyzer is intentionally plain ESM
import { analyzeAgentAb } from "../scripts/agent-ab-analysis.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(root, "scripts", "agent-ab.mjs");
const benchmarkRoot = path.join(root, "benchmarks", "agent-ab");
const mcpPreflight = path.join(benchmarkRoot, "support", "mcp-initialize-tools-list-smoke.mjs");
const armIds = ["control", "full-detailed-legacy", "adaptive-auto-legacy", "adaptive-auto-bounded"] as const;
const comparisons = [
  { id: "optimized-net-value", baselineArm: "control", candidateArm: "adaptive-auto-bounded", primary: true },
  { id: "total-optimization", baselineArm: "full-detailed-legacy", candidateArm: "adaptive-auto-bounded", primary: false },
  { id: "transport-exposure", baselineArm: "full-detailed-legacy", candidateArm: "adaptive-auto-legacy", primary: false },
  { id: "cadence", baselineArm: "adaptive-auto-legacy", candidateArm: "adaptive-auto-bounded", primary: false }
] as const;
describe("agent A/B schema-v2 stepped ablation", () => {
  it("registers every arm once per block with deterministic cyclic positional balance", async () => {
    const fixture = await createV2Benchmark(4);
    const output = await mkdtemp(path.join(os.tmpdir(), "codexa-agent-ab-v2-registration-"));
    const first = run([
      "register", "--config", fixture.config, "--output", output,
      "--agent", "codex", "--model", "openai/example-model"
    ]);
    expect(first.status, first.stderr).toBe(0);
    const registration = JSON.parse(await readFile(path.join(output, "registration.json"), "utf8"));

    expect(registration.schemaVersion).toBe(2);
    expect(registration.harness.mcpPreflightHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(registration.assignments).toHaveLength(16);
    for (let repetition = 1; repetition <= 4; repetition += 1) {
      const block = registration.assignments.filter((entry: { repetition: number }) => entry.repetition === repetition);
      expect(block.map((entry: { arm: string }) => entry.arm).sort()).toEqual([...armIds].sort());
      expect(block.map((entry: { order: number }) => entry.order).sort()).toEqual([1, 2, 3, 4]);
    }
    expect(registration.positionalBalance.fullyBalanced).toBe(true);
    for (const arm of armIds) {
      expect(registration.positionalBalance.positions[arm]).toEqual({ "1": 1, "2": 1, "3": 1, "4": 1 });
    }
    expect(registration.comparisons).toEqual(comparisons);
    expect(registration.inputs.arms).toHaveLength(4);
    expect(registration.inputs.arms.find((arm: { id: string }) => arm.id === "control")).toEqual({ id: "control", kind: "control" });

    const boundedLayout = registration.inputs.arms.find((arm: { id: string }) => arm.id === "adaptive-auto-bounded");
    await writeFile(path.join(output, boundedLayout.extraInstruction), "Codexa snapshot was changed.\n", "utf8");
    const resumed = run([
      "register", "--config", fixture.config, "--output", output,
      "--agent", "codex", "--model", "openai/example-model", "--resume"
    ]);
    expect(resumed.status).toBe(1);
    expect(resumed.stderr).toContain("arm adaptive-auto-bounded instruction input snapshot hash differs");
  });

  it("rejects duplicate arms, unknown comparison arms, and control inputs", async () => {
    const duplicate = await createV2Benchmark(1);
    const duplicateValue = JSON.parse(await readFile(duplicate.config, "utf8"));
    duplicateValue.arms[1].id = "control";
    await writeFile(duplicate.config, `${JSON.stringify(duplicateValue, null, 2)}\n`, "utf8");
    const duplicateResult = run(["validate", "--config", duplicate.config]);
    expect(duplicateResult.status).toBe(1);
    expect(duplicateResult.stderr).toContain("duplicate arm id");

    const unknown = await createV2Benchmark(1);
    const unknownValue = JSON.parse(await readFile(unknown.config, "utf8"));
    unknownValue.analysis.comparisons[0].candidateArm = "not-registered";
    await writeFile(unknown.config, `${JSON.stringify(unknownValue, null, 2)}\n`, "utf8");
    const unknownResult = run(["validate", "--config", unknown.config]);
    expect(unknownResult.status).toBe(1);
    expect(unknownResult.stderr).toContain("references an unknown arm");

    const controlInput = await createV2Benchmark(1);
    const controlValue = JSON.parse(await readFile(controlInput.config, "utf8"));
    controlValue.arms[0].mcpConfig = "config/full-detailed-legacy.mcp.json";
    await writeFile(controlInput.config, `${JSON.stringify(controlValue, null, 2)}\n`, "utf8");
    const controlResult = run(["validate", "--config", controlInput.config]);
    expect(controlResult.status).toBe(1);
    expect(controlResult.stderr).toContain("unknown field: mcpConfig");
  });

  it("passes only each Codexa arm's immutable inputs to Harbor", async () => {
    const fixture = await createV2Benchmark(1);
    const output = await mkdtemp(path.join(os.tmpdir(), "codexa-agent-ab-v2-run-"));
    const fakeBin = await mkdtemp(path.join(os.tmpdir(), "codexa-agent-ab-v2-uvx-"));
    const fakeUvx = path.join(fakeBin, "uvx");
    await writeFile(fakeUvx, `#!/usr/bin/env node
const fs = require("node:fs");
fs.appendFileSync(process.env.FAKE_UVX_LOG, JSON.stringify(process.argv.slice(2)) + "\\n");
`, "utf8");
    await chmod(fakeUvx, 0o755);
    const fakeDocker = path.join(fakeBin, "docker");
    await writeFile(fakeDocker, `#!/usr/bin/env node
const fs = require("node:fs");
const readline = require("node:readline");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_DOCKER_LOG, JSON.stringify(args) + "\\n");
if (args[0] === "build") process.exit(0);
if (args[0] === "image" && args[1] === "rm") process.exit(0);
if (args[0] !== "run") process.exit(2);
const lines = readline.createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-03-26", capabilities: {}, serverInfo: { name: "codexa", version: "0.10.0" } } }) + "\\n");
  } else if (message.method === "tools/list") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { tools: [{ name: "task_brief" }] } }) + "\\n");
  }
});
`, "utf8");
    await chmod(fakeDocker, 0o755);
    const log = path.join(output, "uvx.jsonl");
    const dockerLog = path.join(output, "docker.jsonl");
    const runArgs = [
      "run", "--config", fixture.config, "--output", output,
      "--agent", "codex", "--model", "openai/example-model"
    ];
    const runEnv = {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH}`,
      FAKE_UVX_LOG: log,
      FAKE_DOCKER_LOG: dockerLog
    };
    const result = run(runArgs, runEnv);
    expect(result.status, result.stderr).toBe(0);
    const dockerInvocations = (await readFile(dockerLog, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(dockerInvocations.filter((args: string[]) => args[0] === "build")).toHaveLength(1);
    expect(dockerInvocations.filter((args: string[]) => args[0] === "run")).toHaveLength(3);
    expect(dockerInvocations.filter((args: string[]) => args[0] === "image" && args[1] === "rm")).toHaveLength(1);
    const receiptFiles = (await readdir(path.join(output, "preflight"))).filter((entry) => entry.endsWith(".json"));
    expect(receiptFiles).toHaveLength(3);
    for (const receiptFile of receiptFiles) {
      const receipt = JSON.parse(await readFile(path.join(output, "preflight", receiptFile), "utf8"));
      expect(receipt).toMatchObject({
        schemaVersion: 1,
        kind: "schema-v2-mcp-preflight",
        experimentId: "codexa-agent-ab-stepped-v2-test",
        taskId: "path-target-normalization",
        expectedServerInfo: { name: "codexa", version: "0.10.0" },
        observedServerInfo: { name: "codexa", version: "0.10.0" },
        mcpPreflightHash: expect.stringMatching(/^[a-f0-9]{64}$/u)
      });
      expect(Number.isFinite(Date.parse(receipt.completedAt))).toBe(true);
    }
    const invocations = (await readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(invocations).toHaveLength(4);
    const withoutMcp = invocations.filter((args: string[]) => !args.includes("--mcp-config"));
    expect(withoutMcp).toHaveLength(1);
    const withMcp = invocations.filter((args: string[]) => args.includes("--mcp-config"));
    expect(withMcp).toHaveLength(3);
    const observedArms = withMcp.map((args: string[]) => {
      const mcpPath = args[args.indexOf("--mcp-config") + 1];
      const instructionPath = args[args.indexOf("--extra-instruction-path") + 1];
      expect(mcpPath).toContain(`${path.sep}inputs${path.sep}arms${path.sep}`);
      expect(instructionPath).toContain(`${path.sep}inputs${path.sep}arms${path.sep}`);
      return armIds.find((arm) => arm !== "control" && mcpPath.includes(`${path.sep}${arm}${path.sep}`));
    });
    expect(observedArms.sort()).toEqual([...armIds.slice(1)].sort());

    const registration = JSON.parse(await readFile(path.join(output, "registration.json"), "utf8"));
    const pendingAssignment = registration.assignments.find((assignment: { arm: string }) => assignment.arm === "adaptive-auto-bounded");
    await rm(path.join(output, "attempts", `${pendingAssignment.runId}.json`));
    await rm(path.join(output, "runs", `${pendingAssignment.runId}.json`));
    const resumed = run([...runArgs, "--resume"], runEnv);
    expect(resumed.status, resumed.stderr).toBe(0);
    expect((await readFile(dockerLog, "utf8")).trim().split("\n")).toHaveLength(dockerInvocations.length);
    expect((await readFile(log, "utf8")).trim().split("\n")).toHaveLength(invocations.length + 1);

    const completedResume = run([...runArgs, "--resume"], runEnv);
    expect(completedResume.status, completedResume.stderr).toBe(0);
    expect((await readFile(dockerLog, "utf8")).trim().split("\n")).toHaveLength(dockerInvocations.length);
    expect((await readFile(log, "utf8")).trim().split("\n")).toHaveLength(invocations.length + 1);
  });

  it("rejects tampered registered framework and candidate identities on resume", async () => {
    const fixture = await createV2Benchmark(1);
    for (const identity of ["framework", "candidate"] as const) {
      const output = await mkdtemp(path.join(os.tmpdir(), `codexa-agent-ab-v2-${identity}-`));
      const args = [
        "register", "--config", fixture.config, "--output", output,
        "--agent", "codex", "--model", "openai/example-model"
      ];
      expect(run(args).status).toBe(0);
      const registrationPath = path.join(output, "registration.json");
      const registration = JSON.parse(await readFile(registrationPath, "utf8"));
      if (identity === "framework") {
        registration.framework = { name: "harbor", version: "0.18.1" };
      } else {
        registration.candidate = { codexaVersion: "9.9.9" };
      }
      await writeFile(registrationPath, `${JSON.stringify(registration, null, 2)}\n`, "utf8");
      const resumed = run([...args, "--resume"]);
      expect(resumed.status).toBe(1);
      expect(resumed.stderr).toContain(`${identity} differs from the immutable registration`);
    }
  });

  it("suppresses schema-v2 effects when a started candidate preflight receipt is missing, late, or identity-tampered", async () => {
    for (const mutation of ["missing", "late", "tampered"] as const) {
      const experiment = await createSyntheticV2Experiment(["task-a"]);
      for (const assignment of experiment.assignments) {
        await writeSyntheticRun(experiment, assignment, 1, "none");
      }
      const receiptPath = syntheticPreflightReceiptPath(
        experiment,
        "task-a",
        "/opt/codexa-agent-ab/start-codexa-mcp-adaptive-auto-bounded"
      );
      if (mutation === "missing") {
        await rm(receiptPath);
      } else {
        const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
        if (mutation === "late") receipt.completedAt = "2026-07-13T00:00:01.000Z";
        else receipt.observedServerInfo.version = "9.9.9";
        await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
      }

      const summary = analyzeAgentAb(experiment);
      expect(summary.protocolStatus).toBe("invalid");
      expect(summary.claimStatus).toBe("invalid-protocol-no-effect-estimate");
      expect(summary.candidateIdentityProof).toMatchObject({
        status: "invalid",
        expectedServerInfo: { name: "codexa", version: "0.12.0" },
        requiredReceipts: 3,
        verifiedReceipts: 2,
        invalidReceipts: 1
      });
      const invalidReceipt = summary.candidateIdentityProof.receipts.find((receipt: { status: string }) => receipt.status === "invalid");
      expect(invalidReceipt).toMatchObject({
        taskId: "task-a",
        serverCommand: "/opt/codexa-agent-ab/start-codexa-mcp-adaptive-auto-bounded",
        expectedServerInfo: { name: "codexa", version: "0.12.0" },
        status: "invalid"
      });
      expect(invalidReceipt.observedServerInfo).toEqual(
        mutation === "missing" ? null : { name: "codexa", version: mutation === "late" ? "0.12.0" : "9.9.9" }
      );
      for (const comparison of Object.values(summary.comparisons) as Array<{ effect: unknown }>) {
        expect(comparison.effect).toBeNull();
      }
      const affected = summary.outcomes.find((outcome: { arm: string }) => outcome.arm === "adaptive-auto-bounded");
      expect(affected).toMatchObject({ protocolStatus: "invalid", success: null });
      expect(affected.protocolFailure).toContain("candidate identity preflight");
      expect(await readFile(path.join(experiment.output, "summary.md"), "utf8")).toContain("Candidate identity preflight: invalid");
    }
  });

  it("recomputes all four-arm comparisons and keeps transport telemetry descriptive", async () => {
    const experiment = await createSyntheticV2Experiment();
    const successByArm: Record<string, [number, number]> = {
      control: [0, 0],
      "full-detailed-legacy": [0, 1],
      "adaptive-auto-legacy": [1, 1],
      "adaptive-auto-bounded": [1, 0]
    };
    for (const assignment of experiment.assignments) {
      const taskIndex = assignment.taskId === "task-a" ? 0 : 1;
      await writeSyntheticRun(
        experiment,
        assignment,
        successByArm[assignment.arm][taskIndex],
        assignment.arm === "adaptive-auto-legacy" && assignment.taskId === "task-a" ? "string" : undefined
      );
    }
    await setSyntheticMetrics(experiment, "task-a", "control", {
      input: 100, cache: 10, output: 10, cost: 0, agentElapsedMs: 100, controllerElapsedMs: 200
    });
    await setSyntheticMetrics(experiment, "task-a", "adaptive-auto-bounded", {
      input: 130, cache: 15, output: 20, cost: 0.02, agentElapsedMs: 160, controllerElapsedMs: 300
    });
    await setSyntheticMetrics(experiment, "task-b", "control", {
      input: 200, cache: 20, output: 30, cost: 0, agentElapsedMs: 200, controllerElapsedMs: 400
    });
    await setSyntheticMetrics(experiment, "task-b", "adaptive-auto-bounded", {
      input: 240, output: 25, cost: 0.03, agentElapsedMs: 220, controllerElapsedMs: 350
    });

    const summary = analyzeAgentAb(experiment);
    expect(summary.schemaVersion).toBe(2);
    expect(summary.status).toBe("complete");
    expect(summary.protocolStatus).toBe("valid");
    expect(summary.candidateIdentityProof).toMatchObject({
      status: "valid",
      expectedServerInfo: { name: "codexa", version: "0.12.0" },
      requiredReceipts: 6,
      verifiedReceipts: 6,
      invalidReceipts: 0
    });
    expect(summary.primaryComparison).toBe("optimized-net-value");
    expect(summary.comparisons["optimized-net-value"].effect.absoluteRiskDifference).toBe(0.5);
    expect(summary.comparisons["total-optimization"].effect.absoluteRiskDifference).toBe(0);
    expect(summary.comparisons["transport-exposure"].effect.absoluteRiskDifference).toBe(0.5);
    expect(summary.comparisons.cadence.effect.absoluteRiskDifference).toBe(-0.5);
    const paired = summary.comparisons["optimized-net-value"].pairedOverhead;
    expect(paired).toMatchObject({
      evidenceRole: "paired-descriptive-only",
      direction: "candidate-minus-baseline",
      views: {
        allStarted: { eligiblePairs: 2 },
        bothCompletedSuccessfully: { eligiblePairs: 0 }
      }
    });
    expect(paired.views.allStarted.metrics.inputTokens).toMatchObject({
      pairedPresent: 2,
      pairedMissing: 0,
      baselineMean: 150,
      candidateMean: 185,
      meanDelta: 35,
      medianDelta: 35,
      candidateToBaselineMeanRatio: 185 / 150
    });
    expect(paired.views.allStarted.metrics.cacheTokens).toMatchObject({
      pairedPresent: 1,
      pairedMissing: 1,
      meanDelta: 5,
      medianDelta: 5
    });
    expect(paired.views.allStarted.metrics.costUsd).toMatchObject({
      pairedPresent: 2,
      meanDelta: 0.025,
      medianDelta: 0.025,
      candidateToBaselineMeanRatio: null
    });
    expect(paired.views.allStarted.metrics.controllerElapsedMs).toMatchObject({
      pairedPresent: 2,
      meanDelta: 25,
      medianDelta: 25
    });
    expect(summary.comparisons.cadence.pairedOverhead.views.bothCompletedSuccessfully).toMatchObject({
      eligiblePairs: 1,
      metrics: { inputTokens: { pairedPresent: 1, pairedMissing: 0, meanDelta: 30 } }
    });

    const bounded = summary.outcomes.find((outcome: { taskId: string; arm: string }) =>
      outcome.taskId === "task-a" && outcome.arm === "adaptive-auto-bounded"
    );
    const args = { task: "inspect café 🎭", responseFormat: "auto" };
    const resultText = JSON.stringify({
      structuredContent: {
        schemaVersion: 1,
        data: {
          delivery: {
            requestedFormat: "auto",
            effectiveFormat: "detailed",
            escalationReason: "blocking_authority"
          }
        }
      },
      content: [{ type: "text", text: "résumé 🎭" }]
    });
    expect(bounded.codexaUsage.transportTelemetry).toMatchObject({
      status: "observed",
      correlatedCalls: 1,
      requestArgumentBytes: Buffer.byteLength(JSON.stringify(args), "utf8"),
      modelVisibleResultTextBytes: Buffer.byteLength(resultText, "utf8"),
      requestedFormats: { auto: 1 },
      effectiveFormats: { detailed: 1 },
      automaticEscalations: 1,
      unchangedReceipts: 0
    });
    expect(bounded.codexaUsage.serverTelemetry).toMatchObject({
      status: "observed",
      events: 1,
      requestBytes: 47,
      textBytes: 83,
      structuredBytes: 211,
      totalBytes: 341,
      elapsedMs: 12.5,
      requestedFormats: { auto: 1 },
      effectiveFormats: { detailed: 1 },
      escalationEvents: 1,
      unchangedReceipts: 0
    });
    const stringArguments = '{"task":"café 🎭","responseFormat":"auto"}';
    const adaptiveLegacy = summary.outcomes.find((outcome: { taskId: string; arm: string }) =>
      outcome.taskId === "task-a" && outcome.arm === "adaptive-auto-legacy"
    );
    expect(adaptiveLegacy.codexaUsage.transportTelemetry.requestArgumentBytes).toBe(
      Buffer.byteLength(stringArguments, "utf8")
    );
    expect(adaptiveLegacy.codexaUsage.transportTelemetry.requestArgumentBytes).not.toBe(
      Buffer.byteLength(JSON.stringify(stringArguments), "utf8")
    );
    expect(summary.efficiencyTelemetry["adaptive-auto-bounded"]).toMatchObject({
      evidenceRole: "descriptive-only",
      atif: {
        eligibleRuns: 2,
        observedRuns: 1,
        unknownOrPartialRuns: 1,
        requestArgumentBytes: Buffer.byteLength(JSON.stringify(args), "utf8"),
        modelVisibleResultTextBytes: Buffer.byteLength(resultText, "utf8"),
        automaticEscalations: 1
      },
      server: {
        eligibleRuns: 2,
        observedRuns: 1,
        unknownOrPartialRuns: 1,
        totalBytes: 341,
        elapsedMs: 12.5
      }
    });
    const markdown = await readFile(path.join(experiment.output, "summary.md"), "utf8");
    expect(markdown).toContain("ATIF transport observed/unknown-or-partial: 1/1");
    expect(markdown).toContain("Server telemetry observed/unknown-or-partial: 1/1");
    expect(bounded.routeConformance).toMatchObject({ expectedRouteClass: "source-only", status: "deviation", actualOperations: ["task_brief"] });
    expect(summary.routeConformance).toMatchObject({ routeAdherenceArm: "adaptive-auto-bounded", byArm: { "adaptive-auto-bounded": { observedRuns: 1, deviationRuns: 1, unknownRuns: 1 } } });
    expect(summary.armFidelity["adaptive-auto-bounded"].nonadherentRuns).toBe(1);
    expect(bounded.success).toBe(true);
  });

  it("marks copied or duplicate ATIF lineage and malformed server telemetry unknown without invalidating protocol", async () => {
    const experiment = await createSyntheticV2Experiment(["task-a"]);
    for (const assignment of experiment.assignments) {
      await writeSyntheticRun(experiment, assignment, 1, assignment.arm === "adaptive-auto-bounded" ? "ambiguous" : "none");
    }
    const summary = analyzeAgentAb(experiment);
    const bounded = summary.outcomes.find((outcome: { arm: string }) => outcome.arm === "adaptive-auto-bounded");
    expect(summary.protocolStatus).toBe("valid");
    expect(summary.comparisons["optimized-net-value"].effect.absoluteRiskDifference).toBe(0);
    expect(bounded.success).toBe(true);
    expect(bounded.codexaUsage.transportTelemetry).toMatchObject({ status: "partial", correlatedCalls: null });
    expect(bounded.codexaUsage.serverTelemetry).toMatchObject({ status: "malformed", events: null });
  });

  it("invalidates a trial that receives another arm's immutable instruction", async () => {
    const experiment = await createSyntheticV2Experiment(["task-a"]);
    for (const assignment of experiment.assignments) {
      await writeSyntheticRun(experiment, assignment, 1, "none");
    }
    const bounded = findSyntheticAssignment(experiment, "task-a", "adaptive-auto-bounded");
    const trialPath = syntheticTrialResultPath(experiment, bounded);
    const trial = JSON.parse(await readFile(trialPath, "utf8"));
    trial.config.extra_instruction_paths = [
      path.join(experiment.output, "inputs/arms/full-detailed-legacy/instruction/codexa-instructions.md")
    ];
    await writeFile(trialPath, `${JSON.stringify(trial)}\n`, "utf8");

    const summary = analyzeAgentAb(experiment);
    const outcome = summary.outcomes.find((entry: { runId: string }) => entry.runId === bounded.runId);
    expect(summary.status).toBe("complete");
    expect(summary.protocolStatus).toBe("invalid");
    expect(summary.comparisons["optimized-net-value"].effect).toBeNull();
    expect(outcome).toMatchObject({
      success: null,
      protocolStatus: "invalid",
      protocolFailure: "arm adaptive-auto-bounded did not receive exactly its registered Codexa MCP and workflow-instruction bundle"
    });
  });

  it("keeps copied, continued, and subagent lineage partial while accepting text plus resource links", async () => {
    const experiment = await createSyntheticV2Experiment(["copied", "continued", "subagent", "resource-link"]);
    for (const assignment of experiment.assignments) {
      await writeSyntheticRun(experiment, assignment, 1, "none");
    }
    const call = {
      tool_call_id: "codexa-lineage-call",
      function_name: "mcp__codexa__task_brief",
      arguments: { task: "generic task", responseFormat: "auto" }
    };
    const result = { source_call_id: call.tool_call_id, content: "ordinary result" };
    await writeSyntheticTrajectory(experiment, "copied", {
      schema_version: "ATIF-v1.7",
      steps: [{ is_copied_context: true, tool_calls: [call], observation: { results: [result] } }]
    });
    await writeSyntheticTrajectory(experiment, "continued", {
      schema_version: "ATIF-v1.7",
      continued_trajectory_ref: "continued.json",
      steps: [{ tool_calls: [call], observation: { results: [result] } }]
    });
    await writeSyntheticTrajectory(experiment, "subagent", {
      schema_version: "ATIF-v1.7",
      subagent_trajectories: [{ schema_version: "ATIF-v1.7", trajectory_id: "child", steps: [] }],
      steps: [{ tool_calls: [call], observation: { results: [result] } }]
    });
    const visibleText = "model-visible résumé 🎭";
    await writeSyntheticTrajectory(experiment, "resource-link", {
      schema_version: "ATIF-v1.7",
      steps: [{
        tool_calls: [call],
        observation: {
          results: [{
            source_call_id: call.tool_call_id,
            content: [
              { type: "text", text: visibleText },
              {
                type: "resource_link",
                uri: `codexa://repo/mcp-results/rr_${"a".repeat(32)}/mr_${"a".repeat(64)}`,
                name: "Detailed Codexa result",
                mimeType: "application/json"
              }
            ]
          }]
        }
      }]
    });

    const summary = analyzeAgentAb(experiment);
    expect(summary.protocolStatus).toBe("valid");
    expect(summary.comparisons["optimized-net-value"].effect.absoluteRiskDifference).toBe(0);
    for (const taskId of ["copied", "continued", "subagent"]) {
      const outcome = summary.outcomes.find((entry: { taskId: string; arm: string }) =>
        entry.taskId === taskId && entry.arm === "adaptive-auto-bounded"
      );
      expect(outcome).toMatchObject({ success: true, protocolStatus: "valid" });
      expect(outcome.codexaUsage.transportTelemetry).toMatchObject({ status: "partial", correlatedCalls: null });
    }
    const resourceOutcome = summary.outcomes.find((entry: { taskId: string; arm: string }) =>
      entry.taskId === "resource-link" && entry.arm === "adaptive-auto-bounded"
    );
    expect(resourceOutcome.codexaUsage.transportTelemetry).toMatchObject({
      status: "observed",
      correlatedCalls: 1,
      detailResourceFetches: 0,
      modelVisibleResultTextBytes: Buffer.byteLength(visibleText, "utf8")
    });
  });

  it("counts only exactly correlated Codexa detail-resource reads and reconciles server events", async () => {
    const experiment = await createSyntheticV2Experiment(["fetch", "explicit", "conflict", "wrong-server", "wrong-uri", "duplicate"]);
    for (const assignment of experiment.assignments) {
      await writeSyntheticRun(experiment, assignment, 1, "none");
    }
    const uri = routedResultUri("a");
    const toolArguments = { task: "generic task", responseFormat: "auto" };
    const fetchArguments = { server: "codexa", uri };
    const receipt = "bounded receipt";
    const detailed = "exact detailed payload 🎭";
    await writeSyntheticTrajectory(experiment, "fetch", {
      schema_version: "ATIF-v1.7",
      steps: [
        {
          tool_calls: [{ tool_call_id: "tool-call", function_name: "mcp__codexa__task_brief", arguments: toolArguments }],
          observation: { results: [{ source_call_id: "tool-call", content: receipt }] }
        },
        {
          tool_calls: [{ tool_call_id: "fetch-call", function_name: "read_mcp_resource", arguments: fetchArguments }],
          observation: { results: [{ source_call_id: "fetch-call", content: detailed }] }
        }
      ]
    });
    await writeSyntheticTrajectory(experiment, "explicit", {
      schema_version: "ATIF-v1.7",
      steps: [{
        tool_calls: [{
          tool_call_id: "explicit-call",
          function_name: "mcp__codexa__capabilities",
          arguments: { operation: "task_brief", arguments: { task: "generic task", responseFormat: "detailed" } }
        }],
        observation: { results: [{ source_call_id: "explicit-call", content: detailed }] }
      }]
    });
    await writeSyntheticTrajectory(experiment, "conflict", {
      schema_version: "ATIF-v1.7",
      steps: [{
        tool_calls: [{
          tool_call_id: "conflict-call",
          function_name: "mcp__codexa__capabilities",
          arguments: { responseFormat: "concise", operation: "task_brief", arguments: { responseFormat: "detailed" } }
        }],
        observation: { results: [{ source_call_id: "conflict-call", content: detailed }] }
      }]
    });
    const fetchAssignment = findSyntheticAssignment(experiment, "fetch", "adaptive-auto-bounded");
    const fetchTrial = path.dirname(syntheticTrialResultPath(experiment, fetchAssignment));
    const fetchRequestBytes = Buffer.byteLength(JSON.stringify(fetchArguments), "utf8");
    const fetchTextBytes = Buffer.byteLength(detailed, "utf8");
    await writeFile(path.join(fetchTrial, "codexa-mcp-telemetry.jsonl"), [
      JSON.stringify({ ...validServerEvent(1), resultReference: uri }),
      JSON.stringify({
        schemaVersion: 1,
        sequence: 2,
        eventKind: "resource-read",
        logicalOperation: "mcp-detailed-result",
        outcome: "ok",
        tool: "read_mcp_resource",
        profile: "core",
        requestedFormat: "detailed",
        effectiveFormat: "detailed",
        requestBytes: fetchRequestBytes,
        textBytes: fetchTextBytes,
        structuredBytes: 0,
        totalBytes: fetchTextBytes + 16,
        elapsedMs: 2.5,
        resultReference: uri,
        unchangedReceipt: false
      }),
      JSON.stringify(validServerCompletion(2))
    ].join("\n") + "\n", "utf8");

    for (const [taskId, argumentsValue] of [
      ["wrong-server", { server: "other", uri }],
      ["wrong-uri", {
        server: "codexa",
        uri: `codexa://repo/mcp-results/rr_${"z".repeat(32)}/mr_${"c".repeat(64)}`
      }]
    ] as const) {
      await writeSyntheticTrajectory(experiment, taskId, {
        schema_version: "ATIF-v1.7",
        steps: [{
          tool_calls: [{ tool_call_id: `${taskId}-call`, function_name: "read_mcp_resource", arguments: argumentsValue }],
          observation: { results: [{ source_call_id: `${taskId}-call`, content: detailed }] }
        }]
      });
    }
    await writeSyntheticTrajectory(experiment, "duplicate", {
      schema_version: "ATIF-v1.7",
      steps: [{
        tool_calls: [1, 2].map(() => ({ tool_call_id: "duplicate-call", function_name: "read_mcp_resource", arguments: fetchArguments })),
        observation: { results: [{ source_call_id: "duplicate-call", content: detailed }] }
      }]
    });

    const summary = analyzeAgentAb(experiment);
    const fetched = summary.outcomes.find((entry: { taskId: string; arm: string }) =>
      entry.taskId === "fetch" && entry.arm === "adaptive-auto-bounded"
    );
    const expectedRequestBytes = Buffer.byteLength(JSON.stringify(toolArguments), "utf8") + fetchRequestBytes;
    const expectedResultBytes = Buffer.byteLength(receipt, "utf8") + fetchTextBytes;
    expect(fetched.codexaUsage.transportTelemetry).toMatchObject({
      status: "observed",
      correlatedCalls: 2,
      requestArgumentBytes: expectedRequestBytes,
      modelVisibleResultTextBytes: expectedResultBytes,
      explicitDetailedRequests: 0,
      detailResourceFetches: 1,
      detailResourceFetchRequestArgumentBytes: fetchRequestBytes,
      detailResourceFetchResultTextBytes: fetchTextBytes,
      callsByTool: { read_mcp_resource: { calls: 1 } }
    });
    expect(fetched.codexaUsage.serverTelemetry).toMatchObject({
      status: "observed",
      events: 2,
      toolCallEvents: 1,
      detailResourceFetches: 1,
      detailResourceFetchRequestBytes: fetchRequestBytes,
      detailResourceFetchTextBytes: fetchTextBytes,
      detailResourceFetchTotalBytes: fetchTextBytes + 16,
      detailResourceFetchElapsedMs: 2.5
    });
    const explicit = summary.outcomes.find((entry: { taskId: string; arm: string }) =>
      entry.taskId === "explicit" && entry.arm === "adaptive-auto-bounded"
    );
    expect(explicit.codexaUsage.transportTelemetry).toMatchObject({
      status: "observed",
      correlatedCalls: 1,
      explicitDetailedRequests: 1,
      detailResourceFetches: 0
    });
    const conflict = summary.outcomes.find((entry: { taskId: string; arm: string }) =>
      entry.taskId === "conflict" && entry.arm === "adaptive-auto-bounded"
    );
    expect(conflict.codexaUsage.transportTelemetry).toMatchObject({
      status: "partial",
      explicitDetailedRequests: null
    });
    for (const taskId of ["wrong-server", "wrong-uri"]) {
      const ignored = summary.outcomes.find((entry: { taskId: string; arm: string }) =>
        entry.taskId === taskId && entry.arm === "adaptive-auto-bounded"
      );
      expect(ignored.codexaUsage.transportTelemetry).toMatchObject({
        status: "observed",
        correlatedCalls: 0,
        detailResourceFetches: 0
      });
    }
    const duplicate = summary.outcomes.find((entry: { taskId: string; arm: string }) =>
      entry.taskId === "duplicate" && entry.arm === "adaptive-auto-bounded"
    );
    expect(duplicate.codexaUsage.transportTelemetry).toMatchObject({ status: "partial", detailResourceFetches: null });
  });

  it("applies the cumulative ATIF byte bound without changing protocol or scoring", async () => {
    const experiment = await createSyntheticV2Experiment(["task-a"]);
    for (const assignment of experiment.assignments) {
      await writeSyntheticRun(experiment, assignment, 1, "none");
    }
    const chunk = "x".repeat(4_300_000);
    await writeSyntheticTrajectory(experiment, "task-a", {
      schema_version: "ATIF-v1.7",
      steps: [1, 2].map((index) => ({
        tool_calls: [{
          tool_call_id: `large-${index}`,
          function_name: "mcp__codexa__task_brief",
          arguments: { task: `generic-${index}`, responseFormat: "auto" }
        }],
        observation: { results: [{ source_call_id: `large-${index}`, content: chunk }] }
      }))
    });

    const summary = analyzeAgentAb(experiment);
    const bounded = summary.outcomes.find((entry: { arm: string }) => entry.arm === "adaptive-auto-bounded");
    expect(summary.protocolStatus).toBe("valid");
    expect(summary.comparisons["optimized-net-value"].effect.absoluteRiskDifference).toBe(0);
    expect(bounded).toMatchObject({ success: true, protocolStatus: "valid" });
    expect(bounded.codexaUsage.transportTelemetry).toMatchObject({ status: "scan-limit", correlatedCalls: null });
  });

  it("rejects symlink, truncated, gapped, and unbounded telemetry evidence descriptively", async () => {
    const experiment = await createSyntheticV2Experiment(["symlink", "empty", "complete-empty", "truncated-prefix", "sequence-gap", "dropped", "error-outcome", "fetch-mismatch", "scan-limit"]);
    for (const assignment of experiment.assignments) {
      await writeSyntheticRun(experiment, assignment, 1, "none");
    }
    const symlinkAssignment = findSyntheticAssignment(experiment, "symlink", "adaptive-auto-bounded");
    const symlinkTrial = path.dirname(syntheticTrialResultPath(experiment, symlinkAssignment));
    const external = path.join(experiment.output, "agent-controlled-telemetry.jsonl");
    await writeFile(external, `${JSON.stringify(validServerEvent())}\n`, "utf8");
    await symlink(external, path.join(symlinkTrial, "codexa-mcp-telemetry.jsonl"));

    const emptyAssignment = findSyntheticAssignment(experiment, "empty", "adaptive-auto-bounded");
    const emptyTrial = path.dirname(syntheticTrialResultPath(experiment, emptyAssignment));
    await writeFile(path.join(emptyTrial, "codexa-mcp-telemetry.jsonl"), "", "utf8");

    const completeEmptyAssignment = findSyntheticAssignment(experiment, "complete-empty", "adaptive-auto-bounded");
    const completeEmptyTrial = path.dirname(syntheticTrialResultPath(experiment, completeEmptyAssignment));
    await writeFile(
      path.join(completeEmptyTrial, "codexa-mcp-telemetry.jsonl"),
      `${JSON.stringify(validServerCompletion(0))}\n`,
      "utf8"
    );

    const truncatedAssignment = findSyntheticAssignment(experiment, "truncated-prefix", "adaptive-auto-bounded");
    const truncatedTrial = path.dirname(syntheticTrialResultPath(experiment, truncatedAssignment));
    await writeFile(
      path.join(truncatedTrial, "codexa-mcp-telemetry.jsonl"),
      `${JSON.stringify(validServerEvent(1))}\n`,
      "utf8"
    );

    const gapAssignment = findSyntheticAssignment(experiment, "sequence-gap", "adaptive-auto-bounded");
    const gapTrial = path.dirname(syntheticTrialResultPath(experiment, gapAssignment));
    await writeFile(
      path.join(gapTrial, "codexa-mcp-telemetry.jsonl"),
      `${JSON.stringify(validServerEvent(1))}\n${JSON.stringify(validServerEvent(3))}\n${JSON.stringify(validServerCompletion(2))}\n`,
      "utf8"
    );

    const droppedAssignment = findSyntheticAssignment(experiment, "dropped", "adaptive-auto-bounded");
    const droppedTrial = path.dirname(syntheticTrialResultPath(experiment, droppedAssignment));
    await writeFile(
      path.join(droppedTrial, "codexa-mcp-telemetry.jsonl"),
      `${JSON.stringify({ ...validServerEvent(1), droppedBefore: 1 })}\n${JSON.stringify(validServerCompletion(1))}\n`,
      "utf8"
    );

    const errorAssignment = findSyntheticAssignment(experiment, "error-outcome", "adaptive-auto-bounded");
    const errorTrial = path.dirname(syntheticTrialResultPath(experiment, errorAssignment));
    await writeFile(
      path.join(errorTrial, "codexa-mcp-telemetry.jsonl"),
      `${JSON.stringify({ ...validServerEvent(1), outcome: "error" })}\n${JSON.stringify(validServerCompletion(1))}\n`,
      "utf8"
    );

    const mismatchAssignment = findSyntheticAssignment(experiment, "fetch-mismatch", "adaptive-auto-bounded");
    const mismatchTrial = path.dirname(syntheticTrialResultPath(experiment, mismatchAssignment));
    const mismatchUri = routedResultUri("b");
    await writeSyntheticTrajectory(experiment, "fetch-mismatch", {
      schema_version: "ATIF-v1.7",
      steps: [{
        tool_calls: [{
          tool_call_id: "mismatch-fetch",
          function_name: "read_mcp_resource",
          arguments: { server: "codexa", uri: mismatchUri }
        }],
        observation: { results: [{ source_call_id: "mismatch-fetch", content: "detail" }] }
      }]
    });
    await writeFile(
      path.join(mismatchTrial, "codexa-mcp-telemetry.jsonl"),
      `${JSON.stringify(validServerEvent(1))}\n${JSON.stringify(validServerCompletion(1))}\n`,
      "utf8"
    );

    const scanAssignment = findSyntheticAssignment(experiment, "scan-limit", "adaptive-auto-bounded");
    const noise = path.join(path.dirname(syntheticTrialResultPath(experiment, scanAssignment)), "noise");
    await mkdir(noise);
    for (let start = 0; start <= 10_000; start += 250) {
      const end = Math.min(10_001, start + 250);
      await Promise.all(Array.from({ length: end - start }, (_, offset) =>
        writeFile(path.join(noise, `entry-${start + offset}.txt`), "", "utf8")
      ));
    }
    const summary = analyzeAgentAb(experiment);
    const symlinkOutcome = summary.outcomes.find((entry: { runId: string }) => entry.runId === symlinkAssignment.runId);
    const emptyOutcome = summary.outcomes.find((entry: { runId: string }) => entry.runId === emptyAssignment.runId);
    const completeEmptyOutcome = summary.outcomes.find((entry: { runId: string }) => entry.runId === completeEmptyAssignment.runId);
    const truncatedOutcome = summary.outcomes.find((entry: { runId: string }) => entry.runId === truncatedAssignment.runId);
    const gapOutcome = summary.outcomes.find((entry: { runId: string }) => entry.runId === gapAssignment.runId);
    const droppedOutcome = summary.outcomes.find((entry: { runId: string }) => entry.runId === droppedAssignment.runId);
    const errorOutcome = summary.outcomes.find((entry: { runId: string }) => entry.runId === errorAssignment.runId);
    const mismatchOutcome = summary.outcomes.find((entry: { runId: string }) => entry.runId === mismatchAssignment.runId);
    const scanOutcome = summary.outcomes.find((entry: { runId: string }) => entry.runId === scanAssignment.runId);
    expect(summary.protocolStatus).toBe("valid");
    expect(summary.comparisons["optimized-net-value"].effect.absoluteRiskDifference).toBe(0);
    expect(symlinkOutcome.codexaUsage.serverTelemetry).toMatchObject({ status: "invalid-file", events: null });
    expect(emptyOutcome.codexaUsage.serverTelemetry).toMatchObject({ status: "partial", events: null });
    expect(completeEmptyOutcome.codexaUsage.serverTelemetry).toMatchObject({ status: "observed", events: 0 });
    expect(truncatedOutcome.codexaUsage.serverTelemetry).toMatchObject({ status: "partial", events: null });
    expect(gapOutcome.codexaUsage.serverTelemetry).toMatchObject({ status: "partial", events: null });
    expect(droppedOutcome.codexaUsage.serverTelemetry).toMatchObject({ status: "partial", events: null });
    expect(errorOutcome.codexaUsage.serverTelemetry).toMatchObject({ status: "partial", events: null });
    expect(mismatchOutcome.codexaUsage.transportTelemetry).toMatchObject({ status: "partial", detailResourceFetches: null });
    expect(mismatchOutcome.codexaUsage.serverTelemetry).toMatchObject({ status: "partial", detailResourceFetches: null });
    expect(scanOutcome.codexaUsage.serverTelemetry).toMatchObject({ status: "scan-limit", events: null });
    expect(symlinkOutcome.success).toBe(true);
    expect(gapOutcome.success).toBe(true);
    expect(errorOutcome.success).toBe(true);
    expect(scanOutcome.success).toBe(true);
  });
});

function run(args: string[], env = process.env) {
  return spawnSync(process.execPath, [script, ...args], { cwd: root, env, encoding: "utf8" });
}

async function createV2Benchmark(repetitions: number, provisionCommands = true) {
  const parent = await mkdtemp(path.join(os.tmpdir(), "codexa-agent-ab-v2-config-"));
  const target = path.join(parent, "agent-ab");
  await cp(benchmarkRoot, target, { recursive: true });
  const original = JSON.parse(await readFile(path.join(target, "experiment.json"), "utf8"));
  const arms = armIds.map((id) => id === "control"
    ? { id, kind: "control" }
    : {
        id,
        kind: "codexa",
        mcpConfig: `config/${id}.mcp.json`,
        extraInstruction: `config/${id}-instructions.md`
      });
  for (const id of armIds.slice(1)) {
    await writeFile(
      path.join(target, "config", `${id}.mcp.json`),
      `${JSON.stringify({ mcpServers: { codexa: { command: `/opt/codexa-agent-ab/start-codexa-mcp-${id}`, args: [] } } }, null, 2)}\n`,
      "utf8"
    );
    await writeFile(path.join(target, "config", `${id}-instructions.md`), `Use Codexa for registered arm ${id}.\n`, "utf8");
  }
  for (const task of original.tasks) {
    const environment = path.join(target, task.path, "environment");
    const dockerfilePath = path.join(environment, "Dockerfile");
    let dockerfile = await readFile(dockerfilePath, "utf8");
    if (provisionCommands) {
      for (const id of armIds.slice(1)) {
        const basename = `start-codexa-mcp-${id}`;
        await writeFile(path.join(environment, `${basename}.sh`), `#!/usr/bin/env bash
set -euo pipefail
repo=/workspace/project
codexa=/opt/codexa-runtime/bin/codexa
exec "$codexa" serve "$repo"
`, "utf8");
        dockerfile += `COPY --chmod=0755 ${basename}.sh /opt/codexa-agent-ab/${basename}\n`;
      }
    }
    await writeFile(dockerfilePath, dockerfile, "utf8");
  }
  const value = {
    schemaVersion: 2,
    experimentId: "codexa-agent-ab-stepped-v2-test",
    framework: original.framework,
    runner: original.runner,
    candidate: original.candidate,
    design: { ...original.design, repetitions },
    tasks: original.tasks.map((task: Record<string, unknown>) => ({ ...task, expectedRouteClass: "source-only" })),
    arms,
    analysis: { ...original.analysis, comparisons }
  };
  const config = path.join(target, "experiment-v2.json");
  await writeFile(config, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  return { root: target, config };
}

async function createSyntheticV2Experiment(taskIds = ["task-a", "task-b"], expectedRouteClasses: Record<string, string> = {}) {
  const output = await mkdtemp(path.join(os.tmpdir(), "codexa-agent-ab-v2-analysis-"));
  const arms = armIds.map((id) => id === "control"
    ? { id, kind: "control" }
    : {
        id,
        kind: "codexa",
        mcpConfigHash: `mcp-${id}`,
        extraInstructionHash: `instruction-${id}`,
        serverCommand: `/opt/codexa-agent-ab/start-codexa-mcp-${id}`
      });
  const inputs = {
    schemaVersion: 2,
    tasks: taskIds.map((id) => ({ id, path: `inputs/tasks/${id}` })),
    arms: armIds.map((id) => id === "control"
      ? { id, kind: "control" }
      : {
          id,
          kind: "codexa",
          mcpConfig: `inputs/arms/${id}/mcp/codexa.mcp.json`,
          extraInstruction: `inputs/arms/${id}/instruction/codexa-instructions.md`
        })
  };
  const assignments = taskIds.flatMap((taskId) => armIds.map((arm, index) => ({
    runId: `${taskId}-${arm}`,
    taskId,
    taskName: `agent-ab-v2/${taskId}`,
    repetition: 1,
    arm,
    order: index + 1,
    jobName: `agent-ab-${taskId}-${arm}`
  })));
  const registration = {
    schemaVersion: 2,
    experimentId: "agent-ab-v2-analysis-test",
    createdAt: "2026-07-13T00:00:00.000Z",
    configHash: "v2-config-hash",
    framework: { name: "harbor", version: "0.18.0" },
    harness: { controllerHash: "controller", analyzerHash: "analyzer", mcpPreflightHash: "preflight-helper-hash" },
    runner: { agent: "codex", version: "0.144.1", kwargs: { reasoning_effort: "high" } },
    candidate: { codexaVersion: "0.12.0" },
    agent: "codex",
    model: "openai/test-model",
    tasks: taskIds.map((id) => ({
      id,
      name: `agent-ab-v2/${id}`,
      expectedRouteClass: expectedRouteClasses[id] ?? "source-only",
      hash: `hash-${id}`
    })),
    arms,
    comparisons,
    inputs,
    assignments
  };
  await writeFile(path.join(output, "registration.json"), `${JSON.stringify(registration, null, 2)}\n`, "utf8");
  await writeSyntheticPreflightReceipts(output, registration);
  const config = {
    schemaVersion: 2,
    design: { seed: "synthetic-v2-seed" },
    analysis: { primaryReward: "verified_completion", bootstrapSamples: 1_000, confidenceLevel: 0.95, comparisons }
  };
  return { config, outputDir: output, output, assignments, registration };
}

async function writeSyntheticPreflightReceipts(output: string, registration: Record<string, any>) {
  const directory = path.join(output, "preflight");
  await mkdir(directory, { recursive: true });
  for (const task of registration.tasks) {
    for (const arm of registration.arms.filter((entry: { kind: string }) => entry.kind === "codexa")) {
      const receipt = {
        schemaVersion: 1,
        kind: "schema-v2-mcp-preflight",
        experimentId: registration.experimentId,
        configHash: registration.configHash,
        taskId: task.id,
        taskHash: task.hash,
        serverCommand: arm.serverCommand,
        expectedServerInfo: { name: "codexa", version: registration.candidate.codexaVersion },
        mcpPreflightHash: registration.harness.mcpPreflightHash,
        observedServerInfo: { name: "codexa", version: registration.candidate.codexaVersion },
        completedAt: "2026-07-12T23:59:59.000Z"
      };
      await writeFile(syntheticPreflightReceiptPath({ output }, task.id, arm.serverCommand), `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
    }
  }
}

function syntheticPreflightReceiptPath(experiment: { output: string }, taskId: string, serverCommand: string) {
  const commandHash = createHash("sha256").update(serverCommand).digest("hex").slice(0, 24);
  return path.join(experiment.output, "preflight", `${taskId}-${commandHash}.json`);
}

function findSyntheticAssignment(
  experiment: Awaited<ReturnType<typeof createSyntheticV2Experiment>>,
  taskId: string,
  arm: string
) {
  const assignment = experiment.assignments.find((entry) => entry.taskId === taskId && entry.arm === arm);
  if (!assignment) {
    throw new Error(`missing synthetic assignment ${taskId}/${arm}`);
  }
  return assignment;
}

function syntheticTrialResultPath(
  experiment: Awaited<ReturnType<typeof createSyntheticV2Experiment>>,
  assignment: Record<string, any>
) {
  return path.join(
    experiment.output,
    "jobs",
    assignment.jobName,
    `${assignment.taskId}__fixture`,
    "result.json"
  );
}

async function writeSyntheticTrajectory(
  experiment: Awaited<ReturnType<typeof createSyntheticV2Experiment>>,
  taskId: string,
  trajectory: Record<string, unknown>
) {
  const assignment = findSyntheticAssignment(experiment, taskId, "adaptive-auto-bounded");
  const trial = path.dirname(syntheticTrialResultPath(experiment, assignment));
  await writeFile(path.join(trial, "trajectory.json"), `${JSON.stringify(trajectory)}\n`, "utf8");
}

function validServerEvent(sequence = 1) {
  return {
    schemaVersion: 1,
    sequence,
    outcome: "ok",
    tool: "task_brief",
    profile: "core",
    requestedFormat: "auto",
    effectiveFormat: "concise",
    requestBytes: 20,
    textBytes: 40,
    structuredBytes: 60,
    totalBytes: 120,
    elapsedMs: 5,
    unchangedReceipt: false
  };
}

function validServerCompletion(eventCount: number) {
  return {
    schemaVersion: 1,
    recordKind: "session-complete",
    sequence: eventCount + 1,
    eventCount
  };
}

function routedResultUri(hexCharacter: string) {
  const locator = `rr_${"a".repeat(32)}`;
  return `codexa://repo/mcp-results/${locator}/mr_${hexCharacter.repeat(64)}`;
}

async function writeSyntheticRun(
  experiment: Awaited<ReturnType<typeof createSyntheticV2Experiment>>,
  assignment: Record<string, any>,
  success: number,
  telemetry: "valid" | "string" | "ambiguous" | "none" | undefined = assignment.arm === "adaptive-auto-bounded" && assignment.taskId === "task-a" ? "valid" : "none"
) {
  telemetry ??= assignment.arm === "adaptive-auto-bounded" && assignment.taskId === "task-a" ? "valid" : "none";
  const attempts = path.join(experiment.output, "attempts");
  const runs = path.join(experiment.output, "runs");
  const job = path.join(experiment.output, "jobs", assignment.jobName);
  const trialName = `${assignment.taskId}__fixture`;
  const trial = path.join(job, trialName);
  await mkdir(attempts, { recursive: true });
  await mkdir(runs, { recursive: true });
  await mkdir(trial, { recursive: true });
  await writeFile(path.join(attempts, `${assignment.runId}.json`), `${JSON.stringify({
    schemaVersion: 1,
    experimentId: experiment.registration.experimentId,
    configHash: experiment.registration.configHash,
    agent: experiment.registration.agent,
    model: experiment.registration.model,
    harness: experiment.registration.harness,
    runner: experiment.registration.runner,
    runId: assignment.runId,
    taskId: assignment.taskId,
    taskName: assignment.taskName,
    repetition: assignment.repetition,
    arm: assignment.arm,
    order: assignment.order,
    jobName: assignment.jobName,
    startedAt: "2026-07-13T00:00:00.000Z"
  })}\n`, "utf8");
  await writeFile(path.join(runs, `${assignment.runId}.json`), `${JSON.stringify({
    schemaVersion: 1,
    runId: assignment.runId,
    taskId: assignment.taskId,
    repetition: assignment.repetition,
    arm: assignment.arm,
    order: assignment.order,
    exitCode: 0,
    timedOut: false,
    controllerElapsedMs: 500,
    jobResultPath: `jobs/${assignment.jobName}/result.json`
  })}\n`, "utf8");
  const jobId = `job-${assignment.runId}`;
  await writeFile(path.join(job, "result.json"), `${JSON.stringify({
    id: jobId,
    n_total_trials: 1,
    stats: { n_completed_trials: 1, n_errored_trials: 0 }
  })}\n`, "utf8");
  const registeredArm = experiment.registration.arms.find((arm: { id: string }) => arm.id === assignment.arm);
  const inputArm = experiment.registration.inputs.arms.find((arm: { id: string }) => arm.id === assignment.arm);
  const isControl = registeredArm.kind === "control";
  await writeFile(path.join(trial, "result.json"), `${JSON.stringify({
    task_name: assignment.taskName,
    trial_name: trialName,
    config: {
      job_id: jobId,
      task: { path: path.join(experiment.output, "inputs", "tasks", assignment.taskId) },
      agent: {
        name: experiment.registration.agent,
        model_name: experiment.registration.model,
        kwargs: { version: experiment.registration.runner.version, ...experiment.registration.runner.kwargs },
        mcp_servers: isControl ? [] : [{
          name: "codexa", transport: "stdio", url: null, command: registeredArm.serverCommand, args: []
        }]
      },
      extra_instruction_paths: isControl ? [] : [path.join(experiment.output, inputArm.extraInstruction)]
    },
    verifier_result: { rewards: { verified_completion: success } },
    agent_result: { n_input_tokens: 100, n_output_tokens: 20, cost_usd: 0.01 },
    agent_execution: { started_at: "2026-07-13T00:00:00.000Z", finished_at: "2026-07-13T00:00:00.250Z" },
    exception_info: null
  })}\n`, "utf8");

  if (telemetry !== "none") {
    const args = { task: "inspect café 🎭", responseFormat: "auto" };
    const callArguments = telemetry === "string"
      ? '{"task":"café 🎭","responseFormat":"auto"}'
      : args;
    const resultText = JSON.stringify({
      structuredContent: {
        schemaVersion: 1,
        data: {
          delivery: {
            requestedFormat: "auto",
            effectiveFormat: "detailed",
            escalationReason: "blocking_authority"
          }
        }
      },
      content: [{ type: "text", text: "résumé 🎭" }]
    });
    const call = { tool_call_id: "codexa-call", function_name: "mcp__codexa__task_brief", arguments: callArguments };
    const trajectory = telemetry === "ambiguous"
      ? {
          schema_version: "ATIF-v1.7",
          steps: [{
            tool_calls: [call, { ...call }],
            observation: { results: [{ source_call_id: "codexa-call", content: resultText }] }
          }]
        }
      : {
          schema_version: "ATIF-v1.7",
          steps: [{
            tool_calls: [call],
            observation: { results: [{ source_call_id: "codexa-call", content: resultText }] }
          }]
        };
    await writeFile(path.join(trial, "trajectory.json"), `${JSON.stringify(trajectory)}\n`, "utf8");
    await writeFile(
      path.join(trial, "codexa-mcp-telemetry.jsonl"),
      telemetry === "ambiguous"
        ? "{\"schemaVersion\":1,\"sequence\":1,\"tool\":\"task_brief\",\"secret\":\"not allowed\"}\n"
        : `${JSON.stringify({
            schemaVersion: 1,
            sequence: 1,
            tool: "task_brief",
            profile: "core",
            requestedFormat: "auto",
            effectiveFormat: "detailed",
            escalationReason: "blocking_authority",
            requestBytes: 47,
            textBytes: 83,
            structuredBytes: 211,
            totalBytes: 341,
            elapsedMs: 12.5,
            resultReference: "codexa://result/sha256/example",
            unchangedReceipt: false
          })}\n${JSON.stringify(validServerCompletion(1))}\n`,
      "utf8"
    );
  }
}

async function setSyntheticMetrics(
  experiment: Awaited<ReturnType<typeof createSyntheticV2Experiment>>,
  taskId: string,
  arm: string,
  metrics: {
    input: number;
    cache?: number;
    output: number;
    cost: number;
    agentElapsedMs: number;
    controllerElapsedMs: number;
  }
) {
  const assignment = findSyntheticAssignment(experiment, taskId, arm);
  const trialPath = syntheticTrialResultPath(experiment, assignment);
  const trial = JSON.parse(await readFile(trialPath, "utf8"));
  trial.agent_result = {
    n_input_tokens: metrics.input,
    ...(metrics.cache === undefined ? {} : { n_cache_tokens: metrics.cache }),
    n_output_tokens: metrics.output,
    cost_usd: metrics.cost
  };
  trial.agent_execution = {
    started_at: "2026-07-13T00:00:00.000Z",
    finished_at: new Date(Date.parse("2026-07-13T00:00:00.000Z") + metrics.agentElapsedMs).toISOString()
  };
  await writeFile(trialPath, `${JSON.stringify(trial)}\n`, "utf8");
  const runPath = path.join(experiment.output, "runs", `${assignment.runId}.json`);
  const runMetadata = JSON.parse(await readFile(runPath, "utf8"));
  runMetadata.controllerElapsedMs = metrics.controllerElapsedMs;
  await writeFile(runPath, `${JSON.stringify(runMetadata)}\n`, "utf8");
}
