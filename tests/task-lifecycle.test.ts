import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runPreEditHook } from "../src/cli/hooks.js";
import { buildIndex } from "../src/indexer.js";
import { changePlanQuery, postEditReviewQuery } from "../src/queries.js";
import { loadTaskSnapshot, saveBlockedTaskSnapshot, saveTaskSnapshot } from "../src/task-snapshots.js";
import { createQuerySession } from "../src/query/session.js";
import { getDiffFootprint } from "../src/query/worktree.js";
import {
  classifyTaskLoopFailures,
  loadTaskLifecycleState,
  normalizeTaskInvariants,
  pendingTaskLifecycleReplan,
  prepareTaskLoopAttempt,
  recordTaskPlanRevision,
  reviewTaskInvariants,
  saveTaskLifecycleState,
  withTaskLifecycleLock
} from "../src/task-lifecycle.js";
import type { DiffFootprintV1, TaskLoopFailureSignal, TaskLoopReview, TaskSnapshot } from "../src/types.js";
import { createHookFixtureRepo } from "./cli-hooks-fixtures.js";
import { createFixtureRepo } from "./indexer-fixtures.js";

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

  it("persists concurrent distinct-task plans without latest-pointer temp collisions", async () => {
    const repo = await createHookFixtureRepo();
    await buildIndex({ repoRoot: repo });
    const taskIds = Array.from({ length: 20 }, (_, index) => `parallel-plan-${index + 1}`);
    const results = await Promise.all(taskIds.map((taskId) => changePlanQuery(
      repo,
      { task: `Concurrent plan ${taskId}`, taskId, files: ["src/main.ts"], saveSnapshot: true },
      { autoRefresh: false }
    )));
    expect(results).toHaveLength(taskIds.length);
    for (const taskId of taskIds) {
      const snapshot = JSON.parse(await readFile(path.join(repo, `.codex/cache/codexa-tasks/${taskId}.json`), "utf8")) as TaskSnapshot;
      expect(snapshot.taskId).toBe(taskId);
    }
    const latest = JSON.parse(await readFile(path.join(repo, ".codex/cache/codexa-tasks/latest.json"), "utf8")) as { taskId: string; path: string };
    expect(taskIds).toContain(latest.taskId);
    expect(latest.path).toBe(`${latest.taskId}.json`);
  });

  it("ignores future wall-clock values when publishing and recovering later authority", async () => {
    const repo = await createHookFixtureRepo();
    await buildIndex({ repoRoot: repo });
    const first = await changePlanQuery(
      repo,
      { task: "First authority", taskId: "future-first", files: ["src/main.ts"], saveSnapshot: true },
      { autoRefresh: false }
    );
    const firstSnapshot = (first.data as { snapshot: TaskSnapshot }).snapshot;
    const snapshotPath = path.join(repo, ".codex/cache/codexa-tasks/future-first.json");
    const latestPath = path.join(repo, ".codex/cache/codexa-tasks/latest.json");
    const futureCreatedAt = "9999-12-31T23:59:59.999Z";
    await writeFile(snapshotPath, `${JSON.stringify({ ...firstSnapshot, createdAt: futureCreatedAt }, null, 2)}\n`, "utf8");
    const firstPointer = JSON.parse(await readFile(latestPath, "utf8")) as Record<string, unknown>;
    await writeFile(latestPath, `${JSON.stringify({ ...firstPointer, createdAt: futureCreatedAt }, null, 2)}\n`, "utf8");

    const second = await changePlanQuery(
      repo,
      { task: "Authority after clock rollback", taskId: "after-clock-rollback", files: ["src/main.ts"], saveSnapshot: true },
      { autoRefresh: false }
    );
    const secondSnapshot = (second.data as { snapshot: TaskSnapshot }).snapshot;
    expect(secondSnapshot.publicationSequence).toBeGreaterThan(firstSnapshot.publicationSequence ?? 0);
    expect((await loadTaskSnapshot(repo)).snapshot?.taskId).toBe("after-clock-rollback");

    await writeFile(latestPath, "{corrupt\n", "utf8");
    const recovered = await loadTaskSnapshot(repo);
    expect(recovered).toMatchObject({ recoveredLatest: true, latestTaskId: "after-clock-rollback" });
  });

  it("repairs a high-sequence latest pointer when its blocked artifact is dangling", async () => {
    const repo = await createHookFixtureRepo();
    await buildIndex({ repoRoot: repo });
    const first = await changePlanQuery(
      repo,
      { task: "Initial authority", taskId: "initial-authority", files: ["src/main.ts"], saveSnapshot: true },
      { autoRefresh: false }
    );
    const firstSnapshot = (first.data as { snapshot: TaskSnapshot }).snapshot;
    const latestPath = path.join(repo, ".codex/cache/codexa-tasks/latest.json");
    const danglingSequence = (firstSnapshot.publicationSequence ?? 1) + 10_000;
    await writeFile(latestPath, `${JSON.stringify({
      schemaVersion: 1,
      taskId: "dangling-blocked",
      path: "dangling-blocked.blocked.json",
      createdAt: new Date().toISOString(),
      publicationSequence: danglingSequence,
      blocked: true,
      reason: "dangling test marker",
      origin: "blocked"
    }, null, 2)}\n`, "utf8");

    const later = await changePlanQuery(
      repo,
      { task: "Valid later authority", taskId: "valid-later-authority", files: ["src/main.ts"], saveSnapshot: true },
      { autoRefresh: false }
    );
    const laterSnapshot = (later.data as { snapshot: TaskSnapshot }).snapshot;
    expect(laterSnapshot.publicationSequence).toBeLessThan(danglingSequence);
    expect(JSON.parse(await readFile(latestPath, "utf8"))).toMatchObject({
      taskId: "valid-later-authority",
      path: "valid-later-authority.json",
      publicationSequence: laterSnapshot.publicationSequence
    });
    expect(await loadTaskSnapshot(repo)).toMatchObject({
      latestTaskId: "valid-later-authority",
      snapshot: { taskId: "valid-later-authority", publicationSequence: laterSnapshot.publicationSequence }
    });
  });

  it("repairs an interrupted same-task artifact before a delayed writer can regress latest", async () => {
    const repo = await createHookFixtureRepo();
    const index = await buildIndex({ repoRoot: repo });
    const snapshot = (task: string) => ({
      task,
      changeType: "unknown" as const,
      snapshotFreshness: index.freshness,
      plannedEditTargets: ["src/main.ts"],
      plannedFiles: ["src/main.ts"],
      focusFiles: [],
      plannedTests: [],
      requiredWorkflowChecks: [],
      requiredDependencyChecks: [],
      recipes: [],
      dirtyBaseline: {
        changedEntries: [],
        dirtyFiles: [],
        dirtyFileHashes: {},
        headCommit: index.freshness.headCommit,
        indexedAt: index.freshness.indexedAt
      },
      gaps: [],
      warnings: []
    });
    let releaseDelayed!: () => void;
    let delayedEntered!: () => void;
    const releaseGate = new Promise<void>((resolve) => { releaseDelayed = resolve; });
    const enteredGate = new Promise<void>((resolve) => { delayedEntered = resolve; });
    let delayed: ReturnType<typeof saveTaskSnapshot> | undefined;
    try {
      delayed = saveTaskSnapshot({
        repoRoot: repo,
        input: { task: "Delayed stale plan", taskId: "delayed-stale", files: ["src/main.ts"], saveSnapshot: true },
        snapshot: snapshot("Delayed stale plan"),
        beforePersist: async () => {
          delayedEntered();
          await releaseGate;
        }
      });
      await enteredGate;
      const current = await saveTaskSnapshot({
        repoRoot: repo,
        input: { task: "Current authority", taskId: "current-authority", files: ["src/main.ts"], saveSnapshot: true },
        snapshot: snapshot("Current authority")
      });
      const interruptedSequence = (current.snapshot.publicationSequence ?? 0) + 1;
      const currentPath = path.join(repo, ".codex/cache/codexa-tasks/current-authority.json");
      // Model a crash after the same-task artifact and matching lifecycle state
      // are durable but before latest.json is advanced.
      const interruptedRevision = (current.snapshot.planRevision ?? 1) + 1;
      await writeFile(currentPath, `${JSON.stringify({
        ...current.snapshot,
        planRevision: interruptedRevision,
        publicationSequence: interruptedSequence
      }, null, 2)}\n`, "utf8");
      await writeFile(path.join(repo, ".codex/cache/codexa-tasks/.latest-publication-sequence"), `${interruptedSequence}\n`, "utf8");
      await recordTaskPlanRevision(repo, "current-authority", interruptedRevision, current.snapshot.invariants ?? []);

      releaseDelayed();
      const stale = await delayed;
      expect(stale.snapshot.publicationSequence).toBeLessThan(interruptedSequence);
      expect(JSON.parse(await readFile(path.join(repo, ".codex/cache/codexa-tasks/latest.json"), "utf8"))).toMatchObject({
        taskId: "current-authority",
        path: "current-authority.json",
        publicationSequence: interruptedSequence
      });
      expect(await loadTaskSnapshot(repo)).toMatchObject({
        latestTaskId: "current-authority",
        snapshot: { taskId: "current-authority", publicationSequence: interruptedSequence }
      });
    } finally {
      releaseDelayed?.();
      await delayed?.catch(() => undefined);
    }
  });

  it("uses one authority order for delayed same-time publications and recovery", async () => {
    const repo = await createHookFixtureRepo();
    const index = await buildIndex({ repoRoot: repo });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-07-19T12:00:00.000Z"));
    let releaseDelayed!: () => void;
    let delayedEntered!: () => void;
    const releaseGate = new Promise<void>((resolve) => { releaseDelayed = resolve; });
    const enteredGate = new Promise<void>((resolve) => { delayedEntered = resolve; });
    const snapshot = (task: string) => ({
      task,
      changeType: "unknown" as const,
      snapshotFreshness: index.freshness,
      plannedEditTargets: ["src/main.ts"],
      plannedFiles: ["src/main.ts"],
      focusFiles: [],
      plannedTests: [],
      requiredWorkflowChecks: [],
      requiredDependencyChecks: [],
      recipes: [],
      dirtyBaseline: {
        changedEntries: [],
        dirtyFiles: [],
        dirtyFileHashes: {},
        headCommit: index.freshness.headCommit,
        indexedAt: index.freshness.indexedAt
      },
      gaps: [],
      warnings: []
    });
    let delayed: ReturnType<typeof saveTaskSnapshot> | undefined;
    try {
      delayed = saveTaskSnapshot({
        repoRoot: repo,
        input: { task: "Delayed explicit", taskId: "z-delayed-explicit", files: ["src/main.ts"], saveSnapshot: true },
        snapshot: snapshot("Delayed explicit"),
        beforePersist: async () => {
          delayedEntered();
          await releaseGate;
        }
      });
      await enteredGate;
      const newer = await saveTaskSnapshot({
        repoRoot: repo,
        input: { task: "Newer explicit", taskId: "a-newer-explicit", files: ["src/main.ts"], saveSnapshot: true },
        snapshot: snapshot("Newer explicit")
      });
      releaseDelayed();
      const older = await delayed;
      expect(newer.snapshot.publicationSequence).toBeGreaterThan(older.snapshot.publicationSequence ?? 0);
      expect((await loadTaskSnapshot(repo)).snapshot?.taskId).toBe("a-newer-explicit");

      await writeFile(path.join(repo, ".codex/cache/codexa-tasks/latest.json"), "{corrupt\n", "utf8");
      expect(await loadTaskSnapshot(repo)).toMatchObject({ recoveredLatest: true, latestTaskId: "a-newer-explicit" });
    } finally {
      releaseDelayed?.();
      await delayed?.catch(() => undefined);
      vi.useRealTimers();
    }
  });

  it("recovers a newer same-task snapshot when a crash occurs before blocked-marker deletion", async () => {
    const repo = await createHookFixtureRepo();
    const index = await buildIndex({ repoRoot: repo });
    const taskId = "blocked-upgrade-crash";
    await saveBlockedTaskSnapshot({
      repoRoot: repo,
      input: { task: "Resolve the target", taskId, saveSnapshot: true },
      reason: "orientation-only"
    });
    const dir = path.join(repo, ".codex/cache/codexa-tasks");
    await expect(saveTaskSnapshot({
      repoRoot: repo,
      input: { task: "Apply the resolved edit", taskId, files: ["src/main.ts"], saveSnapshot: true },
      snapshot: {
        task: "Apply the resolved edit",
        changeType: "unknown",
        snapshotFreshness: index.freshness,
        plannedEditTargets: ["src/main.ts"],
        plannedFiles: ["src/main.ts"],
        focusFiles: [],
        plannedTests: [],
        requiredWorkflowChecks: [],
        requiredDependencyChecks: [],
        recipes: [],
        dirtyBaseline: {
          changedEntries: [],
          dirtyFiles: [],
          dirtyFileHashes: {},
          headCommit: index.freshness.headCommit,
          indexedAt: index.freshness.indexedAt
        },
        gaps: [],
        warnings: []
      },
      afterPersistBeforeBlockedCleanup: async () => {
        throw new Error("simulated crash before blocked cleanup");
      }
    })).rejects.toThrow("simulated crash before blocked cleanup");

    const acceptedSnapshot = JSON.parse(await readFile(path.join(dir, `${taskId}.json`), "utf8")) as TaskSnapshot;
    expect(JSON.parse(await readFile(path.join(dir, "latest.json"), "utf8"))).toMatchObject({ taskId, blocked: true });
    expect(JSON.parse(await readFile(path.join(dir, `${taskId}.blocked.json`), "utf8"))).toMatchObject({ taskId, kind: "change-plan-snapshot-blocked" });
    for (const loaded of [await loadTaskSnapshot(repo), await loadTaskSnapshot(repo, taskId)]) {
      expect(loaded).toMatchObject({
        latestTaskId: taskId,
        missingReason: "blocked-plan",
        blockedSnapshot: { taskId }
      });
      expect(loaded.snapshot).toBeUndefined();
    }
    await expect(pendingTaskLifecycleReplan(repo, acceptedSnapshot)).rejects.toThrow("state is missing for governed snapshot");

    await recordTaskPlanRevision(repo, taskId, acceptedSnapshot.planRevision ?? 1, acceptedSnapshot.invariants ?? []);
    for (const loaded of [await loadTaskSnapshot(repo), await loadTaskSnapshot(repo, taskId)]) {
      expect(loaded).toMatchObject({
        recoveredLatest: true,
        latestTaskId: taskId,
        snapshot: { taskId, publicationSequence: acceptedSnapshot.publicationSequence }
      });
      expect(loaded.missingReason).toBeUndefined();
      await expect(pendingTaskLifecycleReplan(repo, loaded.snapshot)).resolves.toBeUndefined();
    }
    await expect(runPreEditHook(repo)).resolves.toBeUndefined();
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
    expect(blocked.taskId).not.toBe("orientation-preserve");
    const after = JSON.parse(await readFile(path.join(repo, ".codex/cache/codexa-tasks/orientation-preserve.json"), "utf8")) as TaskSnapshot;
    expect(after.taskId).toBe(before.taskId);
    expect(after.planRevision).toBe(before.planRevision);
  });

  it("preserves an existing task snapshot while issuing a followable blocked candidate flow", async () => {
    const repo = await createHookFixtureRepo();
    await mkdir(path.join(repo, "src/a"), { recursive: true });
    await mkdir(path.join(repo, "src/b"), { recursive: true });
    await writeFile(path.join(repo, "src/a/config.ts"), "export const config = 'a'\n", "utf8");
    await writeFile(path.join(repo, "src/b/config.ts"), "export const config = 'b'\n", "utf8");
    await buildIndex({ repoRoot: repo });
    const originalTaskId = "candidate-preserve";
    const valid = await changePlanQuery(repo, {
      task: "Fix src/main.ts",
      taskId: originalTaskId,
      files: ["src/main.ts"],
      invariants: ["Keep the main contract stable."],
      saveSnapshot: true
    }, { autoRefresh: false });
    const before = (valid.data as { snapshot: TaskSnapshot }).snapshot;
    expect((valid.data as { nextTools: Array<{ tool: string; readOnly: boolean; writes: string[] }> }).nextTools).toEqual([
      expect.objectContaining({
        tool: "post_edit_review",
        readOnly: false,
        writes: [".codex/cache/codexa-task-lifecycle", ".codex/cache/codexa-outcomes"]
      })
    ]);

    const blocked = await changePlanQuery(repo, { task: "Fix config.ts", taskId: originalTaskId, files: ["config.ts"], saveSnapshot: true }, { autoRefresh: false });
    const blockedData = blocked.data as {
      snapshotBlock?: { taskId: string };
      targetCandidates: Array<{ candidateId: string }>;
    };
    expect(blockedData.snapshotBlock?.taskId).toBeTruthy();
    expect(blockedData.snapshotBlock?.taskId).not.toBe(originalTaskId);
    expect(blockedData.targetCandidates.length).toBeGreaterThan(0);
    const preserved = JSON.parse(await readFile(path.join(repo, `.codex/cache/codexa-tasks/${originalTaskId}.json`), "utf8")) as TaskSnapshot;
    expect(preserved.planRevision).toBe(before.planRevision);
    expect(preserved.plannedEditTargets).toEqual(before.plannedEditTargets);

    const followed = await changePlanQuery(repo, {
      taskId: blockedData.snapshotBlock?.taskId,
      followCandidate: blockedData.targetCandidates[0]?.candidateId,
      saveSnapshot: true
    }, { autoRefresh: false });
    expect((followed.data as { editReadiness: { editable: boolean }; followCandidate?: { status: string }; snapshot: TaskSnapshot })).toMatchObject({
      editReadiness: { editable: true },
      followCandidate: { status: "accepted" }
    });
    expect((followed.data as { snapshot: TaskSnapshot }).snapshot.invariants?.map((entry) => entry.statement)).toContain("Keep the main contract stable.");
  });

  it("binds a followed structural candidate to its source and destination", async () => {
    const repo = await createHookFixtureRepo();
    await mkdir(path.join(repo, "src/a"), { recursive: true });
    await mkdir(path.join(repo, "src/b"), { recursive: true });
    await writeFile(path.join(repo, "src/a/config.ts"), "export const config = 'a'\n", "utf8");
    await writeFile(path.join(repo, "src/b/config.ts"), "export const config = 'b'\n", "utf8");
    await buildIndex({ repoRoot: repo });
    const blocked = await changePlanQuery(repo, { task: "Rename config.ts to src/renamed-config.ts", taskId: "rename-config", files: ["config.ts"], saveSnapshot: true }, { autoRefresh: false });
    const blockedData = blocked.data as { snapshotBlock: { taskId: string }; targetCandidates: Array<{ candidateId: string; path: string }> };
    const selected = blockedData.targetCandidates.find((candidate) => candidate.path === "src/a/config.ts")!;
    const followed = await changePlanQuery(repo, { taskId: blockedData.snapshotBlock.taskId, followCandidate: selected.candidateId, saveSnapshot: true }, { autoRefresh: false });
    expect((followed.data as { followCandidate: { status: string; plannedEditTargets: string[] }; snapshot: TaskSnapshot })).toMatchObject({
      followCandidate: { status: "accepted", plannedEditTargets: ["src/a/config.ts", "src/renamed-config.ts"] },
      snapshot: { plannedEditTargets: ["src/a/config.ts", "src/renamed-config.ts"] }
    });
  });

  it("preserves resolved file and symbol scope while replacing one ambiguous followed target", async () => {
    const repo = await createHookFixtureRepo();
    await mkdir(path.join(repo, "src/a"), { recursive: true });
    await mkdir(path.join(repo, "src/b"), { recursive: true });
    await writeFile(path.join(repo, "src/a/config.ts"), "export const config = 'a'\n", "utf8");
    await writeFile(path.join(repo, "src/b/config.ts"), "export const config = 'b'\n", "utf8");
    await buildIndex({ repoRoot: repo });

    const blocked = await changePlanQuery(repo, {
      task: "Fix main and config.ts",
      taskId: "mixed-candidate-scope",
      files: ["src/main.ts", "config.ts"],
      symbols: ["main"],
      saveSnapshot: true
    }, { autoRefresh: false });
    const blockedData = blocked.data as {
      snapshotBlock: { taskId: string };
      targetCandidates: Array<{ candidateId: string; path: string; nextChangePlanArgs: { files?: string[]; symbols?: string[] } }>;
    };
    const selected = blockedData.targetCandidates.find((candidate) => candidate.path === "src/a/config.ts" && candidate.nextChangePlanArgs.files?.includes("src/main.ts"))!;
    expect(selected.nextChangePlanArgs.files).toEqual(["src/main.ts", "src/a/config.ts"]);
    expect(selected.nextChangePlanArgs.symbols).toHaveLength(1);

    const followed = await changePlanQuery(repo, {
      taskId: blockedData.snapshotBlock.taskId,
      followCandidate: selected.candidateId,
      saveSnapshot: true
    }, { autoRefresh: false });
    const followedData = followed.data as { followCandidate: { status: string; plannedEditTargets: string[] }; snapshot: TaskSnapshot };
    expect(followedData.followCandidate.status, JSON.stringify(followedData.followCandidate)).toBe("accepted");
    expect(followedData).toMatchObject({
      followCandidate: { status: "accepted", plannedEditTargets: ["src/a/config.ts", "src/main.ts"] },
      snapshot: { plannedEditTargets: ["src/a/config.ts", "src/main.ts"] }
    });
    expect(followedData.snapshot.input.files).toEqual(["src/main.ts", "src/a/config.ts"]);
    expect(followedData.snapshot.input.symbols).toEqual(selected.nextChangePlanArgs.symbols);
  });

  it("does not mutate a blocked marker when candidate replay is rejected", async () => {
    const repo = await createHookFixtureRepo();
    await mkdir(path.join(repo, "src/a"), { recursive: true });
    await mkdir(path.join(repo, "src/b"), { recursive: true });
    await writeFile(path.join(repo, "src/a/config.ts"), "export const config = 'a'\n", "utf8");
    await writeFile(path.join(repo, "src/b/config.ts"), "export const config = 'b'\n", "utf8");
    await buildIndex({ repoRoot: repo });
    const blocked = await changePlanQuery(repo, { task: "Move config.ts to /tmp/outside", taskId: "rejected-candidate", files: ["config.ts"], saveSnapshot: true }, { autoRefresh: false });
    const blockedData = blocked.data as { snapshotBlock: { taskId: string; path: string }; targetCandidates: Array<{ candidateId: string }> };
    const markerPath = path.join(repo, blockedData.snapshotBlock.path);
    const markerBefore = await readFile(markerPath, "utf8");
    const followed = await changePlanQuery(repo, { taskId: blockedData.snapshotBlock.taskId, followCandidate: blockedData.targetCandidates[0]!.candidateId, saveSnapshot: true }, { autoRefresh: false });
    expect((followed.data as { followCandidate?: { status?: string } }).followCandidate).toMatchObject({ status: "rejected" });
    expect(await readFile(markerPath, "utf8")).toBe(markerBefore);
  });

  it("keeps a newer explicit snapshot authoritative over a delayed implicit publication", async () => {
    const repo = await createHookFixtureRepo();
    const index = await buildIndex({ repoRoot: repo });
    let releaseImplicit!: () => void;
    let implicitEntered!: () => void;
    const releaseGate = new Promise<void>((resolve) => { releaseImplicit = resolve; });
    const enteredGate = new Promise<void>((resolve) => { implicitEntered = resolve; });
    const snapshot = (task: string, origin?: "hook-implicit") => ({
      task,
      changeType: "unknown" as const,
      ...(origin ? { origin } : {}),
      snapshotFreshness: index.freshness,
      plannedEditTargets: origin ? [] : ["src/main.ts"],
      plannedFiles: origin ? [] : ["src/main.ts"],
      focusFiles: [],
      plannedTests: [],
      requiredWorkflowChecks: [],
      requiredDependencyChecks: [],
      recipes: [],
      dirtyBaseline: {
        changedEntries: [],
        dirtyFiles: [],
        dirtyFileHashes: {},
        headCommit: index.freshness.headCommit,
        indexedAt: index.freshness.indexedAt
      },
      gaps: [],
      warnings: []
    });

    const delayedImplicit = saveTaskSnapshot({
      repoRoot: repo,
      input: { task: "Implicit baseline", taskId: "implicit-race", saveSnapshot: true },
      snapshot: snapshot("Implicit baseline", "hook-implicit"),
      beforePersist: async () => {
        implicitEntered();
        await releaseGate;
      }
    });
    await enteredGate;
    const explicit = await saveTaskSnapshot({
      repoRoot: repo,
      input: { task: "Explicit plan", taskId: "explicit-race", files: ["src/main.ts"], saveSnapshot: true },
      snapshot: snapshot("Explicit plan")
    });
    releaseImplicit();
    await delayedImplicit;

    const latest = await loadTaskSnapshot(repo);
    expect(latest.snapshot?.taskId).toBe(explicit.snapshot.taskId);
    await expect(readFile(path.join(repo, ".codex/cache/codexa-tasks/implicit-race.json"), "utf8")).rejects.toThrow();
  });

  it("never reports a followed candidate accepted unless replay saved an editable plan", async () => {
    const repo = await createFixtureRepo();
    await buildIndex({ repoRoot: repo });
    await changePlanQuery(repo, { task: "Valid helper plan", taskId: "candidate-replay-old", files: ["src/util.ts"], saveSnapshot: true }, { autoRefresh: false });
    const blocked = await changePlanQuery(repo, { task: "Fix helper behavior", taskId: "candidate-replay-old", saveSnapshot: true }, { autoRefresh: false });
    const blockedData = blocked.data as { snapshotBlock?: { taskId: string }; targetCandidates: Array<{ candidateId: string }> };
    expect(blockedData.snapshotBlock?.taskId).toBeTruthy();
    expect(blockedData.targetCandidates.length).toBeGreaterThan(0);

    const followed = await changePlanQuery(repo, {
      taskId: blockedData.snapshotBlock?.taskId,
      followCandidate: blockedData.targetCandidates[0]?.candidateId,
      saveSnapshot: true
    }, { autoRefresh: false });
    const followedData = followed.data as {
      editReadiness?: { editable?: boolean };
      followCandidate?: { status?: string };
      snapshot?: TaskSnapshot;
    };
    if (followedData.followCandidate?.status === "accepted") {
      expect(followedData.editReadiness?.editable).toBe(true);
      expect(followedData.snapshot?.taskId).toBeTruthy();
    } else {
      expect(followedData.followCandidate?.status).toBe("rejected");
    }
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
