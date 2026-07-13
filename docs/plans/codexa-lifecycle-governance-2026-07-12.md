# Codexa lifecycle-governance implementation plan

Status: implementation in progress
Base: `f79bbe36c5ca6ec4a08427d5b6ab4eb0bc4c5e46`
Branch: `codex/backend/codexa-20260712-codexa-lifecycle-governance`

## 1. Objective

Make Codexa fail closed when it cannot prove that its evidence belongs to the
selected Git worktree and checkout, and make its edit lifecycle preserve enough
structured state to stop repeated, scope-expanding repair loops.

This work addresses five connected failures:

1. an evidence query can currently return an index from the wrong root or HEAD
   when auto-refresh is disabled or routing falls back;
2. `change_plan` and `post_edit_review` detect one review's drift but do not
   govern repeated attempts across a long task;
3. declared task invariants are not first-class snapshot data and therefore
   cannot be required at review or proof time;
4. external live/integration results cannot be bound to a task and worktree
   state or credited in the proof ledger;
5. session compaction and task/session lookup can lose or misroute the exact
   decisions, rejected hypotheses, run evidence, and stop conditions needed to
   resume safely.

## 2. Operating contract

### 2.1 Invariants

- Every evidence-bearing query uses an index built from the exact selected Git
  worktree and current checkout HEAD.
- Auto-refresh may repair an identity mismatch once, but Codexa must revalidate
  before returning evidence.
- Diagnostic freshness/status surfaces remain available when evidence queries
  are blocked.
- A task replan keeps the same task lineage, increments its plan revision, and
  retains previously declared invariants.
- Repeated unchanged review calls do not count as new attempts.
- Loop enforcement uses structured state and exact failure fingerprints, never
  prose similarity or LLM judgment.
- A semantic invariant is never declared satisfied automatically. A reported
  satisfaction remains reported evidence; a violation forces replanning.
- External artifacts never execute code, fetch URLs, read attachments, or
  receive test/command credit merely because an overall run passed.
- Session-memory compaction publishes an archive containing dropped evidence
  before it rewrites active state.
- No production behavior is specific to Dramaturg, screenplays, CopyMovie,
  model names, fixture names, pages, characters, or benchmark literals.

### 2.2 Trust boundaries

- Git root, HEAD, and dirty hashes are live process inputs and can race an index
  build.
- `.codex/codebase` and `.codex/cache` files can be stale, copied, malformed, or
  tampered with.
- Workspace focus files and environment variables can route a long-lived MCP
  server to the wrong checkout.
- External verification manifests are untrusted local files until bounded,
  schema-validated, hashed, and state-bound.
- Agent-supplied invariant reviews and summaries are assertions, not executed
  proof.
- Concurrent MCP, hook, and CLI calls can write cache state simultaneously.

### 2.3 Non-goals

- No general policy DSL or rule engine.
- No LLM-based failure clustering or benchmark-overfitting detector.
- No global LOC/file ceiling that rejects a legitimate large initial task.
- No arbitrary JSON/JSONL inference and no project-specific artifact parser.
- No second memory subsystem, database, network service, or raw transcript log.
- No GitHub PR review/merge automation in this change.
- No claim that Codexa can judge whether two natural-language propositions are
  semantically equivalent.

## 3. Delivery slices

Each slice must leave the branch type-correct and focused tests green. Later
slices may extend optional schema fields, but legacy artifacts remain readable.

### Slice A: checkout and index identity

#### Mechanism

Add one central identity validator shared by query loading and query-session
construction. It validates:

- selected root equals `index.snapshot.repoRoot`;
- selected root equals `index.freshness.repoRoot`;
- snapshot and freshness snapshot IDs agree;
- snapshot and freshness HEADs agree;
- snapshot and freshness Git roots agree;
- live freshness does not report root drift, HEAD drift, or degraded Git state.

`requireIndex` will:

1. load the stored index;
2. validate its internal identity before trusting it;
3. force one rebuild in the selected root when identity is invalid and
   auto-refresh is enabled;
4. retain the existing refresh path for dirty-file or external-report drift;
5. recompute freshness and rerun identity validation after rebuilding;
6. throw a typed, actionable error if identity is still unproven.

With auto-refresh disabled, evidence queries reject root, HEAD, internal
metadata, or degraded-Git identity mismatches. Ordinary dirty-overlay or
external-report staleness remains visible as stale context. `freshness` and
`status` continue to diagnose all mismatch reasons.

Explicit workspace routing that names a focus file/session but matches no row
will error instead of silently serving the configured root. Unscoped MCP
launches retain their current configured-root behavior.

Generated context resources use the same validated-root path as tools;
`freshness.json` remains diagnostic-only.

#### Proof

- copied index between linked worktrees is rejected without refresh;
- auto-refresh rebuilds in the selected worktree and succeeds;
- snapshot-only and freshness-only root/HEAD corruption are rejected;
- a commit after indexing is rejected with `--no-auto-refresh` and repaired by
  default querying;
- a race that leaves the rebuilt index stale returns no packet;
- explicit missing workspace focus errors, while unscoped late focus still
  works;
- generated context resources never return mismatched artifacts.

#### Rollback

Remove the validator calls and typed error. No source or user data migration is
required.

### Slice B: task lineage, explicit invariants, and earlier tests

#### Snapshot extensions

Add optional, version-1-compatible fields:

```ts
interface TaskInvariant {
  id: string;          // stable hash of the normalized statement
  statement: string;   // bounded exact contract
}

interface TaskSnapshot {
  planRevision?: number;        // legacy default: 1
  invariants?: TaskInvariant[]; // legacy default: []
}
```

`change_plan` accepts at most 12 invariant statements of at most 280 characters
each. It allocates the final task ID before computing the session-memory
pointer. Reusing a task ID creates revision `N + 1`, inherits existing
invariants, and may add but not silently remove constraints.

The structured replan action retains the task ID. `change_plan` presents
`test_plan` before editing when targeted tests exist, while
`post_edit_review` remains the mandatory post-edit step. The documented loop
becomes:

```text
session_context -> search(if unclear) -> task_brief ->
change_plan(saveSnapshot) -> test_plan -> edit ->
post_edit_review -> proof_card
```

#### Invariant accounting

`post_edit_review` accepts bounded reviews:

```ts
interface TaskInvariantReview {
  invariantId: string;
  status: "satisfied" | "violated";
  evidence: string[];
}
```

- Missing review for a declared invariant produces blocking inspection.
- Reported violation forces `replan_required`.
- Reported satisfaction remains trust tier `reported` and does not become
  command, test, or artifact proof.
- Plans, reviews, proof cards, and session resumes display the exact invariant.

#### Proof

- same-task replan increments revision and preserves invariants;
- legacy snapshots load as revision 1 with no invariants;
- generated task IDs match session-memory pointers;
- missing, satisfied, violated, unknown, and duplicate invariant reviews are
  handled deterministically;
- structured replan actions retain task lineage;
- pre-edit `test_plan` suggestions include affected test consumers and do not
  replace final full-suite verification.

### Slice C: artifact-backed loop budget and decision history

#### Existing artifact to extend

Keep immutable post-edit outcome files as the audit record, and add a strictly
validated per-task lifecycle state as the authoritative bounded attempt/stop
ledger. MCP `post_edit_review` persists both under one task-scoped lock; tool
metadata discloses the outcome and session-cache writes.

Add a pure task-lifecycle reducer over the current task snapshot plus bounded
outcome history. Do not put enforcement in the advisory complexity checker.

#### Diff footprint

Each distinct attempt records:

```ts
interface DiffFootprintV1 {
  schemaVersion: 1;
  trackedInsertions: number | null;
  trackedDeletions: number | null;
  changedFileCount: number;
  modifiedSymbolCount: number;
  untrackedFileCount: number;
  fingerprint: string;
  degradedReasons: string[];
}
```

Tracked counts come from bounded `git diff --numstat HEAD -- .`; untracked
source contributes bounded line counts and content hashes to the footprint.
If Git state is degraded, the growth rule is disabled but the attempt-count
rule remains. Large initial diffs do not fail merely because they are large.

#### Failure signals

Derive only exact structured classes and exact affected targets:

- `plan-drift`;
- `context-unreliable`;
- `verification-missing`;
- `verification-failed`;
- `required-check-missing`;
- `risk-escalation`;
- `invariant-unreviewed`;
- `invariant-violated`;
- `external-check-failed`.

The fingerprint hashes class plus sorted stable targets. It never clusters
arbitrary error prose.

#### Budget

- Three distinct unresolved attempts under one plan revision force replanning.
- Five distinct patch/artifact attempts under one plan revision force
  replanning even when intermediate reviews were locally complete.
- The same failure fingerprint on two consecutive distinct attempts forces
  replanning earlier when the diff grew: more tracked lines, new files, or more
  modified symbols.
- Repeating the same review on unchanged tree/evidence does not increment the
  count.
- New bound run evidence may create a distinct attempt even when code is
  unchanged.
- A complete outcome resets the unresolved streak only while no stop is
  latched; same-revision reviews cannot clear a latched stop.
- A newer plan revision resets attempts-since-plan while retaining total task
  history.

No user-configurable numeric policy is added in v1. The reducer reports attempt
count, cumulative/peak growth, recurring fingerprints, and exact stop reasons.

`loopReview.status === "replan-required"` forces the existing `replan` verdict
and `replan_required` completion authority. Proof cards report a blocking gap.
Managed edit hooks block when the latest acknowledged task-loop outcome
requires replan and no newer plan revision exists. Lifecycle routing, read, or
validation failures fail closed; unrelated advisory hook failures retain their
existing behavior.

#### Proof

- duplicate unchanged review does not increment attempts;
- three distinct unresolved attempts force replan;
- same failure/different targets does not falsely recur;
- repeated same-target failure plus diff growth forces early replan;
- large initial diff alone remains within budget;
- successful completion and newer plan revision reset the correct counters;
- managed hook gate clears only after a newer plan revision;
- proof cannot claim completion while a loop stop is active.

### Slice D: generic external verification artifacts

#### Producer contract

Codexa accepts one strict, project-neutral JSON manifest:

```ts
interface VerificationSummaryManifestV1 {
  schemaVersion: 1;
  kind: "codexa-verification-summary";
  binding: {
    taskId: string;
    headCommit: string | null;
    workspaceStateDigest: string;
  };
  run: {
    id: string;
    category: string;
    outcome: "passed" | "failed" | "cancelled" | "timed_out" | "unknown";
    startedAt?: string;
    finishedAt?: string;
    durationMs?: number;
  };
  checks: Array<{
    kind: "workflow" | "dependency";
    target: string;
    outcome: "passed" | "failed" | "skipped" | "unknown";
    summary?: string;
  }>;
  attachments?: Array<{
    name: string;
    sha256?: string;
    sizeBytes?: number;
    mediaType?: string;
  }>;
  producer?: { name: string; version?: string };
}
```

`workspaceStateDigest` is SHA-256 over canonical JSON containing HEAD plus
sorted dirty-file hashes. It is stable across unchanged reindexing, unlike the
current time-derived index snapshot ID.

#### Ingestion boundary

Raw filesystem ingestion is CLI-only. It:

- accepts one explicit path at a time;
- opens with no-follow semantics and requires a regular file;
- caps input at 256 KiB;
- rejects unknown keys and overlong arrays/strings/numbers;
- strips controls and redacts secret-shaped content;
- performs no network, shell, glob, directory, attachment, or URL operation;
- stores only the normalized manifest, input SHA-256, ingestion time, and
  diagnostics under `.codex/cache/codexa-verification-artifacts/<id>.json`;
- never stores the raw source path;
- derives filenames from canonical normalized content;
- publishes atomically and is idempotent;
- revalidates the artifact ID on load to detect cache tampering.

MCP `post_edit_review` and `proof_card` accept artifact IDs only, never paths.

#### Binding and credit

- task ID, HEAD, and workspace-state digest must all match;
- only an individually passed exact workflow/dependency target can receive
  bounded coverage credit; imported unauthenticated manifests remain
  `reported` evidence, while `artifact-corroborated` is reserved for a future
  authenticated or witnessed producer;
- overall run pass never covers omitted checks;
- artifacts never cover tests or reported/executed command evidence;
- failed, stale, malformed, unbound, conflicting, or unknown artifacts create
  proof gaps and no credit;
- conflicting selected evidence for one target fails closed;
- attachments are descriptive hashes only and are never opened;
- wording says "artifact reports passed," never "Codexa witnessed the run."

Proof exposes artifacts beside reported command evidence, not inside it, while
using the shared ledger evaluator for exact workflow/dependency coverage.

#### Proof

- valid passed and failed manifests;
- oversized, symlink, FIFO, directory, unknown-key, control-character, and
  secret-shaped inputs;
- idempotent/concurrent ingestion and tamper detection;
- clean/dirty state binding and stability across unchanged reindex;
- wrong task/HEAD/state rejection;
- exact check credit, omitted-check no-credit, failed/unknown no-credit;
- artifacts never cover tests or commands;
- conflicting selected artifacts fail closed.

### Slice E: decision continuity and compaction repair

#### Compaction correctness

Before filtering resolved/rejected entries, session memory writes an atomic
archive containing:

- source and destination revisions;
- source event count;
- digest of pre-compaction active state;
- retained entry IDs;
- the full bounded records being dropped.

Only after durable archive publication may active `memory.json` and
`events.ndjson` be rewritten. Archive failure leaves active state untouched.
Active decisions, ruled-out hypotheses, constraints, run verification, risks,
and stop conditions remain active until explicitly resolved/superseded.

#### Exact task/session binding

- The final task ID is allocated before a memory pointer is stored.
- Context, post-edit review, and proof use
  `snapshot.sessionMemory.sessionId`, not whichever session is latest.
- Legacy fallback is allowed only when the latest memory pointer's task ID
  matches exactly; otherwise Codexa returns an `unbound session memory` gap.
- Baseline entry IDs/hash are checked. Later revisions are expected; missing or
  mutated baseline entries are reported.

#### Decision-log capsule

Proof and resume packets return a bounded task-lifecycle capsule containing:

- current plan revision and invariants;
- latest three distinct attempts and current stop condition;
- active decisions and ruled-out hypotheses;
- constraints and open questions;
- selected external run evidence;
- baseline/current memory revision and integrity warnings.

Session-memory keys include plan revision or attempt ID so repeated attempts do
not overwrite one another. Artifact ingestion creates bounded verification refs;
no raw run transcript is copied.

#### Proof

- dropped entries exist in the archive before event rewrite;
- failed archive write does not alter active store/events;
- decisions/invariants/runs/stops survive repeated compactions;
- concurrent sessions with the same task text never cross-contaminate;
- corrupt stores replay valid bounded event history;
- proof identifies missing/mutated baseline memory;
- compact MCP output retains the stop condition and artifact IDs.

## 4. Anticipated source surface

The plan intentionally reuses current modules. Expected changes are bounded to:

- index identity and routing: `src/query/runtime.ts`, `src/query/session.ts`,
  `src/mcp-repo-root.ts`, `src/mcp/runtime.ts`, `src/mcp/resources.ts`,
  `src/mcp.ts`, plus one small identity module;
- lifecycle: `src/types/inputs.ts`, `src/types/snapshots.ts`,
  `src/task-snapshots.ts`, `src/query/change-plan.ts`,
  `src/query/post-edit.ts`, `src/query/post-edit/decision.ts`,
  `src/query/post-edit/next-actions.ts`, `src/post-edit-outcomes.ts`, plus one
  pure reducer module;
- artifact/proof: `src/types/verification.ts`, `src/prove.ts`,
  `src/query/verification.ts`, `src/mcp/tools.ts`, CLI registration, plus one
  bounded artifact module;
- continuity: existing `src/session-memory/*` storage/derivation and task-bound
  query calls;
- documentation and focused tests in the existing suites.

New modules are accepted only for the shared identity validator, pure lifecycle
reducer, and secure artifact boundary. Each has multiple production callers or
a distinct trust boundary; no one-use helper hierarchy will be introduced.

## 5. Verification strategy

### Per-slice

- `npm run typecheck`
- the focused test files covering the modified production path
- source inspection of every caller for changed public interfaces

### Integrated

- `npm test`
- `npm run check`
- package/privacy/public-snapshot gates required by the repository
- Codexa `post_edit_review`, `test_plan`, and `proof_card` against this exact
  worktree and task ID
- adversarial review of checkout races, cache tampering, task cross-talk,
  duplicate attempts, trust-tier inflation, and project-specific literals

### Acceptance criteria

- No evidence packet escapes with mismatched worktree/root/HEAD identity.
- The active task's declared invariants appear in plan, review, proof, and
  resume surfaces.
- A repeated unresolved loop reaches `replan_required` deterministically and
  cannot be cleared without a newer plan revision.
- A valid state-bound external manifest can corroborate only exact workflow or
  dependency checks.
- Session-memory compaction retains an auditable archive of dropped entries.
- Full existing behavior remains green for projects that never declare
  invariants or ingest artifacts.
- Production code contains no screenplay- or benchmark-specific branch,
  identifier, field, parser, or prompt.

## 6. Release and rollback

This is cache-only governance; it does not mutate project source outside normal
Codexa index/cache writes. New snapshot/outcome fields remain optional under
schema version 1. Legacy snapshots behave as revision 1 with no invariants;
legacy outcomes do not activate the new mandatory loop gate.

Intentional compatibility changes:

- stale HEAD/root evidence queries with `--no-auto-refresh` now fail;
- explicitly requested workspace routing with no matching focus now fails;
- MCP post-edit review now persists a sanitized outcome cache artifact;
- managed hooks may block a new edit after an acknowledged task-loop stop until
  a newer plan revision exists.

Rollback is forward-safe: revert the feature commit and optionally delete the
new cache directories/outcomes. Source repos, Git history, and legacy Codexa
artifacts remain intact.
