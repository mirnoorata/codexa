import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { describe, expect, it } from "vitest";
import { conciseText } from "../src/mcp/compaction.js";
import { buildIndex } from "../src/indexer.js";
import { MCP_TOOL_RESULT_MAX_BYTES } from "../src/mcp/result-budget.js";
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
        expect(structured?.data?.nextTools, `${call.toolName} duplicated the top-level follow-up contract`).toBeUndefined();
        expect(["task_brief", "context_pack", "session_context"]).not.toContain(structured?.data?.nextCall?.tool);
        for (const entry of structured?.nextTools ?? []) {
          const name = typeof entry === "string" ? entry : (entry as { tool?: string })?.tool;
          if (typeof name === "string") {
            expect(core.has(name) || dispatcherCallable.has(name), `tool ${call.toolName} steered to unavailable ${name}`).toBe(true);
          }
        }
      }

      const callersFocus = await client.callTool({
        name: "capabilities",
        arguments: {
          action: "invoke",
          operation: "focus_brief",
          arguments: { task: "callers for src/alpha.ts", diff: false, limit: 4, tokenBudget: 900, responseFormat: "detailed" }
        }
      });
      const callersEnvelope = callersFocus.structuredContent as {
        data?: {
          nextCall?: { tool?: string; arguments?: Record<string, unknown> };
          retrieval?: { intentConfidence?: { recommendedNextTool?: string; recommendedOperation?: string } };
          decisionKernel?: { scope?: { nextCall?: { tool?: string; status?: string; arguments?: Record<string, unknown> } } };
        };
      };
      const expectedCallersDispatch = { action: "invoke", operation: "callers", arguments: { file: "src/alpha.ts" } };
      expect(callersEnvelope.data?.nextCall).toMatchObject({ tool: "capabilities", arguments: expectedCallersDispatch });
      expect(callersEnvelope.data?.retrieval?.intentConfidence).toMatchObject({ recommendedNextTool: "capabilities", recommendedOperation: "callers" });
      expect(callersEnvelope.data?.decisionKernel?.scope?.nextCall).toEqual({ tool: "capabilities", status: "executable" });
      expect(callersEnvelope.data?.decisionKernel?.scope?.nextCall?.arguments).toBeUndefined();
      const callersText = callersFocus.content.find((entry) => entry.type === "text")?.text ?? "";
      expect(callersText).toContain("capabilities");
      expect(callersText).toContain("data.nextCall");
      expect(callersText).not.toContain('"arguments":{"file":"src/alpha.ts"}');
      expect(callersText).not.toMatch(/(?:call|invoke|use)\s+`?callers`?/iu);

      const dispatchedCallers = await client.callTool({
        name: "capabilities",
        arguments: { action: "invoke", operation: "callers", arguments: { file: "src/alpha.ts" } }
      });
      const callersPolicy = (dispatchedCallers.structuredContent as { toolPolicy?: { avoidWhen?: string } }).toolPolicy;
      expect(callersPolicy?.avoidWhen).toContain("direct source inspection");
      expect(callersPolicy?.avoidWhen).not.toMatch(/(?:call|invoke|run|use)\s+`?callees`?/iu);

      const exactSearch = await client.callTool({ name: "search", arguments: { query: "alphaSymbol", patterns: ["alphaSymbol"] } });
      const exactSearchEnvelope = exactSearch.structuredContent as { nextTools?: unknown[]; systemMessage?: string };
      expect(exactSearchEnvelope.nextTools).toEqual([]);
      expect(JSON.stringify(exactSearch)).toContain("Stop Codexa");

      const cleanDirtyScope = await client.callTool({
        name: "capabilities",
        arguments: {
          action: "invoke",
          operation: "focus_brief",
          arguments: { task: "Fix current changes", diff: true, limit: 6, tokenBudget: 1000, responseFormat: "detailed" }
        }
      });
      const cleanDirtyScopeEnvelope = cleanDirtyScope.structuredContent as {
        data?: {
          nextCall?: { tool?: string };
          retrieval?: { intentConfidence?: { recommendedNextTool?: string } };
          decisionKernel?: { scope?: { nextCall?: { tool?: string } } };
        };
        systemMessage?: string;
      };
      expect(cleanDirtyScopeEnvelope.data?.nextCall).toMatchObject({ tool: "none" });
      expect(cleanDirtyScopeEnvelope.data?.retrieval?.intentConfidence?.recommendedNextTool).toBe("none");
      expect(cleanDirtyScopeEnvelope.data?.decisionKernel?.scope?.nextCall).toMatchObject({ tool: "none" });
      expect(cleanDirtyScopeEnvelope.systemMessage).toContain("worktree is clean");
      expect(JSON.stringify(cleanDirtyScope)).not.toContain('"operation":"none"');

      const hooklessPlan = await client.callTool({
        name: "change_plan",
        arguments: { task: "change alphaSymbol API", files: ["src/alpha.ts"], saveSnapshot: true, taskId: "core-dispatch-plan" }
      });
      const planEnvelope = hooklessPlan.structuredContent as {
        data?: { nextTools?: unknown[]; decisionKernel?: { nextTools?: string[] }; steps?: string[] };
        lifecycle?: { nextTools?: string[] };
        nextTools?: Array<{ tool?: string; requiredInputs?: Record<string, unknown> }>;
        systemMessage?: string;
      };
      const expectedDispatch = {
        action: "invoke",
        operation: "post_edit_review",
        arguments: { taskId: "core-dispatch-plan" }
      };
      expect(planEnvelope.nextTools).toEqual([
        expect.objectContaining({ tool: "capabilities", requiredInputs: expectedDispatch })
      ]);
      expect(planEnvelope.data?.nextTools).toBeUndefined();
      expect(planEnvelope.data?.decisionKernel?.nextTools).toEqual(["capabilities"]);
      expect(planEnvelope.lifecycle?.nextTools).toEqual(["capabilities"]);
      expect(planEnvelope.systemMessage).toContain("top-level nextTools contract");
      const serializedPlanEnvelope = JSON.stringify(planEnvelope);
      const serializedRequiredInputs = `"requiredInputs":${JSON.stringify(expectedDispatch)}`;
      expect(serializedPlanEnvelope.split(serializedRequiredInputs)).toHaveLength(2);
      expect(JSON.stringify(planEnvelope.data?.steps)).not.toMatch(/(?:call|run|use)\s+`?(?:post_edit_review|workflow_path|callers|callees|dependency_path)`?/iu);
      expect(JSON.stringify(planEnvelope.data?.steps)).not.toContain("capabilities(action=invoke");
      const planText = hooklessPlan.content.find((entry) => entry.type === "text")?.text ?? "";
      expect(planText).toContain("Next: capabilities");
      expect(planText).not.toContain("Next: post_edit_review");

      const hooklessReview = await client.callTool({
        name: "capabilities",
        arguments: {
          action: "invoke",
          operation: "post_edit_review",
          arguments: { taskId: "core-dispatch-plan", responseFormat: "detailed" }
        }
      });
      const reviewEnvelope = hooklessReview.structuredContent as { data?: { nextActions?: string[] }; systemMessage?: string };
      const reviewGuidance = JSON.stringify({ nextActions: reviewEnvelope.data?.nextActions, systemMessage: reviewEnvelope.systemMessage });
      expect(reviewGuidance).not.toMatch(/(?:call|invoke|run|use)\s+`?(?:workflow_path|callers|callees|dependency_path|post_edit_review)`?/iu);
      expect(reviewGuidance).not.toContain("capabilities(action=invoke");

      const prompts = await client.listPrompts();
      const dirtyDiff = prompts.prompts.find((prompt) => prompt.name === "dirty_diff_review");
      expect(dirtyDiff).toBeTruthy();
      const rendered = await client.getPrompt({ name: "dirty_diff_review", arguments: {} });
      const promptText = JSON.stringify(rendered);
      expect(promptText).toContain("`capabilities`");
      expect(promptText).toContain('`operation: \\"post_edit_review\\"`');
      expect(promptText).toContain('`operation: \\"diff_impact\\"`');
      expect(promptText).toContain('`operation: \\"test_plan\\"`');
      expect(promptText).toContain('`arguments: {}`');
      expect(promptText).toContain('`arguments: {\\"diff\\":true}`');
      expect(promptText).toContain("render this prompt again with `taskId`");
      expect(promptText).not.toMatch(/(?:call|invoke|run|use)\s+`?(?:post_edit_review|diff_impact|test_plan)`?/iu);

      const boundDirtyDiff = await client.getPrompt({ name: "dirty_diff_review", arguments: { taskId: "core-dispatch-plan" } });
      expect(JSON.stringify(boundDirtyDiff)).toContain('`arguments: {\\"taskId\\":\\"core-dispatch-plan\\"}`');

      const snapshotPrompt = await client.getPrompt({ name: "snapshot_edit_loop", arguments: { task: "change alpha", target: "src/alpha.ts" } });
      const snapshotText = JSON.stringify(snapshotPrompt);
      expect(snapshotText).toContain('`operation: \\"post_edit_review\\"`');
      expect(snapshotText).toContain('`arguments: {\\"taskId\\":\\"<saved taskId>\\"}`');
      expect(snapshotText).not.toMatch(/(?:call|invoke|run|use)\s+`?post_edit_review`?/iu);

      const impactPrompt = await client.getPrompt({ name: "impact_before_edit", arguments: { target: "src/alpha.ts", targetKind: "file" } });
      const impactText = JSON.stringify(impactPrompt);
      expect(impactText).toContain('`operation: \\"impact\\"`');
      expect(impactText).toContain('`arguments: {\\"file\\":\\"src/alpha.ts\\"}`');

      const extensionlessImpactPrompt = await client.getPrompt({ name: "impact_before_edit", arguments: { target: "Makefile" } });
      const extensionlessImpactText = JSON.stringify(extensionlessImpactPrompt);
      expect(extensionlessImpactText).toContain('`arguments: {\\"file\\":\\"Makefile\\"}`');
      expect(extensionlessImpactText).toContain('`arguments: {\\"symbol\\":\\"Makefile\\"}`');

      const dottedImpactPrompt = await client.getPrompt({ name: "impact_before_edit", arguments: { target: "Alpha.run" } });
      const dottedImpactText = JSON.stringify(dottedImpactPrompt);
      expect(dottedImpactText).toContain('`arguments: {\\"file\\":\\"Alpha.run\\"}`');
      expect(dottedImpactText).toContain('`arguments: {\\"symbol\\":\\"Alpha.run\\"}`');

      await Promise.all(Array.from({ length: 180 }, async (_, index) => {
        const suffix = String(index).padStart(3, "0");
        await writeFile(
          path.join(repo, "src", `caller-${suffix}-${"bounded-".repeat(8)}.ts`),
          `import { alphaSymbol } from "./alpha.js";\nexport const caller${suffix} = () => alphaSymbol();\n`,
          "utf8"
        );
      }));
      // Index the dirty caller graph in-place. Matching indexed dirty hashes
      // keep authority fresh while the large freshness payload exercises the
      // serialized ToolResult budget through a real core stdio call.
      await buildIndex({ repoRoot: repo });
      const oversizedCallers = await client.callTool({
        name: "capabilities",
        arguments: {
          action: "invoke",
          operation: "focus_brief",
          arguments: { task: "Callers for src/alpha.ts", diff: false, limit: 30, tokenBudget: 8000 }
        }
      });
      const oversizedEnvelope = oversizedCallers.structuredContent as {
        data?: {
          nextCall?: { tool?: string; arguments?: Record<string, unknown> };
          systemMessage?: string;
          decisionKernel?: { scope?: { nextCall?: { tool?: string; status?: string; arguments?: unknown } }; systemMessage?: string };
        };
        lifecycle?: { nextTools?: string[] };
        nextTools?: unknown[];
        systemMessage?: string;
        truncation?: { "__mcp.toolResultBudget"?: { total?: number; returned?: number } };
      };
      expect(Buffer.byteLength(JSON.stringify(oversizedCallers), "utf8")).toBeLessThanOrEqual(MCP_TOOL_RESULT_MAX_BYTES);
      expect(oversizedEnvelope.truncation?.["__mcp.toolResultBudget"]?.total).toBeGreaterThan(MCP_TOOL_RESULT_MAX_BYTES);
      expect(oversizedEnvelope.data?.nextCall).toMatchObject({ tool: "capabilities", arguments: expectedCallersDispatch });
      expect(oversizedEnvelope.data?.decisionKernel?.scope?.nextCall).toEqual({ tool: "capabilities", status: "executable" });
      expect(oversizedEnvelope.data?.decisionKernel?.scope?.nextCall?.arguments).toBeUndefined();
      expect(oversizedEnvelope.lifecycle?.nextTools).toEqual(["capabilities"]);
      expect(oversizedEnvelope.nextTools).toEqual([]);
      expect(oversizedEnvelope.data?.systemMessage).toBeUndefined();
      expect(oversizedEnvelope.data?.decisionKernel?.systemMessage).toBeUndefined();
      expect(oversizedEnvelope.systemMessage).toContain("data.nextCall contract");
      expect(JSON.stringify(oversizedCallers).split(JSON.stringify(expectedCallersDispatch))).toHaveLength(2);
    } finally {
      await client.close();
    }
  }, 90_000);

  it("never elides both exact hits and their detailed result after final transport compaction", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "codexa-mcp-exact-transport-"));
    const repo = await createIndexedMcpRepo(workspace, "repo", "alpha", "alphaSymbol");
    await Promise.all(Array.from({ length: 80 }, async (_, index) => {
      const suffix = String(index).padStart(3, "0");
      await writeFile(
        path.join(repo, "src", `mcp-structured-data-target-bytes-${suffix}.ts`),
        index === 0
          ? "export const mcpStructuredDataTargetBytes = 12_000;\n"
          : `export const context${suffix} = "mcp structured data target bytes ${suffix}";\n`,
        "utf8"
      );
    }));
    execFileSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["-c", "user.name=Codexa", "-c", "user.email=codexa@example.invalid", "commit", "-m", "exact search fixture"], { cwd: repo, stdio: "ignore" });
    await buildIndex({ repoRoot: repo });

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(process.cwd(), "dist/cli.js"), "serve", repo, "--no-auto-refresh", "--session-memory", "off", "--no-semantic", "--tools", "core"],
      stderr: "pipe"
    });
    const client = new Client({ name: "codexa-exact-transport-test", version: "0.1.0" });
    await client.connect(transport);
    try {
      const result = await client.callTool({ name: "search", arguments: { query: "mcpStructuredDataTargetBytes", limit: 50 } });
      const envelope = result.structuredContent as {
        data?: {
          rawExactHitCount?: number;
          raw?: { sufficient?: boolean; hits?: unknown[]; files?: string[] };
          delivery?: { resultUri?: string };
        };
      };
      const data = envelope.data;
      const retainedCompleteHits = data?.raw?.sufficient === true
        && Array.isArray(data.raw.hits)
        && data.raw.hits.length === data.rawExactHitCount;
      const resultUri = data?.delivery?.resultUri;
      expect(retainedCompleteHits || Boolean(resultUri)).toBe(true);
      if (!retainedCompleteHits) {
        expect(resultUri).toMatch(/^codexa:\/\/repo\/mcp-results\//u);
        const linkedDetail = await client.readResource({ uri: resultUri! });
        expect(linkedDetail.contents.some((entry) => typeof entry.text === "string" && entry.text.includes("mcpStructuredDataTargetBytes"))).toBe(true);
      }
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
