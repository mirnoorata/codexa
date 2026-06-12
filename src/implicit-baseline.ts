import { acquireCacheLock } from "./cache-lock.js";
import { runCommand } from "./command.js";
import { getFreshness } from "./indexer.js";
import { getChangedFileEntries } from "./query/worktree.js";
import { loadTaskSnapshot, saveTaskSnapshot } from "./task-snapshots.js";

export const IMPLICIT_BASELINE_TASK = "Implicit pre-edit baseline";

export interface ImplicitBaselineResult {
  status: "saved" | "existing-snapshot" | "skipped";
  taskId?: string;
  latestTaskId?: string;
  reason?: string;
}

// Saves a plan-less dirty-tree baseline so post_edit_review always has a
// pre-edit reference, even when the agent never called change_plan. The
// snapshot deliberately declares no planned scope: post-edit review only
// computes unplanned-edit drift against a non-empty planned scope, and the
// decision layer treats head drift on an implicit baseline as informational,
// so an implicit baseline contributes changed-since-baseline, symbol, and
// verification accounting without manufacturing drift verdicts. An explicit
// change_plan(saveSnapshot=true) later replaces it as latest.
export async function saveImplicitBaselineSnapshot(repoRoot: string): Promise<ImplicitBaselineResult> {
  const release = await tryAcquireBaselineLock(repoRoot);
  if (!release) {
    return { status: "skipped", reason: "another Codexa snapshot writer is active" };
  }
  try {
    const loaded = await loadTaskSnapshot(repoRoot);
    if (loaded.snapshot) {
      return { status: "existing-snapshot", taskId: loaded.snapshot.taskId };
    }
    if (loaded.missingReason === "blocked-plan" || loaded.missingReason === "invalid-json") {
      return {
        status: "skipped",
        latestTaskId: loaded.latestTaskId,
        reason: `latest snapshot state is ${loaded.missingReason}; not replacing it with an implicit baseline`
      };
    }
    const changed = await getChangedFileEntries(repoRoot);
    if (changed.degradedReason) {
      return { status: "skipped", reason: `worktree state degraded (${changed.degradedReason}); an implicit baseline would be unreliable` };
    }
    const freshness = await getFreshness(repoRoot, undefined, { recover: false });
    const { snapshot } = await saveTaskSnapshot({
      repoRoot,
      input: { task: IMPLICIT_BASELINE_TASK, changeType: "unknown", saveSnapshot: true },
      snapshot: {
        task: IMPLICIT_BASELINE_TASK,
        changeType: "unknown",
        origin: "hook-implicit",
        snapshotFreshness: freshness,
        plannedEditTargets: [],
        plannedFiles: [],
        focusFiles: [],
        plannedTests: [],
        requiredWorkflowChecks: [],
        requiredDependencyChecks: [],
        recipes: [],
        dirtyBaseline: {
          changedEntries: changed.entries,
          dirtyFiles: changed.entries.map((entry) => entry.path),
          dirtyFileHashes: freshness.dirtyFileHashes,
          // freshnessFromStored carries the INDEXED head commit when a stored
          // bundle exists; the baseline must record the head at save time or
          // every later review reports phantom head drift.
          headCommit: await currentHeadCommit(repoRoot),
          indexedAt: freshness.indexedAt
        },
        gaps: ["implicit pre-edit baseline saved by the pre-edit hook; no planned scope or tests are declared"],
        warnings: []
      }
    });
    return { status: "saved", taskId: snapshot.taskId };
  } finally {
    await release();
  }
}

async function currentHeadCommit(repoRoot: string): Promise<string | null> {
  const result = await runCommand("git", ["-C", repoRoot, "rev-parse", "HEAD"], { timeoutMs: 2_000, maxBufferBytes: 4_096 });
  if (!result.ok) {
    return null;
  }
  const head = result.stdout.trim();
  return /^[0-9a-f]{7,40}$/u.test(head) ? head : null;
}

async function tryAcquireBaselineLock(repoRoot: string): Promise<(() => Promise<void>) | null> {
  try {
    return await acquireCacheLock({
      repoRoot,
      lockDir: ".codex/cache/codexa-implicit-baseline.lock",
      staleMs: 60_000,
      timeoutMs: 5_000,
      label: "Codexa implicit baseline"
    });
  } catch {
    return null;
  }
}
