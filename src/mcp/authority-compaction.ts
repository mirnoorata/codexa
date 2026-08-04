import { isRecord, structuredByteLength } from "./compaction-helpers.js";

/**
 * Preserve small, explicit edit boundaries across last-resort tiers. If an
 * authority array is itself too wide for the transport budget, the boundary
 * scan fails closed instead of silently authorizing a subset.
 */
export function exactTopLevelAuthority(data: Record<string, unknown>): Record<string, unknown> {
  if (!isRecord(data.targetRoles)) {
    return {};
  }
  return {
    ...(Array.isArray(data.files) ? { files: data.files } : {}),
    ...(Array.isArray(data.plannedEditTargets) ? { plannedEditTargets: data.plannedEditTargets } : {}),
    targetRoles: {
      editableTargets: data.targetRoles.editableTargets,
      readDependencies: data.targetRoles.readDependencies,
      excludedTargets: data.targetRoles.excludedTargets,
      hasReferenceCue: data.targetRoles.hasReferenceCue,
      unresolvedReferenceCue: data.targetRoles.unresolvedReferenceCue
    }
  };
}

/** Keep the versioned verification receipt whole or replace untrusted growth. */
export function boundedVerificationProvenance(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  return structuredByteLength(value) <= 2_000 ? value : { truncated: true };
}
