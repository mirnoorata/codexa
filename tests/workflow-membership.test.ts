import { describe, expect, it } from "vitest";
import { proofRequiredCheckContext } from "../src/prove-required-checks.js";
import { requiredWorkflowChecksForPlan } from "../src/query/change-plan/checks.js";
import { buildChangeEvidenceChains } from "../src/query/change-plan/evidence-chains.js";
import { evaluateRequiredChecks } from "../src/query/required-checks.js";
import { workflowMatchesTarget } from "../src/query/workflow.js";
import type { CodexaIndex, FileFact, GraphEdgeFact, WorkflowTraceFact } from "../src/types.js";
import { retainedWorkflowPaths, workflowMatchesAnyPath } from "../src/workflow-membership.js";

describe("retained workflow membership", () => {
  it("keeps production target #41 actionable after the related-files payload is capped at 40", () => {
    const workflow = wideWorkflow();
    const target = productionPath(41);
    const targetSet = new Set([target]);

    expect(workflow.relatedFiles).toHaveLength(40);
    expect(workflow.relatedFiles).not.toContain(target);
    expect(workflow.steps.some((step) => step.targetPath === target)).toBe(true);
    expect(workflowMatchesAnyPath(workflow, targetSet)).toBe(true);
    expect(retainedWorkflowPaths(workflow)).toContain(target);
    expect(workflowMatchesTarget(workflow, { label: target, paths: targetSet, file: sourceFile(target) })).toBe(true);

    const requiredChecks = requiredWorkflowChecksForPlan([workflow], targetSet, "behavior");
    expect(requiredChecks).toHaveLength(1);
    expect(requiredChecks[0]?.paths[0]).toBe(target);
    expect(requiredChecks[0]?.paths).toHaveLength(20);

    const selectedWorkflows = [workflow].filter((candidate) => workflowMatchesAnyPath(candidate, targetSet));
    const evaluatedChecks = evaluateRequiredChecks(requiredChecks, {
      editPaths: [target],
      reviewTargets: [target],
      selectedFiles: [productionPath(1)],
      workflows: selectedWorkflows,
      affectedEdges: [],
      affectedTests: [],
      tests: [],
      ranTests: [],
      verificationCoverage: []
    });
    expect(evaluatedChecks).toMatchObject([{ target: workflow.title, status: "covered" }]);

    const broadScope = new Set(Array.from({ length: 21 }, (_, index) => productionPath(index + 1)));
    const broadChecks = requiredWorkflowChecksForPlan([workflow], broadScope, "behavior");
    const formerReceiptOmission = productionPath(21);
    expect(broadChecks).toHaveLength(1);
    expect(broadChecks[0]?.paths).toHaveLength(21);
    expect(broadChecks[0]?.paths).toEqual(expect.arrayContaining([...broadScope]));
    expect(evaluateRequiredChecks(broadChecks, {
      editPaths: [formerReceiptOmission],
      reviewTargets: [formerReceiptOmission],
      selectedFiles: [productionPath(1)],
      workflows: [workflow],
      affectedEdges: [],
      affectedTests: [],
      tests: [],
      ranTests: [],
      verificationCoverage: []
    })).toMatchObject([{ target: workflow.title, status: "covered" }]);

    const index = workflowIndex(workflow);
    expect(proofRequiredCheckContext({
      index,
      snapshot: {
        schemaVersion: 1,
        taskId: "late-workflow-target",
        repoRoot: "/repo",
        task: "change production target 41",
        changeType: "behavior",
        createdAt: index.freshness.indexedAt,
        snapshotFreshness: index.freshness,
        input: {},
        plannedEditTargets: [target],
        plannedFiles: [target],
        focusFiles: [],
        plannedTests: [],
        requiredWorkflowChecks: requiredChecks,
        requiredDependencyChecks: [],
        recipes: [],
        dirtyBaseline: { changedEntries: [], dirtyFiles: [], dirtyFileHashes: {}, headCommit: "abc", indexedAt: index.freshness.indexedAt },
        gaps: [],
        warnings: []
      },
      tests: [],
      ranTests: [],
      verificationCoverage: [],
      reconstruct: true
    }).workflows).toEqual([workflow]);

    const evidence = buildChangeEvidenceChains({
      index,
      task: "change production target 41",
      anchors: [{ path: target, authority: "explicit-target" }],
      editTargets: [target]
    });
    expect(evidence.chains.length).toBeGreaterThan(0);
    expect(evidence.chains.every((chain) => chain.subsystem?.id === workflow.id)).toBe(true);
  });
});

function wideWorkflow(): WorkflowTraceFact {
  const entryPath = "src/workflow-entry.ts";
  return {
    id: "workflow:wide",
    type: "WorkflowTrace",
    source: "heuristic",
    confidence: "derived",
    snapshotId: "snapshot:wide-workflow",
    indexedAt: "2026-08-03T00:00:00.000Z",
    workflowKind: "route",
    title: "route wide workflow",
    entryPath,
    relatedFiles: [entryPath, ...Array.from({ length: 39 }, (_, index) => productionPath(index + 1))],
    tests: ["tests/wide-workflow.test.ts"],
    steps: [
      { kind: "entry", label: "wide", path: entryPath, confidence: "authoritative", reason: "route entry" },
      ...Array.from({ length: 41 }, (_, index) => ({
        kind: "call" as const,
        label: `production-${index + 1}`,
        path: entryPath,
        targetPath: productionPath(index + 1),
        confidence: "derived" as const,
        reason: `retained call ${index + 1}`
      }))
    ],
    summary: "Wide retained workflow",
    rank: 10,
    truncation: {
      relatedFiles: { total: 43, returned: 40 },
      steps: { total: 42, returned: 16 }
    }
  };
}

function workflowIndex(workflow: WorkflowTraceFact): CodexaIndex {
  const target = productionPath(41);
  const consumer = "src/late-consumer.ts";
  const freshness = {
    schemaVersion: 1 as const,
    snapshotId: workflow.snapshotId,
    repoRoot: "/repo",
    gitRoot: "/repo",
    headCommit: "abc",
    indexedAt: workflow.indexedAt,
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
      id: "snapshot:wide-workflow",
      type: "RepoSnapshot",
      source: "git",
      confidence: "authoritative",
      snapshotId: workflow.snapshotId,
      indexedAt: workflow.indexedAt,
      repoRoot: "/repo",
      gitRoot: "/repo",
      headCommit: "abc",
      dirtyFiles: []
    },
    freshness,
    files: [sourceFile(target), sourceFile(consumer)],
    symbols: [],
    usageSites: [],
    imports: [],
    testEdges: [],
    graphEdges: [graphEdge(target, consumer, workflow)],
    workflows: [workflow],
    modules: [],
    risks: [],
    parserErrors: []
  };
}

function sourceFile(filePath: string): FileFact {
  return {
    id: fileId(filePath),
    type: "File",
    path: filePath,
    language: "typescript",
    sizeBytes: 10,
    dirty: false,
    generated: false,
    test: false,
    rank: 1,
    rankReasons: {},
    symbolCount: 0,
    usageCount: 0,
    importCount: 0,
    riskScore: 0,
    source: "typescript-syntax",
    confidence: "authoritative",
    snapshotId: "snapshot:wide-workflow",
    indexedAt: "2026-08-03T00:00:00.000Z"
  };
}

function graphEdge(fromPath: string, toPath: string, workflow: WorkflowTraceFact): GraphEdgeFact {
  return {
    id: "edge:late-consumer",
    type: "GraphEdge",
    edgeKind: "CALLS",
    fromId: fileId(fromPath),
    toId: fileId(toPath),
    fromKind: "file",
    toKind: "file",
    fromPath,
    toPath,
    reason: `${fromPath} calls ${toPath}`,
    weight: 1,
    source: "typescript-syntax",
    confidence: "derived",
    snapshotId: workflow.snapshotId,
    indexedAt: workflow.indexedAt,
    range: { startLine: 1, endLine: 1, startByte: 0, endByte: 1 }
  };
}

function productionPath(index: number): string {
  return `src/production-${String(index).padStart(2, "0")}.ts`;
}

function fileId(filePath: string): string {
  return `file:${filePath}`;
}
