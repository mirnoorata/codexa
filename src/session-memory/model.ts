import type {
  Confidence,
  EvidenceTier,
  FreshnessInfo,
  SessionMemoryEntryFact,
  SessionMemoryEvidence,
  SessionMemoryInput,
  SessionMemoryKind,
  SessionMemoryRef,
  SessionMemoryScope,
  SessionMemoryStatus,
  SessionMemoryStore
} from "../types.js";

export const SESSION_MEMORY_DIR = ".codex/cache/codexa-session-memory";
export const SESSION_MEMORY_LOCK_DIR = ".codex/cache/codexa-session-memory.lock";
export const LATEST_FILE = "latest.json";
export const MEMORY_FILE = "memory.json";
export const EVENTS_FILE = "events.ndjson";
export const COMPACTIONS_DIR = "compactions";
export const MAX_EVENTS_BYTES = 512 * 1024;
export const MAX_EVENTS_LINES = 200;
export const MAX_MEMORY_JSON_BYTES = 2 * 1024 * 1024;
export const MAX_EVENT_REPLAY_BYTES = 1024 * 1024;
export const MAX_REFS_PER_ENTRY = 80;
export const MAX_EVIDENCE_PER_ENTRY = 24;
export const MAX_SUMMARY_CHARS = 280;
export const MAX_DETAILS_CHARS = 2000;
export const MEMORY_LOCK_STALE_MS = 120_000;
export const MEMORY_LOCK_TIMEOUT_MS = 30_000;

export interface LatestSessionMemoryPointer {
  schemaVersion: 1;
  sessionId: string;
  path: string;
  taskId?: string;
  updatedAt: string;
}

export interface SessionMemoryEvent {
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

export type MemoryTrustScore = Confidence | EvidenceTier | SessionMemoryStatus;
