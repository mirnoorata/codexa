import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createMcpOutputSchema, toToolResult } from "../src/mcp/envelope.js";
import { MCP_TOOL_RESULT_DETAILED_MAX_BYTES, MCP_TOOL_RESULT_MAX_BYTES } from "../src/mcp/result-budget.js";
import { canonicalMcpDetailedProjection, compactMcpResult, compactNextTools } from "../src/mcp/compaction.js";
import { withMcpDelivery } from "../src/mcp/decision-kernel.js";
import { CORE_PROFILE_TOOL_NAMES } from "../src/mcp/tool-registry.js";
import { createPostEditReviewCoverage } from "../src/post-edit-review-coverage.js";

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

  it("returns the detailed candidate when ancillary compaction brings the whole ToolResult under its cap", () => {
    const dirtyFiles = Array.from({ length: 2_000 }, (_, index) => `src/detail-${String(index).padStart(4, "0")}-${"wide-path-".repeat(4)}.ts`);
    const dirtyFileHashes = Object.fromEntries(dirtyFiles.map((file, index) => [file, `hash-${index}`]));
    const evidence = "e".repeat(450_000);
    const text = "d".repeat(80 * 1_024);
    const result = toToolResult(
      {
        text,
        data: {
          mode: "capabilities",
          actionability: "orientation",
          evidence,
          delivery: { schemaVersion: 1, requestedFormat: "detailed", effectiveFormat: "detailed", detailAvailable: true }
        },
        freshness: freshness({ dirtyFiles, dirtyFileHashes })
      },
      "capabilities",
      POLICY
    );

    const envelope = result.structuredContent as {
      actionability: string;
      data: {
        evidence?: string;
        delivery: { effectiveFormat: string };
        truncation: { "__mcp.toolResultBudget": { total: number; returned: number } };
      };
      freshness: { dirtyFiles: string[]; dirtyFileCount: number };
      truncation: { "__mcp.toolResultBudget": { total: number; returned: number } };
    };
    expect(bytes(result)).toBeLessThanOrEqual(MCP_TOOL_RESULT_DETAILED_MAX_BYTES);
    expect(envelope.actionability).toBe("orientation");
    expect(envelope.data.evidence).toBe(evidence);
    expect(envelope.data.delivery.effectiveFormat).toBe("detailed");
    expect(result.content[0]).toEqual({ type: "text", text });
    expect(envelope.freshness.dirtyFiles).toEqual(dirtyFiles.slice(0, 12));
    expect(envelope.freshness.dirtyFileCount).toBe(dirtyFiles.length);
    expect(envelope.truncation["__mcp.toolResultBudget"].total).toBeGreaterThan(MCP_TOOL_RESULT_DETAILED_MAX_BYTES);
    expect(envelope.truncation["__mcp.toolResultBudget"].returned).toBe(bytes(result));
    expect(envelope.data.truncation["__mcp.toolResultBudget"]).toEqual(envelope.truncation["__mcp.toolResultBudget"]);
  });

  it.each(["concise", "detailed"] as const)("keeps executable strings over 1,000 characters lossless in %s projections", (format) => {
    const task = `Preserve this exact scope: ${"bounded-scope-".repeat(120)}`;
    const project = (data: Record<string, unknown>) => {
      const packet = { text: "bounded guidance", data, freshness: freshness() };
      return format === "concise" ? compactMcpResult(packet, { format }) : canonicalMcpDetailedProjection(packet);
    };
    const nextCall = project({
      mode: "focus_brief",
      task,
      actionability: "edit_ready",
      nextCall: { tool: "change_plan", reason: "plan the exact scope", arguments: { task, files: ["src/target.ts"], saveSnapshot: true } }
    }).data as { nextCall: { arguments: { task: string } }; truncation?: Record<string, unknown> };
    const nextTools = project({
      mode: "context_pack",
      task,
      actionability: "edit_ready",
      nextTools: [{ schemaVersion: 1, tool: "change_plan", reason: "plan the exact scope", requiredInputs: { task, files: ["src/target.ts"], saveSnapshot: true }, readOnly: false, writes: [] }]
    }).data as { nextTools: Array<{ requiredInputs: { task: string } }>; truncation?: Record<string, unknown> };

    expect(nextCall.nextCall.arguments.task).toBe(task);
    expect(nextTools.nextTools[0]?.requiredInputs.task).toBe(task);
    expect(Object.keys(nextCall.truncation ?? {})).not.toContain(expect.stringContaining("nextCall.arguments"));
    expect(Object.keys(nextTools.truncation ?? {})).not.toContain(expect.stringContaining("nextTools.0.requiredInputs"));
  });

  it("preserves blocking authority and the detailed resource URI after transport compaction", () => {
    const uri = `codexa://repo/mcp-results/rr_${"b".repeat(32)}/mr_${"a".repeat(64)}`;
    const result = toToolResult(
      {
        text: "review\n".repeat(20_000),
        data: {
          mode: "post_edit_review",
          taskId: "transport-compaction-review",
          planRevision: 1,
          reviewCandidateTargets: [],
          reviewTargets: [],
          reviewCoverage: createPostEditReviewCoverage({
            taskId: "transport-compaction-review",
            planRevision: 1,
            snapshotCreatedAt: null,
            snapshotPublicationSequence: null,
            candidateTargets: [],
            analyzedTargets: [],
            targetLimit: 3
          }),
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

  it("keeps an oversized change plan actionable when its terminal scope is self-contained", () => {
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
        delivery: { resultUri: string; detailRequired: boolean; requiredDetailReason?: string };
        decisionKernel: { authority: { actionability: string; originalActionability?: string }; detailsRequired?: boolean };
      };
      lifecycle: { blockingReasons: string[] };
      systemMessage?: string;
    };
    expect(envelope.actionability).toBe("edit_ready");
    expect(envelope.data.actionability).toBe(envelope.actionability);
    expect(envelope.data.decisionKernel).toMatchObject({
      authority: { actionability: "edit_ready" }
    });
    expect(envelope.data.decisionKernel.detailsRequired ?? false).toBe(false);
    expect(envelope.data.delivery.resultUri).toBe(uri);
    expect(envelope.data.delivery).toMatchObject({ detailRequired: false });
    expect(envelope.data.delivery.requiredDetailReason).toBeUndefined();
    expect(envelope.lifecycle.blockingReasons).not.toContain("Read the linked detailed result before acting");
    expect(envelope.systemMessage ?? "").not.toContain("read the linked detailed result before acting");
    expect(result.content).toContainEqual(expect.objectContaining({ type: "resource_link", uri }));
  });

  it("preserves a complete next-tool contract when the bounded receipt can carry every input", () => {
    const uri = `codexa://repo/mcp-results/rr_${"e".repeat(32)}/mr_${"f".repeat(64)}`;
    const files = Array.from({ length: 80 }, (_, index) => `src/${index}-${"nested-path-".repeat(20)}target.ts`);
    const result = toToolResult(
      {
        text: "bounded context\n".repeat(20_000),
        data: {
          mode: "context_pack",
          actionability: "edit_ready",
          nextTools: [{
            tool: "change_plan",
            reason: "act on every bounded target",
            requiredInputs: { task: "Refactor the bounded targets", files, saveSnapshot: true },
            readOnly: false,
            writes: [".codex/cache/codexa-tasks"]
          }],
          hugeEvidence: "e".repeat(MCP_TOOL_RESULT_MAX_BYTES * 4),
          delivery: {
            schemaVersion: 1,
            requestedFormat: "auto",
            effectiveFormat: "concise",
            resultUri: uri
          }
        },
        freshness: freshness()
      },
      "context_pack",
      POLICY
    );

    expect(bytes(result)).toBeLessThanOrEqual(MCP_TOOL_RESULT_MAX_BYTES);
    const envelope = result.structuredContent as {
      actionability: string;
      nextTools: Array<{
        tool: string;
        requiredInputs: { task: string; files: string[]; saveSnapshot: boolean };
        readOnly: boolean;
        writes: string[];
      }>;
      data: {
        delivery: { detailRequired: boolean; resultUri: string };
        decisionKernel: { authority: { actionability: string }; nextTools: unknown[]; detailsRequired?: boolean };
      };
      systemMessage?: string;
    };
    expect(envelope.actionability).toBe("edit_ready");
    expect(envelope.nextTools).toHaveLength(1);
    expect(envelope.nextTools[0]).toMatchObject({
      tool: "change_plan",
      requiredInputs: { task: "Refactor the bounded targets", files, saveSnapshot: true },
      readOnly: false,
      writes: [".codex/cache/codexa-tasks"]
    });
    expect(envelope.data.decisionKernel).toMatchObject({
      authority: { actionability: "edit_ready" },
      nextTools: ["change_plan"]
    });
    expect(envelope.data.decisionKernel.detailsRequired ?? false).toBe(false);
    expect(envelope.data.delivery).toMatchObject({ detailRequired: false, resultUri: uri });
    expect(envelope.systemMessage ?? "").not.toContain("next-tool arguments were omitted");
    expect(JSON.stringify(result).match(/Refactor the bounded targets/gu)).toHaveLength(1);
    expect(result.content).toContainEqual(expect.objectContaining({ type: "resource_link", uri }));
  });

  it("preserves a writeful next-tool contract with explicitly empty required inputs", () => {
    const uri = `codexa://repo/mcp-results/rr_${"1".repeat(32)}/mr_${"2".repeat(64)}`;
    const contract = {
      schemaVersion: 1,
      tool: "post_edit_review",
      reason: "review the current outcomes",
      requiredInputs: {},
      readOnly: false,
      writes: [".codex/cache/codexa-outcomes"]
    };
    const result = toToolResult(
      {
        text: "bounded context\n".repeat(20_000),
        data: {
          mode: "context_pack",
          actionability: "edit_ready",
          nextTools: [contract],
          hugeEvidence: "e".repeat(MCP_TOOL_RESULT_MAX_BYTES * 4),
          delivery: { schemaVersion: 1, requestedFormat: "auto", effectiveFormat: "concise", resultUri: uri }
        },
        freshness: freshness()
      },
      "context_pack",
      POLICY
    );

    const envelope = result.structuredContent as {
      actionability: string;
      nextTools: unknown[];
      data: { nextTools?: unknown; decisionKernel: { nextTools: unknown[]; detailsRequired?: boolean }; delivery: { detailRequired: boolean } };
    };
    expect(bytes(result)).toBeLessThanOrEqual(MCP_TOOL_RESULT_MAX_BYTES);
    expect(envelope.actionability).toBe("edit_ready");
    expect(envelope.nextTools).toEqual([contract]);
    expect(envelope.data.nextTools).toBeUndefined();
    expect(envelope.data.decisionKernel.nextTools).toEqual(["post_edit_review"]);
    expect(envelope.data.decisionKernel.detailsRequired ?? false).toBe(false);
    expect(envelope.data.delivery.detailRequired).toBe(false);
    expect(JSON.stringify(result).match(/review the current outcomes/gu)).toHaveLength(1);
  });

  it("preserves one complete oversized core nextCall without duplicating its arguments", () => {
    const uri = `codexa://repo/mcp-results/rr_${"7".repeat(32)}/mr_${"8".repeat(64)}`;
    const files = Array.from({ length: 64 }, (_, index) => `src/${String(index).padStart(2, "0")}-${"bounded-segment-".repeat(7)}target.ts`);
    const task = "Refactor every explicitly bounded target";
    const result = toToolResult(
      {
        text: "oversized focus\n".repeat(20_000),
        data: {
          mode: "focus_brief",
          actionability: "edit_ready",
          packetVerdict: "edit-ready",
          nextCall: { tool: "change_plan", reason: "the bounded target set needs one saved plan", arguments: { task, files, saveSnapshot: true } },
          systemMessage: "Use the complete data.nextCall contract for the saved plan.",
          hugeEvidence: "e".repeat(MCP_TOOL_RESULT_MAX_BYTES * 4),
          delivery: { schemaVersion: 1, requestedFormat: "auto", effectiveFormat: "concise", resultUri: uri }
        },
        freshness: freshness()
      },
      "focus_brief",
      { ...POLICY, enabledTools: new Set(CORE_PROFILE_TOOL_NAMES) }
    );
    const expectedArguments = { task, files, saveSnapshot: true };
    const envelope = result.structuredContent as {
      actionability: string;
      data: {
        nextCall?: { tool: string; arguments: Record<string, unknown> };
        systemMessage?: string;
        decisionKernel: { scope?: { nextCall?: { tool?: string; status?: string; arguments?: unknown } }; systemMessage?: string };
      };
      lifecycle: { nextTools: string[] };
      nextTools: unknown[];
      systemMessage?: string;
    };

    expect(bytes(result)).toBeLessThanOrEqual(MCP_TOOL_RESULT_MAX_BYTES);
    expect(envelope.actionability).toBe("edit_ready");
    expect(envelope.nextTools).toEqual([]);
    expect(envelope.data.nextCall).toEqual({
      tool: "change_plan",
      reason: "the bounded target set needs one saved plan",
      arguments: expectedArguments
    });
    expect(envelope.data.decisionKernel.scope?.nextCall).toEqual({ tool: "change_plan", status: "executable" });
    expect(envelope.data.decisionKernel.scope?.nextCall?.arguments).toBeUndefined();
    expect(envelope.lifecycle.nextTools).toEqual(["change_plan"]);
    expect(envelope.data.systemMessage).toBeUndefined();
    expect(envelope.data.decisionKernel.systemMessage).toBeUndefined();
    expect(envelope.systemMessage).toBe("Use the complete data.nextCall contract for the saved plan.");
    expect(JSON.stringify(result).split(JSON.stringify(files)).length).toBe(2);
    expect(result.content).toContainEqual(expect.objectContaining({ type: "resource_link", uri }));
  });

  it("fails closed with linked detail when a complete nextCall cannot fit", () => {
    const uri = `codexa://repo/mcp-results/rr_${"9".repeat(32)}/mr_${"a".repeat(64)}`;
    const result = toToolResult(
      {
        text: "oversized focus",
        data: {
          mode: "focus_brief",
          actionability: "edit_ready",
          packetVerdict: "edit-ready",
          nextCall: { tool: "change_plan", reason: "use the exact arguments", arguments: { task: "t".repeat(MCP_TOOL_RESULT_MAX_BYTES * 2), files: ["src/a.ts"], saveSnapshot: true } },
          delivery: { schemaVersion: 1, requestedFormat: "auto", effectiveFormat: "concise", resultUri: uri }
        },
        freshness: freshness()
      },
      "focus_brief",
      { ...POLICY, enabledTools: new Set(CORE_PROFILE_TOOL_NAMES) }
    );
    const envelope = result.structuredContent as {
      actionability: string;
      data: { nextCall?: unknown; decisionKernel: { scope?: { nextCall?: unknown }; detailsRequired?: boolean } };
      lifecycle: { nextTools: string[] };
      nextTools: unknown[];
      systemMessage: string;
      truncation: Record<string, { total: number; returned: number }>;
    };

    expect(bytes(result)).toBeLessThanOrEqual(MCP_TOOL_RESULT_MAX_BYTES);
    expect(envelope.actionability).toBe("blocked");
    expect(envelope.nextTools).toEqual([]);
    expect(envelope.data.nextCall).toBeUndefined();
    expect(envelope.data.decisionKernel.scope?.nextCall).toBeUndefined();
    expect(envelope.data.decisionKernel.detailsRequired).toBe(true);
    expect(envelope.lifecycle.nextTools).toEqual([]);
    expect(envelope.systemMessage).toContain("next-call arguments were omitted");
    expect(envelope.truncation["nextCall.arguments.__transport"]).toMatchObject({ total: expect.any(Number), returned: 0 });
    expect(result.content).toContainEqual(expect.objectContaining({ type: "resource_link", uri }));
  });

  it("removes nextCall authority when exact lifecycle detail is required", () => {
    const uri = `codexa://repo/mcp-results/rr_${"b".repeat(32)}/mr_${"c".repeat(64)}`;
    const result = toToolResult(
      {
        text: "review\n".repeat(20_000),
        data: {
          mode: "post_edit_review",
          actionability: "review",
          completionAuthority: "replan_required",
          nextCall: { tool: "change_plan", reason: "replan", arguments: { taskId: "task-1" } },
          decisionKernel: {
            schemaVersion: 1,
            mode: "post_edit_review",
            authority: { actionability: "review", completionAuthority: "replan_required" },
            scope: { nextCall: { tool: "change_plan", arguments: { taskId: "task-1" } } },
            detailsRequired: true
          },
          hugeEvidence: "e".repeat(MCP_TOOL_RESULT_MAX_BYTES * 4),
          delivery: { schemaVersion: 1, requestedFormat: "auto", effectiveFormat: "concise", resultUri: uri }
        },
        freshness: freshness()
      },
      "post_edit_review",
      { ...POLICY, enabledTools: new Set(CORE_PROFILE_TOOL_NAMES) }
    );
    const envelope = result.structuredContent as {
      data: { nextCall?: unknown; decisionKernel: { scope?: { nextCall?: unknown }; detailsRequired?: boolean } };
      lifecycle: { nextTools: string[] };
      nextTools: unknown[];
    };

    expect(envelope.nextTools).toEqual([]);
    expect(envelope.data.nextCall).toBeUndefined();
    expect(envelope.data.decisionKernel.scope?.nextCall).toBeUndefined();
    expect(envelope.data.decisionKernel.detailsRequired).toBe(true);
    expect(envelope.lifecycle.nextTools).toEqual([]);
  });

  it.each([
    {
      name: "requiredInputs",
      contract: {
        schemaVersion: 1,
        tool: "change_plan",
        reason: "use every bounded file",
        requiredInputs: { files: Array.from({ length: 81 }, (_, index) => `src/${index}.ts`) },
        readOnly: false,
        writes: []
      }
    },
    {
      name: "writes",
      contract: {
        schemaVersion: 1,
        tool: "change_plan",
        reason: "declare every write effect",
        requiredInputs: {},
        readOnly: false,
        writes: Array.from({ length: 9 }, (_, index) => `.codex/cache/outcome-${index}`)
      }
    }
  ])("fails closed when $name is truncated before transport budgeting", ({ contract }) => {
    const uri = `codexa://repo/mcp-results/rr_${"3".repeat(32)}/mr_${"4".repeat(64)}`;
    const truncation: Record<string, { total: number; returned: number }> = {};
    const compactedNextTools = compactNextTools([contract], truncation) as unknown[];
    expect(Object.keys(truncation).some((key) => key.includes(`nextTools.0.${contract.writes.length > 8 ? "writes" : "requiredInputs"}`))).toBe(true);
    const result = toToolResult(
      {
        text: "bounded context\n".repeat(20_000),
        data: {
          mode: "context_pack",
          actionability: "edit_ready",
          nextTools: compactedNextTools,
          truncation,
          hugeEvidence: "e".repeat(MCP_TOOL_RESULT_MAX_BYTES * 4),
          delivery: { schemaVersion: 1, requestedFormat: "auto", effectiveFormat: "concise", resultUri: uri }
        },
        freshness: freshness()
      },
      "context_pack",
      POLICY
    );

    const envelope = result.structuredContent as {
      actionability: string;
      nextTools: unknown[];
      systemMessage: string;
      data: { decisionKernel: { detailsRequired: boolean; nextTools: unknown[] }; delivery: { detailRequired: boolean } };
    };
    expect(bytes(result)).toBeLessThanOrEqual(MCP_TOOL_RESULT_MAX_BYTES);
    expect(envelope.actionability).toBe("blocked");
    expect(envelope.nextTools).toEqual([]);
    expect(envelope.data.decisionKernel).toMatchObject({ detailsRequired: true, nextTools: [] });
    expect(envelope.data.delivery.detailRequired).toBe(true);
    expect(envelope.systemMessage).toContain("next-tool arguments were omitted");
  });

  it("fails closed below the hard cap when core dispatch receives typed-compacted required inputs", () => {
    const uri = `codexa://repo/mcp-results/rr_${"7".repeat(32)}/mr_${"9".repeat(64)}`;
    const requiredInputs = Object.fromEntries(
      Array.from({ length: 20 }, (_, index) => [`key${String(index).padStart(2, "0")}`, `value-${index}`])
    );
    const compacted = compactMcpResult(
      {
        text: "edit-ready context",
        data: {
          mode: "task_brief",
          actionability: "edit_ready",
          nextTools: [{
            schemaVersion: 1,
            tool: "session_memory",
            reason: "record every required input",
            requiredInputs,
            readOnly: false,
            writes: [".codex/cache/codexa-session-memory"]
          }]
        },
        freshness: freshness()
      },
      { format: "concise" }
    );
    const delivered = withMcpDelivery(compacted, {
      schemaVersion: 1,
      requestedFormat: "auto",
      effectiveFormat: "concise",
      resultId: `mr_${"9".repeat(64)}`,
      resultUri: uri,
      detailAvailable: true,
      detailRequired: false
    });
    const result = toToolResult(
      delivered,
      "task_brief",
      { ...POLICY, enabledTools: new Set(CORE_PROFILE_TOOL_NAMES) }
    );

    const envelope = result.structuredContent as {
      actionability: string;
      nextTools: unknown[];
      systemMessage: string;
      lifecycle: { nextTools: string[] };
      truncation: Record<string, { total: number; returned: number }>;
      data: {
        delivery: { detailRequired: boolean; requiredDetailReason?: string; escalationReason?: string };
        decisionKernel: { authority: { actionability: string; originalActionability?: string }; nextTools: unknown[]; detailsRequired: boolean };
        mcp: { budgetCompaction: string; hardBudgetEnforced?: boolean };
      };
    };
    expect(bytes(result)).toBeLessThan(MCP_TOOL_RESULT_MAX_BYTES);
    expect(envelope.actionability).toBe("blocked");
    expect(envelope.nextTools).toEqual([]);
    expect(envelope.lifecycle.nextTools).toEqual([]);
    expect(envelope.data.decisionKernel).toMatchObject({
      authority: { actionability: "blocked", originalActionability: "edit_ready" },
      nextTools: [],
      detailsRequired: true
    });
    expect(envelope.data.delivery).toMatchObject({
      detailRequired: true,
      requiredDetailReason: "executable-follow-up-truncated",
      escalationReason: "executable-follow-up-truncated"
    });
    expect(envelope.data.mcp).toMatchObject({ budgetCompaction: "follow-up-contract" });
    expect(envelope.data.mcp.hardBudgetEnforced).toBeUndefined();
    expect(envelope.truncation["nextTools.0.requiredInputs.__keys"]).toEqual({ total: 20, returned: 16 });
    expect(envelope.truncation["nextTools.0.requiredInputs.__transport"]?.returned).toBe(0);
    expect(envelope.truncation["__mcp.toolResultBudget"]).toBeUndefined();
    expect(envelope.systemMessage).toContain("next-tool arguments were omitted");
    expect(result.content).toContainEqual(expect.objectContaining({ type: "resource_link", uri }));
  });

  it("fails closed when an oversized receipt carries string-only next-tool guidance", () => {
    const uri = `codexa://repo/mcp-results/rr_${"9".repeat(32)}/mr_${"a".repeat(64)}`;
    const result = toToolResult(
      {
        text: "bounded context",
        data: {
          mode: "context_pack",
          actionability: "edit_ready",
          nextTools: ["change_plan"],
          hugeEvidence: "e".repeat(MCP_TOOL_RESULT_MAX_BYTES * 4),
          delivery: { schemaVersion: 1, requestedFormat: "auto", effectiveFormat: "concise", resultUri: uri }
        },
        freshness: freshness()
      },
      "context_pack",
      POLICY
    );

    const envelope = result.structuredContent as {
      actionability: string;
      nextTools: unknown[];
      lifecycle: { nextTools: string[] };
      systemMessage: string;
      data: { decisionKernel: { detailsRequired: boolean; nextTools: unknown[] }; delivery: { detailRequired: boolean } };
    };
    expect(bytes(result)).toBeLessThanOrEqual(MCP_TOOL_RESULT_MAX_BYTES);
    expect(envelope.actionability).toBe("blocked");
    expect(envelope.nextTools).toEqual([]);
    expect(envelope.lifecycle.nextTools).toEqual([]);
    expect(envelope.data.decisionKernel).toMatchObject({ detailsRequired: true, nextTools: [] });
    expect(envelope.data.delivery.detailRequired).toBe(true);
    expect(envelope.systemMessage).toContain("next-tool arguments were omitted");
  });

  it("fails closed when a complete next-tool contract itself cannot fit the transport budget", () => {
    const uri = `codexa://repo/mcp-results/rr_${"5".repeat(32)}/mr_${"6".repeat(64)}`;
    const result = toToolResult(
      {
        text: "bounded context\n".repeat(20_000),
        data: {
          mode: "context_pack",
          actionability: "edit_ready",
          nextTools: [{
            schemaVersion: 1,
            tool: "change_plan",
            reason: "use the exact untruncated payload",
            requiredInputs: { task: "t".repeat(MCP_TOOL_RESULT_MAX_BYTES) },
            readOnly: false,
            writes: []
          }],
          delivery: { schemaVersion: 1, requestedFormat: "auto", effectiveFormat: "concise", resultUri: uri }
        },
        freshness: freshness()
      },
      "context_pack",
      POLICY
    );

    const envelope = result.structuredContent as { actionability: string; nextTools: unknown[]; systemMessage: string; truncation: Record<string, { total: number; returned: number }> };
    expect(bytes(result)).toBeLessThanOrEqual(MCP_TOOL_RESULT_MAX_BYTES);
    expect(envelope.actionability).toBe("blocked");
    expect(envelope.nextTools).toEqual([]);
    expect(envelope.systemMessage).toContain("next-tool arguments were omitted");
    expect(envelope.truncation["nextTools.0.requiredInputs.__transport"]).toMatchObject({ total: expect.any(Number), returned: 0 });
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
