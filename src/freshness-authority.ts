export interface FreshnessAuthorityState {
  missing?: unknown;
  stale?: unknown;
  reason?: unknown;
}

/** Stable dirty source is lifecycle input; every other stale state blocks authority. */
export function freshnessBlocksAuthority(freshness: FreshnessAuthorityState | undefined): boolean {
  if (freshness?.missing === true) return true;
  if (freshness?.stale !== true) return false;
  return freshness.reason !== "dirty-files-changed";
}
