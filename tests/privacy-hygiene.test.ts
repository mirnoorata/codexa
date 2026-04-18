import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const codexaRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const hygieneScript = path.join(codexaRoot, "scripts", "verify-public-hygiene.mjs");

describe("public hygiene scanner", () => {
  it("blocks machine-local runbook names outside the repository root", async () => {
    const repo = await createGitRepo();
    await mkdir(path.join(repo, "docs"), { recursive: true });
    await writeFile(path.join(repo, "docs", "MEMORY.md"), "private session state\n", "utf8");
    commitAll(repo, "add nested private runbook");

    const result = runHygiene(repo);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("docs/MEMORY.md");
    expect(result.stderr).toContain("machine-local runbook");
  });

  it("scans symlink targets without following them into the local filesystem", async () => {
    const repo = await createGitRepo();
    await symlink(`/${"srv"}`, path.join(repo, "private-link"));
    commitAll(repo, "add symlink");

    const result = runHygiene(repo);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("private-link");
    expect(result.stderr).toContain("symlink target workspace absolute path");
  });

  it("allows benign tracked symlinks", async () => {
    const repo = await createGitRepo();
    await symlink("../outside-fixture", path.join(repo, "fixture-link"));
    commitAll(repo, "add benign symlink");

    const result = runHygiene(repo);

    expect(result.status).toBe(0);
  });

  it("detects sensitive identifiers that were removed from current HEAD but remain in history", async () => {
    const repo = await createGitRepo();
    await writeFile(path.join(repo, "config.txt"), `path=${"/"}${"srv"}/private-project\n`, "utf8");
    commitAll(repo, "add private path");
    await writeFile(path.join(repo, "config.txt"), "path=/path/to/project\n", "utf8");
    commitAll(repo, "sanitize current path");

    const currentResult = runHygiene(repo);
    const historyResult = runHygiene(repo, ["--history"]);

    expect(currentResult.status).toBe(0);
    expect(historyResult.status).toBe(1);
    expect(historyResult.stderr).toContain("config.txt");
    expect(historyResult.stderr).toContain("workspace absolute path");
  });
});

async function createGitRepo(): Promise<string> {
  const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-public-hygiene-"));
  execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["branch", "-M", "main"], { cwd: repo, stdio: "ignore" });
  await writeFile(path.join(repo, "README.md"), "# fixture\n", "utf8");
  commitAll(repo, "fixture");
  return repo;
}

function commitAll(repo: string, message: string): void {
  execFileSync("git", ["add", "-A"], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["-c", "user.name=Codexa", "-c", "user.email=codexa@example.invalid", "commit", "-m", message], {
    cwd: repo,
    stdio: "ignore"
  });
}

function runHygiene(repo: string, args: string[] = []): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, [hygieneScript, ...args], {
    cwd: repo,
    encoding: "utf8"
  });
}
