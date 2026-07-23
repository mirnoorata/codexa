import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { initializeProject, renderSessionStartJson, SESSION_START_JSON_MAX_BYTES, sessionStartReceipt, sessionStartStrictFailures, sessionStartSummary } from "../src/init.js";
import { executableCommandCandidates, pairedNodeCommandCandidates, workspaceRepoProject } from "../src/session-start.js";
import { CODEXA_VERSION } from "../src/version.js";

const testCliPath = path.resolve(process.cwd(), "dist/cli.js");

describe("Codexa versioned SessionStart receipt", () => {
  it("groups shared worktrees with their canonical project without embedding a host path literal", () => {
    const sharedRoot = path.posix.join(path.posix.sep, "srv");
    const canonical = path.posix.join(sharedRoot, "codexa");
    const worktree = path.posix.join(sharedRoot, "worktree", "codexa", "codex", "session-id");

    expect(workspaceRepoProject(worktree)).toBe(canonical);
    expect(workspaceRepoProject(canonical)).toBe(canonical);
    expect(workspaceRepoProject(path.posix.join(path.posix.sep, "tmp", "repo"))).toBe(path.posix.join(path.posix.sep, "tmp", "repo"));
  });

  it("separates core config, fresh index, and unverified current-thread activation within the plain-text budget", async () => {
    const repo = await createRepo("codexa-session-receipt-core-");
    const initialized = await initializeProject(repo, { cliPath: testCliPath });

    const receipt = await sessionStartReceipt(repo, false);
    expect(receipt).toMatchObject({
      schemaVersion: 1,
      kind: "codexa-session-start",
      availability: "ok",
      repoRoot: repo,
      config: {
        state: "configured",
        path: path.join(repo, ".codex/config.toml"),
        serverName: initialized.serverName,
        command: process.execPath,
        launcher: testCliPath,
        configuredRepoRoot: repo,
        toolProfile: "core",
        serverToolProfile: "core"
      },
      index: { state: "fresh", reason: "fresh", repoRoot: repo, parserErrorCount: 0 },
      threadMcp: { state: "unverified", reason: "session-start-cannot-observe-host-initialize" }
    });
    expect(sessionStartStrictFailures(receipt)).toEqual([]);

    const summary = await sessionStartSummary(repo, false);
    expect(summary).toContain("Config: configured");
    expect(summary).toContain("Index: fresh");
    expect(summary).toContain("Current-thread MCP: unverified");
    expect(summary).not.toContain("Codexa MCP is ready");
    expect(Buffer.byteLength(summary, "utf8")).toBeLessThanOrEqual(800);

    receipt.context = ["x".repeat(100_000)];
    const boundedJson = renderSessionStartJson(receipt);
    expect(Buffer.byteLength(boundedJson, "utf8")).toBeLessThanOrEqual(SESSION_START_JSON_MAX_BYTES);
    expect(JSON.parse(boundedJson)).not.toHaveProperty("context");
  });

  it("keeps config, index, and active root aligned after workspace routing", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "codexa-session-receipt-workspace-"));
    execFileSync("git", ["init"], { cwd: workspace, stdio: "ignore" });
    const repo = await createRepoAt(workspace, "focused-repo");
    await initializeProject(repo, { cliPath: testCliPath });
    await mkdir(path.join(workspace, ".codex"), { recursive: true });
    await writeFile(
      path.join(workspace, ".codex/WORKING.md"),
      [
        "## Workspace Default",
        "",
        `- Default repo: \`${repo}\`.`,
        "",
        "## Active Sessions",
        "",
        "| session | agent | repo | task | status | claims | last_seen | next |",
        "| --- | --- | --- | --- | --- | --- | --- | --- |",
        `| session-focused | codex | ${repo} | receipt test | active | none | now | inspect |`
      ].join("\n"),
      "utf8"
    );
    await writeFile(
      path.join(workspace, ".codex/config.toml"),
      "# >>> codexa managed\n[mcp_servers.workspace-only]\nargs = [\"codexa\", \"serve\", \"--tools\", \"full\"]\n# <<< codexa managed\n",
      "utf8"
    );

    const receipt = await sessionStartReceipt(workspace, false, { workspaceSessionId: "session-focused" });
    expect(receipt).toMatchObject({
      configuredRoot: workspace,
      repoRoot: repo,
      routing: { state: "resolved", source: "workspace-focus-file", focusReason: "selected-session", workspaceSessionId: "session-focused" },
      config: { state: "configured", path: path.join(repo, ".codex/config.toml"), configuredRepoRoot: repo, toolProfile: "core" },
      index: { state: "fresh", repoRoot: repo }
    });
    expect(receipt.config.path).not.toBe(path.join(workspace, ".codex/config.toml"));
  });

  it("requires an explicit workspace selection instead of loading the previous default repo", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "codexa-session-receipt-selection-"));
    execFileSync("git", ["init"], { cwd: workspace, stdio: "ignore" });
    const previousRepo = await createRepoAt(workspace, "previous-default");
    await initializeProject(previousRepo, { cliPath: testCliPath });
    await mkdir(path.join(workspace, ".codex"), { recursive: true });
    await writeFile(path.join(workspace, ".codex/WORKING.md"), `## Workspace Default\n\n- Default repo: \`${previousRepo}\`.\n`, "utf8");

    const receipt = await sessionStartReceipt(workspace, false);
    expect(receipt).toMatchObject({
      availability: "ok",
      configuredRoot: workspace,
      repoRoot: null,
      routing: { state: "selection-required", source: "workspace-focus-file", focusReason: "workspace-default" },
      config: { state: "unavailable", toolProfile: "unknown", reason: "repo not selected; config not inspected" },
      index: { state: "not-selected", reason: "workspace-session-not-selected" },
      threadMcp: { state: "unverified" }
    });
    expect(sessionStartStrictFailures(receipt)).toEqual(expect.arrayContaining([
      "routing selection-required",
      "config unavailable",
      "index not-selected: workspace-session-not-selected"
    ]));
    expect(receipt.hints.join("\n")).toContain("--workspace-session <session-id>");
    expect(receipt.hints.join("\n")).not.toContain("session-env.sh");

    const summary = await sessionStartSummary(workspace, false);
    expect(summary).toContain(`Codexa context for ${workspace} (startup receipt v1):`);
    expect(summary).toContain("Workspace selection required:");
    expect(summary).toContain(`Repo: not selected (workspace=${workspace})`);
    expect(summary).toContain("Index: not-selected");
    expect(summary).not.toContain(previousRepo);
    expect(summary).not.toContain("indexed=");
    expect(Buffer.byteLength(summary, "utf8")).toBeLessThanOrEqual(800);
  });

  it("never recommends directly sourcing a mutable selector after ambiguous workspace routing", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "codexa-session-receipt-ambiguous-"));
    execFileSync("git", ["init"], { cwd: workspace, stdio: "ignore" });
    const repoA = await createRepoAt(workspace, "repo-a");
    const repoB = await createRepoAt(workspace, "repo-b");
    await mkdir(path.join(workspace, ".codex"), { recursive: true });
    await writeFile(
      path.join(workspace, ".codex/WORKING.md"),
      [
        "## Active Sessions",
        "",
        "| session | agent | repo | task | status | claims | last_seen | next |",
        "| --- | --- | --- | --- | --- | --- | --- | --- |",
        `| duplicate | codex | ${repoA} | task a | active | none | now | inspect |`,
        `| duplicate | codex | ${repoB} | task b | active | none | now | inspect |`
      ].join("\n"),
      "utf8"
    );

    const receipt = await sessionStartReceipt(workspace, false, { workspaceSessionId: "duplicate" });
    expect(receipt).toMatchObject({
      availability: "unavailable",
      routing: { state: "unavailable" },
      index: { state: "unavailable", reason: "routing-unavailable" }
    });
    expect(receipt.hints.join("\n")).toContain("--workspace-session duplicate");
    expect(receipt.hints.join("\n")).not.toContain("session-env.sh");
  });

  it("does not treat even a local workspace default as an explicit SessionStart selection", async () => {
    const repo = await createRepo("codexa-session-receipt-local-default-");
    await initializeProject(repo, { cliPath: testCliPath });
    await writeFile(path.join(repo, ".codex/WORKING.md"), `## Workspace Default\n\n- Default repo: \`${repo}\`.\n`, "utf8");

    const receipt = await sessionStartReceipt(repo, false);
    expect(receipt).toMatchObject({
      repoRoot: null,
      routing: { state: "selection-required", focusReason: "workspace-default" },
      config: { state: "unavailable" },
      index: { state: "not-selected" }
    });
  });

  it("keeps parked and unknown composite workspace rows explicitly selectable", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "codexa-session-receipt-conservative-status-"));
    execFileSync("git", ["init"], { cwd: workspace, stdio: "ignore" });
    const repo = await createRepoAt(workspace, "focused-repo");
    await initializeProject(repo, { cliPath: testCliPath });
    await mkdir(path.join(workspace, ".codex"), { recursive: true });
    const focusFile = path.join(workspace, ".codex/WORKING.md");

    for (const status of ["parked", "parked-but-dirty", "not-done"]) {
      await writeFile(
        focusFile,
        [
          "## Active Sessions",
          "",
          "| session | agent | repo | task | status | claims | last_seen | next |",
          "| --- | --- | --- | --- | --- | --- | --- | --- |",
          `| recoverable-session | codex | ${repo} | recoverable task | ${status} | claim:src/main.ts | now | inspect |`
        ].join("\n"),
        "utf8"
      );
      const receipt = await sessionStartReceipt(workspace, false, { workspaceSessionId: "recoverable-session" });
      expect(receipt).toMatchObject({ repoRoot: repo, routing: { state: "resolved", focusReason: "selected-session" } });
    }
  });

  it("rejects explicitly selected cleanup and legacy-terminal rows before config or index inspection", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "codexa-session-receipt-terminal-status-"));
    execFileSync("git", ["init"], { cwd: workspace, stdio: "ignore" });
    const repo = await createRepoAt(workspace, "finished-repo");
    await initializeProject(repo, { cliPath: testCliPath });
    await mkdir(path.join(workspace, ".codex"), { recursive: true });
    const focusFile = path.join(workspace, ".codex/WORKING.md");

    for (const status of ["cleaning", "done", "merged", "released"]) {
      await writeFile(
        focusFile,
        [
          "## Active Sessions",
          "",
          "| session | agent | repo | task | status | claims | last_seen | next |",
          "| --- | --- | --- | --- | --- | --- | --- | --- |",
          `| terminal-session | codex | ${repo} | finished task | ${status} | none | earlier | cleanup |`
        ].join("\n"),
        "utf8"
      );
      const receipt = await sessionStartReceipt(workspace, false, { workspaceSessionId: "terminal-session" });
      expect(receipt).toMatchObject({
        availability: "unavailable",
        repoRoot: null,
        routing: { state: "unavailable", error: expect.stringContaining("workspace session terminal-session is not active") },
        config: {
          state: "unavailable",
          path: path.join(workspace, ".codex/config.toml"),
          reason: "active repo unresolved; config not inspected"
        },
        index: { state: "unavailable", reason: "routing-unavailable" }
      });
      expect(receipt.config.path).not.toBe(path.join(repo, ".codex/config.toml"));
    }
  });

  it("reports missing and full-profile states without treating config presence as activation", async () => {
    const missingRepo = await createRepo("codexa-session-receipt-missing-");
    const missing = await sessionStartReceipt(missingRepo, false);
    expect(missing).toMatchObject({
      availability: "ok",
      config: { state: "not-configured", toolProfile: "unknown" },
      index: { state: "missing", repoRoot: missingRepo },
      threadMcp: { state: "unverified" }
    });
    expect(sessionStartStrictFailures(missing)).toEqual(expect.arrayContaining(["config not-configured", "index missing: missing-index"]));

    const fullRepo = await createRepo("codexa-session-receipt-full-");
    await initializeProject(fullRepo, { cliPath: testCliPath, index: false, toolProfile: "full" });
    const full = await sessionStartReceipt(fullRepo, false);
    expect(full).toMatchObject({
      config: { state: "configured", toolProfile: "full", serverToolProfile: "full" },
      index: { state: "missing", repoRoot: fullRepo },
      threadMcp: { state: "unverified" }
    });
  });

  it("accepts the version-pinned npx launcher emitted for ephemeral CLI paths", async () => {
    const repo = await createRepo("codexa-session-receipt-npx-");
    await initializeProject(repo, { cliPath: "/tmp/_npx/fixture/node_modules/@mirnoorata/codexa/dist/cli.js" });

    const receipt = await sessionStartReceipt(repo, false);
    expect(receipt.config).toMatchObject({ state: "configured", command: "npx", toolProfile: "core" });
    expect(receipt.config.launcher).toBe(`@mirnoorata/codexa@${CODEXA_VERSION}`);
    expect(sessionStartStrictFailures(receipt)).toEqual([]);
  });

  it("rejects launcher argument shapes that init never emits", async () => {
    const repo = await createRepo("codexa-session-receipt-launcher-shape-");
    await initializeProject(repo, { cliPath: testCliPath });
    const configPath = path.join(repo, ".codex/config.toml");
    const nodeConfig = await readFile(configPath, "utf8");

    await writeFile(
      configPath,
      nodeConfig.replace(
        `args = [${JSON.stringify(testCliPath)}, "serve",`,
        `args = ["--require", ${JSON.stringify(testCliPath)}, "serve",`
      ),
      "utf8"
    );
    expect((await sessionStartReceipt(repo, false)).config).toMatchObject({ state: "invalid" });

    await initializeProject(repo, { cliPath: "/tmp/_npx/fixture/node_modules/@mirnoorata/codexa/dist/cli.js", index: false });
    const npxConfig = await readFile(configPath, "utf8");
    await writeFile(configPath, npxConfig.replace('"-y", "@mirnoorata/codexa@', '"--package", "@mirnoorata/codexa@'), "utf8");
    expect((await sessionStartReceipt(repo, false)).config).toMatchObject({ state: "invalid" });

    for (const invalidVersion of ["999.999.999", "01.2.3", "1.2.3-..", "file:/tmp/not-codexa"]) {
      await writeFile(configPath, npxConfig.replace(/@mirnoorata\/codexa@[^"\]]+/u, `@mirnoorata/codexa@${invalidVersion}`), "utf8");
      expect((await sessionStartReceipt(repo, false)).config).toMatchObject({ state: "invalid" });
    }

    await writeFile(
      configPath,
      nodeConfig
        .replace(/^command\s*=.*$/mu, 'command = "codexa"')
        .replace(`args = [${JSON.stringify(testCliPath)}, "serve",`, 'args = ["serve",')
    );
    expect((await sessionStartReceipt(repo, false)).config).toMatchObject({
      state: "invalid",
      reason: "Codexa-managed command/args do not identify a recognized Codexa launcher"
    });
  });

  it("rejects non-stdio args, invalid TOML scope, and an unavailable Node command", async () => {
    const repo = await createRepo("codexa-session-receipt-managed-shape-");
    await initializeProject(repo, { cliPath: testCliPath });
    const configPath = path.join(repo, ".codex/config.toml");
    const config = await readFile(configPath, "utf8");
    const serverName = /^\[mcp_servers\.([A-Za-z0-9_-]+)\]$/mu.exec(config)?.[1];
    expect(serverName).toBeTruthy();

    await writeFile(configPath, config.replace('"--tools", "core"]', '"--tools", "core", "--transport", "http"]'), "utf8");
    expect((await sessionStartReceipt(repo, false)).config).toMatchObject({ state: "invalid" });

    await writeFile(configPath, config.replace(/^command\s*=/mu, `[mcp_servers.${serverName}.env]\ncommand =`), "utf8");
    expect((await sessionStartReceipt(repo, false)).config).toMatchObject({ state: "invalid" });

    await writeFile(configPath, `${config}\n[mcp_servers.${serverName}]\nextra = true\n`, "utf8");
    expect((await sessionStartReceipt(repo, false)).config).toMatchObject({ state: "invalid" });

    await writeFile(configPath, config.replace(/^command\s*=.*$/mu, 'command = "/tmp/codexa-missing/node"'), "utf8");
    expect((await sessionStartReceipt(repo, false)).config).toMatchObject({
      state: "invalid",
      reason: "Codexa-managed launcher command does not resolve to an executable file"
    });
  });

  it("keeps plain-text roots and session hints on bounded lines", async () => {
    const options = { workspaceSessionId: `session\n${"x".repeat(40_000)}` };
    const receipt = await sessionStartReceipt("/path/with\nINJECTED", false, options);
    expect(Buffer.byteLength(renderSessionStartJson(receipt), "utf8")).toBeLessThanOrEqual(SESSION_START_JSON_MAX_BYTES);

    const plain = await sessionStartSummary("/path/with\nINJECTED", false, options);
    expect(plain).not.toContain("\nINJECTED");
    expect(plain).not.toContain("\nsession\n");
    expect(Buffer.byteLength(plain, "utf8")).toBeLessThanOrEqual(2048);
  });

  it("reports invalid and drifted managed profiles as strict failures", async () => {
    const repo = await createRepo("codexa-session-receipt-drift-");
    const configPath = path.join(repo, ".codex/config.toml");
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(
      configPath,
      [
        "# >>> codexa managed",
        "[mcp_servers.codexa-fixture]",
        'command = "node"',
        `args = [${JSON.stringify(testCliPath)}, "serve", "--auto-refresh", "--tools", "full"]`,
        'enabled_tools = ["search", "change_plan", "capabilities"]',
        "# <<< codexa managed",
        ""
      ].join("\n"),
      "utf8"
    );
    const drift = await sessionStartReceipt(repo, false);
    expect(drift.config).toMatchObject({ state: "configured", toolProfile: "drift", serverToolProfile: "full" });
    expect(sessionStartStrictFailures(drift)).toContain("config profile drift");

    await writeFile(configPath, "# >>> codexa managed\n[mcp_servers.codexa-fixture]\n", "utf8");
    const invalid = await sessionStartReceipt(repo, false);
    expect(invalid.config).toMatchObject({ state: "invalid", reason: "unterminated Codexa-managed config block" });
    expect(sessionStartStrictFailures(invalid)).toContain("config invalid");
  });

  it("accepts a readable Codexa CLI from another package root and rejects a stale path", async () => {
    const repo = await createRepo("codexa-session-receipt-cross-checkout-");
    await initializeProject(repo, { cliPath: testCliPath });
    const configPath = path.join(repo, ".codex/config.toml");
    const config = await readFile(configPath, "utf8");
    const otherPackage = await mkdtemp(path.join(os.tmpdir(), "codexa-other-package-"));
    const otherCli = path.join(otherPackage, "dist/cli.js");
    await mkdir(path.dirname(otherCli), { recursive: true });
    await writeFile(path.join(otherPackage, "package.json"), `${JSON.stringify({ name: "@mirnoorata/codexa", version: CODEXA_VERSION, bin: { codexa: "dist/cli.js" } })}\n`, "utf8");
    await writeFile(otherCli, "#!/usr/bin/env node\n", "utf8");
    await writeFile(configPath, config.replaceAll(testCliPath, otherCli), "utf8");
    expect((await sessionStartReceipt(repo, false)).config).toMatchObject({ state: "configured", launcher: otherCli });

    await writeFile(path.join(otherPackage, "package.json"), `${JSON.stringify({ name: "@mirnoorata/codexa", version: "999.999.999", bin: { codexa: "dist/cli.js" } })}\n`, "utf8");
    expect((await sessionStartReceipt(repo, false)).config).toMatchObject({
      state: "invalid",
      reason: `Codexa-managed Node launcher is not a readable @mirnoorata/codexa@${CODEXA_VERSION} dist/cli.js`
    });

    const missingCli = path.join(otherPackage, "missing", "dist/cli.js");
    await writeFile(configPath, config.replaceAll(testCliPath, missingCli), "utf8");
    expect((await sessionStartReceipt(repo, false)).config).toMatchObject({
      state: "invalid",
      reason: `Codexa-managed Node launcher is not a readable @mirnoorata/codexa@${CODEXA_VERSION} dist/cli.js`
    });
  });

  it("validates long Node command and launcher paths before bounding receipt values", async () => {
    const repo = await createRepo("codexa-session-receipt-long-launcher-");
    await initializeProject(repo, { cliPath: testCliPath });
    const configPath = path.join(repo, ".codex/config.toml");
    const config = await readFile(configPath, "utf8");
    let packageRoot = await mkdtemp(path.join(os.tmpdir(), "codexa-long-package-"));
    for (let index = 0; index < 4; index += 1) {
      packageRoot = path.join(packageRoot, `nested-${index}-${"x".repeat(64)}`);
    }
    const longCli = path.join(packageRoot, "dist/cli.js");
    const longNode = path.join(packageRoot, "runtime/bin/node");
    expect(longCli.length).toBeGreaterThan(240);
    expect(longNode.length).toBeGreaterThan(240);
    await mkdir(path.dirname(longCli), { recursive: true });
    await mkdir(path.dirname(longNode), { recursive: true });
    await writeFile(
      path.join(packageRoot, "package.json"),
      `${JSON.stringify({ name: "@mirnoorata/codexa", version: CODEXA_VERSION, bin: { codexa: "dist/cli.js" } })}\n`,
      "utf8"
    );
    await writeFile(longCli, "#!/usr/bin/env node\n", "utf8");
    await symlink(process.execPath, longNode);
    await writeFile(configPath, config.replaceAll(process.execPath, longNode).replaceAll(testCliPath, longCli), "utf8");

    const receipt = await sessionStartReceipt(repo, false);
    expect(receipt.config).toMatchObject({ state: "configured", toolProfile: "core" });
    expect(receipt.config.command).toHaveLength(240);
    expect(receipt.config.command).toMatch(/\.\.\.$/u);
    expect(receipt.config.launcher).toHaveLength(240);
    expect(receipt.config.launcher).toMatch(/\.\.\.$/u);
    expect(sessionStartStrictFailures(receipt)).toEqual([]);
  });

  it("rejects a different configured Node runtime without executing it", async () => {
    const repo = await createRepo("codexa-session-receipt-untrusted-node-");
    await initializeProject(repo, { cliPath: testCliPath });
    const configPath = path.join(repo, ".codex/config.toml");
    const config = await readFile(configPath, "utf8");
    const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "codexa-untrusted-node-"));
    const otherNode = path.join(runtimeRoot, "node");
    const sentinel = path.join(runtimeRoot, "executed");
    await writeFile(
      otherNode,
      `#!/usr/bin/env bash\nprintf executed >${JSON.stringify(sentinel)}\nexit 1\n`,
      "utf8"
    );
    await chmod(otherNode, 0o755);
    await writeFile(configPath, config.replaceAll(process.execPath, otherNode), "utf8");

    const receipt = await sessionStartReceipt(repo, false);
    expect(receipt.config).toMatchObject({
      state: "invalid",
      reason: "Codexa-managed Node command is not the current trusted runtime; re-run codexa init"
    });
    expect(sessionStartStrictFailures(receipt)).toContain("config invalid");
    await expect(readFile(sentinel, "utf8")).rejects.toThrow();
  });

  it("rejects npx when its sibling Node is not the current trusted runtime", async () => {
    const repo = await createRepo("codexa-session-receipt-untrusted-npx-");
    await initializeProject(repo, { cliPath: "/tmp/_npx/fixture/node_modules/@mirnoorata/codexa/dist/cli.js" });
    const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "codexa-untrusted-npx-"));
    const fakeNpx = path.join(runtimeRoot, "npx");
    const fakeNode = path.join(runtimeRoot, "node");
    const sentinel = path.join(runtimeRoot, "npx-executed");
    await writeFile(fakeNpx, `#!/usr/bin/env bash\nprintf executed >${JSON.stringify(sentinel)}\nexit 1\n`, "utf8");
    await writeFile(fakeNode, "#!/usr/bin/env bash\nexit 1\n", "utf8");
    await chmod(fakeNpx, 0o755);
    await chmod(fakeNode, 0o755);
    const originalPath = process.env.PATH;
    process.env.PATH = `${runtimeRoot}${path.delimiter}${originalPath ?? ""}`;
    try {
      const receipt = await sessionStartReceipt(repo, false);
      expect(receipt.config).toMatchObject({
        state: "invalid",
        reason: "Codexa-managed npx command is not paired with the current trusted Node runtime; re-run codexa init"
      });
      expect(sessionStartStrictFailures(receipt)).toContain("config invalid");
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
    }
    await expect(readFile(sentinel, "utf8")).rejects.toThrow();
  });

  it("rejects a copied managed config that serves a different checkout", async () => {
    const repo = await createRepo("codexa-session-receipt-config-root-");
    const wrongRepo = await createRepo("codexa-session-receipt-wrong-root-");
    await initializeProject(repo, { cliPath: testCliPath, index: false });
    const configPath = path.join(repo, ".codex/config.toml");
    const config = await readFile(configPath, "utf8");
    await writeFile(configPath, config.replace(`"serve", "${repo}"`, `"serve", "${wrongRepo}"`), "utf8");

    const receipt = await sessionStartReceipt(repo, false);
    expect(receipt.config).toMatchObject({
      state: "invalid",
      configuredRepoRoot: wrongRepo,
      toolProfile: "drift",
      serverToolProfile: "core"
    });
    expect(receipt.config.reason).toContain("does not match active repo");
    expect(receipt.config.configuredRepoRoot?.length).toBeLessThanOrEqual(240);
    expect(sessionStartStrictFailures(receipt)).toContain("config invalid");

    const longTarget = path.join(path.dirname(wrongRepo), "x".repeat(400));
    await writeFile(
      configPath,
      config.replace(`"${repo}", "--auto-refresh"`, `"${longTarget}", "--auto-refresh"`),
      "utf8"
    );
    const bounded = await sessionStartReceipt(repo, false);
    expect(bounded.config.configuredRepoRoot).toHaveLength(240);
    expect(bounded.config.configuredRepoRoot).toMatch(/\.\.\.$/u);
  });

  it("resolves bare launcher commands with Windows PATHEXT semantics", () => {
    expect(executableCommandCandidates("node", "C:\\one;D:\\two", "win32", ".EXE;.CMD")).toEqual([
      "C:\\one\\node.exe", "C:\\one\\node.cmd", "D:\\two\\node.exe", "D:\\two\\node.cmd"
    ]);
    expect(pairedNodeCommandCandidates("C:\\runtime\\npx.cmd", "win32")).toEqual([
      "C:\\runtime\\node.exe", "C:\\runtime\\node"
    ]);
  });
});

async function createRepo(prefix: string): Promise<string> {
  const repo = await mkdtemp(path.join(os.tmpdir(), prefix));
  await initializeGitRepo(repo);
  return repo;
}

async function createRepoAt(parent: string, name: string): Promise<string> {
  const repo = path.join(parent, name);
  await mkdir(repo, { recursive: true });
  await initializeGitRepo(repo);
  return repo;
}

async function initializeGitRepo(repo: string): Promise<void> {
  execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
  await mkdir(path.join(repo, "src"), { recursive: true });
  await writeFile(path.join(repo, "package.json"), `${JSON.stringify({ scripts: { test: "vitest run" } }, null, 2)}\n`, "utf8");
  await writeFile(path.join(repo, "src/main.ts"), "export function main() { return 1 }\n", "utf8");
  execFileSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["-c", "user.name=Codexa", "-c", "user.email=codexa@example.invalid", "commit", "-m", "fixture"], {
    cwd: repo,
    stdio: "ignore"
  });
}
