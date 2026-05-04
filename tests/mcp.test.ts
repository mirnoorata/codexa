import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { describe, expect, it } from "vitest";
import { buildIndex } from "../src/indexer.js";
import { compactNonPostEditMcpResult, compactPostEditMcpResult } from "../src/mcp.js";
import { CURRENT_VERIFICATION_PROVENANCE } from "../src/types.js";

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

function buildContextPacket(mode?: "focus_brief" | "task_brief") {
  return {
    ...(mode ? { mode } : {}),
    task: "refactor packet",
    changeType: "behavior",
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
    gaps: seq(35, (index) => `gap-${index}`)
  };
}

function buildChangePlanPacket() {
  return {
    mode: "change_plan",
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

      await writeFile(focusFile, `## Session\n\n- Focused project: \`${repoB}\`.\n`, "utf8");

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
    expect(contextTool?.annotations?.destructiveHint).toBe(false);
    expect(contextTool?.annotations?.openWorldHint).toBe(false);
    expect(contextTool?.annotations?.readOnlyHint).toBe(false);
    expect(contextTool?.annotations?.idempotentHint).toBe(false);
    const searchSchema = JSON.stringify(tools.tools.find((tool) => tool.name === "search")?.inputSchema);
    expect(searchSchema).toContain("patterns");
    expect(searchSchema).toContain("maxItems");
    expect(searchSchema).toContain("7");
    expect(tools.tools.find((tool) => tool.name === "impact")?.annotations?.readOnlyHint).toBe(false);
    expect(tools.tools.find((tool) => tool.name === "freshness")?.annotations?.readOnlyHint).toBe(true);

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
        verificationCommands?: string[];
        verificationCoverage?: Array<{ kind: string }>;
        verificationCommandPlan?: Array<{ command: string; covers: string[] }>;
      };
    };
    expect(contextPackData.data?.verificationCommands?.length).toBeGreaterThan(0);
    expect(contextPackData.data?.verificationCoverage?.length).toBeGreaterThan(0);
    expect(contextPackData.data?.verificationCommandPlan?.length).toBeGreaterThan(0);

    const taskBrief = await client.callTool({ name: "task_brief", arguments: { files: ["src/index.ts"], task: "change behavior", tokenBudget: 900, limit: 5 } });
    expect(JSON.stringify(taskBrief)).toContain("Codexa task brief");
    expect(JSON.stringify(taskBrief)).toContain("mode");
    const taskBriefData = taskBrief.structuredContent as {
      data?: {
        verificationCommands?: string[];
        verificationCoverage?: Array<{ kind: string }>;
        verificationCommandPlan?: Array<{ command: string; covers: string[] }>;
      };
    };
    expect(taskBriefData.data?.verificationCommands?.length).toBeGreaterThan(0);
    expect(taskBriefData.data?.verificationCoverage?.length).toBeGreaterThan(0);
    expect(taskBriefData.data?.verificationCommandPlan?.length).toBeGreaterThan(0);

    const focusBrief = await client.callTool({ name: "focus_brief", arguments: { task: "understand the main workflow", tokenBudget: 900, limit: 5 } });
    expect(JSON.stringify(focusBrief)).toContain("Codexa focus brief");

    const callers = await client.callTool({ name: "callers", arguments: { symbol: "changedSymbol", limit: 5 } });
    expect(JSON.stringify(callers)).toContain("Callers/importers");

    const changePlan = await client.callTool({
      name: "change_plan",
      arguments: { task: "change changedSymbol safely", symbols: ["changedSymbol"], tokenBudget: 1000, limit: 5, saveSnapshot: true, taskId: "mcp-changed-symbol" }
    });
    expect(JSON.stringify(changePlan)).toContain("Codexa change plan");
    expect(JSON.stringify(changePlan)).toContain("Task snapshot: mcp-changed-symbol");

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
    const postEditData = (postEdit.structuredContent as { data: unknown }).data as {
      ranCommands?: string[];
      ranCommandReports?: Array<{ command: string; exitCode?: number; durationMs?: number }>;
      commandEnvelopes?: Array<{ command: string; cwd?: string; packageManager?: string; packageRoot?: string; scriptName?: string; source?: string; scopeStatus?: string; args: string[] }>;
      verificationProvenance?: typeof CURRENT_VERIFICATION_PROVENANCE;
      mcp?: { verificationProvenance?: typeof CURRENT_VERIFICATION_PROVENANCE };
      verificationLedger?: Array<{ status: string; evidence: string[] }>;
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
      focusFiles?: unknown[];
      truncation?: Record<string, { total: number; returned: number }>;
      mcp: { mode: string; returnedBytes: number; targetBytes: number };
    };
    expect(taskData.mode).toBe("task_brief");
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
      verificationCommands: unknown[];
      verificationCoverage: unknown[];
      verificationCommandPlan: unknown[];
      verificationLedgerPreview: unknown[];
      gaps: unknown[];
      truncation?: Record<string, { total: number; returned: number }>;
      mcp: { mode: string; returnedBytes: number; targetBytes: number };
    };
    expect(testPlanData.mcp.mode).toBe("test_plan");
    expect(testPlanData.mcp.returnedBytes).toBe(serializedBytes(testPlanData));
    expect(testPlanData.mcp.returnedBytes).toBeLessThanOrEqual(testPlanData.mcp.targetBytes);
    expect(testPlanData.changedFiles.length).toBeGreaterThan(0);
    expect(testPlanData.tests.length).toBeGreaterThan(0);
    expect(testPlanData.verificationCommands.length).toBeGreaterThan(0);
    expect(testPlanData.verificationCoverage.length).toBeGreaterThan(0);
    expect(testPlanData.verificationCommandPlan.length).toBeGreaterThan(0);
    expect(testPlanData.verificationLedgerPreview.length).toBeGreaterThan(0);
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
      files?: unknown[];
      plannedEditTargets?: unknown[];
      tests?: unknown[];
      snapshot?: { taskId?: string; plannedEditTargets?: unknown[]; plannedFiles?: unknown[]; plannedTests?: unknown[]; requiredWorkflowCheckCount?: number; requiredDependencyCheckCount?: number };
      truncation?: Record<string, { total: number; returned: number }>;
      mcp: { mode: string; returnedBytes: number; targetBytes: number; hardBudgetEnforced?: boolean; budgetCompaction?: string };
    };
    expect(data.mode).toBe("change_plan");
    expect(data.mcp.mode).toBe("change_plan");
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

  it("marks context tools as strictly read-only when auto-refresh is disabled", async () => {
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
    expect(tools.tools.find((tool) => tool.name === "task_brief")?.annotations?.readOnlyHint).toBe(true);
    expect(tools.tools.find((tool) => tool.name === "task_brief")?.annotations?.idempotentHint).toBe(true);
    expect(tools.tools.find((tool) => tool.name === "context_pack")?.annotations?.readOnlyHint).toBe(true);
    expect(tools.tools.find((tool) => tool.name === "context_pack")?.annotations?.idempotentHint).toBe(true);
    expect(tools.tools.find((tool) => tool.name === "impact")?.annotations?.readOnlyHint).toBe(true);
    expect(tools.tools.find((tool) => tool.name === "focus_brief")?.annotations?.readOnlyHint).toBe(true);
    expect(tools.tools.find((tool) => tool.name === "callers")?.annotations?.readOnlyHint).toBe(true);
    expect(tools.tools.find((tool) => tool.name === "post_edit_review")?.annotations?.readOnlyHint).toBe(true);
    await client.close();
  });

  it("marks semantic OpenAI-capable MCP tools as open-world, including change_plan", async () => {
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
