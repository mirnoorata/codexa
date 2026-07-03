# Codexa AAA Roadmap — Hardening + Next-Highest-ROI Features

Status: revision 5 (post adversarial rounds 1–4)
Date: 2026-07-03
Baseline: v0.7.2 (`main` @ cd0a4a5)
Branch: `claude/general/codexa-20260703-103149-focus-orientation`

## How this plan was built

Six parallel deep-read audits of the full v0.7.2 source (indexer/parser/
retrieval, query layer, MCP server + token discipline, CLI/init/integrations,
verification/autoverify/eval/policies, docs/philosophy/history) plus five
primary-source research streams (GitNexus feature inventory; code-context MCP
landscape; git-history intelligence tooling; edit-governance tooling;
token-economics techniques including RTK and Ponytail). Findings cite
file:line against the v0.7.2 tree; every load-bearing behavioral claim was
independently re-verified against source by an adversarial fact-check pass.
The plan was then hardened through the review rounds recorded at the end of
this document: round 1 (five reviewers — source fact-check, solo-maintainer
feasibility, philosophy/invariants, product/ROI, cross-model Codex; 40+
findings), round 2 (fix-verification, fresh-eyes, second Codex pass),
round 3 (seven-reviewer workflow: fix application, new-claim citations,
three-lens H12 attack, consistency and final-verdict sweeps), and round 4
(three-reviewer convergence gate; findings 49 → 4 → 0 open). All findings
incorporated or explicitly rebutted in the round log.

## Hard invariants (gates on every item below)

From the product's own written contracts (README, architecture drift
controls, maintainer expectations) and the owner's standing constraints:

- Zero API keys, zero charges, zero network calls in core paths.
- Deterministic: same inputs → same outputs. Where a feature is explicitly
  session-stateful (T1.4 delta mode), the session-state key is a declared
  input: determinism is per-(inputs + declared state key), the key is echoed
  in the response, and golden-byte tests carry session-state fixtures.
  Timestamps/durations stay out of *packet body content*; freshness
  provenance (`freshness.indexedAt`, already shipped in every envelope,
  `src/mcp/envelope.ts:88`) and verification report provenance
  (`startedAt`/`durationMs` in AutoVerify reports) are exempt — those
  fields are provenance, not noise. Golden-byte tests normalize the
  exempted fields.
- Read-only toward source: no MCP tool mutates source files or executes
  commands. Execution features are CLI/hook-lane only, gated on user-owned
  autonomy config (never repo config).
- No graph DB, no vector DB, no web UI, no generated wiki, no always-on
  daemon detached from the `serve` process lifetime.
- Fail closed on ambiguity; advisory by default; blocking only via explicit
  per-task opt-in (an explicit change-plan snapshot) — repo-committed files
  may tighten only within that already-opted-in lane, never create blocking
  on their own.
- Every public claim must be reproducible by a shipped, runnable gate.
  External research numbers are labeled "external benchmark, not
  Codexa-measured" until Codexa's own gates reproduce them.
- Solo maintainer: a merged feature is a lifetime maintenance commitment.
  Operationalized: max ~2 features + fixes per release (demonstrated
  cadence: 11 releases in the three weeks 2026-06-10→2026-07-01, each
  carrying 1–2 features — so the v0.12.0 horizon is plausibly 4–8 weeks
  out, not quarters); at most one new public verb *and* at most one new
  host target per release, where "public verb" counts CLI verbs and MCP
  tools alike; host-transcript-dependent features ship behind an
  `experimental` label with a documented removal right; new input surfaces
  (config regexes, XML artifacts) get an explicit security note before
  merge.
- Behavior-change discipline: any ranking or verdict behavior change ships
  with a release-note entry stating before/after; experimental features
  carry a documented removal right. "Experimental" is mechanical, not
  prose: a tag in the tool/command description, a doctor warning when the
  feature is in use, and a CHANGELOG note reserving removal.

## Competitive position (verified 2026-07-03, primary sources)

- **The edit-lifecycle governance moat is still uncontested.** Across ~30
  tools checked (Serena, GitNexus, ChunkHound, claude-context, Octocode,
  kit, repomix, ast-grep, lsmcp, CodeRabbit, Greptile, qlty, Trunk, Semgrep,
  Spec Kit, msr-mcp, repowise, CodeScene…), nobody ships deterministic
  pre-edit plan snapshots + rename-aware drift review + a masked-command
  verification ledger. Spec Kit (~118k stars) owns the plan-then-verify
  *vocabulary* but is prompts-only, zero enforcement.
- **Retrieval is commoditized.** Semble-class local embeddings, LSP servers
  (Serena 26k stars), and skeleton tools are abundant. Codexa keeps
  retrieval "good enough to feed governance" and keeps publishing the
  fail-closed eval; it does not compete on retrieval breadth.
- **GitNexus (43.5k stars) is inspiration, not scope.** Its distinctive
  lanes — PDG/taint, ad-hoc Cypher, 16-language graph, cross-repo groups,
  WASM UI — violate Codexa's invariants or maintainer budget (see Part 3).
  Notably GitNexus has **no git-history analytics and no governance** — both
  lanes stay open, and its PolyForm Noncommercial license leaves an
  MIT-shaped hole Codexa already occupies.
- **Deterministic git-history intelligence over MCP is unowned.** CodeScene
  is subscription-gated (including its MCP server); code-maat/hercules are
  unmaintained GPL CLIs with no agent surface; msr-mcp is JVM-bound with
  zero adoption; repowise is AGPL. Every proven signal (hotspots, co-change
  coupling, ownership, bus factor) is computable from one
  `git log --numstat` pass plus keyword complexity counting. License note:
  reimplement from published algorithms (Tornhill's analyses, Avelino
  ICPC'16 DOA formula); do not port GPL/AGPL code.
- **Token economics is the demand wave — with platform-erosion risk.**
  External benchmarks (not Codexa-measured): tool results ≈60–75% of agent
  tokens, ~40–60% of that removable without task loss; input:output ≈100:1;
  KV-cache alignment is the top production cost lever. RTK proves the
  product shape (filter + measure + discover). Codexa owns the best
  filtering substrate but emits its per-call metrics without persisting
  them and ships no analytics. Risk priced in: hosts are absorbing parts of
  this layer (context editing, tool-result clearing), so harvest the lane
  early rather than savor it.

### Adoption vs retention (growth model)

The tracks are labeled A (adoption: brings new users) or R (retention:
deepens value for existing users). Codexa's realistic growth surfaces, in
order: (1) proof-card comments on public PRs — impressions on people who
never installed anything; (2) `codexa discover` — a personal "you burned N
tokens last week" hook; (3) screenshotable git-signals output; (4) the
Cursor/registry conversion funnel. The prior draft ranked only integrity;
this revision sequences A-items at a fixed cadence — v0.9.2, v0.10.x,
v0.12.0 — instead of systematically last; the v0.8.x train is deliberately
all-R trust repair (adoption surfaces built on unrepaired trust would
amplify the wrong first impression).

## Part 0 — What is already AAA (do not touch, protect)

- The cache lock (PID-recycle defense, mtime hard reclaim, self-fencing
  heartbeat) — `src/cache-lock.ts`.
- Atomic artifact publish + reader-side recovery — `src/indexer/artifact-writing.ts:15-37`.
- The shell command-credit analyzer and its laundering defenses —
  `src/query/verification/*` (single-resolver discipline, substitution
  sentinels, dead-branch skipping, speculative-fallback downgrades).
- AutoVerify's double-entry trust chain (in-process Symbol marker +
  recomputed digest + dirty-hash-after freshness binding) — `src/autoverify/*`.
- Fail-closed workspace routing (17 integration-tested scenarios in
  `tests/mcp-01`) — `src/mcp-repo-root.ts`.
- Hash-aware dirty-baseline separation — `src/query/post-edit/dirty-scope.ts:22-24`.
- Prompt-injection-aware hooks (allowlist parsing, enum-token block reasons) —
  `integrations/claude-code/scripts/*`.
- The five-tier MCP budget-compaction ladder with truncation records —
  `src/mcp/compaction.ts:170-303`.

## Part 1 — P0 Hardening ("make the existing features AAA")

Trust repairs, split across small releases at demonstrated cadence.
Ordering constraint (hard): **H1a lands before H3's eval re-pin** — deleting
eval-vocabulary intent words (`src/retrieval.ts:234`) and the decoy fix move
retrieval behavior, so an eval archived before H1a is stale on arrival.

### H1a. Delete workspace-specific priors; fix decoy over-blocking (S)

The public package ships the author's private-workspace priors:
Private-workspace risk rules that fire on generic words (`failed|running|queue`)
on any repo with a `src/` dir (`src/rules.ts:78-116`, consumed per-file via
`src/parser/risks.ts:28-45`), hardcoded UI filenames (`src/graph.ts:697-698`),
Codexa's own src layout hardcoded as "architecture core"
(`src/retrieval.ts:535,767`), fixture-tuned workflow scores
(`src/query/workflow.ts:239-254`), recipe path assumptions
(`src/query/impact.ts:405-443`), and eval-vocabulary intent words
(`src/retrieval.ts:234`). **Delete to generic defaults** — do not build a
config system for them (CONTRIBUTING.md:68 rejects config-toggle features;
Safety Boundaries already mandate "no project-specific private rules in the
public setup path").
Decoy fix: `isDecoyLikePath` detection is compact-substring
(`src/retrieval.ts:977-980`) while the query escape hatch is word-boundary
(`queryAllowsDecoy`, `src/retrieval.ts:982-984`, applied at `:136,155,179`)
— the asymmetry means a query containing "mockingbird" never unlocks
`mockingbird.ts`, so `mockingbird.ts` / `fixtures_loader.py` /
`backup-service.ts` are hidden from any realistic query; the search lane
zeroes them below exact-match strength (`src/query/search.ts:385-414`).
Require path *segments* for detection, not substrings.
Ship with a release note: ranking changes for existing users (files Codexa
used to hide will appear); note the before/after on the eval.

### H1b. Minimal per-repo rules lane (M — separate item, co-designed with T3)

If (and only if) generic defaults prove insufficient, add a minimal
`.codex/rules.json` read at index time — schema shared with the T3 policy
pack work so one config story ships, not two. Constraints: bounded regex
execution (ReDoS-safe: pattern length/complexity caps, no backreferences),
fail-closed on malformed files (warning + ignore, never crash), documented
CONTRIBUTING exception rationale. Deletion is preferred; this lane exists
for repos that need their own invariant hints, not to re-house the deleted
priors.

### H2. Close the MCP envelope budget bypass (S)

`compactMcpResult` compacts only `result.data`; the envelope's `freshness`
field ships raw with unbounded `dirtyFiles`/`dirtyFileHashes`
(`src/mcp/envelope.ts:89-92,204`), so a large dirty tree blows the
"budgeted" response while `mcp.returnedBytes` under-reports. Fix
**additively** (the envelope schema is pinned `schemaVersion: z.literal(1)`
with unaudited hook consumers): add a bounded `dirtySummary` (counts +
digest) and cap the legacy arrays above a threshold; enforce the byte target
on the whole envelope; add the missing whole-envelope regression test. Cap
raw artifact resource reads (`src/mcp/resources.ts:130-137`).

### H3. Refresh and pin the public proof (S; after H1a)

Corrected premise (both archives verified on disk): the two
archives (v0.2.0, v0.3.0; 20 scenarios each) record per-scenario
`selectedToBaselineRatio` with the same mean (0.6624 ≈ 0.66x), so the
figure is derivable from either — but the metric is selected-file count ÷
baseline output *lines* (`src/eval/scoring.ts:34-35`), not bytes, and no
suite-level aggregate is recorded. README.md:56 and :725 mislabel it as
"packet size vs. raw baseline output" in both places. The newest archive is
v0.3.0 while the shipped version is 0.7.2, and the current suite is 21
scenarios (3 project + 12 synthetic + 6 historical; a 4th project scenario
is silently gated on a repo file that doesn't exist, `src/eval.ts:238-254`).
Rerun the eval on the current tree post-H1a, archive
`reports/benchmarks/v0.7.2-eval.json`, fix the README metric description
and scenario count as part of the re-pin, and add a release-lane step that
archives the eval per release. Circularity guard: H1a's heuristic purge may
legitimately move eval results — any scenario modified or re-tuned during
the re-pin must be itemized in the release note, so the purge cannot be
quietly re-tuned back to green (recreating the overfit it removes). And
the re-pinned number ships regardless of direction: a worse honest ratio
replaces the README figure in the same release — holding a release to
protect a number is prohibited. Tighten CI schema-size bounds (`tests/mcp-05-suite.test.ts:50,64`
currently <70KB/<30KB vs claimed 54KB/21KB) so README numbers are CI-pinned.

### H4. Doctor: audit reality, not itself (S)

The `mcp-tool-parity` check compares the registry to itself
(`src/doctor.ts:242-256`, surface built at ~292-320 from the same module)
— structurally unfailable. Replace with checks that inspect actual wiring:
plugin + `.mcp.json` double registration (different server names `codexa`
vs `codexa-<slug>`; doctor never reads repo-root `.mcp.json` today,
`src/doctor.ts:406-419`), version skew between wired configs and the
installed CLI, stale managed-doc blocks, and the hardcoded
`codexa/plugin v0.1.0` SessionStart banner
(`integrations/claude-code/scripts/session-start.sh:55,140` — sync via
release-please extra-files). Data for `doctor --hooks` (success rate,
p50/p95 from the existing `events.ndjson`) is already recorded; the rollup
report can trail in a follow-up patch.

### H5+H6. Drift-loop precision (one coupled unit, M)

**H5 — committed-work reconciliation.** `headChanged` on an explicit
snapshot is a hard `replan` even when the agent committed its own planned
work (`src/query/post-edit/decision.ts:103-108`). Fail-closed fix: on head
change, diff `snapshot.headCommit..HEAD`; downgrade to advisory **only if**
committed paths ⊆ planned scope **and** committed blob hashes match the
snapshot's recorded `dirtyFileHashes` (machinery exists in
`src/query/post-edit/dirty-scope.ts`). History rewrite (old head
unreachable, merge-base ≠ snapshot head) → keep `replan`. Path-subset alone
cannot distinguish the agent's commit from a concurrent worker's.
**H6 — rename-aware baselines.** Symbol/risk baseline diffs are path-keyed
(`src/query/post-edit.ts:658-676,725-741`; rename awareness stops at git
status `oldPath`, post-edit.ts:120-129), so a planned rename yields false
symbol-drift at both paths — and defeats H5's path-subset check when the
rename was committed. Map old→new before diffing; pair delete+untracked-add
by content hash. H6 is a hard precondition for T3's fanout limits.

### H7. Verification scope-credit hole (S)

With no recommended tests, a repo-scope test run counts as credible evidence
for *any* changed target (`src/query/post-edit.ts:945-947`;
`scopeCoversReviewPath(".", …)` is always true). Require package containment
of the changed path, mirroring `coverageCoversTest`'s stricter rule. Note:
this makes the product *stricter* — pair with the H5 downgrade in release
notes so the net verdict change is balanced.

### H8. Determinism hardening (S code + S CI)

**182 `localeCompare` lines (219 call sites) across 49 files** make
ordering ICU/locale-sensitive — a real hazard for a
product selling byte-stable determinism. Swap for a code-point comparator,
add an ESLint `no-restricted-syntax` ban, and scope golden tests to one
artifact set built under a spawned `LANG=tr_TR.UTF-8` process (no full CI
locale matrix needed). Also: cap dotted-string/endpoint reference extraction
per file (`src/parser/references.ts` — no count cap today; one string-table
file can mint thousands of facts and skew BM25; ~20 lines), and emit a
ParserError instead of silently skipping Python files past the 16 MiB
semantic budget (`src/indexer/parsing.ts:85-88`).

### H9. Small trust fixes (S each, ride-alongs)

- Env repo candidates (`CODEXA_REPO`) get the same realpath containment as
  focus-file candidates (`src/mcp-repo-root.ts:94-99` vs 70-72).
- `dependency_path`: distinguish "no path" from "depth exceeded"
  (`src/query/graph-traversal.ts:112`); add truncation counts to edge lists.
- Wire or remove the hardcoded `discardedAnchorCount: 0` in retrieval
  intentConfidence (`src/retrieval.ts:696`, propagated via
  `src/query/context.ts:206,477`) — **keep** the live focus-lane computation
  (`src/query/context/focus.ts:544,582-627`) that quality scoring consumes
  (`src/query/quality.ts:48`).
- Typed error taxonomy for MCP (replace `safeQuery` string-prefix matching,
  `src/mcp/envelope.ts:488-495`).
- Split the 61.7KB single-`it()` masking test
  (`tests/indexer-07-accounts-for-rancommands-through-package.test.ts`) into
  granular cases.

### H10. Secret redaction of served context (S; ships with H2 — same envelope layer)

Codexa redacts *command evidence* (`src/mcp/compaction-helpers.ts:179-225`)
but not *served file snippets* (evidence snippets, search excerpts,
spill artifacts). repomix (Secretlint pre-pack) and Octocode (300+ patterns
on all output) treat this as table stakes. Add deterministic pattern
redaction at the envelope layer for snippet-bearing packets, fail-closed,
with a `redactions: N` count in the packet. Pattern source: a bundled,
versioned, deterministic pattern set (gitleaks-class rules, vendored — no
network). Fail-closed means: on redaction-engine error the snippet section
is withheld with a `redaction-error` reason, never served unredacted.
Prerequisite for T1.3 spill artifacts.

### H11. Supply-chain hardening (S–M)

npm provenance publishing already ships (`.github/workflows/npm-publish.yml`
uses `--provenance` with tag-ancestry and prerelease gates — genuinely above
OSS norms). Close the rest of the enterprise supply-chain checklist for a
trust product: SHA-pin GitHub Actions (currently tag-pinned), add CodeQL +
dependency-review + OpenSSF Scorecard workflows, migrate npm publish from
`NPM_TOKEN` to OIDC trusted publishing (noted as pending in README), emit an
SBOM artifact per release, and document the 2FA/publish-token posture in
SECURITY.md. All CI-side; no runtime surface.

### H12. Session-pinned routing — multi-worker isolation (M, stdio scope)

**Problem (recurring in production use):** with N concurrent agent sessions
working in one workspace — or on the same project — MCP routing re-derives
the active repo **per call** from shared mutable state (the WORKING.md
focus file; `src/mcp/runtime.ts:26-45` re-resolves on every tool invocation
and invalidates its cache on focus change). Another session updating the
shared file can silently re-route this session's Codexa to *its* worktree —
governance packets, snapshots, and search results then describe a different
worker's branch. Fail-closed ambiguity checks exist
(`src/mcp-repo-root.ts:296-303`) but only the caller-supplied
selected-session lane compares session ids; the workspace-default and
active-session lanes carry no ownership check, so a caller without
`CODEXA_WORKSPACE_SESSION` resolves to another live session's claimed
worktree. Observed workaround: abandoning MCP for the explicit CLI — the
flagship integration losing to its own fallback.

**First principles:** routing identity is *session* state, not *workspace*
state. Bind once, **verify every call**, move only explicitly. (The
multi-tenant lease-and-fencing pattern — including the part naive designs
skip: lease *expiry* — implemented as one JSON pin file, no new
infrastructure.)

**Design constraint discovered in review (round 3):** there is no ambient
host-session identity available to a spawned stdio MCP server — both
launchers pass plain `process.env`
(`plugins/codexa/scripts/codexa-mcp.js`,
`integrations/claude-code/scripts/codexa-mcp.js`), session ids exist only
in *hook* stdin payloads, and the workspace focus helper exports
`CODEXA_WORKSPACE_SESSION` into a shell **after** the server has already
attached. The design below therefore uses explicit binding, not env
inheritance.

1. **Pin at attach; verify every call.** At stdio server start, resolve
   the repo once and write a pin file under the *workspace root's*
   `.codex/cache/codexa-routing/<attach-nonce>.json` — the key is a
   server-generated nonce (never derived from ambient state, so two
   identical sessions can never collide); fields:
   `{repo, routingSource, boundSession?, headCommit}` (`headCommit` is
   attach-time provenance for display only — never a pin-validity input).
   The server re-reads *its own pin file* on every call (this is what
   makes cross-process repin work). The *shared focus file* is re-read per
   call **only to verify** the pin: if the pinned repo is now claimed by a
   different session's live row, the claim backing the pin vanished, or
   the pinned path is no longer the same git root (worktree deleted), the
   call fails closed naming the pin's provenance and the exact repin
   command. Verification is never silent re-routing — the pin moves only
   via an explicit action. Pins are process-lifetime: a respawned server
   mints a fresh nonce and a fresh provisional pin (never adopts another
   pin file). Pin files get the T1.3 treatment: TTL/GC keyed to session
   end, `.gitignore` coverage verified at init, doctor stale-pin cleanup.
2. **Identity by explicit bind — agent-mediated, server-executed.** A
   sibling process cannot address a specific server's nonce-keyed pin, so
   the **primary bind action is in-band**: when a tool call carries the
   optional `workspaceSession` argument, the server validates it against
   that session's live row and binds *its own* pin — no cross-process
   addressing at all. The `codexa repin` CLI verb
   (`--workspace-session <id> --nonce <n> [--repo <path>]`) exists for
   scripted flows and is nonce-addressed: packets and `session_context`
   display the server's nonce, so only the agent talking to that server
   can target it. The focus helper does **not** execute repin (it cannot
   know which server serves the caller); it *emits* the exact bind
   instruction for the agent's next call. A pin created before any bind
   is **provisional** and binds once; a bound pin rebinds only for the
   same bound session or via its nonce — so a mis-bind is recoverable,
   never frozen. This keeps the flagship mid-session
   `focus on <project>` flow working: the server attaches identity-less
   at host startup, the focus action emits the bind, the agent's next
   call carries it.
3. **Ownership fail-closed, scoped to actual conflict.** Fail-closed
   triggers when two or more *live* rows point at different repos and none
   is bound to this session, or when this session's bound identity
   mismatches the claimant of the resolved target. An identity-less
   session with exactly one unambiguous live row **adopts it at attach**
   with loud pin provenance — preserving the README-documented
   single-worker workspace contract, which the standard workspace-focus
   flow (always one live row) depends on. The workspace default remains a
   routing source unless its target is claimed by a *different* live
   session. Liveness has a horizon **and a renewal path**: the stdio
   server refreshes a session-keyed lease sidecar (throttled — at most
   once per few minutes of tool activity) so long-running live sessions
   never expire; a row whose lease/`last_seen` age exceeds the window
   (default 24h, a named constant so the lease tests can pin it) is not
   live for ownership purposes — but expiry weakens a row only for
   *other* sessions' adoption decisions; a pin's own backing claim is
   invalidated by row deletion or reassignment, never by age. Expired
   rows still are never auto-selected; doctor lists stale rows with
   cleanup commands.
   Unattributed focus/default lines pointing into the workspace's worktree
   area are never auto-selected; the focus helper adds session attribution
   to the lines it writes. When live rows exist and none is adoptable,
   **tool calls** fail closed with the live-row list and the exact bind
   command — attach itself never hard-fails (the plugin must not die at
   host startup), and configured-root fall-through is disallowed when the
   configured root is a workspace hosting claimed worktrees (serving the
   workspace meta-repo is a wrong-repo result, not a safe default).
4. **Loud provenance + doctor.** Packets carry the pin (repo, nonce, bound
   session, provisional/bound state); the routing pin is a **declared
   session-state key** under the determinism invariant, with fixture
   coverage in the golden suite. If the shared focus file changed since
   attach, packets add: "focus changed; pin unchanged; run `codexa
   repin`". Doctor gains a routing-isolation check: live sessions, pins,
   conflicts, stale rows and stale pins. The cwd-vs-pin mismatch check is
   scoped to a cwd inside a *candidate worktree repo* different from the
   pinned repo — the configured workspace root is excluded (a workspace
   root that is itself a git repo must not trip it).
5. **Scope + contract change.** Stdio transport only: the stateless HTTP
   transport keeps per-request resolution (session pinning there waits on
   MCP session management, a separate slice). CLI and hook invocations
   remain per-invocation resolvers *by design* — ownership checks apply
   there when identity is present, and the MCP/CLI asymmetry is
   intentional and documented. This item **reverses a documented
   contract** (per-call re-resolution so "focus changes do not require an
   MCP process restart", `docs/architecture/codexa-context-server.md`):
   it ships with the Drift Controls amendment in the same PR, README
   workspace-routing updates, and a before/after release note per the
   behavior-change invariant. Superseding the session-memory implicit
   "latest" fallback is a sub-slice that ships with the first T1 consumer.

Behavior change stated plainly: today's per-call re-resolution is replaced
by pin-verify-repin — same session → same repo unless explicitly rebound,
and the identity-less single-row adoption keeps the common single-worker
flow zero-config. Tests: two-concurrent-session races (B rewrites the
workspace default between A's calls), server restart with an existing pin
file, repin from a separate CLI process observed by the running server's
next call, stale-row lease horizon, dangling-pin (deleted worktree)
failure. Effort M covers this scoped slice (stdio pin + ownership + bind
verb); HTTP session management and any future ambient-identity channel are
explicitly out of this slice.

## Part 2 — ROI-ranked feature tracks

Scoring: Impact (moat depth × sessions touched × credibility × **growth**)
÷ Effort, philosophy fit as a hard gate. Labels: [A]doption / [R]etention.
Rankings are reasoned estimates (evidence-classed per the Verification
plan), not measurements; where a numeric claim appears it carries its
evidence class inline.

### T1. Token Economics Lane — "RTK inside the MCP layer" [R; T1.5 is A] (Impact: very high; Effort: M total, S slices)

Codexa already computes and emits per-call byte metrics
(`data.mcp.originalBytes/returnedBytes`, `src/mcp/compaction.ts:109-117`)
but never persists or aggregates them. This track turns existing discipline
into a measurable system. **Metric honesty (brand-critical):** the ledger
measures **compaction ratio** — Codexa's structured-data bytes before vs
after compaction — and must say so; it is not "tokens saved vs raw grep."
Current metrics cover `result.data` only; full-result accounting (envelope +
mirrored text) ships with T1.1 before any README claim *based on the
per-call compaction metrics* (the A/B-script lane below is carved out). The only
README-citable *savings* number is an A/B reproduction script (same scripted
task, `responseMode both` vs `structured`, transcript-measured, rerunnable)
— the eval-gate pattern applied to tokens. Session identity: ledger and
delta state require an explicit session id (CLI flag / transport metadata);
implicit "latest" fallback (`src/session-memory/event-log.ts:26`) is
forbidden for these lanes (cross-client contamination). H12 provides this
plumbing — its session pin is the identity every session-scoped lane keys
on.

1. **`codexa gain` — savings ledger (S/M).** Persist per-call
   `{tool, mode, originalBytes, returnedBytes, fullResultBytes,
   compactionTier, sessionId}` to `.codex/cache/codexa-savings/` NDJSON;
   CLI report with per-tool rollups and compaction-tier histogram.
   Retention: size-capped rotation + TTL via the existing cache maintenance
   path (no unbounded growth). Byte numbers exact and labeled by scope;
   token numbers labeled estimates (estimator named). Transcript
   reconciliation is a separate, `experimental`-labeled lane: session-level
   only (per-tool billed attribution is not recoverable from host
   transcripts), version-fenced parsers that fail "unsupported format"
   rather than silently undercounting, pinned fixture transcript for the
   reproduction test.
2. **`responseMode: "structured" | "text" | "both"` (S).** The text block
   mirrors structuredContent on every call (~2× payload,
   `src/mcp/compaction.ts:73-76`). Default stays `both`; hooks/SDK
   consumers opt down. Biggest single per-call win (~40–50% on large
   tools — reasoned from the mirrored-payload structure, to be confirmed by
   the A/B script); ships early in v0.8.0. The A/B reproduction script rides this
   slice (it needs `responseMode both` vs `structured` to compare); the
   *measured-savings* README headline waits for T1.1's full-result
   accounting in v0.9.0 — v0.8.0 claims only the response-size cut the A/B
   script itself demonstrates.
3. **Spill-to-disk truncation handles (S/M; requires H10).** Truncation
   records today are dead ends (`{total, returned}`,
   `src/mcp/compaction-helpers.ts`). Write the full pre-compaction artifact
   to session cache; put path + byte count in the record; expose windowed
   retrieval through the existing `codexa://` resource surface (no new
   tool or verb). Controls before ship: H10 redaction applied to spilled
   content, TTL keyed to session end, max-bytes cap, `.gitignore` coverage
   verified at init, doctor check for stale spill dirs. RTK's "tee"
   insight: recoverability makes aggressive filtering safe.
4. **Delta/unchanged responses (M; stdio-transport only).** Explicit opt-in
   input parameter (`delta: {sessionId, basis}`) — part of the determinism
   key, echoed in the response. Key includes (snapshotId, headCommit,
   dirty-hash, input-hash, **config/rules/policy digest**) so H1b/T3 config
   edits invalidate. Full re-emission on cache miss or unprovable
   continuity; freshness lines are never suppressed when freshness state
   changed. Not offered on the stateless HTTP transport (fresh server per
   request, `src/mcp.ts:71-78`). Golden tests get session-state fixtures.
5. **`codexa discover` (M; experimental) [A].** Parse local host transcripts
   and report where raw `cat`/`rg`/`git diff`/test output burned N bytes
   that a Codexa call would have served for M. Acceptance criterion for M
   (falsifiability): M = measured bytes of the equivalent Codexa call
   actually replayed against the same repo state — never an estimate; where
   replay isn't possible (repo state moved on), report only the raw burn N
   with no counterfactual. Privacy gate (hard):
   per-invocation opt-in, path allowlist, aggregate-only output with zero
   prompt/command-text excerpts, nothing transcript-derived written under
   the repo. Same version-fenced parser rules as T1.1. Sequenced right
   after T1.1-T1.3 — it is the adoption engine and the reconciliation input.
6. **Cache-aligned serialization audit (S).** Golden-byte tests asserting
   byte-identical output for identical inputs (+ declared state); stable key
   order; no timestamps/durations in packet bodies (freshness and
   verification-report provenance exempt, normalized in goldens per the
   determinism invariant). KV-cache alignment is the top external cost
   lever (external benchmark, not Codexa-measured).

Supersession note: the 2026-06-21 complexity-lane plan's non-goal "no token
accounting service" is superseded by T1.1 *for byte-truth accounting only*
— the rationale (no unverifiable token claims) is preserved by the metric-
honesty rules above, and the ledger measures Codexa's own output, not
model behavior.

### T2. Verification Breadth + Trust Pack [R; T2.5 is A] (Impact: very high; Effort: M, per-slice S)

The credit engine covers one ecosystem lane (npm/vitest/jest/pytest/tsc —
verified: no *runner grammars* for cargo/go/gradle/make/turbo/nx/mocha/
playwright/bun/deno in `src/query/verification/`; bun/bunx appear only as
launcher recognition, `script-credit.ts:50,129`). Elsewhere the ledger
reports everything "missing," training users to waive. Evidence tiers,
stated once and used everywhere: **executed-by-AutoVerify** (in-process
trust) > **witnessed** (T2.3) > **artifact-corroborated** (T2.2) >
**reported** (honor lane). Packets name the tier.

0. **T2.0 — Trust-tier schema slice (S; precedes every other T2 item).**
   The tier ladder does not exist in the data model today:
   `VerificationCoverage` and `VerificationLedgerEntry` carry no tier field
   (`src/types/verification.ts`), and AutoVerify evidence is emitted as
   separate runner-review entries rather than tiered ledger rows. Add a
   first-class `trustTier` to coverage/ledger/proof-card outputs (versioned
   bump: coverage-v4 / ledger-v3, following the existing versioning
   discipline), migrate AutoVerify runner evidence into it, and require all
   new lanes (T2.1 packs, T2.2 artifacts, T2.3 witnessed) to populate it.
   Without this slice first, each new lane invents its own trust
   representation and the ladder becomes prose.

1. **Runner grammar packs.**
   *T2.1a — in-lane first (per-runner S; rides v0.9.x):* playwright, bun,
   deno, mocha, vitest `--project`, turbo/nx/lerna fan-out, `pnpm -r`.
   These fix waive-training for the *existing* JS/TS user base today.
   Cadence: one or two runner grammars per patch release across the 0.9.x
   line — never the whole list in one release.
   *T2.1b — out-of-lane (per-runner S; v0.10.0):* `cargo test`,
   `go test ./...`, `gradle test`/`mvn test`, `make <target>`
   (literal-body targets only — no recursive expansion/`include`/`$(shell)`
   in v1). Same cadence rule as T2.1a: one or two out-of-lane packs per
   0.10.x patch — never the whole list in one release. README annotation
   required: on Go/Rust/Java repos verification
   credit is real but indexing depth is shallow — governance-lite, stated
   plainly (no "market expansion" claim until depth exists).
   Ordering (hard): **T2.4's fuzz harness precedes the first new pack** —
   each grammar widens the laundering attack surface of the crown-jewel
   analyzer.
2. **Test-artifact crediting (M per format family).** Slice 1: junit-XML
   with named dialects (pytest xunit2, jest-junit, Surefire), DTD-disabled
   parser (XXE), size caps. Later slices: TAP 13/14, vitest/jest JSON.
   Corroborate exit-0 claims with pass/fail counts and per-file identities
   where the dialect provides them; bind artifact mtime+hash to the current
   dirty-tree hash (mirroring `src/query/post-edit/runner-review.ts:75`).
   Trust honesty: artifacts are forgeable (`touch`, fabricated XML) —
   credited as **artifact-corroborated**, explicitly below executed
   evidence, never described as "evidence-backed conversion of the honor
   lane."
3. **`codexa run -- <cmd>` execution-capture shim (M).** Codexa executes
   and *witnesses* the agent's chosen command: real exit code, duration,
   bounded redacted output. Consent + containment (all hard requirements):
   CLI/hook-lane only, never an MCP tool; gated on user-owned
   `full-access` autonomy (`src/autonomy.ts:37-61` — repo config can never
   enable it); inherits AutoVerify's env scrubbing, unsafe-executable and
   lifecycle-hook rejections, process-group kill, and output redaction —
   only the runner-grammar allowlist is relaxed; the witnessed command
   still goes through command-credit classification (`codexa run -- true`
   earns nothing). Trust label: **witnessed** tier with its own policy
   id/digest — *not* AutoVerify's chain (a cross-process report has no
   in-process marker; a deterministic digest is computable by anything that
   can read the source). Optional hardening: per-install HMAC key in XDG
   state raises forgery cost; still labeled witnessed.
4. **Differential fuzz harness (M, CI-side; precedes T2.1 packs).**
   Generate random command ASTs (runners × masks × wrappers × heredocs ×
   substitutions), execute under real `sh` with a stub runner recording
   exit propagation, assert the classifier never credits a masked failure.
   The same harness feeds malformed/adversarial inputs to T2.2's artifact
   parsers — XML/TAP/JSON parsers get the same fuzz bar as shell grammars.
5. **Eval verification-lane scenarios + named public benchmark (S+S) [A].**
   Add eval scenarios feeding adversarial `ranCommands` through post-edit
   review, asserting ledger outcomes (plumbing exists,
   `src/eval/scoring.ts:424-460`). Then publish the adversarial set as a
   named benchmark (masked failures, fabricated reports, scope drift;
   Codexa vs nothing vs prompts-only) — category vocabulary + citations,
   built from machinery T2.4/T2.5 already fund.
6. **Flaky-test trust tracking (M; follow-on).** Persist per-command/
   per-test pass-fail history in the ledger; flag nondeterministic
   verifiers and discount their credit with a named reason. A verification
   ledger that trusts flaky tests over-credits; no competitor can copy this
   without a ledger. (Trunk's core insight, done locally.)

### T3. Policy Packs v2 + Hold-the-Line [R] (Impact: high; Effort: M; preconditions: H6, T2.1a)

Sequencing note: T3 stays ahead of T4 despite T4's adoption surface because
T3's preconditions (H6, T2.1a) complete by v0.9.1 and T3 deepens the moat
lane.

Policy packs are inert today: parsed, displayed in `codexa prove`, never
enforced (sole consumer `src/prove.ts:132`; verified). Give them teeth
without breaking the blocking contract:

1. **Evaluable schema v2.** Whitelisted rule grammar only:
   `requiredCoverageKinds` per path glob, `maxUnplannedChangedFiles`,
   `maxDirtyFanout`, `requiredCommands` (matched via the existing envelope
   semantic key, `src/query/verification/command-envelope.ts:35-43`).
   Violations map into the **existing verdict lattice** as ledger `missing`
   entries and inspect reasons — they do not add a new verdict class, and
   they respect current precedence (head-change/fanout replan rules in
   `src/query/post-edit/decision.ts` evaluate first); decision tests
   required.
   Consent model: blocking requires the **conjunction** of an explicit plan
   snapshot (per-task opt-in, unchanged) AND a pack with an explicit
   `enforce: true` key. Pre-v2 packs stay display-only (migration: nothing
   changes for existing repos until someone opts in). Malformed or unknown
   evaluable keys → advisory warning + ledger note, never a block.
   Degradation: `requiredCoverageKinds` on ecosystems without a matching
   T2.1 runner pack degrade to advisory (else they recreate
   everything-missing → waive-training).
2. **Hold-the-line delta gate (M).** Compare analyzer findings at snapshot
   time vs review time; report **newly introduced** findings only, as
   advisory inspect reasons (blocking only under the same conjunction).
   Execution stays out of the MCP lane: analyzer runs happen in the
   CLI/hook lane or the user's own workflow, and results enter through the
   **existing static-analysis report ingest** (SARIF import already
   shipped) — `change_plan`/`post_edit_review` only diff the imported
   findings, read-only. Determinism: the analyzer name + version + ruleset
   digest joins the snapshot (`analyzerVersionDigest`); reviews where the
   digest changed between snapshot and review report "analyzer changed —
   delta not comparable" instead of fake regressions. v1 binds to SARIF
   only (one format, already parsed), not per-analyzer output formats.
   Converts post_edit_review from "did you drift from plan" to "did you
   make the code worse" (qlty/CodeScene-delta pattern, deterministically).

### T4. Git-Signals Lane [A+R] (Impact: high; Effort: M/L, decomposable)

Unowned competitive ground (CodeScene subscription-gated; rivals GPL/AGPL/
dead), fully inside the philosophy: one incremental pass over
`git log --numstat` cached under `.codex/cache/`, plus keyword-count
complexity (scc-style, no AST). Determinism rules: **commit-distance, not
wall-clock** (age = commits-since-touch relative to HEAD; "dormant
contributor" defined structurally as absent from the last N commits — N is
a documented constant default; per-repo override arrives only with the
T3/H1b schema, which gates overrides, not the feature); stated input caveat: shallow clones yield truncated history —
packets carry a `historyDepth` provenance field; mailmap respected when
present. Privacy gate (hard): author identities never leave the local
cache; `.codex/cache/` gitignore coverage verified at init; packets carry
aggregate signals only ("bus factor 1", "single-owner file") — and on repos
with ≤3 authors even aggregates name people implicitly, so ownership
packets are **off by default** there; `npm run privacy` gains an
identity-leak check for shipped artifacts. Eval-gated ranking: signals ship
as displayed evidence immediately; they flip default ranking only when the
eval shows wins (same contract as the gated PageRank experiment — and these
scenarios finally give that experiment something to differentiate). All T4
packet sections join the T1.6 golden-byte suite.

1. **Churn + hotspots (M).** Populate the always-empty
   `GitState.churnByPath` in query sessions (verified:
   `src/query/session.ts:133` hardcodes an empty Map; real churn exists
   only in indexing rank, `src/git.ts:75-93`); hotspot = churn ×
   complexity; feeds a `git_signals` section in `task_brief`/`impact` and
   a rank tie-breaker replacing the degenerate 1000/0 `impactSortScore`
   (`src/query/impact.ts:300-303`).
2. **Co-change coupling (M).** Same-commit pair counting with min-support
   plus sum-of-couplings centrality; surfaces in `impact` as "historically
   changes with" (tier `heuristic`, like every lead). Catches coupling the
   static graph cannot see (config↔code, cross-language).
3. **Ownership / bus factor (S/M; off by default on tiny repos).**
   Added-lines share + DOA main-dev (Avelino ICPC'16, reimplemented);
   "single-owner complex hotspot → raise verification tier" advisory.
4. **Staleness risk (S).** Commit-distance × complexity as a risk signal.
5. **Session-adaptive read-first personalization (S/M).** Bias the ranked
   map toward the dirty diff, active change-plan targets, and explicit
   session anchors (aider's personalized-PageRank insight, deterministic,
   state already in task snapshots). Same eval gate as above.

### T5. Distribution Pack [A] (Impact: high; Effort: S per slice; one host per release max)

1. **GitHub Action: proof-card PR comment (S/M; v0.9–0.10).** `codexa
   index` + `prove` on PRs; proof card as job summary + one top-level
   comment (noise-budgeted, issue-52 guardrails: read-only, observe→comment
   modes, prompt-injection posture). The only surface where non-users see
   Codexa; every public PR comment is an impression. Reuses the existing
   `prove` artifact.
2. **Cursor init target + walkthrough (S).** `codexa init --cursor`
   (generalizing `upsertClaudeMcpConfig`, `src/init.ts:316-348`) + a
   verified 10-line walkthrough. **Cursor only** until a concrete demand
   signal (issue/discussion) exists for the next host; each host ships with
   a documented Windows MCP-only degraded lane (config works, hooks don't —
   stated, not discovered via failed installs). Host-support tiers
   documented.
3. **Host auto-detection in init (S).** Probe `.claude/`, `.cursor/`,
   `AGENTS.md`; print the recommended flag set; apply with `--yes`.
4. **`codexa upgrade` + wired-repo registry (M).** XDG-state registry of
   init'd repos; one command re-renders managed blocks, re-pins npx
   versions, refreshes hooks; doctor warns on skew (pairs with H4).
5. **Generated API reference (M).** Emit per-tool docs from the tool
   registry (it already encodes inputs/cost/write-effects/nextTools);
   drift-free by construction; closes the biggest enterprise-doc gap.
6. **Time-to-wow + docs quick wins (S each).** `codexa demo` — scripted
   60-second drift-catch walkthrough on a well-known OSS repo; promote the
   honest comparison matrix into README; persist the 2026-06-17 and
   2026-07-03 research notes (with source URLs) into `docs/research/`;
   ship the three existing HTML demos;
   fill-or-delete the six `.gitkeep`-only dirs; changelog history note.

### T6. Scale floor [R] (Impact: medium; Effort: S–M)

Full incremental relink and index sharding stay deferred (architecture doc
defers them deliberately). Three bounded fixes:

1. **Merge hot-path maps (S).** Replace `mergeUsage`/`mergeImport`
   repo-wide `Array.find` scans with keyed maps
   (`src/semantic/typescript.ts:578,598`); batch `markExported`
   (`src/semantic/python.ts:784-787`). Mechanical O(n²) removal.
2. **Worker-thread parse pool (M; spike-gated).** Tree-sitter parsing is
   synchronous CPU on one core (`src/indexer/parsing.ts:41` — `mapLimit`
   helps I/O only). Native `tree-sitter@0.21.1` bindings may not be
   context-aware for `worker_threads`; a one-day spike gates the approach,
   with a child-process pool pre-authorized as fallback. Deterministic
   result ordering preserved (already sorted post-collection).
3. String-reference extraction caps and the Python-budget ParserError ride
   with H8 (same files).

## Part 3 — Explicitly deferred / rejected (with reasons)

- **PDG/taint, ad-hoc Cypher, 16-language graph depth, cross-repo groups,
  WASM UI, graph-aware rename actuator** (GitNexus-inspired): violate
  no-graph-DB / no-UI / read-only invariants or the maintainer budget.
- **Semantic retrieval expansion / bundled embeddings:** retrieval is
  commoditized; differentiation lives at the edit-lifecycle layer. The
  `local-command` escape hatch exists for users who want embeddings.
- **Deep native Rust/Go/Java tree-sitter lanes:** README declares deep
  native indexers out of scope; SCIP import is the endorsed lane.
  Reconsider only if T2.1b adoption shows heavy non-JS/Python governance
  demand (the runner packs will generate exactly that signal).
- **Warm LSP sidecar pool:** collides with the drift-controls line "no
  always-on LSP daemon orchestration"
  (`docs/architecture/codexa-context-server.md:701`). Deferred; shipping it
  would require an explicit Drift Controls amendment in the same PR (the
  doc's own correction rule) plus a pool lifetime strictly inside the
  `serve` process. Revisit on demand evidence only.
- **Windows-native hook rewrite (Node-based hooks):** real gap; meaningful
  effort (stop.sh fingerprint logic). Interim: every T5 host target
  documents the Windows MCP-only lane. Promote when T5 telemetry (issues,
  failed-install reports) shows Windows volume.
- **Remote authenticated HTTP MCP:** stays deferred-not-shipped-insecure.
- **Bash-hook adoption shim** (RTK's transparent interception): high blast
  radius (rewriting agent commands; RTK's own over-filtering incidents).
  Revisit after T2.2's artifact parsers exist and T1's ledger shows which
  raw commands dominate — the parsers, not MCP compaction, are the
  distiller substrate the shim would route to.
- **Failures-only distiller MCP tools:** presentation layer over T2.2's
  parsers; build the parsers first, revisit as a follow-on slice.
- **PreToolUse context enrichment** (GitNexus-style injection into
  Grep/Bash calls): promising (external report: 88% fewer tool calls —
  external benchmark, not Codexa-measured), but injecting content into
  agent tool calls cuts against Codexa's strict prompt-injection posture
  (hooks currently never forward repo prose). Needs an allowlist-shaped
  design of its own; revisit after the T5 GitHub Action ships.
- **Structural AST query lane (ast-grep-class):** real query-class gap, M
  effort, and ast-grep itself is MIT and composes alongside Codexa today.
  Revisit if T3 policy rules need structural predicates.
- **Merkle freshness proofs / cAST chunking:** honorable mentions;
  retrieval-side polish the strategy deprioritizes.
- **Ponytail integration:** shipped as the complexity review lane (v0.5.0);
  no runtime dependency wanted.

## Sequencing and release shape (≤2 features + fixes per release)

| Release | Contents | Headline [A/R] |
| --- | --- | --- |
| v0.8.0 | H1a (priors purge + decoy fix) → H3 (eval re-pin, ordered after); T1.2 responseMode | response-size cut + honest ranking [R] |
| v0.8.1 | H2 (envelope bound) + H10 (served-context redaction, same layer); H9 items ride as fixes, spilling to 0.8.x patches as needed | security floor [R] |
| v0.8.2 | H5+H6 (one unit) + H7 (rides as fix — release-note pairing with H5 per H7's text), H12 (session-pinned routing) | drift precision + multi-worker isolation [R] |
| v0.8.3 | H4 (doctor reality audit), H11 (supply-chain hardening) | wiring + supply chain [R] |
| v0.9.0 | T1.1 gain ledger, T1.3 spill handles (+T1.6 goldens) | `codexa gain` [R] |
| v0.9.1+ | T2.0 tier schema, T2.4 fuzz harness, then T2.1a packs (1–2 runners per patch); H8 rides as a fix | in-lane verification breadth [R] |
| v0.9.2 | T1.5 discover (experimental), T5.1 GitHub Action | adoption engines [A] |
| v0.10.0+ (train: 1–2 packs per patch) | T2.1b out-of-lane packs; T2.2 junit slice in its own patch | verification breadth [R] |
| v0.10.x (train: one feature per patch) | T5.2 Cursor target; T5.6 demo + docs wins; T2.5 named benchmark | funnel + benchmark [A] |
| v0.11.0 | T3 policy v2 + hold-the-line (one coupled track) | governance deepening [R] |
| v0.11.1 | T2.3 witnessed shim | witnessed evidence tier [R] |
| v0.12.0 | T4.1–4.2 git signals (T4.3–4.5 follow) | screenshotable signals [A] |
| Continuous | T6 slices when profiling justifies; T1.4 delta mode once H12's session-id plumbing ships; eval + ledger refresh every release (ledger from v0.9.0 on) | — |
| Backlog (unslotted) | T2.6 flaky tracking, T5.3 auto-detect, T5.4 upgrade, T5.5 API reference, H1b rules lane (conditional) | scheduled on demand signal |

## Verification plan for this document's claims

- Every load-bearing file:line citation was adversarially re-verified
  against `main` @ cd0a4a5 by an independent fact-check pass (round 1); the
  four corrections it found are incorporated above.
- Competitive claims trace to primary sources fetched 2026-07-03; license
  assertions read from LICENSE files or the GitHub API. These are planning
  assumptions verified outside the repo: the full research notes with
  source URLs are archived to `docs/research/` as part of T5.6, and until
  then no external number is copied into README or any shipped artifact.
- Feature-value claims carry evidence class: measured-external (labeled
  "external benchmark, not Codexa-measured"), demonstrated (competitor
  ships it), or reasoned (first-principles from the audits).
- This plan gates itself: any item that cannot state a runnable
  verification (test, eval scenario, golden-byte check, or ledger
  measurement) does not ship a public claim.

## Adversarial review rounds

### Round 1 (2026-07-03) — five reviewers, 40+ findings, all incorporated

Reviewers: source fact-check (all priority behavioral claims confirmed
against disk; 4 corrections), solo-maintainer feasibility, philosophy/
invariants, product/ROI, cross-model (Codex). Major findings and the fixes
applied above:

- **T2.3 trust overclaim (critical, 3 reviewers):** "same trust chain as
  AutoVerify" was false — no signing secret exists in a zero-key system;
  a cross-process report is forgeable. → Witnessed tier below AutoVerify,
  CLI-only, autonomy-gated, credit classification retained, "signed"
  dropped, optional XDG HMAC as hardening only.
- **T1.4 statelessness (critical, 3 reviewers):** delta responses assumed
  session state the HTTP transport doesn't have and contradicted the
  determinism invariant; session-memory's implicit "latest" fallback risks
  cross-client contamination. → Explicit opt-in param in the determinism
  key, explicit session id required, stdio-only, config digest in the
  cache key, moved out of the numbered releases until plumbing exists.
- **H1 mislabeled S / config anti-pattern (feasibility):** the rules lane
  required a nonexistent config subsystem and is CONTRIBUTING's own
  reject-pattern. → Split into H1a (deletion, S) and H1b (minimal lane, M,
  co-designed with T3, exception rationale required).
- **v0.8.0 overload (feasibility):** 6–10× demonstrated cadence. → Re-cut
  into v0.8.0–v0.8.3 at ≤2 features each; hard ordering H1a→H3 added.
- **H5 fail-open (philosophy):** path-subset can't distinguish the agent's
  commit from a concurrent worker's. → Blob-hash conjunction + history-
  rewrite replan branch; coupled with H6 as one unit.
- **T3 consent + precedence (philosophy, Codex):** repo-committed packs
  could escalate blocking; verdict lattice conflict. → Explicit-plan AND
  `enforce: true` conjunction; pre-v2 packs stay display-only; violations
  map into the existing lattice; malformed keys never block; H6 + runner-
  pack degradation preconditions.
- **T4 nondeterminism + privacy (philosophy):** wall-clock age and
  "ex-contributor" broke determinism; small-team ownership packets are
  identity claims. → Commit-distance metrics, structural dormancy,
  off-by-default on ≤3-author repos, privacy-scan check, golden coverage.
- **Transcript ingestion (philosophy, feasibility):** unstable private
  format + no privacy gate + marketing exposure. → Experimental label,
  version-fenced parsers failing closed, per-invocation opt-in,
  aggregate-only, session-level reconciliation only, fixture-pinned tests.
- **Measurement circularity (ROI, Codex):** originalBytes/returnedBytes is
  compaction-vs-self on `result.data` only, not user savings. → Renamed
  compaction ratio; full-result accounting added; A/B reproduction script
  is the only README-citable savings number; macro claims labeled external.
- **Growth blindness (ROI):** GitHub Action absent, no adoption/retention
  distinction, adoption items systematically sequenced last, v0.8.0 had no
  headline. → Growth term + A/R labels, T5.1 Action added, discover
  promoted, responseMode into v0.8.0, demo + named benchmark added.
- **Fact corrections (fact-check):** H3 premise rewritten (round-1 claim
  "v0.2.0 archive lacks baseline-size metric" was itself refuted in round
  2 — both archives record the ratio; see H3 for the standing premise);
  suite is 21 scenarios; H8 count 182 lines / 219 call sites;
  H9 discardedAnchorCount scoped to the dead copy; T1.1 "discards" →
  "emits but never persists"; citation drift fixed (doctor.ts:242-256,
  retrieval.ts:155,179, graph.ts:697-698).
- **Smaller:** T2.2 dialect variance + XXE note; Makefile literal-body
  scope; fuzz-before-packs ordering; T2.1a/T2.1b split with honest
  market-expansion framing; T6.2 spike gate; H2 additive schema + versioning; ledger/spill
  GC policy; "every release" ledger gate corrected to v0.9.0+; no-timestamp
  rule narrowed to exempt verification provenance; support-budget cap and
  experimental lane added to invariants; Bash-shim revisit condition
  re-pointed at T2.2 parsers; Windows MCP-only lane documented per host;
  supersession note for the token-accounting non-goal; warm LSP sidecar
  pool (formerly T6.3) moved to Part 3 deferred with the amendment
  requirement, and T6 renumbered.

### Round 2 (2026-07-03) — fix-verification + fresh-eyes + Codex

All round-1 fixes verified genuinely applied in body text (not just
claimed); the fix-verification pass refuted one round-1 "fact" (the v0.2.0
archive does record `selectedToBaselineRatio`; the real README defect is
the files-per-lines metric mislabeled as packet size — H3 rewritten).
Fresh-eyes found: T3.2 executing analyzers in the MCP path (rescoped to
CLI/hook lane + SARIF ingest with `analyzerVersionDigest`); the decoy
escape-hatch asymmetry (H1a justification corrected); missing supply-chain
track (H11 added); `freshness.indexedAt` vs the no-timestamp rule
(exemption widened); unfalsifiable T1.5 counterfactual (replay-measured
acceptance criterion added); six unslotted items (Backlog row added); plus
release-table invariant violations (headline, verb/host counts — fixed).
Codex round 2 added: T2.0 trust-tier schema slice must precede runner
packs (added); cadence overload in v0.8.1/v0.9.1 (recut); external claims
need archived source provenance (Verification-plan rule added). H12
(session-pinned routing) was added in this round from a live production
incident report.

### Round 3 (2026-07-03) — seven-reviewer workflow gate

verify:new-claims confirmed every revision-3 factual claim against source
with zero refutations. The three H12 lenses found the original H12 spec
unimplementable as written — no ambient host-session identity reaches a
spawned stdio MCP server, pin-at-attach froze pre-focus state, stale
WORKING.md rows would permanently fail-close routing, the cwd-vs-pin check
false-positived on workspace roots, and the HTTP transport has no attach
point. H12 was rewritten around explicit binding (`codexa repin` invoked
by the focus helper), per-call pin verification against the focus file
(verify-only, never silent re-route), a liveness lease horizon for rows,
single-live-row adoption for identity-less sessions, nonce-keyed pin
files with T1.3-style GC, stdio-only scope, and an explicit
documented-contract reversal (Drift Controls amendment + release note).
Consistency/final-verdict sweeps produced the remaining fixes applied in
revision 4: H7 release pairing honored (moved to v0.8.2), v0.11.0 split,
v0.10.x marked as a train, T1.3 retrieval bound to the existing resource
surface, T1-intro README-claim carve-out reconciled with T1.2, T1.6
freshness exemption, T4 dormancy constant, T5.6 research-archive scope,
H3 worse-number-ships rule, public-verb definition (CLI verbs and MCP
tools both count), cadence quantified, provenance/status trail corrected,
and draft-history narration moved out of normative text into this log.

### Round 4 (2026-07-03) — convergence gate (3 reviewers)

Findings dropped 49 → 4 (one high, three medium), all with prescribed
fixes, applied in this revision: the H12 bind path was re-designed
agent-mediated/server-executed (a sibling process cannot address a
nonce-keyed pin; the `workspaceSession` tool argument is now the primary
bind action, `codexa repin` is nonce-addressed, the focus helper emits
rather than executes the bind, and bound pins rebind only for the same
session or via nonce); the lease horizon gained its renewal half
(throttled session-keyed lease sidecar; expiry affects only other
sessions' adoption; default window named); the T2.1b out-of-lane packs
got the same 1–2-per-patch cadence rule as T2.1a with the v0.10.0 row
marked as a train; and the round-1 log's stale "T6.3 moved to deferred"
clause was replaced with the explicit old-number equation.
