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
it("does not let stale CODEXA_REPO override an explicit git repo argument", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "codexa-mcp-explicit-"));
    const explicitRepo = await createIndexedMcpRepo(workspace, "explicit-repo", "explicit", "explicitSymbol");
    const staleEnvRepo = await createIndexedMcpRepo(workspace, "stale-env-repo", "stale", "staleSymbol");

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(process.cwd(), "dist/cli.js"), "serve", explicitRepo],
      env: { CODEXA_REPO: staleEnvRepo },
      stderr: "pipe"
    });
    const client = new Client({ name: "codexa-explicit-routing-test", version: "0.1.0" });
    await client.connect(transport);

    try {
      const freshness = await client.callTool({ name: "freshness", arguments: {} });
      expect(JSON.stringify(freshness)).toContain(explicitRepo);
      expect(JSON.stringify(freshness)).not.toContain(staleEnvRepo);

      const repoMap = await client.callTool({ name: "repo_map", arguments: { limit: 5 } });
      expect(JSON.stringify(repoMap)).toContain("src/explicit.ts");
      expect(JSON.stringify(repoMap)).not.toContain("src/stale.ts");
    } finally {
      await client.close();
    }
  });

it("does not let stale workspace focus env override an explicit wired MCP repo", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "codexa-mcp-explicit-focus-env-"));
    const explicitRepo = await createIndexedMcpRepo(workspace, "explicit-repo", "explicit", "explicitSymbol");
    const staleRepo = await createIndexedMcpRepo(workspace, "stale-repo", "stale", "staleSymbol");
    await mkdir(path.join(explicitRepo, ".codex"), { recursive: true });
    await writeFile(path.join(explicitRepo, ".codex", "config.toml"), "[features]\nhooks = true\n", "utf8");
    const focusFile = path.join(workspace, "WORKING.md");
    await writeFile(
      focusFile,
      [
        "## Active Sessions",
        "",
        "| session | agent | repo | task | status | claims | last_seen | next |",
        "| --- | --- | --- | --- | --- | --- | --- | --- |",
        `| other-session | codex | ${staleRepo} | other task | active | none | now | inspect |`
      ].join("\n"),
      "utf8"
    );

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(process.cwd(), "dist/cli.js"), "serve", explicitRepo],
      env: { CODEXA_WORKSPACE_FOCUS_FILE: focusFile, SESSION_ID: "stale-session" },
      stderr: "pipe"
    });
    const client = new Client({ name: "codexa-explicit-focus-env-routing-test", version: "0.1.0" });
    await client.connect(transport);

    try {
      const repoMap = await client.callTool({ name: "repo_map", arguments: { limit: 5 } });
      const serialized = JSON.stringify(repoMap);
      expect(serialized).toContain("src/explicit.ts");
      expect(serialized).not.toContain("src/stale.ts");
      expect(serialized).not.toContain("stale-session");
    } finally {
      await client.close();
    }
  });

it("ignores out-of-tree repo paths from workspace focus files", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "codexa-mcp-focused-root-"));
    const outsideParent = await mkdtemp(path.join(os.tmpdir(), "codexa-mcp-outside-"));
    execFileSync("git", ["init"], { cwd: workspace, stdio: "ignore" });
    const outsideRepo = await createIndexedMcpRepo(outsideParent, "outside-repo", "outside", "outsideSymbol");
    const outsideLink = path.join(workspace, "outside-link");
    await symlink(outsideRepo, outsideLink, "dir");
    const focusFile = path.join(workspace, ".codex", "WORKING.md");
    await mkdir(path.dirname(focusFile), { recursive: true });
    await writeFile(focusFile, `## Session\n\n- Focused project: \`${outsideLink}\`.\n`, "utf8");

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(process.cwd(), "dist/cli.js"), "serve", workspace],
      stderr: "pipe"
    });
    const client = new Client({ name: "codexa-focused-root-boundary-test", version: "0.1.0" });
    await client.connect(transport);

    try {
      const freshness = await client.callTool({ name: "freshness", arguments: {} });
      expect(JSON.stringify(freshness)).toContain(workspace);
      expect(JSON.stringify(freshness)).not.toContain(outsideRepo);
    } finally {
      await client.close();
    }
  });

it("exposes bounded context tools with stale-index auto-refresh over stdio", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-mcp-"));
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    await mkdir(path.join(repo, "src"), { recursive: true });
    await mkdir(path.join(repo, "tests"), { recursive: true });
    await writeFile(path.join(repo, "package.json"), JSON.stringify({ scripts: { test: "vitest run" } }, null, 2), "utf8");
    await writeFile(path.join(repo, "src/index.ts"), "export function main() { return 1 }\n", "utf8");
    await writeFile(path.join(repo, "tests/index.test.ts"), "import { main } from '../src/index'\ntest('main', () => expect(main()).toBe(1))\n", "utf8");
    execFileSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["-c", "user.name=Codexa", "-c", "user.email=codexa@example.invalid", "commit", "-m", "fixture"], {
      cwd: repo,
      stdio: "ignore"
    });
    await buildIndex({ repoRoot: repo });

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(process.cwd(), "dist/cli.js"), "serve", repo],
      stderr: "pipe"
    });
    const stderrChunks: Buffer[] = [];
    transport.stderr?.on("data", (chunk) => stderrChunks.push(Buffer.from(chunk)));

    const client = new Client({ name: "codexa-test", version: "0.1.0" });
    await client.connect(transport);
    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining([
        "repo_map",
        "find_context",
        "search",
        "placeholder_report",
        "symbol_context",
        "impact",
        "diff_impact",
        "test_plan",
        "freshness",
        "task_brief",
        "context_pack",
        "focus_brief",
        "session_context",
        "session_memory",
        "callers",
        "callees",
        "dependency_path",
        "workflow_path",
        "change_plan",
        "post_edit_review",
        "proof_card"
      ])
    );
    const contextTool = tools.tools.find((tool) => tool.name === "context_pack");
    expect(contextTool?.outputSchema).toBeTruthy();
    // The compact default keeps the envelope's top-level contract; the deep
    // nested fields are asserted below under CODEXA_MCP_OUTPUT_SCHEMA=full.
    expect(JSON.stringify(contextTool?.outputSchema)).toContain("schemaVersion");
    expect(JSON.stringify(contextTool?.outputSchema)).toContain("actionability");
    expect(JSON.stringify(contextTool?.outputSchema)).toContain("verificationProvenance");
    expect(JSON.stringify(contextTool?.outputSchema)).toContain("worktree");
    expect(contextTool?.annotations?.destructiveHint).toBe(false);
    expect(contextTool?.annotations?.openWorldHint).toBe(false);
    expect(contextTool?.annotations?.readOnlyHint).toBe(false);
    expect(contextTool?.annotations?.idempotentHint).toBe(false);
	    const searchSchema = JSON.stringify(tools.tools.find((tool) => tool.name === "search")?.inputSchema);
	    expect(searchSchema).toContain("patterns");
	    expect(searchSchema).toContain("maxItems");
	    expect(searchSchema).toContain("7");
	    const symbolContextSchema = JSON.stringify(tools.tools.find((tool) => tool.name === "symbol_context")?.inputSchema);
	    expect(symbolContextSchema).toContain("depth");
	    expect(symbolContextSchema).toContain("includeEvidence");
	    expect(symbolContextSchema).toContain("language");
    const changePlanSchema = JSON.stringify(tools.tools.find((tool) => tool.name === "change_plan")?.inputSchema);
    expect(changePlanSchema).toContain("followCandidate");
    const testPlanSchema = JSON.stringify(tools.tools.find((tool) => tool.name === "test_plan")?.inputSchema);
    expect(testPlanSchema).toContain("files");
    expect(testPlanSchema).toContain("changeType");
    const proofCardSchema = JSON.stringify(tools.tools.find((tool) => tool.name === "proof_card")?.inputSchema);
    expect(proofCardSchema).toContain("files");
    expect(proofCardSchema).toContain("ranCommandReports");
    expect(proofCardSchema).toContain("waivers");
    expect(tools.tools.find((tool) => tool.name === "impact")?.annotations?.readOnlyHint).toBe(false);
    expect(tools.tools.find((tool) => tool.name === "freshness")?.annotations?.readOnlyHint).toBe(true);

    const freshness = await client.callTool({ name: "freshness", arguments: {} });
    expect(freshness.structuredContent).toMatchObject({
      schemaVersion: 1,
      mode: "freshness",
      actionability: expect.any(String),
      toolPolicy: {
        name: "freshness",
        readOnly: true,
        useWhen: expect.stringContaining("Check whether indexed artifacts")
      }
    });
    expect(JSON.stringify(freshness.content)).toContain("resource_link");

    const sourcePolicyCases: Array<[string, Record<string, unknown>]> = [
      ["search", { query: "main", limit: 3 }],
      ["repo_map", { limit: 3 }],
      ["symbol_context", { symbol: "main" }],
      ["callers", { file: "src/index.ts", limit: 3 }],
      ["workflow_path", { query: "main", limit: 3 }]
    ];
	    for (const [name, args] of sourcePolicyCases) {
	      const result = await client.callTool({ name, arguments: args });
      const toolPolicy = (result.structuredContent as { toolPolicy?: { name?: string; readOnly?: boolean; writeEffects?: string } }).toolPolicy;
      const listed = tools.tools.find((tool) => tool.name === name);
      expect(toolPolicy).toMatchObject({
        name,
        readOnly: listed?.annotations?.readOnlyHint,
        writeEffects: expect.stringContaining("index-cache-if-auto-refresh")
	      });
	    }
	    const symbolContext = await client.callTool({ name: "symbol_context", arguments: { symbol: "main", depth: 2 } });
	    const symbolData = (symbolContext.structuredContent as { data?: { mode?: string; edgeEvidence?: unknown[]; nextTools?: Array<{ tool?: string }> } }).data;
	    expect(symbolData?.mode).toBe("symbol_context");
	    expect(Array.isArray(symbolData?.edgeEvidence)).toBe(true);
	    expect(symbolData?.nextTools?.some((tool) => tool.tool === "impact")).toBe(true);

	    const rejectedFollow = await client.callTool({ name: "change_plan", arguments: { taskId: "missing-mcp-follow", followCandidate: "candidate-missing" } });
    expect(JSON.stringify(rejectedFollow)).toContain("Follow candidate: rejected");
    expect(((rejectedFollow.structuredContent as { data?: { followCandidate?: { status?: string; requested?: string } } }).data?.followCandidate)).toMatchObject({
      status: "rejected",
      requested: "candidate-missing"
    });

    const blockedPlan = await client.callTool({
      name: "change_plan",
      arguments: { task: "Change main", diff: false, limit: 6, tokenBudget: 1200, saveSnapshot: true, taskId: "mcp-follow-policy" }
    });
    const blockedPlanData = blockedPlan.structuredContent as {
      data?: {
        snapshotBlock?: { taskId?: string };
        targetCandidates?: Array<{ candidateId: string; validationStatus?: string }>;
      };
    };
    const acceptedCandidate = blockedPlanData.data?.targetCandidates?.find((candidate) => candidate.validationStatus === "edit-ready");
    expect(blockedPlanData.data?.snapshotBlock).toMatchObject({ taskId: "mcp-follow-policy" });
    expect(acceptedCandidate?.candidateId).toMatch(/^candidate-/);
    const acceptedFollow = await client.callTool({
      name: "change_plan",
      arguments: { taskId: "mcp-follow-policy", followCandidate: acceptedCandidate!.candidateId }
    });
    expect(((acceptedFollow.structuredContent as { data?: { followCandidate?: { status?: string } } }).data?.followCandidate)).toMatchObject({ status: "accepted" });
    expect((acceptedFollow.structuredContent as { toolPolicy?: { writeEffects?: string } }).toolPolicy?.writeEffects).toContain("task-snapshot-cache");

    const resources = await client.listResources();
    expect(resources.resources.length).toBeLessThanOrEqual(200);
    expect(resources.resources.map((resource) => resource.uri)).toEqual(
      expect.arrayContaining([
        "codexa://repo/codebase/README.md",
        "codexa://repo/codebase/codex-contract.md",
        "codexa://repo/codebase/repo-map.md",
        "codexa://repo/codebase/placeholder-map.md",
        "codexa://repo/codebase/workflows.md",
        "codexa://repo/codebase/playbooks/README.md",
        "codexa://repo/codebase/freshness.json"
      ])
    );
    const playbookUri = resources.resources.map((resource) => resource.uri).find((uri) => uri.startsWith("codexa://repo/codebase/playbooks/") && !uri.endsWith("/README.md"));
    expect(playbookUri).toBeTruthy();
    const playbook = await client.readResource({ uri: playbookUri! });
    expect(playbook.contents?.[0]?.text).toContain("Playbook");
    for (const resource of resources.resources) {
      const content = await client.readResource({ uri: resource.uri });
      expect(content.contents?.[0]?.text).toBeTruthy();
      expect(String(content.contents?.[0]?.text)).not.toContain("Codexa artifact missing");
    }
    const readme = await client.readResource({ uri: "codexa://repo/codebase/README.md" });
    expect(readme.contents?.[0]?.text).toContain("Codexa Codebase Context");
    const contract = await client.readResource({ uri: "codexa://repo/codebase/codex-contract.md" });
    expect(contract.contents?.[0]?.text).toContain("Automatic Use Rules");
    expect(contract.contents?.[0]?.text).toContain("Session Memory Protocol");
    const placeholderMap = await client.readResource({ uri: "codexa://repo/codebase/placeholder-map.md" });
    expect(placeholderMap.contents?.[0]?.text).toContain("Placeholder Map");

    const prompts = await client.listPrompts();
    expect(prompts.prompts.map((prompt) => prompt.name)).toEqual(
      expect.arrayContaining(["impact_before_edit", "dirty_diff_review", "snapshot_edit_loop", "targeted_test_plan"])
    );
    const prompt = await client.getPrompt({ name: "impact_before_edit", arguments: { target: "src/index.ts", task: "change behavior" } });
    expect(prompt.messages[0].content.type).toBe("text");
    if (prompt.messages[0].content.type === "text") {
      expect(prompt.messages[0].content.text).toContain("impact");
    }

    const result = await client.callTool({ name: "freshness", arguments: {} });
    expect(result.content?.[0]?.type).toBe("text");
    expect(result.structuredContent).toBeTruthy();
    expect(JSON.stringify(result)).toContain("fresh");

    const repoMap = await client.callTool({ name: "repo_map", arguments: { limit: 3 } });
    expect(JSON.stringify(repoMap)).toContain("src/index.ts");

    const cleanTestPlan = await client.callTool({ name: "test_plan", arguments: { diff: true } });
    const cleanTestPlanData = cleanTestPlan.structuredContent as { actionability?: string; data?: { tests?: unknown[]; verificationCommands?: unknown[] } };
    expect(cleanTestPlanData.actionability).toBe("needs_target");
    expect(cleanTestPlanData.data?.tests).toEqual([]);
    expect(cleanTestPlanData.data?.verificationCommands).toEqual([]);
    expect(JSON.stringify(cleanTestPlan)).toContain("No targeted test plan");

    const targetedTestPlan = await client.callTool({ name: "test_plan", arguments: { files: ["src/index.ts"], diff: false } });
    const targetedTestPlanData = targetedTestPlan.structuredContent as { actionability?: string; data?: { targetFiles?: string[] } };
    expect(targetedTestPlanData.actionability).toBe("verify");
    expect(targetedTestPlanData.data?.targetFiles).toEqual(["src/index.ts"]);

    const cleanProofCard = await client.callTool({ name: "proof_card", arguments: { diff: false } });
    const cleanProofCardData = cleanProofCard.structuredContent as {
      actionability?: string;
      data?: { actionability?: string; verification?: { tests?: unknown[]; recommendedCommands?: unknown[] }; gaps?: string[] };
    };
    expect(cleanProofCardData.actionability).toBe("needs_target");
    expect(cleanProofCardData.data?.actionability).toBe("needs_target");
    expect(cleanProofCardData.data?.verification?.tests).toEqual([]);
    expect(cleanProofCardData.data?.verification?.recommendedCommands).toEqual([]);
    expect(cleanProofCardData.data?.gaps).toContain("test plan needs target files or a dirty diff");

    const targetedProofCard = await client.callTool({ name: "proof_card", arguments: { files: ["src/index.ts"], diff: false } });
    const targetedProofCardData = targetedProofCard.structuredContent as { actionability?: string; data?: { actionability?: string; verification?: { tests?: unknown[] } } };
    expect(targetedProofCardData.actionability).toBe("verify");
    expect(targetedProofCardData.data?.actionability).toBe("verify");
    expect(targetedProofCardData.data?.verification?.tests?.length).toBeGreaterThan(0);

    await writeFile(path.join(repo, "src/index.ts"), "export function changedSymbol() { return 2 }\n", "utf8");
    const dirtyFreshness = await client.callTool({ name: "freshness", arguments: {} });
    expect((dirtyFreshness.structuredContent as { freshness?: { stale?: boolean; reason?: string } }).freshness?.stale).toBe(true);
    expect((dirtyFreshness.structuredContent as { freshness?: { reason?: string } }).freshness?.reason).toBe("dirty-files-changed");
    const dirtyFreshnessResource = await client.readResource({ uri: "codexa://repo/codebase/freshness.json" });
    expect(JSON.parse(String(dirtyFreshnessResource.contents?.[0]?.text)).stale).toBe(true);
    const refreshed = await client.callTool({ name: "find_context", arguments: { query: "changedSymbol", limit: 3 } });
    expect(JSON.stringify(refreshed)).toContain("auto-refreshed from dirty-files-changed");
    expect(JSON.stringify(refreshed)).toContain("changedSymbol");
    const refreshedFreshnessResource = await client.readResource({ uri: "codexa://repo/codebase/freshness.json" });
    expect(JSON.parse(String(refreshedFreshnessResource.contents?.[0]?.text)).stale).toBe(false);

    const search = await client.callTool({ name: "search", arguments: { query: "changedSymbol", patterns: ["changedSymbol", "changed_symbol"], limit: 3 } });
    expect(JSON.stringify(search)).toContain("Codexa value");
    expect(JSON.stringify(search)).toContain("changedSymbol");
    expect(JSON.stringify(search)).toContain("Search patterns");

    const impact = await client.callTool({ name: "impact", arguments: { file: "src/index.ts", changeType: "api", depth: 2 } });
    expect(JSON.stringify(impact)).toContain("Impact target");
    expect(JSON.stringify(impact)).toContain("Change type: api");

    const testPlan = await client.callTool({ name: "test_plan", arguments: { diff: true } });
    expect(JSON.stringify(testPlan)).toContain("Test plan");

    const contextPack = await client.callTool({ name: "context_pack", arguments: { query: "changedSymbol", changeType: "behavior", tokenBudget: 800, limit: 5 } });
    expect(JSON.stringify(contextPack)).toContain("Codexa context pack");
    expect(JSON.stringify(contextPack)).toContain("changedSymbol");
    const contextPackData = contextPack.structuredContent as {
      data?: {
        contextSources?: Array<{ source?: string; fileCount?: number }>;
        verificationCommands?: string[];
        verificationCoverage?: Array<{ kind: string }>;
        verificationCommandPlan?: Array<{ command: string; covers: string[] }>;
        sessionMemory?: { autoRecorded?: boolean; writes?: { sessionId?: string; revision?: number; recordedEntryIds?: string[] } };
      };
    };
    expect(contextPackData.data?.contextSources?.map((entry) => entry.source)).toContain("lexical_query");
    expect(contextPackData.data?.verificationCommands?.length).toBeGreaterThan(0);
    expect(contextPackData.data?.verificationCoverage?.length).toBeGreaterThan(0);
    expect(contextPackData.data?.verificationCommandPlan?.length).toBeGreaterThan(0);
    expect(contextPackData.data?.sessionMemory?.autoRecorded).toBe(true);
    expect(contextPackData.data?.sessionMemory?.writes?.sessionId).toBeTruthy();
    expect(contextPackData.data?.sessionMemory?.writes?.revision).toBeGreaterThan(0);
    expect(contextPackData.data?.sessionMemory?.writes?.recordedEntryIds?.length).toBeGreaterThan(0);

    const taskBrief = await client.callTool({ name: "task_brief", arguments: { files: ["src/index.ts"], task: "change behavior", tokenBudget: 900, limit: 5 } });
    expect(JSON.stringify(taskBrief)).toContain("Codexa task brief");
    expect(JSON.stringify(taskBrief)).toContain("mode");
    const taskBriefData = taskBrief.structuredContent as {
      data?: {
        contextSources?: Array<{ source?: string; fileCount?: number }>;
        verificationCommands?: string[];
        verificationCoverage?: Array<{ kind: string }>;
        verificationCommandPlan?: Array<{ command: string; covers: string[] }>;
      };
    };
    expect(taskBriefData.data?.contextSources?.map((entry) => entry.source)).toContain("explicit_target");
    expect(taskBriefData.data?.verificationCommands?.length).toBeGreaterThan(0);
    expect(taskBriefData.data?.verificationCoverage?.length).toBeGreaterThan(0);
    expect(taskBriefData.data?.verificationCommandPlan?.length).toBeGreaterThan(0);

    const focusBrief = await client.callTool({ name: "focus_brief", arguments: { task: "understand the main workflow", tokenBudget: 900, limit: 5 } });
    expect(JSON.stringify(focusBrief)).toContain("Codexa focus brief");

    const autoMemorySummary = await client.callTool({
      name: "session_memory",
      arguments: { action: "summary", kinds: ["viewed", "verification"], limit: 10 }
    });
    expect(JSON.stringify(autoMemorySummary)).toContain("Recently viewed:");
    expect(JSON.stringify(autoMemorySummary)).toContain("context_pack returned");
    expect(JSON.stringify(autoMemorySummary)).toContain("test_plan recommended");

    const remembered = await client.callTool({
      name: "session_memory",
      arguments: {
        action: "remember",
        sessionId: "mcp-test-session",
        taskId: "mcp-changed-symbol",
        files: ["src/index.ts"],
        topics: ["mcp test"],
        entries: [
          {
            kind: "decision",
            key: "decision:mcp-test",
            summary: "Use the session_memory MCP tool to persist task-local decisions.",
            provenance: "agent-asserted",
            confidence: "heuristic",
            evidenceTier: "derived"
          }
        ]
      }
    });
    expect(JSON.stringify(remembered)).toContain("Codexa session memory");
    const rememberedData = remembered.structuredContent as { data?: { writes?: { recordedEntryIds?: string[] }; memory?: { decisions?: Array<{ confidence: string; provenance: string }> } } };
    expect(rememberedData.data?.writes?.recordedEntryIds?.length).toBe(1);
    expect(rememberedData.data?.memory?.decisions?.[0]).toMatchObject({ confidence: "heuristic", provenance: "agent-asserted" });

    const recalled = await client.callTool({
      name: "session_memory",
      arguments: { action: "read", sessionId: "mcp-test-session", taskId: "mcp-changed-symbol", kinds: ["decision"], files: ["src/index.ts"] }
    });
    expect(JSON.stringify(recalled)).toContain("Use the session_memory MCP tool");

    const memorySummary = await client.callTool({
      name: "session_memory",
      arguments: { action: "summary", sessionId: "mcp-test-session", taskId: "mcp-changed-symbol" }
    });
    expect(JSON.stringify(memorySummary)).toContain("Decisions:");
    const cliMemorySummary = execFileSync(process.execPath, [path.join(process.cwd(), "dist/cli.js"), "session-memory", repo, "--action", "summary", "--session-id", "mcp-test-session", "--task-id", "mcp-changed-symbol"], {
      encoding: "utf8"
    });
    expect(cliMemorySummary).toContain("Codexa session memory");
    expect(cliMemorySummary).toContain("Use the session_memory MCP tool");

    const callers = await client.callTool({ name: "callers", arguments: { symbol: "changedSymbol", limit: 5 } });
    expect(JSON.stringify(callers)).toContain("Callers/importers");

    const unsavedChangePlan = await client.callTool({
      name: "change_plan",
      arguments: { task: "change changedSymbol safely", symbols: ["changedSymbol"], tokenBudget: 1000, limit: 5 }
    });
    expect((unsavedChangePlan.structuredContent as { toolPolicy?: { writeEffects?: string } }).toolPolicy?.writeEffects).toBe("session-memory-auto+index-cache-if-auto-refresh");

    const changePlan = await client.callTool({
      name: "change_plan",
      arguments: { task: "change changedSymbol safely", symbols: ["changedSymbol"], tokenBudget: 1000, limit: 5, saveSnapshot: true, taskId: "mcp-changed-symbol" }
    });
    expect(JSON.stringify(changePlan)).toContain("Codexa change plan");
    expect(JSON.stringify(changePlan)).toContain("Task snapshot: mcp-changed-symbol");
    expect((changePlan.structuredContent as { toolPolicy?: { writeEffects?: string } }).toolPolicy?.writeEffects).toBe(
      "task-snapshot-cache+session-memory-auto+index-cache-if-auto-refresh"
    );

    await writeFile(path.join(repo, "src/index.ts"), "export function changedSymbol() { return 3 }\n", "utf8");
    const indexMtimeBeforePostEdit = (await stat(path.join(repo, ".codex/codebase/index.json"))).mtimeMs;
    const postEdit = await client.callTool({
      name: "post_edit_review",
      arguments: {
        taskId: "mcp-changed-symbol",
        ranTests: [],
        ranCommands: ["npm test"],
        ranCommandReports: [{ command: "npm test", cwd: repo, packageManager: "npm", packageRoot: ".", scriptName: "test", args: [], exitCode: 0, durationMs: 50, stdoutSummary: "vitest passed" }]
      }
    });
    expect(JSON.stringify(postEdit)).toContain("Codexa post-edit review");
    expect(JSON.stringify(postEdit)).toContain("Changed since snapshot");
    expect(JSON.stringify(postEdit)).toContain("auto-refreshed");
    expect(JSON.stringify(postEdit)).toContain("verificationLedger");
    expect(JSON.stringify(postEdit)).toContain("ranCommands");
    expect(JSON.stringify(postEdit)).toContain('"persisted":false');
    const postEditEnvelope = postEdit.structuredContent as { data: unknown; nextTools?: unknown[]; systemMessage?: string };
    const postEditData = postEditEnvelope.data as {
      ranCommands?: string[];
      ranCommandReports?: Array<{ command: string; exitCode?: number; durationMs?: number }>;
      commandEnvelopes?: Array<{ command: string; cwd?: string; packageManager?: string; packageRoot?: string; scriptName?: string; source?: string; scopeStatus?: string; args: string[] }>;
      verificationProvenance?: typeof CURRENT_VERIFICATION_PROVENANCE;
      mcp?: { verificationProvenance?: typeof CURRENT_VERIFICATION_PROVENANCE };
      verificationLedger?: Array<{ status: string; evidence: string[] }>;
      systemMessage?: string;
      outcome?: {
        persisted?: boolean;
        ranTests?: string[];
        ranCommands?: string[];
        ranCommandReports?: Array<{ command: string; cwd?: string; stdoutSummary?: string }>;
        commandEnvelopes?: Array<{ command: string; cwd?: string; packageManager?: string; packageRoot?: string; scriptName?: string; source?: string; scopeStatus?: string; args: string[] }>;
        verificationProvenance?: typeof CURRENT_VERIFICATION_PROVENANCE;
        waivedChecks?: string[];
        verificationCoverage?: unknown[];
        verificationLedger?: unknown[];
      };
    };
    expect(postEditData.ranCommands).toEqual(["npm test"]);
    expect(postEditData.ranCommandReports?.[0]).toMatchObject({ command: "npm test", exitCode: 0, durationMs: 50 });
    expect(postEditData.commandEnvelopes?.[0]).toMatchObject({ command: "npm test", cwd: "<repo>", packageManager: "npm", packageRoot: ".", scriptName: "test", source: "reported", scopeStatus: "repo", args: [] });
    expect(postEditData.verificationProvenance).toEqual(CURRENT_VERIFICATION_PROVENANCE);
    expect(postEditData.mcp?.verificationProvenance).toEqual(CURRENT_VERIFICATION_PROVENANCE);
    expect(postEditData.verificationLedger?.some((entry) => entry.status === "covered" && entry.evidence.some((item) => item.includes("npm test")))).toBe(true);
    expect(postEditData.outcome?.persisted).toBe(false);
    expect(postEditData.outcome?.ranTests).toEqual([]);
    expect(postEditData.outcome?.ranCommands).toEqual(["npm test"]);
    expect(postEditData.outcome?.ranCommandReports?.[0]).toMatchObject({ command: "npm test", cwd: "<repo>", stdoutSummary: "vitest passed" });
    expect(postEditData.outcome?.commandEnvelopes?.[0]).toMatchObject({ command: "npm test", cwd: "<repo>", packageManager: "npm", packageRoot: ".", scriptName: "test", source: "reported" });
    expect(postEditData.outcome?.verificationProvenance).toEqual(CURRENT_VERIFICATION_PROVENANCE);
    expect(postEditData.outcome?.waivedChecks).toEqual([]);
    expect(postEditData.outcome?.verificationCoverage?.length).toBeGreaterThan(0);
    expect(postEditData.outcome?.verificationLedger?.length).toBeGreaterThan(0);

    const proofCard = await client.callTool({
      name: "proof_card",
      arguments: {
        taskId: "mcp-changed-symbol",
        ranCommandReports: [{ command: "npm test", cwd: repo, packageManager: "npm", packageRoot: ".", scriptName: "test", args: [], exitCode: 0, durationMs: 50, stdoutSummary: "vitest passed" }]
      }
    });
    expect(JSON.stringify(proofCard)).toContain("Codexa proof card");
    expect(JSON.stringify(proofCard)).toContain("Reported verification ledger");
    const proofEnvelope = proofCard.structuredContent as {
      mode?: string;
      actionability?: string;
      data: {
        mode?: string;
        verification?: {
          reported?: {
            hasEvidence?: boolean;
            commandEnvelopes?: Array<{ command?: string; cwd?: string; scriptName?: string; source?: string }>;
            ledger?: Array<{ status?: string; target?: string; evidence?: string[] }>;
            verificationProvenance?: typeof CURRENT_VERIFICATION_PROVENANCE;
          };
        };
        verificationProvenance?: typeof CURRENT_VERIFICATION_PROVENANCE;
      };
      toolPolicy?: { name?: string; phase?: string; readOnly?: boolean };
    };
    expect(proofEnvelope.mode).toBe("proof_card");
    expect(proofEnvelope.actionability).toBe("verify");
    expect(proofEnvelope.toolPolicy).toMatchObject({ name: "proof_card", phase: "verify", readOnly: false });
    expect(proofEnvelope.data.mode).toBe("proof_card");
    expect(proofEnvelope.data.verificationProvenance).toEqual(CURRENT_VERIFICATION_PROVENANCE);
    expect(proofEnvelope.data.verification?.reported?.hasEvidence).toBe(true);
    expect(proofEnvelope.data.verification?.reported?.verificationProvenance).toEqual(CURRENT_VERIFICATION_PROVENANCE);
    expect(proofEnvelope.data.verification?.reported?.commandEnvelopes?.[0]).toMatchObject({ command: "npm test", cwd: "<repo>", scriptName: "test", source: "reported" });
    expect(proofEnvelope.data.verification?.reported?.ledger?.some((entry) => entry.status === "covered" && entry.evidence?.some((item) => item.includes("npm test")))).toBe(true);

    const unverifiedPostEdit = await client.callTool({
      name: "post_edit_review",
      arguments: { taskId: "mcp-changed-symbol", ranTests: [], ranCommands: [] }
    });
    const unverifiedEnvelope = unverifiedPostEdit.structuredContent as {
      data: { nextTools?: Array<{ tool?: string; reason?: string; readOnly?: boolean; writes?: string[] }>; systemMessage?: string };
      nextTools?: unknown[];
      systemMessage?: string;
    };
    expect(unverifiedEnvelope.data.nextTools?.some((tool) => tool.tool === "test_plan" && tool.reason && tool.readOnly === true)).toBe(true);
    expect(unverifiedEnvelope.nextTools?.some((tool) => typeof tool === "object" && tool !== null && "tool" in tool)).toBe(true);
    expect(unverifiedEnvelope.systemMessage).toBe(unverifiedEnvelope.data.systemMessage);

    const outsideCwd = path.join(os.tmpdir(), "codexa-secret-outside");
    const longSummary = `outside path ${outsideCwd} ${"x".repeat(900)}`;
    const redactedPostEdit = await client.callTool({
      name: "post_edit_review",
      arguments: {
        taskId: "mcp-changed-symbol",
        ranTests: [],
        ranCommandReports: [{ command: "npm test", cwd: outsideCwd, exitCode: 0, stdoutSummary: longSummary }]
      }
    });
    const redactedSerialized = JSON.stringify(redactedPostEdit);
    expect(redactedSerialized).not.toContain(outsideCwd);
    expect(redactedSerialized).not.toContain(longSummary);
    expect(redactedSerialized).toContain("<outside-repo>");

    const waivedPostEdit = await client.callTool({
      name: "post_edit_review",
      arguments: {
        taskId: "mcp-changed-symbol",
        ranTests: [],
        ranCommands: [],
        waivers: [{ kind: "test", target: "tests/index.test.ts", reason: "manual browser regression" }]
      }
    });
    expect(JSON.stringify(waivedPostEdit)).toContain("waivedVerification");
    const waivedData = waivedPostEdit.structuredContent as {
      data: {
        waivedVerification?: Array<{ kind: string; target: string; status: string }>;
        outcome?: { waivedVerification?: Array<{ kind: string; target: string; status: string }> };
      };
    };
    expect(waivedData.data.waivedVerification?.some((entry) => entry.kind === "test" && entry.target === "tests/index.test.ts" && entry.status === "waived")).toBe(true);
    expect(waivedData.data.outcome?.waivedVerification?.some((entry) => entry.kind === "test" && entry.target === "tests/index.test.ts" && entry.status === "waived")).toBe(true);
    expect((await stat(path.join(repo, ".codex/codebase/index.json"))).mtimeMs).toBeGreaterThanOrEqual(indexMtimeBeforePostEdit);
    await expect(readdir(path.join(repo, ".codex/cache/codexa-outcomes"))).rejects.toThrow();

    await client.close();
    expect(Buffer.concat(stderrChunks).toString("utf8")).toContain("codexa MCP server ready");
  });

it("does not execute AutoVerify through MCP even when CODEXA_AUTOVERIFY is enabled", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "codexa-mcp-autoverify-"));
    const repo = await createIndexedMcpAutoVerifyRepo(workspace);
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(process.cwd(), "dist/cli.js"), "serve", repo],
      env: { CODEXA_AUTOVERIFY: "1" },
      stderr: "pipe"
    });
    const client = new Client({ name: "codexa-mcp-autoverify-test", version: "0.1.0" });
    await client.connect(transport);

    try {
      const changePlan = await client.callTool({
        name: "change_plan",
        arguments: { task: "change main safely", files: ["src/main.js"], saveSnapshot: true, taskId: "mcp-autoverify-no-exec", limit: 5, tokenBudget: 1000 }
      });
      expect(JSON.stringify(changePlan)).toContain("Task snapshot: mcp-autoverify-no-exec");
      await writeFile(path.join(repo, "src/main.js"), "export function main() {\n  return 1;\n}\n", "utf8");

      const postEdit = await client.callTool({
        name: "post_edit_review",
        arguments: { taskId: "mcp-autoverify-no-exec", ranTests: [], ranCommands: [] }
      });
      expect(JSON.stringify(postEdit)).toContain("tests/main.test.js");
      const data = (postEdit.structuredContent as { data?: { ranCommandReports?: unknown[]; autoVerifyRunnerEvidence?: unknown[] } }).data;
      expect(data?.ranCommandReports ?? []).toEqual([]);
      expect(data?.autoVerifyRunnerEvidence ?? []).toEqual([]);
      await expect(stat(path.join(repo, "mcp-executed.txt"))).rejects.toThrow();

      const spoofed = await client.callTool({
        name: "post_edit_review",
        arguments: {
          taskId: "mcp-autoverify-no-exec",
          ranTests: [],
          ranCommandReports: [
            {
              command: "echo done",
              cwd: repo,
              exitCode: 0,
              runner: { reportKind: "codexa-autoverify-report", runnerName: "codexa" }
            }
          ],
          trustedRunnerReports: [{ command: "npm test", cwd: repo, exitCode: 0 }]
        }
      });
      const spoofedData = (spoofed.structuredContent as { data?: { autoVerifyRunnerEvidence?: unknown[]; verificationCoverage?: Array<{ kind?: string }> } }).data;
      expect(spoofedData?.autoVerifyRunnerEvidence ?? []).toEqual([]);
      expect(spoofedData?.verificationCoverage?.some((entry) => entry.kind === "javascript-tests")).toBe(false);
      expect(JSON.stringify(spoofed)).not.toContain("codexa-autoverify-report");
    } finally {
      await client.close();
    }
  });

it("serves placeholder report tool output and placeholder map resource", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-mcp-placeholder-"));
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    await mkdir(path.join(repo, "src"), { recursive: true });
    await mkdir(path.join(repo, "tests"), { recursive: true });
    await writeFile(path.join(repo, "package.json"), JSON.stringify({ scripts: { test: "vitest run" } }, null, 2), "utf8");
    await writeFile(path.join(repo, "src/index.ts"), "export function later() { throw new Error('not implemented') }\n", "utf8");
    await writeFile(path.join(repo, "tests/index.test.ts"), "it('keeps fixture placeholder text', () => {}) // TODO fixture\n", "utf8");
    execFileSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["-c", "user.name=Codexa", "-c", "user.email=codexa@example.invalid", "commit", "-m", "fixture"], {
      cwd: repo,
      stdio: "ignore"
    });
    await buildIndex({ repoRoot: repo });

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(process.cwd(), "dist/cli.js"), "serve", repo],
      stderr: "pipe"
    });
    const client = new Client({ name: "codexa-placeholder-test", version: "0.1.0" });
    await client.connect(transport);
    const report = await client.callTool({ name: "placeholder_report", arguments: { limit: 10 } });
    const data = (report.structuredContent as { data?: { findings?: Array<{ path: string; signal: string }>; filters?: { includeTests: boolean } } }).data;
    expect(JSON.stringify(report)).toContain("Codexa placeholder report");
    expect(data?.findings?.some((finding) => finding.path === "src/index.ts" && finding.signal === "placeholder.not-implemented")).toBe(true);
    expect(data?.findings?.some((finding) => finding.path.startsWith("tests/"))).toBe(false);
    expect(data?.filters?.includeTests).toBe(false);
    const resource = await client.readResource({ uri: "codexa://repo/codebase/placeholder-map.md" });
    expect(resource.contents?.[0]?.text).toContain("placeholder.not-implemented");
    await client.close();
  });
});
