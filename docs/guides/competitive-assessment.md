# Codexa value assessment — September 2026

Codexa remains useful when a change needs an accountable finish: connect the
saved plan to the actual diff, distinguish reported checks from witnessed
execution, and show the work still missing. Its value is conditional on catching
real omissions for less effort than manual review. It has not demonstrated a
first-place ranking across coding tools.

A useful product description is: **Codexa helps your coding agent show what
changed, what was checked, and what still needs attention.** “Done” should come
with receipts. A confident paragraph is not a test result.

## Where it fits

The following compares documented capabilities, not measured head-to-head
accuracy. Primary project documentation was rechecked on September 19, 2026.
These products overlap but do not all solve the same job.

| Need | Strong alternatives | Codexa's position |
| --- | --- | --- |
| Semantic navigation and refactoring | [Serena](https://github.com/oraios/serena) integrates language servers for over 40 languages and an alternative JetBrains backend. | Codexa has narrower native semantic depth. Use existing LSP/SCIP adapters; do not try to build a competing IDE backend. |
| Graph exploration and impact | [GitNexus](https://github.com/abhigyanpatwari/GitNexus) offers hybrid search, symbol context, process views, traces and change impact. [CodeGraphContext](https://github.com/CodeGraphContext/CodeGraphContext) combines graph queries, multiple languages and optional SCIP. | Broad graph exploration is not Codexa's strongest reason to install. Turn available impact evidence into a bounded change/check workflow. Embedded graph options exist elsewhere; local operation alone is not a differentiator. |
| Compact repository context | [Aider's repo map](https://aider.chat/docs/repomap.html) ranks important code within a token budget. [Repomix](https://repomix.com/guide/) packages repositories for model consumption. | Context efficiency is table stakes. Codexa should skip exact local work, retrieve only when needed, and justify every lifecycle call. |
| Pull-request review | [PR-Agent](https://github.com/The-PR-Agent/pr-agent) provides review and related PR automation; the community project is distinct from Qodo's commercial product. | Codexa complements review with local plans, scoped verification evidence and explicit remaining obligations. Commentary quality alone is not a durable advantage. |

Competitors also address uncertainty, freshness, local execution and bounded
context. None of those individual features makes Codexa uniquely safe or
universally better. Codexa's strongest positioning is the small, reusable
**plan → change → checks → review** contract across existing agents and CI.
This is a product judgment grounded in implementation, not a proven competitive
accuracy lead.

## What the six improvements achieved

1. **Evaluation and accounting:** pinned public repository queries, separate
   calibration/evaluation repositories, and provider usage alongside MCP events.
   Missing usage stays unknown. The agent harness can now register an unreleased
   npm package by SHA-256 without publishing it.
2. **Relevant excerpts:** source windows can reach implementations beyond file
   headers. Evaluation input fell from 77,670 to 61,583 tokens, a 20.7% reduction.
3. **Selective promotion:** uncertainty in unrelated candidates no longer vetoes
   a clear winner. Correct first files improved from 2/11 to 5/11 in the small
   public set, with no worsened ranks observed. Repeating its nine behavioral
   queries made no additional TypeSafe requests.
4. **Two-call workflow:** a real MCP consumer now proves plan → edit/test →
   review in two calls. Missing verification still blocks; no extra discovery
   call or fourth default tool is necessary.
5. **Go verification:** local package commands receive conservative scoped test
   credit. Filtered/compile-only runs, unsupported flags, nested modules,
   conditional files and TestMain bypasses do not silently become full coverage.
6. **Cursor setup:** portable, idempotent project MCP configuration preserves
   unrelated servers and rejects unsafe/conflicting state. The npm-installed
   generated command passed initialize/tools-list/query checks. Cursor desktop
   UI activation remains unverified.

The [retrieval pack](../../benchmarks/typesafe-retrieval/README.md) provides
case-level measurements and limitations. These are public regression results,
not blinded evidence of improved agent task completion. The three missing
candidate files remain missing; reranking cannot invent them. TypeSafe remains
opt-in and advisory. Its heuristic confidence bounds are not correctness
probabilities.

## Local Qwen pilot

The existing Harbor controller ran Qwen3.8-27B-FP8 locally through Codex 0.145.0
with `xhigh` reasoning. Two repetitions of one public path-normalization task
compared control with the bounded selective Codexa arm. The unreleased npm
package was hash-pinned; MCP setup and candidate identity checks passed.

| Arm | Visible tests passed | Independent completion | Codexa calls | Total input / output tokens |
| --- | ---: | ---: | ---: | ---: |
| Control | 2/2 | 0/2 | 0 | 193,126 / 12,508 |
| Selective Codexa | 2/2 | 0/2 | 0 | 256,276 / 10,603 |

Zero calls matched this task's registered source-only route. No plan/review or
TypeSafe operation was exercised. Both arms missed independent behavioral
cases despite passing visible tests; for example, trimming first concealed
leading/trailing control characters that the verifier required rejecting.
This pilot establishes local-runner integration and route conformance, with
**no demonstrated completion benefit**. It cannot establish an efficacy or
competitor ranking. More input tokens in the selective arm remain a descriptive
cost, even when the agent does not call Codexa.

The [public result record](../../benchmarks/agent-ab-selective-v2/qwen-conformance-2026-09-19.json)
includes every finalized run and retained earlier setup failures: an unreachable
container endpoint and an unsupported `high` reasoning setting. The corrected
registration used `xhigh`; failed attempts were not silently discarded.
Cached tokens are included within input totals. No hosted coding-model billing
was used, but hardware/electricity costs were not measured. Dollar cost stays
unknown. TypeSafe's separate retrieval results above are not agent-success data.

Using Codexa to finish this change exposed another practical gap: the saved
plan listed seven initial implementation files, while six completed features
needed supporting contracts, tests and evidence files. The gate correctly
flagged scope growth, but also suggested fixture helpers and benchmark README
files as unaccounted tests despite the full executable suite passing. Delivery
records an explicit acceptance after reviewing the expanded scope; it does not
rewrite the original snapshot to manufacture a clean verdict. Better test-target
classification and easier scope reconciliation should reduce this friction.

## Highest-return next work

| Priority | Investment | Success measure |
| --- | --- | --- |
| 1 | Correct inferred test obligations that name helpers/docs, improve scope reconciliation, and expand independent verification challenges across real repositories. Then run a preregistered agent study with matched budgets, including missing tests, masked failures, stale evidence and wrong scopes. | Fewer false completion signals without more false blocks; independently verified patch success; total tokens, latency and tool calls. Report failures and no-use runs. |
| 2 | Repair candidate recall for demonstrated misses before adding more rerank sophistication. Use evaluation-owned repositories and record exact query failures. | Correct target enters the bounded candidate set; first-file accuracy rises without harmful promotions or inflated context. |
| 3 | Test installation and the two-call workflow in real Cursor, Codex and Claude Code sessions. Keep a single concise workflow and explicit escape routes for unsupported checks. | Time to first useful result, successful setup rate, unnecessary calls and repeated review rate. |
| 4 | Extend verification one ecosystem at a time from real demand. Reuse external semantic tools instead of adding parsers indiscriminately. | More actual project checks recognized with the same conservative failure behavior. |
| 5 | Evaluate TypeSafe on consequential choices only. Add cost estimates only with a versioned price schedule; continue reporting requests and tokens independently. | Better first reads and less agent exploration after including provider overhead. |

Keep the default small. Do not add an always-running coding model, graph UI,
mandatory hosted dependency, or growing stack of orchestration calls merely to
match a feature list. Integrate stronger navigation tools where useful, then
make the final evidence clear enough for a human to trust and challenge.

The product is worth continuing if independent trials show that this finish
contract catches omissions cheaply. If they do not, narrow Codexa to the
verification/receipt functions that earn their cost, and let ordinary source
tools handle more tasks. The current evidence supports that focused direction;
it does not support a “best coding assistant” claim.
