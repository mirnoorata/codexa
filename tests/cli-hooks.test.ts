import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("Codexa hook CLI", () => {
  it("rejects malformed integer options instead of truncating them", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-cli-integer-"));
    const result = spawnSync(process.execPath, [path.resolve(process.cwd(), "dist/cli.js"), "repo-map", repo, "--limit", "12abc"], {
      cwd: process.cwd(),
      encoding: "utf8"
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Invalid integer: 12abc");
  });

  it("keeps hook-post-edit advisory when query setup fails", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-hook-missing-git-"));
    const result = spawnSync(process.execPath, [path.resolve(process.cwd(), "dist/cli.js"), "hook-post-edit", repo], {
      cwd: process.cwd(),
      encoding: "utf8"
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Codexa: post-edit review unavailable:");
    expect(result.stdout).toContain("Codexa: hook is advisory; continuing without blocking the edit.");
    await expect(readFile(path.join(repo, ".codex/cache/codexa-hooks/events.ndjson"), "utf8")).rejects.toThrow();
  });

  it("keeps session-start advisory when query setup fails", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-session-start-missing-git-"));
    const result = spawnSync(process.execPath, [path.resolve(process.cwd(), "dist/cli.js"), "session-start", repo], {
      cwd: process.cwd(),
      encoding: "utf8"
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Codexa status unavailable:");
    expect(result.stdout).toContain("Codexa startup hook is advisory");
  });

  it("routes workspace-root session-start hooks through the focused repository", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "codexa-session-start-focused-"));
    const repo = path.join(workspace, "repo");
    await mkdir(repo, { recursive: true });
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    await writeFile(path.join(repo, "README.md"), "# fixture\n", "utf8");
    execFileSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["-c", "user.name=Codexa", "-c", "user.email=codexa@example.invalid", "commit", "-m", "fixture"], {
      cwd: repo,
      stdio: "ignore"
    });
    await mkdir(path.join(workspace, ".codex"), { recursive: true });
    await writeFile(path.join(workspace, ".codex", "WORKING.md"), `- Focused project: \`${repo}\`.\n`, "utf8");

    const result = spawnSync(process.execPath, [path.resolve(process.cwd(), "dist/cli.js"), "session-start", workspace], {
      cwd: process.cwd(),
      encoding: "utf8"
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain(`Codexa context for ${repo}:`);
    expect(result.stdout).toContain(`Repo: ${repo}`);
    expect(result.stdout).not.toContain("Codexa status unavailable:");
    expect(result.stdout).not.toContain("Failed to read git status");
    const latest = JSON.parse(await readFile(path.join(workspace, ".codex/cache/codexa-hooks/latest.json"), "utf8")) as { status: string };
    expect(latest.status).toBe("ok");
  });

  it("routes workspace-root session-start hooks through the default repository", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "codexa-session-start-default-"));
    execFileSync("git", ["init"], { cwd: workspace, stdio: "ignore" });
    const repo = path.join(workspace, "repo");
    await mkdir(repo, { recursive: true });
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    await writeFile(path.join(repo, "README.md"), "# fixture\n", "utf8");
    execFileSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["-c", "user.name=Codexa", "-c", "user.email=codexa@example.invalid", "commit", "-m", "fixture"], {
      cwd: repo,
      stdio: "ignore"
    });
    await mkdir(path.join(workspace, ".codex"), { recursive: true });
    await writeFile(path.join(workspace, ".codex", "WORKING.md"), `## Workspace Default\n\n- Default repo: \`${repo}\`.\n`, "utf8");

    const result = spawnSync(process.execPath, [path.resolve(process.cwd(), "dist/cli.js"), "session-start", workspace], {
      cwd: process.cwd(),
      encoding: "utf8"
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain(`Codexa context for ${repo}:`);
    expect(result.stdout).toContain(`Repo: ${repo}`);
    expect(result.stdout).not.toContain("Codexa status unavailable:");
    expect(result.stdout).not.toContain("Failed to read git status");
    const latest = JSON.parse(await readFile(path.join(workspace, ".codex/cache/codexa-hooks/latest.json"), "utf8")) as { status: string };
    expect(latest.status).toBe("ok");
  });

  it("routes workspace-root query CLI commands through the default repository", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "codexa-query-default-"));
    execFileSync("git", ["init"], { cwd: workspace, stdio: "ignore" });
    const repo = path.join(workspace, "repo");
    await mkdir(path.join(repo, "src"), { recursive: true });
    await writeFile(path.join(repo, "package.json"), JSON.stringify({ scripts: { test: "vitest run" } }, null, 2), "utf8");
    await writeFile(path.join(repo, "src/main.ts"), "export function defaultRouteSymbol() { return 1 }\n", "utf8");
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["-c", "user.name=Codexa", "-c", "user.email=codexa@example.invalid", "commit", "-m", "fixture"], {
      cwd: repo,
      stdio: "ignore"
    });
    await mkdir(path.join(workspace, ".codex"), { recursive: true });
    await writeFile(path.join(workspace, ".codex", "WORKING.md"), `## Workspace Default\n\n- Default repo: \`${repo}\`.\n`, "utf8");
    const cli = path.resolve(process.cwd(), "dist/cli.js");
    const indexed = spawnSync(process.execPath, [cli, "index", repo], {
      cwd: process.cwd(),
      encoding: "utf8"
    });
    expect(indexed.status).toBe(0);

    const brief = spawnSync(process.execPath, [cli, "brief", workspace, "--task", "change defaultRouteSymbol", "--limit", "2", "--budget", "700"], {
      cwd: process.cwd(),
      encoding: "utf8"
    });

    expect(brief.status).toBe(0);
    expect(brief.stdout).toContain(`Repo: ${repo}`);
    expect(brief.stdout).toContain("defaultRouteSymbol");
    expect(brief.stderr).toBe("");
    expect(brief.stdout).not.toContain("Failed to read git status");
  });

  it("routes workspace-root edit hooks through the focused repository", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "codexa-edit-hooks-focused-"));
    const repo = path.join(workspace, "repo");
    await mkdir(repo, { recursive: true });
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    await mkdir(path.join(repo, "src"), { recursive: true });
    await writeFile(path.join(repo, "src/main.ts"), "export function main() { return 1 }\n", "utf8");
    execFileSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["-c", "user.name=Codexa", "-c", "user.email=codexa@example.invalid", "commit", "-m", "fixture"], {
      cwd: repo,
      stdio: "ignore"
    });
    await mkdir(path.join(workspace, ".codex"), { recursive: true });
    await writeFile(path.join(workspace, ".codex", "WORKING.md"), `- Focused project: \`${repo}\`.\n`, "utf8");
    const cli = path.resolve(process.cwd(), "dist/cli.js");

    const indexed = spawnSync(process.execPath, [cli, "index", repo], {
      cwd: process.cwd(),
      encoding: "utf8"
    });
    expect(indexed.status).toBe(0);
    await writeFile(path.join(repo, "src/main.ts"), "export function main() { return 2 }\n", "utf8");

    const preEdit = spawnSync(process.execPath, [cli, "hook-pre-edit", workspace], {
      cwd: process.cwd(),
      encoding: "utf8"
    });
    expect(preEdit.status).toBe(0);
    expect(preEdit.stdout).toContain("Codexa: no change-plan snapshot is available");
    expect(preEdit.stdout).not.toContain("Failed to read git status");

    const postEdit = spawnSync(process.execPath, [cli, "hook-post-edit", workspace], {
      cwd: process.cwd(),
      encoding: "utf8"
    });
    expect(postEdit.status).toBe(0);
    expect(postEdit.stdout).toContain("Codexa post-edit review");
    expect(postEdit.stdout).not.toContain("Failed to read git status");
    const latest = JSON.parse(await readFile(path.join(workspace, ".codex/cache/codexa-hooks/latest.json"), "utf8")) as { hook: string; status: string };
    expect(latest).toMatchObject({ hook: "post-edit", status: "ok" });
  });

  it("auto-runs targeted safe verification before persisting hook-post-edit outcome", async () => {
    const repo = await createAutoVerifyFixtureRepo({ test: "node --test" });
    const cli = path.resolve(process.cwd(), "dist/cli.js");

    const plan = spawnSync(
      process.execPath,
      [cli, "change-plan", repo, "--task", "Tighten main formatting", "--file", "src/main.js", "--save-snapshot", "--task-id", "hook-autoverify"],
      {
        cwd: process.cwd(),
        encoding: "utf8"
      }
    );
    expect(plan.status).toBe(0);
    await writeFile(path.join(repo, "src/main.js"), "export function main() {\n  return 1;\n}\n", "utf8");

    const postEdit = spawnSync(process.execPath, [cli, "hook-post-edit", repo], {
      cwd: process.cwd(),
      encoding: "utf8"
    });
    expect(postEdit.status).toBe(0);
    expect(postEdit.stdout).toContain("Codexa AutoVerify: ran 1 targeted command(s).");
    expect(postEdit.stdout).toContain("passed");

    const outcomeFiles = (await readdir(path.join(repo, ".codex/cache/codexa-outcomes"))).filter(
      (entry) => entry.endsWith(".json") && entry !== "latest.json" && entry !== "latest-hook-review.json"
    );
    expect(outcomeFiles).toHaveLength(1);
    const outcome = JSON.parse(await readFile(path.join(repo, ".codex/cache/codexa-outcomes", outcomeFiles[0]), "utf8")) as {
      ranCommandReports: Array<{ command: string; exitCode?: number }>;
      verificationLedger: Array<{ target: string; status: string; evidence: string[] }>;
    };
    expect(outcome.ranCommandReports[0]).toMatchObject({ exitCode: 0 });
    expect(outcome.ranCommandReports[0]).toMatchObject({ cwd: "<repo>", args: ["run", "test", "--", "tests/main.test.js"] });
    expect(outcome.ranCommandReports[0]?.command).toContain("npm run test -- tests/main.test.js");
    expect(outcome.verificationLedger.find((entry) => entry.target === "tests/main.test.js")).toMatchObject({ status: "covered" });
  });

  it("does not auto-run unsafe package test scripts from hook-post-edit", async () => {
    const cli = path.resolve(process.cwd(), "dist/cli.js");
    for (const scripts of [
      { pretest: "node -e \"require('fs').writeFileSync('deployed.txt','bad')\"", test: "node --test" },
      { test: "node --test", posttest: "node -e \"require('fs').writeFileSync('deployed.txt','bad')\"" },
      { test: "node --test && node -e \"require('fs').writeFileSync('deployed.txt','bad')\"" }
    ]) {
      const repo = await createAutoVerifyFixtureRepo(scripts);
      const plan = spawnSync(process.execPath, [cli, "change-plan", repo, "--task", "Tighten main formatting", "--file", "src/main.js", "--save-snapshot", "--task-id", "hook-autoverify-unsafe"], {
        cwd: process.cwd(),
        encoding: "utf8"
      });
      expect(plan.status).toBe(0);
      await writeFile(path.join(repo, "src/main.js"), "export function main() {\n  return 1;\n}\n", "utf8");

      const postEdit = spawnSync(process.execPath, [cli, "hook-post-edit", repo], {
        cwd: process.cwd(),
        encoding: "utf8"
      });
      expect(postEdit.status).toBe(0);
      expect(postEdit.stdout).toContain("Codexa AutoVerify: skipped 1 unsafe or unsupported command(s).");
      await expect(readFile(path.join(repo, "deployed.txt"), "utf8")).rejects.toThrow();
    }
  });

  it("does not execute shell metacharacters from recommended test paths", async () => {
    const repo = await createAutoVerifyFixtureRepo({ test: "node --test" }, "main;touch shell-pwned.test.js");
    const cli = path.resolve(process.cwd(), "dist/cli.js");
    const plan = spawnSync(process.execPath, [cli, "change-plan", repo, "--task", "Tighten main formatting", "--file", "src/main.js", "--save-snapshot", "--task-id", "hook-autoverify-shell-meta"], {
      cwd: process.cwd(),
      encoding: "utf8"
    });
    expect(plan.status).toBe(0);
    await writeFile(path.join(repo, "src/main.js"), "export function main() {\n  return 1;\n}\n", "utf8");

    const postEdit = spawnSync(process.execPath, [cli, "hook-post-edit", repo], {
      cwd: process.cwd(),
      encoding: "utf8"
    });
    expect(postEdit.status).toBe(0);
    expect(postEdit.stdout).toContain("Codexa AutoVerify: skipped 1 unsafe or unsupported command(s).");
    await expect(readFile(path.join(repo, "shell-pwned.test.js"), "utf8")).rejects.toThrow();
  });

  it("skips duplicate hook-post-edit reviews for an unchanged dirty tree", async () => {
    const repo = await createHookFixtureRepo();
    const cli = path.resolve(process.cwd(), "dist/cli.js");

    const indexed = spawnSync(process.execPath, [cli, "index", repo], {
      cwd: process.cwd(),
      encoding: "utf8"
    });
    expect(indexed.status).toBe(0);

    await writeFile(path.join(repo, "src/main.ts"), "export function main() { return 2 }\n", "utf8");

    const first = spawnSync(process.execPath, [cli, "hook-post-edit", repo], {
      cwd: process.cwd(),
      encoding: "utf8"
    });
    expect(first.status).toBe(0);
    expect(first.stdout).toContain("Codexa post-edit review");

    const second = spawnSync(process.execPath, [cli, "hook-post-edit", repo], {
      cwd: process.cwd(),
      encoding: "utf8"
    });
    expect(second.status).toBe(0);
    expect(second.stdout).toContain("Codexa: post-edit review unchanged since last hook run");

    const outcomeFiles = (await readdir(path.join(repo, ".codex/cache/codexa-outcomes"))).filter(
      (entry) => entry.endsWith(".json") && entry !== "latest.json" && entry !== "latest-hook-review.json"
    );
    expect(outcomeFiles).toHaveLength(1);

    const hookEvents = (await readFile(path.join(repo, ".codex/cache/codexa-hooks/events.ndjson"), "utf8"))
      .trim()
      .split(/\r?\n/u)
      .map((line) => JSON.parse(line) as { hook: string; status: string; reason?: string });
    expect(hookEvents).toMatchObject([
      { hook: "post-edit", status: "ok", reason: "reviewed" },
      { hook: "post-edit", status: "skipped", reason: "duplicate-dirty-tree" }
    ]);
    const latestHook = JSON.parse(await readFile(path.join(repo, ".codex/cache/codexa-hooks/latest.json"), "utf8")) as { status: string; reason?: string };
    expect(latestHook).toMatchObject({ status: "skipped", reason: "duplicate-dirty-tree" });
  });

  it("reports doctor diagnostics for installed wiring and latest hook events", async () => {
    const repo = await createHookFixtureRepo();
    const cli = path.resolve(process.cwd(), "dist/cli.js");

    const init = spawnSync(process.execPath, [cli, "init", repo], {
      cwd: process.cwd(),
      encoding: "utf8"
    });
    expect(init.status).toBe(0);

    const sessionStart = spawnSync(process.execPath, [cli, "session-start", repo], {
      cwd: process.cwd(),
      encoding: "utf8"
    });
    expect(sessionStart.status).toBe(0);

    const doctorJson = spawnSync(process.execPath, [cli, "doctor", repo, "--json"], {
      cwd: process.cwd(),
      encoding: "utf8"
    });
    expect(doctorJson.status).toBe(0);
    const data = JSON.parse(doctorJson.stdout) as {
      config: { mcpServerConfigured: boolean; codexHooksEnabled: boolean };
      hooks: { sessionStart: boolean; preEdit: boolean; postEdit: boolean };
      index: { missing: boolean } | null;
      latestHookEvent: { hook: string; status: string } | null;
      hookEventsPath: string;
    };
    expect(data.config).toMatchObject({ mcpServerConfigured: true, codexHooksEnabled: true });
    expect(data.hooks).toMatchObject({ sessionStart: true, preEdit: true, postEdit: true });
    expect(data.index?.missing).toBe(false);
    expect(data.latestHookEvent).toMatchObject({ hook: "session-start", status: "ok" });
    expect(data.hookEventsPath).toBe(".codex/cache/codexa-hooks/events.ndjson");

    const doctorText = spawnSync(process.execPath, [cli, "doctor", repo], {
      cwd: process.cwd(),
      encoding: "utf8"
    });
    expect(doctorText.status).toBe(0);
    expect(doctorText.stdout).toContain("Codexa doctor");
    expect(doctorText.stdout).toContain("Latest hook: session-start ok");
  });
});

async function createHookFixtureRepo(): Promise<string> {
  const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-hook-dedupe-"));
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

async function createAutoVerifyFixtureRepo(scripts: Record<string, string>, testFileName = "main.test.js"): Promise<string> {
  const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-hook-autoverify-"));
  execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
  await mkdir(path.join(repo, "src"), { recursive: true });
  await mkdir(path.join(repo, "tests"), { recursive: true });
  await writeFile(path.join(repo, "package.json"), JSON.stringify({ type: "module", scripts }, null, 2), "utf8");
  await writeFile(path.join(repo, "src/main.js"), "export function main() {\n  return 1\n}\n", "utf8");
  await writeFile(
    path.join(repo, "tests", testFileName),
    "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { main } from '../src/main.js';\n\ntest('main returns value', () => {\n  assert.equal(main(), 1);\n});\n",
    "utf8"
  );
  execFileSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["-c", "user.name=Codexa", "-c", "user.email=codexa@example.invalid", "commit", "-m", "fixture"], {
    cwd: repo,
    stdio: "ignore"
  });
  return repo;
}
