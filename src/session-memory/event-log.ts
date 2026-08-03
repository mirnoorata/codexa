import { randomUUID } from "node:crypto";
import { constants as fsConstants, promises as fs, type Stats } from "node:fs";
import path from "node:path";
import { acquireCacheLock } from "../cache-lock.js";
import { assertSafeManagedFile, assertSafeManagedStateDirectory, ensureSafeManagedStateDirectory } from "../init-portability.js";
import type { SessionMemoryStore } from "../types.js";
import { stableId } from "../util.js";
import {
  COMPACTIONS_DIR,
  EVENTS_FILE,
  LATEST_FILE,
  MAX_EVENTS_BYTES,
  MAX_EVENTS_LINES,
  MAX_EVENT_REPLAY_BYTES,
  MAX_MEMORY_JSON_BYTES,
  MEMORY_FILE,
  MEMORY_LOCK_STALE_MS,
  MEMORY_LOCK_TIMEOUT_MS,
  SESSION_MEMORY_DIR,
  SESSION_MEMORY_LOCK_DIR,
  type LatestSessionMemoryPointer,
  type SessionMemoryEvent
} from "./model.js";

const SESSION_MEMORY_STATE_SEGMENTS = ["cache", "codexa-session-memory"] as const;
const MAPPED_SESSION_DIRECTORY_PREFIX = "__codexa_session_v1_";
const MANAGED_READ_FLAGS = fsConstants.O_RDONLY | fsConstants.O_NONBLOCK | (fsConstants.O_NOFOLLOW ?? 0);
const MANAGED_APPEND_FLAGS =
  fsConstants.O_WRONLY |
  fsConstants.O_APPEND |
  fsConstants.O_CREAT |
  fsConstants.O_NONBLOCK |
  (fsConstants.O_NOFOLLOW ?? 0);

export type ManagedTextReadResult =
  | { ok: true; value: string }
  | { ok: false; missing: boolean; tooLarge: boolean; error: string };

export interface SessionIdResolution {
  sessionId: string;
  generated: boolean;
}

export function sessionMemoryCacheDir(repoRoot: string): string {
  return path.join(path.resolve(repoRoot), SESSION_MEMORY_DIR);
}

export async function resolveSessionId(repoRoot: string, requested?: string): Promise<string> {
  return (await resolveSessionIdWithProvenance(repoRoot, requested)).sessionId;
}

export async function resolveSessionIdWithProvenance(
  repoRoot: string,
  requested?: string
): Promise<SessionIdResolution> {
  if (requested !== undefined) {
    const normalized = normalizeIdentifier(requested);
    if (!normalized || normalized === "." || normalized === "..") {
      throw new Error("session id must contain a safe non-dot identifier");
    }
    return { sessionId: normalized, generated: false };
  }
  await assertSessionMemoryCacheDirectory(repoRoot);
  const latestPath = path.join(sessionMemoryCacheDir(repoRoot), LATEST_FILE);
  await assertSafeManagedFile(latestPath);
  const latest = await readJson<LatestSessionMemoryPointer>(latestPath);
  if (latest.ok && typeof latest.value.sessionId === "string") {
    const latestId = normalizeIdentifier(latest.value.sessionId);
    if (latestId && latestId !== "." && latestId !== "..") {
      return { sessionId: latestId, generated: false };
    }
  }
  return {
    sessionId: `session-${new Date().toISOString().replace(/[-:TZ.]/gu, "").slice(0, 14)}-${randomUUID().slice(0, 8)}`,
    generated: true
  };
}

export async function writeStoreAndLatest(repoRoot: string, store: SessionMemoryStore, taskId?: string): Promise<void> {
  await ensureSessionMemorySessionDirectory(repoRoot, store.sessionId);
  await atomicJsonWrite(memoryStorePath(repoRoot, store.sessionId), store);
  await writeLatestSessionPointer(repoRoot, store, taskId);
}

export async function writeLatestSessionPointer(repoRoot: string, store: SessionMemoryStore, taskId?: string): Promise<void> {
  await ensureSessionMemoryCacheDirectory(repoRoot);
  await atomicJsonWrite(path.join(sessionMemoryCacheDir(repoRoot), LATEST_FILE), {
    schemaVersion: 1,
    sessionId: store.sessionId,
    path: relativeMemoryPath(store.sessionId),
    taskId,
    updatedAt: store.updatedAt
  } satisfies LatestSessionMemoryPointer);
}

export async function appendSessionMemoryEvent(repoRoot: string, store: SessionMemoryStore, event: SessionMemoryEvent): Promise<void> {
  const directory = await ensureSessionMemorySessionDirectory(repoRoot, store.sessionId);
  const eventsPath = path.join(directory, EVENTS_FILE);
  await assertSafeManagedFile(eventsPath);
  const handle = await fs.open(eventsPath, MANAGED_APPEND_FLAGS, 0o600);
  try {
    assertSingleLinkRegularFile(await handle.stat(), eventsPath);
    await assertSessionMemorySessionDirectory(repoRoot, store.sessionId);
    assertSingleLinkRegularFile(await handle.stat(), eventsPath);
    await handle.writeFile(`${JSON.stringify(event)}\n`, "utf8");
  } finally {
    await handle.close();
  }
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
  const directory = await ensureSessionMemorySessionDirectory(repoRoot, store.sessionId);
  const eventsPath = path.join(directory, EVENTS_FILE);
  await atomicTextWrite(eventsPath, `${JSON.stringify(event)}\n`);
}

export async function shouldCompactEvents(repoRoot: string, sessionId: string): Promise<boolean> {
  const read = await readSessionMemoryEventsText(repoRoot, sessionId, MAX_EVENTS_BYTES);
  if (!read.ok) {
    if (read.missing) return false;
    if (read.tooLarge) return true;
    throw new Error(read.error);
  }
  return eventLineCount(read.value) > MAX_EVENTS_LINES;
}

export async function countEventLines(repoRoot: string, sessionId: string): Promise<number> {
  const read = await readSessionMemoryEventsText(repoRoot, sessionId, MAX_EVENT_REPLAY_BYTES);
  if (!read.ok) {
    if (read.missing) return 0;
    if (read.tooLarge) return MAX_EVENTS_LINES + 1;
    throw new Error(read.error);
  }
  return eventLineCount(read.value);
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
  await atomicTextWrite(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

export async function atomicTextWrite(filePath: string, value: string): Promise<void> {
  await assertSafeManagedFile(filePath);
  const tmp = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(tmp, value, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await assertSafeManagedFile(tmp);
    await assertSafeManagedFile(filePath);
    await fs.rename(tmp, filePath);
  } finally {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
  }
}

export async function readJson<T>(filePath: string): Promise<{ ok: true; value: T } | { ok: false; missing: boolean; error: string }> {
  const read = await readBoundedManagedText(filePath, MAX_MEMORY_JSON_BYTES);
  if (!read.ok) {
    return { ok: false, missing: read.missing, error: read.error };
  }
  try {
    const text = read.value;
    return { ok: true, value: JSON.parse(text) as T };
  } catch (error) {
    return { ok: false, missing: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function readSessionMemoryStoreJson<T>(
  repoRoot: string,
  sessionId: string
): Promise<{ ok: true; value: T } | { ok: false; missing: boolean; error: string }> {
  const directory = await assertSessionMemorySessionDirectory(repoRoot, sessionId);
  const filePath = path.join(directory, MEMORY_FILE);
  await assertSafeManagedFile(filePath);
  return readJson<T>(filePath);
}

export async function readSessionMemoryEventsText(
  repoRoot: string,
  sessionId: string,
  maxBytes = MAX_EVENT_REPLAY_BYTES
): Promise<ManagedTextReadResult> {
  const directory = await assertSessionMemorySessionDirectory(repoRoot, sessionId);
  const filePath = path.join(directory, EVENTS_FILE);
  await assertSafeManagedFile(filePath);
  return readBoundedManagedText(filePath, maxBytes);
}

export async function assertSessionMemoryCompactionDirectory(repoRoot: string, sessionId: string): Promise<string> {
  const directory = await assertSessionMemorySessionDirectory(repoRoot, sessionId);
  return assertSafeManagedStateDirectory(
    repoRoot,
    ...SESSION_MEMORY_STATE_SEGMENTS,
    "sessions",
    path.basename(directory),
    COMPACTIONS_DIR
  );
}

export async function ensureSessionMemoryCompactionDirectory(repoRoot: string, sessionId: string): Promise<string> {
  const directory = await ensureSessionMemorySessionDirectory(repoRoot, sessionId);
  return ensureSafeManagedStateDirectory(
    repoRoot,
    ...SESSION_MEMORY_STATE_SEGMENTS,
    "sessions",
    path.basename(directory),
    COMPACTIONS_DIR
  );
}

export function memoryStorePath(repoRoot: string, sessionId: string): string {
  return path.join(sessionDir(repoRoot, sessionId), MEMORY_FILE);
}

export function sessionDir(repoRoot: string, sessionId: string): string {
  return path.join(sessionMemoryCacheDir(repoRoot), "sessions", sessionDirectoryName(sessionId));
}

export function relativeMemoryPath(sessionId: string): string {
  return path.posix.join("sessions", sessionDirectoryName(sessionId), MEMORY_FILE);
}

async function assertSessionMemoryCacheDirectory(repoRoot: string): Promise<string> {
  return assertSafeManagedStateDirectory(repoRoot, ...SESSION_MEMORY_STATE_SEGMENTS);
}

async function ensureSessionMemoryCacheDirectory(repoRoot: string): Promise<string> {
  return ensureSafeManagedStateDirectory(repoRoot, ...SESSION_MEMORY_STATE_SEGMENTS);
}

async function assertSessionMemorySessionDirectory(repoRoot: string, sessionId: string): Promise<string> {
  const existing = await existingSessionMemoryDirectories(repoRoot, sessionId);
  if (existing.length > 1) {
    throw new Error(`Codexa found conflicting storage directories for session ${sessionId}`);
  }
  if (existing[0]) return existing[0];
  return sessionDirectoryPath(repoRoot, sessionDirectoryName(sessionId));
}

async function ensureSessionMemorySessionDirectory(repoRoot: string, sessionId: string): Promise<string> {
  await ensureSafeManagedStateDirectory(repoRoot, ...SESSION_MEMORY_STATE_SEGMENTS, "sessions");
  const mappedName = sessionDirectoryName(sessionId);
  const mappedPath = await sessionDirectoryPath(repoRoot, mappedName);
  const existing = await existingSessionMemoryDirectories(repoRoot, sessionId);
  if (existing.length > 1) {
    throw new Error(`Codexa found conflicting storage directories for session ${sessionId}`);
  }
  const current = existing[0];
  if (current && current !== mappedPath) {
    await assertLegacySessionIdentity(current, sessionId);
    await assertSafeManagedStateDirectory(repoRoot, ...SESSION_MEMORY_STATE_SEGMENTS, "sessions", mappedName);
    await fs.rename(current, mappedPath);
  }
  return ensureSafeManagedStateDirectory(
    repoRoot,
    ...SESSION_MEMORY_STATE_SEGMENTS,
    "sessions",
    mappedName
  );
}

async function existingSessionMemoryDirectories(repoRoot: string, sessionId: string): Promise<string[]> {
  const existing: string[] = [];
  const sessionsDirectory = await assertSafeManagedStateDirectory(
    repoRoot,
    ...SESSION_MEMORY_STATE_SEGMENTS,
    "sessions"
  );
  const entries = await fs.readdir(sessionsDirectory).catch((error: unknown) => {
    if (errorCode(error) === "ENOENT") return [] as string[];
    throw error;
  });
  const candidates = sessionDirectoryCandidates(sessionId);
  const exactCandidates = candidates.filter((directoryName) => entries.includes(directoryName));
  if (exactCandidates.length === 0) {
    for (const directoryName of candidates) {
      const caseFoldCollision = entries.find(
        (entry) => entry !== directoryName && entry.toLowerCase() === directoryName.toLowerCase()
      );
      if (caseFoldCollision) {
        throw new Error(
          `Codexa found a case-folding session directory collision between ${directoryName} and ${caseFoldCollision}`
        );
      }
    }
  }
  for (const directoryName of exactCandidates) {
    const directory = await sessionDirectoryPath(repoRoot, directoryName);
    try {
      const entry = await fs.lstat(directory);
      if (!entry.isDirectory() || entry.isSymbolicLink()) {
        throw new Error(`Codexa refuses redirected or non-directory managed state: ${directory}`);
      }
      existing.push(directory);
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    }
  }
  return existing;
}

async function assertLegacySessionIdentity(directory: string, sessionId: string): Promise<void> {
  const store = await readJson<{ sessionId?: unknown }>(path.join(directory, MEMORY_FILE));
  if (store.ok) {
    if (store.value.sessionId !== sessionId) {
      throw new Error(`Codexa refuses legacy session storage owned by another session: ${directory}`);
    }
    return;
  }
  if (!store.missing) {
    throw new Error(`Codexa cannot validate legacy session storage before migration: ${store.error}`);
  }
  const events = await readBoundedManagedText(path.join(directory, EVENTS_FILE), MAX_EVENT_REPLAY_BYTES);
  if (!events.ok) {
    if (events.missing) return;
    throw new Error(`Codexa cannot validate legacy session events before migration: ${events.error}`);
  }
  for (const line of events.value.split(/\r?\n/u).filter(Boolean)) {
    let parsed: { sessionId?: unknown };
    try {
      parsed = JSON.parse(line) as { sessionId?: unknown };
    } catch {
      throw new Error(`Codexa cannot validate malformed legacy session events before migration: ${directory}`);
    }
    if (parsed.sessionId !== sessionId) {
      throw new Error(`Codexa refuses legacy session events owned by another session: ${directory}`);
    }
  }
}

async function sessionDirectoryPath(repoRoot: string, directoryName: string): Promise<string> {
  return assertSafeManagedStateDirectory(
    repoRoot,
    ...SESSION_MEMORY_STATE_SEGMENTS,
    "sessions",
    directoryName
  );
}

async function readBoundedManagedText(filePath: string, maxBytes: number): Promise<ManagedTextReadResult> {
  try {
    await assertSafeManagedFile(filePath);
    const handle = await fs.open(filePath, MANAGED_READ_FLAGS);
    try {
      const before = await handle.stat();
      assertSingleLinkRegularFile(before, filePath);
      if (before.size > maxBytes) {
        return { ok: false, missing: false, tooLarge: true, error: `${path.basename(filePath)} exceeds ${maxBytes} bytes` };
      }
      const buffer = Buffer.alloc(before.size + 1);
      let offset = 0;
      while (offset < buffer.length) {
        const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
        if (bytesRead === 0) break;
        offset += bytesRead;
      }
      if (offset > maxBytes) {
        return { ok: false, missing: false, tooLarge: true, error: `${path.basename(filePath)} exceeds ${maxBytes} bytes` };
      }
      const after = await handle.stat();
      assertSingleLinkRegularFile(after, filePath);
      if (after.size !== before.size || offset !== before.size) {
        throw new Error(`Codexa managed file changed while it was being read: ${filePath}`);
      }
      return { ok: true, value: buffer.subarray(0, offset).toString("utf8") };
    } finally {
      await handle.close();
    }
  } catch (error) {
    return {
      ok: false,
      missing: errorCode(error) === "ENOENT",
      tooLarge: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

function assertSingleLinkRegularFile(stat: Stats, filePath: string): void {
  if (!stat.isFile() || stat.nlink !== 1) {
    throw new Error(`Codexa refuses redirected or non-regular managed file: ${filePath}`);
  }
}

function eventLineCount(text: string): number {
  return text.split(/\r?\n/u).filter(Boolean).length;
}

function errorCode(error: unknown): string {
  return error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code) : "";
}

function normalizeIdentifier(value: string | undefined): string | undefined {
  const normalized = value
    ?.trim()
    .replace(/[^A-Za-z0-9._:-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 120);
  return normalized || undefined;
}

function sessionDirectoryName(sessionId: string): string {
  if (isPortableLowercaseSessionDirectory(sessionId) && !sessionId.startsWith(MAPPED_SESSION_DIRECTORY_PREFIX)) {
    return sessionId;
  }
  const slug =
    sessionId
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/gu, "-")
      .replace(/^-+|-+$/gu, "")
      .replace(/[. ]+$/gu, "")
      .slice(0, 72) || "session";
  return `${MAPPED_SESSION_DIRECTORY_PREFIX}${slug}-${stableId("session-memory-directory-v1", sessionId)}`;
}

function sessionDirectoryCandidates(sessionId: string): string[] {
  const mapped = sessionDirectoryName(sessionId);
  const rawLegacy = process.platform === "win32" && !isPortableWindowsSessionDirectory(sessionId) ? undefined : sessionId;
  const interimLegacy = interimSessionDirectoryName(sessionId);
  return [...new Set([mapped, rawLegacy, interimLegacy].filter((value): value is string => Boolean(value)))];
}

function interimSessionDirectoryName(sessionId: string): string {
  if (isPortableWindowsSessionDirectory(sessionId)) return sessionId;
  const slug =
    sessionId
      .replace(/[^A-Za-z0-9._-]+/gu, "-")
      .replace(/^-+|-+$/gu, "")
      .replace(/[. ]+$/gu, "")
      .slice(0, 72) || "session";
  return `session-${slug}-${stableId("session-memory-directory", sessionId)}`;
}

function isPortableLowercaseSessionDirectory(sessionId: string): boolean {
  return /^[a-z0-9._-]+$/u.test(sessionId) && isPortableWindowsSessionDirectory(sessionId);
}

function isPortableWindowsSessionDirectory(sessionId: string): boolean {
  return (
    /^[A-Za-z0-9._-]+$/u.test(sessionId) &&
    sessionId !== "." &&
    sessionId !== ".." &&
    !/[. ]$/u.test(sessionId) &&
    !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(sessionId)
  );
}
