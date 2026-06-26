import path from "node:path";
import type { AutoVerifyReportRunner } from "../autoverify.js";
import type { VerificationCommandEnvelope, VerificationCommandReport, VerificationCoverage, VerificationLedgerEntry } from "../types.js";

export type DisplayCommandReport = VerificationCommandReport & { runner?: AutoVerifyReportRunner };

export function sanitizeCommandReportForDisplay<T extends DisplayCommandReport>(report: T, repoRoot: string): T {
  return {
    ...report,
    command: sanitizeCommandText(report.command, repoRoot),
    cwd: sanitizePathField(report.cwd, repoRoot),
    packageManager: sanitizeSummary(report.packageManager, repoRoot),
    workspace: sanitizeSummary(report.workspace, repoRoot),
    packageRoot: sanitizePathField(report.packageRoot, repoRoot),
    packageName: sanitizeSummary(report.packageName, repoRoot),
    scriptName: sanitizeSummary(report.scriptName, repoRoot),
    stdoutSummary: sanitizeSummary(report.stdoutSummary, repoRoot),
    stderrSummary: sanitizeSummary(report.stderrSummary, repoRoot),
    outputSummary: sanitizeSummary(report.outputSummary, repoRoot),
    args: sanitizeCommandArgs(report.args, repoRoot),
    runner: sanitizeRunnerForDisplay(report.runner, repoRoot)
  };
}

export function sanitizeCommandEnvelopeForDisplay(envelope: VerificationCommandEnvelope, repoRoot: string): VerificationCommandEnvelope {
  return {
    ...envelope,
    command: sanitizeCommandText(envelope.command, repoRoot),
    cwd: sanitizePathField(envelope.cwd, repoRoot),
    packageManager: sanitizeSummary(envelope.packageManager, repoRoot),
    workspace: sanitizeSummary(envelope.workspace, repoRoot),
    packageRoot: sanitizePathField(envelope.packageRoot, repoRoot),
    packageName: sanitizeSummary(envelope.packageName, repoRoot),
    scriptName: sanitizeSummary(envelope.scriptName, repoRoot),
    stdoutSummary: sanitizeSummary(envelope.stdoutSummary, repoRoot),
    stderrSummary: sanitizeSummary(envelope.stderrSummary, repoRoot),
    outputSummary: sanitizeSummary(envelope.outputSummary, repoRoot),
    args: sanitizeCommandArgs(envelope.args, repoRoot) ?? []
  };
}

export function sanitizeCoverageForDisplay(entry: VerificationCoverage, repoRoot: string): VerificationCoverage {
  return {
    ...entry,
    command: sanitizeCommandText(entry.command, repoRoot),
    source: sanitizeSummary(entry.source, repoRoot) ?? entry.source,
    scope: sanitizePathField(entry.scope, repoRoot),
    targetPath: sanitizePathField(entry.targetPath, repoRoot),
    details: entry.details.map((detail) => sanitizeSummary(detail, repoRoot) ?? "").filter(Boolean),
    outputSummary: sanitizeSummary(entry.outputSummary, repoRoot),
    commandEnvelope: entry.commandEnvelope ? sanitizeCommandEnvelopeForDisplay(entry.commandEnvelope, repoRoot) : undefined
  };
}

export function sanitizeLedgerForDisplay(entry: VerificationLedgerEntry, repoRoot: string): VerificationLedgerEntry {
  return {
    ...entry,
    command: entry.command ? sanitizeCommandText(entry.command, repoRoot) : undefined,
    evidence: entry.evidence.map((item) => sanitizeSummary(item, repoRoot) ?? "").filter(Boolean)
  };
}

export function sanitizeCommandText(value: string, repoRoot: string): string {
  return sanitizeSummary(value, repoRoot) ?? "";
}

export function sanitizeSummary(value: string | undefined, repoRoot: string): string | undefined {
  const clean = redactSecretText(value)
    ?.replaceAll(repoRoot, "<repo>")
    .replace(/__outside_repo__:[^\s;|)]+/gu, "__outside_repo__:<outside-repo>")
    .replace(/(^|[\s([,{])\/[^\s;|)\]'",]+/gu, "$1<abs-path>")
    .replace(/(^|[\s([,{])(?:\.\.?\/)[^\s;|)\]'",]+/gu, "$1<rel-path>")
    .replace(/\s+/gu, " ")
    .trim();
  if (!clean) {
    return undefined;
  }
  return clean.length > 500 ? `${clean.slice(0, 497)}...` : clean;
}

export function sanitizePathField(value: string | undefined, repoRoot: string): string | undefined {
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
    const relative = normalizePathLike(value);
    return relative === "." ? "." : `<repo>/${relative}`;
  }
  if (path.isAbsolute(value)) {
    const relative = path.relative(repoRoot, value);
    if (relative === "") {
      return "<repo>";
    }
    return !relative.startsWith("..") && !path.isAbsolute(relative) ? `<repo>/${relative.split(path.sep).join("/")}` : "<outside-repo>";
  }
  return sanitizeSummary(value, repoRoot);
}

function sanitizeRunnerForDisplay(runner: AutoVerifyReportRunner | undefined, repoRoot: string): AutoVerifyReportRunner | undefined {
  if (!runner) {
    return undefined;
  }
  return {
    ...runner,
    cwdRealpath: sanitizePathField(runner.cwdRealpath, repoRoot) ?? runner.cwdRealpath,
    targetRealpaths: runner.targetRealpaths.map((target) => sanitizePathField(target, repoRoot) ?? target),
    allowedBy: runner.allowedBy.map((reason) => sanitizeSummary(reason, repoRoot) ?? reason),
    skippedReason: sanitizeSummary(runner.skippedReason, repoRoot)
  };
}

function sanitizeCommandArgs(args: string[] | undefined, repoRoot: string): string[] | undefined {
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
      return sanitizeSummary(arg, repoRoot) ?? "";
    }
    return sanitizeSummary(redactSecretArg(arg), repoRoot) ?? "";
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

function normalizePathLike(value: string): string {
  const normalized = value.replace(/\\/gu, "/");
  return normalized.startsWith("./") ? normalized.slice(2) || "." : normalized;
}
