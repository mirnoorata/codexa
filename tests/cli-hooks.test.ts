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

  it("keeps explicit wired hook repos authoritative when ambient workspace env is stale", async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), "codexa-hook-explicit-env-"));
    const repo = path.join(parent, "repo");
    await mkdir(path.join(repo, ".codex"), { recursive: true });
    await writeFile(path.join(repo, ".codex", "config.toml"), "[features]\nhooks = true\n", "utf8");
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    await writeFile(path.join(repo, "README.md"), "# fixture\n", "utf8");
    execFileSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["-c", "user.name=Codexa", "-c", "user.email=codexa@example.invalid", "commit", "-m", "fixture"], {
      cwd: repo,
      stdio: "ignore"
    });
    const focusFile = path.join(parent, "WORKING.md");
    await writeFile(
      focusFile,
      [
        "## Active Sessions",
        "",
        "| session | agent | repo | task | status | claims | last_seen | next |",
        "| --- | --- | --- | --- | --- | --- | --- | --- |",
        `| other-session | codex | ${path.join(parent, "other")} | other task | active | none | now | inspect |`
      ].join("\n"),
      "utf8"
    );

    const cli = path.resolve(process.cwd(), "dist/cli.js");
    const preEdit = spawnSync(process.execPath, [cli, "hook-pre-edit", repo], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, CODEXA_WORKSPACE_FOCUS_FILE: focusFile, SESSION_ID: "stale-session" }
    });

    expect(preEdit.status).toBe(0);
    expect(preEdit.stdout).toContain("Codexa: no change-plan snapshot is available");
    expect(preEdit.stdout).not.toContain("workspace session stale-session is not active");
  });

  it("keeps explicit wired doctor repos authoritative when ambient workspace env is stale", async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), "codexa-doctor-explicit-env-"));
    const repo = path.join(parent, "repo");
    await mkdir(path.join(repo, ".codex"), { recursive: true });
    await writeFile(path.join(repo, ".codex", "config.toml"), "[features]\nhooks = true\n", "utf8");
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    await writeFile(path.join(repo, "README.md"), "# fixture\n", "utf8");
    execFileSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["-c", "user.name=Codexa", "-c", "user.email=codexa@example.invalid", "commit", "-m", "fixture"], {
      cwd: repo,
      stdio: "ignore"
    });
    const focusFile = path.join(parent, "WORKING.md");
    await writeFile(
      focusFile,
      [
        "## Active Sessions",
        "",
        "| session | agent | repo | task | status | claims | last_seen | next |",
        "| --- | --- | --- | --- | --- | --- | --- | --- |",
        `| other-session | codex | ${path.join(parent, "other")} | other task | active | none | now | inspect |`
      ].join("\n"),
      "utf8"
    );

    const cli = path.resolve(process.cwd(), "dist/cli.js");
    const doctor = spawnSync(process.execPath, [cli, "doctor", repo, "--mcp-readiness", "--json"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, CODEXA_WORKSPACE_FOCUS_FILE: focusFile, SESSION_ID: "stale-session" }
    });

    expect(doctor.status).toBe(0);
    const data = JSON.parse(doctor.stdout) as { repoRoot: string; mcpReadiness: { routing: { activeRepoRoot: string; source: string } } };
    expect(data.repoRoot).toBe(repo);
    expect(data.mcpReadiness.routing).toMatchObject({ activeRepoRoot: repo, source: "configured-root" });
  });

  it("does not fall back to the workspace root when hook focus routing is ambiguous", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "codexa-hook-ambiguous-"));
    execFileSync("git", ["init"], { cwd: workspace, stdio: "ignore" });
    const repoA = path.join(workspace, "repo-a");
    const repoB = path.join(workspace, "repo-b");
    await mkdir(repoA, { recursive: true });
    await mkdir(repoB, { recursive: true });
    execFileSync("git", ["init"], { cwd: repoA, stdio: "ignore" });
    execFileSync("git", ["init"], { cwd: repoB, stdio: "ignore" });
    await mkdir(path.join(workspace, ".codex"), { recursive: true });
    await writeFile(
      path.join(workspace, ".codex", "WORKING.md"),
      [
        "## Active Sessions",
        "",
        "| session | agent | repo | task | status | claims | last_seen | next |",
        "| --- | --- | --- | --- | --- | --- | --- | --- |",
        `| session-a | codex | ${repoA} | task a | active | none | now | inspect |`,
        `| session-b | codex | ${repoB} | task b | active | none | now | inspect |`
      ].join("\n"),
      "utf8"
    );

    const cli = path.resolve(process.cwd(), "dist/cli.js");
    const preEdit = spawnSync(process.execPath, [cli, "hook-pre-edit", workspace], {
      cwd: process.cwd(),
      encoding: "utf8"
    });

    expect(preEdit.status).toBe(0);
    expect(preEdit.stdout).toContain("Codexa: change-plan snapshot check unavailable:");
    expect(preEdit.stdout).toContain("Codexa MCP workspace focus is ambiguous");
    expect(preEdit.stdout).not.toContain("Codexa: no change-plan snapshot is available");
  });

  it("skips AutoVerify execution by default and records recommended commands as skipped", async () => {
    const repo = await createAutoVerifyFixtureRepo({ test: "node --test" });
    const cli = path.resolve(process.cwd(), "dist/cli.js");

    const plan = spawnSync(
      process.execPath,
      [cli, "change-plan", repo, "--task", "Tighten main formatting", "--file", "src/main.js", "--save-snapshot", "--task-id", "hook-autoverify-default-skip"],
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
    expect(postEdit.stdout).toContain("Codexa AutoVerify: skipped 1 unsafe or unsupported command(s).");
    expect(postEdit.stdout).toContain("AutoVerify execution requires CODEXA_AUTOVERIFY=1");
    expect(postEdit.stdout).not.toContain("Codexa AutoVerify: ran");
  });

  it("does not trust repo-local config to enable AutoVerify execution", async () => {
    const repo = await createAutoVerifyFixtureRepo({ test: "node --test" });
    await mkdir(path.join(repo, ".codex"), { recursive: true });
    await writeFile(path.join(repo, ".codex", "config.toml"), ["[features]", "auto_verify = true", ""].join("\n"), "utf8");
    const cli = path.resolve(process.cwd(), "dist/cli.js");

    const plan = spawnSync(
      process.execPath,
      [cli, "change-plan", repo, "--task", "Tighten main formatting", "--file", "src/main.js", "--save-snapshot", "--task-id", "hook-autoverify-config-skip"],
      {
        cwd: process.cwd(),
        encoding: "utf8"
      }
    );
    expect(plan.status).toBe(0);
    await writeFile(path.join(repo, "src/main.js"), "export function main() {\n  return 2;\n}\n", "utf8");

    const postEdit = spawnSync(process.execPath, [cli, "hook-post-edit", repo], {
      cwd: process.cwd(),
      encoding: "utf8"
    });
    expect(postEdit.status).toBe(0);
    expect(postEdit.stdout).toContain("Codexa AutoVerify: skipped 1 unsafe or unsupported command(s).");
    expect(postEdit.stdout).toContain("AutoVerify execution requires CODEXA_AUTOVERIFY=1");
    expect(postEdit.stdout).not.toContain("Codexa AutoVerify: ran");
  });

  it("auto-runs targeted safe verification before persisting hook-post-edit outcome when trusted", async () => {
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
      encoding: "utf8",
      env: { ...process.env, CODEXA_AUTOVERIFY: "1" }
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
        encoding: "utf8",
        env: { ...process.env, CODEXA_AUTOVERIFY: "1" }
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
      encoding: "utf8",
      env: { ...process.env, CODEXA_AUTOVERIFY: "1" }
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
    await mkdir(path.join(repo, ".codex/cache/codexa-evals"), { recursive: true });
    await writeFile(
      path.join(repo, ".codex/cache/codexa-evals/latest.json"),
      `${JSON.stringify({ schemaVersion: 1, seed: "unit-doctor", suite: "synthetic", passed: true, score: 1, path: "unit-doctor.json", createdAt: "2026-05-30T00:00:00.000Z" }, null, 2)}\n`,
      "utf8"
    );

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

    const doctorText = spawnSync(process.execPath, [cli, "doctor", repo, "--mcp-readiness"], {
      cwd: process.cwd(),
      encoding: "utf8"
    });
    expect(doctorText.status).toBe(0);
    expect(doctorText.stdout).toContain("Codexa doctor");
    expect(doctorText.stdout).toContain("Latest hook: session-start ok");
    expect(doctorText.stdout).toContain("MCP readiness:");
    expect(doctorText.stdout).toContain("typed envelope: yes");
    expect(doctorText.stdout).toContain("primary tools: session_context, task_brief, change_plan, post_edit_review, test_plan, search");
    expect(doctorText.stdout).toContain("registered tools: 20");
    expect(doctorText.stdout).toContain("catalog/server parity: ok");
    expect(doctorText.stdout).toContain("source mutation tools: none");
    expect(doctorText.stdout).toContain("latest eval: pass score=1.000 suite=synthetic seed=unit-doctor");
  });

  it("reports MCP readiness routing for workspace sessions and ambiguous fallbacks", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "codexa-doctor-workspace-"));
    execFileSync("git", ["init"], { cwd: workspace, stdio: "ignore" });
    const defaultRepo = await createWorkspaceGitRepo(workspace, "default-repo", "alpha");
    const selectedRepo = await createWorkspaceGitRepo(workspace, "selected-repo", "beta");
    const otherRepo = await createWorkspaceGitRepo(workspace, "other-repo", "gamma");
    await mkdir(path.join(workspace, ".codex"), { recursive: true });
    await writeFile(
      path.join(workspace, ".codex", "WORKING.md"),
      [
        "## Workspace Default",
        "",
        `- Default repo: \`${defaultRepo}\`.`,
        "",
        "## Active Sessions",
        "",
        "| session | agent | repo | task | status | claims | last_seen | next |",
        "| --- | --- | --- | --- | --- | --- | --- | --- |",
        `| codex-target | codex | ${selectedRepo} | target task | active | none | now | inspect |`,
        `| codex-other | codex | ${otherRepo} | other task | active | none | now | inspect |`
      ].join("\n"),
      "utf8"
    );
    const cli = path.resolve(process.cwd(), "dist/cli.js");

    const selected = spawnSync(process.execPath, [cli, "doctor", workspace, "--mcp-readiness", "--json", "--workspace-session", "codex-target"], {
      cwd: process.cwd(),
      encoding: "utf8"
    });
    expect(selected.status).toBe(0);
    const selectedData = JSON.parse(selected.stdout) as {
      repoRoot: string;
      mcpReadiness: {
        routing: { configuredRoot: string; activeRepoRoot: string; focusReason: string; workspaceSessionId: string; warnings: string[] };
        toolSurface: {
          primaryTools: string[];
          sourceMutationTools: string[];
          registeredTools: string[];
          registrationSource: string | null;
          unregisteredCatalogTools: string[];
          uncatalogedRegisteredTools: string[];
        };
        latestEval: unknown;
      };
    };
    expect(selectedData.repoRoot).toBe(selectedRepo);
    expect(selectedData.mcpReadiness.routing).toMatchObject({
      configuredRoot: workspace,
      activeRepoRoot: selectedRepo,
      focusReason: "selected-session",
      workspaceSessionId: "codex-target"
    });
    expect(selectedData.mcpReadiness.routing.warnings).toEqual([]);
    expect(selectedData.mcpReadiness.toolSurface.primaryTools).toEqual(["session_context", "task_brief", "change_plan", "post_edit_review", "test_plan", "search"]);
    expect(selectedData.mcpReadiness.toolSurface.sourceMutationTools).toEqual([]);
    expect(selectedData.mcpReadiness.toolSurface.registeredTools).toEqual(
      expect.arrayContaining(["session_context", "task_brief", "change_plan", "post_edit_review", "test_plan", "search", "workflow_path"])
    );
    expect(selectedData.mcpReadiness.toolSurface.registrationSource).toMatch(/mcp\.(?:j|t)s$/u);
    expect(selectedData.mcpReadiness.toolSurface.unregisteredCatalogTools).toEqual([]);
    expect(selectedData.mcpReadiness.toolSurface.uncatalogedRegisteredTools).toEqual([]);
    expect(selectedData.mcpReadiness.latestEval).toBeNull();

    const ambiguous = spawnSync(process.execPath, [cli, "doctor", workspace, "--mcp-readiness", "--json"], {
      cwd: process.cwd(),
      encoding: "utf8"
    });
    expect(ambiguous.status).toBe(1);
    const ambiguousData = JSON.parse(ambiguous.stdout) as {
      repoRoot: string;
      checks: Array<{ name: string; status: string }>;
      mcpReadiness: { routing: { activeRepoRoot: string | null; source: string; error: string } };
    };
    expect(ambiguousData.repoRoot).toBe(workspace);
    expect(ambiguousData.mcpReadiness.routing).toMatchObject({
      activeRepoRoot: null,
      source: "unresolved"
    });
    expect(ambiguousData.mcpReadiness.routing.error).toContain("Codexa MCP workspace focus is ambiguous");
    expect(ambiguousData.checks).toContainEqual(expect.objectContaining({ name: "mcp-routing", status: "fail" }));
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

async function createWorkspaceGitRepo(workspace: string, name: string, stem: string): Promise<string> {
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
