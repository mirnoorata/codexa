import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildIndex } from "../src/indexer.js";
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

  it("reports worktree degradation from the internal getChangedFileEntries when git is unavailable", async () => {
    // Direct unit boundary: even without a session, the worktree module
    // must return { entries: [], degradedReason: <which command failed> }
    // instead of swallowing the error into an empty list.
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-worktree-"));
    const filesResult = await getChangedFileEntries(repo);
    expect(filesResult.entries).toEqual([]);
    expect(filesResult.degradedReason).toMatch(/rev-parse/);
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
