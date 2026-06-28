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
describe("core profile guidance discipline", () => {
it("core-profile envelopes never steer to unregistered tools", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "codexa-mcp-core-guidance-"));
    const repo = await createIndexedMcpRepo(workspace, "repo", "alpha", "alphaSymbol");
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(process.cwd(), "dist/cli.js"), "serve", repo, "--no-auto-refresh", "--tools", "core"],
      stderr: "pipe"
    });
    const client = new Client({ name: "codexa-core-guidance-test", version: "0.1.0" });
    await client.connect(transport);
    try {
      const core = new Set<string>(CORE_PROFILE_TOOL_NAMES);
      for (const toolName of ["session_context", "task_brief", "search"]) {
        const result = await client.callTool({ name: toolName, arguments: toolName === "search" ? { query: "alphaSymbol" } : {} });
        const structured = result.structuredContent as { nextTools?: unknown[]; systemMessage?: string } | undefined;
        for (const entry of structured?.nextTools ?? []) {
          const name = typeof entry === "string" ? entry : (entry as { tool?: string })?.tool;
          if (typeof name === "string") {
            expect(core.has(name), `tool ${toolName} steered to unregistered ${name}`).toBe(true);
          }
        }
      }
      const prompts = await client.listPrompts();
      const dirtyDiff = prompts.prompts.find((prompt) => prompt.name === "dirty_diff_review");
      expect(dirtyDiff).toBeTruthy();
      const rendered = await client.getPrompt({ name: "dirty_diff_review", arguments: {} });
      const promptText = JSON.stringify(rendered);
      expect(promptText).not.toContain("diff_impact");
    } finally {
      await client.close();
    }
  }, 90_000);

it("conciseText passes short and CRLF text through byte-identical", () => {
    const crlf = "Verdict: proceed\r\nline2\r\nline3";
    expect(conciseText(crlf)).toBe(crlf);
    expect(conciseText("just one line")).toBe("just one line");
  });
});
