import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildIndex } from "../src/indexer.js";
import { contextPackQuery, diffImpactQuery, testPlanQuery } from "../src/queries.js";
import { createQuerySession } from "../src/query/session.js";
import { getChangedFileEntries } from "../src/query/worktree.js";

describe("QuerySession", () => {
  it("shares loaded index, git state, changed files, budgets, warnings, and provenance for one query request", async () => {
    const repo = await createSessionFixtureRepo();
    await buildIndex({ repoRoot: repo });
    await writeFile(path.join(repo, "src/main.ts"), "export function main() { return 2 }\n", "utf8");

    const session = await createQuerySession(repo, {
      autoRefresh: false,
      commandBudgetMs: 1234,
      maxResultBytes: 4321,
      maxResults: 7
    });
    const firstEntries = await session.getChangedFileEntries();
    const secondEntries = await session.getChangedFileEntries();

    expect(session.index.files.map((file) => file.path)).toContain("src/main.ts");
    expect(session.gitState.dirtyFiles).toContain("src/main.ts");
    expect(session.commandBudgetMs).toBe(1234);
    expect(session.commandBudget.totalMs).toBe(1234);
    expect(session.maxResultBytes).toBe(4321);
    expect(session.maxResults).toBe(7);
    expect(session.warnings).toContain("index stale: dirty-files-changed");
    expect(firstEntries).toBe(secondEntries);
    expect(firstEntries.map((entry) => entry.path)).toEqual(["src/main.ts"]);
    expect(session.provenance.filter((entry) => entry === "changed-files:1")).toHaveLength(1);
    expect(session.commandBudgetUsedMs()).toBeGreaterThan(0);
    expect(session.commandBudgetRemainingMs()).toBeLessThan(1234);
    expect(session.provenance.some((entry) => entry.startsWith("command:git:"))).toBe(true);
  });

  it("surfaces worktree-degradation reasons when git status/diff fail", async () => {
    // Regression guard: previously getChangedFileEntries / gitDiff silently
    // returned empty results on command failure, and post-edit treated that
    // as "clean tree". During a large refactor a flaky git could let codexa
    // miss real uncommitted work. Callers that act on empty results MUST
    // see the degradation via session.worktreeDegradationReasons.
    const repo = await createSessionFixtureRepo();
    await buildIndex({ repoRoot: repo });

    // Session creation captures freshness while .git is healthy.
    const session = await createQuerySession(repo, { autoRefresh: false });

    // Then git gets pulled out from under us — this mimics a flaky git or
    // a mid-flight worktree change that breaks the rev-parse / status path.
    await rm(path.join(repo, ".git"), { recursive: true, force: true });

    const entries = await session.getChangedFileEntries();

    expect(entries).toEqual([]);
    expect(session.worktreeDegradationReasons.length).toBeGreaterThanOrEqual(1);
    expect(session.worktreeDegradationReasons[0]).toMatch(/rev-parse|status/);
    expect(
      session.warnings.some((warning) => warning.startsWith("worktree status unavailable:"))
    ).toBe(true);
    expect(
      session.provenance.some((entry) => entry.startsWith("worktree-degraded:status:"))
    ).toBe(true);
  });

  it("propagates degraded worktree state through diff-sensitive query packets", async () => {
    const repo = await createSessionFixtureRepo();
    await buildIndex({ repoRoot: repo });
    const session = await createQuerySession(repo, { autoRefresh: false });
    await rm(path.join(repo, ".git"), { recursive: true, force: true });

    const context = await contextPackQuery(session, { task: "review current diff", diff: true, includeSnippets: false }, { autoRefresh: false });
    const diffImpact = await diffImpactQuery(session, { autoRefresh: false });
    const testPlan = await testPlanQuery(session, true, { autoRefresh: false });

    for (const result of [context, diffImpact, testPlan]) {
      const data = result.data as { worktree?: { degraded?: boolean }; worktreeDegradationReasons?: string[]; gaps?: string[] };
      expect(data.worktree?.degraded).toBe(true);
      expect(data.worktreeDegradationReasons?.length).toBeGreaterThan(0);
      expect(data.gaps?.some((gap) => gap.startsWith("worktree state unavailable"))).toBe(true);
      expect(result.text).toContain("Worktree state:");
      expect(result.text).toContain("unknown");
    }
  });

  it("reports worktree degradation from the internal getChangedFileEntries when git is unavailable", async () => {
    // Direct unit boundary: even without a session, the worktree module
    // must return { entries: [], degradedReason: <which command failed> }
    // instead of swallowing the error into an empty list.
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-worktree-"));
    const filesResult = await getChangedFileEntries(repo);
    expect(filesResult.entries).toEqual([]);
    expect(filesResult.degradedReason).toMatch(/rev-parse/);
  });

  it("does not run natural-language retrieval when explicit files already define context", async () => {
    const repo = await createSessionFixtureRepo();
    await buildIndex({ repoRoot: repo });

    const result = await contextPackQuery(
      repo,
      {
        task: "audit broad performance behavior",
        files: ["src/main.ts"],
        diff: false,
        includeSnippets: false
      },
      { autoRefresh: false }
    );
    const data = result.data as { retrieval?: unknown; focusFiles?: Array<{ file: { path: string } }> };

    expect(data.retrieval).toBeUndefined();
    expect(data.focusFiles?.[0]?.file.path).toBe("src/main.ts");
  });

  it("suppresses test and command guidance for low-quality fallback packets", async () => {
    const repo = await createSessionFixtureRepo();
    await buildIndex({ repoRoot: repo });

    const result = await contextPackQuery(
      repo,
      {
        task: "zzzzzzzzzz unmatched context target",
        diff: false,
        includeSnippets: false,
        limit: 5
      },
      { autoRefresh: false }
    );
    const data = result.data as { actionGuidanceSuppressed?: boolean; tests?: unknown[]; verificationCommands?: unknown[] };

    expect(data.actionGuidanceSuppressed).toBe(true);
    expect(data.tests).toEqual([]);
    expect(data.verificationCommands).toEqual([]);
    expect(result.text).toContain("Likely tests:\n- deferred until Codexa has an explicit file, symbol, or higher-confidence packet.");
    expect(result.text).toContain("Recommended next MCP call: search");
    expect(result.text).not.toContain("Recommended next MCP call: find_context");
    expect(result.text).not.toMatch(/Read first:[\s\S]*\n- none\n\nLikely tests:/u);
    expect(result.text).not.toContain("If run, these commands would cover:");
  });

  it("keeps hyphenated plain-English tasks on natural retrieval", async () => {
    const repo = await createSessionFixtureRepo();
    await buildIndex({ repoRoot: repo });

    const result = await contextPackQuery(
      repo,
      {
        task: "audit main behavior over-trust under-trust",
        diff: false,
        includeSnippets: false,
        limit: 5
      },
      { autoRefresh: false }
    );
    const data = result.data as { focusFiles?: Array<{ file: { path: string }; tier: string }>; quality?: { level: string } };

    expect(data.focusFiles?.map((entry) => entry.file.path)).toContain("src/main.ts");
    expect(data.focusFiles?.every((entry) => entry.tier === "fallback")).toBe(false);
    expect(data.quality?.level).not.toBe("low");
    expect(result.text).toContain("natural task retrieval");
  });
});

async function createSessionFixtureRepo(): Promise<string> {
  const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-session-"));
  execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
  await mkdir(path.join(repo, "src"), { recursive: true });
  await writeFile(path.join(repo, "package.json"), JSON.stringify({ scripts: { test: "vitest run" } }, null, 2), "utf8");
  await writeFile(path.join(repo, "src/main.ts"), "export function main() { return 1 }\n", "utf8");
  execFileSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["-c", "user.name=Codexa", "-c", "user.email=codexa@example.invalid", "commit", "-m", "fixture"], {
    cwd: repo,
    stdio: "ignore"
  });
  return repo;
}
