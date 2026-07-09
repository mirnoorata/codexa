import { describe, expect, it } from "vitest";
import { toToolResult } from "../src/mcp/envelope.js";

const POLICY = { autoRefresh: true, sessionMemoryMode: "auto" };

function envelopeWorktree(data: Record<string, unknown>): { knownClean: boolean; unknown: boolean; degraded: boolean; dirtyFileCount: number } {
  const result = toToolResult({ text: "x", data, freshness: { stale: false } }, "freshness", POLICY);
  return (result.structuredContent as { worktree: { knownClean: boolean; unknown: boolean; degraded: boolean; dirtyFileCount: number } }).worktree;
}

describe("envelope worktree honesty", () => {
  it("renders absent worktree data as unknown, never clean-by-omission", () => {
    const worktree = envelopeWorktree({ mode: "freshness" });
    expect(worktree.knownClean).toBe(false);
    expect(worktree.unknown).toBe(true);
    expect(worktree.degraded).toBe(false);
  });

  it("renders an empty worktree record as unknown, not clean", () => {
    const worktree = envelopeWorktree({ mode: "freshness", worktree: {} });
    expect(worktree.knownClean).toBe(false);
    expect(worktree.unknown).toBe(true);
  });

  it("renders a real zero-dirty signal as known clean", () => {
    const worktree = envelopeWorktree({ mode: "freshness", runtime: { dirtyFileCount: 0 } });
    expect(worktree.knownClean).toBe(true);
    expect(worktree.unknown).toBe(false);
  });

  it("renders an empty changedFiles array as known clean, not unknown", () => {
    const worktree = envelopeWorktree({ mode: "freshness", changedFiles: [] });
    expect(worktree.knownClean).toBe(true);
    expect(worktree.unknown).toBe(false);
  });

  it("keeps degraded state fail-closed", () => {
    const worktree = envelopeWorktree({ mode: "freshness", worktreeDegradationReasons: ["git status timed out"] });
    expect(worktree.knownClean).toBe(false);
    expect(worktree.unknown).toBe(false);
    expect(worktree.degraded).toBe(true);
  });
});
