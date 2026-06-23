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

async function trackedTmpDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  fixtureDirs.push(dir);
  return dir;
}

describe("Codexa hook CLI", () => {
  it("rejects malformed integer options instead of truncating them", async () => {
    const repo = await trackedTmpDir("codexa-cli-integer-");
    const result = spawnSync(process.execPath, [path.resolve(process.cwd(), "dist/cli.js"), "repo-map", repo, "--limit", "12abc"], {
      cwd: process.cwd(),
      encoding: "utf8"
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Invalid integer: 12abc");
  });

  it("reports the global autonomy policy when setting --global inside a repo", async () => {
    const repo = await trackedTmpDir("codexa-autonomy-global-");
    const codexaHome = await trackedTmpDir("codexa-autonomy-home-");
    const cli = path.resolve(process.cwd(), "dist/cli.js");
    const env = testEnv({ CODEXA_HOME: codexaHome });
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });

    const repoPolicy = spawnSync(process.execPath, [cli, "autonomy", repo, "--mode", "full-access", "--json"], {
      cwd: repo,
      env,
      encoding: "utf8"
    });
    expect(repoPolicy.status).toBe(0);
    expect(JSON.parse(repoPolicy.stdout)).toMatchObject({ mode: "full-access", source: "user-repo-policy" });

    const globalPolicy = spawnSync(process.execPath, [cli, "autonomy", "--global", "--mode", "read-only", "--json"], {
      cwd: repo,
      env,
      encoding: "utf8"
    });

    expect(globalPolicy.status).toBe(0);
    expect(JSON.parse(globalPolicy.stdout)).toMatchObject({ mode: "read-only", source: "user-default-policy" });
    expect(JSON.parse(globalPolicy.stdout).repoRoot).toBeUndefined();

    const inspectedGlobal = spawnSync(process.execPath, [cli, "autonomy", "--global", "--json"], {
      cwd: repo,
      env,
      encoding: "utf8"
    });
    expect(inspectedGlobal.status).toBe(0);
    expect(JSON.parse(inspectedGlobal.stdout)).toMatchObject({ mode: "read-only", source: "user-default-policy" });
    expect(JSON.parse(inspectedGlobal.stdout).repoRoot).toBeUndefined();
  });

  it("keeps hook-post-edit advisory when query setup fails", async () => {
    const repo = await trackedTmpDir("codexa-hook-missing-git-");
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
    const repo = await trackedTmpDir("codexa-session-start-missing-git-");
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
    const workspace = await trackedTmpDir("codexa-session-start-focused-");
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
    const workspace = await trackedTmpDir("codexa-session-start-default-");
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
    const workspace = await trackedTmpDir("codexa-query-default-");
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
    const workspace = await trackedTmpDir("codexa-edit-hooks-focused-");
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
    expect(preEdit.stdout).toContain("Codexa: saved an implicit pre-edit baseline");
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
    const parent = await trackedTmpDir("codexa-hook-explicit-env-");
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
    expect(preEdit.stdout).toContain("Codexa: saved an implicit pre-edit baseline");
    expect(preEdit.stdout).not.toContain("workspace session stale-session is not active");
  });

  it("keeps explicit wired doctor repos authoritative when ambient workspace env is stale", async () => {
    const parent = await trackedTmpDir("codexa-doctor-explicit-env-");
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
    const workspace = await trackedTmpDir("codexa-hook-ambiguous-");
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
      encoding: "utf8",
      env: { ...process.env, SESSION_ID: "unrelated-helper-session" }
    });

    expect(preEdit.status).toBe(0);
    expect(preEdit.stdout).toContain("Codexa: change-plan snapshot check unavailable:");
    expect(preEdit.stdout).toContain("Codexa MCP workspace focus is ambiguous");
    expect(preEdit.stdout).not.toContain("workspace session unrelated-helper-session is not active");
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
      encoding: "utf8",
      env: testEnv({ CODEXA_HOME: await trackedTmpDir("codexa-autonomy-off-") })
    });
    expect(postEdit.status).toBe(0);
    expect(postEdit.stdout).toContain("Codexa AutoVerify: skipped 1 unsafe or unsupported command(s).");
    expect(postEdit.stdout).toContain("AutoVerify execution requires user full-access autonomy");
    expect(postEdit.stdout).not.toContain("Codexa AutoVerify: ran");
  });

  it("does not suppress AutoVerify when a later hook run enables it for the same dirty tree", async () => {
    const repo = await createAutoVerifyFixtureRepo({ test: "node --test" });
    const codexaHome = await trackedTmpDir("codexa-autonomy-toggle-");
    const cli = path.resolve(process.cwd(), "dist/cli.js");

    const plan = spawnSync(
      process.execPath,
      [cli, "change-plan", repo, "--task", "Tighten main formatting", "--file", "src/main.js", "--save-snapshot", "--task-id", "hook-autoverify-toggle"],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: testEnv({ CODEXA_HOME: codexaHome })
      }
    );
    expect(plan.status).toBe(0);
    await writeFile(path.join(repo, "src/main.js"), "export function main() {\n  return 1;\n}\n", "utf8");

    const withoutAutoVerify = spawnSync(process.execPath, [cli, "hook-post-edit", repo], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: testEnv({ CODEXA_HOME: codexaHome })
    });
    expect(withoutAutoVerify.status).toBe(0);
    expect(withoutAutoVerify.stdout).toContain("Codexa AutoVerify: skipped 1 unsafe or unsupported command(s).");

    const withAutoVerify = spawnSync(process.execPath, [cli, "hook-post-edit", repo], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: testEnv({ CODEXA_HOME: codexaHome, CODEXA_AUTOVERIFY: "1" })
    });
    expect(withAutoVerify.status).toBe(0);
    expect(withAutoVerify.stdout).toContain("Codexa AutoVerify: ran 1 targeted command(s).");
    expect(withAutoVerify.stdout).not.toContain("post-edit review unchanged since last hook run");
  });

  it("skips AutoVerify when hook-post-edit only has an ambiguous latest snapshot", async () => {
    const repo = await createAutoVerifyFixtureRepo({ test: "node --test" });
    const cli = path.resolve(process.cwd(), "dist/cli.js");

    const firstPlan = spawnSync(process.execPath, [cli, "change-plan", repo, "--task", "Old task", "--file", "src/main.js", "--save-snapshot", "--task-id", "hook-autoverify-ambiguous-old"], {
      cwd: process.cwd(),
      encoding: "utf8"
    });
    expect(firstPlan.status).toBe(0);
    const latestPlan = spawnSync(process.execPath, [cli, "change-plan", repo, "--task", "Latest task", "--file", "src/main.js", "--save-snapshot", "--task-id", "hook-autoverify-ambiguous-latest"], {
      cwd: process.cwd(),
      encoding: "utf8"
    });
    expect(latestPlan.status).toBe(0);
    await writeFile(path.join(repo, "src/main.js"), "export function main() {\n  return 1;\n}\n", "utf8");

    const postEdit = spawnSync(process.execPath, [cli, "hook-post-edit", repo], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, CODEXA_AUTOVERIFY: "1" }
    });

    expect(postEdit.status).toBe(0);
    expect(postEdit.stdout).toContain("Codexa AutoVerify: skipped 1 unsafe or unsupported command(s).");
    expect(postEdit.stdout).toContain("ambiguous change-plan snapshot");
    expect(postEdit.stdout).toContain("pass an exact taskId before AutoVerify can run");
    expect(postEdit.stdout).not.toContain("Codexa AutoVerify: ran");

    const duplicatePostEdit = spawnSync(process.execPath, [cli, "hook-post-edit", repo], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, CODEXA_AUTOVERIFY: "1" }
    });
    expect(duplicatePostEdit.status).toBe(0);
    expect(duplicatePostEdit.stdout).toContain("post-edit review unchanged since last hook run");
    expect(duplicatePostEdit.stdout).not.toContain("Codexa post-edit review");
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
      encoding: "utf8",
      env: testEnv({ CODEXA_HOME: await trackedTmpDir("codexa-autonomy-off-") })
    });
    expect(postEdit.status).toBe(0);
    expect(postEdit.stdout).toContain("Codexa AutoVerify: skipped 1 unsafe or unsupported command(s).");
    expect(postEdit.stdout).toContain("AutoVerify execution requires user full-access autonomy");
    expect(postEdit.stdout).not.toContain("Codexa AutoVerify: ran");
  });

  it("auto-runs trusted verification from user-owned full-access autonomy without per-run AutoVerify env", async () => {
    const repo = await createAutoVerifyFixtureRepo({ test: "node --test" });
    const codexaHome = await trackedTmpDir("codexa-autonomy-full-");
    const cli = path.resolve(process.cwd(), "dist/cli.js");
    const setPolicy = spawnSync(process.execPath, [cli, "autonomy", repo, "--mode", "full-access"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: testEnv({ CODEXA_HOME: codexaHome })
    });
    expect(setPolicy.status).toBe(0);
    expect(setPolicy.stdout).toContain("Codexa autonomy: full-access");

    const plan = spawnSync(
      process.execPath,
      [cli, "change-plan", repo, "--task", "Tighten main formatting", "--file", "src/main.js", "--save-snapshot", "--task-id", "hook-autonomy-full-access"],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: testEnv({ CODEXA_HOME: codexaHome })
      }
    );
    expect(plan.status).toBe(0);
    await writeFile(path.join(repo, "src/main.js"), "export function main() {\n  return 1;\n}\n", "utf8");

    const postEdit = spawnSync(process.execPath, [cli, "hook-post-edit", repo], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: testEnv({ CODEXA_HOME: codexaHome })
    });
    expect(postEdit.status).toBe(0);
    expect(postEdit.stdout).toContain("Codexa AutoVerify: ran 1 targeted command(s).");
    expect(postEdit.stdout).toContain("passed");
  });

  it("lets a repo-specific read-only policy override global full-access autonomy", async () => {
    const repo = await createAutoVerifyFixtureRepo({ test: "node --test" });
    const codexaHome = await trackedTmpDir("codexa-autonomy-global-");
    const cli = path.resolve(process.cwd(), "dist/cli.js");
    const setGlobal = spawnSync(process.execPath, [cli, "autonomy", "--global", "--mode", "full-access"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: testEnv({ CODEXA_HOME: codexaHome })
    });
    expect(setGlobal.status).toBe(0);
    const setRepo = spawnSync(process.execPath, [cli, "autonomy", repo, "--mode", "read-only"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: testEnv({ CODEXA_HOME: codexaHome })
    });
    expect(setRepo.status).toBe(0);
    expect(setRepo.stdout).toContain("Codexa autonomy: read-only");

    const plan = spawnSync(
      process.execPath,
      [cli, "change-plan", repo, "--task", "Tighten main formatting", "--file", "src/main.js", "--save-snapshot", "--task-id", "hook-autonomy-read-only-override"],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: testEnv({ CODEXA_HOME: codexaHome })
      }
    );
    expect(plan.status).toBe(0);
    await writeFile(path.join(repo, "src/main.js"), "export function main() {\n  return 1;\n}\n", "utf8");

    const postEdit = spawnSync(process.execPath, [cli, "hook-post-edit", repo], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: testEnv({ CODEXA_HOME: codexaHome })
    });
    expect(postEdit.status).toBe(0);
    expect(postEdit.stdout).toContain("Codexa AutoVerify: skipped 1 unsafe or unsupported command(s).");
    expect(postEdit.stdout).toContain("current: read-only via user-repo-policy");
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
      ranCommandReports: Array<{ command: string; cwd?: string; args?: string[]; exitCode?: number; runner?: { policyId?: string; reportKind?: string; sourceMutationDetected?: boolean; envMode?: string } }>;
      verificationLedger: Array<{ target: string; status: string; evidence: string[] }>;
    };
    expect(outcome.ranCommandReports[0]).toMatchObject({ exitCode: 0 });
    expect(outcome.ranCommandReports[0]).toMatchObject({ cwd: "<repo>", args: ["--", "tests/main.test.js"] });
    expect(outcome.ranCommandReports[0].runner).toMatchObject({
      reportKind: "codexa-autoverify-report",
      policyId: "local-targeted-tests-v1",
      envMode: "minimal",
      sourceMutationDetected: false
    });
    expect(outcome.ranCommandReports[0]?.command).toContain("npm run test -- tests/main.test.js");
    expect(outcome.verificationLedger.find((entry) => entry.target === "tests/main.test.js")).toMatchObject({ status: "covered" });
  });

  it("keeps AutoVerify dirty hashes aligned when Codexa is rooted in a git subdirectory", async () => {
    const repo = await createNestedAutoVerifyFixtureRepo();
    const cli = path.resolve(process.cwd(), "dist/cli.js");
    const plan = spawnSync(process.execPath, [cli, "change-plan", repo, "--task", "Tighten nested main formatting", "--file", "src/main.js", "--save-snapshot", "--task-id", "hook-autoverify-nested-root"], {
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
    expect(postEdit.stdout).toContain("Codexa AutoVerify: ran 1 targeted command(s).");

    const outcomeFiles = (await readdir(path.join(repo, ".codex/cache/codexa-outcomes"))).filter(
      (entry) => entry.endsWith(".json") && entry !== "latest.json" && entry !== "latest-hook-review.json"
    );
    const outcome = JSON.parse(await readFile(path.join(repo, ".codex/cache/codexa-outcomes", outcomeFiles[0]), "utf8")) as {
      driftReasons: string[];
      verificationLedger: Array<{ target: string; status: string }>;
    };
    expect(outcome.driftReasons).not.toContain("recommended tests have not been accounted for");
    expect(outcome.verificationLedger.find((entry) => entry.target === "tests/main.test.js")).toMatchObject({ status: "covered" });
  });

  it("does not auto-run unsafe package test scripts from hook-post-edit", async () => {
    const cli = path.resolve(process.cwd(), "dist/cli.js");
    for (const scripts of [
      { pretest: "node -e \"require('fs').writeFileSync('deployed.txt','bad')\"", test: "node --test" },
      { test: "node --test", posttest: "node -e \"require('fs').writeFileSync('deployed.txt','bad')\"" },
      { test: "node --test && node -e \"require('fs').writeFileSync('deployed.txt','bad')\"" },
      { test: "NODE_OPTIONS=--require ./evil.cjs node --test" },
      { test: "node --test --require ./evil.cjs" },
      { test: "vitest run --config ./evil.config.js" }
    ]) {
      const repo = await createAutoVerifyFixtureRepo(
        scripts,
        "main.test.js",
        undefined,
        { "evil.cjs": "require('node:fs').writeFileSync('deployed.txt', 'bad')\n" }
      );
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
  }, 90_000);

  it("executes safe package scripts as direct runners instead of package-manager shells", async () => {
    const repo = await createAutoVerifyFixtureRepo({ test: "node --test" });
    const evilShell = path.join(repo, "evil.sh");
    await writeFile(evilShell, "#!/bin/sh\nprintf bad > deployed.txt\nexec /bin/sh \"$@\"\n", "utf8");
    await chmod(evilShell, 0o755);
    await writeFile(path.join(repo, ".npmrc"), `script-shell=${evilShell}\n`, "utf8");
    execFileSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["-c", "user.name=Codexa", "-c", "user.email=codexa@example.invalid", "commit", "-m", "add npmrc bypass fixture"], {
      cwd: repo,
      stdio: "ignore"
    });
    const cli = path.resolve(process.cwd(), "dist/cli.js");
    const plan = spawnSync(process.execPath, [cli, "change-plan", repo, "--task", "Tighten main formatting", "--file", "src/main.js", "--save-snapshot", "--task-id", "hook-autoverify-script-shell"], {
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
    expect(postEdit.stdout).toContain("Codexa AutoVerify: ran 1 targeted command(s).");
    expect(postEdit.stdout).toContain("passed");
    await expect(readFile(path.join(repo, "deployed.txt"), "utf8")).rejects.toThrow();
  });

  it("resolves validated package scripts through package-local runner bins", async () => {
    const repo = await createAutoVerifyFixtureRepo({ test: "vitest run" });
    await addFakeVitestBin(repo);
    const cli = path.resolve(process.cwd(), "dist/cli.js");
    const plan = spawnSync(process.execPath, [cli, "change-plan", repo, "--task", "Tighten main formatting", "--file", "src/main.js", "--save-snapshot", "--task-id", "hook-autoverify-local-vitest"], {
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
    expect(postEdit.stdout).toContain("Codexa AutoVerify: ran 1 targeted command(s).");
    expect(postEdit.stdout).toContain("passed");
  });

  it("launches Windows package-local cmd shims through a trusted command shell", async () => {
    const repo = await createAutoVerifyFixtureRepo({ test: "vitest run" });
    await addFakeWindowsVitestCmdBin(repo);
    const { cmdExe, marker } = await createFakeCmdExe();
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const previousAutoVerify = process.env.CODEXA_AUTOVERIFY;
    const previousComSpec = process.env.ComSpec;
    process.env.CODEXA_AUTOVERIFY = "1";
    process.env.ComSpec = cmdExe;
    try {
      const result = await runAutoVerifyForPostEdit(repo, {
        reviewTargets: ["src/main.js"],
        autoVerifyCandidates: [
          {
            schemaVersion: 1,
            taskId: "windows-cmd-shim",
            snapshotDigest: "snapshot",
            commandId: "command",
            command: "npm run test -- tests/main.test.js",
            commandExecutable: "npm",
            commandArgs: ["run", "test", "--", "tests/main.test.js"],
            commandCwd: repo,
            targetPaths: ["tests/main.test.js"],
            source: "explicit",
            rank: 1
          }
        ]
      });

      expect(result.skipped).toEqual([]);
      expect(result.reports).toHaveLength(1);
      expect(result.reports[0].exitCode).toBe(0);
      const cmdArgs = JSON.parse(await readFile(marker, "utf8")) as string[];
      expect(cmdArgs).toEqual([
        "/d",
        "/v:off",
        "/c",
        "call",
        path.join(repo, "node_modules", ".bin", "vitest.cmd"),
        "run",
        "tests/main.test.js"
      ]);
    } finally {
      platformSpy.mockRestore();
      if (previousAutoVerify === undefined) {
        delete process.env.CODEXA_AUTOVERIFY;
      } else {
        process.env.CODEXA_AUTOVERIFY = previousAutoVerify;
      }
      if (previousComSpec === undefined) {
        delete process.env.ComSpec;
      } else {
        process.env.ComSpec = previousComSpec;
      }
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

  it("runs AutoVerify with a minimal child environment and redacts runner output", async () => {
    const secret = "open-secret-value-for-redaction";
    const repo = await createAutoVerifyFixtureRepo(
      { test: "node --test" },
      "main.test.js",
      [
        "import test from 'node:test';",
        "import assert from 'node:assert/strict';",
        "import { main } from '../src/main.js';",
        "",
        `process.on('exit', () => process.stdout.write('Bearer ${secret} ' + new URL('../src/main.js', import.meta.url).pathname + '\\n'));`,
        "",
        "test('main returns value with minimal env', () => {",
        "  for (const key of ['OPENAI_API_KEY', 'GITHUB_TOKEN', 'NODE_OPTIONS', 'PYTHONPATH', 'CODEXA_AUTOVERIFY']) {",
        "    assert.equal(process.env[key], undefined, `${key} should not leak into AutoVerify`);",
        "  }",
        "  assert.equal(process.env.NPM_CONFIG_USERCONFIG?.includes('private-npmrc'), false);",
        "  assert.equal(process.env.CODEXA_VERIFY, '1');",
        "  assert.equal(main(), 1);",
        "});",
        ""
      ].join("\n")
    );
    const cli = path.resolve(process.cwd(), "dist/cli.js");
    const plan = spawnSync(process.execPath, [cli, "change-plan", repo, "--task", "Tighten main formatting", "--file", "src/main.js", "--save-snapshot", "--task-id", "hook-autoverify-min-env"], {
      cwd: process.cwd(),
      encoding: "utf8"
    });
    expect(plan.status).toBe(0);
    await writeFile(path.join(repo, "src/main.js"), "export function main() {\n  return 1;\n}\n", "utf8");

    const hookEnv = {
      ...process.env,
      CODEXA_AUTOVERIFY: "1",
      [["OPENAI", "API", "KEY"].join("_")]: secret,
      [["GITHUB", "TOKEN"].join("_")]: "github-secret-value",
      NODE_OPTIONS: "--no-warnings",
      NPM_CONFIG_USERCONFIG: "/tmp/private-npmrc",
      PYTHONPATH: "/tmp/private-pythonpath"
    };
    const postEdit = spawnSync(process.execPath, [cli, "hook-post-edit", repo], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: hookEnv
    });
    expect(postEdit.status).toBe(0);
    expect(postEdit.stdout).toContain("Codexa AutoVerify: ran 1 targeted command(s).");
    expect(postEdit.stdout).toContain("passed");

    const outcomeFiles = (await readdir(path.join(repo, ".codex/cache/codexa-outcomes"))).filter(
      (entry) => entry.endsWith(".json") && entry !== "latest.json" && entry !== "latest-hook-review.json"
    );
    const outcomeText = await readFile(path.join(repo, ".codex/cache/codexa-outcomes", outcomeFiles[0]), "utf8");
    expect(outcomeText).not.toContain(secret);
    expect(outcomeText).not.toContain(repo);
    const sanitizedProbe = sanitizeAutoVerifyText(`Bearer ${secret} ${path.join(repo, "src/main.js")}`, repo);
    expect(sanitizedProbe).toContain("Bearer <redacted>");
    expect(sanitizedProbe).toContain("<repo>/src/main.js");
  });

  it("marks AutoVerify reports as non-covering when tests mutate source or create source files", async () => {
    const repo = await createAutoVerifyFixtureRepo(
      { test: "node --test" },
      "main.test.js",
      [
        "import test from 'node:test';",
        "import assert from 'node:assert/strict';",
        "import { writeFileSync } from 'node:fs';",
        "import { main } from '../src/main.js';",
        "",
        "test('main returns value but mutates source', () => {",
        "  assert.equal(main(), 1);",
        "  writeFileSync(new URL('../src/main.js', import.meta.url), 'export function main() {\\n  return 999\\n}\\n');",
        "  writeFileSync(new URL('../src/generated.js', import.meta.url), 'export const generated = true\\n');",
        "});",
        ""
      ].join("\n")
    );
    const cli = path.resolve(process.cwd(), "dist/cli.js");
    const plan = spawnSync(process.execPath, [cli, "change-plan", repo, "--task", "Tighten main formatting", "--file", "src/main.js", "--save-snapshot", "--task-id", "hook-autoverify-source-mutation"], {
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
    expect(postEdit.stdout).toContain("Codexa AutoVerify: ran 1 targeted command(s).");
    expect(postEdit.stdout).toContain("non-covering: source mutation detected");

    const outcomeFiles = (await readdir(path.join(repo, ".codex/cache/codexa-outcomes"))).filter(
      (entry) => entry.endsWith(".json") && entry !== "latest.json" && entry !== "latest-hook-review.json"
    );
    const outcome = JSON.parse(await readFile(path.join(repo, ".codex/cache/codexa-outcomes", outcomeFiles[0]), "utf8")) as {
      driftReasons: string[];
      ranCommandReports: Array<{ runner?: { sourceMutationDetected?: boolean } }>;
      verificationLedger: Array<{ target: string; status: string; evidence: string[] }>;
    };
    expect(outcome.ranCommandReports[0].runner).toMatchObject({ sourceMutationDetected: true });
    expect(outcome.verificationLedger.find((entry) => entry.target === "tests/main.test.js")).toMatchObject({ status: "missing" });
    expect(outcome.driftReasons).toContain("recommended tests have not been accounted for");
    await expect(readFile(path.join(repo, "src/generated.js"), "utf8")).resolves.toContain("generated");
  });

  it("marks AutoVerify reports as non-covering when tests mutate Codexa provenance", async () => {
    const repo = await createAutoVerifyFixtureRepo(
      { test: "node --test" },
      "main.test.js",
      [
        "import test from 'node:test';",
        "import assert from 'node:assert/strict';",
        "import { mkdirSync, writeFileSync } from 'node:fs';",
        "import { main } from '../src/main.js';",
        "",
        "test('main returns value but mutates Codexa provenance', () => {",
        "  assert.equal(main(), 1);",
        "  const dir = new URL('../.codex/cache/codexa-task-snapshots/', import.meta.url);",
        "  mkdirSync(dir, { recursive: true });",
        "  writeFileSync(new URL('tampered.json', dir), '{\"tampered\":true}\\n');",
        "});",
        ""
      ].join("\n")
    );
    const cli = path.resolve(process.cwd(), "dist/cli.js");
    const plan = spawnSync(process.execPath, [cli, "change-plan", repo, "--task", "Tighten main formatting", "--file", "src/main.js", "--save-snapshot", "--task-id", "hook-autoverify-provenance-mutation"], {
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
    expect(postEdit.stdout).toContain("non-covering: source mutation detected");

    const outcomeFiles = (await readdir(path.join(repo, ".codex/cache/codexa-outcomes"))).filter(
      (entry) => entry.endsWith(".json") && entry !== "latest.json" && entry !== "latest-hook-review.json"
    );
    const outcome = JSON.parse(await readFile(path.join(repo, ".codex/cache/codexa-outcomes", outcomeFiles[0]), "utf8")) as {
      ranCommandReports: Array<{ runner?: { sourceMutationDetected?: boolean } }>;
      verificationLedger: Array<{ target: string; status: string }>;
    };
    expect(outcome.ranCommandReports[0].runner).toMatchObject({ sourceMutationDetected: true });
    expect(outcome.verificationLedger.find((entry) => entry.target === "tests/main.test.js")).toMatchObject({ status: "missing" });
  });

  it("marks nested-root AutoVerify reports as non-covering when tests mutate git worktree source outside the active repo", async () => {
    const repo = await createNestedAutoVerifyFixtureRepo([
      "import test from 'node:test';",
      "import assert from 'node:assert/strict';",
      "import { writeFileSync } from 'node:fs';",
      "import { main } from '../src/main.js';",
      "",
      "test('main returns value but mutates sibling source', () => {",
      "  assert.equal(main(), 1);",
      "  writeFileSync(new URL('../../../shared.js', import.meta.url), 'export const shared = true\\n');",
      "});",
      ""
    ].join("\n"));
    const cli = path.resolve(process.cwd(), "dist/cli.js");
    const plan = spawnSync(process.execPath, [cli, "change-plan", repo, "--task", "Tighten nested main formatting", "--file", "src/main.js", "--save-snapshot", "--task-id", "hook-autoverify-nested-outside-mutation"], {
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
    expect(postEdit.stdout).toContain("non-covering: source mutation detected");
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
    expect(doctorText.stdout).toContain("primary tools: session_context, search, task_brief, change_plan, post_edit_review, test_plan");
    expect(doctorText.stdout).toContain("registered tools: 20");
    expect(doctorText.stdout).toContain("catalog/server parity: ok");
    expect(doctorText.stdout).toContain("source mutation tools: none");
    expect(doctorText.stdout).toContain("latest eval: pass score=1.000 suite=synthetic seed=unit-doctor");
  });

  it("reports MCP readiness routing for workspace sessions and ambiguous fallbacks", async () => {
    const workspace = await trackedTmpDir("codexa-doctor-workspace-");
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
    expect(selectedData.mcpReadiness.toolSurface.primaryTools).toEqual(["session_context", "search", "task_brief", "change_plan", "post_edit_review", "test_plan"]);
    expect(selectedData.mcpReadiness.toolSurface.sourceMutationTools).toEqual([]);
    expect(selectedData.mcpReadiness.toolSurface.registeredTools).toEqual(
      expect.arrayContaining(["session_context", "task_brief", "change_plan", "post_edit_review", "test_plan", "search", "workflow_path"])
    );
    expect(selectedData.mcpReadiness.toolSurface.registrationSource).toBe("src/mcp/tool-registry.ts");
    expect(selectedData.mcpReadiness.toolSurface.unregisteredCatalogTools).toEqual([]);
    expect(selectedData.mcpReadiness.toolSurface.uncatalogedRegisteredTools).toEqual([]);
    expect(selectedData.mcpReadiness.latestEval).toBeNull();

    const unscoped = spawnSync(process.execPath, [cli, "doctor", workspace, "--mcp-readiness", "--json"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, SESSION_ID: "unrelated-helper-session" }
    });
    expect(unscoped.status).toBe(0);
    const unscopedData = JSON.parse(unscoped.stdout) as {
      repoRoot: string;
      mcpReadiness: { routing: { activeRepoRoot: string; source: string; focusReason: string } };
    };
    expect(unscopedData.repoRoot).toBe(defaultRepo);
    expect(unscopedData.mcpReadiness.routing).toMatchObject({
      activeRepoRoot: defaultRepo,
      source: "workspace-focus-file",
      focusReason: "workspace-default"
    });

    await writeFile(
      path.join(workspace, ".codex", "WORKING.md"),
      [
        "## Active Sessions",
        "",
        "| session | agent | repo | task | status | claims | last_seen | next |",
        "| --- | --- | --- | --- | --- | --- | --- | --- |",
        `| codex-target | codex | ${selectedRepo} | target task | active | none | now | inspect |`,
        `| codex-other | codex | ${otherRepo} | other task | active | none | now | inspect |`
      ].join("\n"),
      "utf8"
    );

    const ambiguous = spawnSync(process.execPath, [cli, "doctor", workspace, "--mcp-readiness", "--json"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, SESSION_ID: "unrelated-helper-session" }
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
    expect(ambiguousData.mcpReadiness.routing.error).not.toContain("unrelated-helper-session");
    expect(ambiguousData.checks).toContainEqual(expect.objectContaining({ name: "mcp-routing", status: "fail" }));
  });

  it("reports MCP readiness for configured workspace roots through the active project focus line", async () => {
    const workspace = await trackedTmpDir("codexa-doctor-configured-workspace-");
    execFileSync("git", ["init"], { cwd: workspace, stdio: "ignore" });
    const focusedRepo = await createWorkspaceGitRepo(workspace, "focused-repo", "focused");
    const otherRepo = await createWorkspaceGitRepo(workspace, "other-repo", "other");
    await mkdir(path.join(workspace, ".codex"), { recursive: true });
    await writeFile(path.join(workspace, ".codex", "config.toml"), "[features]\nhooks = true\n", "utf8");
    await writeFile(
      path.join(workspace, ".codex", "WORKING.md"),
      [
        "## Workspace Default",
        "",
        `- Default repo: \`${workspace}\`.`,
        `- Active project focus: Codexa project via repo \`${focusedRepo}\`.`,
        "",
        "## Active Sessions",
        "",
        "| session | agent | repo | task | status | claims | last_seen | next |",
        "| --- | --- | --- | --- | --- | --- | --- | --- |",
        `| codex-focused | codex | ${focusedRepo} | focused task | active | none | now | inspect |`,
        `| codex-other | codex | ${otherRepo} | other task | active | none | now | inspect |`
      ].join("\n"),
      "utf8"
    );

    const cli = path.resolve(process.cwd(), "dist/cli.js");
    const doctor = spawnSync(process.execPath, [cli, "doctor", workspace, "--mcp-readiness", "--json"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, SESSION_ID: "unrelated-helper-session" }
    });

    expect(doctor.status).toBe(0);
    const data = JSON.parse(doctor.stdout) as {
      repoRoot: string;
      mcpReadiness: { routing: { configuredRoot: string; activeRepoRoot: string; focusReason: string; source: string } };
    };
    expect(data.repoRoot).toBe(focusedRepo);
    expect(data.mcpReadiness.routing).toMatchObject({
      configuredRoot: workspace,
      activeRepoRoot: focusedRepo,
      source: "workspace-focus-file",
      focusReason: "explicit-focus"
    });
  });
});

function testEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env = { ...process.env, ...extra };
  if (!Object.prototype.hasOwnProperty.call(extra, "CODEXA_AUTOVERIFY")) {
    delete env.CODEXA_AUTOVERIFY;
  }
  if (!Object.prototype.hasOwnProperty.call(extra, "CODEXA_AUTONOMY")) {
    delete env.CODEXA_AUTONOMY;
  }
  return env;
}

async function createHookFixtureRepo(): Promise<string> {
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

async function createAutoVerifyFixtureRepo(
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

async function addFakeVitestBin(repo: string): Promise<void> {
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

async function addFakeWindowsVitestCmdBin(repo: string): Promise<void> {
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

async function createFakeCmdExe(): Promise<{ cmdExe: string; marker: string }> {
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

async function createNestedAutoVerifyFixtureRepo(testSource?: string): Promise<string> {
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
