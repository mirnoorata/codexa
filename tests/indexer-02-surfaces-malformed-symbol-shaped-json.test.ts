import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { getGitState } from "../src/git.js";
import { buildIndex, buildIndexLocked, getFreshness, loadIndex } from "../src/indexer.js";
import { MAX_INDEXED_SOURCE_BYTES } from "../src/repo-files.js";
import { validateChangePlanTargetCandidate } from "../src/query/change-plan.js";
import { postEditDecision } from "../src/query/post-edit/decision.js";
import { postEditReviewWithTrustedRunnerReports } from "../src/query/post-edit.js";
import { loadExternalRiskSignals, MAX_RISK_REPORT_BYTES } from "../src/risk-ingest.js";
import { recordSessionMemory } from "../src/session-memory.js";
import { updateStaticAnalysisReports } from "../src/static-analysis.js";
import { CURRENT_VERIFICATION_PROVENANCE } from "../src/types.js";
import type { AutoVerifyCommandReport } from "../src/autoverify.js";
import {
  callersQuery,
  calleesQuery,
  changePlanQuery,
  contextPackQuery,
  dependencyPathQuery,
  diffImpactQuery,
  fileContextQuery,
  focusBriefQuery,
  impactQuery,
  placeholderReportQuery,
  postEditReviewQuery,
  repoMapQuery,
  searchQuery,
  statusQuery,
  taskBriefQuery,
  testPlanQuery,
  workflowPathQuery
} from "../src/queries.js";
import { createFixtureRepo, createDocFixtureRepo, createBroadWorkflowFixtureRepo, createVerificationCoverageFixtureRepo, createSemanticDefaultRepo, createManifestGateFixtureRepo, createDottedReferenceFixtureRepo, createManifestLocalityFixtureRepo, mkdirp } from "./indexer-fixtures.js";
describe("Codexa indexer", () => {
it("surfaces malformed symbol-shaped JSON even when it also contains risk fields", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-custom-symbol-malformed-with-risk-field-"));
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    await mkdirp(path.join(repo, "src"));
    await mkdirp(path.join(repo, ".codex/static-analysis"));
    await writeFile(path.join(repo, ".gitignore"), ".codex/\n", "utf8");
    await writeFile(path.join(repo, "src/app.ts"), "export function app() { return 1 }\n", "utf8");
    await writeFile(
      path.join(repo, ".codex/static-analysis/custom.json"),
      JSON.stringify({
        schemaVersion: 1,
        tool: "fixture-symbol-tool",
        language: "typescript",
        symbols: [{ name: "bad" }],
        risks: []
      }),
      "utf8"
    );
    execFileSync("git", ["add", ".gitignore", "src/app.ts"], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["-c", "user.name=Codexa", "-c", "user.email=codexa@example.invalid", "commit", "-m", "custom-symbol-malformed-with-risk-field"], {
      cwd: repo,
      stdio: "ignore"
    });

    const index = await buildIndex({ repoRoot: repo, writeArtifacts: true });
    expect(index.freshness.externalSymbolReportDiagnostics?.some((diagnostic) => diagnostic.path === ".codex/static-analysis/custom.json" && diagnostic.reason === "invalid-symbol-report")).toBe(true);
    expect(index.freshness.externalRiskReportHashes?.[".codex/static-analysis/custom.json"]).toBeUndefined();
  });

it("surfaces mixed symbol/risk JSON when symbol paths are invalid", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-custom-symbol-invalid-path-with-risk-field-"));
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    await mkdirp(path.join(repo, "src"));
    await mkdirp(path.join(repo, ".codex/static-analysis"));
    await writeFile(path.join(repo, ".gitignore"), ".codex/\n", "utf8");
    await writeFile(path.join(repo, "src/app.ts"), "export function app() { return 1 }\n", "utf8");
    await writeFile(
      path.join(repo, ".codex/static-analysis/custom.json"),
      JSON.stringify({
        schemaVersion: 1,
        tool: "fixture-symbol-tool",
        language: "typescript",
        symbols: [{ id: "missing", name: "missing", qualifiedName: "missing", kind: "function", path: "src/missing.ts", line: 1 }],
        risks: []
      }),
      "utf8"
    );
    execFileSync("git", ["add", ".gitignore", "src/app.ts"], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["-c", "user.name=Codexa", "-c", "user.email=codexa@example.invalid", "commit", "-m", "custom-symbol-invalid-path-with-risk-field"], {
      cwd: repo,
      stdio: "ignore"
    });

    const index = await buildIndex({ repoRoot: repo, writeArtifacts: true });
    expect(index.freshness.externalSymbolReportDiagnostics?.some((diagnostic) => diagnostic.path === ".codex/static-analysis/custom.json" && diagnostic.reason === "invalid-symbol-report")).toBe(true);
    expect(index.freshness.externalRiskReportHashes?.[".codex/static-analysis/custom.json"]).toBeUndefined();
  });

it("surfaces oversized mixed symbol/risk JSON as a symbol report diagnostic", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-mixed-symbol-risk-too-large-"));
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    await mkdirp(path.join(repo, "src"));
    await mkdirp(path.join(repo, ".codex/static-analysis"));
    await writeFile(path.join(repo, ".gitignore"), ".codex/\n", "utf8");
    await writeFile(path.join(repo, "src/app.ts"), "export function app() { return 1 }\n", "utf8");
    await writeFile(
      path.join(repo, ".codex/static-analysis/risks.json"),
      JSON.stringify({
        schemaVersion: 1,
        tool: "fixture-symbol-tool",
        language: "typescript",
        symbols: [{ id: "app", name: "app", qualifiedName: "app", kind: "function", path: "src/app.ts", line: 1 }],
        risks: [],
        padding: "x".repeat(2 * 1024 * 1024 + 1)
      }),
      "utf8"
    );
    execFileSync("git", ["add", ".gitignore", "src/app.ts"], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["-c", "user.name=Codexa", "-c", "user.email=codexa@example.invalid", "commit", "-m", "mixed-symbol-risk-too-large"], {
      cwd: repo,
      stdio: "ignore"
    });

    const index = await buildIndex({ repoRoot: repo, writeArtifacts: true });
    expect(index.freshness.externalSymbolReportDiagnostics?.some((diagnostic) => diagnostic.path === ".codex/static-analysis/risks.json" && diagnostic.reason === "report-too-large")).toBe(true);
    expect(index.freshness.externalRiskReportHashes?.[".codex/static-analysis/risks.json"]).toBeUndefined();
  });

it("does not let generated symbol reports crowd out reports/static-analysis symbol reports", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-symbol-cross-dir-crowd-out-"));
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    await mkdirp(path.join(repo, "src"));
    await mkdirp(path.join(repo, ".codex/static-analysis"));
    await mkdirp(path.join(repo, "reports/static-analysis"));
    await writeFile(path.join(repo, ".gitignore"), ".codex/\nreports/static-analysis/\n", "utf8");
    await writeFile(path.join(repo, "src/app.ts"), "export function app() { return 1 }\n", "utf8");
    for (let index = 0; index < 500; index += 1) {
      await writeFile(
        path.join(repo, ".codex/static-analysis", `scip-ambient-${String(index).padStart(3, "0")}.symbols.json`),
        JSON.stringify({
          schemaVersion: 1,
          tool: "ambient-scip",
          language: "typescript",
          symbols: [{ id: `ambient-${index}`, name: `ambient${index}`, qualifiedName: `ambient${index}`, kind: "function", path: "src/app.ts", line: 1 }]
        }),
        "utf8"
      );
    }
    await writeFile(
      path.join(repo, "reports/static-analysis/symbol-report-manual.json"),
      JSON.stringify({
        schemaVersion: 1,
        tool: "manual-symbol-tool",
        language: "typescript",
        symbols: [{ id: "manual-external", name: "manualExternal", qualifiedName: "manualExternal", kind: "function", path: "src/app.ts", line: 2 }]
      }),
      "utf8"
    );
    execFileSync("git", ["add", ".gitignore", "src/app.ts"], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["-c", "user.name=Codexa", "-c", "user.email=codexa@example.invalid", "commit", "-m", "symbol-cross-dir-crowd-out"], {
      cwd: repo,
      stdio: "ignore"
    });

    const index = await buildIndex({ repoRoot: repo, writeArtifacts: true });
    expect(index.symbols.some((symbol) => symbol.qualifiedName === "manualExternal" && symbol.source === "static-analysis")).toBe(true);
    expect(index.freshness.externalSymbolReportHashes?.["reports/static-analysis/symbol-report-manual.json"]).toBeTruthy();
  });

it("does not let explicit symbol reports crowd out generated SCIP symbol reports before rank reservation", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-symbol-rank-reservation-"));
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    await mkdirp(path.join(repo, "src"));
    await mkdirp(path.join(repo, ".codex/static-analysis"));
    await writeFile(path.join(repo, ".gitignore"), ".codex/\n", "utf8");
    await writeFile(path.join(repo, "src/app.ts"), "export function app() { return 1 }\n", "utf8");
    for (let index = 0; index < 500; index += 1) {
      await writeFile(
        path.join(repo, ".codex/static-analysis", `symbol-report-${String(index).padStart(3, "0")}.json`),
        JSON.stringify({
          schemaVersion: 1,
          tool: "manual-symbol-tool",
          language: "typescript",
          symbols: [{ id: `manual-${index}`, name: `manual${index}`, qualifiedName: `manual${index}`, kind: "function", path: "src/app.ts", line: 1 }]
        }),
        "utf8"
      );
    }
    await writeFile(
      path.join(repo, ".codex/static-analysis/scip-index.symbols.json"),
      JSON.stringify({
        schemaVersion: 1,
        tool: "scip",
        language: "typescript",
        symbols: [{ id: "scip-symbol", name: "scipSymbol", qualifiedName: "scipSymbol", kind: "function", path: "src/app.ts", line: 2 }]
      }),
      "utf8"
    );
    execFileSync("git", ["add", ".gitignore", "src/app.ts"], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["-c", "user.name=Codexa", "-c", "user.email=codexa@example.invalid", "commit", "-m", "symbol-rank-reservation"], {
      cwd: repo,
      stdio: "ignore"
    });

    const index = await buildIndex({ repoRoot: repo, writeArtifacts: true });
    expect(index.symbols.some((symbol) => symbol.qualifiedName === "scipSymbol" && symbol.source === "static-analysis")).toBe(true);
    expect(index.freshness.externalSymbolReportHashes?.[".codex/static-analysis/scip-index.symbols.json"]).toBeTruthy();
  });

it("keeps custom Codexa symbol reports out of risk ingestion and risk freshness", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-symbol-risk-namespace-"));
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    await mkdirp(path.join(repo, "src"));
    await mkdirp(path.join(repo, ".codex/static-analysis"));
    await writeFile(path.join(repo, ".gitignore"), ".codex/\n", "utf8");
    await writeFile(path.join(repo, "src/app.ts"), "export function app() { return 1 }\n", "utf8");
    await writeFile(
      path.join(repo, ".codex/static-analysis/custom.json"),
      JSON.stringify({
        schemaVersion: 1,
        tool: "fixture-symbol-tool",
        language: "typescript",
        symbols: [{ id: "custom-symbol", name: "customSymbol", qualifiedName: "customSymbol", kind: "function", path: "src/app.ts", line: 1 }],
        risks: [{ path: "src/app.ts", signal: "symbol-report-extra-risk", reason: "must not import", score: 10 }]
      }),
      "utf8"
    );
    execFileSync("git", ["add", ".gitignore", "src/app.ts"], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["-c", "user.name=Codexa", "-c", "user.email=codexa@example.invalid", "commit", "-m", "symbol-risk-namespace"], {
      cwd: repo,
      stdio: "ignore"
    });

    const indexed = await buildIndex({ repoRoot: repo, writeArtifacts: true });
    expect(indexed.symbols.some((symbol) => symbol.qualifiedName === "customSymbol" && symbol.source === "static-analysis")).toBe(true);
    expect(indexed.risks.some((risk) => risk.signal === "symbol-report-extra-risk")).toBe(false);

    await writeFile(
      path.join(repo, ".codex/static-analysis/custom.json"),
      JSON.stringify({
        schemaVersion: 1,
        tool: "fixture-symbol-tool",
        language: "typescript",
        symbols: [{ id: "custom-symbol", name: "customSymbol2", qualifiedName: "customSymbol2", kind: "function", path: "src/app.ts", line: 1 }]
      }),
      "utf8"
    );
    const stale = await getFreshness(repo);
    expect(stale.stale).toBe(true);
    expect(stale.reason).toBe("external-symbol-reports-changed");
  });

it("reserves capacity for previously indexed custom symbol reports", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-custom-symbol-known-capacity-"));
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    await mkdirp(path.join(repo, "src"));
    await mkdirp(path.join(repo, ".codex/static-analysis"));
    await writeFile(path.join(repo, ".gitignore"), ".codex/\n", "utf8");
    await writeFile(path.join(repo, "src/app.ts"), "export function app() { return 1 }\n", "utf8");
    await writeFile(
      path.join(repo, ".codex/static-analysis/custom.json"),
      JSON.stringify({
        schemaVersion: 1,
        tool: "fixture-symbol-tool",
        language: "typescript",
        symbols: [{ id: "custom-symbol", name: "customSymbol", qualifiedName: "customSymbol", kind: "function", path: "src/app.ts", line: 2 }]
      }),
      "utf8"
    );
    execFileSync("git", ["add", ".gitignore", "src/app.ts"], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["-c", "user.name=Codexa", "-c", "user.email=codexa@example.invalid", "commit", "-m", "custom-symbol-known-capacity"], {
      cwd: repo,
      stdio: "ignore"
    });
    const firstIndex = await buildIndex({ repoRoot: repo, writeArtifacts: true });
    expect(firstIndex.freshness.externalSymbolReportHashes?.[".codex/static-analysis/custom.json"]).toBeTruthy();

    for (let index = 0; index < 50; index += 1) {
      await writeFile(
        path.join(repo, ".codex/static-analysis", `symbol-report-${String(index).padStart(2, "0")}.json`),
        JSON.stringify({
          schemaVersion: 1,
          tool: "manual-symbol-tool",
          language: "typescript",
          symbols: [{ id: `manual-${index}`, name: `manual${index}`, qualifiedName: `manual${index}`, kind: "function", path: "src/app.ts", line: 1 }]
        }),
        "utf8"
      );
    }

    const refreshed = await buildIndex({ repoRoot: repo, writeArtifacts: true });
    expect(refreshed.symbols.some((symbol) => symbol.qualifiedName === "customSymbol" && symbol.source === "static-analysis")).toBe(true);
    expect(refreshed.freshness.externalSymbolReportHashes?.[".codex/static-analysis/custom.json"]).toBeTruthy();
  });

it("keeps malformed previously indexed custom symbol reports in the symbol diagnostics lane", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-custom-symbol-malformed-lane-"));
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    await mkdirp(path.join(repo, "src"));
    await mkdirp(path.join(repo, ".codex/static-analysis"));
    await writeFile(path.join(repo, ".gitignore"), ".codex/\n", "utf8");
    await writeFile(path.join(repo, "src/app.ts"), "export function app() { return 1 }\n", "utf8");
    await writeFile(
      path.join(repo, ".codex/static-analysis/custom.json"),
      JSON.stringify({
        schemaVersion: 1,
        tool: "fixture-symbol-tool",
        language: "typescript",
        symbols: [{ id: "custom-symbol", name: "customSymbol", qualifiedName: "customSymbol", kind: "function", path: "src/app.ts", line: 1 }]
      }),
      "utf8"
    );
    execFileSync("git", ["add", ".gitignore", "src/app.ts"], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["-c", "user.name=Codexa", "-c", "user.email=codexa@example.invalid", "commit", "-m", "custom-symbol-malformed-lane"], {
      cwd: repo,
      stdio: "ignore"
    });
    await buildIndex({ repoRoot: repo, writeArtifacts: true });

    await writeFile(path.join(repo, ".codex/static-analysis/custom.json"), "{not-json", "utf8");

    const stale = await getFreshness(repo);
    expect(stale.stale).toBe(true);
    expect(stale.reason).toBe("external-symbol-reports-changed");
    expect(stale.externalSymbolReportDiagnostics?.some((diagnostic) => diagnostic.path === ".codex/static-analysis/custom.json")).toBe(true);
    expect(stale.externalRiskReportDiagnostics?.some((diagnostic) => diagnostic.path === ".codex/static-analysis/custom.json")).toBe(false);

    const reindexed = await buildIndex({ repoRoot: repo, writeArtifacts: true });
    expect(reindexed.parserErrors.some((error) => error.path === ".codex/static-analysis/custom.json" && error.message.includes("external symbol report"))).toBe(true);
    expect(reindexed.parserErrors.some((error) => error.path === ".codex/static-analysis/custom.json" && error.message.includes("external risk report"))).toBe(false);
  });

it("lets a previously indexed custom symbol report transfer cleanly to the risk lane", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-custom-symbol-to-risk-lane-"));
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    await mkdirp(path.join(repo, "src"));
    await mkdirp(path.join(repo, ".codex/static-analysis"));
    await writeFile(path.join(repo, ".gitignore"), ".codex/\n", "utf8");
    await writeFile(path.join(repo, "src/app.ts"), "export function app() { return 1 }\n", "utf8");
    await writeFile(
      path.join(repo, ".codex/static-analysis/custom.json"),
      JSON.stringify({
        schemaVersion: 1,
        tool: "fixture-symbol-tool",
        language: "typescript",
        symbols: [{ id: "custom-symbol", name: "customSymbol", qualifiedName: "customSymbol", kind: "function", path: "src/app.ts", line: 1 }]
      }),
      "utf8"
    );
    execFileSync("git", ["add", ".gitignore", "src/app.ts"], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["-c", "user.name=Codexa", "-c", "user.email=codexa@example.invalid", "commit", "-m", "custom-symbol-to-risk-lane"], {
      cwd: repo,
      stdio: "ignore"
    });
    await buildIndex({ repoRoot: repo, writeArtifacts: true });

    for (let index = 0; index < 250; index += 1) {
      await writeFile(
        path.join(repo, ".codex/static-analysis", `aaa-${String(index).padStart(3, "0")}.json`),
        JSON.stringify({ risks: [{ path: "src/app.ts", signal: `ambient-transfer-risk-${index}`, reason: "ambient", score: 1 }] }),
        "utf8"
      );
    }
    await writeFile(path.join(repo, ".codex/static-analysis/custom.json"), JSON.stringify({ risks: [{ path: "src/app.ts", signal: "custom-risk", reason: "custom", score: 7 }] }), "utf8");

    const reindexed = await buildIndex({ repoRoot: repo, writeArtifacts: true });
    expect(reindexed.risks.some((risk) => risk.signal === "custom-risk")).toBe(true);
    expect(reindexed.freshness.externalRiskReportHashes?.[".codex/static-analysis/custom.json"]).toBeTruthy();
    expect(reindexed.freshness.externalSymbolReportHashes?.[".codex/static-analysis/custom.json"]).toBeUndefined();
    expect(reindexed.parserErrors.some((error) => error.path === ".codex/static-analysis/custom.json" && error.message.includes("external symbol report"))).toBe(false);
  });

it("lets a large previously indexed custom symbol report transfer to the risk lane without symbol diagnostics", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-large-custom-symbol-to-risk-lane-"));
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    await mkdirp(path.join(repo, "src"));
    await mkdirp(path.join(repo, ".codex/static-analysis"));
    await writeFile(path.join(repo, ".gitignore"), ".codex/\n", "utf8");
    await writeFile(path.join(repo, "src/app.ts"), "export function app() { return 1 }\n", "utf8");
    await writeFile(
      path.join(repo, ".codex/static-analysis/custom.json"),
      JSON.stringify({
        schemaVersion: 1,
        tool: "fixture-symbol-tool",
        language: "typescript",
        symbols: [{ id: "custom-symbol", name: "customSymbol", qualifiedName: "customSymbol", kind: "function", path: "src/app.ts", line: 1 }]
      }),
      "utf8"
    );
    execFileSync("git", ["add", ".gitignore", "src/app.ts"], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["-c", "user.name=Codexa", "-c", "user.email=codexa@example.invalid", "commit", "-m", "large-custom-symbol-to-risk-lane"], {
      cwd: repo,
      stdio: "ignore"
    });
    await buildIndex({ repoRoot: repo, writeArtifacts: true });

    await writeFile(
      path.join(repo, ".codex/static-analysis/custom.json"),
      JSON.stringify({
        risks: [{ path: "src/app.ts", signal: "large-custom-risk", reason: "custom", score: 7 }],
        padding: "x".repeat(2 * 1024 * 1024 + 1)
      }),
      "utf8"
    );

    const reindexed = await buildIndex({ repoRoot: repo, writeArtifacts: true });
    expect(reindexed.risks.some((risk) => risk.signal === "large-custom-risk")).toBe(true);
    expect(reindexed.freshness.externalRiskReportHashes?.[".codex/static-analysis/custom.json"]).toBeTruthy();
    expect(reindexed.parserErrors.some((error) => error.path === ".codex/static-analysis/custom.json" && error.message.includes("external symbol report"))).toBe(false);
  });

it("dedupes external risks before applying the total cap so duplicate reports do not starve later findings", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-risk-dedupe-cap-"));
    await mkdirp(path.join(repo, "src"));
    await mkdirp(path.join(repo, ".codex/static-analysis"));
    await mkdirp(path.join(repo, "reports/static-analysis"));
    await writeFile(path.join(repo, "src/app.ts"), "export function app() { return 1 }\n", "utf8");
    const duplicateRisks = Array.from({ length: 6000 }, () => ({ path: "src/app.ts", signal: "duplicate", reason: "same", score: 1 }));
    await writeFile(path.join(repo, ".codex/static-analysis/risks.json"), JSON.stringify({ risks: duplicateRisks }), "utf8");
    await writeFile(path.join(repo, "reports/static-analysis/risks.json"), JSON.stringify({ risks: [{ path: "src/app.ts", signal: "unique-late", reason: "late", score: 3 }] }), "utf8");

    const risks = await loadExternalRiskSignals(repo, "snapshot", "2026-05-31T00:00:00.000Z");

    expect(risks.some((risk) => risk.signal === "duplicate")).toBe(true);
    expect(risks.some((risk) => risk.signal === "unique-late")).toBe(true);
  });

it("drops external risk findings for missing files and symlink escapes", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-risk-realpath-"));
    const outside = await mkdtemp(path.join(os.tmpdir(), "codexa-risk-realpath-outside-"));
    await mkdirp(path.join(repo, "src"));
    await mkdirp(path.join(repo, ".codex/static-analysis"));
    await writeFile(path.join(repo, "src/app.ts"), "export function app() { return 1 }\n", "utf8");
    await writeFile(path.join(outside, "outside.ts"), "export const outside = true;\n", "utf8");
    await symlink(path.join(outside, "outside.ts"), path.join(repo, "src/outside-link.ts"));
    await writeFile(
      path.join(repo, ".codex/static-analysis/risks.json"),
      JSON.stringify({
        risks: [
          { path: "src/app.ts", signal: "kept-risk", reason: "real file", score: 3 },
          { path: "src/missing.ts", signal: "missing-risk", reason: "missing file", score: 9 },
          { path: "src/outside-link.ts", signal: "symlink-risk", reason: "symlink escape", score: 9 }
        ]
      }),
      "utf8"
    );

    const risks = await loadExternalRiskSignals(repo, "snapshot", "2026-05-31T00:00:00.000Z");

    expect(risks.some((risk) => risk.signal === "kept-risk" && risk.path === "src/app.ts")).toBe(true);
    expect(risks.some((risk) => risk.signal === "missing-risk")).toBe(false);
    expect(risks.some((risk) => risk.signal === "symlink-risk")).toBe(false);
  });

it("does not let .codex risk report candidates crowd out reports/static-analysis custom risks", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-risk-cross-dir-crowd-out-"));
    await mkdirp(path.join(repo, "src"));
    await mkdirp(path.join(repo, ".codex/static-analysis"));
    await mkdirp(path.join(repo, "reports/static-analysis"));
    await writeFile(path.join(repo, "src/app.ts"), "export function app() { return 1 }\n", "utf8");
    for (let index = 0; index < 250; index += 1) {
      await writeFile(
        path.join(repo, ".codex/static-analysis", `ambient-${String(index).padStart(3, "0")}.json`),
        JSON.stringify({ risks: [{ path: "src/app.ts", signal: `ambient-${index}`, reason: "ambient", score: 1 }] }),
        "utf8"
      );
    }
    await writeFile(path.join(repo, "reports/static-analysis/manual-risk.json"), JSON.stringify({ risks: [{ path: "src/app.ts", signal: "manual-late-risk", reason: "manual", score: 5 }] }), "utf8");

    const risks = await loadExternalRiskSignals(repo, "snapshot", "2026-05-31T00:00:00.000Z");

    expect(risks.some((risk) => risk.signal === "manual-late-risk")).toBe(true);
  });

it("reserves candidate capacity for previously indexed custom risk reports", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-known-risk-capacity-"));
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    await mkdirp(path.join(repo, "src"));
    await mkdirp(path.join(repo, ".codex/static-analysis"));
    await writeFile(path.join(repo, ".gitignore"), ".codex/\n", "utf8");
    await writeFile(path.join(repo, "src/app.ts"), "export function app() { return 1 }\n", "utf8");
    await writeFile(path.join(repo, ".codex/static-analysis/zz-risk.json"), JSON.stringify({ risks: [{ path: "src/app.ts", signal: "known-risk", reason: "known", score: 7 }] }), "utf8");
    execFileSync("git", ["add", ".gitignore", "src/app.ts"], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["-c", "user.name=Codexa", "-c", "user.email=codexa@example.invalid", "commit", "-m", "known-risk-capacity"], {
      cwd: repo,
      stdio: "ignore"
    });
    const firstIndex = await buildIndex({ repoRoot: repo, writeArtifacts: true });
    expect(firstIndex.freshness.externalRiskReportHashes?.[".codex/static-analysis/zz-risk.json"]).toBeTruthy();

    for (let index = 0; index < 250; index += 1) {
      await writeFile(
        path.join(repo, ".codex/static-analysis", `aaa-${String(index).padStart(3, "0")}.json`),
        JSON.stringify({ risks: [{ path: "src/app.ts", signal: `ambient-risk-${index}`, reason: "ambient", score: 1 }] }),
        "utf8"
      );
    }

    const refreshed = await buildIndex({ repoRoot: repo, writeArtifacts: true });
    expect(refreshed.risks.some((risk) => risk.signal === "known-risk")).toBe(true);
    expect(refreshed.freshness.externalRiskReportHashes?.[".codex/static-analysis/zz-risk.json"]).toBeTruthy();
  });

it("keeps invalid previously indexed custom risk reports in the risk diagnostics lane", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-known-risk-invalid-lane-"));
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    await mkdirp(path.join(repo, "src"));
    await mkdirp(path.join(repo, ".codex/static-analysis"));
    await writeFile(path.join(repo, ".gitignore"), ".codex/\n", "utf8");
    await writeFile(path.join(repo, "src/app.ts"), "export function app() { return 1 }\n", "utf8");
    await writeFile(path.join(repo, ".codex/static-analysis/custom.json"), JSON.stringify({ risks: [{ path: "src/app.ts", signal: "known-risk", reason: "known", score: 7 }] }), "utf8");
    execFileSync("git", ["add", ".gitignore", "src/app.ts"], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["-c", "user.name=Codexa", "-c", "user.email=codexa@example.invalid", "commit", "-m", "known-risk-invalid-lane"], {
      cwd: repo,
      stdio: "ignore"
    });
    await buildIndex({ repoRoot: repo, writeArtifacts: true });

    await writeFile(path.join(repo, ".codex/static-analysis/custom.json"), "{not-json", "utf8");

    const reindexed = await buildIndex({ repoRoot: repo, writeArtifacts: true });
    expect(reindexed.parserErrors.some((error) => error.path === ".codex/static-analysis/custom.json" && error.message.includes("external risk report"))).toBe(true);
    expect(reindexed.parserErrors.some((error) => error.path === ".codex/static-analysis/custom.json" && error.message.includes("external symbol report"))).toBe(false);
  });

it("lets a previously indexed custom risk report transfer to the symbol lane under candidate pressure", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-custom-risk-to-symbol-lane-"));
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    await mkdirp(path.join(repo, "src"));
    await mkdirp(path.join(repo, ".codex/static-analysis"));
    await writeFile(path.join(repo, ".gitignore"), ".codex/\n", "utf8");
    await writeFile(path.join(repo, "src/app.ts"), "export function app() { return 1 }\n", "utf8");
    await writeFile(path.join(repo, ".codex/static-analysis/custom.json"), JSON.stringify({ risks: [{ path: "src/app.ts", signal: "custom-risk", reason: "custom", score: 7 }] }), "utf8");
    execFileSync("git", ["add", ".gitignore", "src/app.ts"], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["-c", "user.name=Codexa", "-c", "user.email=codexa@example.invalid", "commit", "-m", "custom-risk-to-symbol-lane"], {
      cwd: repo,
      stdio: "ignore"
    });
    await buildIndex({ repoRoot: repo, writeArtifacts: true });

    for (let index = 0; index < 500; index += 1) {
      await writeFile(path.join(repo, ".codex/static-analysis", `aaa-${String(index).padStart(3, "0")}.json`), JSON.stringify({ risks: [] }), "utf8");
    }
    await writeFile(
      path.join(repo, ".codex/static-analysis/custom.json"),
      JSON.stringify({
        schemaVersion: 1,
        tool: "fixture-symbol-tool",
        language: "typescript",
        symbols: [{ id: "custom-symbol", name: "customSymbol", qualifiedName: "customSymbol", kind: "function", path: "src/app.ts", line: 2 }]
      }),
      "utf8"
    );

    const refreshed = await buildIndex({ repoRoot: repo, writeArtifacts: true });
    expect(refreshed.symbols.some((symbol) => symbol.qualifiedName === "customSymbol" && symbol.source === "static-analysis")).toBe(true);
    expect(refreshed.freshness.externalSymbolReportHashes?.[".codex/static-analysis/custom.json"]).toBeTruthy();
    expect(refreshed.freshness.externalRiskReportHashes?.[".codex/static-analysis/custom.json"]).toBeUndefined();
  });

it("keeps risk report freshness stable after the risk fact cap is reached", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-risk-cap-freshness-"));
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    await mkdirp(path.join(repo, "src"));
    await mkdirp(path.join(repo, ".codex/static-analysis"));
    await writeFile(path.join(repo, ".gitignore"), ".codex/\n", "utf8");
    await writeFile(path.join(repo, "src/app.ts"), "export function app() { return 1 }\n", "utf8");
    execFileSync("git", ["add", ".gitignore", "src/app.ts"], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["-c", "user.name=Codexa", "-c", "user.email=codexa@example.invalid", "commit", "-m", "risk-cap-freshness"], {
      cwd: repo,
      stdio: "ignore"
    });
    for (let reportIndex = 0; reportIndex < 5; reportIndex += 1) {
      await writeFile(
        path.join(repo, ".codex/static-analysis", `cap-${reportIndex}.json`),
        JSON.stringify({
          risks: Array.from({ length: 5000 }, (_, riskIndex) => ({
            path: "src/app.ts",
            signal: `cap-${reportIndex}-${riskIndex}`,
            reason: "cap",
            score: 1
          }))
        }),
        "utf8"
      );
    }

    await buildIndex({ repoRoot: repo, writeArtifacts: true });
    const freshness = await getFreshness(repo);

    expect(freshness.stale).toBe(false);
  });

it("prioritizes fixed risk reports before generic reports when the risk fact cap is reached", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-fixed-risk-priority-cap-"));
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    await mkdirp(path.join(repo, "src"));
    await mkdirp(path.join(repo, ".codex/static-analysis"));
    await writeFile(path.join(repo, ".gitignore"), ".codex/\n", "utf8");
    await writeFile(path.join(repo, "src/app.ts"), "export function app() { return 1 }\n", "utf8");
    execFileSync("git", ["add", ".gitignore", "src/app.ts"], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["-c", "user.name=Codexa", "-c", "user.email=codexa@example.invalid", "commit", "-m", "fixed-risk-priority-cap"], {
      cwd: repo,
      stdio: "ignore"
    });
    for (let reportIndex = 0; reportIndex < 4; reportIndex += 1) {
      await writeFile(
        path.join(repo, ".codex/static-analysis", `aaa-${reportIndex}.json`),
        JSON.stringify({
          risks: Array.from({ length: 5000 }, (_, riskIndex) => ({
            path: "src/app.ts",
            signal: `ambient-cap-${reportIndex}-${riskIndex}`,
            reason: "ambient",
            score: 1
          }))
        }),
        "utf8"
      );
    }
    await writeFile(path.join(repo, ".codex/static-analysis/risks.json"), JSON.stringify({ risks: [{ path: "src/app.ts", signal: "fixed-risk", reason: "fixed", score: 9 }] }), "utf8");

    const index = await buildIndex({ repoRoot: repo, writeArtifacts: true });

    expect(index.risks.some((risk) => risk.signal === "fixed-risk")).toBe(true);
  });

it("prioritizes fixed risk reports before previously known custom risks when the cap is reached", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-fixed-risk-before-known-cap-"));
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    await mkdirp(path.join(repo, "src"));
    await mkdirp(path.join(repo, ".codex/static-analysis"));
    await writeFile(path.join(repo, ".gitignore"), ".codex/\n", "utf8");
    await writeFile(path.join(repo, "src/app.ts"), "export function app() { return 1 }\n", "utf8");
    for (let reportIndex = 0; reportIndex < 4; reportIndex += 1) {
      await writeFile(
        path.join(repo, ".codex/static-analysis", `custom-${reportIndex}.json`),
        JSON.stringify({
          risks: Array.from({ length: 5000 }, (_, riskIndex) => ({
            path: "src/app.ts",
            signal: `known-cap-${reportIndex}-${riskIndex}`,
            reason: "known",
            score: 1
          }))
        }),
        "utf8"
      );
    }
    execFileSync("git", ["add", ".gitignore", "src/app.ts"], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["-c", "user.name=Codexa", "-c", "user.email=codexa@example.invalid", "commit", "-m", "fixed-risk-before-known-cap"], {
      cwd: repo,
      stdio: "ignore"
    });
    await buildIndex({ repoRoot: repo, writeArtifacts: true });

    await writeFile(path.join(repo, ".codex/static-analysis/risks.json"), JSON.stringify({ risks: [{ path: "src/app.ts", signal: "fixed-risk", reason: "fixed", score: 9 }] }), "utf8");

    const refreshed = await buildIndex({ repoRoot: repo, writeArtifacts: true });
    expect(refreshed.risks.some((risk) => risk.signal === "fixed-risk")).toBe(true);
  });

it("imports symbol-shaped fixed risk paths under generic symbol candidate pressure", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-risk-path-symbol-pressure-"));
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    await mkdirp(path.join(repo, "src"));
    await mkdirp(path.join(repo, ".codex/static-analysis"));
    await writeFile(path.join(repo, ".gitignore"), ".codex/\n", "utf8");
    await writeFile(path.join(repo, "src/app.ts"), "export function app() { return 1 }\n", "utf8");
    for (let index = 0; index < 500; index += 1) {
      await writeFile(path.join(repo, ".codex/static-analysis", `aaa-${String(index).padStart(3, "0")}.json`), JSON.stringify({ risks: [] }), "utf8");
    }
    await writeFile(
      path.join(repo, ".codex/static-analysis/risks.json"),
      JSON.stringify({
        schemaVersion: 1,
        tool: "fixture-symbol-tool",
        language: "typescript",
        symbols: [{ id: "risk-path-symbol", name: "riskPathSymbol", qualifiedName: "riskPathSymbol", kind: "function", path: "src/app.ts", line: 2 }]
      }),
      "utf8"
    );
    execFileSync("git", ["add", ".gitignore", "src/app.ts"], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["-c", "user.name=Codexa", "-c", "user.email=codexa@example.invalid", "commit", "-m", "risk-path-symbol-pressure"], {
      cwd: repo,
      stdio: "ignore"
    });

    const index = await buildIndex({ repoRoot: repo, writeArtifacts: true });
    expect(index.symbols.some((symbol) => symbol.qualifiedName === "riskPathSymbol" && symbol.source === "static-analysis")).toBe(true);
    expect(index.freshness.externalSymbolReportHashes?.[".codex/static-analysis/risks.json"]).toBeTruthy();
    expect(index.freshness.externalRiskReportHashes?.[".codex/static-analysis/risks.json"]).toBeUndefined();
  });

it("reserves symbol load capacity for fixed risk paths containing symbol reports", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-risk-path-symbol-load-cap-"));
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    await mkdirp(path.join(repo, "src"));
    await mkdirp(path.join(repo, ".codex/static-analysis"));
    await writeFile(path.join(repo, ".gitignore"), ".codex/\n", "utf8");
    await writeFile(path.join(repo, "src/app.ts"), "export function app() { return 1 }\n", "utf8");
    for (let index = 0; index < 50; index += 1) {
      await writeFile(
        path.join(repo, ".codex/static-analysis", `symbol-report-${String(index).padStart(2, "0")}.json`),
        JSON.stringify({
          schemaVersion: 1,
          tool: "manual-symbol-tool",
          language: "typescript",
          symbols: [{ id: `manual-${index}`, name: `manual${index}`, qualifiedName: `manual${index}`, kind: "function", path: "src/app.ts", line: 1 }]
        }),
        "utf8"
      );
    }
    await writeFile(
      path.join(repo, ".codex/static-analysis/risks.json"),
      JSON.stringify({
        schemaVersion: 1,
        tool: "fixture-symbol-tool",
        language: "typescript",
        symbols: [{ id: "risk-path-symbol", name: "riskPathSymbol", qualifiedName: "riskPathSymbol", kind: "function", path: "src/app.ts", line: 2 }]
      }),
      "utf8"
    );
    execFileSync("git", ["add", ".gitignore", "src/app.ts"], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["-c", "user.name=Codexa", "-c", "user.email=codexa@example.invalid", "commit", "-m", "risk-path-symbol-load-cap"], {
      cwd: repo,
      stdio: "ignore"
    });

    const index = await buildIndex({ repoRoot: repo, writeArtifacts: true });
    expect(index.symbols.some((symbol) => symbol.qualifiedName === "riskPathSymbol" && symbol.source === "static-analysis")).toBe(true);
    expect(index.freshness.externalSymbolReportHashes?.[".codex/static-analysis/risks.json"]).toBeTruthy();
  });
});
