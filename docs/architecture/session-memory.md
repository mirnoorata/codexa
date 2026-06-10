# Session Memory Design

Status: implemented locally in the Codexa TypeScript server.

This plan records the preferred hybrid design after comparing two proposals:
one emphasizing Codexa-shaped provenance and one emphasizing auto-recorded
session views. The implementation should take the product insight from the
second proposal, namely first-class `viewed` memory, while preserving Codexa's
existing fact discipline, cache layout, and small MCP surface.

## 1. Schema

Session memory is cache-only working memory. It does not become part of the
codebase graph and it must not promote agent assertions into parser-backed
facts.

Extend the existing vocabularies only where needed:

```ts
export type FactSource =
  | "tree-sitter"
  | "typescript-syntax"
  | "typescript-compiler"
  | "git"
  | "manifest"
  | "markdown"
  | "heuristic"
  | "static-analysis"
  | "lsp"
  | "mcp-tool"
  | "codex-agent"
  | "codexa-cache";

export type FactType =
  | "RepoSnapshot"
  | "File"
  | "Symbol"
  | "UsageSite"
  | "ImportEdge"
  | "TestEdge"
  | "GraphEdge"
  | "WorkflowTrace"
  | "ModuleCluster"
  | "RiskSignal"
  | "ParserError"
  | "SessionMemoryEntry";

export type SessionMemoryKind =
  | "viewed"
  | "claim"
  | "ruled_out"
  | "open_question"
  | "next_read"
  | "decision"
  | "verification"
  | "risk"
  | "constraint";

export type SessionMemoryProvenance =
  | "codexa-derived"
  | "agent-asserted"
  | "user-asserted";

export type SessionMemoryStatus =
  | "active"
  | "stale"
  | "superseded"
  | "rejected"
  | "resolved";

export interface SessionMemoryRef {
  kind: "file" | "symbol" | "workflow" | "endpoint" | "test" | "graph_edge" | "outcome" | "snapshot";
  id: string;
  path?: string;
  edgeKind?: GraphEdgeKind;
  fromId?: string;
  toId?: string;
  evidenceTier: EvidenceTier;
  confidence: Confidence;
}

export interface SessionMemoryScope {
  files: string[];
  symbols: string[];
  tests: string[];
  workflows: string[];
  topics: string[];
  refs: SessionMemoryRef[];
}

export interface SessionMemoryEvidence {
  id: string;
  provenance: SessionMemoryProvenance;
  source: "agent" | "mcp_tool" | "task_snapshot" | "post_edit_outcome" | "hook_event" | "index_fact";
  sourceRef: string;
  toolName?: string;
  callId?: string;
  taskId?: string;
  path?: string;
  range?: Range;
  factType?: FactType;
  edgeKind?: GraphEdgeKind;
  evidenceTier: EvidenceTier;
  confidence: Confidence;
  snapshotId: string;
  indexedAt: string;
  headCommit: string | null;
  note?: string;
}

export interface SessionMemoryEntryFact extends BaseFact {
  type: "SessionMemoryEntry";
  sessionId: string;
  taskId?: string;
  kind: SessionMemoryKind;
  key: string;
  summary: string;
  details?: string;
  provenance: SessionMemoryProvenance;
  status: SessionMemoryStatus;
  evidenceTier: EvidenceTier;
  scope: SessionMemoryScope;
  evidence: SessionMemoryEvidence[];
  createdAt: string;
  updatedAt: string;
  supersedes: string[];
  supersededBy?: string;
  staleBecause: string[];
}

export interface SessionMemoryStore {
  schemaVersion: 1;
  sessionId: string;
  repoRoot: ".";
  createdAt: string;
  updatedAt: string;
  revision: number;
  activeTaskId?: string;
  entries: SessionMemoryEntryFact[];
  compaction: {
    compactedAt?: string;
    sourceEventCount: number;
    retainedEntryCount: number;
    droppedEntryCount: number;
  };
}
```

Important trust rule: do not add `"agent-asserted"` to `Confidence`.
Agent-authored memory uses `provenance: "agent-asserted"` plus an ordinary
`Confidence`, usually `"heuristic"`, and an explicit `EvidenceTier`.

## 2. Storage Layout

All state is under `.codex/cache/`:

```text
.codex/cache/codexa-session-memory/
  latest.json
  sessions/
    <sessionId>/
      memory.json
      events.ndjson
      compactions/
        <revision>.json
.codex/cache/codexa-session-memory.lock/
  owner.json
```

`latest.json` mirrors the existing task/outcome pointer pattern:

```json
{
  "schemaVersion": 1,
  "sessionId": "<sessionId>",
  "path": "sessions/<sessionId>/memory.json",
  "taskId": "<optional taskId>",
  "updatedAt": "<iso timestamp>"
}
```

Write rules:

- `memory.json`, `latest.json`, and compaction records are written with
  temp-file plus rename.
- `events.ndjson` is append-only while holding the session-memory lock.
- Reads of `memory.json` are lock-free because writers publish by atomic rename.
- Missing or corrupt `memory.json` is rebuilt from `events.ndjson` when possible.

Locking:

- Extract the directory lock currently used by the indexer into
  `src/cache-lock.ts`.
- Keep `.codex/cache/codexa-index.lock` behavior unchanged.
- Use `.codex/cache/codexa-session-memory.lock` for session writes and
  compaction.
- Owner metadata should include `pid`, `token`, `processStartTime`,
  `startedAt`, `heartbeatAt`, and `repoRoot`.

Compaction:

- Trigger when `events.ndjson` exceeds 512 KiB, exceeds 200 events, or when
  `session_memory` is called with `action: "compact"`.
- Group deterministically by `(taskId, kind, key)`.
- Merge evidence arrays by stable id and sort by evidence tier, confidence,
  source ref, then id.
- Retain active entries and latest supersession chains; drop resolved stale
  detail from `memory.json` only after recording a compaction artifact.
- Never cluster by summary meaning, embedding distance, or learned similarity.

## 3. MCP Surface

Expose one tool, not three:

```ts
tool: "session_memory"

input: {
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
```

Return shape:

```ts
{
  mode: "session_memory";
  action: "read" | "remember" | "summary" | "compact";
  sessionId: string;
  taskId?: string;
  revision: number;
  memory: {
    entries: SessionMemoryEntryFact[];
    viewed: SessionMemoryEntryFact[];
    claims: SessionMemoryEntryFact[];
    ruledOut: SessionMemoryEntryFact[];
    openQuestions: SessionMemoryEntryFact[];
    nextReads: SessionMemoryEntryFact[];
    decisions: SessionMemoryEntryFact[];
    verification: SessionMemoryEntryFact[];
    staleEntries: SessionMemoryEntryFact[];
    markdown?: string;
  };
  writes?: {
    sessionId: string;
    taskId?: string;
    revision: number;
    recordedEntryIds: string[];
    compacted: boolean;
    path: string;
  };
  warnings: string[];
}
```

Auto-recorded entries:

- `find_context`, `impact`, `task_brief`, `context_pack`, `focus_brief`, and
  `session_context` record bounded `viewed` entries for the files, symbols,
  workflows, tests, and next reads returned to the agent.
- `change_plan` with `saveSnapshot: true` records `decision`, `next_read`, and
  `verification` entries tied to the task snapshot.
- `post_edit_review` records compact `verification`, `risk`, and `decision`
  entries from verdict, drift reasons, missed tests, and verification ledger.
- `test_plan` records preview-only `verification` entries for recommended
  commands. Planned coverage is represented as `would_cover`; only
  `post_edit_review` or explicit reported commands turn verification into
  executed proof.

Auto-recording must be bounded. Prefer one tool-call entry with compact refs to
one entry per returned file. Compaction can aggregate by ref, task, and kind.

Explicit `remember` is required for:

- Agent conclusions after reading source.
- Ruled-out hypotheses.
- User-specific constraints forwarded by the agent.
- Open questions and next actions the agent wants carried forward.
- Manual verification results not already passed through `post_edit_review`.

Error modes:

- Invalid input uses the normal MCP/Zod error path.
- Lock timeout fails the write without partial state.
- Corrupt memory returns a warning and attempts replay from `events.ndjson`.
- Stale index does not delete entries; read results mark affected entries stale.

## 4. Integration

Task snapshots:

- Add an optional `sessionMemory` pointer to `TaskSnapshot`.
- `changePlanQuery` reads the current session memory before snapshot save and
  stores `{ sessionId, revision, entryIds, summaryHash }`.
- `saveTaskSnapshot` remains authoritative for plan-time baseline data.

Post-edit outcomes:

- Add the same optional session-memory pointer to `PostEditOutcome`.
- Persisted outcomes may auto-record a `viewed` entry referencing the outcome.
- `post_edit_review` should include relevant `claim`, `ruled_out`,
  `open_question`, and `decision` entries for the active task.

Session context:

- `session_context` and `focus_brief` include a small summary block from
  `session_memory({ action: "summary" })`.
- `task_brief` includes memory filtered by task, files, symbols, and open
  questions.

Freshness:

- Every entry stores `snapshotId`, `indexedAt`, and `headCommit`.
- On read, compare the current `FreshnessInfo` with entry freshness.
- If commit or dirty-file changes overlap an entry's scope, display it as stale
  and include `staleBecause`; do not discard it automatically.

Cache behavior:

- Session memory reads should not require embeddings, LSP, or a source mutation.
- Auto-record writes happen after the query result is produced; failures should
  warn but not make read-only context tools unusable.

## 5. Agent-Side Protocol

Generated `codex-contract.md` should add:

```md
Session memory protocol:

1. At session start or focus change, call `session_memory` with
   `action: "summary"` unless `session_context` already included a fresh memory
   preview.
2. Before re-asking for the same task facts, call `session_memory` with
   `action: "read"` and task/file/symbol filters.
3. After forming a non-trivial claim, decision, ruled-out path, open question,
   or durable task constraint, call `session_memory` with `action: "remember"`.
4. Before editing concrete files, still call `change_plan` with
   `saveSnapshot: true`; session memory does not replace snapshots.
5. After editing, call `post_edit_review`; Codexa auto-records the compact
   outcome summary.
6. Before final response, call `test_plan` or account for why no targeted tests
   apply.

Codexa auto-records bounded `viewed` entries for context it returns. Do not log
views manually.
```

Agent writes should be short, scoped, and evidenced:

```ts
session_memory({
  action: "remember",
  taskId: "session-memory-design-doc",
  entries: [{
    kind: "decision",
    summary: "Use one session_memory tool with actions instead of three MCP tools.",
    provenance: "agent-asserted",
    confidence: "heuristic",
    evidenceTier: "derived",
    scope: {
      files: ["src/mcp.ts", "src/codex-contract.ts"],
      topics: ["mcp surface", "maintainer scope"]
    }
  }]
})
```

## 6. Anti-Scope

This feature does not:

- Add a graph DB, vector DB, embeddings, learned similarity, or semantic recall.
- Add an LSP daemon, web UI, formal solver, planner, or source-mutating MCP
  tool.
- Parse hidden reasoning or infer claims from arbitrary agent prose.
- Store raw chat transcripts or long source snippets.
- Share memory across repositories by default.
- Automatically promote agent assertions into the codebase fact graph.
- Replace `change_plan` snapshots or `post_edit_review` outcomes.
- Evict stale entries automatically just because the index changed.

## 7. File-Level Change List

New files:

```text
src/cache-lock.ts
src/session-memory.ts
src/query/session-memory.ts
tests/session-memory.test.ts
docs/architecture/session-memory.md
```

Modified files:

```text
src/types.ts
src/indexer.ts
src/queries.ts
src/mcp.ts
src/query/context.ts
src/query/post-edit.ts
src/task-snapshots.ts
src/post-edit-outcomes.ts
src/codex-contract.ts
src/artifacts.ts
tests/mcp.test.ts
tests/init.test.ts
```

Implementation notes by file:

- `src/types.ts`: add session-memory types, extend `FactSource` and `FactType`,
  and keep `Confidence` unchanged.
- `src/cache-lock.ts`: extract the indexer's directory-lock implementation and
  reuse it for index and session-memory locks.
- `src/indexer.ts`: replace private index lock helpers with `acquireCacheLock`
  without changing lock paths or timeout behavior.
- `src/session-memory.ts`: implement load, record, replay, compaction,
  stale-marking, atomic writes, and redaction.
- `src/query/session-memory.ts`: implement the MCP query wrapper returning
  `QueryResult`.
- `src/queries.ts`: export `sessionMemoryQuery`.
- `src/mcp.ts`: register `session_memory` and add bounded auto-recording to
  existing tool handlers.
- `src/query/context.ts`: include summary/read memory previews in
  `focusBriefQuery`, `session_context`, and `taskBriefQuery`.
- `src/query/post-edit.ts`: include relevant session memory in change-plan and
  post-edit-review data; record compact outcome memory.
- `src/task-snapshots.ts`: validate and preserve optional `sessionMemory`
  pointers.
- `src/post-edit-outcomes.ts`: preserve optional `sessionMemory` pointers and
  record outcome references.
- `src/codex-contract.ts`: add the session-memory protocol.
- `src/artifacts.ts`: list `session_memory` in generated dynamic query docs.
- `tests/mcp.test.ts`: cover tool registration plus a remember/read/summary
  flow over stdio.
- `tests/session-memory.test.ts`: cover storage replay, stale marking,
  compaction, lock timeout, and corruption recovery.
- `tests/init.test.ts`: cover regenerated `codex-contract.md` protocol text.
