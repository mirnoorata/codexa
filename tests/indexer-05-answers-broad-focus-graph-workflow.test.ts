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
it("answers broad focus, graph, workflow, dependency, and change-plan queries", async () => {
    const repo = await createFixtureRepo();
    await buildIndex({ repoRoot: repo });

    const focus = await focusBriefQuery(repo, { task: "How does route normalization workflow work?", diff: false, limit: 6, tokenBudget: 1200 }, { autoRefresh: false });
    expect(focus.text).toContain("Codexa focus brief");
    expect(focus.text).toContain("Recommended next MCP call: workflow_path");
    expect((focus.data as { focusFiles: Array<{ path: string }> }).focusFiles.map((file) => file.path)).toContain("service/app.py");
    expect((focus.data as { quality: { counts: { derived: number } } }).quality.counts.derived).toBeGreaterThan(0);

    const fallbackFocus = await focusBriefQuery(repo, { task: "narlple frondicate zindle", diff: false, limit: 4, tokenBudget: 900 }, { autoRefresh: false });
    expect((fallbackFocus.data as { quality: { counts: { fallback: number; derived: number } } }).quality.counts.fallback).toBeGreaterThan(0);
    expect((fallbackFocus.data as { quality: { counts: { fallback: number; derived: number } } }).quality.counts.derived).toBe(0);

    const ambiguousEdit = await taskBriefQuery(repo, { task: "Change behavior safely", diff: false, limit: 6, tokenBudget: 1200 }, { autoRefresh: false });
    const ambiguousData = ambiguousEdit.data as {
      packetVerdict?: string;
      actionability?: string;
      intentConfidence?: { editReady: boolean; anchors: string[]; missingAnchors: string[] };
      quality?: { level: string; reasons: string[] };
    };
    expect(["raw-search-better", "needs-target"]).toContain(ambiguousData.packetVerdict);
    expect(["raw_search_better", "needs_target"]).toContain(ambiguousData.actionability);
    expect(ambiguousData.intentConfidence?.editReady).toBe(false);
    expect(ambiguousData.intentConfidence?.anchors.every((anchor) => !anchor.includes("test"))).toBe(true);
    expect(ambiguousData.packetVerdict).not.toBe("edit-ready");
    expect(["low", "medium"]).toContain(ambiguousData.quality?.level);
    expect(ambiguousEdit.text).toContain("Recommended next MCP call: search");

    const ambiguousPlan = await changePlanQuery(
      repo,
      {
        task: "Change behavior safely",
        diff: false,
        limit: 6,
        tokenBudget: 1200,
        saveSnapshot: true,
        taskId: "ambiguous-change-plan"
      },
      { autoRefresh: false }
    );
    const ambiguousPlanData = ambiguousPlan.data as {
      editReadiness?: { editable: boolean; status: string; snapshotBlocked: boolean };
      plannedEditTargets?: string[];
      tests?: unknown[];
      snapshot?: unknown;
      snapshotBlock?: { taskId: string; path: string };
      targetCandidates?: Array<{
        candidateId: string;
        rank: number;
        kind: "file" | "symbol";
        path: string;
        score: number;
        validationStatus: "edit-ready" | "needs-more-context" | "weak";
        validationReasons: string[];
        wouldPlanEditTargets: string[];
        wouldRecommendTests: string[];
        candidateRisk: { score: number; reasons: string[] };
        evidence: string[];
        missingAnchors: string[];
        nextChangePlanArgs: { task?: string; files?: string[]; symbols?: string[]; query?: string; taskId?: string; changeType?: "style" | "api" | "behavior" | "rename" | "delete" | "unknown"; diff?: boolean; saveSnapshot: boolean };
        rawSearchQueries: string[];
      }>;
    };
    expect(ambiguousPlan.text).toContain("Edit readiness: orientation-only");
    expect(ambiguousPlan.text).toContain("Task snapshot: not saved");
    expect(ambiguousPlan.text).toContain("Target candidates:");
    expect(ambiguousPlanData.editReadiness).toMatchObject({ editable: false, status: "orientation-only", snapshotBlocked: true });
    expect(ambiguousPlanData.plannedEditTargets).toEqual([]);
    expect(ambiguousPlanData.tests).toEqual([]);
    expect(ambiguousPlanData.snapshot).toBeUndefined();
    expect(ambiguousPlanData.targetCandidates?.length).toBeGreaterThan(0);
    expect(ambiguousPlanData.targetCandidates?.[0]).toMatchObject({
      candidateId: expect.stringMatching(/^candidate-/),
      rank: 1,
      path: expect.any(String),
      validationStatus: "edit-ready",
      validationReasons: expect.any(Array),
      wouldPlanEditTargets: expect.any(Array),
      wouldRecommendTests: expect.any(Array),
      candidateRisk: expect.objectContaining({ score: expect.any(Number), reasons: expect.any(Array) }),
      evidence: expect.any(Array),
      missingAnchors: expect.arrayContaining(["file-or-symbol-target"]),
      nextChangePlanArgs: expect.objectContaining({ saveSnapshot: true, taskId: "ambiguous-change-plan" })
    });
    const validationRanks = { "edit-ready": 0, weak: 1, "needs-more-context": 2 };
    const candidateValidationOrder = (ambiguousPlanData.targetCandidates ?? []).map((candidate) => validationRanks[candidate.validationStatus]);
    expect(candidateValidationOrder).toEqual([...candidateValidationOrder].sort((left, right) => left - right));
    const candidateIds = (ambiguousPlanData.targetCandidates ?? []).map((candidate) => candidate.candidateId);
    expect(new Set(candidateIds).size).toBe(candidateIds.length);
    expect(
      Boolean(ambiguousPlanData.targetCandidates?.[0]?.nextChangePlanArgs.files?.length) ||
        Boolean(ambiguousPlanData.targetCandidates?.[0]?.nextChangePlanArgs.symbols?.length)
    ).toBe(true);
    expect(ambiguousPlanData.targetCandidates?.[0]?.evidence.length).toBeGreaterThan(0);
    expect(ambiguousPlanData.targetCandidates?.[0]?.validationReasons.some((reason) => reason.includes("target resolves"))).toBe(true);
    expect(ambiguousPlanData.targetCandidates?.[0]?.wouldPlanEditTargets.length).toBeGreaterThan(0);
    expect(Array.isArray(ambiguousPlanData.targetCandidates?.[0]?.wouldRecommendTests)).toBe(true);
    expect(ambiguousPlanData.targetCandidates?.[0]?.rawSearchQueries.length).toBeGreaterThan(0);
    expect(ambiguousPlanData.snapshotBlock).toMatchObject({
      taskId: "ambiguous-change-plan",
      path: ".codex/cache/codexa-tasks/ambiguous-change-plan.blocked.json"
    });
    await expect(readFile(path.join(repo, ".codex/cache/codexa-tasks/ambiguous-change-plan.json"), "utf8")).rejects.toThrow();
    const ambiguousLatest = JSON.parse(await readFile(path.join(repo, ".codex/cache/codexa-tasks/latest.json"), "utf8")) as {
      taskId: string;
      path: string;
      blocked: boolean;
    };
    expect(ambiguousLatest).toMatchObject({
      taskId: "ambiguous-change-plan",
      path: "ambiguous-change-plan.blocked.json",
      blocked: true
    });
    const followedCandidate = ambiguousPlanData.targetCandidates?.[0];
    expect(followedCandidate).toBeDefined();
    expect(followedCandidate?.candidateId).toMatch(/^candidate-/);
    expect(followedCandidate?.validationStatus).toBe("edit-ready");
    const followedPlan = await changePlanQuery(
      repo,
      {
        taskId: "ambiguous-change-plan",
        followCandidate: followedCandidate!.candidateId,
        saveSnapshot: true
      },
      { autoRefresh: false }
    );
    const followedPlanData = followedPlan.data as {
      editReadiness?: { editable: boolean; status: string };
      followCandidate?: { status: string; candidateId: string; plannedEditTargets: string[] };
      snapshot?: { taskId: string };
      plannedEditTargets?: string[];
      targetCandidates?: unknown[];
    };
    expect(followedPlan.text).toContain(`Follow candidate: accepted ${followedCandidate?.candidateId}`);
    expect(followedPlanData.editReadiness).toMatchObject({ editable: true, status: "edit-ready" });
    expect(followedPlanData.followCandidate).toMatchObject({ status: "accepted", candidateId: followedCandidate?.candidateId });
    expect(followedPlanData.snapshot?.taskId).toBe("ambiguous-change-plan");
    expect(followedPlanData.plannedEditTargets).toEqual(followedCandidate?.wouldPlanEditTargets);
    expect(followedPlanData.followCandidate?.plannedEditTargets).toEqual(followedCandidate?.wouldPlanEditTargets);
    expect(followedPlanData.targetCandidates).toEqual([]);
    await expect(readFile(path.join(repo, ".codex/cache/codexa-tasks/ambiguous-change-plan.blocked.json"), "utf8")).rejects.toThrow();
    const followedLatest = JSON.parse(await readFile(path.join(repo, ".codex/cache/codexa-tasks/latest.json"), "utf8")) as {
      taskId: string;
      path: string;
      blocked?: boolean;
    };
    expect(followedLatest).toMatchObject({
      taskId: "ambiguous-change-plan",
      path: "ambiguous-change-plan.json"
    });
    expect(followedLatest.blocked).toBeUndefined();

    const symbolCandidate = ambiguousPlanData.targetCandidates?.find((candidate) => candidate.kind === "symbol" && candidate.validationStatus === "edit-ready");
    expect(symbolCandidate).toBeDefined();
    const followedSymbolPlan = await changePlanQuery(
      repo,
      {
        task: symbolCandidate?.nextChangePlanArgs.task,
        symbols: symbolCandidate?.nextChangePlanArgs.symbols,
        query: symbolCandidate?.nextChangePlanArgs.query,
        taskId: "ambiguous-change-plan-symbol",
        changeType: symbolCandidate?.nextChangePlanArgs.changeType,
        diff: symbolCandidate?.nextChangePlanArgs.diff,
        saveSnapshot: true
      },
      { autoRefresh: false }
    );
    const followedSymbolData = followedSymbolPlan.data as {
      editReadiness?: { editable: boolean; status: string };
      plannedEditTargets?: string[];
      targetCandidates?: unknown[];
      snapshot?: { taskId: string };
    };
    expect(followedSymbolData.editReadiness).toMatchObject({ editable: true, status: "edit-ready" });
    expect(followedSymbolData.plannedEditTargets).toEqual(symbolCandidate?.wouldPlanEditTargets);
    expect(followedSymbolData.targetCandidates).toEqual([]);
    expect(followedSymbolData.snapshot?.taskId).toBe("ambiguous-change-plan-symbol");

    const generatedIdPlan = await changePlanQuery(
      repo,
      {
        task: "Retarget behavior safely",
        changeType: "behavior",
        diff: false,
        limit: 6,
        tokenBudget: 1200,
        saveSnapshot: true
      },
      { autoRefresh: false }
    );
    const generatedIdData = generatedIdPlan.data as {
      snapshotBlock?: { taskId: string; path: string };
      targetCandidates?: Array<{
        candidateId: string;
        validationStatus: "edit-ready" | "needs-more-context" | "weak";
        wouldPlanEditTargets: string[];
        nextChangePlanArgs: { task?: string; files?: string[]; symbols?: string[]; query?: string; taskId?: string; changeType?: "style" | "api" | "behavior" | "rename" | "delete" | "unknown"; diff?: boolean; saveSnapshot: boolean };
      }>;
    };
    const generatedTaskId = generatedIdData.snapshotBlock?.taskId;
    expect(generatedTaskId).toBeTruthy();
    expect(generatedIdData.targetCandidates?.[0]?.nextChangePlanArgs.taskId).toBe(generatedTaskId);
    const generatedBlockPath = generatedIdData.snapshotBlock?.path;
    expect(generatedBlockPath).toBeTruthy();
    const generatedCandidate = generatedIdData.targetCandidates?.[0];
    expect(generatedCandidate?.candidateId).toMatch(/^candidate-/);
    expect(generatedCandidate?.validationStatus).toBe("edit-ready");
    expect(generatedCandidate?.wouldPlanEditTargets.length).toBeGreaterThan(0);
    const generatedFollowedOutput = execFileSync(
      process.execPath,
      [path.join(process.cwd(), "dist/cli.js"), "change-plan", repo, "--task-id", generatedTaskId!, "--follow-candidate", generatedCandidate!.candidateId, "--no-auto-refresh"],
      { encoding: "utf8" }
    );
    expect(generatedFollowedOutput).toContain(`Follow candidate: accepted ${generatedCandidate?.candidateId}`);
    expect(generatedFollowedOutput).toContain(`Task snapshot: ${generatedTaskId}`);
    const generatedFollowedSnapshot = JSON.parse(await readFile(path.join(repo, ".codex/cache/codexa-tasks", `${generatedTaskId}.json`), "utf8")) as {
      changeType: string;
      input: { changeType?: string; diff?: boolean };
    };
    expect(generatedFollowedSnapshot.changeType).toBe("behavior");
    expect(generatedFollowedSnapshot.input).toMatchObject({ changeType: "behavior", diff: false });
    await expect(readFile(path.join(repo, generatedBlockPath ?? ""), "utf8")).rejects.toThrow();

    const weakCandidatePlan = await changePlanQuery(
      repo,
      {
        task: "narlple frondicate zindle",
        diff: false,
        limit: 4,
        tokenBudget: 900
      },
      { autoRefresh: false }
    );
    const weakCandidateData = weakCandidatePlan.data as {
      targetCandidates?: Array<{ candidateId: string; validationStatus: "edit-ready" | "needs-more-context" | "weak"; validationReasons: string[] }>;
    };
    expect(weakCandidateData.targetCandidates?.some((candidate) => candidate.validationStatus === "weak" && candidate.validationReasons.includes("candidate evidence is fallback"))).toBe(true);
    const weakCandidate = weakCandidateData.targetCandidates?.find((candidate) => candidate.validationStatus === "weak");
    expect(weakCandidate?.candidateId).toMatch(/^candidate-/);
    const rejectedWeakFollow = await changePlanQuery(
      repo,
      {
        task: "narlple frondicate zindle",
        diff: false,
        limit: 4,
        tokenBudget: 900,
        followCandidate: weakCandidate!.candidateId
      },
      { autoRefresh: false }
    );
    const rejectedWeakFollowData = rejectedWeakFollow.data as {
      followCandidate?: { status: string; requested: string; reason: string };
      snapshot?: unknown;
      plannedEditTargets?: string[];
    };
    expect(rejectedWeakFollowData.followCandidate).toMatchObject({
      status: "rejected",
      requested: weakCandidate?.candidateId
    });
    expect(rejectedWeakFollowData.followCandidate?.reason).toContain("weak");
    expect(rejectedWeakFollowData.snapshot).toBeUndefined();
    expect(rejectedWeakFollowData.plannedEditTargets).toEqual([]);

    const exactFocus = await focusBriefQuery(repo, { task: "Fix src/api.ts handleThing", diff: false, limit: 4, tokenBudget: 900 }, { autoRefresh: false });
    expect((exactFocus.data as { focusFiles: Array<{ path: string }>; quality: { counts: { derived: number } } }).focusFiles.map((file) => file.path)).toContain("src/api.ts");
    expect((exactFocus.data as { quality: { counts: { derived: number } } }).quality.counts.derived).toBeGreaterThan(0);

    const pathAliasFocus = await focusBriefQuery(repo, { task: "Fix TypeScript path alias configuration", diff: false, limit: 4, tokenBudget: 900 }, { autoRefresh: false });
    expect((pathAliasFocus.data as { retrieval: { intents: string[] }; nextCall: { tool: string } }).retrieval.intents).not.toContain("workflow");
    expect((pathAliasFocus.data as { retrieval: { intents: string[] }; nextCall: { tool: string } }).nextCall.tool).not.toBe("workflow_path");

    const callers = await callersQuery(repo, { symbol: "normalize", limit: 20 }, { autoRefresh: false });
    expect(callers.text).toContain("Callers/importers");
    expect(callers.text).toContain("service/app.py");
    expect((callers.data as { edges: Array<{ edgeKind: string }> }).edges.some((edge) => edge.edgeKind === "CALLS" || edge.edgeKind === "REFERENCES")).toBe(true);

    const callees = await calleesQuery(repo, { symbol: "route_thing", limit: 20 }, { autoRefresh: false });
    expect(callees.text).toContain("Callees/dependencies");
    expect(callees.text).toContain("normalize");

    const dependency = await dependencyPathQuery(repo, { fromSymbol: "route_thing", toSymbol: "normalize", maxDepth: 4 }, { autoRefresh: false });
    expect(dependency.text).toContain("Dependency path");
    expect((dependency.data as { path: unknown[] }).path.length).toBeGreaterThan(0);

    const importOnlyCallers = await callersQuery(repo, { symbol: "helper", limit: 40 }, { autoRefresh: false });
    expect(importOnlyCallers.text).toContain("src/import-only.ts");

    const importOnlyDependency = await dependencyPathQuery(repo, { fromSymbol: "helper", toFile: "src/import-only.ts", maxDepth: 4 }, { autoRefresh: false });
    expect((importOnlyDependency.data as { path: unknown[] }).path.length).toBeGreaterThan(0);

    const endpointDependency = await dependencyPathQuery(repo, { fromFile: "web/src/query-client.ts", toSymbol: "route_query", maxDepth: 4 }, { autoRefresh: false });
    expect((endpointDependency.data as { path: unknown[] }).path.length).toBeGreaterThan(0);

    const workflow = await workflowPathQuery(repo, { query: "route normalization workflow", limit: 5 }, { autoRefresh: false });
    expect(workflow.text).toContain("route route_thing");
    expect(workflow.text).toContain("tests/test_app.py");
    expect(workflow.text).toContain("Core path files:");
    const workflowData = workflow.data as { files: string[]; relatedFiles: string[]; tests: string[] };
    expect(workflowData.files).toContain("service/app.py");
    expect(workflowData.files).toContain("service/store.py");
    expect(workflowData.files).not.toContain("tests/test_app.py");
    expect(workflowData.tests).toContain("tests/test_app.py");

    const specificWorkflow = await workflowPathQuery(repo, { query: "route_thing retries", limit: 5 }, { autoRefresh: false });
    expect(specificWorkflow.text).toContain("route route_thing");

    const routeWorkflow = await workflowPathQuery(repo, { symbol: "route_query", limit: 5 }, { autoRefresh: false });
    expect(routeWorkflow.text).toContain("route route_query");
    expect(routeWorkflow.text).not.toContain("route route_thing");

    const plan = await changePlanQuery(repo, { task: "Change route normalization safely", files: ["service/helpers.py"], diff: false, limit: 6 }, { autoRefresh: false });
    expect(plan.text).toContain("Codexa change plan");
    const planData = plan.data as {
      editReadiness?: { editable: boolean; status: string };
      targetCandidates?: unknown[];
      complexityReview?: { status: string; blocking: boolean; invariants: string[] };
    };
    expect(planData.editReadiness).toMatchObject({ editable: true, status: "edit-ready" });
    expect(planData.targetCandidates).toEqual([]);
    expect(planData.complexityReview).toMatchObject({ status: "lean", blocking: false });
    expect(planData.complexityReview?.invariants.some((invariant) => invariant.includes("security"))).toBe(true);
    expect(plan.text).toContain("Complexity review:");
    expect(plan.text).toContain("Read first:");
    expect(plan.text).toContain("tests/test_app.py");
  });

it("adds advisory complexity review signals to change plans for manifest-scoped edits", async () => {
    const repo = await createFixtureRepo();
    await buildIndex({ repoRoot: repo });

    const plan = await changePlanQuery(
      repo,
      {
        task: "Add a package helper dependency only if needed",
        files: ["package.json"],
        diff: false,
        limit: 6
      },
      { autoRefresh: false }
    );

    const data = plan.data as {
      complexityReview?: {
        status: string;
        blocking: boolean;
        items: Array<{ kind: string; severity: string; paths?: string[]; message: string }>;
      };
    };
    expect(plan.text).toContain("Complexity review:");
    expect(data.complexityReview).toMatchObject({ status: "review", blocking: false });
    expect(data.complexityReview?.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "existing-dependency",
          severity: "review",
          paths: expect.arrayContaining(["package.json"])
        })
      ])
    );
  });

it("adds advisory complexity review signals to post-edit reviews for manifest changes", async () => {
    const repo = await createFixtureRepo();
    await buildIndex({ repoRoot: repo });
    await changePlanQuery(
      repo,
      {
        task: "Change package manifest only if needed",
        files: ["package.json"],
        diff: false,
        limit: 6,
        saveSnapshot: true,
        taskId: "manifest-complexity-review"
      },
      { autoRefresh: false }
    );
    const manifestPath = path.join(repo, "package.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { dependencies: Record<string, string> };
    manifest.dependencies.leftpad = "^1.3.0";
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

    const review = await postEditReviewQuery(repo, { taskId: "manifest-complexity-review", ranCommands: ["npm test"], persistOutcome: false }, { autoRefresh: true });
    const data = review.data as {
      complexityReview?: {
        status: string;
        blocking: boolean;
        items: Array<{ kind: string; severity: string; paths?: string[]; message: string }>;
      };
    };
    expect(review.text).toContain("Complexity review:");
    expect(data.complexityReview).toMatchObject({ status: "review", blocking: false });
    expect(data.complexityReview?.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "existing-dependency",
          severity: "review",
          paths: expect.arrayContaining(["package.json"])
        })
      ])
    );
  });

it("saves task snapshots and reports post-edit drift against the actual dirty tree", async () => {
    const repo = await createFixtureRepo();
    await buildIndex({ repoRoot: repo });

    const plan = await changePlanQuery(
      repo,
      {
        task: "Change route normalization safely",
        files: ["service/helpers.py"],
        diff: false,
        limit: 6,
        saveSnapshot: true,
        taskId: "fixture-normalize"
      },
      { autoRefresh: false }
    );
    expect(plan.text).toContain("Task snapshot: fixture-normalize");
    expect((plan.data as { snapshot?: { taskId: string; plannedEditTargets: string[] } }).snapshot?.plannedEditTargets).toContain("service/helpers.py");
    const savedPlanSnapshot = JSON.parse(await readFile(path.join(repo, ".codex/cache/codexa-tasks/fixture-normalize.json"), "utf8")) as {
      requiredWorkflowChecks: unknown[];
      requiredDependencyChecks: unknown[];
    };
    expect(JSON.stringify(savedPlanSnapshot)).toContain("symbolBaseline");
    expect(JSON.stringify(savedPlanSnapshot)).not.toContain(repo);
    expect(savedPlanSnapshot.requiredWorkflowChecks.length).toBeGreaterThan(0);
    expect(savedPlanSnapshot.requiredDependencyChecks.length).toBeGreaterThan(0);

    await changePlanQuery(
      repo,
      {
        task: "Change route normalization safely",
        files: ["service/helpers.py"],
        diff: false,
        limit: 6,
        saveSnapshot: true,
        taskId: "reused-task-id"
      },
      { autoRefresh: false }
    );
    const reusedSnapshotText = await readFile(path.join(repo, ".codex/cache/codexa-tasks/reused-task-id.json"), "utf8");
    const reusedSnapshot = JSON.parse(reusedSnapshotText) as { createdAt: string };
    await mkdir(path.join(repo, ".codex/cache/codexa-task-snapshots"), { recursive: true });
    await writeFile(path.join(repo, ".codex/cache/codexa-task-snapshots/reused-task-id.json"), reusedSnapshotText, "utf8");
    await writeFile(
      path.join(repo, ".codex/cache/codexa-task-snapshots/latest.json"),
      `${JSON.stringify({ schemaVersion: 1, taskId: "reused-task-id", path: "reused-task-id.json", createdAt: reusedSnapshot.createdAt })}\n`,
      "utf8"
    );
    await changePlanQuery(
      repo,
      {
        task: "Change behavior safely",
        diff: false,
        limit: 6,
        tokenBudget: 1200,
        saveSnapshot: true,
        taskId: "reused-task-id"
      },
      { autoRefresh: false }
    );
    await expect(readFile(path.join(repo, ".codex/cache/codexa-tasks/reused-task-id.json"), "utf8")).rejects.toThrow();
    const reusedTaskReview = await postEditReviewQuery(repo, { taskId: "reused-task-id", ranTests: [], persistOutcome: false }, { autoRefresh: false });
    const reusedTaskData = reusedTaskReview.data as {
      snapshot?: unknown;
      snapshotLoad: { taskId?: string; missingReason?: string };
    };
    expect(reusedTaskData.snapshot).toBeUndefined();
    expect(reusedTaskData.snapshotLoad).toMatchObject({ taskId: "reused-task-id", missingReason: "blocked-plan" });

    await writeFile(path.join(repo, ".codex/cache/codexa-tasks/reused-task-id.blocked.json"), "{not json", "utf8");
    const malformedBlockedReview = await postEditReviewQuery(repo, { taskId: "reused-task-id", ranTests: [], persistOutcome: false }, { autoRefresh: false });
    const malformedBlockedReviewData = malformedBlockedReview.data as {
      snapshot?: unknown;
      snapshotLoad: { taskId?: string; missingReason?: string; path?: string };
    };
    expect(malformedBlockedReviewData.snapshot).toBeUndefined();
    expect(malformedBlockedReviewData.snapshotLoad).toMatchObject({ taskId: "reused-task-id", missingReason: "invalid-json" });
    expect(malformedBlockedReviewData.snapshotLoad.path).toContain("reused-task-id.blocked.json");
    await rm(path.join(repo, ".codex/cache/codexa-tasks/reused-task-id.blocked.json"), { force: true });

    await writeFile(
      path.join(repo, ".codex/cache/codexa-tasks/invalid-replay-input.blocked.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        kind: "change-plan-snapshot-blocked",
        taskId: "invalid-replay-input",
        input: { limit: 3 },
        reason: "invalid replay input"
      })}\n`,
      "utf8"
    );
    const invalidReplayFollow = await changePlanQuery(
      repo,
      { taskId: "invalid-replay-input", followCandidate: "candidate-invalid-replay" },
      { autoRefresh: false }
    );
    const invalidReplayFollowData = invalidReplayFollow.data as { followCandidate?: { status: string; requested: string; reason: string } };
    expect(invalidReplayFollow.text).toContain("Follow candidate: rejected");
    expect(invalidReplayFollowData.followCandidate).toMatchObject({ status: "rejected", requested: "candidate-invalid-replay" });
    expect(invalidReplayFollowData.followCandidate?.reason).toContain("does not include replayable input");

    const blockedPlan = await changePlanQuery(
      repo,
      {
        task: "Change behavior safely",
        diff: false,
        limit: 6,
        tokenBudget: 1200,
        saveSnapshot: true,
        taskId: "blocked-after-valid"
      },
      { autoRefresh: false }
    );
    expect(blockedPlan.text).toContain("Edit readiness: orientation-only");
    await expect(readFile(path.join(repo, ".codex/cache/codexa-tasks/blocked-after-valid.json"), "utf8")).rejects.toThrow();
    const blockedReview = await postEditReviewQuery(repo, { ranTests: [], persistOutcome: false }, { autoRefresh: false });
    const blockedReviewData = blockedReview.data as {
      snapshot?: unknown;
      snapshotLoad: { taskId?: string; missingReason?: string; error?: string };
      outcome: { persisted: boolean };
    };
    expect(blockedReview.text).toContain("Snapshot: unavailable (blocked-plan)");
    expect(blockedReviewData.snapshot).toBeUndefined();
    expect(blockedReviewData.snapshotLoad).toMatchObject({ taskId: "blocked-after-valid", missingReason: "blocked-plan" });
    expect(blockedReviewData.snapshotLoad.error).toBeTruthy();
    expect(blockedReviewData.outcome.persisted).toBe(false);

    await recordSessionMemory({
      repoRoot: repo,
      taskId: "blocked-after-valid",
      freshness: blockedPlan.freshness,
      entries: [
        {
          kind: "decision",
          key: "decision:blocked-task",
          summary: "blocked-after-valid memory stays task-scoped.",
          provenance: "agent-asserted",
          confidence: "derived",
          evidenceTier: "derived",
          scope: { files: [] }
        }
      ]
    });
    await recordSessionMemory({
      repoRoot: repo,
      taskId: "unrelated-task",
      freshness: blockedPlan.freshness,
      entries: [
        {
          kind: "decision",
          key: "decision:unrelated-task",
          summary: "unrelated memory should not leak into blocked review.",
          provenance: "agent-asserted",
          confidence: "derived",
          evidenceTier: "derived",
          scope: { files: [] }
        }
      ]
    });
    const blockedMemoryReview = await postEditReviewQuery(repo, { ranTests: [], persistOutcome: false }, { autoRefresh: false });
    expect(blockedMemoryReview.text).toContain("blocked-after-valid memory stays task-scoped");
    expect(blockedMemoryReview.text).not.toContain("unrelated memory should not leak");

    await writeFile(path.join(repo, ".codex/cache/codexa-tasks/latest.json"), "{not json", "utf8");
    const recoveredBlocked = await postEditReviewQuery(repo, { ranTests: [], persistOutcome: false }, { autoRefresh: false });
    const recoveredBlockedData = recoveredBlocked.data as {
      snapshot?: unknown;
      snapshotLoad: { taskId?: string; missingReason?: string; recoveredLatest?: boolean };
    };
    expect(recoveredBlockedData.snapshot).toBeUndefined();
    expect(recoveredBlockedData.snapshotLoad).toMatchObject({
      taskId: "blocked-after-valid",
      missingReason: "blocked-plan",
      recoveredLatest: true
    });

    await changePlanQuery(
      repo,
      {
        task: "Change route normalization safely",
        files: ["service/helpers.py"],
        diff: false,
        limit: 6,
        saveSnapshot: true,
        taskId: "fixture-normalize"
      },
      { autoRefresh: false }
    );

    await writeFile(path.join(repo, "service/helpers.py"), "def normalize(value):\n    return value.strip().lower()\n", "utf8");
    await writeFile(
      path.join(repo, "src/ops.ts"),
      "import { execFileSync } from 'node:child_process'\nexport function risky() { execFileSync('echo', ['changed']) }\n",
      "utf8"
    );

    const review = await postEditReviewQuery(repo, { taskId: "fixture-normalize", ranTests: [] }, { autoRefresh: true });
    expect(review.text).toContain("Codexa post-edit review");
    expect(review.text).toContain("auto-refreshed from dirty-files-changed");
    expect(review.text).toContain("service/helpers.py");
    expect(review.text).toContain("src/ops.ts");
    expect(review.text).toContain("Changed files grouped by module:");
    expect(review.text).toContain("Planned edit targets:");
    expect(review.text).toContain("Symbol delta:");
    expect(review.text).toContain("Risk deltas:");
    expect(review.text).toContain("Affected tests/workflows:");
    expect(review.text).toContain("Unplanned edited files: src/ops.ts");
    expect(review.text).toContain("tests/test_app.py");
    expect(review.text).toContain("Tests still unaccounted for");
    const reviewData = review.data as {
      verdict: string;
      inspectMode: string;
      completionAuthority: string;
      unplannedEditedFiles: string[];
      tests: Array<{ path: string }>;
      symbolDeltas: unknown[];
      riskDeltas: unknown[];
      changedGroups: unknown[];
      snapshotLoad: { missingReason?: string };
      modifiedSymbols: string[];
      modifiedPublicSymbols: string[];
      missedLikelyTests: Array<{ path: string }>;
      workflowChecks: Array<{ status: string }>;
      dependencyChecks: Array<{ status: string }>;
      outcome: {
        path: string;
        verdict: string;
        inspectMode: string;
        completionAuthority: string;
        calibrationLabels: string[];
        testsNotRun: Array<{ path: string }>;
        modifiedSymbols: string[];
        modifiedPublicSymbols: string[];
        missedLikelyTests: Array<{ path: string }>;
        hookSummary: { verdict: string; missedLikelyTests: number };
      };
    };
    expect(reviewData.verdict).not.toBe("continue");
    expect(reviewData.inspectMode).toBe("blocking");
    expect(reviewData.completionAuthority).toBe("blocking_inspect");
    expect(reviewData.outcome.verdict).toBe(reviewData.verdict);
    expect(reviewData.outcome.inspectMode).toBe("blocking");
    expect(reviewData.outcome.completionAuthority).toBe("blocking_inspect");
    expect(reviewData.outcome.path).toMatch(/^\.codex\/cache\/codexa-outcomes\/.+\.json$/u);
    expect(reviewData.outcome.calibrationLabels).toContain("unplanned-edits");
    expect(reviewData.outcome.calibrationLabels).toContain("blocking-inspection");
    expect(reviewData.outcome.calibrationLabels).toContain("modified-public-symbols");
    expect(reviewData.outcome.testsNotRun.some((test) => test.path === "tests/test_app.py")).toBe(true);
    expect(reviewData.outcome.missedLikelyTests.some((test) => test.path === "tests/test_app.py")).toBe(true);
    expect(reviewData.outcome.modifiedSymbols.length).toBeGreaterThan(0);
    expect(reviewData.outcome.modifiedSymbols.some((symbol) => symbol.includes("normalize"))).toBe(true);
    expect(reviewData.outcome.hookSummary.verdict).toBe(reviewData.verdict);
    expect(reviewData.missedLikelyTests.some((test) => test.path === "tests/test_app.py")).toBe(true);
    expect(reviewData.workflowChecks.length).toBeGreaterThan(0);
    expect(reviewData.dependencyChecks.length).toBeGreaterThan(0);
    const persistedOutcomeText = await readFile(path.join(repo, reviewData.outcome.path), "utf8");
    expect(JSON.parse(persistedOutcomeText).verdict).toBe(reviewData.verdict);
    expect(persistedOutcomeText).not.toContain(repo);
    expect(reviewData.unplannedEditedFiles).toContain("src/ops.ts");
    expect(reviewData.tests.some((test) => test.path === "tests/test_app.py")).toBe(true);
    expect(reviewData.changedGroups.length).toBeGreaterThan(0);
    expect(reviewData.riskDeltas.length).toBeGreaterThan(0);
    expect(reviewData.snapshotLoad.missingReason).toBeUndefined();

    await writeFile(path.join(repo, ".codex/cache/codexa-tasks/latest.json"), "{not json", "utf8");
    const recovered = await postEditReviewQuery(repo, { ranTests: [] }, { autoRefresh: false });
    expect((recovered.data as { snapshotLoad: { recoveredLatest?: boolean; missingReason?: string } }).snapshotLoad.recoveredLatest).toBe(true);
    expect((recovered.data as { snapshotLoad: { recoveredLatest?: boolean; missingReason?: string } }).snapshotLoad.missingReason).toBeUndefined();

    await writeFile(
      path.join(repo, ".codex/cache/codexa-tasks/latest.json"),
      JSON.stringify({ schemaVersion: 1, taskId: "missing-task", path: "missing-task.json", createdAt: new Date().toISOString() }),
      "utf8"
    );
    const recoveredMissingTarget = await postEditReviewQuery(repo, { ranTests: [] }, { autoRefresh: false });
    expect((recoveredMissingTarget.data as { snapshotLoad: { recoveredLatest?: boolean; missingReason?: string } }).snapshotLoad.recoveredLatest).toBe(true);
    expect((recoveredMissingTarget.data as { snapshotLoad: { recoveredLatest?: boolean; missingReason?: string } }).snapshotLoad.missingReason).toBeUndefined();
  });
});
