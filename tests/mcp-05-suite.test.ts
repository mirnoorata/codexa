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
describe("MCP token discipline", () => {
async function listToolsWith(repo: string, extraArgs: string[], env?: Record<string, string>) {
    // Ambient CODEXA_MCP_OUTPUT_SCHEMA must not leak into the compact-default
    // baseline run; only an explicit override applies.
    const spawnEnv: Record<string, string> = { ...(process.env as Record<string, string>) };
    delete spawnEnv.CODEXA_MCP_OUTPUT_SCHEMA;
    Object.assign(spawnEnv, env);
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(process.cwd(), "dist/cli.js"), "serve", repo, "--no-auto-refresh", ...extraArgs],
      env: spawnEnv,
      stderr: "pipe"
    });
    const client = new Client({ name: "codexa-token-discipline-test", version: "0.1.0" });
    await client.connect(transport);
    try {
      const tools = await client.listTools();
      return {
        bytes: JSON.stringify(tools).length,
        toolNames: tools.tools.map((tool) => tool.name),
        contextPackOutputSchema: JSON.stringify(tools.tools.find((tool) => tool.name === "context_pack")?.outputSchema ?? {})
      };
    } finally {
      await client.close();
    }
  }

it("keeps the default tools/list compact and honors the core profile and full-schema override", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "codexa-mcp-token-"));
    const repo = await createIndexedMcpRepo(workspace, "repo", "alpha", "alphaSymbol");

    const compact = await listToolsWith(repo, []);
    expect(compact.toolNames).toHaveLength(MCP_TOOL_NAMES.length);
    expect(compact.bytes).toBeLessThan(70_000);

    const full = await listToolsWith(repo, [], { CODEXA_MCP_OUTPUT_SCHEMA: "full" });
    expect(full.toolNames).toHaveLength(MCP_TOOL_NAMES.length);
    expect(full.bytes).toBeGreaterThan(compact.bytes);
    // The env override restores the deep self-describing schema.
    expect(full.contextPackOutputSchema).toContain("snapshotStatus");
    expect(full.contextPackOutputSchema).toContain("knownClean");
    expect(full.contextPackOutputSchema).toContain("commandCoverageClassifierVersion");
    expect(compact.contextPackOutputSchema).not.toContain("commandCoverageClassifierVersion");

    const core = await listToolsWith(repo, ["--tools", "core"]);
    expect([...core.toolNames].sort()).toEqual([...CORE_PROFILE_TOOL_NAMES].sort());
    expect(core.toolNames).not.toContain("callers");
    expect(core.bytes).toBeLessThan(30_000);
  }, 120_000);

it("compacts the text content block for responseFormat concise", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "codexa-mcp-concise-text-"));
    const repo = await createIndexedMcpRepo(workspace, "repo", "alpha", "alphaSymbol");
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(process.cwd(), "dist/cli.js"), "serve", repo, "--no-auto-refresh"],
      stderr: "pipe"
    });
    const client = new Client({ name: "codexa-concise-text-test", version: "0.1.0" });
    await client.connect(transport);
    try {
      const detailed = await client.callTool({ name: "task_brief", arguments: { task: "inspect alphaSymbol" } });
      const concise = await client.callTool({ name: "task_brief", arguments: { task: "inspect alphaSymbol", responseFormat: "concise" } });
      const detailedText = String((detailed.content as Array<{ type: string; text?: string }>)[0]?.text ?? "");
      const conciseTextResult = String((concise.content as Array<{ type: string; text?: string }>)[0]?.text ?? "");
      expect(conciseTextResult.length).toBeLessThanOrEqual(detailedText.length);
      if (detailedText.split(/\r?\n/).length > 30) {
        expect(conciseTextResult).toContain("[concise]");
        expect(conciseTextResult.split(/\r?\n/).length).toBeLessThanOrEqual(31);
      }
    } finally {
      await client.close();
    }
  }, 60_000);

it("conciseText truncates by lines and characters with an honest marker", () => {
    const longText = Array.from({ length: 50 }, (_, index) => `line ${index + 1}`).join("\n");
    const truncated = conciseText(longText);
    expect(truncated.split(/\r?\n/)).toHaveLength(31);
    expect(truncated).toContain("[concise] 20 more line(s) omitted");
    expect(truncated).toContain('responseFormat "detailed"');

    const shortText = "one\ntwo";
    expect(conciseText(shortText)).toBe(shortText);

    const longLine = "x".repeat(5_000);
    const clipped = conciseText(longLine);
    expect(clipped.length).toBeLessThan(2_600);
    expect(clipped).toContain("[concise]");
  });
});
