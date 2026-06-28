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
it("separates evidence tiers and uses natural retrieval instead of broad-task fallback", async () => {
    const repo = await createFixtureRepo();
    await buildIndex({ repoRoot: repo });

    const manifestImpact = await impactQuery(repo, { file: "sample_api/packages/project.media.json" }, { autoRefresh: false });
    expect(manifestImpact.text).toContain("Authoritative read first:");
    expect(manifestImpact.text).toContain("Heuristic expansion:");
    const impactData = manifestImpact.data as {
      selectedFiles: string[];
      affectedFiles: Array<{ file: { path: string } }>;
      evidenceTiers: { authoritative: Array<{ file: { path: string } }>; heuristic: Array<{ file: { path: string } }> };
      quality: { level: string };
      value: { value: string };
    };
    expect(impactData.evidenceTiers.authoritative.some((entry) => entry.file.path === "sample_api/packages/project.media.json")).toBe(true);
    expect(impactData.evidenceTiers.heuristic.length).toBeGreaterThan(0);
    expect(impactData.selectedFiles.length).toBeLessThanOrEqual(impactData.affectedFiles.length);
    expect(impactData.value.value).not.toBe("high");

    const fallbackPack = await contextPackQuery(repo, { task: "Understand route workflow safely", diff: false, limit: 4, tokenBudget: 900 }, { autoRefresh: false });
    expect(fallbackPack.text).toContain("natural task retrieval");
    expect(fallbackPack.text).toContain("workflow route");
    const packData = fallbackPack.data as { quality: { level: string }; focusFiles: Array<{ tier: string }>; value: { value: string } };
    expect(packData.quality.level).not.toBe("low");
    expect(packData.focusFiles.every((entry) => entry.tier === "fallback")).toBe(false);
    expect(packData.quality.level === "medium" ? packData.value.value : "medium").not.toBe("high");
  });

it("builds a token-budgeted repo map with stable truncation", async () => {
    const repo = await createFixtureRepo();
    await buildIndex({ repoRoot: repo });

    const map = await repoMapQuery(repo, 20, { autoRefresh: false }, 400);
    expect(map.text).toContain("Budget: 400 tokens");
    expect(map.text).toContain("Read first:");
    expect(map.text.length).toBeLessThanOrEqual(400 * 4);
    expect((map.data as { quality: { level: string } }).quality.level).toMatch(/high|medium|low/);
  });

it("uses symbol usages and changed diff ranges for impact and test planning", async () => {
    const repo = await createFixtureRepo();
    await buildIndex({ repoRoot: repo });

    const fileImpact = await impactQuery(repo, { file: "src/util.ts" }, { autoRefresh: false });
    expect(fileImpact.text).toContain("src/api.ts");
    expect(fileImpact.text).toContain("call helper");
    const symbolImpact = await impactQuery(repo, { symbol: "helper" }, { autoRefresh: false });
    expect(symbolImpact.text).toContain("src/aliased.ts");
    expect(symbolImpact.text).toContain("src/ns.ts");

    await writeFile(path.join(repo, "src/util.ts"), "export function helper() {\n  return 42\n}\n", "utf8");
    const plan = await testPlanQuery(repo, true, { autoRefresh: true });
    expect(plan.text).toContain("Changed symbols:");
    expect(plan.text).toContain("helper");

    const diff = await diffImpactQuery(repo, { autoRefresh: false });
    expect(diff.text).toContain("Grouped impact:");
    expect(diff.text).toContain("src [source/typescript]");
  });

it("rejects non-manifest JSON from node-manifest indexing", async () => {
    const repo = await createManifestGateFixtureRepo();
    const index = await buildIndex({ repoRoot: repo });

    expect(index.symbols.some((symbol) => symbol.path === "docs/report.json" && symbol.kind === "node")).toBe(false);
    expect(index.symbols.some((symbol) => symbol.path === "sample_api/packages/project.invalid.json" && symbol.kind === "node")).toBe(false);
    expect(index.usageSites.some((usage) => usage.path === "docs/report.json" && usage.name === "fake.node")).toBe(false);
    expect(index.usageSites.some((usage) => usage.path === "sample_api/packages/project.invalid.json" && usage.name === "fake.node")).toBe(false);
    expect(index.risks.some((risk) => risk.path === "docs/report.json" && risk.signal === "node-manifest")).toBe(false);
    expect(index.risks.some((risk) => risk.path === "sample_api/packages/project.invalid.json" && risk.signal === "node-manifest")).toBe(false);
    expect(index.parserErrors.some((error) => error.path === "docs/broken.json")).toBe(true);
    expect(index.graphEdges.some((edge) => edge.fromPath === "docs/report.json" || edge.toPath === "docs/report.json")).toBe(false);
    expect(index.symbols.some((symbol) => symbol.path === "sample_api/packages/project.media.json" && symbol.kind === "node")).toBe(true);
  });

it("keeps quoted dotted references but skips bare property chains", async () => {
    const repo = await createDottedReferenceFixtureRepo();
    const index = await buildIndex({ repoRoot: repo });

    const generateSymbol = index.symbols.find((symbol) => symbol.path === "src/generate.ts" && symbol.name === "generate");
    const barSymbol = index.symbols.find((symbol) => symbol.path === "src/bar.ts" && symbol.name === "bar");

    expect(generateSymbol).toBeTruthy();
    expect(index.usageSites.some((usage) => usage.path === "src/reference.ts" && usage.name === "image.generate" && usage.targetSymbolId === generateSymbol?.id)).toBe(true);
    expect(index.usageSites.some((usage) => usage.path === "src/reference.ts" && usage.name === "foo.bar")).toBe(false);
    expect(index.usageSites.some((usage) => usage.path === "src/reference.ts" && usage.targetSymbolId === barSymbol?.id)).toBe(false);
  });

it("prefers adapters in the same package root as the manifest", async () => {
    const repo = await createManifestLocalityFixtureRepo();
    const index = await buildIndex({ repoRoot: repo });

    const edges = index.graphEdges.filter(
      (edge) => edge.edgeKind === "ADAPTER_REFERENCED_BY_MANIFEST" && edge.fromPath === "packages/foo/package.json"
    );
    expect(edges.map((edge) => edge.toPath)).toEqual(["packages/foo/adapters/image_generate.py"]);
    expect(index.graphEdges.some((edge) => edge.edgeKind === "ADAPTER_REFERENCED_BY_MANIFEST" && edge.fromPath === "packages/foo/package.json" && edge.toPath === "packages/bar/adapters/image_generate.py")).toBe(false);
    const nestedEdges = index.graphEdges.filter((edge) => edge.edgeKind === "ADAPTER_REFERENCED_BY_MANIFEST" && edge.fromPath === "packages/foo/sub/package.json");
    expect(nestedEdges.map((edge) => edge.toPath)).toEqual(["packages/foo/sub/adapters/image_generate.py"]);
    expect(index.graphEdges.some((edge) => edge.edgeKind === "ADAPTER_REFERENCED_BY_MANIFEST" && edge.fromPath === "packages/foo/sub/package.json" && edge.toPath === "packages/foo/adapters/image_generate.py")).toBe(false);
  });

it("builds file explanations with reverse edges and task briefs with bounded impact expansion", async () => {
    const repo = await createFixtureRepo();
    await writeFile(path.join(repo, "service/helpers_decoy.py"), "def normalize_decoy(value):\n    return value\n", "utf8");
    for (let index = 0; index < 12; index += 1) {
      await writeFile(path.join(repo, `src/unrelated_dirty_${index}.ts`), `export const unrelatedDirty${index} = ${index}\n`, "utf8");
    }
    execFileSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
    execFileSync("git", "-c user.name=Codexa -c user.email=codexa@example.invalid commit -m add-broad-dirty-fixtures".split(" "), {
      cwd: repo,
      stdio: "ignore"
    });
    await buildIndex({ repoRoot: repo });
    const broadDirtyPaths = [
      "src/util.ts",
      "src/api.ts",
      "src/aliased.ts",
      "src/ns.ts",
      "src/js-ext-import.ts",
      "src/constants.ts",
      "src/uses-constant.ts",
      "src/ops.ts",
      "src/a/config.ts",
      "src/b/config.ts",
      "web/src/lib/thing.ts",
      "web/src/Danger.tsx"
    ];
    for (const [index, filePath] of broadDirtyPaths.entries()) {
      await writeFile(path.join(repo, filePath), `export const unrelatedDirtyMutation${index} = ${index + 100}\n`, "utf8");
    }

    const fileContext = await fileContextQuery(repo, "service/helpers.py", { autoRefresh: false });
    expect(fileContext.text).toContain("Imported by:");
    expect(fileContext.text).toContain("service/app.py");
    expect(fileContext.text).toContain("External usage sites:");
    expect(fileContext.text).toContain("Covered by tests:");
    expect((fileContext.data as { importedBy: unknown[]; externalUsages: unknown[]; testedBy: unknown[] }).importedBy.length).toBeGreaterThan(0);

    const pack = await contextPackQuery(
      repo,
      {
        task: "Change normalize behavior safely",
        files: ["service/helpers.py"],
        query: "normalize",
        diff: true,
        changeType: "api",
        tokenBudget: 1300,
        limit: 7
      },
      { autoRefresh: false }
    );
    const focusPaths = (pack.data as { focusFiles: Array<{ file: { path: string } }> }).focusFiles.map((entry) => entry.file.path);
    expect(focusPaths).toContain("service/helpers.py");
    expect(focusPaths).toContain("service/app.py");
    expect(focusPaths).toContain("tests/test_app.py");
    expect(focusPaths).not.toContain("service/helpers_decoy.py");
    expect(focusPaths.some((filePath) => broadDirtyPaths.includes(filePath))).toBe(false);
    expect(pack.text).toContain("broad dirty tree");

    const broadWorkflowRepo = await createBroadWorkflowFixtureRepo();
    const broadWorkflow = await focusBriefQuery(
      broadWorkflowRepo,
      {
        task: "How does the normalize_noiseflow route workflow behave and what should be tested?",
        diff: false,
        tokenBudget: 1300,
        limit: 4
      },
      { autoRefresh: false }
    );
    const broadFocusPaths = (broadWorkflow.data as { focusFiles: Array<{ path: string }> }).focusFiles.map((file) => file.path);
    expect(broadFocusPaths).toContain("service_noiseflow/app.py");
    expect(broadFocusPaths).toContain("service_noiseflow/helpers.py");
    expect(broadFocusPaths).toContain("tests/test_noiseflow.py");
    expect(broadFocusPaths.some((filePath) => filePath.startsWith("src/"))).toBe(false);

    const brief = await taskBriefQuery(
      repo,
      {
        task: "Change normalize behavior safely",
        files: ["service/helpers.py"],
        diff: false,
        changeType: "api",
        tokenBudget: 1300,
        limit: 7
      },
      { autoRefresh: false }
    );
    expect(brief.text).toContain("Codexa task brief");
    expect((brief.data as { mode: string }).mode).toBe("task_brief");
  });

it("does not guess ambiguous file or symbol targets", async () => {
    const repo = await createFixtureRepo();
    const index = await buildIndex({ repoRoot: repo });

    const symbolImpact = await impactQuery(repo, { symbol: "config" });
    expect(symbolImpact.text).toContain("Ambiguous symbol target");
    expect(symbolImpact.text).toContain("src/a/config.ts");
    expect(symbolImpact.text).toContain("src/b/config.ts");

    const fileImpact = await impactQuery(repo, { file: "config.ts" });
    expect(fileImpact.text).toContain("Ambiguous file target");

    const outside = await impactQuery(repo, { file: path.join(os.tmpdir(), "src/api.ts") });
    expect(outside.text).toContain("No file or symbol matched impact target");
    expect(outside.text).not.toContain("Impact target");

    const baseCandidate = {
      candidateId: "candidate-test",
      rank: 0,
      kind: "symbol" as const,
      path: "src/api.ts",
      score: 1,
      confidence: "derived" as const,
      evidence: ["test candidate"],
      missingAnchors: [],
      nextChangePlanArgs: { symbols: ["missingSymbol"], changeType: "unknown" as const, saveSnapshot: true as const },
      rawSearchQueries: []
    };
    const invalidSymbol = validateChangePlanTargetCandidate(baseCandidate, { index, repoRoot: repo });
    expect(invalidSymbol.validationStatus).toBe("needs-more-context");
    expect(invalidSymbol.validationReasons).toContain("symbol target not indexed: missingSymbol");

    const ambiguousSymbol = validateChangePlanTargetCandidate(
      {
        ...baseCandidate,
        nextChangePlanArgs: { symbols: ["config"], changeType: "unknown" as const, saveSnapshot: true as const }
      },
      { index, repoRoot: repo }
    );
    expect(ambiguousSymbol.validationStatus).toBe("needs-more-context");
    expect(ambiguousSymbol.validationReasons).toContain("symbol target is ambiguous: config");

    const weakCandidate = validateChangePlanTargetCandidate(
      {
        ...baseCandidate,
        kind: "file" as const,
        confidence: "fallback" as const,
        evidence: [],
        nextChangePlanArgs: { files: ["src/api.ts"], changeType: "unknown" as const, saveSnapshot: true as const }
      },
      { index, repoRoot: repo }
    );
    expect(weakCandidate.validationStatus).toBe("weak");
    expect(weakCandidate.wouldPlanEditTargets).toEqual(["src/api.ts"]);
    expect(weakCandidate.validationReasons).toContain("candidate evidence is fallback");

    const heuristicCandidate = validateChangePlanTargetCandidate(
      {
        ...baseCandidate,
        kind: "file" as const,
        confidence: "heuristic" as const,
        evidence: ["lexical path match"],
        nextChangePlanArgs: { files: ["src/api.ts"], changeType: "unknown" as const, saveSnapshot: true as const }
      },
      { index, repoRoot: repo }
    );
    expect(heuristicCandidate.validationStatus).toBe("weak");
    expect(heuristicCandidate.wouldPlanEditTargets).toEqual(["src/api.ts"]);
  });

it("reports changed files that are not in the current index", async () => {
    const repo = await createFixtureRepo();
    await buildIndex({ repoRoot: repo });
    await writeFile(path.join(repo, "service/new_helper.py"), "def later():\n    return 1\n", "utf8");

    const plan = await testPlanQuery(repo, true, { autoRefresh: false });
    expect(plan.text).toContain("Changed but not indexed");
    expect(plan.text).toContain("service/new_helper.py");
  });

it("indexes Markdown docs as document facts and keeps changed docs out of unindexed gaps", async () => {
    const repo = await createDocFixtureRepo();
    const index = await buildIndex({ repoRoot: repo });

    expect(index.files.find((file) => file.path === "README.md")?.language).toBe("markdown");
    expect(index.files.find((file) => file.path === "docs/workflow.md")?.language).toBe("markdown");
    expect(index.symbols.some((symbol) => symbol.path === "README.md" && symbol.name === "Runtime Guide" && symbol.source === "markdown")).toBe(true);
    expect(index.usageSites.some((usage) => usage.path === "docs/workflow.md" && usage.text.includes("pre edit accountability"))).toBe(true);
    expect(index.imports.some((imp) => imp.path === "README.md" && imp.specifier === "./src/runtime.ts" && imp.resolvedPath === "src/runtime.ts")).toBe(true);
    expect(index.imports.some((imp) => imp.path === "docs/workflow.md" && imp.specifier === "../src/runtime.ts" && imp.resolvedPath === "src/runtime.ts")).toBe(true);

    await writeFile(
      path.join(repo, "README.md"),
      "# Runtime Guide\n\nChanged docs still reference [runtime](src/runtime.ts) and `npm run test`.\n",
      "utf8"
    );
    const diff = await diffImpactQuery(repo, { autoRefresh: false });
    expect((diff.data as { unindexedChanged: string[] }).unindexedChanged).not.toContain("README.md");
    expect(diff.text).not.toContain("Changed but not indexed:\n- README.md");
    expect(diff.text).toContain("root [docs/markdown]");
  });

it("reports rename diff kinds instead of losing the new path", async () => {
    const repo = await createFixtureRepo();
    await buildIndex({ repoRoot: repo });
    execFileSync("git", ["mv", "src/util.ts", "src/util_moved.ts"], { cwd: repo, stdio: "ignore" });

    const status = await statusQuery(repo);
    expect(status.freshness.dirtyFiles).toContain("src/util_moved.ts");
    expect(status.freshness.dirtyFiles).not.toContain("src/util.ts");

    const diff = await diffImpactQuery(repo, { autoRefresh: false });
    expect(diff.text).toContain("src/util_moved.ts");
    expect(diff.text).toContain("renamed");
    expect(diff.text).toContain("Changed but not indexed");
  });

it("does not fabricate Python test commands without repo metadata provenance", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-no-test-metadata-"));
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    await mkdirp(path.join(repo, "service"));
    await mkdirp(path.join(repo, "tests"));
    await writeFile(path.join(repo, "service/mod.py"), "def work():\n    return 1\n", "utf8");
    await writeFile(path.join(repo, "tests/test_mod.py"), "from service.mod import work\n\ndef test_work():\n    assert work() == 1\n", "utf8");
    execFileSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["-c", "user.name=Codexa", "-c", "user.email=codexa@example.invalid", "commit", "-m", "fixture"], {
      cwd: repo,
      stdio: "ignore"
    });
    await buildIndex({ repoRoot: repo });

    const impact = await impactQuery(repo, { file: "service/mod.py" }, { autoRefresh: false });
    expect(impact.text).toContain("tests/test_mod.py");
    expect(impact.text).not.toContain("Candidate test commands");
    expect(impact.text).not.toContain("pytest tests/test_mod.py");
  });

it("promotes indirect recommended tests into impact read-first files", async () => {
    const repo = await createFixtureRepo();
    await buildIndex({ repoRoot: repo });

    const impact = await impactQuery(repo, { file: "service/helpers.py" }, { autoRefresh: false });
    const selected = (impact.data as { selectedFiles: string[] }).selectedFiles;
    expect(selected).toContain("service/helpers.py");
    expect(selected).toContain("service/app.py");
    expect(selected).toContain("tests/test_app.py");
    expect(impact.text).toContain("recommended test");
  });

it("auto-refreshes missing and stale indexes for context queries when requested", async () => {
    const repo = await createFixtureRepo();
    const missing = await impactQuery(repo, { file: "src/api.ts" }, { autoRefresh: true });
    expect(missing.text).toContain("auto-refreshed from missing-index");
    expect(missing.freshness.stale).toBe(false);

    await writeFile(path.join(repo, "src/late.ts"), "export function lateFeature() { return 4 }\n", "utf8");
    const context = await impactQuery(repo, { file: "src/late.ts" }, { autoRefresh: true });
    expect(context.text).toContain("auto-refreshed from dirty-files-changed");
    expect(context.text).toContain("src/late.ts");
    expect(context.freshness.stale).toBe(false);
  });

it("builds a bounded task-shaped context pack", async () => {
    const repo = await createFixtureRepo();
    await buildIndex({ repoRoot: repo });
    await writeFile(path.join(repo, "service/helpers.py"), "def normalize(value):\n    return value.strip().lower()\n", "utf8");

    const pack = await contextPackQuery(
      repo,
      {
        task: "Change helper normalization safely",
        files: ["service/helpers.py"],
        query: "normalize",
        diff: true,
        tokenBudget: 900,
        limit: 6
      },
      { autoRefresh: true }
    );
    expect(pack.text).toContain("Codexa context pack");
    expect(pack.text).toContain("Read first:");
    expect(pack.text).toContain("Likely tests:");
    expect(pack.text).toContain("tests/test_app.py");
    expect(pack.text.length).toBeLessThanOrEqual(900 * 4 + 40);
  });

it("bridges bounded workspace working and memory guidance into context surfaces", async () => {
    const originalRepo = await createFixtureRepo();
    const workspace = await mkdtemp(path.join(os.tmpdir(), "codexa-workspace-"));
    const repo = path.join(workspace, "codexa");
    await rename(originalRepo, repo);
    await mkdir(path.join(workspace, ".codex"), { recursive: true });
    await writeFile(
      path.join(workspace, ".codex", "WORKING.md"),
      [
        "# WORKING",
        "session | repo | task | next",
        `active | ${repo} | Codexa context pack should read workspace guidance | wait for verification`,
        `active | ${path.join(workspace, "atlas")} | Atlas publish note should stay unrelated`
      ].join("\n"),
      "utf8"
    );
    await writeFile(
      path.join(workspace, ".codex", "MEMORY.md"),
      [
        "# MEMORY",
        "- Codexa context pack should surface workspace memory guidance without dumping full memory.",
        "- Springwood furniture palette guidance should stay unrelated."
      ].join("\n"),
      "utf8"
    );
    await buildIndex({ repoRoot: repo });

    const pack = await contextPackQuery(
      repo,
      {
        task: "Improve Codexa context pack workspace memory handling",
        files: ["src/api.ts"],
        diff: false,
        tokenBudget: 1400,
        limit: 6
      },
      { autoRefresh: false }
    );
    const packData = pack.data as {
      workspaceGuidance?: { workspaceRoot: string; lines: Array<{ source: string; text: string }> };
    };
    expect(pack.text).toContain("Workspace guidance:");
    expect(pack.text).toContain("WORKING.md:");
    expect(pack.text).toContain("MEMORY.md:");
    expect(pack.text).toContain("Codexa context pack");
    expect(pack.text).not.toContain("Atlas publish note");
    expect(pack.text).not.toContain("Springwood furniture");
    expect(packData.workspaceGuidance?.workspaceRoot).toBe(workspace);
    expect(packData.workspaceGuidance?.lines.map((line) => line.source)).toEqual(expect.arrayContaining(["WORKING.md", "MEMORY.md"]));

    const focus = await focusBriefQuery(
      repo,
      {
        task: "Improve Codexa context pack workspace memory handling",
        diff: false,
        tokenBudget: 1400,
        limit: 6
      },
      { autoRefresh: false }
    );
    expect(focus.text).toContain("Workspace guidance:");
    expect((focus.data as { workspaceGuidance?: { lines: unknown[] } }).workspaceGuidance?.lines.length).toBeGreaterThan(0);
  });

it("keeps source-anchored edit packets ready when dirty tests are selected", async () => {
    const repo = await createFixtureRepo();
    await buildIndex({ repoRoot: repo });
    await writeFile(
      path.join(repo, "tests/test_app.py"),
      "from service.app import route_thing\n\ndef test_route_dirty():\n    assert route_thing(' A ') == 'A'\n",
      "utf8"
    );

    const pack = await taskBriefQuery(
      repo,
      {
        task: "Fix service/app.py route_thing normalization behavior",
        diff: true,
        tokenBudget: 1400,
        limit: 8
      },
      { autoRefresh: true }
    );
    const data = pack.data as {
      packetVerdict?: string;
      actionability?: string;
      actionGuidanceSuppressed?: boolean;
      focusFiles: Array<{ file: { path: string }; tier: string }>;
      intentConfidence?: { editReady: boolean; anchors: string[]; missingAnchors: string[] };
      quality?: { level: string };
      tests?: unknown[];
    };

    expect(data.focusFiles.map((entry) => entry.file.path)).toContain("service/app.py");
    expect(data.focusFiles.map((entry) => entry.file.path)).toContain("tests/test_app.py");
    expect(data.intentConfidence?.anchors).toContain("service/app.py");
    expect(data.intentConfidence?.missingAnchors).not.toContain("only test anchors for edit prompt");
    expect(data.packetVerdict).toBe("edit-ready");
    expect(data.actionability).toBe("edit_ready");
    expect(pack.text).toContain("Actionability: edit_ready");
    expect(data.intentConfidence?.editReady).toBe(true);
    expect(data.quality?.level).not.toBe("low");
    expect(data.actionGuidanceSuppressed).toBe(false);
    expect(data.tests?.length).toBeGreaterThan(0);
    expect(pack.text).not.toContain("deferred until Codexa has an explicit file, symbol, or higher-confidence packet");
  });

it("does not let unrelated dirty files turn broad edit prompts into edit-ready packets", async () => {
    const repo = await createFixtureRepo();
    await buildIndex({ repoRoot: repo });
    await writeFile(path.join(repo, "service/helpers.py"), "def normalize(value):\n    return value.strip().lower()\n", "utf8");

    const pack = await taskBriefQuery(
      repo,
      {
        task: "Change behavior safely",
        diff: true,
        tokenBudget: 1400,
        limit: 8
      },
      { autoRefresh: false }
    );
    const data = pack.data as {
      packetVerdict?: string;
      actionability?: string;
      focusFiles: Array<{ file: { path: string }; tier: string }>;
      intentConfidence?: { editReady: boolean; anchors: string[]; missingAnchors: string[] };
    };

    expect(data.focusFiles.map((entry) => entry.file.path)).toContain("service/helpers.py");
    expect(data.intentConfidence?.anchors).not.toContain("service/helpers.py");
    expect(data.intentConfidence?.editReady).toBe(false);
    expect(data.packetVerdict).not.toBe("edit-ready");
    expect(data.actionability).not.toBe("edit_ready");
    expect(data.intentConfidence?.missingAnchors).toContain("no selected packet anchors");
    expect(pack.text).toContain("Recommended next MCP call: search");
  });
});
