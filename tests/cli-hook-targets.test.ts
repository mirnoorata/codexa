import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { createAutoVerifyFixtureRepo, createHookFixtureRepo, testEnv, trackedTmpDir } from "./cli-hooks-fixtures.js";

const cli = path.resolve("dist/cli.js");
function hook(repo: string, event: unknown, command = "hook-pre-edit") {
  return spawnSync(process.execPath, [cli, command, repo], {
    cwd: repo, encoding: "utf8", input: JSON.stringify(event), env: testEnv({ CODEXA_AUTOVERIFY: "0" }), timeout: 10000
  });
}
async function noBaseline(repo: string) {
  await expect(readFile(path.join(repo, ".codex/cache/codexa-tasks/latest.json"))).rejects.toThrow();
}

it("refuses a sibling worktree's edits without reviewing either checkout", async () => {
  const repo = await createHookFixtureRepo();
  const sibling = path.join(await trackedTmpDir("codexa-hook-worktree-"), "checkout");
  execFileSync("git", ["worktree", "add", "--detach", sibling], { cwd: repo, stdio: "ignore" });
  const event = { cwd: repo, tool_name: "Edit", tool_input: { file_path: path.join(sibling, "src/main.ts") } };
  for (const command of ["hook-pre-edit", "hook-post-edit"]) {
    const result = hook(repo, event, command);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("outside the configured checkout");
    expect(result.stdout).toContain("unavailable");
  }
  await noBaseline(repo);
  await noBaseline(sibling);
  await expect(readdir(path.join(repo, ".codex/cache/codexa-outcomes"))).rejects.toThrow();
});

it("uses host cwd for relative patch targets and checks move destinations", async () => {
  const repo = await createHookFixtureRepo();
  const other = await trackedTmpDir("codexa-hook-outside-");
  const patch = `*** Begin Patch\n*** Update File: src/main.ts\n*** Move to: ${other}/moved.ts\n*** End Patch`;
  expect(hook(repo, { cwd: repo, tool_input: { input: patch } }).stdout).toContain("outside the configured checkout");
  await noBaseline(repo);
  const allowed = hook(repo, { cwd: repo, tool_input: { patch: "*** Begin Patch\n*** Add File: new/deep/file.ts\n+x\n*** End Patch" } });
  expect(allowed.status).toBe(0);
  expect(allowed.stdout).not.toContain("unavailable");
  expect(await readFile(path.join(repo, ".codex/cache/codexa-tasks/latest.json"), "utf8")).toContain("path");
});

it("rejects symlink escapes and nested repositories", async () => {
  const repo = await createHookFixtureRepo();
  const other = await trackedTmpDir("codexa-hook-outside-");
  await symlink(other, path.join(repo, "escape"), "junction");
  expect(hook(repo, { cwd: repo, tool_input: { file_path: "escape/new.ts" } }).stdout).toContain("outside the configured checkout");
  const nested = path.join(repo, "nested");
  await mkdir(nested);
  execFileSync("git", ["init", nested], { stdio: "ignore" });
  expect(hook(repo, { cwd: repo, tool_input: { file_path: "nested/new.ts" } }).stdout).toContain("another repository");
  await noBaseline(repo);
});

it("rejects raw symlink-parent traversal before lexical normalization", async () => {
  const repo = await createHookFixtureRepo();
  const outside = await trackedTmpDir("codexa-hook-parent-");
  await mkdir(path.join(outside, "child"));
  await symlink(path.join(outside, "child"), path.join(repo, "link"), "junction");
  // Do not use path.join here: it would erase the very traversal under test.
  const raw = `${repo}/link/../victim.ts`;
  for (const command of ["hook-pre-edit", "hook-post-edit"]) {
    expect(hook(repo, { cwd: repo, tool_input: { file_path: raw } }, command).stdout).toContain("parent traversal is unsupported");
  }
  expect(hook(repo, { cwd: `${repo}/link/..`, tool_input: { file_path: "victim.ts" } }).stdout).toContain("parent traversal is unsupported");
  await noBaseline(repo);
});

it("does not let another checkout's invalid lifecycle block the edit", async () => {
  const repo = await createHookFixtureRepo();
  const plan = spawnSync(process.execPath, [cli, "change-plan", repo, "--task", "Lifecycle", "--file", "src/main.ts", "--save-snapshot", "--task-id", "invalid-state"], { encoding: "utf8", env: testEnv() });
  expect(plan.status).toBe(0);
  const stateDir = path.join(repo, ".codex/cache/codexa-task-lifecycle");
  const stateFile = (await readdir(stateDir)).find((file) => file.endsWith(".json"));
  expect(stateFile).toBeTruthy();
  await writeFile(path.join(stateDir, stateFile!), '{"schemaVersion":1,"taskId":"invalid-state"}\n');
  const other = await createHookFixtureRepo();
  const foreign = hook(repo, { cwd: repo, tool_input: { file_path: path.join(other, "src/main.ts") } });
  expect(foreign.status).toBe(0);
  expect(foreign.stdout).toContain("outside the configured checkout");
  // The invalid lifecycle still fails closed for an edit in its own checkout.
  const local = hook(repo, { cwd: repo, tool_input: { file_path: "src/main.ts" } });
  expect(local.status).not.toBe(0);
  expect(local.stdout + local.stderr).toContain("state is unavailable or invalid");
});

it.each([
  { tool_input: { file_path: "relative.ts" } },
  { cwd: "/path/to/project", tool_input: { arbitrary: "text" } },
  { tool_input: { file_path: "\0" } }
])("reports unsupported target evidence without a successful baseline", async (event) => {
  const repo = await createHookFixtureRepo();
  expect(hook(repo, event).stdout).toContain("unavailable");
  await noBaseline(repo);
});

it("bounds malformed and oversized stdin instead of silently ignoring it", async () => {
  const repo = await createHookFixtureRepo();
  for (const input of ["{broken", "x".repeat(1024 * 1024 + 1)]) {
    const result = spawnSync(process.execPath, [cli, "hook-pre-edit", repo], {
      cwd: repo, input, encoding: "utf8", timeout: 10000, env: testEnv()
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("unavailable");
  }
  await noBaseline(repo);
});

it("surfaces failed automatic tests even with an informational review", async () => {
  const repo = await createAutoVerifyFixtureRepo({ test: "node --test" }, "main.test.js", "import { main } from '../src/main.js';\nthrow new Error('fixture failure');\n");
  const plan = spawnSync(process.execPath, [cli, "change-plan", repo, "--task", "Formatting", "--file", "src/main.js", "--save-snapshot", "--task-id", "failure-output"], { encoding: "utf8", env: testEnv() });
  expect(plan.status).toBe(0);
  await writeFile(path.join(repo, "src/main.js"), "export function main() { return 1; }\n");
  const result = spawnSync(process.execPath, [cli, "hook-post-edit", repo], {
    cwd: repo, encoding: "utf8", env: testEnv({ CODEXA_AUTOVERIFY: "1" })
  });
  expect(result.status).toBe(0);
  expect(result.stdout).toContain("Codexa AutoVerify: ran");
  expect(result.stdout).toContain("exit 1");
});
