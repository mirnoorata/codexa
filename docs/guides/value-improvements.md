# Six improvements, in order

Base: Codexa 0.19.0. The objective is useful, inspectable change evidence with
less wasted source reading and tool overhead. Comparative superiority requires
measured task outcomes; implementation tests alone cannot establish it.

## Invariants

- Source, explicit targets, freshness, and observed execution retain authority.
  TypeSafe only advises ordering; it never grants edit or verification authority.
- No-model and zero-Codexa-call workflows remain supported.
- Optional telemetry excludes queries, source, credentials, and private paths.
  Missing accounting stays unknown, not zero.
- Existing public interfaces remain compatible. Changes are independently
  reversible; new integrations preserve unrelated configuration.

## 1. Evaluation and accounting — implemented, local checks passed

Extend the existing TypeSafe comparison and agent A/B facilities rather than
building a second agent controller. Add a bounded external retrieval pack with
pinned repository revisions, repository-separated calibration/evaluation groups,
candidate coverage, answer rank, harmful promotions, and cold/repeat usage.
Public cases are reproducible regressions, not secret held-out agent tasks.
Support evaluator-owned packs without copying private source into reports.

Correlate optional TypeSafe usage with existing MCP events and preserve unknown
provider usage. Reuse the deterministic product-level verification challenge
suites covering valid runs, missing checks, masked failures, and wrong scope.
Keep full-agent task correctness owned by the existing independent verifier.

Verify pack validation, split leakage rejection, production query execution,
telemetry through MCP and the analyzer, and the challenge suite. Capture the
unmodified retrieval baseline before changing excerpt or acceptance behavior.
The coding-agent pilot uses a local Qwen model; TypeSafe requests are authorized.

Verification: 70 focused tests passed. The frozen public pack has three pinned
repositories and 14 cases, with one calibration repository and two evaluation
repositories. Baseline evaluation: 2/11 first-place answers, 8/11 candidate
coverage; all nine behavioral requests fell back. This is a small public
regression set, not a blinded or representative agent benchmark.

## 2. Relevant TypeSafe excerpts — implemented, local checks passed

Replace fixed file prefixes with bounded windows around matching source lines
and relevant indexed symbols. Include line locations and truncation information.
Use existing source reads and complete-content hashes; preserve request limits,
source containment, deadlines, candidates, and deterministic evidence.

Verify late-file implementations, misleading headers, long lines, Unicode,
unreadable/oversized sources, repeat caching, and unchanged edit authority through
the real query/SDK boundary. Compare the same cases and candidate sets as step 1.

Verification: 25 focused tests passed, including late implementation, bounded
Unicode, source hashing, caching, and real SDK/MCP paths. Public evaluation
input tokens fell from 77,670 to 61,583 (20.7%); ranking remained unchanged.
Latency is descriptive on shared infrastructure.

## 3. Invocation and uncertainty — implemented, local checks passed

Use the new measurements to distinguish missing candidates, insufficient source,
uncertain consequential rankings, and unimportant tail uncertainty. Preserve
exact-target bypasses. Accept only supported advisory promotions while retaining
baseline order where uncertainty matters. Do not replace uncertainty with an
unvalidated global threshold or add an always-on model router.

Verify ties, no-match, malformed answers, low-confidence winners, uncertain tails,
service failures, zero-billing reuse, and unsupported source. Publish comparison
results and distinguish offline response-policy tests from live calibration.

Verification: 43 focused tests passed. Calibration showed a 2.99/3, 0.99-
confidence winner vetoed by unrelated low-confidence candidates. The revised
policy promotes only a clear, supported winner and preserves all other order;
valid abstentions are reused, while failures are not cached. Evaluation improved
first-place answers from 2/11 to 5/11, with three improvements and no harmed
ranks in this small set. All nine repeated behavioral queries reused decisions
with no new requests. Candidate coverage stayed 8/11. These are heuristic
acceptance bounds, not calibrated probabilities of correctness.

## 4. Efficient change workflow — implemented, local checks passed

Exercise the actual core MCP path: plan, inspect/edit/test, then direct invocation
of review through the returned capabilities arguments. Cover exact zero-call
guidance, ordinary two-call work, and the bounded ambiguous-task exception.
Repair concrete call-contract gaps. Compare any proposed fourth direct tool with
the existing profile; retain the smaller default unless evidence favors change.

Verify SDK calls, logical-operation telemetry, schema errors, unchanged receipts,
resource reads, and final review evidence. No forced discovery chain or duplicate
review when a managed completion gate owns it.

Verification: nine MCP consumer tests passed. A real Node test run completes
plan → edit/test → review in two tool calls. The same edit with missing test
evidence remains blocking. Both use the returned dispatcher arguments without
list/describe. Clearer dispatcher and plan guidance removes unnecessary schema
discovery; the three-tool default stays. Reported evidence remains reported.

## 5. Go verification — implemented, local checks passed

Implement conservative `go test` recognition with package/workspace scope and
test selection. Compilation-only, listing, invalid/unsupported flags, shell
masking, and uncertain scope must not receive aggregate test credit. Scope
recognition does not authenticate a reported run or prove test adequacy.

Verify against real small Go modules as well as existing verification consumers.
Cover package arguments, `./...`, nested modules, filtered runs, `-c`, `-list`,
wrappers, zero-test behavior, and cwd boundaries. Leave unrelated runners intact.

Verification: 51 focused tests passed, including actual Go execution, package
recommendations, module boundaries, build constraints, TestMain bypasses, shell
masking, and existing verification consumers. Classification remains reported
evidence; environment and test adequacy are not attested.

## 6. Cursor setup and semantic adapters — implemented, local checks passed

Add an opt-in project-local Cursor MCP setup path using the existing init and
portable launch mechanisms. Preserve unrelated servers; handle malformed config,
tracked portability, spaces in paths, repeated setup, and updates. Add a concise
guide to installation, verification, removal, and the existing SCIP/LSP options.

Verify clean fixture installation, idempotency, coexistence, package-installed
stdio initialization and tools/list. Distinguish a server handshake from actual
Cursor UI activation when the desktop client is unavailable.

Verification: 67 focused init tests passed. The installed npm tarball passed
33 package checks, including the generated Cursor command through MCP
initialize, tools/list, and a query. Cursor desktop UI activation was not tested.
See [the setup guide](cursor-and-semantic-tools.md).

## Completion and reassessment

All six implementations and the integrated diff review are complete. The full
project check passed: 113 test files, 1,322 passing tests and one skipped test;
the dependency audit reported zero vulnerabilities. The public snapshot gate
requires a clean commit and is checked at delivery with package hygiene and the
installed-package smoke test.

The local Qwen pilot completed four trials with valid protocol and candidate
identity. Both arms passed visible tests but scored 0/2 on independent task
completion. All traces used the expected zero-Codexa-call route. This confirms
local-runner integration, not product efficacy; earlier infrastructure failures
are retained. The [competitive assessment](competitive-assessment.md) separates
these outcomes from the retrieval gains and ranks the next investments.
Delivery uses a named branch and a draft pull request; no release is implied.
