import { createHash } from "node:crypto";
import type {
  Confidence,
  EvidenceTier,
  FactSource,
  FreshnessInfo,
  SessionMemoryEntryFact,
  SessionMemoryEvidence,
  SessionMemoryInput,
  SessionMemoryKind,
  SessionMemoryProvenance,
  SessionMemoryRef,
  SessionMemoryScope,
  SessionMemoryStatus,
  SessionMemoryStore
} from "../types.js";
import { normalizePath, stableId, uniqueSorted } from "../util.js";
import { MAX_DETAILS_CHARS, MAX_EVIDENCE_PER_ENTRY, MAX_REFS_PER_ENTRY, MAX_SUMMARY_CHARS, type SessionMemoryEvent } from "./model.js";

export function normalizeEntryInput(input: {
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

export function upsertEntry(store: SessionMemoryStore, next: SessionMemoryEntryFact): SessionMemoryStore {
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

export function sanitizeStoreTrust(store: SessionMemoryStore): SessionMemoryStore {
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

export function markStoreStaleness(store: SessionMemoryStore, freshness?: FreshnessInfo): SessionMemoryStore {
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

export function emptyStore(sessionId: string): SessionMemoryStore {
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

export function refKey(ref: SessionMemoryRef): string {
  return [ref.kind, ref.id, ref.path ?? "", ref.edgeKind ?? "", ref.fromId ?? "", ref.toId ?? ""].join(":");
}

export function uniqueRefs(refs: SessionMemoryRef[]): SessionMemoryRef[] {
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

export function sortEntries(entries: SessionMemoryEntryFact[]): SessionMemoryEntryFact[] {
  return [...entries].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.kind.localeCompare(b.kind) || a.key.localeCompare(b.key) || a.id.localeCompare(b.id));
}

export function isSessionMemoryStore(value: unknown, sessionId: string): value is SessionMemoryStore {
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

export function isSessionMemoryEvent(value: unknown, sessionId: string): value is SessionMemoryEvent {
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

export function normalizeIdentifier(value: string | undefined): string | undefined {
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

export function normalizeText(value: string | undefined, limit: number): string | undefined {
  const normalized = value?.replace(/\s+/gu, " ").trim();
  return normalized ? clampText(normalized, limit) : undefined;
}

function clampText(value: string, limit: number): string {
  const cleaned = value.replace(/\s+/gu, " ").trim();
  return cleaned.length > limit ? `${cleaned.slice(0, Math.max(0, limit - 3))}...` : cleaned;
}

export function positiveInt(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && value !== undefined && value > 0 ? Math.trunc(value) : fallback;
}

function confidenceScore(value: Confidence): number {
  return value === "authoritative" ? 0 : value === "derived" ? 1 : 2;
}

function evidenceTierScore(value: EvidenceTier): number {
  return value === "authoritative" ? 0 : value === "derived" ? 1 : value === "heuristic" ? 2 : 3;
}

export function sha1(value: string): string {
  return createHash("sha1").update(value).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

const refFileKinds = new Set<SessionMemoryRef["kind"]>(["file", "test", "endpoint", "workflow", "outcome", "snapshot"]);
