import type { Confidence, EvidenceTier, SessionMemoryEvidence, SessionMemoryKind, SessionMemoryProvenance, SessionMemoryRef, SessionMemoryScope, SessionMemoryStatus } from "./facts.js";
import type { ChangeType } from "./change.js";
import type { VerificationCommandReport, VerificationWaiver } from "./verification.js";

export interface ContextPackInput {
  task?: string;
  files?: string[];
  symbols?: string[];
  query?: string;
  diff?: boolean;
  tokenBudget?: number;
  limit?: number;
  includeSnippets?: boolean;
  changeType?: ChangeType;
}

export interface ChangePlanInput extends ContextPackInput {
  saveSnapshot?: boolean;
  taskId?: string;
  followCandidate?: string;
}

export interface SessionMemoryInput {
  action?: "read" | "remember" | "summary" | "compact";
  sessionId?: string;
  taskId?: string;
  task?: string;
  kinds?: SessionMemoryKind[];
  refs?: SessionMemoryRef[];
  files?: string[];
  symbols?: string[];
  topics?: string[];
  limit?: number;
  tokenBudget?: number;
  includeStale?: boolean;
  entries?: Array<{
    kind: SessionMemoryKind;
    key?: string;
    summary: string;
    details?: string;
    provenance?: SessionMemoryProvenance;
    status?: SessionMemoryStatus;
    confidence: Confidence;
    evidenceTier: EvidenceTier;
    scope?: Partial<SessionMemoryScope>;
    evidence?: SessionMemoryEvidence[];
    supersedes?: string[];
  }>;
}

export interface PostEditReviewInput {
  task?: string;
  taskId?: string;
  files?: string[];
  symbols?: string[];
  changeType?: ChangeType;
  tokenBudget?: number;
  limit?: number;
  includeSnippets?: boolean;
  ranTests?: string[];
  ranCommands?: string[];
  ranCommandReports?: VerificationCommandReport[];
  waivedChecks?: string[];
  waivers?: VerificationWaiver[];
  persistOutcome?: boolean;
}

export interface AutoVerifyCandidate {
  schemaVersion: 1;
  taskId: string;
  snapshotDigest: string;
  commandId: string;
  command: string;
  commandExecutable: string;
  commandArgs: string[];
  commandCwd: string;
  targetPaths: string[];
  source: "explicit" | "authoritative-test-edge" | "derived-impact" | "heuristic" | "legacy";
  rank: number;
}

export interface FocusBriefInput {
  task?: string;
  tokenBudget?: number;
  limit?: number;
  diff?: boolean;
}
