import type { ProveData, ProveLifecycle } from "./prove.js";
import type { VerificationCommandReport } from "./types.js";

type ProofInput = Omit<ProveData, "nextCommands">;

export function proofNextCommands(data: ProofInput): string[] {
  if (data.freshness.stale) return [`codexa index ${shellQuote(data.repoRoot)}`];
  if (data.worktree.degraded || data.worktree.unknown) return [];
  if (data.lifecycle.status === "invalid") return [recoveryChangePlanCommand(data)];
  if (data.snapshot.status === "blocked" || data.lifecycle.pendingStop) return [changePlanCommand(data)];
  if (data.actionability === "needs_target") return [];
  if (data.snapshot.status === "missing") return [changePlanCommand(data)];

  const commands: string[] = [];
  if (data.policies.missing.length > 0) {
    commands.push(`codexa policy-init ${shellQuote(data.repoRoot)}`);
  }
  const latestAttempt = data.lifecycle.attempts.at(-1);
  const verificationCommands = nextVerificationCommands(
    data,
    data.lifecycle.resolvedAttemptDrift ? undefined : latestAttempt
  );
  commands.push(...verificationCommands);
  const missingWorkflows = missingLedgerEntries(data, "workflow");
  if (missingWorkflows.length > 0) {
    commands.push(
      `codexa verification-artifact ${shellQuote(data.repoRoot)} --file ${shellQuote("<state-bound-verification-summary.json>")}`
    );
  }
  if (
    !latestAttempt ||
    latestAttempt.attemptStatus === "unresolved" ||
    data.lifecycle.resolvedAttemptDrift ||
    verificationCommands.length > 0 ||
    (!data.verification.reported.hasEvidence && data.verification.artifacts.selected.length === 0)
  ) {
    commands.push(postEditReviewCommand(data, verificationCommands));
  }
  return [...new Set(commands)];
}

function changePlanCommand(data: ProofInput): string {
  const taskId = data.snapshot.taskId ? ` --task-id ${shellQuote(data.snapshot.taskId)}` : "";
  return `codexa change-plan ${shellQuote(data.repoRoot)} --task ${shellQuote(data.task)}${taskId} --save-snapshot`;
}

function recoveryChangePlanCommand(data: ProofInput): string {
  return `codexa change-plan ${shellQuote(data.repoRoot)} --task ${shellQuote(data.task)} --task-id ${shellQuote("<new-task-id>")} --save-snapshot`;
}

function nextVerificationCommands(
  data: ProofInput,
  latestAttempt: ProveLifecycle["attempts"][number] | undefined
): string[] {
  const recommended = data.verification.recommendedCommands;
  if (recommended.length === 0) return [];
  const suppliedEvidence =
    data.verification.reported.hasEvidence || data.verification.artifacts.selected.length > 0;
  if (suppliedEvidence) {
    const missingTests = new Set(missingLedgerEntries(data, "test").map((entry) => entry.target));
    const hasMissingDependency = missingLedgerEntries(data, "dependency").length > 0;
    if (missingTests.size === 0 && !hasMissingDependency) return [];
    const relevant = new Set(
      data.verification.commandPlan
        .filter(
          (entry) =>
            entry.targetPaths.some((target) => missingTests.has(target)) ||
            (hasMissingDependency &&
              entry.covers.some((kind) =>
                ["build", "typescript-syntax", "javascript-tests", "python-tests", "targeted-test"].includes(kind)
              ))
        )
        .map((entry) => entry.command)
    );
    const filtered = recommended.filter((command) => relevant.has(command));
    return (filtered.length > 0 ? filtered : recommended).slice(0, 4);
  }
  if (!latestAttempt || !suppliedEvidence) return recommended.slice(0, 4);
  const verificationStillMissing =
    latestAttempt.attemptStatus === "unresolved" &&
    latestAttempt.failureSignals.some((signal) =>
      ["verification-missing", "verification-failed", "required-check-missing", "external-check-failed"].includes(signal.class)
    );
  return verificationStillMissing ? recommended.slice(0, 4) : [];
}

function postEditReviewCommand(data: ProofInput, plannedCommands: string[]): string {
  const taskScope = data.snapshot.taskId
    ? `--task-id ${shellQuote(data.snapshot.taskId)}`
    : `--task ${shellQuote(data.task)}`;
  const successfulReports = data.verification.reported.ranCommandReports
    .filter((report) => report.exitCode === 0 && isSafeCommandReportForHandoff(report))
    .map((report) => commandReportForHandoff(report, data.repoRoot));
  const rawCommands = [...new Set(data.verification.reported.ranCommands)].slice(0, 4);
  const evidenceFlags = [
    ...rawCommands.map((command) => `--ran-command ${shellQuote(command)}`),
    ...[...new Set(successfulReports.map((report) => JSON.stringify(report)))]
      .slice(0, 4)
      .map((report) => `--ran-command-report ${shellQuote(report)}`),
    ...data.verification.reported.ranTests.slice(0, 4).map((test) => `--ran-test ${shellQuote(test)}`),
    ...data.verification.reported.waivedChecks.slice(0, 4).map((target) => `--waive-check ${shellQuote(target)}`),
    ...data.verification.reported.waivers
      .slice(0, 4)
      .map((waiver) => `--waiver ${shellQuote(JSON.stringify(waiver))}`),
    ...data.verification.artifacts.selected
      .slice(0, 4)
      .map((artifact) => `--artifact-id ${shellQuote(artifact.artifactId)}`)
  ];
  if (missingLedgerEntries(data, "workflow").length > 0) {
    evidenceFlags.push(`--artifact-id ${shellQuote("<artifact-id-from-verification-artifact>")}`);
  }
  if (plannedCommands.length > 0 || evidenceFlags.length === 0) {
    evidenceFlags.push(`--ran-command ${shellQuote("<command-you-ran>")}`);
  }
  return [`codexa post-edit-review ${shellQuote(data.repoRoot)} ${taskScope}`, ...evidenceFlags].join(" ");
}

function missingLedgerEntries(data: ProofInput, kind: "test" | "workflow" | "dependency") {
  return data.verification.reported.ledger.filter(
    (entry) => entry.status === "missing" && entry.kind === kind
  );
}

function commandReportForHandoff(
  report: VerificationCommandReport,
  repoRoot: string
): VerificationCommandReport {
  return {
    ...report,
    command: restoreRepositoryPlaceholder(report.command, repoRoot),
    cwd: restoreRepositoryPathPlaceholder(report.cwd),
    packageRoot: restoreRepositoryPathPlaceholder(report.packageRoot),
    args: report.args?.map((arg) => restoreRepositoryPlaceholder(arg, repoRoot))
  };
}

function isSafeCommandReportForHandoff(report: VerificationCommandReport): boolean {
  return (
    [report.cwd, report.packageRoot].every((value) => value === undefined || !hasUnsafePathPlaceholder(value)) &&
    !hasUnsafePathPlaceholder(report.command) &&
    (report.args ?? []).every((arg) => !hasUnsafePathPlaceholder(arg))
  );
}

function hasUnsafePathPlaceholder(value: string): boolean {
  return /(?:<abs-path>|<outside-repo>|__outside_repo__:)/u.test(value);
}

function restoreRepositoryPathPlaceholder(value: string | undefined): string | undefined {
  if (value === "<repo>") return ".";
  if (value?.startsWith("<repo>/")) return value.slice("<repo>/".length);
  return value;
}

function restoreRepositoryPlaceholder(value: string, repoRoot: string): string {
  return value.replaceAll("<repo>/", `${repoRoot}/`).replaceAll("<repo>", repoRoot);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}
