import path from "node:path";
import { formatGaps } from "./diff.js";
import { buildPlanComplexityReview, formatComplexityReview } from "./complexity.js";
import { nextTool } from "./next-tools.js";
import { contextPackQuery } from "./context.js";
import { formatContextQuality, type ContextQuality } from "./quality.js";
import {
  assertFreshnessAuthorityCurrent,
  FreshnessAuthorityChangedError,
  freshnessAuthorityBlockReason,
  freshnessBanner
} from "./runtime.js";
import { ensureQuerySession, type QuerySession, type QuerySessionInput } from "./session.js";
import { normalizeSearchText } from "./search.js";
import { formatTestRecommendations, recommendTests, uniqueTests } from "./tests.js";
import { findFile, normalizeInputPaths, resolveFileTarget, resolveSymbolTarget } from "./targets.js";
import { compactSnapshotTests, snapshotRiskBaseline, snapshotSymbolBaseline } from "./post-edit/snapshot-contract.js";
import { pointerForSessionMemory } from "../session-memory.js";
import { allocateTaskSnapshotId, loadTaskSnapshot, saveBlockedTaskSnapshot, saveTaskSnapshot, type TaskSnapshotLoadResult } from "../task-snapshots.js";
import type {
  ChangedFileEntry,
  ChangePlanInput,
  ChangeType,
  CodexaIndex,
  EvidenceTier,
  FileFact,
  GraphEdgeFact,
  QueryOptions,
  QueryResult,
  RefreshInfo,
  SymbolFact,
  TaskInvariant,
  TaskSnapshotRequiredCheck,
  TestRecommendation,
  TestRecommendationProvenance,
  WorkflowTraceFact,
  FreshnessInfo
} from "../types.js";
import { limitText, stableId, uniqueSorted } from "../util.js";
import { formatRequiredChecks, requiredDependencyChecksForPlan, requiredWorkflowChecksForPlan } from "./change-plan/checks.js";
import { getDiffFootprint } from "./worktree.js";
import { formatTaskInvariants, nextTaskPlanLifecycle } from "../task-lifecycle.js";
import { changePlanEditReadiness, normalizeTargetCandidateSelector, resolveChangePlanFollowBaseInput } from "./change-plan/readiness.js";
export async function changePlanQuery(
  sessionInput: QuerySessionInput,
  input: ChangePlanInput = {},
  options: QueryOptions = {}
): Promise<QueryResult> {
  const session = await ensureQuerySession(sessionInput, options);
  const repoRoot = session.repoRoot;
  const freshnessBlockReason = freshnessAuthorityBlockReason(session.freshness);
  if (freshnessBlockReason) {
    const priorSnapshotLoad = input.taskId ? await loadTaskSnapshot(repoRoot, input.taskId) : undefined;
    const { planRevision, invariants } = nextTaskPlanLifecycle(priorSnapshotLoad?.snapshot, input.invariants);
    return changePlanFreshnessBlockedResult({
      freshness: session.freshness,
      refresh: session.refresh,
      repoRoot,
      input,
      reason: freshnessBlockReason,
      planRevision,
      invariants
    });
  }
  const requestedFollowCandidate = normalizeTargetCandidateSelector(input.followCandidate);
  const followBase = requestedFollowCandidate ? await resolveChangePlanFollowBaseInput(repoRoot, input) : undefined;
  if (requestedFollowCandidate && !followBase?.input) {
    return changePlanFollowCandidateRejectedResult({
      session,
      requestedCandidate: requestedFollowCandidate,
      reason: followBase?.reason ?? "followCandidate requires a task, query, or blocked change-plan taskId to replay",
      snapshotLoad: followBase?.snapshotLoad
    });
  }
  const effectiveInput = followBase?.input ?? input;
  const priorSnapshotLoad = effectiveInput.saveSnapshot && effectiveInput.taskId ? await loadTaskSnapshot(repoRoot, effectiveInput.taskId) : undefined;
  const { planRevision, invariants } = nextTaskPlanLifecycle(priorSnapshotLoad?.snapshot, effectiveInput.invariants);
  const pack = await contextPackQuery(session, { ...effectiveInput, tokenBudget: Math.min(effectiveInput.tokenBudget ?? 3200, 4000), limit: effectiveInput.limit ?? 10, includeSnippets: effectiveInput.includeSnippets ?? false }, options);
  const packData = pack.data as {
    focusFiles?: Array<{ file: FileFact; reasons: string[]; tier: EvidenceTier }>;
    changedEntries?: ChangedFileEntry[];
    changedFiles?: string[];
    tests?: TestRecommendation[];
    recipes?: string[];
    dirtyScope?: {
      requested?: boolean;
      mode?: "edit" | "orientation";
      canPlan?: boolean;
      broad?: boolean;
      changedFileCount?: number;
      plannedEditTargets?: string[];
      reason?: string;
    };
    packetVerdict?: string;
    intentConfidence?: { editReady?: boolean; confidence?: number; verdict?: string; recommendedNextTool?: string; missingAnchors?: string[] };
    quality?: ContextQuality;
    gaps?: string[];
    warnings?: string[];
  };
  const focusFiles = packData.focusFiles ?? [];
  const tests = packData.tests ?? [];
  const recipes = packData.recipes ?? [];
  const quality = packData.quality;
  const files = focusFiles.map((entry) => entry.file.path);
  const explicitFiles = normalizeInputPaths(effectiveInput.files ?? [], repoRoot);
  const explicitSymbolFiles = focusFiles
    .filter((entry) => entry.reasons.some((reason) => reason.startsWith("requested symbol ")))
    .map((entry) => entry.file.path);
  const editReadiness = changePlanEditReadiness({
    input: effectiveInput,
    focusFiles,
    explicitTargetProvided: explicitFiles.length > 0 || explicitSymbolFiles.length > 0,
    dirtyScope: packData.dirtyScope,
    quality,
    packetVerdict: packData.packetVerdict,
    intentConfidence: packData.intentConfidence
  });
  const dirtyScopeTargets =
    editReadiness.source === "dirty-worktree"
      ? uniqueSorted(packData.dirtyScope?.plannedEditTargets ?? [])
      : [];
  const plannedEditTargets = editReadiness.editable
    ? uniqueSorted(
        dirtyScopeTargets.length > 0
          ? dirtyScopeTargets
          : explicitFiles.length > 0 || explicitSymbolFiles.length > 0
            ? [...explicitFiles, ...explicitSymbolFiles]
            : files.slice(0, 6)
      )
    : [];
  const focusPathSet = new Set(files);
  const explicitWorkflowPaths = new Set(normalizeInputPaths(effectiveInput.files ?? [], repoRoot));
  const workflowMatchPaths = explicitWorkflowPaths.size > 0 ? explicitWorkflowPaths : focusPathSet;
  const relatedWorkflow = session.index.workflows.find(
    (workflow) => workflow.relatedFiles.some((filePath) => workflowMatchPaths.has(filePath)) || workflowMatchPaths.has(workflow.entryPath)
  );
  const requiredWorkflowChecks = requiredWorkflowChecksForPlan(session.index.workflows, workflowMatchPaths, effectiveInput.changeType ?? "unknown").slice(0, 8);
  const requiredDependencyChecks = requiredDependencyChecksForPlan(session.index, plannedEditTargets, effectiveInput.changeType ?? "unknown").slice(0, 12);
  const dirtyScopeTests =
    editReadiness.source === "dirty-worktree"
      ? recommendTests(session.index, plannedEditTargets, repoRoot, effectiveInput.changeType ?? "unknown")
      : [];
  const plannedTests = editReadiness.editable ? uniqueTests([...tests, ...dirtyScopeTests]).slice(0, 12) : [];
  const plannedRecipes = editReadiness.editable ? recipes : [];
  const blockedSnapshot = effectiveInput.saveSnapshot && !editReadiness.editable && !requestedFollowCandidate
    ? await saveBlockedTaskSnapshot({
        repoRoot,
        input: effectiveInput,
        reason: editReadiness.reason,
        details: editReadiness
      })
    : undefined;
  const targetCandidates = editReadiness.editable
    ? []
    : changePlanTargetCandidates({
        input: effectiveInput,
        taskId: blockedSnapshot?.taskId ?? effectiveInput.taskId,
        index: session.index,
        repoRoot,
        focusFiles,
        workflows: session.index.workflows,
        tests,
        changedEntries: packData.changedEntries ?? [],
        missingAnchors: editReadiness.missingAnchors
      });
  if (requestedFollowCandidate) {
    return changePlanFollowCandidateResult({
      session,
      options,
      originalInput: input,
      baseInput: effectiveInput,
      requestedCandidate: requestedFollowCandidate,
      targetCandidates,
      editReadiness,
      quality,
      snapshotLoad: followBase?.snapshotLoad
    });
  }
  const managedReview = editReadiness.editable && managedPostEditReviewAvailable();
  const planSteps = editReadiness.editable
    ? [
        editReadiness.source === "dirty-worktree"
          ? `1. Treat the current dirty worktree as the planned edit scope (${plannedEditTargets.length} files); read representatives ${files.slice(0, 6).join(", ") || "returned by Codexa"} before editing.`
          : `1. Read ${files.slice(0, 6).join(", ") || "the focus files returned by Codexa"} before editing.`,
        relatedWorkflow
          ? `2. Inspect workflow_path directly or through capabilities for ${relatedWorkflow.title} if the change touches runtime flow.`
          : effectiveInput.files?.length || effectiveInput.symbols?.length
            ? "2. Use callers, callees, or dependency_path if this focused edit changes an exported API or runtime contract."
            : editReadiness.source === "dirty-worktree"
              ? "2. Use change groups, callers, or dependency_path to split the dirty scope only if the representative reads reveal unrelated work."
              : `2. Use ${editReadiness.recommendedNextTool ?? "task_brief"} next if the edit target is still ambiguous.`,
        plannedTests.length > 0
          ? `3. Keep these tests in scope: ${plannedTests.slice(0, 5).map((test) => test.path).join(", ")}.`
          : "3. No targeted tests were proven; inspect repo test metadata before inventing a command.",
        plannedRecipes.length > 0 ? `4. Verification: ${plannedRecipes.slice(0, 3).join(" ")}` : "4. Run the narrowest verified test or type check that covers the touched files.",
        managedReview
          ? "5. Run the planned verification; the managed host completion gate owns post-edit review, so do not call post_edit_review manually."
          : editReadiness.source === "dirty-worktree"
            ? "5. On a hookless host, run post_edit_review once after edits; the snapshot dirty baseline separates pre-existing dirty files from new changes."
            : "5. On a hookless host, run post_edit_review once after edits with the saved task id and verification evidence."
      ]
    : [
        `1. Do not edit yet: ${editReadiness.reason}.`,
        `2. Read ${files.slice(0, 6).join(", ") || "the orientation files returned by Codexa"} only to choose a concrete target.`,
        targetCandidates.length > 0
          ? "3. Pick one target candidate below, then re-run change_plan with followCandidate set to its candidateId."
          : "3. Use one search call or raw source search to identify the exact file or symbol.",
        "4. Re-run change_plan with an explicit file or symbol target and saveSnapshot=true before editing.",
        "5. Treat any tests below as deferred until the edit target is explicit."
      ];
  const finalTaskId = effectiveInput.saveSnapshot && editReadiness.editable ? allocateTaskSnapshotId(repoRoot, effectiveInput) : effectiveInput.taskId;
  const structuredNextTools = editReadiness.editable
    ? managedReview
      ? []
      : [
          nextTool("post_edit_review", "on this hookless host, review drift and verification once after completing the planned edit", { taskId: finalTaskId }, true, [".codex/cache/codexa-outcomes"])
        ].filter((tool): tool is ReturnType<typeof nextTool> => Boolean(tool))
    : targetCandidates[0]
      ? [nextTool("change_plan", "follow the highest-confidence target candidate", { taskId: blockedSnapshot?.taskId ?? effectiveInput.taskId, followCandidate: targetCandidates[0].candidateId, saveSnapshot: true }, true, [".codex/cache/codexa-task-snapshots"])]
      : [nextTool("search", "narrow the task to an explicit file or symbol target before editing", { task: effectiveInput.task })];
  const complexityReview = buildPlanComplexityReview({
    editReadiness,
    plannedEditTargets,
    plannedTests,
    requiredWorkflowChecks: editReadiness.editable ? requiredWorkflowChecks : [],
    requiredDependencyChecks: editReadiness.editable ? requiredDependencyChecks : []
  });
  const snapshotIndex = effectiveInput.saveSnapshot && editReadiness.editable ? session.index : undefined;
  const snapshotScope = uniqueSorted([...plannedEditTargets, ...files]);
  const snapshotDiffFootprint = effectiveInput.saveSnapshot && editReadiness.editable ? await getDiffFootprint(repoRoot, packData.changedEntries ?? []) : undefined;
  const snapshotInput = finalTaskId ? { ...effectiveInput, taskId: finalTaskId } : effectiveInput;
  const sessionMemoryPointer = effectiveInput.saveSnapshot && editReadiness.editable
    ? await pointerForSessionMemory({
        repoRoot,
        sessionId: session.options.workspaceSessionId,
        taskId: finalTaskId,
        files: snapshotScope,
        freshness: pack.freshness,
        limit: 8
      }).catch(() => undefined)
    : undefined;
  let savedSnapshot: Awaited<ReturnType<typeof saveTaskSnapshot>> | undefined;
  if (effectiveInput.saveSnapshot && editReadiness.editable) {
    try {
      savedSnapshot = await saveTaskSnapshot({
        repoRoot,
        input: snapshotInput,
        beforePersist: async () => {
          await assertFreshnessAuthorityCurrent(repoRoot, session.index, session.freshness);
        },
        snapshot: {
          task: effectiveInput.task,
          changeType: effectiveInput.changeType ?? "unknown",
          planRevision,
          invariants,
          snapshotFreshness: pack.freshness,
          plannedEditTargets,
          plannedFiles: files,
          focusFiles: focusFiles.map((entry) => ({
            path: entry.file.path,
            tier: entry.tier,
            reasons: uniqueSorted(entry.reasons),
            rank: entry.file.rank,
            riskScore: entry.file.riskScore
          })),
          plannedTests: compactSnapshotTests(plannedTests, repoRoot),
          sessionMemory: sessionMemoryPointer,
          requiredWorkflowChecks,
          requiredDependencyChecks,
          symbolBaseline: snapshotIndex ? snapshotSymbolBaseline(snapshotIndex, snapshotScope) : undefined,
          riskBaseline: snapshotIndex ? snapshotRiskBaseline(snapshotIndex, snapshotScope) : undefined,
          diffFootprint: snapshotDiffFootprint,
          recipes: plannedRecipes,
          dirtyBaseline: {
            changedEntries: packData.changedEntries ?? [],
            dirtyFiles: pack.freshness.dirtyFiles,
            dirtyFileHashes: pack.freshness.dirtyFileHashes,
            headCommit: pack.freshness.headCommit,
            indexedAt: pack.freshness.indexedAt
          },
          quality,
          gaps: packData.gaps ?? [],
          warnings: packData.warnings ?? []
        }
      });
    } catch (error) {
      if (error instanceof FreshnessAuthorityChangedError) {
        return changePlanFreshnessBlockedResult({
          freshness: error.freshness,
          refresh: { refreshed: false },
          repoRoot,
          input: snapshotInput,
          reason: error.reason,
          planRevision,
          invariants
        });
      }
      throw error;
    }
  }
  const text = [
    freshnessBanner(pack.freshness, pack.refresh),
    quality ? formatContextQuality(quality) : undefined,
    "Codexa change plan",
    effectiveInput.task ? `Task: ${effectiveInput.task}` : undefined,
    `Edit readiness: ${editReadiness.status}; ${editReadiness.reason}`,
    savedSnapshot ? `Task snapshot: ${savedSnapshot.snapshot.taskId}` : undefined,
    savedSnapshot ? `Plan revision: ${savedSnapshot.snapshot.planRevision ?? 1}` : undefined,
    effectiveInput.saveSnapshot && !editReadiness.editable ? "Task snapshot: not saved because this packet is orientation-only." : undefined,
    "",
    ...planSteps,
    "",
    ...formatComplexityReview(complexityReview),
    // Snapshot persistence serializes same-task plans and may merge an
    // invariant committed by a concurrent caller. Render the committed set so
    // detailed text cannot contradict the structured snapshot it accompanies.
    ...formatTaskInvariants(savedSnapshot?.snapshot.invariants ?? invariants, "Task invariants:"),
    "",
    "Read first:",
    ...focusFiles.slice(0, 10).map((entry) => `- ${entry.file.path}: ${entry.tier}; ${entry.reasons.join("; ")}`),
    "",
    "Tests:",
    ...(editReadiness.editable ? formatTestRecommendations(plannedTests.slice(0, 12)) : ["- deferred until Codexa has an explicit file, symbol, or edit-ready packet."]),
    !editReadiness.editable ? "" : undefined,
    !editReadiness.editable ? "Target candidates:" : undefined,
    ...(!editReadiness.editable ? formatTargetCandidates(targetCandidates) : []),
    "",
    "Required workflow checks:",
    ...formatRequiredChecks(editReadiness.editable ? requiredWorkflowChecks : []),
    "",
    "Required dependency checks:",
    ...formatRequiredChecks(editReadiness.editable ? requiredDependencyChecks : []),
    "",
    "Known gaps:",
    ...formatGaps(packData.gaps ?? [])
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
  return {
    freshness: pack.freshness,
    refresh: pack.refresh,
    text: limitText(text, 7000),
    data: {
      mode: "change_plan",
      editReadiness,
      steps: planSteps,
      context: pack.data,
      files,
      plannedEditTargets,
      tests: plannedTests,
      recipes: plannedRecipes,
      targetCandidates,
      quality,
      requiredWorkflowChecks: editReadiness.editable ? requiredWorkflowChecks : [],
	      requiredDependencyChecks: editReadiness.editable ? requiredDependencyChecks : [],
	      complexityReview,
	      reviewOwner: managedReview ? "managed-host-gate" : "agent-on-hookless-host",
	      nextTools: structuredNextTools,
	      systemMessage: managedReview
          ? "Run the planned verification, then stop; the managed host completion gate owns post-edit review."
          : structuredNextTools[0]?.reason,
	      snapshot: savedSnapshot?.snapshot,
      snapshotBlock: blockedSnapshot
        ? {
            taskId: blockedSnapshot.taskId,
            path: path.relative(repoRoot, blockedSnapshot.path).split(path.sep).join("/"),
            reason: editReadiness.reason
          }
        : undefined
    }
  };
}

function managedPostEditReviewAvailable(): boolean {
  return process.env.CODEXA_MANAGED_POST_EDIT === "1";
}

function changePlanFreshnessBlockedResult(input: {
  freshness: FreshnessInfo;
  refresh?: RefreshInfo;
  repoRoot: string;
  input: ChangePlanInput;
  reason: string;
  planRevision: number;
  invariants: TaskInvariant[];
}): QueryResult {
  const editReadiness = {
    editable: false,
    status: "orientation-only" as const,
    reason: input.reason,
    source: "insufficient-context" as const,
    explicitTargetProvided: Boolean(input.input.files?.length || input.input.symbols?.length),
    recommendedNextTool: "freshness",
    missingAnchors: ["fresh-index"],
    snapshotBlocked: Boolean(input.input.saveSnapshot)
  };
  return {
    freshness: input.freshness,
    refresh: input.refresh,
    text: [
      freshnessBanner(input.freshness, input.refresh),
      "Codexa change plan blocked.",
      input.reason,
      `Run: codexa index ${input.repoRoot}`,
      "No task snapshot or blocked-plan marker was written."
    ].join("\n"),
    data: {
      mode: "change_plan",
      actionability: "blocked",
      task: input.input.task,
      taskId: input.input.taskId,
      editReadiness,
      files: [],
      plannedEditTargets: [],
      tests: [],
      recipes: [],
      invariants: input.invariants,
      planRevision: input.planRevision,
      requiredWorkflowChecks: [],
      requiredDependencyChecks: [],
      nextTools: [],
      systemMessage: `Run codexa index ${input.repoRoot}, then retry change_plan.`,
      snapshotBlock: {
        taskId: input.input.taskId,
        status: "not-saved",
        reason: input.reason
      },
      gaps: [input.reason]
    }
  };
}
async function changePlanFollowCandidateResult(input: {
  session: QuerySession;
  options: QueryOptions;
  originalInput: ChangePlanInput;
  baseInput: ChangePlanInput;
  requestedCandidate: string;
  targetCandidates: ChangePlanTargetCandidate[];
  editReadiness: ReturnType<typeof changePlanEditReadiness>;
  quality?: ContextQuality;
  snapshotLoad?: TaskSnapshotLoadResult;
}): Promise<QueryResult> {
  const selected = input.targetCandidates.find((candidate) => candidate.candidateId === input.requestedCandidate);
  if (!selected) {
    return changePlanFollowCandidateRejectedResult({
      session: input.session,
      requestedCandidate: input.requestedCandidate,
      reason: "target candidate id was not found when replayed against the current index",
      targetCandidates: input.targetCandidates,
      editReadiness: input.editReadiness,
      quality: input.quality,
      snapshotLoad: input.snapshotLoad
    });
  }

  const revalidation = validateChangePlanTargetCandidate(selected, { index: input.session.index, repoRoot: input.session.repoRoot });
  const revalidatedCandidate = { ...selected, ...revalidation };
  if (revalidation.validationStatus !== "edit-ready") {
    return changePlanFollowCandidateRejectedResult({
      session: input.session,
      requestedCandidate: input.requestedCandidate,
      reason: `target candidate revalidated as ${revalidation.validationStatus}: ${revalidation.validationReasons.join("; ")}`,
      targetCandidates: [revalidatedCandidate, ...input.targetCandidates.filter((candidate) => candidate.candidateId !== selected.candidateId)],
      editReadiness: input.editReadiness,
      quality: input.quality,
      snapshotLoad: input.snapshotLoad
    });
  }

  const allowRequestOverrides = !input.snapshotLoad?.blockedSnapshot;
  const followedInput: ChangePlanInput = {
    ...selected.nextChangePlanArgs,
    taskId: input.originalInput.taskId ?? selected.nextChangePlanArgs.taskId ?? input.baseInput.taskId,
    changeType: allowRequestOverrides ? input.originalInput.changeType ?? selected.nextChangePlanArgs.changeType : selected.nextChangePlanArgs.changeType,
    diff: allowRequestOverrides ? input.originalInput.diff ?? selected.nextChangePlanArgs.diff : selected.nextChangePlanArgs.diff,
    saveSnapshot: true
  };
  const result = await changePlanQuery(input.session, followedInput, { ...input.options, autoRefresh: false });
  const resultData = result.data && typeof result.data === "object" ? (result.data as Record<string, unknown>) : {};
  return {
    ...result,
    text: limitText(`Follow candidate: accepted ${selected.candidateId}; revalidated edit-ready.\n\n${result.text}`, 7000),
    data: {
      ...resultData,
      followCandidate: {
        status: "accepted",
        requested: input.requestedCandidate,
        candidateId: selected.candidateId,
        rank: selected.rank,
        kind: selected.kind,
        path: selected.path,
        plannedEditTargets: revalidation.wouldPlanEditTargets,
        validationReasons: revalidation.validationReasons
      }
    }
  };
}

function changePlanFollowCandidateRejectedResult(input: {
  session: QuerySession;
  requestedCandidate: string;
  reason: string;
  targetCandidates?: ChangePlanTargetCandidate[];
  editReadiness?: ReturnType<typeof changePlanEditReadiness>;
  quality?: ContextQuality;
  snapshotLoad?: TaskSnapshotLoadResult;
}): QueryResult {
  const editReadiness =
    input.editReadiness ??
    ({
      editable: false,
      status: "orientation-only",
      reason: input.reason,
      source: "insufficient-context",
      explicitTargetProvided: false,
      recommendedNextTool: "change_plan",
      missingAnchors: ["valid-target-candidate"],
      snapshotBlocked: false
    } satisfies ReturnType<typeof changePlanEditReadiness>);
  const steps = [
    `1. Do not edit yet: ${input.reason}.`,
    "2. Re-run the orientation change_plan if the target candidates are stale.",
    "3. Use an edit-ready candidateId from the current Target candidates list, then retry followCandidate.",
    "4. If no candidate is edit-ready, use search/task_brief to identify an explicit file or symbol target."
  ];
  const text = [
    freshnessBanner(input.session.freshness, input.session.refresh),
    input.quality ? formatContextQuality(input.quality) : undefined,
    "Codexa change plan",
    `Follow candidate: rejected; ${input.reason}`,
    "",
    ...steps,
    "",
    input.targetCandidates?.length ? "Target candidates:" : undefined,
    ...(input.targetCandidates?.length ? formatTargetCandidates(input.targetCandidates) : [])
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
  return {
    freshness: input.session.freshness,
    refresh: input.session.refresh,
    text: limitText(text, 7000),
    data: {
      mode: "change_plan",
      editReadiness,
      steps,
      files: [],
      plannedEditTargets: [],
      tests: [],
      recipes: [],
      targetCandidates: input.targetCandidates ?? [],
      quality: input.quality,
      requiredWorkflowChecks: [],
      requiredDependencyChecks: [],
      followCandidate: {
        status: "rejected",
        requested: input.requestedCandidate,
        reason: input.reason,
        snapshotLoad: input.snapshotLoad
          ? {
              latestTaskId: input.snapshotLoad.latestTaskId,
              missingReason: input.snapshotLoad.missingReason,
              error: input.snapshotLoad.error
            }
          : undefined
      }
    }
  };
}

export type TargetCandidateValidationStatus = "edit-ready" | "needs-more-context" | "weak";

export interface TargetCandidateRisk {
  score: number;
  reasons: string[];
}

export interface ChangePlanTargetCandidateValidation {
  validationStatus: TargetCandidateValidationStatus;
  validationReasons: string[];
  wouldPlanEditTargets: string[];
  wouldRecommendTests: string[];
  candidateRisk: TargetCandidateRisk;
}

export interface ChangePlanTargetCandidateBase {
  candidateId: string;
  rank: number;
  kind: "file" | "symbol";
  path: string;
  symbol?: {
    id: string;
    name: string;
    qualifiedName: string;
    kind: SymbolFact["kind"];
  };
  score: number;
  confidence: EvidenceTier;
  evidence: string[];
  missingAnchors: string[];
  nextChangePlanArgs: {
    task?: string;
    files?: string[];
    symbols?: string[];
    query?: string;
    taskId?: string;
    changeType: ChangeType;
    diff?: boolean;
    saveSnapshot: true;
  };
  rawSearchQueries: string[];
}

export interface ChangePlanTargetCandidate extends ChangePlanTargetCandidateBase, ChangePlanTargetCandidateValidation {}

type ChangePlanTargetCandidateDraft = Omit<ChangePlanTargetCandidateBase, "candidateId">;

function changePlanTargetCandidates(input: {
  input: ChangePlanInput;
  taskId?: string;
  index: CodexaIndex;
  repoRoot: string;
  focusFiles: Array<{ file: FileFact; reasons: string[]; tier: EvidenceTier }>;
  workflows: WorkflowTraceFact[];
  tests: TestRecommendation[];
  changedEntries: ChangedFileEntry[];
  missingAnchors: string[];
}): ChangePlanTargetCandidate[] {
  const taskTokens = meaningfulTaskTokens(input.input.task ?? input.input.query ?? "");
  const changedPaths = new Set(input.changedEntries.map((entry) => entry.path));
  const testPaths = new Set(input.tests.map((test) => test.path));
  const symbolsByPath = new Map<string, SymbolFact[]>();
  for (const symbol of input.index.symbols) {
    if (["module", "unknown"].includes(symbol.kind)) {
      continue;
    }
    const entries = symbolsByPath.get(symbol.path) ?? [];
    entries.push(symbol);
    symbolsByPath.set(symbol.path, entries);
  }
  const candidates: ChangePlanTargetCandidateDraft[] = [];
  for (const entry of input.focusFiles.slice(0, 10)) {
    const file = entry.file;
    if (file.test && input.focusFiles.some((candidate) => !candidate.file.test)) {
      continue;
    }
    const workflowHits = input.workflows.filter((workflow) => workflow.entryPath === file.path || workflow.relatedFiles.includes(file.path));
    const graphHits = input.index.graphEdges.filter((edge) => edge.fromPath === file.path || edge.toPath === file.path).slice(0, 6);
    const fileEvidence = candidateEvidence({
      file,
      reasons: entry.reasons,
      workflowHits,
      graphHits,
      testPaths,
      changedPaths,
      taskTokens,
      symbol: undefined
    });
    candidates.push({
      rank: 0,
      kind: "file",
      path: file.path,
      score: candidateScore(file, entry.tier, fileEvidence, undefined),
      confidence: entry.tier,
      evidence: fileEvidence.slice(0, 8),
      missingAnchors: input.missingAnchors,
      nextChangePlanArgs: {
        task: input.input.task,
        files: [file.path],
        query: input.input.query,
        taskId: input.taskId,
        changeType: input.input.changeType ?? "unknown",
        diff: input.input.diff,
        saveSnapshot: true
      },
      rawSearchQueries: rawSearchQueries(input.input.task ?? input.input.query, file.path)
    });
    for (const symbol of candidateSymbols(symbolsByPath.get(file.path) ?? [], taskTokens).slice(0, 2)) {
      const symbolEvidence = candidateEvidence({
        file,
        reasons: entry.reasons,
        workflowHits,
        graphHits: graphHits.filter((edge) => edge.fromSymbolId === symbol.id || edge.toSymbolId === symbol.id || edge.fromPath === symbol.path || edge.toPath === symbol.path),
        testPaths,
        changedPaths,
        taskTokens,
        symbol
      });
      candidates.push({
        rank: 0,
        kind: "symbol",
        path: file.path,
        symbol: {
          id: symbol.id,
          name: symbol.name,
          qualifiedName: symbol.qualifiedName,
          kind: symbol.kind
        },
        score: candidateScore(file, entry.tier, symbolEvidence, symbol),
        confidence: entry.tier,
        evidence: symbolEvidence.slice(0, 8),
        missingAnchors: input.missingAnchors,
        nextChangePlanArgs: {
          task: input.input.task,
          symbols: [symbol.id],
          query: input.input.query,
          taskId: input.taskId,
          changeType: input.input.changeType ?? "unknown",
          diff: input.input.diff,
          saveSnapshot: true
        },
        rawSearchQueries: rawSearchQueries(input.input.task ?? input.input.query, symbol.qualifiedName)
      });
    }
  }
  return dedupeTargetCandidates(candidates)
    .map(withTargetCandidateId)
    .map((candidate) => ({
      ...candidate,
      ...validateChangePlanTargetCandidate(candidate, { index: input.index, repoRoot: input.repoRoot })
    }))
    .sort(compareTargetCandidates)
    .slice(0, 8)
    .map((candidate, index) => ({ ...candidate, rank: index + 1 }));
}
export function validateChangePlanTargetCandidate(
  candidate: ChangePlanTargetCandidateBase,
  context: { index: CodexaIndex; repoRoot: string }
): ChangePlanTargetCandidateValidation {
  const validationReasons: string[] = [];
  const wouldPlanEditTargets = new Set<string>();
  let unresolvedTarget = false;
  let ambiguousTarget = false;
  const requestedFiles = candidate.nextChangePlanArgs.files ?? [];
  const requestedSymbols = candidate.nextChangePlanArgs.symbols ?? [];
  if (requestedFiles.length === 0 && requestedSymbols.length === 0) {
    validationReasons.push("no explicit file or symbol target in nextChangePlanArgs");
    unresolvedTarget = true;
  }

  for (const requestedFile of requestedFiles) {
    const resolved = resolveFileTarget(context.index, requestedFile, context.repoRoot);
    if (resolved.file) {
      wouldPlanEditTargets.add(resolved.file.path);
      validationReasons.push(`file target resolves: ${resolved.file.path}`);
    } else if (resolved.ambiguous.length > 0) {
      ambiguousTarget = true;
      validationReasons.push(`file target is ambiguous: ${requestedFile}`);
    } else {
      unresolvedTarget = true;
      validationReasons.push(`file target not indexed: ${requestedFile}`);
    }
  }

  for (const requestedSymbol of requestedSymbols) {
    const resolved = resolveSymbolTarget(context.index, requestedSymbol);
    if (resolved.symbol) {
      wouldPlanEditTargets.add(resolved.symbol.path);
      validationReasons.push(`symbol target resolves: ${resolved.symbol.qualifiedName} in ${resolved.symbol.path}`);
    } else if (resolved.ambiguous.length > 0) {
      ambiguousTarget = true;
      validationReasons.push(`symbol target is ambiguous: ${requestedSymbol}`);
    } else {
      unresolvedTarget = true;
      validationReasons.push(`symbol target not indexed: ${requestedSymbol}`);
    }
  }

  const plannedTargets = uniqueSorted(wouldPlanEditTargets);
  if (candidate.confidence === "fallback") {
    validationReasons.push("candidate evidence is fallback");
  } else if (candidate.evidence.length > 0) {
    validationReasons.push(`candidate has ${candidate.confidence} evidence`);
  }
  if (candidate.evidence.length === 0) {
    validationReasons.push("candidate has no supporting evidence");
  }

  const wouldRecommendTests = plannedTargets.length > 0
    ? recommendTests(context.index, plannedTargets, context.repoRoot, candidate.nextChangePlanArgs.changeType).map((test) => test.path).slice(0, 8)
    : [];
  if (wouldRecommendTests.length > 0) {
    validationReasons.push(`would recommend ${wouldRecommendTests.length} targeted test(s)`);
  } else {
    validationReasons.push("no targeted test recommendation proven");
  }

  const candidateRisk = candidateRiskForTargets(context.index, plannedTargets);
  if (candidateRisk.score > 0) {
    validationReasons.push(`candidate risk score ${candidateRisk.score.toFixed(1)}`);
  }

  const hasStrongEvidence = (candidate.confidence === "authoritative" || candidate.confidence === "derived") && candidate.evidence.length > 0;
  const validationStatus: TargetCandidateValidationStatus =
    plannedTargets.length === 0 || unresolvedTarget || ambiguousTarget
      ? "needs-more-context"
      : hasStrongEvidence
        ? "edit-ready"
        : "weak";

  return {
    validationStatus,
    validationReasons: uniqueInOrder(validationReasons).slice(0, 8),
    wouldPlanEditTargets: plannedTargets,
    wouldRecommendTests,
    candidateRisk
  };
}

function candidateRiskForTargets(index: CodexaIndex, paths: string[]): TargetCandidateRisk {
  const pathSet = new Set(paths);
  const fileReasons = paths
    .map((filePath) => findFile(index, filePath))
    .filter((file): file is FileFact => Boolean(file))
    .filter((file) => file.riskScore > 0)
    .map((file) => ({ score: file.riskScore, reason: `${file.path}: indexed risk ${file.riskScore.toFixed(1)}` }));
  const signalReasons = index.risks
    .filter((risk) => pathSet.has(risk.path))
    .map((risk) => ({ score: risk.score, reason: `${risk.path}: ${risk.signal} - ${risk.reason}` }));
  const scoredReasons = [...fileReasons, ...signalReasons].sort((left, right) => right.score - left.score || left.reason.localeCompare(right.reason));
  return {
    score: Math.max(0, ...scoredReasons.map((entry) => entry.score)),
    reasons: uniqueInOrder(scoredReasons.map((entry) => entry.reason)).slice(0, 6)
  };
}

function compareTargetCandidates(left: ChangePlanTargetCandidate, right: ChangePlanTargetCandidate): number {
  return (
    targetCandidateStatusRank(left.validationStatus) - targetCandidateStatusRank(right.validationStatus) ||
    right.score - left.score ||
    left.path.localeCompare(right.path) ||
    left.kind.localeCompare(right.kind) ||
    left.candidateId.localeCompare(right.candidateId)
  );
}

function targetCandidateStatusRank(status: TargetCandidateValidationStatus): number {
  return status === "edit-ready" ? 0 : status === "weak" ? 1 : 2;
}

function candidateEvidence(input: {
  file: FileFact;
  reasons: string[];
  workflowHits: WorkflowTraceFact[];
  graphHits: GraphEdgeFact[];
  testPaths: Set<string>;
  changedPaths: Set<string>;
  taskTokens: string[];
  symbol?: SymbolFact;
}): string[] {
  const evidence = new Set<string>();
  for (const reason of input.reasons.slice(0, 4)) {
    evidence.add(reason);
  }
  if (input.symbol) {
    evidence.add(`symbol ${input.symbol.qualifiedName} (${input.symbol.kind})`);
    const normalizedSymbol = normalizeSearchText(`${input.symbol.name} ${input.symbol.qualifiedName}`);
    if (input.taskTokens.some((token) => normalizedSymbol.includes(token))) {
      evidence.add("keyword match on symbol name");
    }
  }
  const normalizedPath = normalizeSearchText(input.file.path);
  if (input.taskTokens.some((token) => normalizedPath.includes(token))) {
    evidence.add("keyword match on file path");
  }
  if (input.workflowHits.length > 0) {
    evidence.add(`workflow evidence: ${input.workflowHits.slice(0, 2).map((workflow) => workflow.title).join(", ")}`);
  }
  if (input.graphHits.length > 0) {
    evidence.add(`graph evidence: ${uniqueSorted(input.graphHits.map((edge) => edge.edgeKind)).slice(0, 4).join(", ")}`);
  }
  if (input.testPaths.has(input.file.path) || input.file.test) {
    evidence.add("test evidence: candidate is a known test path");
  } else if (input.graphHits.some((edge) => edge.edgeKind === "TESTS" || edge.edgeKind === "TEST_COVERS_WORKFLOW")) {
    evidence.add("test evidence: graph links tests to this target");
  }
  if (input.changedPaths.has(input.file.path)) {
    evidence.add("recent diff evidence: file is currently changed");
  }
  if (input.file.riskScore > 0) {
    evidence.add(`risk evidence: score ${input.file.riskScore.toFixed(1)}`);
  }
  return [...evidence];
}

function candidateScore(file: FileFact, tier: EvidenceTier, evidence: string[], symbol: SymbolFact | undefined): number {
  const tierScore: Record<EvidenceTier, number> = {
    authoritative: 100,
    derived: 70,
    heuristic: 35,
    fallback: 10
  };
  const symbolScore = symbol ? (symbol.exported || ["route", "node"].includes(symbol.kind) ? 18 : 10) : 0;
  const sourceScore = file.test ? -12 : 12;
  return tierScore[tier] + file.rank * 2 + file.riskScore + evidence.length * 4 + symbolScore + sourceScore;
}

function candidateSymbols(symbols: SymbolFact[], taskTokens: string[]): SymbolFact[] {
  return symbols
    .slice()
    .sort(
      (left, right) =>
        symbolTargetScore(right, taskTokens) - symbolTargetScore(left, taskTokens) ||
        (left.range?.startLine ?? 0) - (right.range?.startLine ?? 0) ||
        left.qualifiedName.localeCompare(right.qualifiedName)
    );
}

function symbolTargetScore(symbol: SymbolFact, taskTokens: string[]): number {
  const normalized = normalizeSearchText(`${symbol.name} ${symbol.qualifiedName}`);
  const tokenScore = taskTokens.filter((token) => normalized.includes(token)).length * 20;
  const kindScore = symbol.kind === "route" ? 18 : symbol.exported ? 14 : ["function", "method", "class"].includes(symbol.kind) ? 10 : 4;
  return tokenScore + kindScore;
}

function dedupeTargetCandidates(candidates: ChangePlanTargetCandidateDraft[]): ChangePlanTargetCandidateDraft[] {
  const seen = new Set<string>();
  const result: ChangePlanTargetCandidateDraft[] = [];
  for (const candidate of candidates) {
    const key = targetCandidateStableTarget(candidate);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(candidate);
  }
  return result;
}

function withTargetCandidateId(candidate: ChangePlanTargetCandidateDraft): ChangePlanTargetCandidateBase {
  return {
    ...candidate,
    candidateId: targetCandidateStableId(candidate)
  };
}

function targetCandidateStableId(candidate: ChangePlanTargetCandidateDraft): string {
  return `candidate-${stableId("change-plan-target-candidate", targetCandidateStableTarget(candidate)).slice(0, 12)}`;
}

function targetCandidateStableTarget(candidate: ChangePlanTargetCandidateDraft): string {
  const target = candidate.symbol
    ? `${candidate.symbol.kind}:${candidate.symbol.qualifiedName || candidate.symbol.name || candidate.symbol.id}`
    : candidate.nextChangePlanArgs.files?.join("\n") ?? candidate.path;
  return `${candidate.kind}:${candidate.path}:${target}`;
}

function uniqueInOrder(values: Iterable<string>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (seen.has(value)) {
      continue;
    }
    seen.add(value);
    result.push(value);
  }
  return result;
}

function meaningfulTaskTokens(value: string): string[] {
  const stop = new Set(["a", "an", "and", "as", "for", "how", "in", "of", "on", "or", "safely", "the", "to", "with"]);
  return uniqueSorted(
    normalizeSearchText(value)
      .split(/\s+/u)
      .map((token) => token.trim())
      .filter((token) => token.length >= 3 && !stop.has(token))
  ).slice(0, 8);
}

function rawSearchQueries(task: string | undefined, target: string): string[] {
  const taskPart = meaningfulTaskTokens(task ?? "").slice(0, 4).join(" ");
  const targetPart = target.split(/[/.]/u).filter(Boolean).slice(-2).join(" ");
  return uniqueSorted([taskPart, targetPart, `${taskPart} ${targetPart}`].map((entry) => entry.trim()).filter(Boolean)).slice(0, 3);
}

function formatTargetCandidates(candidates: ChangePlanTargetCandidate[]): string[] {
  if (candidates.length === 0) {
    return ["- none ranked from current packet; run search/raw search to find a file or symbol target."];
  }
  return candidates.slice(0, 6).map((candidate) => {
    const target = candidate.kind === "symbol" && candidate.symbol ? `${candidate.symbol.qualifiedName} in ${candidate.path}` : candidate.path;
    const nextArg = candidate.nextChangePlanArgs.files?.[0] ?? candidate.nextChangePlanArgs.symbols?.[0] ?? target;
    return `- #${candidate.rank} ${candidate.candidateId} ${candidate.kind} ${target}: ${candidate.validationStatus}; score ${candidate.score.toFixed(1)}; risk ${candidate.candidateRisk.score.toFixed(1)}; followCandidate ${candidate.candidateId}; next change_plan target ${nextArg}; ${candidate.evidence.slice(0, 3).join("; ")}`;
  });
}
