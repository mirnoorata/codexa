import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, mkdir, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { describe, expect, it } from "vitest";
import { buildIndex } from "../src/indexer.js";
import { MCP_TOOL_CATALOG, PRIMARY_CODEX_LOOP, compactNonPostEditMcpResult, compactPostEditMcpResult } from "../src/mcp.js";
import { MCP_TOOL_NAMES, MCP_TOOL_REGISTRY } from "../src/mcp/tool-registry.js";
import { MCP_REGISTERED_TOOL_NAMES } from "../src/mcp/tools.js";
import { CURRENT_VERIFICATION_PROVENANCE } from "../src/types.js";
import { CODEXA_VERSION } from "../src/version.js";

function freshnessFixture() {
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

function seq<T>(count: number, factory: (index: number) => T): T[] {
  return Array.from({ length: count }, (_, index) => factory(index));
}

function serializedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

async function waitForStderr(child: ChildProcessWithoutNullStreams, pattern: RegExp, timeoutMs = 5000): Promise<string> {
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

async function stopChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  child.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
    setTimeout(resolve, 1500).unref();
  });
}

async function waitForExit(child: ChildProcessWithoutNullStreams, timeoutMs = 5000): Promise<{ code: number | null; signal: NodeJS.Signals | null; stderr: string }> {
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

async function createIndexedMcpRepo(parent: string, name: string, fileStem: string, symbol: string): Promise<string> {
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

async function createIndexedMcpAutoVerifyRepo(parent: string): Promise<string> {
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

function buildContextPacket(mode?: "focus_brief" | "task_brief") {
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

function buildFocusBriefPacket() {
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

function buildTestPlanPacket() {
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

function buildChangePlanPacket() {
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

describe("Codexa MCP server", () => {
  it("keeps the primary MCP happy path small and demotes graph/workflow tools", () => {
    const primaryTools = MCP_TOOL_CATALOG.filter((tool) => tool.tier === "primary").map((tool) => tool.name);

    expect(primaryTools).toEqual(["session_context", "search", "task_brief", "change_plan", "post_edit_review", "test_plan"]);
    expect(MCP_TOOL_CATALOG.find((tool) => tool.name === "workflow_path")).toMatchObject({ tier: "advanced" });
    expect(MCP_TOOL_CATALOG.find((tool) => tool.name === "change_plan")).toMatchObject({
      useWhen: expect.stringContaining("saveSnapshot=true"),
      avoidWhen: expect.stringContaining("post_edit_review")
    });
    expect(MCP_TOOL_CATALOG.find((tool) => tool.name === "search")).toMatchObject({
      readOnly: false,
      writeEffects: expect.stringContaining("index-cache-if-auto-refresh"),
      useWhen: expect.stringContaining("Before task_brief")
    });
    expect(MCP_TOOL_CATALOG.map((tool) => tool.name)).toEqual(MCP_TOOL_NAMES);
    expect(MCP_REGISTERED_TOOL_NAMES).toEqual(MCP_TOOL_NAMES);
    expect(MCP_TOOL_REGISTRY.map((tool) => ({ name: tool.name, title: tool.title, description: tool.description }))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "change_plan", title: "Codexa change plan", description: expect.stringContaining("saveSnapshot=true") }),
        expect.objectContaining({ name: "search", title: "Codexa hybrid semantic search", description: expect.stringContaining("First-class target discovery") }),
        expect.objectContaining({ name: "post_edit_review", title: "Codexa post-edit review", description: expect.stringContaining("Go-to post-edit review gate") })
      ])
    );
  });

  it("routes workspace-root MCP calls and resources to the focused repository", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "codexa-mcp-workspace-"));
    execFileSync("git", ["init"], { cwd: workspace, stdio: "ignore" });
    const repoA = await createIndexedMcpRepo(workspace, "repo-a", "alpha", "alphaSymbol");
    const repoB = await createIndexedMcpRepo(workspace, "repo-b", "beta", "betaSymbol");
    const focusFile = path.join(workspace, ".codex", "WORKING.md");
    await mkdir(path.dirname(focusFile), { recursive: true });
    await writeFile(focusFile, `## Session\n\n- Focused project: \`${repoA}\`.\n`, "utf8");

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(process.cwd(), "dist/cli.js"), "serve", workspace],
      stderr: "pipe"
    });
    const client = new Client({ name: "codexa-workspace-routing-test", version: "0.1.0" });
    await client.connect(transport);

    try {
      const firstFreshness = await client.callTool({ name: "freshness", arguments: {} });
      expect(JSON.stringify(firstFreshness)).toContain(repoA);
      expect(JSON.stringify(firstFreshness)).not.toContain("Failed to read git status");

      const firstRepoMap = await client.callTool({ name: "repo_map", arguments: { limit: 5 } });
      expect(JSON.stringify(firstRepoMap)).toContain("src/alpha.ts");
      expect(JSON.stringify(firstRepoMap)).not.toContain("src/beta.ts");

      const firstResource = await client.readResource({ uri: "codexa://repo/codebase/repo-map.md" });
      expect(String(firstResource.contents?.[0]?.text)).toContain("src/alpha.ts");
      expect(String(firstResource.contents?.[0]?.text)).not.toContain("src/beta.ts");

      await writeFile(focusFile, `## Active Focus\n\n- Project: \`${repoB}\`\n`, "utf8");

      const secondSearch = await client.callTool({ name: "find_context", arguments: { query: "betaSymbol", limit: 5 } });
      expect(JSON.stringify(secondSearch)).toContain(repoB);
      expect(JSON.stringify(secondSearch)).toContain("betaSymbol");
      expect(JSON.stringify(secondSearch)).not.toContain("Failed to read git status");

      const secondResource = await client.readResource({ uri: "codexa://repo/codebase/repo-map.md" });
      expect(String(secondResource.contents?.[0]?.text)).toContain("src/beta.ts");
      expect(String(secondResource.contents?.[0]?.text)).not.toContain("src/alpha.ts");
    } finally {
      await client.close();
    }
  });

  it("routes workspace-root task briefs from active-session rows before WORKING.md default", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "codexa-mcp-working-default-"));
    execFileSync("git", ["init"], { cwd: workspace, stdio: "ignore" });
    const defaultRepo = await createIndexedMcpRepo(workspace, "default-repo", "alpha", "alphaSymbol");
    const activeRepo = await createIndexedMcpRepo(workspace, "active-repo", "beta", "betaSymbol");
    const focusFile = path.join(workspace, ".codex", "WORKING.md");
    await mkdir(path.dirname(focusFile), { recursive: true });
    await writeFile(
      focusFile,
      [
        "## Workspace Default",
        "",
        `- Default repo: \`${defaultRepo}\`.`,
        "",
        "## Active Sessions",
        "",
        "| session | agent | repo | task | status | claims | last_seen | next |",
        "| --- | --- | --- | --- | --- | --- | --- | --- |",
        `| codex-test | codex | ${activeRepo} | route task | active | none | now | inspect |`
      ].join("\n"),
      "utf8"
    );

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(process.cwd(), "dist/cli.js"), "serve", workspace],
      stderr: "pipe"
    });
    const client = new Client({ name: "codexa-working-default-routing-test", version: "0.1.0" });
    await client.connect(transport);

    try {
      const taskBrief = await client.callTool({ name: "task_brief", arguments: { task: "change alphaSymbol", tokenBudget: 900, limit: 5 } });
      const serialized = JSON.stringify(taskBrief);
      expect(serialized).toContain(activeRepo);
      expect(serialized).toContain("betaSymbol");
      expect(serialized).not.toContain(defaultRepo);
      expect(serialized).not.toContain("Failed to read git status");
    } finally {
      await client.close();
    }
  });

  it("fails closed when active-session rows are ambiguous without a workspace session selector", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "codexa-mcp-working-ambiguous-active-"));
    execFileSync("git", ["init"], { cwd: workspace, stdio: "ignore" });
    const defaultRepo = await createIndexedMcpRepo(workspace, "default-repo", "alpha", "alphaSymbol");
    const otherRepo = await createIndexedMcpRepo(workspace, "other-repo", "beta", "betaSymbol");
    const focusFile = path.join(workspace, ".codex", "WORKING.md");
    await mkdir(path.dirname(focusFile), { recursive: true });
    await writeFile(
      focusFile,
      [
        "## Workspace Default",
        "",
        `- Default repo: \`${defaultRepo}\`.`,
        "",
        "## Active Sessions",
        "",
        "| session | agent | repo | task | status | claims | last_seen | next |",
        "| --- | --- | --- | --- | --- | --- | --- | --- |",
        `| codex-default | codex | ${defaultRepo} | workspace default task | active | none | now | inspect |`,
        `| codex-other | codex | ${otherRepo} | concurrent repo task | active | none | now | inspect |`
      ].join("\n"),
      "utf8"
    );

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(process.cwd(), "dist/cli.js"), "serve", workspace],
      stderr: "pipe"
    });
    const client = new Client({ name: "codexa-working-ambiguous-active-test", version: "0.1.0" });
    await client.connect(transport);

    try {
      const taskBrief = await client.callTool({ name: "task_brief", arguments: { task: "change alphaSymbol", tokenBudget: 900, limit: 5 } });
      expect(taskBrief.isError).toBe(true);
      expect(JSON.stringify(taskBrief)).toContain("Codexa MCP workspace focus is ambiguous");
    } finally {
      await client.close();
    }
  });

  it("routes ambiguous workspace active rows through an explicit workspace session", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "codexa-mcp-working-session-"));
    execFileSync("git", ["init"], { cwd: workspace, stdio: "ignore" });
    const defaultRepo = await createIndexedMcpRepo(workspace, "default-repo", "alpha", "alphaSymbol");
    const selectedRepo = await createIndexedMcpRepo(workspace, "selected-repo", "beta", "betaSymbol");
    const nextSelectedRepo = await createIndexedMcpRepo(workspace, "next-selected-repo", "gamma", "gammaSymbol");
    const otherRepo = await createIndexedMcpRepo(workspace, "other-repo", "delta", "deltaSymbol");
    const focusFile = path.join(workspace, ".codex", "WORKING.md");
    await mkdir(path.dirname(focusFile), { recursive: true });
    const writeFocusFile = async (selected: string) =>
      writeFile(
        focusFile,
        [
          "## Workspace Default",
          "",
          `- Default repo: \`${defaultRepo}\`.`,
          "",
          "## Active Sessions",
          "",
          "| session | agent | repo | task | status | claims | last_seen | next |",
          "| --- | --- | --- | --- | --- | --- | --- | --- |",
          `| codex-target | codex | ${selected} | target task | active | none | now | inspect |`,
          `| codex-other | codex | ${otherRepo} | concurrent repo task | active | none | now | inspect |`
        ].join("\n"),
        "utf8"
      );
    await writeFocusFile(selectedRepo);

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(process.cwd(), "dist/cli.js"), "serve", workspace, "--workspace-session", "codex-target"],
      stderr: "pipe"
    });
    const client = new Client({ name: "codexa-working-selected-session-test", version: "0.1.0" });
    await client.connect(transport);

    try {
      const firstBrief = await client.callTool({ name: "task_brief", arguments: { task: "change betaSymbol", tokenBudget: 900, limit: 5 } });
      const firstSerialized = JSON.stringify(firstBrief);
      expect(firstSerialized).toContain(selectedRepo);
      expect(firstSerialized).toContain("betaSymbol");
      expect(firstSerialized).not.toContain(defaultRepo);
      expect(firstSerialized).not.toContain(otherRepo);

      await writeFocusFile(nextSelectedRepo);

      const secondBrief = await client.callTool({ name: "task_brief", arguments: { task: "change gammaSymbol", tokenBudget: 900, limit: 5 } });
      const secondSerialized = JSON.stringify(secondBrief);
      expect(secondSerialized).toContain(nextSelectedRepo);
      expect(secondSerialized).toContain("gammaSymbol");
      expect(secondSerialized).not.toContain(selectedRepo);
      expect(secondSerialized).not.toContain(defaultRepo);
      expect(secondSerialized).not.toContain("Failed to read git status");
    } finally {
      await client.close();
    }
  });

  it("routes a shared workspace WORKING.md shape through an explicit current Codex session", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "codexa-mcp-srv-working-shape-"));
    execFileSync("git", ["init"], { cwd: workspace, stdio: "ignore" });
    const oldRepo = await createIndexedMcpRepo(workspace, "old-repo", "old", "oldSymbol");
    const currentRepo = await createIndexedMcpRepo(workspace, "current-repo", "current", "currentSymbol");
    const focusFile = path.join(workspace, ".codex", "WORKING.md");
    await mkdir(path.dirname(focusFile), { recursive: true });
    await writeFile(
      focusFile,
      [
        "# WORKING.md - Current Workspace State",
        "",
        "## Workspace Default",
        "",
        `- Default repo: \`${workspace}\`.`,
        "- Active project focus: shared workspace interface via the workspace root.",
        "",
        "## Active Sessions",
        "",
        "| session | agent | repo | task | status | claims | last_seen | next |",
        "| --- | --- | --- | --- | --- | --- | --- | --- |",
        `| codex-old-session | codex | ${oldRepo} | previous task | done | none | earlier | wait |`,
        `| codex-current-session | codex | ${currentRepo} | current task | active | none | now | implement |`
      ].join("\n"),
      "utf8"
    );

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(process.cwd(), "dist/cli.js"), "serve", workspace, "--workspace-session", "codex-current-session"],
      stderr: "pipe"
    });
    const client = new Client({ name: "codexa-srv-working-shape-routing-test", version: "0.1.0" });
    await client.connect(transport);

    try {
      const taskBrief = await client.callTool({ name: "task_brief", arguments: { task: "change currentSymbol", tokenBudget: 900, limit: 5 } });
      const serialized = JSON.stringify(taskBrief);
      expect(serialized).toContain(currentRepo);
      expect(serialized).toContain("currentSymbol");
      expect(serialized).not.toContain(oldRepo);
      expect(serialized).not.toContain("Failed to read git status");
    } finally {
      await client.close();
    }
  });

  it("routes configured workspace roots through the active project focus line", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "codexa-mcp-configured-workspace-focus-"));
    execFileSync("git", ["init"], { cwd: workspace, stdio: "ignore" });
    const currentRepo = await createIndexedMcpRepo(workspace, "current-repo", "current", "currentSymbol");
    const otherRepo = await createIndexedMcpRepo(workspace, "other-repo", "other", "otherSymbol");
    const focusFile = path.join(workspace, ".codex", "WORKING.md");
    await mkdir(path.dirname(focusFile), { recursive: true });
    await writeFile(path.join(workspace, ".codex", "config.toml"), "[features]\nhooks = true\n", "utf8");
    await writeFile(
      focusFile,
      [
        "# WORKING.md - Current Workspace State",
        "",
        "## Workspace Default",
        "",
        `- Default repo: \`${workspace}\`.`,
        `- Active project focus: Codexa project via repo \`${currentRepo}\`.`,
        "",
        "## Active Sessions",
        "",
        "| session | agent | repo | task | status | claims | last_seen | next |",
        "| --- | --- | --- | --- | --- | --- | --- | --- |",
        `| codex-current-session | codex | ${currentRepo} | current task | active | none | now | implement |`,
        `| codex-other-session | codex | ${otherRepo} | other task | active | none | now | inspect |`
      ].join("\n"),
      "utf8"
    );

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(process.cwd(), "dist/cli.js"), "serve", workspace],
      stderr: "pipe"
    });
    const client = new Client({ name: "codexa-configured-workspace-focus-routing-test", version: "0.1.0" });
    await client.connect(transport);

    try {
      const taskBrief = await client.callTool({ name: "task_brief", arguments: { task: "change currentSymbol", tokenBudget: 900, limit: 5 } });
      const serialized = JSON.stringify(taskBrief);
      expect(serialized).toContain(currentRepo);
      expect(serialized).toContain("currentSymbol");
      expect(serialized).not.toContain(otherRepo);
      expect(serialized).not.toContain("Failed to read git status");
    } finally {
      await client.close();
    }
  });

  it("does not let stale CODEXA_REPO override an explicit git repo argument", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "codexa-mcp-explicit-"));
    const explicitRepo = await createIndexedMcpRepo(workspace, "explicit-repo", "explicit", "explicitSymbol");
    const staleEnvRepo = await createIndexedMcpRepo(workspace, "stale-env-repo", "stale", "staleSymbol");

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(process.cwd(), "dist/cli.js"), "serve", explicitRepo],
      env: { CODEXA_REPO: staleEnvRepo },
      stderr: "pipe"
    });
    const client = new Client({ name: "codexa-explicit-routing-test", version: "0.1.0" });
    await client.connect(transport);

    try {
      const freshness = await client.callTool({ name: "freshness", arguments: {} });
      expect(JSON.stringify(freshness)).toContain(explicitRepo);
      expect(JSON.stringify(freshness)).not.toContain(staleEnvRepo);

      const repoMap = await client.callTool({ name: "repo_map", arguments: { limit: 5 } });
      expect(JSON.stringify(repoMap)).toContain("src/explicit.ts");
      expect(JSON.stringify(repoMap)).not.toContain("src/stale.ts");
    } finally {
      await client.close();
    }
  });

  it("does not let stale workspace focus env override an explicit wired MCP repo", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "codexa-mcp-explicit-focus-env-"));
    const explicitRepo = await createIndexedMcpRepo(workspace, "explicit-repo", "explicit", "explicitSymbol");
    const staleRepo = await createIndexedMcpRepo(workspace, "stale-repo", "stale", "staleSymbol");
    await mkdir(path.join(explicitRepo, ".codex"), { recursive: true });
    await writeFile(path.join(explicitRepo, ".codex", "config.toml"), "[features]\nhooks = true\n", "utf8");
    const focusFile = path.join(workspace, "WORKING.md");
    await writeFile(
      focusFile,
      [
        "## Active Sessions",
        "",
        "| session | agent | repo | task | status | claims | last_seen | next |",
        "| --- | --- | --- | --- | --- | --- | --- | --- |",
        `| other-session | codex | ${staleRepo} | other task | active | none | now | inspect |`
      ].join("\n"),
      "utf8"
    );

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(process.cwd(), "dist/cli.js"), "serve", explicitRepo],
      env: { CODEXA_WORKSPACE_FOCUS_FILE: focusFile, SESSION_ID: "stale-session" },
      stderr: "pipe"
    });
    const client = new Client({ name: "codexa-explicit-focus-env-routing-test", version: "0.1.0" });
    await client.connect(transport);

    try {
      const repoMap = await client.callTool({ name: "repo_map", arguments: { limit: 5 } });
      const serialized = JSON.stringify(repoMap);
      expect(serialized).toContain("src/explicit.ts");
      expect(serialized).not.toContain("src/stale.ts");
      expect(serialized).not.toContain("stale-session");
    } finally {
      await client.close();
    }
  });

  it("ignores out-of-tree repo paths from workspace focus files", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "codexa-mcp-focused-root-"));
    const outsideParent = await mkdtemp(path.join(os.tmpdir(), "codexa-mcp-outside-"));
    execFileSync("git", ["init"], { cwd: workspace, stdio: "ignore" });
    const outsideRepo = await createIndexedMcpRepo(outsideParent, "outside-repo", "outside", "outsideSymbol");
    const outsideLink = path.join(workspace, "outside-link");
    await symlink(outsideRepo, outsideLink, "dir");
    const focusFile = path.join(workspace, ".codex", "WORKING.md");
    await mkdir(path.dirname(focusFile), { recursive: true });
    await writeFile(focusFile, `## Session\n\n- Focused project: \`${outsideLink}\`.\n`, "utf8");

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(process.cwd(), "dist/cli.js"), "serve", workspace],
      stderr: "pipe"
    });
    const client = new Client({ name: "codexa-focused-root-boundary-test", version: "0.1.0" });
    await client.connect(transport);

    try {
      const freshness = await client.callTool({ name: "freshness", arguments: {} });
      expect(JSON.stringify(freshness)).toContain(workspace);
      expect(JSON.stringify(freshness)).not.toContain(outsideRepo);
    } finally {
      await client.close();
    }
  });

  it("exposes bounded context tools with stale-index auto-refresh over stdio", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-mcp-"));
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    await mkdir(path.join(repo, "src"), { recursive: true });
    await mkdir(path.join(repo, "tests"), { recursive: true });
    await writeFile(path.join(repo, "package.json"), JSON.stringify({ scripts: { test: "vitest run" } }, null, 2), "utf8");
    await writeFile(path.join(repo, "src/index.ts"), "export function main() { return 1 }\n", "utf8");
    await writeFile(path.join(repo, "tests/index.test.ts"), "import { main } from '../src/index'\ntest('main', () => expect(main()).toBe(1))\n", "utf8");
    execFileSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["-c", "user.name=Codexa", "-c", "user.email=codexa@example.invalid", "commit", "-m", "fixture"], {
      cwd: repo,
      stdio: "ignore"
    });
    await buildIndex({ repoRoot: repo });

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(process.cwd(), "dist/cli.js"), "serve", repo],
      stderr: "pipe"
    });
    const stderrChunks: Buffer[] = [];
    transport.stderr?.on("data", (chunk) => stderrChunks.push(Buffer.from(chunk)));

    const client = new Client({ name: "codexa-test", version: "0.1.0" });
    await client.connect(transport);
    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining([
        "repo_map",
        "find_context",
        "search",
        "placeholder_report",
        "symbol_context",
        "impact",
        "diff_impact",
        "test_plan",
        "freshness",
        "task_brief",
        "context_pack",
        "focus_brief",
        "session_context",
        "session_memory",
        "callers",
        "callees",
        "dependency_path",
        "workflow_path",
        "change_plan",
        "post_edit_review"
      ])
    );
    const contextTool = tools.tools.find((tool) => tool.name === "context_pack");
    expect(contextTool?.outputSchema).toBeTruthy();
    expect(JSON.stringify(contextTool?.outputSchema)).toContain("schemaVersion");
    expect(JSON.stringify(contextTool?.outputSchema)).toContain("actionability");
    expect(JSON.stringify(contextTool?.outputSchema)).toContain("repoRoot");
    expect(JSON.stringify(contextTool?.outputSchema)).toContain("snapshotStatus");
    expect(JSON.stringify(contextTool?.outputSchema)).toContain("knownClean");
    expect(JSON.stringify(contextTool?.outputSchema)).toContain("commandCoverageClassifierVersion");
    expect(contextTool?.annotations?.destructiveHint).toBe(false);
    expect(contextTool?.annotations?.openWorldHint).toBe(false);
    expect(contextTool?.annotations?.readOnlyHint).toBe(false);
    expect(contextTool?.annotations?.idempotentHint).toBe(false);
	    const searchSchema = JSON.stringify(tools.tools.find((tool) => tool.name === "search")?.inputSchema);
	    expect(searchSchema).toContain("patterns");
	    expect(searchSchema).toContain("maxItems");
	    expect(searchSchema).toContain("7");
	    const symbolContextSchema = JSON.stringify(tools.tools.find((tool) => tool.name === "symbol_context")?.inputSchema);
	    expect(symbolContextSchema).toContain("depth");
	    expect(symbolContextSchema).toContain("includeEvidence");
	    expect(symbolContextSchema).toContain("language");
    const changePlanSchema = JSON.stringify(tools.tools.find((tool) => tool.name === "change_plan")?.inputSchema);
    expect(changePlanSchema).toContain("followCandidate");
    const testPlanSchema = JSON.stringify(tools.tools.find((tool) => tool.name === "test_plan")?.inputSchema);
    expect(testPlanSchema).toContain("changeType");
    expect(tools.tools.find((tool) => tool.name === "impact")?.annotations?.readOnlyHint).toBe(false);
    expect(tools.tools.find((tool) => tool.name === "freshness")?.annotations?.readOnlyHint).toBe(true);

    const freshness = await client.callTool({ name: "freshness", arguments: {} });
    expect(freshness.structuredContent).toMatchObject({
      schemaVersion: 1,
      mode: "freshness",
      actionability: expect.any(String),
      toolPolicy: {
        name: "freshness",
        readOnly: true,
        useWhen: expect.stringContaining("Check whether indexed artifacts")
      }
    });
    expect(JSON.stringify(freshness.content)).toContain("resource_link");

    const sourcePolicyCases: Array<[string, Record<string, unknown>]> = [
      ["search", { query: "main", limit: 3 }],
      ["repo_map", { limit: 3 }],
      ["symbol_context", { symbol: "main" }],
      ["callers", { file: "src/index.ts", limit: 3 }],
      ["workflow_path", { query: "main", limit: 3 }]
    ];
	    for (const [name, args] of sourcePolicyCases) {
	      const result = await client.callTool({ name, arguments: args });
      const toolPolicy = (result.structuredContent as { toolPolicy?: { name?: string; readOnly?: boolean; writeEffects?: string } }).toolPolicy;
      const listed = tools.tools.find((tool) => tool.name === name);
      expect(toolPolicy).toMatchObject({
        name,
        readOnly: listed?.annotations?.readOnlyHint,
        writeEffects: expect.stringContaining("index-cache-if-auto-refresh")
	      });
	    }
	    const symbolContext = await client.callTool({ name: "symbol_context", arguments: { symbol: "main", depth: 2 } });
	    const symbolData = (symbolContext.structuredContent as { data?: { mode?: string; edgeEvidence?: unknown[]; nextTools?: Array<{ tool?: string }> } }).data;
	    expect(symbolData?.mode).toBe("symbol_context");
	    expect(Array.isArray(symbolData?.edgeEvidence)).toBe(true);
	    expect(symbolData?.nextTools?.some((tool) => tool.tool === "impact")).toBe(true);

	    const rejectedFollow = await client.callTool({ name: "change_plan", arguments: { taskId: "missing-mcp-follow", followCandidate: "candidate-missing" } });
    expect(JSON.stringify(rejectedFollow)).toContain("Follow candidate: rejected");
    expect(((rejectedFollow.structuredContent as { data?: { followCandidate?: { status?: string; requested?: string } } }).data?.followCandidate)).toMatchObject({
      status: "rejected",
      requested: "candidate-missing"
    });

    const blockedPlan = await client.callTool({
      name: "change_plan",
      arguments: { task: "Change main", diff: false, limit: 6, tokenBudget: 1200, saveSnapshot: true, taskId: "mcp-follow-policy" }
    });
    const blockedPlanData = blockedPlan.structuredContent as {
      data?: {
        snapshotBlock?: { taskId?: string };
        targetCandidates?: Array<{ candidateId: string; validationStatus?: string }>;
      };
    };
    const acceptedCandidate = blockedPlanData.data?.targetCandidates?.find((candidate) => candidate.validationStatus === "edit-ready");
    expect(blockedPlanData.data?.snapshotBlock).toMatchObject({ taskId: "mcp-follow-policy" });
    expect(acceptedCandidate?.candidateId).toMatch(/^candidate-/);
    const acceptedFollow = await client.callTool({
      name: "change_plan",
      arguments: { taskId: "mcp-follow-policy", followCandidate: acceptedCandidate!.candidateId }
    });
    expect(((acceptedFollow.structuredContent as { data?: { followCandidate?: { status?: string } } }).data?.followCandidate)).toMatchObject({ status: "accepted" });
    expect((acceptedFollow.structuredContent as { toolPolicy?: { writeEffects?: string } }).toolPolicy?.writeEffects).toContain("task-snapshot-cache");

    const resources = await client.listResources();
    expect(resources.resources.length).toBeLessThanOrEqual(200);
    expect(resources.resources.map((resource) => resource.uri)).toEqual(
      expect.arrayContaining([
        "codexa://repo/codebase/README.md",
        "codexa://repo/codebase/codex-contract.md",
        "codexa://repo/codebase/repo-map.md",
        "codexa://repo/codebase/placeholder-map.md",
        "codexa://repo/codebase/workflows.md",
        "codexa://repo/codebase/playbooks/README.md",
        "codexa://repo/codebase/freshness.json"
      ])
    );
    const playbookUri = resources.resources.map((resource) => resource.uri).find((uri) => uri.startsWith("codexa://repo/codebase/playbooks/") && !uri.endsWith("/README.md"));
    expect(playbookUri).toBeTruthy();
    const playbook = await client.readResource({ uri: playbookUri! });
    expect(playbook.contents?.[0]?.text).toContain("Playbook");
    for (const resource of resources.resources) {
      const content = await client.readResource({ uri: resource.uri });
      expect(content.contents?.[0]?.text).toBeTruthy();
      expect(String(content.contents?.[0]?.text)).not.toContain("Codexa artifact missing");
    }
    const readme = await client.readResource({ uri: "codexa://repo/codebase/README.md" });
    expect(readme.contents?.[0]?.text).toContain("Codexa Codebase Context");
    const contract = await client.readResource({ uri: "codexa://repo/codebase/codex-contract.md" });
    expect(contract.contents?.[0]?.text).toContain("Automatic Use Rules");
    expect(contract.contents?.[0]?.text).toContain("Session Memory Protocol");
    const placeholderMap = await client.readResource({ uri: "codexa://repo/codebase/placeholder-map.md" });
    expect(placeholderMap.contents?.[0]?.text).toContain("Placeholder Map");

    const prompts = await client.listPrompts();
    expect(prompts.prompts.map((prompt) => prompt.name)).toEqual(
      expect.arrayContaining(["impact_before_edit", "dirty_diff_review", "snapshot_edit_loop", "targeted_test_plan"])
    );
    const prompt = await client.getPrompt({ name: "impact_before_edit", arguments: { target: "src/index.ts", task: "change behavior" } });
    expect(prompt.messages[0].content.type).toBe("text");
    if (prompt.messages[0].content.type === "text") {
      expect(prompt.messages[0].content.text).toContain("impact");
    }

    const result = await client.callTool({ name: "freshness", arguments: {} });
    expect(result.content?.[0]?.type).toBe("text");
    expect(result.structuredContent).toBeTruthy();
    expect(JSON.stringify(result)).toContain("fresh");

    const repoMap = await client.callTool({ name: "repo_map", arguments: { limit: 3 } });
    expect(JSON.stringify(repoMap)).toContain("src/index.ts");

    await writeFile(path.join(repo, "src/index.ts"), "export function changedSymbol() { return 2 }\n", "utf8");
    const dirtyFreshness = await client.callTool({ name: "freshness", arguments: {} });
    expect((dirtyFreshness.structuredContent as { freshness?: { stale?: boolean; reason?: string } }).freshness?.stale).toBe(true);
    expect((dirtyFreshness.structuredContent as { freshness?: { reason?: string } }).freshness?.reason).toBe("dirty-files-changed");
    const dirtyFreshnessResource = await client.readResource({ uri: "codexa://repo/codebase/freshness.json" });
    expect(JSON.parse(String(dirtyFreshnessResource.contents?.[0]?.text)).stale).toBe(true);
    const refreshed = await client.callTool({ name: "find_context", arguments: { query: "changedSymbol", limit: 3 } });
    expect(JSON.stringify(refreshed)).toContain("auto-refreshed from dirty-files-changed");
    expect(JSON.stringify(refreshed)).toContain("changedSymbol");
    const refreshedFreshnessResource = await client.readResource({ uri: "codexa://repo/codebase/freshness.json" });
    expect(JSON.parse(String(refreshedFreshnessResource.contents?.[0]?.text)).stale).toBe(false);

    const search = await client.callTool({ name: "search", arguments: { query: "changedSymbol", patterns: ["changedSymbol", "changed_symbol"], limit: 3 } });
    expect(JSON.stringify(search)).toContain("Codexa value");
    expect(JSON.stringify(search)).toContain("changedSymbol");
    expect(JSON.stringify(search)).toContain("Search patterns");

    const impact = await client.callTool({ name: "impact", arguments: { file: "src/index.ts", changeType: "api", depth: 2 } });
    expect(JSON.stringify(impact)).toContain("Impact target");
    expect(JSON.stringify(impact)).toContain("Change type: api");

    const testPlan = await client.callTool({ name: "test_plan", arguments: { diff: true } });
    expect(JSON.stringify(testPlan)).toContain("Test plan");

    const contextPack = await client.callTool({ name: "context_pack", arguments: { query: "changedSymbol", changeType: "behavior", tokenBudget: 800, limit: 5 } });
    expect(JSON.stringify(contextPack)).toContain("Codexa context pack");
    expect(JSON.stringify(contextPack)).toContain("changedSymbol");
    const contextPackData = contextPack.structuredContent as {
      data?: {
        contextSources?: Array<{ source?: string; fileCount?: number }>;
        verificationCommands?: string[];
        verificationCoverage?: Array<{ kind: string }>;
        verificationCommandPlan?: Array<{ command: string; covers: string[] }>;
        sessionMemory?: { autoRecorded?: boolean; writes?: { sessionId?: string; revision?: number; recordedEntryIds?: string[] } };
      };
    };
    expect(contextPackData.data?.contextSources?.map((entry) => entry.source)).toContain("lexical_query");
    expect(contextPackData.data?.verificationCommands?.length).toBeGreaterThan(0);
    expect(contextPackData.data?.verificationCoverage?.length).toBeGreaterThan(0);
    expect(contextPackData.data?.verificationCommandPlan?.length).toBeGreaterThan(0);
    expect(contextPackData.data?.sessionMemory?.autoRecorded).toBe(true);
    expect(contextPackData.data?.sessionMemory?.writes?.sessionId).toBeTruthy();
    expect(contextPackData.data?.sessionMemory?.writes?.revision).toBeGreaterThan(0);
    expect(contextPackData.data?.sessionMemory?.writes?.recordedEntryIds?.length).toBeGreaterThan(0);

    const taskBrief = await client.callTool({ name: "task_brief", arguments: { files: ["src/index.ts"], task: "change behavior", tokenBudget: 900, limit: 5 } });
    expect(JSON.stringify(taskBrief)).toContain("Codexa task brief");
    expect(JSON.stringify(taskBrief)).toContain("mode");
    const taskBriefData = taskBrief.structuredContent as {
      data?: {
        contextSources?: Array<{ source?: string; fileCount?: number }>;
        verificationCommands?: string[];
        verificationCoverage?: Array<{ kind: string }>;
        verificationCommandPlan?: Array<{ command: string; covers: string[] }>;
      };
    };
    expect(taskBriefData.data?.contextSources?.map((entry) => entry.source)).toContain("explicit_target");
    expect(taskBriefData.data?.verificationCommands?.length).toBeGreaterThan(0);
    expect(taskBriefData.data?.verificationCoverage?.length).toBeGreaterThan(0);
    expect(taskBriefData.data?.verificationCommandPlan?.length).toBeGreaterThan(0);

    const focusBrief = await client.callTool({ name: "focus_brief", arguments: { task: "understand the main workflow", tokenBudget: 900, limit: 5 } });
    expect(JSON.stringify(focusBrief)).toContain("Codexa focus brief");

    const autoMemorySummary = await client.callTool({
      name: "session_memory",
      arguments: { action: "summary", kinds: ["viewed", "verification"], limit: 10 }
    });
    expect(JSON.stringify(autoMemorySummary)).toContain("Recently viewed:");
    expect(JSON.stringify(autoMemorySummary)).toContain("context_pack returned");
    expect(JSON.stringify(autoMemorySummary)).toContain("test_plan recommended");

    const remembered = await client.callTool({
      name: "session_memory",
      arguments: {
        action: "remember",
        sessionId: "mcp-test-session",
        taskId: "mcp-changed-symbol",
        files: ["src/index.ts"],
        topics: ["mcp test"],
        entries: [
          {
            kind: "decision",
            key: "decision:mcp-test",
            summary: "Use the session_memory MCP tool to persist task-local decisions.",
            provenance: "agent-asserted",
            confidence: "heuristic",
            evidenceTier: "derived"
          }
        ]
      }
    });
    expect(JSON.stringify(remembered)).toContain("Codexa session memory");
    const rememberedData = remembered.structuredContent as { data?: { writes?: { recordedEntryIds?: string[] }; memory?: { decisions?: Array<{ confidence: string; provenance: string }> } } };
    expect(rememberedData.data?.writes?.recordedEntryIds?.length).toBe(1);
    expect(rememberedData.data?.memory?.decisions?.[0]).toMatchObject({ confidence: "heuristic", provenance: "agent-asserted" });

    const recalled = await client.callTool({
      name: "session_memory",
      arguments: { action: "read", sessionId: "mcp-test-session", taskId: "mcp-changed-symbol", kinds: ["decision"], files: ["src/index.ts"] }
    });
    expect(JSON.stringify(recalled)).toContain("Use the session_memory MCP tool");

    const memorySummary = await client.callTool({
      name: "session_memory",
      arguments: { action: "summary", sessionId: "mcp-test-session", taskId: "mcp-changed-symbol" }
    });
    expect(JSON.stringify(memorySummary)).toContain("Decisions:");
    const cliMemorySummary = execFileSync(process.execPath, [path.join(process.cwd(), "dist/cli.js"), "session-memory", repo, "--action", "summary", "--session-id", "mcp-test-session", "--task-id", "mcp-changed-symbol"], {
      encoding: "utf8"
    });
    expect(cliMemorySummary).toContain("Codexa session memory");
    expect(cliMemorySummary).toContain("Use the session_memory MCP tool");

    const callers = await client.callTool({ name: "callers", arguments: { symbol: "changedSymbol", limit: 5 } });
    expect(JSON.stringify(callers)).toContain("Callers/importers");

    const unsavedChangePlan = await client.callTool({
      name: "change_plan",
      arguments: { task: "change changedSymbol safely", symbols: ["changedSymbol"], tokenBudget: 1000, limit: 5 }
    });
    expect((unsavedChangePlan.structuredContent as { toolPolicy?: { writeEffects?: string } }).toolPolicy?.writeEffects).toBe("session-memory-auto+index-cache-if-auto-refresh");

    const changePlan = await client.callTool({
      name: "change_plan",
      arguments: { task: "change changedSymbol safely", symbols: ["changedSymbol"], tokenBudget: 1000, limit: 5, saveSnapshot: true, taskId: "mcp-changed-symbol" }
    });
    expect(JSON.stringify(changePlan)).toContain("Codexa change plan");
    expect(JSON.stringify(changePlan)).toContain("Task snapshot: mcp-changed-symbol");
    expect((changePlan.structuredContent as { toolPolicy?: { writeEffects?: string } }).toolPolicy?.writeEffects).toBe(
      "task-snapshot-cache+session-memory-auto+index-cache-if-auto-refresh"
    );

    await writeFile(path.join(repo, "src/index.ts"), "export function changedSymbol() { return 3 }\n", "utf8");
    const indexMtimeBeforePostEdit = (await stat(path.join(repo, ".codex/codebase/index.json"))).mtimeMs;
    const postEdit = await client.callTool({
      name: "post_edit_review",
      arguments: {
        taskId: "mcp-changed-symbol",
        ranTests: [],
        ranCommands: ["npm test"],
        ranCommandReports: [{ command: "npm test", cwd: repo, packageManager: "npm", packageRoot: ".", scriptName: "test", args: [], exitCode: 0, durationMs: 50, stdoutSummary: "vitest passed" }]
      }
    });
    expect(JSON.stringify(postEdit)).toContain("Codexa post-edit review");
    expect(JSON.stringify(postEdit)).toContain("Changed since snapshot");
    expect(JSON.stringify(postEdit)).toContain("auto-refreshed");
    expect(JSON.stringify(postEdit)).toContain("verificationLedger");
    expect(JSON.stringify(postEdit)).toContain("ranCommands");
    expect(JSON.stringify(postEdit)).toContain('"persisted":false');
    const postEditEnvelope = postEdit.structuredContent as { data: unknown; nextTools?: unknown[]; systemMessage?: string };
    const postEditData = postEditEnvelope.data as {
      ranCommands?: string[];
      ranCommandReports?: Array<{ command: string; exitCode?: number; durationMs?: number }>;
      commandEnvelopes?: Array<{ command: string; cwd?: string; packageManager?: string; packageRoot?: string; scriptName?: string; source?: string; scopeStatus?: string; args: string[] }>;
      verificationProvenance?: typeof CURRENT_VERIFICATION_PROVENANCE;
      mcp?: { verificationProvenance?: typeof CURRENT_VERIFICATION_PROVENANCE };
      verificationLedger?: Array<{ status: string; evidence: string[] }>;
      systemMessage?: string;
      outcome?: {
        persisted?: boolean;
        ranTests?: string[];
        ranCommands?: string[];
        ranCommandReports?: Array<{ command: string; cwd?: string; stdoutSummary?: string }>;
        commandEnvelopes?: Array<{ command: string; cwd?: string; packageManager?: string; packageRoot?: string; scriptName?: string; source?: string; scopeStatus?: string; args: string[] }>;
        verificationProvenance?: typeof CURRENT_VERIFICATION_PROVENANCE;
        waivedChecks?: string[];
        verificationCoverage?: unknown[];
        verificationLedger?: unknown[];
      };
    };
    expect(postEditData.ranCommands).toEqual(["npm test"]);
    expect(postEditData.ranCommandReports?.[0]).toMatchObject({ command: "npm test", exitCode: 0, durationMs: 50 });
    expect(postEditData.commandEnvelopes?.[0]).toMatchObject({ command: "npm test", cwd: "<repo>", packageManager: "npm", packageRoot: ".", scriptName: "test", source: "reported", scopeStatus: "repo", args: [] });
    expect(postEditData.verificationProvenance).toEqual(CURRENT_VERIFICATION_PROVENANCE);
    expect(postEditData.mcp?.verificationProvenance).toEqual(CURRENT_VERIFICATION_PROVENANCE);
    expect(postEditData.verificationLedger?.some((entry) => entry.status === "covered" && entry.evidence.some((item) => item.includes("npm test")))).toBe(true);
    expect(postEditData.outcome?.persisted).toBe(false);
    expect(postEditData.outcome?.ranTests).toEqual([]);
    expect(postEditData.outcome?.ranCommands).toEqual(["npm test"]);
    expect(postEditData.outcome?.ranCommandReports?.[0]).toMatchObject({ command: "npm test", cwd: "<repo>", stdoutSummary: "vitest passed" });
    expect(postEditData.outcome?.commandEnvelopes?.[0]).toMatchObject({ command: "npm test", cwd: "<repo>", packageManager: "npm", packageRoot: ".", scriptName: "test", source: "reported" });
    expect(postEditData.outcome?.verificationProvenance).toEqual(CURRENT_VERIFICATION_PROVENANCE);
    expect(postEditData.outcome?.waivedChecks).toEqual([]);
    expect(postEditData.outcome?.verificationCoverage?.length).toBeGreaterThan(0);
    expect(postEditData.outcome?.verificationLedger?.length).toBeGreaterThan(0);

    const unverifiedPostEdit = await client.callTool({
      name: "post_edit_review",
      arguments: { taskId: "mcp-changed-symbol", ranTests: [], ranCommands: [] }
    });
    const unverifiedEnvelope = unverifiedPostEdit.structuredContent as {
      data: { nextTools?: Array<{ tool?: string; reason?: string; readOnly?: boolean; writes?: string[] }>; systemMessage?: string };
      nextTools?: unknown[];
      systemMessage?: string;
    };
    expect(unverifiedEnvelope.data.nextTools?.some((tool) => tool.tool === "test_plan" && tool.reason && tool.readOnly === true)).toBe(true);
    expect(unverifiedEnvelope.nextTools?.some((tool) => typeof tool === "object" && tool !== null && "tool" in tool)).toBe(true);
    expect(unverifiedEnvelope.systemMessage).toBe(unverifiedEnvelope.data.systemMessage);

    const outsideCwd = path.join(os.tmpdir(), "codexa-secret-outside");
    const longSummary = `outside path ${outsideCwd} ${"x".repeat(900)}`;
    const redactedPostEdit = await client.callTool({
      name: "post_edit_review",
      arguments: {
        taskId: "mcp-changed-symbol",
        ranTests: [],
        ranCommandReports: [{ command: "npm test", cwd: outsideCwd, exitCode: 0, stdoutSummary: longSummary }]
      }
    });
    const redactedSerialized = JSON.stringify(redactedPostEdit);
    expect(redactedSerialized).not.toContain(outsideCwd);
    expect(redactedSerialized).not.toContain(longSummary);
    expect(redactedSerialized).toContain("<outside-repo>");

    const waivedPostEdit = await client.callTool({
      name: "post_edit_review",
      arguments: {
        taskId: "mcp-changed-symbol",
        ranTests: [],
        ranCommands: [],
        waivers: [{ kind: "test", target: "tests/index.test.ts", reason: "manual browser regression" }]
      }
    });
    expect(JSON.stringify(waivedPostEdit)).toContain("waivedVerification");
    const waivedData = waivedPostEdit.structuredContent as {
      data: {
        waivedVerification?: Array<{ kind: string; target: string; status: string }>;
        outcome?: { waivedVerification?: Array<{ kind: string; target: string; status: string }> };
      };
    };
    expect(waivedData.data.waivedVerification?.some((entry) => entry.kind === "test" && entry.target === "tests/index.test.ts" && entry.status === "waived")).toBe(true);
    expect(waivedData.data.outcome?.waivedVerification?.some((entry) => entry.kind === "test" && entry.target === "tests/index.test.ts" && entry.status === "waived")).toBe(true);
    expect((await stat(path.join(repo, ".codex/codebase/index.json"))).mtimeMs).toBeGreaterThanOrEqual(indexMtimeBeforePostEdit);
    await expect(readdir(path.join(repo, ".codex/cache/codexa-outcomes"))).rejects.toThrow();

    await client.close();
    expect(Buffer.concat(stderrChunks).toString("utf8")).toContain("codexa MCP server ready");
  });

  it("does not execute AutoVerify through MCP even when CODEXA_AUTOVERIFY is enabled", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "codexa-mcp-autoverify-"));
    const repo = await createIndexedMcpAutoVerifyRepo(workspace);
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(process.cwd(), "dist/cli.js"), "serve", repo],
      env: { CODEXA_AUTOVERIFY: "1" },
      stderr: "pipe"
    });
    const client = new Client({ name: "codexa-mcp-autoverify-test", version: "0.1.0" });
    await client.connect(transport);

    try {
      const changePlan = await client.callTool({
        name: "change_plan",
        arguments: { task: "change main safely", files: ["src/main.js"], saveSnapshot: true, taskId: "mcp-autoverify-no-exec", limit: 5, tokenBudget: 1000 }
      });
      expect(JSON.stringify(changePlan)).toContain("Task snapshot: mcp-autoverify-no-exec");
      await writeFile(path.join(repo, "src/main.js"), "export function main() {\n  return 1;\n}\n", "utf8");

      const postEdit = await client.callTool({
        name: "post_edit_review",
        arguments: { taskId: "mcp-autoverify-no-exec", ranTests: [], ranCommands: [] }
      });
      expect(JSON.stringify(postEdit)).toContain("tests/main.test.js");
      const data = (postEdit.structuredContent as { data?: { ranCommandReports?: unknown[]; autoVerifyRunnerEvidence?: unknown[] } }).data;
      expect(data?.ranCommandReports ?? []).toEqual([]);
      expect(data?.autoVerifyRunnerEvidence ?? []).toEqual([]);
      await expect(stat(path.join(repo, "mcp-executed.txt"))).rejects.toThrow();

      const spoofed = await client.callTool({
        name: "post_edit_review",
        arguments: {
          taskId: "mcp-autoverify-no-exec",
          ranTests: [],
          ranCommandReports: [
            {
              command: "echo done",
              cwd: repo,
              exitCode: 0,
              runner: { reportKind: "codexa-autoverify-report", runnerName: "codexa" }
            }
          ],
          trustedRunnerReports: [{ command: "npm test", cwd: repo, exitCode: 0 }]
        }
      });
      const spoofedData = (spoofed.structuredContent as { data?: { autoVerifyRunnerEvidence?: unknown[]; verificationCoverage?: Array<{ kind?: string }> } }).data;
      expect(spoofedData?.autoVerifyRunnerEvidence ?? []).toEqual([]);
      expect(spoofedData?.verificationCoverage?.some((entry) => entry.kind === "javascript-tests")).toBe(false);
      expect(JSON.stringify(spoofed)).not.toContain("codexa-autoverify-report");
    } finally {
      await client.close();
    }
  });

  it("serves placeholder report tool output and placeholder map resource", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-mcp-placeholder-"));
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    await mkdir(path.join(repo, "src"), { recursive: true });
    await mkdir(path.join(repo, "tests"), { recursive: true });
    await writeFile(path.join(repo, "package.json"), JSON.stringify({ scripts: { test: "vitest run" } }, null, 2), "utf8");
    await writeFile(path.join(repo, "src/index.ts"), "export function later() { throw new Error('not implemented') }\n", "utf8");
    await writeFile(path.join(repo, "tests/index.test.ts"), "it('keeps fixture placeholder text', () => {}) // TODO fixture\n", "utf8");
    execFileSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["-c", "user.name=Codexa", "-c", "user.email=codexa@example.invalid", "commit", "-m", "fixture"], {
      cwd: repo,
      stdio: "ignore"
    });
    await buildIndex({ repoRoot: repo });

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(process.cwd(), "dist/cli.js"), "serve", repo],
      stderr: "pipe"
    });
    const client = new Client({ name: "codexa-placeholder-test", version: "0.1.0" });
    await client.connect(transport);
    const report = await client.callTool({ name: "placeholder_report", arguments: { limit: 10 } });
    const data = (report.structuredContent as { data?: { findings?: Array<{ path: string; signal: string }>; filters?: { includeTests: boolean } } }).data;
    expect(JSON.stringify(report)).toContain("Codexa placeholder report");
    expect(data?.findings?.some((finding) => finding.path === "src/index.ts" && finding.signal === "placeholder.not-implemented")).toBe(true);
    expect(data?.findings?.some((finding) => finding.path.startsWith("tests/"))).toBe(false);
    expect(data?.filters?.includeTests).toBe(false);
    const resource = await client.readResource({ uri: "codexa://repo/codebase/placeholder-map.md" });
    expect(resource.contents?.[0]?.text).toContain("placeholder.not-implemented");
    await client.close();
  });

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

  it("reports package version and Codexa loop instructions during MCP initialization", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-mcp-server-info-"));
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
    const client = new Client({ name: "codexa-server-info-test", version: "0.1.0" });
    await client.connect(transport);
    try {
      expect(client.getServerVersion()).toMatchObject({ name: "codexa", version: CODEXA_VERSION });
      expect(client.getInstructions()).toContain(PRIMARY_CODEX_LOOP);
      expect(client.getInstructions()).toContain("post_edit_review");
      expect(client.getInstructions()).toContain("must not mutate source files");
    } finally {
      await client.close();
    }
  });

  it("serves Codexa tools over explicit Streamable HTTP transport", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-mcp-http-"));
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    await mkdir(path.join(repo, "src"), { recursive: true });
    await writeFile(path.join(repo, "src/index.ts"), "export function httpMarker() { return 1 }\n", "utf8");
    execFileSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["-c", "user.name=Codexa", "-c", "user.email=codexa@example.invalid", "commit", "-m", "fixture"], {
      cwd: repo,
      stdio: "ignore"
    });
    await buildIndex({ repoRoot: repo });

    const child = spawn(process.execPath, [path.join(process.cwd(), "dist/cli.js"), "serve", repo, "--transport", "http", "--port", "0", "--no-auto-refresh"], {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"]
    });
    try {
      const ready = await waitForStderr(child, /http:\/\/127\.0\.0\.1:(\d+)\/mcp/u);
      const url = /http:\/\/127\.0\.0\.1:(\d+)\/mcp/u.exec(ready)?.[0];
      expect(url).toBeTruthy();
      const rejected = await fetch(url!, {
        method: "POST",
        headers: {
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
          origin: "https://evil.example"
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: "origin-test", method: "initialize", params: {} })
      });
      expect(rejected.status).toBe(403);
      expect(await rejected.text()).toContain("Origin");
      const rejectedNonWebOrigin = await fetch(url!, {
        method: "POST",
        headers: {
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
          origin: "file://localhost"
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: "origin-scheme-test", method: "initialize", params: {} })
      });
      expect(rejectedNonWebOrigin.status).toBe(403);
      expect(await rejectedNonWebOrigin.text()).toContain("Origin");
      const transport = new StreamableHTTPClientTransport(new URL(url!));
      const client = new Client({ name: "codexa-http-test", version: "0.1.0" });
      await client.connect(transport);
      try {
        expect(client.getServerVersion()).toMatchObject({ name: "codexa", version: CODEXA_VERSION });
        expect(client.getInstructions()).toContain(PRIMARY_CODEX_LOOP);
        const tools = await client.listTools();
        expect(tools.tools.map((tool) => tool.name)).toContain("search");
        const result = await client.callTool({ name: "search", arguments: { query: "httpMarker", limit: 3 } });
        expect(JSON.stringify(result)).toContain("httpMarker");
      } finally {
        await client.close();
      }
    } finally {
      await stopChild(child);
    }
  });

  it("refuses Streamable HTTP binds on non-loopback hosts without auth", async () => {
    const child = spawn(process.execPath, [path.join(process.cwd(), "dist/cli.js"), "serve", process.cwd(), "--transport", "http", "--host", "0.0.0.0", "--port", "0", "--no-auto-refresh"], {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"]
    });
    const result = await waitForExit(child);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("requires a loopback host");
  });

  it("can disable MCP session-memory auto-recording for a strict read-only launch", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-mcp-memory-off-"));
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
      args: [path.join(process.cwd(), "dist/cli.js"), "serve", repo, "--no-auto-refresh", "--session-memory", "off"],
      stderr: "pipe"
    });
    const client = new Client({ name: "codexa-test", version: "0.1.0" });
    await client.connect(transport);
    try {
      const tools = await client.listTools();
      expect(tools.tools.find((tool) => tool.name === "task_brief")?.annotations?.readOnlyHint).toBe(true);
      expect(tools.tools.find((tool) => tool.name === "task_brief")?.annotations?.idempotentHint).toBe(true);
      await client.callTool({ name: "task_brief", arguments: { task: "inspect main", tokenBudget: 900, limit: 5 } });
      await expect(readdir(path.join(repo, ".codex/cache/codexa-session-memory"))).rejects.toThrow();
    } finally {
      await client.close();
    }
  });

  it("does not claim session-memory writes when only auto-refresh cache writes are possible", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-mcp-memory-off-refresh-"));
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
      args: [path.join(process.cwd(), "dist/cli.js"), "serve", repo, "--session-memory", "off"],
      stderr: "pipe"
    });
    const client = new Client({ name: "codexa-test", version: "0.1.0" });
    await client.connect(transport);
    try {
      const result = await client.callTool({ name: "task_brief", arguments: { task: "inspect main", tokenBudget: 900, limit: 5 } });
      const policy = (result.structuredContent as { toolPolicy?: { readOnly?: boolean; writeEffects?: string } }).toolPolicy;
      expect(policy).toMatchObject({
        readOnly: false,
        writeEffects: "index-cache-if-auto-refresh"
      });
      expect(policy?.writeEffects).not.toContain("session-memory-auto");
      await expect(readdir(path.join(repo, ".codex/cache/codexa-session-memory"))).rejects.toThrow();
    } finally {
      await client.close();
    }
  });

  it("reports session_memory auto-refresh cache effects when auto-refresh is enabled", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-mcp-session-memory-refresh-"));
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
      args: [path.join(process.cwd(), "dist/cli.js"), "serve", repo],
      stderr: "pipe"
    });
    const client = new Client({ name: "codexa-test", version: "0.1.0" });
    await client.connect(transport);
    try {
      const result = await client.callTool({ name: "session_memory", arguments: { action: "summary", limit: 3 } });
      expect((result.structuredContent as { toolPolicy?: { readOnly?: boolean; writeEffects?: string } }).toolPolicy).toMatchObject({
        readOnly: false,
        writeEffects: "index-cache-if-auto-refresh"
      });
      const remembered = await client.callTool({
        name: "session_memory",
        arguments: {
          action: "remember",
          entries: [
            {
              kind: "decision",
              summary: "Record a policy write for the MCP policy regression.",
              provenance: "agent-asserted",
              confidence: "heuristic",
              evidenceTier: "derived"
            }
          ]
        }
      });
      expect((remembered.structuredContent as { toolPolicy?: { writeEffects?: string } }).toolPolicy?.writeEffects).toBe("explicit-memory-cache+index-cache-if-auto-refresh");
    } finally {
      await client.close();
    }
  });

  it("marks semantic OpenAI-capable MCP tools as open-world, including post_edit_review", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-mcp-semantic-openworld-"));
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
      args: [path.join(process.cwd(), "dist/cli.js"), "serve", repo, "--no-auto-refresh", "--semantic", "--semantic-provider", "openai"],
      stderr: "pipe"
    });
    const client = new Client({ name: "codexa-test", version: "0.1.0" });
    await client.connect(transport);
    const tools = await client.listTools();
    expect(tools.tools.find((tool) => tool.name === "search")?.annotations?.openWorldHint).toBe(true);
    expect(tools.tools.find((tool) => tool.name === "change_plan")?.annotations?.openWorldHint).toBe(true);
    expect(tools.tools.find((tool) => tool.name === "post_edit_review")?.annotations?.openWorldHint).toBe(true);
    const postEditSchema = JSON.stringify(tools.tools.find((tool) => tool.name === "post_edit_review")?.inputSchema);
    expect(postEditSchema).toContain("semanticProvider");
    await client.close();
  });

  it("surfaces missing advertised artifacts as resource errors", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-mcp-missing-artifact-"));
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    await mkdir(path.join(repo, "src"), { recursive: true });
    await writeFile(path.join(repo, "src/index.ts"), "export function main() { return 1 }\n", "utf8");
    execFileSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["-c", "user.name=Codexa", "-c", "user.email=codexa@example.invalid", "commit", "-m", "fixture"], {
      cwd: repo,
      stdio: "ignore"
    });
    await buildIndex({ repoRoot: repo });
    await rm(path.join(repo, ".codex/codebase/repo-map.md"));

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(process.cwd(), "dist/cli.js"), "serve", repo, "--no-auto-refresh"],
      stderr: "pipe"
    });
    const client = new Client({ name: "codexa-test", version: "0.1.0" });
    await client.connect(transport);
    await expect(client.readResource({ uri: "codexa://repo/codebase/repo-map.md" })).rejects.toThrow(/Codexa artifact missing/);
    await client.close();
  });

  it("rejects malformed structured waiver JSON with a friendly CLI error", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-cli-waiver-"));
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    const cli = path.join(process.cwd(), "dist/cli.js");
    expect(() =>
      execFileSync(process.execPath, [cli, "post-edit-review", repo, "--waiver", "{bad json"], {
        cwd: repo,
        encoding: "utf8",
        stdio: "pipe"
      })
    ).toThrow(/Invalid waiver JSON/);
    expect(() =>
      execFileSync(process.execPath, [cli, "post-edit-review", repo, "--ran-command-report", "{bad json"], {
        cwd: repo,
        encoding: "utf8",
        stdio: "pipe"
      })
    ).toThrow(/Invalid command report JSON/);
    expect(() =>
      execFileSync(
        process.execPath,
        [cli, "post-edit-review", repo, "--ran-command-report", JSON.stringify({ command: "npm test", cwd: repo, exitCode: 0, args: Array.from({ length: 81 }, (_, index) => String(index)) })],
        {
          cwd: repo,
          encoding: "utf8",
          stdio: "pipe"
        }
      )
    ).toThrow(/args exceeds 80 entries/);
    expect(() =>
      execFileSync(
        process.execPath,
        [cli, "post-edit-review", repo, "--ran-command-report", JSON.stringify({ command: "npm test", cwd: repo, exitCode: 0, stdoutSummary: "x".repeat(1001) })],
        {
          cwd: repo,
          encoding: "utf8",
          stdio: "pipe"
        }
      )
    ).toThrow(/stdoutSummary exceeds 1000 characters/);
  });

  it("discovers module and playbook resources after auto-refresh without restarting", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-mcp-dynamic-resources-"));
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    await mkdir(path.join(repo, "src"), { recursive: true });
    await writeFile(path.join(repo, "src/index.ts"), "export function main() { return 1 }\n", "utf8");
    execFileSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["-c", "user.name=Codexa", "-c", "user.email=codexa@example.invalid", "commit", "-m", "fixture"], {
      cwd: repo,
      stdio: "ignore"
    });

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(process.cwd(), "dist/cli.js"), "serve", repo],
      stderr: "pipe"
    });
    const client = new Client({ name: "codexa-test", version: "0.1.0" });
    await client.connect(transport);
    await client.callTool({ name: "repo_map", arguments: { limit: 3 } });
    const resources = await client.listResources();
    const moduleUri = resources.resources.map((resource) => resource.uri).find((uri) => uri.startsWith("codexa://repo/codebase/modules/"));
    const playbookUri = resources.resources.map((resource) => resource.uri).find((uri) => uri.startsWith("codexa://repo/codebase/playbooks/") && !uri.endsWith("/README.md"));
    expect(moduleUri).toBeTruthy();
    expect(playbookUri).toBeTruthy();
    expect((await client.readResource({ uri: moduleUri! })).contents?.[0]?.text).toContain("# Module:");
    expect((await client.readResource({ uri: playbookUri! })).contents?.[0]?.text).toContain("Playbook");
    await client.close();
  });

  it("returns a bounded missing-index packet instead of a tool error when auto-refresh is disabled", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-mcp-missing-index-"));
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    await mkdir(path.join(repo, "src"), { recursive: true });
    await writeFile(path.join(repo, "src/index.ts"), "export function main() { return 1 }\n", "utf8");
    execFileSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["-c", "user.name=Codexa", "-c", "user.email=codexa@example.invalid", "commit", "-m", "fixture"], {
      cwd: repo,
      stdio: "ignore"
    });

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(process.cwd(), "dist/cli.js"), "serve", repo, "--no-auto-refresh"],
      stderr: "pipe"
    });
    const client = new Client({ name: "codexa-test", version: "0.1.0" });
    await client.connect(transport);
    const result = await client.callTool({ name: "focus_brief", arguments: { task: "start work", limit: 4 } });
    expect(JSON.stringify(result)).toContain("Codexa index missing");
    expect(JSON.stringify(result)).toContain("missingIndex");
    await client.close();
  });

  it("keeps concurrent MCP tool calls bounded and JSON-RPC clean", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-mcp-concurrent-"));
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    await mkdir(path.join(repo, "src"), { recursive: true });
    await writeFile(path.join(repo, "src/index.ts"), "export function concurrentMarker() { return 1 }\n", "utf8");
    execFileSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["-c", "user.name=Codexa", "-c", "user.email=codexa@example.invalid", "commit", "-m", "fixture"], {
      cwd: repo,
      stdio: "ignore"
    });
    await buildIndex({ repoRoot: repo });

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(process.cwd(), "dist/cli.js"), "serve", repo],
      stderr: "pipe"
    });
    const stderrChunks: Buffer[] = [];
    transport.stderr?.on("data", (chunk) => stderrChunks.push(Buffer.from(chunk)));
    const client = new Client({ name: "codexa-test", version: "0.1.0" });
    await client.connect(transport);

    const [repoMap, search, contextPack, taskBrief, freshness] = await Promise.all([
      client.callTool({ name: "repo_map", arguments: { limit: 3 } }),
      client.callTool({ name: "search", arguments: { query: "concurrentMarker", limit: 3 } }),
      client.callTool({ name: "context_pack", arguments: { query: "concurrentMarker", tokenBudget: 900, limit: 4 } }),
      client.callTool({ name: "task_brief", arguments: { task: "change concurrent marker", files: ["src/index.ts"], tokenBudget: 900, limit: 4 } }),
      client.callTool({ name: "freshness", arguments: {} })
    ]);

    for (const result of [repoMap, search, contextPack, taskBrief]) {
      expect(JSON.stringify(result)).toContain("runtime");
      expect(JSON.stringify(result)).toContain("commandBudgetMs");
      expect(JSON.stringify(result)).toContain("provenance");
    }
    expect(JSON.stringify(freshness)).toContain("fresh");
    expect(Buffer.concat(stderrChunks).toString("utf8")).toContain("codexa MCP server ready");
    await client.close();
  });
});
