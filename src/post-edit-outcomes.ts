import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { acquireCacheLock } from "./cache-lock.js";
import { assertSafeManagedDirectory, assertSafeManagedFile, ensureSafeManagedStateDirectory } from "./init-portability.js";
import {
  isCompletionBearingPostEditReviewCoverage,
  postEditReviewCoverageDigest,
  validatePostEditReviewCoverage
} from "./post-edit-review-coverage.js";
import { CURRENT_VERIFICATION_PROVENANCE } from "./types.js";
import type { AutoVerifyReportRunner } from "./autoverify.js";
import type {
  Confidence,
  FreshnessInfo,
  TaskSnapshotRequiredCheck,
  TestRecommendation,
  VerificationCommandEnvelope,
  VerificationCommandReport,
  VerificationCoverage,
  VerificationLedgerEntry,
  VerificationLedgerStatus,
  VerificationProvenance,
  VerificationTrustTier,
  VerificationWaiver,
  SessionMemoryPointer,
  DiffFootprintV1,
  TaskInvariant,
  TaskInvariantReview,
  TaskLoopFailureSignal,
  TaskLoopReview,
  VerificationArtifactSummary,
  PostEditReviewCoverage
} from "./types.js";
import { stableId } from "./util.js";
import { exactWorkspaceContentDigest, exactWorkspaceStateDigest, workspaceStateDigest } from "./workspace-state.js";

type OutcomeCommandReport = VerificationCommandReport & { runner?: AutoVerifyReportRunner };

const OUTCOME_DIR = ".codex/cache/codexa-outcomes";
const OUTCOME_WRITE_LOCK_DIR = ".codex/cache/codexa-outcomes-write.lock";
const LATEST_FILE = "latest.json";
const LATEST_HOOK_REVIEW_FILE = "latest-hook-review.json";
const HOOK_EVENT_DIR = ".codex/cache/codexa-hooks";
const HOOK_EVENT_WRITE_LOCK_DIR = ".codex/cache/codexa-hooks-write.lock";
const HOOK_EVENTS_FILE = "events.ndjson";
const LATEST_HOOK_EVENT_FILE = "latest.json";
const MAX_HOOK_EVENTS_BYTES = 512 * 1024;
const MAX_HOOK_EVENT_LINES = 200;

export type PostEditVerdict = "continue" | "run_tests" | "inspect" | "replan";
export type PostEditInspectMode = "none" | "advisory" | "blocking";
export type PostEditCompletionAuthority = "complete" | "tests_required" | "advisory_inspect" | "blocking_inspect" | "replan_required";
export type CodexaHookName = "session-start" | "pre-edit" | "post-edit";
export type CodexaHookEventStatus = "ok" | "skipped" | "failed";

export interface PostEditOutcomeInput {
  repoRoot: string;
  task: string;
  taskId?: string;
  snapshotPath?: string;
  snapshotCreatedAt?: string;
  snapshotPublicationSequence?: number;
  verdict: PostEditVerdict;
  inspectMode: PostEditInspectMode;
  inspectReasons: string[];
  completionAuthority: PostEditCompletionAuthority;
  freshness: FreshnessInfo;
  planRevision: number;
  invariants: TaskInvariant[];
  invariantReviews: TaskInvariantReview[];
  failureSignals: TaskLoopFailureSignal[];
  diffFootprint: DiffFootprintV1;
  loopReview: TaskLoopReview;
  changedFiles: string[];
  plannedEditTargets: string[];
  reviewTargets: string[];
  reviewCandidateTargets: string[];
  reviewCoverage: PostEditReviewCoverage;
  unplannedEditedFiles: string[];
  unindexedEditedFiles: string[];
  modifiedSymbols: string[];
  modifiedPublicSymbols: string[];
  affectedWorkflows: string[];
  workflowChecks: PostEditCheckResult[];
  dependencyChecks: PostEditCheckResult[];
	  driftReasons: string[];
	  tests: TestRecommendation[];
	  degradedSnapshotTests?: TestRecommendation[];
	  testsNotRun: TestRecommendation[];
  missedLikelyTests: TestRecommendation[];
  ranTests: string[];
  ranCommands: string[];
  ranCommandReports: OutcomeCommandReport[];
  commandEnvelopes: VerificationCommandEnvelope[];
  waivedChecks: string[];
  waivers: VerificationWaiver[];
  verificationCoverage: VerificationCoverage[];
  verificationLedger: VerificationLedgerEntry[];
  verificationArtifacts: VerificationArtifactSummary[];
  verificationProvenance?: VerificationProvenance;
  sessionMemory?: SessionMemoryPointer;
  riskDeltas: PostEditRiskDelta[];
  quality?: { level?: unknown; counts?: unknown };
  confidence?: {
    authoritative: number;
    derived: number;
    heuristic: number;
    fallback: number;
  };
}

export interface PostEditCheckResult extends TaskSnapshotRequiredCheck {
  status: Extract<VerificationLedgerStatus, "covered" | "missing" | "not_applicable">;
  trustTier: VerificationTrustTier;
}

export interface PostEditRiskDelta {
  path: string;
  beforeRisk: number;
  afterRisk: number;
  delta: number;
}

export interface PostEditHookSummary {
  verdict: PostEditVerdict;
  changedFiles: number;
  unplannedEditedFiles: number;
  modifiedSymbols: number;
  missedLikelyTests: number;
  riskIncreases: number;
  requiredChecksMissing: number;
  nextAction: string;
}

export interface PostEditOutcome {
  schemaVersion: 1;
  outcomeId: string;
  createdAt: string;
  repoRoot: string;
  task: string;
  taskId?: string;
  snapshotPath?: string;
  snapshotCreatedAt?: string;
  snapshotPublicationSequence?: number;
  verdict: PostEditVerdict;
  inspectMode: PostEditInspectMode;
  inspectReasons: string[];
  completionAuthority: PostEditCompletionAuthority;
  headCommit: string | null;
  indexSnapshotId: string;
  workspaceStateDigest: string;
  /** Optional only for legacy or non-exact outcomes. */
  workspaceContentDigest?: string;
  planRevision?: number;
  invariants?: TaskInvariant[];
  invariantReviews?: TaskInvariantReview[];
  failureSignals?: TaskLoopFailureSignal[];
  diffFootprint?: DiffFootprintV1;
  loopReview?: TaskLoopReview;
  changedFiles: string[];
  plannedEditTargets: string[];
  reviewTargets: string[];
  /**
   * Optional only for reading legacy schema-v1 records. New outcomes always
   * persist this authority receipt.
   */
  reviewCoverage?: PostEditReviewCoverage;
  unplannedEditedFiles: string[];
  unindexedEditedFiles: string[];
  modifiedSymbols: string[];
  modifiedPublicSymbols: string[];
  affectedWorkflows: string[];
  workflowChecks: PostEditCheckResult[];
  dependencyChecks: PostEditCheckResult[];
	  driftReasons: string[];
	  recommendedTests: Array<Pick<TestRecommendation, "path" | "reason" | "rank" | "evidenceTier" | "command" | "commandSource" | "commandConfidence" | "provenance">>;
	  degradedSnapshotTests: Array<Pick<TestRecommendation, "path" | "reason" | "rank" | "evidenceTier" | "command" | "commandSource" | "commandConfidence" | "provenance">>;
	  testsNotRun: Array<Pick<TestRecommendation, "path" | "reason" | "rank" | "evidenceTier" | "command" | "commandSource" | "commandConfidence" | "provenance">>;
  missedLikelyTests: Array<Pick<TestRecommendation, "path" | "reason" | "rank" | "evidenceTier" | "command" | "commandSource" | "commandConfidence" | "provenance">>;
  ranTests: string[];
  ranCommands: string[];
  ranCommandReports: OutcomeCommandReport[];
  commandEnvelopes: VerificationCommandEnvelope[];
  waivedChecks: string[];
  waivers: VerificationWaiver[];
  verificationCoverage: VerificationCoverage[];
  verificationLedger: VerificationLedgerEntry[];
  verificationArtifacts?: VerificationArtifactSummary[];
  verificationProvenance: VerificationProvenance;
  sessionMemory?: SessionMemoryPointer;
  riskDeltas: PostEditRiskDelta[];
  hookSummary: PostEditHookSummary;
  qualityLevel?: string;
  confidence?: Record<Confidence | "fallback", number>;
  calibrationLabels: string[];
}

interface LatestPostEditOutcomePointer {
  schemaVersion: 1;
  outcomeId: string;
  path: string;
  createdAt: string;
  verdict: PostEditVerdict;
  completionAuthority: PostEditCompletionAuthority;
  taskId?: string;
  planRevision: number;
  snapshotCreatedAt?: string;
  snapshotPublicationSequence?: number;
  headCommit: string | null;
  indexSnapshotId: string;
  workspaceStateDigest: string;
  workspaceContentDigest?: string;
  reviewCoverageDigest: string;
}

export interface PostEditHookReviewState {
  schemaVersion: 1;
  signature: string;
  createdAt: string;
  outcomeId?: string;
  taskId?: string;
  verdict?: PostEditVerdict;
  autoVerifyStatus?: "off" | "covered" | "skipped" | "failed" | "non_covering";
}

export interface CodexaHookEventInput {
  hook: CodexaHookName;
  status: CodexaHookEventStatus;
  durationMs: number;
  reason?: string;
  taskId?: string;
  verdict?: PostEditVerdict;
  outcomeId?: string;
  signature?: string;
  error?: string;
}

export interface CodexaHookEvent extends CodexaHookEventInput {
  schemaVersion: 1;
  createdAt: string;
  repoRoot: ".";
}

export function buildPostEditOutcome(
  input: PostEditOutcomeInput,
  createdAt = new Date().toISOString(),
  outcomeIdNonce?: string
): PostEditOutcome {
  const repoRoot = path.resolve(input.repoRoot);
  const coverageValidation = validatePostEditReviewCoverage(input.reviewCoverage, {
    taskId: input.taskId ?? null,
    planRevision: input.planRevision,
    snapshotCreatedAt: input.snapshotCreatedAt ?? null,
    snapshotPublicationSequence: input.snapshotPublicationSequence ?? null,
    candidateTargets: input.reviewCandidateTargets,
    analyzedTargets: input.reviewTargets
  });
  if (!coverageValidation.valid) throw new Error(`refusing to build post-edit outcome with invalid review coverage: ${coverageValidation.reason}`);
  const outcomeId = stableOutcomeId(repoRoot, input, createdAt, outcomeIdNonce);
  return {
    schemaVersion: 1,
    outcomeId,
    createdAt,
    repoRoot: ".",
    task: input.task,
    taskId: input.taskId,
    snapshotPath: input.snapshotPath,
    snapshotCreatedAt: input.snapshotCreatedAt,
    snapshotPublicationSequence: input.snapshotPublicationSequence,
    verdict: input.verdict,
    inspectMode: input.inspectMode,
    inspectReasons: input.inspectReasons,
    completionAuthority: input.completionAuthority,
    headCommit: input.freshness.headCommit,
    indexSnapshotId: input.freshness.snapshotId,
    workspaceStateDigest: workspaceStateDigest(input.freshness),
    planRevision: input.planRevision,
    invariants: input.invariants,
    invariantReviews: input.invariantReviews.map((review) => ({
      ...review,
      evidence: review.evidence.map((entry) => sanitizeText(entry, repoRoot) ?? "").filter(Boolean)
    })),
    failureSignals: input.failureSignals.map((signal) => ({
      ...signal,
      targets: signal.targets.map((target) => sanitizeText(target, repoRoot) ?? "").filter(Boolean)
    })),
    diffFootprint: input.diffFootprint,
    loopReview: input.loopReview,
    changedFiles: input.changedFiles,
    plannedEditTargets: input.plannedEditTargets,
    reviewTargets: input.reviewTargets,
    reviewCoverage: input.reviewCoverage,
    unplannedEditedFiles: input.unplannedEditedFiles,
    unindexedEditedFiles: input.unindexedEditedFiles,
    modifiedSymbols: input.modifiedSymbols,
    modifiedPublicSymbols: input.modifiedPublicSymbols,
    affectedWorkflows: input.affectedWorkflows,
    workflowChecks: input.workflowChecks,
    dependencyChecks: input.dependencyChecks,
	    driftReasons: input.driftReasons,
	    recommendedTests: compactTests(input.tests, repoRoot),
	    degradedSnapshotTests: compactTests(input.degradedSnapshotTests ?? [], repoRoot),
	    testsNotRun: compactTests(input.testsNotRun, repoRoot),
    missedLikelyTests: compactTests(input.missedLikelyTests, repoRoot),
    ranTests: input.ranTests.map((test) => sanitizeText(test, repoRoot) ?? ""),
    ranCommands: input.ranCommands.map((command) => sanitizeText(command, repoRoot) ?? ""),
    ranCommandReports: compactCommandReports(input.ranCommandReports, repoRoot),
    commandEnvelopes: compactCommandEnvelopes(input.commandEnvelopes, repoRoot),
    waivedChecks: input.waivedChecks.map((check) => sanitizeText(check, repoRoot) ?? ""),
    waivers: compactWaivers(input.waivers, repoRoot),
    verificationCoverage: compactCoverage(input.verificationCoverage, repoRoot),
    verificationLedger: compactLedger(input.verificationLedger, repoRoot),
    verificationArtifacts: input.verificationArtifacts,
    verificationProvenance: input.verificationProvenance ?? CURRENT_VERIFICATION_PROVENANCE,
    sessionMemory: input.sessionMemory,
    riskDeltas: input.riskDeltas,
    hookSummary: hookSummary(input),
    qualityLevel: typeof input.quality?.level === "string" ? input.quality.level : undefined,
    confidence: input.confidence,
    calibrationLabels: calibrationLabels(input)
  };
}

export async function savePostEditOutcome(input: PostEditOutcomeInput): Promise<{ outcome: PostEditOutcome; path: string; relativePath: string }> {
  const repoRoot = path.resolve(input.repoRoot);
  const release = await acquireCacheLock({ repoRoot, lockDir: OUTCOME_WRITE_LOCK_DIR, label: "Codexa post-edit outcomes" });
  try {
    const createdAt = new Date().toISOString();
    const outcome = buildPostEditOutcome(input, createdAt, randomUUID());
    // Persist the stricter completion identity when the checkout can be observed
    // exactly. The legacy content-only digest remains useful for ordinary outcome
    // records, but completion probes will never trust it as a skip authority.
    outcome.workspaceContentDigest = (await exactWorkspaceContentDigest(repoRoot, input.freshness)) ?? undefined;
    outcome.workspaceStateDigest = (await exactWorkspaceStateDigest(repoRoot, input.freshness)) ?? outcome.workspaceStateDigest;
    const dir = await ensureSafeManagedStateDirectory(repoRoot, "cache", "codexa-outcomes");
    const outcomePath = path.join(dir, `${outcome.outcomeId}.json`);
    const latestPath = path.join(dir, LATEST_FILE);
    const reviewCoverageDigest = postEditReviewCoverageDigest(outcome.reviewCoverage);
    if (!reviewCoverageDigest) throw new Error("refusing to save post-edit outcome with invalid review coverage");
    await assertSafeManagedFile(outcomePath);
    await assertSafeManagedFile(latestPath);
    await atomicJsonWrite(outcomePath, outcome);
    await atomicJsonWrite(latestPath, {
      schemaVersion: 1,
      outcomeId: outcome.outcomeId,
      path: path.basename(outcomePath),
      createdAt,
      verdict: outcome.verdict,
      completionAuthority: outcome.completionAuthority,
      taskId: outcome.taskId,
      planRevision: outcome.planRevision ?? 1,
      snapshotCreatedAt: outcome.snapshotCreatedAt,
      snapshotPublicationSequence: outcome.snapshotPublicationSequence,
      headCommit: outcome.headCommit,
      indexSnapshotId: outcome.indexSnapshotId,
      workspaceStateDigest: outcome.workspaceStateDigest,
      ...(outcome.workspaceContentDigest ? { workspaceContentDigest: outcome.workspaceContentDigest } : {}),
      reviewCoverageDigest
    } satisfies LatestPostEditOutcomePointer);
    return { outcome, path: outcomePath, relativePath: path.posix.join(OUTCOME_DIR, `${outcome.outcomeId}.json`) };
  } finally {
    await release();
  }
}

/**
 * A completion hook may skip only when the latest persisted non-blocking review
 * names this exact plan revision and the current checkout is byte-identical to
 * the state that review authorized. The pointed outcome is revalidated so a
 * torn or hand-edited latest pointer never suppresses a real review.
 */
export async function latestCompletedPostEditReviewMatches(input: {
  repoRoot: string;
  freshness: FreshnessInfo;
  taskId: string;
  planRevision: number;
  snapshotCreatedAt?: string;
  snapshotPublicationSequence?: number;
}): Promise<boolean> {
  if (!workspaceStateSupportsExactIdentity(input.freshness)) {
    return false;
  }
  const repoRoot = path.resolve(input.repoRoot);
  const dir = path.join(repoRoot, OUTCOME_DIR);
  let pointer: LatestPostEditOutcomePointer;
  let outcome: Partial<PostEditOutcome>;
  try {
    const parsedPointer = JSON.parse(await fs.readFile(path.join(dir, LATEST_FILE), "utf8")) as unknown;
    if (!isLatestPostEditOutcomePointer(parsedPointer)) {
      return false;
    }
    pointer = parsedPointer;
    if (pointer.path !== `${pointer.outcomeId}.json` || path.basename(pointer.path) !== pointer.path) {
      return false;
    }
    outcome = JSON.parse(await fs.readFile(path.join(dir, pointer.path), "utf8")) as Partial<PostEditOutcome>;
  } catch {
    return false;
  }
  if (pointer.completionAuthority !== "complete" && pointer.completionAuthority !== "advisory_inspect") {
    return false;
  }
  const currentDigest = await exactWorkspaceStateDigest(repoRoot, input.freshness);
  if (!currentDigest) {
    return false;
  }
  const authorityMatches =
    pointer.taskId === input.taskId &&
    pointer.planRevision === input.planRevision &&
    pointer.snapshotCreatedAt === input.snapshotCreatedAt &&
    pointer.snapshotPublicationSequence === input.snapshotPublicationSequence &&
    outcome.schemaVersion === 1 &&
    outcome.outcomeId === pointer.outcomeId &&
    outcome.createdAt === pointer.createdAt &&
    outcome.repoRoot === "." &&
    outcome.verdict === pointer.verdict &&
    outcome.taskId === pointer.taskId &&
    outcome.planRevision === pointer.planRevision &&
    outcome.snapshotCreatedAt === pointer.snapshotCreatedAt &&
    outcome.snapshotPublicationSequence === pointer.snapshotPublicationSequence &&
    outcome.completionAuthority === pointer.completionAuthority &&
    Array.isArray(outcome.reviewTargets) &&
    outcome.reviewTargets.every((target) => typeof target === "string") &&
    isCompletionBearingPostEditReviewCoverage(outcome.reviewCoverage, {
      taskId: outcome.taskId ?? null,
      planRevision: outcome.planRevision ?? 0,
      snapshotCreatedAt: outcome.snapshotCreatedAt ?? null,
      snapshotPublicationSequence: outcome.snapshotPublicationSequence ?? null,
      analyzedTargets: outcome.reviewTargets
    }) &&
    postEditReviewCoverageDigest(outcome.reviewCoverage) === pointer.reviewCoverageDigest &&
    outcome.headCommit === pointer.headCommit &&
    outcome.indexSnapshotId === pointer.indexSnapshotId &&
    outcome.workspaceStateDigest === pointer.workspaceStateDigest &&
    outcome.workspaceContentDigest === pointer.workspaceContentDigest;
  if (!authorityMatches) return false;

  const exactReviewedState =
    pointer.headCommit === input.freshness.headCommit &&
    pointer.indexSnapshotId === input.freshness.snapshotId &&
    pointer.workspaceStateDigest === currentDigest;
  if (exactReviewedState) return true;

  // A normal human workflow commits the exact workspace authorized by the
  // review and then reopens Codexa from the clean successor commit. Preserve
  // completion only for that content-equivalent transition. Dirty successors,
  // legacy outcomes without the stronger digest, and any added/removed/mode-
  // changed path continue to fail closed.
  if (input.freshness.dirtyFiles.length > 0 || !pointer.workspaceContentDigest) return false;
  const currentContentDigest = await exactWorkspaceContentDigest(repoRoot, input.freshness);
  return currentContentDigest !== null && currentContentDigest === pointer.workspaceContentDigest;
}

export function postEditHookReviewSignature(input: { freshness: FreshnessInfo; taskId?: string; autoVerifyMode?: string }): string {
  return createHash("sha1")
    .update(
      JSON.stringify({
        taskId: input.taskId ?? null,
        autoVerifyMode: input.autoVerifyMode ?? "autoverify:off",
        snapshotId: input.freshness.snapshotId,
        indexedAt: input.freshness.indexedAt,
        headCommit: input.freshness.headCommit,
        dirtyFiles: input.freshness.dirtyFiles,
        dirtyFileHashes: input.freshness.dirtyFileHashes
      })
    )
    .digest("hex");
}

export async function loadPostEditHookReviewState(repoRoot: string): Promise<PostEditHookReviewState | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(path.join(path.resolve(repoRoot), OUTCOME_DIR, LATEST_HOOK_REVIEW_FILE), "utf8")) as Partial<PostEditHookReviewState>;
    if (parsed.schemaVersion === 1 && typeof parsed.signature === "string" && typeof parsed.createdAt === "string") {
      return {
        schemaVersion: 1,
        signature: parsed.signature,
        createdAt: parsed.createdAt,
        outcomeId: typeof parsed.outcomeId === "string" ? parsed.outcomeId : undefined,
        taskId: typeof parsed.taskId === "string" ? parsed.taskId : undefined,
        verdict: isPostEditVerdict(parsed.verdict) ? parsed.verdict : undefined,
        autoVerifyStatus: isAutoVerifyStatus(parsed.autoVerifyStatus) ? parsed.autoVerifyStatus : undefined
      };
    }
  } catch {
    return null;
  }
  return null;
}

export async function savePostEditHookReviewState(repoRoot: string, input: { signature: string; outcome?: PostEditOutcome; autoVerifyStatus?: PostEditHookReviewState["autoVerifyStatus"] }): Promise<void> {
  const repo = path.resolve(repoRoot);
  const release = await acquireCacheLock({ repoRoot: repo, lockDir: OUTCOME_WRITE_LOCK_DIR, label: "Codexa post-edit outcomes" });
  try {
    const dir = await ensureSafeManagedStateDirectory(repo, "cache", "codexa-outcomes");
    const reviewPath = path.join(dir, LATEST_HOOK_REVIEW_FILE);
    await assertSafeManagedFile(reviewPath);
    await atomicJsonWrite(reviewPath, {
      schemaVersion: 1,
      signature: input.signature,
      createdAt: new Date().toISOString(),
      outcomeId: input.outcome?.outcomeId,
      taskId: input.outcome?.taskId,
      verdict: input.outcome?.verdict,
      autoVerifyStatus: input.autoVerifyStatus
    });
  } finally {
    await release();
  }
}

export async function recordCodexaHookEvent(repoRoot: string, input: CodexaHookEventInput): Promise<void> {
  const repo = path.resolve(repoRoot);
  const dir = await prepareHookEventDirectory(repo);
  if (!dir) return;
  const release = await acquireCacheLock({ repoRoot: repo, lockDir: HOOK_EVENT_WRITE_LOCK_DIR, label: "Codexa hook events" });
  try {
    const event = compactHookEvent(repo, input);
    const eventsPath = path.join(dir, HOOK_EVENTS_FILE);
    const latestPath = path.join(dir, LATEST_HOOK_EVENT_FILE);
    await assertSafeManagedFile(eventsPath);
    await assertSafeManagedFile(latestPath);
    await trimHookEventsIfNeeded(eventsPath);
    await fs.appendFile(eventsPath, `${JSON.stringify(event)}\n`, "utf8");
    await atomicJsonWrite(latestPath, event);
  } finally {
    await release();
  }
}

export async function loadLatestCodexaHookEvent(repoRoot: string): Promise<CodexaHookEvent | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(path.join(path.resolve(repoRoot), HOOK_EVENT_DIR, LATEST_HOOK_EVENT_FILE), "utf8")) as Partial<CodexaHookEvent>;
    if (
      parsed.schemaVersion === 1 &&
      parsed.repoRoot === "." &&
      isHookName(parsed.hook) &&
      isHookEventStatus(parsed.status) &&
      typeof parsed.createdAt === "string" &&
      typeof parsed.durationMs === "number"
    ) {
      return {
        schemaVersion: 1,
        createdAt: parsed.createdAt,
        repoRoot: ".",
        hook: parsed.hook,
        status: parsed.status,
        durationMs: parsed.durationMs,
        reason: typeof parsed.reason === "string" ? parsed.reason : undefined,
        taskId: typeof parsed.taskId === "string" ? parsed.taskId : undefined,
        verdict: isPostEditVerdict(parsed.verdict) ? parsed.verdict : undefined,
        outcomeId: typeof parsed.outcomeId === "string" ? parsed.outcomeId : undefined,
        signature: typeof parsed.signature === "string" ? parsed.signature : undefined,
        error: typeof parsed.error === "string" ? parsed.error : undefined
      };
    }
  } catch {
    return null;
  }
  return null;
}

export function codexaHookEventsRelativePath(): string {
  return path.posix.join(HOOK_EVENT_DIR, HOOK_EVENTS_FILE);
}

function stableOutcomeId(
  repoRoot: string,
  input: PostEditOutcomeInput,
  createdAt: string,
  outcomeIdNonce?: string
): string {
  const task = (input.taskId ?? input.task).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "post-edit";
  const suffix = stableId(
    "post-edit-outcome",
    repoRoot,
    input.taskId,
    input.task,
    input.verdict,
    input.changedFiles.join("\n"),
    createdAt,
    outcomeIdNonce
  );
  return `${task}-${createdAt.replace(/[-:TZ.]/g, "").slice(0, 14)}-${suffix}`.slice(0, 120);
}

function isPostEditVerdict(value: unknown): value is PostEditVerdict {
  return value === "continue" || value === "run_tests" || value === "inspect" || value === "replan";
}

function isPostEditCompletionAuthority(value: unknown): value is PostEditCompletionAuthority {
  return value === "complete" || value === "tests_required" || value === "advisory_inspect" || value === "blocking_inspect" || value === "replan_required";
}

function isLatestPostEditOutcomePointer(value: unknown): value is LatestPostEditOutcomePointer {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Partial<LatestPostEditOutcomePointer>;
  return (
    record.schemaVersion === 1 &&
    typeof record.outcomeId === "string" &&
    typeof record.path === "string" &&
    typeof record.createdAt === "string" &&
    isPostEditVerdict(record.verdict) &&
    isPostEditCompletionAuthority(record.completionAuthority) &&
    (record.taskId === undefined || typeof record.taskId === "string") &&
    Number.isInteger(record.planRevision) &&
    (record.planRevision ?? 0) > 0 &&
    (record.snapshotCreatedAt === undefined || typeof record.snapshotCreatedAt === "string") &&
    (record.snapshotPublicationSequence === undefined || (Number.isInteger(record.snapshotPublicationSequence) && (record.snapshotPublicationSequence ?? 0) > 0)) &&
    (record.headCommit === null || typeof record.headCommit === "string") &&
    typeof record.indexSnapshotId === "string" &&
    /^[a-f0-9]{64}$/u.test(record.workspaceStateDigest ?? "") &&
    (record.workspaceContentDigest === undefined || /^[a-f0-9]{64}$/u.test(record.workspaceContentDigest)) &&
    /^[a-f0-9]{16}$/u.test(record.reviewCoverageDigest ?? "")
  );
}

function workspaceStateSupportsExactIdentity(freshness: FreshnessInfo): boolean {
  if (freshness.missing || (freshness.degradedGitState?.length ?? 0) > 0) {
    return false;
  }
  const dirtyFiles = [...new Set(freshness.dirtyFiles)].sort();
  const hashedFiles = Object.keys(freshness.dirtyFileHashes).sort();
  if (dirtyFiles.length !== hashedFiles.length || dirtyFiles.some((file, index) => file !== hashedFiles[index])) {
    return false;
  }
  // Ordinary files use content SHA-1; a deleted path uses the stable `missing`
  // sentinel. Metadata/unreadable/non-file fallbacks are deliberately not
  // strong enough to suppress a later review.
  return Object.values(freshness.dirtyFileHashes).every((digest) => digest === "missing" || /^[a-f0-9]{40}$/u.test(digest));
}

function isHookName(value: unknown): value is CodexaHookName {
  return value === "session-start" || value === "pre-edit" || value === "post-edit";
}

function isHookEventStatus(value: unknown): value is CodexaHookEventStatus {
  return value === "ok" || value === "skipped" || value === "failed";
}

function isAutoVerifyStatus(value: unknown): value is NonNullable<PostEditHookReviewState["autoVerifyStatus"]> {
  return value === "off" || value === "covered" || value === "skipped" || value === "failed" || value === "non_covering";
}

function compactHookEvent(repoRoot: string, input: CodexaHookEventInput): CodexaHookEvent {
  return {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    repoRoot: ".",
    hook: input.hook,
    status: input.status,
    durationMs: Math.max(0, Math.round(input.durationMs)),
    reason: sanitizeText(input.reason, repoRoot),
    taskId: sanitizeText(input.taskId, repoRoot),
    verdict: input.verdict,
    outcomeId: sanitizeText(input.outcomeId, repoRoot),
    signature: sanitizeText(input.signature, repoRoot),
    error: sanitizeText(input.error, repoRoot)
  };
}

async function trimHookEventsIfNeeded(eventsPath: string): Promise<void> {
  try {
    const stat = await fs.stat(eventsPath);
    if (stat.size < MAX_HOOK_EVENTS_BYTES) {
      return;
    }
    const text = await fs.readFile(eventsPath, "utf8");
    const lines = text.split(/\r?\n/u).filter(Boolean).slice(-MAX_HOOK_EVENT_LINES);
    await fs.writeFile(eventsPath, `${lines.join("\n")}\n`, "utf8");
  } catch {
    return;
  }
}

async function prepareHookEventDirectory(repoRoot: string): Promise<string | null> {
  const codexDir = path.join(repoRoot, ".codex");
  try {
    await fs.lstat(codexDir);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return null;
    throw error;
  }
  await assertSafeManagedDirectory(codexDir);
  return ensureSafeManagedStateDirectory(repoRoot, "cache", "codexa-hooks");
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function compactTests(tests: TestRecommendation[], repoRoot: string): PostEditOutcome["recommendedTests"] {
  return tests.map((test) => ({
    path: test.path,
    reason: test.reason,
    rank: test.rank,
    evidenceTier: test.evidenceTier,
    command: test.command?.replaceAll(repoRoot, "<repo>"),
    commandSource: test.commandSource,
    commandConfidence: test.commandConfidence,
    provenance: test.provenance
  }));
}

function compactCoverage(coverage: VerificationCoverage[], repoRoot: string): VerificationCoverage[] {
  return coverage.map((entry) => ({
    ...entry,
    command: sanitizeText(entry.command, repoRoot) ?? "",
    source: sanitizeText(entry.source, repoRoot) ?? entry.source,
    scope: sanitizePathField(entry.scope, repoRoot),
    targetPath: sanitizePathField(entry.targetPath, repoRoot),
    details: entry.details.map((detail) => sanitizeText(detail, repoRoot) ?? "").filter(Boolean),
    outputSummary: sanitizeText(entry.outputSummary, repoRoot),
    commandEnvelope: entry.commandEnvelope ? compactCommandEnvelopes([entry.commandEnvelope], repoRoot)[0] : undefined
  }));
}

function compactCommandReports(reports: OutcomeCommandReport[], repoRoot: string): OutcomeCommandReport[] {
  return reports.map((report) => ({
    ...report,
    command: sanitizeText(report.command, repoRoot) ?? "",
    cwd: sanitizePathField(report.cwd, repoRoot),
    packageManager: sanitizeText(report.packageManager, repoRoot),
    workspace: sanitizeText(report.workspace, repoRoot),
    packageRoot: sanitizePathField(report.packageRoot, repoRoot),
    packageName: sanitizeText(report.packageName, repoRoot),
    scriptName: sanitizeText(report.scriptName, repoRoot),
    stdoutSummary: sanitizeText(report.stdoutSummary, repoRoot),
    stderrSummary: sanitizeText(report.stderrSummary, repoRoot),
    outputSummary: sanitizeText(report.outputSummary, repoRoot),
    args: sanitizeArgs(report.args, repoRoot),
    runner: compactRunner(report.runner, repoRoot)
  }));
}

function compactRunner(runner: AutoVerifyReportRunner | undefined, repoRoot: string): AutoVerifyReportRunner | undefined {
  if (!runner) {
    return undefined;
  }
  return {
    ...runner,
    cwdRealpath: sanitizePathField(runner.cwdRealpath, repoRoot) ?? runner.cwdRealpath,
    targetRealpaths: runner.targetRealpaths.map((target) => sanitizePathField(target, repoRoot) ?? target),
    allowedBy: runner.allowedBy.map((reason) => sanitizeText(reason, repoRoot) ?? reason),
    skippedReason: sanitizeText(runner.skippedReason, repoRoot)
  };
}

function compactCommandEnvelopes(envelopes: VerificationCommandEnvelope[], repoRoot: string): VerificationCommandEnvelope[] {
  return envelopes.map((envelope) => ({
    ...envelope,
    command: sanitizeText(envelope.command, repoRoot) ?? "",
    cwd: sanitizePathField(envelope.cwd, repoRoot),
    packageManager: sanitizeText(envelope.packageManager, repoRoot),
    workspace: sanitizeText(envelope.workspace, repoRoot),
    packageRoot: sanitizePathField(envelope.packageRoot, repoRoot),
    packageName: sanitizeText(envelope.packageName, repoRoot),
    scriptName: sanitizeText(envelope.scriptName, repoRoot),
    stdoutSummary: sanitizeText(envelope.stdoutSummary, repoRoot),
    stderrSummary: sanitizeText(envelope.stderrSummary, repoRoot),
    outputSummary: sanitizeText(envelope.outputSummary, repoRoot),
    args: sanitizeArgs(envelope.args, repoRoot) ?? []
  }));
}

function compactWaivers(waivers: VerificationWaiver[], repoRoot: string): VerificationWaiver[] {
  return waivers.map((waiver) => ({
    kind: waiver.kind,
    target: sanitizeText(waiver.target, repoRoot) ?? "",
    reason: sanitizeText(waiver.reason, repoRoot) ?? ""
  }));
}

function compactLedger(ledger: VerificationLedgerEntry[], repoRoot: string): VerificationLedgerEntry[] {
  return ledger.map((entry) => ({
    ...entry,
    command: sanitizeText(entry.command, repoRoot),
    evidence: entry.evidence.map((item) => sanitizeText(item, repoRoot) ?? "").filter(Boolean)
  }));
}

function clampSummary(value: string | undefined): string | undefined {
  const clean = value?.replace(/\s+/gu, " ").trim();
  if (!clean) {
    return undefined;
  }
  return clean.length > 500 ? `${clean.slice(0, 497)}...` : clean;
}

function sanitizeText(value: string | undefined, repoRoot: string): string | undefined {
  return clampSummary(
    redactSecretText(value)
      ?.replaceAll(repoRoot, "<repo>")
      .replace(/__outside_repo__:[^\s;|)]+/gu, "__outside_repo__:<outside-repo>")
      .replace(/(^|[\s([,{])\/[^\s;|)\]'",]+/gu, "$1<abs-path>")
      .replace(/(^|[\s([,{])(?:\.\.?\/)[^\s;|)\]'",]+/gu, "$1<rel-path>")
  );
}

function sanitizeArgs(args: string[] | undefined, repoRoot: string): string[] | undefined {
  if (!args) {
    return undefined;
  }
  let redactNext = false;
  return args.map((arg) => {
    if (redactNext) {
      redactNext = false;
      return "<redacted>";
    }
    if (isSecretFlag(arg) && !arg.includes("=")) {
      redactNext = true;
      return sanitizeText(arg, repoRoot) ?? "";
    }
    return sanitizeText(redactSecretArg(arg), repoRoot) ?? "";
  });
}

function redactSecretText(value: string | undefined): string | undefined {
  return value
    ?.replace(/(^|[\s([,{])((?:--?[a-z0-9-]*(?:token|secret|password|passwd|pwd|api[-_]?key|access[-_]?key|auth|credential|cookie)[a-z0-9-]*)(?:=|\s+))([^\s;|)\]'",]+)/giu, "$1$2<redacted>")
    .replace(/(\b[A-Z_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|PWD|API_?KEY|ACCESS_?KEY|AUTH|CREDENTIAL|COOKIE)[A-Z0-9_]*=)([^\s;|)\]'",]+)/gu, "$1<redacted>")
    .replace(/\b(Bearer)\s+[A-Za-z0-9._~+/-]+=*/giu, "$1 <redacted>");
}

function redactSecretArg(value: string): string {
  if (/^Bearer\s+/iu.test(value)) {
    return "Bearer <redacted>";
  }
  if (isSecretFlag(value) && value.includes("=")) {
    return value.replace(/=.*/u, "=<redacted>");
  }
  if (/^(?:[A-Z_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|PWD|API_?KEY|ACCESS_?KEY|AUTH|CREDENTIAL|COOKIE)[A-Z0-9_]*)=/iu.test(value)) {
    return value.replace(/=.*/u, "=<redacted>");
  }
  return value;
}

function isSecretFlag(value: string): boolean {
  return /^--?[a-z0-9-]*(?:token|secret|password|passwd|pwd|api-?key|access-?key|auth|credential|cookie)[a-z0-9-]*(?:=.*)?$/iu.test(value);
}

function sanitizePathField(value: string | undefined, repoRoot: string): string | undefined {
  if (!value) {
    return undefined;
  }
  if (value.startsWith("__outside_repo__:")) {
    return "__outside_repo__:<outside-repo>";
  }
  if (value === "." || value === "./") {
    return ".";
  }
  if (value === ".." || value.startsWith("../")) {
    return "<outside-repo>";
  }
  if (value.startsWith("./")) {
    const relative = value.replace(/\\/gu, "/").replace(/^\.\//u, "").replace(/\/+/gu, "/");
    return relative === "." ? "." : `<repo>/${relative}`;
  }
  if (path.isAbsolute(value)) {
    const relative = path.relative(repoRoot, value);
    if (relative === "") {
      return "<repo>";
    }
    return !relative.startsWith("..") && !path.isAbsolute(relative) ? `<repo>/${relative.split(path.sep).join("/")}` : "<outside-repo>";
  }
  return sanitizeText(value, repoRoot);
}

function hookSummary(input: PostEditOutcomeInput): PostEditHookSummary {
  const missingChecks = [...input.workflowChecks, ...input.dependencyChecks].filter((check) => check.status === "missing").length;
  const riskIncreases = input.riskDeltas.filter((delta) => delta.delta > 0).length;
  const nextAction =
    input.verdict === "replan"
      ? "replan before continuing"
      : input.verdict === "inspect"
        ? "inspect drift before completion"
        : input.verdict === "run_tests"
          ? "run or account for targeted tests"
          : "continue with normal diff review";
  return {
    verdict: input.verdict,
    changedFiles: input.changedFiles.length,
    unplannedEditedFiles: input.unplannedEditedFiles.length,
    modifiedSymbols: input.modifiedSymbols.length,
    missedLikelyTests: input.missedLikelyTests.length,
    riskIncreases,
    requiredChecksMissing: missingChecks,
    nextAction
  };
}

function calibrationLabels(input: PostEditOutcomeInput): string[] {
  const labels: string[] = [];
  if (input.reviewCoverage.status === "partial") {
    labels.push("partial-review-coverage");
  }
  if (input.unplannedEditedFiles.length > 0) {
    labels.push("unplanned-edits");
  }
  const commandEvidenceCount = input.ranCommands.length + input.ranCommandReports.length;
  const commandCoveredTests =
    commandEvidenceCount > 0 &&
    input.verificationLedger.some(
      (entry) => entry.kind === "test" && entry.status === "covered" && entry.coverageKinds.some((kind) => kind === "javascript-tests" || kind === "python-tests" || kind === "targeted-test")
    );
  const unresolvedCommandCoverage = commandEvidenceCount > 0 && input.verificationCoverage.some((entry) => entry.kind === "unknown");
  const failedCommandCoverage = input.verificationCoverage.some((entry) => entry.kind === "unknown" && entry.exitCode !== undefined && entry.exitCode !== 0);
  if (input.testsNotRun.length > 0) {
    labels.push("missing-recommended-tests");
    labels.push(failedCommandCoverage ? "failed-verification-command" : unresolvedCommandCoverage ? "unresolved-verification-command" : "real-missed-tests");
  } else if (commandCoveredTests && input.ranTests.length === 0 && commandEvidenceCount > 0) {
    labels.push("aggregate-command-coverage");
    labels.push("false-missing-test-warning-avoided");
  }
  if (input.verificationLedger.some((entry) => entry.status === "waived")) {
    labels.push("verification-waiver");
  }
  if (input.verificationLedger.some((entry) => entry.status === "waived" && entry.kind === "test")) {
    labels.push("waived-behavior-test");
  }
  if (input.verificationLedger.some((entry) => entry.status === "waived" && entry.kind === "workflow")) {
    labels.push("workflow-checks-waived");
  }
  if (input.verificationLedger.some((entry) => entry.status === "waived" && entry.kind === "dependency")) {
    labels.push("dependency-checks-waived");
  }
  if (input.verificationLedger.some((entry) => entry.status === "waived" && entry.kind !== "test")) {
    labels.push("waived-required-check");
  }
  if (input.verificationLedger.some((entry) => entry.status === "not_applicable")) {
    labels.push("recommended-check-not-applicable");
  }
  if (input.unindexedEditedFiles.length > 0) {
    labels.push("unindexed-edits");
  }
  if (input.modifiedPublicSymbols.length > 0) {
    labels.push("modified-public-symbols");
  }
  if (input.workflowChecks.some((check) => check.status === "missing")) {
    labels.push("workflow-checks-missing");
  }
  if (input.dependencyChecks.some((check) => check.status === "missing")) {
    labels.push("dependency-checks-missing");
  }
  if (input.riskDeltas.some((delta) => delta.delta > 0)) {
    labels.push("risk-increase");
  }
  if (input.quality?.level === "low") {
    labels.push("low-context-quality");
  }
  if ((input.confidence?.heuristic ?? 0) > (input.confidence?.authoritative ?? 0) + (input.confidence?.derived ?? 0)) {
    labels.push("heuristic-heavy");
  }
  if (input.verdict === "replan") {
    labels.push("requires-replan");
  } else if (input.verdict === "inspect") {
    labels.push("requires-inspection");
    labels.push(input.inspectMode === "blocking" ? "blocking-inspection" : "advisory-inspection");
  }
  return [...new Set(labels)].sort();
}

async function atomicJsonWrite(filePath: string, value: unknown): Promise<void> {
  const tmp = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    await fs.rename(tmp, filePath);
  } finally {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
  }
}
