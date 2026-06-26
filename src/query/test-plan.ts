import path from "node:path";
import { formatDiffGroups, formatGaps, groupDiffImpact, indexGaps } from "./diff.js";
import { freshnessBanner } from "./runtime.js";
import { ensureQuerySession, type QuerySessionInput } from "./session.js";
import { formatOutcomeLearningRecommendations, formatTestRecommendations, outcomeLearningRecommendations, recommendTests } from "./tests.js";
import { compactChangedSymbol, compactDiffGroup } from "./compact-data.js";
import { compactWorktreeState, getWorktreeState, worktreeStateGaps, worktreeStateText } from "./worktree-state.js";
import {
  formatVerificationCoverage,
  formatVerificationLedger,
  verificationCommandPlan,
  verificationCommandsForContext,
  verificationLedgerForPostEdit
} from "./verification.js";
import { CURRENT_VERIFICATION_PROVENANCE } from "../types.js";
import type { ChangeType, QueryOptions, QueryResult, VerificationLedgerEntry } from "../types.js";
import { limitText, normalizePath } from "../util.js";

export interface TestPlanOptions extends QueryOptions {
  changeType?: ChangeType;
  files?: string[];
}

export async function testPlanQuery(input: QuerySessionInput, diff = true, options: TestPlanOptions = {}): Promise<QueryResult> {
  const session = await ensureQuerySession(input, options);
  const { index, freshness, refresh, repoRoot } = session;
  const indexedPaths = new Set(index.files.map((file) => file.path));
  const worktree = diff ? await getWorktreeState(session) : undefined;
  const changedEntries = worktree?.entries ?? [];
  const changed = worktree?.files ?? [];
  const changedSymbols = worktree?.symbols ?? [];
  const unindexedChanged = changed.filter((file) => !indexedPaths.has(file));
  const explicitTargets = resolveTargetFiles(options.files, repoRoot, indexedPaths);
  const explicitTargetsProvided = (options.files?.length ?? 0) > 0;
  const scopedFiles = explicitTargets.files.length > 0 ? explicitTargets.files : explicitTargetsProvided ? [] : changed;
  const groups = groupDiffImpact(index, changedEntries, changedSymbols, unindexedChanged);
  const gaps = [...indexGaps(index, freshness, unindexedChanged), ...explicitTargets.gaps, ...(worktree ? worktreeStateGaps(worktree) : [])];
  const changeType: ChangeType = options.changeType ?? "unknown";
  const tests = scopedFiles.length > 0 ? recommendTests(index, scopedFiles, repoRoot, changeType) : [];
  const outcomeLearning = outcomeLearningRecommendations(tests, 8);
  const verificationCommands = scopedFiles.length > 0 ? verificationCommandsForContext(index, repoRoot, scopedFiles, tests, 16) : [];
  const verificationPreview = verificationLedgerForPostEdit({
    index,
    tests,
    ranTests: [],
    ranCommands: verificationCommands,
    repoRoot
  });
  const missingVerification = verificationLedgerForPostEdit({
    index,
    tests,
    ranTests: [],
    ranCommands: [],
    repoRoot
  });
  const verificationCoverage = verificationPreview.coverage;
  const commandPlan = verificationCommandPlan(verificationCoverage);
  const verificationLedgerPreview = markLedgerAsPreview(verificationPreview.ledger);
  const actionability = scopedFiles.length > 0 ? "verify" : "needs_target";
  const text = scopedFiles.length > 0
    ? [
        freshnessBanner(freshness, refresh),
        `Test plan for ${explicitTargets.files.length > 0 ? `${explicitTargets.files.length} target file(s)` : `${changed.length} changed files`}:`,
        ...(explicitTargets.files.length > 0 ? ["", "Target files:", ...explicitTargets.files.slice(0, 20).map((file) => `- ${file}`)] : []),
        ...(groups.length > 0 ? ["", "Change groups:", ...formatDiffGroups(groups.slice(0, 12))] : []),
        "",
        ...(changedSymbols.length > 0
          ? [
              "Changed symbols:",
              ...changedSymbols
                .slice(0, 20)
                .map((entry) => `- ${entry.symbol.qualifiedName} (${entry.symbol.kind}) at ${entry.symbol.path}:${entry.symbol.range?.startLine ?? 1}`)
            ]
          : []),
        ...formatTestRecommendations(tests.slice(0, 30)),
        ...(outcomeLearning.length > 0 ? ["", "Outcome learning:", ...formatOutcomeLearningRecommendations(outcomeLearning)] : []),
        "",
        "If run, these commands would cover:",
        ...formatVerificationCoverage(verificationCoverage),
        "",
        "Verification ledger preview if recommended commands are run:",
        ...formatVerificationLedger(verificationLedgerPreview),
        ...(unindexedChanged.length > 0 ? ["", "Changed but not indexed:", ...unindexedChanged.slice(0, 20).map((file) => `- ${file}`)] : []),
        "",
        "Known gaps:",
        ...formatGaps(gaps),
        ...(worktree ? worktreeStateText(worktree) : [])
      ].join("\n")
    : [
        freshnessBanner(freshness, refresh),
        noScopeTestPlanMessage({ explicitTargetsProvided, worktreeDegraded: worktree?.degraded ?? false }),
        "",
        "Next action:",
        "- Pass target files or make a code change before asking Codexa for targeted verification.",
        "",
        "Known gaps:",
        ...formatGaps(gaps),
        ...(worktree ? worktreeStateText(worktree) : [])
      ].join("\n");
  return {
    freshness,
    refresh,
    text: limitText(text, 6000),
    data: {
      mode: "test_plan",
      actionability,
      targetFiles: explicitTargets.files.slice(0, 120),
      unindexedTargetFiles: explicitTargets.unindexed.slice(0, 120),
      rejectedTargetFiles: explicitTargets.rejected.slice(0, 120),
      changedFiles: changed.slice(0, 120),
      changedEntries: changedEntries.slice(0, 120),
      changedSymbols: changedSymbols.slice(0, 80).map(compactChangedSymbol),
      unindexedChanged: unindexedChanged.slice(0, 80),
      worktree: worktree ? compactWorktreeState(worktree) : undefined,
      worktreeDegradationReasons: worktree?.degradedReasons ?? [],
      groups: groups.slice(0, 20).map(compactDiffGroup),
      tests: tests.slice(0, 30),
      outcomeLearning,
      verificationCommands: verificationCommands.slice(0, 30),
      verificationCoverage: verificationCoverage.slice(0, 60),
        commandEnvelopes: verificationPreview.commandEnvelopes.slice(0, 60),
          verificationCommandPlan: commandPlan.slice(0, 40),
          verificationLedgerPreview: verificationLedgerPreview.slice(0, 60),
          verificationProvenance: CURRENT_VERIFICATION_PROVENANCE,
          testsNotRun: missingVerification.testsNotRun.slice(0, 30),
      gaps
    }
  };
}

function noScopeTestPlanMessage(input: { explicitTargetsProvided: boolean; worktreeDegraded: boolean }): string {
  if (input.explicitTargetsProvided) {
    return "No targeted test plan: supplied target files were invalid or are not indexed.";
  }
  if (input.worktreeDegraded) {
    return "No targeted test plan: worktree state is unknown and no target files were supplied.";
  }
  return "No targeted test plan: no current diff and no target files supplied.";
}

function resolveTargetFiles(
  rawFiles: string[] | undefined,
  repoRoot: string,
  indexedPaths: Set<string>
): { files: string[]; unindexed: string[]; rejected: string[]; gaps: string[] } {
  const files: string[] = [];
  const unindexed: string[] = [];
  const rejected: string[] = [];
  for (const raw of rawFiles ?? []) {
    const normalized = normalizeTargetFile(raw, repoRoot);
    if (!normalized) {
      rejected.push(raw);
      continue;
    }
    if (indexedPaths.has(normalized)) {
      files.push(normalized);
    } else {
      unindexed.push(normalized);
    }
  }
  const uniqueFiles = uniqueInOrder(files);
  const uniqueUnindexed = uniqueInOrder(unindexed);
  const uniqueRejected = uniqueInOrder(rejected);
  const gaps = [
    uniqueUnindexed.length > 0 ? `target files not indexed: ${uniqueUnindexed.slice(0, 5).join(", ")}${uniqueUnindexed.length > 5 ? ", ..." : ""}` : undefined,
    uniqueRejected.length > 0 ? `target files rejected: ${uniqueRejected.slice(0, 5).join(", ")}${uniqueRejected.length > 5 ? ", ..." : ""}` : undefined
  ].filter((gap): gap is string => Boolean(gap));
  return { files: uniqueFiles, unindexed: uniqueUnindexed, rejected: uniqueRejected, gaps };
}

function normalizeTargetFile(raw: string, repoRoot: string): string | undefined {
  const value = raw.trim();
  if (!value || /[\x00-\x1f\x7f]/u.test(value) || value.includes("\\") || path.win32.isAbsolute(value)) {
    return undefined;
  }
  const absolute = path.resolve(repoRoot, value);
  const relative = normalizePath(path.relative(repoRoot, absolute));
  if (!relative || relative === "." || relative.startsWith("../") || path.isAbsolute(relative)) {
    return undefined;
  }
  return relative;
}

function uniqueInOrder(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (!seen.has(value)) {
      seen.add(value);
      result.push(value);
    }
  }
  return result;
}

function markLedgerAsPreview(ledger: VerificationLedgerEntry[]): VerificationLedgerEntry[] {
  return ledger.map((entry) =>
    entry.status === "covered"
      ? {
          ...entry,
          status: "would_cover",
          evidence: entry.evidence.map((item) => `would cover if run: ${item}`)
        }
      : entry
  );
}
