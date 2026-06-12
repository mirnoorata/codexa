import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { initializeProject, sessionStartSummary } from "../src/init.js";
import { CODEXA_VERSION } from "../src/version.js";

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
    expect(config).toContain("hooks = true");
    expect(config).not.toContain("codex_hooks");
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
    expect(hooks.hooks.PreToolUse[0].matcher).toBe("Edit|MultiEdit|Write|NotebookEdit|apply_patch");
    expect(hooks.hooks.PreToolUse[0].hooks[0].command).toBe(`node '/opt/codexa/dist/cli.js' hook-pre-edit '${repo}'`);
    expect(hooks.hooks.PostToolUse[0].hooks[0].command).toBe(`node '/opt/codexa/dist/cli.js' hook-post-edit '${repo}'`);

    const freshness = await readFile(path.join(repo, ".codex/codebase/freshness.json"), "utf8");
    expect(JSON.parse(freshness).stale).toBe(false);

    const summary = await sessionStartSummary(repo, false);
    expect(summary).toContain(`Codexa context for ${repo}`);
    expect(summary).toContain("Codexa MCP is ready");
    expect(summary).toContain("primary loop session_context -> search(if target unclear) -> task_brief -> change_plan(saveSnapshot) -> post_edit_review -> test_plan");
    expect(summary).not.toContain("broad task -> focus_brief/session_context");
  });

  it("writes the core tool profile and managed AGENTS.md block when requested", async () => {
    const repo = await createInitRepo();
    await writeFile(path.join(repo, "AGENTS.md"), "# Existing runbook\n\nKeep this content.\n", "utf8");

    const result = await initializeProject(repo, {
      cliPath: "/opt/codexa/dist/cli.js",
      index: false,
      toolProfile: "core",
      agentsMd: true
    });

    const config = await readFile(path.join(repo, ".codex/config.toml"), "utf8");
    expect(config).toContain("enabled_tools = [");
    expect(config).toContain('"session_context"');
    expect(config).toContain('"post_edit_review"');
    expect(config).toContain('"impact"');
    expect(config).toContain("startup_timeout_sec = 20");

    expect(result.agentsMdPath).toBe(path.join(repo, "AGENTS.md"));
    const agentsMd = await readFile(path.join(repo, "AGENTS.md"), "utf8");
    expect(agentsMd).toContain("Keep this content.");
    expect(agentsMd).toContain("<!-- >>> codexa managed -->");
    expect(agentsMd).toContain("change_plan");

    // Re-run init: managed block must be replaced, not duplicated.
    await initializeProject(repo, {
      cliPath: "/opt/codexa/dist/cli.js",
      index: false,
      toolProfile: "full",
      agentsMd: true
    });
    const rerunAgentsMd = await readFile(path.join(repo, "AGENTS.md"), "utf8");
    expect(rerunAgentsMd.match(/<!-- >>> codexa managed -->/gu)).toHaveLength(1);
    const rerunConfig = await readFile(path.join(repo, ".codex/config.toml"), "utf8");
    expect(rerunConfig).not.toContain("enabled_tools = [");
  });

  it("refuses to rewrite AGENTS.md when managed markers are unbalanced", async () => {
    const repo = await createInitRepo();
    const original = "# Runbook\n\n<!-- >>> codexa managed -->\nimportant user content with no end marker\n";
    await writeFile(path.join(repo, "AGENTS.md"), original, "utf8");

    await expect(
      initializeProject(repo, {
        cliPath: "/opt/codexa/dist/cli.js",
        index: false,
        agentsMd: true
      })
    ).rejects.toThrow(/unterminated/u);
    expect(await readFile(path.join(repo, "AGENTS.md"), "utf8")).toBe(original);
  });

  it("refuses to rewrite AGENTS.md when an orphan end marker is present", async () => {
    const repo = await createInitRepo();
    const original = "# Runbook\n\n<!-- <<< codexa managed -->\nuser content\n";
    await writeFile(path.join(repo, "AGENTS.md"), original, "utf8");

    await expect(
      initializeProject(repo, {
        cliPath: "/opt/codexa/dist/cli.js",
        index: false,
        agentsMd: true
      })
    ).rejects.toThrow(/orphan/u);
    expect(await readFile(path.join(repo, "AGENTS.md"), "utf8")).toBe(original);
  });

  it("writes a managed CLAUDE.md block for Claude Code independently of AGENTS.md", async () => {
    const repo = await createInitRepo();
    await writeFile(path.join(repo, "CLAUDE.md"), "# Project memory\n\nKeep this.\n", "utf8");

    const result = await initializeProject(repo, {
      cliPath: "/opt/codexa/dist/cli.js",
      index: false,
      claudeMd: true
    });

    expect(result.claudeMdPath).toBe(path.join(repo, "CLAUDE.md"));
    expect(result.agentsMdPath).toBeNull();
    const claudeMd = await readFile(path.join(repo, "CLAUDE.md"), "utf8");
    expect(claudeMd).toContain("Keep this.");
    expect(claudeMd).toContain("<!-- >>> codexa managed -->");
    expect(claudeMd).toContain("change_plan");
    // CLAUDE.md must not have triggered an AGENTS.md write.
    await expect(readFile(path.join(repo, "AGENTS.md"), "utf8")).rejects.toThrow();

    // Re-run: managed block replaced, not duplicated.
    await initializeProject(repo, { cliPath: "/opt/codexa/dist/cli.js", index: false, claudeMd: true });
    const rerun = await readFile(path.join(repo, "CLAUDE.md"), "utf8");
    expect(rerun.match(/<!-- >>> codexa managed -->/gu)).toHaveLength(1);
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
    expect(config).toContain("hooks = true");
    expect(config).not.toContain("codex_hooks");
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
        "hooks = true",
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

  it("honors no-hooks without leaving stale Codexa-managed hooks enabled", async () => {
    const repo = await createInitRepo();
    const codexDir = path.join(repo, ".codex");
    await mkdir(codexDir, { recursive: true });
    await writeFile(path.join(codexDir, "config.toml"), ["[features]", "hooks = true", "codex_hooks = true", ""].join("\n"), "utf8");
    await writeFile(
      path.join(codexDir, "hooks.json"),
      JSON.stringify(
        {
          hooks: {
            SessionStart: [
              {
                codexaManaged: true,
                matcher: "startup|resume",
                hooks: [{ codexaManaged: true, type: "command", command: "node /opt/context/dist/cli.js session-start /tmp/repo", timeout: 5 }]
              }
            ],
            PreToolUse: [
              {
                matcher: "Edit|Write",
                hooks: [{ type: "command", command: "node /opt/context/dist/cli.js hook-pre-edit /tmp/repo", timeout: 5 }]
              }
            ]
          }
        },
        null,
        2
      ),
      "utf8"
    );

    const result = await initializeProject(repo, {
      cliPath: "/opt/context/dist/cli.js",
      hooks: false,
      index: false
    });

    expect(result.hooksPath).toBeNull();
    const config = await readFile(path.join(repo, ".codex/config.toml"), "utf8");
    expect(config).not.toContain("hooks = true");
    expect(config).not.toContain("codex_hooks");
    await expect(readFile(path.join(repo, ".codex/hooks.json"), "utf8")).rejects.toThrow();
  });

  it("preserves unmanaged hooks and their feature flag when no-hooks removes only Codexa hooks", async () => {
    const repo = await createInitRepo();
    const codexDir = path.join(repo, ".codex");
    await mkdir(codexDir, { recursive: true });
    await writeFile(path.join(codexDir, "config.toml"), ["[features]", "hooks = true", ""].join("\n"), "utf8");
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
                codexaManaged: true,
                matcher: "startup|resume",
                hooks: [{ codexaManaged: true, type: "command", command: "node /opt/context/dist/cli.js session-start /tmp/repo", timeout: 5 }]
              }
            ],
            PostToolUse: [
              {
                matcher: "Edit",
                hooks: [{ type: "command", command: "bash ./scripts/hook-post-edit-audit.sh /tmp/repo", timeout: 5 }]
              }
            ]
          }
        },
        null,
        2
      ),
      "utf8"
    );

    const result = await initializeProject(repo, {
      cliPath: "/opt/context/dist/cli.js",
      hooks: false,
      index: false
    });

    expect(result.hooksPath).toBeNull();
    const config = await readFile(path.join(repo, ".codex/config.toml"), "utf8");
    expect(config).toContain("hooks = true");
    expect(config).not.toContain("codex_hooks");
    const hooks = JSON.parse(await readFile(path.join(repo, ".codex/hooks.json"), "utf8")) as {
      hooks: {
        SessionStart: Array<{ hooks: Array<{ command: string }> }>;
        PostToolUse: Array<{ hooks: Array<{ command: string }> }>;
      };
    };
    const sessionCommands = hooks.hooks.SessionStart.flatMap((entry) => entry.hooks.map((hook) => hook.command));
    const postToolCommands = hooks.hooks.PostToolUse.flatMap((entry) => entry.hooks.map((hook) => hook.command));
    expect(sessionCommands).toEqual(["echo keep"]);
    expect(postToolCommands).toEqual(["bash ./scripts/hook-post-edit-audit.sh /tmp/repo"]);
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
    expect(summary).toContain("Session Memory Protocol");
    expect(summary).toContain("session_memory");
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

  it("routes workspace-root session-start summaries through the workspace default repo", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "codexa-session-start-default-workspace-"));
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

describe("Claude Code init wiring", () => {
  it("writes a managed codexa entry into .mcp.json with --claude and preserves other servers", async () => {
    const repo = await createInitRepo();
    await writeFile(
      path.join(repo, ".mcp.json"),
      JSON.stringify({ mcpServers: { other: { command: "node", args: ["x.js"] } }, custom: true }, null, 2),
      "utf8"
    );

    const result = await initializeProject(repo, { cliPath: "/opt/codexa/dist/cli.js", claude: true, index: false });

    expect(result.claudeMcpPath).toBe(path.join(repo, ".mcp.json"));
    const parsed = JSON.parse(await readFile(path.join(repo, ".mcp.json"), "utf8")) as {
      custom: boolean;
      mcpServers: Record<string, { command: string; args: string[] }>;
    };
    expect(parsed.custom).toBe(true);
    expect(parsed.mcpServers.other).toEqual({ command: "node", args: ["x.js"] });
    const entry = parsed.mcpServers[result.serverName];
    expect(entry.command).toBe("node");
    expect(entry.args).toEqual(["/opt/codexa/dist/cli.js", "serve", repo, "--auto-refresh", "--tools", "core"]);
  });

  it("replaces a stale codexa entry under a different name instead of duplicating it", async () => {
    const repo = await createInitRepo();
    await writeFile(
      path.join(repo, ".mcp.json"),
      JSON.stringify({ mcpServers: { "codexa-old": { command: "node", args: ["/old/codexa/dist/cli.js", "serve", repo] } } }, null, 2),
      "utf8"
    );

    const result = await initializeProject(repo, { cliPath: "/opt/codexa/dist/cli.js", claude: true, index: false });

    const parsed = JSON.parse(await readFile(path.join(repo, ".mcp.json"), "utf8")) as {
      mcpServers: Record<string, unknown>;
    };
    expect(Object.keys(parsed.mcpServers)).toEqual([result.serverName]);
  });

  it("aborts the --claude write when .mcp.json is malformed", async () => {
    const repo = await createInitRepo();
    await writeFile(path.join(repo, ".mcp.json"), "{ not json", "utf8");

    await expect(initializeProject(repo, { cliPath: "/opt/codexa/dist/cli.js", claude: true, index: false })).rejects.toThrow(/Cannot update/u);
    expect(await readFile(path.join(repo, ".mcp.json"), "utf8")).toBe("{ not json");
  });

  it("pins a versioned npx launch when the CLI resolves from the npx cache", async () => {
    const repo = await createInitRepo();
    const npxCli = "/opt/npm-cache/_npx/0123abcd/node_modules/@mirnoorata/codexa/dist/cli.js";

    const result = await initializeProject(repo, { cliPath: npxCli, claude: true, index: false });

    expect(result.launchNote).toContain("npx cache");
    const config = await readFile(path.join(repo, ".codex/config.toml"), "utf8");
    expect(config).toContain('command = "npx"');
    expect(config).toContain(`"@mirnoorata/codexa@${CODEXA_VERSION}"`);
    expect(config).not.toContain("_npx");

    const hooks = JSON.parse(await readFile(path.join(repo, ".codex/hooks.json"), "utf8")) as {
      hooks: { SessionStart: Array<{ hooks: Array<{ command: string }> }> };
    };
    expect(hooks.hooks.SessionStart[0].hooks[0].command).toBe(`npx '-y' '@mirnoorata/codexa@${CODEXA_VERSION}' session-start '${repo}'`);

    const mcp = JSON.parse(await readFile(path.join(repo, ".mcp.json"), "utf8")) as {
      mcpServers: Record<string, { command: string; args: string[] }>;
    };
    expect(mcp.mcpServers[result.serverName].command).toBe("npx");
    expect(mcp.mcpServers[result.serverName].args.slice(0, 2)).toEqual(["-y", `@mirnoorata/codexa@${CODEXA_VERSION}`]);
  });

  it("re-running init removes the previously generated npx hook commands", async () => {
    const repo = await createInitRepo();
    const npxCli = "/opt/npm-cache/_npx/0123abcd/node_modules/@mirnoorata/codexa/dist/cli.js";
    await initializeProject(repo, { cliPath: npxCli, index: false });

    await initializeProject(repo, { cliPath: "/opt/codexa/dist/cli.js", index: false });

    const hooks = JSON.parse(await readFile(path.join(repo, ".codex/hooks.json"), "utf8")) as {
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    };
    const allCommands = Object.values(hooks.hooks)
      .flat()
      .flatMap((entry) => entry.hooks.map((hook) => hook.command));
    expect(allCommands.filter((command) => command.includes("session-start"))).toHaveLength(1);
    expect(allCommands.some((command) => command.startsWith("npx"))).toBe(false);
  });
});

describe("init profile preservation and entry safety", () => {
  it("re-running plain init preserves an existing full profile", async () => {
    const repo = await createInitRepo();
    await initializeProject(repo, { cliPath: "/opt/codexa/dist/cli.js", index: false, toolProfile: "full" });
    const firstConfig = await readFile(path.join(repo, ".codex/config.toml"), "utf8");
    expect(firstConfig).not.toContain("enabled_tools");

    await initializeProject(repo, { cliPath: "/opt/codexa/dist/cli.js", index: false });
    const rerunConfig = await readFile(path.join(repo, ".codex/config.toml"), "utf8");
    expect(rerunConfig).not.toContain("enabled_tools");
  });

  it("re-running plain init preserves an existing core profile and fresh installs default to core", async () => {
    const repo = await createInitRepo();
    await initializeProject(repo, { cliPath: "/opt/codexa/dist/cli.js", index: false });
    const fresh = await readFile(path.join(repo, ".codex/config.toml"), "utf8");
    expect(fresh).toContain("enabled_tools");

    await initializeProject(repo, { cliPath: "/opt/codexa/dist/cli.js", index: false });
    const rerun = await readFile(path.join(repo, ".codex/config.toml"), "utf8");
    expect(rerun).toContain("enabled_tools");
  });

  it("does not delete user MCP servers that merely mention codexa in a path", async () => {
    const repo = await createInitRepo();
    const userServer = { command: "node", args: ["/home-dir/codexa-tools/scripts/serve.js", "serve", "things"] };
    await writeFile(path.join(repo, ".mcp.json"), JSON.stringify({ mcpServers: { mytool: userServer } }, null, 2), "utf8");

    const result = await initializeProject(repo, { cliPath: "/opt/codexa/dist/cli.js", claude: true, index: false });

    const parsed = JSON.parse(await readFile(path.join(repo, ".mcp.json"), "utf8")) as {
      mcpServers: Record<string, unknown>;
    };
    expect(parsed.mcpServers.mytool).toEqual(userServer);
    expect(Object.keys(parsed.mcpServers).sort()).toEqual(["mytool", result.serverName].sort());
  });

  it("pins a versioned npx launch for pnpm dlx cache paths", async () => {
    const repo = await createInitRepo();
    const dlxCli = "/opt/cache/pnpm/dlx/7f2a9c1b3e/node_modules/@mirnoorata/codexa/dist/cli.js";

    const result = await initializeProject(repo, { cliPath: dlxCli, index: false });

    expect(result.launchNote).toContain("npx");
    const config = await readFile(path.join(repo, ".codex/config.toml"), "utf8");
    expect(config).toContain('command = "npx"');
    expect(config).not.toContain("/pnpm/dlx/");
  });
});
