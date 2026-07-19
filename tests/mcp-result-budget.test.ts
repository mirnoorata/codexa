import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createMcpOutputSchema, toToolResult } from "../src/mcp/envelope.js";
import { MCP_TOOL_RESULT_DETAILED_MAX_BYTES, MCP_TOOL_RESULT_MAX_BYTES } from "../src/mcp/result-budget.js";
import { compactMcpResult } from "../src/mcp/compaction.js";
import { withMcpDelivery } from "../src/mcp/decision-kernel.js";

const POLICY = { autoRefresh: true, sessionMemoryMode: "auto" };

describe("MCP serialized ToolResult budget", () => {
  it.each([
    {
      mode: "task_brief",
      tool: "task_brief",
      data: { mode: "task_brief", actionability: "inspect_first", focusFiles: [{ path: "src/target.ts" }], nextReads: ["src/target.ts"] },
      actionability: "inspect_first",
      expectedKey: "focusFiles"
    },
    {
      mode: "proof_card",
      tool: "proof_card",
      data: { mode: "proof_card", actionability: "verify", completionAuthority: "complete", verification: { recommendedCommands: ["npm test"] } },
      actionability: "verify",
      expectedKey: "verification"
    }
  ])("preserves ordinary $mode structured data and actionability", ({ tool, data, actionability, expectedKey }) => {
    const result = toToolResult({ text: `${tool} result`, data, freshness: freshness() }, tool, POLICY);
    expect(bytes(result)).toBeLessThanOrEqual(MCP_TOOL_RESULT_MAX_BYTES);
    const envelope = result.structuredContent as { actionability: string; data?: Record<string, unknown> };
    expect(envelope.actionability).toBe(actionability);
    expect(envelope.data).toMatchObject({ mode: data.mode, actionability });
    expect(envelope.data?.[expectedKey]).toBeDefined();
  });

  it("bounds huge freshness metadata as a terminal orientation summary", () => {
    const dirtyFiles = Array.from({ length: 20_000 }, (_, index) => `src/${index}-${"path".repeat(30)}.ts`);
    const dirtyFileHashes = Object.fromEntries(dirtyFiles.map((file, index) => [file, `hash-${index}-${"a".repeat(120)}`]));
    const result = toToolResult(
      {
        text: "freshness result",
        data: { mode: "freshness", actionability: "orientation" },
        freshness: freshness({ dirtyFiles, dirtyFileHashes, stale: false, reason: "dirty state indexed" })
      },
      "freshness",
      POLICY
    );

    expect(bytes(result)).toBeLessThanOrEqual(MCP_TOOL_RESULT_MAX_BYTES);
    const envelope = result.structuredContent as {
      actionability: string;
      systemMessage: string;
      freshness: { stale: boolean; reason: string; dirtyFileCount: number; dirtyFiles: string[]; dirtyFileHashes: Record<string, string> };
      truncation: { "__mcp.toolResultBudget": { total: number; returned: number } };
    };
    expect(envelope.actionability).toBe("orientation");
    expect(envelope.freshness).toMatchObject({ stale: false, reason: "dirty state indexed", dirtyFileCount: dirtyFiles.length });
    expect(envelope.freshness.dirtyFiles).toEqual([]);
    expect(envelope.freshness.dirtyFileHashes).toEqual({});
    expect(envelope.truncation["__mcp.toolResultBudget"].total).toBeGreaterThan(envelope.truncation["__mcp.toolResultBudget"].returned);
    expect(envelope.truncation["__mcp.toolResultBudget"].returned).toBe(bytes(result));
    expect(envelope.systemMessage).toContain("git status --short");
    expect(envelope.systemMessage).toContain("no further Codexa call");
  });

  it("keeps in-budget detailed text and freshness lossless", () => {
    const dirtyFiles = Array.from({ length: 50 }, (_, index) => `src/detail-${index}.ts`);
    const detailedFreshness = freshness({
      dirtyFiles,
      dirtyFileHashes: Object.fromEntries(dirtyFiles.map((file, index) => [file, `hash-${index}`])),
      degradedGitState: true,
      externalRiskReportHashes: { "risk.json": "risk-hash" }
    });
    const text = "d".repeat(100 * 1_024);
    const result = toToolResult(
      {
        text,
        data: { mode: "capabilities", delivery: { schemaVersion: 1, requestedFormat: "detailed", effectiveFormat: "detailed", detailAvailable: true } },
        freshness: detailedFreshness
      },
      "capabilities",
      POLICY
    );

    expect(bytes(result)).toBeLessThanOrEqual(MCP_TOOL_RESULT_DETAILED_MAX_BYTES);
    expect(result.content[0]).toMatchObject({ type: "text", text });
    expect((result.structuredContent as { freshness: Record<string, unknown> }).freshness).toEqual(detailedFreshness);
    expect((result.structuredContent as { truncation?: unknown }).truncation).toBeUndefined();
  });

  it("preserves blocking authority and the detailed resource URI after transport compaction", () => {
    const uri = `codexa://repo/mcp-results/rr_${"b".repeat(32)}/mr_${"a".repeat(64)}`;
    const result = toToolResult(
      {
        text: "review\n".repeat(20_000),
        data: {
          mode: "post_edit_review",
          verdict: "replan",
          completionAuthority: "replan_required",
          gaps: Array.from({ length: 2_000 }, (_, index) => `gap-${index}-${"g".repeat(300)}`),
          delivery: {
            schemaVersion: 1,
            requestedFormat: "auto",
            effectiveFormat: "concise",
            resultId: `mr_${"a".repeat(64)}`,
            resultUri: uri
          }
        },
        freshness: freshness()
      },
      "post_edit_review",
      POLICY
    );

    expect(bytes(result)).toBeLessThanOrEqual(MCP_TOOL_RESULT_MAX_BYTES);
    const envelope = result.structuredContent as {
      actionability: string;
      data: {
        completionAuthority: string;
        delivery: { resultUri: string };
        decisionKernel: { authority: { actionability: string; verdict: string; completionAuthority: string } };
      };
    };
    expect(envelope.actionability).toBe("blocked");
    expect(envelope.data.decisionKernel.authority).toMatchObject({ actionability: "blocked", verdict: "replan", completionAuthority: "replan_required" });
    expect(envelope.data.delivery.resultUri).toBe(uri);
    expect(result.content).toContainEqual(expect.objectContaining({ type: "resource_link", uri }));
    expect(() => z.object(createMcpOutputSchema("full")).parse(result.structuredContent)).not.toThrow();
  });

  it("keeps oversized change-plan authority blocked until linked detail is read", () => {
    const uri = `codexa://repo/mcp-results/rr_${"c".repeat(32)}/mr_${"d".repeat(64)}`;
    const result = toToolResult(
      {
        text: "edit-ready plan\n".repeat(20_000),
        data: {
          mode: "change_plan",
          actionability: "edit_ready",
          editReadiness: { editable: true, status: "edit-ready" },
          plannedEditTargets: ["src/target.ts"],
          hugeDetailedEvidence: "x".repeat(MCP_TOOL_RESULT_MAX_BYTES * 8),
          delivery: {
            schemaVersion: 1,
            requestedFormat: "auto",
            effectiveFormat: "concise",
            resultUri: uri
          }
        },
        freshness: freshness()
      },
      "change_plan",
      POLICY
    );

    expect(bytes(result)).toBeLessThanOrEqual(MCP_TOOL_RESULT_MAX_BYTES);
    const envelope = result.structuredContent as {
      actionability: string;
      data: {
        actionability: string;
        delivery: { resultUri: string; detailRequired: boolean; requiredDetailReason: string };
        decisionKernel: { authority: { actionability: string; originalActionability: string }; detailsRequired: boolean };
      };
      lifecycle: { blockingReasons: string[] };
      systemMessage: string;
    };
    expect(envelope.actionability).toBe("blocked");
    expect(envelope.data.actionability).toBe(envelope.actionability);
    expect(envelope.data.decisionKernel).toMatchObject({
      authority: { actionability: "blocked", originalActionability: "edit_ready" },
      detailsRequired: true
    });
    expect(envelope.data.delivery.resultUri).toBe(uri);
    expect(envelope.data.delivery).toMatchObject({ detailRequired: true, requiredDetailReason: "tool-result-budget" });
    expect(envelope.lifecycle.blockingReasons).toContain("Read the linked detailed result before acting");
    expect(envelope.systemMessage).toContain("read the linked detailed result before acting");
    expect(result.content).toContainEqual(expect.objectContaining({ type: "resource_link", uri }));
  });

  it("keeps an auto request within the ordinary cap when detailed artifact persistence failed", () => {
    const result = toToolResult(
      {
        text: "unbounded detailed fallback".repeat(20_000),
        data: {
          mode: "change_plan",
          actionability: "edit_ready",
          editReadiness: { editable: true, status: "edit-ready" },
          plannedEditTargets: ["src/target.ts"],
          hugeDetailedEvidence: "x".repeat(MCP_TOOL_RESULT_DETAILED_MAX_BYTES * 3),
          delivery: {
            schemaVersion: 1,
            requestedFormat: "auto",
            effectiveFormat: "concise",
            escalationReason: "detailed-result-resource-unavailable"
          }
        },
        freshness: freshness()
      },
      "change_plan",
      POLICY
    );

    expect(bytes(result)).toBeLessThanOrEqual(MCP_TOOL_RESULT_MAX_BYTES);
    const envelope = result.structuredContent as {
      actionability: string;
      data: {
        hugeDetailedEvidence?: string;
        delivery: { requestedFormat: string; effectiveFormat: string; detailAvailable: boolean; escalationReason: string; resultUri?: string };
        decisionKernel: { authority: { actionability: string; originalActionability: string } };
      };
    };
    expect(envelope.actionability).toBe("blocked");
    expect(envelope.data.decisionKernel.authority).toMatchObject({ actionability: "blocked", originalActionability: "edit_ready" });
    expect(envelope.data.delivery).toMatchObject({ requestedFormat: "auto", effectiveFormat: "concise", detailAvailable: false, escalationReason: "detailed-result-resource-unavailable" });
    expect(envelope.data.delivery.resultUri).toBeUndefined();
    expect(envelope.data.hugeDetailedEvidence).toBeUndefined();
  });

  it("keeps a self-contained concise plan useful when only the optional detail artifact is unavailable", () => {
    const compact = compactMcpResult({
      text: "bounded edit plan",
      data: {
        mode: "change_plan",
        actionability: "edit_ready",
        task: "Update the exact parser target",
        plannedEditTargets: ["src/parser.ts"],
        editReadiness: { editable: true, status: "edit-ready" },
        nextTools: []
      },
      freshness: freshness()
    }, { format: "concise" });
    const delivered = withMcpDelivery(compact, {
      schemaVersion: 1,
      requestedFormat: "auto",
      effectiveFormat: "concise",
      detailAvailable: false,
      escalationReason: "detailed-result-resource-unavailable"
    });
    const result = toToolResult(delivered, "change_plan", POLICY);
    const envelope = result.structuredContent as {
      actionability: string;
      data: { delivery: { detailAvailable: boolean; resultUri?: string }; decisionKernel: { detailsRequired?: boolean } };
    };

    expect(bytes(result)).toBeLessThanOrEqual(MCP_TOOL_RESULT_MAX_BYTES);
    expect(envelope.actionability).toBe("edit_ready");
    expect(envelope.data.delivery).toMatchObject({ detailAvailable: false });
    expect(envelope.data.delivery.resultUri).toBeUndefined();
    expect(envelope.data.decisionKernel.detailsRequired ?? false).toBe(false);
  });

  it("allows a larger packet only for explicit detailed requests", () => {
    const evidence = "d".repeat(MCP_TOOL_RESULT_MAX_BYTES + 12_000);
    const result = toToolResult(
      {
        text: "explicit detail",
        data: {
          mode: "capabilities",
          evidence,
          delivery: { schemaVersion: 1, requestedFormat: "detailed", effectiveFormat: "detailed" }
        },
        freshness: freshness()
      },
      "capabilities",
      POLICY
    );

    expect(bytes(result)).toBeGreaterThan(MCP_TOOL_RESULT_MAX_BYTES);
    expect(bytes(result)).toBeLessThanOrEqual(MCP_TOOL_RESULT_DETAILED_MAX_BYTES);
    expect((result.structuredContent as { data: { evidence: string } }).data.evidence).toBe(evidence);
  });

  it("applies an absolute ceiling even to explicit detailed responses", () => {
    const result = toToolResult(
      {
        text: "detail".repeat(100_000),
        data: {
          mode: "capabilities",
          actionability: "orientation",
          evidence: "e".repeat(MCP_TOOL_RESULT_DETAILED_MAX_BYTES * 6),
          delivery: { schemaVersion: 1, requestedFormat: "detailed", effectiveFormat: "detailed" }
        },
        freshness: freshness()
      },
      "capabilities",
      POLICY
    );

    expect(bytes(result)).toBeLessThanOrEqual(MCP_TOOL_RESULT_DETAILED_MAX_BYTES);
    expect((result.structuredContent as { data: { evidence?: string; mcp: { hardBudgetEnforced: boolean } } }).data.evidence).toBeUndefined();
    expect((result.structuredContent as { data: { mcp: { hardBudgetEnforced: boolean } } }).data.mcp.hardBudgetEnforced).toBe(true);
  });

  it("revokes raw-search authority when an oversized detailed result has no retrievable URI", () => {
    const result = toToolResult(
      {
        text: `Use these raw hits immediately.\n${"raw-hit\n".repeat(100_000)}`,
        data: {
          mode: "search",
          actionability: "raw_search_sufficient",
          rawHits: Array.from({ length: 10_000 }, (_, index) => ({ path: `src/${index}.ts`, line: index, text: "hit".repeat(100) })),
          nextTools: [{ tool: "change_plan", reason: "act on the raw hits" }],
          systemMessage: "Stop Codexa and use the raw hits.",
          delivery: { schemaVersion: 1, requestedFormat: "detailed", effectiveFormat: "detailed", detailAvailable: true }
        },
        freshness: freshness()
      },
      "search",
      POLICY
    );

    expect(bytes(result)).toBeLessThanOrEqual(MCP_TOOL_RESULT_DETAILED_MAX_BYTES);
    const envelope = result.structuredContent as {
      actionability: string;
      nextTools: unknown[];
      systemMessage: string;
      data: {
        delivery: { effectiveFormat: string; detailAvailable: boolean; resultUri?: string };
        decisionKernel: { authority: { actionability: string; originalActionability: string }; nextTools: unknown[]; detailsRequired: boolean };
        truncation: { "__mcp.toolResultBudget": { total: number; returned: number } };
      };
    };
    expect(envelope.actionability).toBe("blocked");
    expect(envelope.nextTools).toEqual([]);
    expect(envelope.data.decisionKernel).toMatchObject({
      authority: { actionability: "blocked", originalActionability: "raw_search_sufficient" },
      nextTools: [],
      detailsRequired: true
    });
    expect(envelope.data.delivery).toMatchObject({ effectiveFormat: "concise", detailAvailable: false });
    expect(envelope.data.delivery.resultUri).toBeUndefined();
    expect(envelope.systemMessage).not.toContain("use the raw hits");
    expect(JSON.stringify(result.content)).not.toContain("Use these raw hits immediately");
    expect(envelope.data.truncation["__mcp.toolResultBudget"].total).toBeGreaterThan(envelope.data.truncation["__mcp.toolResultBudget"].returned);
    expect(envelope.data.truncation["__mcp.toolResultBudget"].returned).toBe(bytes(result));
  });

  it("does not synthesize post_edit_review after an edit-ready change_plan", () => {
    const result = toToolResult(
      {
        text: "edit-ready",
        data: { mode: "change_plan", plannedEditTargets: ["src/target.ts"], snapshot: { taskId: "task" } },
        freshness: freshness()
      },
      "change_plan",
      POLICY
    );
    expect((result.structuredContent as { lifecycle: { nextTools: string[] }; nextTools: string[] }).lifecycle.nextTools).toEqual([]);
    expect((result.structuredContent as { nextTools: string[] }).nextTools).toEqual([]);
  });
});

function freshness(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
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
    parserErrorCount: 0,
    ...overrides
  };
}

function bytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}
