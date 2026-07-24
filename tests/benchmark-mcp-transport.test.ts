import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { createIndexedMcpRepo } from "./mcp-fixtures.js";

describe("reproducible MCP transport comparison", () => {
  it("runs hot-path MCP metrics against the explicit full profile and successful tool results", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "codexa-hot-path-benchmark-"));
    const repo = await createIndexedMcpRepo(workspace, "repo", "alpha", "alphaSymbol");
    await writeFile(path.join(repo, ".git", "info", "exclude"), ".codex/\n", "utf8");
    await mkdir(path.join(repo, "dist"), { recursive: true });
    await symlink(path.join(process.cwd(), "dist/cli.js"), path.join(repo, "dist/cli.js"));
    const output = path.join(workspace, "hot-path.json");
    execFileSync(
      process.execPath,
      [
        path.join(process.cwd(), "scripts/benchmark-hot-paths.mjs"),
        "--repo", repo,
        "--runs", "1",
        "--warmups", "1",
        "--warn-only",
        "--output", output
      ],
      { cwd: process.cwd(), encoding: "utf8", timeout: 60_000, maxBuffer: 4 * 1024 * 1024 }
    );
    const report = JSON.parse(await readFile(output, "utf8")) as {
      thresholdScale: number;
      mcp: { toolProfile: string; requiredDirectTools: string[]; directToolNames: string[] };
      metrics: Array<{ name: string; targetMs: number; thresholdMs: number }>;
    };
    expect(report.thresholdScale).toBe(1);
    expect(report.mcp.toolProfile).toBe("full");
    expect(report.mcp.requiredDirectTools).toEqual(["freshness", "repo_map", "task_brief"]);
    expect(report.mcp.requiredDirectTools.every((tool) => report.mcp.directToolNames.includes(tool))).toBe(true);
    expect(report.metrics.filter((metric) => metric.name.startsWith("mcp.")).map((metric) => metric.name)).toEqual([
      "mcp.startup",
      "mcp.freshness",
      "mcp.repo_map",
      "mcp.task_brief_explicit_file"
    ]);
    expect(report.metrics.every((metric) => metric.targetMs === metric.thresholdMs)).toBe(true);
  }, 60_000);

  it("compares full and core exposure without making an agent-quality claim", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "codexa-transport-benchmark-"));
    const repo = await createIndexedMcpRepo(workspace, "repo", "alpha", "alphaSymbol");
    await writeFile(path.join(repo, ".git", "info", "exclude"), ".codex/\n", "utf8");
    const stdout = execFileSync(
      process.execPath,
      [
        path.join(process.cwd(), "scripts/benchmark-mcp-transport.mjs"),
        "--repo", repo,
        "--baseline-cli", path.join(process.cwd(), "dist/cli.js"),
        "--candidate-cli", path.join(process.cwd(), "dist/cli.js"),
        "--baseline-tools", "full",
        "--candidate-tools", "core",
        "--task", "Inspect the explicit alpha target",
        "--file", "src/alpha.ts",
        "--calls", "3"
      ],
      { cwd: process.cwd(), encoding: "utf8", timeout: 60_000, maxBuffer: 4 * 1024 * 1024 }
    );
    const report = JSON.parse(stdout) as {
      schemaVersion: number;
      passed: boolean;
      measurement: { unit: string };
      baseline: { directToolCount: number; directToolNames: string[]; advertisedLogicalOperationNames: string[]; serverInstructionsDecodedPayloadBytes: number; logicalInvocationRoutes: { freshness: string; task_brief: string } };
      candidate: { directToolCount: number; directToolNames: string[]; advertisedLogicalOperationNames: string[]; serverInstructionsDecodedPayloadBytes: number; logicalInvocationRoutes: { freshness: string; task_brief: string }; receiptFlags: boolean[]; detailedResourceReadable: boolean };
      comparison: {
        advertisedLogicalOperationNameParity: boolean;
        baselineLogicalOperationsRetained: boolean;
        missingCandidateLogicalOperationNames: string[];
        addedCandidateLogicalOperationNames: string[];
        baselineAdvertisementAndDiscoveryDecodedPayloadBytes: number;
        candidateAdvertisementAndDiscoveryDecodedPayloadBytes: number;
        baselineStartupAdvertisementAndDiscoveryDecodedPayloadBytes: number;
        candidateStartupAdvertisementAndDiscoveryDecodedPayloadBytes: number;
        toolsListDecodedPayloadReductionPercent: number;
      };
      checks: { advertisedLogicalOperationCompatibility: boolean; advertisementAndDiscoveryPayloadReduction: boolean; startupAdvertisementAndDiscoveryPayloadReduction: boolean; currentFullProfileExact: boolean; candidateCoreProfileExact: boolean; candidateLogicalCatalogComplete: boolean; candidateDispatcherRoutes: boolean; baselineServerMatchesExecutable: boolean; candidateServerMatchesExecutable: boolean };
      claimBoundary: string;
    };
    expect(report.schemaVersion).toBe(4);
    expect(report.passed).toBe(true);
    expect(report.baseline.directToolCount).toBe(23);
    expect(report.candidate.directToolCount).toBe(3);
    expect(report.candidate.directToolNames).toEqual(["capabilities", "change_plan", "search"]);
    expect(report.baseline.logicalInvocationRoutes).toEqual({ freshness: "direct", task_brief: "direct" });
    expect(report.candidate.logicalInvocationRoutes).toEqual({ freshness: "capabilities", task_brief: "capabilities" });
    expect(report.candidate.advertisedLogicalOperationNames).toHaveLength(22);
    expect(report.candidate.advertisedLogicalOperationNames).toEqual(report.baseline.advertisedLogicalOperationNames);
    expect(report.comparison).toMatchObject({
      advertisedLogicalOperationNameParity: true,
      baselineLogicalOperationsRetained: true,
      missingCandidateLogicalOperationNames: [],
      addedCandidateLogicalOperationNames: []
    });
    expect(report.comparison.toolsListDecodedPayloadReductionPercent).toBeGreaterThan(0);
    expect(report.comparison.candidateAdvertisementAndDiscoveryDecodedPayloadBytes).toBeLessThan(report.comparison.baselineAdvertisementAndDiscoveryDecodedPayloadBytes);
    expect(report.comparison.candidateStartupAdvertisementAndDiscoveryDecodedPayloadBytes).toBeLessThan(report.comparison.baselineStartupAdvertisementAndDiscoveryDecodedPayloadBytes);
    expect(report.baseline.serverInstructionsDecodedPayloadBytes).toBeGreaterThan(0);
    expect(report.candidate.serverInstructionsDecodedPayloadBytes).toBeGreaterThan(0);
    expect(report.checks).toMatchObject({
      advertisedLogicalOperationCompatibility: true,
      advertisementAndDiscoveryPayloadReduction: true,
      startupAdvertisementAndDiscoveryPayloadReduction: true,
      currentFullProfileExact: true,
      candidateCoreProfileExact: true,
      candidateLogicalCatalogComplete: true,
      candidateDispatcherRoutes: true,
      baselineServerMatchesExecutable: true,
      candidateServerMatchesExecutable: true
    });
    expect(report.candidate).toMatchObject({ receiptFlags: [false, true, true], detailedResourceReadable: true });
    expect(report.measurement.unit).toContain("decoded-mcp-application-payload");
    expect(report.claimBoundary).toContain("does not measure agent quality");
  }, 90_000);

  it.skipIf(process.env.CODEXA_RUN_V012_TRANSPORT_COMPAT !== "1")("materializes the pinned v0.12.0 baseline across root lockfile metadata changes", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "codexa-transport-release-benchmark-"));
    const repo = await createIndexedMcpRepo(workspace, "repo", "alpha", "alphaSymbol");
    await writeFile(path.join(repo, ".git", "info", "exclude"), ".codex/\n", "utf8");
    const stdout = execFileSync(process.execPath, [
      path.join(process.cwd(), "scripts/benchmark-mcp-transport.mjs"),
      "--repo", repo,
      "--release-baseline", "v0.12.0",
      "--candidate-cli", path.join(process.cwd(), "dist/cli.js"),
      "--candidate-tools", "core",
      "--task", "Inspect the explicit alpha target",
      "--file", "src/alpha.ts",
      "--calls", "2"
    ], { cwd: process.cwd(), encoding: "utf8", timeout: 90_000, maxBuffer: 4 * 1024 * 1024 });
    const report = JSON.parse(stdout) as {
      schemaVersion: number;
      passed: boolean;
      comparisonMode: string;
      input: { baseline: { release: { sourceCommit: string; artifactKind: string; dependencyMaterialization: string }; executable: { version: string; sourceCommit: string; cliSha256: string; distTreeSha256: string } } };
      baseline: { serverIdentity: { name: string; version: string } };
      comparison: { advertisedLogicalOperationNameParity: boolean; baselineLogicalOperationsRetained: boolean; missingCandidateLogicalOperationNames: string[]; addedCandidateLogicalOperationNames: string[] };
      checks: { advertisedLogicalOperationCompatibility: boolean; pinnedBaselineServerIdentity: boolean };
    };
    expect(report).toMatchObject({ schemaVersion: 4, passed: true, comparisonMode: "pinned-release-versus-candidate" });
    expect(report.input.baseline.release).toMatchObject({
      sourceCommit: "68061b022cfc9f4dcc1aaf3d7776710196cc69b0",
      dependencyMaterialization: "npm-ci-pinned-lock-ignore-scripts",
      artifactKind: "locally-built-tagged-source"
    });
    expect(report.input.baseline.executable).toMatchObject({
      version: "0.12.0",
      sourceCommit: "68061b022cfc9f4dcc1aaf3d7776710196cc69b0",
      cliSha256: "ea90fb40a0cf2b9825707f511ba8013644e8a0492349f58741f7ded47f110e0d"
    });
    expect(report.input.baseline.executable.distTreeSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(report.baseline.serverIdentity).toEqual({ name: "codexa", version: "0.12.0" });
    expect(report.comparison).toMatchObject({
      advertisedLogicalOperationNameParity: false,
      baselineLogicalOperationsRetained: true,
      missingCandidateLogicalOperationNames: []
    });
    expect(report.comparison.addedCandidateLogicalOperationNames).toContain("change_review");
    expect(report.checks.advertisedLogicalOperationCompatibility).toBe(true);
    expect(report.checks.pinnedBaselineServerIdentity).toBe(true);
  }, 120_000);
});
