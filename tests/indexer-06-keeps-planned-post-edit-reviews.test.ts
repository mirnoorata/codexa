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
it("keeps planned post-edit reviews accountable without forcing replan when tests are reported", async () => {
    const repo = await createFixtureRepo();
    await buildIndex({ repoRoot: repo });

    await changePlanQuery(
      repo,
      {
        task: "Change helper normalization safely",
        files: ["service/helpers.py"],
        diff: false,
        limit: 6,
        saveSnapshot: true,
        taskId: "planned-helper-edit"
      },
      { autoRefresh: false }
    );
    const snapshotPath = path.join(repo, ".codex/cache/codexa-tasks/planned-helper-edit.json");
    const snapshot = JSON.parse(await readFile(snapshotPath, "utf8"));
	    snapshot.plannedTests.push({
	      path: "tests/manual_regression.py",
	      reason: "manual regression saved in plan snapshot",
	      rank: 99,
	      evidenceTier: "authoritative",
	      provenance: {
	        schemaVersion: 1,
	        origin: "snapshot",
	        sources: ["explicit_target"],
	        targetPaths: ["service/helpers.py"],
	        evidence: ["manual regression saved in plan snapshot"]
	      }
	    });
    await writeFile(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");

    await writeFile(path.join(repo, "service/helpers.py"), "def normalize(value):\n    return value.strip().upper()\n", "utf8");

    const needsTests = await postEditReviewQuery(repo, { taskId: "planned-helper-edit", ranTests: [] }, { autoRefresh: true });
    const needsTestsData = needsTests.data as {
      verdict: string;
      unplannedEditedFiles: string[];
      modifiedSymbols: string[];
      missedLikelyTests: Array<{ path: string }>;
    };
    expect(needsTestsData.unplannedEditedFiles).toEqual([]);
    expect(needsTestsData.verdict).toBe("run_tests");
    expect(needsTestsData.modifiedSymbols.some((symbol) => symbol.includes("normalize"))).toBe(true);
    expect(needsTestsData.missedLikelyTests.map((test) => test.path)).toContain("tests/test_app.py");
    expect(needsTestsData.missedLikelyTests.map((test) => test.path)).toContain("tests/manual_regression.py");

    const pytestTargeted = await postEditReviewQuery(repo, { taskId: "planned-helper-edit", ranCommands: ["pytest tests/test_app.py"] }, { autoRefresh: false });
    const pytestTargetedData = pytestTargeted.data as {
      testsNotRun: Array<{ path: string }>;
      verificationLedger: Array<{ target: string; status: string; evidence: string[] }>;
    };
    expect(pytestTargetedData.verificationLedger.find((entry) => entry.target === "tests/test_app.py")?.status).toBe("covered");
    expect(pytestTargetedData.testsNotRun.map((test) => test.path)).toContain("tests/manual_regression.py");

    const pythonModulePytest = await postEditReviewQuery(repo, { taskId: "planned-helper-edit", ranCommands: ["python -m pytest tests/test_app.py"] }, { autoRefresh: false });
    expect((pythonModulePytest.data as { verificationLedger: Array<{ target: string; status: string }> }).verificationLedger.find((entry) => entry.target === "tests/test_app.py")?.status).toBe(
      "covered"
    );

    const absolutePytestTarget = await postEditReviewQuery(repo, { taskId: "planned-helper-edit", ranCommands: [`pytest ${path.join(repo, "tests/test_app.py")}`] }, { autoRefresh: false });
    expect((absolutePytestTarget.data as { verificationLedger: Array<{ target: string; status: string }> }).verificationLedger.find((entry) => entry.target === "tests/test_app.py")?.status).toBe(
      "covered"
    );

    const pytestNodeIdTarget = await postEditReviewQuery(repo, { taskId: "planned-helper-edit", ranCommands: ["pytest tests/test_app.py::test_route"] }, { autoRefresh: false });
    expect((pytestNodeIdTarget.data as { verificationLedger: Array<{ target: string; status: string }> }).verificationLedger.find((entry) => entry.target === "tests/test_app.py")?.status).toBe(
      "covered"
    );

    const pytestCollectOnly = await postEditReviewQuery(repo, { taskId: "planned-helper-edit", ranCommands: ["pytest --collect-only tests/test_app.py"] }, { autoRefresh: false });
    expect((pytestCollectOnly.data as { testsNotRun: Array<{ path: string }> }).testsNotRun.map((test) => test.path)).toContain("tests/test_app.py");

    const pytestVersion = await postEditReviewQuery(repo, { taskId: "planned-helper-edit", ranCommands: ["pytest --version"] }, { autoRefresh: false });
    expect((pytestVersion.data as { testsNotRun: Array<{ path: string }> }).testsNotRun.map((test) => test.path)).toContain("tests/test_app.py");

    const pytestVerbose = await postEditReviewQuery(repo, { taskId: "planned-helper-edit", ranCommands: ["pytest -v tests/test_app.py"] }, { autoRefresh: false });
    expect((pytestVerbose.data as { verificationLedger: Array<{ target: string; status: string }> }).verificationLedger.find((entry) => entry.target === "tests/test_app.py")?.status).toBe(
      "covered"
    );

    const pytestHelp = await postEditReviewQuery(repo, { taskId: "planned-helper-edit", ranCommands: ["pytest -h tests/test_app.py"] }, { autoRefresh: false });
    expect((pytestHelp.data as { testsNotRun: Array<{ path: string }> }).testsNotRun.map((test) => test.path)).toContain("tests/test_app.py");

    const pytestAll = await postEditReviewQuery(repo, { taskId: "planned-helper-edit", ranCommands: ["pytest"] }, { autoRefresh: false });
    const pytestAllData = pytestAll.data as { testsNotRun: Array<{ path: string }>; verificationLedger: Array<{ target: string; status: string }> };
    expect(pytestAllData.verificationLedger.find((entry) => entry.target === "tests/test_app.py")?.status).toBe("covered");
    expect(pytestAllData.testsNotRun.map((test) => test.path)).toContain("tests/manual_regression.py");

    const afterTests = await postEditReviewQuery(repo, { taskId: "planned-helper-edit", ranTests: needsTestsData.missedLikelyTests.map((test) => test.path) }, { autoRefresh: false });
    const afterTestsData = afterTests.data as {
      verdict: string;
      testsNotRun: unknown[];
      missedLikelyTests: unknown[];
      workflowChecks: Array<{ status: string }>;
      dependencyChecks: Array<{ status: string }>;
      outcome: { hookSummary: { nextAction: string }; calibrationLabels: string[] };
    };
    expect(afterTestsData.verdict).toBe("continue");
    expect(afterTestsData.testsNotRun).toEqual([]);
    expect(afterTestsData.missedLikelyTests).toEqual([]);
    expect(afterTestsData.workflowChecks.every((check) => check.status === "covered")).toBe(true);
    expect(afterTestsData.dependencyChecks.every((check) => check.status === "covered")).toBe(true);
    expect(afterTestsData.outcome.hookSummary.nextAction).toBe("continue with normal diff review");
      expect(afterTestsData.outcome.calibrationLabels).not.toContain("missing-recommended-tests");
    });

it("degrades legacy snapshot tests instead of trusting unscoped planned-test evidence", async () => {
      const repo = await createFixtureRepo();
      await buildIndex({ repoRoot: repo });
      await changePlanQuery(
        repo,
        {
          task: "Change helper normalization safely",
          files: ["service/helpers.py"],
          diff: false,
          limit: 6,
          saveSnapshot: true,
          taskId: "legacy-planned-test-provenance"
        },
        { autoRefresh: false }
      );
      const snapshotPath = path.join(repo, ".codex/cache/codexa-tasks/legacy-planned-test-provenance.json");
      const snapshot = JSON.parse(await readFile(snapshotPath, "utf8"));
      snapshot.plannedTests.push({
        path: "tests/manual_legacy.py",
        reason: "legacy broad snapshot test without provenance",
        rank: 99,
        evidenceTier: "authoritative"
      });
      snapshot.plannedTests.push({
        path: "tests/manual_v1_stale.py",
        reason: "v1 snapshot test for a broader old target",
        rank: 98,
        evidenceTier: "authoritative",
        provenance: {
          schemaVersion: 1,
          origin: "snapshot",
          sources: ["authoritative_test_edge"],
          targetPaths: ["service/old_target.py"],
          evidence: ["v1 snapshot test for a broader old target"]
        }
      });
      await writeFile(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
      await writeFile(path.join(repo, "service/helpers.py"), "def normalize(value):\n    return value.strip().upper()\n", "utf8");

      const review = await postEditReviewQuery(repo, { taskId: "legacy-planned-test-provenance", ranTests: [] }, { autoRefresh: true });
      const data = review.data as {
        verdict: string;
        inspectMode: string;
        completionAuthority: string;
        inspectReasons: string[];
        degradedSnapshotTests: Array<{ path: string; provenance?: { degradedReason?: string } }>;
        missedLikelyTests: Array<{ path: string }>;
        driftReasons: string[];
      };
      expect(data.verdict).toBe("inspect");
      expect(data.inspectMode).toBe("advisory");
      expect(data.completionAuthority).toBe("advisory_inspect");
      expect(data.inspectReasons).toContain("planned snapshot tests have degraded provenance");
      expect(data.degradedSnapshotTests.map((test) => test.path)).toContain("tests/manual_legacy.py");
      expect(data.degradedSnapshotTests.map((test) => test.path)).toContain("tests/manual_v1_stale.py");
      expect(data.degradedSnapshotTests.find((test) => test.path === "tests/manual_legacy.py")?.provenance?.degradedReason).toContain("legacy snapshot test lacks planned-test provenance");
      expect(data.missedLikelyTests.map((test) => test.path)).not.toContain("tests/manual_legacy.py");
      expect(data.missedLikelyTests.map((test) => test.path)).not.toContain("tests/manual_v1_stale.py");
      expect(data.driftReasons.some((reason) => reason.includes("planned snapshot test"))).toBe(true);
    });

it("requires explicit snapshot binding when multiple task snapshots exist", async () => {
      const repo = await createFixtureRepo();
      await buildIndex({ repoRoot: repo });

      await changePlanQuery(
        repo,
        {
          task: "First helper edit",
          files: ["service/helpers.py"],
          diff: false,
          saveSnapshot: true,
          taskId: "first-helper-edit"
        },
        { autoRefresh: false }
      );
      await changePlanQuery(
        repo,
        {
          task: "Second helper edit",
          files: ["service/helpers.py"],
          diff: false,
          saveSnapshot: true,
          taskId: "second-helper-edit"
        },
        { autoRefresh: false }
      );
      await writeFile(path.join(repo, "service/helpers.py"), "def normalize(value):\n    return value.strip().upper()\n", "utf8");

      const review = await postEditReviewQuery(repo, { ranTests: ["tests/test_app.py"], persistOutcome: false }, { autoRefresh: true });
      const data = review.data as { verdict: string; inspectMode: string; completionAuthority: string; driftReasons: string[] };
      expect(data.verdict).toBe("inspect");
      expect(data.inspectMode).toBe("advisory");
      expect(data.completionAuthority).toBe("advisory_inspect");
      expect(data.driftReasons.some((reason) => reason.includes("used latest snapshot second-helper-edit without an explicit taskId"))).toBe(true);
    });

it("keeps verified non-source unindexed post-edit drift advisory", () => {
      type DecisionInput = Parameters<typeof postEditDecision>[0];
      const mediumQuality: DecisionInput["quality"] = {
        level: "medium",
        recommendation: "Use explicit verification and inspect advisory gaps.",
        reasons: ["non-source file has no symbol ranges"],
        counts: { authoritative: 1, derived: 0, heuristic: 0, fallback: 0 }
      };
      const baseInput = (unindexedEditedFiles: string[]): DecisionInput => ({
        snapshot: { taskId: "style-css" } as NonNullable<DecisionInput["snapshot"]>,
        loadedSnapshot: {},
        snapshotAmbiguity: undefined,
        worktreeDegradationReasons: [],
        headChanged: false,
        unplannedEditedFiles: [],
        unplannedChangedSymbols: [],
        unindexedEditedFiles,
        symbolDeltas: [],
        riskDeltas: [],
        workflowChecks: [],
        dependencyChecks: [],
        degradedSnapshotTests: [],
        quality: mediumQuality,
        riskEscalations: [],
        waivedVerification: [],
        hasActualEditedFiles: true,
        testsNotRun: [],
        hasTestVerificationAccounting: true,
        noVerificationProofForEditedFiles: false,
        implicitBaseline: false
      });

      const cssDecision = postEditDecision(baseInput(["web/src/styles.css"]));
      expect(cssDecision.verdict).toBe("inspect");
      expect(cssDecision.inspectMode).toBe("advisory");
      expect(cssDecision.completionAuthority).toBe("advisory_inspect");
      expect(cssDecision.inspectReasons).toEqual(expect.arrayContaining(["edited non-source files lack symbol ranges", "context quality is medium"]));
      expect(cssDecision.inspectReasons).not.toContain("source-like edited files are not indexed");
      expect(cssDecision.driftReasons).toContain("1 changed-since-snapshot file(s) lack indexed source/symbol context");

      const sourceLikeDecision = postEditDecision(baseInput(["web/src/App.vue"]));
      expect(sourceLikeDecision.inspectMode).toBe("blocking");
      expect(sourceLikeDecision.completionAuthority).toBe("blocking_inspect");
      expect(sourceLikeDecision.inspectReasons).toContain("source-like edited files are not indexed");
    });

it("does not continue edited files when no verification was recommended or reported", async () => {
      const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-no-test-proof-"));
      execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
      await mkdirp(path.join(repo, "src"));
      await writeFile(path.join(repo, "src/main.ts"), "export function main() { return 1 }\n", "utf8");
      execFileSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
      execFileSync("git", ["-c", "user.name=Codexa", "-c", "user.email=codexa@example.invalid", "commit", "-m", "fixture"], {
        cwd: repo,
        stdio: "ignore"
      });
      await buildIndex({ repoRoot: repo });
      await changePlanQuery(
        repo,
        {
          task: "Change main without tests",
          files: ["src/main.ts"],
          diff: false,
          saveSnapshot: true,
          taskId: "no-test-proof"
        },
        { autoRefresh: false }
      );
      const snapshotPath = path.join(repo, ".codex/cache/codexa-tasks/no-test-proof.json");
      const snapshot = JSON.parse(await readFile(snapshotPath, "utf8"));
      snapshot.plannedTests = [];
      snapshot.requiredWorkflowChecks = [];
      snapshot.requiredDependencyChecks = [];
      await writeFile(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
      await writeFile(path.join(repo, "src/main.ts"), "export function main() { return 2 }\n", "utf8");

    const review = await postEditReviewQuery(repo, { taskId: "no-test-proof", persistOutcome: false }, { autoRefresh: true });
    const data = review.data as { verdict: string; inspectMode: string; completionAuthority: string; inspectReasons: string[]; tests: unknown[]; driftReasons: string[]; nextActions: string[] };
    expect(data.tests).toEqual([]);
    expect(data.verdict).toBe("inspect");
    expect(data.inspectMode).toBe("blocking");
    expect(data.completionAuthority).toBe("blocking_inspect");
    expect(data.inspectReasons).toContain("edited files have no credible verification evidence");
    expect(data.driftReasons).toContain("edited files have no credible verification evidence");
    expect(data.nextActions).toContain("Report a relevant test, build, or typecheck command before treating edited files as verified.");

    const auditOnly = await postEditReviewQuery(repo, { taskId: "no-test-proof", ranCommands: ["npm audit"], persistOutcome: false }, { autoRefresh: false });
    const auditOnlyData = auditOnly.data as { verdict: string; inspectMode: string; completionAuthority: string; inspectReasons: string[]; tests: unknown[]; driftReasons: string[]; nextActions: string[] };
    expect(auditOnlyData.tests).toEqual([]);
    expect(auditOnlyData.verdict).toBe("inspect");
    expect(auditOnlyData.inspectMode).toBe("blocking");
    expect(auditOnlyData.completionAuthority).toBe("blocking_inspect");
    expect(auditOnlyData.inspectReasons).toContain("edited files have no credible verification evidence");
    expect(auditOnlyData.driftReasons).toContain("edited files have no credible verification evidence");
    expect(auditOnlyData.nextActions).toContain("Report a relevant test, build, or typecheck command before treating edited files as verified.");
    });

it("clears planned high-risk post-edit targets after required verification is accounted for", async () => {
    const repo = await createFixtureRepo();
    await writeFile(
      path.join(repo, "tests/ops.test.ts"),
      "import { rewriteFile } from '../src/ops'\ntest('operator rewrite surface', () => { expect(typeof rewriteFile).toBe('function') })\n",
      "utf8"
    );
    await buildIndex({ repoRoot: repo });

    await changePlanQuery(
      repo,
      {
        task: "Change operator file rewrite safely",
        files: ["src/ops.ts"],
        diff: false,
        limit: 6,
        saveSnapshot: true,
        taskId: "planned-high-risk-edit"
      },
      { autoRefresh: false }
    );
    const snapshotPath = path.join(repo, ".codex/cache/codexa-tasks/planned-high-risk-edit.json");
    const snapshot = JSON.parse(await readFile(snapshotPath, "utf8"));
	    snapshot.plannedTests.push({
	      path: "tests/manual_ops_regression.ts",
	      reason: "manual high-risk ops regression saved in plan snapshot",
	      rank: 99,
	      evidenceTier: "authoritative",
	      provenance: {
	        schemaVersion: 1,
	        origin: "snapshot",
	        sources: ["explicit_target"],
	        targetPaths: ["src/ops.ts"],
	        evidence: ["manual high-risk ops regression saved in plan snapshot"]
	      }
	    });
    await writeFile(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");

    await writeFile(
      path.join(repo, "src/ops.ts"),
      "import { execFileSync } from 'node:child_process'\nimport { writeFile } from 'node:fs/promises'\nexport async function rewriteFile(path: string) { execFileSync('echo', ['changed']); await writeFile(path, 'changed') }\n",
      "utf8"
    );

    const needsProof = await postEditReviewQuery(repo, { taskId: "planned-high-risk-edit", ranTests: [] }, { autoRefresh: true });
    const needsProofData = needsProof.data as {
      verdict: string;
      unplannedEditedFiles: string[];
      riskEscalations: Array<{ path: string }>;
      riskEscalationsNeedInspection: boolean;
      missedLikelyTests: Array<{ path: string }>;
    };
    expect(needsProofData.unplannedEditedFiles).toEqual([]);
    expect(needsProofData.riskEscalations.map((file) => file.path)).toContain("src/ops.ts");
    expect(needsProofData.riskEscalationsNeedInspection).toBe(true);
    expect(needsProofData.verdict).toBe("inspect");
    expect(needsProofData.missedLikelyTests.map((test) => test.path)).toContain("tests/manual_ops_regression.ts");

    const afterProof = await postEditReviewQuery(
      repo,
      {
        taskId: "planned-high-risk-edit",
        ranTests: needsProofData.missedLikelyTests.map((test) => test.path)
      },
      { autoRefresh: false }
    );
    const afterProofData = afterProof.data as {
      verdict: string;
      testsNotRun: unknown[];
      missedLikelyTests: unknown[];
      riskEscalations: Array<{ path: string }>;
      riskEscalationsCoveredByVerification: boolean;
      riskEscalationsNeedInspection: boolean;
      workflowChecks: Array<{ status: string }>;
      dependencyChecks: Array<{ status: string }>;
      driftReasons: string[];
    };
    expect(afterProofData.riskEscalations.map((file) => file.path)).toContain("src/ops.ts");
    expect(afterProofData.riskEscalationsCoveredByVerification).toBe(true);
    expect(afterProofData.riskEscalationsNeedInspection).toBe(false);
    expect(afterProofData.verdict).toBe("continue");
    expect(afterProofData.testsNotRun).toEqual([]);
    expect(afterProofData.missedLikelyTests).toEqual([]);
    expect(afterProofData.workflowChecks.every((check) => check.status === "covered")).toBe(true);
    expect(afterProofData.dependencyChecks.every((check) => check.status === "covered")).toBe(true);
    expect(afterProofData.driftReasons.some((reason) => reason.includes("high-risk"))).toBe(false);
  });
});
