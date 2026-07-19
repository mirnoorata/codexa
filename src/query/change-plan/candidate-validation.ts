import type { CodexaIndex, FileFact } from "../../types.js";
import { uniqueSorted } from "../../util.js";
import type { ChangePlanTargetCandidateBase, ChangePlanTargetCandidateValidation, TargetCandidateRisk, TargetCandidateValidationStatus } from "../change-plan.js";
import { findFile, resolveFileTarget, resolveSymbolTarget } from "../targets.js";
import { recommendTests } from "../tests.js";
import { uniqueInOrder } from "./candidate-helpers.js";

export function validateChangePlanTargetCandidate(
  candidate: ChangePlanTargetCandidateBase,
  context: { index: CodexaIndex; repoRoot: string }
): ChangePlanTargetCandidateValidation {
  const validationReasons: string[] = [];
  const wouldPlanEditTargets = new Set<string>();
  let unresolvedTarget = false;
  let ambiguousTarget = false;
  const requestedFiles = candidate.nextChangePlanArgs.files ?? [];
  const requestedSymbols = candidate.nextChangePlanArgs.symbols ?? [];
  if (requestedFiles.length === 0 && requestedSymbols.length === 0) {
    validationReasons.push("no explicit file or symbol target in nextChangePlanArgs");
    unresolvedTarget = true;
  }

  for (const requestedFile of requestedFiles) {
    const resolved = resolveFileTarget(context.index, requestedFile, context.repoRoot);
    if (resolved.file) {
      wouldPlanEditTargets.add(resolved.file.path);
      validationReasons.push(`file target resolves: ${resolved.file.path}`);
    } else if (resolved.ambiguous.length > 0) {
      ambiguousTarget = true;
      validationReasons.push(`file target is ambiguous: ${requestedFile}`);
    } else {
      unresolvedTarget = true;
      validationReasons.push(`file target not indexed: ${requestedFile}`);
    }
  }

  for (const requestedSymbol of requestedSymbols) {
    const resolved = resolveSymbolTarget(context.index, requestedSymbol);
    const selectedAmbiguous = resolved.ambiguous.filter((symbol) => wouldPlanEditTargets.has(symbol.path));
    const symbol = resolved.symbol ?? (selectedAmbiguous.length === 1 ? selectedAmbiguous[0] : undefined);
    if (symbol) {
      wouldPlanEditTargets.add(symbol.path);
      validationReasons.push(`symbol target resolves: ${symbol.qualifiedName} in ${symbol.path}`);
    } else if (resolved.ambiguous.length > 0) {
      ambiguousTarget = true;
      validationReasons.push(`symbol target is ambiguous: ${requestedSymbol}`);
    } else {
      unresolvedTarget = true;
      validationReasons.push(`symbol target not indexed: ${requestedSymbol}`);
    }
  }

  const plannedTargets = uniqueSorted(wouldPlanEditTargets);
  if (candidate.confidence === "fallback") validationReasons.push("candidate evidence is fallback");
  else if (candidate.evidence.length > 0) validationReasons.push(`candidate has ${candidate.confidence} evidence`);
  if (candidate.evidence.length === 0) validationReasons.push("candidate has no supporting evidence");

  const wouldRecommendTests = plannedTargets.length > 0
    ? recommendTests(context.index, plannedTargets, context.repoRoot, candidate.nextChangePlanArgs.changeType).map((test) => test.path).slice(0, 8)
    : [];
  validationReasons.push(wouldRecommendTests.length > 0 ? `would recommend ${wouldRecommendTests.length} targeted test(s)` : "no targeted test recommendation proven");

  const candidateRisk = candidateRiskForTargets(context.index, plannedTargets);
  if (candidateRisk.score > 0) validationReasons.push(`candidate risk score ${candidateRisk.score.toFixed(1)}`);
  const hasStrongEvidence = (candidate.confidence === "authoritative" || candidate.confidence === "derived") && candidate.evidence.length > 0;
  const validationStatus: TargetCandidateValidationStatus = plannedTargets.length === 0 || unresolvedTarget || ambiguousTarget
    ? "needs-more-context"
    : hasStrongEvidence ? "edit-ready" : "weak";
  return {
    validationStatus,
    validationReasons: uniqueInOrder(validationReasons).slice(0, 8),
    wouldPlanEditTargets: plannedTargets,
    wouldRecommendTests,
    candidateRisk
  };
}

function candidateRiskForTargets(index: CodexaIndex, paths: string[]): TargetCandidateRisk {
  const pathSet = new Set(paths);
  const fileReasons = paths
    .map((filePath) => findFile(index, filePath))
    .filter((file): file is FileFact => Boolean(file))
    .filter((file) => file.riskScore > 0)
    .map((file) => ({ score: file.riskScore, reason: `${file.path}: indexed risk ${file.riskScore.toFixed(1)}` }));
  const signalReasons = index.risks
    .filter((risk) => pathSet.has(risk.path))
    .map((risk) => ({ score: risk.score, reason: `${risk.path}: ${risk.signal} - ${risk.reason}` }));
  const scoredReasons = [...fileReasons, ...signalReasons].sort((left, right) => right.score - left.score || left.reason.localeCompare(right.reason));
  return {
    score: Math.max(0, ...scoredReasons.map((entry) => entry.score)),
    reasons: uniqueInOrder(scoredReasons.map((entry) => entry.reason)).slice(0, 6)
  };
}
