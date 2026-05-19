import type { FreshnessInfo } from "../types.js";
import { uniqueSorted } from "../util.js";

export interface ContextQuality {
  level: "high" | "medium" | "low";
  recommendation: string;
  reasons: string[];
  counts: {
    authoritative: number;
    derived: number;
    heuristic: number;
    fallback: number;
  };
}

export type ValueMode = "search" | "impact" | "context_pack" | "dirty_diff_review";
export type ValueLevel = "high" | "medium" | "low" | "raw-sufficient";

export interface ValueEstimate {
  mode: ValueMode;
  value: ValueLevel;
  reason: string;
}

export function assessContextQuality(input: {
  freshness: FreshnessInfo;
  gaps: string[];
  tiers: ContextQuality["counts"];
  selectedCount: number;
  rawSufficient?: boolean;
  fanoutCount?: number;
  testCount?: number;
  queryBroad?: boolean;
  centralFileCount?: number;
  packetVerdict?: string;
  discardedAnchorCount?: number;
}): ContextQuality {
  const reasons: string[] = [];
  const evidenceBacked = input.tiers.authoritative + input.tiers.derived;
  const totalEvidence = evidenceBacked + input.tiers.heuristic + input.tiers.fallback;
  const heuristicDominates = input.tiers.heuristic > evidenceBacked && input.tiers.heuristic > 0;
  const parserGapsPresent = input.gaps.some((gap) => gap.startsWith("parser errors"));
  const worktreeUnknown = input.gaps.some((gap) => gap.startsWith("worktree state unavailable"));
  const broadFanout = (input.fanoutCount ?? 0) > Math.max(10, input.selectedCount * 2);
  const allHeuristic = evidenceBacked === 0 && input.tiers.heuristic > 0;
  const missingLikelyTest = (input.testCount ?? 1) === 0 && input.selectedCount > 0 && !input.rawSufficient;
  const centralHeavy = (input.centralFileCount ?? 0) >= Math.max(4, input.selectedCount - 1) && input.selectedCount >= 6;
  const discardedAnchors = input.discardedAnchorCount ?? 0;
  const rawSearchBetterPacket = input.packetVerdict === "raw-search-better";
  const needsTargetPacket = input.packetVerdict === "needs-target";
  if (input.selectedCount === 0 || totalEvidence === 0) {
    reasons.push("no indexed evidence selected");
  }
  if (input.rawSufficient) {
    reasons.push("raw exact search is narrow");
  }
  if (input.freshness.stale) {
    reasons.push(`index stale: ${input.freshness.reason}`);
  }
  if (input.tiers.fallback > 0 && evidenceBacked === 0) {
    reasons.push("fallback-only context");
  }
  if (heuristicDominates) {
    reasons.push("heuristic links dominate");
  }
  if (allHeuristic) {
    reasons.push("all selected evidence is heuristic");
  }
  if (parserGapsPresent) {
    reasons.push("parser gaps present");
  }
  if (worktreeUnknown) {
    reasons.push("worktree state is unknown");
  }
  if (broadFanout) {
    reasons.push(`broad fanout: ${input.fanoutCount} affected, ${input.selectedCount} read-first`);
  }
  if (missingLikelyTest) {
    reasons.push("no likely test evidence selected");
  }
  if (input.queryBroad) {
    reasons.push("broad natural-language task");
  }
  if (centralHeavy) {
    reasons.push("central-file-heavy context; verify task-specific relevance");
  }
  if (discardedAnchors > 0) {
    reasons.push(`${discardedAnchors} retrieval anchor(s) were not selected`);
  }
  if (rawSearchBetterPacket) {
    reasons.push("packet verdict recommends raw search first");
  } else if (needsTargetPacket && input.queryBroad) {
    reasons.push("broad task needs a narrower edit target");
  }

  let level: ContextQuality["level"] = "high";
  let recommendation = "Use the authoritative/derived context first; expand only if the source read leaves a gap.";
  if (input.selectedCount === 0 || totalEvidence === 0) {
    level = "low";
    recommendation = "No indexed evidence was found. Use raw search or provide an explicit file/symbol before relying on Codexa.";
  } else if (input.tiers.fallback > 0 && evidenceBacked === 0) {
    level = "low";
    recommendation = "No confident focus was found. Use raw search or provide an explicit file/symbol before relying on this packet.";
  } else if (rawSearchBetterPacket) {
    level = "low";
    recommendation = "Use raw search or provide a narrower file/symbol target before edit planning.";
  } else if (allHeuristic) {
    level = "low";
    recommendation = "Only heuristic context was selected. Use this as a lead, then verify with source reads, callers, and tests before editing.";
  } else if (input.freshness.stale || heuristicDominates || parserGapsPresent || worktreeUnknown || missingLikelyTest || centralHeavy || discardedAnchors > 0 || (needsTargetPacket && input.queryBroad)) {
    level = "medium";
    recommendation = "Treat heuristic entries as expansion candidates, not edit targets. Verify by reading source and tests.";
  } else if (broadFanout) {
    level = "medium";
    recommendation = "Use the read-first set as a starting point, then widen source and test reads if the task touches shared behavior.";
  }
  if (input.rawSufficient && input.selectedCount > 0 && totalEvidence > 0 && totalEvidence <= 3) {
    level = "high";
    recommendation = "Raw search is sufficient for the lookup; use Codexa only for impact, tests, or freshness.";
  }
  return {
    level,
    recommendation,
    reasons: reasons.length > 0 ? uniqueSorted(reasons) : ["evidence-backed selection"],
    counts: input.tiers
  };
}

export function formatContextQuality(quality: ContextQuality): string {
  return `Context quality: ${quality.level}; ${quality.recommendation} Reasons: ${quality.reasons.join("; ")}. Evidence counts: authoritative ${quality.counts.authoritative}, derived ${quality.counts.derived}, heuristic ${quality.counts.heuristic}, fallback ${quality.counts.fallback}.`;
}

export function valueEstimate(
  mode: ValueMode,
  stats: {
    rawFileCount?: number;
    codexaFileCount?: number;
    exactTargetCount?: number;
    testCount?: number;
    parserErrors?: number;
    affectedCount?: number;
    quality?: ContextQuality;
  }
): ValueEstimate {
  const raw = stats.rawFileCount ?? 0;
  const selected = stats.codexaFileCount ?? 0;
  const tests = stats.testCount ?? 0;
  const exact = stats.exactTargetCount ?? 0;
  const affected = stats.affectedCount ?? 0;
  const gaps = stats.parserErrors ?? 0;
  if (stats.quality?.level === "low") {
    return { mode, value: "low", reason: "context quality is low; use raw search or explicit targets before relying on Codexa" };
  }
  if (mode === "search" && raw > 0 && raw <= 3 && exact > 0) {
    return { mode, value: "raw-sufficient", reason: "exact search is already narrow; use Codexa only if you need impact or tests" };
  }
  if (stats.quality?.level === "medium" && (stats.quality.counts.heuristic > stats.quality.counts.authoritative + stats.quality.counts.derived || gaps > 0)) {
    return { mode, value: "medium", reason: "useful context, but heuristic or parser-gap evidence requires source verification" };
  }
  if ((mode === "impact" || mode === "context_pack") && stats.quality?.level === "high" && (affected >= 8 || tests > 0)) {
    return { mode, value: "high", reason: "adds blast-radius grouping, test targeting, and gap labels beyond raw search" };
  }
  if (raw > 0 && selected > 0 && selected < raw) {
    return { mode, value: "high", reason: `compresses ${raw} raw hits/files into ${selected} ranked read-first files` };
  }
  if (exact > 0 || tests > 0 || affected > selected) {
    return { mode, value: "medium", reason: "adds ranking or verification context, but raw search may already expose the main target" };
  }
  if (gaps > 0) {
    return { mode, value: "low", reason: "index has known parser gaps; treat results as orientation and verify with source reads" };
  }
  return { mode, value: "low", reason: "no strong evidence that Codexa adds much beyond direct source inspection for this query" };
}

export function formatValueEstimate(value: ValueEstimate): string {
  return `Codexa value: ${value.value}; mode: ${value.mode}; ${value.reason}`;
}
