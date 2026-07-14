import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildIndex } from "../src/indexer.js";

const cli = path.resolve("dist/cli.js");
const WAIVER = JSON.stringify({ kind: "test", target: "tests/main.test.ts", reason: "gate test" });

function git(repo: string, ...args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
}

function commitAll(repo: string, message: string): void {
  git(repo, "add", "-A");
  git(repo, "commit", "-m", message);
}

async function createGateRepo(): Promise<string> {
  const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-post-edit-gate-"));
  git(repo, "init");
  git(repo, "config", "user.email", "tests@codexa.local");
  git(repo, "config", "user.name", "Codexa Tests");
  await mkdir(path.join(repo, "src"), { recursive: true });
  await mkdir(path.join(repo, "tests"), { recursive: true });
  await writeFile(path.join(repo, ".gitignore"), ".codex/\n", "utf8");
  await writeFile(path.join(repo, "package.json"), `${JSON.stringify({ name: "post-edit-gate-fixture", scripts: { test: "vitest run" } }, null, 2)}\n`, "utf8");
  await writeFile(path.join(repo, "src/main.ts"), "export function greeting() { return 'hello' }\n", "utf8");
  await writeFile(path.join(repo, "tests/main.test.ts"), "import { greeting } from '../src/main.js'\nexport const expected = greeting()\n", "utf8");
  commitAll(repo, "test: create fixture");
  return repo;
}

async function createDirtyIndexedRepo(): Promise<string> {
  const repo = await createGateRepo();
  await writeFile(path.join(repo, "src/main.ts"), "export function greeting() { return 'hello v2' }\n", "utf8");
  await buildIndex({ repoRoot: repo });
  return repo;
}

describe("post-edit-review CLI gate surface", () => {
  it("emits the structured review as JSON with --format json", async () => {
    const repo = await createDirtyIndexedRepo();
    const run = spawnSync(process.execPath, [cli, "post-edit-review", repo, "--task", "gate", "--format", "json", "--no-auto-refresh"], { encoding: "utf8" });
    expect(run.status).toBe(0);
    const data = JSON.parse(run.stdout);
    expect(data.mode).toBe("post_edit_review");
    expect(typeof data.verdict).toBe("string");
    expect(typeof data.completionAuthority).toBe("string");
  });

  it("keeps exit 0 on a blocking verdict without --exit-code", async () => {
    const repo = await createDirtyIndexedRepo();
    const run = spawnSync(
      process.execPath,
      [cli, "post-edit-review", repo, "--task", "gate", "--waiver", WAIVER, "--format", "json", "--no-auto-refresh"],
      { encoding: "utf8" }
    );
    const data = JSON.parse(run.stdout);
    expect(data.completionAuthority).toBe("blocking_inspect");
    expect(run.status).toBe(0);
  });

  it("exits 2 on a blocking verdict with --exit-code", async () => {
    const repo = await createDirtyIndexedRepo();
    const run = spawnSync(
      process.execPath,
      [cli, "post-edit-review", repo, "--task", "gate", "--waiver", WAIVER, "--exit-code", "--no-auto-refresh"],
      { encoding: "utf8" }
    );
    expect(run.stdout).toContain("Verdict: inspect");
    expect(run.status).toBe(2);
  });

  it("exits 0 with --exit-code when reported verification downgrades the verdict to advisory", async () => {
    const repo = await createDirtyIndexedRepo();
    const run = spawnSync(
      process.execPath,
      [cli, "post-edit-review", repo, "--task", "gate", "--ran-command", "npm test", "--format", "json", "--exit-code", "--no-auto-refresh"],
      { encoding: "utf8" }
    );
    const data = JSON.parse(run.stdout);
    expect(data.completionAuthority).toBe("advisory_inspect");
    expect(run.status).toBe(0);
  });

});
