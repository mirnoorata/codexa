import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  classifyTaskLoopFailures,
  loadTaskLifecycleState,
  prepareTaskLoopAttempt,
  saveTaskLifecycleState,
  withTaskLifecycleLock
} from "../src/task-lifecycle.js";

describe("task lifecycle attempt ordering", () => {
  it("reappends a revisited attempt so proof consumers see the actual latest coverage gap", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-lifecycle-order-"));
    const failureSignals = classifyTaskLoopFailures({
      verificationMissingTargets: ["post-edit-review-scope:1-target(s)-omitted"]
    });
    await record(repo, "attempt-a", "unresolved", failureSignals, 1);
    await record(repo, "attempt-b", "resolved", [], 2);
    await record(repo, "attempt-a", "unresolved", failureSignals, 1);

    const state = await loadTaskLifecycleState(repo, "revisited-attempt-order");
    expect(state?.attempts.map((attempt) => attempt.attemptId)).toEqual(["attempt-b", "attempt-a"]);
    expect(state?.attempts.at(-1)).toMatchObject({
      attemptId: "attempt-a",
      attemptStatus: "unresolved",
      failureSignals: expect.arrayContaining([
        expect.objectContaining({ targets: ["post-edit-review-scope:1-target(s)-omitted"] })
      ])
    });
  });
});

async function record(
  repoRoot: string,
  attemptId: string,
  attemptStatus: "resolved" | "unresolved",
  failureSignals: ReturnType<typeof classifyTaskLoopFailures>,
  trackedInsertions: number
): Promise<void> {
  await withTaskLifecycleLock(repoRoot, "revisited-attempt-order", async () => {
    const prepared = await prepareTaskLoopAttempt({
      repoRoot,
      taskId: "revisited-attempt-order",
      planRevision: 1,
      attemptId,
      attemptStatus,
      failureSignals,
      diffFootprint: {
        schemaVersion: 1,
        trackedInsertions,
        trackedDeletions: 0,
        changedFileCount: 1,
        modifiedSymbolCount: 1,
        untrackedFileCount: 0,
        fingerprint: `footprint-${trackedInsertions}`,
        degradedReasons: []
      },
      changedFiles: ["src/main.ts"]
    });
    await saveTaskLifecycleState(repoRoot, prepared.nextState);
  });
}
