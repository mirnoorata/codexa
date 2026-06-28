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
it("reports package version and Codexa loop instructions during MCP initialization", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-mcp-server-info-"));
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
    const client = new Client({ name: "codexa-server-info-test", version: "0.1.0" });
    await client.connect(transport);
    try {
      expect(client.getServerVersion()).toMatchObject({ name: "codexa", version: CODEXA_VERSION });
      expect(client.getInstructions()).toContain(PRIMARY_CODEX_LOOP);
      expect(client.getInstructions()).toContain("post_edit_review");
      expect(client.getInstructions()).toContain("must not mutate source files");
    } finally {
      await client.close();
    }
  });

it("serves Codexa tools over explicit Streamable HTTP transport", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-mcp-http-"));
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    await mkdir(path.join(repo, "src"), { recursive: true });
    await writeFile(path.join(repo, "src/index.ts"), "export function httpMarker() { return 1 }\n", "utf8");
    execFileSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["-c", "user.name=Codexa", "-c", "user.email=codexa@example.invalid", "commit", "-m", "fixture"], {
      cwd: repo,
      stdio: "ignore"
    });
    await buildIndex({ repoRoot: repo });

    const child = spawn(process.execPath, [path.join(process.cwd(), "dist/cli.js"), "serve", repo, "--transport", "http", "--port", "0", "--no-auto-refresh"], {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"]
    });
    try {
      const ready = await waitForStderr(child, /http:\/\/127\.0\.0\.1:(\d+)\/mcp/u);
      const url = /http:\/\/127\.0\.0\.1:(\d+)\/mcp/u.exec(ready)?.[0];
      expect(url).toBeTruthy();
      const rejected = await fetch(url!, {
        method: "POST",
        headers: {
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
          origin: "https://evil.example"
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: "origin-test", method: "initialize", params: {} })
      });
      expect(rejected.status).toBe(403);
      expect(await rejected.text()).toContain("Origin");
      const rejectedNonWebOrigin = await fetch(url!, {
        method: "POST",
        headers: {
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
          origin: "file://localhost"
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: "origin-scheme-test", method: "initialize", params: {} })
      });
      expect(rejectedNonWebOrigin.status).toBe(403);
      expect(await rejectedNonWebOrigin.text()).toContain("Origin");
      // DNS-rebinding defense: a request that reaches loopback but carries a
      // non-loopback Host header must be rejected. (Raw http.request because
      // fetch/undici forbids overriding the Host header.)
      const rebindPort = Number(/:(\d+)\//u.exec(url!)![1]);
      const rejectedHost = await new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = http.request(
          { host: "127.0.0.1", port: rebindPort, path: "/mcp", method: "POST", headers: { accept: "application/json, text/event-stream", "content-type": "application/json", host: "evil.example" } },
          (res) => {
            let body = "";
            res.on("data", (chunk) => (body += chunk));
            res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
          }
        );
        req.on("error", reject);
        req.write(JSON.stringify({ jsonrpc: "2.0", id: "host-test", method: "initialize", params: {} }));
        req.end();
      });
      expect(rejectedHost.status).toBe(403);
      expect(rejectedHost.body).toContain("Host");
      const transport = new StreamableHTTPClientTransport(new URL(url!));
      const client = new Client({ name: "codexa-http-test", version: "0.1.0" });
      await client.connect(transport);
      try {
        expect(client.getServerVersion()).toMatchObject({ name: "codexa", version: CODEXA_VERSION });
        expect(client.getInstructions()).toContain(PRIMARY_CODEX_LOOP);
        const tools = await client.listTools();
        expect(tools.tools.map((tool) => tool.name)).toContain("search");
        const result = await client.callTool({ name: "search", arguments: { query: "httpMarker", limit: 3 } });
        expect(JSON.stringify(result)).toContain("httpMarker");
      } finally {
        await client.close();
      }
    } finally {
      await stopChild(child);
    }
  });

it("refuses Streamable HTTP binds on non-loopback hosts without auth", async () => {
    const child = spawn(process.execPath, [path.join(process.cwd(), "dist/cli.js"), "serve", process.cwd(), "--transport", "http", "--host", "0.0.0.0", "--port", "0", "--no-auto-refresh"], {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"]
    });
    const result = await waitForExit(child);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("requires a loopback host");
  });

it("can disable MCP session-memory auto-recording for a strict read-only launch", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-mcp-memory-off-"));
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
      args: [path.join(process.cwd(), "dist/cli.js"), "serve", repo, "--no-auto-refresh", "--session-memory", "off"],
      stderr: "pipe"
    });
    const client = new Client({ name: "codexa-test", version: "0.1.0" });
    await client.connect(transport);
    try {
      const tools = await client.listTools();
      expect(tools.tools.find((tool) => tool.name === "task_brief")?.annotations?.readOnlyHint).toBe(true);
      expect(tools.tools.find((tool) => tool.name === "task_brief")?.annotations?.idempotentHint).toBe(true);
      await client.callTool({ name: "task_brief", arguments: { task: "inspect main", tokenBudget: 900, limit: 5 } });
      await expect(readdir(path.join(repo, ".codex/cache/codexa-session-memory"))).rejects.toThrow();
    } finally {
      await client.close();
    }
  });

it("does not claim session-memory writes when only auto-refresh cache writes are possible", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-mcp-memory-off-refresh-"));
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
      args: [path.join(process.cwd(), "dist/cli.js"), "serve", repo, "--session-memory", "off"],
      stderr: "pipe"
    });
    const client = new Client({ name: "codexa-test", version: "0.1.0" });
    await client.connect(transport);
    try {
      const result = await client.callTool({ name: "task_brief", arguments: { task: "inspect main", tokenBudget: 900, limit: 5 } });
      const policy = (result.structuredContent as { toolPolicy?: { readOnly?: boolean; writeEffects?: string } }).toolPolicy;
      expect(policy).toMatchObject({
        readOnly: false,
        writeEffects: "index-cache-if-auto-refresh"
      });
      expect(policy?.writeEffects).not.toContain("session-memory-auto");
      await expect(readdir(path.join(repo, ".codex/cache/codexa-session-memory"))).rejects.toThrow();
    } finally {
      await client.close();
    }
  });

it("reports session_memory auto-refresh cache effects when auto-refresh is enabled", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-mcp-session-memory-refresh-"));
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
    const client = new Client({ name: "codexa-test", version: "0.1.0" });
    await client.connect(transport);
    try {
      const result = await client.callTool({ name: "session_memory", arguments: { action: "summary", limit: 3 } });
      expect((result.structuredContent as { toolPolicy?: { readOnly?: boolean; writeEffects?: string } }).toolPolicy).toMatchObject({
        readOnly: false,
        writeEffects: "index-cache-if-auto-refresh"
      });
      const remembered = await client.callTool({
        name: "session_memory",
        arguments: {
          action: "remember",
          entries: [
            {
              kind: "decision",
              summary: "Record a policy write for the MCP policy regression.",
              provenance: "agent-asserted",
              confidence: "heuristic",
              evidenceTier: "derived"
            }
          ]
        }
      });
      expect((remembered.structuredContent as { toolPolicy?: { writeEffects?: string } }).toolPolicy?.writeEffects).toBe("explicit-memory-cache+index-cache-if-auto-refresh");
    } finally {
      await client.close();
    }
  });

it("marks semantic OpenAI-capable MCP tools as open-world, including post_edit_review and proof_card", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-mcp-semantic-openworld-"));
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
      args: [path.join(process.cwd(), "dist/cli.js"), "serve", repo, "--no-auto-refresh", "--semantic", "--semantic-provider", "openai"],
      stderr: "pipe"
    });
    const client = new Client({ name: "codexa-test", version: "0.1.0" });
    await client.connect(transport);
    const tools = await client.listTools();
    expect(tools.tools.find((tool) => tool.name === "search")?.annotations?.openWorldHint).toBe(true);
    expect(tools.tools.find((tool) => tool.name === "change_plan")?.annotations?.openWorldHint).toBe(true);
    expect(tools.tools.find((tool) => tool.name === "post_edit_review")?.annotations?.openWorldHint).toBe(true);
    expect(tools.tools.find((tool) => tool.name === "proof_card")?.annotations?.openWorldHint).toBe(true);
    const postEditSchema = JSON.stringify(tools.tools.find((tool) => tool.name === "post_edit_review")?.inputSchema);
    expect(postEditSchema).toContain("semanticProvider");
    const proofCardSchema = JSON.stringify(tools.tools.find((tool) => tool.name === "proof_card")?.inputSchema);
    expect(proofCardSchema).toContain("semanticProvider");
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

it("rejects malformed structured waiver JSON with a friendly CLI error", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-cli-waiver-"));
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    const cli = path.join(process.cwd(), "dist/cli.js");
    expect(() =>
      execFileSync(process.execPath, [cli, "post-edit-review", repo, "--waiver", "{bad json"], {
        cwd: repo,
        encoding: "utf8",
        stdio: "pipe"
      })
    ).toThrow(/Invalid waiver JSON/);
    expect(() =>
      execFileSync(process.execPath, [cli, "post-edit-review", repo, "--ran-command-report", "{bad json"], {
        cwd: repo,
        encoding: "utf8",
        stdio: "pipe"
      })
    ).toThrow(/Invalid command report JSON/);
    expect(() =>
      execFileSync(
        process.execPath,
        [cli, "post-edit-review", repo, "--ran-command-report", JSON.stringify({ command: "npm test", cwd: repo, exitCode: 0, args: Array.from({ length: 81 }, (_, index) => String(index)) })],
        {
          cwd: repo,
          encoding: "utf8",
          stdio: "pipe"
        }
      )
    ).toThrow(/args exceeds 80 entries/);
    expect(() =>
      execFileSync(
        process.execPath,
        [cli, "post-edit-review", repo, "--ran-command-report", JSON.stringify({ command: "npm test", cwd: repo, exitCode: 0, stdoutSummary: "x".repeat(1001) })],
        {
          cwd: repo,
          encoding: "utf8",
          stdio: "pipe"
        }
      )
    ).toThrow(/stdoutSummary exceeds 1000 characters/);
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

it("keeps concurrent MCP tool calls bounded and JSON-RPC clean", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-mcp-concurrent-"));
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    await mkdir(path.join(repo, "src"), { recursive: true });
    await writeFile(path.join(repo, "src/index.ts"), "export function concurrentMarker() { return 1 }\n", "utf8");
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

    const [repoMap, search, contextPack, taskBrief, freshness] = await Promise.all([
      client.callTool({ name: "repo_map", arguments: { limit: 3 } }),
      client.callTool({ name: "search", arguments: { query: "concurrentMarker", limit: 3 } }),
      client.callTool({ name: "context_pack", arguments: { query: "concurrentMarker", tokenBudget: 900, limit: 4 } }),
      client.callTool({ name: "task_brief", arguments: { task: "change concurrent marker", files: ["src/index.ts"], tokenBudget: 900, limit: 4 } }),
      client.callTool({ name: "freshness", arguments: {} })
    ]);

    for (const result of [repoMap, search, contextPack, taskBrief]) {
      expect(JSON.stringify(result)).toContain("runtime");
      expect(JSON.stringify(result)).toContain("commandBudgetMs");
      expect(JSON.stringify(result)).toContain("provenance");
    }
    expect(JSON.stringify(freshness)).toContain("fresh");
    expect(Buffer.concat(stderrChunks).toString("utf8")).toContain("codexa MCP server ready");
    await client.close();
  });
});
