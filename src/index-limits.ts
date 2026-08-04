// Build and load must share this ceiling so Codexa never publishes an index
// that a later process is required to reject.
export const MAX_INDEX_ARTIFACT_BYTES = 512 * 1024 * 1024;
