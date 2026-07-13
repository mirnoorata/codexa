import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { mkdtemp, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { createIndexedMcpRepo } from "./mcp-fixtures.js";

describe("reproducible MCP transport comparison", () => {
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
      passed: boolean;
      measurement: { unit: string };
      baseline: { directToolCount: number; advertisedLogicalOperationNames: string[] };
      candidate: { directToolCount: number; advertisedLogicalOperationNames: string[]; receiptFlags: boolean[]; detailedResourceReadable: boolean };
      comparison: {
        advertisedLogicalOperationNameParity: boolean;
        baselineAdvertisementAndDiscoveryDecodedPayloadBytes: number;
        candidateAdvertisementAndDiscoveryDecodedPayloadBytes: number;
        toolsListDecodedPayloadReductionPercent: number;
      };
      checks: { advertisementAndDiscoveryPayloadReduction: boolean; baselineServerMatchesExecutable: boolean; candidateServerMatchesExecutable: boolean };
      claimBoundary: string;
    };
    expect(report.passed).toBe(true);
    expect(report.candidate.directToolCount).toBeLessThan(report.baseline.directToolCount);
    expect(report.candidate.advertisedLogicalOperationNames).toEqual(report.baseline.advertisedLogicalOperationNames);
    expect(report.comparison).toMatchObject({ advertisedLogicalOperationNameParity: true });
    expect(report.comparison.toolsListDecodedPayloadReductionPercent).toBeGreaterThan(0);
    expect(report.comparison.candidateAdvertisementAndDiscoveryDecodedPayloadBytes).toBeLessThan(report.comparison.baselineAdvertisementAndDiscoveryDecodedPayloadBytes);
    expect(report.checks).toMatchObject({
      advertisementAndDiscoveryPayloadReduction: true,
      baselineServerMatchesExecutable: true,
      candidateServerMatchesExecutable: true
    });
    expect(report.candidate).toMatchObject({ receiptFlags: [false, true, true], detailedResourceReadable: true });
    expect(report.measurement.unit).toContain("decoded-mcp-application-payload");
    expect(report.claimBoundary).toContain("does not measure agent quality");
  }, 90_000);

  it.skipIf(process.env.CODEXA_RUN_V012_TRANSPORT_COMPAT !== "1")("materializes and identifies the pinned v0.12.0 baseline entirely from local history", async () => {
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
      passed: boolean;
      comparisonMode: string;
      input: { baseline: { release: { sourceCommit: string; artifactKind: string }; executable: { version: string; sourceCommit: string; cliSha256: string; distTreeSha256: string } } };
      baseline: { serverIdentity: { name: string; version: string } };
      checks: { pinnedBaselineServerIdentity: boolean };
    };
    expect(report).toMatchObject({ passed: true, comparisonMode: "pinned-release-versus-candidate" });
    expect(report.input.baseline.release).toMatchObject({
      sourceCommit: "68061b022cfc9f4dcc1aaf3d7776710196cc69b0",
      artifactKind: "locally-built-tagged-source"
    });
    expect(report.input.baseline.executable).toMatchObject({
      version: "0.12.0",
      sourceCommit: "68061b022cfc9f4dcc1aaf3d7776710196cc69b0",
      cliSha256: "ea90fb40a0cf2b9825707f511ba8013644e8a0492349f58741f7ded47f110e0d"
    });
    expect(report.input.baseline.executable.distTreeSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(report.baseline.serverIdentity).toEqual({ name: "codexa", version: "0.12.0" });
    expect(report.checks.pinnedBaselineServerIdentity).toBe(true);
  }, 120_000);
});
