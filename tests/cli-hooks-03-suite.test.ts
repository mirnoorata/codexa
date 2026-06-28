import { execFileSync, spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { runAutoVerifyForPostEdit, sanitizeAutoVerifyText } from "../src/autoverify.js";
import { trackedTmpDir, testEnv, createHookFixtureRepo, createWorkspaceGitRepo, createAutoVerifyFixtureRepo, addFakeVitestBin, addFakeWindowsVitestCmdBin, createFakeCmdExe, createNestedAutoVerifyFixtureRepo } from "./cli-hooks-fixtures.js";
describe("implicit pre-edit baseline", () => {
const cli = path.resolve(process.cwd(), "dist/cli.js");

async function gitFixtureRepo(prefix: string): Promise<string> {
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

it("saves an implicit baseline once and reports the existing snapshot afterwards", async () => {
    const repo = await gitFixtureRepo("codexa-implicit-baseline-");
    await writeFile(path.join(repo, "notes.txt"), "dirty before edit\n", "utf8");

    const first = spawnSync(process.execPath, [cli, "hook-pre-edit", repo], { cwd: repo, encoding: "utf8", env: testEnv() });
    expect(first.status).toBe(0);
    expect(first.stdout).toContain("implicit pre-edit baseline");

    const latest = JSON.parse(await readFile(path.join(repo, ".codex/cache/codexa-tasks/latest.json"), "utf8")) as { taskId: string; path: string };
    const snapshot = JSON.parse(await readFile(path.join(repo, ".codex/cache/codexa-tasks", latest.path), "utf8")) as {
      origin?: string;
      plannedEditTargets: string[];
      plannedFiles: string[];
      dirtyBaseline: { dirtyFiles: string[] };
    };
    expect(snapshot.origin).toBe("hook-implicit");
    expect(snapshot.plannedEditTargets).toEqual([]);
    expect(snapshot.plannedFiles).toEqual([]);
    expect(snapshot.dirtyBaseline.dirtyFiles).toContain("notes.txt");

    const second = spawnSync(process.execPath, [cli, "hook-pre-edit", repo], { cwd: repo, encoding: "utf8", env: testEnv() });
    expect(second.status).toBe(0);
    expect(second.stdout).toContain("change-plan snapshot ready");
  });

it("leaves a blocked change-plan marker in place instead of replacing it", async () => {
    const repo = await gitFixtureRepo("codexa-implicit-blocked-");
    const tasksDir = path.join(repo, ".codex/cache/codexa-tasks");
    await mkdir(tasksDir, { recursive: true });
    const latestContent = JSON.stringify({ schemaVersion: 1, taskId: "t", path: "t.blocked.json", createdAt: "now", blocked: true, reason: "orientation-only" });
    await writeFile(path.join(tasksDir, "latest.json"), latestContent, "utf8");
    await writeFile(
      path.join(tasksDir, "t.blocked.json"),
      JSON.stringify({ schemaVersion: 1, kind: "change-plan-snapshot-blocked", taskId: "t", createdAt: "now" }),
      "utf8"
    );

    const result = spawnSync(process.execPath, [cli, "hook-pre-edit", repo], { cwd: repo, encoding: "utf8", env: testEnv() });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("no change-plan snapshot is available");
    expect(await readFile(path.join(tasksDir, "latest.json"), "utf8")).toBe(latestContent);
  });

it("treats edits under an implicit baseline as in-scope in the post-edit review", async () => {
    const repo = await gitFixtureRepo("codexa-implicit-review-");

    const baseline = spawnSync(process.execPath, [cli, "hook-pre-edit", repo], { cwd: repo, encoding: "utf8", env: testEnv() });
    expect(baseline.status).toBe(0);
    expect(baseline.stdout).toContain("implicit pre-edit baseline");

    await writeFile(path.join(repo, "src.ts"), "export const value = 2;\n", "utf8");

    const review = spawnSync(process.execPath, [cli, "post-edit-review", repo, "--change-type", "unknown"], {
      cwd: repo,
      encoding: "utf8",
      env: testEnv()
    });
    expect(review.status).toBe(0);
    expect(review.stdout).toContain("implicit pre-edit baseline");
    expect(review.stdout).toContain("none declared (implicit baseline)");
    expect(review.stdout).not.toContain("outside planned scope");
    expect(review.stdout).toContain("- Actual edited files since snapshot: src.ts");
  }, 60_000);
});
