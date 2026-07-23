import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, mkdir, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ResourceListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { buildIndex } from "../src/indexer.js";
import { MCP_TOOL_CATALOG, PRIMARY_CODEX_LOOP, compactNonPostEditMcpResult, compactPostEditMcpResult } from "../src/mcp.js";
import { conciseText } from "../src/mcp/compaction.js";
import { toToolResult } from "../src/mcp/envelope.js";
import { CORE_PROFILE_TOOL_NAMES, DISPATCHABLE_MCP_TOOL_NAMES, MCP_TOOL_NAMES, MCP_TOOL_REGISTRY } from "../src/mcp/tool-registry.js";
import { MCP_REGISTERED_TOOL_NAMES } from "../src/mcp/tools.js";
import { loadSkillHints } from "../src/skill-hints.js";
import { CURRENT_VERIFICATION_PROVENANCE } from "../src/types.js";
import { CODEXA_VERSION } from "../src/version.js";
import { freshnessFixture, seq, serializedBytes, waitForStderr, stopChild, waitForExit, createIndexedMcpRepo, createIndexedMcpAutoVerifyRepo, buildContextPacket, buildFocusBriefPacket, buildTestPlanPacket, buildChangePlanPacket } from "./mcp-fixtures.js";
describe("Codexa MCP server", () => {
it("keeps lifecycle envelope fallbacks adaptive and honors explicit terminal guidance", () => {
    const options = { autoRefresh: false, sessionMemoryMode: "off" };
    const changePlan = toToolResult(
      { text: "plan", freshness: freshnessFixture(), data: { mode: "change_plan" } },
      "change_plan",
      options
    ).structuredContent as { lifecycle: { preconditions: string[]; nextTools: string[] } };
    expect(changePlan.lifecycle.preconditions.join(" ")).toContain("explicit bounded target");
    expect(changePlan.lifecycle.nextTools).toEqual([]);

    const completedReview = toToolResult(
      { text: "review complete", freshness: freshnessFixture(), data: { mode: "post_edit_review", verdict: "continue", nextTools: [] } },
      "post_edit_review",
      options
    ).structuredContent as { lifecycle: { nextTools: string[] }; nextTools?: unknown[] };
    expect(completedReview.lifecycle.nextTools).toEqual([]);
    expect(completedReview.nextTools).toEqual([]);

    const replanReview = toToolResult(
      { text: "replan", freshness: freshnessFixture(), data: { mode: "post_edit_review", verdict: "replan", nextTools: [{ tool: "change_plan" }] } },
      "post_edit_review",
      options
    ).structuredContent as { lifecycle: { nextTools: string[] } };
    expect(replanReview.lifecycle.nextTools).toEqual(["change_plan"]);

    const proof = toToolResult(
      { text: "proof gaps", freshness: freshnessFixture(), data: { mode: "proof_card", verification: { reported: { hasEvidence: false } } } },
      "proof_card",
      options
    ).structuredContent as { lifecycle: { preconditions: string[]; nextTools: string[] } };
    expect(proof.lifecycle.preconditions.join(" ")).toContain("formal audit");
    expect(proof.lifecycle.nextTools).toEqual([]);
  });

it("keeps the core MCP surface selective while preserving every logical operation", () => {
    const primaryTools = MCP_TOOL_CATALOG.filter((tool) => tool.tier === "primary").map((tool) => tool.name);

    expect(primaryTools).toEqual(["session_context", "search", "task_brief", "change_plan", "post_edit_review", "test_plan", "proof_card", "capabilities"]);
    expect(CORE_PROFILE_TOOL_NAMES).toEqual(["search", "change_plan", "capabilities"]);
    expect(MCP_TOOL_NAMES).toHaveLength(23);
    expect(DISPATCHABLE_MCP_TOOL_NAMES).toEqual(MCP_TOOL_NAMES.filter((name) => !CORE_PROFILE_TOOL_NAMES.includes(name as (typeof CORE_PROFILE_TOOL_NAMES)[number])));
    expect(DISPATCHABLE_MCP_TOOL_NAMES).toEqual(expect.arrayContaining(["session_context", "task_brief", "post_edit_review", "workflow_path"]));
    expect(PRIMARY_CODEX_LOOP).toContain("source tools with zero Codexa calls");
    expect(PRIMARY_CODEX_LOOP).toContain("post_edit_review only when no deterministic host gate owns review");
    expect(MCP_TOOL_CATALOG.find((tool) => tool.name === "workflow_path")).toMatchObject({ tier: "advanced" });
    expect(MCP_TOOL_CATALOG.find((tool) => tool.name === "change_plan")).toMatchObject({
      useWhen: expect.stringContaining("saveSnapshot=true"),
      avoidWhen: expect.stringContaining("exact, local, low-risk edit")
    });
    expect(MCP_TOOL_CATALOG.find((tool) => tool.name === "search")).toMatchObject({
      readOnly: false,
      writeEffects: expect.stringContaining("index-cache-if-auto-refresh"),
      useWhen: expect.stringContaining("target is ambiguous")
    });
    expect(MCP_TOOL_CATALOG.find((tool) => tool.name === "post_edit_review")?.nextToolUse).toEqual([]);
    expect(MCP_TOOL_CATALOG.find((tool) => tool.name === "capabilities")?.nextToolUse).toEqual([]);
    expect(MCP_TOOL_CATALOG.map((tool) => tool.name)).toEqual(MCP_TOOL_NAMES);
    expect(MCP_REGISTERED_TOOL_NAMES).toEqual(MCP_TOOL_NAMES);
    expect(MCP_TOOL_REGISTRY.map((tool) => ({ name: tool.name, title: tool.title, description: tool.description }))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "change_plan", title: "Codexa change plan", description: expect.stringContaining("Plan a non-trivial code change") }),
        expect.objectContaining({ name: "search", title: "Codexa hybrid semantic search", description: expect.stringContaining("Search the codebase") }),
        expect.objectContaining({ name: "post_edit_review", title: "Codexa post-edit review", description: expect.stringContaining("Review code changes for drift") }),
        expect.objectContaining({ name: "proof_card", title: "Codexa proof card", description: expect.stringContaining("Final proof packet") }),
        expect.objectContaining({ name: "capabilities", title: "Codexa capability dispatcher", description: expect.stringContaining("full logical capability set") })
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
      args: [path.join(process.cwd(), "dist/cli.js"), "serve", workspace, "--tools", "full"],
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

it("routes a focus row written AFTER server spawn (no frozen configured-root preference)", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "codexa-mcp-late-focus-"));
    execFileSync("git", ["init"], { cwd: workspace, stdio: "ignore" });
    await mkdir(path.join(workspace, "src"), { recursive: true });
    await writeFile(path.join(workspace, "src/workspace.ts"), "export function workspaceRootSymbol() { return 1 }\n", "utf8");
    execFileSync("git", ["add", "-A"], { cwd: workspace, stdio: "ignore" });
    execFileSync("git", ["-c", "user.name=Codexa", "-c", "user.email=codexa@example.invalid", "commit", "-m", "fixture"], { cwd: workspace, stdio: "ignore" });
    await buildIndex({ repoRoot: workspace, writeArtifacts: true });
    const repoA = await createIndexedMcpRepo(workspace, "repo-a", "alpha", "alphaSymbol");

    // No focus file exists at spawn time: the server starts pinned to the
    // configured workspace root.
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(process.cwd(), "dist/cli.js"), "serve", workspace, "--tools", "full"],
      stderr: "pipe"
    });
    const client = new Client({ name: "codexa-late-focus-test", version: "0.1.0" });
    await client.connect(transport);
    let resourceListChanges = 0;
    client.setNotificationHandler(ResourceListChangedNotificationSchema, () => {
      resourceListChanges += 1;
    });

    try {
      const first = await client.callTool({ name: "freshness", arguments: {} });
      expect(JSON.stringify(first)).toContain('"routingSource":"configured-root"');

      const focusFile = path.join(workspace, ".codex", "WORKING.md");
      await mkdir(path.dirname(focusFile), { recursive: true });
      await writeFile(focusFile, `## Session\n\n- Focused project: \`${repoA}\`.\n`, "utf8");

      const second = await client.callTool({ name: "freshness", arguments: {} });
      expect(JSON.stringify(second)).toContain(repoA);
      expect(JSON.stringify(second)).toContain('"routingSource":"workspace-focus-file"');
      expect(resourceListChanges).toBe(1);
    } finally {
      await client.close();
    }
  });

it("fails closed when explicit workspace routing matches no focus row", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "codexa-mcp-focus-miss-"));
    execFileSync("git", ["init"], { cwd: workspace, stdio: "ignore" });
    await mkdir(path.join(workspace, "src"), { recursive: true });
    await writeFile(path.join(workspace, "src/workspace.ts"), "export function workspaceRootSymbol() { return 1 }\n", "utf8");
    const focusFile = path.join(workspace, ".codex", "WORKING.md");
    await mkdir(path.dirname(focusFile), { recursive: true });
    await writeFile(focusFile, "## Session\n\nno focus rows here\n", "utf8");
    execFileSync("git", ["add", "-A"], { cwd: workspace, stdio: "ignore" });
    execFileSync("git", ["-c", "user.name=Codexa", "-c", "user.email=codexa@example.invalid", "commit", "-m", "fixture"], { cwd: workspace, stdio: "ignore" });
    await buildIndex({ repoRoot: workspace, writeArtifacts: true });

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(process.cwd(), "dist/cli.js"), "serve", workspace, "--workspace-focus-file", focusFile, "--tools", "full"],
      stderr: "pipe"
    });
    const client = new Client({ name: "codexa-focus-miss-test", version: "0.1.0" });
    await client.connect(transport);

    try {
      const result = await client.callTool({ name: "freshness", arguments: {} });
      const serialized = JSON.stringify(result);
      expect(result.isError).toBe(true);
      expect(serialized).toContain("no focus row matched");
      expect(serialized).toContain("refusing to serve the configured root");
      expect(serialized).not.toContain("workspaceRootSymbol");
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
      args: [path.join(process.cwd(), "dist/cli.js"), "serve", workspace, "--tools", "full"],
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
      args: [path.join(process.cwd(), "dist/cli.js"), "serve", workspace, "--tools", "full"],
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

it("exposes configured skill hints and surfaces path-matched skills in task briefs", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "codexa-mcp-skill-hints-"));
    execFileSync("git", ["init"], { cwd: workspace, stdio: "ignore" });
    const repo = await createIndexedMcpRepo(workspace, "repo", "alpha", "alphaSymbol");
    const skillDir = path.join(repo, ".claude/skills/site-hardening");
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      path.join(skillDir, "SKILL.md"),
      ["---", "name: site-hardening", "description: Harden web trust boundaries.", "---", "", "# Site Hardening", ""].join("\n"),
      "utf8"
    );
    const outsideSkillRoot = path.join(workspace, "..", `${path.basename(workspace)}-outside-skills`);
    await mkdir(path.join(outsideSkillRoot, "evil-skill"), { recursive: true });
    await writeFile(
      path.join(outsideSkillRoot, "evil-skill", "SKILL.md"),
      ["---", "name: evil-skill", "description: Should not be scanned.", "---", "", "# Evil", ""].join("\n"),
      "utf8"
    );
    await symlink(outsideSkillRoot, path.join(repo, ".claude/linked-skills"), "dir");
    await writeFile(
      path.join(repo, ".codex/skill-hints.json"),
      JSON.stringify(
        {
          schemaVersion: 1,
          skillRoots: ["<repo>/.claude/skills", "<repo>/.claude/linked-skills", outsideSkillRoot],
          hints: [{ glob: "src/**/*.ts", skills: ["site-hardening", "evil-skill", "missing-skill"] }]
        },
        null,
        2
      ),
      "utf8"
    );
    await buildIndex({ repoRoot: repo, writeArtifacts: true });

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(process.cwd(), "dist/cli.js"), "serve", repo, "--no-auto-refresh", "--tools", "full"],
      stderr: "pipe"
    });
    const client = new Client({ name: "codexa-skill-hints-test", version: "0.1.0" });
    await client.connect(transport);

    try {
      const resources = await client.listResources();
      expect(resources.resources.map((resource) => resource.uri)).toContain("codexa://repo/codebase/skill-hints.md");
      const skillResource = await client.readResource({ uri: "codexa://repo/codebase/skill-hints.md" });
      const skillText = String(skillResource.contents?.[0]?.text);
      expect(skillText).toContain("<repo>/.claude/skills");
      expect(skillText).toContain("site-hardening - Harden web trust boundaries.");
      expect(skillText).not.toContain("Should not be scanned.");
      expect(skillText).toContain("ignored skill root outside allowed skill roots");
      expect(skillText).toContain("ignored skill hint for unscanned skill: evil-skill");
      expect(skillText).toContain("ignored skill hint for unscanned skill: missing-skill");
      expect(skillText).not.toContain("evil-skill/SKILL.md");
      expect(skillText).not.toContain(workspace);
      expect(skillText).not.toContain(outsideSkillRoot);

      const taskBrief = await client.callTool({ name: "task_brief", arguments: { files: ["src/alpha.ts"], task: "harden alpha", tokenBudget: 1400, limit: 5 } });
      const rendered = JSON.stringify(taskBrief.content);
      expect(rendered).toContain("Skill and playbook hints");
      expect(rendered).toContain("site-hardening");
      expect(rendered).not.toContain("skill evil-skill");
      expect(rendered).not.toContain("skill missing-skill");
      expect(rendered).toContain("codexa://repo/codebase/playbooks/");
      const data = taskBrief.structuredContent as {
        data?: {
          skillHints?: {
            roots?: string[];
            applicableSkills?: Array<{ name?: string; matchedGlob?: string; matchedPath?: string; skillPath?: string }>;
            targetPlaybooks?: Array<{ uri?: string }>;
            warnings?: string[];
          };
        };
      };
      expect(data.data?.skillHints?.roots).toEqual(["<repo>/.claude/skills"]);
      expect(data.data?.skillHints?.applicableSkills?.map((skill) => skill.name)).toEqual(["site-hardening"]);
      expect(data.data?.skillHints?.applicableSkills?.[0]).toMatchObject({ name: "site-hardening", matchedGlob: "src/**/*.ts", matchedPath: "src/alpha.ts" });
      expect(data.data?.skillHints?.applicableSkills?.[0]?.skillPath).toBe("<repo>/.claude/skills/site-hardening/SKILL.md");
      expect(data.data?.skillHints?.targetPlaybooks?.[0]?.uri).toContain("codexa://repo/codebase/playbooks/");
      expect(data.data?.skillHints?.warnings?.join("\n")).toContain("ignored skill hint for unscanned skill: evil-skill");
    } finally {
      await client.close();
    }
  });

it("contains malformed skill hint configs without throwing", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "codexa-mcp-skill-hints-malformed-"));
    execFileSync("git", ["init"], { cwd: workspace, stdio: "ignore" });
    const repo = await createIndexedMcpRepo(workspace, "repo", "alpha", "alphaSymbol");
    await writeFile(
      path.join(repo, ".codex/skill-hints.json"),
      JSON.stringify(
        {
          schemaVersion: 1,
          skillRoots: "<repo>/.claude/skills",
          hints: [{ glob: "src/**", skills: "site-hardening" }, null, { globs: "src/**", skills: ["site-hardening"] }]
        },
        null,
        2
      ),
      "utf8"
    );

    const summary = await loadSkillHints(repo);

    expect(summary.configured).toBe(true);
    expect(summary.roots).toEqual([]);
    expect(summary.hints).toEqual([]);
    expect(summary.warnings.join("\n")).toContain("ignored skillRoots because it is not an array");
    expect(summary.warnings.join("\n")).toContain("ignored hint.skills because it is not an array");
    expect(summary.warnings.join("\n")).toContain("ignored skill hint that is not an object");
    expect(summary.warnings.join("\n")).toContain("ignored hint.globs because it is not an array");
  });

it("reports invalid skill hint config through MCP output", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "codexa-mcp-skill-hints-invalid-"));
    execFileSync("git", ["init"], { cwd: workspace, stdio: "ignore" });
    const repo = await createIndexedMcpRepo(workspace, "repo", "alpha", "alphaSymbol");
    await writeFile(path.join(repo, ".codex/skill-hints.json"), "{not json", "utf8");

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(process.cwd(), "dist/cli.js"), "serve", repo, "--no-auto-refresh", "--tools", "full"],
      stderr: "pipe"
    });
    const client = new Client({ name: "codexa-skill-hints-invalid-test", version: "0.1.0" });
    await client.connect(transport);

    try {
      const skillResource = await client.readResource({ uri: "codexa://repo/codebase/skill-hints.md" });
      const skillText = String(skillResource.contents?.[0]?.text);
      expect(skillText).toContain(".codex/skill-hints.json is present but could not be used.");
      expect(skillText).toContain(".codex/skill-hints.json is not valid JSON");

      const taskBrief = await client.callTool({ name: "task_brief", arguments: { files: ["src/alpha.ts"], task: "harden alpha", tokenBudget: 1400, limit: 5 } });
      const data = taskBrief.structuredContent as { data?: { skillHints?: { configured?: boolean; warnings?: string[] } } };
      expect(data.data?.skillHints?.configured).toBe(false);
      expect(data.data?.skillHints?.warnings?.join("\n")).toContain(".codex/skill-hints.json is not valid JSON");
    } finally {
      await client.close();
    }
  });

it("does not scan user-global skill roots from repo-controlled skill hint config", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "codexa-mcp-skill-hints-global-"));
    execFileSync("git", ["init"], { cwd: workspace, stdio: "ignore" });
    const repo = await createIndexedMcpRepo(workspace, "repo", "alpha", "alphaSymbol");
    await writeFile(
      path.join(repo, ".codex/skill-hints.json"),
      JSON.stringify({ schemaVersion: 1, skillRoots: ["~/.codex/skills"], hints: [{ glob: "src/**", skills: ["private-skill"] }] }, null, 2),
      "utf8"
    );

    const summary = await loadSkillHints(repo);

    expect(summary.roots).toEqual([]);
    expect(summary.scannedSkills).toEqual([]);
    expect(summary.warnings.join("\n")).toContain("ignored skill root outside allowed skill roots: ~/.codex/skills");
  });

it("ignores only exact verified-delivery session statuses when checking workspace conflicts", async () => {
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
        `| codex-merged | codex | ${mergedRepo} | previous task | merged-live-verified | none | earlier | done |`
      ].join("\n"),
      "utf8"
    );

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(process.cwd(), "dist/cli.js"), "serve", workspace, "--tools", "full"],
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
      args: [path.join(process.cwd(), "dist/cli.js"), "serve", workspace, "--tools", "full"],
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
      args: [path.join(process.cwd(), "dist/cli.js"), "serve", workspace, "--tools", "full"],
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
      args: [path.join(process.cwd(), "dist/cli.js"), "serve", workspace, "--tools", "full"],
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
      args: [path.join(process.cwd(), "dist/cli.js"), "serve", workspace, "--tools", "full"],
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
      args: [path.join(process.cwd(), "dist/cli.js"), "serve", workspace, "--tools", "full"],
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
      args: [path.join(process.cwd(), "dist/cli.js"), "serve", workspace, "--tools", "full"],
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
      args: [path.join(process.cwd(), "dist/cli.js"), "serve", workspace, "--workspace-session", "codex-target", "--tools", "full"],
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
      args: [path.join(process.cwd(), "dist/cli.js"), "serve", workspace, "--tools", "full"],
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
      args: [path.join(process.cwd(), "dist/cli.js"), "serve", workspace, "--workspace-session", "codex-current-session", "--tools", "full"],
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
      args: [path.join(process.cwd(), "dist/cli.js"), "serve", workspace, "--tools", "full"],
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
      args: [path.join(process.cwd(), "dist/cli.js"), "serve", workspace, "--tools", "full"],
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
      args: [path.join(process.cwd(), "dist/cli.js"), "serve", workspace, "--tools", "full"],
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
