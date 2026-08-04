import { realpathSync } from "node:fs";
import path from "node:path";
import type { CodexaIndex, FreshnessInfo } from "./types.js";

export interface IndexIdentityView {
  snapshot: Pick<CodexaIndex["snapshot"], "repoRoot" | "snapshotId" | "headCommit" | "gitRoot">;
  freshness: Pick<FreshnessInfo, "repoRoot" | "snapshotId" | "headCommit" | "gitRoot">;
}

export type IndexIdentityReason =
  | "snapshot-repo-root-mismatch"
  | "freshness-repo-root-mismatch"
  | "snapshot-id-mismatch"
  | "snapshot-head-mismatch"
  | "snapshot-git-root-mismatch"
  | "head-commit-changed"
  | "repo-root-changed"
  | "git-state-degraded";

export interface IndexIdentityIssue {
  reason: IndexIdentityReason;
  expectedRepoRoot: string;
  indexedRepoRoot: string | null;
  indexedHeadCommit: string | null;
}

const LIVE_IDENTITY_REASONS = new Set<IndexIdentityReason>(["head-commit-changed", "repo-root-changed", "git-state-degraded"]);

export class IndexIdentityError extends Error {
  readonly code = "CODEXA_INDEX_IDENTITY_MISMATCH";
  readonly issue: IndexIdentityIssue;

  constructor(issue: IndexIdentityIssue) {
    const indexedRoot = issue.indexedRepoRoot ?? "unknown";
    const indexedHead = issue.indexedHeadCommit ?? "none";
    super(
      `Codexa index identity mismatch (${issue.reason}): selected repo ${issue.expectedRepoRoot}; indexed repo ${indexedRoot}; indexed HEAD ${indexedHead}. ` +
        `Run: codexa index ${issue.expectedRepoRoot}`
    );
    this.name = "IndexIdentityError";
    this.issue = issue;
  }
}

export function findIndexIdentityIssue(repoRoot: string, index: IndexIdentityView, freshness?: FreshnessInfo): IndexIdentityIssue | undefined {
  const expectedRepoRoot = path.resolve(repoRoot);
  const expectedCheckout = canonicalPath(expectedRepoRoot);
  const snapshotRepoRoot = resolvedPath(index.snapshot.repoRoot);
  const indexedFreshnessRepoRoot = resolvedPath(index.freshness.repoRoot);
  const base = {
    expectedRepoRoot,
    indexedRepoRoot: snapshotRepoRoot ?? indexedFreshnessRepoRoot,
    indexedHeadCommit: index.snapshot.headCommit
  };

  if (!snapshotRepoRoot || canonicalPath(snapshotRepoRoot) !== expectedCheckout) {
    return { ...base, reason: "snapshot-repo-root-mismatch" };
  }
  if (!indexedFreshnessRepoRoot || canonicalPath(indexedFreshnessRepoRoot) !== expectedCheckout) {
    return { ...base, reason: "freshness-repo-root-mismatch" };
  }
  if (!nonEmptyString(index.snapshot.snapshotId) || !nonEmptyString(index.freshness.snapshotId) || index.snapshot.snapshotId !== index.freshness.snapshotId) {
    return { ...base, reason: "snapshot-id-mismatch" };
  }
  if (!nullableString(index.snapshot.headCommit) || !nullableString(index.freshness.headCommit) || index.snapshot.headCommit !== index.freshness.headCommit) {
    return { ...base, reason: "snapshot-head-mismatch" };
  }
  if (!nullableString(index.snapshot.gitRoot) || !nullableString(index.freshness.gitRoot) || !sameOptionalPath(index.snapshot.gitRoot, index.freshness.gitRoot)) {
    return { ...base, reason: "snapshot-git-root-mismatch" };
  }
  if (freshness && LIVE_IDENTITY_REASONS.has(freshness.reason as IndexIdentityReason)) {
    return { ...base, reason: freshness.reason as IndexIdentityReason };
  }
  return undefined;
}

export function assertIndexIdentity(repoRoot: string, index: CodexaIndex, freshness?: FreshnessInfo): void {
  const issue = findIndexIdentityIssue(repoRoot, index, freshness);
  if (issue) {
    throw new IndexIdentityError(issue);
  }
}

export function canonicalPath(value: string): string {
  const resolved = path.resolve(value);
  try {
    return realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

function resolvedPath(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? path.resolve(value) : null;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function nullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function sameOptionalPath(left: unknown, right: unknown): boolean {
  if (left === null && right === null) {
    return true;
  }
  const resolvedLeft = resolvedPath(left);
  const resolvedRight = resolvedPath(right);
  return Boolean(resolvedLeft && resolvedRight && canonicalPath(resolvedLeft) === canonicalPath(resolvedRight));
}
