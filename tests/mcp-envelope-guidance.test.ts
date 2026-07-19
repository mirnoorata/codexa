import { describe, expect, it } from "vitest";
import { withMcpDelivery } from "../src/mcp/decision-kernel.js";
import { toToolResult } from "../src/mcp/envelope.js";
import { CORE_PROFILE_TOOL_NAMES } from "../src/mcp/tool-registry.js";

const POLICY = { autoRefresh: false, sessionMemoryMode: "off" };
const FRESHNESS = {
  schemaVersion: 1,
  snapshotId: "snapshot",
  repoRoot: "/repo",
  gitRoot: "/repo",
  headCommit: "head",
  indexedAt: "2026-07-18T00:00:00.000Z",
  dirtyFiles: [],
  dirtyFileHashes: {},
  indexedDirtyFileHashes: {},
  indexedDirtyFiles: [],
  missing: false,
  stale: false,
  reason: "fresh",
  parserErrorCount: 0
};

describe("MCP envelope next-tool ownership", () => {
  it.each([
    ["session_context", {}],
    ["task_brief", { focusFiles: [{ path: "src/main.ts" }] }],
    ["context_pack", { nextReads: ["src/main.ts"] }],
    ["change_plan", { snapshotBlock: { reason: "needs target" } }],
    ["test_plan", { verificationCommands: ["npm test"] }]
  ])("does not synthesize legacy next tools for %s", (mode, extra) => {
    const result = toToolResult(
      { text: `${mode} result`, data: { mode, ...extra }, freshness: FRESHNESS },
      mode,
      POLICY
    );
    const envelope = result.structuredContent as { lifecycle: { nextTools: string[] }; nextTools: unknown[] };

    expect(envelope.lifecycle.nextTools).toEqual([]);
    expect(envelope.nextTools).toEqual([]);
  });

  it("preserves the one explicit unresolved decision without inventing another", () => {
    const nextTool = { schemaVersion: 1, tool: "search", reason: "one exact target is unresolved", requiredInputs: { query: "target" }, readOnly: true, writes: [] };
    const result = toToolResult(
      { text: "brief result", data: { mode: "task_brief", nextTools: [nextTool] }, freshness: FRESHNESS },
      "task_brief",
      POLICY
    );
    const envelope = result.structuredContent as { data: { nextTools?: unknown[] }; lifecycle: { nextTools: string[] }; nextTools: unknown[] };

    expect(envelope.data.nextTools).toBeUndefined();
    expect(envelope.lifecycle.nextTools).toEqual(["search"]);
    expect(envelope.nextTools).toEqual([nextTool]);
    expect(JSON.stringify(result).match(/one exact target is unresolved/gu)).toHaveLength(1);
  });

  it("does not dispatch a downstream operation from a fail-closed delivery receipt", () => {
    const resultUri = `codexa://repo/mcp-results/rr_${"e".repeat(32)}/mr_${"f".repeat(64)}`;
    const nextTool = {
      schemaVersion: 1,
      tool: "change_plan",
      reason: "replan the unresolved review",
      requiredInputs: { taskId: "core-fail-closed" },
      readOnly: false,
      writes: []
    };
    const packet = {
      text: "large change plan",
      data: {
        mode: "post_edit_review",
        actionability: "review",
        completionAuthority: "replan_required",
        filler: "x".repeat(7_000),
        nextTools: [nextTool],
        decisionKernel: {
          schemaVersion: 1,
          mode: "post_edit_review",
          authority: { actionability: "review", completionAuthority: "replan_required" },
          nextTools: [nextTool]
        },
        mcp: { targetBytes: 4_000 }
      },
      freshness: FRESHNESS
    };
    const delivered = withMcpDelivery(packet, {
      schemaVersion: 1,
      requestedFormat: "auto",
      effectiveFormat: "concise",
      resultId: `mr_${"f".repeat(64)}`,
      resultUri,
      detailAvailable: true
    });
    const result = toToolResult(delivered, "post_edit_review", {
      ...POLICY,
      enabledTools: new Set(CORE_PROFILE_TOOL_NAMES)
    });
    const envelope = result.structuredContent as {
      actionability: string;
      data: {
        nextTools?: unknown[];
        systemMessage?: string;
        decisionKernel: { nextTools?: unknown[]; systemMessage?: string; detailsRequired?: boolean };
      };
      nextTools: unknown[];
    };
    const text = result.content.find((entry) => entry.type === "text")?.text ?? "";

    expect(envelope.actionability).toBe("blocked");
    expect(envelope.nextTools).toEqual([]);
    expect(envelope.data.nextTools ?? []).toEqual([]);
    expect(envelope.data.decisionKernel.nextTools ?? []).toEqual([]);
    expect(envelope.data.decisionKernel.detailsRequired).toBe(true);
    expect(envelope.data.decisionKernel.systemMessage).toBeUndefined();
    expect((result.structuredContent as { systemMessage?: string }).systemMessage).toContain("read the linked detailed result");
    expect(text).toContain(resultUri);
    expect(text).not.toContain("Next: capabilities");
    expect(text).not.toContain("Next: change_plan");
  });

  it("selects one complete follow-up before profile routing and lifecycle projection", () => {
    const result = toToolResult(
      {
        text: "review needs replan and impact",
        data: {
          mode: "post_edit_review",
          actionability: "review",
          nextTools: [
            { schemaVersion: 1, tool: "change_plan", reason: "rebuild the saved plan", requiredInputs: { taskId: "task-1" }, readOnly: false, writes: [".codex/cache/codexa-tasks"] },
            { schemaVersion: 1, tool: "impact", reason: "inspect a high-risk target", requiredInputs: { file: "src/risky.ts" }, readOnly: true, writes: [] }
          ],
          decisionKernel: {
            schemaVersion: 1,
            mode: "post_edit_review",
            authority: { actionability: "review" },
            nextTools: [{ tool: "change_plan" }, { tool: "impact" }],
            systemMessage: "rebuild the saved plan"
          },
          systemMessage: "rebuild the saved plan"
        },
        freshness: FRESHNESS
      },
      "post_edit_review",
      { ...POLICY, enabledTools: new Set(CORE_PROFILE_TOOL_NAMES) }
    );
    const envelope = result.structuredContent as {
      data: { nextTools?: unknown[]; decisionKernel: { nextTools?: string[]; systemMessage?: string } };
      lifecycle: { nextTools: string[] };
      nextTools: Array<{ tool: string; requiredInputs: Record<string, unknown> }>;
      systemMessage?: string;
    };

    expect(envelope.nextTools).toHaveLength(1);
    expect(envelope.nextTools[0]).toMatchObject({
      tool: "change_plan",
      requiredInputs: { taskId: "task-1" }
    });
    expect(envelope.lifecycle.nextTools).toEqual(["change_plan"]);
    expect(envelope.data.nextTools).toBeUndefined();
    expect(envelope.data.decisionKernel.nextTools).toEqual(["change_plan"]);
    expect(envelope.data.decisionKernel.systemMessage).toBeUndefined();
    expect(envelope.systemMessage).toBe("rebuild the saved plan");
    expect(JSON.stringify(result)).not.toContain('"tool":"capabilities"');
    expect(JSON.stringify(result)).not.toContain('"operation":"impact"');
    expect(JSON.stringify(result)).not.toContain("inspect a high-risk target");
  });

  it("never promotes a lossy kernel tool summary into an executable contract", () => {
    const result = toToolResult(
      {
        text: "kernel-only summary",
        data: {
          mode: "task_brief",
          decisionKernel: { schemaVersion: 1, mode: "task_brief", nextTools: ["change_plan"] }
        },
        freshness: FRESHNESS
      },
      "task_brief",
      POLICY
    );
    const envelope = result.structuredContent as { data: { nextTools?: unknown[]; decisionKernel: { nextTools?: string[] } }; lifecycle: { nextTools: string[] }; nextTools: unknown[] };

    expect(envelope.nextTools).toEqual([]);
    expect(envelope.data.nextTools).toBeUndefined();
    expect(envelope.data.decisionKernel.nextTools).toEqual([]);
    expect(envelope.lifecycle.nextTools).toEqual([]);
  });
});
