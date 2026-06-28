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

export function freshnessFixture() {
  return {
    schemaVersion: 1 as const,
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
  };
}

export function seq<T>(count: number, factory: (index: number) => T): T[] {
  return Array.from({ length: count }, (_, index) => factory(index));
}

export function serializedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

export async function waitForStderr(child: ChildProcessWithoutNullStreams, pattern: RegExp, timeoutMs = 5000): Promise<string> {
  const chunks: Buffer[] = [];
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for stderr pattern ${pattern}`));
    }, timeoutMs);
    const onData = (chunk: Buffer) => {
      chunks.push(chunk);
      const text = Buffer.concat(chunks).toString("utf8");
      if (pattern.test(text)) {
        cleanup();
        resolve(text);
      }
    };
    const onExit = () => {
      cleanup();
      reject(new Error(`Process exited before stderr pattern ${pattern}: ${Buffer.concat(chunks).toString("utf8")}`));
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.stderr.off("data", onData);
      child.off("exit", onExit);
    };
    child.stderr.on("data", onData);
    child.once("exit", onExit);
  });
}

export async function stopChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  child.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
    setTimeout(resolve, 1500).unref();
  });
}

export async function waitForExit(child: ChildProcessWithoutNullStreams, timeoutMs = 5000): Promise<{ code: number | null; signal: NodeJS.Signals | null; stderr: string }> {
  const stderrChunks: Buffer[] = [];
  child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timed out waiting for process exit: ${Buffer.concat(stderrChunks).toString("utf8")}`));
    }, timeoutMs);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stderr: Buffer.concat(stderrChunks).toString("utf8") });
    });
  });
}

export async function createIndexedMcpRepo(parent: string, name: string, fileStem: string, symbol: string): Promise<string> {
  const repo = path.join(parent, name);
  await mkdir(path.join(repo, "src"), { recursive: true });
  await writeFile(path.join(repo, "package.json"), JSON.stringify({ scripts: { test: "vitest run" } }, null, 2), "utf8");
  await writeFile(path.join(repo, "src", `${fileStem}.ts`), `export function ${symbol}() { return '${symbol}' }\n`, "utf8");
  execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["-c", "user.name=Codexa", "-c", "user.email=codexa@example.invalid", "commit", "-m", "fixture"], {
    cwd: repo,
    stdio: "ignore"
  });
  await buildIndex({ repoRoot: repo });
  return repo;
}

export async function createIndexedMcpAutoVerifyRepo(parent: string): Promise<string> {
  const repo = path.join(parent, "repo");
  await mkdir(path.join(repo, "src"), { recursive: true });
  await mkdir(path.join(repo, "tests"), { recursive: true });
  await writeFile(path.join(repo, "package.json"), JSON.stringify({ type: "module", scripts: { test: "node --test" } }, null, 2), "utf8");
  await writeFile(path.join(repo, "src/main.js"), "export function main() {\n  return 1\n}\n", "utf8");
  await writeFile(
    path.join(repo, "tests/main.test.js"),
    [
      "import test from 'node:test';",
      "import assert from 'node:assert/strict';",
      "import { writeFileSync } from 'node:fs';",
      "import { main } from '../src/main.js';",
      "",
      "test('would write marker if MCP executed verification', () => {",
      "  writeFileSync(new URL('../mcp-executed.txt', import.meta.url), 'ran');",
      "  assert.equal(main(), 1);",
      "});",
      ""
    ].join("\n"),
    "utf8"
  );
  execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["-c", "user.name=Codexa", "-c", "user.email=codexa@example.invalid", "commit", "-m", "fixture"], {
    cwd: repo,
    stdio: "ignore"
  });
  await buildIndex({ repoRoot: repo });
  return repo;
}

export function buildContextPacket(mode?: "focus_brief" | "task_brief") {
  return {
    ...(mode ? { mode } : {}),
	    task: "refactor packet",
	    changeType: "behavior",
	    actionability: "needs_target",
	    tokenBudget: 1000,
    focusFiles: seq(25, (index) => ({
      path: `src/focus-${index}.ts`,
      tier: "derived",
      reasons: seq(15, (reasonIndex) => `reason-${index}-${reasonIndex}`),
      matchedTerms: seq(15, (termIndex) => `term-${index}-${termIndex}`),
      rank: index,
      riskScore: index
    })),
    changedFiles: seq(45, (index) => `src/changed-${index}.ts`),
    changedEntries: seq(45, (index) => ({ path: `src/entry-${index}.ts` })),
    changedSymbols: seq(45, (index) => ({ symbol: `symbol-${index}` })),
    unindexedChanged: seq(45, (index) => `src/unindexed-${index}.ts`),
    groups: seq(25, (index) => ({
      module: `group-${index}`,
      files: seq(35, (fileIndex) => `src/group-${index}-${fileIndex}.ts`),
      symbols: seq(25, (symbolIndex) => `symbol-${index}-${symbolIndex}`
      )
    })),
    tests: seq(35, (index) => ({ path: `tests/test-${index}.ts` })),
    snippets: seq(14, (index) => `snippet-${index}`),
    warnings: seq(25, (index) => `warning-${index}`),
    nextReads: seq(25, (index) => `read-${index}`),
    retrieval: {
      query: "task query",
      intents: seq(4, (index) => `intent-${index}`),
      terms: seq(4, (index) => `term-${index}`),
      matches: seq(30, (index) => ({ file: { path: `src/match-${index}.ts` } })),
      workflows: seq(14, (index) => ({
        title: `retrieval-workflow-${index}`,
        relatedFiles: seq(25, (fileIndex) => `src/workflow-${index}-${fileIndex}.ts`),
        tests: seq(25, (testIndex) => `tests/workflow-${index}-${testIndex}.test.ts`),
        steps: seq(20, (stepIndex) => ({ kind: "open", label: `step-${index}-${stepIndex}` }))
      })),
      modules: seq(22, (index) => ({
        name: `retrieval-module-${index}`,
        files: seq(25, (fileIndex) => `src/module-${index}-${fileIndex}.ts`),
        reasons: seq(15, (reasonIndex) => `reason-${index}-${reasonIndex}`)
      })),
      broad: true,
      intentConfidence: {
        mode: "edit",
        intent: "testing",
        confidence: 0.9,
        anchors: seq(7, (index) => `anchor-${index}`),
        missingAnchors: seq(7, (index) => `missing-${index}`),
        reasons: seq(13, (index) => `reason-${index}`),
        recommendedNextTool: "task_brief",
        editReady: true,
        verdict: "edit-ready"
      },
      diagnostics: seq(25, (index) => `diag-${index}`)
    },
    diagnostics: seq(25, (index) => `diag-${index}`),
    recipes: seq(15, (index) => `recipe-${index}`),
    verificationCommands: seq(25, (index) => `cmd-${index}`),
    verificationCoverage: seq(50, (index) => ({
      kind: "unknown",
      command: `cmd-${index}`,
      source: "source",
      confidence: "derived",
      details: seq(15, (detailIndex) => `detail-${index}-${detailIndex}`)
    })),
    verificationCommandPlan: seq(35, (index) => ({
      command: `cmd-${index}`,
      covers: seq(15, (coverIndex) => `cover-${index}-${coverIndex}`),
      targetPaths: seq(25, (targetIndex) => `src/target-${index}-${targetIndex}.ts`),
      scopes: seq(15, (scopeIndex) => `scope-${index}-${scopeIndex}`),
      sources: seq(15, (sourceIndex) => `source-${index}-${sourceIndex}`)
    })),
    gaps: seq(35, (index) => `gap-${index}`),
    session: { commandBudgetMs: 1000, maxResultBytes: 2000, maxResults: 50, provenance: seq(40, (index) => `prov-${index}`) },
    value: { kind: "context_pack" }
  };
}

export function buildFocusBriefPacket() {
  return {
    mode: "focus_brief",
    task: "refactor packet",
    retrieval: buildContextPacket().retrieval,
    packetVerdict: "edit-ready",
    diagnostics: seq(25, (index) => `diag-${index}`),
    focusFiles: seq(25, (index) => ({
      path: `src/focus-${index}.ts`,
      tier: "derived",
      reasons: seq(15, (reasonIndex) => `reason-${index}-${reasonIndex}`),
      matchedTerms: seq(15, (termIndex) => `term-${index}-${termIndex}`),
      rank: index,
      riskScore: index
    })),
    workflows: seq(14, (index) => ({
      title: `workflow-${index}`,
      relatedFiles: seq(25, (fileIndex) => `src/workflow-${index}-${fileIndex}.ts`),
      tests: seq(25, (testIndex) => `tests/workflow-${index}-${testIndex}.test.ts`),
      steps: seq(20, (stepIndex) => ({ kind: "open", label: `step-${index}-${stepIndex}` }))
    })),
    modules: seq(22, (index) => ({
      name: `module-${index}`,
      files: seq(25, (fileIndex) => `src/module-${index}-${fileIndex}.ts`),
      reasons: seq(15, (reasonIndex) => `reason-${index}-${reasonIndex}`)
    })),
    groups: seq(25, (index) => ({
      module: `group-${index}`,
      files: seq(35, (fileIndex) => `src/group-${index}-${fileIndex}.ts`),
      symbols: seq(25, (symbolIndex) => `symbol-${index}-${symbolIndex}`)
    })),
    tests: seq(35, (index) => ({ path: `tests/test-${index}.ts` })),
    nextCall: { tool: "task_brief", reason: "recommended next call" },
    quality: { level: "medium" },
    gaps: seq(35, (index) => `gap-${index}`),
    runtime: { commandBudgetMs: 1000 }
  };
}

export function buildTestPlanPacket() {
  return {
    changedFiles: seq(45, (index) => `src/changed-${index}.ts`),
    changedEntries: seq(45, (index) => ({ path: `src/entry-${index}.ts` })),
    changedSymbols: seq(45, (index) => ({ symbol: `symbol-${index}` })),
    unindexedChanged: seq(45, (index) => `src/unindexed-${index}.ts`),
    groups: seq(25, (index) => ({
      module: `group-${index}`,
      files: seq(35, (fileIndex) => `src/group-${index}-${fileIndex}.ts`),
      symbols: seq(25, (symbolIndex) => `symbol-${index}-${symbolIndex}`)
    })),
	    tests: seq(35, (index) => ({ path: `tests/test-${index}.ts` })),
	    outcomeLearning: seq(16, (index) => ({
	      path: `tests/learned-${index}.ts`,
	      rank: 10 - index,
	      reason: "outcome history raised priority",
	      targetPaths: [`src/changed-${index}.ts`],
	      sources: ["outcome_history"],
	      evidence: [`outcome evidence-${index}`]
	    })),
	    verificationCommands: seq(25, (index) => `cmd-${index}`),
    verificationCoverage: seq(50, (index) => ({
      kind: "unknown",
      command: `cmd-${index}`,
      source: "source",
      confidence: "derived",
      details: seq(15, (detailIndex) => `detail-${index}-${detailIndex}`)
    })),
    verificationCommandPlan: seq(35, (index) => ({
      command: `cmd-${index}`,
      covers: seq(15, (coverIndex) => `cover-${index}-${coverIndex}`),
      targetPaths: seq(25, (targetIndex) => `src/target-${index}-${targetIndex}.ts`),
      scopes: seq(15, (scopeIndex) => `scope-${index}-${scopeIndex}`),
      sources: seq(15, (sourceIndex) => `source-${index}-${sourceIndex}`)
	    })),
	    commandEnvelopes: seq(75, (index) => ({
	      command: `cmd-${index}`,
	      args: [],
	      source: "derived-from-raw-command",
	      scopeStatus: "repo",
	      classifierVersion: CURRENT_VERIFICATION_PROVENANCE.commandCoverageClassifierVersion
	    })),
	    verificationLedgerPreview: seq(75, (index) => ({
      kind: "test",
      recommended: `run test-${index}`,
      target: `tests/test-${index}.ts`,
      status: index % 2 === 0 ? "covered" : "missing",
      evidence: seq(12, (evidenceIndex) => `evidence-${index}-${evidenceIndex}`),
      coverageKinds: seq(15, (coverageIndex) => `coverage-${index}-${coverageIndex}`),
      command: `cmd-${index}`,
      source: `source-${index}`
	    })),
	    verificationProvenance: CURRENT_VERIFICATION_PROVENANCE,
	    testsNotRun: seq(35, (index) => ({ path: `tests/not-run-${index}.ts` })),
	    gaps: seq(35, (index) => `gap-${index}`)
	  };
	}

export function buildChangePlanPacket() {
  return {
    mode: "change_plan",
    editReadiness: { editable: false, status: "orientation-only", snapshotBlocked: true },
    snapshotBlock: { taskId: "blocked-snap-1", path: ".codex/cache/codexa-tasks/blocked-snap-1.blocked.json", reason: "context quality is low" },
    targetCandidates: seq(14, (index) => ({
      candidateId: `candidate-${index}`,
      rank: index + 1,
      kind: index % 2 === 0 ? "file" : "symbol",
      path: `src/candidate-${index}.ts`,
      symbol:
        index % 2 === 0
          ? undefined
          : {
              id: `sym-${index}`,
              name: `candidate${index}`,
              qualifiedName: `candidate${index}`,
              kind: "function"
            },
      score: 100 - index,
      confidence: "derived",
      evidence: seq(10, (evidenceIndex) => `evidence-${index}-${evidenceIndex}`),
      missingAnchors: ["file-or-symbol-target", "edit-ready-context"],
      validationStatus: index % 5 === 0 ? "weak" : "edit-ready",
      validationReasons: seq(10, (reasonIndex) => `validation-${index}-${reasonIndex}`),
      wouldPlanEditTargets: seq(10, (targetIndex) => `src/validated-${index}-${targetIndex}.ts`),
      wouldRecommendTests: seq(10, (testIndex) => `tests/validated-${index}-${testIndex}.test.ts`),
      candidateRisk: {
        score: index,
        reasons: seq(8, (reasonIndex) => `risk-${index}-${reasonIndex}`)
      },
      nextChangePlanArgs: { files: [`src/candidate-${index}.ts`], saveSnapshot: true },
      rawSearchQueries: seq(5, (queryIndex) => `query-${index}-${queryIndex}`)
    })),
    steps: seq(5, (index) => `step-${index}`),
    focus: buildFocusBriefPacket(),
    context: buildContextPacket(),
    files: seq(35, (index) => `src/file-${index}.ts`),
    plannedEditTargets: seq(35, (index) => `src/planned-${index}.ts`),
    tests: seq(35, (index) => ({ path: `tests/planned-${index}.test.ts` })),
    recipes: seq(15, (index) => `recipe-${index}`),
    quality: { level: "medium" },
    requiredWorkflowChecks: seq(25, (index) => ({ target: `workflow-${index}` })),
    requiredDependencyChecks: seq(35, (index) => ({ target: `dependency-${index}` })),
    complexityReview: {
      schemaVersion: 1,
      phase: "plan",
      status: "review",
      blocking: false,
      summary: "14 complexity signals need review.",
      items: seq(14, (index) => ({
        kind: "scope",
        severity: index % 2 === 0 ? "review" : "watch",
        message: `complexity item ${index}`,
        paths: seq(10, (pathIndex) => `src/complexity-${index}-${pathIndex}.ts`),
        rationale: `rationale ${index}`
      })),
      invariants: seq(10, (index) => `invariant ${index}`)
    },
    snapshot: {
      taskId: "snap-1",
      createdAt: "2026-04-11T00:00:00.000Z",
      changeType: "behavior",
      plannedEditTargets: seq(31, (index) => `src/snapshot-target-${index}.ts`),
      plannedFiles: seq(41, (index) => `src/snapshot-file-${index}.ts`),
      focusFiles: seq(21, (index) => ({ path: `src/snapshot-focus-${index}.ts`, tier: "derived", reasons: [`reason-${index}`], rank: index, riskScore: index })),
      plannedTests: seq(21, (index) => ({ path: `tests/snapshot-${index}.test.ts`, reason: `reason-${index}`, rank: index })),
      requiredWorkflowCheckCount: 7,
      requiredDependencyCheckCount: 8,
      requiredWorkflowChecks: seq(2, (index) => ({ target: `workflow-${index}` })),
      requiredDependencyChecks: seq(2, (index) => ({ target: `dependency-${index}` })),
      recipes: seq(9, (index) => `recipe-${index}`),
      gaps: seq(21, (index) => `gap-${index}`),
      warnings: seq(22, (index) => `warning-${index}`),
      dirtyBaseline: {
        headCommit: "abc",
        indexedAt: "2026-04-11T00:00:00.000Z",
        changedEntries: seq(21, (index) => ({ path: `src/snapshot-dirty-${index}.ts`, kind: "modified", status: "M", staged: false, worktree: true })),
        dirtyFiles: seq(21, (index) => `src/snapshot-dirty-${index}.ts`)
      },
      symbolBaseline: {
        "src/file-1.ts": [{ id: "symbol-1" }],
        "src/file-2.ts": [{ id: "symbol-2" }]
      },
      riskBaseline: {
        "src/file-1.ts": { riskScore: 1, signals: ["signal-1"] }
      },
      quality: { level: "medium" }
    }
  };
}
