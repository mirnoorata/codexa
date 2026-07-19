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
    const envelope = result.structuredContent as { data: { nextTools: unknown[] }; lifecycle: { nextTools: string[] }; nextTools: unknown[] };

    expect(envelope.data.nextTools).toHaveLength(1);
    expect(envelope.lifecycle.nextTools).toEqual(["search"]);
    expect(envelope.nextTools).toEqual([expect.objectContaining({ tool: "search" })]);
  });

  it("does not dispatch a downstream operation from a fail-closed delivery receipt", () => {
    const resultUri = `codexa://repo/mcp-results/rr_${"e".repeat(32)}/mr_${"f".repeat(64)}`;
    const nextTool = {
      schemaVersion: 1,
      tool: "post_edit_review",
      reason: "review the completed edit",
      requiredInputs: { taskId: "core-fail-closed" },
      readOnly: true,
      writes: []
    };
    const packet = {
      text: "large change plan",
      data: {
        mode: "change_plan",
        actionability: "edit_ready",
        filler: "x".repeat(7_000),
        nextTools: [nextTool],
        decisionKernel: {
          schemaVersion: 1,
          mode: "change_plan",
          authority: { actionability: "edit_ready" },
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
    const result = toToolResult(delivered, "change_plan", {
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
    expect(envelope.data.decisionKernel.systemMessage).toContain("read the linked detailed result");
    expect(text).toContain(resultUri);
    expect(text).not.toContain("Next: capabilities");
    expect(text).not.toContain("Next: post_edit_review");
  });
});
