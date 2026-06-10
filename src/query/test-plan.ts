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
import { limitText } from "../util.js";

export interface TestPlanOptions extends QueryOptions {
  changeType?: ChangeType;
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
  const groups = groupDiffImpact(index, changedEntries, changedSymbols, unindexedChanged);
  const gaps = [...indexGaps(index, freshness, unindexedChanged), ...(worktree ? worktreeStateGaps(worktree) : [])];
  const changeType: ChangeType = options.changeType ?? "unknown";
  const tests = recommendTests(
    index,
    changed.length > 0 ? changed : index.files.slice(0, 10).map((file) => file.path),
    repoRoot,
    changeType
  );
  const outcomeLearning = outcomeLearningRecommendations(tests, 8);
  const verificationCommands = verificationCommandsForContext(index, repoRoot, changed.length > 0 ? changed : index.files.slice(0, 10).map((file) => file.path), tests, 16);
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
  const text = [
    freshnessBanner(freshness, refresh),
    `Test plan for ${changed.length > 0 ? `${changed.length} changed files` : "top-ranked files"}:`,
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
  ].join("\n");
  return {
    freshness,
    refresh,
    text: limitText(text, 6000),
    data: {
      mode: "test_plan",
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
