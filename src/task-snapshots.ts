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

export interface TaskSnapshotLoadResult {
  snapshot?: TaskSnapshot;
  path?: string;
  latestTaskId?: string;
  missingReason?: "missing-directory" | "missing-latest" | "missing-task" | "invalid-json";
  error?: string;
  recoveredLatest?: boolean;
}

export async function saveTaskSnapshot({ repoRoot, input, snapshot }: SaveTaskSnapshotInput): Promise<{ snapshot: TaskSnapshot; path: string }> {
  const repo = path.resolve(repoRoot);
  const createdAt = new Date().toISOString();
  const taskId = normalizeTaskId(input.taskId) ?? defaultTaskId(repo, input, createdAt);
  const saved: TaskSnapshot = {
    schemaVersion: 1,
    taskId,
    repoRoot: repo,
    createdAt,
    input: { ...input, taskId, saveSnapshot: Boolean(input.saveSnapshot) },
    ...snapshot
  };
  const dir = snapshotDir(repo);
  await fs.mkdir(dir, { recursive: true });
  const snapshotPath = path.join(dir, `${taskId}.json`);
  await atomicJsonWrite(snapshotPath, saved);
  await atomicJsonWrite(path.join(dir, LATEST_FILE), { schemaVersion: 1, taskId, path: path.basename(snapshotPath), createdAt });
  return { snapshot: saved, path: snapshotPath };
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
      | { ok: true; value: { taskId?: unknown }; dir: string }
      | { ok: false; missing: boolean; error: string; dir: string }
      | undefined;
    for (const candidateDir of dirs) {
      const candidate = await readJson<{ taskId?: unknown }>(path.join(candidateDir, LATEST_FILE));
      if (candidate.ok) {
        latest = { ...candidate, dir: candidateDir };
        break;
      }
      latest ??= { ...candidate, dir: candidateDir };
    }
    if (!latest || !latest.ok) {
      const recovered = await recoverLatestSnapshot(dirs);
      return recovered ?? { missingReason: latest?.missing ? "missing-latest" : "invalid-json", error: latest?.error };
    }
    if (typeof latest.value.taskId !== "string" || !normalizeTaskId(latest.value.taskId)) {
      const recovered = await recoverLatestSnapshot(dirs);
      return recovered ?? { missingReason: "missing-latest", error: "latest snapshot pointer does not contain a valid taskId" };
    }
    resolvedTaskId = normalizeTaskId(latest.value.taskId);
    dir = latest.dir;
  } else {
    const matchingDir = dirs.find((candidateDir) => existsSync(path.join(candidateDir, `${resolvedTaskId}.json`)));
    if (matchingDir) {
      dir = matchingDir;
    }
  }

  const snapshotPath = path.join(dir, `${resolvedTaskId}.json`);
  const parsed = await readJson<TaskSnapshot>(snapshotPath);
  if (!parsed.ok) {
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

async function recoverLatestSnapshot(dirs: string[]): Promise<TaskSnapshotLoadResult | undefined> {
  const candidates: Array<{ snapshot: TaskSnapshot; path: string; createdAtMs: number }> = [];
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
      const parsed = await readJson<TaskSnapshot>(snapshotPath);
      if (!parsed.ok || !isTaskSnapshot(parsed.value)) {
        continue;
      }
      candidates.push({
        snapshot: parsed.value,
        path: snapshotPath,
        createdAtMs: Date.parse(parsed.value.createdAt) || 0
      });
    }
  }
  const latest = candidates.sort((a, b) => b.createdAtMs - a.createdAtMs || a.snapshot.taskId.localeCompare(b.snapshot.taskId))[0];
  return latest
    ? {
        snapshot: latest.snapshot,
        latestTaskId: latest.snapshot.taskId,
        path: latest.path,
        recoveredLatest: true
      }
    : undefined;
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
  return record.schemaVersion === 1 && typeof record.taskId === "string" && Array.isArray(record.plannedFiles) && Boolean(record.dirtyBaseline);
}
