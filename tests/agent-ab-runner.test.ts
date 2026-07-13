import { spawn, spawnSync } from "node:child_process";
import { constants } from "node:fs";
import {
  access,
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(root, "scripts", "agent-ab.mjs");
const benchmarkRoot = path.join(root, "benchmarks", "agent-ab");
const config = path.join(benchmarkRoot, "experiment.json");

describe("agent A/B runner lifecycle", () => {
  it("pins the generic runner and counterbalances order within each task", async () => {
    const output = await mkdtemp(path.join(os.tmpdir(), "codexa-agent-ab-order-"));
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
    const registration = JSON.parse(await readFile(path.join(output, "registration.json"), "utf8"));
    expect(registration.runner).toEqual({
      agent: "codex",
      version: "0.144.1",
      kwargs: { reasoning_effort: "high", web_search: "disabled" }
    });
    const treatmentOrders = registration.assignments
      .filter((entry: { arm: string }) => entry.arm === "treatment")
      .map((entry: { order: number }) => entry.order);
    expect(treatmentOrders.sort()).toEqual([1, 2]);

    const wrongAgent = run([
      "register",
      "--config",
      config,
      "--output",
      `${output}-wrong-agent`,
      "--agent",
      "claude-code",
      "--model",
      "example/model"
    ]);
    expect(wrongAgent.status).toBe(1);
    expect(wrongAgent.stderr).toContain("must match the registered runner agent");
  });

  it("binds configured task names and verifier baselines to the submitted fixture", async () => {
    const fixture = await copyBenchmark({});
    const fixtureConfig = path.join(fixture, "experiment.json");
    const value = JSON.parse(await readFile(fixtureConfig, "utf8"));
    value.tasks[0].name = "external-pack/arbitrary-task";
    await writeFile(fixtureConfig, `${JSON.stringify(value, null, 2)}\n`, "utf8");

    const mismatchedName = run(["validate", "--config", fixtureConfig]);
    expect(mismatchedName.status).toBe(1);
    expect(mismatchedName.stderr).toContain("must match configured task name");

    value.tasks[0].name = "codexa-agent-ab/path-target-normalization";
    await writeFile(fixtureConfig, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await writeFile(
      path.join(fixture, "tasks", "path-target-normalization", "tests", "baseline", "README.md"),
      "stale verifier baseline\n",
      "utf8"
    );
    const staleBaseline = run(["validate", "--config", fixtureConfig]);
    expect(staleBaseline.status).toBe(1);
    expect(staleBaseline.stderr).toContain("must exactly match environment/project");
  });

  it("does not accept commented decoys for verifier isolation or artifact transfer", async () => {
    const fixture = await copyBenchmark({});
    const fixtureConfig = path.join(fixture, "experiment.json");
    const taskToml = path.join(fixture, "tasks", "path-target-normalization", "task.toml");
    const original = await readFile(taskToml, "utf8");
    await writeFile(
      taskToml,
      original.replace(
        'environment_mode = "separate"',
        'environment_mode = "same" # environment_mode = "separate"'
      ),
      "utf8"
    );
    const sharedVerifier = run(["validate", "--config", fixtureConfig]);
    expect(sharedVerifier.status).toBe(1);
    expect(sharedVerifier.stderr).toContain("must use a separate verifier");

    await writeFile(
      taskToml,
      original
        .replace('source = "/workspace/project"', 'source = "/workspace/other"')
        .replace("artifacts = [", 'artifacts = [\n  # "/workspace/project",'),
      "utf8"
    );
    const missingArtifact = run(["validate", "--config", fixtureConfig]);
    expect(missingArtifact.status).toBe(1);
    expect(missingArtifact.stderr).toContain("must transfer /workspace/project");

    await writeFile(taskToml, original.replace('"*.pyc"', '"*.cache"'), "utf8");
    const bytecodeTransfer = run(["validate", "--config", fixtureConfig]);
    expect(bytecodeTransfer.status).toBe(1);
    expect(bytecodeTransfer.stderr).toContain("must exclude Git, Codexa state, and Python bytecode");
  });

  it("runs the registered task snapshot even if the live task changes", async () => {
    const fixture = await copyBenchmark({ repetitions: 1 });
    const fixtureConfig = path.join(fixture, "experiment.json");
    const liveInstruction = path.join(fixture, "tasks", "path-target-normalization", "instruction.md");
    const registeredInstruction = await readFile(liveInstruction, "utf8");
    const output = await mkdtemp(path.join(os.tmpdir(), "codexa-agent-ab-live-drift-"));
    const registered = run([
      "register",
      "--config",
      fixtureConfig,
      "--output",
      output,
      "--agent",
      "codex",
      "--model",
      "openai/example-model"
    ]);
    expect(registered.status, registered.stderr).toBe(0);
    const registration = JSON.parse(await readFile(path.join(output, "registration.json"), "utf8"));

    await writeFile(liveInstruction, "The live task changed after registration.\n", "utf8");
    const fake = await makeFakeUvx(`
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const taskPath = args[args.indexOf("--path") + 1];
const instruction = fs.readFileSync(path.join(taskPath, "instruction.md"), "utf8");
fs.appendFileSync(process.env.FAKE_UVX_LOG, JSON.stringify({ taskPath, instruction }) + "\\n");
`);
    const log = path.join(output, "uvx.jsonl");
    const result = run([
      "run",
      "--config",
      fixtureConfig,
      "--output",
      output,
      "--agent",
      "codex",
      "--model",
      "openai/example-model",
      "--resume"
    ], { ...process.env, PATH: `${fake.bin}:${process.env.PATH}`, FAKE_UVX_LOG: log });

    expect(result.status, result.stderr).toBe(0);
    const invocations = await readJsonLines(log);
    expect(invocations).toHaveLength(2);
    const snapshotTask = path.resolve(output, registration.inputs.tasks[0].path);
    for (const invocation of invocations) {
      expect(invocation.taskPath).toBe(snapshotTask);
      expect(invocation.taskPath).not.toBe(path.dirname(liveInstruction));
      expect(invocation.instruction).toBe(registeredInstruction);
    }
  });

  it("rejects registered task snapshot content or mode changes before spawn", async () => {
    const fixture = await copyBenchmark({ repetitions: 1 });
    const fixtureConfig = path.join(fixture, "experiment.json");
    const fake = await makeFakeUvx(`
const fs = require("node:fs");
fs.appendFileSync(process.env.FAKE_UVX_LOG, "spawned\\n");
`);

    const contentOutput = await mkdtemp(path.join(os.tmpdir(), "codexa-agent-ab-snapshot-content-"));
    const contentRegistration = await registerFixture(fixtureConfig, contentOutput);
    const contentSnapshot = path.join(
      contentOutput,
      contentRegistration.inputs.tasks[0].path,
      "instruction.md"
    );
    await writeFile(contentSnapshot, "The registered snapshot was tampered with.\n", "utf8");
    const contentLog = path.join(contentOutput, "uvx.log");
    const contentResult = run([
      "run",
      "--config",
      fixtureConfig,
      "--output",
      contentOutput,
      "--agent",
      "codex",
      "--model",
      "openai/example-model",
      "--resume"
    ], { ...process.env, PATH: `${fake.bin}:${process.env.PATH}`, FAKE_UVX_LOG: contentLog });
    expect(contentResult.status).toBe(1);
    expect(contentResult.stderr).toContain("task input snapshot hash differs from registration");
    expect(await exists(contentLog)).toBe(false);

    const modeOutput = await mkdtemp(path.join(os.tmpdir(), "codexa-agent-ab-snapshot-mode-"));
    const modeRegistration = await registerFixture(fixtureConfig, modeOutput);
    const modeSnapshot = path.join(
      modeOutput,
      modeRegistration.inputs.tasks[0].path,
      "instruction.md"
    );
    const originalMode = (await stat(modeSnapshot)).mode & 0o777;
    await chmod(modeSnapshot, originalMode ^ constants.S_IXUSR);
    const modeLog = path.join(modeOutput, "uvx.log");
    const modeResult = run([
      "run",
      "--config",
      fixtureConfig,
      "--output",
      modeOutput,
      "--agent",
      "codex",
      "--model",
      "openai/example-model",
      "--resume"
    ], { ...process.env, PATH: `${fake.bin}:${process.env.PATH}`, FAKE_UVX_LOG: modeLog });
    expect(modeResult.status).toBe(1);
    expect(modeResult.stderr).toContain("task input snapshot hash differs from registration");
    expect(await exists(modeLog)).toBe(false);
  });

  it("journals the exact assignment before spawn and never retries it on resume", async () => {
    const fixture = await copyBenchmark({ repetitions: 1 });
    const fixtureConfig = path.join(fixture, "experiment.json");
    const output = await mkdtemp(path.join(os.tmpdir(), "codexa-agent-ab-attempt-"));
    const fake = await makeFakeUvx(`
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const jobsDir = args[args.indexOf("--jobs-dir") + 1];
const jobName = args[args.indexOf("--job-name") + 1];
const runId = jobName.replace(/^agent-ab-/, "");
const attemptPath = path.join(path.dirname(jobsDir), "attempts", runId + ".json");
const attempt = JSON.parse(fs.readFileSync(attemptPath, "utf8"));
fs.appendFileSync(process.env.FAKE_UVX_LOG, JSON.stringify({ args, attempt }) + "\\n");
`);
    const log = path.join(output, "uvx.jsonl");
    const env = { ...process.env, PATH: `${fake.bin}:${process.env.PATH}`, FAKE_UVX_LOG: log };
    const args = [
      "run",
      "--config",
      fixtureConfig,
      "--output",
      output,
      "--agent",
      "codex",
      "--model",
      "openai/example-model"
    ];

    const first = run(args, env);
    expect(first.status, first.stderr).toBe(0);
    const registration = JSON.parse(await readFile(path.join(output, "registration.json"), "utf8"));
    const invocations = await readJsonLines(log);
    expect(invocations).toHaveLength(2);
    for (const invocation of invocations) {
      const assignment = registration.assignments.find((entry: { runId: string }) => entry.runId === invocation.attempt.runId);
      expect(assignment).toBeDefined();
      expect(invocation.attempt).toMatchObject({
        schemaVersion: 1,
        experimentId: registration.experimentId,
        configHash: registration.configHash,
        agent: registration.agent,
        model: registration.model,
        runner: registration.runner,
        harness: registration.harness,
        ...assignment
      });
      expect(Number.isFinite(Date.parse(invocation.attempt.startedAt))).toBe(true);
      expect(agentKwargs(invocation.args)).toEqual([
        "version=0.144.1",
        "reasoning_effort=high",
        "web_search=disabled"
      ]);
    }

    const missingFinal = registration.assignments[0];
    await rm(path.join(output, "runs", `${missingFinal.runId}.json`));
    const resumed = run([...args, "--resume"], env);
    expect(resumed.status).toBe(0);
    expect(await readJsonLines(log)).toHaveLength(2);
  });

  it("rejects output roots and runner subdirectories that escape through symlinks", async () => {
    const target = path.join(benchmarkRoot, "tasks", "path-target-normalization", "environment", "project");
    const parent = await mkdtemp(path.join(os.tmpdir(), "codexa-agent-ab-symlink-"));
    const linkedOutput = path.join(parent, "output");
    await symlink(target, linkedOutput, "dir");

    const linkedRoot = run([
      "register",
      "--config",
      config,
      "--output",
      linkedOutput,
      "--agent",
      "codex",
      "--model",
      "openai/example-model"
    ]);
    expect(linkedRoot.status).toBe(1);
    expect(linkedRoot.stderr).toContain("may not contain symlink components");

    const output = await mkdtemp(path.join(os.tmpdir(), "codexa-agent-ab-subdir-"));
    const registered = run([
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
    expect(registered.status).toBe(0);
    await symlink(target, path.join(output, "attempts"), "dir");
    const escapedSubdirectory = run([
      "run",
      "--config",
      config,
      "--output",
      output,
      "--agent",
      "codex",
      "--model",
      "openai/example-model",
      "--resume"
    ]);
    expect(escapedSubdirectory.status).toBe(1);
    expect(escapedSubdirectory.stderr).toContain("must be a real directory, not a symlink");
  });

  it("SIGKILLs the timed-out process group after grace even if its leader exits", async () => {
    const fixture = await copyBenchmark({ repetitions: 1, controllerTimeoutSeconds: 1 });
    const fixtureConfig = path.join(fixture, "experiment.json");
    const output = await mkdtemp(path.join(os.tmpdir(), "codexa-agent-ab-timeout-"));
    const registered = run([
      "register",
      "--config",
      fixtureConfig,
      "--output",
      output,
      "--agent",
      "codex",
      "--model",
      "openai/example-model"
    ]);
    expect(registered.status).toBe(0);
    const registration = JSON.parse(await readFile(path.join(output, "registration.json"), "utf8"));
    await mkdir(path.join(output, "attempts"));
    await writeFile(
      path.join(output, "attempts", `${registration.assignments[0].runId}.json`),
      `${JSON.stringify(attemptRecord(registration, registration.assignments[0]))}\n`,
      { encoding: "utf8", mode: 0o600 }
    );

    const fake = await makeFakeUvx(`
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const child = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: "ignore" });
fs.writeFileSync(process.env.FAKE_UVX_CHILD_PID, String(child.pid));
process.on("SIGTERM", () => process.exit(0));
setInterval(() => {}, 1000);
`);
    const childPidFile = path.join(output, "child.pid");
    const env = { ...process.env, PATH: `${fake.bin}:${process.env.PATH}`, FAKE_UVX_CHILD_PID: childPidFile };
    let childPid: number | undefined;
    try {
      const started = Date.now();
      const result = await runAsync([
        "run",
        "--config",
        fixtureConfig,
        "--output",
        output,
        "--agent",
        "codex",
        "--model",
        "openai/example-model",
        "--resume"
      ], env);
      expect(result.status, result.stderr).toBe(0);
      expect(Date.now() - started).toBeGreaterThanOrEqual(5500);
      childPid = Number.parseInt(await readFile(childPidFile, "utf8"), 10);
      expect(Number.isInteger(childPid)).toBe(true);
      await expectProcessToStop(childPid);
      const run = JSON.parse(await readFile(path.join(output, "runs", `${registration.assignments[1].runId}.json`), "utf8"));
      expect(run.timedOut).toBe(true);
    } finally {
      if (childPid && processIsRunning(childPid)) {
        process.kill(childPid, "SIGKILL");
      }
    }
  }, 15_000);

  it("stops after external interruption, cleans the group, and leaves only the start journal", async () => {
    const fixture = await copyBenchmark({ repetitions: 1 });
    const fixtureConfig = path.join(fixture, "experiment.json");
    const output = await mkdtemp(path.join(os.tmpdir(), "codexa-agent-ab-interrupt-"));
    const registered = run([
      "register",
      "--config",
      fixtureConfig,
      "--output",
      output,
      "--agent",
      "codex",
      "--model",
      "openai/example-model"
    ]);
    expect(registered.status).toBe(0);
    const registration = JSON.parse(await readFile(path.join(output, "registration.json"), "utf8"));

    const fake = await makeFakeUvx(`
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const child = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: "ignore" });
fs.writeFileSync(process.env.FAKE_UVX_CHILD_PID, String(child.pid));
process.on("SIGTERM", () => process.exit(0));
setInterval(() => {}, 1000);
`);
    const childPidFile = path.join(output, "child.pid");
    const env = { ...process.env, PATH: `${fake.bin}:${process.env.PATH}`, FAKE_UVX_CHILD_PID: childPidFile };
    const running = startAsync([
      "run",
      "--config",
      fixtureConfig,
      "--output",
      output,
      "--agent",
      "codex",
      "--model",
      "openai/example-model",
      "--resume"
    ], env);
    let childPid: number | undefined;
    try {
      await waitForFile(childPidFile);
      childPid = Number.parseInt(await readFile(childPidFile, "utf8"), 10);
      const interruptedAt = Date.now();
      running.child.kill("SIGTERM");
      const result = await running.completed;
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("controller interrupted by SIGTERM");
      expect(Date.now() - interruptedAt).toBeGreaterThanOrEqual(4500);
      await expectProcessToStop(childPid);

      const assignment = registration.assignments[0];
      expect(await exists(path.join(output, "attempts", `${assignment.runId}.json`))).toBe(true);
      expect(await exists(path.join(output, "runs", `${assignment.runId}.json`))).toBe(false);
    } finally {
      if (running.child.exitCode === null) {
        running.child.kill("SIGKILL");
      }
      if (childPid && processIsRunning(childPid)) {
        process.kill(childPid, "SIGKILL");
      }
    }
  }, 15_000);
});

function run(args: string[], env = process.env): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, [script, ...args], { cwd: root, env, encoding: "utf8" });
}

function runAsync(args: string[], env: NodeJS.ProcessEnv): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return startAsync(args, env).completed;
}

function startAsync(args: string[], env: NodeJS.ProcessEnv): {
  child: ReturnType<typeof spawn>;
  completed: Promise<{ status: number | null; stdout: string; stderr: string }>;
} {
  const child = spawn(process.execPath, [script, ...args], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  const completed = new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (status) => resolve({ status, stdout, stderr }));
  });
  return { child, completed };
}

async function copyBenchmark(overrides: { repetitions?: number; controllerTimeoutSeconds?: number }): Promise<string> {
  const parent = await mkdtemp(path.join(os.tmpdir(), "codexa-agent-ab-runner-config-"));
  const target = path.join(parent, "agent-ab");
  await cp(benchmarkRoot, target, { recursive: true });
  const targetConfig = path.join(target, "experiment.json");
  const value = JSON.parse(await readFile(targetConfig, "utf8"));
  Object.assign(value.design, overrides);
  await writeFile(targetConfig, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  return target;
}

async function registerFixture(fixtureConfig: string, output: string): Promise<Record<string, any>> {
  const result = run([
    "register",
    "--config",
    fixtureConfig,
    "--output",
    output,
    "--agent",
    "codex",
    "--model",
    "openai/example-model"
  ]);
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(await readFile(path.join(output, "registration.json"), "utf8"));
}

async function makeFakeUvx(driverBody: string): Promise<{ bin: string }> {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "codexa-agent-ab-fake-uvx-"));
  const bin = path.join(rootDir, "bin");
  await mkdir(bin);
  const driver = path.join(rootDir, "driver.cjs");
  const executable = path.join(bin, "uvx");
  await writeFile(driver, `${driverBody.trim()}\n`, "utf8");
  await writeFile(executable, `#!/bin/sh\nexec "${process.execPath}" "${driver}" "$@"\n`, "utf8");
  await chmod(executable, constants.S_IRWXU);
  return { bin };
}

function agentKwargs(args: string[]): string[] {
  const values = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--agent-kwarg") {
      values.push(args[index + 1]);
    }
  }
  return values;
}

function attemptRecord(registration: Record<string, any>, assignment: Record<string, any>): Record<string, unknown> {
  return {
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
    startedAt: new Date().toISOString()
  };
}

async function readJsonLines(file: string): Promise<any[]> {
  const raw = await readFile(file, "utf8");
  return raw.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

async function expectProcessToStop(pid: number): Promise<void> {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (!processIsRunning(pid)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  expect(processIsRunning(pid)).toBe(false);
}

async function waitForFile(file: string): Promise<void> {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (await exists(file)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${file}`);
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

function processIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    try {
      const state = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).stdout.trim();
      return state.length > 0 && !state.startsWith("Z");
    } catch {
      return true;
    }
  } catch {
    return false;
  }
}
