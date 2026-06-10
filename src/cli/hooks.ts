import { promises as fs } from "node:fs";
import path from "node:path";
import { effectiveAutonomyMode } from "../autonomy.js";
import { runAutoVerifyForPostEdit, autoVerifyPolicySignature, sanitizeAutoVerifyText } from "../autoverify.js";
import { acquireCacheLock } from "../cache-lock.js";
import { getFreshness } from "../indexer.js";
import { resolveMcpRepoRoot, shouldPreferConfiguredRepoRoot } from "../mcp-repo-root.js";
import {
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

type HookActionResult = Omit<CodexaHookEventInput, "hook" | "durationMs"> | void;

export async function runPreEditHook(repo: string): Promise<void> {
  const configuredRoot = path.resolve(repo);
  await runAdvisoryHook(configuredRoot, "pre-edit", "change-plan snapshot check", async () => {
    const { activeRepoRoot } = await resolveHookRepoRoots(repo);
    const snapshot = await loadTaskSnapshot(activeRepoRoot);
    if (!snapshot.snapshot) {
      console.log("Codexa: no change-plan snapshot is available. For code edits, call change_plan with saveSnapshot=true before editing when the task is non-trivial.");
      return { status: "skipped", reason: "missing-change-plan-snapshot", taskId: snapshot.latestTaskId };
    }
    console.log(`Codexa: change-plan snapshot ready (${snapshot.snapshot.taskId}). After edits, post_edit_review will compare planned vs actual work.`);
    return { status: "ok", reason: "snapshot-ready", taskId: snapshot.snapshot.taskId };
  });
}

export async function runPostEditHook(repo: string): Promise<void> {
  const configuredRoot = path.resolve(repo);
  await runAdvisoryHook(configuredRoot, "post-edit", "post-edit review", async () => {
    const { activeRepoRoot } = await resolveHookRepoRoots(repo);
    const release = await tryAcquirePostEditHookLock(activeRepoRoot);
    if (!release) {
      console.log("Codexa: post-edit review skipped because another Codexa post-edit hook is active.");
      return { status: "skipped", reason: "post-edit-hook-lock-active" };
    }
    try {
      const snapshot = await loadTaskSnapshot(activeRepoRoot);
      const taskId = snapshot.snapshot?.taskId ?? snapshot.latestTaskId;
      const hookSnapshotAmbiguity = snapshot.snapshot?.taskId ? await latestHookSnapshotAmbiguity(activeRepoRoot, snapshot.snapshot.taskId) : undefined;
      const autoVerifyMode = await postEditAutoVerifyMode(activeRepoRoot);
      const freshness = await getFreshness(activeRepoRoot, undefined, { recover: false });
      const signature = postEditHookReviewSignature({ freshness, taskId, autoVerifyMode });
      const previous = await loadPostEditHookReviewState(activeRepoRoot);
      if (previous?.signature === signature && duplicatePostEditReviewCanSkip(previous.autoVerifyStatus)) {
        const verdict = previous.verdict ? `; last verdict ${previous.verdict}` : "";
        console.log(`Codexa: post-edit review unchanged since last hook run${verdict}.`);
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
          persistOutcome: false
        },
        { autoRefresh: true, commandBudgetMs: 15_000, maxResults: 6 }
      );
      const autoVerifySkipReason = hookSnapshotAmbiguity ?? ambiguousSnapshotAutoVerifySkipReason(initialResult.data);
      const autoVerify = autoVerifySkipReason
        ? { reports: [], attempted: [], skipped: [autoVerifySkipReason] }
        : await runAutoVerifyForPostEdit(activeRepoRoot, initialResult.data);
      if (autoVerify.attempted.length > 0) {
        console.log(`Codexa AutoVerify: ran ${autoVerify.attempted.length} targeted command(s).`);
        for (const report of autoVerify.reports) {
          const status = autoVerifyReportStatus(report);
          const duration = report.durationMs === undefined ? "" : ` in ${report.durationMs}ms`;
          console.log(`- ${status}${duration}: ${sanitizeAutoVerifyText(report.command, activeRepoRoot) ?? "<redacted-command>"}`);
        }
      }
      if (autoVerify.skipped.length > 0 && autoVerify.attempted.length === 0) {
        console.log(`Codexa AutoVerify: skipped ${autoVerify.skipped.length} unsafe or unsupported command(s).`);
        for (const skipped of autoVerify.skipped.slice(0, 4)) {
          console.log(`- ${sanitizeAutoVerifyText(skipped, activeRepoRoot) ?? "<redacted-command>"}`);
        }
      }
      const result = await postEditReviewWithTrustedRunnerReports(
        activeRepoRoot,
        reviewInput,
        autoVerify.reports,
        { autoRefresh: true, commandBudgetMs: 15_000, maxResults: 6 }
      );
      console.log(compactHookOutput(result.text));
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
  const resolution = await resolveMcpRepoRoot(configuredRoot, {
    preferConfiguredRoot: await shouldPreferConfiguredRepoRoot(configuredRoot)
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
