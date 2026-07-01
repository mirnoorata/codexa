import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, mkdir, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { describe, expect, it } from "vitest";
import { buildIndex } from "../src/indexer.js";
import { MCP_TOOL_CATALOG, PRIMARY_CODEX_LOOP, compactNonPostEditMcpResult, compactPostEditMcpResult } from "../src/mcp.js";
import { conciseText } from "../src/mcp/compaction.js";
import { CORE_PROFILE_TOOL_NAMES, MCP_TOOL_NAMES, MCP_TOOL_REGISTRY } from "../src/mcp/tool-registry.js";
import { MCP_REGISTERED_TOOL_NAMES } from "../src/mcp/tools.js";
import { CURRENT_VERIFICATION_PROVENANCE } from "../src/types.js";
import { CODEXA_VERSION } from "../src/version.js";
import { freshnessFixture, seq, serializedBytes, waitForStderr, stopChild, waitForExit, createIndexedMcpRepo, createIndexedMcpAutoVerifyRepo, buildContextPacket, buildFocusBriefPacket, buildTestPlanPacket, buildChangePlanPacket } from "./mcp-fixtures.js";
describe("Codexa MCP server", () => {
it("keeps the primary MCP happy path small and demotes graph/workflow tools", () => {
    const primaryTools = MCP_TOOL_CATALOG.filter((tool) => tool.tier === "primary").map((tool) => tool.name);

    expect(primaryTools).toEqual(["session_context", "search", "task_brief", "change_plan", "post_edit_review", "test_plan", "proof_card"]);
    expect(MCP_TOOL_CATALOG.find((tool) => tool.name === "workflow_path")).toMatchObject({ tier: "advanced" });
    expect(MCP_TOOL_CATALOG.find((tool) => tool.name === "change_plan")).toMatchObject({
      useWhen: expect.stringContaining("saveSnapshot=true"),
      avoidWhen: expect.stringContaining("post_edit_review")
    });
    expect(MCP_TOOL_CATALOG.find((tool) => tool.name === "search")).toMatchObject({
      readOnly: false,
      writeEffects: expect.stringContaining("index-cache-if-auto-refresh"),
      useWhen: expect.stringContaining("Before task_brief")
    });
    expect(MCP_TOOL_CATALOG.map((tool) => tool.name)).toEqual(MCP_TOOL_NAMES);
    expect(MCP_REGISTERED_TOOL_NAMES).toEqual(MCP_TOOL_NAMES);
    expect(MCP_TOOL_REGISTRY.map((tool) => ({ name: tool.name, title: tool.title, description: tool.description }))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "change_plan", title: "Codexa change plan", description: expect.stringContaining("saveSnapshot=true") }),
        expect.objectContaining({ name: "search", title: "Codexa hybrid semantic search", description: expect.stringContaining("Search the codebase") }),
        expect.objectContaining({ name: "post_edit_review", title: "Codexa post-edit review", description: expect.stringContaining("Review code changes for drift") }),
        expect.objectContaining({ name: "proof_card", title: "Codexa proof card", description: expect.stringContaining("Final proof packet") })
      ])
    );
  });

it("routes workspace-root MCP calls and resources to the focused repository", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "codexa-mcp-workspace-"));
    execFileSync("git", ["init"], { cwd: workspace, stdio: "ignore" });
    const repoA = await createIndexedMcpRepo(workspace, "repo-a", "alpha", "alphaSymbol");
    const repoB = await createIndexedMcpRepo(workspace, "repo-b", "beta", "betaSymbol");
    const focusFile = path.join(workspace, ".codex", "WORKING.md");
    await mkdir(path.dirname(focusFile), { recursive: true });
    await writeFile(focusFile, `## Session\n\n- Focused project: \`${repoA}\`.\n`, "utf8");

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(process.cwd(), "dist/cli.js"), "serve", workspace],
      stderr: "pipe"
    });
    const client = new Client({ name: "codexa-workspace-routing-test", version: "0.1.0" });
    await client.connect(transport);

    try {
      const firstFreshness = await client.callTool({ name: "freshness", arguments: {} });
      expect(JSON.stringify(firstFreshness)).toContain(repoA);
      expect(JSON.stringify(firstFreshness)).not.toContain("Failed to read git status");

      const firstRepoMap = await client.callTool({ name: "repo_map", arguments: { limit: 5 } });
      expect(JSON.stringify(firstRepoMap)).toContain("src/alpha.ts");
      expect(JSON.stringify(firstRepoMap)).not.toContain("src/beta.ts");

      const firstResource = await client.readResource({ uri: "codexa://repo/codebase/repo-map.md" });
      expect(String(firstResource.contents?.[0]?.text)).toContain("src/alpha.ts");
      expect(String(firstResource.contents?.[0]?.text)).not.toContain("src/beta.ts");

      await writeFile(focusFile, `## Active Focus\n\n- Project: \`${repoB}\`\n`, "utf8");

      const secondSearch = await client.callTool({ name: "find_context", arguments: { query: "betaSymbol", limit: 5 } });
      expect(JSON.stringify(secondSearch)).toContain(repoB);
      expect(JSON.stringify(secondSearch)).toContain("betaSymbol");
      expect(JSON.stringify(secondSearch)).not.toContain("Failed to read git status");

      const secondResource = await client.readResource({ uri: "codexa://repo/codebase/repo-map.md" });
      expect(String(secondResource.contents?.[0]?.text)).toContain("src/beta.ts");
      expect(String(secondResource.contents?.[0]?.text)).not.toContain("src/alpha.ts");
    } finally {
      await client.close();
    }
  });

it("routes unscoped workspace default despite active-session rows", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "codexa-mcp-working-default-"));
    execFileSync("git", ["init"], { cwd: workspace, stdio: "ignore" });
    const defaultRepo = await createIndexedMcpRepo(workspace, "default-repo", "alpha", "alphaSymbol");
    const activeRepo = await createIndexedMcpRepo(workspace, "active-repo", "beta", "betaSymbol");
    const focusFile = path.join(workspace, ".codex", "WORKING.md");
    await mkdir(path.dirname(focusFile), { recursive: true });
    await writeFile(
      focusFile,
      [
        "## Workspace Default",
        "",
        `- Default repo: \`${defaultRepo}\`.`,
        "",
        "## Active Sessions",
        "",
        "| session | agent | repo | task | status | claims | last_seen | next |",
        "| --- | --- | --- | --- | --- | --- | --- | --- |",
        `| codex-test | codex | ${activeRepo} | route task | active | none | now | inspect |`
      ].join("\n"),
      "utf8"
    );

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(process.cwd(), "dist/cli.js"), "serve", workspace],
      stderr: "pipe"
    });
    const client = new Client({ name: "codexa-working-default-routing-test", version: "0.1.0" });
    await client.connect(transport);

    try {
      const taskBrief = await client.callTool({ name: "task_brief", arguments: { task: "change alphaSymbol", tokenBudget: 900, limit: 5 } });
      const serialized = JSON.stringify(taskBrief);
      expect(taskBrief.isError).toBeUndefined();
      expect(serialized).toContain(defaultRepo);
      expect(serialized).toContain("alphaSymbol");
      expect(serialized).toContain('"focusReason":"workspace-default"');
      expect(serialized).not.toContain(activeRepo);
      expect(serialized).not.toContain("betaSymbol");
    } finally {
      await client.close();
    }
  });

it("fails closed when active project focus conflicts with workspace default", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "codexa-mcp-working-top-conflict-"));
    execFileSync("git", ["init"], { cwd: workspace, stdio: "ignore" });
    const defaultRepo = await createIndexedMcpRepo(workspace, "default-repo", "alpha", "alphaSymbol");
    const focusedRepo = await createIndexedMcpRepo(workspace, "focused-repo", "beta", "betaSymbol");
    const focusFile = path.join(workspace, ".codex", "WORKING.md");
    await mkdir(path.dirname(focusFile), { recursive: true });
    await writeFile(
      focusFile,
      [
        "## Workspace Default",
        "",
        `- Default repo: \`${defaultRepo}\`.`,
        `- Active project focus: Codexa project via repo \`${focusedRepo}\`.`
      ].join("\n"),
      "utf8"
    );

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(process.cwd(), "dist/cli.js"), "serve", workspace],
      stderr: "pipe"
    });
    const client = new Client({ name: "codexa-working-top-conflict-test", version: "0.1.0" });
    await client.connect(transport);

    try {
      const taskBrief = await client.callTool({ name: "task_brief", arguments: { task: "change alphaSymbol", tokenBudget: 900, limit: 5 } });
      const serialized = JSON.stringify(taskBrief);
      expect(taskBrief.isError).toBe(true);
      expect(serialized).toContain("Codexa MCP workspace focus is ambiguous");
      expect(serialized).toContain(defaultRepo);
      expect(serialized).toContain(focusedRepo);
      expect(serialized).not.toContain("alphaSymbol");
      expect(serialized).not.toContain("betaSymbol");
    } finally {
      await client.close();
    }
  });

it("ignores terminal composite session statuses when checking workspace conflicts", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "codexa-mcp-working-merged-live-"));
    execFileSync("git", ["init"], { cwd: workspace, stdio: "ignore" });
    const defaultRepo = await createIndexedMcpRepo(workspace, "default-repo", "alpha", "alphaSymbol");
    const mergedRepo = await createIndexedMcpRepo(workspace, "merged-repo", "beta", "betaSymbol");
    const focusFile = path.join(workspace, ".codex", "WORKING.md");
    await mkdir(path.dirname(focusFile), { recursive: true });
    await writeFile(
      focusFile,
      [
        "## Workspace Default",
        "",
        `- Default repo: \`${defaultRepo}\`.`,
        "",
        "## Active Sessions",
        "",
        "| session | agent | repo | task | status | claims | last_seen | next |",
        "| --- | --- | --- | --- | --- | --- | --- | --- |",
        `| codex-merged | codex | ${mergedRepo} | previous task | merged-live | none | earlier | done |`
      ].join("\n"),
      "utf8"
    );

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(process.cwd(), "dist/cli.js"), "serve", workspace],
      stderr: "pipe"
    });
    const client = new Client({ name: "codexa-working-merged-live-test", version: "0.1.0" });
    await client.connect(transport);

    try {
      const taskBrief = await client.callTool({ name: "task_brief", arguments: { task: "change alphaSymbol", tokenBudget: 900, limit: 5 } });
      const serialized = JSON.stringify(taskBrief);
      expect(taskBrief.isError).not.toBe(true);
      expect(serialized).toContain(defaultRepo);
      expect(serialized).toContain("alphaSymbol");
      expect(serialized).not.toContain("betaSymbol");
    } finally {
      await client.close();
    }
  });

it("treats workspace-root default subdirectories as configured-root defaults", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "codexa-mcp-working-subdir-default-"));
    execFileSync("git", ["init"], { cwd: workspace, stdio: "ignore" });
    const workspaceDefaultSubdir = path.join(workspace, ".codex");
    await mkdir(workspaceDefaultSubdir, { recursive: true });
    const activeRepo = await createIndexedMcpRepo(workspace, "active-repo", "beta", "betaSymbol");
    const focusFile = path.join(workspace, ".codex", "WORKING.md");
    await writeFile(
      focusFile,
      [
        "## Workspace Default",
        "",
        `- Default repo: \`${workspaceDefaultSubdir}\`.`,
        "",
        "## Active Sessions",
        "",
        "| session | agent | repo | task | status | claims | last_seen | next |",
        "| --- | --- | --- | --- | --- | --- | --- | --- |",
        `| codex-current | codex | ${activeRepo} | route task | active | none | now | inspect |`
      ].join("\n"),
      "utf8"
    );

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(process.cwd(), "dist/cli.js"), "serve", workspace],
      stderr: "pipe"
    });
    const client = new Client({ name: "codexa-working-subdir-default-test", version: "0.1.0" });
    await client.connect(transport);

    try {
      const taskBrief = await client.callTool({ name: "task_brief", arguments: { task: "change betaSymbol", tokenBudget: 900, limit: 5 } });
      const serialized = JSON.stringify(taskBrief);
      expect(taskBrief.isError).not.toBe(true);
      expect(serialized).toContain(activeRepo);
      expect(serialized).toContain("betaSymbol");
      expect(serialized).not.toContain("Codexa MCP workspace focus is ambiguous");
    } finally {
      await client.close();
    }
  });

it("falls back to active session rows when workspace defaults are invalid", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "codexa-mcp-working-invalid-default-"));
    const outsideParent = await mkdtemp(path.join(os.tmpdir(), "codexa-mcp-outside-default-"));
    execFileSync("git", ["init"], { cwd: workspace, stdio: "ignore" });
    const outsideRepo = await createIndexedMcpRepo(outsideParent, "outside-repo", "outside", "outsideSymbol");
    const activeRepo = await createIndexedMcpRepo(workspace, "active-repo", "beta", "betaSymbol");
    const focusFile = path.join(workspace, ".codex", "WORKING.md");
    await mkdir(path.dirname(focusFile), { recursive: true });
    await writeFile(
      focusFile,
      [
        "## Workspace Default",
        "",
        `- Default repo: \`${path.join(workspace, "missing-repo")}\`.`,
        `- Default repo: \`${outsideRepo}\`.`,
        "",
        "## Active Sessions",
        "",
        "| session | agent | repo | task | status | claims | last_seen | next |",
        "| --- | --- | --- | --- | --- | --- | --- | --- |",
        `| codex-current | codex | ${activeRepo} | route task | active | none | now | inspect |`
      ].join("\n"),
      "utf8"
    );

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(process.cwd(), "dist/cli.js"), "serve", workspace],
      stderr: "pipe"
    });
    const client = new Client({ name: "codexa-working-invalid-default-routing-test", version: "0.1.0" });
    await client.connect(transport);

    try {
      const taskBrief = await client.callTool({ name: "task_brief", arguments: { task: "change betaSymbol", tokenBudget: 900, limit: 5 } });
      const serialized = JSON.stringify(taskBrief);
      expect(serialized).toContain(activeRepo);
      expect(serialized).toContain("betaSymbol");
      expect(serialized).not.toContain(outsideRepo);
      expect(serialized).not.toContain("outsideSymbol");
      expect(serialized).not.toContain("Failed to read git status");
    } finally {
      await client.close();
    }
  });

it("does not treat workspace-level active project focus prose as the focused repo", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "codexa-mcp-working-prose-focus-"));
    execFileSync("git", ["init"], { cwd: workspace, stdio: "ignore" });
    const activeRepo = await createIndexedMcpRepo(workspace, "active-repo", "beta", "betaSymbol");
    const focusFile = path.join(workspace, ".codex", "WORKING.md");
    await mkdir(path.dirname(focusFile), { recursive: true });
    await writeFile(
      focusFile,
      [
        "## Workspace Default",
        "",
        `- Default repo: \`${workspace}\`.`,
        `- Active project focus: workspace-level \`${workspace}\` helper/protocol maintenance.`,
        "",
        "## Active Sessions",
        "",
        "| session | agent | repo | task | status | claims | last_seen | next |",
        "| --- | --- | --- | --- | --- | --- | --- | --- |",
        `| codex-current | codex | ${activeRepo} | route task | active | none | now | inspect |`
      ].join("\n"),
      "utf8"
    );

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(process.cwd(), "dist/cli.js"), "serve", workspace],
      stderr: "pipe"
    });
    const client = new Client({ name: "codexa-working-prose-focus-routing-test", version: "0.1.0" });
    await client.connect(transport);

    try {
      const freshness = await client.callTool({ name: "freshness", arguments: {} });
      const serialized = JSON.stringify(freshness);
      expect(serialized).toContain(activeRepo);
      expect(serialized).not.toContain(`"repoRoot":"${workspace}"`);
      expect(serialized).not.toContain("Failed to read git status");
    } finally {
      await client.close();
    }
  });

it("keeps workspace-root defaults below ambiguous active-session rows", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "codexa-mcp-working-root-default-"));
    execFileSync("git", ["init"], { cwd: workspace, stdio: "ignore" });
    const firstRepo = await createIndexedMcpRepo(workspace, "first-repo", "alpha", "alphaSymbol");
    const secondRepo = await createIndexedMcpRepo(workspace, "second-repo", "beta", "betaSymbol");
    const focusFile = path.join(workspace, ".codex", "WORKING.md");
    await mkdir(path.dirname(focusFile), { recursive: true });
    await writeFile(
      focusFile,
      [
        "## Workspace Default",
        "",
        `- Default repo: \`${workspace}\`.`,
        "",
        "## Active Sessions",
        "",
        "| session | agent | repo | task | status | claims | last_seen | next |",
        "| --- | --- | --- | --- | --- | --- | --- | --- |",
        `| codex-first | codex | ${firstRepo} | first task | active | none | now | inspect |`,
        `| codex-second | codex | ${secondRepo} | second task | active | none | now | inspect |`
      ].join("\n"),
      "utf8"
    );

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(process.cwd(), "dist/cli.js"), "serve", workspace],
      stderr: "pipe"
    });
    const client = new Client({ name: "codexa-working-root-default-ambiguity-test", version: "0.1.0" });
    await client.connect(transport);

    try {
      const taskBrief = await client.callTool({ name: "task_brief", arguments: { task: "change alphaSymbol", tokenBudget: 900, limit: 5 } });
      const serialized = JSON.stringify(taskBrief);
      expect(taskBrief.isError).toBe(true);
      expect(serialized).toContain("Codexa MCP workspace focus is ambiguous");
      expect(serialized).toContain(firstRepo);
      expect(serialized).toContain(secondRepo);
    } finally {
      await client.close();
    }
  });

it("routes workspace default despite verified live session rows", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "codexa-mcp-working-verified-status-"));
    execFileSync("git", ["init"], { cwd: workspace, stdio: "ignore" });
    const defaultRepo = await createIndexedMcpRepo(workspace, "default-repo", "alpha", "alphaSymbol");
    const activeRepo = await createIndexedMcpRepo(workspace, "active-repo", "beta", "betaSymbol");
    const focusFile = path.join(workspace, ".codex", "WORKING.md");
    await mkdir(path.dirname(focusFile), { recursive: true });
    await writeFile(
      focusFile,
      [
        "## Workspace Default",
        "",
        `- Default repo: \`${defaultRepo}\`.`,
        "",
        "## Active Sessions",
        "",
        "| session | agent | repo | task | status | claims | last_seen | next |",
        "| --- | --- | --- | --- | --- | --- | --- | --- |",
        `| codex-current | codex | ${activeRepo} | verified task | verified | none | now | inspect |`
      ].join("\n"),
      "utf8"
    );

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(process.cwd(), "dist/cli.js"), "serve", workspace],
      stderr: "pipe"
    });
    const client = new Client({ name: "codexa-working-verified-status-test", version: "0.1.0" });
    await client.connect(transport);

    try {
      const freshness = await client.callTool({ name: "freshness", arguments: {} });
      const serialized = JSON.stringify(freshness);
      expect(freshness.isError).toBeUndefined();
      expect(serialized).toContain(defaultRepo);
      expect(serialized).toContain('"focusReason":"workspace-default"');
      expect(serialized).not.toContain(activeRepo);
    } finally {
      await client.close();
    }
  });

it("fails closed when active-session rows are ambiguous without a workspace session selector", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "codexa-mcp-working-ambiguous-active-"));
    execFileSync("git", ["init"], { cwd: workspace, stdio: "ignore" });
    const defaultRepo = await createIndexedMcpRepo(workspace, "default-repo", "alpha", "alphaSymbol");
    const otherRepo = await createIndexedMcpRepo(workspace, "other-repo", "beta", "betaSymbol");
    const focusFile = path.join(workspace, ".codex", "WORKING.md");
    await mkdir(path.dirname(focusFile), { recursive: true });
    await writeFile(
      focusFile,
      [
        "## Workspace Default",
        "",
        "## Active Sessions",
        "",
        "| session | agent | repo | task | status | claims | last_seen | next |",
        "| --- | --- | --- | --- | --- | --- | --- | --- |",
        `| codex-default | codex | ${defaultRepo} | workspace default task | active | none | now | inspect |`,
        `| codex-other | codex | ${otherRepo} | concurrent repo task | active | none | now | inspect |`
      ].join("\n"),
      "utf8"
    );

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(process.cwd(), "dist/cli.js"), "serve", workspace],
      stderr: "pipe"
    });
    const client = new Client({ name: "codexa-working-ambiguous-active-test", version: "0.1.0" });
    await client.connect(transport);

    try {
      const taskBrief = await client.callTool({ name: "task_brief", arguments: { task: "change alphaSymbol", tokenBudget: 900, limit: 5 } });
      expect(taskBrief.isError).toBe(true);
      expect(JSON.stringify(taskBrief)).toContain("Codexa MCP workspace focus is ambiguous");
    } finally {
      await client.close();
    }
  });

it("routes ambiguous workspace active rows through an explicit workspace session", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "codexa-mcp-working-session-"));
    execFileSync("git", ["init"], { cwd: workspace, stdio: "ignore" });
    const defaultRepo = await createIndexedMcpRepo(workspace, "default-repo", "alpha", "alphaSymbol");
    const selectedRepo = await createIndexedMcpRepo(workspace, "selected-repo", "beta", "betaSymbol");
    const nextSelectedRepo = await createIndexedMcpRepo(workspace, "next-selected-repo", "gamma", "gammaSymbol");
    const otherRepo = await createIndexedMcpRepo(workspace, "other-repo", "delta", "deltaSymbol");
    const focusFile = path.join(workspace, ".codex", "WORKING.md");
    await mkdir(path.dirname(focusFile), { recursive: true });
    const writeFocusFile = async (selected: string) =>
      writeFile(
        focusFile,
        [
          "## Workspace Default",
          "",
          `- Default repo: \`${defaultRepo}\`.`,
          "",
          "## Active Sessions",
          "",
          "| session | agent | repo | task | status | claims | last_seen | next |",
          "| --- | --- | --- | --- | --- | --- | --- | --- |",
          `| codex-target | codex | ${selected} | target task | active | none | now | inspect |`,
          `| codex-other | codex | ${otherRepo} | concurrent repo task | active | none | now | inspect |`
        ].join("\n"),
        "utf8"
      );
    await writeFocusFile(selectedRepo);

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(process.cwd(), "dist/cli.js"), "serve", workspace, "--workspace-session", "codex-target"],
      stderr: "pipe"
    });
    const client = new Client({ name: "codexa-working-selected-session-test", version: "0.1.0" });
    await client.connect(transport);

    try {
      const firstBrief = await client.callTool({ name: "task_brief", arguments: { task: "change betaSymbol", tokenBudget: 900, limit: 5 } });
      const firstSerialized = JSON.stringify(firstBrief);
      expect(firstSerialized).toContain(selectedRepo);
      expect(firstSerialized).toContain("betaSymbol");
      expect(firstSerialized).toContain('"routingSource":"workspace-focus-file"');
      expect(firstSerialized).toContain('"focusReason":"selected-session"');
      expect(firstSerialized).toContain('"workspaceSessionId":"codex-target"');
      expect(firstSerialized).not.toContain('"configuredRoot"');
      expect(firstSerialized).not.toContain('"focusFile":');
      expect(firstSerialized).not.toContain(defaultRepo);
      expect(firstSerialized).not.toContain(otherRepo);

      await writeFocusFile(nextSelectedRepo);

      const secondBrief = await client.callTool({ name: "task_brief", arguments: { task: "change gammaSymbol", tokenBudget: 900, limit: 5 } });
      const secondSerialized = JSON.stringify(secondBrief);
      expect(secondSerialized).toContain(nextSelectedRepo);
      expect(secondSerialized).toContain("gammaSymbol");
      expect(secondSerialized).not.toContain(selectedRepo);
      expect(secondSerialized).not.toContain(defaultRepo);
      expect(secondSerialized).not.toContain("Failed to read git status");
    } finally {
      await client.close();
    }
  });

it("fails closed when a workspace session selector has no active row", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "codexa-mcp-missing-session-row-"));
    execFileSync("git", ["init"], { cwd: workspace, stdio: "ignore" });
    const sharedRepo = await createIndexedMcpRepo(workspace, "shared-repo", "shared", "sharedSymbol");
    const focusFile = path.join(workspace, ".codex", "WORKING.md");
    await mkdir(path.dirname(focusFile), { recursive: true });
    await writeFile(
      focusFile,
      [
        "## Workspace Default",
        "",
        `- Default repo: \`${sharedRepo}\`.`,
        `- Active project focus: Codexa project via repo \`${sharedRepo}\`.`
      ].join("\n"),
      "utf8"
    );

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(process.cwd(), "dist/cli.js"), "serve", workspace],
      env: { PATH: process.env.PATH ?? "", CODEXA_WORKSPACE_SESSION: "codex-missing-session" },
      stderr: "pipe"
    });
    const client = new Client({ name: "codexa-missing-session-row-test", version: "0.1.0" });
    await client.connect(transport);

    try {
      const taskBrief = await client.callTool({ name: "task_brief", arguments: { task: "change sharedSymbol", tokenBudget: 900, limit: 5 } });
      const serialized = JSON.stringify(taskBrief);
      expect(taskBrief.isError).toBe(true);
      expect(serialized).toContain("workspace session codex-missing-session is not active");
      expect(serialized).toContain(focusFile);
      expect(serialized).not.toContain("sharedSymbol");
    } finally {
      await client.close();
    }
  });

it("routes a shared workspace WORKING.md shape through an explicit current Codex session", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "codexa-mcp-srv-working-shape-"));
    execFileSync("git", ["init"], { cwd: workspace, stdio: "ignore" });
    const oldRepo = await createIndexedMcpRepo(workspace, "old-repo", "old", "oldSymbol");
    const currentRepo = await createIndexedMcpRepo(workspace, "current-repo", "current", "currentSymbol");
    const focusFile = path.join(workspace, ".codex", "WORKING.md");
    await mkdir(path.dirname(focusFile), { recursive: true });
    await writeFile(
      focusFile,
      [
        "# WORKING.md - Current Workspace State",
        "",
        "## Workspace Default",
        "",
        `- Default repo: \`${workspace}\`.`,
        "- Active project focus: shared workspace interface via the workspace root.",
        "",
        "## Active Sessions",
        "",
        "| session | agent | repo | task | status | claims | last_seen | next |",
        "| --- | --- | --- | --- | --- | --- | --- | --- |",
        `| codex-old-session | codex | ${oldRepo} | previous task | done | none | earlier | wait |`,
        `| codex-current-session | codex | ${currentRepo} | current task | active | none | now | implement |`
      ].join("\n"),
      "utf8"
    );

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(process.cwd(), "dist/cli.js"), "serve", workspace, "--workspace-session", "codex-current-session"],
      stderr: "pipe"
    });
    const client = new Client({ name: "codexa-srv-working-shape-routing-test", version: "0.1.0" });
    await client.connect(transport);

    try {
      const taskBrief = await client.callTool({ name: "task_brief", arguments: { task: "change currentSymbol", tokenBudget: 900, limit: 5 } });
      const serialized = JSON.stringify(taskBrief);
      expect(serialized).toContain(currentRepo);
      expect(serialized).toContain("currentSymbol");
      expect(serialized).not.toContain(oldRepo);
      expect(serialized).not.toContain("Failed to read git status");
    } finally {
      await client.close();
    }
  });

it("routes configured workspace roots through workspace default despite other active sessions", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "codexa-mcp-configured-workspace-default-"));
    execFileSync("git", ["init"], { cwd: workspace, stdio: "ignore" });
    const defaultRepo = await createIndexedMcpRepo(workspace, "default-repo", "default", "defaultSymbol");
    const otherRepo = await createIndexedMcpRepo(workspace, "other-repo", "other", "otherSymbol");
    const focusFile = path.join(workspace, ".codex", "WORKING.md");
    await mkdir(path.dirname(focusFile), { recursive: true });
    await writeFile(
      focusFile,
      [
        "# WORKING.md - Current Workspace State",
        "",
        "## Workspace Default",
        "",
        `- Default repo: \`${defaultRepo}\`.`,
        "",
        "## Active Sessions",
        "",
        "| session | agent | repo | task | status | claims | last_seen | next |",
        "| --- | --- | --- | --- | --- | --- | --- | --- |",
        `| codex-other-session | codex | ${otherRepo} | other task | active | none | now | inspect |`
      ].join("\n"),
      "utf8"
    );

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(process.cwd(), "dist/cli.js"), "serve", workspace],
      stderr: "pipe"
    });
    const client = new Client({ name: "codexa-configured-workspace-default-routing-test", version: "0.1.0" });
    await client.connect(transport);

    try {
      const taskBrief = await client.callTool({ name: "task_brief", arguments: { task: "change defaultSymbol", tokenBudget: 900, limit: 5 } });
      const serialized = JSON.stringify(taskBrief);
      expect(serialized).toContain(defaultRepo);
      expect(serialized).toContain("defaultSymbol");
      expect(serialized).toContain('"focusReason":"workspace-default"');
      expect(serialized).not.toContain(otherRepo);
      expect(serialized).not.toContain("otherSymbol");
      expect(serialized).not.toContain("Failed to read git status");
    } finally {
      await client.close();
    }
  });

it("routes configured workspace roots through the active project focus line when it has no live-row conflict", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "codexa-mcp-configured-workspace-focus-"));
    execFileSync("git", ["init"], { cwd: workspace, stdio: "ignore" });
    const currentRepo = await createIndexedMcpRepo(workspace, "current-repo", "current", "currentSymbol");
    const focusFile = path.join(workspace, ".codex", "WORKING.md");
    await mkdir(path.dirname(focusFile), { recursive: true });
    await writeFile(path.join(workspace, ".codex", "config.toml"), "[features]\nhooks = true\n", "utf8");
    await writeFile(
      focusFile,
      [
        "# WORKING.md - Current Workspace State",
        "",
        "## Workspace Default",
        "",
        `- Default repo: \`${workspace}\`.`,
        `- Active project focus: Codexa project via repo \`${currentRepo}\`.`,
        "",
        "## Active Sessions",
        "",
        "| session | agent | repo | task | status | claims | last_seen | next |",
        "| --- | --- | --- | --- | --- | --- | --- | --- |",
        `| codex-current-session | codex | ${currentRepo} | current task | active | none | now | implement |`
      ].join("\n"),
      "utf8"
    );

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(process.cwd(), "dist/cli.js"), "serve", workspace],
      stderr: "pipe"
    });
    const client = new Client({ name: "codexa-configured-workspace-focus-routing-test", version: "0.1.0" });
    await client.connect(transport);

    try {
      const taskBrief = await client.callTool({ name: "task_brief", arguments: { task: "change currentSymbol", tokenBudget: 900, limit: 5 } });
      const serialized = JSON.stringify(taskBrief);
      expect(serialized).toContain(currentRepo);
      expect(serialized).toContain("currentSymbol");
      expect(serialized).not.toContain("Failed to read git status");
    } finally {
      await client.close();
    }
  });

it("fails closed when active project focus conflicts with another active session", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "codexa-mcp-configured-workspace-conflict-"));
    execFileSync("git", ["init"], { cwd: workspace, stdio: "ignore" });
    const currentRepo = await createIndexedMcpRepo(workspace, "current-repo", "current", "currentSymbol");
    const otherRepo = await createIndexedMcpRepo(workspace, "other-repo", "other", "otherSymbol");
    const focusFile = path.join(workspace, ".codex", "WORKING.md");
    await mkdir(path.dirname(focusFile), { recursive: true });
    await writeFile(path.join(workspace, ".codex", "config.toml"), "[features]\nhooks = true\n", "utf8");
    await writeFile(
      focusFile,
      [
        "# WORKING.md - Current Workspace State",
        "",
        "## Workspace Default",
        "",
        `- Default repo: \`${workspace}\`.`,
        `- Active project focus: Codexa project via repo \`${currentRepo}\`.`,
        "",
        "## Active Sessions",
        "",
        "| session | agent | repo | task | status | claims | last_seen | next |",
        "| --- | --- | --- | --- | --- | --- | --- | --- |",
        `| codex-current-session | codex | ${currentRepo} | current task | active | none | now | implement |`,
        `| codex-other-session | codex | ${otherRepo} | other task | active | none | now | inspect |`
      ].join("\n"),
      "utf8"
    );

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(process.cwd(), "dist/cli.js"), "serve", workspace],
      stderr: "pipe"
    });
    const client = new Client({ name: "codexa-configured-workspace-conflict-test", version: "0.1.0" });
    await client.connect(transport);

    try {
      const taskBrief = await client.callTool({ name: "task_brief", arguments: { task: "change currentSymbol", tokenBudget: 900, limit: 5 } });
      const serialized = JSON.stringify(taskBrief);
      expect(taskBrief.isError).toBe(true);
      expect(serialized).toContain("Codexa MCP workspace focus is ambiguous");
      expect(serialized).toContain(currentRepo);
      expect(serialized).toContain(otherRepo);
      expect(serialized).not.toContain("currentSymbol");
      expect(serialized).not.toContain("otherSymbol");
    } finally {
      await client.close();
    }
  });
});
