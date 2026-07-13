import { afterEach, describe, expect, it } from "vitest";
import { compactMcpResult } from "../src/mcp/compaction.js";
import { mcpAutoEscalationReason, mcpDecisionKernel, renderMcpConciseText, withMcpDelivery } from "../src/mcp/decision-kernel.js";
import type { FreshnessInfo, QueryResult } from "../src/types.js";

const previousBudget = process.env.CODEXA_MCP_STRUCTURED_BUDGET_BYTES;
afterEach(() => {
  if (previousBudget === undefined) delete process.env.CODEXA_MCP_STRUCTURED_BUDGET_BYTES;
  else process.env.CODEXA_MCP_STRUCTURED_BUDGET_BYTES = previousBudget;
});

function freshness(headCommit = "head-active"): FreshnessInfo {
  return {
    schemaVersion: 1,
    snapshotId: "snapshot-identity",
    repoRoot: "/repo/worktree",
    gitRoot: "/repo/worktree",
    headCommit,
    indexedAt: "2026-07-13T00:00:00.000Z",
    dirtyFiles: [],
    dirtyFileHashes: {},
    indexedDirtyFileHashes: {},
    indexedDirtyFiles: [],
    missing: false,
    stale: false,
    reason: "fresh",
    parserErrorCount: 0
  };
}

function invariants() {
  return Array.from({ length: 12 }, (_, index) => ({ id: `invariant-${index}`, statement: `preserve invariant ${index} ${"x".repeat(180)}` }));
}

describe("mandatory MCP decision kernel", () => {
  it("keeps checkout/freshness identity and every declared invariant, and fail-closes an oversized concise plan", () => {
    process.env.CODEXA_MCP_STRUCTURED_BUDGET_BYTES = "4000";
    const packet: QueryResult = {
      freshness: freshness(),
      text: "wide plan",
      data: {
        mode: "change_plan",
        actionability: "edit_ready",
        editReadiness: { status: "edit-ready", editable: true, reason: "explicit target", source: "explicit-target" },
        runtime: { repoRoot: "/repo/worktree", gitHead: "head-active", routingSource: "workspace-focus-file", workspaceSessionId: "session-1" },
        snapshot: { taskId: "task-1", invariants: invariants(), planRevision: 1 },
        plannedEditTargets: ["src/a.ts"],
        requiredDependencyChecks: Array.from({ length: 20 }, (_, index) => ({ kind: "dependency", target: `edge-${index}`, status: "required" })),
        huge: Array.from({ length: 200 }, (_, index) => ({ index, value: "z".repeat(300) }))
      }
    };
    const kernel = mcpDecisionKernel(packet.data as Record<string, unknown>, "change_plan", packet.freshness);
    expect(kernel.detailsRequired).toBe(true);
    expect((kernel.identity as { checkout?: { repoRoot?: string; gitHead?: string }; freshness?: { headCommit?: string } }).checkout).toMatchObject({ repoRoot: "/repo/worktree", gitHead: "head-active" });
    expect((kernel.identity as { freshness?: { headCommit?: string } }).freshness?.headCommit).toBe("head-active");
    const kernelInvariants = kernel.invariants as Array<{ id: string; status: string }>;
    expect(kernelInvariants).toHaveLength(12);
    expect(kernelInvariants.every((entry) => entry.status === "declared")).toBe(true);
    expect(mcpAutoEscalationReason(packet)).toBe("decision-kernel-overflow");

    const compactedPacket = compactMcpResult(packet, { format: "concise" });
    expect(Buffer.byteLength(JSON.stringify(compactedPacket.data), "utf8")).toBeLessThanOrEqual(4000);
    const concise = withMcpDelivery(compactedPacket, {
      schemaVersion: 1,
      requestedFormat: "concise",
      effectiveFormat: "concise",
      resultId: `mr_${"a".repeat(64)}`,
      resultUri: `codexa://repo/mcp-results/rr_${"d".repeat(32)}/mr_${"a".repeat(64)}`
    });
    const data = concise.data as { actionability?: string; decisionKernel?: { authority?: { actionability?: string; originalActionability?: string }; identity?: unknown; invariants?: unknown[] } };
    expect(Buffer.byteLength(JSON.stringify(concise.data), "utf8")).toBeLessThanOrEqual(4000);
    expect(data.actionability).toBe("blocked");
    expect(data.decisionKernel?.authority).toMatchObject({ actionability: "blocked", originalActionability: "edit_ready" });
    expect(data.decisionKernel?.invariants).toHaveLength(12);
  });

  it.each([
    { missing: true, stale: true, reason: "missing-index" },
    { missing: false, stale: true, reason: "head-mismatch" }
  ])("fail-closes authority for unusable freshness: $reason", (state) => {
    const packet: QueryResult = {
      freshness: { ...freshness(), ...state },
      text: "unsafe freshness",
      data: {
        mode: "change_plan",
        actionability: "edit_ready",
        editReadiness: { status: "edit-ready", editable: true },
        runtime: { repoRoot: "/repo/worktree", gitHead: "head-active" },
        plannedEditTargets: ["src/a.ts"]
      }
    };
    const kernel = mcpDecisionKernel(packet.data as Record<string, unknown>, "change_plan", packet.freshness);
    expect(kernel.authority).toMatchObject({ actionability: "blocked" });
    expect(mcpAutoEscalationReason(packet)).toMatch(/index-(missing|stale)/u);
  });

  it("keeps a stable dirty overlay actionable without treating it as checkout identity drift", () => {
    const packet: QueryResult = {
      freshness: { ...freshness(), stale: true, reason: "dirty-files-changed" },
      text: "review the dirty worktree",
      data: {
        mode: "change_plan",
        actionability: "edit_ready",
        editReadiness: { status: "edit-ready", editable: true, source: "dirty-worktree" },
        runtime: { repoRoot: "/repo/worktree", gitHead: "head-active" },
        plannedEditTargets: ["src/a.ts"]
      }
    };

    const kernel = mcpDecisionKernel(packet.data as Record<string, unknown>, "change_plan", packet.freshness);
    expect(kernel.authority).toMatchObject({ actionability: "edit_ready" });
    expect(mcpAutoEscalationReason(packet)).toBeUndefined();
  });

  it("keeps oversized high-quality read-first context concise while exact lifecycle decisions still expand", () => {
    const packet: QueryResult = {
      freshness: freshness(),
      text: "read-first context",
      data: {
        mode: "task_brief",
        actionability: "inspect_first",
        quality: { level: "high" },
        runtime: { repoRoot: "/repo/worktree", gitHead: "head-active", knownClean: true },
        focusFiles: Array.from({ length: 20 }, (_, index) => ({ file: { path: `src/context-${index}.ts` }, reasons: ["read before editing"] })),
        nextReads: Array.from({ length: 20 }, (_, index) => `src/context-${index}.ts`),
        tests: Array.from({ length: 20 }, (_, index) => ({ path: `tests/context-${index}.test.ts`, command: `npm test -- tests/context-${index}.test.ts`, reason: "targeted coverage" })),
        verificationCommands: Array.from({ length: 20 }, (_, index) => `npm test -- tests/context-${index}.test.ts`),
        skillHints: {
          applicableSkills: [{ name: "site-hardening", matchedGlob: "src/**/*.ts", matchedPath: "src/context-0.ts", skillPath: ".claude/skills/site-hardening/SKILL.md" }]
        },
        targetPlaybooks: [{ module: "core", uri: "codexa://repo/codebase/playbooks/core.md", path: ".codex/codebase/playbooks/core.md" }],
        nextTools: [{ tool: "change_plan", reason: "save the focused plan" }]
      }
    };

    const kernel = mcpDecisionKernel(packet.data as Record<string, unknown>, "task_brief", packet.freshness);
    expect(kernel.detailsRequired ?? false).toBe(false);
    expect(kernel.authority).toMatchObject({ actionability: "inspect_first" });
    expect(kernel.identity).toMatchObject({ freshness: { headCommit: "head-active" } });
    expect(kernel.scope).toMatchObject({ nextReadCount: 20 });
    expect((kernel.scope as { nextReads?: string[] }).nextReads).toContain("src/context-0.ts");
    expect(kernel.verification).toMatchObject({ testCount: 20 });
    expect(kernel.nextTools).toMatchObject([{ tool: "change_plan" }]);
    expect(mcpAutoEscalationReason(packet)).toBeUndefined();

    const delivered = withMcpDelivery(compactMcpResult(packet, { format: "concise" }), {
      schemaVersion: 1,
      requestedFormat: "auto",
      effectiveFormat: "concise",
      resultId: `mr_${"b".repeat(64)}`,
      resultUri: `codexa://repo/mcp-results/rr_${"c".repeat(32)}/mr_${"b".repeat(64)}`
    });
    const rendered = renderMcpConciseText(delivered);
    expect(rendered).toContain("Read first: src/context-0.ts");
    expect(rendered).toContain("Skill and playbook hints: skill site-hardening");
    expect(rendered).toContain("codexa://repo/codebase/playbooks/core.md");

    const lowQuality = { ...packet, data: { ...(packet.data as Record<string, unknown>), quality: { level: "low" } } };
    expect(mcpDecisionKernel(lowQuality.data, "task_brief", lowQuality.freshness).authority).toMatchObject({ actionability: "blocked" });
    expect(mcpAutoEscalationReason(lowQuality)).toBe("low-context-quality");
  });

  it.each([
    {
      mode: "post_edit_review",
      data: {
        mode: "post_edit_review",
        actionability: "done",
        completionAuthority: "complete",
        inspectMode: "none",
        loopReview: { status: "resolved" },
        invariants: invariants(),
        invariantReviews: invariants().map(({ id }) => ({ invariantId: id, status: "satisfied" })),
        reviewTargets: Array.from({ length: 40 }, (_, index) => `src/review-${index}.ts`),
        changedSinceSnapshot: Array.from({ length: 40 }, (_, index) => ({ path: `src/review-${index}.ts`, status: "modified" })),
        verificationLedger: Array.from({ length: 40 }, (_, index) => ({ target: `check-${index}`, status: "covered", reason: "verified" }))
      }
    },
    {
      mode: "proof_card",
      data: {
        mode: "proof_card",
        actionability: "done",
        lifecycle: { status: "complete", invariants: invariants(), invariantReviews: invariants().map(({ id }) => ({ invariantId: id, status: "satisfied" })) },
        decisionLog: { status: "available", baselineIntact: true, summaryHashValid: true },
        gaps: [],
        nextCommands: Array.from({ length: 40 }, (_, index) => `npm test -- tests/proof-${index}.test.ts`),
        verification: { tests: Array.from({ length: 40 }, (_, index) => ({ path: `tests/proof-${index}.test.ts`, status: "covered" })) }
      }
    }
  ])("requires exact detail when a healthy oversized $mode authority kernel cannot fit", ({ mode, data }) => {
    const packet: QueryResult = { freshness: freshness(), text: "oversized authority", data };
    expect(mcpDecisionKernel(data, mode, packet.freshness).detailsRequired).toBe(true);
    expect(mcpAutoEscalationReason(packet)).toBe("decision-kernel-overflow");
  });

  it("keeps oversized advisory test selection monotone and concise at the terminal tier", () => {
    process.env.CODEXA_MCP_STRUCTURED_BUDGET_BYTES = "4000";
    const data = {
      mode: "test_plan",
      actionability: "verify",
      task: "t".repeat(240),
      query: "q".repeat(240),
      systemMessage: "s".repeat(240),
      runtime: { repoRoot: "/repo/worktree", gitHead: "head-active", routingSource: "r".repeat(60), workspaceSessionId: "w".repeat(100) },
      quality: { level: "high", score: 1, confidence: "authoritative", warnings: Array.from({ length: 5 }, () => "w".repeat(100)), reasons: Array.from({ length: 5 }, () => "r".repeat(100)) },
      worktree: { knownClean: true, degraded: false, dirtyFileCount: 0, warnings: Array.from({ length: 5 }, () => "w".repeat(100)), provenance: "p".repeat(100) },
      nextTools: Array.from({ length: 4 }, (_, index) => ({ tool: `tool${index}`, reason: "n".repeat(200), arguments: { file: "f".repeat(200) } })),
      targetFiles: Array.from({ length: 100 }, (_, index) => `src/${index}-${"x".repeat(150)}.ts`),
      tests: Array.from({ length: 100 }, (_, index) => ({ path: `tests/${index}-${"y".repeat(150)}.test.ts`, command: `npm test -- ${index}-${"z".repeat(150)}`, reason: "targeted coverage" })),
      verificationCommands: Array.from({ length: 100 }, (_, index) => `npm test -- ${index}-${"q".repeat(150)}`),
      verificationLedgerPreview: Array.from({ length: 100 }, (_, index) => ({ target: `target-${index}-${"r".repeat(150)}`, status: "required", reason: "not yet run" }))
    };
    const packet: QueryResult = { freshness: freshness(), text: "oversized test plan", data };
    const kernel = mcpDecisionKernel(data, "test_plan", packet.freshness);
    expect(kernel.detailsRequired ?? false).toBe(false);
    expect(kernel.authority).toMatchObject({ actionability: "verify" });
    expect(kernel.scope).toMatchObject({ targetFileCount: 100 });
    expect(kernel.verification).toMatchObject({ testCount: 100, commandCount: 100 });
    expect(mcpAutoEscalationReason(packet)).toBeUndefined();

    const compacted = compactMcpResult(packet, { format: "concise" });
    const compactedBytes = Buffer.byteLength(JSON.stringify(compacted.data), "utf8");
    expect(compactedBytes).toBeGreaterThan(3_600);
    expect(compactedBytes).toBeLessThanOrEqual(4_000);
    const delivered = withMcpDelivery(compacted, {
      schemaVersion: 1,
      requestedFormat: "auto",
      effectiveFormat: "concise",
      resultId: `mr_${"f".repeat(64)}`,
      resultUri: `codexa://repo/mcp-results/rr_${"e".repeat(32)}/mr_${"f".repeat(64)}`
    });
    const deliveredData = delivered.data as {
      actionability?: string;
      decisionKernel?: { authority?: { actionability?: string }; detailsRequired?: boolean };
      mcp?: { budgetCompaction?: string };
    };
    expect(deliveredData.mcp?.budgetCompaction).toBe("delivery");
    expect(deliveredData.actionability).toBe("verify");
    expect(deliveredData.decisionKernel?.authority).toMatchObject({ actionability: "verify" });
    expect(deliveredData.decisionKernel?.detailsRequired ?? false).toBe(false);
  });

  it.each([
    { name: "non-editable plan", mode: "change_plan", actionability: "edit_ready", editReadiness: { editable: false }, expected: "edit-target-not-ready" },
    { name: "degraded worktree", mode: "change_plan", actionability: "edit_ready", worktree: { degraded: true }, expected: "worktree-degraded" },
    { name: "low-quality plan", mode: "change_plan", actionability: "edit_ready", quality: { level: "low" }, expected: "low-context-quality" },
    { name: "replan-required completion", mode: "post_edit_review", actionability: "done", completionAuthority: "replan_required", expected: "completion-authority:replan_required" }
  ])("downgrades contradictory detailed and concise authority: $name", ({ expected, ...data }) => {
    const packet: QueryResult = { freshness: freshness(), text: "contradictory authority", data };
    const kernel = mcpDecisionKernel(data, String(data.mode), packet.freshness);
    expect(kernel.authority).toMatchObject({ actionability: "blocked" });
    expect(mcpAutoEscalationReason(packet)).toBe(expected);
    const detailed = withMcpDelivery(packet, { schemaVersion: 1, requestedFormat: "detailed", effectiveFormat: "detailed" });
    expect(detailed.data).toMatchObject({ actionability: "blocked", decisionKernel: { authority: { actionability: "blocked" } } });
  });

  it("keeps exact delivery budget, mandatory blockers, counts, and the detailed URI under adversarial identities", () => {
    process.env.CODEXA_MCP_STRUCTURED_BUDGET_BYTES = "4000";
    const longPath = `/repo/${"segment/".repeat(300)}worktree`;
    const manyInvariants = Array.from({ length: 16 }, (_, index) => ({ id: `${"hash".repeat(40)}-${index}`, statement: "x".repeat(500), status: index === 15 ? "violated" : "satisfied" }));
    const packet: QueryResult = {
      freshness: { ...freshness(), repoRoot: longPath },
      text: "adversarial",
      data: {
        mode: "post_edit_review",
        completionAuthority: "replan_required",
        runtime: { repoRoot: longPath, gitHead: "head-active" },
        invariants: manyInvariants,
        invariantReviews: manyInvariants.map(({ id, status }) => ({ invariantId: id, status })),
        loopReview: { status: "replan-required", attemptsSincePlan: 9, reasons: Array.from({ length: 20 }, (_, index) => `loop reason ${index} ${"r".repeat(200)}`) },
        gaps: Array.from({ length: 40 }, (_, index) => `gap ${index} ${"g".repeat(200)}`),
        testsNotRun: Array.from({ length: 40 }, (_, index) => ({ path: `tests/${index}.test.ts`, status: "missing" })),
        nextTools: [{ tool: "change_plan", reason: "replan before another edit" }],
        huge: Array.from({ length: 300 }, () => "z".repeat(500))
      }
    };
    const uri = `codexa://repo/mcp-results/rr_${"e".repeat(32)}/mr_${"c".repeat(64)}`;
    const delivered = withMcpDelivery(compactMcpResult(packet, { format: "concise" }), {
      schemaVersion: 1,
      requestedFormat: "concise",
      effectiveFormat: "concise",
      resultId: `mr_${"c".repeat(64)}`,
      resultUri: uri
    });
    const data = delivered.data as { decisionKernel: { authority: { actionability: string }; gapCount: number; gapsOmitted: number; invariants: Array<[string, string]> }; delivery: { resultUri: string } };
    expect(Buffer.byteLength(JSON.stringify(data), "utf8")).toBeLessThanOrEqual(4000);
    expect(data.decisionKernel.authority.actionability).toBe("blocked");
    expect(data.decisionKernel.gapCount).toBe(40);
    expect(data.decisionKernel.gapsOmitted).toBeGreaterThan(0);
    expect(data.delivery.resultUri).toBe(uri);
    const text = renderMcpConciseText(delivered);
    expect(text.length).toBeLessThanOrEqual(2400);
    expect(text).toContain("Actionability: blocked");
    expect(text).toContain("Verification unresolved (40)");
    expect(text).toContain("Gaps (40)");
    expect(text).toContain("Next: change_plan");
    expect(text).toContain(data.decisionKernel.invariants.at(-1)![0]);
    expect(text).toContain("violated=1");
    expect(text).toContain(uri);
  });

  it("projects real proof artifact arrays and counts only non-passing rejects", () => {
    const packet: QueryResult = {
      freshness: freshness(),
      text: "proof artifacts",
      data: {
        mode: "proof_card",
        runtime: { repoRoot: "/repo/worktree", gitHead: "head-active" },
        verification: {
          artifacts: {
            selected: [{ artifactId: "a" }, { artifactId: "b" }, { artifactId: "c" }],
            accepted: [{ artifactId: "a", status: "accepted" }],
            rejected: [{ artifactId: "b", status: "non_passing" }, { artifactId: "c", status: "invalid" }],
            ledgerEvidence: [{ artifactId: "a", status: "accepted" }]
          }
        }
      }
    };
    const kernel = mcpDecisionKernel(packet.data as Record<string, unknown>, "proof_card", packet.freshness) as { verification: { artifacts: Record<string, unknown> } };
    expect(kernel.verification.artifacts).toMatchObject({ selectedCount: 3, acceptedCount: 1, rejectedCount: 2, nonPassingCount: 1, ledgerEvidenceCount: 1 });
  });

  it("blocks checkout/HEAD mismatch and exposes both identities to text-only hosts", () => {
    const packet: QueryResult = {
      freshness: freshness("indexed-head"),
      text: "identity mismatch",
      data: {
        mode: "task_brief",
        actionability: "edit_ready",
        runtime: { repoRoot: "/repo/worktree", gitHead: "active-head", routingSource: "workspace-focus-file" },
        focusFiles: [{ path: "src/a.ts" }]
      }
    };
    const compact = withMcpDelivery(compactMcpResult(packet, { format: "concise" }), {
      schemaVersion: 1,
      requestedFormat: "concise",
      effectiveFormat: "concise",
      resultId: `mr_${"b".repeat(64)}`,
      resultUri: `codexa://repo/mcp-results/rr_${"f".repeat(32)}/mr_${"b".repeat(64)}`
    });
    expect((compact.data as { actionability?: string }).actionability).toBe("blocked");
    expect(mcpAutoEscalationReason(packet)).toBe("checkout-index-identity-mismatch");
    const text = renderMcpConciseText(compact);
    expect(text).toContain("/repo/worktree");
    expect(text).toContain("HEAD active-head");
    expect(text).toContain("indexed HEAD indexed-head");
  });

  it("preserves post-edit loop counters, all invariant review states, and proof blockers at 4KB", () => {
    process.env.CODEXA_MCP_STRUCTURED_BUDGET_BYTES = "4000";
    const declared = invariants();
    const reviews = declared.map((entry, index) => ({ invariantId: entry.id, status: index === 11 ? "violated" : "satisfied", reason: `review-${index}` }));
    const post: QueryResult = {
      freshness: freshness(),
      text: "post review",
      data: {
        mode: "post_edit_review",
        verdict: "replan",
        completionAuthority: "replan_required",
        inspectMode: "required",
        runtime: { repoRoot: "/repo/worktree", gitHead: "head-active" },
        invariants: declared,
        invariantReviews: reviews,
        loopReview: {
          policyVersion: "task-loop-v1",
          attemptId: "attempt-3",
          attemptStatus: "unresolved",
          totalDistinctAttempts: 3,
          attemptsSincePlan: 3,
          unresolvedAttemptsSincePlan: 3,
          recurringFailures: [{ class: "verification-failed", fingerprint: "failure-fingerprint", count: 3 }],
          cumulativeDiffGrowth: { firstTrackedLines: 10, currentTrackedLines: 30, peakTrackedLines: 30, newFilesSinceFirstAttempt: 2, peakModifiedSymbols: 4 },
          status: "replan-required",
          reasons: ["same failure recurred while diff grew"]
        },
        testsNotRun: Array.from({ length: 20 }, (_, index) => ({ path: `tests/${index}.test.ts`, status: "missing" })),
        verificationLedger: Array.from({ length: 20 }, (_, index) => ({ kind: "test", target: `tests/${index}.test.ts`, status: "missing" })),
        huge: Array.from({ length: 200 }, (_, index) => ({ index, value: "x".repeat(300) }))
      }
    };
    const compactPost = compactMcpResult(post, { format: "concise" });
    expect(Buffer.byteLength(JSON.stringify(compactPost.data), "utf8")).toBeLessThanOrEqual(4000);
    const postKernel = (compactPost.data as { decisionKernel: Record<string, unknown> }).decisionKernel;
    expect((postKernel.invariants as unknown[])).toHaveLength(12);
    expect((postKernel.invariants as Array<{ id: string; status: string }>).at(-1)).toMatchObject({ id: "invariant-11", status: "violated" });
    expect(postKernel.loop).toMatchObject({ attemptsSincePlan: 3, unresolvedAttemptsSincePlan: 3, recurringFailures: [{ class: "verification-failed", count: 3 }], cumulativeDiffGrowth: { currentTrackedLines: 30, newFilesSinceFirstAttempt: 2 } });
    expect(postKernel.verification).toBeTruthy();

    const proof: QueryResult = {
      freshness: freshness(),
      text: "proof",
      data: {
        mode: "proof_card",
        actionability: "verify",
        runtime: { repoRoot: "/repo/worktree", gitHead: "head-active" },
        lifecycle: { status: "loaded", invariants: declared, invariantReviews: reviews, pendingStop: { reasons: ["replan"] } },
        decisionLog: { status: "loaded", baselineIntact: false, summaryHashValid: false, warnings: ["digest mismatch"] },
        verification: { reported: { hasEvidence: true, testsNotRun: [{ path: "tests/missing.test.ts" }] }, recommendedCommands: ["npm test"] },
        gaps: ["task invariant violated: invariant-11", "task-bound decision log differs"]
      }
    };
    expect(mcpAutoEscalationReason(proof)).toBe("proof-invariant-unresolved");
    const proofKernel = mcpDecisionKernel(proof.data as Record<string, unknown>, "proof_card", proof.freshness);
    expect((proofKernel.invariants as Array<{ id: string; status: string }>).at(-1)).toMatchObject({ id: "invariant-11", status: "violated" });
    expect(proofKernel.decisionLog).toMatchObject({ baselineIntact: false, summaryHashValid: false });
    expect(proofKernel.verification).toBeTruthy();
  });
});
