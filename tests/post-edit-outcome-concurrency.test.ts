import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  recordCodexaHookEvent,
  postEditHookReviewSignature,
  savePostEditHookReviewState,
  savePostEditOutcome,
  type PostEditOutcomeInput
} from "../src/post-edit-outcomes.js";
import { createPostEditReviewCoverage } from "../src/post-edit-review-coverage.js";
import { CURRENT_VERIFICATION_PROVENANCE } from "../src/types.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("post-edit persistence concurrency", () => {
  it("invalidates duplicate-review signatures when verification provenance changes", () => {
    const freshness = outcomeInput("/path/to/project", []).freshness;
    const legacyPayload = {
      taskId: "outcome-collision",
      autoVerifyMode: "autoverify:off",
      snapshotId: freshness.snapshotId,
      indexedAt: freshness.indexedAt,
      headCommit: freshness.headCommit,
      dirtyFiles: freshness.dirtyFiles,
      dirtyFileHashes: freshness.dirtyFileHashes
    };
    const currentPayload = {
      taskId: "outcome-collision",
      autoVerifyMode: "autoverify:off",
      verificationProvenance: CURRENT_VERIFICATION_PROVENANCE,
      snapshotId: freshness.snapshotId,
      indexedAt: freshness.indexedAt,
      headCommit: freshness.headCommit,
      dirtyFiles: freshness.dirtyFiles,
      dirtyFileHashes: freshness.dirtyFileHashes
    };
    const digest = (value: unknown) => createHash("sha1").update(JSON.stringify(value)).digest("hex");

    expect(postEditHookReviewSignature({ freshness, taskId: "outcome-collision" })).toBe(digest(currentPayload));
    expect(digest(currentPayload)).not.toBe(digest(legacyPayload));
  });

  it("serializes hook review pointer writers and uses collision-safe atomic temp files", async () => {
    const repo = await managedRepo("codexa-hook-review-concurrency-");
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);

    const signatures = Array.from({ length: 6 }, (_, index) => `signature-${index}`);
    await Promise.all(signatures.map((signature) => savePostEditHookReviewState(repo, { signature, autoVerifyStatus: "off" })));

    const outcomeDir = path.join(repo, ".codex/cache/codexa-outcomes");
    const latest = JSON.parse(await readFile(path.join(outcomeDir, "latest-hook-review.json"), "utf8")) as { signature: string };
    expect(signatures).toContain(latest.signature);
    expect((await readdir(outcomeDir)).filter((entry) => entry.endsWith(".tmp"))).toEqual([]);
  });

  it("keeps concurrent hook journal appends as complete JSON records", async () => {
    const repo = await managedRepo("codexa-hook-events-concurrency-");
    const taskIds = Array.from({ length: 8 }, (_, index) => `task-${index}`);

    await Promise.all(
      taskIds.map((taskId) =>
        recordCodexaHookEvent(repo, {
          hook: "post-edit",
          status: "ok",
          durationMs: 1,
          taskId
        })
      )
    );

    const eventDir = path.join(repo, ".codex/cache/codexa-hooks");
    const events = (await readFile(path.join(eventDir, "events.ndjson"), "utf8"))
      .trim()
      .split(/\r?\n/u)
      .map((line) => JSON.parse(line) as { taskId: string });
    const latest = JSON.parse(await readFile(path.join(eventDir, "latest.json"), "utf8")) as { taskId: string };
    expect(events.map((event) => event.taskId).sort()).toEqual([...taskIds].sort());
    expect(taskIds).toContain(latest.taskId);
  });

  it("keeps distinct immutable outcomes created in the same millisecond", async () => {
    const repo = await managedRepo("codexa-outcome-id-collision-");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-08-03T12:00:00.123Z"));

    const first = await savePostEditOutcome(outcomeInput(repo, ["npm run typecheck"]));
    const second = await savePostEditOutcome(outcomeInput(repo, ["npm test"]));

    expect(first.outcome.createdAt).toBe(second.outcome.createdAt);
    expect(first.outcome.outcomeId).not.toBe(second.outcome.outcomeId);
    expect(first.path).not.toBe(second.path);
    expect(JSON.parse(await readFile(first.path, "utf8"))).toMatchObject({
      outcomeId: first.outcome.outcomeId,
      ranCommands: ["npm run typecheck"]
    });
    expect(JSON.parse(await readFile(second.path, "utf8"))).toMatchObject({
      outcomeId: second.outcome.outcomeId,
      ranCommands: ["npm test"]
    });
  });
});

async function managedRepo(prefix: string): Promise<string> {
  const repo = await mkdtemp(path.join(os.tmpdir(), prefix));
  await mkdir(path.join(repo, ".codex"), { recursive: true });
  return repo;
}

function outcomeInput(repoRoot: string, ranCommands: string[]): PostEditOutcomeInput {
  const target = "src/main.ts";
  return {
    repoRoot,
    task: "Persist collision-safe outcomes",
    taskId: "outcome-collision",
    verdict: "continue",
    inspectMode: "none",
    inspectReasons: [],
    completionAuthority: "complete",
    freshness: {
      schemaVersion: 1,
      snapshotId: "snap-outcome-collision",
      repoRoot: ".",
      gitRoot: null,
      headCommit: null,
      indexedAt: "2026-08-03T11:59:00.000Z",
      dirtyFiles: [],
      dirtyFileHashes: {},
      indexedDirtyFileHashes: {},
      indexedDirtyFiles: [],
      missing: false,
      stale: false,
      reason: "current",
      parserErrorCount: 0
    },
    planRevision: 1,
    invariants: [],
    invariantReviews: [],
    failureSignals: [],
    diffFootprint: {
      schemaVersion: 1,
      trackedInsertions: 1,
      trackedDeletions: 0,
      changedFileCount: 1,
      modifiedSymbolCount: 1,
      untrackedFileCount: 0,
      fingerprint: "outcome-collision-footprint",
      degradedReasons: []
    },
    loopReview: {
      policyVersion: "task-loop-v1",
      attemptId: "outcome-collision-attempt",
      attemptStatus: "resolved",
      totalDistinctAttempts: 1,
      attemptsSincePlan: 1,
      unresolvedAttemptsSincePlan: 0,
      recurringFailures: [],
      cumulativeDiffGrowth: {
        firstTrackedLines: 1,
        currentTrackedLines: 1,
        peakTrackedLines: 1,
        newFilesSinceFirstAttempt: 0,
        peakModifiedSymbols: 1
      },
      status: "within-budget",
      reasons: []
    },
    changedFiles: [target],
    plannedEditTargets: [target],
    reviewTargets: [target],
    reviewCandidateTargets: [target],
    reviewCoverage: createPostEditReviewCoverage({
      candidateTargets: [target],
      analyzedTargets: [target],
      targetLimit: 3,
      taskId: "outcome-collision",
      planRevision: 1,
      snapshotCreatedAt: null,
      snapshotPublicationSequence: null
    }),
    unplannedEditedFiles: [],
    unindexedEditedFiles: [],
    modifiedSymbols: [],
    modifiedPublicSymbols: [],
    affectedWorkflows: [],
    workflowChecks: [],
    dependencyChecks: [],
    driftReasons: [],
    tests: [],
    degradedSnapshotTests: [],
    testsNotRun: [],
    missedLikelyTests: [],
    ranTests: [],
    ranCommands,
    ranCommandReports: [],
    commandEnvelopes: [],
    waivedChecks: [],
    waivers: [],
    verificationCoverage: [],
    verificationLedger: [],
    verificationArtifacts: [],
    riskDeltas: []
  };
}
