import path from "node:path";
import { focusBriefQuery, testPlanQuery } from "./queries.js";
import { loadPolicyPack, type PolicyPackSummary } from "./policy-pack.js";
import { loadTaskSnapshot, type TaskSnapshotLoadResult } from "./task-snapshots.js";
import { freshnessBanner } from "./query/runtime.js";
import { createQuerySession } from "./query/session.js";
import { evaluateRequiredChecks } from "./query/required-checks.js";
import { formatVerificationCoverage, formatVerificationLedger, verificationCommandPlan, verificationEvidenceForCommandReports, verificationLedgerForPostEdit } from "./query/verification.js";
import {
  sanitizeCommandEnvelopeForDisplay,
  sanitizeCommandReportForDisplay,
  sanitizeCommandText,
  sanitizeCoverageForDisplay,
  sanitizeLedgerForDisplay,
  sanitizeSummary
} from "./query/verification-display.js";
import { pruneMissingFiles, prunedFilesGap } from "./query/prune-missing.js";
import { verificationTrustTierOrNone } from "./query/verification/trust.js";
import { latestCompletedPostEditReviewMatches } from "./post-edit-outcomes.js";
import { readArchivedSessionMemoryEntries, readSessionMemory, sessionMemoryPointerDigest } from "./session-memory.js";
import { evaluateVerificationArtifacts, loadVerificationArtifacts, type VerificationArtifactEvaluation } from "./verification-artifacts.js";
import { loadTaskLifecycleState, pendingTaskLifecycleReplan, type TaskLifecycleState, type TaskLifecycleStop } from "./task-lifecycle.js";
import type {
  ChangeType,
  CodexaIndex,
  FreshnessInfo,
  QueryOptions,
  QueryResult,
  RefreshInfo,
  TaskSnapshot,
  TestRecommendation,
  SessionMemoryEntryFact,
  VerificationCommandEnvelope,
  VerificationCommandReport,
  VerificationCommandPlanEntry,
  VerificationCoverage,
  VerificationArtifactSummary,
  VerificationLedgerEntry,
  VerificationProvenance,
  VerificationWaiver
} from "./types.js";
import { CURRENT_VERIFICATION_PROVENANCE as VERIFICATION_PROVENANCE } from "./types.js";
import { limitText, uniqueSorted } from "./util.js";
import { proofNextCommands } from "./prove-next-commands.js";

export interface ProveOptions extends QueryOptions {
  task?: string;
  diff?: boolean;
  changeType?: ChangeType;
  files?: string[];
  tokenBudget?: number;
  taskId?: string;
  ranTests?: string[];
  ranCommands?: string[];
  ranCommandReports?: VerificationCommandReport[];
  waivedChecks?: string[];
  waivers?: VerificationWaiver[];
  artifactIds?: string[];
}

export interface ProveReportedVerification {
  hasEvidence: boolean;
  ranTests: string[];
  ranCommands: string[];
  ranCommandReports: VerificationCommandReport[];
  waivedChecks: string[];
  waivers: VerificationWaiver[];
  coverage: VerificationCoverage[];
  commandEnvelopes: VerificationCommandEnvelope[];
  commandPlan: VerificationCommandPlanEntry[];
  ledger: VerificationLedgerEntry[];
  waivedVerification: VerificationLedgerEntry[];
  testsNotRun: TestRecommendation[];
  verificationProvenance: VerificationProvenance;
}

export interface ProveData {
  mode: "proof_card";
  actionability: string;
  task: string;
  repoRoot: string;
  verificationProvenance: VerificationProvenance;
  freshness: {
    stale: boolean;
    reason: string;
    indexedAt: string;
    headCommit: string | null;
    dirtyFileCount: number;
    parserErrorCount: number;
  };
  worktree: {
    knownClean?: boolean;
    unknown?: boolean;
    degraded?: boolean;
    dirtyFileCount?: number;
    changedFiles: string[];
    degradedReasons: string[];
  };
  readFirst: Array<{ path: string; riskScore?: number; rank?: number }>;
  snapshot: {
    status: "loaded" | "missing" | "blocked";
    taskId?: string;
    origin?: string;
    createdAt?: string;
    plannedEditTargets: string[];
    plannedTests: string[];
    reason?: string;
  };
  verification: {
    recommendedCommands: string[];
    commandPlan: VerificationCommandPlanEntry[];
    ledgerPreview: VerificationLedgerEntry[];
    tests: TestRecommendation[];
    reported: ProveReportedVerification;
    artifacts: {
      selected: VerificationArtifactSummary[];
      accepted: VerificationArtifactSummary[];
      rejected: VerificationArtifactSummary[];
      ledgerEvidence: VerificationArtifactEvaluation["ledgerEvidence"];
    };
  };
  decisionLog: ProveDecisionLog;
  lifecycle: ProveLifecycle;
  policies: PolicyPackSummary;
  gaps: string[];
  trustPosture: string[];
  nextCommands: string[];
}

export interface ProveLifecycle {
  status: "loaded" | "missing" | "invalid";
  planRevision?: number;
  invariants: TaskLifecycleState["invariants"];
  invariantReviews: TaskLifecycleState["latestInvariantReviews"];
  attempts: TaskLifecycleState["attempts"];
  pendingStop?: TaskLifecycleStop;
  resolvedAttemptDrift?: {
    attemptId: string;
    reason: string;
  };
  error?: string;
}

export interface ProveDecisionLog {
  status: "loaded" | "not_recorded" | "unavailable";
  sessionId?: string;
  baselineRevision?: number;
  currentRevision?: number;
  baselineIntact?: boolean;
  summaryHashValid?: boolean;
  decisions: SessionMemoryEntryFact[];
  ruledOut: SessionMemoryEntryFact[];
  constraints: SessionMemoryEntryFact[];
  verification: SessionMemoryEntryFact[];
  openQuestions: SessionMemoryEntryFact[];
  artifactIds: string[];
  warnings: string[];
}

interface FocusFileShape {
  path?: unknown;
  riskScore?: unknown;
  rank?: unknown;
}

interface WorktreeShape {
  knownClean?: unknown;
  degraded?: unknown;
  dirtyFileCount?: unknown;
  degradedReasons?: unknown;
}

export async function proveQuery(repoRoot: string, options: ProveOptions = {}): Promise<QueryResult> {
  const repo = path.resolve(repoRoot);
  const task = options.task?.trim() || "Codexa proof card";
  const diff = options.diff ?? true;
  const session = await createQuerySession(repo, options);
  const focusPromise = focusBriefQuery(session, { task, diff, tokenBudget: Math.min(options.tokenBudget ?? 1800, 3000), limit: 8 }, options);
  const policiesPromise = loadPolicyPack(repo);
  const snapshotLoad = await loadTaskSnapshot(repo, options.taskId);
  const proofFiles = (options.files?.length ?? 0) > 0 ? options.files : snapshotLoad.snapshot?.plannedEditTargets;
  const [focus, testPlan, policies] = await Promise.all([
    focusPromise,
    testPlanQuery(session, diff, { ...options, files: proofFiles, changeType: options.changeType ?? "unknown" }),
    policiesPromise
  ]);
  const focusData = asRecord(focus.data);
  const testData = asRecord(testPlan.data);
  const actionability = typeof testData.actionability === "string" ? testData.actionability : "verify";
  const planChangedFiles = stringArray(testData.changedFiles);
  const changedFiles = diff && Array.isArray(testData.changedFiles) ? planChangedFiles : session.freshness.dirtyFiles;
  const worktreeDegradationReasons = uniqueSorted([
    ...stringArray(focusData.worktreeDegradationReasons),
    ...session.worktreeDegradationReasons
  ]);
  const worktree = worktreeFromData(
    focusData.worktree,
    changedFiles,
    worktreeDegradationReasons,
    session.worktreeDegradationReasons.length === 0
  );
  const snapshot = snapshotSummary(snapshotLoad.snapshot, {
    taskId: snapshotLoad.latestTaskId,
    reason: snapshotLoad.error ?? snapshotLoad.missingReason ?? snapshotLoad.blockedSnapshot?.reason,
    blocked: Boolean(snapshotLoad.blockedSnapshot)
  });
  const readFirstPrune = pruneMissingFiles(readFirstFromFocus(focusData.focusFiles), repo, (entry) => entry.path);
  const readFirst = readFirstPrune.entries;
  const recommendedCommands = stringArray(testData.verificationCommands);
  const commandPlan = verificationCommandPlanFromData(testData.verificationCommandPlan);
  const ledgerPreview = verificationLedgerFromData(testData.verificationLedgerPreview);
  const tests = testRecommendationsFromData(testData.tests);
  const decisionLog = await decisionLogForSnapshot(repo, snapshotLoad.snapshot, session.freshness);
  const lifecycle = await lifecycleForProof(
    repo,
    snapshotLoad.snapshot,
    snapshotLoad,
    session.freshness
  );
  // Historical artifact refs remain visible in the decision log, but proof
  // credit is explicit-only so stale prior runs cannot silently satisfy a new
  // handoff.
  const artifactIds = uniqueSorted(options.artifactIds ?? []).slice(0, 20);
  const artifactLoads = await loadVerificationArtifacts(repo, artifactIds);
  const artifacts = evaluateVerificationArtifacts(artifactLoads, {
    taskId: snapshotLoad.snapshot?.taskId,
    freshness: session.freshness,
    requiredChecks: [
      ...(snapshotLoad.snapshot?.requiredWorkflowChecks ?? []),
      ...(snapshotLoad.snapshot?.requiredDependencyChecks ?? [])
    ]
  });
  const reported = applyArtifactLedger(reportedVerificationData({
    repoRoot: repo,
    index: session.index,
    snapshot: snapshotLoad.snapshot,
    tests,
    ranTests: options.ranTests ?? [],
    ranCommands: options.ranCommands ?? [],
    ranCommandReports: options.ranCommandReports ?? [],
    waivedChecks: options.waivedChecks ?? [],
    waivers: options.waivers ?? []
  }), artifacts);
  const gaps = proofGaps({
    freshness: session.freshness,
    worktree,
    snapshot,
    policies,
    reported,
    testPlanActionability: actionability,
    focusGaps: stringArray(focusData.gaps),
    testGaps: stringArray(testData.gaps),
    artifacts,
    decisionLog,
    lifecycle
  });
  if (readFirstPrune.prunedCount > 0) {
    gaps.push(prunedFilesGap(readFirstPrune.prunedCount));
  }
  const proofData: Omit<ProveData, "nextCommands"> = {
    mode: "proof_card",
    actionability,
    task,
    repoRoot: repo,
    verificationProvenance: VERIFICATION_PROVENANCE,
    freshness: freshnessData(session.freshness),
    worktree,
    readFirst,
    snapshot,
    verification: {
      recommendedCommands,
      commandPlan,
      ledgerPreview,
      tests,
      reported,
      artifacts
    },
    decisionLog,
    lifecycle,
    policies,
    gaps,
    trustPosture: trustPosture()
  };
  const data: ProveData = { ...proofData, nextCommands: proofNextCommands(proofData) };
  return {
    freshness: session.freshness,
    refresh: session.refresh,
    text: renderProofCard(data, session.freshness, session.refresh),
    data
  };
}

function renderProofCard(data: ProveData, freshness: FreshnessInfo, refresh: RefreshInfo | undefined): string {
  const worktreeLine = data.worktree.degraded || data.worktree.unknown
    ? `unknown (${data.worktree.degradedReasons.join("; ") || "no authoritative worktree signal"})`
    : data.worktree.knownClean
      ? "clean"
      : `${data.worktree.dirtyFileCount ?? data.worktree.changedFiles.length} changed file(s)`;
  const lines = [
    freshnessBanner(freshness, refresh),
    "Codexa proof card",
    `Task: ${data.task}`,
    `Repo: ${data.repoRoot}`,
    `Worktree: ${worktreeLine}`,
    `Snapshot: ${formatSnapshot(data.snapshot)}`,
    `Actionability: ${data.actionability}`,
    `Status: ${proofStatus(data)}`,
    `Proof gaps: ${data.gaps.length}`,
    "",
    "Read first:",
    ...formatReadFirst(data.readFirst),
    ...proofSection(
      "Verification preview (not proof until reported):",
      data.verification.recommendedCommands.length > 0 ? formatCommands(data.verification.recommendedCommands) : []
    ),
    ...proofSection(
      "Verification ledger preview:",
      data.verification.ledgerPreview.length > 0 ? formatVerificationLedger(data.verification.ledgerPreview) : []
    ),
    ...proofSection(
      "Reported verification evidence:",
      data.verification.reported.hasEvidence ? formatReportedEvidence(data.verification.reported) : []
    ),
    ...proofSection(
      "Reported verification coverage:",
      data.verification.reported.hasEvidence ? formatVerificationCoverage(data.verification.reported.coverage) : []
    ),
    ...proofSection(
      "Reported verification ledger:",
      shouldRenderReportedLedger(data) ? formatReportedLedger(data.verification.reported) : []
    ),
    ...proofSection(
      "External verification artifacts:",
      data.verification.artifacts.selected.length > 0 ? formatVerificationArtifacts(data.verification.artifacts.selected) : []
    ),
    ...proofSection("Decision log:", shouldRenderDecisionLog(data.decisionLog) ? formatDecisionLog(data.decisionLog) : []),
    ...proofSection("Task lifecycle:", shouldRenderLifecycle(data.lifecycle) ? formatProofLifecycle(data.lifecycle) : []),
    "",
    "Local policies:",
    ...formatPolicies(data.policies),
    "",
    "Trust posture:",
    ...data.trustPosture.map((line) => `- ${line}`),
    "",
    "Remaining proof gaps:",
    ...formatGaps(data.gaps),
    ...(data.nextCommands.length > 0
      ? ["", "Next commands:", ...data.nextCommands.map((command) => `- ${command}`)]
      : data.actionability === "needs_target"
        ? ["", "Next action:", "- Choose explicit file or symbol targets, or create a dirty diff, before requesting proof."]
        : [])
  ];
  return limitText(lines.join("\n"), 8000);
}

function proofSection(title: string, lines: string[]): string[] {
  return lines.length > 0 ? ["", title, ...lines] : [];
}

function shouldRenderReportedLedger(data: ProveData): boolean {
  return data.verification.reported.hasEvidence || data.verification.artifacts.selected.length > 0;
}

function shouldRenderDecisionLog(decisionLog: ProveDecisionLog): boolean {
  return decisionLog.status !== "not_recorded" || decisionLog.warnings.length > 0;
}

function shouldRenderLifecycle(lifecycle: ProveLifecycle): boolean {
  return (
    lifecycle.status !== "missing" ||
    lifecycle.invariants.length > 0 ||
    lifecycle.invariantReviews.length > 0 ||
    lifecycle.attempts.length > 0 ||
    Boolean(lifecycle.pendingStop) ||
    Boolean(lifecycle.error)
  );
}

function proofStatus(data: ProveData): "blocked" | "needs target" | "action required" | "ready" {
  if (
    data.freshness.stale ||
    data.worktree.degraded ||
    data.worktree.unknown ||
    data.snapshot.status === "blocked" ||
    data.lifecycle.status === "invalid" ||
    data.lifecycle.pendingStop
  ) {
    return "blocked";
  }
  if (data.actionability === "needs_target") {
    return "needs target";
  }
  return data.gaps.length > 0 || data.nextCommands.length > 0 ? "action required" : "ready";
}

function freshnessData(freshness: FreshnessInfo): ProveData["freshness"] {
  return {
    stale: freshness.stale,
    reason: freshness.reason,
    indexedAt: freshness.indexedAt,
    headCommit: freshness.headCommit,
    dirtyFileCount: freshness.dirtyFiles.length,
    parserErrorCount: freshness.parserErrorCount
  };
}

function readFirstFromFocus(value: unknown): ProveData["readFirst"] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry): ProveData["readFirst"][number] | undefined => {
      const record = entry as FocusFileShape;
      return typeof record.path === "string"
        ? {
            path: record.path,
            riskScore: typeof record.riskScore === "number" ? record.riskScore : undefined,
            rank: typeof record.rank === "number" ? record.rank : undefined
          }
        : undefined;
    })
    .filter((entry): entry is ProveData["readFirst"][number] => Boolean(entry))
    .slice(0, 8);
}

function snapshotSummary(
  snapshot: TaskSnapshot | undefined,
  fallback: { taskId?: string; reason?: string; blocked: boolean }
): ProveData["snapshot"] {
  if (snapshot) {
    return {
      status: "loaded",
      taskId: snapshot.taskId,
      origin: snapshot.origin,
      createdAt: snapshot.createdAt,
      plannedEditTargets: snapshot.plannedEditTargets.slice(0, 20),
      plannedTests: snapshot.plannedTests.map((test) => test.path).slice(0, 20)
    };
  }
  return {
    status: fallback.blocked ? "blocked" : "missing",
    taskId: fallback.taskId,
    plannedEditTargets: [],
    plannedTests: [],
    reason: fallback.reason
  };
}

function worktreeFromData(value: unknown, changedFiles: string[], fallbackDegradedReasons: string[], changedFilesKnown: boolean): ProveData["worktree"] {
  const record = asRecord(value);
  const degradedReasons = stringArray(record.degradedReasons).length > 0 ? stringArray(record.degradedReasons) : fallbackDegradedReasons;
  const shape = record as WorktreeShape;
  // Same honesty rule as the MCP envelope: with no worktree signal at all,
  // knownClean is false-by-honesty, never clean-by-omission.
  const hasSignal = typeof shape.knownClean === "boolean" || typeof shape.dirtyFileCount === "number" || changedFilesKnown || degradedReasons.length > 0;
  if (!hasSignal) {
    return { knownClean: false, unknown: true, degraded: false, dirtyFileCount: 0, changedFiles: [], degradedReasons: [] };
  }
  const dirtyFileCount = Math.max(
    typeof shape.dirtyFileCount === "number" ? (shape.dirtyFileCount as number) : 0,
    changedFilesKnown ? changedFiles.length : 0
  );
  return {
    knownClean:
      shape.knownClean !== false &&
      shape.degraded !== true &&
      dirtyFileCount === 0 &&
      degradedReasons.length === 0,
    unknown: false,
    degraded: typeof shape.degraded === "boolean" ? (shape.degraded as boolean) : degradedReasons.length > 0,
    dirtyFileCount,
    changedFiles: changedFiles.slice(0, 120),
    degradedReasons
  };
}

function reportedVerificationData(input: {
  repoRoot: string;
  index: CodexaIndex;
  snapshot?: TaskSnapshot;
  tests: TestRecommendation[];
  ranTests: string[];
  ranCommands: string[];
  ranCommandReports: VerificationCommandReport[];
  waivedChecks: string[];
  waivers: VerificationWaiver[];
}): ProveReportedVerification {
  const hasEvidence =
    input.ranTests.length > 0 || input.ranCommands.length > 0 || input.ranCommandReports.length > 0 || input.waivedChecks.length > 0 || input.waivers.length > 0;
  const checkCoverage = verificationEvidenceForCommandReports(input.index, input.ranCommands, input.ranCommandReports, input.repoRoot).coverage;
  const checkContext = {
    editPaths: input.snapshot?.plannedEditTargets ?? [],
    reviewTargets: input.snapshot?.plannedFiles ?? input.snapshot?.plannedEditTargets ?? [],
    selectedFiles: [],
    workflows: [],
    affectedEdges: [],
    affectedTests: [],
    tests: input.tests,
    ranTests: input.ranTests,
    verificationCoverage: checkCoverage
  };
  const workflowChecks = evaluateRequiredChecks(input.snapshot?.requiredWorkflowChecks ?? [], checkContext);
  const dependencyChecks = evaluateRequiredChecks(input.snapshot?.requiredDependencyChecks ?? [], checkContext);
  const verification = verificationLedgerForPostEdit({
    index: input.index,
    tests: input.tests,
    ranTests: input.ranTests,
    ranCommands: input.ranCommands,
    ranCommandReports: input.ranCommandReports,
    waivedChecks: input.waivedChecks,
    waivers: input.waivers,
    repoRoot: input.repoRoot,
    workflowChecks,
    dependencyChecks
  });
  const coverage = verification.coverage.map((entry) => sanitizeCoverageForDisplay(entry, input.repoRoot));
  const ledger = verification.ledger.map((entry) => sanitizeLedgerForDisplay(entry, input.repoRoot));
  return {
    hasEvidence,
    ranTests: input.ranTests.map((test) => sanitizeCommandText(test, input.repoRoot)),
    ranCommands: input.ranCommands.map((command) => sanitizeCommandText(command, input.repoRoot)),
    ranCommandReports: input.ranCommandReports.map((report) => sanitizeCommandReportForDisplay(report, input.repoRoot)),
    waivedChecks: input.waivedChecks.map((check) => sanitizeCommandText(check, input.repoRoot)),
    waivers: input.waivers.map((waiver) => ({
      kind: waiver.kind,
      target: sanitizeCommandText(waiver.target, input.repoRoot),
      reason: sanitizeCommandText(waiver.reason, input.repoRoot)
    })),
    coverage,
    commandEnvelopes: verification.commandEnvelopes.map((envelope) => sanitizeCommandEnvelopeForDisplay(envelope, input.repoRoot)),
    commandPlan: verificationCommandPlan(coverage),
    ledger,
    waivedVerification: ledger.filter((entry) => entry.status === "waived"),
    testsNotRun: verification.testsNotRun,
    verificationProvenance: VERIFICATION_PROVENANCE
  };
}

function applyArtifactLedger(reported: ProveReportedVerification, artifacts: VerificationArtifactEvaluation): ProveReportedVerification {
  const byTarget = new Map(artifacts.ledgerEvidence.map((entry) => [`${entry.kind}:${entry.target}`, entry]));
  const ledger = reported.ledger.map((entry) => {
    if (entry.kind === "test") {
      return entry;
    }
    const artifact = byTarget.get(`${entry.kind}:${entry.target}`);
    if (!artifact) {
      return entry;
    }
    if (artifact.status === "covered") {
      return {
        ...entry,
        status: "covered" as const,
        trustTier: "reported" as const,
        evidence: artifact.evidence,
        missingReason: undefined,
        source: "verification-artifact"
      };
    }
    return {
      ...entry,
      status: "missing" as const,
      trustTier: "none" as const,
      evidence: artifact.evidence,
      missingReason: "selected verification artifacts conflict for this required check",
      source: "verification-artifact"
    };
  });
  return {
    ...reported,
    ledger,
    waivedVerification: ledger.filter((entry) => entry.status === "waived")
  };
}

async function decisionLogForSnapshot(repoRoot: string, snapshot: TaskSnapshot | undefined, freshness: FreshnessInfo): Promise<ProveDecisionLog> {
  const pointer = snapshot?.sessionMemory;
  if (!snapshot || !pointer) {
    return emptyDecisionLog("not_recorded");
  }
  try {
    const result = await readSessionMemory({
      repoRoot,
      sessionId: pointer.sessionId,
      taskId: snapshot.taskId,
      freshness,
      includeStale: true,
      limit: 240
    });
    const activeEntries = result.memory.entries;
    const missingBaselineIds = pointer.entryIds.filter((entryId) => !activeEntries.some((entry) => entry.id === entryId));
    const archivedEntries = await readArchivedSessionMemoryEntries({
      repoRoot,
      sessionId: pointer.sessionId,
      entryIds: missingBaselineIds,
      taskId: snapshot.taskId,
      maxArchives: 8
    });
    const entriesById = new Map([...archivedEntries, ...activeEntries].map((entry) => [entry.id, entry]));
    const baselineEntries = pointer.entryIds.map((entryId) => entriesById.get(entryId)).filter((entry): entry is SessionMemoryEntryFact => Boolean(entry));
    const entries = [...entriesById.values()].map((entry) => redactDecisionEntry(entry, repoRoot));
    const artifactIds = uniqueSorted(
      entries.flatMap((entry) => entry.scope.refs.filter((ref) => ref.kind === "verification_artifact").map((ref) => ref.id))
    ).slice(0, 20);
    const canonicalPointer = /^[a-f0-9]{64}$/u.test(pointer.summaryHash);
    return {
      status: "loaded",
      sessionId: pointer.sessionId,
      baselineRevision: pointer.revision,
      currentRevision: result.revision,
      baselineIntact: baselineEntries.length === pointer.entryIds.length,
      summaryHashValid: canonicalPointer && baselineEntries.length === pointer.entryIds.length
        ? sessionMemoryPointerDigest(baselineEntries) === pointer.summaryHash
        : undefined,
      decisions: entries.filter((entry) => entry.kind === "decision").slice(0, 20),
      ruledOut: entries.filter((entry) => entry.kind === "ruled_out").slice(0, 20),
      constraints: entries.filter((entry) => entry.kind === "constraint").slice(0, 20),
      verification: entries.filter((entry) => entry.kind === "verification").slice(0, 20),
      openQuestions: entries.filter((entry) => entry.kind === "open_question").slice(0, 20),
      artifactIds,
      warnings: [...result.warnings, ...(!canonicalPointer ? ["plan-time session-memory pointer uses a legacy non-canonical digest"] : [])]
    };
  } catch (error) {
    return {
      ...emptyDecisionLog("unavailable"),
      sessionId: pointer.sessionId,
      baselineRevision: pointer.revision,
      warnings: [error instanceof Error ? error.message : String(error)]
    };
  }
}

function emptyDecisionLog(status: ProveDecisionLog["status"]): ProveDecisionLog {
  return { status, decisions: [], ruledOut: [], constraints: [], verification: [], openQuestions: [], artifactIds: [], warnings: [] };
}

function redactDecisionEntry(entry: SessionMemoryEntryFact, repoRoot: string): SessionMemoryEntryFact {
  return {
    ...entry,
    summary: sanitizeSummary(entry.summary, repoRoot) ?? "<redacted>",
    details: sanitizeSummary(entry.details, repoRoot),
    scope: {
      ...entry.scope,
      topics: entry.scope.topics.map((topic) => sanitizeSummary(topic, repoRoot) ?? "<redacted>")
    },
    evidence: entry.evidence.map((evidence) => ({
      ...evidence,
      sourceRef: sanitizeSummary(evidence.sourceRef, repoRoot) ?? "<redacted>",
      note: sanitizeSummary(evidence.note, repoRoot)
    }))
  };
}

function verificationCommandPlanFromData(value: unknown): VerificationCommandPlanEntry[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter(isVerificationCommandPlanEntry)
    .slice(0, 30)
    .map((entry) => ({ ...entry, trustTier: verificationTrustTierOrNone(entry.trustTier) }));
}

function verificationLedgerFromData(value: unknown): VerificationLedgerEntry[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter(isVerificationLedgerEntry)
    .slice(0, 30)
    .map((entry) => ({ ...entry, trustTier: verificationTrustTierOrNone(entry.trustTier) }));
}

function testRecommendationsFromData(value: unknown): TestRecommendation[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(isTestRecommendation).slice(0, 30);
}

function isVerificationCommandPlanEntry(value: unknown): value is VerificationCommandPlanEntry {
  const record = asRecord(value);
  return (
    typeof record.command === "string" &&
    Array.isArray(record.covers) &&
    Array.isArray(record.targetPaths) &&
    Array.isArray(record.scopes) &&
    Array.isArray(record.sources) &&
    ["authoritative", "derived", "heuristic"].includes(String(record.confidence))
  );
}

function isVerificationLedgerEntry(value: unknown): value is VerificationLedgerEntry {
  const record = asRecord(value);
  return (
    typeof record.kind === "string" &&
    typeof record.recommended === "string" &&
    typeof record.target === "string" &&
    typeof record.status === "string" &&
    Array.isArray(record.evidence) &&
    Array.isArray(record.coverageKinds)
  );
}

function isTestRecommendation(value: unknown): value is TestRecommendation {
  const record = asRecord(value);
  return typeof record.path === "string" && typeof record.reason === "string" && typeof record.rank === "number";
}

function proofGaps(input: {
  freshness: FreshnessInfo;
  worktree: ProveData["worktree"];
  snapshot: ProveData["snapshot"];
  policies: PolicyPackSummary;
  reported: ProveReportedVerification;
  testPlanActionability: string;
  focusGaps: string[];
  testGaps: string[];
  artifacts: VerificationArtifactEvaluation;
  decisionLog: ProveDecisionLog;
  lifecycle: ProveLifecycle;
}): string[] {
  return uniqueSorted([
    ...(input.freshness.stale ? [`index stale: ${input.freshness.reason}`] : []),
    ...(input.worktree.degraded ? input.worktree.degradedReasons.map((reason) => `worktree state unavailable: ${reason}`) : []),
    ...(input.worktree.unknown ? ["worktree state unavailable: no authoritative worktree signal"] : []),
    ...(input.snapshot.status === "missing" ? [`no saved change-plan snapshot${input.snapshot.reason ? `: ${input.snapshot.reason}` : ""}`] : []),
    ...(input.snapshot.status === "blocked" ? [`latest change-plan snapshot blocked${input.snapshot.reason ? `: ${input.snapshot.reason}` : ""}`] : []),
    ...(input.policies.missing.length > 0 ? [`policy pack missing: ${input.policies.missing.join(", ")}`] : []),
    ...(input.testPlanActionability === "needs_target" ? ["test plan needs target files or a dirty diff"] : []),
    ...(input.reported.hasEvidence && input.reported.coverage.length === 0 && (input.reported.ranCommands.length > 0 || input.reported.ranCommandReports.length > 0)
      ? ["reported commands earned no classifier-backed verification coverage"]
      : []),
    ...(input.reported.hasEvidence || input.artifacts.selected.length > 0
      ? input.reported.testsNotRun.map((test) => `reported verification missing: ${test.path}`)
      : []),
    ...input.reported.ledger
      .filter((entry) => entry.status === "missing" && entry.kind !== "test")
      .map((entry) => `reported verification missing: ${entry.kind} ${entry.target}`),
    ...input.artifacts.selected
      .filter((entry) => entry.status !== "accepted" && entry.status !== "non_passing")
      .map((entry) => `verification artifact ${entry.artifactId} ${entry.status}: ${entry.reasons.join("; ") || "no trusted binding"}`),
    ...input.artifacts.selected
      .filter((entry) => entry.status === "non_passing")
      .map((entry) => `verification artifact ${entry.artifactId} is non-passing: ${entry.reasons.join("; ")}`),
    ...(input.decisionLog.status === "unavailable" ? ["task-bound decision log is unavailable"] : []),
    ...(input.decisionLog.baselineIntact === false ? ["task-bound decision log no longer contains every plan-time baseline entry"] : []),
    ...(input.decisionLog.summaryHashValid === false ? ["task-bound decision log content differs from the plan-time canonical digest"] : []),
    ...(input.lifecycle.status === "invalid" ? [`task lifecycle state is invalid${input.lifecycle.error ? `: ${input.lifecycle.error}` : ""}`] : []),
    ...(input.lifecycle.pendingStop ? [`task lifecycle requires replan: ${input.lifecycle.pendingStop.reasons.join("; ")}`] : []),
    ...(input.lifecycle.resolvedAttemptDrift
      ? [`worktree changed since resolved post-edit review: ${input.lifecycle.resolvedAttemptDrift.attemptId}`]
      : []),
    ...(input.lifecycle.attempts.at(-1)?.attemptStatus === "resolved" &&
    !input.reported.hasEvidence &&
    input.artifacts.selected.length === 0
      ? ["resolved lifecycle history is not explicit verification evidence in the current proof packet"]
      : []),
    ...unresolvedPostEditReviewCoverageGaps(input.lifecycle),
    ...input.lifecycle.invariants.flatMap((invariant) => {
      const review = input.lifecycle.invariantReviews.find((entry) => entry.invariantId === invariant.id);
      return !review ? [`task invariant unreviewed: ${invariant.id}`] : review.status === "violated" ? [`task invariant violated: ${invariant.id}`] : [];
    }),
    ...input.decisionLog.warnings.map((warning) => `decision log warning: ${warning}`),
    ...input.policies.warnings,
    ...input.focusGaps,
    ...input.testGaps
  ]);
}

function unresolvedPostEditReviewCoverageGaps(lifecycle: ProveLifecycle): string[] {
  const latestAttempt = lifecycle.attempts.at(-1);
  if (!latestAttempt || latestAttempt.attemptStatus !== "unresolved") return [];
  return latestAttempt.failureSignals
    .filter((signal) => signal.class === "verification-missing")
    .flatMap((signal) => signal.targets)
    .filter((target) => target.startsWith("post-edit-review-scope:"))
    .slice(0, 4)
    .map((target) => `latest post-edit review is unresolved: ${target.replace(/^post-edit-review-scope:/u, "")}`);
}

async function lifecycleForProof(
  repoRoot: string,
  snapshot: TaskSnapshot | undefined,
  snapshotLoad?: TaskSnapshotLoadResult,
  freshness?: FreshnessInfo
): Promise<ProveLifecycle> {
  if (!snapshot) {
    return snapshotLoad?.error?.includes("task lifecycle")
      ? {
          status: "invalid",
          invariants: [],
          invariantReviews: [],
          attempts: [],
          error: snapshotLoad.error
        }
      : { status: "missing", invariants: [], invariantReviews: [], attempts: [] };
  }
  try {
    const state = await loadTaskLifecycleState(repoRoot, snapshot.taskId);
    const pendingStop = await pendingTaskLifecycleReplan(repoRoot, snapshot);
    if (!state) {
      return {
        status: "missing",
        planRevision: snapshot.planRevision,
        invariants: snapshot.invariants ?? [],
        invariantReviews: [],
        attempts: [],
        pendingStop
      };
    }
    const latestAttempt = state.attempts.at(-1);
    const resolvedAttemptMatches =
      latestAttempt?.attemptStatus !== "resolved" ||
      (freshness !== undefined &&
        (await latestCompletedPostEditReviewMatches({
          repoRoot,
          freshness,
          taskId: snapshot.taskId,
          planRevision: snapshot.planRevision ?? 1,
          snapshotCreatedAt: snapshot.createdAt,
          snapshotPublicationSequence: snapshot.publicationSequence
        })));
    const resolvedAttemptDrift =
      latestAttempt?.attemptStatus === "resolved" && !resolvedAttemptMatches
        ? {
            attemptId: latestAttempt.attemptId,
            reason: "latest completion outcome does not exactly match the current plan and workspace state"
          }
        : undefined;
    return {
      status: "loaded",
      planRevision: state.planRevision,
      invariants: state.invariants,
      invariantReviews: state.latestInvariantReviews,
      attempts: state.attempts.slice(-3),
      pendingStop,
      resolvedAttemptDrift
    };
  } catch (error) {
    return {
      status: "invalid",
      planRevision: snapshot.planRevision,
      invariants: snapshot.invariants ?? [],
      invariantReviews: [],
      attempts: [],
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

function formatProofLifecycle(lifecycle: ProveLifecycle): string[] {
  const header = `- state ${lifecycle.status}${lifecycle.planRevision ? `; plan revision ${lifecycle.planRevision}` : ""}${lifecycle.pendingStop ? "; replan required" : ""}`;
  return [
    header,
    ...(lifecycle.error ? [`- error: ${lifecycle.error}`] : []),
    ...lifecycle.invariants.map((invariant) => {
      const review = lifecycle.invariantReviews.find((entry) => entry.invariantId === invariant.id);
      return `- ${invariant.id}: ${review?.status ?? "unreviewed"}; ${invariant.statement}`;
    }),
    ...lifecycle.attempts.map((attempt) => `- attempt ${attempt.attemptId}: ${attempt.attemptStatus}; ${attempt.failureSignals.length} failure signal(s); ${attempt.changedFiles.length} changed file(s)`),
    ...(lifecycle.resolvedAttemptDrift
      ? [`- drift: worktree changed after resolved attempt ${lifecycle.resolvedAttemptDrift.attemptId}`]
      : []),
    ...(lifecycle.pendingStop ? lifecycle.pendingStop.reasons.map((reason) => `- stop: ${reason}`) : [])
  ];
}

function trustPosture(): string[] {
  return [
    "core proof paths are local and model-free; optional semantic lanes remain explicit opt-ins",
    "Codexa MCP tools are context and review tools, not source-mutating edit tools",
    "reported commands earn verification credit only through the shared command classifier",
    "verification trust is explicit: executed-by-autoverify > witnessed > artifact-corroborated > reported > none",
    "unauthenticated imported manifests remain reported evidence; artifact-corroborated is reserved for a future authenticated or witnessed producer lane",
    "repository policy text is bounded local evidence, not executable code"
  ];
}

function formatSnapshot(snapshot: ProveData["snapshot"]): string {
  if (snapshot.status === "loaded") {
    const origin = snapshot.origin ? `; ${snapshot.origin}` : "";
    const created = snapshot.createdAt ? `; ${snapshot.createdAt}` : "";
    return `loaded ${snapshot.taskId ?? "latest"}${origin}${created}`;
  }
  return `${snapshot.status}${snapshot.reason ? ` (${snapshot.reason})` : ""}`;
}

function formatReadFirst(files: ProveData["readFirst"]): string[] {
  if (files.length === 0) {
    return ["- none selected"];
  }
  return files.map((file) => {
    const rank = file.rank === undefined ? "" : `; rank ${file.rank.toFixed(2)}`;
    const risk = file.riskScore === undefined ? "" : `; risk ${file.riskScore.toFixed(1)}`;
    return `- ${file.path}${rank}${risk}`;
  });
}

function formatCommands(commands: string[]): string[] {
  if (commands.length === 0) {
    return ["- none inferred; run codexa test-plan after choosing an edit target"];
  }
  return commands.slice(0, 12).map((command) => `- ${command}`);
}

function formatReportedEvidence(reported: ProveReportedVerification): string[] {
  if (!reported.hasEvidence) {
    return ["- none supplied; pass --ran-command, --ran-test, --ran-command-report, --waive-check, or --waiver after verification runs"];
  }
  const lines = [
    ...reported.ranTests.slice(0, 12).map((test) => `- ran test: ${test}`),
    ...reported.ranCommands.slice(0, 12).map((command) => `- ran command: ${command}`),
    ...reported.ranCommandReports.slice(0, 12).map((report) => `- command report: ${formatCommandReport(report)}`),
    ...reported.waivedChecks.slice(0, 12).map((target) => `- legacy waiver: ${target}`),
    ...reported.waivers.slice(0, 12).map((waiver) => `- waiver: ${waiver.kind} ${waiver.target}; ${waiver.reason}`)
  ];
  return lines.length > 0 ? lines : ["- evidence supplied, but no displayable entries after sanitization"];
}

function formatReportedLedger(reported: ProveReportedVerification): string[] {
  if (!reported.hasEvidence && reported.ledger.length === 0) {
    return ["- none; preview above shows what reported commands would need to cover"];
  }
  return formatVerificationLedger(reported.ledger);
}

function formatVerificationArtifacts(artifacts: VerificationArtifactSummary[]): string[] {
  if (artifacts.length === 0) {
    return ["- none selected"];
  }
  return artifacts.slice(0, 20).map((artifact) => {
    const run = artifact.runId ? `; run ${artifact.runId} ${artifact.outcome ?? "unknown"}` : "";
    const reasons = artifact.reasons.length > 0 ? `; ${artifact.reasons.slice(0, 3).join(" | ")}` : "";
    return `- ${artifact.status}: ${artifact.artifactId}${run}; trust ${artifact.trustTier}${reasons}`;
  });
}

function formatDecisionLog(decisionLog: ProveDecisionLog): string[] {
  if (decisionLog.status !== "loaded") {
    return [`- ${decisionLog.status}${decisionLog.warnings.length > 0 ? `: ${decisionLog.warnings.join("; ")}` : ""}`];
  }
  const counts = `decisions ${decisionLog.decisions.length}; ruled out ${decisionLog.ruledOut.length}; constraints ${decisionLog.constraints.length}; verification ${decisionLog.verification.length}; open questions ${decisionLog.openQuestions.length}`;
  const revisions = `revision ${decisionLog.baselineRevision ?? "unknown"} -> ${decisionLog.currentRevision ?? "unknown"}`;
  const baseline = decisionLog.baselineIntact === false ? "baseline entries missing" : "baseline intact";
  const entries = [...decisionLog.constraints, ...decisionLog.decisions, ...decisionLog.ruledOut, ...decisionLog.verification, ...decisionLog.openQuestions]
    .slice(0, 8)
    .map((entry) => `- ${entry.kind} (${entry.provenance}): ${entry.summary}`);
  return [`- session ${decisionLog.sessionId ?? "unknown"}; ${revisions}; ${baseline}; ${counts}`, ...entries];
}

function formatCommandReport(report: VerificationCommandReport): string {
  const status = report.exitCode === undefined ? "exit unknown" : `exit ${report.exitCode}`;
  const cwd = report.cwd ? `; cwd ${report.cwd}` : "";
  const duration = report.durationMs === undefined ? "" : `; ${report.durationMs}ms`;
  const summary = report.outputSummary ?? report.stderrSummary ?? report.stdoutSummary;
  return `${report.command} (${status}${cwd}${duration}${summary ? `; ${summary}` : ""})`;
}

function formatPolicies(policies: PolicyPackSummary): string[] {
  const lines = policies.policies.flatMap((policy) => [
    `- ${policy.kind}: ${policy.purpose}`,
    ...policy.rules.slice(0, 3).map((rule) => `  - ${rule}`)
  ]);
  if (policies.missing.length > 0) {
    lines.push(`- missing policy files: ${policies.missing.map((kind) => `${kind}.json`).join(", ")}; run codexa policy-init <repo>`);
  }
  if (policies.warnings.length > 0) {
    lines.push(...policies.warnings.map((warning) => `- warning: ${warning}`));
  }
  return lines.length > 0 ? lines : ["- no local policy pack present; run codexa policy-init <repo>"];
}

function formatGaps(gaps: string[]): string[] {
  return gaps.length > 0 ? gaps.slice(0, 20).map((gap) => `- ${gap}`) : ["- none detected in the proof card inputs"];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}
