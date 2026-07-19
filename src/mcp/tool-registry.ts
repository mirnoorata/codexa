export type McpToolTier = "primary" | "advanced";
export type McpToolPhase = "orientation" | "brief" | "plan" | "review" | "verify" | "inspect" | "diagnose" | "risk" | "memory";
/** Typical structured-output size, as a routing hint for agents choosing the cheapest sufficient tool. */
export type McpToolCost = "compact" | "medium" | "large";

export interface McpToolRegistryEntry {
  name: string;
  title: string;
  description: string;
  tier: McpToolTier;
  phase: McpToolPhase;
  cost: McpToolCost;
  writeEffects: string;
  readOnly: boolean;
  useWhen: string;
  avoidWhen: string;
  nextToolUse: string[];
}

export const MCP_TOOL_REGISTRY = [
  {
    name: "session_context",
    title: "Codexa session context",
    description: "Recovery context for broad work: current focus, dirty file groups, likely workflows, and the next useful action. Use only when starting a genuinely broad task, resuming after context loss, or when orientation would prevent repeated source reads. Alias of focus_brief. Compact output.",
    tier: "primary",
    phase: "orientation",
    cost: "compact",
    writeEffects: "session-memory-auto",
    readOnly: false,
    useWhen: "Start genuinely broad work, resume after context loss, or prevent repeated repository re-reading.",
    avoidWhen: "A file, symbol, error, or bounded target is already known; inspect source directly or use change_plan only if the edit is materially risky.",
    nextToolUse: []
  },
  {
    name: "search",
    title: "Codexa hybrid semantic search",
    description:
      "Search the codebase: find code, files, symbols, and likely tests for an ambiguous task or identifier in one bounded hybrid pass (raw, exact, symbol, ranking; semantic only when configured) with value/gap labels. Medium output; cheaper than context_pack.",
    tier: "primary",
    phase: "inspect",
    cost: "medium",
    writeEffects: "index-cache-if-auto-refresh",
    readOnly: false,
    useWhen: "The target is ambiguous and one bounded hybrid pass can replace repeated raw searches.",
    avoidWhen: "A file, symbol, error, or exact raw match already identifies the target; use source tools directly and stop when raw evidence is sufficient.",
    nextToolUse: []
  },
  {
    name: "task_brief",
    title: "Codexa task brief",
    description:
      "Optional pre-edit context brief: what to read first before changing code — read-first files, impact expansion, risks, likely tests, freshness, confidence labels, snippets. Use when an otherwise bounded task still needs repository context. Medium output.",
    tier: "primary",
    phase: "brief",
    cost: "medium",
    writeEffects: "session-memory-auto",
    readOnly: false,
    useWhen: "A plausible target is known but the agent still lacks enough repository context to plan safely.",
    avoidWhen: "The target is unclear (use search), or the bounded target and required context are already explicit (use change_plan).",
    nextToolUse: []
  },
  {
    name: "change_plan",
    title: "Codexa change plan",
    description:
      "Plan a non-trivial code change and optionally save a pre-edit snapshot. Accepts bounded task invariants and returns planned targets, tests, freshness, and known gaps. Use for multi-file, API, runtime, persistence, security, or otherwise high-risk edits; ordinary local edits should use source and tests directly. Medium output.",
    tier: "primary",
    phase: "plan",
    cost: "medium",
    writeEffects: "task-snapshot-cache",
    readOnly: false,
    useWhen: "A non-trivial edit crosses files or material boundaries; pass saveSnapshot=true when later drift accountability is useful.",
    avoidWhen: "The change is an exact, local, low-risk edit with obvious verification, or edits are already complete.",
    nextToolUse: []
  },
  {
    name: "post_edit_review",
    title: "Codexa post-edit review",
    description:
      "Review code changes for drift when no deterministic host completion gate already owns review: compares the dirty tree against a change_plan snapshot, accounts for declared invariants and selected verification artifacts, and persists a sanitized task outcome used by the replan budget. Pass the snapshot task id plus evidence that actually ran. Large output, budget-compacted.",
    tier: "primary",
    phase: "review",
    cost: "large",
    writeEffects: "task-outcome-cache+session-memory-auto",
    readOnly: false,
    useWhen: "A hookless host needs one drift review, or the user requests a formal review; pass the saved task id plus commands/tests that actually ran.",
    avoidWhen: "A managed host hook or completion gate already reviewed the edit, before editing, or without a meaningful diff.",
    nextToolUse: []
  },
  {
    name: "test_plan",
    title: "Codexa test plan",
    description: "Which tests to run before or after editing: recommend targeted tests and verification commands for explicit target files or the current diff. Returns needs_target instead of inventing work when no scope exists. Recommendations only, not execution evidence. Compact output.",
    tier: "primary",
    phase: "verify",
    cost: "compact",
    writeEffects: "session-memory-auto",
    readOnly: false,
    useWhen: "Verification guidance from change_plan or post_edit_review is unresolved, or the user explicitly asks for a dedicated test plan.",
    avoidWhen: "The change plan already returned sufficient tests/commands, or you need proof that tests ran; recommendations are not execution evidence.",
    nextToolUse: []
  },
  {
    name: "proof_card",
    title: "Codexa proof card",
    description:
      "Final proof packet: freshness, saved plan and invariants, lifecycle stop state, decision continuity, local policies, selected run artifacts, and reported command/test evidence classified by the shared verification ledger. Does not execute commands. Medium output.",
    tier: "primary",
    phase: "verify",
    cost: "medium",
    writeEffects: "session-memory-auto",
    readOnly: false,
    useWhen: "A policy change, formal audit, release, artifact handoff, or decision-integrity review needs an explicit proof packet.",
    avoidWhen: "An ordinary bounded edit is already resolved by post_edit_review, or verification still needs to run.",
    nextToolUse: []
  },
  {
    name: "capabilities",
    title: "Codexa capability dispatcher",
    description:
      "Discover or invoke any non-core Codexa operation through one compact, manifest-backed dispatcher. The dispatcher preserves the full logical capability set and validates each invocation with the same operation-specific schema as the direct tool. Compact output unless the selected operation returns more detail.",
    tier: "primary",
    phase: "inspect",
    cost: "compact",
    writeEffects: "dispatched-operation-dependent",
    readOnly: false,
    useWhen: "A concrete trigger requires a non-core operation without exposing every schema in the optimized/core profile.",
    avoidWhen: "Source inspection, search, or change_plan already resolves the task, or full mode exposes the preferred direct tool.",
    nextToolUse: []
  },
  {
    name: "workflow_path",
    title: "Codexa workflow path",
    description: "Trace a route, endpoint, job, manifest, or workflow path related to a query, file, or symbol. Medium output.",
    tier: "advanced",
    phase: "inspect",
    cost: "medium",
    writeEffects: "index-cache-if-auto-refresh",
    readOnly: false,
    useWhen: "Inspect route, job, manifest, or workflow traces for a focused runtime path.",
    avoidWhen: "You only need startup orientation; session_context is cheaper.",
    nextToolUse: []
  },
  {
    name: "freshness",
    title: "Codexa freshness",
    description: "Index status check: report whether the Codexa codebase index is present, fresh, stale, or missing. Compact, read-only.",
    tier: "advanced",
    phase: "diagnose",
    cost: "compact",
    writeEffects: "none",
    readOnly: true,
    useWhen: "Check whether indexed artifacts are present, fresh, stale, or missing.",
    avoidWhen: "You need task-specific context; use task_brief after freshness is known.",
    nextToolUse: []
  },
  {
    name: "repo_map",
    title: "Codexa repo map",
    description: "Repository map and project structure overview: ranked top modules and files for orientation. Compact output.",
    tier: "advanced",
    phase: "orientation",
    cost: "compact",
    writeEffects: "index-cache-if-auto-refresh",
    readOnly: false,
    useWhen: "Get a ranked repository map or module overview.",
    avoidWhen: "You need edit-ready task context; task_brief carries more proof.",
    nextToolUse: []
  },
  {
    name: "find_context",
    title: "Codexa find context",
    description: "Find files, symbols, definitions, and usage sites matching a precise known name. Compact output; cheaper than search when the name is already known.",
    tier: "advanced",
    phase: "inspect",
    cost: "compact",
    writeEffects: "session-memory-auto",
    readOnly: false,
    useWhen: "Find matching files, symbols, and usage sites for a precise query.",
    avoidWhen: "You need dirty-diff review or saved edit planning.",
    nextToolUse: []
  },
  {
    name: "context_pack",
    title: "Codexa context pack",
    description:
      "Deep context packet for one task: focus files, bounded impact expansion, evidence snippets, impact groups, tests, freshness, provenance. Use only when task_brief is not enough. Large output.",
    tier: "advanced",
    phase: "brief",
    cost: "large",
    writeEffects: "session-memory-auto",
    readOnly: false,
    useWhen: "Build a larger task-shaped packet with snippets, impact, tests, and provenance.",
    avoidWhen: "A small first-pass task_brief is enough.",
    nextToolUse: []
  },
  {
    name: "focus_brief",
    title: "Codexa focus brief",
    description: "Orient a broad natural-language question: classify the task, pick likely subsystems, and recommend the next Codexa call. Compact output.",
    tier: "advanced",
    phase: "orientation",
    cost: "compact",
    writeEffects: "session-memory-auto",
    readOnly: false,
    useWhen: "Classify a broad natural-language task and choose likely subsystems.",
    avoidWhen: "You already know exact files or symbols.",
    nextToolUse: []
  },
  {
    name: "impact",
    title: "Codexa impact",
    description: "Impact analysis and blast radius: what could break if one file or symbol changes; traversal depth auto-scales with changeType (rename/delete reach deeper than style). Medium output.",
    tier: "advanced",
    phase: "inspect",
    cost: "medium",
    writeEffects: "session-memory-auto",
    readOnly: false,
    useWhen: "Inspect blast radius for one file or symbol before an API, behavior, rename, or delete change.",
    avoidWhen: "No target is known; use search or task_brief first.",
    nextToolUse: []
  },
  {
    name: "diff_impact",
    title: "Codexa diff impact",
    description: "Analyze the current git diff: group dirty working-tree changes into impact modules before review or verification. Medium output.",
    tier: "advanced",
    phase: "inspect",
    cost: "medium",
    writeEffects: "index-cache-if-auto-refresh",
    readOnly: false,
    useWhen: "Group the current dirty tree before review or verification.",
    avoidWhen: "The tree is clean or you need a saved-snapshot drift review.",
    nextToolUse: []
  },
  {
    name: "change_review",
    title: "Codexa committed change review",
    description: "Review a clean committed base-to-head range with the same structured receipt used by the CLI and GitHub Action: identity, changed files, blast radius, plan conformance, test guidance, reported verification claims, verdict, and next actions. Medium output.",
    tier: "advanced",
    phase: "review",
    cost: "medium",
    writeEffects: "index-cache-if-auto-refresh",
    readOnly: false,
    useWhen: "Review a committed branch, pull request head, or agent-produced commit against a known base.",
    avoidWhen: "Edits are still uncommitted; use post_edit_review for dirty-tree accountability.",
    nextToolUse: []
  },
  {
    name: "symbol_context",
    title: "Codexa symbol context",
    description:
      "Symbol definition and neighborhood: callers, callees, references, tests, risks, and evidence for one symbol. depth=1 is compact; depth=3 expands several-fold.",
    tier: "advanced",
    phase: "inspect",
    cost: "medium",
    writeEffects: "index-cache-if-auto-refresh",
    readOnly: false,
    useWhen: "Inspect one symbol's definition and usage sites.",
    avoidWhen: "You need full file blast radius; use impact.",
    nextToolUse: []
  },
  {
    name: "callers",
    title: "Codexa callers",
    description: "Who calls or references this: typed inbound call-graph edges (calls, references, imports, tests) for a file or symbol. Compact output.",
    tier: "advanced",
    phase: "inspect",
    cost: "compact",
    writeEffects: "index-cache-if-auto-refresh",
    readOnly: false,
    useWhen: "Find typed inbound graph edges for a focused file or symbol.",
    avoidWhen: "You need outgoing dependencies; use callees.",
    nextToolUse: []
  },
  {
    name: "callees",
    title: "Codexa callees",
    description: "What this calls or depends on: typed outbound call-graph edges (calls, references, imports, tests, risks) for a file or symbol. Compact output.",
    tier: "advanced",
    phase: "inspect",
    cost: "compact",
    writeEffects: "index-cache-if-auto-refresh",
    readOnly: false,
    useWhen: "Find typed outgoing graph edges for a focused file or symbol.",
    avoidWhen: "You need inbound usages; use callers.",
    nextToolUse: []
  },
  {
    name: "dependency_path",
    title: "Codexa dependency path",
    description: "How two files or symbols are connected: bounded typed dependency path between two known endpoints. Compact output.",
    tier: "advanced",
    phase: "inspect",
    cost: "compact",
    writeEffects: "index-cache-if-auto-refresh",
    readOnly: false,
    useWhen: "Find a bounded graph path between two known files or symbols.",
    avoidWhen: "Either endpoint is unknown; use search first.",
    nextToolUse: []
  },
  {
    name: "placeholder_report",
    title: "Codexa placeholder report",
    description: "Find TODOs, stubs, placeholders, and unimplemented code; tracked as risk signals that participate in post_edit_review deltas. Compact output.",
    tier: "advanced",
    phase: "risk",
    cost: "compact",
    writeEffects: "index-cache-if-auto-refresh",
    readOnly: false,
    useWhen: "Inspect TODO, stub, dummy, and not-implemented risk signals.",
    avoidWhen: "You need ordinary file localization.",
    nextToolUse: []
  },
  {
    name: "session_memory",
    title: "Codexa session memory",
    description:
      "Read, summarize, compact, or explicitly remember durable structured working memory for this Codex session. Cache-only; never mutates source. action=summary is the cheap overview. Compact output.",
    tier: "advanced",
    phase: "memory",
    cost: "compact",
    writeEffects: "explicit-memory-cache",
    readOnly: false,
    useWhen: "Read or write cache-only structured session memory for the current Codex workflow.",
    avoidWhen: "You need durable project docs or source changes.",
    nextToolUse: []
  }
] as const satisfies readonly McpToolRegistryEntry[];

export type McpToolName = (typeof MCP_TOOL_REGISTRY)[number]["name"];
export type McpToolCatalogEntry = Pick<McpToolRegistryEntry, "name" | "tier" | "phase" | "cost" | "writeEffects" | "readOnly" | "useWhen" | "avoidWhen" | "nextToolUse">;

export const MCP_TOOL_CATALOG = MCP_TOOL_REGISTRY.map(({ name, tier, phase, cost, writeEffects, readOnly, useWhen, avoidWhen, nextToolUse }) => ({
  name,
  tier,
  phase,
  cost,
  writeEffects,
  readOnly,
  useWhen,
  avoidWhen,
  nextToolUse
})) as readonly McpToolCatalogEntry[];

export const MCP_TOOL_NAMES = Object.freeze(MCP_TOOL_REGISTRY.map((tool) => tool.name));
export const PRIMARY_MCP_TOOL_NAMES = Object.freeze(MCP_TOOL_REGISTRY.filter((tool) => tool.tier === "primary").map((tool) => tool.name));
// The "core" exposure profile keeps only the decision points that can pay for
// their own schema cost. Every removed operation remains available through the
// manifest-backed capabilities dispatcher.
export const CORE_PROFILE_TOOL_NAMES = Object.freeze(["search", "change_plan", "capabilities"] as const satisfies readonly McpToolName[]);
export const ADVANCED_MCP_TOOL_NAMES = Object.freeze(MCP_TOOL_REGISTRY.filter((tool) => tool.tier === "advanced").map((tool) => tool.name));
export const DISPATCHABLE_MCP_TOOL_NAMES = Object.freeze(MCP_TOOL_NAMES.filter((tool) => !CORE_PROFILE_TOOL_NAMES.includes(tool as (typeof CORE_PROFILE_TOOL_NAMES)[number])));
export const SOURCE_CONTEXT_MCP_TOOL_NAMES = Object.freeze(MCP_TOOL_REGISTRY.filter((tool) => tool.writeEffects === "index-cache-if-auto-refresh").map((tool) => tool.name));
export const MEMORY_RECORDING_MCP_TOOL_NAMES = Object.freeze(MCP_TOOL_REGISTRY.filter((tool) => tool.writeEffects.includes("session-memory-auto")).map((tool) => tool.name));
export const PRIMARY_CODEX_LOOP = "exact/local work -> source tools with zero Codexa calls; ambiguous target -> one search and stop when raw evidence is sufficient; non-trivial risky edit -> change_plan(saveSnapshot) -> edit/run planned verification; post_edit_review only when no deterministic host gate owns review";
export const NO_SOURCE_MUTATION_CONTRACT = "Codexa MCP tools may write Codexa cache artifacts, but must not mutate source files.";

export function mcpToolRegistryEntry(name: string): McpToolRegistryEntry | undefined {
  return MCP_TOOL_REGISTRY.find((tool) => tool.name === name);
}
