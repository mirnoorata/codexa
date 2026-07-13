import { execFileSync, spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  appendMcpOverheadTelemetry,
  finalizeMcpOverheadTelemetry,
  flushMcpOverheadTelemetry,
  mcpToolResultByteCounts,
  resetMcpOverheadTelemetryForTests,
  type McpOverheadTelemetryCompletionRecord,
  type McpOverheadTelemetryEvent
} from "../src/mcp/telemetry.js";
import { createIndexedMcpRepo } from "./mcp-fixtures.js";

const previousTelemetryPath = process.env.CODEXA_MCP_TELEMETRY_PATH;

afterEach(async () => {
  await flushMcpOverheadTelemetry();
  resetMcpOverheadTelemetryForTests();
  if (previousTelemetryPath === undefined) delete process.env.CODEXA_MCP_TELEMETRY_PATH;
  else process.env.CODEXA_MCP_TELEMETRY_PATH = previousTelemetryPath;
});

function event(sequence: number): McpOverheadTelemetryEvent {
  return {
    schemaVersion: 1,
    sequence,
    eventKind: "tool",
    logicalOperation: "task_brief",
    outcome: "ok",
    tool: "task_brief",
    profile: "core",
    requestedFormat: "auto",
    effectiveFormat: "concise",
    requestBytes: 2,
    textBytes: 10,
    structuredBytes: 20,
    totalBytes: 40,
    elapsedMs: 1,
    unchangedReceipt: false
  };
}

describe("MCP overhead telemetry", () => {
  it("writes off the response path and preserves UTF-8 byte accounting", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-mcp-telemetry-"));
    process.env.CODEXA_MCP_TELEMETRY_PATH = ".codex/cache/telemetry.jsonl";

    expect(appendMcpOverheadTelemetry(repo, event(1))).toBeUndefined();
    await flushMcpOverheadTelemetry();

    const telemetryPath = path.join(repo, ".codex/cache/telemetry.jsonl");
    const lines = (await readFile(telemetryPath, "utf8")).trim().split("\n");
    expect(lines.map((line) => JSON.parse(line))).toEqual([event(1)]);

    await finalizeMcpOverheadTelemetry(repo);
    await finalizeMcpOverheadTelemetry(repo);
    expect((await readFile(telemetryPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line))).toEqual([
      event(1),
      { schemaVersion: 1, recordKind: "session-complete", sequence: 2, eventCount: 1 }
    ]);

    const result = { content: [{ type: "text", text: "a💡" }], structuredContent: { value: "é" } };
    expect(mcpToolResultByteCounts(result)).toEqual({
      textBytes: Buffer.byteLength("a💡", "utf8"),
      structuredBytes: Buffer.byteLength(JSON.stringify(result.structuredContent), "utf8"),
      totalBytes: Buffer.byteLength(JSON.stringify(result), "utf8")
    });
  });

  it("refuses a pre-existing regular log without mutating prior evidence", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-mcp-telemetry-existing-"));
    const telemetryPath = path.join(repo, "telemetry.jsonl");
    const priorEvidence = `${JSON.stringify(event(1))}\n`;
    await writeFile(telemetryPath, priorEvidence, { encoding: "utf8", mode: 0o600 });
    process.env.CODEXA_MCP_TELEMETRY_PATH = telemetryPath;
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      appendMcpOverheadTelemetry(repo, event(1));
      await finalizeMcpOverheadTelemetry(repo);
      expect(await readFile(telemetryPath, "utf8")).toBe(priorEvidence);
      expect(errorLog).toHaveBeenCalledWith(expect.stringContaining("must be absent"));
    } finally {
      errorLog.mockRestore();
    }
  });

  it("leaves a valid prefix unfinalized when a later append fails", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-mcp-telemetry-failure-"));
    const telemetryPath = path.join(repo, "telemetry.jsonl");
    process.env.CODEXA_MCP_TELEMETRY_PATH = telemetryPath;
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      appendMcpOverheadTelemetry(repo, event(1));
      await flushMcpOverheadTelemetry();
      await chmod(telemetryPath, 0o400);

      appendMcpOverheadTelemetry(repo, event(2));
      await flushMcpOverheadTelemetry();
      await finalizeMcpOverheadTelemetry(repo);

      const records = (await readFile(telemetryPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
      expect(records).toEqual([event(1)]);
      expect(records.some((record) => record.recordKind === "session-complete")).toBe(false);
      expect(errorLog).toHaveBeenCalledWith(expect.stringContaining("Codexa MCP telemetry write failed"));
    } finally {
      await chmod(telemetryPath, 0o600).catch(() => undefined);
      errorLog.mockRestore();
    }
  });

  it("finalizes a clean zero-event session without inventing an event", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-mcp-telemetry-empty-"));
    process.env.CODEXA_MCP_TELEMETRY_PATH = "telemetry.jsonl";

    await finalizeMcpOverheadTelemetry(repo);

    expect(JSON.parse((await readFile(path.join(repo, "telemetry.jsonl"), "utf8")).trim())).toEqual({
      schemaVersion: 1,
      recordKind: "session-complete",
      sequence: 1,
      eventCount: 0
    });
  });

  it("finalizes only the requested repository path", async () => {
    const repoA = await mkdtemp(path.join(os.tmpdir(), "codexa-mcp-telemetry-repo-a-"));
    const repoB = await mkdtemp(path.join(os.tmpdir(), "codexa-mcp-telemetry-repo-b-"));
    process.env.CODEXA_MCP_TELEMETRY_PATH = "telemetry.jsonl";
    appendMcpOverheadTelemetry(repoA, event(1));
    appendMcpOverheadTelemetry(repoB, event(1));
    await flushMcpOverheadTelemetry();

    await finalizeMcpOverheadTelemetry(repoA);
    const recordsA = (await readFile(path.join(repoA, "telemetry.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    const recordsBBefore = (await readFile(path.join(repoB, "telemetry.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(recordsA.at(-1)).toEqual({ schemaVersion: 1, recordKind: "session-complete", sequence: 2, eventCount: 1 });
    expect(recordsBBefore).toEqual([event(1)]);

    appendMcpOverheadTelemetry(repoB, event(2));
    await finalizeMcpOverheadTelemetry(repoB);
    const recordsBAfter = (await readFile(path.join(repoB, "telemetry.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(recordsBAfter).toEqual([
      event(1),
      event(2),
      { schemaVersion: 1, recordKind: "session-complete", sequence: 3, eventCount: 2 }
    ]);
  });

  it("refuses symlinked telemetry files and parent directories without mutating their targets", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-mcp-telemetry-links-"));
    const outsideFile = path.join(await mkdtemp(path.join(os.tmpdir(), "codexa-mcp-telemetry-outside-file-")), "outside.txt");
    await writeFile(outsideFile, "sentinel", "utf8");
    const linkedFile = path.join(repo, "telemetry.jsonl");
    await symlink(outsideFile, linkedFile);
    process.env.CODEXA_MCP_TELEMETRY_PATH = linkedFile;
    appendMcpOverheadTelemetry(repo, event(1));
    await flushMcpOverheadTelemetry();
    expect(await readFile(outsideFile, "utf8")).toBe("sentinel");

    resetMcpOverheadTelemetryForTests();
    const outsideDirectory = await mkdtemp(path.join(os.tmpdir(), "codexa-mcp-telemetry-outside-dir-"));
    const linkedDirectory = path.join(repo, "linked-logs");
    await symlink(outsideDirectory, linkedDirectory);
    process.env.CODEXA_MCP_TELEMETRY_PATH = path.join(linkedDirectory, "telemetry.jsonl");
    appendMcpOverheadTelemetry(repo, event(1));
    await flushMcpOverheadTelemetry();
    expect(await readdir(outsideDirectory)).toEqual([]);
  });

  it.skipIf(process.platform === "win32")("fails boundedly when an active telemetry path is replaced by a FIFO", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-mcp-telemetry-fifo-swap-"));
    const moduleUrl = new URL("../src/mcp/telemetry.ts", import.meta.url).href;
    const source = `
      import { execFileSync } from "node:child_process";
      import { rm } from "node:fs/promises";
      import { appendMcpOverheadTelemetry, finalizeMcpOverheadTelemetry, flushMcpOverheadTelemetry } from ${JSON.stringify(moduleUrl)};
      const repo = ${JSON.stringify(repo)};
      const telemetryPath = ${JSON.stringify(path.join(repo, "telemetry.jsonl"))};
      process.env.CODEXA_MCP_TELEMETRY_PATH = telemetryPath;
      const first = ${JSON.stringify(event(1))};
      appendMcpOverheadTelemetry(repo, first);
      await flushMcpOverheadTelemetry();
      await rm(telemetryPath);
      execFileSync("mkfifo", [telemetryPath]);
      appendMcpOverheadTelemetry(repo, { ...first, sequence: 2 });
      await finalizeMcpOverheadTelemetry(repo);
      process.stdout.write("complete\\n");
    `;

    const outcome = await runTelemetryChild(source, 4_000);
    expect(outcome.timedOut).toBe(false);
    expect(outcome.code).toBe(0);
    expect(outcome.stdout).toBe("complete\n");
    expect(outcome.stderr).toContain("Codexa MCP telemetry write failed");
  }, 8_000);

  it("bounds bursts and emits a terminal partial marker without requiring a later event", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-mcp-telemetry-burst-"));
    process.env.CODEXA_MCP_TELEMETRY_PATH = "telemetry.jsonl";

    for (let sequence = 1; sequence <= 400; sequence += 1) {
      appendMcpOverheadTelemetry(repo, event(sequence));
    }
    await flushMcpOverheadTelemetry();

    const records = (await readFile(path.join(repo, "telemetry.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as McpOverheadTelemetryEvent);
    expect(records.length).toBeLessThanOrEqual(256);
    expect(records.at(-1)).toMatchObject({
      tool: "telemetry",
      logicalOperation: "writer-queue-overflow",
      outcome: "error",
      droppedBefore: 1,
      requestBytes: 0,
      totalBytes: 0
    });
  });

  it("stops at the analyzer record ceiling with an explicit partial-evidence marker", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-mcp-telemetry-cap-"));
    process.env.CODEXA_MCP_TELEMETRY_PATH = "telemetry.jsonl";

    for (let start = 1; start <= 999; start += 200) {
      for (let sequence = start; sequence < Math.min(start + 200, 1_000); sequence += 1) {
        appendMcpOverheadTelemetry(repo, event(sequence));
      }
      await flushMcpOverheadTelemetry();
    }
    appendMcpOverheadTelemetry(repo, event(1_000));
    appendMcpOverheadTelemetry(repo, event(1_001));
    await flushMcpOverheadTelemetry();

    const records = (await readFile(path.join(repo, "telemetry.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as McpOverheadTelemetryEvent);
    expect(records).toHaveLength(1_000);
    expect(records.at(-1)).toMatchObject({
      sequence: 1_000,
      tool: "telemetry",
      logicalOperation: "writer-cap-reached",
      outcome: "error",
      droppedBefore: 1,
      requestBytes: 0,
      totalBytes: 0
    });
  });

  it("records live dispatcher, freshness, and detailed-resource events without collapsing logical operations", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "codexa-mcp-telemetry-live-"));
    const repo = await createIndexedMcpRepo(workspace, "repo", "alpha", "alphaSymbol");
    const telemetryPath = path.join(workspace, "telemetry.jsonl");
    const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
    env.CODEXA_MCP_TELEMETRY_PATH = telemetryPath;
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(process.cwd(), "dist/cli.js"), "serve", repo, "--no-auto-refresh", "--tools", "core"],
      env,
      stderr: "pipe"
    });
    const client = new Client({ name: "codexa-telemetry-integration-test", version: "0.1.0" });
    await client.connect(transport);
    try {
      await client.callTool({ name: "freshness", arguments: {} });
      const dispatched = await client.callTool({
        name: "capabilities",
        arguments: { action: "invoke", operation: "repo_map", arguments: { limit: 3 } }
      });
      const envelope = dispatched.structuredContent as { data?: { delivery?: { resultUri?: string } } };
      const uri = envelope.data?.delivery?.resultUri;
      expect(uri).toMatch(/^codexa:\/\/repo\/mcp-results\/rr_[a-f0-9]{32}\/mr_[a-f0-9]{64}$/u);
      const resource = await client.readResource({ uri: uri! });
      const records = await waitForTelemetryRecords(telemetryPath, 3);

      expect(records.map((entry) => [entry.sequence, entry.eventKind ?? "tool", entry.tool, entry.logicalOperation, entry.outcome])).toEqual([
        [1, "tool", "freshness", "freshness", "ok"],
        [2, "tool", "capabilities", "repo_map", "ok"],
        [3, "resource-read", "read_mcp_resource", "mcp-detailed-result", "ok"]
      ]);
      expect(records[1]).toMatchObject({ requestedFormat: "auto", effectiveFormat: "concise" });
      const resourceText = resource.contents[0]?.text;
      expect(typeof resourceText).toBe("string");
      expect(records[2]).toMatchObject({
        requestedFormat: "detailed",
        effectiveFormat: "detailed",
        requestBytes: Buffer.byteLength(JSON.stringify({ server: "codexa", uri }), "utf8"),
        textBytes: Buffer.byteLength(resourceText as string, "utf8"),
        structuredBytes: 0,
        resultReference: uri,
        unchangedReceipt: false
      });
      expect(records[2]!.totalBytes).toBeGreaterThan(records[2]!.textBytes);
    } finally {
      await client.close();
    }
    expect(await waitForTelemetryCompletion(telemetryPath)).toEqual({
      schemaVersion: 1,
      recordKind: "session-complete",
      sequence: 4,
      eventCount: 3
    });
  }, 90_000);

  it("anchors a relative telemetry destination to the launch root across focus changes", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "codexa-mcp-telemetry-focus-"));
    execFileSync("git", ["init"], { cwd: workspace, stdio: "ignore" });
    const repoA = await createIndexedMcpRepo(workspace, "repo-a", "alpha", "alphaSymbol");
    const repoB = await createIndexedMcpRepo(workspace, "repo-b", "beta", "betaSymbol");
    const focusFile = path.join(workspace, ".codex", "WORKING.md");
    await mkdir(path.dirname(focusFile), { recursive: true });
    await writeFile(focusFile, `## Session\n\n- Focused project: \`${repoA}\`.\n`, "utf8");
    const relativeTelemetryPath = ".codex/cache/codexa-mcp-telemetry.jsonl";
    const telemetryPath = path.join(workspace, relativeTelemetryPath);
    const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
    env.CODEXA_MCP_TELEMETRY_PATH = relativeTelemetryPath;
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(process.cwd(), "dist/cli.js"), "serve", workspace, "--no-auto-refresh", "--tools", "full"],
      env,
      stderr: "pipe"
    });
    const client = new Client({ name: "codexa-telemetry-focus-routing-test", version: "0.1.0" });
    await client.connect(transport);
    try {
      const first = await client.callTool({ name: "freshness", arguments: {} });
      expect(JSON.stringify(first)).toContain(repoA);
      await writeFile(focusFile, `## Active Focus\n\n- Project: \`${repoB}\`\n`, "utf8");
      const second = await client.callTool({ name: "freshness", arguments: {} });
      expect(JSON.stringify(second)).toContain(repoB);
      expect((await waitForTelemetryRecords(telemetryPath, 2)).map((entry) => entry.sequence)).toEqual([1, 2]);
    } finally {
      await client.close();
    }

    expect(await waitForTelemetryCompletion(telemetryPath)).toEqual({
      schemaVersion: 1,
      recordKind: "session-complete",
      sequence: 3,
      eventCount: 2
    });
    await expect(readFile(path.join(repoA, relativeTelemetryPath), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(path.join(repoB, relativeTelemetryPath), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  }, 90_000);
});

async function waitForTelemetryRecords(filePath: string, count: number): Promise<McpOverheadTelemetryEvent[]> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const records = (await readFile(filePath, "utf8"))
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as McpOverheadTelemetryEvent);
      if (records.length >= count) return records;
    } catch {
      // The off-path writer may not have created the file yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${count} MCP telemetry records`);
}

async function waitForTelemetryCompletion(filePath: string): Promise<McpOverheadTelemetryCompletionRecord> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const records = (await readFile(filePath, "utf8"))
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as McpOverheadTelemetryEvent | McpOverheadTelemetryCompletionRecord);
      const completion = records.find((record): record is McpOverheadTelemetryCompletionRecord => "recordKind" in record);
      if (completion) return completion;
    } catch {
      // The transport close callback finalizes asynchronously.
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for MCP telemetry completion record");
}

async function runTelemetryChild(source: string, timeoutMs: number): Promise<{
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}> {
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", source], {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  let timedOut = false;
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr, timedOut });
    });
  });
}
