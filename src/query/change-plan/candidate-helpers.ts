import type { SymbolFact } from "../../types.js";
import { stableId, uniqueSorted } from "../../util.js";
import type { ChangePlanTargetCandidate, ChangePlanTargetCandidateBase, ChangePlanTargetCandidateDraft } from "../change-plan.js";
import { normalizeSearchText } from "../search.js";
import type { RepositoryTargetPathAuthority } from "../targets.js";

export function candidateSymbols(symbols: SymbolFact[], taskTokens: string[]): SymbolFact[] {
  return symbols
    .slice()
    .sort(
      (left, right) =>
        symbolTargetScore(right, taskTokens) - symbolTargetScore(left, taskTokens) ||
        (left.range?.startLine ?? 0) - (right.range?.startLine ?? 0) ||
        left.qualifiedName.localeCompare(right.qualifiedName)
    );
}

function symbolTargetScore(symbol: SymbolFact, taskTokens: string[]): number {
  const normalized = normalizeSearchText(`${symbol.name} ${symbol.qualifiedName}`);
  const tokenScore = taskTokens.filter((token) => normalized.includes(token)).length * 20;
  const kindScore = symbol.kind === "route" ? 18 : symbol.exported ? 14 : ["function", "method", "class"].includes(symbol.kind) ? 10 : 4;
  return tokenScore + kindScore;
}

export function dedupeTargetCandidates(candidates: ChangePlanTargetCandidateDraft[]): ChangePlanTargetCandidateDraft[] {
  const seen = new Set<string>();
  const result: ChangePlanTargetCandidateDraft[] = [];
  for (const candidate of candidates) {
    const key = targetCandidateStableTarget(candidate);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(candidate);
  }
  return result;
}

export function withTargetCandidateId(candidate: ChangePlanTargetCandidateDraft): ChangePlanTargetCandidateBase {
  return { ...candidate, candidateId: targetCandidateStableId(candidate) };
}

function targetCandidateStableId(candidate: ChangePlanTargetCandidateDraft): string {
  return `candidate-${stableId("change-plan-target-candidate", targetCandidateStableTarget(candidate)).slice(0, 12)}`;
}

function targetCandidateStableTarget(candidate: ChangePlanTargetCandidateDraft): string {
  const target = candidate.symbol
    ? `${candidate.symbol.kind}:${candidate.symbol.qualifiedName || candidate.symbol.name || candidate.symbol.id}`
    : candidate.nextChangePlanArgs.files?.join("\n") ?? candidate.path;
  return `${candidate.kind}:${candidate.path}:${target}`;
}

export function uniqueInOrder(values: Iterable<string>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

export function canonicalCandidateReplayFiles(
  files: string[] | undefined,
  authorities: RepositoryTargetPathAuthority[]
): string[] | undefined {
  return files?.map((filePath, index) => authorities[index]?.status === "indexed" && authorities[index]?.path ? authorities[index].path : filePath);
}

export function meaningfulTaskTokens(value: string): string[] {
  const stop = new Set(["a", "an", "and", "as", "for", "how", "in", "of", "on", "or", "safely", "the", "to", "with"]);
  return uniqueSorted(
    normalizeSearchText(value)
      .split(/\s+/u)
      .map((token) => token.trim())
      .filter((token) => token.length >= 3 && !stop.has(token))
  ).slice(0, 8);
}

export function rawSearchQueries(task: string | undefined, target: string): string[] {
  const taskPart = meaningfulTaskTokens(task ?? "").slice(0, 4).join(" ");
  const targetPart = target.split(/[/.]/u).filter(Boolean).slice(-2).join(" ");
  return uniqueSorted([taskPart, targetPart, `${taskPart} ${targetPart}`].map((entry) => entry.trim()).filter(Boolean)).slice(0, 3);
}

export function formatTargetCandidates(candidates: ChangePlanTargetCandidate[]): string[] {
  if (candidates.length === 0) return ["- none ranked from current packet; run search/raw search to find a file or symbol target."];
  return candidates.slice(0, 6).map((candidate) => {
    const target = candidate.kind === "symbol" && candidate.symbol ? `${candidate.symbol.qualifiedName} in ${candidate.path}` : candidate.path;
    const nextArg = candidate.nextChangePlanArgs.files?.[0] ?? candidate.nextChangePlanArgs.symbols?.[0] ?? target;
    return `- #${candidate.rank} ${candidate.candidateId} ${candidate.kind} ${target}: ${candidate.validationStatus}; score ${candidate.score.toFixed(1)}; risk ${candidate.candidateRisk.score.toFixed(1)}; followCandidate ${candidate.candidateId}; next change_plan target ${nextArg}; ${candidate.evidence.slice(0, 3).join("; ")}`;
  });
}

export function followedReplaySnapshotTargets(resultData: Record<string, unknown>, candidateTargets: string[]): string[] | undefined {
  const readiness = resultData.editReadiness && typeof resultData.editReadiness === "object" ? resultData.editReadiness as Record<string, unknown> : undefined;
  const snapshot = resultData.snapshot && typeof resultData.snapshot === "object" ? resultData.snapshot as Record<string, unknown> : undefined;
  const context = resultData.context && typeof resultData.context === "object" ? resultData.context as Record<string, unknown> : undefined;
  const snapshotTargets = Array.isArray(snapshot?.plannedEditTargets) ? snapshot.plannedEditTargets.filter((entry): entry is string => typeof entry === "string") : [];
  const packetTargets = Array.isArray(context?.boundedPlanTargets) ? context.boundedPlanTargets.filter((entry): entry is string => typeof entry === "string") : [];
  const requiredTargets = uniqueSorted([...candidateTargets, ...packetTargets]);
  return readiness?.editable === true && snapshot && requiredTargets.length > 0 && requiredTargets.every((filePath) => snapshotTargets.includes(filePath))
    ? uniqueSorted(snapshotTargets)
    : undefined;
}
