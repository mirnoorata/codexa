import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const codexaRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const hygieneScript = path.join(codexaRoot, "scripts", "verify-public-hygiene.mjs");
const packageHygieneScript = path.join(codexaRoot, "scripts", "verify-package-hygiene.mjs");

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

  it("redacts sensitive matches from hygiene failures", async () => {
    const repo = await createGitRepo();
    const token = "npm_" + "A".repeat(31);
    await writeFile(path.join(repo, ".npmrc"), `//registry.npmjs.org/:_authToken=${token}\n`, "utf8");
    commitAll(repo, "add token fixture");

    const result = runHygiene(repo);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("npm auth token assignment");
    expect(result.stderr).toContain("<redacted>");
    expect(result.stderr).not.toContain(token);
  });

  it("blocks local absolute paths terminated by punctuation or whitespace", async () => {
    const repo = await createGitRepo();
    await writeFile(path.join(repo, "README.md"), `bad workspace ${"/"}${"srv"}, bad home ${"/"}home/q \n`, "utf8");
    commitAll(repo, "add punctuated private paths");

    const result = runHygiene(repo);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("workspace absolute path");
    expect(result.stderr).toContain("local home path");
  });

  it("scans generated package contents without leaking matches", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "codexa-package-hygiene-"));
    await mkdir(path.join(dir, "dist"), { recursive: true });
    const token = "npm_" + "B".repeat(31);
    await writeFile(path.join(dir, "dist", "cli.js"), `const value = "${token}"\n`, "utf8");

    const result = spawnSync(process.execPath, [packageHygieneScript, dir], {
      cwd: codexaRoot,
      encoding: "utf8"
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("package-hygiene");
    expect(result.stderr).toContain("<redacted>");
    expect(result.stderr).not.toContain(token);
  });

  it("blocks punctuated local absolute paths in generated package contents", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "codexa-package-path-hygiene-"));
    await mkdir(path.join(dir, "dist"), { recursive: true });
    await writeFile(path.join(dir, "dist", "cli.js"), `const workspace = "${"/"}${"srv"},"\nconst home = "${"/"}home/q "\n`, "utf8");

    const result = spawnSync(process.execPath, [packageHygieneScript, dir], {
      cwd: codexaRoot,
      encoding: "utf8"
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("workspace absolute path");
    expect(result.stderr).toContain("local home path");
  });

  it("keeps generated static analysis imports ignored", () => {
    const gitignore = readFileSync(path.join(codexaRoot, ".gitignore"), "utf8");
    expect(gitignore).toContain(".codex/static-analysis/");
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
