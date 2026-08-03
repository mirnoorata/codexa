import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import type { CommandResult } from "../command.js";
import { impactEntriesForFile, evidenceTierForImpact } from "./impact.js";
import { recommendTests } from "./tests.js";
import { verificationLedgerForPostEdit } from "./verification.js";
import { ensureQuerySession, type QuerySession, type QuerySessionInput } from "./session.js";
import { isCodexaControlPath } from "./worktree.js";
import { isTaskSnapshot, loadTaskSnapshot } from "../task-snapshots.js";
import type { ChangeEvidenceBundleV1, ChangeType, ChangedFileEntry, CodexaIndex, QueryOptions, QueryResult, TaskSnapshot, TestRecommendation, VerificationCommandReport, VerificationCoverage, VerificationLedgerEntry } from "../types.js";
import { isSubpath, limitText, normalizePath, uniqueSorted } from "../util.js";
import { buildChangeEvidenceChains, formatChangeEvidenceChains } from "./change-plan/evidence-chains.js";

const MAX_REF_LENGTH = 256;
const MAX_CHANGED_FILES = 1_000;
const MAX_PORTABLE_SNAPSHOT_BYTES = 1024 * 1024;
const GIT_TIMEOUT_MS = 10_000;
const GIT_BUFFER_BYTES = 4 * 1024 * 1024;
const MAX_REPORTED_COMMANDS = 100;
const MAX_REPORTED_COMMAND_LENGTH = 2_000;
const MAX_PLAN_FILES = 1_000;
const MAX_REPO_PATH_LENGTH = 500;

export type ChangeReviewMode = "observe" | "warn" | "fail";

export interface ChangeReviewInput {
  base: string;
  head?: string;
  changeType?: ChangeType;
  mode?: ChangeReviewMode;
  taskId?: string;
  planSnapshot?: string;
  ranTests?: string[];
  ranCommands?: string[];
  ranCommandReports?: VerificationCommandReport[];
}

export interface ChangeReviewData {
  schemaVersion: 1;
  mode: "change_review";
  policyMode: ChangeReviewMode;
  actionability: "review" | "no_changes";
  verdict: {
    status: "pass" | "attention" | "blocked";
    blocking: boolean;
    reasons: string[];
  };
  identity: {
    baseRef: string;
    headRef: string;
    baseCommit: string;
    headCommit: string;
    mergeBaseCommit: string;
    indexHeadCommit: string;
    comparison: "merge-base...head";
  };
  change: {
    changedFileCount: number;
    changedFiles: string[];
    entries: ChangedFileEntry[];
    indexedChanged: string[];
    unindexedChanged: string[];
    insertions: number;
    deletions: number;
    binaryFileCount: number;
  };
  impact: {
    affectedFileCount: number;
    sourceFileCount: number;
    analyzedSourceFileCount: number;
    truncated: boolean;
    affectedFiles: Array<{ path: string; depth: number; tier: string; reasons: string[]; sourceFiles: string[] }>;
  };
  evidenceChains: ChangeEvidenceBundleV1;
  plan: {
    status: "loaded" | "not_requested" | "unavailable";
    source?: "local" | "portable";
    trust: "local-cache" | "repo-file-advisory" | "none";
    taskId?: string;
    baselineCommit?: string | null;
    boundToRange?: boolean;
    plannedFiles: string[];
    unplannedFiles: string[];
    plannedButUnchanged: string[];
    conformance: "matched" | "drifted" | "not_checked";
    detail?: string;
  };
  verification: {
    recommendedTests: TestRecommendation[];
    coveredTests: string[];
    missingTests: string[];
    ranCommands: string[];
    failedCommands: Array<{ command: string; exitCode: number }>;
    coverage: VerificationCoverage[];
    ledger: VerificationLedgerEntry[];
    trustPosture: "reported-not-witnessed";
  };
  gaps: string[];
  nextActions: string[];
}

export async function changeReviewQuery(input: QuerySessionInput, reviewInput: ChangeReviewInput, options: QueryOptions = {}): Promise<QueryResult> {
  const session = await ensureQuerySession(input, options);
  const baseRef = validateRef(reviewInput.base, "base");
  const headRef = validateRef(reviewInput.head ?? "HEAD", "head");
  const policyMode = validateMode(reviewInput.mode);
  const changeType = validateChangeType(reviewInput.changeType);
  if (
    session.freshness.dirtyFiles.length > 0 ||
    session.freshness.stale ||
    session.freshness.indexedDirtyFiles.length > 0 ||
    (session.freshness.degradedGitState?.length ?? 0) > 0
  ) {
    throw new Error("change review requires a fresh index built from a clean checkout; commit or stash changes and reindex before reviewing a committed range");
  }

  const baseCommit = await resolveCommit(session, baseRef);
  const headCommit = await resolveCommit(session, headRef);
  const indexHeadCommit = session.freshness.headCommit;
  if (!indexHeadCommit) {
    throw new Error("change review requires a Git-backed Codexa index with a resolved HEAD commit");
  }
  if (headCommit !== indexHeadCommit) {
    throw new Error(`requested head ${headCommit} does not match indexed checkout ${indexHeadCommit}; check out the requested head and reindex`);
  }
  const mergeBaseCommit = await resolveMergeBase(session, baseCommit, headCommit);
  const entries = await committedEntries(session, mergeBaseCommit, headCommit);
  const stats = await committedStats(session, mergeBaseCommit, headCommit, entries);
  const changedFiles = uniqueSorted(entries.flatMap((entry) => entry.kind === "copied" ? [entry.path] : [entry.oldPath, entry.path].filter((value): value is string => Boolean(value))).filter((file) => !isCodexaControlPath(file)));
  const indexedPaths = new Set(session.index.files.map((file) => file.path));
  const historicalRenamePaths = new Set(entries.filter((entry) => entry.kind === "renamed" && !isCodexaControlPath(entry.path)).map((entry) => entry.oldPath).filter((value): value is string => Boolean(value)));
  const indexedChanged = changedFiles.filter((file) => indexedPaths.has(file));
  const unindexedChanged = changedFiles.filter((file) => !indexedPaths.has(file) && !historicalRenamePaths.has(file));
  const recommendedTests = recommendTests(session.index, changedFiles, session.repoRoot, changeType).slice(0, 40).map((test) => portableTestRecommendation(test, session.repoRoot));
  const impact = aggregateImpact(session.index, indexedChanged);
  const plan = await reviewPlan(session.repoRoot, reviewInput, entries, mergeBaseCommit);
  const evidenceChains = buildChangeEvidenceChains({
    index: session.index,
    task: `Committed change ${mergeBaseCommit}...${headCommit}`,
    anchors: rankCommittedEvidenceAnchors(session.index, indexedChanged, impact).map((filePath) => ({ path: filePath, authority: "committed-change" as const })),
    editTargets: plan.status === "loaded" ? plan.plannedFiles : [],
    tests: recommendedTests,
    freshness: session.freshness
  });
  const commandReports = boundedCommandReports(reviewInput.ranCommandReports ?? []);
  const ranCommands = boundedReportedCommands([
    ...(reviewInput.ranCommands ?? []),
    ...(reviewInput.ranTests ?? []),
    ...commandReports.map((report) => report.command)
  ]);
  const verification = verificationLedgerForPostEdit({
    index: session.index,
    tests: recommendedTests,
    ranTests: boundedReportedCommands(reviewInput.ranTests ?? []),
    ranCommands: boundedReportedCommands(reviewInput.ranCommands ?? []),
    ranCommandReports: commandReports,
    repoRoot: session.repoRoot
  });
  const coveredTests = verification.ledger.filter((entry) => entry.kind === "test" && entry.status === "covered").map((entry) => entry.target);
  const missingTests = verification.testsNotRun.map((test) => test.path);
  const failedCommands = commandReports
    .filter((report): report is VerificationCommandReport & { exitCode: number } => typeof report.exitCode === "number" && report.exitCode !== 0)
    .map((report) => ({ command: report.command, exitCode: report.exitCode }));
  const deterministicBlockers = [
    ...(plan.status === "unavailable" && plan.source === "local" ? ["the explicitly requested local plan snapshot is unavailable, invalid, or not bound to this range"] : []),
    ...(plan.source === "local" && plan.unplannedFiles.length > 0 ? [`plan drift: ${plan.unplannedFiles.length} changed file(s) are outside the declared local plan`] : []),
    ...(failedCommands.length > 0 ? [`reported verification failure: ${failedCommands.length} command(s) exited nonzero`] : [])
  ];
  const attentionReasons = [
    ...deterministicBlockers,
    ...(plan.source === "portable" && plan.status === "unavailable" ? ["the requested portable plan is not bound to this review range"] : []),
    ...(plan.source === "portable" && plan.unplannedFiles.length > 0 ? [`advisory portable plan drift: ${plan.unplannedFiles.length} changed file(s) are outside the declared scope`] : []),
    ...(unindexedChanged.length > 0 ? [`${unindexedChanged.length} changed file(s) are not represented in the current index`] : []),
    ...(missingTests.length > 0 ? [`${missingTests.length} recommended test(s) have no reported verification coverage`] : [])
  ];
  const blocking = policyMode === "fail" && deterministicBlockers.length > 0;
  const verdict = {
    status: blocking ? "blocked" as const : attentionReasons.length > 0 ? "attention" as const : "pass" as const,
    blocking,
    reasons: attentionReasons
  };
  const gaps = uniqueSorted([
    ...(unindexedChanged.length > 0 ? [`unindexed changed files: ${unindexedChanged.slice(0, 12).map(safeDisplay).join(", ")}`] : []),
    ...(impact.truncated ? [`impact expansion analyzed ${impact.analyzedSourceFileCount} of ${impact.sourceFileCount} indexed changed files`] : []),
    ...(plan.status === "unavailable" ? [`plan unavailable: ${safeDisplay(plan.detail ?? "unknown reason")}`] : []),
    ...(missingTests.length > 0 ? ["recommended tests are guidance until reported or witnessed verification is supplied"] : [])
  ]);
  const nextActions = uniqueSorted([
    ...(plan.unplannedFiles.length > 0 ? ["Update the saved plan or remove unintended files from the change."] : []),
    ...(failedCommands.length > 0 ? ["Fix the reported verification failures and rerun the same commands."] : []),
    ...(missingTests.length > 0 ? ["Run the recommended tests that apply and pass their commands back as evidence."] : []),
    ...(unindexedChanged.length > 0 ? ["Inspect unindexed files directly; Codexa cannot infer their graph impact."] : [])
  ]);

  const data: ChangeReviewData = {
    schemaVersion: 1,
    mode: "change_review",
    policyMode,
    actionability: changedFiles.length > 0 ? "review" : "no_changes",
    verdict,
    identity: { baseRef, headRef, baseCommit, headCommit, mergeBaseCommit, indexHeadCommit, comparison: "merge-base...head" },
    change: { changedFileCount: entries.length, changedFiles, entries, indexedChanged, unindexedChanged, ...stats },
    impact,
    evidenceChains,
    plan,
    verification: {
      recommendedTests,
      coveredTests,
      missingTests,
      ranCommands,
      failedCommands,
      coverage: verification.coverage.slice(0, 100),
      ledger: verification.ledger.slice(0, 100),
      trustPosture: "reported-not-witnessed"
    },
    gaps,
    nextActions
  };
  return { freshness: session.freshness, refresh: session.refresh, text: limitText(renderChangeReviewText(data), 12_000), data };
}

export function renderChangeReviewText(data: ChangeReviewData): string {
  return [
    `Codexa change review: ${data.verdict.status.toUpperCase()}${data.verdict.blocking ? " (blocking)" : ""}`,
    `Range: ${shortSha(data.identity.mergeBaseCommit)}...${shortSha(data.identity.headCommit)} (${data.identity.baseRef} -> ${data.identity.headRef})`,
    `Changed files: ${data.change.changedFileCount}; +${data.change.insertions} -${data.change.deletions}; binary ${data.change.binaryFileCount}`,
    `Affected files: ${data.impact.affectedFileCount}; recommended tests: ${data.verification.recommendedTests.length}; reported coverage: ${data.verification.coveredTests.length}`,
    `Plan: ${data.plan.conformance}${data.plan.taskId ? ` (${safeDisplay(data.plan.taskId)})` : ""}`,
    "",
    "Verdict:",
    ...(data.verdict.reasons.length > 0 ? data.verdict.reasons.map((reason) => `- ${safeDisplay(reason)}`) : ["- no review concerns found"]),
    "",
    "Changed files:",
    ...(data.change.entries.length > 0 ? data.change.entries.slice(0, 60).map((entry) => `- ${safeDisplay(entry.path)}: ${entry.kind}${entry.oldPath ? ` from ${safeDisplay(entry.oldPath)}` : ""}`) : ["- none"]),
    ...(data.change.entries.length > 60 ? [`- ... ${data.change.entries.length - 60} more changed files in structured output`] : []),
    "",
    "Highest-impact files:",
    ...(data.impact.affectedFiles.length > 0 ? data.impact.affectedFiles.slice(0, 20).map((entry) => `- ${safeDisplay(entry.path)}: ${entry.tier}; via ${entry.sourceFiles.map(safeDisplay).join(", ")}`) : ["- none"]),
    "",
    "Recommended tests:",
    ...(data.verification.recommendedTests.length > 0 ? data.verification.recommendedTests.slice(0, 30).map((test) => `- ${safeDisplay(test.path)}${test.command ? `: ${safeDisplay(test.command)}` : ""}`) : ["- none"]),
    ...(data.nextActions.length > 0 ? ["", "Next actions:", ...data.nextActions.map((action) => `- ${safeDisplay(action)}`)] : []),
    "",
    "Causal change evidence:",
    ...formatChangeEvidenceChains(data.evidenceChains).map(safeDisplay)
  ].join("\n");
}

export function renderChangeReviewMarkdown(data: ChangeReviewData): string {
  const icon = data.verdict.status === "pass" ? "PASS" : data.verdict.status === "blocked" ? "BLOCKED" : "ATTENTION";
  return [
    `## Codexa Change Review: ${icon}`,
    "",
    `| Range | Files | Diff | Affected | Reported coverage | Plan |`,
    `| --- | ---: | ---: | ---: | ---: | --- |`,
    `| \`${shortSha(data.identity.mergeBaseCommit)}...${shortSha(data.identity.headCommit)}\` | ${data.change.changedFileCount} | +${data.change.insertions} / -${data.change.deletions} | ${data.impact.affectedFileCount} | ${data.verification.coveredTests.length}/${data.verification.recommendedTests.length} reported | ${escapeMarkdownCell(data.plan.conformance)} |`,
    "",
    ...(data.verdict.reasons.length > 0 ? ["### Findings", ...data.verdict.reasons.map((reason) => `- ${escapeMarkdownCell(reason)}`), ""] : []),
    "### Changed files",
    ...(data.change.entries.length > 0 ? data.change.entries.slice(0, 60).map((entry) => `- \`${escapeMarkdownCode(entry.path)}\` (${entry.kind})`) : ["- None"]),
    ...(data.change.entries.length > 60 ? [`- ... ${data.change.entries.length - 60} more changed files in structured output`] : []),
    "",
    "### Recommended tests",
    ...(data.verification.recommendedTests.length > 0 ? data.verification.recommendedTests.slice(0, 30).map((test) => `- \`${escapeMarkdownCode(test.path)}\`${test.command ? `: \`${escapeMarkdownCode(test.command)}\`` : ""}`) : ["- None"]),
    "",
    "### Causal change evidence",
    ...formatChangeEvidenceChains(data.evidenceChains).map((line) => escapeMarkdownCell(line)),
    ""
  ].join("\n");
}

export function renderChangeReviewGithubAnnotations(data: ChangeReviewData): string[] {
  const level = data.verdict.blocking ? "error" : data.verdict.status === "attention" && data.policyMode !== "observe" ? "warning" : "notice";
  if (data.verdict.reasons.length === 0) {
    return [`::notice title=Codexa change review::${githubEscape(`PASS: ${data.change.changedFileCount} changed file(s), ${data.verification.coveredTests.length}/${data.verification.recommendedTests.length} recommended tests have reported coverage`)}`];
  }
  return data.verdict.reasons.slice(0, 10).map((reason) => `::${level} title=Codexa change review::${githubEscape(reason)}`);
}

async function resolveCommit(session: QuerySession, ref: string): Promise<string> {
  const result = await session.runCommand("git", ["-C", session.repoRoot, "rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`], gitOptions());
  return exactSha(result, `resolve Git ref ${ref}`);
}

async function resolveMergeBase(session: QuerySession, baseCommit: string, headCommit: string): Promise<string> {
  const result = await session.runCommand("git", ["-C", session.repoRoot, "merge-base", "--", baseCommit, headCommit], gitOptions());
  return exactSha(result, "resolve merge base");
}

async function committedEntries(session: QuerySession, baseCommit: string, headCommit: string): Promise<ChangedFileEntry[]> {
  const result = await session.runCommand("git", ["-C", session.repoRoot, "diff", "--name-status", "-z", "--find-renames", "--find-copies", `-l${MAX_CHANGED_FILES}`, "--no-ext-diff", baseCommit, headCommit, "--"], gitOptions());
  assertGitResult(result, "read committed changed files");
  const tokens = result.stdout.split("\0");
  if (tokens.at(-1) === "") tokens.pop();
  const entries: ChangedFileEntry[] = [];
  let parsedEntryCount = 0;
  for (let cursor = 0; cursor < tokens.length;) {
    const status = tokens[cursor++];
    const kind = kindForStatus(status);
    if (kind === "unknown") throw new Error(`Git returned unsupported committed change status: ${safeDisplay(status)}`);
    if (kind === "renamed" || kind === "copied") {
      const oldPath = normalizedGitPath(tokens[cursor++], "old path");
      const filePath = normalizedGitPath(tokens[cursor++], "path");
      if ((kind === "renamed" && !(isCodexaControlPath(filePath) && isCodexaControlPath(oldPath))) || (kind === "copied" && !isCodexaControlPath(filePath))) {
        entries.push({ path: filePath, oldPath, status, kind, staged: false, worktree: false });
      }
    } else {
      const filePath = normalizedGitPath(tokens[cursor++], "path");
      if (!isCodexaControlPath(filePath)) entries.push({ path: filePath, status, kind, staged: false, worktree: false });
    }
    parsedEntryCount += 1;
    if (parsedEntryCount > MAX_CHANGED_FILES) throw new Error(`change review exceeds the ${MAX_CHANGED_FILES}-file safety limit`);
  }
  return entries.sort((left, right) => left.path.localeCompare(right.path) || left.status.localeCompare(right.status));
}

async function committedStats(session: QuerySession, baseCommit: string, headCommit: string, entries: ChangedFileEntry[]): Promise<{ insertions: number; deletions: number; binaryFileCount: number }> {
  const result = await session.runCommand("git", ["-C", session.repoRoot, "diff", "--numstat", "-z", "--find-renames", "--find-copies", `-l${MAX_CHANGED_FILES}`, "--no-ext-diff", baseCommit, headCommit, "--"], gitOptions());
  assertGitResult(result, "read committed diff statistics");
  let insertions = 0;
  let deletions = 0;
  let binaryFileCount = 0;
  const tokens = result.stdout.split("\0");
  if (tokens.at(-1) === "") tokens.pop();
  const allowedPaths = new Set(entries.filter((entry) => !entry.oldPath).map((entry) => entry.path));
  const allowedTransitions = new Set(entries.filter((entry) => entry.oldPath).map((entry) => `${entry.oldPath}\0${entry.path}`));
  let includedCount = 0;
  let parsedCount = 0;
  for (let cursor = 0; cursor < tokens.length;) {
    const token = tokens[cursor++];
    const match = /^(\d+|-)\t(\d+|-)\t(.*)$/us.exec(token);
    if (!match) throw new Error("Git returned malformed committed diff statistics");
    const oldPath = match[3] === "" ? normalizedGitPath(tokens[cursor++], "old numstat path") : undefined;
    const filePath = match[3] === "" ? normalizedGitPath(tokens[cursor++], "numstat path") : normalizedGitPath(match[3], "numstat path");
    parsedCount += 1;
    if (parsedCount > MAX_CHANGED_FILES) throw new Error(`change review exceeds the ${MAX_CHANGED_FILES}-file safety limit`);
    const included = oldPath ? allowedTransitions.has(`${oldPath}\0${filePath}`) : allowedPaths.has(filePath);
    if (!included) continue;
    includedCount += 1;
    if (match[1] === "-" || match[2] === "-") binaryFileCount += 1;
    else {
      insertions += Number.parseInt(match[1], 10);
      deletions += Number.parseInt(match[2], 10);
      if (!Number.isSafeInteger(insertions) || !Number.isSafeInteger(deletions)) throw new Error("committed diff statistics exceed safe integer limits");
    }
  }
  if (includedCount !== entries.length) throw new Error("committed change entries and diff statistics do not describe the same files");
  return { insertions, deletions, binaryFileCount };
}

function aggregateImpact(index: CodexaIndex, changedFiles: string[]): ChangeReviewData["impact"] {
  const aggregated = new Map<string, ChangeReviewData["impact"]["affectedFiles"][number]>();
  const analyzedSources = changedFiles.slice(0, 100);
  for (const source of analyzedSources) {
    for (const entry of impactEntriesForFile(index, source, 2).slice(0, 80)) {
      const existing = aggregated.get(entry.file.path) ?? { path: entry.file.path, depth: entry.depth, tier: evidenceTierForImpact(entry), reasons: [], sourceFiles: [] };
      existing.depth = Math.min(existing.depth, entry.depth);
      if (tierRank(evidenceTierForImpact(entry)) < tierRank(existing.tier)) existing.tier = evidenceTierForImpact(entry);
      existing.reasons = uniqueSorted([...existing.reasons, ...entry.reasons]).slice(0, 8);
      existing.sourceFiles = uniqueSorted([...existing.sourceFiles, source]).slice(0, 12);
      aggregated.set(entry.file.path, existing);
    }
  }
  const affectedFiles = [...aggregated.values()].sort((left, right) => tierRank(left.tier) - tierRank(right.tier) || left.depth - right.depth || left.path.localeCompare(right.path)).slice(0, 200);
  return { affectedFileCount: aggregated.size, sourceFileCount: changedFiles.length, analyzedSourceFileCount: analyzedSources.length, truncated: analyzedSources.length < changedFiles.length, affectedFiles };
}

function rankCommittedEvidenceAnchors(index: CodexaIndex, changedFiles: string[], impact: ChangeReviewData["impact"]): string[] {
  const files = new Map(index.files.map((file) => [file.path, file]));
  const impactReach = new Map(changedFiles.map((filePath) => [filePath, 0]));
  for (const affected of impact.affectedFiles) {
    for (const source of affected.sourceFiles) {
      if (impactReach.has(source)) impactReach.set(source, (impactReach.get(source) ?? 0) + 1);
    }
  }
  return [...changedFiles].sort((left, right) => {
    const leftFile = files.get(left);
    const rightFile = files.get(right);
    return (rightFile?.riskScore ?? 0) - (leftFile?.riskScore ?? 0)
      || (impactReach.get(right) ?? 0) - (impactReach.get(left) ?? 0)
      || (rightFile?.rank ?? 0) - (leftFile?.rank ?? 0)
      || left.localeCompare(right);
  });
}

async function reviewPlan(repoRoot: string, input: ChangeReviewInput, entries: ChangedFileEntry[], mergeBaseCommit: string): Promise<ChangeReviewData["plan"]> {
  if (input.taskId && input.planSnapshot) throw new Error("change review accepts either taskId or planSnapshot, not both");
  if (!input.taskId && !input.planSnapshot) return { status: "not_requested", trust: "none", plannedFiles: [], unplannedFiles: [], plannedButUnchanged: [], conformance: "not_checked" };
  let snapshot: TaskSnapshot | undefined;
  let source: "local" | "portable";
  let detail: string | undefined;
  if (input.planSnapshot) {
    source = "portable";
    snapshot = await loadPortableSnapshot(repoRoot, input.planSnapshot);
  } else {
    source = "local";
    const loaded = await loadTaskSnapshot(repoRoot, input.taskId);
    snapshot = loaded.snapshot;
    detail = loaded.error ?? loaded.missingReason;
  }
  const trust = source === "local" ? "local-cache" as const : "repo-file-advisory" as const;
  if (!snapshot) return { status: "unavailable", source, trust, taskId: input.taskId, plannedFiles: [], unplannedFiles: [], plannedButUnchanged: [], conformance: "not_checked", detail };
  if (![...snapshot.plannedEditTargets, ...snapshot.plannedFiles].every((entry) => typeof entry === "string")) throw new Error("plan snapshot contains a non-string planned path");
  const baselineCommit = snapshot.dirtyBaseline.headCommit;
  if (baselineCommit !== mergeBaseCommit) {
    return {
      status: "unavailable",
      source,
      trust,
      taskId: snapshot.taskId,
      baselineCommit,
      boundToRange: false,
      plannedFiles: [],
      unplannedFiles: [],
      plannedButUnchanged: [],
      conformance: "not_checked",
      detail: `plan baseline ${baselineCommit ?? "none"} does not match review merge base ${mergeBaseCommit}`
    };
  }
  const rawPlannedFiles = snapshot.plannedEditTargets.length > 0 ? snapshot.plannedEditTargets : snapshot.plannedFiles;
  if (rawPlannedFiles.length > MAX_PLAN_FILES) throw new Error(`plan snapshot exceeds the ${MAX_PLAN_FILES}-file scope limit`);
  const plannedFiles = uniqueSorted(rawPlannedFiles.map(normalizePlannedPath));
  const planned = new Set(plannedFiles);
  const touchedPlanPaths = new Set<string>();
  const unplannedFiles: string[] = [];
  for (const entry of entries) {
    const candidates = entry.kind === "renamed" ? [entry.path, entry.oldPath] : [entry.path];
    const matched = candidates.filter((value): value is string => Boolean(value)).filter((file) => planned.has(file));
    if (matched.length === 0) unplannedFiles.push(entry.path);
    else for (const file of matched) touchedPlanPaths.add(file);
  }
  const plannedButUnchanged = plannedFiles.filter((file) => !touchedPlanPaths.has(file));
  const uniqueUnplannedFiles = uniqueSorted(unplannedFiles);
  return { status: "loaded", source, trust, taskId: snapshot.taskId, baselineCommit, boundToRange: true, plannedFiles, unplannedFiles: uniqueUnplannedFiles, plannedButUnchanged, conformance: uniqueUnplannedFiles.length > 0 ? "drifted" : "matched" };
}

async function loadPortableSnapshot(repoRoot: string, snapshotInput: string): Promise<TaskSnapshot> {
  if (!snapshotInput || snapshotInput.length > MAX_REPO_PATH_LENGTH || /[\u0000-\u001f\u007f]/u.test(snapshotInput)) throw new Error("portable plan snapshot path is invalid or too long");
  const candidate = path.resolve(repoRoot, snapshotInput);
  if (!isSubpath(candidate, repoRoot)) throw new Error("portable plan snapshot must be inside the repository");
  const inputStat = await lstat(candidate, { bigint: true });
  if (!inputStat.isFile() || inputStat.isSymbolicLink()) throw new Error("portable plan snapshot must be a regular non-symlink file");
  assertStableFileIdentity(inputStat, "input portable plan snapshot");
  const resolved = await realpath(candidate);
  if (!isSubpath(resolved, await realpath(repoRoot))) throw new Error("portable plan snapshot resolves outside the repository");
  const validatedStat = await lstat(resolved, { bigint: true });
  assertStableFileIdentity(validatedStat, "validated portable plan snapshot");
  if (validatedStat.dev !== inputStat.dev || validatedStat.ino !== inputStat.ino) throw new Error("portable plan snapshot changed during containment validation");
  let handle;
  try {
    handle = await open(candidate, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") throw new Error("portable plan snapshot must be a regular non-symlink file");
    throw error;
  }
  try {
    const stat = await handle.stat({ bigint: true });
    if (!stat.isFile()) throw new Error("portable plan snapshot must be a regular non-symlink file");
    assertStableFileIdentity(stat, "opened portable plan snapshot");
    if (stat.dev !== validatedStat.dev || stat.ino !== validatedStat.ino) throw new Error("portable plan snapshot changed while it was being validated");
    const openedPathStat = await lstat(candidate, { bigint: true });
    if (!openedPathStat.isFile() || openedPathStat.isSymbolicLink() || openedPathStat.dev !== stat.dev || openedPathStat.ino !== stat.ino) {
      throw new Error("portable plan snapshot path changed while it was being opened");
    }
    if (stat.size > BigInt(MAX_PORTABLE_SNAPSHOT_BYTES)) throw new Error(`portable plan snapshot exceeds ${MAX_PORTABLE_SNAPSHOT_BYTES} bytes`);
    const buffer = Buffer.allocUnsafe(MAX_PORTABLE_SNAPSHOT_BYTES + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const result = await handle.read(buffer, bytesRead, buffer.length - bytesRead, null);
      if (result.bytesRead === 0) break;
      bytesRead += result.bytesRead;
    }
    if (bytesRead > MAX_PORTABLE_SNAPSHOT_BYTES) throw new Error(`portable plan snapshot exceeds ${MAX_PORTABLE_SNAPSHOT_BYTES} bytes`);
    const parsed = JSON.parse(buffer.subarray(0, bytesRead).toString("utf8")) as unknown;
    if (!isTaskSnapshot(parsed)) throw new Error("portable plan snapshot schema is invalid");
    return parsed;
  } finally {
    await handle.close();
  }
}

function assertStableFileIdentity(stat: { dev: bigint; ino: bigint }, label: string): void {
  if (stat.dev < 0n || stat.ino <= 0n) throw new Error(`${label} does not expose a stable file identity`);
}

function validateRef(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_REF_LENGTH || /[\u0000-\u001f\u007f]/u.test(trimmed)) throw new Error(`${label} ref must be a non-empty control-free value up to ${MAX_REF_LENGTH} characters`);
  return trimmed;
}

function normalizePlannedPath(value: string): string {
  if (!value || value.length > MAX_REPO_PATH_LENGTH || /[\u0000-\u001f\u007f]/u.test(value)) throw new Error("plan snapshot contains an invalid or oversized planned path");
  const normalized = normalizePath(value);
  if (path.posix.isAbsolute(normalized) || normalized.split("/").some((segment) => segment === "." || segment === "..")) throw new Error("plan snapshot paths must be repository-relative files without dot segments");
  return normalized;
}

function validateMode(value: ChangeReviewMode | undefined): ChangeReviewMode {
  if (value === undefined || value === "observe") return "observe";
  if (value === "warn" || value === "fail") return value;
  throw new Error("change review mode must be observe, warn, or fail");
}

function validateChangeType(value: ChangeType | undefined): ChangeType {
  if (value === undefined) return "unknown";
  if (value === "style" || value === "api" || value === "behavior" || value === "rename" || value === "delete" || value === "unknown") return value;
  throw new Error("change review changeType is invalid");
}

function portableTestRecommendation(test: TestRecommendation, repoRoot: string): TestRecommendation {
  const portableString = (value: string | undefined): string | undefined => value?.replaceAll(repoRoot, ".");
  const commandCwd = test.commandCwd
    ? (() => {
        const absolute = path.resolve(repoRoot, test.commandCwd);
        if (!isSubpath(absolute, repoRoot)) return "<external>";
        return normalizePath(path.relative(repoRoot, absolute)) || ".";
      })()
    : undefined;
  return {
    ...test,
    command: portableString(test.command),
    commandCwd,
    commandExecutable: portableString(test.commandExecutable),
    commandArgs: test.commandArgs?.map((argument) => portableString(argument) ?? argument)
  };
}

function normalizedGitPath(value: string | undefined, label: string): string {
  if (!value) throw new Error(`Git returned a malformed ${label}`);
  const normalized = normalizePath(value);
  if (path.posix.isAbsolute(normalized) || normalized === ".." || normalized.startsWith("../")) throw new Error(`Git returned an unsafe ${label}`);
  return normalized;
}

function exactSha(result: CommandResult, action: string): string {
  assertGitResult(result, action);
  const lines = result.stdout.trim().split(/\r?\n/u);
  if (lines.length !== 1 || !/^[0-9a-f]{40,64}$/u.test(lines[0])) throw new Error(`unable to ${action}: Git returned an unexpected object id`);
  return lines[0];
}

function assertGitResult(result: CommandResult, action: string): void {
  if (result.ok) return;
  const reason = result.timedOut ? "timed out" : result.truncated ? "exceeded output limit" : `exited ${result.exitCode ?? "without a code"}`;
  throw new Error(`unable to ${action}: Git ${reason}${result.stderr.trim() ? `: ${safeDisplay(result.stderr.trim()).slice(0, 300)}` : ""}`);
}

function gitOptions() {
  return { timeoutMs: GIT_TIMEOUT_MS, maxBufferBytes: GIT_BUFFER_BYTES };
}

function kindForStatus(status: string): ChangedFileEntry["kind"] {
  if (/^R\d*$/u.test(status)) return "renamed";
  if (/^C\d*$/u.test(status)) return "copied";
  if (status === "A") return "added";
  if (status === "D") return "deleted";
  if (status === "M" || status === "T") return "modified";
  return "unknown";
}

function boundedReportedCommands(values: string[]): string[] {
  if (values.length > MAX_REPORTED_COMMANDS) throw new Error(`change review accepts at most ${MAX_REPORTED_COMMANDS} reported commands`);
  return uniqueSorted(values.map((value) => {
    if (typeof value !== "string") throw new Error("reported commands must be strings");
    const trimmed = value.trim();
    if (trimmed.length > MAX_REPORTED_COMMAND_LENGTH) throw new Error(`reported command exceeds ${MAX_REPORTED_COMMAND_LENGTH} characters`);
    return trimmed;
  }).filter(Boolean));
}

function boundedCommandReports(reports: VerificationCommandReport[]): VerificationCommandReport[] {
  if (reports.length > MAX_REPORTED_COMMANDS) throw new Error(`change review accepts at most ${MAX_REPORTED_COMMANDS} command reports`);
  return reports.map((report) => {
    if (!report || typeof report.command !== "string") throw new Error("command report requires a command string");
    boundedReportedCommands([report.command]);
    if (report.exitCode !== undefined && (!Number.isSafeInteger(report.exitCode) || report.exitCode < 0)) throw new Error("command report exitCode must be a non-negative safe integer");
    if (report.args && (report.args.length > 80 || report.args.some((arg) => typeof arg !== "string" || arg.length > 500))) throw new Error("command report args exceed the bounded input contract");
    for (const value of [report.stdoutSummary, report.stderrSummary, report.outputSummary]) {
      if (value !== undefined && (typeof value !== "string" || value.length > 1_000)) throw new Error("command report output summary exceeds 1000 characters");
    }
    return report;
  });
}

function tierRank(tier: string): number {
  return tier === "authoritative" ? 0 : tier === "derived" ? 1 : tier === "heuristic" ? 2 : 3;
}

function shortSha(value: string): string {
  return value.slice(0, 12);
}

function safeDisplay(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/gu, " ").replace(/\s+/gu, " ").trim();
}

function escapeMarkdownCell(value: string): string {
  return safeDisplay(value).replaceAll("|", "\\|");
}

function escapeMarkdownCode(value: string): string {
  return safeDisplay(value).replaceAll("`", "'");
}

function githubEscape(value: string): string {
  return safeDisplay(value).replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
}
