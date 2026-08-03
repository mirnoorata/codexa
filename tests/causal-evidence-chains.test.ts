import { describe, expect, it } from "vitest";
import { compactMcpResult } from "../src/mcp/compaction.js";
import { mcpDecisionKernel, renderMcpConciseText, withMcpDelivery } from "../src/mcp/decision-kernel.js";
import { compactEvidenceDecisionSection } from "../src/mcp/evidence-decision-kernel.js";
import { createPostEditReviewCoverage } from "../src/post-edit-review-coverage.js";
import { buildChangeEvidenceChains, changeEvidenceGraphCacheFootprint } from "../src/query/change-plan/evidence-chains.js";
import { refsFromQueryResult } from "../src/session-memory/derivation.js";
import { isTaskSnapshot } from "../src/task-snapshots.js";
import {
  CHANGE_EVIDENCE_LIMITS,
  isChangeEvidenceBundleV1,
  type ChangeEvidenceBundleV1,
  type CodexaIndex,
  type FileFact,
  type FreshnessInfo,
  type GraphEdgeFact,
  type GraphEdgeKind,
  type GraphNodeKind,
  type QueryResult,
  type SymbolFact
} from "../src/types.js";

describe("bounded causal change evidence", () => {
  it("returns deterministic, diverse chains without expanding edit authority", () => {
    const index = evidenceIndex();
    const input = {
      index,
      task: "Change the handler safely",
      anchors: [{ path: "src/handler.ts", authority: "explicit-target" as const }],
      editTargets: ["src/handler.ts"],
      tests: [{ path: "tests/handler.test.ts", reason: "direct test", rank: 10, evidenceTier: "authoritative" as const }],
      freshness: index.freshness
    };
    const first = buildChangeEvidenceChains(input);
    const shuffled = buildChangeEvidenceChains({ ...input, index: { ...index, graphEdges: [...index.graphEdges].reverse() } });

    expect(first).toEqual(shuffled);
    expect(first.chains.map((chain) => chain.purpose)).toEqual(expect.arrayContaining(["verification", "risk"]));
    expect(first.chains).toHaveLength(3);
    expect(first.chains.every((chain) => chain.roles.editTargets.join() === "src/handler.ts")).toBe(true);
    expect(first.chains.flatMap((chain) => chain.roles.editTargets)).not.toContain("src/caller.ts");
    expect(first.chains.find((chain) => chain.purpose === "verification")?.roles.verifyTargets).toContain("tests/handler.test.ts");
    expect(first.chains.every((chain) => chain.segments.every((segment) => index.graphEdges.some((edge) => edge.id === segment.id)))).toBe(true);
    expect(first.fingerprint).toMatch(/^[a-f0-9]{16}$/u);
    expect(isChangeEvidenceBundleV1(first)).toBe(true);

    const withoutRecommendations = buildChangeEvidenceChains({ ...input, tests: [] });
    expect(withoutRecommendations.chains.map((chain) => chain.chainId)).toEqual(first.chains.map((chain) => chain.chainId));
    expect(withoutRecommendations.fingerprint).not.toBe(first.fingerprint);

    const wideAuthority = buildChangeEvidenceChains({
      ...input,
      editTargets: ["src/handler.ts", ...Array.from({ length: 20 }, (_, index) => `src/authorized-${index}.ts`)]
    });
    expect(isChangeEvidenceBundleV1(wideAuthority)).toBe(true);
    expect(wideAuthority.fingerprint).not.toBe(first.fingerprint);
    expect(wideAuthority.chains.flatMap((chain) => chain.roles.editTargets)).toEqual(["src/handler.ts", "src/handler.ts", "src/handler.ts"]);
  });

  it("bounds high fanout traversal and discloses lower-bound chain totals", () => {
    const base = evidenceIndex();
    const extraFiles = Array.from({ length: 80 }, (_, index) => file(`tests/fanout-${index}.test.ts`, true));
    const extraEdges = extraFiles.map((test, index) => edge(`fanout-${index}`, "TESTS", test.id, fileId("src/handler.ts"), test.path, "src/handler.ts", "file", "file"));
    const index = { ...base, files: [...base.files, ...extraFiles], graphEdges: [...base.graphEdges, ...extraEdges] };
    const result = buildChangeEvidenceChains({
      index,
      task: "fanout",
      anchors: [{ path: "src/handler.ts", authority: "explicit-target" }],
      editTargets: ["src/handler.ts"]
    });

    expect(result.chains.length).toBeLessThanOrEqual(CHANGE_EVIDENCE_LIMITS.maxChains);
    expect(result.chains.every((chain) => chain.segments.length <= CHANGE_EVIDENCE_LIMITS.maxSegmentsPerChain)).toBe(true);
    expect(result.truncation?.chains).toMatchObject({ returned: result.chains.length });
    expect(result.truncation?.chains?.total).toBeGreaterThan(result.chains.length);
    expect(result.truncation?.chains?.exact).toBe(true);
    expect(result.traversal.capped).toBe(false);
    expect(result.gaps.join(" ")).toContain("all traversed candidates were scored");
    expect(result.traversal.visitedNodes).toBeLessThanOrEqual(CHANGE_EVIDENCE_LIMITS.maxVisitedNodes);
    expect(result.traversal.examinedEdges).toBeLessThanOrEqual(CHANGE_EVIDENCE_LIMITS.maxExaminedEdges);
  });

  it("retains only compact directional edge references before bounded traversal", () => {
    const base = evidenceIndex();
    const edgeCount = 20_000;
    const index: CodexaIndex = {
      ...base,
      files: [file("src/handler.ts")],
      graphEdges: Array.from({ length: edgeCount }, (_, index) =>
        edge(`compact-${index}`, "CALLS", fileId("src/handler.ts"), `symbol-${index}`, "src/handler.ts", `src/target-${index}.ts`, "file", "symbol")
      )
    };

    expect(changeEvidenceGraphCacheFootprint(index)).toEqual({
      edgeCount,
      edgeReferenceCount: edgeCount * 2,
      edgeReferenceBytes: edgeCount * 2 * Uint32Array.BYTES_PER_ELEMENT
    });
    const result = buildChangeEvidenceChains({
      index,
      anchors: [{ path: "src/handler.ts", authority: "explicit-target" }],
      editTargets: ["src/handler.ts"]
    });
    expect(result.traversal).toMatchObject({ examinedEdges: CHANGE_EVIDENCE_LIMITS.maxExaminedEdges, capped: true });
  });

  it("retains a late verification chain after a high-fanout runtime reservoir", () => {
    const base = evidenceIndex();
    const callees = Array.from({ length: 50 }, (_, index) => file(`src/callee-${index}.ts`));
    const test = file("tests/late-verification.test.ts", true);
    const result = buildChangeEvidenceChains({
      index: {
        ...base,
        files: [base.files[0]!, ...callees, test],
        graphEdges: [
          ...callees.map((callee, index) => edge(`call-${index}`, "CALLS", fileId("src/handler.ts"), callee.id, "src/handler.ts", callee.path, "file", "file")),
          edge("late-test", "TESTS", test.id, fileId("src/handler.ts"), test.path, "src/handler.ts", "test", "file")
        ]
      },
      anchors: [{ path: "src/handler.ts", authority: "explicit-target" }],
      editTargets: ["src/handler.ts"]
    });

    expect(result.chains.map((chain) => chain.purpose)).toContain("verification");
    expect(result.traversal.capped).toBe(false);
    expect(result.truncation?.chains?.exact).toBe(true);
  });

  it("starts from a validated symbol and its file fallback so file-only evidence remains visible", () => {
    const base = evidenceIndex();
    const anchorSymbol = symbol("symbol-handler", "src/handler.ts");
    const index: CodexaIndex = {
      ...base,
      symbols: [anchorSymbol],
      graphEdges: [
        edge("symbol-runtime", "CALLS", anchorSymbol.id, fileId("src/dependency.ts"), anchorSymbol.path, "src/dependency.ts", "symbol", "file"),
        edge("file-test", "TESTS", fileId("tests/handler.test.ts"), fileId("src/handler.ts"), "tests/handler.test.ts", "src/handler.ts", "file", "file"),
        edge("file-risk", "RISK", fileId("src/handler.ts"), "risk-handler", "src/handler.ts", "src/handler.ts", "file", "risk")
      ]
    };
    const input = {
      index,
      anchors: [{ path: "src/handler.ts", symbolId: anchorSymbol.id, authority: "explicit-target" as const }],
      editTargets: ["src/handler.ts"]
    };
    const result = buildChangeEvidenceChains(input);

    expect(result.chains.map((chain) => chain.purpose)).toEqual(["verification", "risk", "runtime"]);
    expect(result.chains.flatMap((chain) => chain.segments.map((segment) => segment.id))).toEqual(expect.arrayContaining(["symbol-runtime", "file-test", "file-risk"]));
    const invalidSymbolFallback = buildChangeEvidenceChains({
      ...input,
      anchors: [{ path: "src/handler.ts", symbolId: "missing-symbol", authority: "explicit-target" }]
    });
    expect(invalidSymbolFallback.chains.map((chain) => chain.purpose)).toEqual(expect.arrayContaining(["verification", "risk"]));
    expect(invalidSymbolFallback.gaps).not.toContain("no graph node is available for src/handler.ts");
  });

  it("balances represented targets and purposes deterministically within the three-chain budget", () => {
    const base = evidenceIndex();
    const anchorPaths = ["src/a.ts", "src/b.ts", "src/c.ts"];
    const testPaths = anchorPaths.map((_, index) => `tests/target-${index}.test.ts`);
    const graphEdges = [
      ...anchorPaths.map((anchorPath, index) => edge(`verify-${index}`, "TESTS", fileId(testPaths[index]), fileId(anchorPath), testPaths[index], anchorPath, "file", "file")),
      edge("risk-a", "RISK", fileId("src/a.ts"), "risk-a", "src/a.ts", "src/a.ts", "file", "risk")
    ];
    const input = {
      index: {
        ...base,
        files: [...anchorPaths.map((path) => file(path)), ...testPaths.map((path) => file(path, true))],
        graphEdges
      },
      anchors: anchorPaths.map((path) => ({ path, authority: "explicit-target" as const })),
      editTargets: anchorPaths
    };
    const first = buildChangeEvidenceChains(input);
    const shuffled = buildChangeEvidenceChains({ ...input, index: { ...input.index, graphEdges: [...graphEdges].reverse() } });
    const representedTargets = new Set(first.chains.map((chain) => chain.anchor.path));
    const representedPurposes = new Set(first.chains.map((chain) => chain.purpose));

    expect(first.chains).toHaveLength(CHANGE_EVIDENCE_LIMITS.maxChains);
    expect(representedTargets.size).toBe(2);
    expect(representedPurposes).toEqual(new Set(["verification", "risk"]));
    expect(first).toMatchObject({ analyzedTargetCount: 3, representedTargetCount: 2, unrepresentedTargetCount: 1 });
    expect(first.gaps.join(" ")).toContain("1 analyzed target(s) are not represented");
    expect(first.chains.map((chain) => chain.chainId)).toEqual(shuffled.chains.map((chain) => chain.chainId));
  });

  it("keeps converging diamond evidence and fingerprints invariant to graph edge order", () => {
    const base = evidenceIndex();
    const anchorPath = "src/a.ts";
    const leftPath = "src/b.ts";
    const rightPath = "src/c.ts";
    const convergencePath = "src/d.ts";
    const graphEdges = [
      edge("a-b", "CALLS", fileId(anchorPath), fileId(leftPath), anchorPath, leftPath, "file", "file"),
      edge("a-c", "CALLS", fileId(anchorPath), fileId(rightPath), anchorPath, rightPath, "file", "file"),
      edge("b-d", "CALLS", fileId(leftPath), fileId(convergencePath), leftPath, convergencePath, "file", "file"),
      edge("c-d", "CALLS", fileId(rightPath), fileId(convergencePath), rightPath, convergencePath, "file", "file"),
      edge("d-risk", "RISK", fileId(convergencePath), "risk-d", convergencePath, convergencePath, "file", "risk")
    ];
    const input = {
      index: {
        ...base,
        files: [anchorPath, leftPath, rightPath, convergencePath].map((path) => file(path)),
        graphEdges
      },
      task: "change the diamond safely",
      anchors: [{ path: anchorPath, authority: "explicit-target" as const }],
      editTargets: [anchorPath]
    };

    const first = buildChangeEvidenceChains(input);
    const shuffled = buildChangeEvidenceChains({ ...input, index: { ...input.index, graphEdges: [...graphEdges].reverse() } });

    expect(shuffled).toEqual(first);
    expect(first.chains.find((chain) => chain.purpose === "risk")?.summary).toContain(`${anchorPath} -CALLS-> ${leftPath}`);
  });

  it("rejects malformed portable snapshot evidence", () => {
    const bundle = buildChangeEvidenceChains({
      index: evidenceIndex(),
      anchors: [{ path: "src/handler.ts", authority: "explicit-target" }],
      editTargets: ["src/handler.ts"]
    });
    const forged = structuredClone(bundle);
    forged.chains[0]!.roles.readDependencies = ["../outside.ts"];
    expect(isChangeEvidenceBundleV1(forged)).toBe(false);
    expect(isTaskSnapshot(snapshotWithEvidence(forged))).toBe(false);

    const oversized = structuredClone(bundle);
    oversized.chains = Array.from({ length: CHANGE_EVIDENCE_LIMITS.maxChains + 1 }, () => bundle.chains[0]!);
    expect(isChangeEvidenceBundleV1(oversized)).toBe(false);
    expect(isTaskSnapshot(snapshotWithEvidence(bundle))).toBe(true);
    expect(isTaskSnapshot(snapshotWithEvidence(oversized))).toBe(false);

    const wrongAuthority = structuredClone(bundle);
    wrongAuthority.chains[0]!.roles.editTargets = ["src/dependency.ts"];
    expect(isChangeEvidenceBundleV1(wrongAuthority)).toBe(true);
    expect(isTaskSnapshot(snapshotWithEvidence(wrongAuthority))).toBe(false);
    const wrongSnapshot = snapshotWithEvidence(bundle) as { snapshotFreshness: FreshnessInfo };
    wrongSnapshot.snapshotFreshness = { ...wrongSnapshot.snapshotFreshness, snapshotId: "different-snapshot" };
    expect(isTaskSnapshot(wrongSnapshot)).toBe(false);
    const wrongAnchorAuthority = structuredClone(bundle);
    wrongAnchorAuthority.chains[0]!.anchor.authority = "observed-edit";
    expect(isTaskSnapshot(snapshotWithEvidence(wrongAnchorAuthority))).toBe(false);
    const wrongAnchorPath = structuredClone(bundle);
    wrongAnchorPath.chains[0]!.anchor.path = "src/dependency.ts";
    wrongAnchorPath.chains[0]!.roles.editTargets = [];
    expect(isTaskSnapshot(snapshotWithEvidence(wrongAnchorPath))).toBe(false);
  });

  it("reports targets skipped by a global traversal cap", () => {
    const base = evidenceIndex();
    const supportEdges = Array.from({ length: CHANGE_EVIDENCE_LIMITS.maxVisitedNodes + 4 }, (_, index) =>
      edge(`support-${index}`, "DEFINES", fileId("src/handler.ts"), `symbol-${index}`, "src/handler.ts", "src/handler.ts", "file", "symbol")
    );
    const result = buildChangeEvidenceChains({
      index: { ...base, graphEdges: supportEdges },
      anchors: [
        { path: "src/handler.ts", authority: "explicit-target" },
        { path: "src/dependency.ts", authority: "explicit-target" }
      ],
      editTargets: ["src/handler.ts", "src/dependency.ts"]
    });

    expect(result).toMatchObject({ requestedTargetCount: 2, analyzedTargetCount: 1, omittedTargetCount: 1, traversal: { capped: true } });
    expect(result.truncation?.targets).toEqual({ total: 2, returned: 1 });
    expect(result.gaps.join(" ")).toContain("omitted after traversal reached");
    expect(isChangeEvidenceBundleV1(result)).toBe(true);
  });

  it("does not invent causal links between co-callees", () => {
    const base = evidenceIndex();
    const result = buildChangeEvidenceChains({
      index: {
        ...base,
        files: [file("src/a.ts"), file("src/b.ts"), file("src/c.ts")],
        graphEdges: [
          edge("b-a", "CALLS", fileId("src/b.ts"), fileId("src/a.ts"), "src/b.ts", "src/a.ts", "file", "file"),
          edge("b-c", "CALLS", fileId("src/b.ts"), fileId("src/c.ts"), "src/b.ts", "src/c.ts", "file", "file")
        ]
      },
      anchors: [{ path: "src/a.ts", authority: "explicit-target" }],
      editTargets: ["src/a.ts"]
    });

    expect(result.chains.some((chain) => chain.roles.readDependencies.includes("src/c.ts"))).toBe(false);
    expect(result.chains.some((chain) => chain.summary.includes("src/c.ts"))).toBe(false);
    expect(result.chains[0]?.summary).toContain("src/b.ts -CALLS-> src/a.ts");
  });

  it("keeps generated evidence inside portable text bounds", () => {
    const anchorPath = `src/${"a".repeat(150)}/${"b".repeat(150)}.ts`;
    const terminalPath = `src/${"c".repeat(150)}/${"d".repeat(150)}.ts`;
    const base = evidenceIndex();
    const anchor = { ...file(anchorPath), id: "long-anchor" };
    const terminal = { ...file(terminalPath), id: "long-terminal" };
    const result = buildChangeEvidenceChains({
      index: {
        ...base,
        files: [anchor, terminal],
        graphEdges: [edge("long-call", "CALLS", anchor.id, terminal.id, anchorPath, terminalPath, "file", "file")]
      },
      anchors: [{ path: anchorPath, authority: "explicit-target" }],
      editTargets: [anchorPath],
      tests: [{ path: terminalPath, reason: "r".repeat(700), rank: 1, command: "x".repeat(2_500), commandCwd: "." }]
    });

    expect(result.chains[0]?.summary.length).toBeLessThanOrEqual(320);
    expect(result.chains[0]?.segments[0]?.reason.length).toBeLessThanOrEqual(500);
    expect(isChangeEvidenceBundleV1(result)).toBe(true);
  });

  it("keeps advisory chain paths out of session-memory scope and preserves them in the decision kernel", () => {
    const index = evidenceIndex();
    const bundle = buildChangeEvidenceChains({
      index,
      task: "scope",
      anchors: [{ path: "src/handler.ts", authority: "explicit-target" }],
      editTargets: ["src/handler.ts"]
    });
    const data = {
      mode: "change_plan",
      files: ["src/handler.ts"],
      plannedEditTargets: ["src/handler.ts"],
      targetRoles: { editableTargets: ["src/handler.ts"], readDependencies: [], excludedTargets: [] },
      tests: [],
      requiredWorkflowChecks: [],
      requiredDependencyChecks: [],
      evidenceChains: bundle
    };

    const refs = refsFromQueryResult(data, index);
    expect(refs.map((ref) => ref.path)).toContain("src/handler.ts");
    expect(refs.map((ref) => ref.path)).not.toContain("src/caller.ts");
    const kernel = mcpDecisionKernel(data, "change_plan", index.freshness);
    expect(kernel).toMatchObject({
      authority: { actionability: "edit_ready" },
      evidence: { chainCount: 3, requestedTargetCount: 1, analyzedTargetCount: 1, omittedTargetCount: 0 }
    });
    expect(JSON.stringify(kernel)).toContain("src/handler.ts");
    const compacted = compactMcpResult({ freshness: index.freshness, text: "change plan", data });
    expect(compacted.data).toMatchObject({
      evidenceChains: { fingerprint: bundle.fingerprint, chainCount: 3 },
      decisionKernel: { evidence: { chainCount: 3, analyzedTargetCount: 1 } }
    });
    expect(renderMcpConciseText(compacted)).toContain("Causal evidence: 3 chain(s) across 1 of 1 analyzed target(s)");
    const bounded = compactMcpResult({ freshness: index.freshness, text: "change plan", data }, { format: "concise", targetBytes: 4_000 });
    const delivered = withMcpDelivery(bounded, {
      schemaVersion: 1,
      requestedFormat: "concise",
      effectiveFormat: "concise",
      detailAvailable: true
    });
    expect(delivered.data).toMatchObject({ actionability: "edit_ready", decisionKernel: { authority: { actionability: "edit_ready" } } });
    expect((delivered.data as { delivery?: { requiredDetailReason?: string } }).delivery?.requiredDetailReason).not.toBe("target-role-boundaries-truncated");
  });

  it("preserves bounded max-bundle identity, omission accounting, and warnings across decision tiers", () => {
    const bundle = maximumEvidenceBundle();
    expect(isChangeEvidenceBundleV1(bundle)).toBe(true);
    const kernel = mcpDecisionKernel({ mode: "change_plan", actionability: "edit_ready", plannedEditTargets: ["src/handler.ts"], evidenceChains: bundle }, "change_plan", evidenceIndex().freshness);
    const evidence = kernel.evidence as Record<string, unknown>;
    const narrow = compactEvidenceDecisionSection(evidence, "narrow")!;
    const emergency = compactEvidenceDecisionSection(evidence, "emergency")!;
    const firstChainId = bundle.chains[0]!.chainId;

    expect(evidence).toMatchObject({ chainCount: 3, chainTruncatedCount: 3, chainsWithGaps: 3, traversalCapped: true });
    expect((narrow.chains as Array<{ chainId: string }>)[0]?.chainId).toBe(firstChainId);
    expect((emergency.chains as Array<{ chainId: string }>)[0]?.chainId).toBe(firstChainId);
    expect(emergency).toMatchObject({ chainCount: 3, chainsOmitted: 2, chainTruncatedCount: 3, chainsWithGaps: 3 });
    const rendered = renderMcpConciseText({
      freshness: evidenceIndex().freshness,
      text: "max evidence",
      data: { mode: "change_plan", actionability: "edit_ready", decisionKernel: kernel }
    });
    expect(rendered).toContain("Causal evidence: 3 chain(s)");
    expect(rendered).toContain("traversal capped");
    expect(rendered).toContain("3 chain(s) truncated");
  });

  it("keeps exact change-plan target roles actionable at 4KB with or without maximum valid evidence", () => {
    const targetPath = `src/${"a".repeat(280)}.ts`;
    expect(targetPath).toHaveLength(287);
    const targetRoles = {
      editableTargets: [targetPath],
      readDependencies: ["src/dependency.ts"],
      excludedTargets: ["src/generated.ts"],
      hasReferenceCue: true,
      unresolvedReferenceCue: false
    };
    const base = {
      mode: "change_plan",
      actionability: "edit_ready",
      editReadiness: { editable: true, status: "edit-ready", reason: "explicit target", source: "explicit-target" },
      files: [targetPath],
      plannedEditTargets: [targetPath],
      targetRoles,
      tests: [],
      requiredWorkflowChecks: [],
      requiredDependencyChecks: []
    };
    const withoutEvidence = deliverAtBudget(base, 4_000);
    const withEvidence = deliverAtBudget({ ...base, evidenceChains: maximumEvidenceBundle() }, 4_000);
    const data = withEvidence.data as {
      actionability?: string;
      targetRoles?: typeof targetRoles;
      delivery?: { requiredDetailReason?: string; escalationReason?: string };
      decisionKernel?: { authority?: { actionability?: string }; detailsRequired?: boolean };
    };

    expect(decisionAuthority(withEvidence)).toEqual(decisionAuthority(withoutEvidence));
    expect(decisionAuthority(withEvidence)).toMatchObject({ effectiveActionability: "edit_ready", actionability: "edit_ready" });
    expect(data.targetRoles).toEqual(targetRoles);
    expect(data.decisionKernel?.detailsRequired ?? false).toBe(false);
    expect(data.delivery?.requiredDetailReason).not.toBe("target-role-boundaries-truncated");
    expect(data.delivery?.escalationReason ?? "").not.toContain("target-role-boundaries-truncated");
  });

  it.each([
    { mode: "proof_card" as const, budget: 4_000 },
    { mode: "proof_card" as const, budget: 12_000 },
    { mode: "post_edit_review" as const, budget: 4_000 },
    { mode: "post_edit_review" as const, budget: 12_000 }
  ])("keeps $mode lifecycle authority unchanged by maximum evidence at $budget bytes", ({ mode, budget }) => {
    const base = lifecyclePacketData(mode);
    const withoutEvidence = deliverAtBudget(base, budget);
    const withEvidence = deliverAtBudget({ ...base, evidenceChains: maximumEvidenceBundle() }, budget);

    expect(decisionAuthority(withEvidence)).toEqual(decisionAuthority(withoutEvidence));
    expect(decisionAuthority(withEvidence)).toEqual({
      effectiveActionability: "done",
      actionability: "done",
      verdict: "pass",
      completionAuthority: "complete"
    });
    expect(Buffer.byteLength(JSON.stringify(withEvidence.data), "utf8")).toBeLessThanOrEqual(budget);
  });
});

function evidenceIndex(): CodexaIndex {
  const files = [
    file("src/handler.ts"),
    file("src/dependency.ts"),
    file("src/caller.ts"),
    file("tests/handler.test.ts", true)
  ];
  const freshness: FreshnessInfo = {
    schemaVersion: 1,
    snapshotId: "snapshot-evidence",
    repoRoot: "/repo",
    gitRoot: "/repo",
    headCommit: "abc",
    indexedAt: "2026-08-03T00:00:00.000Z",
    dirtyFiles: [],
    dirtyFileHashes: {},
    indexedDirtyFileHashes: {},
    indexedDirtyFiles: [],
    missing: false,
    stale: false,
    reason: "fresh",
    parserErrorCount: 0
  };
  return {
    schemaVersion: 1,
    snapshot: {
      id: "snapshot-fact",
      type: "RepoSnapshot",
      source: "git",
      confidence: "authoritative",
      snapshotId: freshness.snapshotId,
      indexedAt: freshness.indexedAt,
      repoRoot: "/repo",
      gitRoot: "/repo",
      headCommit: "abc",
      dirtyFiles: []
    },
    freshness,
    files,
    symbols: [],
    usageSites: [],
    imports: [],
    testEdges: [],
    graphEdges: [
      edge("test-handler", "TESTS", fileId("tests/handler.test.ts"), fileId("src/handler.ts"), "tests/handler.test.ts", "src/handler.ts", "test", "file"),
      edge("handler-risk", "RISK", fileId("src/handler.ts"), "risk-handler", "src/handler.ts", "src/handler.ts", "file", "risk"),
      edge("handler-dependency", "CALLS", fileId("src/handler.ts"), fileId("src/dependency.ts"), "src/handler.ts", "src/dependency.ts", "file", "file"),
      edge("caller-handler", "CALLS", fileId("src/caller.ts"), fileId("src/handler.ts"), "src/caller.ts", "src/handler.ts", "file", "file")
    ],
    workflows: [],
    modules: [],
    risks: [],
    parserErrors: []
  };
}

function maximumEvidenceBundle(): ChangeEvidenceBundleV1 {
  const index = evidenceIndex();
  const base = buildChangeEvidenceChains({
    index,
    task: "maximum valid evidence",
    anchors: [{ path: "src/handler.ts", authority: "explicit-target" }],
    editTargets: ["src/handler.ts"]
  });
  const chains = base.chains.map((chain, chainIndex) => {
    const segment = chain.segments[0]!;
    const verifyTargets = Array.from({ length: CHANGE_EVIDENCE_LIMITS.maxTestsPerChain }, (_, index) => `tests/max-${chainIndex}-${index}.test.ts`);
    return {
      ...chain,
      summary: `chain-${chainIndex}-${"s".repeat(312)}`.slice(0, 320),
      anchor: {
        ...chain.anchor,
        candidateId: "c".repeat(160),
        symbolId: "s".repeat(240)
      },
      subsystem: {
        kind: "workflow" as const,
        id: "w".repeat(200),
        label: "l".repeat(240),
        confidence: "derived" as const
      },
      segments: Array.from({ length: CHANGE_EVIDENCE_LIMITS.maxSegmentsPerChain }, (_, index) => ({
        ...segment,
        id: `max-segment-${chainIndex}-${index}`,
        reason: "r".repeat(500)
      })),
      roles: {
        editTargets: Array.from({ length: CHANGE_EVIDENCE_LIMITS.maxPathsPerChain }, (_, index) => `src/evidence-edit-${chainIndex}-${index}.ts`),
        readDependencies: Array.from({ length: CHANGE_EVIDENCE_LIMITS.maxPathsPerChain }, (_, index) => `src/evidence-read-${chainIndex}-${index}.ts`),
        verifyTargets
      },
      tests: verifyTargets.map((path, index) => ({
        path,
        reason: `test-${index}-${"r".repeat(500)}`.slice(0, 500),
        evidenceTier: "derived" as const,
        command: "x".repeat(2_000),
        commandCwd: "."
      })),
      gaps: Array.from({ length: CHANGE_EVIDENCE_LIMITS.maxGaps }, (_, index) => `chain-${chainIndex}-gap-${index}-${"g".repeat(240)}`.slice(0, 240)),
      truncated: {
        segments: { total: 12, returned: CHANGE_EVIDENCE_LIMITS.maxSegmentsPerChain },
        paths: { total: 24, returned: CHANGE_EVIDENCE_LIMITS.maxPathsPerChain },
        tests: { total: 8, returned: CHANGE_EVIDENCE_LIMITS.maxTestsPerChain }
      }
    };
  });
  return {
    ...base,
    requestedTargetCount: 8,
    analyzedTargetCount: 8,
    omittedTargetCount: 0,
    representedTargetCount: 1,
    unrepresentedTargetCount: 7,
    chains,
    traversal: {
      visitedNodes: CHANGE_EVIDENCE_LIMITS.maxVisitedNodes,
      examinedEdges: CHANGE_EVIDENCE_LIMITS.maxExaminedEdges,
      capped: true
    },
    gaps: Array.from({ length: CHANGE_EVIDENCE_LIMITS.maxGaps }, (_, index) => `bundle-gap-${index}-${"g".repeat(240)}`.slice(0, 240)),
    truncation: {
      targets: { total: 8, returned: 8 },
      chains: { total: 9, returned: CHANGE_EVIDENCE_LIMITS.maxChains, exact: false }
    }
  };
}

function deliverAtBudget(data: Record<string, unknown>, targetBytes: number): QueryResult {
  const packet: QueryResult = { freshness: evidenceIndex().freshness, text: "bounded evidence delivery", data };
  return withMcpDelivery(compactMcpResult(packet, { format: "concise", targetBytes }), {
    schemaVersion: 1,
    requestedFormat: "concise",
    effectiveFormat: "concise",
    resultId: `mr_${"a".repeat(64)}`,
    resultUri: `codexa://repo/mcp-results/rr_${"b".repeat(32)}/mr_${"a".repeat(64)}`,
    detailAvailable: true
  });
}

function lifecyclePacketData(mode: "proof_card" | "post_edit_review"): Record<string, unknown> {
  if (mode === "proof_card") {
    return {
      mode,
      actionability: "done",
      verdict: "pass",
      completionAuthority: "complete",
      readFirst: ["src/handler.ts"],
      verification: { recommendedCommands: [], tests: [], reported: { hasEvidence: true, testsNotRun: [], ledger: [] } },
      lifecycle: { status: "complete", invariants: [], invariantReviews: [], attempts: [] },
      decisionLog: { status: "available", baselineIntact: true, summaryHashValid: true }
    };
  }
  const reviewTargets = ["src/handler.ts"];
  return {
    mode,
    actionability: "done",
    verdict: "pass",
    completionAuthority: "complete",
    inspectMode: "none",
    taskId: "max-evidence-review",
    planRevision: 1,
    reviewCandidateTargets: reviewTargets,
    reviewTargets,
    reviewCoverage: createPostEditReviewCoverage({
      taskId: "max-evidence-review",
      planRevision: 1,
      snapshotCreatedAt: null,
      snapshotPublicationSequence: null,
      candidateTargets: reviewTargets,
      analyzedTargets: reviewTargets,
      targetLimit: 3
    }),
    invariants: [],
    invariantReviews: [],
    failureSignals: [],
    testsNotRun: [],
    verificationLedger: []
  };
}

function decisionAuthority(result: QueryResult): {
  effectiveActionability: unknown;
  actionability: unknown;
  verdict: unknown;
  completionAuthority: unknown;
} {
  const data = result.data as Record<string, unknown>;
  const kernel = data.decisionKernel as { authority?: Record<string, unknown> } | undefined;
  const authority = kernel?.authority ?? {};
  return {
    effectiveActionability: data.actionability,
    actionability: authority.actionability,
    verdict: authority.verdict ?? data.verdict,
    completionAuthority: authority.completionAuthority ?? data.completionAuthority
  };
}

function file(filePath: string, test = false): FileFact {
  return {
    id: fileId(filePath),
    type: "File",
    path: filePath,
    language: "typescript",
    sizeBytes: 10,
    dirty: false,
    generated: false,
    test,
    rank: 1,
    rankReasons: {},
    symbolCount: 0,
    usageCount: 0,
    importCount: 0,
    riskScore: 0,
    source: "tree-sitter",
    confidence: "authoritative",
    snapshotId: "snapshot-evidence",
    indexedAt: "2026-08-03T00:00:00.000Z"
  };
}

function fileId(filePath: string): string {
  return `file-${filePath.replace(/[^a-z0-9]+/giu, "-").replace(/^-|-$/gu, "")}`;
}

function symbol(id: string, filePath: string): SymbolFact {
  return {
    id,
    type: "Symbol",
    path: filePath,
    name: id,
    qualifiedName: id,
    kind: "function",
    language: "typescript",
    exported: true,
    decorators: [],
    source: "typescript-syntax",
    confidence: "authoritative",
    snapshotId: "snapshot-evidence",
    indexedAt: "2026-08-03T00:00:00.000Z"
  };
}

function edge(
  id: string,
  edgeKind: GraphEdgeKind,
  fromId: string,
  toId: string,
  fromPath: string,
  toPath: string,
  fromKind: GraphNodeKind,
  toKind: GraphNodeKind
): GraphEdgeFact {
  return {
    id,
    type: "GraphEdge",
    edgeKind,
    fromId,
    toId,
    fromKind,
    toKind,
    fromPath,
    toPath,
    reason: `${edgeKind} ${fromPath} -> ${toPath}`,
    weight: 1,
    source: "typescript-syntax",
    confidence: "derived",
    snapshotId: "snapshot-evidence",
    indexedAt: "2026-08-03T00:00:00.000Z",
    range: { startLine: 1, endLine: 1, startByte: 0, endByte: 1 }
  };
}

function snapshotWithEvidence(evidenceChains: unknown): unknown {
  const freshness = evidenceIndex().freshness;
  return {
    schemaVersion: 1,
    taskId: "portable-evidence",
    repoRoot: "/repo",
    task: "change handler",
    changeType: "behavior",
    createdAt: freshness.indexedAt,
    snapshotFreshness: freshness,
    input: {},
    plannedEditTargets: ["src/handler.ts"],
    plannedFiles: ["src/handler.ts"],
    focusFiles: [],
    plannedTests: [],
    evidenceChains,
    requiredWorkflowChecks: [],
    requiredDependencyChecks: [],
    recipes: [],
    dirtyBaseline: { changedEntries: [], dirtyFiles: [], dirtyFileHashes: {}, headCommit: "abc", indexedAt: freshness.indexedAt },
    gaps: [],
    warnings: []
  };
}
