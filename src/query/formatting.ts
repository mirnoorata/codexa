import type { Confidence, EvidenceTier } from "../types.js";
import { limitText, uniqueSorted } from "../util.js";
import type { ContextQuality } from "./quality.js";

export function confidenceTier(confidence: Confidence): EvidenceTier {
  return confidence === "authoritative" ? "authoritative" : confidence === "derived" ? "derived" : "heuristic";
}

export function tierScore(tier: EvidenceTier): number {
  return tier === "authoritative" ? 0 : tier === "derived" ? 1 : tier === "heuristic" ? 2 : 3;
}

export function tierCounts(tiers: Record<"authoritative" | "derived" | "heuristic", unknown[]>): ContextQuality["counts"] {
  return {
    authoritative: tiers.authoritative.length,
    derived: tiers.derived.length,
    heuristic: tiers.heuristic.length,
    fallback: 0
  };
}

export function betterTier(a: EvidenceTier, b: EvidenceTier): EvidenceTier {
  return tierScore(a) <= tierScore(b) ? a : b;
}

export function focusTierCounts(entries: Array<{ tier: EvidenceTier }>): ContextQuality["counts"] {
  const counts: ContextQuality["counts"] = { authoritative: 0, derived: 0, heuristic: 0, fallback: 0 };
  for (const entry of entries) {
    counts[entry.tier] += 1;
  }
  return counts;
}

export function formatReasons(reasons: Iterable<string>, displayLimit = 8): string {
  const values = uniqueSorted([...reasons]);
  if (values.length <= displayLimit) {
    return values.join("; ");
  }
  return `${values.slice(0, displayLimit).join("; ")}; +${values.length - displayLimit} more`;
}

export function formatRecipes(recipes: string[]): string[] {
  return recipes.length > 0 ? recipes.map((recipe) => `- ${recipe}`) : ["- none"];
}

export function limitTextToTokens(value: string, tokenBudget: number): string {
  return limitText(value, Math.max(1000, tokenBudget * 4));
}

export function fitLinesToTokenBudget(lines: string[], tokenBudget: number, message = "repo map entries"): string {
  const maxChars = Math.max(1000, tokenBudget * 4);
  const kept: string[] = [];
  let length = 0;
  const truncation = `... truncated to ${tokenBudget} token budget; increase --budget for more ${message}`;
  for (const line of lines) {
    const nextLength = length + line.length + 1;
    if (nextLength > maxChars) {
      while (kept.length > 0 && length + truncation.length + 1 > maxChars) {
        const removed = kept.pop() ?? "";
        length -= removed.length + 1;
      }
      if (truncation.length <= maxChars) {
        kept.push(truncation);
      }
      break;
    }
    kept.push(line);
    length = nextLength;
  }
  return kept.join("\n");
}

export function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.max(min, Math.min(max, Math.trunc(value)));
}
