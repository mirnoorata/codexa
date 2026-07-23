import { execFileSync, spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const fixtures: string[] = [];

afterAll(async () => {
  await Promise.all(fixtures.map((fixture) => rm(fixture, { recursive: true, force: true })));
});

describe("worktree bootstrap lock handoff", () => {
  it("converges concurrent incumbent handoffs to acquired or busy", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-bootstrap-lock-handoff-"));
    fixtures.push(repo);
    await mkdir(path.join(repo, ".codex"), { recursive: true });
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    const script = path.resolve("scripts/worktree-bootstrap.mjs");
    const results: Array<{ code: number | null; signal: NodeJS.Signals | null; stderr: string }> = [];

    for (let batch = 0; batch < 8; batch += 1) {
      results.push(...await Promise.all(
        Array.from({ length: 12 }, () => runLockContender(script, repo))
      ));
    }

    expect(results.some((result) => result.code === 0)).toBe(true);
    expect(
      results.filter((result) => result.code !== 0 && result.code !== 75)
    ).toEqual([]);
  }, 20_000);
});

function runLockContender(
  script: string,
  repo: string
): Promise<{ code: number | null; signal: NodeJS.Signals | null; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, "--try-lock", repo], {
      cwd: repo,
      stdio: ["ignore", "ignore", "pipe"]
    });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < 4_096) stderr += chunk.toString("utf8").slice(0, 4_096 - stderr.length);
    });
    const timeout = setTimeout(() => child.kill(), 5_000);
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal, stderr });
    });
  });
}
