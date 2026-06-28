import { promises as fs } from "node:fs";
import path from "node:path";
import { isTrustedAutoVerifyCommandReport, type AutoVerifyCommandReport, type AutoVerifyReportRunner } from "../../autoverify.js";
import { AUTO_VERIFY_POLICY_DIGEST, AUTO_VERIFY_POLICY_ID } from "../../autoverify/policy.js";
import type { TaskSnapshot, VerificationCommandReport } from "../../types.js";
import { stableId } from "../../util.js";
import { sanitizeCommandText, sanitizeSummary } from "../verification-display.js";

export interface AutoVerifyRunnerReviewEntry {
  command: string;
  covering: boolean;
  reason: string;
  policyId?: string;
  sourceMutationDetected?: boolean;
  timedOut?: boolean;
}

export async function reviewTrustedRunnerReports(
  reports: AutoVerifyCommandReport[],
  ctx: { freshness: { headCommit: string | null; dirtyFiles: string[]; dirtyFileHashes: Record<string, string> }; snapshot: TaskSnapshot | undefined; repoRoot: string }
): Promise<{ coveringReports: AutoVerifyCommandReport[]; displayReports: AutoVerifyCommandReport[]; reviewEntries: AutoVerifyRunnerReviewEntry[] }> {
  const repoRealRoot = await fs.realpath(ctx.repoRoot).catch(() => path.resolve(ctx.repoRoot));
  const currentDirtyHash = dirtyHashFromFreshness(ctx.freshness);
  const snapshotDigest = ctx.snapshot ? autoVerifySnapshotDigest(ctx.snapshot) : undefined;
  const coveringReports: AutoVerifyCommandReport[] = [];
  const displayReports: AutoVerifyCommandReport[] = [];
  const reviewEntries: AutoVerifyRunnerReviewEntry[] = [];
  for (const report of reports) {
    const reasons = runnerReportRejectionReasons(report, {
      currentDirtyHash,
      snapshotDigest,
      taskId: ctx.snapshot?.taskId,
      repoRealRoot
    });
    displayReports.push(report);
    const covering = reasons.length === 0;
    if (covering) {
      coveringReports.push(report);
    }
    reviewEntries.push({
      command: sanitizeCommandText(report.command, ctx.repoRoot),
      covering,
      reason: sanitizeSummary(covering ? "fresh trusted AutoVerify report" : reasons.join("; "), ctx.repoRoot) ?? "runner evidence unavailable",
      policyId: report.runner?.policyId,
      sourceMutationDetected: report.runner?.sourceMutationDetected,
      timedOut: report.runner?.timedOut
    });
  }
  return { coveringReports, displayReports, reviewEntries };
}

function runnerReportRejectionReasons(
  report: AutoVerifyCommandReport,
  ctx: { currentDirtyHash: string; snapshotDigest?: string; taskId?: string; repoRealRoot: string }
): string[] {
  const runner = report.runner;
  const reasons: string[] = [];
  if (!isTrustedAutoVerifyCommandReport(report)) {
    return ["missing internal AutoVerify trust marker"];
  }
  if (!runner || runner.schemaVersion !== 1 || runner.reportKind !== "codexa-autoverify-report" || runner.runnerName !== "codexa") {
    return ["missing trusted AutoVerify runner metadata"];
  }
  if (runner.policyId !== AUTO_VERIFY_POLICY_ID) reasons.push("unexpected runner policy");
  if (runner.policyDigest !== AUTO_VERIFY_POLICY_DIGEST) reasons.push("unexpected runner policy digest");
  if (runner.envMode !== "minimal") reasons.push("unexpected runner environment");
  if (!runner.outputRedacted) reasons.push("runner output was not redacted");
  if (report.exitCode !== 0) reasons.push(report.exitCode === undefined ? "missing exit code" : `exit code ${report.exitCode}`);
  if (!report.cwd) reasons.push("missing cwd");
  if (runner.timedOut) reasons.push("runner timed out");
  if (runner.sourceMutationDetected) reasons.push("source mutation detected");
  if (runner.skippedReason) reasons.push(runner.skippedReason);
  if (ctx.taskId && runner.taskId !== ctx.taskId) reasons.push("task id mismatch");
  if (ctx.snapshotDigest && runner.snapshotDigest !== ctx.snapshotDigest) reasons.push("snapshot digest mismatch");
  if (runner.dirtyHashAfter !== ctx.currentDirtyHash) reasons.push("stale dirty tree");
  if (!absoluteSubpath(runner.cwdRealpath, ctx.repoRealRoot)) reasons.push("runner cwd outside repo");
  if (runner.targetRealpaths.length === 0) reasons.push("missing runner targets");
  if (runner.targetRealpaths.some((target) => !absoluteSubpath(target, ctx.repoRealRoot))) reasons.push("runner target outside repo");
  if (runner.canonicalDigest !== runnerReportDigest(report, runner)) reasons.push("runner digest mismatch");
  return reasons;
}

function runnerReportDigest(report: AutoVerifyCommandReport, runner: AutoVerifyReportRunner): string {
  return stableId(
    "codexa-autoverify-report",
    report.command,
    report.exitCode,
    runner.policyId,
    runner.policyDigest,
    runner.taskId,
    runner.snapshotDigest,
    runner.commandId,
    runner.candidateDigest,
    runner.headCommit ?? "null",
    runner.dirtyHashBefore,
    runner.dirtyHashAfter,
    runner.cwdRealpath,
    JSON.stringify(runner.targetRealpaths),
    runner.envMode,
    JSON.stringify(runner.allowedBy),
    runner.sourceMutationDetected ? "mutated" : "clean",
    runner.timedOut ? "timed-out" : "not-timed-out",
    runner.outputRedacted ? "redacted" : "not-redacted",
    runner.signal ?? "",
    runner.skippedReason ?? ""
  );
}

export function stripRunnerMetadata(report: VerificationCommandReport): VerificationCommandReport {
  return {
    command: report.command,
    cwd: report.cwd,
    packageManager: report.packageManager,
    workspace: report.workspace,
    packageRoot: report.packageRoot,
    packageName: report.packageName,
    scriptName: report.scriptName,
    args: report.args,
    exitCode: report.exitCode,
    durationMs: report.durationMs,
    stdoutSummary: report.stdoutSummary,
    stderrSummary: report.stderrSummary,
    outputSummary: report.outputSummary
  };
}

function dirtyHashFromFreshness(freshness: { headCommit: string | null; dirtyFiles: string[]; dirtyFileHashes: Record<string, string> }): string {
  return stableId(
    "autoverify-dirty-tree",
    freshness.headCommit ?? "null",
    JSON.stringify({
      dirtyFiles: [...freshness.dirtyFiles].sort(),
      dirtyFileHashes: Object.fromEntries(Object.entries(freshness.dirtyFileHashes).sort(([a], [b]) => a.localeCompare(b)))
    })
  );
}

export function autoVerifySnapshotDigest(snapshot: TaskSnapshot): string {
  return stableId("autoverify-snapshot", snapshot.taskId, snapshot.createdAt, JSON.stringify(snapshot.plannedEditTargets), JSON.stringify(snapshot.plannedTests.map((test) => test.path)));
}

function absoluteSubpath(candidate: string, parent: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
