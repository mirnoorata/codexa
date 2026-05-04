import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { initializeProject, sessionStartSummary } from "../src/init.js";

describe("Codexa project init", () => {
  it("writes repo-local Codex config, hook, and initial artifacts", async () => {
    const repo = await createInitRepo();
    const result = await initializeProject(repo, {
      cliPath: "/opt/codexa/dist/cli.js"
    });

    expect(result.repoRoot).toBe(repo);
    expect(result.serverName).toMatch(/^codexa-codexa-init-/u);
    expect(result.indexed?.files).toBeGreaterThan(0);

    const config = await readFile(path.join(repo, ".codex/config.toml"), "utf8");
    expect(config).toContain("[features]");
    expect(config).toContain("codex_hooks = true");
    expect(config).toContain(`[mcp_servers.${result.serverName}]`);
    expect(config).toContain(`args = ["/opt/codexa/dist/cli.js", "serve", "${repo}", "--auto-refresh"]`);

    const hooks = JSON.parse(await readFile(path.join(repo, ".codex/hooks.json"), "utf8")) as {
      hooks: {
        SessionStart: Array<{ hooks: Array<{ command: string }> }>;
        PreToolUse: Array<{ matcher: string; hooks: Array<{ command: string }> }>;
        PostToolUse: Array<{ matcher: string; hooks: Array<{ command: string }> }>;
      };
    };
    expect(hooks.hooks.SessionStart).toHaveLength(1);
    expect(hooks.hooks.SessionStart[0].hooks[0].command).toBe(`node '/opt/codexa/dist/cli.js' session-start '${repo}'`);
    expect(hooks.hooks.PreToolUse[0].matcher).toBe("Edit|MultiEdit|Write|apply_patch");
    expect(hooks.hooks.PreToolUse[0].hooks[0].command).toBe(`node '/opt/codexa/dist/cli.js' hook-pre-edit '${repo}'`);
    expect(hooks.hooks.PostToolUse[0].hooks[0].command).toBe(`node '/opt/codexa/dist/cli.js' hook-post-edit '${repo}'`);

    const freshness = await readFile(path.join(repo, ".codex/codebase/freshness.json"), "utf8");
    expect(JSON.parse(freshness).stale).toBe(false);

    const summary = await sessionStartSummary(repo, false);
    expect(summary).toContain(`Codexa context for ${repo}`);
    expect(summary).toContain("Codexa MCP is ready");
  });

  it("updates existing config and hooks idempotently without clobbering unrelated entries", async () => {
    const repo = await createInitRepo();
    const codexDir = path.join(repo, ".codex");
    await mkdir(codexDir, { recursive: true });
    const staleServerName = `codexa-${path.basename(repo)}`;
    await writeFile(
      path.join(codexDir, "config.toml"),
      [
        "[features]",
        "other_flag = true",
        "codex_hooks = false",
        "",
        `[mcp_servers.${staleServerName}]`,
        'command = "old"',
        'args = ["old"]',
        "",
        "[other]",
        "value = true",
        ""
      ].join("\n"),
      "utf8"
    );
    await writeFile(
      path.join(codexDir, "hooks.json"),
      JSON.stringify(
        {
          hooks: {
            SessionStart: [
              {
                matcher: "startup",
                hooks: [{ type: "command", command: "echo keep", timeout: 1 }]
              },
              {
                matcher: "startup",
                hooks: [{ type: "command", command: "node ./scripts/session-start.js", timeout: 1 }]
              },
              {
                matcher: "startup|resume",
                hooks: [{ type: "command", command: "/opt/codexa/scripts/codexa-sessionstart-legacy.sh /opt/project", timeout: 5 }]
              }
            ]
          }
        },
        null,
        2
      ),
      "utf8"
    );

    const first = await initializeProject(repo, {
      cliPath: "/opt/codexa/dist/cli.js",
      index: false
    });
    await initializeProject(repo, {
      cliPath: "/opt/codexa/dist/cli.js",
      index: false
    });

    const config = await readFile(path.join(codexDir, "config.toml"), "utf8");
    expect(config).toContain("other_flag = true");
    expect(config).toContain("codex_hooks = true");
    expect(config).toContain("[other]");
    expect(config.match(new RegExp(`\\[mcp_servers\\.${first.serverName}\\]`, "g"))).toHaveLength(1);
    expect(config).not.toContain('command = "old"');

    const hooks = JSON.parse(await readFile(path.join(codexDir, "hooks.json"), "utf8")) as {
      hooks: { SessionStart: Array<{ hooks: Array<{ command: string }> }> };
    };
    const commands = hooks.hooks.SessionStart.flatMap((entry) => entry.hooks.map((hook) => hook.command));
    expect(commands).toContain("echo keep");
    expect(commands).toContain("node ./scripts/session-start.js");
    expect(commands.filter((command) => command.includes(" session-start ") && command.includes("/opt/codexa/dist/cli.js"))).toHaveLength(1);
    expect(commands.some((command) => command.includes("codexa-sessionstart-legacy"))).toBe(false);
  });

  it("deduplicates managed hooks even when the CLI path is not named codexa", async () => {
    const repo = await createInitRepo();
    await initializeProject(repo, {
      cliPath: "/opt/context/dist/cli.js",
      index: false
    });
    await initializeProject(repo, {
      cliPath: "/opt/context/dist/cli.js",
      index: false
    });

    const hooks = JSON.parse(await readFile(path.join(repo, ".codex/hooks.json"), "utf8")) as {
      hooks: { SessionStart: Array<{ hooks: Array<{ command: string; codexaManaged?: boolean }> }> };
    };
    const commands = hooks.hooks.SessionStart.flatMap((entry) => entry.hooks.map((hook) => hook.command));
    expect(commands.filter((command) => command.includes("session-start"))).toHaveLength(1);
    expect(hooks.hooks.SessionStart[0].hooks[0].codexaManaged).toBe(true);
  });

  it("removes stale Codexa MCP server blocks when the server name changes", async () => {
    const repo = await createInitRepo();
    const codexDir = path.join(repo, ".codex");
    await mkdir(codexDir, { recursive: true });
    await writeFile(
      path.join(codexDir, "config.toml"),
      [
        "[features]",
        "codex_hooks = true",
        "",
        "[mcp_servers.codexa-old]",
        'command = "node"',
        `args = ["/opt/context/dist/cli.js", "serve", "${repo}", "--auto-refresh"]`,
        "",
        "[mcp_servers.other]",
        'command = "other"',
        'args = ["keep"]',
        "",
        "[mcp_servers.docs]",
        'command = "node"',
        `args = ["/opt/docs-mcp/dist/cli.js", "serve", "${repo}"]`,
        ""
      ].join("\n"),
      "utf8"
    );

    await initializeProject(repo, {
      cliPath: "/opt/context/dist/cli.js",
      index: false,
      serverName: "codexa-new"
    });

    const config = await readFile(path.join(codexDir, "config.toml"), "utf8");
    expect(config).not.toContain("[mcp_servers.codexa-old]");
    expect(config).toContain("[mcp_servers.codexa-new]");
    expect(config).toContain("[mcp_servers.other]");
    expect(config).toContain("[mcp_servers.docs]");
  });

  it("rejects unsafe MCP server names before writing config", async () => {
    const repo = await createInitRepo();

    await expect(
      initializeProject(repo, {
        cliPath: "/opt/context/dist/cli.js",
        index: false,
        serverName: "codexa-bad]\n[mcp_servers.injected]"
      })
    ).rejects.toThrow("Invalid Codexa MCP server name");
    await expect(readFile(path.join(repo, ".codex/config.toml"), "utf8")).rejects.toThrow();
  });

  it("honors no-hooks without enabling Codex hooks", async () => {
    const repo = await createInitRepo();

    const result = await initializeProject(repo, {
      cliPath: "/opt/context/dist/cli.js",
      hooks: false,
      index: false
    });

    expect(result.hooksPath).toBeNull();
    const config = await readFile(path.join(repo, ".codex/config.toml"), "utf8");
    expect(config).not.toContain("codex_hooks = true");
    await expect(readFile(path.join(repo, ".codex/hooks.json"), "utf8")).rejects.toThrow();
  });

  it("anchors init to the git root when invoked from a nested directory", async () => {
    const repo = await createInitRepo();
    const nested = path.join(repo, "src");

    const result = await initializeProject(nested, {
      cliPath: "/opt/codexa/dist/cli.js",
      index: false
    });

    expect(result.repoRoot).toBe(repo);
    expect(result.configPath).toBe(path.join(repo, ".codex/config.toml"));
  });

  it("degrades session-start context when the index is missing", async () => {
    const repo = await createInitRepo();
    const summary = await sessionStartSummary(repo, true);
    expect(summary).toContain("Codexa Codex Contract");
    expect(summary).toContain("codexa index <repo>");
    expect(summary).toContain("Codexa MCP is ready");
  });

  it("keeps session-start advisory outside git repositories", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-session-start-nongit-"));
    const summary = await sessionStartSummary(repo, true);

    expect(summary).toContain("Codexa status unavailable:");
    expect(summary).toContain("Codexa startup hook is advisory");
  });

  it("routes workspace-root session-start summaries to the focused repository", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "codexa-session-start-workspace-"));
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
    await writeFile(path.join(workspace, ".codex", "WORKING.md"), `## Active Focus\n\n- Project: \`${repo}\`\n`, "utf8");

    const summary = await sessionStartSummary(workspace, false);

    expect(summary).toContain(`Codexa context for ${repo}:`);
    expect(summary).toContain(`Workspace root: ${workspace} -> focused repo via workspace-focus-file:`);
    expect(summary).toContain(`Repo: ${repo}`);
    expect(summary).not.toContain("Codexa status unavailable:");
    expect(summary).not.toContain("Failed to read git status");
  });

  it("honors session-start auto-refresh when the index is missing", async () => {
    const repo = await createInitRepo();
    const summary = await sessionStartSummary(repo, true, true);

    expect(summary).toContain("Codexa status: fresh");
    expect(summary).toContain("Session-start auto-refresh: enabled");
    expect(JSON.parse(await readFile(path.join(repo, ".codex/codebase/freshness.json"), "utf8")).stale).toBe(false);
  });
});

async function createInitRepo(): Promise<string> {
  const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-init-"));
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
