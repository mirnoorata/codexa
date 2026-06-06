import type { SessionMemoryEntryFact, SessionMemoryKind, SessionMemoryRef } from "../types.js";
import { normalizePath } from "../util.js";
import { MAX_SUMMARY_CHARS, type SessionMemoryBuckets, type SessionMemoryReadFilter } from "./model.js";

export function filterEntries(entries: SessionMemoryEntryFact[], filter: SessionMemoryReadFilter, limit: number): SessionMemoryEntryFact[] {
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

export function bucketMemory(entries: SessionMemoryEntryFact[], options: { limit: number }): SessionMemoryBuckets {
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

export function renderSessionMemoryMarkdown(memory: SessionMemoryBuckets, limit: number): string {
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

function fileScopeMatches(entry: SessionMemoryEntryFact, files: Set<string>, taskId: string | undefined): boolean {
  if (entry.scope.files.some((file) => files.has(file)) || entry.scope.tests.some((file) => files.has(file))) {
    return true;
  }
  return Boolean(taskId && entry.taskId === taskId && entry.scope.files.length === 0 && entry.scope.tests.length === 0);
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

function refKey(ref: SessionMemoryRef): string {
  return [ref.kind, ref.id, ref.path ?? "", ref.edgeKind ?? "", ref.fromId ?? "", ref.toId ?? ""].join(":");
}

function byKind(entries: SessionMemoryEntryFact[], kind: SessionMemoryKind): SessionMemoryEntryFact[] {
  return entries.filter((entry) => entry.kind === kind);
}

function sortEntries(entries: SessionMemoryEntryFact[]): SessionMemoryEntryFact[] {
  return [...entries].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.kind.localeCompare(b.kind) || a.key.localeCompare(b.key) || a.id.localeCompare(b.id));
}
