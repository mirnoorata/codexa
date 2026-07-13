import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

const METRICS = [
  ["inputTokens", "inputTokens"],
  ["cacheTokens", "cacheTokens"],
  ["outputTokens", "outputTokens"],
  ["costUsd", "costUsd"],
  ["agentElapsedMs", "agentElapsedMs"],
  ["controllerElapsedMs", "controllerElapsedMs"],
  ["codexaIndexElapsedMs", "codexaIndexElapsedMs"]
];
const ATTEMPT_KEYS = [
  "schemaVersion",
  "experimentId",
  "configHash",
  "agent",
  "model",
  "harness",
  "runner",
  "runId",
  "taskId",
  "taskName",
  "repetition",
  "arm",
  "order",
  "jobName",
  "startedAt"
];
const MAX_STRINGIFIED_TOOL_ARGUMENT_CHARACTERS = 256 * 1024;

class ProtocolIdentityError extends Error {}

export function analyzeAgentAb({ config, outputDir }) {
  const registration = readJson(path.join(outputDir, "registration.json"), "registration");
  const assignmentsByRunId = indexAssignments(registration.assignments);
  const attempts = readAttemptJournals(outputDir, assignmentsByRunId, registration);
  const runMetadata = readRunMetadata(outputDir, assignmentsByRunId, attempts);

  const outcomes = registration.assignments.map((assignment) =>
    normalizeOutcome({
      assignment,
      attempt: attempts.get(assignment.runId),
      metadata: runMetadata.get(assignment.runId),
      outputDir,
      primaryReward: config.analysis.primaryReward,
      registration,
      config
    })
  );
  const neverStartedRuns = outcomes.filter((outcome) => !outcome.started).length;
  const status = neverStartedRuns === 0 ? "complete" : "incomplete";
  const pairs = pairOutcomes(outcomes.filter((outcome) => outcome.started));
  const rewardNames = [...new Set([
    config.analysis.primaryReward,
    ...outcomes.flatMap((outcome) => Object.keys(outcome.rewards))
  ])].sort();
  const control = summarizeArm(outcomes, "control", rewardNames);
  const treatment = summarizeArm(outcomes, "treatment", rewardNames);
  const taskCount = new Set(registration.assignments.map((assignment) => assignment.taskId)).size;
  const protocolFailures = outcomes.filter((outcome) => outcome.protocolStatus === "invalid");
  const protocolStatus = protocolFailures.length === 0 ? "valid" : "invalid";
  const effect = status === "complete" && protocolStatus === "valid"
    ? summarizeEffect({
        control,
        treatment,
        pairs,
        samples: config.analysis.bootstrapSamples,
        confidenceLevel: config.analysis.confidenceLevel,
        seed: `${registration.configHash}:${config.design.seed}`
      })
    : null;

  const summary = {
    schemaVersion: 1,
    experimentId: registration.experimentId,
    registeredAt: typeof registration.createdAt === "string" ? registration.createdAt : null,
    runWindow: summarizeRunWindow(outcomes),
    configHash: registration.configHash,
    framework: registration.framework,
    harness: registration.harness,
    candidate: registration.candidate,
    runner: registration.runner,
    agent: registration.agent,
    model: registration.model,
    registeredArtifacts: {
      tasks: registration.tasks,
      treatment: registration.treatment,
      inputs: registration.inputs
    },
    status,
    protocolStatus,
    protocolFailures: protocolFailures.map((outcome) => ({
      runId: outcome.runId,
      taskId: outcome.taskId,
      arm: outcome.arm,
      reason: outcome.protocolFailure
    })),
    confirmatory: false,
    claimStatus: protocolStatus === "invalid"
      ? "invalid-protocol-no-effect-estimate"
      : status === "incomplete"
        ? "incomplete-no-effect-estimate"
        : taskCount < 2
          ? "non-confirmatory-pilot"
          : "descriptive-unless-preregistered-and-powered",
    primaryReward: config.analysis.primaryReward,
    estimand: "intention-to-treat effect of offering the Codexa MCP plus Codexa workflow-instruction bundle on verified completion",
    treatmentDefinition: {
      control: "Codexa MCP and Codexa workflow instruction are not offered",
      treatment: "Codexa MCP and Codexa workflow instruction are offered as one bundle",
      adherencePolicy: "usage telemetry is descriptive only; no run is excluded for adherence or contamination"
    },
    generalizationUnit: "task",
    registeredTasks: taskCount,
    registeredRuns: registration.assignments.length,
    startedRuns: outcomes.filter((outcome) => outcome.started).length,
    finalizedRuns: outcomes.filter((outcome) => outcome.finalized).length,
    observedRuns: outcomes.filter((outcome) => outcome.observed).length,
    neverStartedRuns,
    completePairs: pairs.length,
    arms: { control, treatment },
    treatmentFidelity: summarizeTreatmentFidelity(outcomes, registration.candidate?.codexaVersion),
    effect,
    outcomes
  };

  writeAtomicJson(path.join(outputDir, "summary.json"), summary);
  writeAtomicText(path.join(outputDir, "summary.md"), renderMarkdown(summary, config.analysis.confidenceLevel));
  return summary;
}

function indexAssignments(assignments) {
  if (!Array.isArray(assignments) || assignments.length === 0) {
    throw new Error("registration must contain assignments");
  }
  const indexed = new Map();
  for (const assignment of assignments) {
    if (!assignment || typeof assignment !== "object" || typeof assignment.runId !== "string") {
      throw new Error("registration contains a malformed assignment");
    }
    if (indexed.has(assignment.runId)) {
      throw new Error(`duplicate registered assignment for ${assignment.runId}`);
    }
    indexed.set(assignment.runId, assignment);
  }
  return indexed;
}

function readAttemptJournals(outputDir, assignmentsByRunId, registration) {
  const records = new Map();
  const attemptDir = path.join(outputDir, "attempts");
  if (!existsSync(attemptDir)) {
    return records;
  }
  for (const file of jsonFiles(attemptDir)) {
    const record = readJson(path.join(attemptDir, file), `attempt journal ${file}`);
    const assignment = requireRegisteredRecord({ record, file, assignmentsByRunId, label: "attempt journal" });
    assertExactKeys(record, ATTEMPT_KEYS, `attempt journal for ${record.runId}`);
    assertAssignmentBinding(record, assignment, { includeJobName: true, label: "attempt journal" });
    if (
      record.experimentId !== registration.experimentId
      || record.configHash !== registration.configHash
      || record.agent !== registration.agent
      || record.model !== registration.model
      || JSON.stringify(record.harness) !== JSON.stringify(registration.harness)
      || JSON.stringify(record.runner) !== JSON.stringify(registration.runner)
    ) {
      throw new Error(`attempt journal for ${record.runId} differs from the registered experiment identity`);
    }
    if (record.schemaVersion !== 1 || !Number.isFinite(Date.parse(record.startedAt))) {
      throw new Error(`attempt journal for ${record.runId} has an invalid schemaVersion or startedAt`);
    }
    records.set(record.runId, record);
  }
  return records;
}

function readRunMetadata(outputDir, assignmentsByRunId, attempts) {
  const records = new Map();
  const runDir = path.join(outputDir, "runs");
  if (!existsSync(runDir)) {
    return records;
  }
  for (const file of jsonFiles(runDir)) {
    const record = readJson(path.join(runDir, file), `run metadata ${file}`);
    const assignment = requireRegisteredRecord({ record, file, assignmentsByRunId, label: "run metadata" });
    if (!attempts.has(record.runId)) {
      throw new Error(`run metadata for ${record.runId} is missing its pre-spawn attempt journal`);
    }
    assertAssignmentBinding(record, assignment, { includeJobName: false, label: "run metadata" });
    const expectedJobResultPath = path.posix.join("jobs", assignment.jobName, "result.json");
    if (record.schemaVersion !== 1 || record.jobResultPath !== expectedJobResultPath) {
      throw new Error(`run metadata for ${record.runId} is not bound to registered job ${assignment.jobName}`);
    }
    if (!Number.isInteger(record.exitCode) || typeof record.timedOut !== "boolean" || !Number.isFinite(record.controllerElapsedMs)) {
      throw new Error(`run metadata for ${record.runId} has invalid completion fields`);
    }
    records.set(record.runId, record);
  }
  return records;
}

function jsonFiles(directory) {
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => entry.name)
    .sort();
}

function requireRegisteredRecord({ record, file, assignmentsByRunId, label }) {
  if (!record || typeof record !== "object" || Array.isArray(record) || typeof record.runId !== "string") {
    throw new Error(`${label} ${file} must be an object with a runId`);
  }
  if (file !== `${record.runId}.json`) {
    throw new Error(`${label} filename does not match embedded runId ${record.runId}`);
  }
  const assignment = assignmentsByRunId.get(record.runId);
  if (!assignment) {
    throw new Error(`${label} references unregistered run ${record.runId}`);
  }
  return assignment;
}

function assertAssignmentBinding(record, assignment, { includeJobName, label }) {
  const fields = ["runId", "taskId", ...(includeJobName ? ["taskName"] : []), "repetition", "arm", "order", ...(includeJobName ? ["jobName"] : [])];
  for (const field of fields) {
    if (record[field] !== assignment[field]) {
      throw new Error(`${label} for ${assignment.runId} has mismatched ${field}`);
    }
  }
}

function assertExactKeys(record, expected, label) {
  const actual = Object.keys(record).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    throw new Error(`${label} must contain exactly: ${wanted.join(", ")}`);
  }
}

function normalizeOutcome({ assignment, attempt, metadata, outputDir, primaryReward, registration, config }) {
  const base = {
    runId: assignment.runId,
    taskId: assignment.taskId,
    taskName: assignment.taskName,
    repetition: assignment.repetition,
    arm: assignment.arm,
    order: assignment.order,
    started: Boolean(attempt),
    finalized: Boolean(metadata),
    observed: Boolean(metadata),
    success: attempt ? false : null,
    failureClass: attempt ? "started-unfinalized" : null,
    protocolStatus: "not-observable",
    protocolFailure: null,
    attemptStartedAt: timestampOrNull(attempt?.startedAt),
    agentStartedAt: null,
    agentFinishedAt: null,
    rewards: {},
    inputTokens: null,
    cacheTokens: null,
    outputTokens: null,
    costUsd: null,
    agentElapsedMs: null,
    controllerElapsedMs: metadata?.controllerElapsedMs ?? null,
    codexaIndexElapsedMs: null,
    codexaSetup: { status: "unavailable" },
    codexaUsage: { status: "unavailable", codexaInvoked: null, codexaCallCount: null, callsByTool: null }
  };
  if (!attempt || !metadata) {
    return base;
  }
  if (metadata.timedOut) {
    return { ...base, failureClass: "controller-timeout" };
  }
  if (metadata.exitCode !== 0) {
    return { ...base, failureClass: "harbor-error" };
  }
  const resultPath = safeOutputPath(outputDir, metadata.jobResultPath);
  if (!resultPath || !existsSync(resultPath)) {
    return {
      ...base,
      success: null,
      failureClass: null,
      protocolStatus: "invalid",
      protocolFailure: "finalized Harbor run is missing its evaluator-owned job result"
    };
  }

  let trialRecord;
  try {
    trialRecord = readHarborTrialResult(resultPath, assignment);
  } catch (error) {
    return {
      ...base,
      success: null,
      failureClass: null,
      protocolStatus: "invalid",
      protocolFailure: error instanceof ProtocolIdentityError
        ? error.message
        : `cannot establish evaluator result schema for ${assignment.runId}`
    };
  }
  const { trial, trialPath } = trialRecord;
  const codexaSetup = readCodexaSetup(path.dirname(trialPath), registration.candidate?.codexaVersion);
  const codexaUsage = inferCodexaUsage(path.dirname(trialPath));
  const agentStartedAt = timestampOrNull(trial.agent_execution?.started_at);
  const agentFinishedAt = timestampOrNull(trial.agent_execution?.finished_at);
  const protocolFailure = validateTrialProtocol({ trial, assignment, registration, outputDir });
  if (protocolFailure) {
    return {
      ...base,
      success: null,
      failureClass: null,
      protocolStatus: "invalid",
      protocolFailure,
      agentStartedAt,
      agentFinishedAt,
      codexaIndexElapsedMs: codexaSetup.indexElapsedMs ?? null,
      codexaSetup,
      codexaUsage
    };
  }
  const rewards = numericRecord(trial.verifier_result?.rewards);
  const agent = trial.agent_result ?? {};
  const exception = trial.exception_info;
  const success = !exception && rewards[primaryReward] === 1;
  return {
    ...base,
    protocolStatus: "valid",
    success,
    failureClass: success ? null : exception ? "trial-error" : rewards[primaryReward] === undefined ? "missing-primary-reward" : "verification-failed",
    agentStartedAt,
    agentFinishedAt,
    rewards,
    inputTokens: finiteOrNull(agent.n_input_tokens),
    cacheTokens: finiteOrNull(agent.n_cache_tokens),
    outputTokens: finiteOrNull(agent.n_output_tokens),
    costUsd: finiteOrNull(agent.cost_usd),
    agentElapsedMs: elapsedMs(trial.agent_execution),
    codexaIndexElapsedMs: codexaSetup.indexElapsedMs ?? null,
    codexaSetup,
    codexaUsage
  };
}

function readHarborTrialResult(jobResultPath, assignment) {
  if (!isRegularNonSymlink(jobResultPath)) {
    throw new ProtocolIdentityError(`Harbor aggregate for ${assignment.runId} is not a regular result file`);
  }
  const job = readJson(jobResultPath, `Harbor job result for ${assignment.runId}`);
  const completed = job?.stats?.n_completed_trials;
  const errored = job?.stats?.n_errored_trials;
  if (
    !job
    || typeof job !== "object"
    || Array.isArray(job)
    || job.n_total_trials !== 1
    || !Number.isInteger(completed)
    || !Number.isInteger(errored)
    || completed + errored !== 1
  ) {
    throw new Error("Harbor job result does not match the pinned single-trial aggregate schema");
  }
  const jobDir = path.dirname(jobResultPath);
  const trialPaths = readdirSync(jobDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
    .map((entry) => path.join(jobDir, entry.name, "result.json"));
  if (trialPaths.length !== 1) {
    throw new ProtocolIdentityError(`Harbor job for ${assignment.runId} must contain exactly one trial directory`);
  }
  const trialPath = trialPaths[0];
  if (!isRegularNonSymlink(trialPath)) {
    throw new ProtocolIdentityError(`Harbor trial result for ${assignment.runId} is not a regular result file`);
  }
  const trial = readJson(trialPath, `Harbor trial result for ${assignment.runId}`);
  const expectedTaskName = assignment.taskName;
  const expectedTrialName = path.basename(path.dirname(trialPath));
  if (
    !trial
    || typeof trial !== "object"
    || Array.isArray(trial)
    || typeof job.id !== "string"
    || job.id.length === 0
    || trial.config?.job_id !== job.id
    || trial.task_name !== expectedTaskName
    || trial.trial_name !== expectedTrialName
  ) {
    throw new ProtocolIdentityError(`Harbor trial identity does not match registered run ${assignment.runId}`);
  }
  return { trial, trialPath };
}

function validateTrialProtocol({ trial, assignment, registration, outputDir }) {
  const agent = trial.config?.agent;
  if (!agent || typeof agent !== "object" || Array.isArray(agent)) {
    return "trial config is missing agent identity";
  }
  if (agent.name !== registration.agent) {
    return `trial agent ${String(agent.name)} does not match registered agent ${registration.agent}`;
  }
  if (agent.model_name !== registration.model) {
    return `trial model ${String(agent.model_name)} does not match registered model ${registration.model}`;
  }
  const expectedKwargs = { version: registration.runner?.version, ...registration.runner?.kwargs };
  if (!sameFlatRecord(agent.kwargs, expectedKwargs)) {
    return "trial runner kwargs do not match the registered runner version and configuration";
  }
  const registeredTask = Array.isArray(registration.inputs?.tasks)
    ? registration.inputs.tasks.find((entry) => entry?.id === assignment.taskId)
    : null;
  const expectedTaskPath = safeOutputPath(outputDir, registeredTask?.path);
  const trialTask = trial.config?.task;
  if (
    !trialTask
    || typeof trialTask !== "object"
    || Array.isArray(trialTask)
    || typeof trialTask.path !== "string"
    || expectedTaskPath === null
    || trialTask.path !== expectedTaskPath
  ) {
    return `trial task path does not match the registered immutable snapshot for ${assignment.taskId}`;
  }
  const servers = agent.mcp_servers;
  const instructions = trial.config?.extra_instruction_paths;
  if (!Array.isArray(servers) || !Array.isArray(instructions)) {
    return "trial config is missing MCP server or extra-instruction arrays";
  }
  if (assignment.arm === "control") {
    return servers.length === 0 && instructions.length === 0
      ? null
      : "control trial received Codexa MCP or extra instructions";
  }
  const server = servers[0];
  const expectedInstruction = safeOutputPath(outputDir, registration.inputs?.treatment?.extraInstruction);
  const instruction = instructions[0];
  const serverMatches = servers.length === 1
    && server
    && typeof server === "object"
    && !Array.isArray(server)
    && server.name === "codexa"
    && server.transport === "stdio"
    && server.command === "/opt/codexa-agent-ab/start-codexa-mcp"
    && Array.isArray(server.args)
    && server.args.length === 0
    && (server.url === null || server.url === undefined);
  const instructionMatches = instructions.length === 1
    && typeof instruction === "string"
    && expectedInstruction !== null
    && instruction === expectedInstruction;
  if (!serverMatches || !instructionMatches) {
    return "treatment trial did not receive exactly the registered Codexa MCP and workflow-instruction bundle";
  }
  return null;
}

function sameFlatRecord(actual, expected) {
  if (!actual || typeof actual !== "object" || Array.isArray(actual)) {
    return false;
  }
  const actualEntries = Object.entries(actual).sort(([left], [right]) => left.localeCompare(right));
  const expectedEntries = Object.entries(expected).sort(([left], [right]) => left.localeCompare(right));
  return JSON.stringify(actualEntries) === JSON.stringify(expectedEntries);
}

function isRegularNonSymlink(target) {
  try {
    const entry = lstatSync(target);
    return entry.isFile() && !entry.isSymbolicLink();
  } catch {
    return false;
  }
}

function pairOutcomes(outcomes) {
  const grouped = new Map();
  for (const outcome of outcomes) {
    const key = `${outcome.taskId}\0${outcome.repetition}`;
    const current = grouped.get(key) ?? { taskId: outcome.taskId, repetition: outcome.repetition };
    if (current[outcome.arm]) {
      throw new Error(`duplicate ${outcome.arm} outcome for ${outcome.taskId} repetition ${outcome.repetition}`);
    }
    current[outcome.arm] = outcome;
    grouped.set(key, current);
  }
  return [...grouped.values()]
    .filter((pair) => pair.control && pair.treatment)
    .sort((left, right) => left.taskId.localeCompare(right.taskId) || left.repetition - right.repetition);
}

function summarizeArm(outcomes, arm, rewardNames) {
  const registered = outcomes.filter((outcome) => outcome.arm === arm);
  const started = registered.filter((outcome) => outcome.started);
  const finalized = registered.filter((outcome) => outcome.finalized);
  const evaluable = started.filter((outcome) => typeof outcome.success === "boolean");
  const successful = evaluable.filter((outcome) => outcome.success === true);
  return {
    registeredRuns: registered.length,
    runs: started.length,
    startedRuns: started.length,
    finalizedRuns: finalized.length,
    neverStartedRuns: registered.length - started.length,
    protocolInvalidRuns: started.filter((outcome) => outcome.protocolStatus === "invalid").length,
    successes: successful.length,
    failures: evaluable.filter((outcome) => outcome.success === false).length,
    successRate: evaluable.length === 0 ? null : successful.length / evaluable.length,
    rewardMetrics: summarizeRewardMetrics(started, rewardNames),
    metrics: summarizeMetrics(started),
    completionConditionedMetrics: summarizeMetrics(successful),
    failureClasses: countBy(started.filter((outcome) => outcome.failureClass), (outcome) => outcome.failureClass)
  };
}

function summarizeRewardMetrics(outcomes, rewardNames) {
  return Object.fromEntries(rewardNames.map((name) => {
    const present = outcomes.map((outcome) => outcome.rewards[name]).filter((value) => Number.isFinite(value));
    return [name, summarizeValues(present, outcomes.length)];
  }));
}

function summarizeMetrics(outcomes) {
  return Object.fromEntries(METRICS.map(([name, field]) => [name, metricSummary(outcomes, field)]));
}

function summarizeRunWindow(outcomes) {
  const attempts = outcomes.map((outcome) => outcome.attemptStartedAt).filter(Boolean).sort();
  const agentStarts = outcomes.map((outcome) => outcome.agentStartedAt).filter(Boolean).sort();
  const agentFinishes = outcomes.map((outcome) => outcome.agentFinishedAt).filter(Boolean).sort();
  return {
    firstAttemptStartedAt: attempts[0] ?? null,
    lastAttemptStartedAt: attempts.at(-1) ?? null,
    firstAgentStartedAt: agentStarts[0] ?? null,
    lastAgentFinishedAt: agentFinishes.at(-1) ?? null
  };
}

function metricSummary(outcomes, field) {
  const present = outcomes.map((outcome) => outcome[field]).filter((value) => Number.isFinite(value));
  return summarizeValues(present, outcomes.length);
}

function summarizeValues(present, eligibleRuns) {
  return {
    eligibleRuns,
    presentRuns: present.length,
    missingRuns: eligibleRuns - present.length,
    total: present.length === 0 ? null : present.reduce((sum, value) => sum + value, 0),
    mean: present.length === 0 ? null : present.reduce((sum, value) => sum + value, 0) / present.length
  };
}

function summarizeEffect({ control, treatment, pairs, samples, confidenceLevel, seed }) {
  const discordance = summarizeDiscordance(pairs);
  return {
    absoluteRiskDifference: treatment.successRate - control.successRate,
    treatmentOnlyPairs: discordance.treatmentOnly,
    controlOnlyPairs: discordance.controlOnly,
    bothPassPairs: discordance.bothPass,
    bothFailPairs: discordance.bothFail,
    taskClusteredBootstrap: taskClusteredBootstrap({ pairs, samples, confidenceLevel, seed })
  };
}

function summarizeDiscordance(pairs) {
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

function taskClusteredBootstrap({ pairs, samples, confidenceLevel, seed }) {
  const tasks = [...new Set(pairs.map((pair) => pair.taskId))].sort();
  if (tasks.length < 2 || samples < 1) {
    return {
      lower: null,
      upper: null,
      samples: 0,
      tasks: tasks.length,
      confidenceLevel,
      note: "at least two tasks are required; a one-task pilot is non-confirmatory"
    };
  }
  const byTask = new Map(tasks.map((task) => [task, pairs.filter((pair) => pair.taskId === task)]));
  const random = deterministicRandom(seed);
  const deltas = [];
  for (let sample = 0; sample < samples; sample += 1) {
    let treatmentSuccesses = 0;
    let controlSuccesses = 0;
    let runs = 0;
    for (let index = 0; index < tasks.length; index += 1) {
      const task = tasks[Math.floor(random() * tasks.length)];
      for (const pair of byTask.get(task)) {
        treatmentSuccesses += Number(pair.treatment.success);
        controlSuccesses += Number(pair.control.success);
        runs += 1;
      }
    }
    deltas.push(runs === 0 ? 0 : (treatmentSuccesses - controlSuccesses) / runs);
  }
  deltas.sort((left, right) => left - right);
  const alpha = 1 - confidenceLevel;
  return {
    lower: quantile(deltas, alpha / 2),
    upper: quantile(deltas, 1 - alpha / 2),
    samples,
    tasks: tasks.length,
    confidenceLevel,
    note: "task-clustered percentile bootstrap; repetitions are not independent clusters"
  };
}

function summarizeTreatmentFidelity(outcomes, candidateVersion) {
  return {
    candidateVersion: candidateVersion ?? null,
    control: fidelityForArm(outcomes, "control"),
    treatment: fidelityForArm(outcomes, "treatment")
  };
}

function fidelityForArm(outcomes, arm) {
  const selected = outcomes.filter((outcome) => outcome.arm === arm && outcome.started);
  const observed = selected.filter((outcome) => outcome.codexaUsage.status === "observed");
  const invoked = observed.filter((outcome) => outcome.codexaUsage.codexaInvoked);
  const setupObserved = selected.filter((outcome) => outcome.codexaSetup.status === "observed");
  return {
    startedRuns: selected.length,
    traceObservedRuns: observed.length,
    traceUnknownRuns: selected.length - observed.length,
    codexaInvokedRuns: invoked.length,
    codexaCallsByTool: mergeCallCounts(observed.map((outcome) => outcome.codexaUsage.callsByTool)),
    noCodexaInvocationObservedRuns: observed.length - invoked.length,
    contaminationRuns: arm === "control" ? invoked.length : 0,
    nonadherentRuns: arm === "treatment" ? observed.length - invoked.length : 0,
    setupObservedRuns: setupObserved.length,
    setupSuccessfulRuns: setupObserved.filter((outcome) => outcome.codexaSetup.indexExitCode === 0).length,
    setupFailedRuns: setupObserved.filter((outcome) => Number.isInteger(outcome.codexaSetup.indexExitCode) && outcome.codexaSetup.indexExitCode !== 0).length,
    setupVersionMismatchRuns: setupObserved.filter((outcome) => outcome.codexaSetup.versionMatchesCandidate === false).length,
    note: "agent-reported trajectory and setup telemetry are descriptive and never change ITT inclusion"
  };
}

function inferCodexaUsage(trialDir) {
  const matches = findFiles(trialDir, "trajectory.json", 6);
  if (matches.length === 0) {
    return { status: "missing", codexaInvoked: null, codexaCallCount: null, callsByTool: null };
  }
  if (matches.length !== 1) {
    return { status: "ambiguous", codexaInvoked: null, codexaCallCount: null, callsByTool: null };
  }
  try {
    if (statSync(matches[0]).size > 32 * 1024 * 1024) {
      return { status: "too-large", codexaInvoked: null, codexaCallCount: null, callsByTool: null };
    }
    const trajectory = readJson(matches[0], "Harbor trajectory");
    if (!trajectory || typeof trajectory !== "object" || trajectory.schema_version !== "ATIF-v1.7" || !Array.isArray(trajectory.steps)) {
      return { status: "unsupported", codexaInvoked: null, codexaCallCount: null, callsByTool: null };
    }
    const scan = scanStructuredToolCalls(trajectory.steps);
    if (!scan.complete) {
      return { status: "scan-limit", codexaInvoked: null, codexaCallCount: null, callsByTool: null };
    }
    return {
      status: "observed",
      codexaInvoked: scan.codexaCalls > 0,
      codexaCallCount: scan.codexaCalls,
      callsByTool: scan.callsByTool
    };
  } catch {
    return { status: "malformed", codexaInvoked: null, codexaCallCount: null, callsByTool: null };
  }
}

function scanStructuredToolCalls(root) {
  const stack = [{ value: root, parentKey: "" }];
  let visited = 0;
  let codexaCalls = 0;
  const callsByTool = {};
  while (stack.length > 0) {
    const { value, parentKey } = stack.pop();
    visited += 1;
    if (visited > 100_000) {
      return { complete: false, codexaCalls: 0, callsByTool: {} };
    }
    if (Array.isArray(value)) {
      for (const entry of value) {
        stack.push({ value: entry, parentKey });
      }
      continue;
    }
    if (!value || typeof value !== "object") {
      continue;
    }
    if (isToolCallObject(value, parentKey)) {
      const names = identifyCodexaCalls(value);
      codexaCalls += names.length;
      for (const name of names) {
        callsByTool[name] = (callsByTool[name] ?? 0) + 1;
      }
    }
    for (const [key, entry] of Object.entries(value)) {
      stack.push({ value: entry, parentKey: key });
    }
  }
  return {
    complete: true,
    codexaCalls,
    callsByTool: Object.fromEntries(Object.entries(callsByTool).sort(([left], [right]) => left.localeCompare(right)))
  };
}

function isToolCallObject(value, parentKey) {
  const type = String(value.type ?? value.kind ?? value.event_type ?? "").toLowerCase();
  const normalizedParent = parentKey.replaceAll("_", "").toLowerCase();
  return normalizedParent === "toolcalls"
    || normalizedParent === "tooluses"
    || type.includes("tool_call")
    || type.includes("tool_use")
    || typeof value.tool_name === "string"
    || typeof value.toolName === "string"
    || typeof value.function_name === "string";
}

function identifyCodexaCalls(value) {
  const identifiers = [
    value.tool_name,
    value.toolName,
    value.function_name,
    value.functionName,
    value.name,
    value.server,
    value.server_name,
    value.mcp_server,
    value.function?.name
  ].filter((entry) => typeof entry === "string");
  for (const identifier of identifiers) {
    const match = /mcp__codexa__([a-z0-9_]+)/iu.exec(identifier);
    if (match) {
      return [match[1].toLowerCase()];
    }
  }
  const mcpNames = extractMcpCallNames(value.arguments);
  if (mcpNames.length > 0) {
    return mcpNames;
  }
  const cliNames = extractCodexaCliNames(value.arguments);
  if (cliNames.length > 0) {
    return cliNames;
  }
  return identifiers.some((entry) => /(?:^|[^a-z0-9])codexa(?:[^a-z0-9]|$)/iu.test(entry))
    ? ["unknown"]
    : [];
}

function extractMcpCallNames(value) {
  if (typeof value === "string") {
    const names = [];
    const pattern = /tools(?:\.|\[\s*["'])mcp__codexa__([a-z0-9_]+)/giu;
    for (const match of value.matchAll(pattern)) {
      names.push(match[1].toLowerCase());
    }
    return names;
  }
  if (Array.isArray(value)) {
    return value.flatMap((entry) => extractMcpCallNames(entry));
  }
  if (!value || typeof value !== "object") {
    return [];
  }
  return Object.values(value).flatMap((entry) => extractMcpCallNames(entry));
}

function extractCodexaCliNames(value) {
  if (typeof value === "string") {
    const parsed = parseStringifiedToolArguments(value);
    return parsed === null ? [] : extractCodexaCliNamesFromStructured(parsed);
  }
  return extractCodexaCliNamesFromStructured(value);
}

function parseStringifiedToolArguments(value) {
  if (value.length > MAX_STRINGIFIED_TOOL_ARGUMENT_CHARACTERS) {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
    return null;
  }
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function extractCodexaCliNamesFromStructured(value) {
  if (Array.isArray(value)) {
    return value.flatMap((entry) => extractCodexaCliNamesFromStructured(entry));
  }
  if (!value || typeof value !== "object") {
    return [];
  }
  const names = [];
  for (const [key, entry] of Object.entries(value)) {
    if (["command", "cmd", "shell_command"].includes(key) && typeof entry === "string") {
      const pattern = /(?:^|[;&|\n][ \t]*)codexa[ \t]+([a-z][a-z0-9-]*)/giu;
      for (const match of entry.matchAll(pattern)) {
        names.push(`cli:${match[1].toLowerCase()}`);
      }
      continue;
    }
    names.push(...extractCodexaCliNamesFromStructured(entry));
  }
  return names;
}

function mergeCallCounts(records) {
  const merged = {};
  for (const record of records) {
    if (!record || typeof record !== "object" || Array.isArray(record)) {
      continue;
    }
    for (const [name, count] of Object.entries(record)) {
      if (Number.isInteger(count) && count > 0) {
        merged[name] = (merged[name] ?? 0) + count;
      }
    }
  }
  return Object.fromEntries(Object.entries(merged).sort(([left], [right]) => left.localeCompare(right)));
}

function renderMarkdown(summary, confidenceLevel) {
  const percent = (value) => `${(value * 100).toFixed(1)}%`;
  const confidenceLabel = formatConfidenceLevel(confidenceLevel);
  const lines = [
    `# ${summary.experimentId}`,
    "",
    `Status: ${summary.status}.`,
    `Protocol status: ${summary.protocolStatus}.`,
    "",
    `Estimand: ${summary.estimand}.`,
    "",
    `- Agent: ${summary.agent}`,
    `- Model: ${summary.model}`,
    `- Registered runs: ${summary.registeredRuns}`,
    `- Started runs: ${summary.startedRuns}`,
    `- Finalized runs: ${summary.finalizedRuns}`,
    `- Never-started runs: ${summary.neverStartedRuns}`,
    `- Control: ${summary.arms.control.successes}/${summary.arms.control.startedRuns} started runs`,
    `- Treatment: ${summary.arms.treatment.successes}/${summary.arms.treatment.startedRuns} started runs`
  ];
  if (summary.effect === null) {
    lines.push(summary.protocolStatus === "invalid"
      ? "- Effect: not estimated because at least one finalized trial violated the registered arm protocol"
      : "- Effect: not estimated because at least one registered assignment never started");
  } else {
    const ci = summary.effect.taskClusteredBootstrap;
    const ciText = ci.lower === null ? "not estimable" : `${percent(ci.lower)} to ${percent(ci.upper)}`;
    lines.push(
      `- Absolute risk difference: ${percent(summary.effect.absoluteRiskDifference)}`,
      `- Task-clustered ${confidenceLabel} interval: ${ciText}`,
      `- Discordant pairs: treatment-only ${summary.effect.treatmentOnlyPairs}, control-only ${summary.effect.controlOnlyPairs}`
    );
  }
  lines.push(
    `- Control contamination observed: ${summary.treatmentFidelity.control.contaminationRuns}`,
    `- Treatment nonadherence observed: ${summary.treatmentFidelity.treatment.nonadherentRuns}`,
    `- Treatment setup observed/success/failed/version-mismatch: ${summary.treatmentFidelity.treatment.setupObservedRuns}/${summary.treatmentFidelity.treatment.setupSuccessfulRuns}/${summary.treatmentFidelity.treatment.setupFailedRuns}/${summary.treatmentFidelity.treatment.setupVersionMismatchRuns}`,
    "",
    summary.registeredTasks < 2
      ? "This one-task run is a non-confirmatory plumbing pilot and cannot support a product-effect claim."
      : "Treat this result as descriptive unless the task set, power target, and analysis were preregistered.",
    ""
  );
  return lines.join("\n");
}

function formatConfidenceLevel(confidenceLevel) {
  return `${Number((confidenceLevel * 100).toFixed(3))}%`;
}

function readCodexaSetup(jobDir, candidateVersion) {
  const matches = findFiles(jobDir, "codexa-setup.json", 6);
  if (matches.length === 0) {
    return { status: "missing" };
  }
  if (matches.length !== 1) {
    return { status: "ambiguous" };
  }
  try {
    const setup = readJson(matches[0], "Codexa setup artifact");
    return {
      status: "observed",
      evidenceTrust: "agent-reported",
      codexaVersion: typeof setup.codexaVersion === "string" ? setup.codexaVersion : null,
      versionMatchesCandidate: typeof setup.codexaVersion === "string" && typeof candidateVersion === "string"
        ? setup.codexaVersion === candidateVersion
        : null,
      indexExitCode: Number.isInteger(setup.indexExitCode) ? setup.indexExitCode : null,
      indexElapsedMs: finiteOrNull(setup.indexElapsedMs)
    };
  } catch {
    return { status: "malformed" };
  }
}

function findFiles(root, basename, depth) {
  if (depth < 0 || !existsSync(root)) {
    return [];
  }
  const matches = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name);
    if (entry.isSymbolicLink()) {
      continue;
    }
    if (entry.isDirectory()) {
      matches.push(...findFiles(target, basename, depth - 1));
    } else if (entry.isFile() && entry.name === basename) {
      matches.push(target);
    }
  }
  return matches;
}

function safeOutputPath(outputDir, relative) {
  if (typeof relative !== "string" || path.isAbsolute(relative) || relative.includes("\\")) {
    return null;
  }
  const resolved = path.resolve(outputDir, relative);
  const prefix = `${path.resolve(outputDir)}${path.sep}`;
  return resolved.startsWith(prefix) ? resolved : null;
}

function numericRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => Number.isFinite(entry)));
}

function elapsedMs(timing) {
  const start = Date.parse(timing?.started_at ?? "");
  const finish = Date.parse(timing?.finished_at ?? "");
  return Number.isFinite(start) && Number.isFinite(finish) && finish >= start ? finish - start : null;
}

function timestampOrNull(value) {
  if (typeof value !== "string") {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function finiteOrNull(value) {
  return Number.isFinite(value) ? Number(value) : null;
}

function countBy(values, key) {
  const result = {};
  for (const value of values) {
    const label = String(key(value));
    result[label] = (result[label] ?? 0) + 1;
  }
  return result;
}

function deterministicRandom(seed) {
  let counter = 0;
  return () => {
    const digest = createHash("sha256").update(`${seed}\0${counter}`).digest();
    counter += 1;
    return digest.readUIntBE(0, 6) / 2 ** 48;
  };
}

function quantile(sorted, probability) {
  if (sorted.length === 0) {
    return null;
  }
  const index = (sorted.length - 1) * probability;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) {
    return sorted[lower];
  }
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}

function readJson(file, label) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`cannot read ${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function writeAtomicJson(file, value) {
  writeAtomicText(file, `${JSON.stringify(value, null, 2)}\n`);
}

function writeAtomicText(file, value) {
  const temporary = `${file}.tmp-${process.pid}`;
  writeFileSync(temporary, value, { encoding: "utf8", flag: "wx", mode: 0o600 });
  renameSync(temporary, file);
}
