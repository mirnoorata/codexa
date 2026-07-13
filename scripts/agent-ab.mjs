#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeAgentAb } from "./agent-ab-analysis.mjs";

const TERMINATION_GRACE_MS = 5000;
const CONTROLLER_PATH = fileURLToPath(import.meta.url);
const ANALYZER_PATH = path.join(path.dirname(CONTROLLER_PATH), "agent-ab-analysis.mjs");

const command = process.argv[2];
const options = parseOptions(process.argv.slice(3));

try {
  if (command === "validate") {
    const loaded = loadAndValidateConfig(requiredOption(options, "config"));
    printJson(validationSummary(loaded));
  } else if (command === "register") {
    const loaded = loadAndValidateConfig(requiredOption(options, "config"));
    const registration = createOrLoadRegistration({ loaded, options, allowExisting: Boolean(options.resume) });
    printJson(registration);
  } else if (command === "run") {
    const loaded = loadAndValidateConfig(requiredOption(options, "config"));
    const registration = createOrLoadRegistration({ loaded, options, allowExisting: Boolean(options.resume) });
    await executeAssignments({ loaded, registration, options });
    const summary = analyzeAgentAb({ config: loaded.config, outputDir: registration.outputDir });
    printJson({
      experimentId: summary.experimentId,
      observedRuns: summary.observedRuns,
      registeredRuns: summary.registeredRuns,
      summary: path.join(registration.outputDir, "summary.json")
    });
  } else if (command === "analyze") {
    const loaded = loadAndValidateConfig(requiredOption(options, "config"));
    const outputDir = validateOutputPath(requiredOption(options, "output"), loaded);
    requireMatchingRegistration(loaded, outputDir, options);
    const summary = analyzeAgentAb({ config: loaded.config, outputDir });
    printJson(summary);
  } else {
    usage(command ? `unknown command: ${command}` : undefined);
  }
} catch (error) {
  console.error(`agent-ab: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}

function usage(error) {
  if (error) {
    console.error(`agent-ab: ${error}`);
  }
  console.error(`Usage:
  node scripts/agent-ab.mjs validate --config <experiment.json>
  node scripts/agent-ab.mjs register --config <experiment.json> --output <dir> --agent <agent> --model <model>
  node scripts/agent-ab.mjs run --config <experiment.json> --output <dir> --agent <agent> --model <model> [--resume]
  node scripts/agent-ab.mjs analyze --config <experiment.json> --output <dir> [--agent <agent> --model <model>]

Real runs use uvx with the Harbor version pinned by the experiment. Harbor
telemetry is disabled. API credentials are inherited by Harbor but are never
copied into registration or summary artifacts.`);
  process.exitCode = 1;
}

function parseOptions(args) {
  const allowed = new Set(["config", "output", "agent", "model", "resume"]);
  const parsed = {};
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (!token.startsWith("--")) {
      throw new Error(`unexpected positional argument: ${token}`);
    }
    const name = token.slice(2);
    if (!allowed.has(name)) {
      throw new Error(`unknown option: --${name}`);
    }
    if (Object.hasOwn(parsed, name)) {
      throw new Error(`duplicate option: --${name}`);
    }
    if (name === "resume") {
      parsed[name] = true;
      continue;
    }
    const value = args[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`--${name} requires a value`);
    }
    parsed[name] = value;
    index += 1;
  }
  return parsed;
}

function loadAndValidateConfig(inputPath) {
  const absolute = path.resolve(inputPath);
  const raw = readBoundedText(absolute, 256 * 1024, "experiment configuration");
  let config;
  try {
    config = JSON.parse(raw);
  } catch (error) {
    throw new Error(`invalid experiment JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  validateConfigObject(config);
  const baseDir = path.dirname(absolute);
  const taskEntries = config.tasks.map((task) => {
    const taskPath = resolveContainedPath(baseDir, task.path, `task ${task.id}`);
    validateTask(taskPath, config.candidate.codexaVersion, task.name);
    return { ...task, absolutePath: taskPath, hash: hashDirectory(taskPath) };
  });
  const mcpConfigPath = resolveContainedPath(baseDir, config.treatment.mcpConfig, "treatment MCP config");
  const extraInstructionPath = resolveContainedPath(baseDir, config.treatment.extraInstruction, "treatment instruction");
  validateTreatmentFiles(mcpConfigPath, extraInstructionPath);
  return {
    absolute,
    baseDir,
    config,
    configHash: sha256(raw),
    tasks: taskEntries,
    mcpConfigPath,
    extraInstructionPath,
    mcpConfigHash: hashFile(mcpConfigPath),
    extraInstructionHash: hashFile(extraInstructionPath),
    harness: {
      controllerHash: hashFile(CONTROLLER_PATH),
      analyzerHash: hashFile(ANALYZER_PATH)
    }
  };
}

function validateConfigObject(config) {
  assertObject(config, "experiment configuration");
  assertKeys(config, ["schemaVersion", "experimentId", "framework", "runner", "candidate", "design", "tasks", "treatment", "analysis"], "experiment configuration");
  if (config.schemaVersion !== 1) {
    throw new Error("schemaVersion must be 1");
  }
  assertIdentifier(config.experimentId, "experimentId");
  assertObject(config.framework, "framework");
  assertKeys(config.framework, ["name", "version"], "framework");
  if (config.framework.name !== "harbor" || !/^0\.18\.0$/u.test(config.framework.version)) {
    throw new Error("framework must pin Harbor 0.18.0");
  }
  validateRunner(config.runner);
  assertObject(config.candidate, "candidate");
  assertKeys(config.candidate, ["codexaVersion"], "candidate");
  if (!/^\d+\.\d+\.\d+$/u.test(config.candidate.codexaVersion)) {
    throw new Error("candidate.codexaVersion must be an exact stable semver");
  }
  validateDesign(config.design);
  validateAnalysis(config.analysis);
  if (!Array.isArray(config.tasks) || config.tasks.length < 1 || config.tasks.length > 100) {
    throw new Error("tasks must contain between 1 and 100 entries");
  }
  const taskIds = new Set();
  for (const task of config.tasks) {
    assertObject(task, "task");
    assertKeys(task, ["id", "name", "path"], "task");
    assertIdentifier(task.id, "task.id");
    validateTaskName(task.name, `task ${task.id} name`);
    assertSafeRelative(task.path, `task ${task.id} path`);
    if (taskIds.has(task.id)) {
      throw new Error(`duplicate task id: ${task.id}`);
    }
    taskIds.add(task.id);
  }
  assertObject(config.treatment, "treatment");
  assertKeys(config.treatment, ["mcpConfig", "extraInstruction"], "treatment");
  assertSafeRelative(config.treatment.mcpConfig, "treatment.mcpConfig");
  assertSafeRelative(config.treatment.extraInstruction, "treatment.extraInstruction");
}

function validateRunner(runner) {
  assertObject(runner, "runner");
  assertKeys(runner, ["agent", "version", "kwargs"], "runner");
  validateCliLabel(runner.agent, "runner.agent");
  if (!/^\d+\.\d+\.\d+$/u.test(runner.version)) {
    throw new Error("runner.version must be an exact stable semver");
  }
  assertObject(runner.kwargs, "runner.kwargs");
  if (Object.hasOwn(runner.kwargs, "version")) {
    throw new Error("runner.kwargs may not override the pinned runner.version");
  }
  for (const [key, value] of Object.entries(runner.kwargs)) {
    if (!/^[a-z][a-z0-9_]{0,63}$/u.test(key)) {
      throw new Error(`runner kwarg name is invalid: ${key}`);
    }
    if (typeof value !== "string" || value.length === 0 || value.length > 200 || /[\u0000-\u001f\u007f]/u.test(value)) {
      throw new Error(`runner kwarg ${key} must be a bounded printable string`);
    }
  }
}

function validateDesign(design) {
  assertObject(design, "design");
  assertKeys(design, ["seed", "repetitions", "concurrency", "maxRetries", "timeoutMultiplier", "controllerTimeoutSeconds"], "design");
  if (typeof design.seed !== "string" || design.seed.length < 8 || design.seed.length > 200) {
    throw new Error("design.seed must contain 8-200 characters");
  }
  integerInRange(design.repetitions, 1, 20, "design.repetitions");
  if (design.concurrency !== 1) {
    throw new Error("design.concurrency must be 1 because adjacent paired assignments execute sequentially");
  }
  if (design.maxRetries !== 0) {
    throw new Error("design.maxRetries must be 0 so infrastructure and agent failures remain ITT failures");
  }
  numberInRange(design.timeoutMultiplier, 0.1, 10, "design.timeoutMultiplier");
  integerInRange(design.controllerTimeoutSeconds, 1, 7200, "design.controllerTimeoutSeconds");
}

function validateAnalysis(analysis) {
  assertObject(analysis, "analysis");
  assertKeys(analysis, ["primaryReward", "bootstrapSamples", "confidenceLevel", "generalizationUnit", "failurePolicy"], "analysis");
  assertIdentifier(analysis.primaryReward, "analysis.primaryReward");
  integerInRange(analysis.bootstrapSamples, 1000, 100000, "analysis.bootstrapSamples");
  numberInRange(analysis.confidenceLevel, 0.8, 0.999, "analysis.confidenceLevel");
  if (analysis.generalizationUnit !== "task") {
    throw new Error("analysis.generalizationUnit must be task");
  }
  if (analysis.failurePolicy !== "intention-to-treat") {
    throw new Error("analysis.failurePolicy must be intention-to-treat");
  }
}

function validateTask(taskPath, codexaVersion, expectedTaskName) {
  const required = [
    "instruction.md",
    "task.toml",
    "environment/Dockerfile",
    "environment/codexa-mcp-entrypoint.sh",
    "environment/project/.gitignore",
    "solution/solve.sh",
    "tests/Dockerfile",
    "tests/candidate_runner.py",
    "tests/public_test_runner.py",
    "tests/test.sh"
  ];
  for (const file of required) {
    const target = path.join(taskPath, file);
    if (!existsSync(target) || !statSync(target).isFile()) {
      throw new Error(`task is missing required file: ${file}`);
    }
  }
  rejectSymlinksAndOversizedFiles(taskPath);
  const baselinePath = path.join(taskPath, "tests/baseline");
  const baselineStat = lstatIfExists(baselinePath);
  if (baselineStat) {
    if (!baselineStat.isDirectory() || baselineStat.isSymbolicLink()) {
      throw new Error("tests/baseline must be a real directory when present");
    }
    const projectPath = path.join(taskPath, "environment/project");
    if (hashDirectory(baselinePath) !== hashDirectory(projectPath)) {
      throw new Error("tests/baseline must exactly match environment/project");
    }
  }
  const taskToml = readBoundedText(path.join(taskPath, "task.toml"), 128 * 1024, "task.toml");
  const taskName = readRequiredTomlString(taskToml, "task", "name");
  if (taskName !== expectedTaskName) {
    throw new Error(`task.toml [task].name must match configured task name: ${expectedTaskName}`);
  }
  const artifacts = readRequiredTomlValue(taskToml, undefined, "artifacts");
  if (!tomlArtifactsIncludeSource(artifacts, "/workspace/project")) {
    throw new Error("task.toml must transfer /workspace/project to the verifier");
  }
  if (!tomlArtifactHasExcludes(artifacts, "/workspace/project", [".git", ".codex", "__pycache__", "*.pyc"])) {
    throw new Error("task.toml project transfer must exclude Git, Codexa state, and Python bytecode");
  }
  if (readRequiredTomlString(taskToml, "verifier", "environment_mode") !== "separate") {
    throw new Error("task.toml must use a separate verifier");
  }
  if (readRequiredTomlString(taskToml, "verifier.environment", "network_mode") !== "no-network") {
    throw new Error("the separate verifier must use no-network mode");
  }
  const dockerfile = readBoundedText(path.join(taskPath, "environment/Dockerfile"), 128 * 1024, "agent Dockerfile");
  if (!dockerfile.includes(`ARG CODEXA_VERSION=${codexaVersion}`)) {
    throw new Error("agent Dockerfile Codexa version does not match experiment candidate");
  }
  if (!dockerfile.includes("npm install --global --prefix /opt/codexa-runtime")) {
    throw new Error("agent Dockerfile must keep Codexa out of the control agent PATH");
  }
  if (/^\s*(?:COPY|ADD)\s+(?:\.\.?\/|tests\/)/imu.test(dockerfile)) {
    throw new Error("agent Dockerfile may not copy the task root or agent-inaccessible verifier tests");
  }
  const instruction = readBoundedText(path.join(taskPath, "instruction.md"), 128 * 1024, "task instruction");
  if (/\bcodexa\b/iu.test(instruction)) {
    throw new Error("base task instruction may not mention Codexa");
  }
  const gitignore = readBoundedText(path.join(taskPath, "environment/project/.gitignore"), 64 * 1024, "fixture .gitignore");
  if (!gitignore.split(/\r?\n/u).includes(".codex/")) {
    throw new Error("fixture .gitignore must ignore .codex/");
  }
  const entrypoint = readBoundedText(path.join(taskPath, "environment/codexa-mcp-entrypoint.sh"), 128 * 1024, "Codexa MCP entrypoint");
  if (!entrypoint.includes("repo=/workspace/project") || !entrypoint.includes("codexa=/opt/codexa-runtime/bin/codexa")) {
    throw new Error("Codexa MCP entrypoint must use the sandbox checkout and isolated runtime");
  }
}

function validateTreatmentFiles(mcpConfigPath, instructionPath) {
  const mcp = JSON.parse(readBoundedText(mcpConfigPath, 128 * 1024, "treatment MCP config"));
  assertObject(mcp, "treatment MCP config");
  assertKeys(mcp, ["mcpServers"], "treatment MCP config");
  assertObject(mcp.mcpServers, "treatment MCP servers");
  assertKeys(mcp.mcpServers, ["codexa"], "treatment MCP servers");
  const server = mcp.mcpServers.codexa;
  assertObject(server, "Codexa MCP server");
  assertKeys(server, ["command", "args"], "Codexa MCP server");
  if (server.command !== "/opt/codexa-agent-ab/start-codexa-mcp") {
    throw new Error("Codexa MCP command must use the sandbox-local entrypoint");
  }
  if (JSON.stringify(server.args) !== JSON.stringify([])) {
    throw new Error("Codexa MCP args must be empty for Harbor 0.18 Codex compatibility");
  }
  const instruction = readBoundedText(instructionPath, 128 * 1024, "treatment instruction");
  if (!/\bCodexa\b/u.test(instruction) || instruction.length > 4000) {
    throw new Error("treatment instruction must name Codexa and stay under 4000 characters");
  }
}

function createOrLoadRegistration({ loaded, options, allowExisting }) {
  const outputInput = requiredOption(options, "output");
  const agent = validateCliLabel(requiredOption(options, "agent"), "agent");
  const model = validateCliLabel(requiredOption(options, "model"), "model");
  if (agent !== loaded.config.runner.agent) {
    throw new Error(`--agent must match the registered runner agent: ${loaded.config.runner.agent}`);
  }
  let outputDir = validateOutputPath(outputInput, loaded);
  let registrationPath = path.join(outputDir, "registration.json");
  if (pathEntryExists(registrationPath)) {
    if (!allowExisting) {
      throw new Error("registration already exists; pass --resume to continue without changing it");
    }
    return requireMatchingRegistration(loaded, outputDir, { agent, model });
  }
  mkdirSync(outputDir, { recursive: true, mode: 0o700 });
  outputDir = validateOutputPath(outputInput, loaded);
  registrationPath = path.join(outputDir, "registration.json");
  const inputs = inputSnapshotLayout(loaded.config);
  const registration = {
    schemaVersion: 1,
    experimentId: loaded.config.experimentId,
    createdAt: new Date().toISOString(),
    outputDir,
    configHash: loaded.configHash,
    framework: loaded.config.framework,
    harness: loaded.harness,
    runner: loaded.config.runner,
    candidate: loaded.config.candidate,
    agent,
    model,
    treatment: {
      mcpConfigHash: loaded.mcpConfigHash,
      extraInstructionHash: loaded.extraInstructionHash
    },
    tasks: loaded.tasks.map((task) => ({ id: task.id, name: task.name, hash: task.hash })),
    inputs,
    assignments: buildAssignments(loaded.config)
  };
  snapshotExperimentInputs(loaded, registration, outputDir);
  writeExclusiveJson(registrationPath, publicRegistration(registration));
  return registration;
}

function requireMatchingRegistration(loaded, outputDir, options) {
  const file = path.join(outputDir, "registration.json");
  if (!pathEntryExists(file)) {
    throw new Error("registration.json is missing; register or run the experiment first");
  }
  requireRegularFile(file, "registration.json");
  const registration = JSON.parse(readBoundedText(file, 2 * 1024 * 1024, "registration"));
  if (registration.configHash !== loaded.configHash) {
    throw new Error("experiment configuration changed after registration");
  }
  if (options.agent && registration.agent !== options.agent) {
    throw new Error("agent differs from the immutable registration");
  }
  if (options.model && registration.model !== options.model) {
    throw new Error("model differs from the immutable registration");
  }
  if (JSON.stringify(registration.runner) !== JSON.stringify(loaded.config.runner)) {
    throw new Error("runner configuration changed after registration");
  }
  if (JSON.stringify(registration.harness) !== JSON.stringify(loaded.harness)) {
    throw new Error("agent A/B harness source changed after registration");
  }
  const expectedTaskIdentity = loaded.config.tasks.map((task) => ({ id: task.id, name: task.name }));
  const registeredTaskIdentity = Array.isArray(registration.tasks)
    ? registration.tasks.map((task) => ({ id: task.id, name: task.name }))
    : [];
  if (JSON.stringify(registeredTaskIdentity) !== JSON.stringify(expectedTaskIdentity)) {
    throw new Error("registered task identity changed after registration");
  }
  if (JSON.stringify(registration.inputs) !== JSON.stringify(inputSnapshotLayout(loaded.config))) {
    throw new Error("registered input snapshot layout changed after registration");
  }
  const expectedAssignments = buildAssignments(loaded.config);
  if (JSON.stringify(registration.assignments) !== JSON.stringify(expectedAssignments)) {
    throw new Error("registered assignments do not match the deterministic experiment design");
  }
  resolveRegisteredInputs(registration, outputDir);
  return { ...registration, outputDir };
}

function inputSnapshotLayout(config) {
  return {
    schemaVersion: 1,
    tasks: config.tasks.map((task) => ({
      id: task.id,
      path: path.posix.join("inputs", "tasks", task.id)
    })),
    treatment: {
      mcpConfig: path.posix.join("inputs", "treatment", "mcp", path.posix.basename(config.treatment.mcpConfig)),
      extraInstruction: path.posix.join("inputs", "treatment", "instruction", path.posix.basename(config.treatment.extraInstruction))
    }
  };
}

function snapshotExperimentInputs(loaded, registration, outputDir) {
  const inputsRoot = path.join(outputDir, "inputs");
  if (pathEntryExists(inputsRoot)) {
    throw new Error("input snapshot already exists without a registration; use a new output directory");
  }
  mkdirSync(inputsRoot, { recursive: false, mode: 0o700 });
  mkdirSync(path.join(inputsRoot, "tasks"), { recursive: false, mode: 0o700 });
  for (const task of loaded.tasks) {
    const layout = registration.inputs.tasks.find((entry) => entry.id === task.id);
    if (!layout) {
      throw new Error(`input snapshot layout is missing task ${task.id}`);
    }
    const target = path.resolve(outputDir, layout.path);
    cpSync(task.absolutePath, target, { recursive: true, dereference: false, preserveTimestamps: true });
  }
  const mcpDirectory = path.join(inputsRoot, "treatment", "mcp");
  const instructionDirectory = path.join(inputsRoot, "treatment", "instruction");
  mkdirSync(mcpDirectory, { recursive: true, mode: 0o700 });
  mkdirSync(instructionDirectory, { recursive: true, mode: 0o700 });
  copyFileSync(loaded.mcpConfigPath, path.resolve(outputDir, registration.inputs.treatment.mcpConfig));
  copyFileSync(loaded.extraInstructionPath, path.resolve(outputDir, registration.inputs.treatment.extraInstruction));
  resolveRegisteredInputs(registration, outputDir);
}

function resolveRegisteredInputs(registration, outputDir) {
  if (!registration.inputs || registration.inputs.schemaVersion !== 1 || !Array.isArray(registration.inputs.tasks)) {
    throw new Error("registration is missing its immutable input snapshot layout");
  }
  if (!Array.isArray(registration.tasks)) {
    throw new Error("registration is missing task hashes");
  }
  const tasksById = new Map();
  for (const registeredTask of registration.tasks) {
    const layout = registration.inputs.tasks.find((entry) => entry?.id === registeredTask.id);
    if (!layout || typeof layout.path !== "string") {
      throw new Error(`input snapshot layout is missing task ${registeredTask.id}`);
    }
    const taskPath = resolveSnapshotPath(outputDir, layout.path, `task snapshot ${registeredTask.id}`, "directory");
    rejectSymlinksAndOversizedFiles(taskPath);
    validateTask(taskPath, registration.candidate?.codexaVersion, registeredTask.name);
    if (hashDirectory(taskPath) !== registeredTask.hash) {
      throw new Error(`task input snapshot hash differs from registration: ${registeredTask.id}`);
    }
    tasksById.set(registeredTask.id, taskPath);
  }
  const treatmentLayout = registration.inputs.treatment;
  if (!treatmentLayout || typeof treatmentLayout.mcpConfig !== "string" || typeof treatmentLayout.extraInstruction !== "string") {
    throw new Error("registration is missing treatment input snapshot paths");
  }
  const mcpConfigPath = resolveSnapshotPath(outputDir, treatmentLayout.mcpConfig, "treatment MCP snapshot", "file");
  const extraInstructionPath = resolveSnapshotPath(outputDir, treatmentLayout.extraInstruction, "treatment instruction snapshot", "file");
  validateTreatmentFiles(mcpConfigPath, extraInstructionPath);
  if (hashFile(mcpConfigPath) !== registration.treatment?.mcpConfigHash) {
    throw new Error("treatment MCP input snapshot hash differs from registration");
  }
  if (hashFile(extraInstructionPath) !== registration.treatment?.extraInstructionHash) {
    throw new Error("treatment instruction input snapshot hash differs from registration");
  }
  return { tasksById, mcpConfigPath, extraInstructionPath };
}

function resolveSnapshotPath(outputDir, relative, label, expectedType) {
  assertSafeRelative(relative, label);
  const target = path.resolve(outputDir, relative);
  if (!isWithin(outputDir, target)) {
    throw new Error(`${label} escapes the experiment output`);
  }
  assertNoSymlinkComponents(target, label);
  const stat = lstatIfExists(target);
  const valid = expectedType === "directory" ? stat?.isDirectory() : stat?.isFile();
  if (!valid || stat?.isSymbolicLink()) {
    throw new Error(`${label} must be a real ${expectedType}`);
  }
  const real = realpathSync(target);
  if (!isWithin(realpathSync(outputDir), real)) {
    throw new Error(`${label} escapes the experiment output`);
  }
  return real;
}

function buildAssignments(config) {
  const assignments = [];
  for (const task of config.tasks) {
    const treatmentFirstForFirstRepetition = createHash("sha256").update(`${config.design.seed}\0${task.id}`).digest()[0] % 2 === 1;
    for (let repetition = 1; repetition <= config.design.repetitions; repetition += 1) {
      const treatmentFirst = repetition % 2 === 1
        ? treatmentFirstForFirstRepetition
        : !treatmentFirstForFirstRepetition;
      const arms = treatmentFirst ? ["treatment", "control"] : ["control", "treatment"];
      for (let order = 0; order < arms.length; order += 1) {
        const arm = arms[order];
        const runId = createHash("sha256")
          .update(`${config.experimentId}\0${config.design.seed}\0${task.id}\0${repetition}\0${arm}`)
          .digest("hex")
          .slice(0, 20);
        assignments.push({ runId, taskId: task.id, taskName: task.name, repetition, arm, order: order + 1, jobName: `agent-ab-${runId}` });
      }
    }
  }
  return assignments;
}

async function executeAssignments({ loaded, registration, options }) {
  const runDir = ensureOutputSubdirectory(registration.outputDir, "runs");
  const attemptsDir = ensureOutputSubdirectory(registration.outputDir, "attempts");
  const jobsDir = ensureOutputSubdirectory(registration.outputDir, "jobs");
  for (const assignment of registration.assignments) {
    const metadataPath = path.join(runDir, `${assignment.runId}.json`);
    const attemptPath = path.join(attemptsDir, `${assignment.runId}.json`);
    const expectedAttempt = attemptIdentity(registration, assignment);
    const hasMetadata = pathEntryExists(metadataPath);
    if (hasMetadata) {
      requireRegularFile(metadataPath, `run metadata for ${assignment.runId}`);
    }
    if (pathEntryExists(attemptPath)) {
      requireMatchingAttempt(attemptPath, expectedAttempt);
      if (options.resume) {
        continue;
      }
      throw new Error(`assignment attempt already started for ${assignment.runId}`);
    }
    if (hasMetadata) {
      if (options.resume) {
        continue;
      }
      throw new Error(`run metadata already exists for ${assignment.runId}`);
    }
    const snapshots = resolveRegisteredInputs(registration, registration.outputDir);
    const task = snapshots.tasksById.get(assignment.taskId);
    if (!task) {
      throw new Error(`registered task is unavailable: ${assignment.taskId}`);
    }
    const harborArgs = [
      "--from",
      `harbor==${loaded.config.framework.version}`,
      "harbor",
      "run",
      "--path",
      task,
      "--agent",
      registration.agent,
      "--agent-kwarg",
      `version=${registration.runner.version}`,
      "--model",
      registration.model,
      "--jobs-dir",
      jobsDir,
      "--job-name",
      assignment.jobName,
      "--n-attempts",
      "1",
      "--n-concurrent",
      "1",
      "--max-retries",
      String(loaded.config.design.maxRetries),
      "--timeout-multiplier",
      String(loaded.config.design.timeoutMultiplier),
      "--yes"
    ];
    for (const [key, value] of Object.entries(registration.runner.kwargs).sort(([left], [right]) => compareText(left, right))) {
      harborArgs.push("--agent-kwarg", `${key}=${value}`);
    }
    if (assignment.arm === "treatment") {
      harborArgs.push(
        "--mcp-config",
        snapshots.mcpConfigPath,
        "--extra-instruction-path",
        snapshots.extraInstructionPath
      );
    }
    writeExclusiveJson(attemptPath, { ...expectedAttempt, startedAt: new Date().toISOString() });
    const result = await runProcess({
      executable: "uvx",
      args: harborArgs,
      timeoutMs: loaded.config.design.controllerTimeoutSeconds * 1000,
      env: { ...process.env, HARBOR_TELEMETRY: "off" }
    });
    const jobResultPath = path.join("jobs", assignment.jobName, "result.json");
    writeExclusiveJson(metadataPath, {
      schemaVersion: 1,
      runId: assignment.runId,
      taskId: assignment.taskId,
      repetition: assignment.repetition,
      arm: assignment.arm,
      order: assignment.order,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      controllerElapsedMs: result.elapsedMs,
      jobResultPath
    });
  }
}

function attemptIdentity(registration, assignment) {
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
    jobName: assignment.jobName
  };
}

function requireMatchingAttempt(file, expected) {
  requireRegularFile(file, `attempt journal for ${expected.runId}`);
  const attempt = JSON.parse(readBoundedText(file, 128 * 1024, "attempt journal"));
  const { startedAt, ...identity } = attempt;
  if (typeof startedAt !== "string" || !Number.isFinite(Date.parse(startedAt))) {
    throw new Error(`attempt journal has an invalid start time for ${expected.runId}`);
  }
  if (JSON.stringify(identity) !== JSON.stringify(expected)) {
    throw new Error(`attempt journal identity differs from registration for ${expected.runId}`);
  }
  return attempt;
}

function runProcess({ executable, args, timeoutMs, env }) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const detached = process.platform !== "win32";
    const child = spawn(executable, args, { env, stdio: "inherit", shell: false, detached });
    let timedOut = false;
    let settled = false;
    let killEscalated = false;
    let closeOutcome;
    let killTimer;
    let terminationReason;
    const terminate = (signal) => {
      try {
        if (detached && child.pid) {
          process.kill(-child.pid, signal);
        } else {
          child.kill(signal);
        }
      } catch {
        // The process may already have exited.
      }
    };
    const cleanup = () => {
      clearTimeout(timer);
      if (killTimer) {
        clearTimeout(killTimer);
      }
      process.removeListener("SIGINT", interruptSigint);
      process.removeListener("SIGTERM", interruptSigterm);
    };
    const finishIfReady = () => {
      if (settled || !closeOutcome || (terminationReason && !killEscalated)) {
        return;
      }
      settled = true;
      cleanup();
      if (terminationReason === "SIGINT" || terminationReason === "SIGTERM") {
        reject(new Error(`controller interrupted by ${terminationReason}; assignment remains started and will not be retried`));
        return;
      }
      resolve({
        exitCode: Number.isInteger(closeOutcome.code) ? closeOutcome.code : closeOutcome.signal ? 128 : 1,
        timedOut,
        elapsedMs: Date.now() - started
      });
    };
    const beginTermination = (reason) => {
      if (terminationReason) {
        return;
      }
      terminationReason = reason;
      timedOut = reason === "timeout";
      clearTimeout(timer);
      terminate("SIGTERM");
      killTimer = setTimeout(() => {
        killEscalated = true;
        terminate("SIGKILL");
        finishIfReady();
      }, TERMINATION_GRACE_MS);
    };
    const timer = setTimeout(() => beginTermination("timeout"), timeoutMs);
    const interruptSigint = () => beginTermination("SIGINT");
    const interruptSigterm = () => beginTermination("SIGTERM");
    process.on("SIGINT", interruptSigint);
    process.on("SIGTERM", interruptSigterm);
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    });
    child.once("close", (code, signal) => {
      if (settled) return;
      closeOutcome = { code, signal };
      finishIfReady();
    });
  });
}

function validationSummary(loaded) {
  return {
    schemaVersion: 1,
    experimentId: loaded.config.experimentId,
    framework: loaded.config.framework,
    harness: loaded.harness,
    runner: loaded.config.runner,
    candidate: loaded.config.candidate,
    configHash: loaded.configHash,
    tasks: loaded.tasks.map((task) => ({ id: task.id, name: task.name, hash: task.hash })),
    treatment: { mcpConfigHash: loaded.mcpConfigHash, extraInstructionHash: loaded.extraInstructionHash },
    inputs: inputSnapshotLayout(loaded.config),
    registeredRuns: loaded.config.tasks.length * loaded.config.design.repetitions * 2,
    primaryReward: loaded.config.analysis.primaryReward,
    generalizationUnit: loaded.config.analysis.generalizationUnit
  };
}

function publicRegistration(registration) {
  const { outputDir: _outputDir, ...publicValue } = registration;
  return publicValue;
}

function validateOutputPath(input, loaded) {
  const requestedOutput = path.resolve(input);
  assertNoSymlinkComponents(requestedOutput, "output directory");
  const outputStat = lstatIfExists(requestedOutput);
  if (outputStat && !outputStat.isDirectory()) {
    throw new Error("output path must be a directory");
  }
  const output = canonicalizePotentialPath(requestedOutput);
  for (const task of loaded.tasks) {
    if (isWithin(task.absolutePath, output) || isWithin(output, task.absolutePath)) {
      throw new Error("output directory must be outside every agent-visible task directory");
    }
  }
  return output;
}

function ensureOutputSubdirectory(outputDir, name) {
  const outputReal = realpathSync(outputDir);
  const target = path.join(outputReal, name);
  const existing = lstatIfExists(target);
  if (existing?.isSymbolicLink() || (existing && !existing.isDirectory())) {
    throw new Error(`output ${name} path must be a real directory, not a symlink`);
  }
  if (!existing) {
    mkdirSync(target, { recursive: false, mode: 0o700 });
  }
  const created = lstatSync(target);
  const targetReal = realpathSync(target);
  if (!created.isDirectory() || !isWithin(outputReal, targetReal)) {
    throw new Error(`output ${name} directory escapes the experiment output`);
  }
  return targetReal;
}

function canonicalizePotentialPath(target) {
  let existing = target;
  const missingSegments = [];
  while (!lstatIfExists(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) {
      throw new Error("output path has no existing filesystem ancestor");
    }
    missingSegments.unshift(path.basename(existing));
    existing = parent;
  }
  return path.join(realpathSync(existing), ...missingSegments);
}

function assertNoSymlinkComponents(target, label) {
  const absolute = path.resolve(target);
  const root = path.parse(absolute).root;
  let current = root;
  for (const segment of path.relative(root, absolute).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const stat = lstatIfExists(current);
    if (!stat) {
      return;
    }
    if (stat.isSymbolicLink()) {
      throw new Error(`${label} may not contain symlink components`);
    }
  }
}

function pathEntryExists(target) {
  return lstatIfExists(target) !== undefined;
}

function lstatIfExists(target) {
  try {
    return lstatSync(target);
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

function requireRegularFile(file, label) {
  const stat = lstatIfExists(file);
  if (!stat?.isFile() || stat.isSymbolicLink()) {
    throw new Error(`${label} must be a regular file, not a symlink`);
  }
}

function resolveContainedPath(baseDir, relative, label) {
  assertSafeRelative(relative, label);
  const target = path.resolve(baseDir, relative);
  if (!isWithin(baseDir, target) || !existsSync(target)) {
    throw new Error(`${label} does not resolve to an existing contained path`);
  }
  const baseReal = realpathSync(baseDir);
  const targetReal = realpathSync(target);
  if (!isWithin(baseReal, targetReal)) {
    throw new Error(`${label} escapes through a symlink`);
  }
  return targetReal;
}

function rejectSymlinksAndOversizedFiles(root) {
  let total = 0;
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      const relative = path.relative(root, target).split(path.sep).join("/");
      if (
        entry.name === "__pycache__" ||
        entry.name === ".pytest_cache" ||
        entry.name === ".mypy_cache" ||
        entry.name === ".ruff_cache" ||
        entry.name === ".DS_Store" ||
        /\.(?:pyc|pyo)$/u.test(entry.name)
      ) {
        throw new Error(`task contains a transient artifact: ${relative}`);
      }
      const stat = lstatSync(target);
      if (stat.isSymbolicLink()) {
        throw new Error("task directories may not contain symlinks");
      }
      if (stat.isDirectory()) {
        walk(target);
      } else if (stat.isFile()) {
        if (stat.size > 1024 * 1024) {
          throw new Error("task file exceeds the 1 MiB bound");
        }
        total += stat.size;
      } else {
        throw new Error("task directories may contain only regular files and directories");
      }
    }
  };
  walk(root);
  if (total > 8 * 1024 * 1024) {
    throw new Error("task exceeds the 8 MiB total bound");
  }
}

function hashDirectory(root) {
  const entries = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => compareText(left.name, right.name))) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        entries.push({ kind: "directory", target });
        walk(target);
      } else if (entry.isFile()) {
        entries.push({ kind: "file", target });
      }
    }
  };
  walk(root);
  const hash = createHash("sha256");
  for (const entry of entries) {
    const stat = lstatSync(entry.target);
    hash.update(entry.kind);
    hash.update("\0");
    hash.update(path.relative(root, entry.target).split(path.sep).join("/"));
    hash.update("\0");
    if (entry.kind === "file") {
      hash.update(portableFileMode(stat));
      hash.update("\0");
      hash.update(readFileSync(entry.target));
      hash.update("\0");
    }
  }
  return hash.digest("hex");
}

function hashFile(file) {
  const stat = lstatSync(file);
  return createHash("sha256")
    .update(portableFileMode(stat))
    .update("\0")
    .update(readFileSync(file))
    .digest("hex");
}

function portableFileMode(stat) {
  return (stat.mode & 0o111) === 0 ? "regular" : "executable";
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function readBoundedText(file, maxBytes, label) {
  const stat = statSync(file);
  if (!stat.isFile() || stat.size > maxBytes) {
    throw new Error(`${label} is not a bounded regular file`);
  }
  return readFileSync(file, "utf8");
}

function writeExclusiveJson(file, value) {
  const temporary = `${file}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  try {
    if (existsSync(file)) {
      throw new Error(`refusing to replace immutable artifact: ${path.basename(file)}`);
    }
    renameSync(temporary, file);
  } catch (error) {
    try {
      if (existsSync(temporary)) {
        unlinkSync(temporary);
      }
    } catch {
      // Preserve the original error.
    }
    throw error;
  }
}

function requiredOption(parsed, name) {
  if (typeof parsed[name] !== "string" || parsed[name].length === 0) {
    throw new Error(`--${name} is required`);
  }
  return parsed[name];
}

function validateCliLabel(value, label) {
  if (typeof value !== "string" || value.length > 200 || value.startsWith("-") || !/^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$/u.test(value)) {
    throw new Error(`${label} contains unsupported characters`);
  }
  return value;
}

function assertSafeRelative(value, label) {
  if (typeof value !== "string" || value.length === 0 || value.length > 500 || path.isAbsolute(value) || value.includes("\\") || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(`${label} must be a bounded relative POSIX path`);
  }
  const segments = value.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error(`${label} contains an unsafe path segment`);
  }
}

function validateTaskName(value, label) {
  if (typeof value !== "string" || value.length === 0 || value.length > 200 || value.trim() !== value || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(`${label} must be a bounded printable string`);
  }
}

function readRequiredTomlString(raw, table, key) {
  const encoded = readRequiredTomlValue(raw, table, key);
  if (!/^"(?:[^"\\]|\\.)*"$/u.test(encoded)) {
    throw new Error(`task.toml [${table}].${key} must be a basic quoted string`);
  }
  try {
    const value = JSON.parse(encoded);
    if (typeof value !== "string") {
      throw new Error("not a string");
    }
    return value;
  } catch {
    throw new Error(`task.toml [${table}].${key} contains invalid string escapes`);
  }
}

function readRequiredTomlValue(raw, table, key) {
  let currentTable;
  const values = [];
  let pending;
  for (const rawLine of raw.split(/\r?\n/u)) {
    const line = stripTomlComment(rawLine).trim();
    if (line.length === 0) {
      continue;
    }
    if (pending !== undefined) {
      pending = `${pending}\n${line}`;
      if (tomlValueIsComplete(pending)) {
        values.push(pending);
        pending = undefined;
      }
      continue;
    }
    const tableMatch = /^\[([^\]]+)\]$/u.exec(line);
    if (tableMatch) {
      currentTable = tableMatch[1].trim();
      continue;
    }
    if (currentTable !== table || !new RegExp(`^${key}\\s*=`, "u").test(line)) {
      continue;
    }
    const valueMatch = new RegExp(`^${key}\\s*=\\s*(.+)$`, "u").exec(line);
    if (!valueMatch) {
      throw new Error(`task.toml [${table ?? "root"}].${key} must have a value`);
    }
    if (tomlValueIsComplete(valueMatch[1])) {
      values.push(valueMatch[1]);
    } else {
      pending = valueMatch[1];
    }
  }
  if (pending !== undefined) {
    throw new Error(`task.toml [${table ?? "root"}].${key} has an unterminated value`);
  }
  if (values.length !== 1) {
    throw new Error(`task.toml must define [${table ?? "root"}].${key} exactly once`);
  }
  return values[0];
}

function tomlValueIsComplete(value) {
  let squareDepth = 0;
  let braceDepth = 0;
  let quoted = false;
  let escaped = false;
  for (const character of value) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quoted && character === "\\") {
      escaped = true;
      continue;
    }
    if (character === "\"") {
      quoted = !quoted;
      continue;
    }
    if (quoted) {
      continue;
    }
    if (character === "[") squareDepth += 1;
    if (character === "]") squareDepth -= 1;
    if (character === "{") braceDepth += 1;
    if (character === "}") braceDepth -= 1;
    if (squareDepth < 0 || braceDepth < 0) {
      throw new Error("task.toml contains unbalanced delimiters");
    }
  }
  return !quoted && squareDepth === 0 && braceDepth === 0;
}

function tomlArtifactsIncludeSource(value, expectedSource) {
  return tomlArtifactFields(value, expectedSource).length > 0;
}

function tomlArtifactHasExcludes(value, expectedSource, required) {
  const matches = tomlArtifactFields(value, expectedSource);
  if (matches.length !== 1) {
    return false;
  }
  const excludes = parseTomlBasicStringArray(matches[0].get("exclude"));
  return excludes !== undefined && required.every((entry) => excludes.includes(entry));
}

function tomlArtifactFields(value, expectedSource) {
  const trimmed = value.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) {
    throw new Error("task.toml root.artifacts must be an array");
  }
  const matches = [];
  for (const element of splitTomlTopLevel(trimmed.slice(1, -1))) {
    const direct = parseTomlBasicString(element);
    if (direct === expectedSource) {
      matches.push(new Map([["source", JSON.stringify(direct)]]));
      continue;
    }
    const inline = element.trim();
    if (!inline.startsWith("{") || !inline.endsWith("}")) {
      continue;
    }
    const fields = new Map();
    for (const field of splitTomlTopLevel(inline.slice(1, -1))) {
      const match = /^([A-Za-z_][A-Za-z0-9_-]*)\s*=\s*([\s\S]+)$/u.exec(field.trim());
      if (match) {
        fields.set(match[1], match[2]);
      }
    }
    if (parseTomlBasicString(fields.get("source") ?? "") === expectedSource) {
      matches.push(fields);
    }
  }
  return matches;
}

function parseTomlBasicStringArray(value) {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) {
    return undefined;
  }
  const parsed = splitTomlTopLevel(trimmed.slice(1, -1)).map(parseTomlBasicString);
  return parsed.every((entry) => typeof entry === "string") ? parsed : undefined;
}

function splitTomlTopLevel(value) {
  const parts = [];
  let start = 0;
  let squareDepth = 0;
  let braceDepth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quoted && character === "\\") {
      escaped = true;
      continue;
    }
    if (character === "\"") {
      quoted = !quoted;
      continue;
    }
    if (quoted) {
      continue;
    }
    if (character === "[") squareDepth += 1;
    if (character === "]") squareDepth -= 1;
    if (character === "{") braceDepth += 1;
    if (character === "}") braceDepth -= 1;
    if (character === "," && squareDepth === 0 && braceDepth === 0) {
      parts.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }
  const final = value.slice(start).trim();
  if (final.length > 0) {
    parts.push(final);
  }
  return parts;
}

function parseTomlBasicString(value) {
  const trimmed = value.trim();
  if (!/^"(?:[^"\\]|\\.)*"$/u.test(trimmed)) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(trimmed);
    return typeof parsed === "string" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function stripTomlComment(line) {
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quoted && character === "\\") {
      escaped = true;
      continue;
    }
    if (character === "\"") {
      quoted = !quoted;
      continue;
    }
    if (!quoted && character === "#") {
      return line.slice(0, index);
    }
  }
  return line;
}

function assertIdentifier(value, label) {
  if (typeof value !== "string" || !/^[a-z][a-z0-9_-]{2,79}$/u.test(value)) {
    throw new Error(`${label} must be a lowercase bounded identifier`);
  }
}

function assertObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
}

function assertKeys(value, allowed, label) {
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unexpected.length > 0) {
    throw new Error(`${label} contains unknown field: ${unexpected[0]}`);
  }
  for (const key of allowed) {
    if (!Object.hasOwn(value, key)) {
      throw new Error(`${label} is missing field: ${key}`);
    }
  }
}

function integerInRange(value, minimum, maximum, label) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be an integer from ${minimum} to ${maximum}`);
  }
}

function numberInRange(value, minimum, maximum, label) {
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be from ${minimum} to ${maximum}`);
  }
}

function isWithin(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}
