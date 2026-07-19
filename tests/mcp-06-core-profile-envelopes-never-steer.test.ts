import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { describe, expect, it } from "vitest";
import { conciseText } from "../src/mcp/compaction.js";
import { CORE_PROFILE_TOOL_NAMES, DISPATCHABLE_MCP_TOOL_NAMES } from "../src/mcp/tool-registry.js";
import { createIndexedMcpRepo } from "./mcp-fixtures.js";
describe("core profile guidance discipline", () => {
it("core-profile envelopes steer only to directly registered or dispatcher-callable tools", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "codexa-mcp-core-guidance-"));
    const repo = await createIndexedMcpRepo(workspace, "repo", "alpha", "alphaSymbol");
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(process.cwd(), "dist/cli.js"), "serve", repo, "--no-auto-refresh", "--tools", "core"],
      env: Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[0] !== "CODEXA_MANAGED_POST_EDIT" && typeof entry[1] === "string")),
      stderr: "pipe"
    });
    const client = new Client({ name: "codexa-core-guidance-test", version: "0.1.0" });
    await client.connect(transport);
    try {
      const core = new Set<string>(CORE_PROFILE_TOOL_NAMES);
      const dispatcherCallable = core.has("capabilities") ? new Set<string>(DISPATCHABLE_MCP_TOOL_NAMES) : new Set<string>();
      expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(CORE_PROFILE_TOOL_NAMES);

      const calls = [
        { toolName: "search", direct: true, arguments: { query: "alphaSymbol" } },
        { toolName: "change_plan", direct: true, arguments: { task: "change alphaSymbol", files: ["src/alpha.ts"], saveSnapshot: false } },
        { toolName: "session_context", direct: false, arguments: {} },
        { toolName: "task_brief", direct: false, arguments: { task: "change alphaSymbol", files: ["src/alpha.ts"], tokenBudget: 900, limit: 3 } }
      ];
      for (const call of calls) {
        const result = await client.callTool(call.direct
          ? { name: call.toolName, arguments: call.arguments }
          : { name: "capabilities", arguments: { action: "invoke", operation: call.toolName, arguments: call.arguments } });
        const structured = result.structuredContent as { data?: { nextTools?: unknown[]; nextCall?: { tool?: string } }; nextTools?: unknown[]; systemMessage?: string } | undefined;
        expect(structured?.data?.nextTools?.length ?? 0, `${call.toolName} nested too many follow-up tools`).toBeLessThanOrEqual(1);
        expect(["task_brief", "context_pack", "session_context"]).not.toContain(structured?.data?.nextCall?.tool);
        for (const entry of structured?.nextTools ?? []) {
          const name = typeof entry === "string" ? entry : (entry as { tool?: string })?.tool;
          if (typeof name === "string") {
            expect(core.has(name) || dispatcherCallable.has(name), `tool ${call.toolName} steered to unavailable ${name}`).toBe(true);
          }
        }
      }

      const exactSearch = await client.callTool({ name: "search", arguments: { query: "alphaSymbol", patterns: ["alphaSymbol"] } });
      const exactSearchEnvelope = exactSearch.structuredContent as { nextTools?: unknown[]; systemMessage?: string };
      expect(exactSearchEnvelope.nextTools).toEqual([]);
      expect(JSON.stringify(exactSearch)).toContain("Stop Codexa");

      const hooklessPlan = await client.callTool({
        name: "change_plan",
        arguments: { task: "change alphaSymbol API", files: ["src/alpha.ts"], saveSnapshot: true, taskId: "core-dispatch-plan" }
      });
      const planEnvelope = hooklessPlan.structuredContent as {
        data?: { nextTools?: Array<{ tool?: string; requiredInputs?: Record<string, unknown> }>; decisionKernel?: { nextTools?: Array<{ tool?: string }> } };
        lifecycle?: { nextTools?: string[] };
        nextTools?: Array<{ tool?: string; requiredInputs?: Record<string, unknown> }>;
      };
      const expectedDispatch = {
        action: "invoke",
        operation: "post_edit_review",
        arguments: { taskId: "core-dispatch-plan" }
      };
      expect(planEnvelope.nextTools).toEqual([
        expect.objectContaining({ tool: "capabilities", requiredInputs: expectedDispatch })
      ]);
      expect(planEnvelope.data?.nextTools).toEqual([
        expect.objectContaining({ tool: "capabilities", requiredInputs: expectedDispatch })
      ]);
      expect(planEnvelope.data?.decisionKernel?.nextTools).toEqual([
        expect.objectContaining({ tool: "capabilities" })
      ]);
      expect(planEnvelope.lifecycle?.nextTools).toEqual(["capabilities"]);
      const planText = hooklessPlan.content.find((entry) => entry.type === "text")?.text ?? "";
      expect(planText).toContain("Next: capabilities");
      expect(planText).not.toContain("Next: post_edit_review");

      const prompts = await client.listPrompts();
      const dirtyDiff = prompts.prompts.find((prompt) => prompt.name === "dirty_diff_review");
      expect(dirtyDiff).toBeTruthy();
      const rendered = await client.getPrompt({ name: "dirty_diff_review", arguments: {} });
      const promptText = JSON.stringify(rendered);
      expect(promptText).toContain("`capabilities`");
      expect(promptText).toContain('`operation: \\"post_edit_review\\"`');
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
