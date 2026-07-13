import path from "node:path";
import { describe, expect, it } from "vitest";
import type { CommandResult } from "../src/command.js";
import { getGitStateAsync, type GitCommandRunner } from "../src/git.js";
import { freshnessFromStored } from "../src/indexer/freshness.js";
import { indexGaps } from "../src/query/diff.js";
import type { CodexaIndex, FreshnessInfo } from "../src/types.js";

const REPO = path.resolve("/repo");

function gitResult(partial: Partial<CommandResult>): CommandResult {
  return {
    command: "git",
    args: [],
    stdout: "",
    stderr: "",
    exitCode: 0,
    signal: null,
    ok: true,
    timedOut: false,
    truncated: false,
    ...partial
  };
}

// Stubs the git invocations behind getGitStateAsync. Overrides replace
// the happy-path result for one subcommand so each test degrades exactly one
// step while the rest of the state read stays healthy.
function stubRunner(overrides: Partial<Record<"toplevel" | "head" | "lsFiles" | "status" | "churn", CommandResult>>): GitCommandRunner {
  return async (_command, args) => {
    if (args.includes("--show-toplevel")) {
      return overrides.toplevel ?? gitResult({ stdout: `${REPO}\n` });
    }
    if (args.includes("HEAD")) {
      return overrides.head ?? gitResult({ stdout: "abc123\n" });
    }
    if (args.includes("ls-files")) {
      return overrides.lsFiles ?? gitResult({ stdout: "a.ts\0b.ts\0" });
    }
    if (args.includes("status")) {
      return overrides.status ?? gitResult({ stdout: " M a.ts\0" });
    }
    return overrides.churn ?? gitResult({ stdout: "a.ts\n" });
  };
}

describe("getGitStateAsync degradation", () => {
  it("degrades on truncated status output and drops the trailing partial entry", async () => {
    const git = await getGitStateAsync(REPO, {
      commandRunner: stubRunner({
        status: gitResult({ ok: false, truncated: true, exitCode: null, stdout: " M a.ts\0?? partial-fragmen" })
      })
    });
    expect(git.dirtyFiles).toEqual(["a.ts"]);
    expect(git.degradedReasons).toEqual(["git status output truncated"]);
  });

  it("degrades on ls-files timeout and keeps only complete entries", async () => {
    const git = await getGitStateAsync(REPO, {
      commandRunner: stubRunner({
        lsFiles: gitResult({ ok: false, timedOut: true, exitCode: null, stdout: "a.ts\0b.ts\0half-a-pa" })
      })
    });
    expect(git.files).toEqual(["a.ts", "b.ts"]);
    expect(git.degradedReasons).toEqual(["git ls-files timed out"]);
  });

  it("still hard-fails on a real git status error", async () => {
    await expect(
      getGitStateAsync(REPO, {
        commandRunner: stubRunner({
          status: gitResult({ ok: false, exitCode: 128, stdout: "" })
        })
      })
    ).rejects.toThrow(/Failed to read git status/);
  });

  it("records a gap instead of silently zeroing churn", async () => {
    const git = await getGitStateAsync(REPO, {
      commandRunner: stubRunner({
        churn: gitResult({ ok: false, truncated: true, exitCode: null, stdout: "" })
      })
    });
    expect(git.churnByPath.size).toBe(0);
    expect(git.degradedReasons).toEqual(["git log churn output truncated; ranking proceeds without churn"]);
    expect(git.files).toEqual(["a.ts", "b.ts"]);
  });

  it("reports a clean read with no degraded reasons", async () => {
    const git = await getGitStateAsync(REPO, { commandRunner: stubRunner({}) });
    expect(git.degradedReasons).toEqual([]);
    expect(git.dirtyFiles).toEqual(["a.ts"]);
  });

  it("degrades when HEAD changes during a single git-state probe", async () => {
    let headReads = 0;
    const runner: GitCommandRunner = async (_command, args) => {
      if (args.includes("--show-toplevel")) {
        return gitResult({ stdout: `${REPO}\n` });
      }
      if (args.includes("HEAD")) {
        headReads += 1;
        return gitResult({ stdout: headReads === 1 ? "abc123\n" : "def456\n" });
      }
      if (args.includes("ls-files")) {
        return gitResult({ stdout: "a.ts\0" });
      }
      if (args.includes("status")) {
        return gitResult({ stdout: "" });
      }
      return gitResult({ stdout: "" });
    };

    const git = await getGitStateAsync(REPO, { commandRunner: runner });
    expect(git.headCommit).toBe("abc123");
    expect(git.degradedReasons).toContain("git HEAD changed during probe: abc123 -> def456");
  });

  it("degrades when the git root changes during a single git-state probe", async () => {
    let rootReads = 0;
    const nextRoot = path.resolve("/other-worktree");
    const runner: GitCommandRunner = async (_command, args) => {
      if (args.includes("--show-toplevel")) {
        rootReads += 1;
        return gitResult({ stdout: `${rootReads === 1 ? REPO : nextRoot}\n` });
      }
      if (args.includes("HEAD")) {
        return gitResult({ stdout: "abc123\n" });
      }
      if (args.includes("ls-files")) {
        return gitResult({ stdout: "a.ts\0" });
      }
      if (args.includes("status")) {
        return gitResult({ stdout: "" });
      }
      return gitResult({ stdout: "" });
    };

    const git = await getGitStateAsync(REPO, { commandRunner: runner });
    expect(git.gitRoot).toBe(REPO);
    expect(git.degradedReasons).toContain(`git root changed during probe: ${REPO} -> ${nextRoot}`);
  });
});

describe("freshness under a degraded git probe", () => {
  it("fails closed: a degraded probe can never report fresh", () => {
    const loaded = {
      schemaVersion: 1,
      snapshotId: "s1",
      repoRoot: REPO,
      gitRoot: REPO,
      headCommit: "abc123",
      indexedAt: "2026-07-09T00:00:00.000Z",
      dirtyFiles: [],
      indexedDirtyFiles: [],
      dirtyFileHashes: {},
      indexedDirtyFileHashes: {},
      missing: false,
      stale: false,
      reason: "fresh",
      parserErrorCount: 0
    } as FreshnessInfo;
    const current = {
      git: {
        repoRoot: REPO,
        gitRoot: REPO,
        headCommit: "abc123",
        files: [],
        dirtyFiles: [],
        churnByPath: new Map<string, number>(),
        degradedReasons: ["git status output truncated"]
      },
      dirtyFileHashes: {}
    };
    const empty = { reportHashes: {}, diagnostics: [] };
    const freshness = freshnessFromStored(REPO, current, empty, empty, loaded);
    expect(freshness.stale).toBe(true);
    expect(freshness.reason).toBe("git-state-degraded");
  });

  it("keeps an index-time degraded probe stale until a clean rebuild", () => {
    const loaded = {
      schemaVersion: 1,
      snapshotId: "s1",
      repoRoot: REPO,
      gitRoot: REPO,
      headCommit: "abc123",
      indexedAt: "2026-07-09T00:00:00.000Z",
      dirtyFiles: [],
      indexedDirtyFiles: [],
      dirtyFileHashes: {},
      indexedDirtyFileHashes: {},
      missing: false,
      stale: false,
      reason: "fresh",
      parserErrorCount: 0,
      degradedGitState: ["git HEAD changed during probe: abc123 -> def456"]
    } as FreshnessInfo;
    const current = {
      git: {
        repoRoot: REPO,
        gitRoot: REPO,
        headCommit: "abc123",
        files: [],
        dirtyFiles: [],
        churnByPath: new Map<string, number>(),
        degradedReasons: []
      },
      dirtyFileHashes: {}
    };
    const empty = { reportHashes: {}, diagnostics: [] };
    const freshness = freshnessFromStored(REPO, current, empty, empty, loaded);
    expect(freshness).toMatchObject({ stale: true, reason: "git-state-degraded" });
  });
});

describe("degraded git state in packet gaps", () => {
  it("surfaces degradedGitState from freshness as a packet gap", () => {
    const freshness = {
      stale: false,
      reason: "fresh",
      degradedGitState: ["git status output truncated"]
    } as FreshnessInfo;
    const index = { parserErrors: [], usageSites: [] } as unknown as CodexaIndex;
    expect(indexGaps(index, freshness)).toContain("git state degraded at index time: git status output truncated");
  });
});
