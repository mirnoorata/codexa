import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { acquireCacheLock } from "./cache-lock.js";
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
} from "./types.js";
import { normalizePath, stableId, uniqueSorted } from "./util.js";

export const SESSION_MEMORY_DIR = ".codex/cache/codexa-session-memory";
export const SESSION_MEMORY_LOCK_DIR = ".codex/cache/codexa-session-memory.lock";

const LATEST_FILE = "latest.json";
const MEMORY_FILE = "memory.json";
const EVENTS_FILE = "events.ndjson";
const COMPACTIONS_DIR = "compactions";
const MAX_EVENTS_BYTES = 512 * 1024;
const MAX_EVENTS_LINES = 200;
const MAX_MEMORY_JSON_BYTES = 2 * 1024 * 1024;
const MAX_EVENT_REPLAY_BYTES = 1024 * 1024;
const MAX_REFS_PER_ENTRY = 80;
const MAX_EVIDENCE_PER_ENTRY = 24;
const MAX_SUMMARY_CHARS = 280;
const MAX_DETAILS_CHARS = 2000;
const MEMORY_LOCK_STALE_MS = 120_000;
const MEMORY_LOCK_TIMEOUT_MS = 30_000;

interface LatestSessionMemoryPointer {
  schemaVersion: 1;
  sessionId: string;
  path: string;
  taskId?: string;
  updatedAt: string;
}

interface SessionMemoryEvent {
  schemaVersion: 1;
  eventId: string;
  event: "record" | "compact";
  createdAt: string;
  sessionId: string;
  taskId?: string;
  entries: SessionMemoryEntryFact[];
  revision: number;
}

export interface SessionMemoryReadFilter {
  repoRoot: string;
  sessionId?: string;
  taskId?: string;
  kinds?: SessionMemoryKind[];
  refs?: SessionMemoryRef[];
  files?: string[];
  symbols?: string[];
  topics?: string[];
  limit?: number;
  includeStale?: boolean;
  freshness?: FreshnessInfo;
}

export interface SessionMemoryRecordInput {
  repoRoot: string;
  sessionId?: string;
  taskId?: string;
  task?: string;
  entries: NonNullable<SessionMemoryInput["entries"]>;
  freshness: FreshnessInfo;
  source?: SessionMemoryEvidence["source"];
  toolName?: string;
  callId?: string;
}

export interface SessionMemoryLoadResult {
  store: SessionMemoryStore;
  path: string;
  warnings: string[];
}

export interface SessionMemoryBuckets {
  entries: SessionMemoryEntryFact[];
  viewed: SessionMemoryEntryFact[];
  claims: SessionMemoryEntryFact[];
  ruledOut: SessionMemoryEntryFact[];
  openQuestions: SessionMemoryEntryFact[];
  nextReads: SessionMemoryEntryFact[];
  decisions: SessionMemoryEntryFact[];
  verification: SessionMemoryEntryFact[];
  risks: SessionMemoryEntryFact[];
  constraints: SessionMemoryEntryFact[];
  staleEntries: SessionMemoryEntryFact[];
  markdown?: string;
}

export interface SessionMemoryWriteResult {
  sessionId: string;
  taskId?: string;
  revision: number;
  recordedEntryIds: string[];
  compacted: boolean;
  path: string;
}

export interface SessionMemoryResult {
  sessionId: string;
  taskId?: string;
  revision: number;
  memory: SessionMemoryBuckets;
  writes?: SessionMemoryWriteResult;
  warnings: string[];
}

export function sessionMemoryCacheDir(repoRoot: string): string {
  return path.join(path.resolve(repoRoot), SESSION_MEMORY_DIR);
}

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

function isOrientationOnlyChangePlan(toolName: string, data: unknown): boolean {
  if (toolName !== "change_plan" || !isRecord(data)) {
    return false;
  }
  const editReadiness = isRecord(data.editReadiness) ? data.editReadiness : undefined;
  return editReadiness?.status === "orientation-only" || editReadiness?.editable === false;
}

function derivedEntriesForTool(
  toolName: string,
  data: unknown,
  scope: Pick<SessionMemoryScope, "files" | "symbols" | "tests" | "refs">
): NonNullable<SessionMemoryInput["entries"]> {
  if (!data || typeof data !== "object") {
    return [];
  }
  const record = data as Record<string, unknown>;
  if (toolName === "change_plan") {
    const snapshot = isRecord(record.snapshot) ? record.snapshot : undefined;
    const editReadiness = isRecord(record.editReadiness) ? record.editReadiness : undefined;
    const orientationOnly = editReadiness?.status === "orientation-only" || editReadiness?.editable === false;
    const taskId = typeof snapshot?.taskId === "string" ? snapshot.taskId : undefined;
    const plannedTargets = stringValues(record.plannedEditTargets).slice(0, MAX_REFS_PER_ENTRY);
    const targetCount = plannedTargets.length;
    const testCount = Array.isArray(record.tests) ? record.tests.length : 0;
    const workflowCheckCount = Array.isArray(record.requiredWorkflowChecks) ? record.requiredWorkflowChecks.length : 0;
    const dependencyCheckCount = Array.isArray(record.requiredDependencyChecks) ? record.requiredDependencyChecks.length : 0;
    if (orientationOnly) {
      return [
        {
          kind: "decision",
          key: `decision:change_plan:${stableId("change-plan-orientation", String(record.task ?? ""), scope.files.join("\n")).slice(0, 16)}`,
          summary: `change_plan withheld planned edit targets until an explicit file, symbol, or edit-ready packet is available.`,
          provenance: "codexa-derived",
          confidence: "derived",
          evidenceTier: "derived",
          scope
        }
      ];
    }
    return [
      {
        kind: "decision",
        key: `decision:change_plan:${taskId ?? stableId("change-plan", String(record.task ?? ""), scope.files.join("\n")).slice(0, 16)}`,
        summary: `change_plan prepared ${targetCount} planned edit target(s)${taskId ? ` for ${taskId}` : ""}.`,
        provenance: "codexa-derived",
        confidence: "derived",
        evidenceTier: "derived",
        scope
      },
      ...(plannedTargets.length > 0
        ? [
            {
              kind: "next_read" as const,
              key: `next_read:change_plan:${taskId ?? stableId("change-plan-read", plannedTargets.join("\n")).slice(0, 16)}`,
              summary: `Read planned edit target(s): ${plannedTargets.slice(0, 5).join(", ")}${plannedTargets.length > 5 ? `, +${plannedTargets.length - 5} more` : ""}.`,
              provenance: "codexa-derived" as const,
              confidence: "derived" as const,
              evidenceTier: "derived" as const,
              scope: {
                ...scope,
                files: uniqueSorted([...scope.files, ...plannedTargets]).slice(0, MAX_REFS_PER_ENTRY)
              }
            }
          ]
        : []),
      ...(testCount > 0 || workflowCheckCount > 0 || dependencyCheckCount > 0
        ? [
            {
              kind: "verification" as const,
              key: `verification:change_plan:${taskId ?? stableId("change-plan-verify", scope.files.join("\n"), String(testCount), String(workflowCheckCount), String(dependencyCheckCount)).slice(0, 16)}`,
              summary: `change_plan queued ${testCount} test target(s), ${workflowCheckCount} workflow check(s), and ${dependencyCheckCount} dependency check(s).`,
              provenance: "codexa-derived" as const,
              confidence: "derived" as const,
              evidenceTier: "derived" as const,
              scope
            }
          ]
        : [])
    ];
  }
  if (toolName === "post_edit_review") {
    const verdict = typeof record.verdict === "string" ? record.verdict : "unknown";
    const outcome = isRecord(record.outcome) ? record.outcome : undefined;
    const driftReasons = stringList(record.driftReasons, 8);
    const nextActions = stringList(record.nextActions, 8);
    const driftCount = arrayLength(record.driftReasons);
    const testsNotRun = arrayLength(record.testsNotRun);
    const outcomeTestsNotRun = arrayLength(outcome?.testsNotRun);
    const unaccountedTests = Math.max(testsNotRun, outcomeTestsNotRun);
      const ledgerCounts = ledgerStatusCounts(outcome?.verificationLedger ?? record.verificationLedger);
    const commandCount = arrayLength(record.ranCommands ?? outcome?.ranCommands);
    const commandReportCount = arrayLength(record.ranCommandReports ?? outcome?.ranCommandReports);
    const provenanceVersion = verificationProvenanceVersion(record.verificationProvenance ?? outcome?.verificationProvenance);
    const postEditScope = scopeWithOutcomeRefs(scope, record);
    return [
      {
        kind: "verification",
        key: `verification:post_edit_review:${stableId("post-edit-review", String(record.task ?? ""), verdict, postEditScope.files.join("\n")).slice(0, 16)}`,
        summary: `post_edit_review verdict ${verdict}; ${driftCount} drift reason(s); ${unaccountedTests} test(s) still unaccounted for; ledger ${ledgerCounts.covered}/${ledgerCounts.total} covered.`,
        details: clampText(
          [
            `ledger missing=${ledgerCounts.missing}, waived=${ledgerCounts.waived}, not_applicable=${ledgerCounts.notApplicable}, would_cover=${ledgerCounts.wouldCover}`,
            `commands=${commandCount}, commandReports=${commandReportCount}`,
            provenanceVersion ? `verificationLedgerVersion=${provenanceVersion}` : undefined
          ]
            .filter((entry): entry is string => Boolean(entry))
            .join("; "),
          MAX_DETAILS_CHARS
        ),
        provenance: "codexa-derived",
        confidence: "derived",
        evidenceTier: "derived",
        scope: postEditScope
      },
      {
        kind: "decision",
        key: `decision:post_edit_review:${stableId("post-edit-decision", String(record.task ?? ""), verdict, postEditScope.files.join("\n")).slice(0, 16)}`,
        summary: `post_edit_review recommended ${verdict}.`,
        details: nextActions.length > 0 ? `Next actions: ${nextActions.join(" | ")}` : undefined,
        provenance: "codexa-derived",
        confidence: "derived",
        evidenceTier: "derived",
        scope: postEditScope
      },
      ...(driftCount > 0 || unaccountedTests > 0
        ? [
            {
              kind: "risk" as const,
              key: `risk:post_edit_review:${stableId("post-edit-risk", String(record.task ?? ""), verdict, String(driftCount), String(unaccountedTests), postEditScope.files.join("\n")).slice(0, 16)}`,
              summary: `post_edit_review found ${driftCount} drift reason(s) and ${unaccountedTests} unaccounted test target(s).`,
              details: driftReasons.length > 0 ? `Drift reasons: ${driftReasons.join(" | ")}` : undefined,
              provenance: "codexa-derived" as const,
              confidence: "derived" as const,
              evidenceTier: "derived" as const,
              scope: postEditScope
            }
          ]
        : [])
    ];
  }
    if (toolName === "test_plan") {
      const testCount = Array.isArray(record.tests) ? record.tests.length : 0;
      const ledgerCounts = ledgerStatusCounts(record.verificationLedgerPreview);
      const commandCount = arrayLength(record.verificationCommands);
      const testsNotRun = arrayLength(record.testsNotRun);
      const provenanceVersion = verificationProvenanceVersion(record.verificationProvenance);
    return [
      {
        kind: "verification",
        key: `verification:test_plan:${stableId("test-plan", scope.tests.join("\n"), scope.files.join("\n")).slice(0, 16)}`,
        summary: `test_plan recommended ${testCount} test target(s), ${commandCount} verification command(s); preview would cover ${ledgerCounts.wouldCover}/${ledgerCounts.total} ledger item(s) if run.`,
        details: clampText(
          [
            `testsNotRun=${testsNotRun}`,
            `ledger missing=${ledgerCounts.missing}, waived=${ledgerCounts.waived}, not_applicable=${ledgerCounts.notApplicable}, would_cover=${ledgerCounts.wouldCover}`,
            provenanceVersion ? `verificationLedgerVersion=${provenanceVersion}` : undefined
          ]
            .filter((entry): entry is string => Boolean(entry))
            .join("; "),
          MAX_DETAILS_CHARS
        ),
        provenance: "codexa-derived",
        confidence: "derived",
        evidenceTier: "derived",
        scope
      }
    ];
  }
  return [];
}

function ledgerStatusCounts(value: unknown): { total: number; covered: number; missing: number; waived: number; notApplicable: number; wouldCover: number } {
  const entries = Array.isArray(value) ? value : [];
  let covered = 0;
  let missing = 0;
  let waived = 0;
  let notApplicable = 0;
  let wouldCover = 0;
  for (const entry of entries) {
    if (!isRecord(entry) || typeof entry.status !== "string") {
      continue;
    }
    if (entry.status === "covered") {
      covered += 1;
    } else if (entry.status === "missing") {
      missing += 1;
    } else if (entry.status === "waived") {
      waived += 1;
    } else if (entry.status === "not_applicable") {
      notApplicable += 1;
    } else if (entry.status === "would_cover") {
      wouldCover += 1;
    }
  }
  return { total: covered + missing + waived + notApplicable + wouldCover, covered, missing, waived, notApplicable, wouldCover };
}

function scopeWithOutcomeRefs(
  scope: Pick<SessionMemoryScope, "files" | "symbols" | "tests" | "refs">,
  record: Record<string, unknown>
): Pick<SessionMemoryScope, "files" | "symbols" | "tests" | "refs"> {
  const outcome = isRecord(record.outcome) ? record.outcome : undefined;
  const snapshot = isRecord(record.snapshot) ? record.snapshot : undefined;
  const snapshotLoad = isRecord(record.snapshotLoad) ? record.snapshotLoad : undefined;
  const outcomeId = typeof outcome?.outcomeId === "string" ? outcome.outcomeId : undefined;
  const outcomePath = typeof outcome?.path === "string" ? outcome.path : undefined;
  const snapshotId = typeof snapshot?.taskId === "string" ? snapshot.taskId : typeof snapshotLoad?.taskId === "string" ? snapshotLoad.taskId : undefined;
  const snapshotPath = typeof snapshotLoad?.path === "string" ? snapshotLoad.path : undefined;
  const refs: SessionMemoryRef[] = [
    ...scope.refs,
    ...(outcomeId
      ? [
          {
            kind: "outcome" as const,
            id: outcomeId,
            path: outcomePath ? normalizePath(outcomePath) : undefined,
            evidenceTier: "derived" as const,
            confidence: "derived" as const
          }
        ]
      : []),
    ...(snapshotId
      ? [
          {
            kind: "snapshot" as const,
            id: snapshotId,
            path: snapshotPath ? normalizePath(snapshotPath) : undefined,
            evidenceTier: "derived" as const,
            confidence: "derived" as const
          }
        ]
      : [])
  ];
  return {
    ...scope,
    refs: uniqueRefs(refs).slice(0, MAX_REFS_PER_ENTRY)
  };
}

function verificationProvenanceVersion(value: unknown): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  return typeof value.verificationLedgerVersion === "string" ? clampText(value.verificationLedgerVersion, 80) : undefined;
}

function arrayLength(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

function stringList(value: unknown, limit: number): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string").map((entry) => clampText(entry, MAX_SUMMARY_CHARS)).slice(0, limit) : [];
}

function normalizeEntryInput(input: {
  repoRoot: string;
  sessionId: string;
  taskId?: string;
  task?: string;
  entry: NonNullable<SessionMemoryInput["entries"]>[number];
  freshness: FreshnessInfo;
  source: SessionMemoryEvidence["source"];
  toolName?: string;
  callId: string;
  createdAt: string;
}): SessionMemoryEntryFact {
  const taskId = normalizeIdentifier(input.taskId);
  const provenance = normalizeWriteProvenance(input.entry.provenance ?? "agent-asserted", input.source, input.toolName);
  const evidenceTier = normalizeWritableEvidenceTier(input.entry.evidenceTier, provenance);
  const confidence = normalizeWritableConfidence(input.entry.confidence, provenance);
  const summary = clampText(input.entry.summary, MAX_SUMMARY_CHARS);
  const scope = normalizeScope(input.entry.scope, input.entry.evidence, input.repoRoot);
  const key = normalizeMemoryKey(input.entry.key) ?? defaultMemoryKey(taskId, input.entry.kind, summary, scope);
  const id = stableId("session-memory-entry", input.sessionId, taskId ?? "", input.entry.kind, key);
  const evidence = normalizeEvidence({
    entryId: id,
    repoRoot: input.repoRoot,
    provenance,
    evidence: input.entry.evidence,
    fallback: {
      id: stableId("session-memory-evidence", id, input.source, input.toolName ?? "", input.callId, input.createdAt),
      provenance,
      source: input.source,
      sourceRef: input.toolName ? `${input.toolName}:${input.callId}` : input.callId,
      toolName: input.toolName,
      callId: input.callId,
      taskId,
      evidenceTier,
      confidence,
      snapshotId: input.freshness.snapshotId,
      indexedAt: input.freshness.indexedAt,
      headCommit: input.freshness.headCommit,
      note: input.task ? clampText(input.task, MAX_SUMMARY_CHARS) : undefined
    }
  });
  return {
    id,
    type: "SessionMemoryEntry",
    source: sourceFactSource(provenance),
    confidence,
    snapshotId: input.freshness.snapshotId,
    indexedAt: input.freshness.indexedAt,
    sessionId: input.sessionId,
    taskId,
    kind: input.entry.kind,
    key,
    summary,
    details: input.entry.details ? clampText(input.entry.details, MAX_DETAILS_CHARS) : undefined,
    provenance,
    status: input.entry.status ?? "active",
    evidenceTier,
    scope,
    evidence,
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
    supersedes: uniqueSorted(input.entry.supersedes ?? []),
    staleBecause: []
  };
}

function upsertEntry(store: SessionMemoryStore, next: SessionMemoryEntryFact): SessionMemoryStore {
  const entries = store.entries.map((entry) => ({ ...entry }));
  for (const supersededId of next.supersedes) {
    const superseded = entries.find((entry) => entry.id === supersededId);
    if (superseded) {
      superseded.status = "superseded";
      superseded.supersededBy = next.id;
      superseded.updatedAt = next.updatedAt;
    }
  }
  const existingIndex = entries.findIndex((entry) => entry.id === next.id);
  const existing = existingIndex >= 0 ? entries[existingIndex] : undefined;
  if (!existing) {
    entries.push(next);
    return { ...store, entries };
  }
  const mergedScope = mergeScopes(existing.scope, next.scope);
  const mergedEvidence = mergeEvidence(existing.evidence, next.evidence);
  Object.assign(existing, {
    source: next.source,
    summary: next.kind === "viewed" ? existing.summary : next.summary,
    details: next.details ?? existing.details,
    status: mergeStatus(existing.status, next.status),
    confidence: mergeConfidence(existing.confidence, next.confidence),
    snapshotId: next.snapshotId,
    indexedAt: next.indexedAt,
    evidenceTier: mergeEvidenceTier(existing.evidenceTier, next.evidenceTier),
    scope: mergedScope,
    evidence: mergedEvidence,
    updatedAt: next.updatedAt,
    supersedes: uniqueSorted([...existing.supersedes, ...next.supersedes]),
    staleBecause: []
  } satisfies Partial<SessionMemoryEntryFact>);
  entries[existingIndex] = sanitizeEntryTrust(existing);
  return { ...store, entries };
}

function normalizeWriteProvenance(provenance: SessionMemoryProvenance, source: SessionMemoryEvidence["source"], toolName: string | undefined): SessionMemoryProvenance {
  return provenance === "codexa-derived" && !(source === "mcp_tool" && toolName) ? "agent-asserted" : provenance;
}

function normalizeWritableConfidence(confidence: Confidence, provenance: SessionMemoryProvenance): Confidence {
  return provenance === "codexa-derived" ? confidence : "heuristic";
}

function normalizeWritableEvidenceTier(evidenceTier: EvidenceTier, provenance: SessionMemoryProvenance): EvidenceTier {
  if (provenance === "codexa-derived") {
    return evidenceTier;
  }
  return evidenceTier === "fallback" ? "fallback" : "heuristic";
}

function mergeStatus(existing: SessionMemoryStatus, next: SessionMemoryStatus): SessionMemoryStatus {
  if ((existing === "superseded" || existing === "rejected" || existing === "resolved") && next === "active") {
    return existing;
  }
  return next;
}

function filterEntries(entries: SessionMemoryEntryFact[], filter: SessionMemoryReadFilter, limit: number): SessionMemoryEntryFact[] {
  const kinds = new Set(filter.kinds ?? []);
  const files = new Set((filter.files ?? []).map(normalizePath));
  const symbols = new Set(filter.symbols ?? []);
  const topics = (filter.topics ?? []).map((topic) => topic.toLowerCase());
  const refs = new Set((filter.refs ?? []).map(refKey));
  const includeStale = filter.includeStale ?? true;
  return sortEntries(entries)
    .filter((entry) => (kinds.size > 0 ? kinds.has(entry.kind) : true))
    .filter((entry) => (filter.taskId ? entry.taskId === filter.taskId : true))
    .filter((entry) => (includeStale ? true : entry.status !== "stale"))
    .filter((entry) => (files.size > 0 ? fileScopeMatches(entry, files, filter.taskId) : true))
    .filter((entry) => (symbols.size > 0 ? entry.scope.symbols.some((symbol) => symbols.has(symbol)) : true))
    .filter((entry) => (topics.length > 0 ? entry.scope.topics.some((topic) => topics.some((needle) => topic.toLowerCase().includes(needle))) : true))
    .filter((entry) => (refs.size > 0 ? entry.scope.refs.some((ref) => refs.has(refKey(ref))) : true))
    .slice(0, limit);
}

function fileScopeMatches(entry: SessionMemoryEntryFact, files: Set<string>, taskId: string | undefined): boolean {
  if (entry.scope.files.some((file) => files.has(file)) || entry.scope.tests.some((file) => files.has(file))) {
    return true;
  }
  return Boolean(taskId && entry.taskId === taskId && entry.scope.files.length === 0 && entry.scope.tests.length === 0);
}

function bucketMemory(entries: SessionMemoryEntryFact[], options: { limit: number }): SessionMemoryBuckets {
  const limited = sortEntries(entries).slice(0, options.limit);
  return {
    entries: limited,
    viewed: byKind(limited, "viewed"),
    claims: byKind(limited, "claim"),
    ruledOut: byKind(limited, "ruled_out"),
    openQuestions: byKind(limited, "open_question"),
    nextReads: byKind(limited, "next_read"),
    decisions: byKind(limited, "decision"),
    verification: byKind(limited, "verification"),
    risks: byKind(limited, "risk"),
    constraints: byKind(limited, "constraint"),
    staleEntries: limited.filter((entry) => entry.status === "stale")
  };
}

function renderSessionMemoryMarkdown(memory: SessionMemoryBuckets, limit: number): string {
  const sections = [
    formatMemorySection("Claims", memory.claims, limit),
    formatMemorySection("Decisions", memory.decisions, limit),
    formatMemorySection("Ruled out", memory.ruledOut, limit),
    formatMemorySection("Open questions", memory.openQuestions, limit),
    formatMemorySection("Next reads", memory.nextReads, limit),
    formatMemorySection("Verification", memory.verification, limit),
    formatMemorySection("Constraints", memory.constraints, limit),
    formatMemorySection("Recently viewed", memory.viewed, Math.min(5, limit)),
    formatMemorySection("Stale", memory.staleEntries, Math.min(5, limit))
  ].filter(Boolean);
  return sections.length > 0 ? sections.join("\n") : "No session memory entries recorded.";
}

function formatMemorySection(title: string, entries: SessionMemoryEntryFact[], limit: number): string {
  if (entries.length === 0) {
    return "";
  }
  return [`${title}:`, ...entries.slice(0, limit).map(formatMemoryEntryLine)].join("\n");
}

function formatMemoryEntryLine(entry: SessionMemoryEntryFact): string {
  const label = `(${entry.provenance}; ${entry.evidenceTier}/${entry.confidence}; ${entry.id})`;
  const summary = sanitizeMemoryText(entry.summary);
  if (entry.provenance === "codexa-derived") {
    return `- ${summary} ${label}`;
  }
  return `- untrusted ${entry.provenance} note: "${summary}" ${label}`;
}

function sanitizeMemoryText(value: string): string {
  return value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, MAX_SUMMARY_CHARS);
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

function sanitizeStoreTrust(store: SessionMemoryStore): SessionMemoryStore {
  return {
    ...store,
    entries: store.entries.map(sanitizeEntryTrust)
  };
}

function sanitizeEntryTrust(entry: SessionMemoryEntryFact): SessionMemoryEntryFact {
  if (entry.provenance === "codexa-derived") {
    return entry;
  }
  const confidence = normalizeWritableConfidence(entry.confidence, entry.provenance);
  const evidenceTier = normalizeWritableEvidenceTier(entry.evidenceTier, entry.provenance);
  return {
    ...entry,
    source: sourceFactSource(entry.provenance),
    confidence,
    evidenceTier,
    evidence: entry.evidence.map((evidence) => ({
      ...evidence,
      provenance: entry.provenance,
      source: "agent",
      confidence: normalizeWritableConfidence(evidence.confidence, entry.provenance),
      evidenceTier: normalizeWritableEvidenceTier(evidence.evidenceTier, entry.provenance)
    }))
  };
}

function markStoreStaleness(store: SessionMemoryStore, freshness?: FreshnessInfo): SessionMemoryStore {
  if (!freshness) {
    return store;
  }
  const dirty = new Set(freshness.dirtyFiles.map(normalizePath));
  return {
    ...store,
    entries: store.entries.map((entry) => {
      const reasons: string[] = [];
      const latestEvidence = latestEvidenceForStaleness(entry.evidence);
      if (latestEvidence?.headCommit && freshness.headCommit && latestEvidence.headCommit !== freshness.headCommit) {
        reasons.push("head commit changed");
      }
      const scopedFiles = [...entry.scope.files, ...entry.scope.tests].map(normalizePath);
      const dirtyOverlap = scopedFiles.filter((file) => dirty.has(file));
      if (dirtyOverlap.length > 0 && entry.snapshotId !== freshness.snapshotId) {
        reasons.push(`scope dirty: ${dirtyOverlap.slice(0, 5).join(", ")}`);
      }
      return reasons.length > 0
        ? {
            ...entry,
            status: entry.status === "active" ? "stale" : entry.status,
            staleBecause: uniqueSorted([...entry.staleBecause, ...reasons])
          }
        : {
            ...entry,
            status: entry.status === "stale" ? "active" : entry.status,
            staleBecause: []
          };
    })
  };
}

function latestEvidenceForStaleness(evidence: SessionMemoryEvidence[]): SessionMemoryEvidence | undefined {
  return evidence
    .slice()
    .sort((left, right) => (Date.parse(right.indexedAt) || 0) - (Date.parse(left.indexedAt) || 0) || right.id.localeCompare(left.id))[0];
}

function refsFromQueryResult(data: unknown, index: CodexaIndex): SessionMemoryRef[] {
  const fileByPath = new Map(index.files.map((file) => [file.path, file]));
  const symbolByPathName = new Map(index.symbols.map((symbol) => [`${symbol.path}:${symbol.qualifiedName}`, symbol]));
  const refs = new Map<string, SessionMemoryRef>();
  const addFile = (filePath: string, kind: "file" | "test" = "file") => {
    const normalized = normalizePath(filePath);
    const file = fileByPath.get(normalized);
    if (!file) {
      return;
    }
    const ref: SessionMemoryRef = {
      kind: kind === "test" || file.test ? "test" : "file",
      id: file.id,
      path: file.path,
      evidenceTier: "derived",
      confidence: file.confidence
    };
    refs.set(refKey(ref), ref);
  };
  const addSymbol = (pathValue: unknown, qualifiedName: unknown) => {
    if (typeof pathValue !== "string" || typeof qualifiedName !== "string") {
      return;
    }
    const symbol = symbolByPathName.get(`${normalizePath(pathValue)}:${qualifiedName}`);
    if (!symbol) {
      return;
    }
    const ref: SessionMemoryRef = {
      kind: "symbol",
      id: symbol.id,
      path: symbol.path,
      evidenceTier: "derived",
      confidence: symbol.confidence
    };
    refs.set(refKey(ref), ref);
  };
  const visit = (value: unknown, depth: number) => {
    if (refs.size >= MAX_REFS_PER_ENTRY || depth > 7 || value === null || value === undefined) {
      return;
    }
    if (typeof value === "string") {
      if (/^[^/\s]+(?:\/[^/\s]+)+$/u.test(value)) {
        addFile(value);
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value.slice(0, 120)) {
        visit(item, depth + 1);
      }
      return;
    }
    if (typeof value !== "object") {
      return;
    }
    const record = value as Record<string, unknown>;
    if (typeof record.path === "string") {
      addFile(record.path, typeof record.kind === "string" && record.kind === "test" ? "test" : "file");
      addSymbol(record.path, record.qualifiedName);
    }
    if (typeof record.entryPath === "string") {
      addFile(record.entryPath);
    }
    if (Array.isArray(record.relatedFiles)) {
      for (const file of record.relatedFiles.slice(0, 20)) {
        if (typeof file === "string") {
          addFile(file);
        }
      }
    }
    if (Array.isArray(record.tests)) {
      for (const file of record.tests.slice(0, 20)) {
        if (typeof file === "string") {
          addFile(file, "test");
        } else {
          visit(file, depth + 1);
        }
      }
    }
    if (typeof record.id === "string" && typeof record.workflowKind === "string" && typeof record.title === "string") {
      const ref: SessionMemoryRef = {
        kind: "workflow",
        id: record.id,
        path: typeof record.entryPath === "string" ? normalizePath(record.entryPath) : undefined,
        evidenceTier: "derived",
        confidence: "derived"
      };
      refs.set(refKey(ref), ref);
    }
    for (const [key, item] of Object.entries(record)) {
      if (["raw", "snippets", "mcp", "runtime", "sessionMemory", "priorSessionMemory"].includes(key)) {
        continue;
      }
      visit(item, depth + 1);
    }
  };
  visit(data, 0);
  return [...refs.values()].sort((a, b) => refKey(a).localeCompare(refKey(b))).slice(0, MAX_REFS_PER_ENTRY);
}

function normalizeScope(scope: Partial<SessionMemoryScope> | undefined, evidence: SessionMemoryEvidence[] | undefined, repoRoot: string): SessionMemoryScope {
  const refs = uniqueRefs([...(scope?.refs ?? []), ...(evidence ?? []).flatMap((item) => evidenceRef(item))]).slice(0, MAX_REFS_PER_ENTRY);
  const refFiles = refs
    .filter((ref) => ref.kind !== "test" && ref.path && refFileKinds.has(ref.kind))
    .map((ref) => ref.path)
    .filter((value): value is string => Boolean(value));
  const files = normalizePathList([...(scope?.files ?? []), ...refFiles]);
  const tests = normalizePathList([...(scope?.tests ?? []), ...refs.filter((ref) => ref.kind === "test").map((ref) => ref.path ?? ref.id)]);
  const symbols = normalizeIdentifierList([...(scope?.symbols ?? []), ...refs.filter((ref) => ref.kind === "symbol").map((ref) => ref.id)]);
  const workflows = normalizeIdentifierList([...(scope?.workflows ?? []), ...refs.filter((ref) => ref.kind === "workflow").map((ref) => ref.id)]);
  const topics = uniqueSorted((scope?.topics ?? []).map((topic) => clampText(topic.replaceAll(repoRoot, "<repo>"), MAX_SUMMARY_CHARS))).slice(0, 40);
  return { files, symbols, tests, workflows, topics, refs };
}

function normalizePathList(values: string[]): string[] {
  return uniqueSorted(values.map((value) => normalizePath(clampText(value, 500))).filter(Boolean)).slice(0, MAX_REFS_PER_ENTRY);
}

function normalizeIdentifierList(values: string[]): string[] {
  return uniqueSorted(values.map((value) => clampText(value, 240)).filter(Boolean)).slice(0, MAX_REFS_PER_ENTRY);
}

function stringValues(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return uniqueSorted(value.filter((entry): entry is string => typeof entry === "string").map((entry) => normalizePath(clampText(entry, 500))));
}

function evidenceRef(evidence: SessionMemoryEvidence): SessionMemoryRef[] {
  if (!evidence.path) {
    return [];
  }
  return [
    {
      kind: evidence.factType === "GraphEdge" ? "graph_edge" : "file",
      id: evidence.sourceRef,
      path: evidence.path,
      edgeKind: evidence.edgeKind,
      evidenceTier: evidence.evidenceTier,
      confidence: evidence.confidence
    }
  ];
}

function normalizeEvidence(input: {
  entryId: string;
  repoRoot: string;
  provenance: SessionMemoryProvenance;
  evidence?: SessionMemoryEvidence[];
  fallback: SessionMemoryEvidence;
}): SessionMemoryEvidence[] {
  const trustedCodexaEvidence = input.provenance === "codexa-derived";
  const entries =
    input.evidence && input.evidence.length > 0
      ? trustedCodexaEvidence
        ? input.evidence
        : [...input.evidence, input.fallback]
      : [input.fallback];
  return mergeEvidence(
    [],
    entries.map((entry, index) => {
      return {
        ...entry,
        id: normalizeIdentifier(entry.id) ?? stableId("session-memory-evidence", input.entryId, String(index), entry.sourceRef),
        source: trustedCodexaEvidence ? entry.source : "agent",
        sourceRef: clampText(entry.sourceRef.replaceAll(input.repoRoot, "<repo>"), MAX_SUMMARY_CHARS),
        path: entry.path ? normalizePath(entry.path.replaceAll(input.repoRoot, "<repo>")) : undefined,
        note: entry.note ? clampText(entry.note.replaceAll(input.repoRoot, "<repo>"), MAX_SUMMARY_CHARS) : undefined,
        provenance: trustedCodexaEvidence ? (entry.provenance ?? input.provenance) : input.provenance,
        evidenceTier: trustedCodexaEvidence ? entry.evidenceTier : normalizeWritableEvidenceTier(entry.evidenceTier, input.provenance),
        confidence: trustedCodexaEvidence ? entry.confidence : normalizeWritableConfidence(entry.confidence, input.provenance),
        snapshotId: trustedCodexaEvidence ? entry.snapshotId : input.fallback.snapshotId,
        indexedAt: trustedCodexaEvidence ? entry.indexedAt : input.fallback.indexedAt,
        headCommit: trustedCodexaEvidence ? entry.headCommit : input.fallback.headCommit
      };
    })
  );
}

function mergeScopes(a: SessionMemoryScope, b: SessionMemoryScope): SessionMemoryScope {
  return {
    files: uniqueSorted([...a.files, ...b.files]).slice(0, MAX_REFS_PER_ENTRY),
    symbols: uniqueSorted([...a.symbols, ...b.symbols]).slice(0, MAX_REFS_PER_ENTRY),
    tests: uniqueSorted([...a.tests, ...b.tests]).slice(0, MAX_REFS_PER_ENTRY),
    workflows: uniqueSorted([...a.workflows, ...b.workflows]).slice(0, MAX_REFS_PER_ENTRY),
    topics: uniqueSorted([...a.topics, ...b.topics]).slice(0, 40),
    refs: uniqueRefs([...a.refs, ...b.refs]).slice(0, MAX_REFS_PER_ENTRY)
  };
}

function mergeEvidence(a: SessionMemoryEvidence[], b: SessionMemoryEvidence[]): SessionMemoryEvidence[] {
  const byId = new Map<string, SessionMemoryEvidence>();
  for (const entry of [...a, ...b]) {
    byId.set(entry.id, entry);
  }
  const entries = [...byId.values()];
  const newest = latestEvidenceForStaleness(entries);
  const selected = entries
    .sort(
      (left, right) =>
        evidenceTierScore(left.evidenceTier) - evidenceTierScore(right.evidenceTier) ||
        confidenceScore(left.confidence) - confidenceScore(right.confidence) ||
        left.sourceRef.localeCompare(right.sourceRef) ||
        left.id.localeCompare(right.id)
    )
    .slice(0, MAX_EVIDENCE_PER_ENTRY);
  if (newest && !selected.some((entry) => entry.id === newest.id)) {
    selected[selected.length > 0 ? selected.length - 1 : 0] = newest;
  }
  return selected;
}

function mergeConfidence(a: Confidence, b: Confidence): Confidence {
  return confidenceScore(a) <= confidenceScore(b) ? a : b;
}

function mergeEvidenceTier(a: EvidenceTier, b: EvidenceTier): EvidenceTier {
  return evidenceTierScore(a) <= evidenceTierScore(b) ? a : b;
}

function sourceFactSource(provenance: SessionMemoryProvenance): FactSource {
  return provenance === "codexa-derived" ? "mcp-tool" : "codex-agent";
}

function defaultMemoryKey(taskId: string | undefined, kind: SessionMemoryKind, summary: string, scope: SessionMemoryScope): string {
  if (kind === "viewed") {
    return `viewed:${stableId("viewed", taskId ?? "", scope.refs.map(refKey).sort().join("\n")).slice(0, 24)}`;
  }
  return `${kind}:${stableId("memory-key", taskId ?? "", summary, scope.files.join("\n"), scope.symbols.join("\n")).slice(0, 24)}`;
}

function viewedSummary(toolName: string, refs: SessionMemoryRef[], files: string[], symbols: string[], tests: string[]): string {
  const parts = [`${toolName} returned ${refs.length} ref(s)`];
  if (files.length > 0) {
    parts.push(`${files.length} file(s)`);
  }
  if (symbols.length > 0) {
    parts.push(`${symbols.length} symbol(s)`);
  }
  if (tests.length > 0) {
    parts.push(`${tests.length} test(s)`);
  }
  return clampText(parts.join("; "), MAX_SUMMARY_CHARS);
}

function taskIdFromToolData(data: unknown): string | undefined {
  if (!isRecord(data)) {
    return undefined;
  }
  if (typeof data.taskId === "string") {
    return data.taskId;
  }
  if (isRecord(data.snapshot) && typeof data.snapshot.taskId === "string") {
    return data.snapshot.taskId;
  }
  if (isRecord(data.snapshotBlock) && typeof data.snapshotBlock.taskId === "string") {
    return data.snapshotBlock.taskId;
  }
  if (isRecord(data.snapshotLoad) && typeof data.snapshotLoad.taskId === "string") {
    return data.snapshotLoad.taskId;
  }
  return undefined;
}

async function resolveSessionId(repoRoot: string, requested?: string): Promise<string> {
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

function emptyStore(sessionId: string): SessionMemoryStore {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    sessionId,
    repoRoot: ".",
    createdAt: now,
    updatedAt: now,
    revision: 0,
    entries: [],
    compaction: {
      sourceEventCount: 0,
      retainedEntryCount: 0,
      droppedEntryCount: 0
    }
  };
}

async function writeStoreAndLatest(repoRoot: string, store: SessionMemoryStore, taskId?: string): Promise<void> {
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

async function appendSessionMemoryEvent(repoRoot: string, store: SessionMemoryStore, event: SessionMemoryEvent): Promise<void> {
  await fs.mkdir(sessionDir(repoRoot, store.sessionId), { recursive: true });
  await fs.appendFile(path.join(sessionDir(repoRoot, store.sessionId), EVENTS_FILE), `${JSON.stringify(event)}\n`, "utf8");
}

async function rewriteEvents(repoRoot: string, store: SessionMemoryStore): Promise<void> {
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

async function shouldCompactEvents(repoRoot: string, sessionId: string): Promise<boolean> {
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

async function countEventLines(repoRoot: string, sessionId: string): Promise<number> {
  try {
    const text = await fs.readFile(path.join(sessionDir(repoRoot, sessionId), EVENTS_FILE), "utf8");
    return text.split(/\r?\n/u).filter(Boolean).length;
  } catch {
    return 0;
  }
}

async function acquireSessionMemoryLock(repoRoot: string): Promise<() => Promise<void>> {
  return acquireCacheLock({
    repoRoot,
    lockDir: SESSION_MEMORY_LOCK_DIR,
    staleMs: MEMORY_LOCK_STALE_MS,
    timeoutMs: MEMORY_LOCK_TIMEOUT_MS,
    label: "Codexa session memory"
  });
}

async function atomicJsonWrite(filePath: string, value: unknown): Promise<void> {
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.rename(tmp, filePath);
}

async function atomicTextWrite(filePath: string, value: string): Promise<void> {
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, value, "utf8");
  await fs.rename(tmp, filePath);
}

async function readJson<T>(filePath: string): Promise<{ ok: true; value: T } | { ok: false; missing: boolean; error: string }> {
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

function memoryStorePath(repoRoot: string, sessionId: string): string {
  return path.join(sessionDir(repoRoot, sessionId), MEMORY_FILE);
}

function sessionDir(repoRoot: string, sessionId: string): string {
  return path.join(sessionMemoryCacheDir(repoRoot), "sessions", sessionId);
}

function relativeMemoryPath(sessionId: string): string {
  return path.posix.join("sessions", sessionId, MEMORY_FILE);
}

function refKey(ref: SessionMemoryRef): string {
  return [ref.kind, ref.id, ref.path ?? "", ref.edgeKind ?? "", ref.fromId ?? "", ref.toId ?? ""].join(":");
}

function uniqueRefs(refs: SessionMemoryRef[]): SessionMemoryRef[] {
  const byKey = new Map<string, SessionMemoryRef>();
  for (const ref of refs) {
    const normalized = {
      ...ref,
      path: ref.path ? normalizePath(ref.path) : undefined
    };
    byKey.set(refKey(normalized), normalized);
  }
  return [...byKey.values()].sort((a, b) => refKey(a).localeCompare(refKey(b)));
}

function byKind(entries: SessionMemoryEntryFact[], kind: SessionMemoryKind): SessionMemoryEntryFact[] {
  return entries.filter((entry) => entry.kind === kind);
}

function sortEntries(entries: SessionMemoryEntryFact[]): SessionMemoryEntryFact[] {
  return [...entries].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.kind.localeCompare(b.kind) || a.key.localeCompare(b.key) || a.id.localeCompare(b.id));
}

function isSessionMemoryStore(value: unknown, sessionId: string): value is SessionMemoryStore {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Partial<SessionMemoryStore>;
  return (
    record.schemaVersion === 1 &&
    record.sessionId === sessionId &&
    record.repoRoot === "." &&
    Array.isArray(record.entries) &&
    record.entries.every(isSessionMemoryEntry) &&
    typeof record.revision === "number"
  );
}

function isSessionMemoryEvent(value: unknown, sessionId: string): value is SessionMemoryEvent {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Partial<SessionMemoryEvent>;
  return (
    record.schemaVersion === 1 &&
    record.sessionId === sessionId &&
    (record.event === "record" || record.event === "compact") &&
    Array.isArray(record.entries) &&
    record.entries.every(isSessionMemoryEntry) &&
    typeof record.revision === "number"
  );
}

function isSessionMemoryEntry(value: unknown): value is SessionMemoryEntryFact {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.id === "string" &&
    value.type === "SessionMemoryEntry" &&
    typeof value.source === "string" &&
    isConfidence(value.confidence) &&
    typeof value.snapshotId === "string" &&
    typeof value.indexedAt === "string" &&
    typeof value.sessionId === "string" &&
    isSessionMemoryKind(value.kind) &&
    typeof value.key === "string" &&
    typeof value.summary === "string" &&
    isSessionMemoryProvenance(value.provenance) &&
    isSessionMemoryStatus(value.status) &&
    isEvidenceTier(value.evidenceTier) &&
    isSessionMemoryScope(value.scope) &&
    Array.isArray(value.evidence) &&
    value.evidence.every(isSessionMemoryEvidence) &&
    typeof value.createdAt === "string" &&
    typeof value.updatedAt === "string" &&
    Array.isArray(value.supersedes) &&
    value.supersedes.every((entry) => typeof entry === "string") &&
    Array.isArray(value.staleBecause) &&
    value.staleBecause.every((entry) => typeof entry === "string")
  );
}

function isSessionMemoryScope(value: unknown): value is SessionMemoryScope {
  return (
    isRecord(value) &&
    stringArray(value.files) &&
    stringArray(value.symbols) &&
    stringArray(value.tests) &&
    stringArray(value.workflows) &&
    stringArray(value.topics) &&
    Array.isArray(value.refs) &&
    value.refs.every(isSessionMemoryRef)
  );
}

function isSessionMemoryRef(value: unknown): value is SessionMemoryRef {
  return isRecord(value) && typeof value.kind === "string" && typeof value.id === "string" && isEvidenceTier(value.evidenceTier) && isConfidence(value.confidence);
}

function isSessionMemoryEvidence(value: unknown): value is SessionMemoryEvidence {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    isSessionMemoryProvenance(value.provenance) &&
    typeof value.source === "string" &&
    typeof value.sourceRef === "string" &&
    isEvidenceTier(value.evidenceTier) &&
    isConfidence(value.confidence) &&
    typeof value.snapshotId === "string" &&
    typeof value.indexedAt === "string" &&
    (typeof value.headCommit === "string" || value.headCommit === null)
  );
}

function isSessionMemoryKind(value: unknown): value is SessionMemoryKind {
  return typeof value === "string" && ["viewed", "claim", "ruled_out", "open_question", "next_read", "decision", "verification", "risk", "constraint"].includes(value);
}

function isSessionMemoryProvenance(value: unknown): value is SessionMemoryProvenance {
  return typeof value === "string" && ["codexa-derived", "agent-asserted", "user-asserted"].includes(value);
}

function isSessionMemoryStatus(value: unknown): value is SessionMemoryStatus {
  return typeof value === "string" && ["active", "stale", "superseded", "rejected", "resolved"].includes(value);
}

function isEvidenceTier(value: unknown): value is EvidenceTier {
  return typeof value === "string" && ["authoritative", "derived", "heuristic", "fallback"].includes(value);
}

function isConfidence(value: unknown): value is Confidence {
  return typeof value === "string" && ["authoritative", "derived", "heuristic"].includes(value);
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function normalizeIdentifier(value: string | undefined): string | undefined {
  const normalized = value
    ?.trim()
    .replace(/[^A-Za-z0-9._:-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 120);
  return normalized || undefined;
}

function normalizeMemoryKey(value: string | undefined): string | undefined {
  const normalized = value
    ?.trim()
    .replace(/\s+/gu, " ")
    .replace(/[^A-Za-z0-9._:/ -]+/gu, "")
    .slice(0, 160);
  return normalized || undefined;
}

function normalizeText(value: string | undefined, limit: number): string | undefined {
  const normalized = value?.replace(/\s+/gu, " ").trim();
  return normalized ? clampText(normalized, limit) : undefined;
}

function clampText(value: string, limit: number): string {
  const cleaned = value.replace(/\s+/gu, " ").trim();
  return cleaned.length > limit ? `${cleaned.slice(0, Math.max(0, limit - 3))}...` : cleaned;
}

function positiveInt(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && value !== undefined && value > 0 ? Math.trunc(value) : fallback;
}

function confidenceScore(value: Confidence): number {
  return value === "authoritative" ? 0 : value === "derived" ? 1 : 2;
}

function evidenceTierScore(value: EvidenceTier): number {
  return value === "authoritative" ? 0 : value === "derived" ? 1 : value === "heuristic" ? 2 : 3;
}

function sha1(value: string): string {
  return createHash("sha1").update(value).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

const refFileKinds = new Set<SessionMemoryRef["kind"]>(["file", "test", "endpoint", "workflow", "outcome", "snapshot"]);
