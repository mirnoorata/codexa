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
    description: "Session start context and project orientation: current focus, dirty file groups, likely workflows, and the next Codexa call to make. Use when starting or resuming work in a repository. Alias of focus_brief. Compact output.",
    tier: "primary",
    phase: "orientation",
    cost: "compact",
    writeEffects: "session-memory-auto",
    readOnly: false,
    useWhen: "Start or resume work in a repo and choose the next focused Codexa call.",
    avoidWhen: "You already have an explicit file or symbol target; use task_brief or change_plan instead.",
    nextToolUse: ["search", "task_brief"]
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
    useWhen: "Before task_brief when the target is unclear, when a prompt is broad, or when you need one hybrid semantic/raw pass instead of repeated searches.",
    avoidWhen: "You already have precise files/symbols and need edit planning, drift review, or verification proof.",
    nextToolUse: ["task_brief", "change_plan"]
  },
  {
    name: "task_brief",
    title: "Codexa task brief",
    description:
      "Pre-edit context brief: what to read first before changing code — read-first files, impact expansion, risks, likely tests, freshness, confidence labels, snippets. Default once a target or bounded task is known. Medium output.",
    tier: "primary",
    phase: "brief",
    cost: "medium",
    writeEffects: "session-memory-auto",
    readOnly: false,
    useWhen: "Before editing, debugging, or reviewing a specific task after search/session context has supplied a plausible target.",
    avoidWhen: "The target is still unclear; run first-class search or provide explicit files first.",
    nextToolUse: ["change_plan"]
  },
  {
    name: "change_plan",
    title: "Codexa change plan",
    description:
      "Plan a code change and save a pre-edit snapshot: set saveSnapshot=true before editing so post_edit_review can detect drift against the plan. Returns planned edit targets, tests, freshness, and known gaps. Medium output.",
    tier: "primary",
    phase: "plan",
    cost: "medium",
    writeEffects: "task-snapshot-cache",
    readOnly: false,
    useWhen: "Before non-trivial edits; pass saveSnapshot=true to enable post-edit drift checks.",
    avoidWhen: "After edits are already made; use post_edit_review for dirty-tree accountability.",
    nextToolUse: ["post_edit_review"]
  },
  {
    name: "post_edit_review",
    title: "Codexa post-edit review",
    description:
      "Review code changes for drift: compares the dirty tree against the change_plan snapshot for planned-vs-actual drift, unplanned edits, symbol/risk deltas, affected callers/tests/workflows, and tests still unaccounted for. Pass the snapshot task id plus commands that actually ran. MCP calls do not persist outcome files. Large output, budget-compacted.",
    tier: "primary",
    phase: "review",
    cost: "large",
    writeEffects: "session-memory-auto",
    readOnly: false,
    useWhen: "Immediately after edits and before final response; pass the saved change_plan task id plus commands/tests that actually ran.",
    avoidWhen: "Before editing or without a meaningful diff to review.",
    nextToolUse: ["test_plan"]
  },
  {
    name: "test_plan",
    title: "Codexa test plan",
    description: "Which tests to run: recommend targeted tests and verification commands for explicit target files or the current diff. Returns needs_target instead of inventing work when no scope exists. Recommendations only, not execution evidence. Compact output.",
    tier: "primary",
    phase: "verify",
    cost: "compact",
    writeEffects: "session-memory-auto",
    readOnly: false,
    useWhen: "Select verification for explicit files, the current diff, or after post_edit_review has provided a review scope.",
    avoidWhen: "You need proof that tests ran; recommendations are not execution evidence.",
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
    nextToolUse: ["task_brief", "change_plan"]
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
    nextToolUse: ["task_brief"]
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
    nextToolUse: ["task_brief"]
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
    nextToolUse: ["task_brief"]
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
    nextToolUse: ["change_plan"]
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
    nextToolUse: ["task_brief", "search"]
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
    nextToolUse: ["change_plan"]
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
    nextToolUse: ["post_edit_review", "test_plan"]
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
    nextToolUse: ["impact"]
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
    nextToolUse: ["impact"]
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
    nextToolUse: ["impact"]
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
    nextToolUse: ["change_plan"]
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
    nextToolUse: ["task_brief"]
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
    nextToolUse: ["task_brief"]
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
// The "core" exposure profile: the primary loop plus the two cheap
// inspection tools. Shared by `codexa init --tools core` (Codex
// enabled_tools allowlist) and `codexa serve --tools core` (server-side
// registration filter for hosts without a client allowlist).
export const CORE_PROFILE_TOOL_NAMES = Object.freeze([...PRIMARY_MCP_TOOL_NAMES, "impact" as McpToolName, "freshness" as McpToolName]);
export const ADVANCED_MCP_TOOL_NAMES = Object.freeze(MCP_TOOL_REGISTRY.filter((tool) => tool.tier === "advanced").map((tool) => tool.name));
export const SOURCE_CONTEXT_MCP_TOOL_NAMES = Object.freeze(MCP_TOOL_REGISTRY.filter((tool) => tool.writeEffects === "index-cache-if-auto-refresh").map((tool) => tool.name));
export const MEMORY_RECORDING_MCP_TOOL_NAMES = Object.freeze(MCP_TOOL_REGISTRY.filter((tool) => tool.writeEffects === "session-memory-auto").map((tool) => tool.name));
export const PRIMARY_CODEX_LOOP = "session_context -> search(if target unclear) -> task_brief -> change_plan(saveSnapshot) -> post_edit_review -> test_plan";
export const NO_SOURCE_MUTATION_CONTRACT = "Codexa MCP tools may write Codexa cache artifacts, but must not mutate source files.";

export function mcpToolRegistryEntry(name: string): McpToolRegistryEntry | undefined {
  return MCP_TOOL_REGISTRY.find((tool) => tool.name === name);
}
