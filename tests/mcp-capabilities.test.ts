import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { describe, expect, it } from "vitest";
import { CORE_PROFILE_TOOL_NAMES, DISPATCHABLE_MCP_TOOL_NAMES } from "../src/mcp/tool-registry.js";
import { createIndexedMcpRepo } from "./mcp-fixtures.js";

type ToolResult = Awaited<ReturnType<Client["callTool"]>>;

describe("MCP capability dispatcher parity", () => {
  it("exposes the exact non-core manifest and preserves direct runtime envelopes", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "codexa-capabilities-"));
    const repo = await createIndexedMcpRepo(workspace, "repo", "alpha", "alphaSymbol");
    const { client, close } = await connect(repo, "full");
    try {
      const listedTools = await client.listTools();
      const directDispatchable = listedTools.tools.map((tool) => tool.name).filter((name) => (DISPATCHABLE_MCP_TOOL_NAMES as readonly string[]).includes(name)).sort();
      expect(directDispatchable).toEqual([...DISPATCHABLE_MCP_TOOL_NAMES].sort());

      const manifestResult = await client.callTool({ name: "capabilities", arguments: { action: "list", responseFormat: "detailed" } });
      const manifest = queryData(manifestResult) as { capabilityHash: string; operationCount: number; operations: Array<{ name: string; schemaHash: string }> };
      expect(manifest.operations.map((entry) => entry.name).sort()).toEqual([...DISPATCHABLE_MCP_TOOL_NAMES].sort());
      expect(manifest.operationCount).toBe(DISPATCHABLE_MCP_TOOL_NAMES.length);
      for (const operation of manifest.operations) {
        const direct = listedTools.tools.find((tool) => tool.name === operation.name);
        expect(direct, operation.name).toBeDefined();
        expect(operation.schemaHash, operation.name).toBe(hashCanonical(direct!.inputSchema));
      }
      expect(manifest.capabilityHash).toMatch(/^[a-f0-9]{64}$/u);
      expect(manifest.capabilityHash).toBe(createHash("sha256").update(JSON.stringify(manifest.operations)).digest("hex"));

      const representative: Array<{ operation: string; arguments: Record<string, unknown> }> = [
        { operation: "session_context", arguments: { responseFormat: "detailed" } },
        { operation: "task_brief", arguments: { task: "inspect alphaSymbol", files: ["src/alpha.ts"], tokenBudget: 900, limit: 3, responseFormat: "detailed" } },
        { operation: "repo_map", arguments: { limit: 3, responseFormat: "detailed" } },
        { operation: "callers", arguments: { symbol: "alphaSymbol", limit: 5, responseFormat: "detailed" } },
        { operation: "workflow_path", arguments: { symbol: "alphaSymbol", limit: 3, responseFormat: "detailed" } },
        { operation: "session_memory", arguments: { action: "summary", limit: 3, responseFormat: "detailed" } },
        { operation: "placeholder_report", arguments: { includeTests: true, limit: 5, responseFormat: "detailed" } }
      ];
      for (const entry of representative) {
        const direct = await client.callTool({ name: entry.operation, arguments: entry.arguments });
        const dispatched = await client.callTool({
          name: "capabilities",
          arguments: { action: "invoke", operation: entry.operation, arguments: entry.arguments }
        });
        expect(normalizeDynamicSessionIds(dispatched.structuredContent), entry.operation).toEqual(normalizeDynamicSessionIds(direct.structuredContent));
        expect(normalizeDynamicSessionIds(textContent(dispatched)), entry.operation).toBe(normalizeDynamicSessionIds(textContent(direct)));
      }
    } finally {
      await close();
    }
  }, 120_000);

  it("honors outer-only, inner-only, and matching response formats for string-context operations", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "codexa-capability-format-"));
    const repo = await createIndexedMcpRepo(workspace, "repo", "alpha", "alphaSymbol");
    const { client, close } = await connect(repo, "core");
    try {
      expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(CORE_PROFILE_TOOL_NAMES);
      const autoList = await client.callTool({ name: "capabilities", arguments: { action: "list" } });
      for (const operation of DISPATCHABLE_MCP_TOOL_NAMES) expect(textContent(autoList)).toContain(operation);
      expect(delivery(autoList)).toMatchObject({ requestedFormat: "auto", effectiveFormat: "concise" });

      const calls = [
        { action: "invoke", operation: "repo_map", arguments: { limit: 3 }, responseFormat: "detailed" },
        { action: "invoke", operation: "repo_map", arguments: { limit: 3, responseFormat: "detailed" } },
        { action: "invoke", operation: "repo_map", arguments: { limit: 3, responseFormat: "detailed" }, responseFormat: "detailed" }
      ];
      for (const argumentsValue of calls) {
        const result = await client.callTool({ name: "capabilities", arguments: argumentsValue });
        expect(delivery(result)).toMatchObject({ requestedFormat: "detailed", effectiveFormat: "detailed" });
      }
      const conflict = await captureFailure(() => client.callTool({
        name: "capabilities",
        arguments: { action: "invoke", operation: "repo_map", arguments: { responseFormat: "concise" }, responseFormat: "detailed" }
      }));
      expect(conflict).toMatch(/Conflicting responseFormat/u);
    } finally {
      await close();
    }
  }, 90_000);

  it("describes nested session-memory inputs deeply enough to construct a valid invocation", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "codexa-capability-schema-"));
    const repo = await createIndexedMcpRepo(workspace, "repo", "alpha", "alphaSymbol");
    const { client, close } = await connect(repo, "full");
    try {
      const describedResult = await client.callTool({
        name: "capabilities",
        arguments: { action: "describe", operation: "session_memory", responseFormat: "detailed" }
      });
      const describedPacket = (queryData(describedResult) as { described: { schema: CapabilitySchema; schemaHash: string } }).described;
      const described = describedPacket.schema;
      const direct = (await client.listTools()).tools.find((tool) => tool.name === "session_memory");
      expect(direct).toBeDefined();
      expect(described).toEqual(JSON.parse(canonicalJson(direct!.inputSchema)));
      expect(describedPacket.schemaHash).toBe(hashCanonical(direct!.inputSchema));
      const entry = described.properties.entries?.items;
      expect(entry?.required).toEqual(expect.arrayContaining(["kind", "summary", "confidence", "evidenceTier"]));
      expect(Object.keys(entry?.properties ?? {})).toEqual(expect.arrayContaining(["scope", "evidence"]));
      const ref = entry?.properties?.scope?.properties?.refs?.items;
      expect(ref?.required).toEqual(expect.arrayContaining(["kind", "id", "evidenceTier", "confidence"]));
      expect(Object.keys(ref?.properties ?? {})).toEqual(expect.arrayContaining(["kind", "id", "path", "edgeKind"]));
      const range = entry?.properties?.evidence?.items?.properties?.range;
      expect(range?.required).toEqual(expect.arrayContaining(["startLine", "endLine", "startByte", "endByte"]));
      expect(Object.keys(range?.properties ?? {})).toEqual(expect.arrayContaining(["startLine", "endLine", "startByte", "endByte"]));

      const autoDescription = await client.callTool({ name: "capabilities", arguments: { action: "describe", operation: "session_memory" } });
      expect(delivery(autoDescription)).toMatchObject({ requestedFormat: "auto", effectiveFormat: "concise", resultUri: expect.stringMatching(/^codexa:\/\/repo\/mcp-results\//u) });
      expect(textContent(autoDescription)).toContain("Capability: session_memory");
      expect(textContent(autoDescription)).toContain(describedPacket.schemaHash);

      const result = await client.callTool({
        name: "capabilities",
        arguments: {
          action: "invoke",
          operation: "session_memory",
          responseFormat: "detailed",
          arguments: {
            action: "remember",
            sessionId: "capability-schema-session",
            entries: [{
              kind: firstEnum(entry?.properties?.kind),
              summary: "dispatcher schema retained nested session-memory contracts",
              confidence: firstEnum(entry?.properties?.confidence),
              evidenceTier: firstEnum(entry?.properties?.evidenceTier),
              scope: {
                refs: [{
                  kind: firstEnum(ref?.properties?.kind),
                  id: "src/alpha.ts",
                  path: "src/alpha.ts",
                  evidenceTier: firstEnum(ref?.properties?.evidenceTier),
                  confidence: firstEnum(ref?.properties?.confidence)
                }]
              }
            }]
          }
        }
      });
      expect(textContent(result)).not.toMatch(/error|invalid arguments/iu);
      expect(delivery(result)).toMatchObject({ requestedFormat: "detailed", effectiveFormat: "detailed" });
    } finally {
      await close();
    }
  }, 90_000);

  it("normalizes invalid direct and dispatched inputs to the same operation-schema issue", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "codexa-capability-invalid-"));
    const repo = await createIndexedMcpRepo(workspace, "repo", "alpha", "alphaSymbol");
    const { client, close } = await connect(repo, "full");
    try {
      const direct = await captureFailure(() => client.callTool({ name: "repo_map", arguments: { limit: 0 } }));
      const dispatched = await captureFailure(() => client.callTool({ name: "capabilities", arguments: { action: "invoke", operation: "repo_map", arguments: { limit: 0 } } }));
      for (const failure of [direct, dispatched]) {
        expect(failure).toMatch(/limit/u);
        expect(failure).toMatch(/too_small|greater than or equal to 1|positive/iu);
      }
    } finally {
      await close();
    }
  }, 90_000);
});

interface CapabilitySchema {
  required?: string[];
  enum?: unknown[];
  properties: Record<string, CapabilitySchema | undefined>;
  items?: CapabilitySchema;
}

async function connect(repo: string, profile: "core" | "full"): Promise<{ client: Client; close: () => Promise<void> }> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(process.cwd(), "dist/cli.js"), "serve", repo, "--no-auto-refresh", "--session-memory", "off", "--tools", profile],
    stderr: "pipe"
  });
  const client = new Client({ name: "codexa-capability-parity-test", version: "0.1.0" });
  await client.connect(transport);
  return { client, close: () => client.close() };
}

function queryData(result: ToolResult): Record<string, unknown> {
  const envelope = result.structuredContent as { data?: unknown } | undefined;
  if (!envelope?.data || typeof envelope.data !== "object" || Array.isArray(envelope.data)) throw new Error("missing Codexa query data");
  return envelope.data as Record<string, unknown>;
}

function delivery(result: ToolResult): Record<string, unknown> {
  const value = queryData(result).delivery;
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function textContent(result: ToolResult): string {
  const first = Array.isArray(result.content) ? result.content[0] as { text?: unknown } | undefined : undefined;
  return typeof first?.text === "string" ? first.text : "";
}

async function captureFailure(invoke: () => Promise<ToolResult>): Promise<string> {
  try {
    const result = await invoke();
    return JSON.stringify(result);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function firstEnum(value: CapabilitySchema | undefined): unknown {
  const first = value?.enum?.[0];
  if (first === undefined) throw new Error("described enum is missing");
  return first;
}

function normalizeDynamicSessionIds<T>(value: T): T {
  return JSON.parse(
    JSON.stringify(value)
      .replace(/session-\d{14}-[a-f0-9]{8}/gu, "session-<dynamic>")
      .replace(/"revision":\d+/gu, '"revision":"<dynamic>"')
  ) as T;
}

function hashCanonical(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error("non-JSON schema value");
  return serialized;
}
