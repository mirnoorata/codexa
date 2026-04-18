import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildIndex } from "../src/indexer.js";
import { createQuerySession } from "../src/query/session.js";

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
