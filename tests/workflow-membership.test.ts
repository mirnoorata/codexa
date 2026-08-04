import { describe, expect, it } from "vitest";
import { proofRequiredCheckContext } from "../src/prove-required-checks.js";
import { requiredWorkflowChecksForPlan } from "../src/query/change-plan/checks.js";
import { buildChangeEvidenceChains } from "../src/query/change-plan/evidence-chains.js";
import { evaluateRequiredChecks } from "../src/query/required-checks.js";
import { workflowMatchesTarget } from "../src/query/workflow.js";
import type { CodexaIndex, FileFact, GraphEdgeFact, SymbolFact, TestEdgeFact, WorkflowTraceFact } from "../src/types.js";
import { retainedWorkflowPaths, workflowMatchesAnyPath } from "../src/workflow-membership.js";

describe("retained workflow membership", () => {
  it("keeps production target #41 actionable after the related-files payload is capped at 40", () => {
    const workflow = wideWorkflow();
    const index = workflowIndex(workflow);
    const target = productionPath(41);
    const targetSet = new Set([target]);

    expect(workflow.relatedFiles).toHaveLength(40);
    expect(workflow.relatedFiles).not.toContain(target);
    expect(workflow.steps.some((step) => step.targetPath === target)).toBe(true);
    expect(workflowMatchesAnyPath(workflow, targetSet, index)).toBe(true);
    expect(retainedWorkflowPaths(workflow)).toContain(target);
    expect(workflowMatchesTarget(workflow, { label: target, paths: targetSet, file: sourceFile(target) }, index)).toBe(true);

    const requiredChecks = requiredWorkflowChecksForPlan(index, targetSet, "behavior");
    expect(requiredChecks).toHaveLength(1);
    expect(requiredChecks[0]?.paths[0]).toBe(target);
    expect(requiredChecks[0]?.paths).toHaveLength(20);

    const selectedWorkflows = [workflow].filter((candidate) => workflowMatchesAnyPath(candidate, targetSet, index));
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
    const broadChecks = requiredWorkflowChecksForPlan(index, broadScope, "behavior");
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

  it("keeps test #21 actionable without widening workflow payload caps", () => {
    const testPaths = Array.from({ length: 25 }, (_, index) => testPath(index + 1));
    const workflow = wideWorkflowWithCappedTests(testPaths);
    const index = workflowIndex(workflow, testPaths);
    const target = testPaths[20]!;
    const targetSet = new Set([target]);

    expect(workflow.relatedFiles).toHaveLength(40);
    expect(workflow.tests).toHaveLength(20);
    expect(workflow.tests).not.toContain(target);
    expect(workflow.steps.filter((step) => step.kind === "test")).toHaveLength(8);
    expect(workflow.steps.some((step) => step.path === target || step.targetPath === target)).toBe(false);
    expect(workflowMatchesAnyPath(workflow, targetSet, index)).toBe(true);
    expect(workflowMatchesTarget(workflow, { label: target, paths: targetSet, file: sourceFile(target) }, index)).toBe(true);
    expect(workflowMatchesTarget(workflow, { label: target, paths: new Set(), symbol: testSymbol(target) }, index)).toBe(true);

    const transitiveTest = testPath(26);
    const transitiveIndex = {
      ...index,
      testEdges: [...index.testEdges, testEdge(transitiveTest, testPaths[0]!, workflow)]
    };
    expect(workflowMatchesAnyPath(workflow, new Set([transitiveTest]), transitiveIndex)).toBe(false);
    expect(workflowMatchesAnyPath(workflow, new Set([transitiveTest]), {
      ...transitiveIndex,
      workflowMembershipSpill: {
        ...transitiveIndex.workflowMembershipSpill,
        [workflow.id]: [...(transitiveIndex.workflowMembershipSpill?.[workflow.id] ?? []), transitiveTest]
      }
    })).toBe(true);

    const trackedEdges = trackedArray(index.testEdges);
    expect(workflowMatchesAnyPath(workflow, new Set(["src/unrelated.ts"]), { ...index, testEdges: trackedEdges.value })).toBe(false);
    expect(trackedEdges.reads()).toBe(0);

    const requiredChecks = requiredWorkflowChecksForPlan(index, targetSet, "behavior");
    expect(requiredChecks).toHaveLength(1);
    expect(requiredChecks[0]?.paths[0]).toBe(target);
    expect(requiredChecks[0]?.paths).toHaveLength(20);

    const evaluatedChecks = evaluateRequiredChecks(requiredChecks, {
      editPaths: [target],
      reviewTargets: [target],
      selectedFiles: [productionPath(1)],
      workflows: index.workflows.filter((candidate) => workflowMatchesAnyPath(candidate, targetSet, index)),
      affectedEdges: [],
      affectedTests: [],
      tests: [],
      ranTests: [],
      verificationCoverage: []
    });
    expect(evaluatedChecks).toMatchObject([{ target: workflow.title, status: "covered" }]);

    expect(proofRequiredCheckContext({
      index,
      snapshot: taskSnapshot(index, target, requiredChecks),
      tests: [],
      ranTests: [],
      verificationCoverage: [],
      reconstruct: true
    }).workflows).toEqual([workflow]);

    const evidence = buildChangeEvidenceChains({
      index,
      task: "change omitted workflow test",
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

function wideWorkflowWithCappedTests(testPaths: string[]): WorkflowTraceFact {
  const workflow = wideWorkflow();
  return {
    ...workflow,
    id: "workflow:wide-tests",
    title: "route wide workflow with capped tests",
    tests: testPaths.slice(0, 20),
    steps: [
      ...workflow.steps,
      ...testPaths.slice(0, 8).map((filePath) => ({
        kind: "test" as const,
        label: filePath,
        path: filePath,
        targetPath: productionPath(41),
        confidence: "derived" as const,
        reason: "covers workflow-related file"
      }))
    ],
    truncation: {
      relatedFiles: { total: 67, returned: 40 },
      tests: { total: testPaths.length, returned: 20 },
      steps: { total: workflow.steps.length + testPaths.length, returned: 16 }
    }
  };
}

function workflowIndex(workflow: WorkflowTraceFact, testPaths: string[] = []): CodexaIndex {
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
    files: [sourceFile(target), sourceFile(consumer), ...testPaths.map(sourceFile)],
    symbols: [],
    usageSites: [],
    imports: [],
    testEdges: testPaths.map((filePath) => testEdge(filePath, productionPath(41), workflow)),
    graphEdges: [
      graphEdge(target, consumer, workflow),
      ...testPaths.map((filePath) => testGraphEdge(filePath, target, workflow))
    ],
    workflows: [workflow],
    workflowMembershipSpill: { [workflow.id]: testPaths.slice(20) },
    modules: [],
    risks: [],
    parserErrors: []
  };
}

function taskSnapshot(index: CodexaIndex, target: string, requiredWorkflowChecks: ReturnType<typeof requiredWorkflowChecksForPlan>) {
  return {
    schemaVersion: 1 as const,
    taskId: "late-workflow-test",
    repoRoot: "/repo",
    task: "change omitted workflow test",
    changeType: "behavior" as const,
    createdAt: index.freshness.indexedAt,
    snapshotFreshness: index.freshness,
    input: {},
    plannedEditTargets: [target],
    plannedFiles: [target],
    focusFiles: [],
    plannedTests: [],
    requiredWorkflowChecks,
    requiredDependencyChecks: [],
    recipes: [],
    dirtyBaseline: { changedEntries: [], dirtyFiles: [], dirtyFileHashes: {}, headCommit: "abc", indexedAt: index.freshness.indexedAt },
    gaps: [],
    warnings: []
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
    test: filePath.startsWith("tests/"),
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

function testSymbol(filePath: string): SymbolFact {
  return {
    id: `symbol:${filePath}`,
    type: "Symbol",
    path: filePath,
    name: "omitted workflow test",
    qualifiedName: "omitted workflow test",
    kind: "function",
    language: "typescript",
    exported: false,
    decorators: [],
    range: { startLine: 1, endLine: 1, startByte: 0, endByte: 1 },
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

function testEdge(path: string, targetPath: string, workflow: WorkflowTraceFact): TestEdgeFact {
  return {
    id: `test-edge:${path}`,
    type: "TestEdge",
    path,
    targetPath,
    reason: `${path} covers ${targetPath}`,
    source: "typescript-syntax",
    confidence: "derived",
    snapshotId: workflow.snapshotId,
    indexedAt: workflow.indexedAt
  };
}

function testGraphEdge(fromPath: string, toPath: string, workflow: WorkflowTraceFact): GraphEdgeFact {
  return {
    id: `graph-test-edge:${fromPath}`,
    type: "GraphEdge",
    edgeKind: "TESTS",
    fromId: fileId(fromPath),
    toId: fileId(toPath),
    fromKind: "file",
    toKind: "file",
    fromPath,
    toPath,
    reason: `${fromPath} tests ${toPath}`,
    weight: 1,
    source: "typescript-syntax",
    confidence: "derived",
    snapshotId: workflow.snapshotId,
    indexedAt: workflow.indexedAt
  };
}

function productionPath(index: number): string {
  return `src/production-${String(index).padStart(2, "0")}.ts`;
}

function testPath(index: number): string {
  return `tests/workflow-${String(index).padStart(2, "0")}.test.ts`;
}

function fileId(filePath: string): string {
  return `file:${filePath}`;
}

function trackedArray<T>(entries: T[]): { value: T[]; reads: () => number } {
  let reads = 0;
  const value = new Proxy(entries, {
    get(target, property, receiver) {
      if (typeof property === "string" && /^(0|[1-9]\d*)$/u.test(property)) reads += 1;
      return Reflect.get(target, property, receiver);
    }
  });
  return { value, reads: () => reads };
}
