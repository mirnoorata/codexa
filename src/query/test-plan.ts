import { formatDiffGroups, formatGaps, groupDiffImpact, indexGaps } from "./diff.js";
import { freshnessBanner } from "./runtime.js";
import { ensureQuerySession, type QuerySessionInput } from "./session.js";
import { formatTestRecommendations, recommendTests } from "./tests.js";
import type { QueryOptions, QueryResult } from "../types.js";
import { limitText } from "../util.js";

export async function testPlanQuery(input: QuerySessionInput, diff = true, options: QueryOptions = {}): Promise<QueryResult> {
  const session = await ensureQuerySession(input, options);
  const { index, freshness, refresh, repoRoot } = session;
  const indexedPaths = new Set(index.files.map((file) => file.path));
  const changedEntries = diff ? await session.getChangedFileEntries() : [];
  const changed = changedEntries.map((entry) => entry.path);
  const changedSymbols = diff ? await session.getChangedSymbols() : [];
  const unindexedChanged = changed.filter((file) => !indexedPaths.has(file));
  const groups = groupDiffImpact(index, changedEntries, changedSymbols, unindexedChanged);
  const gaps = indexGaps(index, freshness, unindexedChanged);
  const tests = recommendTests(index, changed.length > 0 ? changed : index.files.slice(0, 10).map((file) => file.path), repoRoot);
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
    ...(unindexedChanged.length > 0 ? ["", "Changed but not indexed:", ...unindexedChanged.slice(0, 20).map((file) => `- ${file}`)] : []),
    "",
    "Known gaps:",
    ...formatGaps(gaps)
  ].join("\n");
  return { freshness, refresh, text: limitText(text, 6000), data: { changedFiles: changed, changedEntries, changedSymbols, unindexedChanged, groups, tests, gaps } };
}
