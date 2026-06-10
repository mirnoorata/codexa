import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type {
  CodexaIndex,
  Confidence,
  EvidenceTier,
  FactSource,
  FreshnessInfo,
  QueryResult,
  SessionMemoryEntryFact,
  SessionMemoryEvidence,
  SessionMemoryInput,
  SessionMemoryKind,
  SessionMemoryPointer,
  SessionMemoryProvenance,
  SessionMemoryRef,
  SessionMemoryScope,
  SessionMemoryStatus,
  SessionMemoryStore
} from "../types.js";
import { normalizePath, stableId, uniqueSorted } from "../util.js";
import {
  COMPACTIONS_DIR,
  EVENTS_FILE,
  LATEST_FILE,
  MAX_DETAILS_CHARS,
  MAX_EVENTS_BYTES,
  MAX_EVENTS_LINES,
  MAX_EVENT_REPLAY_BYTES,
  MAX_EVIDENCE_PER_ENTRY,
  MAX_MEMORY_JSON_BYTES,
  MAX_REFS_PER_ENTRY,
  MAX_SUMMARY_CHARS,
  MEMORY_FILE,
  MEMORY_LOCK_STALE_MS,
  MEMORY_LOCK_TIMEOUT_MS,
  SESSION_MEMORY_DIR,
  SESSION_MEMORY_LOCK_DIR,
  type LatestSessionMemoryPointer,
  type SessionMemoryBuckets,
  type SessionMemoryEvent,
  type SessionMemoryLoadResult,
  type SessionMemoryReadFilter,
  type SessionMemoryRecordInput,
  type SessionMemoryResult,
  type SessionMemoryWriteResult
} from "./model.js";
import { derivedEntriesForTool, isOrientationOnlyChangePlan, refsFromQueryResult, taskIdFromToolData, viewedSummary } from "./derivation.js";
import {
  acquireSessionMemoryLock,
  appendSessionMemoryEvent,
  atomicJsonWrite,
  atomicTextWrite,
  countEventLines,
  memoryStorePath,
  readJson,
  relativeMemoryPath,
  resolveSessionId,
  rewriteEvents,
  sessionDir,
  sessionMemoryCacheDir,
  shouldCompactEvents,
  writeStoreAndLatest
} from "./event-log.js";
import { bucketMemory, filterEntries, renderSessionMemoryMarkdown } from "./formatting.js";
import {
  emptyStore,
  isSessionMemoryEvent,
  isSessionMemoryStore,
  markStoreStaleness,
  normalizeEntryInput,
  normalizeIdentifier,
  normalizeText,
  positiveInt,
  refKey,
  sanitizeStoreTrust,
  sha1,
  sortEntries,
  upsertEntry
} from "./store.js";

export {
  SESSION_MEMORY_DIR,
  SESSION_MEMORY_LOCK_DIR,
  type SessionMemoryBuckets,
  type SessionMemoryLoadResult,
  type SessionMemoryReadFilter,
  type SessionMemoryRecordInput,
  type SessionMemoryResult,
  type SessionMemoryWriteResult
} from "./model.js";

export { sessionMemoryCacheDir } from "./event-log.js";

export async function loadSessionMemory(input: { repoRoot: string; sessionId?: string; freshness?: FreshnessInfo }): Promise<SessionMemoryLoadResult> {
  const repoRoot = path.resolve(input.repoRoot);
  const sessionId = await resolveSessionId(repoRoot, input.sessionId);
  const memoryPath = memoryStorePath(repoRoot, sessionId);
  const warnings: string[] = [];
  const parsed = await readJson<SessionMemoryStore>(memoryPath);
  if (parsed.ok && isSessionMemoryStore(parsed.value, sessionId)) {
    return {
      store: markStoreStaleness(sanitizeStoreTrust(parsed.value), input.freshness),
      path: memoryPath,
      warnings
    };
  }
  if (parsed.ok) {
    warnings.push("session memory store invalid: schema is invalid");
  }
  if (!parsed.ok && !parsed.missing) {
    warnings.push(`session memory store invalid: ${parsed.error}`);
  }
  const replay = await replaySessionMemoryEvents(repoRoot, sessionId, input.freshness);
  warnings.push(...replay.warnings);
  return { ...replay, path: memoryPath, warnings };
}

export async function recordSessionMemory(input: SessionMemoryRecordInput): Promise<SessionMemoryResult> {
  const repoRoot = path.resolve(input.repoRoot);
  const release = await acquireSessionMemoryLock(repoRoot);
  try {
    const sessionId = await resolveSessionId(repoRoot, input.sessionId);
    const loaded = await loadSessionMemory({ repoRoot, sessionId, freshness: input.freshness });
    let store = loaded.store;
    const warnings = [...loaded.warnings];
    const effectiveTaskId = normalizeIdentifier(input.taskId) ?? store.activeTaskId;
    const now = new Date().toISOString();
    const callId = normalizeText(input.callId, 80) ?? randomUUID();
    const entries = input.entries.map((entry) =>
      normalizeEntryInput({
        repoRoot,
        sessionId,
        taskId: effectiveTaskId,
        task: input.task,
        entry,
        freshness: input.freshness,
        source: input.source ?? "agent",
        toolName: input.toolName,
        callId,
        createdAt: now
      })
    );
    const recordedIds: string[] = [];
    for (const entry of entries) {
      store = upsertEntry(store, entry);
      recordedIds.push(entry.id);
    }
    store = {
      ...store,
      activeTaskId: effectiveTaskId ?? store.activeTaskId,
      updatedAt: now,
      revision: store.revision + 1,
      entries: sortEntries(store.entries)
    };
    await appendSessionMemoryEvent(repoRoot, store, {
      schemaVersion: 1,
      eventId: stableId("session-memory-event", sessionId, now, recordedIds.join("\n"), String(store.revision)),
      event: "record",
      createdAt: now,
      sessionId,
      taskId: effectiveTaskId,
      entries,
      revision: store.revision
    });
    await writeStoreAndLatest(repoRoot, store, effectiveTaskId);
    let compacted = false;
    if (await shouldCompactEvents(repoRoot, sessionId)) {
      store = await compactSessionMemoryStore(repoRoot, store, input.freshness);
      compacted = true;
    }
    const memory = bucketMemory(markStoreStaleness(store, input.freshness).entries, { limit: 20 });
    return {
      sessionId,
      taskId: effectiveTaskId,
      revision: store.revision,
      memory,
      writes: {
        sessionId,
        taskId: effectiveTaskId,
        revision: store.revision,
        recordedEntryIds: uniqueSorted(recordedIds),
        compacted,
        path: relativeMemoryPath(sessionId)
      },
      warnings
    };
  } finally {
    await release();
  }
}

export async function readSessionMemory(input: SessionMemoryReadFilter): Promise<SessionMemoryResult> {
  const loaded = await loadSessionMemory(input);
  const limit = positiveInt(input.limit, 30);
  const filtered = filterEntries(loaded.store.entries, input, limit);
  return {
    sessionId: loaded.store.sessionId,
    taskId: input.taskId ?? loaded.store.activeTaskId,
    revision: loaded.store.revision,
    memory: bucketMemory(filtered, { limit }),
    warnings: loaded.warnings
  };
}

export async function summarizeSessionMemory(input: SessionMemoryReadFilter): Promise<SessionMemoryResult> {
  const limit = positiveInt(input.limit, 12);
  const result = await readSessionMemory({ ...input, limit, includeStale: input.includeStale ?? true });
  return {
    ...result,
    memory: {
      ...result.memory,
      markdown: renderSessionMemoryMarkdown(result.memory, limit)
    }
  };
}

export async function compactSessionMemory(input: SessionMemoryReadFilter): Promise<SessionMemoryResult> {
  const repoRoot = path.resolve(input.repoRoot);
  const release = await acquireSessionMemoryLock(repoRoot);
  try {
    const loaded = await loadSessionMemory(input);
    const store = await compactSessionMemoryStore(repoRoot, loaded.store, input.freshness);
    return {
      sessionId: store.sessionId,
      taskId: input.taskId ?? store.activeTaskId,
      revision: store.revision,
      memory: bucketMemory(filterEntries(markStoreStaleness(store, input.freshness).entries, input, positiveInt(input.limit, 30)), { limit: positiveInt(input.limit, 30) }),
      writes: {
        sessionId: store.sessionId,
        taskId: input.taskId ?? store.activeTaskId,
        revision: store.revision,
        recordedEntryIds: [],
        compacted: true,
        path: relativeMemoryPath(store.sessionId)
      },
      warnings: loaded.warnings
    };
  } finally {
    await release();
  }
}

export async function pointerForSessionMemory(input: SessionMemoryReadFilter): Promise<SessionMemoryPointer | undefined> {
  const result = await summarizeSessionMemory({ ...input, limit: input.limit ?? 8 });
  const ids = result.memory.entries.map((entry) => entry.id).slice(0, 20);
  if (ids.length === 0) {
    return undefined;
  }
  return {
    sessionId: result.sessionId,
    revision: result.revision,
    entryIds: ids,
    summaryHash: sha1(result.memory.markdown ?? ids.join("\n"))
  };
}

export async function recordViewedMemoryForTool(input: {
  repoRoot: string;
  sessionId?: string;
  taskId?: string;
  task?: string;
  toolName: string;
  callId?: string;
  result: QueryResult;
  index: CodexaIndex;
}): Promise<SessionMemoryWriteResult | undefined> {
  const rawRefs = refsFromQueryResult(input.result.data, input.index);
  const refs = isOrientationOnlyChangePlan(input.toolName, input.result.data) ? rawRefs.filter((ref) => ref.kind !== "test") : rawRefs;
  const files = uniqueSorted(refs.map((ref) => ref.path).filter((value): value is string => Boolean(value)));
  const symbols = uniqueSorted(refs.filter((ref) => ref.kind === "symbol").map((ref) => ref.id));
  const tests = uniqueSorted(refs.filter((ref) => ref.kind === "test").map((ref) => ref.path ?? ref.id));
  const workflows = uniqueSorted(refs.filter((ref) => ref.kind === "workflow").map((ref) => ref.id));
  const taskId = input.taskId ?? taskIdFromToolData(input.result.data);
  const scope = {
    files,
    symbols,
    tests,
    workflows,
    refs
  };
  const entries: NonNullable<SessionMemoryInput["entries"]> = [
    ...(refs.length > 0
      ? [
          {
            kind: "viewed" as const,
            key: `viewed:${input.toolName}:${stableId("viewed-refs", refs.map(refKey).sort().join("\n")).slice(0, 16)}`,
            summary: viewedSummary(input.toolName, refs, files, symbols, tests),
            provenance: "codexa-derived" as const,
            confidence: "derived" as const,
            evidenceTier: "derived" as const,
            scope: {
              ...scope,
              topics: input.task ? [input.task] : []
            }
          }
        ]
      : []),
    ...derivedEntriesForTool(input.toolName, input.result.data, scope)
  ];
  if (entries.length === 0) {
    return undefined;
  }
  const result = await recordSessionMemory({
    repoRoot: input.repoRoot,
    sessionId: input.sessionId,
    taskId,
    task: input.task,
    freshness: input.result.freshness,
    source: "mcp_tool",
    toolName: input.toolName,
    callId: input.callId,
    entries
  });
  return result.writes;
}

async function compactSessionMemoryStore(repoRoot: string, store: SessionMemoryStore, freshness?: FreshnessInfo): Promise<SessionMemoryStore> {
  const now = new Date().toISOString();
  const retained = sortEntries(store.entries)
    .filter((entry) => entry.status !== "resolved" && entry.status !== "rejected")
    .map((entry) => ({ ...entry, evidence: entry.evidence.slice(0, MAX_EVIDENCE_PER_ENTRY), scope: { ...entry.scope, refs: entry.scope.refs.slice(0, MAX_REFS_PER_ENTRY) } }));
  const dropped = store.entries.length - retained.length;
  const compacted: SessionMemoryStore = {
    ...store,
    updatedAt: now,
    revision: store.revision + 1,
    entries: markStoreStaleness({ ...store, entries: retained }, freshness).entries,
    compaction: {
      compactedAt: now,
      sourceEventCount: await countEventLines(repoRoot, store.sessionId),
      retainedEntryCount: retained.length,
      droppedEntryCount: dropped
    }
  };
  const compactionDir = path.join(sessionDir(repoRoot, store.sessionId), COMPACTIONS_DIR);
  await fs.mkdir(compactionDir, { recursive: true });
  await atomicJsonWrite(path.join(compactionDir, `${compacted.revision}.json`), compacted);
  await writeStoreAndLatest(repoRoot, compacted, compacted.activeTaskId);
  await rewriteEvents(repoRoot, compacted);
  return compacted;
}

async function replaySessionMemoryEvents(repoRoot: string, sessionId: string, freshness?: FreshnessInfo): Promise<SessionMemoryLoadResult> {
  const warnings: string[] = [];
  const base = emptyStore(sessionId);
  const eventsPath = path.join(sessionDir(repoRoot, sessionId), EVENTS_FILE);
  let store = base;
  try {
    const stat = await fs.stat(eventsPath);
    if (stat.size > MAX_EVENT_REPLAY_BYTES) {
      warnings.push(`session memory replay skipped: events.ndjson exceeds ${MAX_EVENT_REPLAY_BYTES} bytes`);
      return {
        store: markStoreStaleness(sanitizeStoreTrust(store), freshness),
        path: memoryStorePath(repoRoot, sessionId),
        warnings
      };
    }
    const text = await fs.readFile(eventsPath, "utf8");
    for (const line of text.split(/\r?\n/u).filter(Boolean)) {
      try {
        const event = JSON.parse(line) as Partial<SessionMemoryEvent>;
        if (!isSessionMemoryEvent(event, sessionId)) {
          warnings.push("ignored invalid session memory event");
          continue;
        }
        for (const entry of event.entries) {
          store = upsertEntry(store, entry);
        }
        store = { ...store, revision: Math.max(store.revision, event.revision), updatedAt: event.createdAt };
      } catch (error) {
        warnings.push(`ignored invalid session memory event: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code) : "";
    if (code !== "ENOENT") {
      warnings.push(`session memory replay failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return {
    store: markStoreStaleness(sanitizeStoreTrust(store), freshness),
    path: memoryStorePath(repoRoot, sessionId),
    warnings
  };
}
