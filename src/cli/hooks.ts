import { promises as fs } from "node:fs";
import path from "node:path";
import { effectiveAutonomyMode } from "../autonomy.js";
import { runAutoVerifyForPostEdit, autoVerifyPolicySignature, sanitizeAutoVerifyText } from "../autoverify.js";
import { acquireCacheLock } from "../cache-lock.js";
import { assertSafeManagedStateDirectory, ensureSafeManagedStateDirectory } from "../init-portability.js";
import { saveImplicitBaselineSnapshot } from "../implicit-baseline.js";
import { getFreshness } from "../indexer.js";
import { resolveMcpRepoRoot, shouldPreferConfiguredRepoRoot } from "../mcp-repo-root.js";
import {
  latestCompletedPostEditReviewMatches,
  loadPostEditHookReviewState,
  postEditHookReviewSignature,
  recordCodexaHookEvent,
  savePostEditHookReviewState,
  type CodexaHookEventInput,
  type CodexaHookName,
  type PostEditOutcome
} from "../post-edit-outcomes.js";
import { postEditReviewQuery, postEditReviewWithTrustedRunnerReports } from "../query/post-edit.js";
import { loadTaskSnapshot } from "../task-snapshots.js";
import type { VerificationCommandReport } from "../types.js";
import { pendingTaskLifecycleReplan, pendingTaskLifecycleReplans } from "../task-lifecycle.js";

type HookActionResult = Omit<CodexaHookEventInput, "hook" | "durationMs"> | void;

export async function runPreEditHook(repo: string): Promise<void> {
  const configuredRoot = path.resolve(repo);
  let activeRepoRoot: string;
  try {
    ({ activeRepoRoot } = await resolveHookRepoRoots(repo));
  } catch (error) {
    await runAdvisoryHook(configuredRoot, "pre-edit", "change-plan snapshot check", async () => {
      throw error;
    });
    return;
  }
  let lifecycleBlock: Awaited<ReturnType<typeof pendingPreEditLifecycleBlock>>;
  try {
    await prepareHookManagedState(activeRepoRoot);
    lifecycleBlock = await pendingPreEditLifecycleBlock(activeRepoRoot);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.log(`Codexa: edit blocked because task lifecycle state could not be validated (${reason}).`);
    await safeRecordHookEvent(activeRepoRoot, {
      hook: "pre-edit",
      status: "failed",
      durationMs: 0,
      reason: "task-lifecycle-state-invalid",
      error: reason
    });
    throw new Error("Codexa task lifecycle state is unavailable or invalid; refusing a managed edit", { cause: error });
  }
  if (lifecycleBlock) {
    const reason = lifecycleBlock.reasons.join("; ") || "task loop requires a new saved plan";
    console.log(`Codexa: edit blocked until change_plan saves a newer plan revision (${reason}).`);
    await safeRecordHookEvent(lifecycleBlock.repoRoot, {
      hook: "pre-edit",
      status: "failed",
      durationMs: 0,
      reason: "task-loop-replan-required",
      taskId: lifecycleBlock.taskId,
      verdict: "replan"
    });
    throw new Error("Codexa task lifecycle requires replan before another managed edit");
  }
  await runAdvisoryHook(configuredRoot, "pre-edit", "change-plan snapshot check", async () => {
    const baseline = await saveImplicitBaselineSnapshot(activeRepoRoot);
    if (baseline.status === "existing-snapshot") {
      return { status: "ok", reason: "snapshot-ready", taskId: baseline.taskId };
    }
    if (baseline.status === "saved") {
      return { status: "ok", reason: "implicit-baseline-saved", taskId: baseline.taskId };
    }
    console.log(
      "Codexa: pre-edit baseline unavailable; the edit may continue, but post-edit review cannot compare against a reliable pre-edit tree. Run change_plan with saveSnapshot=true before a non-trivial edit."
    );
    return { status: "skipped", reason: baseline.reason ?? "missing-change-plan-snapshot", taskId: baseline.latestTaskId };
  });
}

async function pendingPreEditLifecycleBlock(activeRepoRoot: string): Promise<{ repoRoot: string; taskId: string; reasons: string[] } | undefined> {
  const loaded = await loadTaskSnapshot(activeRepoRoot);
  if (loaded.missingReason === "invalid-json" && /^task lifecycle\b/iu.test(loaded.error ?? "")) {
    throw new Error(loaded.error);
  }
  const review = await pendingTaskLifecycleReplan(activeRepoRoot, loaded.snapshot);
  if (review && loaded.snapshot) {
    return { repoRoot: activeRepoRoot, taskId: loaded.snapshot.taskId, reasons: review.reasons };
  }
  const pending = (await pendingTaskLifecycleReplans(activeRepoRoot))[0];
  return pending ? { repoRoot: activeRepoRoot, taskId: pending.taskId, reasons: pending.stop.reasons } : undefined;
}

export async function runPostEditHook(repo: string): Promise<void> {
  const configuredRoot = path.resolve(repo);
  await runAdvisoryHook(configuredRoot, "post-edit", "post-edit review", async () => {
    const { activeRepoRoot } = await resolveHookRepoRoots(repo);
    await prepareHookManagedState(activeRepoRoot);
    const release = await tryAcquirePostEditHookLock(activeRepoRoot);
    if (!release) {
      return { status: "skipped", reason: "post-edit-hook-lock-active" };
    }
    try {
      const snapshot = await loadTaskSnapshot(activeRepoRoot);
      const taskId = snapshot.snapshot?.taskId ?? snapshot.latestTaskId;
      const autoVerifyMode = await postEditAutoVerifyMode(activeRepoRoot);
      const reviewPassPolicy = postEditHookReviewPassPolicy(autoVerifyMode);
      const hookSnapshotAmbiguity = reviewPassPolicy.runAutoVerify && snapshot.snapshot?.taskId
        ? await latestHookSnapshotAmbiguity(activeRepoRoot, snapshot.snapshot.taskId)
        : undefined;
      const freshness = await getFreshness(activeRepoRoot, undefined, { recover: false });
      const signature = postEditHookReviewSignature({ freshness, taskId, autoVerifyMode });
      const previous = await loadPostEditHookReviewState(activeRepoRoot);
      if (previous?.signature === signature && duplicatePostEditReviewCanSkip(previous.autoVerifyStatus)) {
        return { status: "skipped", reason: "duplicate-dirty-tree", signature, taskId, verdict: previous.verdict, outcomeId: previous.outcomeId };
      }
      const reviewInput = {
        tokenBudget: 1200,
        limit: 5,
        includeSnippets: false,
        taskId: snapshot.snapshot?.taskId
      };
      const initialResult = await postEditReviewQuery(
        activeRepoRoot,
        {
          ...reviewInput,
          persistOutcome: reviewPassPolicy.persistInitialOutcome
        },
        { autoRefresh: true, commandBudgetMs: 15_000, maxResults: 6 }
      );
      const autoVerifySkipReason = reviewPassPolicy.runAutoVerify
        ? hookSnapshotAmbiguity ?? ambiguousSnapshotAutoVerifySkipReason(initialResult.data)
        : undefined;
      const autoVerify = !reviewPassPolicy.runAutoVerify
        ? {
            reports: [],
            attempted: [],
            skipped: []
          }
        : autoVerifySkipReason
          ? { reports: [], attempted: [], skipped: [autoVerifySkipReason] }
          : await runAutoVerifyForPostEdit(activeRepoRoot, initialResult.data);
      const result = reviewPassPolicy.runFinalReview
        ? await postEditReviewWithTrustedRunnerReports(
            activeRepoRoot,
            reviewInput,
            autoVerify.reports,
            { autoRefresh: true, commandBudgetMs: 15_000, maxResults: 6 }
          )
        : initialResult;
      if (postEditHookNeedsAttention(result.data)) {
        const autoVerifyOutput = formatAutoVerifyHookOutput(autoVerify, activeRepoRoot);
        if (autoVerifyOutput.length > 0) {
          console.log(autoVerifyOutput.join("\n"));
        }
        console.log(compactHookOutput(result.text));
      }
      const outcome = postEditOutcomeFromQueryResult(result.data);
      const autoVerifyStatus = summarizeAutoVerifyStatus(autoVerify);
      const reviewedSignature = postEditHookReviewSignature({ freshness: result.freshness, taskId, autoVerifyMode });
      await savePostEditHookReviewState(activeRepoRoot, {
        signature: reviewedSignature,
        outcome,
        autoVerifyStatus
      });
      return { status: "ok", reason: "reviewed", signature: reviewedSignature, taskId, verdict: outcome?.verdict, outcomeId: outcome?.outcomeId };
    } finally {
      await release();
    }
  });
}

async function prepareHookManagedState(repoRoot: string): Promise<void> {
  await ensureSafeManagedStateDirectory(repoRoot, "cache");
  await ensureSafeManagedStateDirectory(repoRoot, "cache", "codexa-tasks");
  await ensureSafeManagedStateDirectory(repoRoot, "cache", "codexa-task-lifecycle");
  await ensureSafeManagedStateDirectory(repoRoot, "cache", "codexa-outcomes");
}

/**
 * Read-only completion probe for host Stop hooks. It intentionally returns
 * false on any missing or degraded identity so the host falls back to a real
 * review instead of trusting an ambiguous cache record.
 */
export async function postEditReviewStateIsCurrent(repo: string): Promise<boolean> {
  const { activeRepoRoot } = await resolveHookRepoRoots(repo);
  try {
    await assertSafeManagedStateDirectory(activeRepoRoot, "cache");
    await assertSafeManagedStateDirectory(activeRepoRoot, "cache", "codexa-tasks");
    await assertSafeManagedStateDirectory(activeRepoRoot, "cache", "codexa-task-lifecycle");
    await assertSafeManagedStateDirectory(activeRepoRoot, "cache", "codexa-outcomes");
  } catch {
    return false;
  }
  const loaded = await loadTaskSnapshot(activeRepoRoot);
  if (!loaded.snapshot) {
    return false;
  }
  const freshness = await getFreshness(activeRepoRoot, undefined, { recover: false });
  return latestCompletedPostEditReviewMatches({
    repoRoot: activeRepoRoot,
    freshness,
    taskId: loaded.snapshot.taskId,
    planRevision: loaded.snapshot.planRevision ?? 1,
    snapshotCreatedAt: loaded.snapshot.createdAt,
    snapshotPublicationSequence: loaded.snapshot.publicationSequence
  });
}

/**
 * Managed hooks stay silent when Codexa has no action for the agent. Only a
 * blocked or incomplete review is injected back into the model transcript.
 */
export function postEditHookNeedsAttention(data: unknown): boolean {
  if (!isCliRecord(data)) {
    return true;
  }
  if (data.actionability === "blocked" || data.inspectMode === "blocking") {
    return true;
  }
  if (data.verdict === "continue") {
    return false;
  }
  if (data.verdict === "inspect") {
    return false;
  }
  return true;
}

export function compactHookOutput(text: string): string {
  const lines = text.split(/\r?\n/);
  const keep: string[] = [];
  let keepNextActions = false;
  let nextActionCount = 0;
  for (const line of lines) {
    if (
      line.startsWith("Codexa post-edit review") ||
      line.startsWith("Task:") ||
      line.startsWith("Snapshot:") ||
      line.startsWith("Verdict:") ||
      line.startsWith("Outcome record:") ||
      line.startsWith("Tests still unaccounted for:")
    ) {
      keep.push(line);
      continue;
    }
    if (line === "Next actions:") {
      keep.push(line);
      keepNextActions = true;
      nextActionCount = 0;
      continue;
    }
    if (keepNextActions && line.startsWith("- ")) {
      keep.push(line);
      nextActionCount += 1;
      if (nextActionCount >= 4) {
        keepNextActions = false;
      }
      continue;
    }
    if (line.trim() === "") {
      keepNextActions = false;
    }
  }
  return keep.length > 0 ? keep.join("\n") : lines.slice(0, 16).join("\n");
}

export async function recordAdvisoryHookEvent(repoRoot: string, event: CodexaHookEventInput): Promise<void> {
  await safeRecordHookEvent(repoRoot, event);
}

async function resolveHookRepoRoots(repo: string): Promise<{ configuredRoot: string; activeRepoRoot: string }> {
  const configuredRoot = path.resolve(repo);
  const preferConfiguredRoot = await shouldPreferConfiguredRepoRoot(configuredRoot, {
    ignoreAmbientWorkspaceSelectors: true
  });
  const resolution = await resolveMcpRepoRoot(configuredRoot, {
    preferConfiguredRoot,
    requireValidDeclaredFocus: !preferConfiguredRoot
  });
  return { configuredRoot, activeRepoRoot: resolution.repoRoot };
}

async function tryAcquirePostEditHookLock(repoRoot: string): Promise<(() => Promise<void>) | null> {
  try {
    return await acquireCacheLock({
      repoRoot,
      lockDir: ".codex/cache/codexa-post-edit-hook.lock",
      staleMs: 120_000,
      timeoutMs: 30_000,
      label: "Codexa post-edit hook"
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("Timed out waiting for Codexa post-edit hook lock")) {
      return null;
    }
    throw error;
  }
}

async function postEditAutoVerifyMode(repoRoot: string): Promise<string> {
  const autonomy = await effectiveAutonomyMode(repoRoot);
  return autonomy.mode === "full-access"
    ? `autoverify:${autoVerifyPolicySignature()}`
    : "autoverify:off";
}

export function postEditHookReviewPassPolicy(autoVerifyMode: string): { persistInitialOutcome: boolean; runAutoVerify: boolean; runFinalReview: boolean } {
  const autoVerifyEnabled = autoVerifyMode !== "autoverify:off";
  return {
    persistInitialOutcome: !autoVerifyEnabled,
    runAutoVerify: autoVerifyEnabled,
    runFinalReview: autoVerifyEnabled
  };
}

function duplicatePostEditReviewCanSkip(autoVerifyStatus: string | undefined): boolean {
  return autoVerifyStatus === undefined || autoVerifyStatus === "off" || autoVerifyStatus === "covered" || autoVerifyStatus === "skipped";
}

function ambiguousSnapshotAutoVerifySkipReason(data: unknown): string | undefined {
  if (!isCliRecord(data) || !isCliRecord(data.snapshotLoad) || data.snapshotLoad.ambiguousLatest !== true) {
    return undefined;
  }
  const reason = typeof data.snapshotLoad.ambiguityReason === "string" ? `: ${data.snapshotLoad.ambiguityReason}` : "";
  return `ambiguous change-plan snapshot${reason}; pass an exact taskId before AutoVerify can run`;
}

async function latestHookSnapshotAmbiguity(repoRoot: string, latestTaskId: string): Promise<string | undefined> {
  try {
    const entries = await fs.readdir(path.join(repoRoot, ".codex/cache/codexa-tasks"));
    const otherSnapshots = entries.filter((entry) => entry.endsWith(".json") && entry !== "latest.json" && !entry.endsWith(".blocked.json") && entry !== `${latestTaskId}.json`);
    if (otherSnapshots.length === 0) {
      return undefined;
    }
    return `ambiguous change-plan snapshot: hook selected latest snapshot ${latestTaskId} while ${otherSnapshots.length} other snapshot(s) exist; pass an exact taskId before AutoVerify can run`;
  } catch {
    return undefined;
  }
}

function autoVerifyReportStatus(report: VerificationCommandReport): string {
  const runner = "runner" in report && report.runner && typeof report.runner === "object"
    ? (report.runner as { sourceMutationDetected?: unknown; timedOut?: unknown })
    : undefined;
  if (runner?.sourceMutationDetected === true) {
    return "non-covering: source mutation detected";
  }
  if (runner?.timedOut === true) {
    return "non-covering: timed out";
  }
  return report.exitCode === 0 ? "passed" : `failed exit ${report.exitCode ?? "unknown"}`;
}

function formatAutoVerifyHookOutput(
  autoVerify: Awaited<ReturnType<typeof runAutoVerifyForPostEdit>>,
  repoRoot: string
): string[] {
  const lines: string[] = [];
  if (autoVerify.attempted.length > 0) {
    lines.push(`Codexa AutoVerify: ran ${autoVerify.attempted.length} targeted command(s).`);
    for (const report of autoVerify.reports) {
      const status = autoVerifyReportStatus(report);
      const duration = report.durationMs === undefined ? "" : ` in ${report.durationMs}ms`;
      lines.push(`- ${status}${duration}: ${sanitizeAutoVerifyText(report.command, repoRoot) ?? "<redacted-command>"}`);
    }
  }
  if (autoVerify.skipped.length > 0 && autoVerify.attempted.length === 0) {
    lines.push(`Codexa AutoVerify: skipped ${autoVerify.skipped.length} unsafe or unsupported command(s).`);
    for (const skipped of autoVerify.skipped.slice(0, 4)) {
      lines.push(`- ${sanitizeAutoVerifyText(skipped, repoRoot) ?? "<redacted-command>"}`);
    }
  }
  return lines;
}

function summarizeAutoVerifyStatus(autoVerify: Awaited<ReturnType<typeof runAutoVerifyForPostEdit>>): "off" | "covered" | "skipped" | "failed" | "non_covering" {
  if (autoVerify.reports.some((report) => report.runner.sourceMutationDetected || report.runner.timedOut)) {
    return "non_covering";
  }
  if (autoVerify.reports.some((report) => report.exitCode !== 0)) {
    return "failed";
  }
  if (autoVerify.reports.length > 0) {
    return "covered";
  }
  if (autoVerify.skipped.length > 0) {
    return "skipped";
  }
  return "off";
}

function postEditOutcomeFromQueryResult(data: unknown): PostEditOutcome | undefined {
  if (!data || typeof data !== "object") {
    return undefined;
  }
  const outcome = (data as { outcome?: unknown }).outcome;
  if (!outcome || typeof outcome !== "object") {
    return undefined;
  }
  const record = outcome as Partial<PostEditOutcome>;
  return record.schemaVersion === 1 && typeof record.outcomeId === "string" ? (record as PostEditOutcome) : undefined;
}

async function runAdvisoryHook(repoRoot: string, hook: CodexaHookName, label: string, action: () => Promise<HookActionResult>): Promise<void> {
  const startedAt = Date.now();
  try {
    const result = await action();
    await safeRecordHookEvent(repoRoot, {
      hook,
      status: result?.status ?? "ok",
      durationMs: Date.now() - startedAt,
      reason: result?.reason,
      taskId: result?.taskId,
      verdict: result?.verdict,
      outcomeId: result?.outcomeId,
      signature: result?.signature
    });
  } catch (error) {
    const message = hookErrorMessage(error);
    console.log(`Codexa: ${label} unavailable: ${message}`);
    console.log("Codexa: hook is advisory; continuing without blocking the edit.");
    await safeRecordHookEvent(repoRoot, {
      hook,
      status: "failed",
      durationMs: Date.now() - startedAt,
      reason: "unavailable",
      error: message
    });
  }
}

async function safeRecordHookEvent(repoRoot: string, event: CodexaHookEventInput): Promise<void> {
  try {
    await recordCodexaHookEvent(repoRoot, event);
  } catch {
    // Hook telemetry is local diagnostics only; it must never make advisory hooks block.
  }
}

function hookErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/gu, " ").trim() || "unknown error";
}

function isCliRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
