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
import { canonicalMcpDetailedProjection, conciseText } from "../src/mcp/compaction.js";
import { CORE_PROFILE_TOOL_NAMES, MCP_TOOL_NAMES, MCP_TOOL_REGISTRY } from "../src/mcp/tool-registry.js";
import { MCP_REGISTERED_TOOL_NAMES } from "../src/mcp/tools.js";
import { CURRENT_VERIFICATION_PROVENANCE, type QueryResult } from "../src/types.js";
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

it("defaults bare serve to core while explicit full remains available", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "codexa-mcp-token-"));
    const repo = await createIndexedMcpRepo(workspace, "repo", "alpha", "alphaSymbol");

    const defaultCore = await listToolsWith(repo, []);
    expect([...defaultCore.toolNames].sort()).toEqual([...CORE_PROFILE_TOOL_NAMES].sort());
    expect(defaultCore.bytes).toBeLessThan(30_000);
    const compact = await listToolsWith(repo, ["--tools", "full"]);
    expect(compact.toolNames).toHaveLength(MCP_TOOL_NAMES.length);
    expect(compact.bytes).toBeLessThan(70_000);

    const full = await listToolsWith(repo, ["--tools", "full"], { CODEXA_MCP_OUTPUT_SCHEMA: "full" });
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
      args: [path.join(process.cwd(), "dist/cli.js"), "serve", repo, "--no-auto-refresh", "--tools", "full"],
      stderr: "pipe"
    });
    const client = new Client({ name: "codexa-concise-text-test", version: "0.1.0" });
    await client.connect(transport);
    try {
      const detailed = await client.callTool({ name: "task_brief", arguments: { task: "inspect alphaSymbol", responseFormat: "detailed" } });
      const concise = await client.callTool({ name: "task_brief", arguments: { task: "inspect alphaSymbol", responseFormat: "concise" } });
      const detailedText = String((detailed.content as Array<{ type: string; text?: string }>)[0]?.text ?? "");
      const conciseTextResult = String((concise.content as Array<{ type: string; text?: string }>)[0]?.text ?? "");
      expect(conciseTextResult.length).toBeLessThanOrEqual(detailedText.length);
      if (detailedText.split(/\r?\n/).length > 30) {
        expect(conciseTextResult).toContain("concise decision receipt");
        expect(conciseTextResult).toContain("codexa://repo/mcp-results/");
        expect(conciseTextResult.split(/\r?\n/).length).toBeLessThanOrEqual(31);
      }
    } finally {
      await client.close();
    }
  }, 60_000);

it("keeps healthy exact-search stop receipts self-contained without a detailed artifact", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "codexa-mcp-exact-search-"));
    const repo = await createIndexedMcpRepo(workspace, "repo", "alpha", "alphaSymbol");
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(process.cwd(), "dist/cli.js"), "serve", repo, "--no-auto-refresh", "--session-memory", "off", "--tools", "core"],
      stderr: "pipe"
    });
    const client = new Client({ name: "codexa-exact-search-receipt-test", version: "0.1.0" });
    await client.connect(transport);
    try {
      for (const responseFormat of [undefined, "concise"] as const) {
        const result = await client.callTool({
          name: "search",
          arguments: { query: "alphaSymbol", limit: 3, ...(responseFormat ? { responseFormat } : {}) }
        });
        const data = (result.structuredContent as {
          data?: {
            actionability?: string;
            delivery?: { detailAvailable?: boolean; detailRequired?: boolean; resultId?: string; resultUri?: string };
          };
        }).data;
        expect(data).toMatchObject({
          actionability: "raw_search_sufficient",
          delivery: { detailAvailable: false, detailRequired: false }
        });
        expect(data?.delivery?.resultId).toBeUndefined();
        expect(data?.delivery?.resultUri).toBeUndefined();
        expect((result.content as Array<{ type?: string }>).some((entry) => entry.type === "resource_link")).toBe(false);
      }

      const degraded = await client.callTool({ name: "search", arguments: { query: "codexa_absent_exact_search_qxjv", limit: 3 } });
      const degradedData = (degraded.structuredContent as { data?: { delivery?: { resultUri?: string; requiredDetailReason?: string } } }).data;
      expect(degradedData?.delivery?.requiredDetailReason).toContain("low-context-quality");
      expect(degradedData?.delivery?.resultUri).toMatch(/^codexa:\/\/repo\/mcp-results\//u);
      expect((degraded.content as Array<{ type?: string }>).some((entry) => entry.type === "resource_link")).toBe(true);
    } finally {
      await client.close();
    }
  }, 60_000);

it("keeps clean read-first task briefs concise and names the concrete read target", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "codexa-mcp-read-first-"));
    const repo = await createIndexedMcpRepo(workspace, "repo", "alpha", "alphaSymbol");
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(process.cwd(), "dist/cli.js"), "serve", repo, "--no-auto-refresh", "--session-memory", "off", "--tools", "core"],
      stderr: "pipe"
    });
    const client = new Client({ name: "codexa-read-first-auto-test", version: "0.1.0" });
    await client.connect(transport);
    try {
      const result = await client.callTool({
        name: "capabilities",
        arguments: {
          action: "invoke",
          operation: "task_brief",
          arguments: { task: "Assess the implementation", files: ["src/alpha.ts"], tokenBudget: 900, limit: 3 }
        }
      });
      const data = (result.structuredContent as {
        data?: {
          actionability?: string;
          delivery?: { effectiveFormat?: string; resultUri?: string };
          decisionKernel?: { scope?: { nextReads?: string[]; focusFiles?: Array<{ path?: string }> } };
        };
      }).data;
      const text = String((result.content as Array<{ type: string; text?: string }>)[0]?.text ?? "");
      const readPaths = [...(data?.decisionKernel?.scope?.nextReads ?? []), ...(data?.decisionKernel?.scope?.focusFiles ?? []).flatMap((entry) => entry.path ? [entry.path] : [])];
      expect(data).toMatchObject({ actionability: "inspect_first", delivery: { effectiveFormat: "concise" } });
      expect(data?.delivery?.resultUri).toMatch(/^codexa:\/\/repo\/mcp-results\//u);
      expect(readPaths).toContain("src/alpha.ts");
      expect(text).toContain("Read first: src/alpha.ts");
    } finally {
      await client.close();
    }
  }, 60_000);

it("returns an unchanged receipt for an identical repeated automatic result", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "codexa-mcp-unchanged-"));
    const repo = await createIndexedMcpRepo(workspace, "repo", "alpha", "alphaSymbol");
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(process.cwd(), "dist/cli.js"), "serve", repo, "--no-auto-refresh", "--session-memory", "off"],
      stderr: "pipe"
    });
    const client = new Client({ name: "codexa-unchanged-receipt-test", version: "0.1.0" });
    await client.connect(transport);
    try {
      const request = { name: "capabilities", arguments: { action: "list" } } as const;
      const first = await client.callTool(request);
      const second = await client.callTool(request);
      const firstDelivery = ((first.structuredContent as { data?: { delivery?: Record<string, unknown> } })?.data?.delivery ?? {});
      const secondData = (second.structuredContent as { data?: { delivery?: Record<string, unknown> } })?.data;
      expect(firstDelivery).toMatchObject({ requestedFormat: "auto", effectiveFormat: "concise" });
      expect(firstDelivery.unchangedReceipt ?? false).toBe(false);
      expect(secondData?.delivery).toMatchObject({ requestedFormat: "auto", effectiveFormat: "concise", unchangedReceipt: true });
      expect(JSON.stringify(second)).toContain("unchanged from the prior receipt");
    } finally {
      await client.close();
    }
  }, 60_000);

it("returns an unchanged task_brief receipt with default session-memory recording enabled", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "codexa-mcp-unchanged-memory-"));
    const repo = await createIndexedMcpRepo(workspace, "repo", "alpha", "alphaSymbol");
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(process.cwd(), "dist/cli.js"), "serve", repo, "--no-auto-refresh"],
      stderr: "pipe"
    });
    const client = new Client({ name: "codexa-unchanged-memory-receipt-test", version: "0.1.0" });
    await client.connect(transport);
    try {
      const argumentsWithMemory = { task: "inspect alphaSymbol" } as const;
      const request = { name: "capabilities", arguments: { action: "invoke", operation: "task_brief", arguments: argumentsWithMemory } } as const;
      const first = await client.callTool(request);
      const second = await client.callTool(request);
      const third = await client.callTool(request);
      const firstDelivery = (first.structuredContent as { data?: { delivery?: Record<string, unknown> } })?.data?.delivery;
      const secondDelivery = (second.structuredContent as { data?: { delivery?: Record<string, unknown> } })?.data?.delivery;
      const thirdDelivery = (third.structuredContent as { data?: { delivery?: Record<string, unknown> } })?.data?.delivery;
      expect(firstDelivery).toMatchObject({ requestedFormat: "auto", effectiveFormat: "concise" });
      expect(firstDelivery?.unchangedReceipt ?? false).toBe(false);
      expect(firstDelivery?.resultId).toMatch(/^mr_[a-f0-9]{64}$/u);
      expect(secondDelivery).toMatchObject({
        requestedFormat: "auto",
        effectiveFormat: "concise"
      });
      expect(secondDelivery?.unchangedReceipt ?? false).toBe(false);
      expect(secondDelivery?.resultId).not.toBe(firstDelivery?.resultId);
      expect(thirdDelivery).toMatchObject({
        requestedFormat: "auto",
        effectiveFormat: "concise",
        resultId: secondDelivery?.resultId,
        unchangedReceipt: true
      });
      expect(JSON.stringify(third)).toContain("unchanged from the prior receipt");

      const memory = await client.callTool({
        name: "capabilities",
        arguments: {
          action: "invoke",
          operation: "session_memory",
          arguments: { action: "summary", responseFormat: "detailed" }
        }
      });
      expect((memory.structuredContent as { data?: { revision?: number } }).data?.revision).toBe(1);
    } finally {
      await client.close();
    }
  }, 60_000);

it("canonicalizes only occurrence timing in canonical detailed projections", () => {
    const packet = {
      freshness: freshnessFixture(),
      text: "detailed evidence",
      data: {
        mode: "task_brief",
        session: {
          commandBudgetMs: 10_000,
          provenance: ["index:2026-07-13T00:00:00.000Z", "command:git:ok:3ms", "changed-files:0"]
        },
        runtime: {
          commandBudgetMs: 10_000,
          commandBudgetUsedMs: 7,
          commandBudgetRemainingMs: 9_993,
          resultBytes: 1234,
          warnings: ["retained warning"],
          provenance: ["git:abc", "command:git:ok:3ms"]
        }
      }
    } as QueryResult;

    const projected = canonicalMcpDetailedProjection(packet);
    const data = projected.data as {
      session?: { provenance?: string[] };
      runtime?: Record<string, unknown> & { provenance?: string[]; warnings?: string[] };
    };
    expect(data.session?.provenance).toEqual(["index:2026-07-13T00:00:00.000Z", "command:git:ok", "changed-files:0"]);
    expect(data.runtime).toMatchObject({
      commandBudgetMs: 10_000,
      resultBytes: 1234,
      warnings: ["retained warning"],
      provenance: ["git:abc", "command:git:ok"]
    });
    expect(data.runtime).not.toHaveProperty("commandBudgetUsedMs");
    expect(data.runtime).not.toHaveProperty("commandBudgetRemainingMs");
    expect((projected.data as { mcp: { returnedBytes: number } }).mcp.returnedBytes).toBe(serializedBytes(projected.data));
    expect((packet.data as { runtime: Record<string, unknown> }).runtime.commandBudgetUsedMs).toBe(7);

    const timingOnlyVariant = canonicalMcpDetailedProjection({
      ...packet,
      data: {
        ...(packet.data as Record<string, unknown>),
        session: {
          ...(packet.data as { session: Record<string, unknown> }).session,
          provenance: ["index:2026-07-13T00:00:00.000Z", "command:git:ok:987ms", "changed-files:0"]
        },
        runtime: {
          ...(packet.data as { runtime: Record<string, unknown> }).runtime,
          commandBudgetUsedMs: 987,
          commandBudgetRemainingMs: 9_013,
          provenance: ["git:abc", "command:git:ok:987ms"]
        }
      }
    });
    expect(timingOnlyVariant).toEqual(projected);

    const failedCommand = canonicalMcpDetailedProjection({
      ...packet,
      data: {
        ...(packet.data as Record<string, unknown>),
        runtime: {
          ...(packet.data as { runtime: Record<string, unknown> }).runtime,
          provenance: ["git:abc", "command:git:not-ok:3ms"]
        }
      }
    });
    expect((failedCommand.data as { runtime: { provenance: string[] } }).runtime.provenance).toContain("command:git:not-ok");
    expect(failedCommand).not.toEqual(projected);
  });

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
