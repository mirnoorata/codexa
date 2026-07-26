import { isRecord } from "./compaction-helpers.js";

export function reviewCoverageKernel(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  const binding = isRecord(value.binding) ? value.binding : undefined;
  return defined({
    schemaVersion: primitive(value.schemaVersion),
    status: primitive(value.status),
    candidateTargetCount: primitive(value.candidateTargetCount),
    analyzedTargetCount: primitive(value.analyzedTargetCount),
    omittedTargetCount: primitive(value.omittedTargetCount),
    targetLimit: primitive(value.targetLimit),
    binding: binding
      ? defined({
          taskId: primitive(binding.taskId),
          planRevision: primitive(binding.planRevision),
          snapshotCreatedAt: primitive(binding.snapshotCreatedAt),
          snapshotPublicationSequence: primitive(binding.snapshotPublicationSequence),
          candidateTargetsDigest: primitive(binding.candidateTargetsDigest),
          analyzedTargetsDigest: primitive(binding.analyzedTargetsDigest)
        })
      : undefined
  });
}

export function postEditOutcomeKernel(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  return defined({
    outcomeId: primitive(value.outcomeId) ?? primitive(value.id),
    path: primitive(value.path),
    persisted: primitive(value.persisted),
    reviewCoverage: reviewCoverageKernel(value.reviewCoverage)
  });
}

function primitive(value: unknown): string | number | boolean | null | undefined {
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  return typeof value === "string" ? value.slice(0, 220) : undefined;
}

function defined(value: Record<string, unknown>): Record<string, unknown> | undefined {
  const entries = Object.entries(value).filter(([, entry]) => entry !== undefined);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}
