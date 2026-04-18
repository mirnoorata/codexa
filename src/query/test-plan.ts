import { formatDiffGroups, formatGaps, groupDiffImpact, indexGaps } from "./diff.js";
import { freshnessBanner } from "./runtime.js";
import { ensureQuerySession, type QuerySessionInput } from "./session.js";
import { formatTestRecommendations, recommendTests } from "./tests.js";
import { compactChangedSymbol, compactDiffGroup } from "./compact-data.js";
import {
  coverageForDisplay,
  formatVerificationCoverage,
  formatVerificationLedger,
  verificationCommandPlan,
  verificationCommandsForContext,
  verificationLedgerForPostEdit
} from "./verification.js";
import type { ChangeType, QueryOptions, QueryResult } from "../types.js";
import { limitText } from "../util.js";

export interface TestPlanOptions extends QueryOptions {
  changeType?: ChangeType;
}

export async function testPlanQuery(input: QuerySessionInput, diff = true, options: TestPlanOptions = {}): Promise<QueryResult> {
  const session = await ensureQuerySession(input, options);
  const { index, freshness, refresh, repoRoot } = session;
  const indexedPaths = new Set(index.files.map((file) => file.path));
  const changedEntries = diff ? await session.getChangedFileEntries() : [];
  const changed = changedEntries.map((entry) => entry.path);
  const changedSymbols = diff ? await session.getChangedSymbols() : [];
  const unindexedChanged = changed.filter((file) => !indexedPaths.has(file));
  const groups = groupDiffImpact(index, changedEntries, changedSymbols, unindexedChanged);
  const gaps = indexGaps(index, freshness, unindexedChanged);
  const changeType: ChangeType = options.changeType ?? "unknown";
  const tests = recommendTests(
    index,
    changed.length > 0 ? changed : index.files.slice(0, 10).map((file) => file.path),
    repoRoot,
    changeType
  );
  const verificationCommands = verificationCommandsForContext(index, repoRoot, changed.length > 0 ? changed : index.files.slice(0, 10).map((file) => file.path), tests, 16);
  const verificationCoverage = coverageForDisplay(index, verificationCommands, repoRoot);
  const commandPlan = verificationCommandPlan(verificationCoverage);
  const verificationLedgerPreview = verificationLedgerForPostEdit({
    index,
    tests,
    ranTests: [],
    ranCommands: verificationCommands,
    repoRoot
  }).ledger;
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
    "",
    "If run, these commands would cover:",
    ...formatVerificationCoverage(verificationCoverage),
    "",
    "Verification ledger preview if recommended commands are run:",
    ...formatVerificationLedger(verificationLedgerPreview),
    ...(unindexedChanged.length > 0 ? ["", "Changed but not indexed:", ...unindexedChanged.slice(0, 20).map((file) => `- ${file}`)] : []),
    "",
    "Known gaps:",
    ...formatGaps(gaps)
  ].join("\n");
  return {
    freshness,
    refresh,
    text: limitText(text, 6000),
    data: {
      changedFiles: changed.slice(0, 120),
      changedEntries: changedEntries.slice(0, 120),
      changedSymbols: changedSymbols.slice(0, 80).map(compactChangedSymbol),
      unindexedChanged: unindexedChanged.slice(0, 80),
      groups: groups.slice(0, 20).map(compactDiffGroup),
      tests: tests.slice(0, 30),
      verificationCommands: verificationCommands.slice(0, 30),
      verificationCoverage: verificationCoverage.slice(0, 60),
      verificationCommandPlan: commandPlan.slice(0, 40),
      verificationLedgerPreview: verificationLedgerPreview.slice(0, 60),
      gaps
    }
  };
}
