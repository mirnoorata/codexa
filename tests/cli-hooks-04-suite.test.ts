import { execFileSync, spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { runAutoVerifyForPostEdit, sanitizeAutoVerifyText } from "../src/autoverify.js";
import { trackedTmpDir, testEnv, createHookFixtureRepo, createWorkspaceGitRepo, createAutoVerifyFixtureRepo, addFakeVitestBin, addFakeWindowsVitestCmdBin, createFakeCmdExe, createNestedAutoVerifyFixtureRepo } from "./cli-hooks-fixtures.js";
describe("implicit baseline review semantics", () => {
const cli = path.resolve(process.cwd(), "dist/cli.js");

async function committedRepo(prefix: string): Promise<string> {
    const repo = await trackedTmpDir(prefix);
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    await writeFile(path.join(repo, "src.ts"), "export const value = 1;\n", "utf8");
    execFileSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["-c", "user.name=Codexa", "-c", "user.email=codexa@example.invalid", "commit", "-m", "fixture"], {
      cwd: repo,
      stdio: "ignore"
    });
    return repo;
  }

it("records the CURRENT head commit even when a stale index bundle exists", async () => {
    const repo = await committedRepo("codexa-implicit-head-");
    const indexed = spawnSync(process.execPath, [cli, "index", repo], { cwd: repo, encoding: "utf8", env: testEnv() });
    expect(indexed.status).toBe(0);
    await writeFile(path.join(repo, "src.ts"), "export const value = 2;\n", "utf8");
    execFileSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["-c", "user.name=Codexa", "-c", "user.email=codexa@example.invalid", "commit", "-m", "second"], {
      cwd: repo,
      stdio: "ignore"
    });
    const currentHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();

    const baseline = spawnSync(process.execPath, [cli, "hook-pre-edit", repo], { cwd: repo, encoding: "utf8", env: testEnv() });
    expect(baseline.status).toBe(0);
    expect(baseline.stdout).toContain("implicit pre-edit baseline");

    const latest = JSON.parse(await readFile(path.join(repo, ".codex/cache/codexa-tasks/latest.json"), "utf8")) as { path: string };
    const snapshot = JSON.parse(await readFile(path.join(repo, ".codex/cache/codexa-tasks", latest.path), "utf8")) as {
      dirtyBaseline: { headCommit: string | null };
    };
    expect(snapshot.dirtyBaseline.headCommit).toBe(currentHead);
  }, 60_000);

it("treats a commit after the implicit baseline as informational, never replan", async () => {
    const repo = await committedRepo("codexa-implicit-commit-");
    // Indexed fixture: the assertion targets headChanged semantics, not the
    // separate quality-low replan rule a missing index would trigger.
    const indexed = spawnSync(process.execPath, [cli, "index", repo], { cwd: repo, encoding: "utf8", env: testEnv() });
    expect(indexed.status).toBe(0);
    const baseline = spawnSync(process.execPath, [cli, "hook-pre-edit", repo], { cwd: repo, encoding: "utf8", env: testEnv() });
    expect(baseline.status).toBe(0);

    await writeFile(path.join(repo, "src.ts"), "export const value = 3;\n", "utf8");
    execFileSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["-c", "user.name=Codexa", "-c", "user.email=codexa@example.invalid", "commit", "-m", "work"], {
      cwd: repo,
      stdio: "ignore"
    });

    const review = spawnSync(process.execPath, [cli, "post-edit-review", repo, "--change-type", "unknown"], {
      cwd: repo,
      encoding: "utf8",
      env: testEnv()
    });
    expect(review.status).toBe(0);
    expect(review.stdout).not.toContain("Verdict: replan");
    expect(review.stdout).toContain("informational");
  }, 60_000);

it("explicit change_plan save removes the implicit sibling snapshot", async () => {
    const repo = await committedRepo("codexa-implicit-prune-");
    const baseline = spawnSync(process.execPath, [cli, "hook-pre-edit", repo], { cwd: repo, encoding: "utf8", env: testEnv() });
    expect(baseline.status).toBe(0);
    const tasksDir = path.join(repo, ".codex/cache/codexa-tasks");
    const beforeFiles = (await readdir(tasksDir)).filter((entry) => entry.endsWith(".json") && entry !== "latest.json");
    expect(beforeFiles.some((entry) => entry.startsWith("implicit-pre-edit-baseline"))).toBe(true);

    const plan = spawnSync(
      process.execPath,
      [cli, "change-plan", repo, "--task", "edit src", "--file", "src.ts", "--change-type", "behavior", "--save-snapshot"],
      { cwd: repo, encoding: "utf8", env: testEnv() }
    );
    expect(plan.status).toBe(0);

    const afterFiles = (await readdir(tasksDir)).filter((entry) => entry.endsWith(".json") && entry !== "latest.json");
    expect(afterFiles.some((entry) => entry.startsWith("implicit-pre-edit-baseline"))).toBe(false);
    expect(afterFiles.length).toBeGreaterThan(0);
  }, 60_000);
});
