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
  MAX_DETAILS_CHARS,
  MAX_EVENT_REPLAY_BYTES,
  MAX_EVIDENCE_PER_ENTRY,
  MAX_REFS_PER_ENTRY,
  MAX_SUMMARY_CHARS,
  SESSION_MEMORY_DIR,
  SESSION_MEMORY_LOCK_DIR,
  type LatestSessionMemoryPointer,
  type SessionMemoryBuckets,
  type SessionMemoryCompactionArchive,
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
  assertSessionMemoryCompactionDirectory,
  atomicJsonWrite,
  countEventLines,
  ensureSessionMemoryCompactionDirectory,
  memoryStorePath,
  readJson,
  readSessionMemoryEventsText,
  readSessionMemoryStoreJson,
  relativeMemoryPath,
  resolveSessionId,
  resolveSessionIdWithProvenance,
  rewriteEvents,
  sessionMemoryCacheDir,
  shouldCompactEvents,
  writeLatestSessionPointer,
  writeStoreAndLatest
} from "./event-log.js";
import { bucketMemory, filterEntries, renderSessionMemoryMarkdown } from "./formatting.js";
import {
  emptyStore,
  isSessionMemoryEntry,
  isSessionMemoryEvent,
  isSessionMemoryStore,
  markStoreStaleness,
  normalizeEntryInput,
  normalizeIdentifier,
  normalizeText,
  positiveInt,
  refKey,
  sanitizeStoreTrust,
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
  const parsed = await readSessionMemoryStoreJson<SessionMemoryStore>(repoRoot, sessionId);
  const stored = parsed.ok && isSessionMemoryStore(parsed.value, sessionId) ? sanitizeStoreTrust(parsed.value) : undefined;
  if (parsed.ok && !stored) {
    warnings.push("session memory store invalid: schema is invalid");
  }
  if (!parsed.ok && !parsed.missing) {
    warnings.push(`session memory store invalid: ${parsed.error}`);
  }
  // events.ndjson is the bounded write-ahead authority. Always inspect it,
  // including when memory.json is valid, so an event made durable immediately
  // before a failed store publication is not silently lost.
  const replay = await replaySessionMemoryEvents(repoRoot, sessionId);
  warnings.push(...replay.warnings);
  let store = replay.store;
  if (stored) {
    if (!replay.completeDeltaChain && stored.revision > replay.store.revision) {
      store = stored;
      warnings.push(
        `session memory event delta chain is incomplete; using valid memory.json revision ${stored.revision}`
      );
    } else if (replay.store.revision > stored.revision) {
      warnings.push(
        replay.completeDeltaChain
          ? `session memory recovered newer event revision ${replay.store.revision} over store revision ${stored.revision}; using events.ndjson authority`
          : `session memory recovered newer contiguous event revision ${replay.store.revision} over store revision ${stored.revision}; later gapped events were ignored`
      );
    } else if (stored.revision > replay.store.revision) {
      store = stored;
      warnings.push(
        `session memory store revision ${stored.revision} is newer than event revision ${replay.store.revision}; using memory.json authority`
      );
    } else if (
      replay.appliedEventCount === 0 ||
      sessionMemoryReconciliationDigest(stored) === sessionMemoryReconciliationDigest(replay.store)
    ) {
      // Preserve memory.json's non-semantic metadata (for example, complete
      // compaction counts) when both durable representations agree.
      store = stored;
    } else {
      warnings.push(
        `session memory revision ${stored.revision} diverges between memory.json and events.ndjson; using events.ndjson write-ahead authority`
      );
    }
  }
  return {
    store: markStoreStaleness(store, input.freshness),
    path: memoryPath,
    warnings
  };
}

export async function recordSessionMemory(input: SessionMemoryRecordInput): Promise<SessionMemoryResult> {
  return recordSessionMemoryInternal(input, false);
}

async function recordSessionMemoryInternal(input: SessionMemoryRecordInput, skipEquivalentAutoRecord: boolean): Promise<SessionMemoryResult> {
  const repoRoot = path.resolve(input.repoRoot);
  const release = await acquireSessionMemoryLock(repoRoot);
  try {
    const resolution = await resolveSessionIdWithProvenance(repoRoot, input.sessionId);
    const { sessionId } = resolution;
    let loaded: SessionMemoryLoadResult;
    try {
      loaded = await loadSessionMemory({ repoRoot, sessionId, freshness: input.freshness });
    } catch (error) {
      if (!resolution.generated) throw error;
      // Preserve reachability for a new implicit session even when its session
      // directory cannot be inspected or created. The pointer is published
      // below before the checked append retries the unsafe path and fails
      // closed without writing through it.
      loaded = {
        store: emptyStore(sessionId),
        path: memoryStorePath(repoRoot, sessionId),
        warnings: [`session memory store unavailable: ${error instanceof Error ? error.message : String(error)}`]
      };
    }
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
    const nextStore = {
      ...store,
      activeTaskId: effectiveTaskId ?? store.activeTaskId,
      entries: sortEntries(store.entries)
    };
    if (
      skipEquivalentAutoRecord &&
      loaded.warnings.length === 0 &&
      (await isRegularFile(loaded.path)) &&
      sessionMemorySemanticDigest(loaded.store) === sessionMemorySemanticDigest(nextStore)
    ) {
      const memory = bucketMemory(markStoreStaleness(loaded.store, input.freshness).entries, { limit: 20 });
      return {
        sessionId,
        taskId: effectiveTaskId,
        revision: loaded.store.revision,
        memory,
        writes: {
          sessionId,
          taskId: effectiveTaskId,
          revision: loaded.store.revision,
          recordedEntryIds: uniqueSorted(recordedIds),
          compacted: false,
          path: relativeMemoryPath(sessionId)
        },
        warnings
      };
    }
    store = {
      ...nextStore,
      updatedAt: now,
      revision: loaded.store.revision + 1
    };
    // An implicit first session has no caller-held identifier to recover from.
    // Publish its pointer before the first event so any event that becomes
    // durable is already reachable even if memory.json publication is lost.
    if (resolution.generated && loaded.store.revision === 0) {
      await writeLatestSessionPointer(repoRoot, store, effectiveTaskId);
    }
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

async function isRegularFile(filePath: string): Promise<boolean> {
  return fs.lstat(filePath).then((entry) => entry.isFile() && !entry.isSymbolicLink() && entry.nlink === 1).catch(() => false);
}

function sessionMemorySemanticDigest(store: SessionMemoryStore): string {
  const entries = store.entries
    .map(({ createdAt: _createdAt, updatedAt: _updatedAt, evidence, ...entry }) => ({
      ...entry,
      evidence: semanticallyUniqueEvidence(evidence)
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
  return createHash("sha256")
    .update(
      canonicalJson({
        activeTaskId: store.activeTaskId,
        entries
      })
    )
    .digest("hex");
}

function sessionMemoryReconciliationDigest(store: SessionMemoryStore): string {
  return sessionMemorySemanticDigest({
    ...store,
    entries: store.entries.map(({ staleBecause: _staleBecause, status, ...entry }) => ({
      ...entry,
      // Staleness is a read-time freshness projection. It is intentionally
      // excluded when deciding whether the two durable representations agree.
      status: status === "stale" ? "active" : status,
      staleBecause: []
    }))
  });
}

function semanticallyUniqueEvidence(evidence: SessionMemoryEvidence[]): unknown[] {
  const bySemanticValue = new Map<string, unknown>();
  for (const item of evidence) {
    const normalized = normalizeAutoRecordEvidence(item);
    bySemanticValue.set(canonicalJson(normalized), normalized);
  }
  return [...bySemanticValue.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, item]) => item);
}

function normalizeAutoRecordEvidence(evidence: SessionMemoryEvidence): unknown {
  const isOccurrenceOnlyFallback =
    evidence.source === "mcp_tool" &&
    Boolean(evidence.toolName) &&
    Boolean(evidence.callId) &&
    evidence.sourceRef === `${evidence.toolName}:${evidence.callId}`;
  if (!isOccurrenceOnlyFallback) {
    return evidence;
  }
  const { id: _id, sourceRef: _sourceRef, callId: _callId, ...semanticEvidence } = evidence;
  return semanticEvidence;
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
  const pointerEntries = result.memory.entries.slice(0, 20);
  const ids = pointerEntries.map((entry) => entry.id);
  if (ids.length === 0 && !input.sessionId) {
    return undefined;
  }
  return {
    sessionId: result.sessionId,
    revision: result.revision,
    entryIds: ids,
    summaryHash: sessionMemoryPointerDigest(pointerEntries)
  };
}

export function sessionMemoryPointerDigest(entries: SessionMemoryEntryFact[]): string {
  const canonicalEntries = [...entries]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map(({ staleBecause: _staleBecause, status, ...entry }) => ({
      ...entry,
      // Read-time freshness projection may mark an otherwise unchanged entry
      // stale. Normalize that transient state so pointer integrity measures
      // memory content, not the current checkout's freshness banner.
      status: status === "stale" ? "active" : status
    }));
  return createHash("sha256").update(canonicalJson(canonicalEntries)).digest("hex");
}

export async function readArchivedSessionMemoryEntries(input: {
  repoRoot: string;
  sessionId: string;
  entryIds?: string[];
  taskId?: string;
  maxArchives?: number;
  maxEntries?: number;
}): Promise<SessionMemoryEntryFact[]> {
  const repoRoot = path.resolve(input.repoRoot);
  const sessionId = await resolveSessionId(repoRoot, input.sessionId);
  const wanted = new Set((input.entryIds ?? []).slice(0, 20));
  if (wanted.size === 0 && !input.taskId) {
    return [];
  }
  const maxEntries = Math.max(1, Math.min(input.maxEntries ?? 80, 200));
  const compactionDir = await assertSessionMemoryCompactionDirectory(repoRoot, sessionId);
  const files = (await fs.readdir(compactionDir).catch((error: unknown) => {
    if (errorCode(error) === "ENOENT") return [];
    throw error;
  }))
    .filter((entry) => /^\d+\.json$/u.test(entry))
    .sort((left, right) => Number.parseInt(right, 10) - Number.parseInt(left, 10))
    .slice(0, Math.max(1, Math.min(input.maxArchives ?? 8, 20)));
  const found = new Map<string, SessionMemoryEntryFact>();
  for (const file of files) {
    const parsed = await readJson<Partial<SessionMemoryCompactionArchive>>(path.join(compactionDir, file));
    if (!parsed.ok || parsed.value.schemaVersion !== 1 || parsed.value.sessionId !== sessionId || !Array.isArray(parsed.value.droppedEntries)) {
      continue;
    }
    for (const entry of parsed.value.droppedEntries) {
      if (
        isSessionMemoryEntry(entry) &&
        entry.sessionId === sessionId &&
        (wanted.has(entry.id) || (input.taskId !== undefined && entry.taskId === input.taskId)) &&
        !found.has(entry.id) &&
        found.size < maxEntries
      ) {
        found.set(entry.id, entry);
      }
    }
    if ((wanted.size > 0 && [...wanted].every((entryId) => found.has(entryId)) && !input.taskId) || found.size >= maxEntries) {
      break;
    }
  }
  return [...found.values()].sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
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
  const result = await recordSessionMemoryInternal({
    repoRoot: input.repoRoot,
    sessionId: input.sessionId,
    taskId,
    task: input.task,
    freshness: input.result.freshness,
    source: "mcp_tool",
    toolName: input.toolName,
    callId: input.callId,
    entries
  }, true);
  return result.writes;
}

async function compactSessionMemoryStore(repoRoot: string, store: SessionMemoryStore, freshness?: FreshnessInfo): Promise<SessionMemoryStore> {
  const now = new Date().toISOString();
  const sourceEntries = sortEntries(store.entries);
  const retained = sourceEntries
    .filter((entry) => entry.status !== "resolved" && entry.status !== "rejected")
    .map((entry) => ({ ...entry, evidence: entry.evidence.slice(0, MAX_EVIDENCE_PER_ENTRY), scope: { ...entry.scope, refs: entry.scope.refs.slice(0, MAX_REFS_PER_ENTRY) } }));
  const droppedEntries = sourceEntries.filter((entry) => entry.status === "resolved" || entry.status === "rejected");
  const sourceEventCount = await countEventLines(repoRoot, store.sessionId);
  const compacted: SessionMemoryStore = {
    ...store,
    updatedAt: now,
    revision: store.revision + 1,
    entries: markStoreStaleness({ ...store, entries: retained }, freshness).entries,
    compaction: {
      compactedAt: now,
      sourceEventCount,
      retainedEntryCount: retained.length,
      droppedEntryCount: droppedEntries.length
    }
  };
  const compactionDir = await ensureSessionMemoryCompactionDirectory(repoRoot, store.sessionId);
  const archive: SessionMemoryCompactionArchive = {
    schemaVersion: 1,
    sessionId: store.sessionId,
    fromRevision: store.revision,
    toRevision: compacted.revision,
    compactedAt: now,
    sourceEventCount,
    preCompactionDigest: createHash("sha256").update(JSON.stringify(store)).digest("hex"),
    retainedEntryIds: retained.map((entry) => entry.id),
    droppedEntries
  };
  // Publish the full dropped-entry evidence before the active store and event
  // log forget it. If this write fails, compaction stops without data loss.
  await atomicJsonWrite(path.join(compactionDir, `${compacted.revision}.json`), archive);
  // Publish the compacted replay event before active memory forgets dropped
  // entries. If event publication is interrupted, memory.json still retains
  // the pre-compaction evidence and remains the authoritative read path.
  await rewriteEvents(repoRoot, compacted);
  await writeStoreAndLatest(repoRoot, compacted, compacted.activeTaskId);
  return compacted;
}

interface SessionMemoryReplayResult extends SessionMemoryLoadResult {
  appliedEventCount: number;
  completeDeltaChain: boolean;
}

async function replaySessionMemoryEvents(repoRoot: string, sessionId: string): Promise<SessionMemoryReplayResult> {
  const warnings: string[] = [];
  const base = emptyStore(sessionId);
  let store = base;
  let appliedEventCount = 0;
  let completeDeltaChain = true;
  const seenEventIds = new Map<string, string>();
  try {
    const read = await readSessionMemoryEventsText(repoRoot, sessionId, MAX_EVENT_REPLAY_BYTES);
    if (!read.ok) {
      if (!read.missing) {
        warnings.push(
          read.tooLarge
            ? `session memory replay skipped: events.ndjson exceeds ${MAX_EVENT_REPLAY_BYTES} bytes`
            : `session memory replay failed: ${read.error}`
        );
      }
      return {
        store: sanitizeStoreTrust(store),
        path: memoryStorePath(repoRoot, sessionId),
        warnings,
        appliedEventCount,
        completeDeltaChain
      };
    }
    const text = read.value;
    if (Buffer.byteLength(text, "utf8") > MAX_EVENT_REPLAY_BYTES) {
      warnings.push(`session memory replay skipped: events.ndjson exceeds ${MAX_EVENT_REPLAY_BYTES} bytes`);
      return {
        store: sanitizeStoreTrust(store),
        path: memoryStorePath(repoRoot, sessionId),
        warnings,
        appliedEventCount,
        completeDeltaChain
      };
    }
    const lines = text.split(/\r?\n/u);
    const terminated = /[\r\n]$/u.test(text);
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
      const line = lines[lineIndex];
      if (!line.trim()) {
        continue;
      }
      try {
        const event = JSON.parse(line) as Partial<SessionMemoryEvent>;
        if (!isReplayableSessionMemoryEvent(event, sessionId)) {
          warnings.push("ignored invalid session memory event");
          continue;
        }
        const eventDigest = canonicalJson(event);
        const seenDigest = seenEventIds.get(event.eventId);
        if (seenDigest !== undefined) {
          if (seenDigest !== eventDigest) {
            warnings.push(`ignored conflicting duplicate session memory event id ${event.eventId}`);
          }
          continue;
        }
        seenEventIds.set(event.eventId, eventDigest);
        if (event.revision <= store.revision) {
          warnings.push(
            `ignored non-monotonic session memory event revision ${event.revision} after revision ${store.revision}`
          );
          continue;
        }
        if (event.event === "compact") {
          store = replayCompactionEvent(store, event);
          // A compact event carries a complete state snapshot, so it repairs
          // any earlier gap in the retained delta log.
          completeDeltaChain = true;
        } else {
          const expectedRevision = store.revision + 1;
          if (event.revision !== expectedRevision) {
            completeDeltaChain = false;
            warnings.push(
              `ignored gapped session memory event revision ${event.revision}; expected ${expectedRevision}`
            );
            continue;
          }
          for (const entry of event.entries) {
            store = upsertEntry(store, entry);
          }
          store = {
            ...store,
            createdAt: appliedEventCount === 0 ? event.createdAt : store.createdAt,
            updatedAt: event.createdAt,
            revision: event.revision,
            activeTaskId: event.taskId ?? store.activeTaskId,
            entries: sortEntries(store.entries)
          };
        }
        appliedEventCount += 1;
      } catch (error) {
        const partialTrailingLine = !terminated && lineIndex === lines.length - 1;
        warnings.push(
          `${partialTrailingLine ? "ignored partial trailing" : "ignored invalid"} session memory event: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    }
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code) : "";
    if (code !== "ENOENT") {
      warnings.push(`session memory replay failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return {
    store: sanitizeStoreTrust(store),
    path: memoryStorePath(repoRoot, sessionId),
    warnings,
    appliedEventCount,
    completeDeltaChain
  };
}

function isReplayableSessionMemoryEvent(value: Partial<SessionMemoryEvent>, sessionId: string): value is SessionMemoryEvent {
  return (
    isSessionMemoryEvent(value, sessionId) &&
    typeof value.eventId === "string" &&
    value.eventId.length > 0 &&
    value.eventId.length <= 240 &&
    typeof value.createdAt === "string" &&
    value.createdAt.length > 0 &&
    Number.isSafeInteger(value.revision) &&
    value.revision > 0 &&
    (value.taskId === undefined || typeof value.taskId === "string") &&
    value.entries.every((entry) => entry.sessionId === sessionId)
  );
}

function replayCompactionEvent(store: SessionMemoryStore, event: SessionMemoryEvent): SessionMemoryStore {
  return {
    schemaVersion: 1,
    sessionId: store.sessionId,
    repoRoot: ".",
    createdAt: store.revision === 0 ? event.createdAt : store.createdAt,
    updatedAt: event.createdAt,
    revision: event.revision,
    activeTaskId: event.taskId,
    // A compact event is a complete state replacement. Merging here would
    // resurrect resolved/rejected entries that compaction intentionally removed.
    entries: sortEntries(event.entries),
    compaction: {
      compactedAt: event.createdAt,
      sourceEventCount: 1,
      retainedEntryCount: event.entries.length,
      droppedEntryCount: 0
    }
  };
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function errorCode(error: unknown): string {
  return error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code) : "";
}
