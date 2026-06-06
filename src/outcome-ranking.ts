import { promises as fs } from "node:fs";
import path from "node:path";
import type { PostEditOutcome } from "./post-edit-outcomes.js";
import { normalizePath, uniqueSorted } from "./util.js";

const OUTCOME_DIR = ".codex/cache/codexa-outcomes";
const MAX_OUTCOME_FILES = 30;
const MAX_OUTCOME_BYTES = 256 * 1024;
const MAX_REASON_PER_PATH = 5;

export interface OutcomeRankSignals {
  boosts: Map<string, number>;
  reasons: Map<string, string[]>;
}

export async function loadOutcomeRankSignals(repoRoot: string, headCommit: string | null, indexedPaths: Set<string>): Promise<OutcomeRankSignals> {
  const empty: OutcomeRankSignals = { boosts: new Map(), reasons: new Map() };
  const outcomeDir = path.join(repoRoot, OUTCOME_DIR);
  let entries: Array<{ name: string; mtimeMs: number; size: number }>;
  try {
    entries = (
      await Promise.all(
        (await fs.readdir(outcomeDir, { withFileTypes: true })).flatMap(async (entry) => {
          if (!entry.isFile() || !entry.name.endsWith(".json")) {
            return [];
          }
          const stat = await fs.stat(path.join(outcomeDir, entry.name)).catch(() => null);
          return stat ? [{ name: entry.name, mtimeMs: stat.mtimeMs, size: stat.size }] : [];
        })
      )
    ).flat();
  } catch {
    return empty;
  }

  const signals: OutcomeRankSignals = { boosts: new Map(), reasons: new Map() };
  const seenOutcomeIds = new Set<string>();
  for (const entry of entries.sort((a, b) => b.mtimeMs - a.mtimeMs || a.name.localeCompare(b.name)).slice(0, MAX_OUTCOME_FILES)) {
    if (entry.size > MAX_OUTCOME_BYTES) {
      continue;
    }
    let parsed: Partial<PostEditOutcome>;
    try {
      parsed = JSON.parse(await fs.readFile(path.join(outcomeDir, entry.name), "utf8")) as Partial<PostEditOutcome>;
    } catch {
      continue;
    }
    if (parsed.schemaVersion !== 1 || !parsed.outcomeId || seenOutcomeIds.has(parsed.outcomeId)) {
      continue;
    }
    if (parsed.headCommit && headCommit && parsed.headCommit !== headCommit) {
      continue;
    }
    seenOutcomeIds.add(parsed.outcomeId);
    applyOutcome(signals, parsed, indexedPaths);
  }
  return signals;
}

function applyOutcome(signals: OutcomeRankSignals, outcome: Partial<PostEditOutcome>, indexedPaths: Set<string>): void {
  for (const filePath of stringArray(outcome.unplannedEditedFiles)) {
    add(signals, indexedPaths, filePath, 1.1, "outcome: edited outside a saved plan");
  }
  for (const filePath of stringArray(outcome.reviewTargets)) {
    add(signals, indexedPaths, filePath, 0.25, "outcome: recent review target");
  }
  for (const filePath of stringArray(outcome.changedFiles)) {
    add(signals, indexedPaths, filePath, 0.2, "outcome: recent changed file");
  }
  for (const entry of recordArray(outcome.riskDeltas)) {
    if (numberValue(entry.delta) && numberValue(entry.delta)! > 0) {
      add(signals, indexedPaths, stringValue(entry.path), 0.6, "outcome: risk increased after edit");
    }
  }
  for (const value of stringArray(outcome.modifiedPublicSymbols)) {
    add(signals, indexedPaths, pathFromSymbolDisplay(value), 0.9, "outcome: public symbol changed recently");
  }
  for (const value of stringArray(outcome.modifiedSymbols)) {
    add(signals, indexedPaths, pathFromSymbolDisplay(value), 0.45, "outcome: symbol changed recently");
  }
  for (const test of recordArray(outcome.missedLikelyTests)) {
    add(signals, indexedPaths, stringValue(test.path), 1.4, "outcome: likely test was missed after an edit");
  }
  for (const test of recordArray(outcome.testsNotRun)) {
    add(signals, indexedPaths, stringValue(test.path), 0.9, "outcome: recommended test was not accounted for");
  }
  for (const test of recordArray(outcome.recommendedTests)) {
    add(signals, indexedPaths, stringValue(test.path), 0.25, "outcome: test repeatedly recommended for local edits");
  }
}

function add(signals: OutcomeRankSignals, indexedPaths: Set<string>, rawPath: string | undefined, amount: number, reason: string): void {
  const filePath = normalizeRepoRelativePath(rawPath);
  if (!filePath || !indexedPaths.has(filePath)) {
    return;
  }
  signals.boosts.set(filePath, Math.min(3, (signals.boosts.get(filePath) ?? 0) + amount));
  const reasons = new Set(signals.reasons.get(filePath) ?? []);
  reasons.add(reason);
  signals.reasons.set(filePath, uniqueSorted(reasons).slice(0, MAX_REASON_PER_PATH));
}

function normalizeRepoRelativePath(rawPath: string | undefined): string | undefined {
  if (!rawPath || rawPath.includes("\0") || path.isAbsolute(rawPath)) {
    return undefined;
  }
  const normalized = normalizePath(rawPath);
  if (normalized === "." || normalized.startsWith("../") || normalized === "..") {
    return undefined;
  }
  return normalized;
}

function pathFromSymbolDisplay(value: string): string | undefined {
  const match = /\sin\s+(.+)$/u.exec(value);
  return match?.[1]?.trim();
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0) : [];
}

function recordArray(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.filter((entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === "object" && !Array.isArray(entry))) : [];
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
