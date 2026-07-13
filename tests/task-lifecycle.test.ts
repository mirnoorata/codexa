import { readFile, readdir, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runPreEditHook } from "../src/cli/hooks.js";
import { buildIndex } from "../src/indexer.js";
import { changePlanQuery, postEditReviewQuery } from "../src/queries.js";
import { saveBlockedTaskSnapshot } from "../src/task-snapshots.js";
import { createQuerySession } from "../src/query/session.js";
import { getDiffFootprint } from "../src/query/worktree.js";
import {
  classifyTaskLoopFailures,
  loadTaskLifecycleState,
  normalizeTaskInvariants,
  pendingTaskLifecycleReplan,
  prepareTaskLoopAttempt,
  reviewTaskInvariants,
  saveTaskLifecycleState,
  withTaskLifecycleLock
} from "../src/task-lifecycle.js";
import type { DiffFootprintV1, TaskLoopFailureSignal, TaskLoopReview, TaskSnapshot } from "../src/types.js";
import { createHookFixtureRepo } from "./cli-hooks-fixtures.js";

describe("task lifecycle governance", () => {
  it("inherits exact task invariants across same-task plan revisions", async () => {
    const repo = await createHookFixtureRepo();
    await buildIndex({ repoRoot: repo });

    const first = await changePlanQuery(
      repo,
      {
        task: "Keep the implementation general",
        taskId: "general-contract",
        files: ["src/main.ts"],
        invariants: ["No customer-specific branches."],
        saveSnapshot: true
      },
      { autoRefresh: false }
    );
    const firstSnapshot = (first.data as { snapshot: TaskSnapshot }).snapshot;
    expect(firstSnapshot.planRevision).toBe(1);
    expect(firstSnapshot.invariants?.map((entry) => entry.statement)).toEqual(["No customer-specific branches."]);

    const second = await changePlanQuery(
      repo,
      {
        task: "Replan the same general implementation",
        taskId: "general-contract",
        files: ["src/main.ts"],
        saveSnapshot: true
      },
      { autoRefresh: false }
    );
    const secondSnapshot = (second.data as { snapshot: TaskSnapshot }).snapshot;
    expect(secondSnapshot.planRevision).toBe(2);
    expect(secondSnapshot.invariants).toEqual(firstSnapshot.invariants);
  });

  it("blocks stale lifecycle queries before snapshots, outcomes, or attempts are persisted", async () => {
    const stalePlanRepo = await createHookFixtureRepo();
    await buildIndex({ repoRoot: stalePlanRepo });
    await writeFile(path.join(stalePlanRepo, "src/main.ts"), "export function main() { return 2 }\n", "utf8");
    execFileSync("git", ["add", "src/main.ts"], { cwd: stalePlanRepo, stdio: "ignore" });
    execFileSync("git", ["-c", "user.name=Codexa", "-c", "user.email=codexa@example.invalid", "commit", "-m", "advance stale plan head"], {
      cwd: stalePlanRepo,
      stdio: "ignore"
    });

    await expect(
      changePlanQuery(
        stalePlanRepo,
        { task: "Do not plan from stale context", taskId: "stale-plan", files: ["src/main.ts"], saveSnapshot: true },
        { autoRefresh: false }
      )
    ).rejects.toThrow("head-commit-changed");
    await expect(readFile(path.join(stalePlanRepo, ".codex/cache/codexa-tasks/stale-plan.json"), "utf8")).rejects.toThrow();
    await expect(readFile(path.join(stalePlanRepo, ".codex/cache/codexa-tasks/stale-plan.blocked.json"), "utf8")).rejects.toThrow();

    const staleReviewRepo = await createHookFixtureRepo();
    await buildIndex({ repoRoot: staleReviewRepo });
    await changePlanQuery(
      staleReviewRepo,
      { task: "Do not review from stale context", taskId: "stale-review", files: ["src/main.ts"], saveSnapshot: true },
      { autoRefresh: false }
    );
    const lifecycleBefore = await loadTaskLifecycleState(staleReviewRepo, "stale-review");
    await writeFile(path.join(staleReviewRepo, "src/main.ts"), "export function main() { return 3 }\n", "utf8");
    execFileSync("git", ["add", "src/main.ts"], { cwd: staleReviewRepo, stdio: "ignore" });
    execFileSync("git", ["-c", "user.name=Codexa", "-c", "user.email=codexa@example.invalid", "commit", "-m", "advance stale review head"], {
      cwd: staleReviewRepo,
      stdio: "ignore"
    });

    await expect(
      postEditReviewQuery(staleReviewRepo, { taskId: "stale-review", persistOutcome: true }, { autoRefresh: false })
    ).rejects.toThrow("head-commit-changed");
    expect(await loadTaskLifecycleState(staleReviewRepo, "stale-review")).toEqual(lifecycleBefore);
    await expect(readdir(path.join(staleReviewRepo, ".codex/cache/codexa-outcomes"))).rejects.toThrow();
  });

  it("blocks a change plan when the checkout mutates after context collection but before snapshot persistence", async () => {
    const repo = await createHookFixtureRepo();
    await buildIndex({ repoRoot: repo });
    const session = await createQuerySession(repo, { autoRefresh: false });
    const getChangedFileEntries = session.getChangedFileEntries.bind(session);
    let mutated = false;
    session.getChangedFileEntries = async () => {
      const entries = await getChangedFileEntries();
      if (!mutated) {
        mutated = true;
        await writeFile(path.join(repo, "src/main.ts"), "export function main() { return 41 }\n", "utf8");
      }
      return entries;
    };

    const result = await changePlanQuery(
      session,
      { task: "Persist only against the observed checkout", taskId: "plan-cas-race", files: ["src/main.ts"], saveSnapshot: true },
      { autoRefresh: false }
    );

    expect(mutated).toBe(true);
    expect(result.data).toMatchObject({
      actionability: "blocked",
      snapshotBlock: { taskId: "plan-cas-race", status: "not-saved" }
    });
    await expect(readFile(path.join(repo, ".codex/cache/codexa-tasks/plan-cas-race.json"), "utf8")).rejects.toThrow();
    await expect(readFile(path.join(repo, ".codex/cache/codexa-tasks/plan-cas-race.blocked.json"), "utf8")).rejects.toThrow();
    expect(await loadTaskLifecycleState(repo, "plan-cas-race")).toBeUndefined();
  });

  it("blocks post-edit persistence when the checkout mutates after review collection", async () => {
    const repo = await createHookFixtureRepo();
    await buildIndex({ repoRoot: repo });
    await changePlanQuery(
      repo,
      { task: "Persist only the reviewed edit", taskId: "post-edit-cas-race", files: ["src/main.ts"], saveSnapshot: true },
      { autoRefresh: false }
    );
    await writeFile(path.join(repo, "src/main.ts"), "export function main() { return 42 }\n", "utf8");
    const session = await createQuerySession(repo, { autoRefresh: true });
    const lifecycleBefore = await loadTaskLifecycleState(repo, "post-edit-cas-race");
    const getChangedFileEntries = session.getChangedFileEntries.bind(session);
    let mutated = false;
    session.getChangedFileEntries = async () => {
      const entries = await getChangedFileEntries();
      if (!mutated) {
        mutated = true;
        await writeFile(path.join(repo, "src/main.ts"), "export function main() { return 43 }\n", "utf8");
      }
      return entries;
    };

    const result = await postEditReviewQuery(session, { taskId: "post-edit-cas-race", persistOutcome: true }, { autoRefresh: false });

    expect(mutated).toBe(true);
    expect(result.data).toMatchObject({
      actionability: "blocked",
      completionAuthority: "blocking_inspect",
      outcome: { persisted: false },
      loopReview: { status: "not-evaluated" }
    });
    expect(await loadTaskLifecycleState(repo, "post-edit-cas-race")).toEqual(lifecycleBefore);
    await expect(readdir(path.join(repo, ".codex/cache/codexa-outcomes"))).rejects.toThrow();
  });

  it("serializes concurrent same-task plans into distinct revisions", async () => {
    const repo = await createHookFixtureRepo();
    await buildIndex({ repoRoot: repo });
    await changePlanQuery(repo, { task: "Concurrent plan", taskId: "plan-cas", files: ["src/main.ts"], saveSnapshot: true }, { autoRefresh: false });
    const results = await Promise.all([
      changePlanQuery(repo, { task: "Concurrent plan A", taskId: "plan-cas", files: ["src/main.ts"], invariants: ["Preserve invariant A."], saveSnapshot: true }, { autoRefresh: false }),
      changePlanQuery(repo, { task: "Concurrent plan B", taskId: "plan-cas", files: ["src/main.ts"], invariants: ["Preserve invariant B."], saveSnapshot: true }, { autoRefresh: false })
    ]);
    const revisions = results.map((result) => (result.data as { snapshot: TaskSnapshot }).snapshot.planRevision).sort();
    expect(revisions).toEqual([2, 3]);
    for (const result of results) {
      const snapshot = (result.data as { snapshot: TaskSnapshot }).snapshot;
      for (const invariant of snapshot.invariants ?? []) {
        expect(result.text).toContain(invariant.statement);
      }
    }
    const stored = JSON.parse(await readFile(path.join(repo, ".codex/cache/codexa-tasks/plan-cas.json"), "utf8")) as TaskSnapshot;
    expect(stored.planRevision).toBe(3);
    expect(stored.invariants?.map((entry) => entry.statement).sort()).toEqual(["Preserve invariant A.", "Preserve invariant B."]);
  });

  it("preserves a valid same-task snapshot when a later orientation-only plan is blocked", async () => {
    const repo = await createHookFixtureRepo();
    await buildIndex({ repoRoot: repo });
    const plan = await changePlanQuery(repo, { task: "Valid plan", taskId: "orientation-preserve", files: ["src/main.ts"], saveSnapshot: true }, { autoRefresh: false });
    const before = (plan.data as { snapshot: TaskSnapshot }).snapshot;
    const blocked = await saveBlockedTaskSnapshot({
      repoRoot: repo,
      input: { task: "Broad orientation", taskId: "orientation-preserve", saveSnapshot: true },
      reason: "orientation-only"
    });
    expect(blocked.preservedSnapshot).toBe(true);
    const after = JSON.parse(await readFile(path.join(repo, ".codex/cache/codexa-tasks/orientation-preserve.json"), "utf8")) as TaskSnapshot;
    expect(after.taskId).toBe(before.taskId);
    expect(after.planRevision).toBe(before.planRevision);
  });

  it("requires explicit invariant review and replans on a reported violation", async () => {
    const repo = await createHookFixtureRepo();
    await buildIndex({ repoRoot: repo });
    const plan = await changePlanQuery(
      repo,
      {
        task: "Keep the implementation general",
        taskId: "invariant-review",
        files: ["src/main.ts"],
        invariants: ["Do not add customer-specific behavior."],
        saveSnapshot: true
      },
      { autoRefresh: false }
    );
    const invariant = (plan.data as { snapshot: TaskSnapshot }).snapshot.invariants?.[0];
    expect(invariant).toBeDefined();

    const missing = await postEditReviewQuery(repo, { taskId: "invariant-review", persistOutcome: false }, { autoRefresh: true });
    expect(missing.data).toMatchObject({ verdict: "inspect", inspectMode: "blocking" });
    expect((missing.data as { invariantReviewMissing: string[] }).invariantReviewMissing).toContain(invariant!.id);

    const violated = await postEditReviewQuery(
      repo,
      {
        taskId: "invariant-review",
        invariantReviews: [{ invariantId: invariant!.id, status: "violated", evidence: ["A customer-only conditional remains in the diff."] }],
        persistOutcome: false
      },
      { autoRefresh: true }
    );
    expect(violated.data).toMatchObject({ verdict: "replan", completionAuthority: "replan_required" });
    expect((violated.data as { loopReview: TaskLoopReview }).loopReview.status).toBe("replan-required");
    expect((violated.data as { nextTools: Array<{ requiredInputs?: { taskId?: string } }> }).nextTools[0]?.requiredInputs?.taskId).toBe("invariant-review");
  });

  it("latches an ordinary head-drift replan until a newer plan revision", async () => {
    const repo = await createHookFixtureRepo();
    await buildIndex({ repoRoot: repo });
    await changePlanQuery(repo, { task: "Narrow edit", taskId: "scope-drift-stop", files: ["src/main.ts"], saveSnapshot: true }, { autoRefresh: false });
    await writeFile(path.join(repo, "src/main.ts"), "export function main() { return 2 }\n", "utf8");
    execFileSync("git", ["add", "src/main.ts"], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["-c", "user.name=Codexa", "-c", "user.email=codexa@example.invalid", "commit", "-m", "concurrent head drift"], { cwd: repo, stdio: "ignore" });
    const review = await postEditReviewQuery(repo, { taskId: "scope-drift-stop" }, { autoRefresh: true });
    expect(review.data).toMatchObject({ verdict: "replan", completionAuthority: "replan_required", loopReview: { status: "replan-required" } });
    const snapshot = (await changePlanSnapshot(repo, "scope-drift-stop"));
    await expect(pendingTaskLifecycleReplan(repo, snapshot)).resolves.toBeDefined();
  });

  it("deduplicates unchanged attempts and requires replan after three distinct unresolved attempts", async () => {
    const repo = await createHookFixtureRepo();
    const signalA = classifyTaskLoopFailures({ verificationMissingTargets: ["tests/a.test.ts"] });
    const signalB = classifyTaskLoopFailures({ requiredCheckMissingTargets: ["workflow:a"] });
    const signalC = classifyTaskLoopFailures({ planDriftTargets: ["src/a.ts"] });
    await writeOutcome(repo, "loop-task", 1, "attempt-a", signalA, footprint(1, 4), ["src/a.ts"]);
    await writeOutcome(repo, "loop-task", 1, "attempt-b", signalB, footprint(1, 4), ["src/a.ts"]);

    const duplicate = await recordAttempt({
      repoRoot: repo,
      taskId: "loop-task",
      planRevision: 1,
      attemptId: "attempt-b",
      attemptStatus: "unresolved",
      failureSignals: signalB,
      diffFootprint: footprint(1, 4),
      changedFiles: ["src/a.ts"]
    });
    expect(duplicate.totalDistinctAttempts).toBe(2);
    expect(duplicate.status).toBe("within-budget");

    const third = await recordAttempt({
      repoRoot: repo,
      taskId: "loop-task",
      planRevision: 1,
      attemptId: "attempt-c",
      attemptStatus: "unresolved",
      failureSignals: signalC,
      diffFootprint: footprint(1, 4),
      changedFiles: ["src/a.ts"]
    });
    expect(third.unresolvedAttemptsSincePlan).toBe(3);
    expect(third.status).toBe("replan-required");
    expect(third.reasons.join(" ")).toContain("3 distinct unresolved attempts");
  });

  it("requires an earlier replan when the same failure recurs while the diff grows", async () => {
    const repo = await createHookFixtureRepo();
    const signal = classifyTaskLoopFailures({ verificationFailedTargets: ["tests/general.test.ts"] });
    await writeOutcome(repo, "growing-loop", 1, "attempt-one", signal, footprint(1, 4), ["src/main.ts"]);

    const second = await recordAttempt({
      repoRoot: repo,
      taskId: "growing-loop",
      planRevision: 1,
      attemptId: "attempt-two",
      attemptStatus: "unresolved",
      failureSignals: signal,
      diffFootprint: footprint(2, 9),
      changedFiles: ["src/main.ts", "src/helper.ts"]
    });
    expect(second.status).toBe("replan-required");
    expect(second.reasons).toContain("the same failure fingerprint recurred while the diff footprint grew");
  });

  it("resets the unresolved streak after a resolved attempt", async () => {
    const repo = await createHookFixtureRepo();
    const failure = classifyTaskLoopFailures({ verificationMissingTargets: ["tests/general.test.ts"] });
    await writeOutcome(repo, "reset-loop", 1, "attempt-one", failure, footprint(1, 4), ["src/main.ts"]);
    await writeOutcome(repo, "reset-loop", 1, "attempt-two", [], footprint(1, 4), ["src/main.ts"], "resolved");
    const current = await recordAttempt({
      repoRoot: repo,
      taskId: "reset-loop",
      planRevision: 1,
      attemptId: "attempt-three",
      attemptStatus: "unresolved",
      failureSignals: classifyTaskLoopFailures({ planDriftTargets: ["src/other.ts"] }),
      diffFootprint: footprint(1, 4),
      changedFiles: ["src/main.ts"]
    });
    expect(current.unresolvedAttemptsSincePlan).toBe(1);
    expect(current.status).toBe("within-budget");
  });

  it("requires replan after five distinct patch attempts even when each review resolves", async () => {
    const repo = await createHookFixtureRepo();
    let latest: TaskLoopReview | undefined;
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      latest = await recordAttempt({
        repoRoot: repo,
        taskId: "total-attempt-budget",
        planRevision: 1,
        attemptId: `attempt-${attempt}`,
        attemptStatus: "resolved",
        failureSignals: [],
        diffFootprint: footprint(1, attempt),
        changedFiles: ["src/main.ts"]
      });
    }
    expect(latest?.status).toBe("replan-required");
    expect(latest?.reasons.join(" ")).toContain("5 distinct patch attempts");
  });

  it("latches a replan stop through later same-revision reviews", async () => {
    const repo = await createHookFixtureRepo();
    const stop = await recordAttempt({
      repoRoot: repo,
      taskId: "latched-loop",
      planRevision: 1,
      attemptId: "violated",
      attemptStatus: "unresolved",
      failureSignals: classifyTaskLoopFailures({ invariantViolatedTargets: ["inv-one"] }),
      diffFootprint: footprint(1, 2),
      changedFiles: ["src/main.ts"],
      forceReplanReasons: ["invariant violated"]
    });
    expect(stop.status).toBe("replan-required");
    const later = await recordAttempt({
      repoRoot: repo,
      taskId: "latched-loop",
      planRevision: 1,
      attemptId: "later-clean-review",
      attemptStatus: "resolved",
      failureSignals: [],
      diffFootprint: footprint(1, 2),
      changedFiles: ["src/main.ts"]
    });
    expect(later.status).toBe("replan-required");
    expect((await loadTaskLifecycleState(repo, "latched-loop"))?.pendingStop?.attemptId).toBe("violated");
  });

  it("serializes concurrent attempts so the third unresolved attempt cannot be missed", async () => {
    const repo = await createHookFixtureRepo();
    const reviews = await Promise.all(["one", "two", "three"].map((attemptId) => recordAttempt({
      repoRoot: repo,
      taskId: "concurrent-loop",
      planRevision: 1,
      attemptId,
      attemptStatus: "unresolved" as const,
      failureSignals: classifyTaskLoopFailures({ verificationMissingTargets: [`tests/${attemptId}.test.ts`] }),
      diffFootprint: footprint(1, 2),
      changedFiles: ["src/main.ts"]
    })));
    expect(reviews.some((review) => review.status === "replan-required")).toBe(true);
    const state = await loadTaskLifecycleState(repo, "concurrent-loop");
    expect(state?.attempts).toHaveLength(3);
    expect(state?.pendingStop).toBeDefined();
  });

  it("blocks managed edits only until a newer plan revision acknowledges the stop", async () => {
    const repo = await createHookFixtureRepo();
    await buildIndex({ repoRoot: repo });
    await changePlanQuery(
      repo,
      { task: "General lifecycle task", taskId: "hook-stop", files: ["src/main.ts"], saveSnapshot: true },
      { autoRefresh: false }
    );
    const stop = await writeOutcome(
      repo,
      "hook-stop",
      1,
      "stopped-attempt",
      classifyTaskLoopFailures({ verificationFailedTargets: ["tests/general.test.ts"] }),
      footprint(1, 4),
      ["src/main.ts"],
      "unresolved",
      "replan-required"
    );
    const snapshotPath = path.join(repo, ".codex/cache/codexa-tasks/hook-stop.json");
    const snapshot = JSON.parse(await readFile(snapshotPath, "utf8")) as TaskSnapshot;
    expect(await pendingTaskLifecycleReplan(repo, snapshot)).toMatchObject({ attemptId: stop.loopReview.attemptId });
    await expect(runPreEditHook(repo)).rejects.toThrow("requires replan");

    await changePlanQuery(
      repo,
      { task: "Replanned general lifecycle task", taskId: "hook-stop", files: ["src/main.ts"], saveSnapshot: true },
      { autoRefresh: false }
    );
    const updated = JSON.parse(await readFile(snapshotPath, "utf8")) as TaskSnapshot;
    expect(updated.planRevision).toBe(2);
    expect(await pendingTaskLifecycleReplan(repo, updated)).toBeUndefined();
    await expect(runPreEditHook(repo)).resolves.toBeUndefined();
  });

  it("fails the pre-edit hook closed when lifecycle state is malformed", async () => {
    const repo = await createHookFixtureRepo();
    await buildIndex({ repoRoot: repo });
    await changePlanQuery(repo, { task: "Malformed state", taskId: "malformed-state", files: ["src/main.ts"], saveSnapshot: true }, { autoRefresh: false });
    const stateDir = path.join(repo, ".codex/cache/codexa-task-lifecycle");
    const [stateFile] = await readdir(stateDir);
    await writeFile(path.join(stateDir, stateFile!), '{"schemaVersion":1,"taskId":"malformed-state"}\n', "utf8");
    await expect(runPreEditHook(repo)).rejects.toThrow("state is unavailable or invalid");
  });

  it("fails the pre-edit hook closed when governed lifecycle state is missing or hidden by another blocked task", async () => {
    const repo = await createHookFixtureRepo();
    await buildIndex({ repoRoot: repo });
    await changePlanQuery(repo, { task: "Stopped task", taskId: "hidden-stop", files: ["src/main.ts"], saveSnapshot: true }, { autoRefresh: false });
    await writeOutcome(
      repo,
      "hidden-stop",
      1,
      "hidden-stopped-attempt",
      classifyTaskLoopFailures({ verificationFailedTargets: ["tests/general.test.ts"] }),
      footprint(1, 4),
      ["src/main.ts"],
      "unresolved",
      "replan-required"
    );
    await saveBlockedTaskSnapshot({ repoRoot: repo, input: { task: "Other broad task", taskId: "other-task", saveSnapshot: true }, reason: "orientation-only" });
    await expect(runPreEditHook(repo)).rejects.toThrow("requires replan");

    await changePlanQuery(repo, { task: "Replanned stopped task", taskId: "hidden-stop", files: ["src/main.ts"], saveSnapshot: true }, { autoRefresh: false });
    const lifecycleDir = path.join(repo, ".codex/cache/codexa-task-lifecycle");
    await rm(lifecycleDir, { recursive: true, force: true });
    await expect(postEditReviewQuery(repo, { taskId: "hidden-stop" }, { autoRefresh: false })).rejects.toThrow("state is missing for governed snapshot");
    await expect(runPreEditHook(repo)).rejects.toThrow("state is unavailable or invalid");
  });

  it("normalizes invariant declarations and keeps satisfaction explicitly reported", () => {
    const invariants = normalizeTaskInvariants(undefined, ["  No customer-specific branches.  ", "No customer-specific branches."]);
    expect(invariants).toHaveLength(1);
    const review = reviewTaskInvariants(invariants, [
      { invariantId: invariants[0]!.id, status: "satisfied", evidence: ["Reviewed the complete diff."] }
    ]);
    expect(review.missing).toEqual([]);
    expect(review.reviews[0]).toMatchObject({ status: "satisfied", evidence: ["Reviewed the complete diff."] });
  });

  it("fails closed on contradictory duplicate reviews and rejects invariant overflow", () => {
    const invariants = normalizeTaskInvariants(undefined, ["No fixture-specific behavior."]);
    const review = reviewTaskInvariants(invariants, [
      { invariantId: invariants[0]!.id, status: "satisfied", evidence: ["Initial scan"] },
      { invariantId: invariants[0]!.id, status: "violated", evidence: ["Contradictory branch found"] }
    ]);
    expect(review.reviews[0]?.status).toBe("violated");
    expect(() => normalizeTaskInvariants(undefined, Array.from({ length: 13 }, (_, index) => `Invariant ${index}`))).toThrow("maximum of 12");
  });

  it("binds a diff footprint to bounded dirty-file content", async () => {
    const repo = await createHookFixtureRepo();
    const entry = { path: "src/main.ts", status: " M", kind: "modified" as const, staged: false, worktree: true };
    await writeFile(path.join(repo, "src/main.ts"), "export const main = 2;\n", "utf8");
    const first = await getDiffFootprint(repo, [entry]);
    await writeFile(path.join(repo, "src/main.ts"), "export const main = 3;\n", "utf8");
    const second = await getDiffFootprint(repo, [entry]);
    expect(first.trackedInsertions).toBe(second.trackedInsertions);
    expect(first.contentHashes?.["src/main.ts"]).not.toBe(second.contentHashes?.["src/main.ts"]);
    expect(first.fingerprint).not.toBe(second.fingerprint);
  });
});

function footprint(changedFileCount: number, trackedLines: number): DiffFootprintV1 {
  return {
    schemaVersion: 1,
    trackedInsertions: trackedLines,
    trackedDeletions: 0,
    changedFileCount,
    modifiedSymbolCount: changedFileCount,
    untrackedFileCount: 0,
    fingerprint: `footprint-${changedFileCount}-${trackedLines}`,
    degradedReasons: []
  };
}

async function writeOutcome(
  repo: string,
  taskId: string,
  planRevision: number,
  attemptId: string,
  failureSignals: TaskLoopFailureSignal[],
  diffFootprint: DiffFootprintV1,
  changedFiles: string[],
  attemptStatus: "resolved" | "unresolved" = "unresolved",
  status: TaskLoopReview["status"] = "within-budget"
): Promise<{ loopReview: TaskLoopReview }> {
  const loopReview = await recordAttempt({
    repoRoot: repo,
    taskId,
    planRevision,
    attemptId,
    attemptStatus,
    failureSignals,
    diffFootprint,
    changedFiles,
    forceReplanReasons: status === "replan-required" ? ["test lifecycle stop"] : []
  });
  return { loopReview };
}

async function recordAttempt(input: Parameters<typeof prepareTaskLoopAttempt>[0]): Promise<TaskLoopReview> {
  return withTaskLifecycleLock(input.repoRoot, input.taskId, async () => {
    const prepared = await prepareTaskLoopAttempt(input);
    await saveTaskLifecycleState(input.repoRoot, prepared.nextState);
    return prepared.review;
  });
}

async function changePlanSnapshot(repo: string, taskId: string): Promise<TaskSnapshot> {
  return JSON.parse(await readFile(path.join(repo, `.codex/cache/codexa-tasks/${taskId}.json`), "utf8")) as TaskSnapshot;
}
