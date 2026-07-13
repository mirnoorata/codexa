import type { PostEditCheckResult } from "../../post-edit-outcomes.js";
import type { VerificationArtifactEvaluation } from "../../verification-artifacts.js";
import type { VerificationArtifactSummary } from "../../types.js";

export function applyArtifactRequiredChecks(checks: PostEditCheckResult[], artifacts: VerificationArtifactEvaluation): PostEditCheckResult[] {
  const evidence = new Map(artifacts.ledgerEvidence.map((entry) => [`${entry.kind}:${entry.target}`, entry]));
  return checks.map((check) => {
    const artifact = evidence.get(`${check.kind}:${check.target}`);
    if (!artifact) return check;
    return artifact.status === "covered"
      ? { ...check, status: "covered", trustTier: "reported" }
      : { ...check, status: "missing", trustTier: "none" };
  });
}

export function failedVerificationArtifactIds(artifacts: VerificationArtifactEvaluation): string[] {
  return artifacts.selected.filter((artifact) => artifact.status !== "accepted").map((artifact) => artifact.artifactId).sort();
}

export function formatPostEditArtifacts(artifacts: VerificationArtifactSummary[]): string[] {
  if (artifacts.length === 0) return [];
  return ["", "Selected verification artifacts:", ...artifacts.map((artifact) => `- ${artifact.artifactId}: ${artifact.status}; trust ${artifact.trustTier}${artifact.runId ? `; run ${artifact.runId}` : ""}`)];
}
