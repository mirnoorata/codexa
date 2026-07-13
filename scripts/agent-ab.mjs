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
const MCP_PREFLIGHT_BUILD_TIMEOUT_MS = 10 * 60 * 1000;
const MCP_PREFLIGHT_HANDSHAKE_TIMEOUT_MS = 60 * 1000;
const MCP_PREFLIGHT_CLEANUP_TIMEOUT_MS = 60 * 1000;
const CONTROLLER_PATH = fileURLToPath(import.meta.url);
const ANALYZER_PATH = path.join(path.dirname(CONTROLLER_PATH), "agent-ab-analysis.mjs");
const MCP_PREFLIGHT_BASENAME = "mcp-initialize-tools-list-smoke.mjs";
const MCP_PREFLIGHT_REFERENCE_PATH = path.join(
  path.dirname(CONTROLLER_PATH),
  "..",
  "benchmarks",
  "agent-ab",
  "support",
  MCP_PREFLIGHT_BASENAME
);

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
    await preflightSchemaV2Assignments({ registration });
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
  const arms = experimentArms(config).map((arm) => {
    if (arm.kind === "control") {
      return arm;
    }
    const mcpConfigPath = resolveContainedPath(baseDir, arm.mcpConfig, `${arm.id} MCP config`);
    const extraInstructionPath = resolveContainedPath(baseDir, arm.extraInstruction, `${arm.id} instruction`);
    const serverCommand = validateArmFiles({
      mcpConfigPath,
      instructionPath: extraInstructionPath,
      label: config.schemaVersion === 1 ? "treatment" : `arm ${arm.id}`,
      legacy: config.schemaVersion === 1
    });
    return {
      ...arm,
      mcpConfigPath,
      extraInstructionPath,
      mcpConfigHash: hashFile(mcpConfigPath),
      extraInstructionHash: hashFile(extraInstructionPath),
      serverCommand
    };
  });
  const schemaV2ServerCommands = config.schemaVersion === 2
    ? arms.filter((arm) => arm.kind === "codexa").map((arm) => arm.serverCommand)
    : [];
  const taskEntries = config.tasks.map((task) => {
    const taskPath = resolveContainedPath(baseDir, task.path, `task ${task.id}`);
    validateTask(taskPath, config.candidate.codexaVersion, task.name, {
      schemaVersion: config.schemaVersion,
      serverCommands: schemaV2ServerCommands
    });
    return { ...task, absolutePath: taskPath, hash: hashDirectory(taskPath) };
  });
  const loaded = {
    absolute,
    baseDir,
    config,
    configHash: sha256(raw),
    tasks: taskEntries,
    arms,
    harness: config.schemaVersion === 2
      ? {
          controllerHash: hashFile(CONTROLLER_PATH),
          analyzerHash: hashFile(ANALYZER_PATH),
          mcpPreflightHash: hashFile(MCP_PREFLIGHT_REFERENCE_PATH)
        }
      : {
          controllerHash: hashFile(CONTROLLER_PATH),
          analyzerHash: hashFile(ANALYZER_PATH)
        }
  };
  if (config.schemaVersion === 1) {
    const treatment = arms.find((arm) => arm.id === "treatment");
    return {
      ...loaded,
      mcpConfigPath: treatment.mcpConfigPath,
      extraInstructionPath: treatment.extraInstructionPath,
      mcpConfigHash: treatment.mcpConfigHash,
      extraInstructionHash: treatment.extraInstructionHash
    };
  }
  return loaded;
}

function validateConfigObject(config) {
  assertObject(config, "experiment configuration");
  if (config.schemaVersion !== 1 && config.schemaVersion !== 2) {
    throw new Error("schemaVersion must be 1 or 2");
  }
  assertKeys(
    config,
    config.schemaVersion === 1
      ? ["schemaVersion", "experimentId", "framework", "runner", "candidate", "design", "tasks", "treatment", "analysis"]
      : ["schemaVersion", "experimentId", "framework", "runner", "candidate", "design", "tasks", "arms", "analysis"],
    "experiment configuration"
  );
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
  if (config.schemaVersion === 1) {
    assertObject(config.treatment, "treatment");
    assertKeys(config.treatment, ["mcpConfig", "extraInstruction"], "treatment");
    assertSafeRelative(config.treatment.mcpConfig, "treatment.mcpConfig");
    assertSafeRelative(config.treatment.extraInstruction, "treatment.extraInstruction");
    validateAnalysis(config.analysis, 1);
    return;
  }
  validateArms(config.arms);
  validateAnalysis(config.analysis, 2, new Set(config.arms.map((arm) => arm.id)));
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

function validateAnalysis(analysis, schemaVersion, armIds = new Set()) {
  assertObject(analysis, "analysis");
  assertKeys(
    analysis,
    schemaVersion === 1
      ? ["primaryReward", "bootstrapSamples", "confidenceLevel", "generalizationUnit", "failurePolicy"]
      : ["primaryReward", "bootstrapSamples", "confidenceLevel", "generalizationUnit", "failurePolicy", "comparisons"],
    "analysis"
  );
  assertIdentifier(analysis.primaryReward, "analysis.primaryReward");
  integerInRange(analysis.bootstrapSamples, 1000, 100000, "analysis.bootstrapSamples");
  numberInRange(analysis.confidenceLevel, 0.8, 0.999, "analysis.confidenceLevel");
  if (analysis.generalizationUnit !== "task") {
    throw new Error("analysis.generalizationUnit must be task");
  }
  if (analysis.failurePolicy !== "intention-to-treat") {
    throw new Error("analysis.failurePolicy must be intention-to-treat");
  }
  if (schemaVersion === 1) {
    return;
  }
  if (!Array.isArray(analysis.comparisons) || analysis.comparisons.length < 1 || analysis.comparisons.length > 32) {
    throw new Error("analysis.comparisons must contain between 1 and 32 entries");
  }
  const comparisonIds = new Set();
  let primaryCount = 0;
  for (const comparison of analysis.comparisons) {
    assertObject(comparison, "analysis comparison");
    assertKeys(comparison, ["id", "baselineArm", "candidateArm", "primary"], "analysis comparison");
    assertIdentifier(comparison.id, "analysis comparison id");
    if (comparisonIds.has(comparison.id)) {
      throw new Error(`duplicate analysis comparison id: ${comparison.id}`);
    }
    comparisonIds.add(comparison.id);
    if (!armIds.has(comparison.baselineArm) || !armIds.has(comparison.candidateArm)) {
      throw new Error(`analysis comparison ${comparison.id} references an unknown arm`);
    }
    if (comparison.baselineArm === comparison.candidateArm) {
      throw new Error(`analysis comparison ${comparison.id} must compare two different arms`);
    }
    if (typeof comparison.primary !== "boolean") {
      throw new Error(`analysis comparison ${comparison.id} primary must be boolean`);
    }
    primaryCount += Number(comparison.primary);
  }
  if (primaryCount !== 1) {
    throw new Error("analysis.comparisons must designate exactly one primary comparison");
  }
}

function validateArms(arms) {
  if (!Array.isArray(arms) || arms.length < 2 || arms.length > 8) {
    throw new Error("arms must contain between 2 and 8 entries");
  }
  const ids = new Set();
  let controlCount = 0;
  for (const arm of arms) {
    assertObject(arm, "arm");
    if (arm.kind === "control") {
      assertKeys(arm, ["id", "kind"], `arm ${String(arm.id)}`);
      controlCount += 1;
    } else if (arm.kind === "codexa") {
      assertKeys(arm, ["id", "kind", "mcpConfig", "extraInstruction"], `arm ${String(arm.id)}`);
      assertSafeRelative(arm.mcpConfig, `arm ${String(arm.id)} mcpConfig`);
      assertSafeRelative(arm.extraInstruction, `arm ${String(arm.id)} extraInstruction`);
    } else {
      throw new Error(`arm ${String(arm.id)} kind must be control or codexa`);
    }
    assertIdentifier(arm.id, "arm id");
    if (ids.has(arm.id)) {
      throw new Error(`duplicate arm id: ${arm.id}`);
    }
    ids.add(arm.id);
  }
  if (controlCount !== 1) {
    throw new Error("schema-v2 requires exactly one control arm");
  }
}

function experimentArms(config) {
  return config.schemaVersion === 1
    ? [
        { id: "control", kind: "control" },
        {
          id: "treatment",
          kind: "codexa",
          mcpConfig: config.treatment.mcpConfig,
          extraInstruction: config.treatment.extraInstruction
        }
      ]
    : config.arms.map((arm) => ({ ...arm }));
}

function validateTask(taskPath, codexaVersion, expectedTaskName, options = { schemaVersion: 1, serverCommands: [] }) {
  const required = [
    "instruction.md",
    "task.toml",
    "environment/Dockerfile",
    "environment/project/.gitignore",
    "solution/solve.sh",
    "tests/Dockerfile",
    "tests/candidate_runner.py",
    "tests/public_test_runner.py",
    "tests/test.sh"
  ];
  if (options.schemaVersion === 1) {
    required.push("environment/codexa-mcp-entrypoint.sh");
  }
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
  const canonicalInstall = 'npm install --global --prefix /opt/codexa-runtime "@mirnoorata/codexa@${CODEXA_VERSION}"';
  const installsPinnedCandidate = dockerfile.split(/\r?\n/u).some((line) => {
    const trimmed = line.trim();
    return !trimmed.startsWith("#")
      && (trimmed.startsWith("RUN ") || trimmed.startsWith("&& "))
      && trimmed.includes(canonicalInstall);
  });
  if (!installsPinnedCandidate) {
    throw new Error("agent Dockerfile must install @mirnoorata/codexa from ${CODEXA_VERSION} into the isolated runtime");
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
  if (options.schemaVersion === 1) {
    const entrypoint = readBoundedText(path.join(taskPath, "environment/codexa-mcp-entrypoint.sh"), 128 * 1024, "Codexa MCP entrypoint");
    if (!entrypoint.includes("repo=/workspace/project") || !entrypoint.includes("codexa=/opt/codexa-runtime/bin/codexa")) {
      throw new Error("Codexa MCP entrypoint must use the sandbox checkout and isolated runtime");
    }
  } else {
    validateSchemaV2TaskArmProvisioning(taskPath, dockerfile, options.serverCommands);
  }
}

function validateSchemaV2TaskArmProvisioning(taskPath, dockerfile, serverCommands) {
  if (!Array.isArray(serverCommands) || serverCommands.length === 0 || new Set(serverCommands).size !== serverCommands.length) {
    throw new Error("schema-v2 task validation requires unique registered Codexa arm commands");
  }
  for (const serverCommand of serverCommands) {
    const basename = path.posix.basename(serverCommand);
    const sourceName = `${basename}.sh`;
    const sourcePath = path.join(taskPath, "environment", sourceName);
    if (!existsSync(sourcePath) || !lstatSync(sourcePath).isFile() || lstatSync(sourcePath).isSymbolicLink()) {
      throw new Error(`schema-v2 task does not provision registered arm command ${serverCommand}`);
    }
    const wrapper = readBoundedText(sourcePath, 128 * 1024, `schema-v2 MCP wrapper ${basename}`);
    const activeLines = wrapper.split(/\r?\n/u).map((line) => line.trim()).filter((line) => line.length > 0 && !line.startsWith("#"));
    const serveIndex = activeLines.findIndex((line) => line === 'exec "$codexa" serve "$repo"' || line.startsWith('exec "$codexa" serve "$repo" '));
    if (
      !activeLines.includes("repo=/workspace/project")
      || !activeLines.includes("codexa=/opt/codexa-runtime/bin/codexa")
      || serveIndex < 0
    ) {
      throw new Error(`schema-v2 MCP wrapper ${sourceName} must serve the sandbox checkout through the isolated runtime`);
    }
    requireCanonicalDockerCopy(dockerfile, sourceName, serverCommand, "0755", `schema-v2 arm command ${serverCommand}`);
  }
}

function requireCanonicalDockerCopy(dockerfile, source, destination, mode, label) {
  const expected = `COPY --chmod=${mode} ${source} ${destination}`;
  const matches = dockerfile.split(/\r?\n/u).filter((line) => line.trim() === expected);
  if (matches.length !== 1) {
    throw new Error(`${label} must be provisioned exactly once with: ${expected}`);
  }
}

function validateArmFiles({ mcpConfigPath, instructionPath, label, legacy }) {
  const mcp = JSON.parse(readBoundedText(mcpConfigPath, 128 * 1024, `${label} MCP config`));
  assertObject(mcp, `${label} MCP config`);
  assertKeys(mcp, ["mcpServers"], `${label} MCP config`);
  assertObject(mcp.mcpServers, `${label} MCP servers`);
  assertKeys(mcp.mcpServers, ["codexa"], `${label} MCP servers`);
  const server = mcp.mcpServers.codexa;
  assertObject(server, "Codexa MCP server");
  assertKeys(server, ["command", "args"], "Codexa MCP server");
  const commandAllowed = legacy
    ? server.command === "/opt/codexa-agent-ab/start-codexa-mcp"
    : /^\/opt\/codexa-agent-ab\/start-codexa-mcp(?:-[a-z0-9-]+)?$/u.test(server.command);
  if (!commandAllowed) {
    throw new Error("Codexa MCP command must use the sandbox-local entrypoint");
  }
  if (JSON.stringify(server.args) !== JSON.stringify([])) {
    throw new Error("Codexa MCP args must be empty for Harbor 0.18 Codex compatibility");
  }
  const instruction = readBoundedText(instructionPath, 128 * 1024, `${label} instruction`);
  if (!/\bCodexa\b/u.test(instruction) || instruction.length > 4000) {
    throw new Error(`${label} instruction must name Codexa and stay under 4000 characters`);
  }
  return server.command;
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
  const assignments = buildAssignments(loaded.config);
  const common = {
    schemaVersion: loaded.config.schemaVersion,
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
    tasks: loaded.tasks.map((task) => ({ id: task.id, name: task.name, hash: task.hash })),
    inputs,
    assignments
  };
  const registration = loaded.config.schemaVersion === 1
    ? {
        ...common,
        treatment: {
          mcpConfigHash: loaded.mcpConfigHash,
          extraInstructionHash: loaded.extraInstructionHash
        }
      }
    : {
        ...common,
        arms: loaded.arms.map((arm) => arm.kind === "control"
          ? { id: arm.id, kind: arm.kind }
          : {
              id: arm.id,
              kind: arm.kind,
              mcpConfigHash: arm.mcpConfigHash,
              extraInstructionHash: arm.extraInstructionHash,
              serverCommand: arm.serverCommand
            }),
        comparisons: loaded.config.analysis.comparisons,
        positionalBalance: summarizePositionalBalance(assignments, loaded.arms.map((arm) => arm.id))
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
  if (registration.schemaVersion !== loaded.config.schemaVersion) {
    throw new Error("registration schemaVersion differs from the experiment configuration");
  }
  if (registration.configHash !== loaded.configHash) {
    throw new Error("experiment configuration changed after registration");
  }
  if (JSON.stringify(registration.framework) !== JSON.stringify(loaded.config.framework)) {
    throw new Error("framework differs from the immutable registration");
  }
  if (JSON.stringify(registration.candidate) !== JSON.stringify(loaded.config.candidate)) {
    throw new Error("candidate differs from the immutable registration");
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
  if (loaded.config.schemaVersion === 2) {
    const expectedArms = loaded.arms.map((arm) => arm.kind === "control"
      ? { id: arm.id, kind: arm.kind }
      : {
          id: arm.id,
          kind: arm.kind,
          mcpConfigHash: arm.mcpConfigHash,
          extraInstructionHash: arm.extraInstructionHash,
          serverCommand: arm.serverCommand
        });
    if (JSON.stringify(registration.arms) !== JSON.stringify(expectedArms)) {
      throw new Error("registered arms changed after registration");
    }
    if (JSON.stringify(registration.comparisons) !== JSON.stringify(loaded.config.analysis.comparisons)) {
      throw new Error("registered comparisons changed after registration");
    }
  }
  const expectedAssignments = buildAssignments(loaded.config);
  if (JSON.stringify(registration.assignments) !== JSON.stringify(expectedAssignments)) {
    throw new Error("registered assignments do not match the deterministic experiment design");
  }
  if (loaded.config.schemaVersion === 2) {
    const expectedBalance = summarizePositionalBalance(expectedAssignments, loaded.arms.map((arm) => arm.id));
    if (JSON.stringify(registration.positionalBalance) !== JSON.stringify(expectedBalance)) {
      throw new Error("registered positional balance changed after registration");
    }
  }
  resolveRegisteredInputs(registration, outputDir);
  return { ...registration, outputDir };
}

function inputSnapshotLayout(config) {
  const common = {
    schemaVersion: config.schemaVersion,
    tasks: config.tasks.map((task) => ({
      id: task.id,
      path: path.posix.join("inputs", "tasks", task.id)
    }))
  };
  if (config.schemaVersion === 1) {
    return {
      ...common,
      treatment: {
        mcpConfig: path.posix.join("inputs", "treatment", "mcp", path.posix.basename(config.treatment.mcpConfig)),
        extraInstruction: path.posix.join("inputs", "treatment", "instruction", path.posix.basename(config.treatment.extraInstruction))
      }
    };
  }
  return {
    ...common,
    arms: config.arms.map((arm) => arm.kind === "control"
      ? { id: arm.id, kind: arm.kind }
      : {
          id: arm.id,
          kind: arm.kind,
          mcpConfig: path.posix.join("inputs", "arms", arm.id, "mcp", path.posix.basename(arm.mcpConfig)),
          extraInstruction: path.posix.join("inputs", "arms", arm.id, "instruction", path.posix.basename(arm.extraInstruction))
        })
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
  if (loaded.config.schemaVersion === 1) {
    const mcpDirectory = path.join(inputsRoot, "treatment", "mcp");
    const instructionDirectory = path.join(inputsRoot, "treatment", "instruction");
    mkdirSync(mcpDirectory, { recursive: true, mode: 0o700 });
    mkdirSync(instructionDirectory, { recursive: true, mode: 0o700 });
    copyFileSync(loaded.mcpConfigPath, path.resolve(outputDir, registration.inputs.treatment.mcpConfig));
    copyFileSync(loaded.extraInstructionPath, path.resolve(outputDir, registration.inputs.treatment.extraInstruction));
  } else {
    for (const arm of loaded.arms.filter((entry) => entry.kind === "codexa")) {
      const layout = registration.inputs.arms.find((entry) => entry.id === arm.id);
      if (!layout) {
        throw new Error(`input snapshot layout is missing arm ${arm.id}`);
      }
      mkdirSync(path.dirname(path.resolve(outputDir, layout.mcpConfig)), { recursive: true, mode: 0o700 });
      mkdirSync(path.dirname(path.resolve(outputDir, layout.extraInstruction)), { recursive: true, mode: 0o700 });
      copyFileSync(arm.mcpConfigPath, path.resolve(outputDir, layout.mcpConfig));
      copyFileSync(arm.extraInstructionPath, path.resolve(outputDir, layout.extraInstruction));
    }
  }
  resolveRegisteredInputs(registration, outputDir);
}

function resolveRegisteredInputs(registration, outputDir) {
  if (
    !registration.inputs
    || registration.inputs.schemaVersion !== registration.schemaVersion
    || !Array.isArray(registration.inputs.tasks)
  ) {
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
    validateTask(taskPath, registration.candidate?.codexaVersion, registeredTask.name, {
      schemaVersion: registration.schemaVersion,
      serverCommands: registration.schemaVersion === 2
        ? registration.arms.filter((arm) => arm.kind === "codexa").map((arm) => arm.serverCommand)
        : []
    });
    if (hashDirectory(taskPath) !== registeredTask.hash) {
      throw new Error(`task input snapshot hash differs from registration: ${registeredTask.id}`);
    }
    tasksById.set(registeredTask.id, taskPath);
  }
  const armInputs = new Map();
  if (registration.schemaVersion === 1) {
    const treatmentLayout = registration.inputs.treatment;
    if (!treatmentLayout || typeof treatmentLayout.mcpConfig !== "string" || typeof treatmentLayout.extraInstruction !== "string") {
      throw new Error("registration is missing treatment input snapshot paths");
    }
    const mcpConfigPath = resolveSnapshotPath(outputDir, treatmentLayout.mcpConfig, "treatment MCP snapshot", "file");
    const extraInstructionPath = resolveSnapshotPath(outputDir, treatmentLayout.extraInstruction, "treatment instruction snapshot", "file");
    validateArmFiles({ mcpConfigPath, instructionPath: extraInstructionPath, label: "treatment", legacy: true });
    if (hashFile(mcpConfigPath) !== registration.treatment?.mcpConfigHash) {
      throw new Error("treatment MCP input snapshot hash differs from registration");
    }
    if (hashFile(extraInstructionPath) !== registration.treatment?.extraInstructionHash) {
      throw new Error("treatment instruction input snapshot hash differs from registration");
    }
    armInputs.set("treatment", { mcpConfigPath, extraInstructionPath });
    return { tasksById, armInputs, mcpConfigPath, extraInstructionPath };
  }
  if (!Array.isArray(registration.arms) || !Array.isArray(registration.inputs.arms)) {
    throw new Error("registration is missing schema-v2 arm snapshots");
  }
  for (const registeredArm of registration.arms) {
    const layout = registration.inputs.arms.find((entry) => entry?.id === registeredArm.id);
    if (!layout || layout.kind !== registeredArm.kind) {
      throw new Error(`input snapshot layout is missing arm ${registeredArm.id}`);
    }
    if (registeredArm.kind === "control") {
      if (Object.hasOwn(layout, "mcpConfig") || Object.hasOwn(layout, "extraInstruction")) {
        throw new Error(`control arm ${registeredArm.id} may not have Codexa input snapshots`);
      }
      continue;
    }
    const mcpConfigPath = resolveSnapshotPath(outputDir, layout.mcpConfig, `${registeredArm.id} MCP snapshot`, "file");
    const extraInstructionPath = resolveSnapshotPath(outputDir, layout.extraInstruction, `${registeredArm.id} instruction snapshot`, "file");
    const serverCommand = validateArmFiles({
      mcpConfigPath,
      instructionPath: extraInstructionPath,
      label: `arm ${registeredArm.id}`,
      legacy: false
    });
    if (serverCommand !== registeredArm.serverCommand) {
      throw new Error(`arm ${registeredArm.id} MCP command differs from registration`);
    }
    if (hashFile(mcpConfigPath) !== registeredArm.mcpConfigHash) {
      throw new Error(`arm ${registeredArm.id} MCP input snapshot hash differs from registration`);
    }
    if (hashFile(extraInstructionPath) !== registeredArm.extraInstructionHash) {
      throw new Error(`arm ${registeredArm.id} instruction input snapshot hash differs from registration`);
    }
    armInputs.set(registeredArm.id, { mcpConfigPath, extraInstructionPath });
  }
  return { tasksById, armInputs };
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
  if (config.schemaVersion === 2) {
    return buildSchemaV2Assignments(config);
  }
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

function buildSchemaV2Assignments(config) {
  const assignments = [];
  const armIds = config.arms.map((arm) => arm.id);
  for (const task of config.tasks) {
    const base = deterministicPermutation(armIds, `${config.design.seed}\0${task.id}`);
    for (let repetition = 1; repetition <= config.design.repetitions; repetition += 1) {
      const offset = (repetition - 1) % base.length;
      const rotated = [...base.slice(offset), ...base.slice(0, offset)];
      for (let order = 0; order < rotated.length; order += 1) {
        const arm = rotated[order];
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

function deterministicPermutation(values, seed) {
  return values
    .map((value) => ({
      value,
      key: createHash("sha256").update(`${seed}\0${value}`).digest("hex")
    }))
    .sort((left, right) => compareText(left.key, right.key) || compareText(left.value, right.value))
    .map((entry) => entry.value);
}

function summarizePositionalBalance(assignments, armIds) {
  const positions = Object.fromEntries(armIds.map((arm) => [
    arm,
    Object.fromEntries(armIds.map((_, index) => [String(index + 1), 0]))
  ]));
  for (const assignment of assignments) {
    const arm = positions[assignment.arm];
    arm[String(assignment.order)] = (arm[String(assignment.order)] ?? 0) + 1;
  }
  const counts = Object.values(positions).flatMap((record) => Object.values(record));
  return {
    schemaVersion: 1,
    method: "seed-derived base permutation with cyclic rotation by repetition",
    positions,
    fullyBalanced: counts.length > 0 && Math.max(...counts) === Math.min(...counts),
    note: "positional balance is reported directly; this design does not claim full counterbalancing"
  };
}

async function preflightSchemaV2Assignments({ registration }) {
  if (registration.schemaVersion !== 2) {
    return;
  }
  const attemptsDir = path.join(registration.outputDir, "attempts");
  const armsById = new Map(registration.arms.map((arm) => [arm.id, arm]));
  const tasksById = new Map(registration.tasks.map((task) => [task.id, task]));
  const pendingPairs = new Map();
  for (const assignment of registration.assignments) {
    if (pathEntryExists(path.join(attemptsDir, `${assignment.runId}.json`))) {
      continue;
    }
    const arm = armsById.get(assignment.arm);
    if (arm?.kind !== "codexa") {
      continue;
    }
    const registeredTask = tasksById.get(assignment.taskId);
    if (!registeredTask) {
      throw new Error(`registration is missing schema-v2 preflight task ${assignment.taskId}`);
    }
    pendingPairs.set(`${assignment.taskId}\0${arm.serverCommand}`, {
      registeredTask,
      serverCommand: arm.serverCommand
    });
  }
  if (pendingPairs.size === 0) {
    return;
  }
  const preflightDir = ensureOutputSubdirectory(registration.outputDir, "preflight");
  const missingByTask = new Map();
  for (const pair of pendingPairs.values()) {
    const expected = schemaV2PreflightReceiptIdentity(registration, pair.registeredTask, pair.serverCommand);
    const receiptPath = schemaV2PreflightReceiptPath(preflightDir, expected);
    if (pathEntryExists(receiptPath)) {
      requireMatchingSchemaV2PreflightReceipt(receiptPath, expected);
      continue;
    }
    const taskReceipts = missingByTask.get(pair.registeredTask.id) ?? [];
    taskReceipts.push({ expected, receiptPath });
    missingByTask.set(pair.registeredTask.id, taskReceipts);
  }
  if (missingByTask.size === 0) {
    return;
  }
  const snapshots = resolveRegisteredInputs(registration, registration.outputDir);
  for (const [taskId, receipts] of missingByTask) {
    const registeredTask = tasksById.get(taskId);
    const taskPath = snapshots.tasksById.get(registeredTask.id);
    if (!taskPath) {
      throw new Error(`registered task is unavailable for schema-v2 MCP preflight: ${registeredTask.id}`);
    }
    const imageTag = [
      "codexa-agent-ab-preflight",
      registeredTask.hash.slice(0, 16),
      registration.configHash.slice(0, 8),
      String(process.pid)
    ].join("-");
    let imageBuilt = false;
    let failure;
    try {
      const build = await runProcess({
        executable: "docker",
        args: ["build", "--tag", imageTag, path.join(taskPath, "environment")],
        timeoutMs: MCP_PREFLIGHT_BUILD_TIMEOUT_MS,
        env: process.env
      });
      if (build.exitCode !== 0 || build.timedOut) {
        throw new Error(`schema-v2 task image preflight build failed for ${registeredTask.id}`);
      }
      imageBuilt = true;
      for (const receipt of receipts) {
        const { expected } = receipt;
        const observationPath = path.join(
          preflightDir,
          `.mcp-observation-${sha256(`${registeredTask.id}\0${expected.serverCommand}`).slice(0, 24)}-${process.pid}-${Date.now()}.json`
        );
        try {
          const smoke = await runProcess({
            executable: process.execPath,
            args: [
              MCP_PREFLIGHT_REFERENCE_PATH,
              "--expected-version",
              expected.expectedServerInfo.version,
              "--result",
              observationPath,
              "--",
              "docker",
              "run",
              "--rm",
              "--interactive",
              "--network",
              "none",
              imageTag,
              expected.serverCommand
            ],
            timeoutMs: MCP_PREFLIGHT_HANDSHAKE_TIMEOUT_MS,
            env: {
              ...process.env,
              CODEXA_AGENT_AB_MCP_PREFLIGHT_TIMEOUT_MS: String(MCP_PREFLIGHT_HANDSHAKE_TIMEOUT_MS)
            }
          });
          if (smoke.exitCode !== 0 || smoke.timedOut) {
            throw new Error(`schema-v2 MCP initialize/tools-list preflight failed for ${registeredTask.id} command ${expected.serverCommand}`);
          }
          receipt.observedServerInfo = readSchemaV2McpPreflightObservation(
            observationPath,
            expected.expectedServerInfo,
            registeredTask.id
          );
        } finally {
          if (existsSync(observationPath)) {
            unlinkSync(observationPath);
          }
        }
      }
    } catch (error) {
      failure = error instanceof Error ? error : new Error(String(error));
    }
    let cleanupFailure;
    if (imageBuilt) {
      try {
        const cleanup = await runProcess({
          executable: "docker",
          args: ["image", "rm", "--force", imageTag],
          timeoutMs: MCP_PREFLIGHT_CLEANUP_TIMEOUT_MS,
          env: process.env
        });
        if (cleanup.exitCode !== 0 || cleanup.timedOut) {
          cleanupFailure = new Error(`schema-v2 task image preflight cleanup failed for ${registeredTask.id}`);
        }
      } catch (error) {
        cleanupFailure = error instanceof Error ? error : new Error(String(error));
      }
    }
    if (failure) {
      if (cleanupFailure) {
        throw new Error(`${failure.message}; additionally, ${cleanupFailure.message}`);
      }
      throw failure;
    }
    if (cleanupFailure) {
      throw cleanupFailure;
    }
    const completedAt = new Date().toISOString();
    for (const { expected, observedServerInfo, receiptPath } of receipts) {
      if (!observedServerInfo) {
        throw new Error(`schema-v2 MCP preflight did not record server identity for ${expected.taskId}`);
      }
      writeExclusiveJson(receiptPath, { ...expected, observedServerInfo, completedAt });
    }
  }
}

function schemaV2PreflightReceiptIdentity(registration, registeredTask, serverCommand) {
  return {
    schemaVersion: 1,
    kind: "schema-v2-mcp-preflight",
    experimentId: registration.experimentId,
    configHash: registration.configHash,
    taskId: registeredTask.id,
    taskHash: registeredTask.hash,
    serverCommand,
    expectedServerInfo: {
      name: "codexa",
      version: registration.candidate.codexaVersion
    },
    mcpPreflightHash: registration.harness.mcpPreflightHash
  };
}

function schemaV2PreflightReceiptPath(preflightDir, identity) {
  const commandHash = sha256(identity.serverCommand).slice(0, 24);
  return path.join(preflightDir, `${identity.taskId}-${commandHash}.json`);
}

function requireMatchingSchemaV2PreflightReceipt(file, expected) {
  requireRegularFile(file, `schema-v2 MCP preflight receipt for ${expected.taskId}`);
  const receipt = JSON.parse(readBoundedText(file, 128 * 1024, "schema-v2 MCP preflight receipt"));
  assertObject(receipt, "schema-v2 MCP preflight receipt");
  assertKeys(receipt, [...Object.keys(expected), "observedServerInfo", "completedAt"], "schema-v2 MCP preflight receipt");
  if (typeof receipt.completedAt !== "string" || !Number.isFinite(Date.parse(receipt.completedAt))) {
    throw new Error(`schema-v2 MCP preflight receipt has an invalid completion time for ${expected.taskId}`);
  }
  const identity = Object.fromEntries(Object.keys(expected).map((key) => [key, receipt[key]]));
  if (JSON.stringify(identity) !== JSON.stringify(expected)) {
    throw new Error(`schema-v2 MCP preflight receipt identity differs from registration for ${expected.taskId}`);
  }
  requireExactServerInfo(receipt.observedServerInfo, expected.expectedServerInfo, `schema-v2 MCP preflight receipt for ${expected.taskId}`);
}

function readSchemaV2McpPreflightObservation(file, expectedServerInfo, taskId) {
  requireRegularFile(file, `schema-v2 MCP preflight observation for ${taskId}`);
  const observation = JSON.parse(readBoundedText(file, 16 * 1024, "schema-v2 MCP preflight observation"));
  assertObject(observation, "schema-v2 MCP preflight observation");
  assertKeys(observation, ["schemaVersion", "expectedServerInfo", "observedServerInfo"], "schema-v2 MCP preflight observation");
  if (observation.schemaVersion !== 1) {
    throw new Error(`schema-v2 MCP preflight observation has an unsupported schema for ${taskId}`);
  }
  requireExactServerInfo(observation.expectedServerInfo, expectedServerInfo, `schema-v2 MCP preflight expected identity for ${taskId}`);
  requireExactServerInfo(observation.observedServerInfo, expectedServerInfo, `schema-v2 MCP preflight observed identity for ${taskId}`);
  return observation.observedServerInfo;
}

function requireExactServerInfo(value, expected, label) {
  assertObject(value, label);
  assertKeys(value, ["name", "version"], label);
  if (value.name !== expected.name || value.version !== expected.version) {
    throw new Error(`${label} does not match ${expected.name}@${expected.version}`);
  }
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
    const armInput = snapshots.armInputs.get(assignment.arm);
    if (armInput) {
      harborArgs.push(
        "--mcp-config",
        armInput.mcpConfigPath,
        "--extra-instruction-path",
        armInput.extraInstructionPath
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
  const common = {
    schemaVersion: loaded.config.schemaVersion,
    experimentId: loaded.config.experimentId,
    framework: loaded.config.framework,
    harness: loaded.harness,
    runner: loaded.config.runner,
    candidate: loaded.config.candidate,
    configHash: loaded.configHash,
    tasks: loaded.tasks.map((task) => ({ id: task.id, name: task.name, hash: task.hash })),
    inputs: inputSnapshotLayout(loaded.config),
    registeredRuns: loaded.config.tasks.length * loaded.config.design.repetitions * loaded.arms.length,
    primaryReward: loaded.config.analysis.primaryReward,
    generalizationUnit: loaded.config.analysis.generalizationUnit
  };
  if (loaded.config.schemaVersion === 1) {
    return {
      ...common,
      treatment: { mcpConfigHash: loaded.mcpConfigHash, extraInstructionHash: loaded.extraInstructionHash }
    };
  }
  const assignments = buildAssignments(loaded.config);
  return {
    ...common,
    arms: loaded.arms.map((arm) => arm.kind === "control"
      ? { id: arm.id, kind: arm.kind }
      : {
          id: arm.id,
          kind: arm.kind,
          mcpConfigHash: arm.mcpConfigHash,
          extraInstructionHash: arm.extraInstructionHash,
          serverCommand: arm.serverCommand
        }),
    comparisons: loaded.config.analysis.comparisons,
    positionalBalance: summarizePositionalBalance(assignments, loaded.arms.map((arm) => arm.id))
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
