import { execFileSync, spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { runAutoVerifyForPostEdit, sanitizeAutoVerifyText } from "../src/autoverify.js";
import { trackedTmpDir, testEnv, createHookFixtureRepo, createWorkspaceGitRepo, createAutoVerifyFixtureRepo, addFakeVitestBin, addFakeWindowsVitestCmdBin, createFakeCmdExe, createNestedAutoVerifyFixtureRepo } from "./cli-hooks-fixtures.js";
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

it("keeps explicit query CLI git repos authoritative when workspace session env is set", async () => {
    const workspace = await trackedTmpDir("codexa-query-explicit-env-");
    execFileSync("git", ["init"], { cwd: workspace, stdio: "ignore" });
    const explicitRepo = await createWorkspaceGitRepo(workspace, "explicit-repo", "explicitRouteSymbol");
    const focusedRepo = await createWorkspaceGitRepo(workspace, "focused-repo", "focusedRouteSymbol");
    await mkdir(path.join(workspace, ".codex"), { recursive: true });
    const focusFile = path.join(workspace, ".codex", "WORKING.md");
    await writeFile(
      focusFile,
      [
        "## Active Sessions",
        "",
        "| session | agent | repo | task | status | claims | last_seen | next |",
        "| --- | --- | --- | --- | --- | --- | --- | --- |",
        `| codex-focused | codex | ${focusedRepo} | focused task | active | none | now | inspect |`
      ].join("\n"),
      "utf8"
    );
    const cli = path.resolve(process.cwd(), "dist/cli.js");
    const indexed = spawnSync(process.execPath, [cli, "index", explicitRepo], {
      cwd: process.cwd(),
      encoding: "utf8"
    });
    expect(indexed.status).toBe(0);

    const brief = spawnSync(process.execPath, [cli, "brief", explicitRepo, "--task", "change explicitRouteSymbol", "--limit", "2", "--budget", "700"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: testEnv({ CODEXA_WORKSPACE_FOCUS_FILE: focusFile, CODEXA_WORKSPACE_SESSION: "codex-focused" })
    });

    expect(brief.status).toBe(0);
    expect(brief.stdout).toContain(`Repo: ${explicitRepo}`);
    expect(brief.stdout).toContain("explicitRouteSymbol");
    expect(brief.stdout).not.toContain(focusedRepo);
    expect(brief.stdout).not.toContain("focusedRouteSymbol");
  expect(brief.stderr).toBe("");
});

it("routes workspace-root session-start through an explicit workspace session flag", async () => {
    const workspace = await trackedTmpDir("codexa-session-start-explicit-session-");
    const repoA = await createWorkspaceGitRepo(workspace, "repo-a", "selectedSessionSymbol");
    const repoB = await createWorkspaceGitRepo(workspace, "repo-b", "otherSessionSymbol");
    await mkdir(path.join(workspace, ".codex"), { recursive: true });
    const focusFile = path.join(workspace, ".codex", "WORKING.md");
    await writeFile(
      focusFile,
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
    const result = spawnSync(process.execPath, [cli, "session-start", workspace, "--workspace-focus-file", focusFile, "--workspace-session", "session-a"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: testEnv()
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain(`Codexa context for ${repoA}:`);
    expect(result.stdout).toContain(`Repo: ${repoA}`);
    expect(result.stdout).toContain("session-a");
    expect(result.stdout).not.toContain(repoB);
    expect(result.stdout).not.toContain("Codexa status unavailable:");
});

it("routes workspace-root query CLI commands through an explicit workspace session flag", async () => {
    const workspace = await trackedTmpDir("codexa-query-explicit-session-");
    const repoA = await createWorkspaceGitRepo(workspace, "repo-a", "selectedQuerySymbol");
    const repoB = await createWorkspaceGitRepo(workspace, "repo-b", "otherQuerySymbol");
    await mkdir(path.join(workspace, ".codex"), { recursive: true });
    const focusFile = path.join(workspace, ".codex", "WORKING.md");
    await writeFile(
      focusFile,
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
    const indexed = spawnSync(process.execPath, [cli, "index", repoA], {
      cwd: process.cwd(),
      encoding: "utf8"
    });
    expect(indexed.status).toBe(0);

    const brief = spawnSync(
      process.execPath,
      [cli, "brief", workspace, "--task", "change selectedQuerySymbol", "--limit", "2", "--budget", "700", "--workspace-focus-file", focusFile, "--workspace-session", "session-a"],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: testEnv()
      }
    );

    expect(brief.status).toBe(0);
    expect(brief.stderr).toBe("");
    expect(brief.stdout).toContain(`Repo: ${repoA}`);
    expect(brief.stdout).toContain("selectedQuerySymbol");
    expect(brief.stdout).not.toContain(repoB);
    expect(brief.stdout).not.toContain("otherQuerySymbol");
});

it("lets an explicit workspace session flag ignore stale ambient focus files", async () => {
    const workspace = await trackedTmpDir("codexa-query-session-stale-env-");
    const repoA = await createWorkspaceGitRepo(workspace, "repo-a", "selectedEnvOverrideSymbol");
    const staleRepo = await createWorkspaceGitRepo(workspace, "stale-repo", "staleEnvOverrideSymbol");
    await mkdir(path.join(workspace, ".codex"), { recursive: true });
    await writeFile(
      path.join(workspace, ".codex", "WORKING.md"),
      [
        "## Active Sessions",
        "",
        "| session | agent | repo | task | status | claims | last_seen | next |",
        "| --- | --- | --- | --- | --- | --- | --- | --- |",
        `| session-a | codex | ${repoA} | task a | active | none | now | inspect |`
      ].join("\n"),
      "utf8"
    );
    const staleFocusFile = path.join(workspace, "stale-WORKING.md");
    await writeFile(
      staleFocusFile,
      [
        "## Active Sessions",
        "",
        "| session | agent | repo | task | status | claims | last_seen | next |",
        "| --- | --- | --- | --- | --- | --- | --- | --- |",
        `| session-a | codex | ${staleRepo} | stale task | active | none | now | inspect |`
      ].join("\n"),
      "utf8"
    );
    const cli = path.resolve(process.cwd(), "dist/cli.js");
    for (const repo of [repoA, staleRepo]) {
      const indexed = spawnSync(process.execPath, [cli, "index", repo], {
        cwd: process.cwd(),
        encoding: "utf8"
      });
      expect(indexed.status).toBe(0);
    }

    const brief = spawnSync(process.execPath, [cli, "brief", workspace, "--task", "change selectedEnvOverrideSymbol", "--limit", "2", "--budget", "700", "--workspace-session", "session-a"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: testEnv({ CODEXA_WORKSPACE_FOCUS_FILE: staleFocusFile })
    });

    expect(brief.status).toBe(0);
    expect(brief.stderr).toBe("");
    expect(brief.stdout).toContain(`Repo: ${repoA}`);
    expect(brief.stdout).toContain("selectedEnvOverrideSymbol");
    expect(brief.stdout).not.toContain(staleRepo);
    expect(brief.stdout).not.toContain("staleEnvOverrideSymbol");
});

it("routes workspace-root proof cards through an explicit workspace session flag", async () => {
    const workspace = await trackedTmpDir("codexa-prove-explicit-session-");
    const repoA = await createWorkspaceGitRepo(workspace, "repo-a", "selectedProofSymbol");
    const repoB = await createWorkspaceGitRepo(workspace, "repo-b", "otherProofSymbol");
    await mkdir(path.join(workspace, ".codex"), { recursive: true });
    const focusFile = path.join(workspace, ".codex", "WORKING.md");
    await writeFile(
      focusFile,
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
    const indexed = spawnSync(process.execPath, [cli, "index", repoA], {
      cwd: process.cwd(),
      encoding: "utf8"
    });
    expect(indexed.status).toBe(0);

    const prove = spawnSync(
      process.execPath,
      [cli, "prove", workspace, "--task", "prove selectedProofSymbol", "--budget", "700", "--workspace-focus-file", focusFile, "--workspace-session", "session-a"],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: testEnv()
      }
    );

    expect(prove.status).toBe(0);
    expect(prove.stderr).toBe("");
    expect(prove.stdout).toContain(`Repo: ${repoA}`);
    expect(prove.stdout).toContain("selectedProofSymbol");
    expect(prove.stdout).not.toContain(repoB);
    expect(prove.stdout).not.toContain("otherProofSymbol");
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
});
