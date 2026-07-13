import { createHash } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync
} from "node:fs";
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
const PAIRED_OVERHEAD_METRICS = [
  ["inputTokens", (outcome) => outcome.inputTokens],
  ["cacheTokens", (outcome) => outcome.cacheTokens],
  ["outputTokens", (outcome) => outcome.outputTokens],
  ["costUsd", (outcome) => outcome.costUsd],
  ["agentElapsedMs", (outcome) => outcome.agentElapsedMs],
  ["controllerElapsedMs", (outcome) => outcome.controllerElapsedMs],
  ["atifCorrelatedCalls", observedTelemetryValue("transportTelemetry", "correlatedCalls")],
  ["atifRequestArgumentBytes", observedTelemetryValue("transportTelemetry", "requestArgumentBytes")],
  ["atifModelVisibleResultTextBytes", observedTelemetryValue("transportTelemetry", "modelVisibleResultTextBytes")],
  ["atifExplicitDetailedRequests", observedTelemetryValue("transportTelemetry", "explicitDetailedRequests")],
  ["atifDetailResourceFetches", observedTelemetryValue("transportTelemetry", "detailResourceFetches")],
  ["atifDetailResourceFetchRequestArgumentBytes", observedTelemetryValue("transportTelemetry", "detailResourceFetchRequestArgumentBytes")],
  ["atifDetailResourceFetchResultTextBytes", observedTelemetryValue("transportTelemetry", "detailResourceFetchResultTextBytes")],
  ["serverEvents", observedTelemetryValue("serverTelemetry", "events")],
  ["serverToolCallEvents", observedTelemetryValue("serverTelemetry", "toolCallEvents")],
  ["serverDetailResourceFetches", observedTelemetryValue("serverTelemetry", "detailResourceFetches")],
  ["serverRequestBytes", observedTelemetryValue("serverTelemetry", "requestBytes")],
  ["serverTextBytes", observedTelemetryValue("serverTelemetry", "textBytes")],
  ["serverStructuredBytes", observedTelemetryValue("serverTelemetry", "structuredBytes")],
  ["serverTotalBytes", observedTelemetryValue("serverTelemetry", "totalBytes")],
  ["serverElapsedMs", observedTelemetryValue("serverTelemetry", "elapsedMs")],
  ["serverDetailResourceFetchRequestBytes", observedTelemetryValue("serverTelemetry", "detailResourceFetchRequestBytes")],
  ["serverDetailResourceFetchTextBytes", observedTelemetryValue("serverTelemetry", "detailResourceFetchTextBytes")],
  ["serverDetailResourceFetchTotalBytes", observedTelemetryValue("serverTelemetry", "detailResourceFetchTotalBytes")],
  ["serverDetailResourceFetchElapsedMs", observedTelemetryValue("serverTelemetry", "detailResourceFetchElapsedMs")]
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
const MAX_POST_EDIT_OBSERVATION_CHARACTERS = 256 * 1024;
const MAX_POST_EDIT_JSON_CANDIDATES = 64;
const MAX_POST_EDIT_REVIEW_CALLS = 100;
const MAX_TRANSPORT_CALLS = 1_000;
const MAX_TRANSPORT_BYTES = 8 * 1024 * 1024;
const MAX_SERVER_TELEMETRY_BYTES = 4 * 1024 * 1024;
const MAX_SERVER_TELEMETRY_LINES = 1_000;
const MAX_SERVER_TELEMETRY_LINE_BYTES = 64 * 1024;
const MAX_SERVER_TELEMETRY_SCAN_ENTRIES = 10_000;
const MAX_SERVER_TELEMETRY_EVENT_BYTES = 1024 * 1024 * 1024;
const MAX_SERVER_TELEMETRY_EVENT_ELAPSED_MS = 24 * 60 * 60 * 1000;
const SERVER_TELEMETRY_BASENAME = "codexa-mcp-telemetry.jsonl";
const MAX_MCP_PREFLIGHT_RECEIPT_BYTES = 128 * 1024;
const MCP_PREFLIGHT_RECEIPT_KEYS = [
  "schemaVersion",
  "kind",
  "experimentId",
  "configHash",
  "taskId",
  "taskHash",
  "serverCommand",
  "expectedServerInfo",
  "mcpPreflightHash",
  "observedServerInfo",
  "completedAt"
];
const POST_EDIT_FINAL_STATES = [
  "not-reviewed",
  "complete",
  "advisory",
  "nonblocking-after-blocking",
  "blocking-unresolved",
  "unknown"
];
const BLOCKING_COMPLETION_AUTHORITIES = new Set(["tests_required", "blocking_inspect", "replan_required"]);

class ProtocolIdentityError extends Error {}

export function analyzeAgentAb({ config, outputDir }) {
  const registration = readJson(path.join(outputDir, "registration.json"), "registration");
  const assignmentsByRunId = indexAssignments(registration.assignments);
  const attempts = readAttemptJournals(outputDir, assignmentsByRunId, registration);
  const runMetadata = readRunMetadata(outputDir, assignmentsByRunId, attempts);

  const normalizedOutcomes = registration.assignments.map((assignment) =>
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
  if (registration.schemaVersion === 2) {
    const candidateIdentityProof = readSchemaV2CandidateIdentityProof({ outputDir, registration, attempts });
    const outcomes = applySchemaV2CandidateIdentityProof(normalizedOutcomes, registration, candidateIdentityProof.failuresByPair);
    const summary = buildSchemaV2Summary({ config, registration, outcomes, candidateIdentityProof: candidateIdentityProof.report });
    writeAtomicJson(path.join(outputDir, "summary.json"), summary);
    writeAtomicText(path.join(outputDir, "summary.md"), renderSchemaV2Markdown(summary, config.analysis.confidenceLevel));
    return summary;
  }
  if (registration.schemaVersion !== 1) {
    throw new Error(`unsupported registration schemaVersion: ${String(registration.schemaVersion)}`);
  }
  const outcomes = normalizedOutcomes;
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

function buildSchemaV2Summary({ config, registration, outcomes, candidateIdentityProof }) {
  if (!Array.isArray(registration.arms) || registration.arms.length < 2) {
    throw new Error("schema-v2 registration must contain arms");
  }
  if (!Array.isArray(registration.comparisons) || registration.comparisons.length < 1) {
    throw new Error("schema-v2 registration must contain comparisons");
  }
  const armIds = registration.arms.map((arm) => arm.id);
  if (new Set(armIds).size !== armIds.length) {
    throw new Error("schema-v2 registration contains duplicate arms");
  }
  const neverStartedRuns = outcomes.filter((outcome) => !outcome.started).length;
  const status = neverStartedRuns === 0 ? "complete" : "incomplete";
  const protocolFailures = outcomes.filter((outcome) => outcome.protocolStatus === "invalid");
  const protocolStatus = protocolFailures.length === 0 ? "valid" : "invalid";
  const rewardNames = [...new Set([
    config.analysis.primaryReward,
    ...outcomes.flatMap((outcome) => Object.keys(outcome.rewards))
  ])].sort();
  const arms = Object.fromEntries(armIds.map((arm) => [arm, summarizeArm(outcomes, arm, rewardNames)]));
  const comparisons = {};
  for (const comparison of registration.comparisons) {
    if (!arms[comparison.baselineArm] || !arms[comparison.candidateArm]) {
      throw new Error(`registered comparison ${comparison.id} references an unknown arm`);
    }
    const pairs = pairComparisonOutcomes(
      outcomes.filter((outcome) => outcome.started),
      comparison.baselineArm,
      comparison.candidateArm
    );
    comparisons[comparison.id] = {
      id: comparison.id,
      baselineArm: comparison.baselineArm,
      candidateArm: comparison.candidateArm,
      primary: comparison.primary,
      completePairs: pairs.length,
      pairedOverhead: summarizePairedOverhead(pairs),
      effect: status === "complete" && protocolStatus === "valid"
        ? summarizeComparisonEffect({
            baseline: arms[comparison.baselineArm],
            candidate: arms[comparison.candidateArm],
            pairs,
            samples: config.analysis.bootstrapSamples,
            confidenceLevel: config.analysis.confidenceLevel,
            seed: `${registration.configHash}:${config.design.seed}:${comparison.id}`
          })
        : null
    };
  }
  const primary = registration.comparisons.find((comparison) => comparison.primary === true);
  if (!primary) {
    throw new Error("schema-v2 registration is missing its primary comparison");
  }
  const taskCount = new Set(registration.assignments.map((assignment) => assignment.taskId)).size;
  const armFidelity = Object.fromEntries(registration.arms.map((arm) => [
    arm.id,
    fidelityForArm(outcomes, arm.id, arm.kind)
  ]));
  const efficiencyTelemetry = Object.fromEntries(registration.arms.map((arm) => [
    arm.id,
    summarizeArmEfficiencyTelemetry(outcomes, arm.id)
  ]));
  return {
    schemaVersion: 2,
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
      arms: registration.arms,
      inputs: registration.inputs
    },
    candidateIdentityProof,
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
    estimand: "registered intention-to-treat comparisons between immutable experiment arms on verified completion",
    armDefinitions: {
      arms: registration.arms.map((arm) => ({ id: arm.id, kind: arm.kind })),
      adherencePolicy: "usage and transport telemetry are descriptive only; no run is excluded for adherence or contamination"
    },
    generalizationUnit: "task",
    registeredTasks: taskCount,
    registeredRuns: registration.assignments.length,
    startedRuns: outcomes.filter((outcome) => outcome.started).length,
    finalizedRuns: outcomes.filter((outcome) => outcome.finalized).length,
    observedRuns: outcomes.filter((outcome) => outcome.observed).length,
    neverStartedRuns,
    primaryComparison: primary.id,
    comparisons,
    arms,
    armFidelity,
    efficiencyTelemetry,
    positionalBalance: registration.positionalBalance ?? summarizeRegisteredPositionBalance(registration.assignments, armIds),
    outcomes
  };
}

function readSchemaV2CandidateIdentityProof({ outputDir, registration, attempts }) {
  const expectedServerInfo = {
    name: "codexa",
    version: registration.candidate?.codexaVersion
  };
  const armsById = new Map((registration.arms ?? []).map((arm) => [arm.id, arm]));
  const tasksById = new Map((registration.tasks ?? []).map((task) => [task.id, task]));
  const assignmentsByRunId = new Map(registration.assignments.map((assignment) => [assignment.runId, assignment]));
  const requiredPairs = new Map();
  for (const [runId] of attempts) {
    const assignment = assignmentsByRunId.get(runId);
    const arm = assignment ? armsById.get(assignment.arm) : undefined;
    if (!assignment || arm?.kind !== "codexa") continue;
    requiredPairs.set(preflightPairKey(assignment.taskId, arm.serverCommand), {
      taskId: assignment.taskId,
      serverCommand: arm.serverCommand
    });
  }
  const failuresByPair = new Map();
  const receipts = [...requiredPairs.values()]
    .sort((left, right) => left.taskId.localeCompare(right.taskId) || left.serverCommand.localeCompare(right.serverCommand))
    .map((pair) => {
      const task = tasksById.get(pair.taskId);
      const expected = {
        schemaVersion: 1,
        kind: "schema-v2-mcp-preflight",
        experimentId: registration.experimentId,
        configHash: registration.configHash,
        taskId: pair.taskId,
        taskHash: task?.hash,
        serverCommand: pair.serverCommand,
        expectedServerInfo,
        mcpPreflightHash: registration.harness?.mcpPreflightHash
      };
      const receiptPath = safeOutputPath(
        outputDir,
        path.posix.join("preflight", `${pair.taskId}-${sha256Text(pair.serverCommand).slice(0, 24)}.json`)
      );
      let raw;
      let receipt;
      let failure;
      try {
        if (!task || typeof task.hash !== "string" || task.hash.length === 0) {
          throw new Error("registration is missing the task hash");
        }
        if (typeof pair.serverCommand !== "string" || pair.serverCommand.length === 0) {
          throw new Error("registration is missing the server command");
        }
        if (!validExactServerInfo(expectedServerInfo, expectedServerInfo)) {
          throw new Error("registration is missing the exact candidate server identity");
        }
        if (typeof registration.harness?.mcpPreflightHash !== "string" || registration.harness.mcpPreflightHash.length === 0) {
          throw new Error("registration is missing the MCP preflight helper hash");
        }
        if (!receiptPath) {
          throw new Error("receipt path escapes the experiment output");
        }
        ({ raw, value: receipt } = readBoundedRegularJson(receiptPath, MAX_MCP_PREFLIGHT_RECEIPT_BYTES));
        assertExactKeys(receipt, MCP_PREFLIGHT_RECEIPT_KEYS, `schema-v2 MCP preflight receipt for ${pair.taskId}`);
        const identity = Object.fromEntries(Object.keys(expected).map((key) => [key, receipt[key]]));
        if (JSON.stringify(identity) !== JSON.stringify(expected)) {
          throw new Error("receipt identity differs from the immutable registration");
        }
        if (!validExactServerInfo(receipt.observedServerInfo, expectedServerInfo)) {
          throw new Error(`observed server identity does not match ${expectedServerInfo.name}@${expectedServerInfo.version}`);
        }
        if (typeof receipt.completedAt !== "string" || !Number.isFinite(Date.parse(receipt.completedAt))) {
          throw new Error("receipt completion time is invalid");
        }
      } catch (error) {
        failure = `candidate identity preflight ${error instanceof Error ? error.message : String(error)}`;
        failuresByPair.set(preflightPairKey(pair.taskId, pair.serverCommand), failure);
      }
      return {
        taskId: pair.taskId,
        taskHash: task?.hash ?? null,
        serverCommand: pair.serverCommand,
        expectedServerInfo,
        observedServerInfo: reportServerInfo(receipt?.observedServerInfo),
        status: failure ? "invalid" : "valid",
        receiptHash: raw ? sha256Text(raw) : null,
        completedAt: typeof receipt?.completedAt === "string" ? receipt.completedAt : null,
        failure: failure ?? null
      };
    });
  const invalidReceipts = receipts.filter((receipt) => receipt.status === "invalid").length;
  return {
    report: {
      schemaVersion: 1,
      status: receipts.length === 0 ? "not-required" : invalidReceipts > 0 ? "invalid" : "valid",
      expectedServerInfo,
      requiredReceipts: receipts.length,
      verifiedReceipts: receipts.length - invalidReceipts,
      invalidReceipts,
      receipts
    },
    failuresByPair
  };
}

function applySchemaV2CandidateIdentityProof(outcomes, registration, failuresByPair) {
  const armsById = new Map((registration.arms ?? []).map((arm) => [arm.id, arm]));
  return outcomes.map((outcome) => {
    if (!outcome.started) return outcome;
    const arm = armsById.get(outcome.arm);
    if (arm?.kind !== "codexa") return outcome;
    const failure = failuresByPair.get(preflightPairKey(outcome.taskId, arm.serverCommand));
    if (!failure) return outcome;
    return {
      ...outcome,
      success: null,
      failureClass: null,
      protocolStatus: "invalid",
      protocolFailure: outcome.protocolFailure ? `${outcome.protocolFailure}; ${failure}` : failure
    };
  });
}

function preflightPairKey(taskId, serverCommand) {
  return `${taskId}\0${serverCommand}`;
}

function validExactServerInfo(value, expected) {
  return value
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.keys(value).sort().join("\0") === "name\0version"
    && typeof expected?.name === "string"
    && typeof expected?.version === "string"
    && value.name === expected.name
    && value.version === expected.version;
}

function reportServerInfo(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return {
    name: typeof value.name === "string" ? value.name.slice(0, 120) : null,
    version: typeof value.version === "string" ? value.version.slice(0, 120) : null
  };
}

function readBoundedRegularJson(file, maxBytes) {
  let descriptor;
  try {
    const pathStat = lstatSync(file);
    if (!pathStat.isFile() || pathStat.isSymbolicLink() || pathStat.size > maxBytes) {
      throw new Error("receipt is missing, non-regular, or oversized");
    }
    descriptor = openSync(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.size > maxBytes) {
      throw new Error("receipt is not a bounded regular file");
    }
    const raw = readFileSync(descriptor, "utf8");
    if (Buffer.byteLength(raw, "utf8") !== stat.size) {
      throw new Error("receipt changed while it was read");
    }
    const value = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("receipt is malformed");
    }
    return { raw, value };
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      throw new Error("receipt is missing");
    }
    throw error;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function sha256Text(value) {
  return createHash("sha256").update(value).digest("hex");
}

function summarizeArmEfficiencyTelemetry(outcomes, arm) {
  const selected = outcomes.filter((outcome) => outcome.arm === arm && outcome.started);
  const atifObserved = selected.filter((outcome) => outcome.codexaUsage.transportTelemetry?.status === "observed");
  const serverObserved = selected.filter((outcome) => outcome.codexaUsage.serverTelemetry?.status === "observed");
  const atifStatusCounts = countBy(selected, (outcome) => outcome.codexaUsage.transportTelemetry?.status ?? "unavailable");
  const serverStatusCounts = countBy(selected, (outcome) => outcome.codexaUsage.serverTelemetry?.status ?? "unavailable");
  const atif = {
    eligibleRuns: selected.length,
    observedRuns: atifObserved.length,
    unknownOrPartialRuns: selected.length - atifObserved.length,
    statusCounts: sortRecord(atifStatusCounts),
    correlatedCalls: sumTelemetry(atifObserved, "transportTelemetry", "correlatedCalls"),
    requestArgumentBytes: sumTelemetry(atifObserved, "transportTelemetry", "requestArgumentBytes"),
    modelVisibleResultTextBytes: sumTelemetry(atifObserved, "transportTelemetry", "modelVisibleResultTextBytes"),
    explicitDetailedRequests: sumTelemetry(atifObserved, "transportTelemetry", "explicitDetailedRequests"),
    detailResourceFetches: sumTelemetry(atifObserved, "transportTelemetry", "detailResourceFetches"),
    detailResourceFetchRequestArgumentBytes: sumTelemetry(atifObserved, "transportTelemetry", "detailResourceFetchRequestArgumentBytes"),
    detailResourceFetchResultTextBytes: sumTelemetry(atifObserved, "transportTelemetry", "detailResourceFetchResultTextBytes"),
    automaticEscalations: sumTelemetry(atifObserved, "transportTelemetry", "automaticEscalations"),
    unchangedReceipts: sumTelemetry(atifObserved, "transportTelemetry", "unchangedReceipts"),
    requestedFormats: mergeNestedCounts(atifObserved.map((outcome) => outcome.codexaUsage.transportTelemetry.requestedFormats)),
    effectiveFormats: mergeNestedCounts(atifObserved.map((outcome) => outcome.codexaUsage.transportTelemetry.effectiveFormats))
  };
  const server = {
    eligibleRuns: selected.length,
    observedRuns: serverObserved.length,
    unknownOrPartialRuns: selected.length - serverObserved.length,
    statusCounts: sortRecord(serverStatusCounts),
    events: sumTelemetry(serverObserved, "serverTelemetry", "events"),
    toolCallEvents: sumTelemetry(serverObserved, "serverTelemetry", "toolCallEvents"),
    detailResourceFetches: sumTelemetry(serverObserved, "serverTelemetry", "detailResourceFetches"),
    requestBytes: sumTelemetry(serverObserved, "serverTelemetry", "requestBytes"),
    textBytes: sumTelemetry(serverObserved, "serverTelemetry", "textBytes"),
    structuredBytes: sumTelemetry(serverObserved, "serverTelemetry", "structuredBytes"),
    totalBytes: sumTelemetry(serverObserved, "serverTelemetry", "totalBytes"),
    elapsedMs: sumTelemetry(serverObserved, "serverTelemetry", "elapsedMs"),
    detailResourceFetchRequestBytes: sumTelemetry(serverObserved, "serverTelemetry", "detailResourceFetchRequestBytes"),
    detailResourceFetchTextBytes: sumTelemetry(serverObserved, "serverTelemetry", "detailResourceFetchTextBytes"),
    detailResourceFetchTotalBytes: sumTelemetry(serverObserved, "serverTelemetry", "detailResourceFetchTotalBytes"),
    detailResourceFetchElapsedMs: sumTelemetry(serverObserved, "serverTelemetry", "detailResourceFetchElapsedMs"),
    escalationEvents: sumTelemetry(serverObserved, "serverTelemetry", "escalationEvents"),
    unchangedReceipts: sumTelemetry(serverObserved, "serverTelemetry", "unchangedReceipts"),
    requestedFormats: mergeNestedCounts(serverObserved.map((outcome) => outcome.codexaUsage.serverTelemetry.requestedFormats)),
    effectiveFormats: mergeNestedCounts(serverObserved.map((outcome) => outcome.codexaUsage.serverTelemetry.effectiveFormats))
  };
  return {
    schemaVersion: 1,
    evidenceRole: "descriptive-only",
    atif,
    server,
    note: "missing, partial, or malformed telemetry is not imputed and never changes ITT inclusion, protocol validity, or verifier outcomes"
  };
}

function sumTelemetry(outcomes, container, field) {
  const values = outcomes
    .map((outcome) => outcome.codexaUsage[container]?.[field])
    .filter((value) => Number.isFinite(value));
  return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0);
}

function mergeNestedCounts(records) {
  const merged = {};
  for (const record of records) {
    if (!record || typeof record !== "object" || Array.isArray(record)) {
      continue;
    }
    for (const [key, value] of Object.entries(record)) {
      if (Number.isInteger(value) && value >= 0) {
        merged[key] = (merged[key] ?? 0) + value;
      }
    }
  }
  return sortRecord(merged);
}

function pairComparisonOutcomes(outcomes, baselineArm, candidateArm) {
  const grouped = new Map();
  for (const outcome of outcomes) {
    if (outcome.arm !== baselineArm && outcome.arm !== candidateArm) {
      continue;
    }
    const key = `${outcome.taskId}\0${outcome.repetition}`;
    const current = grouped.get(key) ?? { taskId: outcome.taskId, repetition: outcome.repetition };
    const slot = outcome.arm === baselineArm ? "baseline" : "candidate";
    if (current[slot]) {
      throw new Error(`duplicate ${outcome.arm} outcome for ${outcome.taskId} repetition ${outcome.repetition}`);
    }
    current[slot] = outcome;
    grouped.set(key, current);
  }
  return [...grouped.values()]
    .filter((pair) => pair.baseline && pair.candidate)
    .sort((left, right) => left.taskId.localeCompare(right.taskId) || left.repetition - right.repetition);
}

function observedTelemetryValue(container, field) {
  return (outcome) => outcome.codexaUsage?.[container]?.status === "observed"
    ? outcome.codexaUsage[container][field]
    : null;
}

function summarizePairedOverhead(pairs) {
  const bothCompletedSuccessfully = pairs.filter((pair) =>
    pair.baseline.finalized
    && pair.candidate.finalized
    && pair.baseline.protocolStatus === "valid"
    && pair.candidate.protocolStatus === "valid"
    && pair.baseline.success === true
    && pair.candidate.success === true
  );
  return {
    schemaVersion: 1,
    evidenceRole: "paired-descriptive-only",
    direction: "candidate-minus-baseline",
    views: {
      allStarted: summarizePairedOverheadView(pairs),
      bothCompletedSuccessfully: {
        ...summarizePairedOverheadView(bothCompletedSuccessfully),
        conditioningNote: "conditioned on both paired runs completing successfully; this selected view can differ systematically from all-started"
      }
    },
    note: "only pairs with both values present contribute to a metric; missing values are not imputed, and ratios are omitted when the paired baseline mean is not positive"
  };
}

function summarizePairedOverheadView(pairs) {
  return {
    eligiblePairs: pairs.length,
    metrics: Object.fromEntries(PAIRED_OVERHEAD_METRICS.map(([name, read]) => [
      name,
      summarizePairedMetric(pairs, read)
    ]))
  };
}

function summarizePairedMetric(pairs, read) {
  const present = [];
  for (const pair of pairs) {
    const baseline = read(pair.baseline);
    const candidate = read(pair.candidate);
    if (!Number.isFinite(baseline) || !Number.isFinite(candidate)) {
      continue;
    }
    present.push({ baseline: Number(baseline), candidate: Number(candidate) });
  }
  const deltas = present.map((pair) => pair.candidate - pair.baseline).sort((left, right) => left - right);
  const baselineMean = mean(present.map((pair) => pair.baseline));
  const candidateMean = mean(present.map((pair) => pair.candidate));
  return {
    eligiblePairs: pairs.length,
    pairedPresent: present.length,
    pairedMissing: pairs.length - present.length,
    baselineMean,
    candidateMean,
    meanDelta: mean(deltas),
    medianDelta: quantile(deltas, 0.5),
    candidateToBaselineMeanRatio: baselineMean !== null && baselineMean > 0
      ? candidateMean / baselineMean
      : null
  };
}

function mean(values) {
  return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function summarizeComparisonEffect({ baseline, candidate, pairs, samples, confidenceLevel, seed }) {
  const discordance = { candidateOnly: 0, baselineOnly: 0, bothPass: 0, bothFail: 0 };
  for (const pair of pairs) {
    if (pair.candidate.success && pair.baseline.success) {
      discordance.bothPass += 1;
    } else if (pair.candidate.success) {
      discordance.candidateOnly += 1;
    } else if (pair.baseline.success) {
      discordance.baselineOnly += 1;
    } else {
      discordance.bothFail += 1;
    }
  }
  return {
    absoluteRiskDifference: candidate.successRate - baseline.successRate,
    candidateOnlyPairs: discordance.candidateOnly,
    baselineOnlyPairs: discordance.baselineOnly,
    bothPassPairs: discordance.bothPass,
    bothFailPairs: discordance.bothFail,
    taskClusteredBootstrap: taskClusteredComparisonBootstrap({ pairs, samples, confidenceLevel, seed })
  };
}

function taskClusteredComparisonBootstrap({ pairs, samples, confidenceLevel, seed }) {
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
    let candidateSuccesses = 0;
    let baselineSuccesses = 0;
    let runs = 0;
    for (let index = 0; index < tasks.length; index += 1) {
      const task = tasks[Math.floor(random() * tasks.length)];
      for (const pair of byTask.get(task)) {
        candidateSuccesses += Number(pair.candidate.success);
        baselineSuccesses += Number(pair.baseline.success);
        runs += 1;
      }
    }
    deltas.push(runs === 0 ? 0 : (candidateSuccesses - baselineSuccesses) / runs);
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

function summarizeRegisteredPositionBalance(assignments, armIds) {
  const positions = Object.fromEntries(armIds.map((arm) => [
    arm,
    Object.fromEntries(armIds.map((_, index) => [String(index + 1), 0]))
  ]));
  for (const assignment of assignments) {
    if (positions[assignment.arm]) {
      positions[assignment.arm][String(assignment.order)] += 1;
    }
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
  const includeEfficiencyTelemetry = registration.schemaVersion === 2;
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
    codexaUsage: unavailableCodexaUsage("unavailable", undefined, includeEfficiencyTelemetry)
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
  const codexaUsage = inferCodexaUsage(path.dirname(trialPath), includeEfficiencyTelemetry);
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
  const registeredArm = registration.schemaVersion === 1
    ? { id: assignment.arm, kind: assignment.arm === "control" ? "control" : "codexa", serverCommand: "/opt/codexa-agent-ab/start-codexa-mcp" }
    : registration.arms?.find((arm) => arm?.id === assignment.arm);
  if (!registeredArm) {
    return `trial references unregistered arm ${assignment.arm}`;
  }
  if (registeredArm.kind === "control") {
    return servers.length === 0 && instructions.length === 0
      ? null
      : "control trial received Codexa MCP or extra instructions";
  }
  if (registeredArm.kind !== "codexa") {
    return `registered arm ${assignment.arm} has an unsupported kind`;
  }
  const server = servers[0];
  const armInput = registration.schemaVersion === 1
    ? registration.inputs?.treatment
    : registration.inputs?.arms?.find((arm) => arm?.id === assignment.arm);
  const expectedInstruction = safeOutputPath(outputDir, armInput?.extraInstruction);
  const instruction = instructions[0];
  const serverMatches = servers.length === 1
    && server
    && typeof server === "object"
    && !Array.isArray(server)
    && server.name === "codexa"
    && server.transport === "stdio"
    && server.command === registeredArm.serverCommand
    && Array.isArray(server.args)
    && server.args.length === 0
    && (server.url === null || server.url === undefined);
  const instructionMatches = instructions.length === 1
    && typeof instruction === "string"
    && expectedInstruction !== null
    && instruction === expectedInstruction;
  if (!serverMatches || !instructionMatches) {
    return `arm ${assignment.arm} did not receive exactly its registered Codexa MCP and workflow-instruction bundle`;
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

function fidelityForArm(outcomes, arm, kind = arm === "control" ? "control" : "codexa") {
  const selected = outcomes.filter((outcome) => outcome.arm === arm && outcome.started);
  const observed = selected.filter((outcome) => outcome.codexaUsage.status === "observed");
  const invoked = observed.filter((outcome) => outcome.codexaUsage.codexaInvoked);
  const setupObserved = selected.filter((outcome) => outcome.codexaSetup.status === "observed");
  const postEditFinalStates = selected.map(
    (outcome) => outcome.codexaUsage.postEditDecisionTrace?.finalState ?? "unknown"
  );
  const postEditFinalStateCounts = Object.fromEntries(
    POST_EDIT_FINAL_STATES.map((state) => [state, postEditFinalStates.filter((entry) => entry === state).length])
  );
  return {
    startedRuns: selected.length,
    traceObservedRuns: observed.length,
    traceUnknownRuns: selected.length - observed.length,
    codexaInvokedRuns: invoked.length,
    codexaCallsByTool: mergeCallCounts(observed.map((outcome) => outcome.codexaUsage.callsByTool)),
    noCodexaInvocationObservedRuns: observed.length - invoked.length,
    contaminationRuns: kind === "control" ? invoked.length : 0,
    nonadherentRuns: kind === "codexa" ? observed.length - invoked.length : 0,
    setupObservedRuns: setupObserved.length,
    setupSuccessfulRuns: setupObserved.filter((outcome) => outcome.codexaSetup.indexExitCode === 0).length,
    setupFailedRuns: setupObserved.filter((outcome) => Number.isInteger(outcome.codexaSetup.indexExitCode) && outcome.codexaSetup.indexExitCode !== 0).length,
    setupVersionMismatchRuns: setupObserved.filter((outcome) => outcome.codexaSetup.versionMatchesCandidate === false).length,
    postEditReviewObservedRuns: selected.filter(
      (outcome) => (outcome.codexaUsage.postEditDecisionTrace?.reviewCallCount ?? 0) > 0
    ).length,
    postEditFinalStateCounts,
    note: "agent-reported trajectory and setup telemetry are descriptive and never change ITT inclusion"
  };
}

function inferCodexaUsage(trialDir, includeEfficiencyTelemetry = false) {
  const serverTelemetry = includeEfficiencyTelemetry ? readServerTelemetry(trialDir) : undefined;
  const matches = findFiles(trialDir, "trajectory.json", 6);
  if (matches.length === 0) {
    return unavailableCodexaUsage("missing", serverTelemetry, includeEfficiencyTelemetry);
  }
  if (matches.length !== 1) {
    return unavailableCodexaUsage("ambiguous", serverTelemetry, includeEfficiencyTelemetry);
  }
  try {
    if (statSync(matches[0]).size > 32 * 1024 * 1024) {
      return unavailableCodexaUsage("too-large", serverTelemetry, includeEfficiencyTelemetry);
    }
    const trajectory = readJson(matches[0], "Harbor trajectory");
    if (!trajectory || typeof trajectory !== "object" || trajectory.schema_version !== "ATIF-v1.7" || !Array.isArray(trajectory.steps)) {
      return unavailableCodexaUsage("unsupported", serverTelemetry, includeEfficiencyTelemetry);
    }
    const currentSteps = trajectory.steps.filter(
      (step) => !step || typeof step !== "object" || Array.isArray(step) || step.is_copied_context !== true
    );
    const scan = scanStructuredToolCalls(currentSteps);
    if (!scan.complete) {
      return unavailableCodexaUsage("scan-limit", serverTelemetry, includeEfficiencyTelemetry);
    }
    const partial = hasUnsupportedTrajectoryLineage(trajectory) || hasMalformedUsageStructure(trajectory);
    const usage = {
      status: partial ? "partial" : "observed",
      codexaInvoked: partial ? null : scan.codexaCalls > 0,
      codexaCallCount: partial ? null : scan.codexaCalls,
      callsByTool: partial ? null : scan.callsByTool,
      postEditDecisionTrace: inferPostEditDecisionTrace(trajectory)
    };
    if (!includeEfficiencyTelemetry) {
      return usage;
    }
    const transportTelemetry = inferAtifTransportTelemetry(trajectory);
    const reconciledTelemetry = reconcileDetailFetchTelemetry(transportTelemetry, serverTelemetry);
    return {
      ...usage,
      transportTelemetry: reconciledTelemetry.transportTelemetry,
      serverTelemetry: reconciledTelemetry.serverTelemetry
    };
  } catch {
    return unavailableCodexaUsage("malformed", serverTelemetry, includeEfficiencyTelemetry);
  }
}

function reconcileDetailFetchTelemetry(transportTelemetry, serverTelemetry) {
  if (
    transportTelemetry.status === "observed"
    && serverTelemetry.status === "observed"
    && (
      transportTelemetry.correlatedCalls !== serverTelemetry.events
      || transportTelemetry.detailResourceFetches !== serverTelemetry.detailResourceFetches
      || transportTelemetry.detailResourceFetchRequestArgumentBytes !== serverTelemetry.detailResourceFetchRequestBytes
      || transportTelemetry.detailResourceFetchResultTextBytes !== serverTelemetry.detailResourceFetchTextBytes
    )
  ) {
    return {
      transportTelemetry: unavailableTransportTelemetry("partial"),
      serverTelemetry: unavailableServerTelemetry("partial")
    };
  }
  return { transportTelemetry, serverTelemetry };
}

function unavailableCodexaUsage(status, serverTelemetry, includeEfficiencyTelemetry = false) {
  const usage = {
    status,
    codexaInvoked: null,
    codexaCallCount: null,
    callsByTool: null,
    postEditDecisionTrace: null
  };
  return includeEfficiencyTelemetry
    ? {
        ...usage,
        transportTelemetry: unavailableTransportTelemetry(status),
        serverTelemetry: serverTelemetry ?? unavailableServerTelemetry("unavailable")
      }
    : usage;
}

function inferAtifTransportTelemetry(trajectory) {
  const base = {
    schemaVersion: 1,
    evidenceTrust: "agent-reported-ATIF-v1.7",
    unit: "UTF-8 bytes of raw string-valued or JSON-serialized object-valued ATIF arguments and model-visible observation text, including exact Codexa detailed-result resource reads"
  };
  if (
    hasUnsupportedTrajectoryLineage(trajectory)
    || hasMalformedUsageStructure(trajectory)
    || trajectory.steps.some((step) => step?.is_copied_context === true)
  ) {
    return unavailableTransportTelemetry("partial", base);
  }
  const callIdCounts = new Map();
  const resultIdCounts = new Map();
  const relevantCalls = [];
  for (let stepIndex = 0; stepIndex < trajectory.steps.length; stepIndex += 1) {
    const step = trajectory.steps[stepIndex];
    const toolCalls = Array.isArray(step.tool_calls) ? step.tool_calls : [];
    const results = Array.isArray(step.observation?.results) ? step.observation.results : [];
    for (const result of results) {
      if (typeof result?.source_call_id === "string" && result.source_call_id.length > 0) {
        resultIdCounts.set(result.source_call_id, (resultIdCounts.get(result.source_call_id) ?? 0) + 1);
      }
    }
    for (const call of toolCalls) {
      if (typeof call?.tool_call_id === "string" && call.tool_call_id.length > 0) {
        callIdCounts.set(call.tool_call_id, (callIdCounts.get(call.tool_call_id) ?? 0) + 1);
      }
      const match = typeof call?.function_name === "string"
        ? /^mcp__codexa__([a-z0-9_]+)$/iu.exec(call.function_name)
        : null;
      if (match) {
        relevantCalls.push({ call, results, kind: "codexa-tool", tool: match[1].toLowerCase() });
      } else if (isExactDetailResourceRead(call)) {
        relevantCalls.push({ call, results, kind: "detail-resource-read", tool: "read_mcp_resource" });
      }
    }
  }
  if (relevantCalls.length > MAX_TRANSPORT_CALLS) {
    return unavailableTransportTelemetry("scan-limit", base);
  }
  const aggregate = {
    ...base,
    status: "observed",
    correlatedCalls: 0,
    requestArgumentBytes: 0,
    modelVisibleResultTextBytes: 0,
    requestedFormats: {},
    effectiveFormats: {},
    explicitDetailedRequests: 0,
    detailResourceFetches: 0,
    detailResourceFetchRequestArgumentBytes: 0,
    detailResourceFetchResultTextBytes: 0,
    automaticEscalations: 0,
    unchangedReceipts: 0,
    callsByTool: {}
  };
  let cumulativeBytes = 0;
  for (const { call, results, kind, tool } of relevantCalls) {
    if (
      callIdCounts.get(call.tool_call_id) !== 1
      || resultIdCounts.get(call.tool_call_id) !== 1
    ) {
      return unavailableTransportTelemetry("partial", base);
    }
    const matching = results.filter((result) => result?.source_call_id === call.tool_call_id);
    if (matching.length !== 1) {
      return unavailableTransportTelemetry("partial", base);
    }
    const strings = observationContentStrings(matching[0].content);
    if (!strings) {
      return unavailableTransportTelemetry("partial", base);
    }
    const serializedArguments = typeof call.arguments === "string"
      ? call.arguments
      : JSON.stringify(call.arguments);
    if (typeof serializedArguments !== "string") {
      return unavailableTransportTelemetry("partial", base);
    }
    const requestBytes = Buffer.byteLength(serializedArguments, "utf8");
    const resultTextBytes = strings.reduce((sum, text) => sum + Buffer.byteLength(text, "utf8"), 0);
    cumulativeBytes += requestBytes + resultTextBytes;
    if (cumulativeBytes > MAX_TRANSPORT_BYTES) {
      return unavailableTransportTelemetry("scan-limit", base);
    }
    const parsedArguments = typeof call.arguments === "string"
      ? parseStringifiedToolArguments(call.arguments)
      : call.arguments;
    const requested = requestedResponseFormat(parsedArguments);
    if (requested.status === "conflict") {
      return unavailableTransportTelemetry("partial", base);
    }
    const requestedFormat = requested.value;
    const delivery = kind === "codexa-tool"
      ? extractUniqueDeliveryMetadata(strings)
      : { status: "missing", value: null };
    if (delivery.status === "ambiguous") {
      return unavailableTransportTelemetry("partial", base);
    }
    const effectiveFormat = delivery.value?.effectiveFormat ?? "unknown";
    aggregate.correlatedCalls += 1;
    aggregate.requestArgumentBytes += requestBytes;
    aggregate.modelVisibleResultTextBytes += resultTextBytes;
    if (kind === "detail-resource-read") {
      aggregate.detailResourceFetches += 1;
      aggregate.detailResourceFetchRequestArgumentBytes += requestBytes;
      aggregate.detailResourceFetchResultTextBytes += resultTextBytes;
    } else {
      incrementCount(aggregate.requestedFormats, requestedFormat);
      incrementCount(aggregate.effectiveFormats, effectiveFormat);
      if (requestedFormat === "detailed") {
        aggregate.explicitDetailedRequests += 1;
      }
      if (typeof delivery.value?.escalationReason === "string" && delivery.value.escalationReason.length > 0) {
        aggregate.automaticEscalations += 1;
      }
      if (delivery.value?.unchangedReceipt === true) {
        aggregate.unchangedReceipts += 1;
      }
    }
    const byTool = aggregate.callsByTool[tool] ?? {
      calls: 0,
      requestArgumentBytes: 0,
      modelVisibleResultTextBytes: 0
    };
    byTool.calls += 1;
    byTool.requestArgumentBytes += requestBytes;
    byTool.modelVisibleResultTextBytes += resultTextBytes;
    aggregate.callsByTool[tool] = byTool;
  }
  aggregate.requestedFormats = sortRecord(aggregate.requestedFormats);
  aggregate.effectiveFormats = sortRecord(aggregate.effectiveFormats);
  aggregate.callsByTool = sortRecord(aggregate.callsByTool);
  return aggregate;
}

function isExactDetailResourceRead(call) {
  if (call?.function_name !== "read_mcp_resource") {
    return false;
  }
  const parsed = typeof call.arguments === "string"
    ? parseStringifiedToolArguments(call.arguments)
    : call.arguments;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return false;
  }
  const keys = Object.keys(parsed).sort();
  return JSON.stringify(keys) === JSON.stringify(["server", "uri"])
    && parsed.server === "codexa"
    && typeof parsed.uri === "string"
    && isExactMcpResultUri(parsed.uri);
}

function requestedResponseFormat(parsedArguments) {
  const formats = new Set(["auto", "concise", "detailed"]);
  const outer = formats.has(parsedArguments?.responseFormat) ? parsedArguments.responseFormat : null;
  const innerArguments = parsedArguments?.arguments;
  const inner = innerArguments && typeof innerArguments === "object" && !Array.isArray(innerArguments) && formats.has(innerArguments.responseFormat)
    ? innerArguments.responseFormat
    : null;
  return outer && inner && outer !== inner
    ? { status: "conflict", value: null }
    : { status: "ok", value: outer ?? inner ?? "unspecified" };
}

function isExactMcpResultUri(uri) {
  return /^codexa:\/\/repo\/mcp-results\/rr_[a-f0-9]{32}\/mr_[a-f0-9]{64}$/u.test(uri);
}

function unavailableTransportTelemetry(status, base = {}) {
  return {
    schemaVersion: 1,
    evidenceTrust: "agent-reported-ATIF-v1.7",
    unit: "UTF-8 bytes of raw string-valued or JSON-serialized object-valued ATIF arguments and model-visible observation text, including exact Codexa detailed-result resource reads",
    ...base,
    status,
    correlatedCalls: null,
    requestArgumentBytes: null,
    modelVisibleResultTextBytes: null,
    requestedFormats: null,
    effectiveFormats: null,
    explicitDetailedRequests: null,
    detailResourceFetches: null,
    detailResourceFetchRequestArgumentBytes: null,
    detailResourceFetchResultTextBytes: null,
    automaticEscalations: null,
    unchangedReceipts: null,
    callsByTool: null
  };
}

function extractUniqueDeliveryMetadata(strings) {
  const candidates = new Map();
  let parsedCount = 0;
  for (const text of strings) {
    const values = [];
    try {
      values.push(JSON.parse(text));
    } catch {
      const embedded = extractEmbeddedJsonObjects(text);
      if (!embedded.complete) {
        return { status: "ambiguous", value: null };
      }
      values.push(...embedded.values);
    }
    for (const value of values) {
      parsedCount += 1;
      if (parsedCount > MAX_POST_EDIT_JSON_CANDIDATES) {
        return { status: "ambiguous", value: null };
      }
      for (const delivery of deliveryMetadataFromEnvelope(value)) {
        candidates.set(JSON.stringify(delivery), delivery);
      }
    }
  }
  return candidates.size > 1
    ? { status: "ambiguous", value: null }
    : { status: candidates.size === 1 ? "observed" : "missing", value: [...candidates.values()][0] ?? null };
}

function deliveryMetadataFromEnvelope(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return [];
  }
  const envelope = value.structuredContent && typeof value.structuredContent === "object" && !Array.isArray(value.structuredContent)
    ? value.structuredContent
    : value;
  const data = envelope.data && typeof envelope.data === "object" && !Array.isArray(envelope.data)
    ? envelope.data
    : null;
  const decisionKernel = data?.decisionKernel && typeof data.decisionKernel === "object" && !Array.isArray(data.decisionKernel)
    ? data.decisionKernel
    : null;
  return [envelope.delivery, data?.delivery, decisionKernel?.delivery]
    .map((delivery) => normalizeDeliveryMetadata(delivery, envelope.schemaVersion))
    .filter(Boolean);
}

function normalizeDeliveryMetadata(delivery, envelopeSchemaVersion) {
  const schemaVersion = delivery?.schemaVersion ?? envelopeSchemaVersion;
  if (!delivery || typeof delivery !== "object" || Array.isArray(delivery) || schemaVersion !== 1) {
    return null;
  }
  const requestedFormat = ["auto", "concise", "detailed"].includes(delivery.requestedFormat) ? delivery.requestedFormat : null;
  const effectiveFormat = ["concise", "detailed"].includes(delivery.effectiveFormat) ? delivery.effectiveFormat : null;
  if (!requestedFormat || !effectiveFormat) {
    return null;
  }
  if (delivery.escalationReason !== undefined && (typeof delivery.escalationReason !== "string" || delivery.escalationReason.length > 200)) {
    return null;
  }
  return {
    requestedFormat,
    effectiveFormat,
    escalationReason: delivery.escalationReason ?? null,
    unchangedReceipt: typeof delivery.unchangedReceipt === "boolean"
      ? delivery.unchangedReceipt
      : delivery.unchanged === true
  };
}

function hasMalformedUsageStructure(trajectory) {
  return trajectory.steps.some((step) => {
    if (!step || typeof step !== "object" || Array.isArray(step)) {
      return true;
    }
    if (
      step.tool_calls !== undefined
      && (!Array.isArray(step.tool_calls) || step.tool_calls.some(isMalformedToolCall))
    ) {
      return true;
    }
    return step.observation !== undefined && (
      !step.observation
      || typeof step.observation !== "object"
      || Array.isArray(step.observation)
      || !Array.isArray(step.observation.results)
      || step.observation.results.some((result) => !result || typeof result !== "object" || Array.isArray(result))
    );
  });
}

function isMalformedToolCall(call) {
  if (!call || typeof call !== "object" || Array.isArray(call)) {
    return true;
  }
  const argumentsValue = call.arguments;
  const hasUsableArguments = typeof argumentsValue === "string" || (
    argumentsValue
    && typeof argumentsValue === "object"
    && !Array.isArray(argumentsValue)
  );
  return typeof call.tool_call_id !== "string"
    || call.tool_call_id.length === 0
    || typeof call.function_name !== "string"
    || call.function_name.length === 0
    || !hasUsableArguments;
}

function hasUnsupportedTrajectoryLineage(trajectory) {
  if (trajectory.continued_trajectory_ref !== undefined && trajectory.continued_trajectory_ref !== null) {
    return true;
  }
  if (
    trajectory.subagent_trajectories !== undefined
    && (!Array.isArray(trajectory.subagent_trajectories) || trajectory.subagent_trajectories.length > 0)
  ) {
    return true;
  }
  return trajectory.steps.some((step) => {
    const results = Array.isArray(step?.observation?.results) ? step.observation.results : [];
    return results.some(
      (result) =>
        result
        && typeof result === "object"
        && !Array.isArray(result)
        && Object.hasOwn(result, "subagent_trajectory_ref")
        && (!Array.isArray(result.subagent_trajectory_ref) || result.subagent_trajectory_ref.length > 0)
    );
  });
}

function inferPostEditDecisionTrace(trajectory) {
  const steps = trajectory.steps;
  const base = {
    schemaVersion: 1,
    evidenceTrust: "agent-reported-structured-trajectory"
  };
  const callIdCounts = new Map();
  const reviewCalls = [];
  let copiedReviewObserved = false;
  const malformed = hasMalformedUsageStructure(trajectory);
  let reviewCallCount = 0;

  for (let stepIndex = 0; stepIndex < steps.length; stepIndex += 1) {
    const step = steps[stepIndex];
    if (!step || typeof step !== "object" || Array.isArray(step)) {
      continue;
    }
    const toolCalls = Array.isArray(step.tool_calls) ? step.tool_calls : [];
    if (step.is_copied_context === true) {
      copiedReviewObserved ||= toolCalls.some((call) => postEditReviewOccurrenceCount(call) > 0);
      continue;
    }
    const results = Array.isArray(step.observation?.results) ? step.observation.results : [];
    for (const call of toolCalls) {
      if (!call || typeof call !== "object" || Array.isArray(call)) {
        continue;
      }
      const toolCallId = typeof call.tool_call_id === "string" && call.tool_call_id.length > 0
        ? call.tool_call_id
        : null;
      if (toolCallId) {
        callIdCounts.set(toolCallId, (callIdCounts.get(toolCallId) ?? 0) + 1);
      }
      const occurrences = postEditReviewOccurrenceCount(call);
      if (occurrences === 0) {
        continue;
      }
      reviewCallCount += occurrences;
      reviewCalls.push({
        stepIndex,
        toolCallId,
        occurrences,
        matchingResults: toolCallId
          ? results.filter((result) => result?.source_call_id === toolCallId)
          : []
      });
    }
  }

  const lineageUnsupported = hasUnsupportedTrajectoryLineage(trajectory);
  if (reviewCallCount > MAX_POST_EDIT_REVIEW_CALLS || copiedReviewObserved || malformed || lineageUnsupported) {
    return unknownPostEditDecisionTrace(base, reviewCallCount, []);
  }
  if (reviewCallCount === 0) {
    return {
      ...base,
      status: "not-invoked",
      reviewCallCount: 0,
      decisions: [],
      finalState: "not-reviewed"
    };
  }

  const callsByStep = new Map();
  for (const call of reviewCalls) {
    const existing = callsByStep.get(call.stepIndex) ?? [];
    existing.push(call);
    callsByStep.set(call.stepIndex, existing);
  }

  const decisions = [];
  let unknownReviewCount = 0;
  for (const call of reviewCalls) {
    if (call.occurrences !== 1 || (callsByStep.get(call.stepIndex)?.length ?? 0) !== 1) {
      unknownReviewCount += call.occurrences;
      continue;
    }
    if (!call.toolCallId || callIdCounts.get(call.toolCallId) !== 1) {
      unknownReviewCount += 1;
      continue;
    }
    if (call.matchingResults.length !== 1) {
      unknownReviewCount += 1;
      continue;
    }
    const decision = extractPostEditDecision(call.matchingResults[0]?.content);
    if (!decision) {
      unknownReviewCount += 1;
      continue;
    }
    decisions.push({
      stepIndex: call.stepIndex,
      ...decision
    });
  }

  if (unknownReviewCount > 0 || decisions.length !== reviewCallCount) {
    return unknownPostEditDecisionTrace(base, reviewCallCount, decisions);
  }
  return {
    ...base,
    status: "observed",
    reviewCallCount,
    decisions,
    finalState: classifyPostEditFinalState(decisions)
  };
}

function unknownPostEditDecisionTrace(base, reviewCallCount, decisions) {
  return {
    ...base,
    status: "unknown",
    reviewCallCount,
    decisions,
    finalState: "unknown"
  };
}

function postEditReviewOccurrenceCount(call) {
  return identifyCodexaCalls(call).filter(
    (name) => name === "post_edit_review" || name === "cli:post-edit-review" || name === "cli:post-edit"
  ).length;
}

function classifyPostEditFinalState(decisions) {
  const finalDecision = decisions.at(-1);
  if (!finalDecision) {
    return "unknown";
  }
  if (BLOCKING_COMPLETION_AUTHORITIES.has(finalDecision.completionAuthority)) {
    return "blocking-unresolved";
  }
  if (decisions.slice(0, -1).some((decision) => BLOCKING_COMPLETION_AUTHORITIES.has(decision.completionAuthority))) {
    return "nonblocking-after-blocking";
  }
  return finalDecision.completionAuthority === "advisory_inspect" ? "advisory" : "complete";
}

function extractPostEditDecision(content) {
  const strings = observationContentStrings(content);
  if (!strings) {
    return null;
  }
  const candidates = new Map();
  let totalCharacters = 0;
  let parsedCandidateCount = 0;

  for (const text of strings) {
    totalCharacters += text.length;
    if (totalCharacters > MAX_POST_EDIT_OBSERVATION_CHARACTERS) {
      return null;
    }

    const parsedValues = [];
    let parsedWholeValue = false;
    try {
      parsedValues.push(JSON.parse(text));
      parsedWholeValue = true;
    } catch {
      // The Harbor Codex adapter may wrap serialized tool output in a
      // Python-repr carrier. Bounded JSON-object extraction below handles
      // only the embedded JSON and never evaluates the wrapper.
    }
    if (!parsedWholeValue) {
      const embedded = extractEmbeddedJsonObjects(text);
      if (!embedded.complete) {
        return null;
      }
      parsedValues.push(...embedded.values);
    }
    for (const value of parsedValues) {
      parsedCandidateCount += 1;
      if (parsedCandidateCount > MAX_POST_EDIT_JSON_CANDIDATES) {
        return null;
      }
      const decision = postEditDecisionFromEnvelope(value);
      if (decision) {
        candidates.set(postEditDecisionKey(decision), decision);
      }
    }
  }

  return candidates.size === 1 ? [...candidates.values()][0] : null;
}

function observationContentStrings(content) {
  if (typeof content === "string") {
    return [content];
  }
  if (!Array.isArray(content)) {
    return null;
  }
  const strings = [];
  for (const part of content) {
    if (!part || typeof part !== "object" || Array.isArray(part)) {
      return null;
    }
    if (part.type === "text" && typeof part.text === "string") {
      strings.push(part.text);
      continue;
    }
    if (
      part.type === "resource_link"
      && typeof part.uri === "string"
      && part.uri.length <= 6_000
      && (part.name === undefined || (typeof part.name === "string" && part.name.length <= 500))
      && (part.description === undefined || (typeof part.description === "string" && part.description.length <= 2_000))
      && (part.mimeType === undefined || (typeof part.mimeType === "string" && part.mimeType.length <= 200))
    ) {
      continue;
    }
    return null;
  }
  return strings;
}

function extractEmbeddedJsonObjects(text) {
  const values = [];
  let starts = 0;
  for (let start = 0; start < text.length; start += 1) {
    if (text[start] !== "{") {
      continue;
    }
    starts += 1;
    if (starts > MAX_POST_EDIT_JSON_CANDIDATES) {
      return { complete: false, values: [] };
    }
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < text.length; index += 1) {
      const character = text[index];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (character === "\\") {
          escaped = true;
        } else if (character === "\"") {
          inString = false;
        }
        continue;
      }
      if (character === "\"") {
        inString = true;
      } else if (character === "{") {
        depth += 1;
      } else if (character === "}") {
        depth -= 1;
        if (depth === 0) {
          try {
            values.push(JSON.parse(text.slice(start, index + 1)));
            start = index;
          } catch {
            // Not a JSON object; continue looking for a later bounded
            // candidate rather than interpreting arbitrary wrapper syntax.
          }
          break;
        }
      }
    }
  }
  return { complete: true, values };
}

function postEditDecisionFromEnvelope(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const envelope = value.structuredContent && typeof value.structuredContent === "object" && !Array.isArray(value.structuredContent)
    ? value.structuredContent
    : value;
  if (
    envelope.schemaVersion !== 1
    || envelope.mode !== "post_edit_review"
    || !envelope.data
    || typeof envelope.data !== "object"
    || Array.isArray(envelope.data)
    || envelope.data.mode !== "post_edit_review"
  ) {
    return null;
  }
  return normalizePostEditDecision(
    envelope.data.verdict,
    envelope.data.inspectMode,
    envelope.data.completionAuthority
  );
}

function normalizePostEditDecision(verdict, inspectMode, completionAuthority) {
  const expected = {
    continue: ["none", "complete"],
    run_tests: ["none", "tests_required"],
    inspect: inspectMode === "advisory"
      ? ["advisory", "advisory_inspect"]
      : inspectMode === "blocking"
        ? ["blocking", "blocking_inspect"]
        : null,
    replan: ["none", "replan_required"]
  }[verdict];
  if (!expected || inspectMode !== expected[0] || completionAuthority !== expected[1]) {
    return null;
  }
  return { verdict, inspectMode, completionAuthority };
}

function postEditDecisionKey(decision) {
  return [decision.verdict, decision.inspectMode, decision.completionAuthority].join("\u0000");
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
    "- Control post-edit state (not-reviewed/complete/advisory/nonblocking-after-blocking/blocking-unresolved/unknown): "
      + renderPostEditFinalStateCounts(summary.treatmentFidelity.control),
    "- Treatment post-edit state (not-reviewed/complete/advisory/nonblocking-after-blocking/blocking-unresolved/unknown): "
      + renderPostEditFinalStateCounts(summary.treatmentFidelity.treatment),
    "- Post-edit decision telemetry is agent-reported and descriptive; it does not change ITT inclusion or verified completion.",
    "",
    summary.registeredTasks < 2
      ? "This one-task run is a non-confirmatory plumbing pilot and cannot support a product-effect claim."
      : "Treat this result as descriptive unless the task set, power target, and analysis were preregistered.",
    ""
  );
  return lines.join("\n");
}

function renderSchemaV2Markdown(summary, confidenceLevel) {
  const percent = (value) => `${(value * 100).toFixed(1)}%`;
  const confidenceLabel = formatConfidenceLevel(confidenceLevel);
  const identityProof = summary.candidateIdentityProof;
  const observedIdentities = [...new Set(
    (identityProof.receipts ?? [])
      .filter((receipt) => receipt.status === "valid" && receipt.observedServerInfo)
      .map((receipt) => `${receipt.observedServerInfo.name}@${receipt.observedServerInfo.version}`)
  )];
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
    `- Primary comparison: ${summary.primaryComparison}`,
    `- Candidate identity preflight: ${identityProof.status} (${identityProof.verifiedReceipts}/${identityProof.requiredReceipts} receipts); expected ${identityProof.expectedServerInfo.name}@${identityProof.expectedServerInfo.version}; observed ${observedIdentities.join(", ") || "none"}`
  ];
  for (const receipt of identityProof.receipts.filter((entry) => entry.status === "invalid").slice(0, 8)) {
    lines.push(`  - Invalid preflight ${receipt.taskId} / ${receipt.serverCommand}: ${receipt.failure}`);
  }
  for (const [armId, arm] of Object.entries(summary.arms)) {
    lines.push(`- Arm ${armId}: ${arm.successes}/${arm.startedRuns} started runs`);
    const efficiency = summary.efficiencyTelemetry[armId];
    lines.push(
      `  - ATIF transport observed/unknown-or-partial: ${efficiency.atif.observedRuns}/${efficiency.atif.unknownOrPartialRuns}; request/result bytes: ${formatNullableNumber(efficiency.atif.requestArgumentBytes)}/${formatNullableNumber(efficiency.atif.modelVisibleResultTextBytes)}; explicit-detailed/resource-fetch/escalation/unchanged: ${formatNullableNumber(efficiency.atif.explicitDetailedRequests)}/${formatNullableNumber(efficiency.atif.detailResourceFetches)}/${formatNullableNumber(efficiency.atif.automaticEscalations)}/${formatNullableNumber(efficiency.atif.unchangedReceipts)}; resource-fetch request/result bytes: ${formatNullableNumber(efficiency.atif.detailResourceFetchRequestArgumentBytes)}/${formatNullableNumber(efficiency.atif.detailResourceFetchResultTextBytes)}`,
      `  - Server telemetry observed/unknown-or-partial: ${efficiency.server.observedRuns}/${efficiency.server.unknownOrPartialRuns}; tool/resource events: ${formatNullableNumber(efficiency.server.toolCallEvents)}/${formatNullableNumber(efficiency.server.detailResourceFetches)}; request/text/structured/total bytes: ${formatNullableNumber(efficiency.server.requestBytes)}/${formatNullableNumber(efficiency.server.textBytes)}/${formatNullableNumber(efficiency.server.structuredBytes)}/${formatNullableNumber(efficiency.server.totalBytes)}; elapsed ms: ${formatNullableNumber(efficiency.server.elapsedMs)}`
    );
  }
  for (const comparison of Object.values(summary.comparisons)) {
    if (comparison.effect === null) {
      lines.push(`- ${comparison.id}: effect not estimated because the experiment is incomplete or protocol-invalid`);
    } else {
      const ci = comparison.effect.taskClusteredBootstrap;
      const interval = ci.lower === null ? "not estimable" : `${percent(ci.lower)} to ${percent(ci.upper)}`;
      lines.push(
        `- ${comparison.id} (${comparison.candidateArm} versus ${comparison.baselineArm}): ${percent(comparison.effect.absoluteRiskDifference)}`,
        `  - Task-clustered ${confidenceLabel} interval: ${interval}`,
        `  - Discordant pairs: candidate-only ${comparison.effect.candidateOnlyPairs}, baseline-only ${comparison.effect.baselineOnlyPairs}`
      );
    }
    const allStarted = comparison.pairedOverhead.views.allStarted;
    const bothSuccessful = comparison.pairedOverhead.views.bothCompletedSuccessfully;
    lines.push(
      `  - Paired descriptive overhead, all-started (candidate minus baseline): ${renderPairedMetrics(allStarted, ["inputTokens", "cacheTokens", "outputTokens", "costUsd", "agentElapsedMs", "controllerElapsedMs"])}`,
      `  - Paired descriptive overhead, both-completed-success: ${renderPairedMetrics(bothSuccessful, ["inputTokens", "cacheTokens", "outputTokens", "costUsd", "agentElapsedMs", "controllerElapsedMs"])}`
    );
    const transport = renderPairedMetrics(allStarted, [
      "atifCorrelatedCalls",
      "atifRequestArgumentBytes",
      "atifModelVisibleResultTextBytes",
      "atifDetailResourceFetches",
      "serverEvents",
      "serverTotalBytes",
      "serverElapsedMs"
    ], true);
    if (transport) {
      lines.push(`  - Paired descriptive transport/server overhead, all-started: ${transport}`);
    }
  }
  lines.push(
    "- Usage, ATIF transport, and server telemetry are descriptive; they do not change ITT inclusion, protocol validity, or verifier outcomes.",
    "",
    summary.registeredTasks < 2
      ? "This one-task run is a non-confirmatory plumbing pilot and cannot support a product-effect claim."
      : "Treat this result as descriptive unless the task set, power target, and analysis were preregistered.",
    ""
  );
  return lines.join("\n");
}

function renderPairedMetrics(view, names, omitUnavailable = false) {
  const rendered = [];
  for (const name of names) {
    const metric = view.metrics[name];
    if (!metric || (omitUnavailable && metric.pairedPresent === 0)) {
      continue;
    }
    const ratio = Number.isFinite(metric.candidateToBaselineMeanRatio)
      ? `, ratio ${formatCompactNumber(metric.candidateToBaselineMeanRatio)}`
      : "";
    rendered.push(
      `${name} mean/median delta ${formatCompactNumber(metric.meanDelta)}/${formatCompactNumber(metric.medianDelta)}${ratio} [paired ${metric.pairedPresent}/${metric.eligiblePairs}]`
    );
  }
  return rendered.length > 0 ? rendered.join("; ") : "no paired values available";
}

function formatCompactNumber(value) {
  return Number.isFinite(value) ? String(Number(value.toFixed(6))) : "unknown";
}

function formatNullableNumber(value) {
  return Number.isFinite(value) ? String(value) : "unknown";
}

function renderPostEditFinalStateCounts(fidelity) {
  return POST_EDIT_FINAL_STATES.map((state) => fidelity.postEditFinalStateCounts[state]).join("/");
}

function formatConfidenceLevel(confidenceLevel) {
  return `${Number((confidenceLevel * 100).toFixed(3))}%`;
}

function readServerTelemetry(trialDir) {
  const scan = findNamedEntries(trialDir, SERVER_TELEMETRY_BASENAME, 6);
  if (!scan.complete) {
    return unavailableServerTelemetry("scan-limit");
  }
  const entries = scan.matches;
  if (entries.length === 0) {
    return unavailableServerTelemetry("missing");
  }
  if (entries.length !== 1) {
    return unavailableServerTelemetry("ambiguous");
  }
  const file = entries[0];
  let descriptor;
  try {
    const pathStat = lstatSync(file);
    if (!pathStat.isFile() || pathStat.isSymbolicLink()) {
      return unavailableServerTelemetry("invalid-file");
    }
    descriptor = openSync(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const stat = fstatSync(descriptor);
    if (!stat.isFile()) {
      return unavailableServerTelemetry("invalid-file");
    }
    if (stat.size > MAX_SERVER_TELEMETRY_BYTES) {
      return unavailableServerTelemetry("too-large");
    }
    const raw = readFileSync(descriptor, "utf8");
    const lines = raw.split(/\r?\n/u).filter((line) => line.length > 0);
    if (lines.length === 0) {
      return unavailableServerTelemetry("partial");
    }
    if (lines.length > MAX_SERVER_TELEMETRY_LINES) {
      return unavailableServerTelemetry("scan-limit");
    }
    const events = [];
    const sequences = new Set();
    let completion;
    for (const [index, line] of lines.entries()) {
      if (Buffer.byteLength(line, "utf8") > MAX_SERVER_TELEMETRY_LINE_BYTES) {
        return unavailableServerTelemetry("scan-limit");
      }
      const event = JSON.parse(line);
      if (event?.recordKind === "session-complete") {
        if (completion || index !== lines.length - 1 || !validServerTelemetryCompletion(event)) {
          return unavailableServerTelemetry("malformed");
        }
        completion = event;
        continue;
      }
      if (!validServerTelemetryEvent(event) || sequences.has(event.sequence)) {
        return unavailableServerTelemetry("malformed");
      }
      sequences.add(event.sequence);
      events.push(event);
    }
    if (!completion) {
      return unavailableServerTelemetry("partial");
    }
    events.sort((left, right) => left.sequence - right.sequence);
    if (
      events.some((event, index) => event.sequence !== index + 1)
      || events.some((event) => (event.droppedBefore ?? 0) > 0)
      || events.some((event) => event.outcome === "error")
      || completion.eventCount !== events.length
      || completion.sequence !== events.length + 1
    ) {
      return unavailableServerTelemetry("partial");
    }
    const aggregate = {
      schemaVersion: 1,
      status: "observed",
      evidenceTrust: "agent-artifact-content-free-server-telemetry",
      events: events.length,
      toolCallEvents: 0,
      detailResourceFetches: 0,
      requestBytes: 0,
      textBytes: 0,
      structuredBytes: 0,
      totalBytes: 0,
      elapsedMs: 0,
      detailResourceFetchRequestBytes: 0,
      detailResourceFetchTextBytes: 0,
      detailResourceFetchTotalBytes: 0,
      detailResourceFetchElapsedMs: 0,
      requestedFormats: {},
      effectiveFormats: {},
      escalationEvents: 0,
      unchangedReceipts: 0,
      callsByTool: {}
    };
    for (const event of events) {
      const eventKind = event.eventKind ?? "tool";
      aggregate.requestBytes += event.requestBytes;
      aggregate.textBytes += event.textBytes;
      aggregate.structuredBytes += event.structuredBytes;
      aggregate.totalBytes += event.totalBytes;
      aggregate.elapsedMs += event.elapsedMs;
      if (eventKind === "resource-read") {
        aggregate.detailResourceFetches += 1;
        aggregate.detailResourceFetchRequestBytes += event.requestBytes;
        aggregate.detailResourceFetchTextBytes += event.textBytes;
        aggregate.detailResourceFetchTotalBytes += event.totalBytes;
        aggregate.detailResourceFetchElapsedMs += event.elapsedMs;
      } else {
        aggregate.toolCallEvents += 1;
        incrementCount(aggregate.requestedFormats, event.requestedFormat);
        incrementCount(aggregate.effectiveFormats, event.effectiveFormat);
        aggregate.escalationEvents += Number(typeof event.escalationReason === "string" && event.escalationReason.length > 0);
        aggregate.unchangedReceipts += Number(event.unchangedReceipt);
      }
      const byTool = aggregate.callsByTool[event.tool] ?? {
        calls: 0,
        requestBytes: 0,
        textBytes: 0,
        structuredBytes: 0,
        totalBytes: 0,
        elapsedMs: 0
      };
      byTool.calls += 1;
      byTool.requestBytes += event.requestBytes;
      byTool.textBytes += event.textBytes;
      byTool.structuredBytes += event.structuredBytes;
      byTool.totalBytes += event.totalBytes;
      byTool.elapsedMs += event.elapsedMs;
      aggregate.callsByTool[event.tool] = byTool;
    }
    aggregate.requestedFormats = sortRecord(aggregate.requestedFormats);
    aggregate.effectiveFormats = sortRecord(aggregate.effectiveFormats);
    aggregate.callsByTool = sortRecord(aggregate.callsByTool);
    return aggregate;
  } catch (error) {
    return unavailableServerTelemetry(error && typeof error === "object" && error.code === "ELOOP" ? "invalid-file" : "malformed");
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // Optional telemetry remains descriptive if cleanup races with teardown.
      }
    }
  }
}

function validServerTelemetryCompletion(record) {
  return record
    && typeof record === "object"
    && !Array.isArray(record)
    && Object.keys(record).length === 4
    && record.schemaVersion === 1
    && record.recordKind === "session-complete"
    && Number.isSafeInteger(record.sequence)
    && record.sequence >= 1
    && record.sequence <= MAX_SERVER_TELEMETRY_LINES
    && Number.isSafeInteger(record.eventCount)
    && record.eventCount >= 0
    && record.eventCount < MAX_SERVER_TELEMETRY_LINES;
}

function validServerTelemetryEvent(event) {
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    return false;
  }
  const allowed = new Set([
    "schemaVersion",
    "sequence",
    "eventKind",
    "logicalOperation",
    "droppedBefore",
    "outcome",
    "tool",
    "profile",
    "requestedFormat",
    "effectiveFormat",
    "escalationReason",
    "requestBytes",
    "textBytes",
    "structuredBytes",
    "totalBytes",
    "elapsedMs",
    "resultReference",
    "unchangedReceipt"
  ]);
  if (Object.keys(event).some((key) => !allowed.has(key))) {
    return false;
  }
  const boundedByteCounts = ["requestBytes", "textBytes", "structuredBytes", "totalBytes"]
    .every((field) => Number.isSafeInteger(event[field]) && event[field] >= 0 && event[field] <= MAX_SERVER_TELEMETRY_EVENT_BYTES);
  const commonValid = event.schemaVersion === 1
    && Number.isInteger(event.sequence)
    && event.sequence >= 1
    && (event.eventKind === undefined || event.eventKind === "tool" || event.eventKind === "resource-read")
    && (event.outcome === undefined || event.outcome === "ok" || event.outcome === "error")
    && (
      event.droppedBefore === undefined
      || (Number.isSafeInteger(event.droppedBefore) && event.droppedBefore >= 0 && event.droppedBefore <= MAX_SERVER_TELEMETRY_EVENT_BYTES)
    )
    && (
      event.logicalOperation === undefined
      || (typeof event.logicalOperation === "string" && /^[a-z][a-z0-9_-]{0,99}$/u.test(event.logicalOperation))
    )
    && typeof event.tool === "string"
    && /^[a-z][a-z0-9_]{0,99}$/u.test(event.tool)
    && ["core", "full"].includes(event.profile)
    && ["auto", "concise", "detailed"].includes(event.requestedFormat)
    && ["concise", "detailed"].includes(event.effectiveFormat)
    && (event.escalationReason === undefined || (typeof event.escalationReason === "string" && event.escalationReason.length <= 200))
    && boundedByteCounts
    && event.totalBytes >= event.textBytes + event.structuredBytes
    && Number.isFinite(event.elapsedMs)
    && event.elapsedMs >= 0
    && event.elapsedMs <= MAX_SERVER_TELEMETRY_EVENT_ELAPSED_MS
    && typeof event.unchangedReceipt === "boolean";
  if (!commonValid) {
    return false;
  }
  if (event.eventKind === "resource-read") {
    return event.tool === "read_mcp_resource"
      && event.requestedFormat === "detailed"
      && event.effectiveFormat === "detailed"
      && event.escalationReason === undefined
      && event.structuredBytes === 0
      && typeof event.resultReference === "string"
      && isExactMcpResultUri(event.resultReference)
      && event.unchangedReceipt === false;
  }
  return event.resultReference === undefined
    || (typeof event.resultReference === "string" && event.resultReference.length <= 500 && event.resultReference.startsWith("codexa://"));
}

function unavailableServerTelemetry(status) {
  return {
    schemaVersion: 1,
    status,
    evidenceTrust: "agent-artifact-content-free-server-telemetry",
    events: null,
    toolCallEvents: null,
    detailResourceFetches: null,
    requestBytes: null,
    textBytes: null,
    structuredBytes: null,
    totalBytes: null,
    elapsedMs: null,
    detailResourceFetchRequestBytes: null,
    detailResourceFetchTextBytes: null,
    detailResourceFetchTotalBytes: null,
    detailResourceFetchElapsedMs: null,
    requestedFormats: null,
    effectiveFormats: null,
    escalationEvents: null,
    unchangedReceipts: null,
    callsByTool: null
  };
}

function findNamedEntries(root, basename, depth) {
  const state = { complete: true, visited: 0, matches: [] };
  const walk = (directory, remainingDepth) => {
    if (!state.complete || remainingDepth < 0 || !existsSync(directory)) {
      return;
    }
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      state.complete = false;
      return;
    }
    for (const entry of entries) {
      state.visited += 1;
      if (state.visited > MAX_SERVER_TELEMETRY_SCAN_ENTRIES) {
        state.complete = false;
        return;
      }
      const target = path.join(directory, entry.name);
      if (entry.name === basename) {
        state.matches.push(target);
        if (state.matches.length > 1) {
          return;
        }
        continue;
      }
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        walk(target, remainingDepth - 1);
      }
      if (!state.complete || state.matches.length > 1) {
        return;
      }
    }
  };
  walk(root, depth);
  return state;
}

function incrementCount(record, key) {
  record[key] = (record[key] ?? 0) + 1;
}

function sortRecord(record) {
  return Object.fromEntries(Object.entries(record).sort(([left], [right]) => left.localeCompare(right)));
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
