import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { describe, expect, it } from "vitest";
import { buildIndex } from "../src/indexer.js";

describe("Codexa MCP server", () => {
  it("exposes bounded context tools with stale-index auto-refresh over stdio", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-mcp-"));
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    await mkdir(path.join(repo, "src"), { recursive: true });
    await writeFile(path.join(repo, "src/index.ts"), "export function main() { return 1 }\n", "utf8");
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
        "symbol_context",
        "impact",
        "diff_impact",
        "test_plan",
        "freshness",
        "task_brief",
        "context_pack",
        "focus_brief",
        "session_context",
        "callers",
        "callees",
        "dependency_path",
        "workflow_path",
        "change_plan",
        "post_edit_review"
      ])
    );
    const contextTool = tools.tools.find((tool) => tool.name === "context_pack");
    expect(contextTool?.outputSchema).toBeTruthy();
    expect(contextTool?.annotations?.destructiveHint).toBe(false);
    expect(contextTool?.annotations?.openWorldHint).toBe(false);
    expect(contextTool?.annotations?.readOnlyHint).toBe(false);
    expect(contextTool?.annotations?.idempotentHint).toBe(false);
    expect(tools.tools.find((tool) => tool.name === "impact")?.annotations?.readOnlyHint).toBe(false);
    expect(tools.tools.find((tool) => tool.name === "freshness")?.annotations?.readOnlyHint).toBe(true);

    const resources = await client.listResources();
    expect(resources.resources.length).toBeLessThanOrEqual(200);
    expect(resources.resources.map((resource) => resource.uri)).toEqual(
      expect.arrayContaining([
        "codexa://repo/codebase/README.md",
        "codexa://repo/codebase/codex-contract.md",
        "codexa://repo/codebase/repo-map.md",
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

    await writeFile(path.join(repo, "src/index.ts"), "export function changedSymbol() { return 2 }\n", "utf8");
    const refreshed = await client.callTool({ name: "find_context", arguments: { query: "changedSymbol", limit: 3 } });
    expect(JSON.stringify(refreshed)).toContain("auto-refreshed from dirty-files-changed");
    expect(JSON.stringify(refreshed)).toContain("changedSymbol");

    const search = await client.callTool({ name: "search", arguments: { query: "changedSymbol", limit: 3 } });
    expect(JSON.stringify(search)).toContain("Codexa value");
    expect(JSON.stringify(search)).toContain("changedSymbol");

    const impact = await client.callTool({ name: "impact", arguments: { file: "src/index.ts", changeType: "api", depth: 2 } });
    expect(JSON.stringify(impact)).toContain("Impact target");
    expect(JSON.stringify(impact)).toContain("Change type: api");

    const testPlan = await client.callTool({ name: "test_plan", arguments: { diff: true } });
    expect(JSON.stringify(testPlan)).toContain("Test plan");

    const contextPack = await client.callTool({ name: "context_pack", arguments: { query: "changedSymbol", changeType: "behavior", tokenBudget: 800, limit: 5 } });
    expect(JSON.stringify(contextPack)).toContain("Codexa context pack");
    expect(JSON.stringify(contextPack)).toContain("changedSymbol");

    const taskBrief = await client.callTool({ name: "task_brief", arguments: { files: ["src/index.ts"], task: "change behavior", tokenBudget: 900, limit: 5 } });
    expect(JSON.stringify(taskBrief)).toContain("Codexa task brief");
    expect(JSON.stringify(taskBrief)).toContain("mode");

    const focusBrief = await client.callTool({ name: "focus_brief", arguments: { task: "understand the main workflow", tokenBudget: 900, limit: 5 } });
    expect(JSON.stringify(focusBrief)).toContain("Codexa focus brief");

    const callers = await client.callTool({ name: "callers", arguments: { symbol: "changedSymbol", limit: 5 } });
    expect(JSON.stringify(callers)).toContain("Callers/importers");

    const changePlan = await client.callTool({
      name: "change_plan",
      arguments: { task: "change changedSymbol safely", symbols: ["changedSymbol"], tokenBudget: 1000, limit: 5, saveSnapshot: true, taskId: "mcp-changed-symbol" }
    });
    expect(JSON.stringify(changePlan)).toContain("Codexa change plan");
    expect(JSON.stringify(changePlan)).toContain("Task snapshot: mcp-changed-symbol");

    await writeFile(path.join(repo, "src/index.ts"), "export function changedSymbol() { return 3 }\n", "utf8");
    const postEdit = await client.callTool({ name: "post_edit_review", arguments: { taskId: "mcp-changed-symbol", ranTests: [] } });
    expect(JSON.stringify(postEdit)).toContain("Codexa post-edit review");
    expect(JSON.stringify(postEdit)).toContain("Changed since snapshot");

    await client.close();
    expect(Buffer.concat(stderrChunks).toString("utf8")).toContain("codexa MCP server ready");
  });

  it("marks context tools as strictly read-only when auto-refresh is disabled", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-mcp-readonly-"));
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    await mkdir(path.join(repo, "src"), { recursive: true });
    await writeFile(path.join(repo, "src/index.ts"), "export function main() { return 1 }\n", "utf8");
    execFileSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["-c", "user.name=Codexa", "-c", "user.email=codexa@example.invalid", "commit", "-m", "fixture"], {
      cwd: repo,
      stdio: "ignore"
    });
    await buildIndex({ repoRoot: repo });

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(process.cwd(), "dist/cli.js"), "serve", repo, "--no-auto-refresh"],
      stderr: "pipe"
    });
    const client = new Client({ name: "codexa-test", version: "0.1.0" });
    await client.connect(transport);
    const tools = await client.listTools();
    expect(tools.tools.find((tool) => tool.name === "task_brief")?.annotations?.readOnlyHint).toBe(true);
    expect(tools.tools.find((tool) => tool.name === "task_brief")?.annotations?.idempotentHint).toBe(true);
    expect(tools.tools.find((tool) => tool.name === "context_pack")?.annotations?.readOnlyHint).toBe(true);
    expect(tools.tools.find((tool) => tool.name === "context_pack")?.annotations?.idempotentHint).toBe(true);
    expect(tools.tools.find((tool) => tool.name === "impact")?.annotations?.readOnlyHint).toBe(true);
    expect(tools.tools.find((tool) => tool.name === "focus_brief")?.annotations?.readOnlyHint).toBe(true);
    expect(tools.tools.find((tool) => tool.name === "callers")?.annotations?.readOnlyHint).toBe(true);
    await client.close();
  });

  it("surfaces missing advertised artifacts as resource errors", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-mcp-missing-artifact-"));
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    await mkdir(path.join(repo, "src"), { recursive: true });
    await writeFile(path.join(repo, "src/index.ts"), "export function main() { return 1 }\n", "utf8");
    execFileSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["-c", "user.name=Codexa", "-c", "user.email=codexa@example.invalid", "commit", "-m", "fixture"], {
      cwd: repo,
      stdio: "ignore"
    });
    await buildIndex({ repoRoot: repo });
    await rm(path.join(repo, ".codex/codebase/repo-map.md"));

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(process.cwd(), "dist/cli.js"), "serve", repo, "--no-auto-refresh"],
      stderr: "pipe"
    });
    const client = new Client({ name: "codexa-test", version: "0.1.0" });
    await client.connect(transport);
    await expect(client.readResource({ uri: "codexa://repo/codebase/repo-map.md" })).rejects.toThrow(/Codexa artifact missing/);
    await client.close();
  });

  it("discovers module and playbook resources after auto-refresh without restarting", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-mcp-dynamic-resources-"));
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    await mkdir(path.join(repo, "src"), { recursive: true });
    await writeFile(path.join(repo, "src/index.ts"), "export function main() { return 1 }\n", "utf8");
    execFileSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["-c", "user.name=Codexa", "-c", "user.email=codexa@example.invalid", "commit", "-m", "fixture"], {
      cwd: repo,
      stdio: "ignore"
    });

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(process.cwd(), "dist/cli.js"), "serve", repo],
      stderr: "pipe"
    });
    const client = new Client({ name: "codexa-test", version: "0.1.0" });
    await client.connect(transport);
    await client.callTool({ name: "repo_map", arguments: { limit: 3 } });
    const resources = await client.listResources();
    const moduleUri = resources.resources.map((resource) => resource.uri).find((uri) => uri.startsWith("codexa://repo/codebase/modules/"));
    const playbookUri = resources.resources.map((resource) => resource.uri).find((uri) => uri.startsWith("codexa://repo/codebase/playbooks/") && !uri.endsWith("/README.md"));
    expect(moduleUri).toBeTruthy();
    expect(playbookUri).toBeTruthy();
    expect((await client.readResource({ uri: moduleUri! })).contents?.[0]?.text).toContain("# Module:");
    expect((await client.readResource({ uri: playbookUri! })).contents?.[0]?.text).toContain("Playbook");
    await client.close();
  });

  it("returns a bounded missing-index packet instead of a tool error when auto-refresh is disabled", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-mcp-missing-index-"));
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    await mkdir(path.join(repo, "src"), { recursive: true });
    await writeFile(path.join(repo, "src/index.ts"), "export function main() { return 1 }\n", "utf8");
    execFileSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["-c", "user.name=Codexa", "-c", "user.email=codexa@example.invalid", "commit", "-m", "fixture"], {
      cwd: repo,
      stdio: "ignore"
    });

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(process.cwd(), "dist/cli.js"), "serve", repo, "--no-auto-refresh"],
      stderr: "pipe"
    });
    const client = new Client({ name: "codexa-test", version: "0.1.0" });
    await client.connect(transport);
    const result = await client.callTool({ name: "focus_brief", arguments: { task: "start work", limit: 4 } });
    expect(JSON.stringify(result)).toContain("Codexa index missing");
    expect(JSON.stringify(result)).toContain("missingIndex");
    await client.close();
  });
});
