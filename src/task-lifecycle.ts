import { promises as fs } from "node:fs";
import path from "node:path";
import { acquireCacheLock } from "./cache-lock.js";
import { assertSafeManagedFile, ensureSafeManagedStateDirectory } from "./init-portability.js";
import {
  MAX_TASK_INVARIANT_CHARS,
  MAX_TASK_INVARIANT_EVIDENCE,
  MAX_TASK_INVARIANTS,
  MAX_TASK_INVARIANT_REVIEWS,
  taskInvariantReviewSchema,
  taskInvariantStatementSchema
} from "./lifecycle-contract.js";
import type {
  DiffFootprintV1,
  TaskInvariant,
  TaskInvariantReview,
  TaskLoopFailureClass,
  TaskLoopFailureSignal,
  TaskLoopReview,
  TaskSnapshot
} from "./types.js";
import { stableId, uniqueSorted } from "./util.js";

const TASK_LIFECYCLE_DIR = ".codex/cache/codexa-task-lifecycle";
const MAX_HISTORY_ATTEMPTS = 30;
const MAX_FAILURE_TARGETS = 20;
const UNRESOLVED_ATTEMPT_LIMIT = 3;
const TOTAL_ATTEMPT_LIMIT = 5;
const RECURRING_FAILURE_LIMIT = 2;
const TASK_LIFECYCLE_LOCK_STALE_MS = 120_000;
const TASK_LIFECYCLE_LOCK_TIMEOUT_MS = 30_000;

export interface TaskLifecycleAttempt {
  attemptId: string;
  planRevision: number;
  attemptStatus: "resolved" | "unresolved";
  failureSignals: TaskLoopFailureSignal[];
  diffFootprint: DiffFootprintV1;
  changedFiles: string[];
  createdAt: string;
}

export interface TaskLifecycleStop {
  planRevision: number;
  attemptId: string;
  reasons: string[];
  createdAt: string;
}

export interface TaskLifecycleState {
  schemaVersion: 1;
  taskId: string;
  planRevision: number;
  invariants: TaskInvariant[];
  attempts: TaskLifecycleAttempt[];
  pendingStop?: TaskLifecycleStop;
  latestInvariantReviews: TaskInvariantReview[];
  updatedAt: string;
}

export interface PreparedTaskLoopAttempt {
  review: TaskLoopReview;
  nextState: TaskLifecycleState;
}

export interface TaskInvariantReviewResult {
  reviews: TaskInvariantReview[];
  missing: TaskInvariant[];
  violated: TaskInvariant[];
  unknownInvariantIds: string[];
}

export interface TaskLoopFailureInput {
  planDriftTargets?: string[];
  contextUnreliableTargets?: string[];
  verificationMissingTargets?: string[];
  verificationFailedTargets?: string[];
  requiredCheckMissingTargets?: string[];
  riskEscalationTargets?: string[];
  invariantUnreviewedTargets?: string[];
  invariantViolatedTargets?: string[];
  externalCheckFailedTargets?: string[];
}

export function nextTaskPlanLifecycle(snapshot: TaskSnapshot | undefined, declaredInvariants: string[] | undefined): {
  planRevision: number;
  invariants: TaskInvariant[];
} {
  return {
    planRevision: (snapshot?.planRevision ?? (snapshot ? 1 : 0)) + 1,
    invariants: normalizeTaskInvariants(snapshot?.invariants, declaredInvariants)
  };
}

export function formatTaskInvariants(invariants: TaskInvariant[], heading: string): string[] {
  return invariants.length > 0 ? ["", heading, ...invariants.map((invariant) => `- ${invariant.id}: ${invariant.statement}`)] : [];
}

export function normalizeTaskInvariants(existing: TaskInvariant[] | undefined, declared: string[] | undefined): TaskInvariant[] {
  const byId = new Map<string, TaskInvariant>();
  for (const invariant of existing ?? []) {
    const statement = parseInvariantStatement(invariant.statement);
    const id = invariant.id || taskInvariantId(statement);
    if (!byId.has(id)) byId.set(id, { id, statement });
  }
  for (const value of declared ?? []) {
    const statement = parseInvariantStatement(value);
    const id = taskInvariantId(statement);
    if (!byId.has(id)) byId.set(id, { id, statement });
  }
  if (byId.size > MAX_TASK_INVARIANTS) {
    throw new Error(`Task invariants exceed the maximum of ${MAX_TASK_INVARIANTS}; existing invariants were preserved and additions were rejected`);
  }
  return [...byId.values()];
}

export function reviewTaskInvariants(invariants: TaskInvariant[], input: TaskInvariantReview[] | undefined): TaskInvariantReviewResult {
  const known = new Set(invariants.map((invariant) => invariant.id));
  const byId = new Map<string, TaskInvariantReview>();
  const unknownInvariantIds: string[] = [];
  for (const review of input ?? []) {
    const parsed = taskInvariantReviewSchema.safeParse(review);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new Error(`Task invariant review is invalid${issue ? ` at ${issue.path.join(".") || "root"}: ${issue.message}` : ""}`);
    }
    const invariantId = parsed.data.invariantId;
    if (!known.has(invariantId)) {
      if (invariantId) unknownInvariantIds.push(invariantId);
      continue;
    }
    const prior = byId.get(invariantId);
    const status = prior?.status === "violated" || parsed.data.status === "violated" ? "violated" : "satisfied";
    byId.set(invariantId, {
      invariantId,
      status,
      evidence: uniqueSorted([...(prior?.evidence ?? []), ...parsed.data.evidence]).slice(0, MAX_TASK_INVARIANT_EVIDENCE)
    });
  }
  const reviews = [...byId.values()].sort((left, right) => left.invariantId.localeCompare(right.invariantId));
  const missing = invariants.filter((invariant) => !byId.has(invariant.id));
  const violatedIds = new Set(reviews.filter((review) => review.status === "violated").map((review) => review.invariantId));
  return {
    reviews,
    missing,
    violated: invariants.filter((invariant) => violatedIds.has(invariant.id)),
    unknownInvariantIds: uniqueSorted(unknownInvariantIds)
  };
}

export function classifyTaskLoopFailures(input: TaskLoopFailureInput): TaskLoopFailureSignal[] {
  const signals: TaskLoopFailureSignal[] = [];
  addFailureSignal(signals, "plan-drift", input.planDriftTargets);
  addFailureSignal(signals, "context-unreliable", input.contextUnreliableTargets);
  addFailureSignal(signals, "verification-missing", input.verificationMissingTargets);
  addFailureSignal(signals, "verification-failed", input.verificationFailedTargets);
  addFailureSignal(signals, "required-check-missing", input.requiredCheckMissingTargets);
  addFailureSignal(signals, "risk-escalation", input.riskEscalationTargets);
  addFailureSignal(signals, "invariant-unreviewed", input.invariantUnreviewedTargets);
  addFailureSignal(signals, "invariant-violated", input.invariantViolatedTargets);
  addFailureSignal(signals, "external-check-failed", input.externalCheckFailedTargets);
  return signals.sort((left, right) => left.fingerprint.localeCompare(right.fingerprint));
}

export function taskLoopAttemptId(input: {
  taskId: string;
  planRevision: number;
  diffFootprint: DiffFootprintV1;
  artifactIds: string[];
}): string {
  return stableId(
    "task-loop-attempt-v1",
    input.taskId,
    String(input.planRevision),
    input.diffFootprint.fingerprint,
    uniqueSorted(input.artifactIds).join("\n")
  );
}

export async function prepareTaskLoopAttempt(input: {
  repoRoot: string;
  taskId: string;
  planRevision: number;
  attemptId: string;
  attemptStatus: "resolved" | "unresolved";
  failureSignals: TaskLoopFailureSignal[];
  diffFootprint: DiffFootprintV1;
  changedFiles: string[];
  forceReplanReasons?: string[];
  invariantReviews?: TaskInvariantReview[];
}): Promise<PreparedTaskLoopAttempt> {
  const loaded = await loadTaskLifecycleState(input.repoRoot, input.taskId);
  const current = loaded ?? emptyTaskLifecycleState(input.taskId, input.planRevision);
  if (loaded && current.planRevision !== input.planRevision) {
    throw new Error(`Task lifecycle state is at plan revision ${current.planRevision}, but the review requested revision ${input.planRevision}`);
  }
  const attemptsById = new Map(current.attempts.map((attempt) => [attempt.attemptId, attempt]));
  const now = new Date().toISOString();
  attemptsById.set(input.attemptId, {
    createdAt: now,
    planRevision: input.planRevision,
    changedFiles: uniqueSorted(input.changedFiles),
    failureSignals: input.failureSignals,
    diffFootprint: input.diffFootprint,
    attemptId: input.attemptId,
    attemptStatus: input.attemptStatus
  });
  // Map insertion order is the lock-serialized commit order. Timestamps may tie
  // within one millisecond and therefore cannot safely order attempts.
  const attempts = [...attemptsById.values()].slice(-MAX_HISTORY_ATTEMPTS);
  const planAttempts = attempts.filter((attempt) => attempt.planRevision === input.planRevision);
  const unresolvedAttemptsSincePlan = trailingUnresolvedCount(planAttempts);
  const recurringFailures = recurringFailureCounts(planAttempts);
  const firstAttempt = planAttempts[0];
  const previousAttempt = planAttempts.length > 1 ? planAttempts[planAttempts.length - 2] : undefined;
  const currentAttempt = planAttempts[planAttempts.length - 1];
  const recurringGrowth =
    previousAttempt &&
    currentAttempt &&
    previousAttempt.attemptStatus === "unresolved" &&
    currentAttempt.attemptStatus === "unresolved" &&
    sameFailureRecurs(previousAttempt.failureSignals, currentAttempt.failureSignals) &&
    diffGrew(previousAttempt.diffFootprint, currentAttempt.diffFootprint);
  const thresholdReasons = uniqueSorted([
    ...(input.forceReplanReasons ?? []).map((reason) => clampText(reason, 500)).filter(Boolean),
    ...(unresolvedAttemptsSincePlan >= UNRESOLVED_ATTEMPT_LIMIT
      ? [`${unresolvedAttemptsSincePlan} distinct unresolved attempts occurred under plan revision ${input.planRevision}`]
      : []),
    ...(planAttempts.length >= TOTAL_ATTEMPT_LIMIT
      ? [`${planAttempts.length} distinct patch attempts occurred under plan revision ${input.planRevision}`]
      : []),
    ...(recurringGrowth ? ["the same failure fingerprint recurred while the diff footprint grew"] : [])
  ]);
  const planTrackedLines = planAttempts.map((attempt) => trackedLines(attempt.diffFootprint)).filter((value): value is number => value !== null);
  const firstFiles = new Set(firstAttempt?.changedFiles ?? []);
  const allFiles = new Set(planAttempts.flatMap((attempt) => attempt.changedFiles));
  const latchedReasons = current.pendingStop?.planRevision === input.planRevision ? current.pendingStop.reasons : [];
  const reasons = uniqueSorted([...latchedReasons, ...thresholdReasons]);
  const review: TaskLoopReview = {
    policyVersion: "task-loop-v1",
    attemptId: input.attemptId,
    attemptStatus: input.attemptStatus,
    totalDistinctAttempts: attempts.length,
    attemptsSincePlan: planAttempts.length,
    unresolvedAttemptsSincePlan,
    recurringFailures,
    cumulativeDiffGrowth: {
      firstTrackedLines: firstAttempt ? trackedLines(firstAttempt.diffFootprint) : null,
      currentTrackedLines: trackedLines(input.diffFootprint),
      peakTrackedLines: planTrackedLines.length > 0 ? Math.max(...planTrackedLines) : null,
      newFilesSinceFirstAttempt: [...allFiles].filter((filePath) => !firstFiles.has(filePath)).length,
      peakModifiedSymbols: Math.max(0, ...planAttempts.map((attempt) => attempt.diffFootprint.modifiedSymbolCount))
    },
    status: reasons.length > 0 ? "replan-required" : "within-budget",
    reasons
  };
  const pendingStop = current.pendingStop?.planRevision === input.planRevision
    ? current.pendingStop
    : review.status === "replan-required"
      ? { planRevision: input.planRevision, attemptId: input.attemptId, reasons, createdAt: now }
      : undefined;
  return {
    review,
    nextState: {
      schemaVersion: 1,
      taskId: input.taskId,
      planRevision: input.planRevision,
      invariants: current.invariants,
      attempts,
      pendingStop,
      latestInvariantReviews: input.invariantReviews ?? current.latestInvariantReviews,
      updatedAt: now
    }
  };
}

export async function withTaskLifecycleLock<T>(repoRoot: string, taskId: string, action: () => Promise<T>): Promise<T> {
  const release = await acquireCacheLock({
    repoRoot: path.resolve(repoRoot),
    lockDir: `.codex/cache/codexa-task-lifecycle-locks/${stableId("task-lifecycle-lock", taskId)}.lock`,
    staleMs: TASK_LIFECYCLE_LOCK_STALE_MS,
    timeoutMs: TASK_LIFECYCLE_LOCK_TIMEOUT_MS,
    label: `Codexa task lifecycle ${taskId}`
  });
  try {
    return await action();
  } finally {
    await release();
  }
}

export async function loadTaskLifecycleState(repoRoot: string, taskId: string): Promise<TaskLifecycleState | undefined> {
  const filePath = taskLifecycleStatePath(repoRoot, taskId);
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code) : "";
    if (code === "ENOENT") return undefined;
    throw new Error(`Task lifecycle state is unreadable: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isTaskLifecycleState(parsed, taskId)) throw new Error("Task lifecycle state schema is invalid");
  return parsed;
}

export async function saveTaskLifecycleState(repoRoot: string, state: TaskLifecycleState): Promise<void> {
  if (!isTaskLifecycleState(state, state.taskId)) throw new Error("Refusing to save invalid task lifecycle state");
  const filePath = taskLifecycleStatePath(repoRoot, state.taskId);
  await ensureSafeManagedStateDirectory(repoRoot, "cache", "codexa-task-lifecycle");
  await assertSafeManagedFile(filePath);
  const temp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await fs.rename(temp, filePath);
}

export async function recordTaskPlanRevision(repoRoot: string, taskId: string, planRevision: number, invariants: TaskInvariant[]): Promise<TaskLifecycleState> {
  const prior = (await loadTaskLifecycleState(repoRoot, taskId)) ?? emptyTaskLifecycleState(taskId, 0);
  if (planRevision <= prior.planRevision) {
    throw new Error(`Task plan revision must advance beyond ${prior.planRevision}`);
  }
  const next: TaskLifecycleState = {
    ...prior,
    planRevision,
    invariants,
    pendingStop: prior.pendingStop && planRevision <= prior.pendingStop.planRevision ? prior.pendingStop : undefined,
    updatedAt: new Date().toISOString()
  };
  await saveTaskLifecycleState(repoRoot, next);
  return next;
}

export async function pendingTaskLifecycleReplan(repoRoot: string, snapshot: TaskSnapshot | undefined): Promise<TaskLifecycleStop | undefined> {
  if (!snapshot) return undefined;
  const state = await loadTaskLifecycleState(repoRoot, snapshot.taskId);
  if (!state) {
    if (snapshot.planRevision !== undefined) {
      throw new Error(`Task lifecycle state is missing for governed snapshot ${snapshot.taskId} revision ${snapshot.planRevision}`);
    }
    return undefined;
  }
  const snapshotRevision = snapshot.planRevision ?? 1;
  if (state.planRevision !== snapshotRevision) {
    throw new Error(`Task lifecycle revision ${state.planRevision} does not match snapshot ${snapshot.taskId} revision ${snapshotRevision}`);
  }
  if (!state.pendingStop) return undefined;
  return (snapshot.planRevision ?? 1) > state.pendingStop.planRevision ? undefined : state.pendingStop;
}

export async function pendingTaskLifecycleReplans(repoRoot: string): Promise<Array<{ taskId: string; stop: TaskLifecycleStop }>> {
  const dir = path.join(path.resolve(repoRoot), TASK_LIFECYCLE_DIR);
  let files: string[];
  try {
    files = (await fs.readdir(dir)).filter((entry) => entry.endsWith(".json")).sort();
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code) : "";
    if (code === "ENOENT") return [];
    throw new Error(`Task lifecycle directory is unreadable: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (files.length > 1_000) {
    throw new Error("Task lifecycle directory exceeds the bounded 1000-state validation limit");
  }
  const pending: Array<{ taskId: string; stop: TaskLifecycleStop }> = [];
  for (const file of files) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await fs.readFile(path.join(dir, file), "utf8"));
    } catch (error) {
      throw new Error(`Task lifecycle state ${file} is unreadable: ${error instanceof Error ? error.message : String(error)}`);
    }
    const taskId = parsed && typeof parsed === "object" && !Array.isArray(parsed) && typeof (parsed as { taskId?: unknown }).taskId === "string"
      ? (parsed as { taskId: string }).taskId
      : "";
    if (!taskId || !isTaskLifecycleState(parsed, taskId)) {
      throw new Error(`Task lifecycle state ${file} is invalid`);
    }
    if (parsed.pendingStop) pending.push({ taskId, stop: parsed.pendingStop });
  }
  return pending;
}

function addFailureSignal(signals: TaskLoopFailureSignal[], failureClass: TaskLoopFailureClass, rawTargets: string[] | undefined): void {
  const targets = uniqueSorted((rawTargets ?? []).map((target) => clampText(target, 500)).filter(Boolean)).slice(0, MAX_FAILURE_TARGETS);
  if (targets.length === 0) return;
  signals.push({
    class: failureClass,
    fingerprint: stableId("task-loop-failure-v1", failureClass, targets.join("\n")),
    targets
  });
}

function isDiffFootprint(value: unknown): value is DiffFootprintV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Partial<DiffFootprintV1>;
  return (
    record.schemaVersion === 1 &&
    (typeof record.trackedInsertions === "number" || record.trackedInsertions === null) &&
    (typeof record.trackedDeletions === "number" || record.trackedDeletions === null) &&
    typeof record.changedFileCount === "number" &&
    typeof record.modifiedSymbolCount === "number" &&
    typeof record.untrackedFileCount === "number" &&
    typeof record.fingerprint === "string" &&
    Array.isArray(record.degradedReasons) &&
    record.degradedReasons.every((reason) => typeof reason === "string")
  );
}

function recurringFailureCounts(attempts: Array<{ failureSignals: TaskLoopFailureSignal[] }>): TaskLoopReview["recurringFailures"] {
  const counts = new Map<string, { class: TaskLoopFailureClass; fingerprint: string; count: number }>();
  for (const attempt of attempts) {
    for (const signal of attempt.failureSignals) {
      const current = counts.get(signal.fingerprint);
      counts.set(signal.fingerprint, { class: signal.class, fingerprint: signal.fingerprint, count: (current?.count ?? 0) + 1 });
    }
  }
  return [...counts.values()].filter((entry) => entry.count >= RECURRING_FAILURE_LIMIT).sort((left, right) => right.count - left.count || left.fingerprint.localeCompare(right.fingerprint));
}

function trailingUnresolvedCount(attempts: Array<{ attemptStatus: "resolved" | "unresolved" }>): number {
  let count = 0;
  for (let index = attempts.length - 1; index >= 0; index -= 1) {
    if (attempts[index]?.attemptStatus !== "unresolved") break;
    count += 1;
  }
  return count;
}

function sameFailureRecurs(left: TaskLoopFailureSignal[], right: TaskLoopFailureSignal[]): boolean {
  const prior = new Set(left.map((signal) => signal.fingerprint));
  return right.some((signal) => prior.has(signal.fingerprint));
}

function diffGrew(left: DiffFootprintV1, right: DiffFootprintV1): boolean {
  const leftLines = trackedLines(left);
  const rightLines = trackedLines(right);
  return (
    (leftLines !== null && rightLines !== null && rightLines > leftLines) ||
    right.changedFileCount > left.changedFileCount ||
    right.modifiedSymbolCount > left.modifiedSymbolCount
  );
}

function trackedLines(footprint: DiffFootprintV1): number | null {
  return footprint.trackedInsertions === null || footprint.trackedDeletions === null ? null : footprint.trackedInsertions + footprint.trackedDeletions;
}

export function taskInvariantId(statement: string): string {
  return `inv-${stableId("task-invariant-v1", statement.toLowerCase())}`;
}

function parseInvariantStatement(value: string): string {
  const result = taskInvariantStatementSchema.safeParse(value);
  if (!result.success) {
    throw new Error(`Task invariant must contain 1-${MAX_TASK_INVARIANT_CHARS} characters`);
  }
  return result.data.replace(/\s+/gu, " ");
}

function taskLifecycleStatePath(repoRoot: string, taskId: string): string {
  return path.join(path.resolve(repoRoot), TASK_LIFECYCLE_DIR, `${stableId("task-lifecycle-state", taskId)}.json`);
}

function emptyTaskLifecycleState(taskId: string, planRevision: number): TaskLifecycleState {
  return {
    schemaVersion: 1,
    taskId,
    planRevision,
    invariants: [],
    attempts: [],
    latestInvariantReviews: [],
    updatedAt: new Date(0).toISOString()
  };
}

function isTaskLifecycleState(value: unknown, taskId: string): value is TaskLifecycleState {
  if (!isExactRecord(value, ["schemaVersion", "taskId", "planRevision", "invariants", "attempts", "pendingStop", "latestInvariantReviews", "updatedAt"])) return false;
  const record = value as Partial<TaskLifecycleState>;
  if (
    record.schemaVersion !== 1 || record.taskId !== taskId || !Number.isInteger(record.planRevision) || (record.planRevision ?? -1) < 0 ||
    !isIsoTimestamp(record.updatedAt) || !Array.isArray(record.invariants) || record.invariants.length > MAX_TASK_INVARIANTS ||
    !Array.isArray(record.attempts) || record.attempts.length > MAX_HISTORY_ATTEMPTS ||
    !Array.isArray(record.latestInvariantReviews) || record.latestInvariantReviews.length > MAX_TASK_INVARIANT_REVIEWS
  ) return false;
  const invariantIds = new Set<string>();
  for (const invariant of record.invariants) {
    if (!isExactRecord(invariant, ["id", "statement"]) || typeof invariant.id !== "string" || invariant.id.length === 0 || invariant.id.length > 160) return false;
    const statement = taskInvariantStatementSchema.safeParse(invariant.statement);
    if (!statement.success || invariant.id !== taskInvariantId(statement.data.replace(/\s+/gu, " ")) || invariantIds.has(invariant.id)) return false;
    invariantIds.add(invariant.id);
  }
  return record.latestInvariantReviews.every((review) => taskInvariantReviewSchema.safeParse(review).success && invariantIds.has(review.invariantId)) &&
    record.attempts.every((attempt) => isTaskLifecycleAttempt(attempt, record.planRevision ?? 0)) &&
    (record.pendingStop === undefined || isTaskLifecycleStop(record.pendingStop, record.planRevision ?? 0));
}

function isTaskLifecycleAttempt(value: unknown, currentPlanRevision: number): value is TaskLifecycleAttempt {
  if (!isExactRecord(value, ["attemptId", "planRevision", "attemptStatus", "failureSignals", "diffFootprint", "changedFiles", "createdAt"])) return false;
  const attempt = value as Partial<TaskLifecycleAttempt>;
  return typeof attempt.attemptId === "string" && attempt.attemptId.length > 0 && attempt.attemptId.length <= 160 &&
    Number.isInteger(attempt.planRevision) && (attempt.planRevision ?? 0) > 0 && (attempt.planRevision ?? 0) <= currentPlanRevision &&
    (attempt.attemptStatus === "resolved" || attempt.attemptStatus === "unresolved") && Array.isArray(attempt.failureSignals) &&
    attempt.failureSignals.length <= 20 && attempt.failureSignals.every(isTaskLoopFailureSignal) && isDiffFootprint(attempt.diffFootprint) &&
    Array.isArray(attempt.changedFiles) && attempt.changedFiles.length <= 2_000 && attempt.changedFiles.every((entry) => typeof entry === "string" && entry.length <= 1_000) &&
    isIsoTimestamp(attempt.createdAt);
}

function isTaskLoopFailureSignal(value: unknown): value is TaskLoopFailureSignal {
  if (!isExactRecord(value, ["class", "fingerprint", "targets"])) return false;
  const signal = value as Partial<TaskLoopFailureSignal>;
  const classes: TaskLoopFailureClass[] = ["plan-drift", "context-unreliable", "verification-missing", "verification-failed", "required-check-missing", "risk-escalation", "invariant-unreviewed", "invariant-violated", "external-check-failed"];
  return classes.includes(signal.class as TaskLoopFailureClass) && typeof signal.fingerprint === "string" && signal.fingerprint.length > 0 &&
    Array.isArray(signal.targets) && signal.targets.length <= MAX_FAILURE_TARGETS && signal.targets.every((target) => typeof target === "string" && target.length <= 500);
}

function isTaskLifecycleStop(value: unknown, planRevision: number): value is TaskLifecycleStop {
  if (!isExactRecord(value, ["planRevision", "attemptId", "reasons", "createdAt"])) return false;
  const stop = value as Partial<TaskLifecycleStop>;
  return stop.planRevision === planRevision && typeof stop.attemptId === "string" && stop.attemptId.length > 0 && Array.isArray(stop.reasons) &&
    stop.reasons.length > 0 && stop.reasons.length <= 20 && stop.reasons.every((reason) => typeof reason === "string" && reason.length <= 500) && isIsoTimestamp(stop.createdAt);
}

function isExactRecord(value: unknown, allowedKeys: string[]): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) && Object.keys(value as object).every((key) => allowedKeys.includes(key));
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function clampText(value: string, limit: number): string {
  const clean = value.replace(/\s+/gu, " ").trim();
  return clean.length > limit ? clean.slice(0, limit) : clean;
}
