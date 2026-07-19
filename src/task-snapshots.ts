import { existsSync } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";
import { atomicJsonWrite, atomicTextWrite, readJson, redactRepoPath, taskSnapshotRollbackPath } from "./task-snapshot-storage.js";
import type { ChangePlanInput, ChangeType, TaskSnapshot } from "./types.js";
import { loadTaskLifecycleState, normalizeTaskInvariants, recordTaskPlanRevision, taskInvariantId, withTaskLifecycleLock } from "./task-lifecycle.js";
import { MAX_TASK_INVARIANTS, taskInvariantStatementSchema } from "./lifecycle-contract.js";
import { stableId } from "./util.js";

const SNAPSHOT_DIR = ".codex/cache/codexa-tasks";
const LEGACY_SNAPSHOT_DIR = ".codex/cache/codexa-task-snapshots";
const LATEST_FILE = "latest.json";
const PUBLICATION_SEQUENCE_FILE = ".latest-publication-sequence";
const CHANGE_TYPES = new Set<ChangeType>(["style", "api", "behavior", "rename", "delete", "unknown"]);

export interface SaveTaskSnapshotInput {
  repoRoot: string;
  input: ChangePlanInput;
  snapshot: Omit<TaskSnapshot, "schemaVersion" | "taskId" | "repoRoot" | "createdAt" | "publicationSequence" | "input">;
  beforePersist?: () => Promise<void>;
  afterPersistBeforeBlockedCleanup?: () => Promise<void>;
}

export interface SaveBlockedTaskSnapshotInput {
  repoRoot: string;
  input: ChangePlanInput;
  reason: string;
  details?: unknown;
}

export interface TaskSnapshotLoadResult {
  snapshot?: TaskSnapshot;
  blockedSnapshot?: BlockedTaskSnapshotMarker;
  path?: string;
  latestTaskId?: string;
  missingReason?: "missing-directory" | "missing-latest" | "missing-task" | "invalid-json" | "blocked-plan";
  error?: string;
  recoveredLatest?: boolean;
}

export interface BlockedTaskSnapshotMarker {
  schemaVersion: 1;
  kind: "change-plan-snapshot-blocked";
  taskId: string;
  repoRoot?: string;
  createdAt?: string;
  publicationSequence?: number;
  input?: ChangePlanInput;
  reason?: string;
  details?: unknown;
}

export async function saveTaskSnapshot({ repoRoot, input, snapshot, beforePersist, afterPersistBeforeBlockedCleanup }: SaveTaskSnapshotInput): Promise<{ snapshot: TaskSnapshot; path: string }> {
  const repo = path.resolve(repoRoot);
  const createdAt = new Date().toISOString();
  const taskId = allocateTaskSnapshotId(repo, input, createdAt);
  return withTaskLifecycleLock(repo, taskId, async () => {
    const dir = snapshotDir(repo);
    await fs.mkdir(dir, { recursive: true });
    const snapshotPath = path.join(dir, `${taskId}.json`);
    const previousSnapshotPath = taskSnapshotRollbackPath(dir, taskId);
    const priorRead = await readJson<TaskSnapshot>(snapshotPath);
    const priorSnapshot = priorRead.ok && isTaskSnapshot(priorRead.value) ? priorRead.value : undefined;
    const lifecycle = await loadTaskLifecycleState(repo, taskId);
    const planRevision = Math.max(priorSnapshot?.planRevision ?? (priorSnapshot ? 1 : 0), lifecycle?.planRevision ?? 0) + 1;
    const invariants = normalizeTaskInvariants(lifecycle?.invariants ?? priorSnapshot?.invariants, input.invariants ?? snapshot.invariants?.map((entry) => entry.statement));
    const publicationSequence = await reservePublicationSequence(repo, dir);
    const saved = redactRepoPath(
      {
        schemaVersion: 1,
        taskId,
        repoRoot: ".",
        createdAt,
        publicationSequence,
        input: { ...input, taskId, saveSnapshot: Boolean(input.saveSnapshot) },
        ...snapshot,
        planRevision,
        invariants
      },
      repo
    ) as TaskSnapshot;
    await beforePersist?.();
    if (priorSnapshot && !await governedSnapshotLifecycleError(repo, priorSnapshot)) {
      await fs.mkdir(path.dirname(previousSnapshotPath), { recursive: true });
      await atomicJsonWrite(previousSnapshotPath, priorSnapshot);
    }
    await atomicJsonWrite(snapshotPath, saved);
    await afterPersistBeforeBlockedCleanup?.();
    await fs.rm(path.join(dir, `${taskId}.blocked.json`), { force: true });
    await recordTaskPlanRevision(repo, taskId, planRevision, invariants);
    const published = await publishLatestSnapshot(repo, dir, {
      schemaVersion: 1,
      taskId,
      path: path.basename(snapshotPath),
      createdAt,
      publicationSequence,
      origin: saved.origin
    });
    await fs.rm(previousSnapshotPath, { force: true });
    if (published) await removeImplicitSiblingSnapshots(dir, taskId);
    else if (saved.origin === "hook-implicit") await fs.rm(snapshotPath, { force: true });
    return { snapshot: saved, path: snapshotPath };
  });
}

// Hook-saved implicit baselines are superseded by ANY newer snapshot. Leaving
// them behind would trip the latest-snapshot ambiguity checks (which disable
// hook AutoVerify and floor un-bound reviews at "inspect") for every repo
// that followed the recommended implicit -> explicit upgrade path.
async function removeImplicitSiblingSnapshots(dir: string, keepTaskId: string): Promise<void> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.endsWith(".json") || entry === LATEST_FILE || entry.endsWith(".blocked.json") || entry === `${keepTaskId}.json`) {
      continue;
    }
    const candidatePath = path.join(dir, entry);
    try {
      const parsed = JSON.parse(await fs.readFile(candidatePath, "utf8")) as Partial<TaskSnapshot>;
      if (parsed.origin === "hook-implicit") {
        await fs.rm(candidatePath, { force: true });
      }
    } catch {
      // Unreadable sibling snapshots are left for the ambiguity checks to report.
    }
  }
}

export async function saveBlockedTaskSnapshot({ repoRoot, input, reason, details }: SaveBlockedTaskSnapshotInput): Promise<{ taskId: string; path: string; preservedSnapshot?: true }> {
  const repo = path.resolve(repoRoot);
  const createdAt = new Date().toISOString();
  const taskId = normalizeTaskId(input.taskId) ?? defaultTaskId(repo, input, createdAt);
  const saved = await withTaskLifecycleLock(repo, taskId, async () => {
    const dir = snapshotDir(repo);
    await fs.mkdir(dir, { recursive: true });
    const snapshotPath = path.join(dir, `${taskId}.json`);
    const prior = await readJson<TaskSnapshot>(snapshotPath);
    if (prior.ok && isTaskSnapshot(prior.value)) {
      return { taskId, path: snapshotPath, preservedSnapshot: true as const };
    }
    const markerPath = path.join(dir, `${taskId}.blocked.json`);
    const publicationSequence = await reservePublicationSequence(repo, dir);
  const marker = redactRepoPath(
    {
      schemaVersion: 1,
      kind: "change-plan-snapshot-blocked",
      taskId,
      repoRoot: ".",
      createdAt,
      publicationSequence,
      input: { ...input, taskId, saveSnapshot: Boolean(input.saveSnapshot) },
      reason,
      details
    },
    repo
  ) as BlockedTaskSnapshotMarker;
    await atomicJsonWrite(markerPath, marker);
    await fs.rm(snapshotPath, { force: true });
    await publishLatestSnapshot(repo, dir, {
      schemaVersion: 1,
      taskId,
      path: path.basename(markerPath),
      createdAt,
      publicationSequence,
      blocked: true,
      reason,
      origin: "blocked"
    });
    return { taskId, path: markerPath };
  });
  if (!saved.preservedSnapshot) return saved;
  const fresh = await saveBlockedTaskSnapshot({ repoRoot: repo, input: { ...input, taskId: undefined }, reason, details });
  return { ...fresh, preservedSnapshot: true };
}

export async function loadTaskSnapshot(repoRoot: string, taskId?: string): Promise<TaskSnapshotLoadResult> {
  const repo = path.resolve(repoRoot);
  const dirs = snapshotReadDirs(repo);
  if (dirs.length === 0) {
    return { missingReason: "missing-directory" };
  }

  const requestedTaskId = normalizeTaskId(taskId);
  let resolvedTaskId = requestedTaskId;
  let dir = dirs[0];
  if (!resolvedTaskId) {
    let latest:
      | { ok: true; value: LatestSnapshotPointer; dir: string }
      | { ok: false; missing: boolean; error: string; dir: string }
      | undefined;
    let priorLatestReadFailed = false;
    for (const candidateDir of dirs) {
      const candidate = await readJson<LatestSnapshotPointer>(path.join(candidateDir, LATEST_FILE));
      if (candidate.ok) {
        if (priorLatestReadFailed) {
          const recovered = await recoverLatestSnapshot(repo, dirs, snapshotDir(repo));
          if (recovered) {
            return recovered;
          }
        }
        latest = { ...candidate, dir: candidateDir };
        break;
      }
      priorLatestReadFailed = true;
      latest ??= { ...candidate, dir: candidateDir };
    }
    if (!latest || !latest.ok) {
      const recovered = await recoverLatestSnapshot(repo, dirs, snapshotDir(repo));
      return recovered ?? { missingReason: latest?.missing ? "missing-latest" : "invalid-json", error: latest?.error };
    }
    if (latest.value.blocked === true) {
      const blockedTaskId = typeof latest.value.taskId === "string" ? normalizeTaskId(latest.value.taskId) : undefined;
      const blocked = await readExactBlockedLatestPointer(repo, latest.dir, latest.value);
      if (blocked) {
        return blocked;
      }
      const recovered = await recoverLatestSnapshot(repo, dirs, snapshotDir(repo));
      return recovered ?? {
        latestTaskId: blockedTaskId,
        missingReason: "invalid-json",
        error: "latest blocked snapshot pointer does not match its exact blocked artifact",
        path: path.join(latest.dir, LATEST_FILE)
      };
    }
    if (typeof latest.value.taskId !== "string" || !normalizeTaskId(latest.value.taskId)) {
      const recovered = await recoverLatestSnapshot(repo, dirs, snapshotDir(repo));
      return recovered ?? { missingReason: "missing-latest", error: "latest snapshot pointer does not contain a valid taskId" };
    }
    if (!await validatedLatestPointerAuthority(repo, latest.dir, latest.value)) {
      const latestTaskId = normalizeTaskId(latest.value.taskId);
      const previous = latestTaskId ? await recoverPreviousTaskSnapshot(repo, latest.dir, latestTaskId, latest.value) : undefined;
      if (previous) return previous;
      const recovered = await recoverLatestSnapshot(repo, dirs, snapshotDir(repo));
      const latestArtifact = latestTaskId ? await readJson<TaskSnapshot>(path.join(latest.dir, `${latestTaskId}.json`)) : undefined;
      const lifecycleError = latestArtifact?.ok && isTaskSnapshot(latestArtifact.value) && latestArtifact.value.taskId === latestTaskId
        ? await governedSnapshotLifecycleError(repo, latestArtifact.value)
        : undefined;
      return recovered ?? {
        latestTaskId,
        missingReason: "invalid-json",
        error: lifecycleError ?? "latest snapshot pointer does not match an artifact with committed lifecycle authority",
        path: path.join(latest.dir, LATEST_FILE)
      };
    }
    resolvedTaskId = normalizeTaskId(latest.value.taskId);
    dir = latest.dir;
  } else {
    const currentBlocked = await readBlockedSnapshotMarker(repo, [snapshotDir(repo)].filter((candidateDir) => existsSync(candidateDir)), resolvedTaskId, { strictInvalid: true });
    if (currentBlocked) {
      return currentBlocked;
    }
    const matchingDir = dirs.find((candidateDir) => existsSync(path.join(candidateDir, `${resolvedTaskId}.json`)));
    if (matchingDir) {
      dir = matchingDir;
    }
  }

  const snapshotPath = path.join(dir, `${resolvedTaskId}.json`);
  const parsed = await readJson<TaskSnapshot>(snapshotPath);
  if (!parsed.ok) {
    const blocked = await readBlockedSnapshotMarker(repo, dirs, resolvedTaskId);
    if (blocked) {
      return blocked;
    }
    if (!requestedTaskId) {
      const recovered = await recoverLatestSnapshot(repo, dirs, snapshotDir(repo));
      if (recovered) {
        return recovered;
      }
    }
    return {
      latestTaskId: resolvedTaskId,
      missingReason: parsed.missing ? "missing-task" : "invalid-json",
      error: parsed.error,
      path: snapshotPath
    };
  }
  if (!isTaskSnapshot(parsed.value)) {
    return { latestTaskId: resolvedTaskId, missingReason: "invalid-json", error: "snapshot schema is invalid", path: snapshotPath };
  }
  const lifecycleError = await governedSnapshotLifecycleError(repo, parsed.value);
  if (lifecycleError) {
    const previous = await recoverPreviousTaskSnapshot(repo, dir, parsed.value.taskId);
    if (previous) return previous;
    return { latestTaskId: resolvedTaskId, missingReason: "invalid-json", error: lifecycleError, path: snapshotPath };
  }
  return { snapshot: parsed.value, latestTaskId: resolvedTaskId, path: snapshotPath };
}

interface LatestSnapshotPointer {
  taskId?: unknown;
  path?: unknown;
  blocked?: unknown;
  reason?: unknown;
  createdAt?: unknown;
  publicationSequence?: unknown;
  origin?: unknown;
}

interface SnapshotAuthority {
  taskId: string;
  path: string;
  implicit: boolean;
  publicationSequence?: number;
  createdAtMs?: number;
  kind: "snapshot" | "blocked";
}

interface RecoverableSnapshotAuthority {
  authority: SnapshotAuthority;
  pointer: Record<string, unknown>;
}

async function reservePublicationSequence(repoRoot: string, dir: string): Promise<number> {
  return withTaskLifecycleLock(repoRoot, "\0codexa-latest-snapshot-publication", async () => {
    const sequencePath = path.join(dir, PUBLICATION_SEQUENCE_FILE);
    const persisted = await readPublicationSequence(sequencePath);
    const maximum = persisted ?? await maximumPublicationSequence(dir);
    if (maximum >= Number.MAX_SAFE_INTEGER) throw new Error("task snapshot publication sequence is exhausted");
    const next = maximum + 1;
    await atomicTextWrite(sequencePath, `${next}\n`);
    return next;
  });
}

async function publishLatestSnapshot(repoRoot: string, dir: string, candidate: Record<string, unknown>): Promise<boolean> {
  return withTaskLifecycleLock(repoRoot, "\0codexa-latest-snapshot-publication", async () => {
    const latestPath = path.join(dir, LATEST_FILE);
    const current = await readJson<LatestSnapshotPointer>(latestPath);
    const candidateAuthority = await validatedLatestPointerAuthority(repoRoot, dir, candidate);
    const currentAuthority = current.ok ? await validatedLatestPointerAuthority(repoRoot, dir, current.value) : undefined;
    if (currentAuthority) {
      if (!candidateAuthority || compareSnapshotAuthority(candidateAuthority, currentAuthority) <= 0) return false;
      await atomicJsonWrite(latestPath, candidate);
      return true;
    }

    // A same-task revision replaces its artifact before latest.json is updated.
    // If that writer is interrupted, the old pointer no longer validates. Treating
    // the mismatch as empty authority lets an older delayed writer regress latest.
    // Rebuild authority from exact validated artifacts while holding the publication
    // lock, and repair latest.json to the strongest artifact already on disk.
    const recovered = await highestRecoverableSnapshotAuthority(repoRoot, dir);
    if (!recovered) return false;
    await atomicJsonWrite(latestPath, recovered.pointer);
    return Boolean(candidateAuthority && compareSnapshotAuthority(candidateAuthority, recovered.authority) === 0);
  });
}

async function validatedLatestPointerAuthority(repoRoot: string, dir: string, pointer: LatestSnapshotPointer): Promise<SnapshotAuthority | undefined> {
  const taskId = typeof pointer.taskId === "string" ? normalizeTaskId(pointer.taskId) : undefined;
  if (!taskId || pointer.taskId !== taskId) return undefined;

  if (pointer.blocked !== undefined && pointer.blocked !== false && pointer.blocked !== true) return undefined;
  const kind = pointer.blocked === true ? "blocked" : "snapshot";
  const artifactName = typeof pointer.path === "string" ? pointer.path : undefined;
  const expectedName = kind === "blocked" ? `${taskId}.blocked.json` : `${taskId}.json`;
  if (
    !artifactName
    || artifactName !== expectedName
    || artifactName !== path.posix.basename(artifactName)
    || artifactName !== path.win32.basename(artifactName)
  ) {
    return undefined;
  }

  const artifactPath = path.join(dir, artifactName);
  const pointerSequence = validPublicationSequence(pointer.publicationSequence);
  if (pointer.publicationSequence !== undefined && pointerSequence === undefined) return undefined;

  if (kind === "blocked") {
    const marker = await readJson<BlockedTaskSnapshotMarker>(artifactPath);
    if (!marker.ok || !isBlockedSnapshotMarker(marker.value, taskId) || marker.value.taskId !== taskId) return undefined;
    if (validPublicationSequence(marker.value.publicationSequence) !== pointerSequence) return undefined;
    return pointerAuthority({
      taskId,
      path: artifactName,
      blocked: true,
      createdAt: marker.value.createdAt,
      publicationSequence: marker.value.publicationSequence
    }, false);
  }

  const snapshot = await readJson<TaskSnapshot>(artifactPath);
  if (!snapshot.ok || !isTaskSnapshot(snapshot.value) || snapshot.value.taskId !== taskId) return undefined;
  if (validPublicationSequence(snapshot.value.publicationSequence) !== pointerSequence) return undefined;
  if (await governedSnapshotLifecycleError(repoRoot, snapshot.value)) return undefined;
  return pointerAuthority({
    taskId,
    path: artifactName,
    createdAt: snapshot.value.createdAt,
    publicationSequence: snapshot.value.publicationSequence
  }, snapshot.value.origin === "hook-implicit");
}

async function highestRecoverableSnapshotAuthority(repoRoot: string, dir: string): Promise<RecoverableSnapshotAuthority | undefined> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return undefined;
  }
  let highest: RecoverableSnapshotAuthority | undefined;
  for (const entry of entries) {
    if (!entry.endsWith(".json") || entry === LATEST_FILE) continue;
    const recovered = await recoverableSnapshotAuthority(repoRoot, dir, entry);
    if (!recovered) continue;
    if (!highest || compareSnapshotAuthority(recovered.authority, highest.authority) > 0) highest = recovered;
  }
  return highest;
}

async function recoverableSnapshotAuthority(repoRoot: string, dir: string, artifactName: string): Promise<RecoverableSnapshotAuthority | undefined> {
  const artifactPath = path.join(dir, artifactName);
  let pointer: Record<string, unknown>;
  if (artifactName.endsWith(".blocked.json")) {
    const marker = await readJson<BlockedTaskSnapshotMarker>(artifactPath);
    if (!marker.ok || !isBlockedSnapshotMarker(marker.value)) return undefined;
    pointer = {
      schemaVersion: 1,
      taskId: marker.value.taskId,
      path: artifactName,
      createdAt: marker.value.createdAt,
      publicationSequence: marker.value.publicationSequence,
      blocked: true,
      reason: marker.value.reason,
      origin: "blocked"
    };
  } else {
    const snapshot = await readJson<TaskSnapshot>(artifactPath);
    if (!snapshot.ok || !isTaskSnapshot(snapshot.value)) return undefined;
    pointer = {
      schemaVersion: 1,
      taskId: snapshot.value.taskId,
      path: artifactName,
      createdAt: snapshot.value.createdAt,
      publicationSequence: snapshot.value.publicationSequence,
      origin: snapshot.value.origin
    };
  }
  const authority = await validatedLatestPointerAuthority(repoRoot, dir, pointer);
  return authority ? { authority, pointer } : undefined;
}

function pointerAuthority(pointer: LatestSnapshotPointer | Record<string, unknown>, implicit: boolean): SnapshotAuthority {
  const createdAtMs = typeof pointer.createdAt === "string" ? Date.parse(pointer.createdAt) : Number.NaN;
  return {
    taskId: typeof pointer.taskId === "string" ? pointer.taskId : "",
    path: typeof pointer.path === "string" ? pointer.path : "",
    implicit,
    publicationSequence: validPublicationSequence(pointer.publicationSequence),
    createdAtMs: Number.isFinite(createdAtMs) ? createdAtMs : undefined,
    kind: pointer.blocked === true ? "blocked" : "snapshot"
  };
}

function compareSnapshotAuthority(left: SnapshotAuthority, right: SnapshotAuthority): number {
  if (left.implicit !== right.implicit) return left.implicit ? -1 : 1;
  const leftSequence = left.publicationSequence;
  const rightSequence = right.publicationSequence;
  if (leftSequence !== undefined || rightSequence !== undefined) {
    if (leftSequence === undefined) return -1;
    if (rightSequence === undefined) return 1;
    if (leftSequence !== rightSequence) return leftSequence - rightSequence;
  } else if (left.createdAtMs !== right.createdAtMs) {
    return (left.createdAtMs ?? 0) - (right.createdAtMs ?? 0);
  }
  return left.taskId.localeCompare(right.taskId) || left.path.localeCompare(right.path) || left.kind.localeCompare(right.kind);
}

async function governedSnapshotLifecycleError(repoRoot: string, snapshot: TaskSnapshot): Promise<string | undefined> {
  if (snapshot.planRevision === undefined) return undefined;
  let lifecycle: Awaited<ReturnType<typeof loadTaskLifecycleState>>;
  try {
    lifecycle = await loadTaskLifecycleState(repoRoot, snapshot.taskId);
  } catch (error) {
    return `task lifecycle state is unavailable for governed snapshot ${snapshot.taskId}: ${error instanceof Error ? error.message : String(error)}`;
  }
  if (!lifecycle) return `task lifecycle state is missing for governed snapshot ${snapshot.taskId} revision ${snapshot.planRevision}`;
  if (lifecycle.planRevision !== snapshot.planRevision) {
    return `task lifecycle revision ${lifecycle.planRevision} does not match governed snapshot ${snapshot.taskId} revision ${snapshot.planRevision}`;
  }
  const snapshotInvariants = snapshot.invariants ?? [];
  const sameInvariants = lifecycle.invariants.length === snapshotInvariants.length
    && lifecycle.invariants.every((invariant, index) => {
      const expected = snapshotInvariants[index];
      return expected?.id === invariant.id && expected.statement === invariant.statement;
    });
  return sameInvariants ? undefined : `task lifecycle invariants do not match governed snapshot ${snapshot.taskId}`;
}

async function recoverPreviousTaskSnapshot(
  repoRoot: string,
  dir: string,
  taskId: string,
  latestPointer?: LatestSnapshotPointer
): Promise<TaskSnapshotLoadResult | undefined> {
  const previousPath = taskSnapshotRollbackPath(dir, taskId);
  const currentPath = path.join(dir, `${taskId}.json`);
  const [previous, current] = await Promise.all([
    readJson<TaskSnapshot>(previousPath),
    readJson<TaskSnapshot>(currentPath)
  ]);
  if (!previous.ok || !current.ok || !isTaskSnapshot(previous.value) || !isTaskSnapshot(current.value)) return undefined;
  if (previous.value.taskId !== taskId || current.value.taskId !== taskId) return undefined;
  if (await governedSnapshotLifecycleError(repoRoot, previous.value)) return undefined;
  if (!await governedSnapshotLifecycleError(repoRoot, current.value)) return undefined;
  const previousRevision = previous.value.planRevision;
  const currentRevision = current.value.planRevision;
  const previousSequence = validPublicationSequence(previous.value.publicationSequence);
  const currentSequence = validPublicationSequence(current.value.publicationSequence);
  if (
    previousRevision === undefined
    || currentRevision !== previousRevision + 1
    || previousSequence === undefined
    || currentSequence === undefined
    || currentSequence <= previousSequence
  ) return undefined;
  if (latestPointer) {
    if (
      latestPointer.taskId !== taskId
      || latestPointer.path !== `${taskId}.json`
      || latestPointer.blocked === true
      || validPublicationSequence(latestPointer.publicationSequence) !== previousSequence
    ) return undefined;
  }
  return { snapshot: previous.value, latestTaskId: taskId, path: previousPath, recoveredLatest: true };
}

function validPublicationSequence(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

async function readPublicationSequence(filePath: string): Promise<number | undefined> {
  try {
    return validPublicationSequence(Number((await fs.readFile(filePath, "utf8")).trim()));
  } catch {
    return undefined;
  }
}

async function maximumPublicationSequence(dir: string): Promise<number> {
  let maximum = 0;
  let entries: string[] = [];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return maximum;
  }
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const parsed = await readJson<Record<string, unknown>>(path.join(dir, entry));
    if (!parsed.ok) continue;
    maximum = Math.max(maximum, validPublicationSequence(parsed.value.publicationSequence) ?? 0);
  }
  return maximum;
}

async function readBlockedSnapshotMarker(
  repoRoot: string,
  dirs: string[],
  taskId: string | undefined,
  options: { strictInvalid?: boolean } = {}
): Promise<TaskSnapshotLoadResult | undefined> {
  if (!taskId) {
    return undefined;
  }
  for (const dir of dirs) {
    const markerPath = path.join(dir, `${taskId}.blocked.json`);
    const parsed = await readJson<BlockedTaskSnapshotMarker>(markerPath);
    if (!parsed.ok) {
      if (options.strictInvalid && !parsed.missing) {
        return { latestTaskId: taskId, missingReason: "invalid-json", error: parsed.error, path: markerPath };
      }
      continue;
    }
    if (!isBlockedSnapshotMarker(parsed.value, taskId)) {
      if (options.strictInvalid) {
        return { latestTaskId: taskId, missingReason: "invalid-json", error: "blocked snapshot marker schema is invalid", path: markerPath };
      }
      continue;
    }
    const newerSnapshot = await newerSameTaskSnapshot(repoRoot, dir, parsed.value);
    if (newerSnapshot) return newerSnapshot;
    return blockedSnapshotLoadResult(parsed.value, markerPath);
  }
  return undefined;
}

async function readExactBlockedLatestPointer(repoRoot: string, dir: string, pointer: LatestSnapshotPointer): Promise<TaskSnapshotLoadResult | undefined> {
  const taskId = typeof pointer.taskId === "string" ? normalizeTaskId(pointer.taskId) : undefined;
  if (!taskId || pointer.taskId !== taskId || pointer.blocked !== true) return undefined;
  const artifactName = typeof pointer.path === "string" ? pointer.path : undefined;
  const expectedName = `${taskId}.blocked.json`;
  if (
    !artifactName
    || artifactName !== expectedName
    || artifactName !== path.posix.basename(artifactName)
    || artifactName !== path.win32.basename(artifactName)
  ) {
    return undefined;
  }
  const pointerSequence = validPublicationSequence(pointer.publicationSequence);
  if (pointer.publicationSequence !== undefined && pointerSequence === undefined) return undefined;
  const markerPath = path.join(dir, artifactName);
  const parsed = await readJson<BlockedTaskSnapshotMarker>(markerPath);
  if (!parsed.ok || !isBlockedSnapshotMarker(parsed.value, taskId) || parsed.value.taskId !== taskId) return undefined;
  if (validPublicationSequence(parsed.value.publicationSequence) !== pointerSequence) return undefined;
  const newerSnapshot = await newerSameTaskSnapshot(repoRoot, dir, parsed.value);
  if (newerSnapshot) return newerSnapshot;
  return blockedSnapshotLoadResult(parsed.value, markerPath);
}

async function newerSameTaskSnapshot(repoRoot: string, dir: string, marker: BlockedTaskSnapshotMarker): Promise<TaskSnapshotLoadResult | undefined> {
  const taskId = normalizeTaskId(marker.taskId);
  if (!taskId || marker.taskId !== taskId) return undefined;
  const snapshotPath = path.join(dir, `${taskId}.json`);
  const parsed = await readJson<TaskSnapshot>(snapshotPath);
  if (!parsed.ok || !isTaskSnapshot(parsed.value) || parsed.value.taskId !== taskId) return undefined;
  if (await governedSnapshotLifecycleError(repoRoot, parsed.value)) return undefined;
  const blockedAuthority = pointerAuthority({
    taskId,
    path: `${taskId}.blocked.json`,
    blocked: true,
    createdAt: marker.createdAt,
    publicationSequence: marker.publicationSequence
  }, false);
  const snapshotAuthority = pointerAuthority({
    taskId,
    path: `${taskId}.json`,
    createdAt: parsed.value.createdAt,
    publicationSequence: parsed.value.publicationSequence
  }, parsed.value.origin === "hook-implicit");
  if (compareSnapshotAuthority(snapshotAuthority, blockedAuthority) <= 0) return undefined;
  return { snapshot: parsed.value, latestTaskId: taskId, path: snapshotPath, recoveredLatest: true };
}

function isBlockedSnapshotMarker(value: unknown, taskId?: string): value is BlockedTaskSnapshotMarker {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Partial<BlockedTaskSnapshotMarker>;
  const normalizedTaskId = typeof record.taskId === "string" ? normalizeTaskId(record.taskId) : undefined;
  return record.schemaVersion === 1
    && record.kind === "change-plan-snapshot-blocked"
    && Boolean(normalizedTaskId)
    && (!taskId || normalizedTaskId === taskId)
    && (record.publicationSequence === undefined || validPublicationSequence(record.publicationSequence) !== undefined);
}

function blockedSnapshotLoadResult(marker: BlockedTaskSnapshotMarker, markerPath: string, recoveredLatest = false): TaskSnapshotLoadResult {
  const normalizedMarker = normalizeBlockedSnapshotMarker(marker);
  return {
    blockedSnapshot: normalizedMarker,
    latestTaskId: normalizedMarker.taskId,
    missingReason: "blocked-plan",
    error: blockedSnapshotReason(marker.reason),
    path: markerPath,
    recoveredLatest
  };
}

function normalizeBlockedSnapshotMarker(marker: BlockedTaskSnapshotMarker): BlockedTaskSnapshotMarker {
  const input = normalizeBlockedSnapshotInput(marker.input);
  return {
    ...marker,
    taskId: normalizeTaskId(marker.taskId) ?? marker.taskId,
    ...(input ? { input } : { input: undefined }),
    reason: blockedSnapshotReason(marker.reason)
  };
}

function normalizeBlockedSnapshotInput(value: unknown): ChangePlanInput | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const input: ChangePlanInput = {};
  for (const key of ["task", "query", "taskId", "followCandidate"] as const) {
    if (record[key] === undefined) {
      continue;
    }
    if (typeof record[key] !== "string") {
      return undefined;
    }
    input[key] = record[key];
  }
  for (const key of ["files", "symbols", "invariants"] as const) {
    if (record[key] === undefined) {
      continue;
    }
    if (!Array.isArray(record[key]) || !record[key].every((entry) => typeof entry === "string")) {
      return undefined;
    }
    input[key] = record[key];
  }
  for (const key of ["diff", "includeSnippets", "saveSnapshot"] as const) {
    if (record[key] === undefined) {
      continue;
    }
    if (typeof record[key] !== "boolean") {
      return undefined;
    }
    input[key] = record[key];
  }
  for (const key of ["tokenBudget", "limit"] as const) {
    if (record[key] === undefined) {
      continue;
    }
    if (typeof record[key] !== "number" || !Number.isFinite(record[key])) {
      return undefined;
    }
    input[key] = record[key];
  }
  if (record.changeType !== undefined) {
    if (typeof record.changeType !== "string" || !CHANGE_TYPES.has(record.changeType as ChangeType)) {
      return undefined;
    }
    input.changeType = record.changeType as ChangeType;
  }
  return hasBlockedSnapshotReplaySeed(input) ? input : undefined;
}

function hasBlockedSnapshotReplaySeed(input: ChangePlanInput): boolean {
  return Boolean(input.task?.trim() || input.query?.trim() || input.files?.length || input.symbols?.length);
}

function blockedSnapshotReason(reason: unknown): string {
  return typeof reason === "string" && reason.trim() ? reason : "latest change plan was orientation-only; no editable task snapshot was saved";
}

async function recoverLatestSnapshot(repoRoot: string, dirs: string[], currentDir?: string): Promise<TaskSnapshotLoadResult | undefined> {
  const candidates: RecoveredSnapshotCandidate[] = [];
  let invalidGovernedSnapshot:
    | { authority: SnapshotAuthority; latestTaskId: string; path: string; error: string }
    | undefined;
  let invalidCurrentBlocked:
    | {
        latestTaskId?: string;
        path: string;
        error: string;
      }
    | undefined;
  for (const dir of dirs) {
    let entries: string[] = [];
    try {
      entries = await fs.readdir(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.endsWith(".json") || entry === LATEST_FILE) {
        continue;
      }
      const snapshotPath = path.join(dir, entry);
      if (entry.endsWith(".blocked.json")) {
        const parsed = await readJson<BlockedTaskSnapshotMarker>(snapshotPath);
        if (!parsed.ok || !isBlockedSnapshotMarker(parsed.value)) {
          if (currentDir && dir === currentDir) {
            invalidCurrentBlocked ??= {
              latestTaskId: normalizeTaskId(entry.slice(0, -".blocked.json".length)),
              path: snapshotPath,
              error: parsed.ok ? "blocked snapshot marker schema is invalid" : parsed.error
            };
          }
          continue;
        }
        candidates.push({
          kind: "blocked",
          marker: parsed.value,
          path: snapshotPath,
          createdAtMs: typeof parsed.value.createdAt === "string" ? Date.parse(parsed.value.createdAt) || 0 : 0
        });
        continue;
      }
      const parsed = await readJson<TaskSnapshot>(snapshotPath);
      if (!parsed.ok || !isTaskSnapshot(parsed.value)) {
        continue;
      }
      const lifecycleError = await governedSnapshotLifecycleError(repoRoot, parsed.value);
      if (lifecycleError) {
        const candidate: RecoveredSnapshotCandidate = {
          kind: "snapshot",
          snapshot: parsed.value,
          path: snapshotPath,
          createdAtMs: Date.parse(parsed.value.createdAt) || 0
        };
        const authority = recoveredCandidateAuthority(candidate);
        if (!invalidGovernedSnapshot || compareSnapshotAuthority(authority, invalidGovernedSnapshot.authority) > 0) {
          invalidGovernedSnapshot = { authority, latestTaskId: parsed.value.taskId, path: snapshotPath, error: lifecycleError };
        }
        continue;
      }
      candidates.push({
        kind: "snapshot",
        snapshot: parsed.value,
        path: snapshotPath,
        createdAtMs: Date.parse(parsed.value.createdAt) || 0
      });
    }
  }
  if (invalidCurrentBlocked) {
    return {
      latestTaskId: invalidCurrentBlocked.latestTaskId,
      missingReason: "invalid-json",
      error: invalidCurrentBlocked.error,
      path: invalidCurrentBlocked.path
    };
  }
  const latest = candidates.sort((left, right) => compareSnapshotAuthority(recoveredCandidateAuthority(right), recoveredCandidateAuthority(left)))[0];
  if (invalidGovernedSnapshot && (!latest || compareSnapshotAuthority(invalidGovernedSnapshot.authority, recoveredCandidateAuthority(latest)) >= 0)) {
    return {
      latestTaskId: invalidGovernedSnapshot.latestTaskId,
      missingReason: "invalid-json",
      error: invalidGovernedSnapshot.error,
      path: invalidGovernedSnapshot.path
    };
  }
  if (!latest) {
    return undefined;
  }
  if (latest.kind === "blocked") {
    return blockedSnapshotLoadResult(latest.marker, latest.path, true);
  }
  return {
    snapshot: latest.snapshot,
    latestTaskId: latest.snapshot.taskId,
    path: latest.path,
    recoveredLatest: true
  };
}

type RecoveredSnapshotCandidate =
  | { kind: "snapshot"; snapshot: TaskSnapshot; path: string; createdAtMs: number }
  | { kind: "blocked"; marker: BlockedTaskSnapshotMarker; path: string; createdAtMs: number };

function recoveredCandidateTaskId(candidate: RecoveredSnapshotCandidate): string {
  if (candidate.kind === "snapshot") {
    return candidate.snapshot.taskId;
  }
  return typeof candidate.marker.taskId === "string" ? normalizeTaskId(candidate.marker.taskId) ?? "" : "";
}

function recoveredCandidateAuthority(candidate: RecoveredSnapshotCandidate): SnapshotAuthority {
  const record = candidate.kind === "snapshot" ? candidate.snapshot : candidate.marker;
  return {
    taskId: recoveredCandidateTaskId(candidate),
    path: path.basename(candidate.path),
    implicit: candidate.kind === "snapshot" && candidate.snapshot.origin === "hook-implicit",
    publicationSequence: validPublicationSequence(record.publicationSequence),
    createdAtMs: candidate.createdAtMs,
    kind: candidate.kind
  };
}

export function taskSnapshotCacheDir(repoRoot: string): string {
  return snapshotDir(path.resolve(repoRoot));
}

function snapshotDir(repoRoot: string): string {
  return path.join(repoRoot, SNAPSHOT_DIR);
}

function snapshotReadDirs(repoRoot: string): string[] {
  return [snapshotDir(repoRoot), path.join(repoRoot, LEGACY_SNAPSHOT_DIR)].filter((dir, index, dirs) => existsSync(dir) && dirs.indexOf(dir) === index);
}

export function allocateTaskSnapshotId(repoRoot: string, input: ChangePlanInput, createdAt = new Date().toISOString()): string {
  return normalizeTaskId(input.taskId) ?? defaultTaskId(path.resolve(repoRoot), input, createdAt);
}

function defaultTaskId(repoRoot: string, input: ChangePlanInput, createdAt: string): string {
  const taskPart = slug(input.task ?? input.query ?? input.files?.join("-") ?? "task");
  const suffix = stableId("task-snapshot", repoRoot, input.task, input.query, input.files?.join("\n"), input.symbols?.join("\n"), createdAt);
  return `${taskPart || "task"}-${createdAt.replace(/[-:TZ.]/g, "").slice(0, 14)}-${suffix}`.slice(0, 96);
}

function normalizeTaskId(value?: string): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  const normalized = trimmed.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 120);
  return normalized || undefined;
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 36);
}

export function isTaskSnapshot(value: unknown): value is TaskSnapshot {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Partial<TaskSnapshot>;
  return (
    record.schemaVersion === 1 &&
    typeof record.taskId === "string" &&
    typeof record.createdAt === "string" &&
    typeof record.changeType === "string" &&
    (record.planRevision === undefined || (Number.isInteger(record.planRevision) && record.planRevision > 0)) &&
    (record.publicationSequence === undefined || validPublicationSequence(record.publicationSequence) !== undefined) &&
    (record.invariants === undefined || isTaskInvariants(record.invariants)) &&
    Boolean(record.snapshotFreshness) &&
    Boolean(record.input) &&
    Array.isArray(record.plannedEditTargets) &&
    Array.isArray(record.plannedFiles) &&
    Array.isArray(record.focusFiles) &&
    Array.isArray(record.plannedTests) &&
    (record.sessionMemory === undefined || isSessionMemoryPointer(record.sessionMemory)) &&
    Array.isArray(record.requiredWorkflowChecks) &&
    Array.isArray(record.requiredDependencyChecks) &&
    (record.diffFootprint === undefined || isDiffFootprint(record.diffFootprint)) &&
    Array.isArray(record.recipes) &&
    Array.isArray(record.gaps) &&
    Array.isArray(record.warnings) &&
    isSnapshotDirtyBaseline(record.dirtyBaseline)
  );
}

function isTaskInvariants(value: unknown): boolean {
  if (!Array.isArray(value) || value.length > MAX_TASK_INVARIANTS) return false;
  const ids = new Set<string>();
  return value.every((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
    const record = entry as { id?: unknown; statement?: unknown };
    if (Object.keys(entry).some((key) => key !== "id" && key !== "statement")) return false;
    const statement = taskInvariantStatementSchema.safeParse(record.statement);
    if (!statement.success || typeof record.id !== "string" || ids.has(record.id)) return false;
    ids.add(record.id);
    return record.id === taskInvariantId(statement.data.replace(/\s+/gu, " "));
  });
}

function isDiffFootprint(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Partial<NonNullable<TaskSnapshot["diffFootprint"]>>;
  return (
    record.schemaVersion === 1 &&
    (typeof record.trackedInsertions === "number" || record.trackedInsertions === null) &&
    (typeof record.trackedDeletions === "number" || record.trackedDeletions === null) &&
    typeof record.changedFileCount === "number" &&
    typeof record.modifiedSymbolCount === "number" &&
    typeof record.untrackedFileCount === "number" &&
    typeof record.fingerprint === "string" &&
    Array.isArray(record.degradedReasons)
  );
}

function isSessionMemoryPointer(value: unknown): boolean {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Partial<NonNullable<TaskSnapshot["sessionMemory"]>>;
  return (
    typeof record.sessionId === "string" &&
    record.sessionId !== "." &&
    record.sessionId !== ".." &&
    typeof record.revision === "number" &&
    Number.isInteger(record.revision) &&
    record.revision >= 0 &&
    Array.isArray(record.entryIds) &&
    record.entryIds.every((entry) => typeof entry === "string") &&
    typeof record.summaryHash === "string" &&
    /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(record.summaryHash)
  );
}

function isSnapshotDirtyBaseline(value: unknown): value is TaskSnapshot["dirtyBaseline"] {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Partial<TaskSnapshot["dirtyBaseline"]>;
  return (
    Array.isArray(record.changedEntries) &&
    Array.isArray(record.dirtyFiles) &&
    record.dirtyFileHashes !== undefined &&
    typeof record.dirtyFileHashes === "object" &&
    (typeof record.headCommit === "string" || record.headCommit === null) &&
    typeof record.indexedAt === "string"
  );
}
