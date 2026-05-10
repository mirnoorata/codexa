import { existsSync } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { ChangePlanInput, TaskSnapshot } from "./types.js";
import { stableId } from "./util.js";

const SNAPSHOT_DIR = ".codex/cache/codexa-tasks";
const LEGACY_SNAPSHOT_DIR = ".codex/cache/codexa-task-snapshots";
const LATEST_FILE = "latest.json";

export interface SaveTaskSnapshotInput {
  repoRoot: string;
  input: ChangePlanInput;
  snapshot: Omit<TaskSnapshot, "schemaVersion" | "taskId" | "repoRoot" | "createdAt" | "input">;
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
  input?: ChangePlanInput;
  reason?: string;
  details?: unknown;
}

export async function saveTaskSnapshot({ repoRoot, input, snapshot }: SaveTaskSnapshotInput): Promise<{ snapshot: TaskSnapshot; path: string }> {
  const repo = path.resolve(repoRoot);
  const createdAt = new Date().toISOString();
  const taskId = normalizeTaskId(input.taskId) ?? defaultTaskId(repo, input, createdAt);
  const saved = redactRepoPath(
    {
      schemaVersion: 1,
      taskId,
      repoRoot: ".",
      createdAt,
      input: { ...input, taskId, saveSnapshot: Boolean(input.saveSnapshot) },
      ...snapshot
    },
    repo
  ) as TaskSnapshot;
  const dir = snapshotDir(repo);
  await fs.mkdir(dir, { recursive: true });
  const snapshotPath = path.join(dir, `${taskId}.json`);
  await atomicJsonWrite(snapshotPath, saved);
  await fs.rm(path.join(dir, `${taskId}.blocked.json`), { force: true });
  await atomicJsonWrite(path.join(dir, LATEST_FILE), { schemaVersion: 1, taskId, path: path.basename(snapshotPath), createdAt });
  return { snapshot: saved, path: snapshotPath };
}

export async function saveBlockedTaskSnapshot({ repoRoot, input, reason, details }: SaveBlockedTaskSnapshotInput): Promise<{ taskId: string; path: string }> {
  const repo = path.resolve(repoRoot);
  const createdAt = new Date().toISOString();
  const taskId = normalizeTaskId(input.taskId) ?? defaultTaskId(repo, input, createdAt);
  const dir = snapshotDir(repo);
  await fs.mkdir(dir, { recursive: true });
  const markerPath = path.join(dir, `${taskId}.blocked.json`);
  const marker = redactRepoPath(
    {
      schemaVersion: 1,
      kind: "change-plan-snapshot-blocked",
      taskId,
      repoRoot: ".",
      createdAt,
      input: { ...input, taskId, saveSnapshot: Boolean(input.saveSnapshot) },
      reason,
      details
    },
    repo
  ) as BlockedTaskSnapshotMarker;
  await atomicJsonWrite(markerPath, marker);
  await fs.rm(path.join(dir, `${taskId}.json`), { force: true });
  await atomicJsonWrite(path.join(dir, LATEST_FILE), {
    schemaVersion: 1,
    taskId,
    path: path.basename(markerPath),
    createdAt,
    blocked: true,
    reason
  });
  return { taskId, path: markerPath };
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
          const recovered = await recoverLatestSnapshot(dirs);
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
      const recovered = await recoverLatestSnapshot(dirs);
      return recovered ?? { missingReason: latest?.missing ? "missing-latest" : "invalid-json", error: latest?.error };
    }
    if (latest.value.blocked === true) {
      const blockedTaskId = typeof latest.value.taskId === "string" ? normalizeTaskId(latest.value.taskId) : undefined;
      const latestDir = latest.dir;
      const blocked = await readBlockedSnapshotMarker(blockedTaskId ? [latestDir, ...dirs.filter((candidateDir) => candidateDir !== latestDir)] : dirs, blockedTaskId);
      return blocked ?? {
        latestTaskId: blockedTaskId,
        missingReason: "blocked-plan",
        error: blockedSnapshotReason(latest.value.reason),
        path: typeof latest.value.path === "string" ? path.join(latest.dir, latest.value.path) : undefined
      };
    }
    if (typeof latest.value.taskId !== "string" || !normalizeTaskId(latest.value.taskId)) {
      const recovered = await recoverLatestSnapshot(dirs);
      return recovered ?? { missingReason: "missing-latest", error: "latest snapshot pointer does not contain a valid taskId" };
    }
    resolvedTaskId = normalizeTaskId(latest.value.taskId);
    dir = latest.dir;
  } else {
    const currentBlocked = await readBlockedSnapshotMarker([snapshotDir(repo)].filter((candidateDir) => existsSync(candidateDir)), resolvedTaskId);
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
    const blocked = await readBlockedSnapshotMarker(dirs, resolvedTaskId);
    if (blocked) {
      return blocked;
    }
    if (!requestedTaskId) {
      const recovered = await recoverLatestSnapshot(dirs);
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
  return { snapshot: parsed.value, latestTaskId: resolvedTaskId, path: snapshotPath };
}

interface LatestSnapshotPointer {
  taskId?: unknown;
  path?: unknown;
  blocked?: unknown;
  reason?: unknown;
}

async function readBlockedSnapshotMarker(dirs: string[], taskId: string | undefined): Promise<TaskSnapshotLoadResult | undefined> {
  if (!taskId) {
    return undefined;
  }
  for (const dir of dirs) {
    const markerPath = path.join(dir, `${taskId}.blocked.json`);
    const parsed = await readJson<BlockedTaskSnapshotMarker>(markerPath);
    if (!parsed.ok || !isBlockedSnapshotMarker(parsed.value, taskId)) {
      continue;
    }
    return blockedSnapshotLoadResult(parsed.value, markerPath);
  }
  return undefined;
}

function isBlockedSnapshotMarker(value: unknown, taskId?: string): value is BlockedTaskSnapshotMarker {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Partial<BlockedTaskSnapshotMarker>;
  const normalizedTaskId = typeof record.taskId === "string" ? normalizeTaskId(record.taskId) : undefined;
  return record.schemaVersion === 1 && record.kind === "change-plan-snapshot-blocked" && Boolean(normalizedTaskId) && (!taskId || normalizedTaskId === taskId);
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
  return {
    ...marker,
    taskId: normalizeTaskId(marker.taskId) ?? marker.taskId,
    reason: blockedSnapshotReason(marker.reason)
  };
}

function blockedSnapshotReason(reason: unknown): string {
  return typeof reason === "string" && reason.trim() ? reason : "latest change plan was orientation-only; no editable task snapshot was saved";
}

async function recoverLatestSnapshot(dirs: string[]): Promise<TaskSnapshotLoadResult | undefined> {
  const candidates: RecoveredSnapshotCandidate[] = [];
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
      candidates.push({
        kind: "snapshot",
        snapshot: parsed.value,
        path: snapshotPath,
        createdAtMs: Date.parse(parsed.value.createdAt) || 0
      });
    }
  }
  const latest = candidates.sort((a, b) => b.createdAtMs - a.createdAtMs || recoveredCandidateTaskId(a).localeCompare(recoveredCandidateTaskId(b)) || a.kind.localeCompare(b.kind))[0];
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

export function taskSnapshotCacheDir(repoRoot: string): string {
  return snapshotDir(path.resolve(repoRoot));
}

function snapshotDir(repoRoot: string): string {
  return path.join(repoRoot, SNAPSHOT_DIR);
}

function snapshotReadDirs(repoRoot: string): string[] {
  return [snapshotDir(repoRoot), path.join(repoRoot, LEGACY_SNAPSHOT_DIR)].filter((dir, index, dirs) => existsSync(dir) && dirs.indexOf(dir) === index);
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

async function atomicJsonWrite(filePath: string, value: unknown): Promise<void> {
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.rename(tmp, filePath);
}

function redactRepoPath(value: unknown, repoRoot: string): unknown {
  if (typeof value === "string") {
    return value.replaceAll(repoRoot, "<repo>");
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactRepoPath(entry, repoRoot));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, redactRepoPath(entry, repoRoot)]));
  }
  return value;
}

async function readJson<T>(filePath: string): Promise<{ ok: true; value: T } | { ok: false; missing: boolean; error: string }> {
  try {
    const text = await fs.readFile(filePath, "utf8");
    return { ok: true, value: JSON.parse(text) as T };
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code) : "";
    return {
      ok: false,
      missing: code === "ENOENT",
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

function isTaskSnapshot(value: unknown): value is TaskSnapshot {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Partial<TaskSnapshot>;
  return (
    record.schemaVersion === 1 &&
    typeof record.taskId === "string" &&
    typeof record.createdAt === "string" &&
    typeof record.changeType === "string" &&
    Boolean(record.snapshotFreshness) &&
    Boolean(record.input) &&
    Array.isArray(record.plannedEditTargets) &&
    Array.isArray(record.plannedFiles) &&
    Array.isArray(record.focusFiles) &&
    Array.isArray(record.plannedTests) &&
    (record.sessionMemory === undefined || isSessionMemoryPointer(record.sessionMemory)) &&
    Array.isArray(record.requiredWorkflowChecks) &&
    Array.isArray(record.requiredDependencyChecks) &&
    Array.isArray(record.recipes) &&
    Array.isArray(record.gaps) &&
    Array.isArray(record.warnings) &&
    isSnapshotDirtyBaseline(record.dirtyBaseline)
  );
}

function isSessionMemoryPointer(value: unknown): boolean {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Partial<NonNullable<TaskSnapshot["sessionMemory"]>>;
  return typeof record.sessionId === "string" && typeof record.revision === "number" && Array.isArray(record.entryIds) && typeof record.summaryHash === "string";
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
