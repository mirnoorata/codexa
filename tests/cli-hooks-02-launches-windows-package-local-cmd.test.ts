import { execFileSync, spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { runAutoVerifyForPostEdit, sanitizeAutoVerifyText } from "../src/autoverify.js";
import { trackedTmpDir, testEnv, createHookFixtureRepo, createWorkspaceGitRepo, createAutoVerifyFixtureRepo, addFakeVitestBin, addFakeWindowsVitestCmdBin, createFakeCmdExe, createNestedAutoVerifyFixtureRepo } from "./cli-hooks-fixtures.js";
describe("Codexa hook CLI", () => {
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
    expect(doctorText.stdout).toContain("primary tools: session_context, search, task_brief, change_plan, post_edit_review, test_plan, proof_card");
    expect(doctorText.stdout).toContain("registered tools: 21");
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
    expect(selectedData.mcpReadiness.toolSurface.primaryTools).toEqual(["session_context", "search", "task_brief", "change_plan", "post_edit_review", "test_plan", "proof_card"]);
    expect(selectedData.mcpReadiness.toolSurface.sourceMutationTools).toEqual([]);
    expect(selectedData.mcpReadiness.toolSurface.registeredTools).toEqual(
      expect.arrayContaining(["session_context", "task_brief", "change_plan", "post_edit_review", "test_plan", "proof_card", "search", "workflow_path"])
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
      checks: Array<{ name: string; status: string }>;
      mcpReadiness: { routing: { configuredRoot: string; activeRepoRoot: string; source: string; focusReason: string; error?: string } };
    };
    expect(unscopedData.repoRoot).toBe(defaultRepo);
    expect(unscopedData.mcpReadiness.routing).toMatchObject({
      configuredRoot: workspace,
      activeRepoRoot: defaultRepo,
      source: "workspace-focus-file",
      focusReason: "workspace-default"
    });
    expect(unscopedData.mcpReadiness.routing.error).toBeUndefined();
    expect(unscopedData.checks).toContainEqual(expect.objectContaining({ name: "mcp-routing", status: "ok" }));

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
        `| codex-focused | codex | ${focusedRepo} | focused task | active | none | now | inspect |`
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
