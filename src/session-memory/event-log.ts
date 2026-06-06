import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { acquireCacheLock } from "../cache-lock.js";
import type { SessionMemoryStore } from "../types.js";
import { stableId } from "../util.js";
import {
  EVENTS_FILE,
  LATEST_FILE,
  MAX_EVENTS_BYTES,
  MAX_EVENTS_LINES,
  MAX_MEMORY_JSON_BYTES,
  MEMORY_FILE,
  MEMORY_LOCK_STALE_MS,
  MEMORY_LOCK_TIMEOUT_MS,
  SESSION_MEMORY_DIR,
  SESSION_MEMORY_LOCK_DIR,
  type LatestSessionMemoryPointer,
  type SessionMemoryEvent
} from "./model.js";

export function sessionMemoryCacheDir(repoRoot: string): string {
  return path.join(path.resolve(repoRoot), SESSION_MEMORY_DIR);
}

export async function resolveSessionId(repoRoot: string, requested?: string): Promise<string> {
  const normalized = normalizeIdentifier(requested);
  if (normalized) {
    return normalized;
  }
  const latest = await readJson<LatestSessionMemoryPointer>(path.join(sessionMemoryCacheDir(repoRoot), LATEST_FILE));
  if (latest.ok && typeof latest.value.sessionId === "string") {
    const latestId = normalizeIdentifier(latest.value.sessionId);
    if (latestId) {
      return latestId;
    }
  }
  return `session-${new Date().toISOString().replace(/[-:TZ.]/gu, "").slice(0, 14)}-${randomUUID().slice(0, 8)}`;
}

export async function writeStoreAndLatest(repoRoot: string, store: SessionMemoryStore, taskId?: string): Promise<void> {
  await fs.mkdir(sessionDir(repoRoot, store.sessionId), { recursive: true });
  await atomicJsonWrite(memoryStorePath(repoRoot, store.sessionId), store);
  await fs.mkdir(sessionMemoryCacheDir(repoRoot), { recursive: true });
  await atomicJsonWrite(path.join(sessionMemoryCacheDir(repoRoot), LATEST_FILE), {
    schemaVersion: 1,
    sessionId: store.sessionId,
    path: relativeMemoryPath(store.sessionId),
    taskId,
    updatedAt: store.updatedAt
  } satisfies LatestSessionMemoryPointer);
}

export async function appendSessionMemoryEvent(repoRoot: string, store: SessionMemoryStore, event: SessionMemoryEvent): Promise<void> {
  await fs.mkdir(sessionDir(repoRoot, store.sessionId), { recursive: true });
  await fs.appendFile(path.join(sessionDir(repoRoot, store.sessionId), EVENTS_FILE), `${JSON.stringify(event)}\n`, "utf8");
}

export async function rewriteEvents(repoRoot: string, store: SessionMemoryStore): Promise<void> {
  const event: SessionMemoryEvent = {
    schemaVersion: 1,
    eventId: stableId("session-memory-compaction-event", store.sessionId, String(store.revision), store.updatedAt),
    event: "compact",
    createdAt: store.updatedAt,
    sessionId: store.sessionId,
    taskId: store.activeTaskId,
    entries: store.entries,
    revision: store.revision
  };
  const eventsPath = path.join(sessionDir(repoRoot, store.sessionId), EVENTS_FILE);
  await atomicTextWrite(eventsPath, `${JSON.stringify(event)}\n`);
}

export async function shouldCompactEvents(repoRoot: string, sessionId: string): Promise<boolean> {
  const eventsPath = path.join(sessionDir(repoRoot, sessionId), EVENTS_FILE);
  try {
    const stat = await fs.stat(eventsPath);
    if (stat.size > MAX_EVENTS_BYTES) {
      return true;
    }
    return (await countEventLines(repoRoot, sessionId)) > MAX_EVENTS_LINES;
  } catch {
    return false;
  }
}

export async function countEventLines(repoRoot: string, sessionId: string): Promise<number> {
  try {
    const text = await fs.readFile(path.join(sessionDir(repoRoot, sessionId), EVENTS_FILE), "utf8");
    return text.split(/\r?\n/u).filter(Boolean).length;
  } catch {
    return 0;
  }
}

export async function acquireSessionMemoryLock(repoRoot: string): Promise<() => Promise<void>> {
  return acquireCacheLock({
    repoRoot,
    lockDir: SESSION_MEMORY_LOCK_DIR,
    staleMs: MEMORY_LOCK_STALE_MS,
    timeoutMs: MEMORY_LOCK_TIMEOUT_MS,
    label: "Codexa session memory"
  });
}

export async function atomicJsonWrite(filePath: string, value: unknown): Promise<void> {
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.rename(tmp, filePath);
}

export async function atomicTextWrite(filePath: string, value: string): Promise<void> {
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, value, "utf8");
  await fs.rename(tmp, filePath);
}

export async function readJson<T>(filePath: string): Promise<{ ok: true; value: T } | { ok: false; missing: boolean; error: string }> {
  try {
    const stat = await fs.stat(filePath);
    if (stat.size > MAX_MEMORY_JSON_BYTES) {
      return { ok: false, missing: false, error: `${path.basename(filePath)} exceeds ${MAX_MEMORY_JSON_BYTES} bytes` };
    }
    const text = await fs.readFile(filePath, "utf8");
    return { ok: true, value: JSON.parse(text) as T };
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code) : "";
    return { ok: false, missing: code === "ENOENT", error: error instanceof Error ? error.message : String(error) };
  }
}

export function memoryStorePath(repoRoot: string, sessionId: string): string {
  return path.join(sessionDir(repoRoot, sessionId), MEMORY_FILE);
}

export function sessionDir(repoRoot: string, sessionId: string): string {
  return path.join(sessionMemoryCacheDir(repoRoot), "sessions", sessionId);
}

export function relativeMemoryPath(sessionId: string): string {
  return path.posix.join("sessions", sessionId, MEMORY_FILE);
}


function normalizeIdentifier(value: string | undefined): string | undefined {
  const normalized = value
    ?.trim()
    .replace(/[^A-Za-z0-9._:-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 120);
  return normalized || undefined;
}
