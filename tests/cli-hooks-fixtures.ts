import { execFileSync, spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { runAutoVerifyForPostEdit, sanitizeAutoVerifyText } from "../src/autoverify.js";

// Wired fixture repos left in the shared os.tmpdir() are picked up by the
// claude-code hook-smoke parent-scan suite, so no fixture dir may outlive this run.
const fixtureDirs: string[] = [];
afterAll(async () => {
  await Promise.all(fixtureDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

export async function trackedTmpDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  fixtureDirs.push(dir);
  return dir;
}

export function testEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env = { ...process.env, ...extra };
  if (!Object.prototype.hasOwnProperty.call(extra, "CODEXA_AUTOVERIFY")) {
    delete env.CODEXA_AUTOVERIFY;
  }
  if (!Object.prototype.hasOwnProperty.call(extra, "CODEXA_AUTONOMY")) {
    delete env.CODEXA_AUTONOMY;
  }
  if (!Object.prototype.hasOwnProperty.call(extra, "CODEXA_WORKSPACE_SESSION")) {
    delete env.CODEXA_WORKSPACE_SESSION;
  }
  if (!Object.prototype.hasOwnProperty.call(extra, "CODEXA_WORKSPACE_FOCUS_FILE")) {
    delete env.CODEXA_WORKSPACE_FOCUS_FILE;
  }
  return env;
}

export async function createHookFixtureRepo(): Promise<string> {
  const repo = await trackedTmpDir("codexa-hook-dedupe-");
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

export async function createWorkspaceGitRepo(workspace: string, name: string, stem: string): Promise<string> {
  const repo = path.join(workspace, name);
  await mkdir(path.join(repo, "src"), { recursive: true });
  await writeFile(path.join(repo, "src", `${stem}.ts`), `export const ${stem} = "${stem}";\n`, "utf8");
  execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["-c", "user.name=Codexa", "-c", "user.email=codexa@example.invalid", "commit", "-m", "fixture"], {
    cwd: repo,
    stdio: "ignore"
  });
  return repo;
}

export async function createAutoVerifyFixtureRepo(
  scripts: Record<string, string>,
  testFileName = "main.test.js",
  testSource?: string,
  extraFiles: Record<string, string> = {}
): Promise<string> {
  const repo = await trackedTmpDir("codexa-hook-autoverify-");

  execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
  await mkdir(path.join(repo, "src"), { recursive: true });
  await mkdir(path.join(repo, "tests"), { recursive: true });
  await writeFile(path.join(repo, "package.json"), JSON.stringify({ type: "module", scripts }, null, 2), "utf8");
  await writeFile(path.join(repo, "src/main.js"), "export function main() {\n  return 1\n}\n", "utf8");
  await writeFile(
    path.join(repo, "tests", testFileName),
    testSource ?? "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { main } from '../src/main.js';\n\ntest('main returns value', () => {\n  assert.equal(main(), 1);\n});\n",
    "utf8"
  );
  for (const [relativePath, content] of Object.entries(extraFiles)) {
    await mkdir(path.dirname(path.join(repo, relativePath)), { recursive: true });
    await writeFile(path.join(repo, relativePath), content, "utf8");
  }
  execFileSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["-c", "user.name=Codexa", "-c", "user.email=codexa@example.invalid", "commit", "-m", "fixture"], {
    cwd: repo,
    stdio: "ignore"
  });
  return repo;
}

export async function addFakeVitestBin(repo: string): Promise<void> {
  const binPath = path.join(repo, "node_modules", ".bin", "vitest");
  await mkdir(path.dirname(binPath), { recursive: true });
  await writeFile(
    binPath,
    [
      "#!/usr/bin/env node",
      "import { spawnSync } from 'node:child_process';",
      "const args = process.argv.slice(2);",
      "const nodeTestArgs = args[0] === 'run' ? args.slice(1) : args;",
      "const result = spawnSync(process.execPath, ['--test', ...nodeTestArgs], { stdio: 'inherit' });",
      "process.exit(result.status ?? 1);",
      ""
    ].join("\n"),
    "utf8"
  );
  await chmod(binPath, 0o755);
  execFileSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["-c", "user.name=Codexa", "-c", "user.email=codexa@example.invalid", "commit", "-m", "add local vitest bin"], {
    cwd: repo,
    stdio: "ignore"
  });
}

export async function addFakeWindowsVitestCmdBin(repo: string): Promise<void> {
  const binPath = path.join(repo, "node_modules", ".bin", "vitest.cmd");
  await mkdir(path.dirname(binPath), { recursive: true });
  await writeFile(binPath, "@echo off\r\n", "utf8");
  await chmod(binPath, 0o755);
  execFileSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["-c", "user.name=Codexa", "-c", "user.email=codexa@example.invalid", "commit", "-m", "add local windows vitest bin"], {
    cwd: repo,
    stdio: "ignore"
  });
}

export async function createFakeCmdExe(): Promise<{ cmdExe: string; marker: string }> {
  const cmdDir = await trackedTmpDir("codexa-fake-cmd-");
  const marker = path.join(cmdDir, "cmd-args.json");
  const cmdExe = path.join(cmdDir, "cmd.exe");
  await writeFile(
    cmdExe,
    [
      "#!/usr/bin/env node",
      "const { writeFileSync } = require('node:fs');",
      `writeFileSync(${JSON.stringify(marker)}, JSON.stringify(process.argv.slice(2)), "utf8");`,
      "process.exit(0);",
      ""
    ].join("\n"),
    "utf8"
  );
  await chmod(cmdExe, 0o755);
  return { cmdExe, marker };
}

export async function createNestedAutoVerifyFixtureRepo(testSource?: string): Promise<string> {
  const workspace = await trackedTmpDir("codexa-hook-autoverify-nested-");

  const repo = path.join(workspace, "packages", "app");
  execFileSync("git", ["init"], { cwd: workspace, stdio: "ignore" });
  await mkdir(path.join(repo, "src"), { recursive: true });
  await mkdir(path.join(repo, "tests"), { recursive: true });
  await writeFile(path.join(repo, "package.json"), JSON.stringify({ type: "module", scripts: { test: "node --test" } }, null, 2), "utf8");
  await writeFile(path.join(repo, "src/main.js"), "export function main() {\n  return 1\n}\n", "utf8");
  await writeFile(
    path.join(repo, "tests/main.test.js"),
    testSource ?? "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { main } from '../src/main.js';\n\ntest('main returns value', () => {\n  assert.equal(main(), 1);\n});\n",
    "utf8"
  );
  execFileSync("git", ["add", "."], { cwd: workspace, stdio: "ignore" });
  execFileSync("git", ["-c", "user.name=Codexa", "-c", "user.email=codexa@example.invalid", "commit", "-m", "fixture"], {
    cwd: workspace,
    stdio: "ignore"
  });
  return repo;
}
