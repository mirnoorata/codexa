import { describe, expect, it } from "vitest";
import { extractWorkflowTraceData, extractWorkflowTraces } from "../src/graph.js";
import type { CodexaIndex, FileFact, GraphEdgeFact, RiskSignalFact, SymbolFact, TestEdgeFact, UsageSiteFact } from "../src/types.js";
import { workflowMatchesAnyPath } from "../src/workflow-membership.js";

const SNAPSHOT_ID = "snapshot:workflow-scale";
const INDEXED_AT = "2026-08-03T00:00:00.000Z";

describe("workflow extraction scale bounds", () => {
  it("indexes large evidence arrays once instead of rescanning them for every execution surface", () => {
    const surfaceCount = 96;
    const noiseCount = 4_096;
    const surfaces = Array.from({ length: surfaceCount }, (_, index) => executionSurface(index));
    const usages = trackedArray([
      ...surfaces.map((surface, index) => usage(`usage:surface:${index}`, surface.path, surface.id, index + 1)),
      ...Array.from({ length: noiseCount }, (_, index) => usage(`usage:noise:${index}`, `src/noise-${index}.ts`, `noise:${index}`, index + 1))
    ]);
    const risks = trackedArray([
      ...surfaces.map((surface, index) => risk(`risk:surface:${index}`, surface.path, index + 1)),
      ...Array.from({ length: noiseCount }, (_, index) => risk(`risk:noise:${index}`, `src/noise-${index}.ts`, index + 1))
    ]);
    const tests = trackedArray([
      ...surfaces.map((surface, index) => testEdge(`test:surface:${index}`, `tests/surface-${index}.test.ts`, surface.path)),
      ...Array.from({ length: noiseCount }, (_, index) => testEdge(`test:noise:${index}`, `tests/noise-${index}.test.ts`, `src/noise-${index}.ts`))
    ]);
    const graphEdges = trackedArray(Array.from({ length: noiseCount }, (_, index) => graphEdge(index)));
    const index = workflowIndex({
      files: surfaces.map((surface) => file(surface.path)),
      symbols: surfaces,
      usageSites: usages.value,
      risks: risks.value,
      testEdges: tests.value,
      graphEdges: graphEdges.value
    });

    const workflows = extractWorkflowTraces(index);

    expect(workflows).toHaveLength(surfaceCount);
    expect(workflows.every((workflow) => workflow.tests.length === 1)).toBe(true);
    expect(usages.reads()).toBeLessThanOrEqual(usages.value.length + 1);
    expect(risks.reads()).toBeLessThanOrEqual(risks.value.length + 1);
    expect(tests.reads()).toBeLessThanOrEqual(tests.value.length + 1);
    expect(graphEdges.reads()).toBeLessThanOrEqual(graphEdges.value.length + 1);
  });

  it("caps workflow test and related-file payloads without changing full-evidence rank or totals", () => {
    const surface = executionSurface(0, ["codexa:execution-surfaces:70:64"]);
    const targets = Array.from({ length: 30 }, (_, index) => targetSymbol(index));
    const relatedPaths = [surface.path, ...targets.map((target) => target.path)];
    const usageSites = targets.map((target, index) => usage(`usage:target:${index}`, surface.path, surface.id, index + 1, target));
    const testEdges = relatedPaths.flatMap((targetPath, targetIndex) => [
      testEdge(`test:${targetIndex}:a`, `__tests__/related-${targetIndex}-a.test.ts`, targetPath),
      testEdge(`test:${targetIndex}:b`, `__tests__/related-${targetIndex}-b.test.ts`, targetPath)
    ]);
    const index = workflowIndex({
      files: [file(surface.path), ...targets.map((target) => file(target.path))],
      symbols: [surface, ...targets],
      usageSites,
      testEdges
    });

    const extraction = extractWorkflowTraceData(index);
    const first = extraction.workflows.find((workflow) => workflow.entrySymbolId === surface.id)!;
    const shuffled = extractWorkflowTraces({
      ...index,
      usageSites: [...usageSites].reverse(),
      testEdges: [...testEdges].reverse()
    }).find((workflow) => workflow.entrySymbolId === surface.id)!;

    expect(first.tests).toHaveLength(20);
    expect(first.relatedFiles).toHaveLength(40);
    expect(first.relatedFiles.slice(0, relatedPaths.length)).toEqual([...relatedPaths].sort((left, right) => left.localeCompare(right)));
    expect(first.relatedFiles).toEqual(expect.arrayContaining(relatedPaths));
    expect(first.truncation).toMatchObject({
      tests: { total: 62, returned: 20 },
      relatedFiles: { total: 93, returned: 40 },
      steps: { total: 39, returned: 16 },
      executionSurfaces: { total: 70, returned: 64 }
    });
    expect(first.rank).toBe(5);
    expect(first.summary).toContain("touches 31 file(s)");
    const fullMembership = new Set([first.entryPath, ...first.relatedFiles, ...first.tests, ...first.steps.flatMap((step) => [step.path, step.targetPath])]);
    const omittedTests = testEdges.map((edge) => edge.path).filter((filePath) => !fullMembership.has(filePath));
    expect(omittedTests.length).toBeGreaterThan(0);
    expect(extraction.workflowMembershipSpill[first.id]).toEqual([...omittedTests].sort((left, right) => left.localeCompare(right)));
    expect(shuffled).toEqual(first);
  });

  it("persists exact omitted membership when typed test steps seed additional tests", () => {
    const surface = executionSurface(0);
    const endpointId = "endpoint:typed-membership";
    const endpointPath = "src/typed-endpoint.ts";
    const typedTestPath = "tests/typed-entry.test.ts";
    const dependentTests = Array.from({ length: 25 }, (_, index) => `tests/typed-dependent-${String(index + 1).padStart(2, "0")}.test.ts`);
    const storePaths = Array.from({ length: 41 }, (_, index) => `src/store-${String(index + 1).padStart(2, "0")}.ts`);
    const graphEdges = [
      workflowTypedEdge("edge:route", "ROUTE_HANDLES", surface, endpointId, endpointPath),
      workflowTypedEdge("edge:typed-test", "TEST_COVERS_WORKFLOW", surface, endpointId, endpointPath, typedTestPath),
      ...storePaths.map((storePath, index) => workflowTypedEdge(`edge:store:${index}`, "ROUTE_CALLS_STORE", surface, `file:${storePath}`, storePath))
    ];
    const testEdges = dependentTests.map((testPath, index) => testEdge(`test:typed:${index}`, testPath, typedTestPath));
    const index = workflowIndex({
      files: [file(surface.path), file(endpointPath), ...storePaths.map(file)],
      symbols: [surface],
      graphEdges,
      testEdges
    });

    const extraction = extractWorkflowTraceData(index);
    const workflow = extraction.workflows.find((candidate) => candidate.entrySymbolId === surface.id)!;
    const omittedTest = dependentTests[20]!;

    expect(workflow.relatedFiles).toHaveLength(40);
    expect(workflow.tests).toHaveLength(20);
    expect(workflow.relatedFiles).not.toContain(omittedTest);
    expect(workflow.tests).not.toContain(omittedTest);
    expect(workflow.steps.some((step) => step.path === typedTestPath && step.kind === "test")).toBe(true);
    expect(workflow.steps.some((step) => step.path === omittedTest)).toBe(false);
    expect(extraction.workflowMembershipSpill[workflow.id]).toContain(omittedTest);
    expect(workflowMatchesAnyPath(workflow, new Set([omittedTest]), {
      ...index,
      workflows: extraction.workflows,
      workflowMembershipSpill: extraction.workflowMembershipSpill
    })).toBe(true);
  });
});

function workflowIndex(overrides: Partial<CodexaIndex>): CodexaIndex {
  return {
    schemaVersion: 1,
    snapshot: {
      id: SNAPSHOT_ID,
      type: "RepoSnapshot",
      source: "git",
      confidence: "authoritative",
      snapshotId: SNAPSHOT_ID,
      indexedAt: INDEXED_AT,
      repoRoot: "/repo",
      gitRoot: "/repo",
      headCommit: "abc",
      dirtyFiles: []
    },
    freshness: {
      schemaVersion: 1,
      snapshotId: SNAPSHOT_ID,
      repoRoot: "/repo",
      gitRoot: "/repo",
      headCommit: "abc",
      indexedAt: INDEXED_AT,
      dirtyFiles: [],
      dirtyFileHashes: {},
      indexedDirtyFileHashes: {},
      indexedDirtyFiles: [],
      missing: false,
      stale: false,
      reason: "fresh",
      parserErrorCount: 0
    },
    files: [],
    symbols: [],
    usageSites: [],
    imports: [],
    testEdges: [],
    graphEdges: [],
    workflows: [],
    modules: [],
    risks: [],
    parserErrors: [],
    ...overrides
  };
}

function executionSurface(index: number, extraDecorators: string[] = []): SymbolFact {
  const filePath = `src/surface-${index}.ts`;
  return {
    ...baseFact(`symbol:surface:${index}`),
    type: "Symbol",
    path: filePath,
    name: `surface-${index}`,
    qualifiedName: `surface-${index}`,
    kind: "module",
    language: "typescript",
    exported: false,
    decorators: ["codexa:mcp-tool", ...extraDecorators],
    range: range(index + 1)
  };
}

function targetSymbol(index: number): SymbolFact {
  return {
    ...baseFact(`symbol:target:${index}`),
    type: "Symbol",
    path: `src/target-${index}.ts`,
    name: `target${index}`,
    qualifiedName: `target${index}`,
    kind: "function",
    language: "typescript",
    exported: true,
    decorators: [],
    range: range(index + 1)
  };
}

function file(filePath: string): FileFact {
  return {
    ...baseFact(`file:${filePath}`),
    type: "File",
    path: filePath,
    language: "typescript",
    sizeBytes: 1,
    dirty: false,
    generated: false,
    test: false,
    rank: 0,
    rankReasons: {},
    symbolCount: 1,
    usageCount: 0,
    importCount: 0,
    riskScore: 0
  };
}

function usage(id: string, filePath: string, usedBySymbolId: string, line: number, target?: SymbolFact): UsageSiteFact {
  return {
    ...baseFact(id),
    type: "UsageSite",
    path: filePath,
    name: target?.name ?? `call${line}`,
    kind: "call",
    targetSymbolId: target?.id,
    usedBySymbolId,
    text: `call at ${line}`,
    range: range(line)
  };
}

function risk(id: string, filePath: string, line: number): RiskSignalFact {
  return {
    ...baseFact(id),
    type: "RiskSignal",
    path: filePath,
    signal: "scale-risk",
    score: 1,
    reason: "scale fixture",
    range: range(line)
  };
}

function testEdge(id: string, testPath: string, targetPath: string): TestEdgeFact {
  return {
    ...baseFact(id),
    type: "TestEdge",
    path: testPath,
    targetPath,
    reason: `covers ${targetPath}`
  };
}

function graphEdge(index: number): GraphEdgeFact {
  return {
    ...baseFact(`edge:${index}`),
    type: "GraphEdge",
    edgeKind: "CALLS",
    fromId: `noise-from:${index}`,
    toId: `noise-to:${index}`,
    fromKind: "file",
    toKind: "file",
    fromPath: `src/noise-${index}.ts`,
    toPath: `src/noise-target-${index}.ts`,
    reason: "noise edge",
    weight: 1
  };
}

function workflowTypedEdge(
  id: string,
  edgeKind: GraphEdgeFact["edgeKind"],
  surface: SymbolFact,
  toId: string,
  toPath: string,
  fromPath = surface.path
): GraphEdgeFact {
  return {
    ...baseFact(id),
    type: "GraphEdge",
    edgeKind,
    fromId: edgeKind === "TEST_COVERS_WORKFLOW" ? `test:${fromPath}` : surface.id,
    toId,
    fromKind: edgeKind === "TEST_COVERS_WORKFLOW" ? "test" : "symbol",
    toKind: edgeKind === "ROUTE_HANDLES" || edgeKind === "TEST_COVERS_WORKFLOW" ? "endpoint" : "file",
    fromPath,
    toPath,
    fromSymbolId: edgeKind === "TEST_COVERS_WORKFLOW" ? undefined : surface.id,
    reason: `${edgeKind} fixture`,
    weight: 1
  };
}

function baseFact(id: string) {
  return {
    id,
    source: "heuristic" as const,
    confidence: "derived" as const,
    snapshotId: SNAPSHOT_ID,
    indexedAt: INDEXED_AT
  };
}

function range(line: number) {
  return { startLine: line, endLine: line, startByte: line, endByte: line + 1 };
}

function trackedArray<T>(entries: T[]): { value: T[]; reads: () => number } {
  let numericReads = 0;
  const value = new Proxy(entries, {
    get(target, property, receiver) {
      if (typeof property === "string" && /^(0|[1-9]\d*)$/u.test(property)) numericReads += 1;
      return Reflect.get(target, property, receiver);
    }
  });
  return { value, reads: () => numericReads };
}
