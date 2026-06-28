import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, mkdir, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { describe, expect, it } from "vitest";
import { buildIndex } from "../src/indexer.js";
import { MCP_TOOL_CATALOG, PRIMARY_CODEX_LOOP, compactNonPostEditMcpResult, compactPostEditMcpResult } from "../src/mcp.js";
import { conciseText } from "../src/mcp/compaction.js";
import { CORE_PROFILE_TOOL_NAMES, MCP_TOOL_NAMES, MCP_TOOL_REGISTRY } from "../src/mcp/tool-registry.js";
import { MCP_REGISTERED_TOOL_NAMES } from "../src/mcp/tools.js";
import { CURRENT_VERIFICATION_PROVENANCE } from "../src/types.js";
import { CODEXA_VERSION } from "../src/version.js";
import { freshnessFixture, seq, serializedBytes, waitForStderr, stopChild, waitForExit, createIndexedMcpRepo, createIndexedMcpAutoVerifyRepo, buildContextPacket, buildFocusBriefPacket, buildTestPlanPacket, buildChangePlanPacket } from "./mcp-fixtures.js";
describe("Codexa MCP server", () => {
it("records truncation metadata when post-edit arrays are compacted", () => {
    const compacted = compactPostEditMcpResult({
      freshness: {
        schemaVersion: 1,
        snapshotId: "test",
        repoRoot: "/tmp/repo",
        gitRoot: "/tmp/repo",
        headCommit: "abc",
        indexedAt: "2026-04-11T00:00:00.000Z",
        dirtyFiles: [],
        dirtyFileHashes: {},
        indexedDirtyFileHashes: {},
        indexedDirtyFiles: [],
        missing: false,
        stale: false,
        reason: "fresh",
        parserErrorCount: 0
      },
      refresh: { refreshed: false },
      text: "post edit review",
      data: {
        verdict: "inspect",
        inspectMode: "advisory",
        inspectReasons: ["latest snapshot was ambiguous"],
        completionAuthority: "advisory_inspect",
        changedSinceSnapshot: Array.from({ length: 45 }, (_, index) => ({ path: `src/file-${index}.ts` })),
        tests: Array.from({ length: 35 }, (_, index) => ({ path: `tests/file-${index}.test.ts` })),
        ranCommandReports: Array.from({ length: 35 }, (_, index) => ({ command: `npm test ${index}` })),
        commandEnvelopes: Array.from({ length: 35 }, (_, index) => ({
          command: index === 0 ? "npm test -- --token s3cr3t-value --reporter /var/private-report.json --config ./secret.json" : `npm test ${index}`,
          packageManager: "npm",
          workspace: index === 0 ? "/var/private-workspace" : undefined,
          scriptName: "test",
          args: index === 0 ? ["--token", "s3cr3t-value", "--reporter", "/var/private-report.json", "--config", "./secret.json"] : [],
          classifierVersion: CURRENT_VERIFICATION_PROVENANCE.commandCoverageClassifierVersion
        })),
        verificationProvenance: CURRENT_VERIFICATION_PROVENANCE,
        verificationCoverage: Array.from({ length: 45 }, (_, index) => ({ status: "covered", evidence: [`npm test ${index}`] })),
        verificationLedger: Array.from({ length: 65 }, (_, index) => ({ status: "covered", evidence: [`npm test ${index}`] })),
        waivedVerification: Array.from({ length: 35 }, (_, index) => ({ status: "waived", evidence: [`waiver ${index}`] })),
        workflowChecks: Array.from({ length: 25 }, (_, index) => ({ target: `workflow ${index}` })),
        dependencyChecks: Array.from({ length: 35 }, (_, index) => ({ target: `dependency ${index}` })),
        complexityReview: {
          schemaVersion: 1,
          phase: "post-edit",
          status: "review",
          blocking: false,
          summary: "11 complexity signals need review.",
          items: Array.from({ length: 11 }, (_, index) => ({
            kind: "scope",
            severity: index % 2 === 0 ? "review" : "watch",
            message: `complexity item ${index}`,
            paths: Array.from({ length: 10 }, (_, pathIndex) => `src/complexity-${index}-${pathIndex}.ts`),
            rationale: `rationale ${index}`
          })),
          invariants: Array.from({ length: 9 }, (_, index) => `invariant ${index}`)
        },
      snapshot: {
          plannedFiles: Array.from({ length: 45 }, (_, index) => `src/planned-${index}.ts`),
          requiredWorkflowCheckCount: 41,
          requiredDependencyCheckCount: 42
        },
        outcome: {
          verdict: "inspect",
          inspectMode: "advisory",
          inspectReasons: ["latest snapshot was ambiguous"],
          completionAuthority: "advisory_inspect",
          testsNotRun: Array.from({ length: 35 }, (_, index) => ({ path: `tests/missing-${index}.test.ts` })),
          ranCommandReports: Array.from({ length: 35 }, (_, index) => ({ command: `npm test ${index}` })),
          commandEnvelopes: Array.from({ length: 35 }, (_, index) => ({
            command: index === 0 ? "npm test -- --token s3cr3t-value --reporter /var/private-report.json --config ./secret.json" : `npm test ${index}`,
            packageManager: "npm",
            workspace: index === 0 ? "/var/private-workspace" : undefined,
            scriptName: "test",
            args: index === 0 ? ["--token", "s3cr3t-value", "--reporter", "/var/private-report.json", "--config", "./secret.json"] : [],
            classifierVersion: CURRENT_VERIFICATION_PROVENANCE.commandCoverageClassifierVersion
          })),
          verificationProvenance: CURRENT_VERIFICATION_PROVENANCE,
          verificationCoverage: Array.from({ length: 45 }, (_, index) => ({ status: "covered", evidence: [`npm test ${index}`] })),
          verificationLedger: Array.from({ length: 65 }, (_, index) => ({ status: "covered", evidence: [`npm test ${index}`] })),
          waivedVerification: Array.from({ length: 35 }, (_, index) => ({ status: "waived", evidence: [`waiver ${index}`] })),
          modifiedPublicSymbols: Array.from({ length: 45 }, (_, index) => `symbol ${index}`)
        }
      }
    });
    const data = compacted.data as {
      changedSinceSnapshot: Array<unknown>;
      inspectMode?: string;
      inspectReasons?: string[];
      completionAuthority?: string;
      tests: Array<unknown>;
      ranCommandReports: Array<unknown>;
      commandEnvelopes: Array<unknown>;
      verificationCoverage: Array<unknown>;
      verificationLedger: Array<unknown>;
      waivedVerification: Array<unknown>;
      workflowChecks: Array<unknown>;
      dependencyChecks: Array<unknown>;
      complexityReview?: {
        status?: string;
        blocking?: boolean;
        items: Array<{ paths?: unknown[] }>;
        invariants: unknown[];
        truncation?: { items?: { total: number; returned: number }; invariants?: { total: number; returned: number } };
      };
      verificationProvenance?: typeof CURRENT_VERIFICATION_PROVENANCE;
      truncation?: {
        changedSinceSnapshot?: { total: number; returned: number };
        tests?: { total: number; returned: number };
        ranCommandReports?: { total: number; returned: number };
        commandEnvelopes?: { total: number; returned: number };
        verificationCoverage?: { total: number; returned: number };
        verificationLedger?: { total: number; returned: number };
        waivedVerification?: { total: number; returned: number };
        workflowChecks?: { total: number; returned: number };
        dependencyChecks?: { total: number; returned: number };
        "snapshot.plannedFiles"?: { total: number; returned: number };
        "outcome.testsNotRun"?: { total: number; returned: number };
        "outcome.ranCommandReports"?: { total: number; returned: number };
        "outcome.commandEnvelopes"?: { total: number; returned: number };
        "outcome.verificationCoverage"?: { total: number; returned: number };
        "outcome.verificationLedger"?: { total: number; returned: number };
        "outcome.waivedVerification"?: { total: number; returned: number };
        "outcome.modifiedPublicSymbols"?: { total: number; returned: number };
      };
      snapshot?: {
        plannedFiles: Array<unknown>;
        requiredWorkflowCheckCount?: number;
        requiredDependencyCheckCount?: number;
      };
      outcome?: {
        inspectMode?: string;
        inspectReasons?: string[];
        completionAuthority?: string;
        testsNotRun: Array<unknown>;
        ranCommandReports: Array<unknown>;
        commandEnvelopes: Array<unknown>;
        verificationProvenance?: typeof CURRENT_VERIFICATION_PROVENANCE;
        verificationCoverage: Array<unknown>;
        verificationLedger: Array<unknown>;
        waivedVerification: Array<unknown>;
        modifiedPublicSymbols: Array<unknown>;
      };
    };

    expect(data.changedSinceSnapshot).toHaveLength(40);
    expect(data.inspectMode).toBe("advisory");
    expect(data.inspectReasons).toEqual(["latest snapshot was ambiguous"]);
    expect(data.completionAuthority).toBe("advisory_inspect");
    expect(data.tests).toHaveLength(30);
    expect(data.ranCommandReports).toHaveLength(30);
    expect(data.commandEnvelopes).toHaveLength(30);
    expect(data.verificationProvenance).toEqual(CURRENT_VERIFICATION_PROVENANCE);
    expect(data.verificationCoverage).toHaveLength(40);
    expect(data.verificationLedger).toHaveLength(60);
    expect(data.waivedVerification).toHaveLength(30);
    expect(data.workflowChecks).toHaveLength(20);
    expect(data.dependencyChecks).toHaveLength(30);
    expect(data.complexityReview).toMatchObject({ status: "review", blocking: false });
    expect(data.complexityReview?.items).toHaveLength(8);
    expect(data.complexityReview?.items[0]?.paths).toHaveLength(8);
    expect(data.complexityReview?.invariants).toHaveLength(6);
    expect(data.complexityReview?.truncation).toMatchObject({ items: { total: 11, returned: 8 }, invariants: { total: 9, returned: 6 } });
    expect(data.snapshot?.plannedFiles).toHaveLength(40);
    expect(data.snapshot?.requiredWorkflowCheckCount).toBe(41);
    expect(data.snapshot?.requiredDependencyCheckCount).toBe(42);
    expect(data.truncation).toMatchObject({
      changedSinceSnapshot: { total: 45, returned: 40 },
      tests: { total: 35, returned: 30 },
      ranCommandReports: { total: 35, returned: 30 },
      commandEnvelopes: { total: 35, returned: 30 },
      verificationCoverage: { total: 45, returned: 40 },
      verificationLedger: { total: 65, returned: 60 },
      waivedVerification: { total: 35, returned: 30 },
      workflowChecks: { total: 25, returned: 20 },
      dependencyChecks: { total: 35, returned: 30 },
      "snapshot.plannedFiles": { total: 45, returned: 40 },
      "outcome.testsNotRun": { total: 35, returned: 30 },
      "outcome.ranCommandReports": { total: 35, returned: 30 },
      "outcome.commandEnvelopes": { total: 35, returned: 30 },
      "outcome.verificationCoverage": { total: 45, returned: 40 },
      "outcome.verificationLedger": { total: 65, returned: 60 },
      "outcome.waivedVerification": { total: 35, returned: 30 },
      "outcome.modifiedPublicSymbols": { total: 45, returned: 40 }
    });
    expect(data.outcome?.testsNotRun).toHaveLength(30);
    expect(data.outcome?.inspectMode).toBe("advisory");
    expect(data.outcome?.inspectReasons).toEqual(["latest snapshot was ambiguous"]);
    expect(data.outcome?.completionAuthority).toBe("advisory_inspect");
    expect(data.outcome?.ranCommandReports).toHaveLength(30);
    expect(data.outcome?.commandEnvelopes).toHaveLength(30);
    expect(data.outcome?.verificationProvenance).toEqual(CURRENT_VERIFICATION_PROVENANCE);
    expect(data.outcome?.verificationCoverage).toHaveLength(40);
    expect(data.outcome?.verificationLedger).toHaveLength(60);
    expect(data.outcome?.waivedVerification).toHaveLength(30);
    expect(data.outcome?.modifiedPublicSymbols).toHaveLength(40);
    const serialized = JSON.stringify(data);
    expect(serialized).not.toContain("s3cr3t-value");
    expect(serialized).not.toContain("/var/private-report.json");
    expect(serialized).not.toContain("./secret.json");
    expect(serialized).not.toContain("/var/private-workspace");
    expect(serialized).toContain("<redacted>");
    expect(serialized).toContain("<abs-path>");
    expect(serialized).toContain("<rel-path>");
  });

it("compacts non-post-edit payloads with explicit truncation metadata", () => {
    const compactedContext = compactNonPostEditMcpResult({
      freshness: freshnessFixture(),
      refresh: { refreshed: false },
      text: "context text",
      data: buildContextPacket()
    });
    expect(compactedContext.text).toBe("context text");
    const contextData = compactedContext.data as {
	      mode?: string;
	      actionability?: string;
	      focusFiles?: unknown[];
      changedFiles?: unknown[];
      tests?: unknown[];
      verificationCommands?: unknown[];
      verificationCoverage?: unknown[];
      verificationCommandPlan?: unknown[];
      truncation?: Record<string, { total: number; returned: number }>;
      mcp: { mode: string; returnedBytes: number; targetBytes: number; hardBudgetEnforced?: boolean };
    };
	    expect(contextData.mode).toBe("context_pack");
	    expect(contextData.actionability).toBe("needs_target");
    expect(contextData.mcp.mode).toBe("context_pack");
    expect(contextData.mcp.returnedBytes).toBe(serializedBytes(contextData));
    expect(contextData.mcp.returnedBytes).toBeLessThanOrEqual(contextData.mcp.targetBytes);
    expect(contextData.focusFiles?.length).toBeGreaterThan(0);
    expect(contextData.changedFiles?.length).toBeGreaterThan(0);
    expect(contextData.tests?.length).toBeGreaterThan(0);
    expect(contextData.verificationCommands?.length).toBeGreaterThan(0);
    expect(contextData.verificationCoverage?.length).toBeGreaterThan(0);
    expect(contextData.verificationCommandPlan?.length).toBeGreaterThan(0);
    expect(Object.keys(contextData.truncation ?? {}).length).toBeGreaterThan(0);

    const compactedTask = compactNonPostEditMcpResult({
      freshness: freshnessFixture(),
      refresh: { refreshed: false },
      text: "task text",
      data: { ...buildContextPacket("task_brief"), mode: "task_brief" }
    });
    expect(compactedTask.text).toBe("task text");
    const taskData = compactedTask.data as {
	      mode: string;
	      actionability?: string;
	      focusFiles?: unknown[];
      truncation?: Record<string, { total: number; returned: number }>;
      mcp: { mode: string; returnedBytes: number; targetBytes: number };
    };
	    expect(taskData.mode).toBe("task_brief");
	    expect(taskData.actionability).toBe("needs_target");
    expect(taskData.mcp.mode).toBe("task_brief");
    expect(taskData.mcp.returnedBytes).toBe(serializedBytes(taskData));
    expect(taskData.mcp.returnedBytes).toBeLessThanOrEqual(taskData.mcp.targetBytes);
    expect(taskData.focusFiles?.length).toBeGreaterThan(0);
    expect(Object.keys(taskData.truncation ?? {}).length).toBeGreaterThan(0);

    const compactedTestPlan = compactNonPostEditMcpResult({
      freshness: freshnessFixture(),
      refresh: { refreshed: false },
      text: "test plan text",
      data: buildTestPlanPacket()
    });
    expect(compactedTestPlan.text).toBe("test plan text");
    const testPlanData = compactedTestPlan.data as {
      changedFiles: unknown[];
      changedEntries: unknown[];
      changedSymbols: unknown[];
      unindexedChanged: unknown[];
      groups: unknown[];
	      tests: unknown[];
	      outcomeLearning: unknown[];
	      verificationCommands: unknown[];
	      verificationCoverage: unknown[];
	      commandEnvelopes: unknown[];
	      verificationCommandPlan: unknown[];
	      verificationLedgerPreview: unknown[];
	      verificationProvenance?: typeof CURRENT_VERIFICATION_PROVENANCE;
	      testsNotRun: unknown[];
	      gaps: unknown[];
      truncation?: Record<string, { total: number; returned: number }>;
      mcp: { mode: string; returnedBytes: number; targetBytes: number };
    };
    expect(testPlanData.mcp.mode).toBe("test_plan");
    expect(testPlanData.mcp.returnedBytes).toBe(serializedBytes(testPlanData));
    expect(testPlanData.mcp.returnedBytes).toBeLessThanOrEqual(testPlanData.mcp.targetBytes);
    expect(testPlanData.changedFiles.length).toBeGreaterThan(0);
    expect(testPlanData.tests.length).toBeGreaterThan(0);
	    expect(testPlanData.outcomeLearning.length).toBeGreaterThan(0);
	    expect(testPlanData.verificationCommands.length).toBeGreaterThan(0);
	    expect(testPlanData.verificationCoverage.length).toBeGreaterThan(0);
	    expect(testPlanData.commandEnvelopes.length).toBeGreaterThan(0);
	    expect(testPlanData.verificationCommandPlan.length).toBeGreaterThan(0);
	    expect(testPlanData.verificationLedgerPreview.length).toBeGreaterThan(0);
	    expect(testPlanData.verificationProvenance).toEqual(CURRENT_VERIFICATION_PROVENANCE);
	    expect(testPlanData.testsNotRun.length).toBeGreaterThan(0);
    expect(Object.keys(testPlanData.truncation ?? {}).length).toBeGreaterThan(0);
  });

it("compacts nested change-plan payloads and snapshot summaries", () => {
    const compacted = compactNonPostEditMcpResult({
      freshness: freshnessFixture(),
      refresh: { refreshed: false },
      text: "change plan text",
      data: buildChangePlanPacket()
    });
    expect(compacted.text).toBe("change plan text");
    const data = compacted.data as {
      mode?: string;
      editReadiness?: { editable?: boolean; status?: string; snapshotBlocked?: boolean };
      snapshotBlock?: { taskId?: string; path?: string; reason?: string };
      targetCandidates?: Array<{
        candidateId?: string;
        rank?: number;
        path?: string;
        evidence?: unknown[];
        rawSearchQueries?: unknown[];
        validationStatus?: string;
        validationReasons?: unknown[];
        wouldPlanEditTargets?: unknown[];
        wouldRecommendTests?: unknown[];
        candidateRisk?: { score?: number; reasons?: unknown[] };
      }>;
      files?: unknown[];
      plannedEditTargets?: unknown[];
      tests?: unknown[];
      snapshot?: { taskId?: string; plannedEditTargets?: unknown[]; plannedFiles?: unknown[]; plannedTests?: unknown[]; requiredWorkflowCheckCount?: number; requiredDependencyCheckCount?: number };
      complexityReview?: { status?: string; blocking?: boolean; items: unknown[]; invariants: unknown[]; truncation?: { items?: { total: number; returned: number }; invariants?: { total: number; returned: number } } };
      truncation?: Record<string, { total: number; returned: number }>;
      mcp: { mode: string; returnedBytes: number; targetBytes: number; hardBudgetEnforced?: boolean; budgetCompaction?: string };
    };
    expect(data.mode).toBe("change_plan");
    expect(data.mcp.mode).toBe("change_plan");
    expect(data.editReadiness).toMatchObject({ editable: false, status: "orientation-only", snapshotBlocked: true });
    expect(data.snapshotBlock).toMatchObject({
      taskId: "blocked-snap-1",
      path: ".codex/cache/codexa-tasks/blocked-snap-1.blocked.json",
      reason: "context quality is low"
    });
    expect(data.targetCandidates?.length).toBeGreaterThan(0);
    expect(data.targetCandidates?.length).toBeLessThanOrEqual(12);
    expect(data.targetCandidates?.[0]).toMatchObject({ candidateId: "candidate-0", rank: 1, path: "src/candidate-0.ts" });
    expect(data.targetCandidates?.[0]?.evidence?.length).toBeLessThanOrEqual(8);
    expect(data.targetCandidates?.[0]?.rawSearchQueries?.length).toBeLessThanOrEqual(4);
    expect(data.targetCandidates?.[0]?.validationStatus).toBe("weak");
    expect(data.targetCandidates?.[0]?.validationReasons?.length).toBeLessThanOrEqual(8);
    expect(data.targetCandidates?.[0]?.wouldPlanEditTargets?.length).toBeLessThanOrEqual(8);
    expect(data.targetCandidates?.[0]?.wouldRecommendTests?.length).toBeLessThanOrEqual(8);
    expect(data.targetCandidates?.[0]?.candidateRisk).toMatchObject({ score: 0 });
    expect(data.targetCandidates?.[0]?.candidateRisk?.reasons?.length).toBeLessThanOrEqual(6);
    expect(data.mcp.returnedBytes).toBe(serializedBytes(data));
    expect(data.mcp.returnedBytes).toBeLessThanOrEqual(data.mcp.targetBytes);
    expect(data.files?.length).toBeGreaterThan(0);
    expect(data.plannedEditTargets?.length).toBeGreaterThan(0);
    expect(data.tests?.length).toBeGreaterThan(0);
    expect(data.complexityReview).toMatchObject({ status: "review", blocking: false });
    expect(data.complexityReview?.items.length).toBeGreaterThanOrEqual(4);
    expect(data.complexityReview?.items.length).toBeLessThanOrEqual(8);
    expect(data.complexityReview?.invariants).toHaveLength(6);
    expect(data.complexityReview?.truncation).toMatchObject({ items: { total: 14, returned: data.complexityReview?.items.length }, invariants: { total: 10, returned: 6 } });
    expect(data.snapshot?.taskId).toBe("snap-1");
    expect(data.snapshot?.plannedFiles?.length).toBeGreaterThan(0);
    expect(data.snapshot?.plannedTests?.length).toBeGreaterThan(0);
    expect(data.snapshot?.requiredWorkflowCheckCount).toBe(7);
    expect(data.snapshot?.requiredDependencyCheckCount).toBe(8);
    expect(Object.keys(data.truncation ?? {}).length).toBeGreaterThan(0);
    expect(Object.keys(data.truncation ?? {}).some((key) => key.startsWith("snapshot."))).toBe(true);
  });

it("hard-enforces final MCP payload budget after metadata is attached", () => {
    const compacted = compactNonPostEditMcpResult({
      freshness: freshnessFixture(),
      refresh: { refreshed: false },
      text: "large test plan text",
      data: {
        ...buildTestPlanPacket(),
        verificationLedgerPreview: seq(90, (index) => ({
          kind: "test",
          recommended: `run large test-${index}`,
          target: `tests/large-${index}.test.ts`,
          status: index % 2 === 0 ? "covered" : "missing",
          evidence: seq(12, (evidenceIndex) => `evidence-${index}-${evidenceIndex}-${"x".repeat(5000)}`),
          coverageKinds: seq(20, (coverageIndex) => `coverage-${index}-${coverageIndex}-${"y".repeat(100)}`),
          command: `npm run check-${index}`,
          source: `source-${index}`
        })),
        runtime: {
          repoRoot: "/tmp/repo",
          commandBudgetMs: 1000,
          warnings: seq(60, (index) => `warning-${index}-${"z".repeat(500)}`),
          provenance: seq(120, (index) => `provenance-${index}-${"p".repeat(500)}`)
        }
      }
    });
    const data = compacted.data as {
      verificationCommands?: unknown[];
      verificationCommandPlan?: unknown[];
      verificationLedgerPreview?: unknown[];
      runtime?: unknown;
      mcp: {
        mode: string;
        returnedBytes: number;
        targetBytes: number;
        hardBudgetEnforced?: boolean;
        preEnforcementBytes?: number;
        budgetCompaction?: string;
      };
    };
    const actualBytes = serializedBytes(data);
    expect(data.mcp.mode).toBe("test_plan");
    expect(data.mcp.returnedBytes).toBe(actualBytes);
    expect(actualBytes).toBeLessThanOrEqual(data.mcp.targetBytes);
    expect(data.mcp.hardBudgetEnforced).toBe(true);
    expect(data.mcp.preEnforcementBytes).toBeGreaterThan(data.mcp.targetBytes);
    expect(data.mcp.budgetCompaction).toMatch(/hard|summary|fallback/);
    expect(data.verificationCommands?.length).toBeGreaterThan(0);
    expect(data.verificationCommandPlan?.length).toBeGreaterThan(0);
    expect(data.verificationLedgerPreview?.length).toBeGreaterThan(0);
    expect(data.runtime).toBeTruthy();
  });

it("honors CODEXA_MCP_STRUCTURED_BUDGET_BYTES for host-specific packet budgets", () => {
    const previous = process.env.CODEXA_MCP_STRUCTURED_BUDGET_BYTES;
    process.env.CODEXA_MCP_STRUCTURED_BUDGET_BYTES = "9500";
    try {
      const compacted = compactNonPostEditMcpResult({
        freshness: freshnessFixture(),
        refresh: { refreshed: false },
        text: "large test plan text",
        data: {
          ...buildTestPlanPacket(),
          verificationLedgerPreview: seq(90, (index) => ({
            kind: "test",
            recommended: `run large test-${index}`,
            target: `tests/large-${index}.test.ts`,
            status: index % 2 === 0 ? "covered" : "missing",
            evidence: seq(12, (evidenceIndex) => `evidence-${index}-${evidenceIndex}-${"x".repeat(5000)}`)
          }))
        }
      });
      const data = compacted.data as {
        mcp: { returnedBytes: number; targetBytes: number; hardBudgetEnforced?: boolean };
      };
      expect(data.mcp.targetBytes).toBe(9500);
      expect(data.mcp.returnedBytes).toBeLessThanOrEqual(9500);
      expect(serializedBytes(data)).toBeLessThanOrEqual(9500);
    } finally {
      if (previous === undefined) {
        delete process.env.CODEXA_MCP_STRUCTURED_BUDGET_BYTES;
      } else {
        process.env.CODEXA_MCP_STRUCTURED_BUDGET_BYTES = previous;
      }
    }
  });

it("meets a tiny byte budget even when targetCandidates carry heavy evidence", () => {
    const previous = process.env.CODEXA_MCP_STRUCTURED_BUDGET_BYTES;
    process.env.CODEXA_MCP_STRUCTURED_BUDGET_BYTES = "4000";
    try {
      const compacted = compactNonPostEditMcpResult({
        freshness: freshnessFixture(),
        refresh: { refreshed: false },
        text: "large packet",
        data: {
          ...buildTestPlanPacket(),
          targetCandidates: seq(8, (index) => ({
            path: `src/candidate-${index}.ts`,
            reasons: seq(8, (j) => `reason-${index}-${j}-${"r".repeat(1000)}`),
            evidence: seq(8, (j) => `evidence-${index}-${j}-${"e".repeat(1000)}`),
            tests: seq(8, (j) => `tests/candidate-${index}-${j}.test.ts`),
            symbols: seq(8, (j) => `symbol-${index}-${j}-${"s".repeat(1000)}`)
          })),
          verificationLedgerPreview: seq(90, (index) => ({
            kind: "test",
            target: `tests/large-${index}.test.ts`,
            status: "missing",
            evidence: seq(12, (j) => `evidence-${index}-${j}-${"x".repeat(5000)}`)
          }))
        }
      });
      const data = compacted.data as {
        mcp: { returnedBytes: number; targetBytes: number; budgetCompaction?: string };
      };
      expect(data.mcp.targetBytes).toBe(4000);
      expect(serializedBytes(data)).toBeLessThanOrEqual(4000);
    } finally {
      if (previous === undefined) {
        delete process.env.CODEXA_MCP_STRUCTURED_BUDGET_BYTES;
      } else {
        process.env.CODEXA_MCP_STRUCTURED_BUDGET_BYTES = previous;
      }
    }
  });

it("meets a tiny byte budget even when minimal-tier survivors are oversized", () => {
    const previous = process.env.CODEXA_MCP_STRUCTURED_BUDGET_BYTES;
    process.env.CODEXA_MCP_STRUCTURED_BUDGET_BYTES = "4000";
    try {
      const compacted = compactNonPostEditMcpResult({
        freshness: freshnessFixture(),
        refresh: { refreshed: false },
        text: "large packet",
        data: {
          ...buildTestPlanPacket(),
          verificationProvenance: Object.fromEntries(seq(200, (index) => [`claim-${index}`, `p`.repeat(150)])),
          nextTools: seq(8, (index) => ({
            schemaVersion: 1,
            tool: `tool-${index}`,
            reason: "r".repeat(150),
            requiredInputs: Object.fromEntries(seq(120, (j) => [`arg-${index}-${j}`, "v".repeat(150)])),
            readOnly: true,
            writes: []
          })),
          verificationLedgerPreview: seq(90, (index) => ({
            kind: "test",
            target: `tests/large-${index}.test.ts`,
            status: "missing",
            evidence: seq(12, (j) => `evidence-${index}-${j}-${"x".repeat(5000)}`)
          }))
        }
      });
      const data = compacted.data as { mcp: { returnedBytes: number; targetBytes: number } };
      expect(data.mcp.targetBytes).toBe(4000);
      expect(serializedBytes(data)).toBeLessThanOrEqual(4000);
    } finally {
      if (previous === undefined) {
        delete process.env.CODEXA_MCP_STRUCTURED_BUDGET_BYTES;
      } else {
        process.env.CODEXA_MCP_STRUCTURED_BUDGET_BYTES = previous;
      }
    }
  });

it("rejects malformed CODEXA_MCP_STRUCTURED_BUDGET_BYTES values instead of misparsing them", () => {
    const previous = process.env.CODEXA_MCP_STRUCTURED_BUDGET_BYTES;
    process.env.CODEXA_MCP_STRUCTURED_BUDGET_BYTES = "96_000";
    try {
      const compacted = compactNonPostEditMcpResult({
        freshness: freshnessFixture(),
        refresh: { refreshed: false },
        text: "plain",
        data: buildTestPlanPacket()
      });
      const data = compacted.data as { mcp: { targetBytes: number } };
      expect(data.mcp.targetBytes).toBe(96_000);
    } finally {
      if (previous === undefined) {
        delete process.env.CODEXA_MCP_STRUCTURED_BUDGET_BYTES;
      } else {
        process.env.CODEXA_MCP_STRUCTURED_BUDGET_BYTES = previous;
      }
    }
  });

it("compacts to the concise tier when responseFormat=concise is requested", () => {
    const compacted = compactNonPostEditMcpResult(
      {
        freshness: freshnessFixture(),
        refresh: { refreshed: false },
        text: "large test plan text",
        data: {
          ...buildTestPlanPacket(),
          verificationLedgerPreview: seq(90, (index) => ({
            kind: "test",
            recommended: `run large test-${index}`,
            target: `tests/large-${index}.test.ts`,
            status: index % 2 === 0 ? "covered" : "missing",
            evidence: seq(12, (evidenceIndex) => `evidence-${index}-${evidenceIndex}-${"x".repeat(5000)}`)
          }))
        }
      },
      { format: "concise" }
    );
    const data = compacted.data as {
      mcp: { returnedBytes: number; targetBytes: number };
    };
    expect(data.mcp.targetBytes).toBe(12_000);
    expect(data.mcp.returnedBytes).toBeLessThanOrEqual(12_000);
    expect(serializedBytes(data)).toBeLessThanOrEqual(12_000);
  });

it("preserves post-edit nextTools and systemMessage under hard MCP budget compaction", () => {
    const requiredInputs = Object.fromEntries(seq(30, (index) => [`arg${index}`, `value-${index}`]));
    const compacted = compactNonPostEditMcpResult({
      freshness: freshnessFixture(),
      refresh: { refreshed: false },
      text: "large post-edit text",
      data: {
        mode: "post_edit_review",
        task: "review large edit",
        verdict: "run_tests",
        files: seq(120, (index) => `src/file-${index}.ts`),
        changedSinceSnapshot: seq(120, (index) => ({ path: `src/file-${index}.ts`, status: "modified", diff: "x".repeat(1200) })),
        symbolDeltas: seq(120, (index) => ({ path: `src/file-${index}.ts`, before: "x".repeat(800), after: "y".repeat(800) })),
        verificationLedger: seq(90, (index) => ({
          kind: "test",
          target: `tests/file-${index}.test.ts`,
          status: "missing",
          evidence: seq(12, (evidenceIndex) => `evidence-${index}-${evidenceIndex}-${"z".repeat(5000)}`)
        })),
        nextTools: [
          {
            schemaVersion: 1,
            tool: "test_plan",
            reason: "recommended tests remain unaccounted for",
            requiredInputs,
            readOnly: true,
            writes: []
          }
        ],
        systemMessage: "recommended tests remain unaccounted for"
      }
    });
    const data = compacted.data as {
      nextTools?: Array<{ tool?: string; requiredInputs?: Record<string, unknown> }>;
      systemMessage?: string;
      truncation?: Record<string, { total: number; returned: number }>;
      mcp: { returnedBytes: number; targetBytes: number; hardBudgetEnforced?: boolean };
    };

    expect(data.mcp.hardBudgetEnforced).toBe(true);
    expect(data.mcp.returnedBytes).toBeLessThanOrEqual(data.mcp.targetBytes);
    expect(data.nextTools?.[0]?.tool).toBe("test_plan");
    expect(data.systemMessage).toBe("recommended tests remain unaccounted for");
    expect(Object.keys(data.nextTools?.[0]?.requiredInputs ?? {}).length).toBeLessThan(30);
    expect(Object.keys(data.truncation ?? {}).some((key) => key.includes("nextTools.0.requiredInputs.__keys"))).toBe(true);
  });

it("bounds unknown-mode MCP payloads instead of bypassing compaction", () => {
    const compacted = compactNonPostEditMcpResult({
      freshness: freshnessFixture(),
      refresh: { refreshed: false },
      text: "unknown payload text",
      data: {
        rows: seq(300, (index) => ({
          id: index,
          note: `row-${index}-${"x".repeat(2000)}`,
          nested: seq(20, (nestedIndex) => ({ label: `nested-${index}-${nestedIndex}`, body: "y".repeat(500) }))
        })),
        notes: "z".repeat(50_000),
        runtime: {
          commandBudgetMs: 1000,
          provenance: seq(80, (index) => `prov-${index}`)
        }
      }
    });
    const data = compacted.data as {
      mode?: string;
      rows?: unknown[];
      truncation?: Record<string, { total: number; returned: number }>;
      mcp: {
        mode: string;
        returnedBytes: number;
        targetBytes: number;
      };
    };
    expect(data.mode).toBe("unknown");
    expect(data.mcp.mode).toBe("unknown");
    expect(data.rows?.length).toBeLessThan(300);
    expect(data.truncation?.rows?.total).toBeGreaterThanOrEqual(data.rows?.length ?? 0);
    expect(data.truncation?.rows?.returned).toBe(data.rows?.length);
    expect(data.mcp.returnedBytes).toBe(serializedBytes(data));
    expect(data.mcp.returnedBytes).toBeLessThanOrEqual(data.mcp.targetBytes);
  });

it("marks auto-recording tools as cache writers even when auto-refresh is disabled", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-mcp-readonly-"));
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    await mkdir(path.join(repo, "src"), { recursive: true });
    await writeFile(path.join(repo, "src/index.ts"), "export function main() { return 1 }\n", "utf8");
    execFileSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["-c", "user.name=Codexa", "-c", "user.email=codexa@example.invalid", "commit", "-m", "fixture"], {
      cwd: repo,
      stdio: "ignore"
    });
    await buildIndex({ repoRoot: repo });

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(process.cwd(), "dist/cli.js"), "serve", repo, "--no-auto-refresh"],
      stderr: "pipe"
    });
    const client = new Client({ name: "codexa-test", version: "0.1.0" });
    await client.connect(transport);
    const tools = await client.listTools();
    expect(tools.tools.find((tool) => tool.name === "repo_map")?.annotations?.readOnlyHint).toBe(true);
    expect(tools.tools.find((tool) => tool.name === "task_brief")?.annotations?.readOnlyHint).toBe(false);
    expect(tools.tools.find((tool) => tool.name === "task_brief")?.annotations?.idempotentHint).toBe(false);
    expect(tools.tools.find((tool) => tool.name === "context_pack")?.annotations?.readOnlyHint).toBe(false);
    expect(tools.tools.find((tool) => tool.name === "context_pack")?.annotations?.idempotentHint).toBe(false);
    expect(tools.tools.find((tool) => tool.name === "impact")?.annotations?.readOnlyHint).toBe(false);
    expect(tools.tools.find((tool) => tool.name === "focus_brief")?.annotations?.readOnlyHint).toBe(false);
    expect(tools.tools.find((tool) => tool.name === "callers")?.annotations?.readOnlyHint).toBe(true);
    expect(tools.tools.find((tool) => tool.name === "post_edit_review")?.annotations?.readOnlyHint).toBe(false);
    await client.close();
  });
});
