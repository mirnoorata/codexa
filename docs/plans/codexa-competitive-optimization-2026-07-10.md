# Codexa Competitive Optimization Plan

Status: implemented and locally verified
Date: 2026-07-10
Baseline: `main` at `f2a1bbd` (`@mirnoorata/codexa` 0.8.0)
Task snapshot: `codexa-competitive-optimization-20260710`

## Decision

Ship one trust feature and one internal scaling optimization:

1. Make verification trust provenance first-class across coverage, ledgers,
   command plans, proof cards, compact MCP results, and persisted outcomes.
2. Replace the known quadratic TypeScript and Python semantic-assist merge
   paths with indexed lookups while preserving emitted facts byte-for-byte
   apart from normal freshness timestamps.

This is the highest-ROI release shape because it deepens Codexa's strongest
competitive advantage, removes a concrete scale handicap, adds no public MCP
tool or CLI verb, and stays within the repository's two-slice release limit.
It executes the existing AAA roadmap's T2.0 trust-tier slice and a
profiling-justified T6 scaling slice without pulling later runner, host, or
distribution tracks into this release.

## Product Contract

Codexa is a local, deterministic, query-only context compiler and proof layer
for coding agents. Its core job is to help an agent answer four questions:

- Did I read the right code?
- What could this change affect?
- Did the edit stay inside the saved plan?
- What evidence actually supports the final claim?

The implementation must preserve these hard invariants:

- No model, API key, charge, or network call in a core path.
- No MCP source mutation or command execution.
- Freshness, evidence class, and uncertainty remain visible.
- Ambiguous or stale evidence fails closed; advisory behavior remains the
  default unless a user explicitly saved a blocking plan.
- Output remains bounded, deterministic for the same declared inputs, and
  usable by any MCP host.
- No graph database, vector database, web UI, generated wiki, or detached
  always-on daemon.
- A feature must retire a real failure mode and have production-path proof.

## Current Codebase Map

The repository is a TypeScript CLI and MCP server with seven connected
subsystems:

1. Index pipeline: discovery, parsing, optional semantic assists, graph/rank
   construction, freshness, and atomic artifact publication under
   `.codex/codebase/`.
2. Retrieval: exact, symbol, BM25, optional semantic, graph, workflow, test,
   and dirty-tree lanes fused into bounded evidence-backed packets.
3. Edit lifecycle: `change_plan` saves file/symbol/risk baselines;
   `post_edit_review` compares the real worktree and verification state.
4. Verification: shell-aware command classification, package-script
   expansion, scope accounting, waivers, ledgers, and AutoVerify runner proof.
5. MCP delivery: 21 registered tools, core/full profiles, compact schemas,
   bounded results, loopback-only HTTP, resources, and routing guards.
6. Host wiring: Codex config/hooks, Claude Code plugin and hooks, worktree
   isolation, doctor checks, policy packs, and session memory.
7. Quality gates: 420 tests, a 21-scenario fail-closed retrieval eval,
   package install smoke, source/privacy/release guards, and hot-path
   benchmarks.

Baseline proof on 2026-07-10:

- `npm run check`: 42 test files and 420 tests passed.
- `npm run eval:ci`: 21 scenarios passed; raw `rg` better in 0 scenarios.
- `npm run benchmark:ci`: cold index 5,163 ms; MCP task brief p95 39 ms;
  all thresholds passed on Node 22.22.2/Linux x64.

## Competitive Comparison

This comparison uses current project-owned repositories or documentation,
checked on 2026-07-10. Repository popularity is a snapshot, not a quality
score.

| Repository | Stronger than Codexa at | Weaker or different from Codexa |
| --- | --- | --- |
| [Serena](https://github.com/oraios/serena) | LSP-backed navigation and diagnostics across 40+ languages; symbol editing, rename/refactor, memory, and extensive configuration; 26,273 stars | It is an agent IDE and mutation toolkit. Its public contract does not describe Codexa's deterministic plan snapshot, rename-aware drift review, or shell-masking verification ledger. |
| [Codanna](https://github.com/bartolli/codanna) | Broad native language support, bundled semantic/document search, watch mode, multiple installers, and claimed sub-10 ms lookup performance; 707 stars | It optimizes rapid code exploration. It does not document an equivalent edit-governance and proof lifecycle. Bundled embeddings also widen the default runtime beyond Codexa's model-free core. |
| [codebase-context](https://github.com/PatrickSys/codebase-context) | Team-pattern detection, trend-aware golden examples, edit preflight cards, durable team memory, 10 deep language lanes, and broad host setup; 52 stars | Its focus is convention retrieval and memory. Agent-authored memory and embedding-backed defaults have a different trust model from Codexa's source-derived facts and cache-only session memory. |
| [code-review-graph](https://github.com/tirth8205/code-review-graph) | Broad parser surface, sub-two-second incremental update claim, risk-scored PR comments, cross-repo daemon, visualization, wiki generation, and GitHub Action distribution; 19,370 stars | It carries a much larger graph/review platform surface, including mutation-capable refactoring. Its public proof is oriented around review context and risk, not plan drift plus command-credit honesty. |
| [CodeGraphContext](https://github.com/CodeGraphContext/CodeGraphContext) | 23-language parsing, multiple graph databases, live watching, complexity/dead-code analysis, setup wizard, and interactive visualization; 3,901 stars | Its database/UI/runtime breadth directly conflicts with Codexa's dependency-light static-artifact philosophy. |
| [Aider](https://github.com/Aider-AI/aider) | Mature autonomous editing, repo maps across 100+ languages, git commits, test/lint execution, and adoption; 47,230 stars | Aider is an agent, not a companion proof layer. Reproducing its editing surface would erase Codexa's product boundary instead of improving it. |

## Where Codexa Is Better

### 1. Edit-lifecycle governance

None of the reviewed project contracts documents the same complete sequence:
deterministic pre-edit snapshot, planned-scope tracking, rename-aware dirty
review, verification accounting, and a final proof card. Codexa protects the
host agent's workflow rather than replacing the host agent.

### 2. Verification honesty

Codexa parses a bounded POSIX-shell subset before a reported command earns
credit. Masked failures, non-running flags, ambiguous wrappers, outside-repo
scope, and incomplete command reports are downgraded instead of accepted at
face value. AutoVerify adds a separate in-process trust chain bound to policy,
snapshot, dirty hashes, source-mutation checks, and canonical report digests.

### 3. Evidence and freshness discipline

Facts carry authoritative/derived/heuristic/fallback classes. Stale indexes,
degraded git state, pruned files, and retrieval gaps are surfaced. The eval
fails when raw search is better, which gives Codexa a stronger anti-marketing
contract than an unqualified context-reduction claim.

### 4. Narrow and composable core

The core is local and model-free, emits static artifacts, supports stdio and
loopback HTTP, and never edits source through MCP. That makes Codexa a
complement to Codex, Claude Code, Serena, Aider, or a future host rather than a
competing editor shell.

## Where Codexa Is Behind

### Functional gaps

- Deep language intelligence is limited to TypeScript/JavaScript and Python;
  Rust, Go, Java, and other languages are intentionally shallow unless SCIP
  evidence is imported.
- There is no symbol mutation, rename engine, debugger, visualization, wiki,
  cross-repo daemon, or built-in PR review bot.
- Optional semantic retrieval requires explicit provider setup; competitors
  offer bundled embeddings or LSP-first semantics.
- Team conventions, trend-aware golden files, and durable shared decisions are
  less developed than codebase-context.
- Host setup is strongest for Codex and Claude Code; Cursor and broad
  auto-detection remain roadmap work.

### Trust and scale gaps to fix now

- AutoVerify evidence is reviewed separately, but coverage and ledger rows do
  not state whether their support is executed or merely reported. A consumer
  can therefore display two materially different evidence sources as peers.
- `src/semantic/typescript.ts` scans every accumulated usage/import fact for
  each semantic merge. `src/semantic/python.ts` maps every symbol and rebuilds
  all symbol indexes each time `__all__` marks one export. These are avoidable
  quadratic paths on the exact cold-index surface where competitors advertise
  broader and faster indexing.

## ROI-Ranked Improvement Areas

### P0: ship in this PR

1. Verification trust tiers: very high moat depth, every proof workflow
   benefits, moderate implementation risk.
2. Semantic merge indexes: high scale ROI, no public contract expansion, low
   behavioral risk with deterministic fact comparison.

### P1: next releases

1. Add a differential shell-classifier fuzz harness before any new runner
   grammar, then ship one or two runner packs per release. Start with
   Playwright and monorepo fan-out; follow with Cargo/Go while clearly labeling
   shallow indexing depth.
2. Publish a local-first GitHub Action that writes one sticky proof-card PR
   comment. Keep source on the runner and make blocking explicit opt-in.
3. Add Cursor wiring and host auto-detection without adding host-specific logic
   to core query paths.
4. Add aggregate git signals: churn/hotspots first, then co-change. Keep author
   identities local and gate ranking changes through the eval.
5. Measure full MCP result bytes before making savings claims; preserve exact
   scope labels and reproduction scripts.

### P2: useful but not urgent

- Generate tool/API reference docs from the registry.
- Add a deterministic quick demo and current comparison table to onboarding.
- Add bounded convention/golden-example evidence only after a generic schema
  proves it can avoid framework-specific heuristics and untrusted memory.

## Explicit Rejects

- Do not add source mutation, symbolic editing, or autonomous commits. Codex,
  Claude Code, Serena, and Aider already own execution.
- Do not add a graph/vector database, bundled embedding model, web UI, wiki,
  or detached daemon to match broader competitors.
- Do not pursue deep native parsers for every language. Keep SCIP and LSP as
  optional evidence lanes and let runner-pack demand prove expansion value.
- Do not ingest agent-authored shared memory into the authoritative fact graph.
- Do not expose remote HTTP until authentication, origin policy, and source
  disclosure risks have a separately reviewed design.
- Do not add a new MCP tool or CLI verb for this release.

## Implementation Slice A: Verification Trust Tiers

### Invariant

Evidence provenance must never imply more trust than the path that produced it.
An agent-reported command remains reported even when it says exit 0; only a
fresh report accepted by the AutoVerify trust chain is executed evidence.

### Failure mode

Coverage, command-plan, ledger, proof-card, compact MCP, and persisted outcome
rows currently omit this distinction. Downstream hosts can present honor-lane
claims as equivalent to Codexa-executed proof.

### Trust boundary

Public `ranCommands` and `ranCommandReports` are untrusted agent input.
`postEditReviewWithTrustedRunnerReports` is the only internal entry that may
upgrade a command to `executed-by-autoverify`, after the existing runner review
accepts policy, digest, snapshot, dirty state, path containment, and no source
mutation.

### Smallest mechanism

- Add `VerificationTrustTier` with this ordered vocabulary:
  `executed-by-autoverify`, `witnessed`, `artifact-corroborated`, `reported`,
  and `none`.
- Add `trustTier` to verification coverage, command-plan, and ledger rows.
- Keep public reports at `reported`; pass accepted AutoVerify reports through a
  separate internal argument that public MCP/CLI input cannot set.
- Aggregate the strongest tier when coverage rows are deduplicated or grouped.
- Use `none` for hypothetical test-plan coverage/command plans and for missing,
  waived, not-applicable, and `would_cover` ledger rows.
- Keep the command classifier at `command-coverage-v3` because its grammar is
  unchanged. Add `verification-coverage-v4` as a distinct provenance field and
  bump ledger provenance to `verification-ledger-v3`.
- Treat legacy persisted rows with no tier as `none` when they must be rendered;
  never guess that old evidence was executed.
- Preserve the field through sanitization, compaction, persistence, and proof
  rendering; include a concise ladder in the proof card.

### Proof

- Manual/spoofed reports remain `reported` and cannot create executed credit.
- Accepted AutoVerify reports produce `executed-by-autoverify` coverage and
  ledger rows.
- Rejected runner reports produce no executed coverage.
- Test-plan previews use `none`; proof-card text and structured data agree.
- Compact MCP and persisted outcome rows retain the tier.
- Existing masked-failure, scope, waiver, and AutoVerify tests remain green.

### Rollback

The change is additive except for provenance version strings. Revert the field
and version bump together; no index or source migration is required.

## Implementation Slice B: Semantic Hot-Path Scaling

### Invariant

Semantic assist must emit the same symbols, usage sites, imports, confidence,
targets, and deterministic ordering as before.

### Failure mode

Each TypeScript semantic usage/import merge scans global arrays, and each
Python export mark maps the full symbol array and rebuilds every symbol index.
Large files or many re-exports can turn a linear semantic pass quadratic.

### Trust boundary

Parsed source and compiler/LSP-derived facts may contain many repeated or
malformed constructs. Lookup indexes must not merge facts with different path,
name, kind, range, import mode, or type-only/re-export semantics.

### Smallest mechanism

- Build TypeScript merge indexes once from the cloned input facts.
- Key usage buckets by path/name/kind and retain the existing four-byte range
  tolerance inside that bounded bucket.
- Key imports by the exact fields used by the current equality predicate.
- Update indexes whenever a new fact is appended.
- Mark Python exports by mutating the cloned symbol already stored in
  `symbolsById`; all symbol maps point to that same object, so rebuilding maps
  is unnecessary.

### Proof

- A synthetic high-fanout TypeScript fixture preserves all distinct imports,
  resolves target symbols, and produces the same deterministic fact keys on a
  second index.
- A Python package `__all__` fixture still marks local and re-exported symbols
  exported without losing map lookups.
- Full tests, retrieval eval, package smoke, and hot-path benchmark pass.

### Rollback

Revert the lookup indexes to array scans and restore Python map rebuilding. No
stored schema changes are involved.

## Execution Order

1. Add characterization tests for current reported and AutoVerify evidence.
2. Add the trust-tier types, provenance versions, internal runner boundary,
   aggregation, rendering, compaction, persistence, and proof text.
3. Add semantic-assist behavior fixtures, then replace the quadratic paths.
4. Update README language only for behavior proven by the tests.
5. Run focused tests and typecheck; inspect the integrated diff.
6. Run `npm run check`, `npm run eval:ci`, `npm run benchmark:ci`,
   `npm run smoke:package`, `npm audit --audit-level=moderate`, and Codexa
   post-edit/test/proof gates.
7. Run repeated adversarial reviews until no actionable finding remains.
8. Commit, generate Markdown/PDF PR artifacts, push a draft PR, inspect all
   checks/comments/review threads, fix findings, and merge only at convergence.

## Adversarial Acceptance Gate

The release is fit to merge only if all answers are yes:

- Can public input forge `executed-by-autoverify`? It must not.
- Does a failed/masked/out-of-scope command ever earn positive coverage? It
  must not.
- Do all structured and text proof surfaces name the same tier?
- Do old behavior tests pass without weakening assertions?
- Do semantic merge keys preserve every field in the old equality contract?
- Is emitted fact ordering unchanged and deterministic?
- Did the implementation avoid a new public verb, dependency, service, config
  system, or source mutation path?
- Are the plan, summary artifacts, PR state, checks, and branch ancestry all
  current at merge time?

## Pre-Implementation Adversarial Review

Review date: 2026-07-10

1. **Finding: classifier-version overclaim.** The first draft proposed
   `command-coverage-v4`, but no shell-classification rule changes in this
   slice. Resolution: keep classifier v3 and add a separate coverage-schema v4
   provenance field.
2. **Finding: hypothetical evidence could look reported.** Test-plan preview
   coverage is built by running recommended command strings through the same
   classifier. Resolution: explicitly rewrite preview coverage and grouped
   command plans to `none`; only actual caller-supplied commands are
   `reported`.
3. **Finding: legacy evidence cannot be reconstructed safely.** Old persisted
   rows have no tier, and some may have originated from AutoVerify. Resolution:
   render unknown legacy provenance as `none` rather than inferring a stronger
   tier.
4. **Finding: trust aggregation must not depend on input order.** Duplicate
   manual and AutoVerify reports can describe the same command. Resolution:
   deduplication and command grouping use an explicit tier order, with
   `executed-by-autoverify` strongest and `none` weakest.

Verdict: fit to implement with these amendments. The plan names the invariant,
failure, trust boundary, smallest mechanism, proof, and rollback for both
slices; no unresolved recommendation requires a wider product surface.

## Implementation Record

Implemented on 2026-07-10:

- Added first-class verification trust tiers to coverage, command plans,
  ledgers, proof cards, MCP compaction, persisted outcomes, and eval
  provenance. Public command reports remain `reported`; only accepted internal
  AutoVerify reports can become `executed-by-autoverify`.
- Added fail-closed normalization for legacy, missing, or malformed trust
  values at aggregation, proof, and compaction boundaries.
- Replaced global TypeScript usage/import scans with indexed merge lookups that
  preserve the old equality fields and four-byte usage tolerance.
- Replaced Python's per-export symbol-array clone and map rebuild with direct
  mutation of the already-cloned symbol referenced by `symbolsById`.
- Added high-fanout regression fixtures covering 180 TypeScript imports, 180
  compiler re-exports, 180 type references, and 180 Python package exports.
  Repeat indexes compare every semantic fact field except per-run
  `snapshotId` and `indexedAt` provenance.

Final local proof:

- `npm run check`: 44 test files and 425 tests passed, plus 26 command-wrapper
  and 87 hook smoke checks.
- `npm run eval:ci`: 21 scenarios passed; score 1; raw `rg` better in 0.
- `npm run benchmark:ci`: all thresholds passed. The observed cold index was
  3,839 ms versus the 5,163 ms pre-change run on the same host, a 25.6%
  reduction. This is a single-host comparison, not a general performance
  guarantee.
- `npm run smoke:package`: 25 packed-install checks passed.
- `npm run package:hygiene`: package and plugin hygiene passed.
- `npm audit --audit-level=moderate`: 0 vulnerabilities.
- Codexa's original saved snapshot returned `replan` for three required files
  discovered during review. After those findings were justified and added to
  the snapshot, `post-edit-review` returned `continue` with no drift and no
  unaccounted tests.

## Adversarial Review Convergence

The implementation review found and resolved these issues before commit:

1. **Durable plan was ignored.** `docs/plans/*` requires a named allowlist
   entry. Added the same explicit allowlist used by existing durable plans.
2. **Python performance proof was too weak.** The first fixture exported one
   symbol. Expanded it to 180 package exports so the removed rebuild loop is
   exercised directly.
3. **Eval provenance dropped the new version.** The eval extractor used an
   explicit field allowlist. Added `verificationCoverageVersion`; existing
   eval assertions now preserve the complete current provenance object.
4. **Trust aggregation lacked direct order proof.** Added both reported-first
   and executed-first duplicate cases for coverage deduplication and command
   grouping.
5. **Malformed tiers were not uniformly fail-closed.** Normalized unknown and
   legacy values to `none` in tier comparison, deduplication, command plans,
   proof loading, and MCP compaction.
6. **Import-key equivalence was typed rather than runtime-exact.** Encoded
   optional-field presence separately so malformed `null` cannot collapse into
   missing `undefined`.
7. **Semantic determinism compared too few fields.** Strengthened the test to
   compare complete import, usage, and symbol facts after removing only the
   two intentionally per-run provenance fields.
8. **Command-backed required checks lost their trust tier.** External PR
   review found that dependency checks covered by `ranTests` or matching
   command coverage still produced ledger rows with `none`. Required-check
   evaluation now carries the strongest matching tier through result, text,
   persistence, and ledger output, while graph/file-only evidence remains
   `none`. Structural, reported, executed AutoVerify, and integrated ledger
   cases cover the distinction.
9. **Unrun context recommendations looked reported.** A second external PR
   review found that context packets classified recommended command strings
   through the raw-report path, so their text and structured command plans
   emitted `reported` before execution. Context and test-plan output now share
   explicit preview conversion that forces coverage, grouped command plans,
   and ledger previews to `none`; task-brief and test-plan regressions lock the
   fail-closed contract.

Convergence verdict: no unresolved correctness, trust-boundary, performance,
packaging, documentation, or test finding remains in the local review. PR
checks, review threads, and branch ancestry remain mandatory merge gates.
