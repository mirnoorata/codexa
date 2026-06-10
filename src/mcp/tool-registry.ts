export type McpToolTier = "primary" | "advanced";
export type McpToolPhase = "orientation" | "brief" | "plan" | "review" | "verify" | "inspect" | "diagnose" | "risk" | "memory";

export interface McpToolRegistryEntry {
  name: string;
  title: string;
  description: string;
  tier: McpToolTier;
  phase: McpToolPhase;
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
    description: "Alias for focus_brief tuned for startup/focus events. Returns project focus, dirty groups, likely workflows, and next Codexa call.",
    tier: "primary",
    phase: "orientation",
    writeEffects: "session-memory-auto",
    readOnly: false,
    useWhen: "Start or resume work in a repo and choose the next focused Codexa call.",
    avoidWhen: "You already have an explicit file or symbol target; use task_brief or change_plan instead.",
    nextToolUse: ["search", "task_brief"]
  },
  {
    name: "search",
    title: "Codexa hybrid semantic search",
    description: "First-class target discovery for natural-language tasks, identifiers, and ambiguous requests. Combines bounded raw search, exact/symbol signals, semantic retrieval when configured, Codexa ranking, likely tests, and value/gap labels.",
    tier: "primary",
    phase: "inspect",
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
      "Default edit-context packet once a target or bounded task is known. Returns read-first files, impact expansion, risks, likely tests, freshness, confidence labels, and snippets.",
    tier: "primary",
    phase: "brief",
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
      "Build a concise Codex edit plan from focus brief, context pack, graph/workflow signals, tests, freshness, and known gaps. Set saveSnapshot=true before edits to enable post_edit_review drift checks.",
    tier: "primary",
    phase: "plan",
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
      "Go-to post-edit review gate. After editing, compare the dirty tree against the latest or requested change_plan snapshot with semantic-aware context, planned-vs-actual drift, symbol/risk deltas, affected callers/tests/workflows, and targeted tests still unaccounted for. MCP calls do not persist outcome files; use the CLI for persisted outcomes.",
    tier: "primary",
    phase: "review",
    writeEffects: "session-memory-auto",
    readOnly: false,
    useWhen: "Immediately after edits and before final response; pass the saved change_plan task id plus commands/tests that actually ran.",
    avoidWhen: "Before editing or without a meaningful diff to review.",
    nextToolUse: ["test_plan"]
  },
  {
    name: "test_plan",
    title: "Codexa test plan",
    description: "Recommend targeted tests for the current diff or top-ranked files, refreshing stale Codexa artifacts first when auto-refresh is enabled.",
    tier: "primary",
    phase: "verify",
    writeEffects: "session-memory-auto",
    readOnly: false,
    useWhen: "Select verification for the current diff or after post_edit_review.",
    avoidWhen: "You need proof that tests ran; recommendations are not execution evidence.",
    nextToolUse: []
  },
  {
    name: "workflow_path",
    title: "Codexa workflow path",
    description: "Return route/job/manifest workflow traces related to a natural-language query, file, or symbol.",
    tier: "advanced",
    phase: "inspect",
    writeEffects: "index-cache-if-auto-refresh",
    readOnly: false,
    useWhen: "Inspect route, job, manifest, or workflow traces for a focused runtime path.",
    avoidWhen: "You only need startup orientation; session_context is cheaper.",
    nextToolUse: ["task_brief", "change_plan"]
  },
  {
    name: "freshness",
    title: "Codexa freshness",
    description: "Report whether the Codexa index is present, fresh, stale, or missing.",
    tier: "advanced",
    phase: "diagnose",
    writeEffects: "none",
    readOnly: true,
    useWhen: "Check whether indexed artifacts are present, fresh, stale, or missing.",
    avoidWhen: "You need task-specific context; use task_brief after freshness is known.",
    nextToolUse: ["task_brief"]
  },
  {
    name: "repo_map",
    title: "Codexa repo map",
    description: "Return the top-ranked modules and files, refreshing stale Codexa artifacts first when auto-refresh is enabled.",
    tier: "advanced",
    phase: "orientation",
    writeEffects: "index-cache-if-auto-refresh",
    readOnly: false,
    useWhen: "Get a ranked repository map or module overview.",
    avoidWhen: "You need edit-ready task context; task_brief carries more proof.",
    nextToolUse: ["task_brief"]
  },
  {
    name: "find_context",
    title: "Codexa find context",
    description: "Find matching files, symbols, and usage sites, refreshing stale Codexa artifacts first when auto-refresh is enabled.",
    tier: "advanced",
    phase: "inspect",
    writeEffects: "session-memory-auto",
    readOnly: false,
    useWhen: "Find matching files, symbols, and usage sites for a precise query.",
    avoidWhen: "You need dirty-diff review or saved edit planning.",
    nextToolUse: ["task_brief"]
  },
  {
    name: "context_pack",
    title: "Codexa context pack",
    description: "Build one compact task-shaped context packet with focus files, bounded impact expansion, evidence snippets, impact groups, tests, freshness, and provenance.",
    tier: "advanced",
    phase: "brief",
    writeEffects: "session-memory-auto",
    readOnly: false,
    useWhen: "Build a larger task-shaped packet with snippets, impact, tests, and provenance.",
    avoidWhen: "A small first-pass task_brief is enough.",
    nextToolUse: ["change_plan"]
  },
  {
    name: "focus_brief",
    title: "Codexa focus brief",
    description: "Use for broad natural-language tasks or session startup. Classifies the task, picks likely subsystems, and recommends the next Codexa tool call.",
    tier: "advanced",
    phase: "orientation",
    writeEffects: "session-memory-auto",
    readOnly: false,
    useWhen: "Classify a broad natural-language task and choose likely subsystems.",
    avoidWhen: "You already know exact files or symbols.",
    nextToolUse: ["task_brief", "search"]
  },
  {
    name: "impact",
    title: "Codexa impact",
    description: "Return blast-radius evidence for a file or symbol, refreshing stale Codexa artifacts first when auto-refresh is enabled.",
    tier: "advanced",
    phase: "inspect",
    writeEffects: "session-memory-auto",
    readOnly: false,
    useWhen: "Inspect blast radius for one file or symbol before an API, behavior, rename, or delete change.",
    avoidWhen: "No target is known; use search or task_brief first.",
    nextToolUse: ["change_plan"]
  },
  {
    name: "diff_impact",
    title: "Codexa diff impact",
    description: "Return high-level impact context for the current dirty git diff, refreshing stale Codexa artifacts first when auto-refresh is enabled.",
    tier: "advanced",
    phase: "inspect",
    writeEffects: "index-cache-if-auto-refresh",
    readOnly: false,
    useWhen: "Group the current dirty tree before review or verification.",
    avoidWhen: "The tree is clean or you need a saved-snapshot drift review.",
    nextToolUse: ["post_edit_review", "test_plan"]
  },
  {
    name: "symbol_context",
    title: "Codexa symbol context",
    description: "Return proof-carrying symbol neighborhood context for a symbol id or name, including callers, callees, references, tests, risks, evidence, and guided next tools.",
    tier: "advanced",
    phase: "inspect",
    writeEffects: "index-cache-if-auto-refresh",
    readOnly: false,
    useWhen: "Inspect one symbol's definition and usage sites.",
    avoidWhen: "You need full file blast radius; use impact.",
    nextToolUse: ["impact"]
  },
  {
    name: "callers",
    title: "Codexa callers",
    description: "Return typed graph evidence for files/symbols that call, reference, import, or test the target.",
    tier: "advanced",
    phase: "inspect",
    writeEffects: "index-cache-if-auto-refresh",
    readOnly: false,
    useWhen: "Find typed inbound graph edges for a focused file or symbol.",
    avoidWhen: "You need outgoing dependencies; use callees.",
    nextToolUse: ["impact"]
  },
  {
    name: "callees",
    title: "Codexa callees",
    description: "Return typed graph evidence for symbols/files the target calls, references, imports, tests, or risks.",
    tier: "advanced",
    phase: "inspect",
    writeEffects: "index-cache-if-auto-refresh",
    readOnly: false,
    useWhen: "Find typed outgoing graph edges for a focused file or symbol.",
    avoidWhen: "You need inbound usages; use callers.",
    nextToolUse: ["impact"]
  },
  {
    name: "dependency_path",
    title: "Codexa dependency path",
    description: "Find a bounded typed graph path between two files or symbols.",
    tier: "advanced",
    phase: "inspect",
    writeEffects: "index-cache-if-auto-refresh",
    readOnly: false,
    useWhen: "Find a bounded graph path between two known files or symbols.",
    avoidWhen: "Either endpoint is unknown; use search first.",
    nextToolUse: ["change_plan"]
  },
  {
    name: "placeholder_report",
    title: "Codexa placeholder report",
    description: "Report indexed placeholder, dummy, TODO, and stub code/data findings. Findings are tracked as risk signals and participate in post_edit_review deltas.",
    tier: "advanced",
    phase: "risk",
    writeEffects: "index-cache-if-auto-refresh",
    readOnly: false,
    useWhen: "Inspect TODO, stub, dummy, and not-implemented risk signals.",
    avoidWhen: "You need ordinary file localization.",
    nextToolUse: ["task_brief"]
  },
  {
    name: "session_memory",
    title: "Codexa session memory",
    description: "Read, summarize, compact, or explicitly remember durable structured working memory for this Codex session. Cache-only; does not mutate source.",
    tier: "advanced",
    phase: "memory",
    writeEffects: "explicit-memory-cache",
    readOnly: false,
    useWhen: "Read or write cache-only structured session memory for the current Codex workflow.",
    avoidWhen: "You need durable project docs or source changes.",
    nextToolUse: ["task_brief"]
  }
] as const satisfies readonly McpToolRegistryEntry[];

export type McpToolName = (typeof MCP_TOOL_REGISTRY)[number]["name"];
export type McpToolCatalogEntry = Pick<McpToolRegistryEntry, "name" | "tier" | "phase" | "writeEffects" | "readOnly" | "useWhen" | "avoidWhen" | "nextToolUse">;

export const MCP_TOOL_CATALOG = MCP_TOOL_REGISTRY.map(({ name, tier, phase, writeEffects, readOnly, useWhen, avoidWhen, nextToolUse }) => ({
  name,
  tier,
  phase,
  writeEffects,
  readOnly,
  useWhen,
  avoidWhen,
  nextToolUse
})) as readonly McpToolCatalogEntry[];

export const MCP_TOOL_NAMES = Object.freeze(MCP_TOOL_REGISTRY.map((tool) => tool.name));
export const PRIMARY_MCP_TOOL_NAMES = Object.freeze(MCP_TOOL_REGISTRY.filter((tool) => tool.tier === "primary").map((tool) => tool.name));
export const ADVANCED_MCP_TOOL_NAMES = Object.freeze(MCP_TOOL_REGISTRY.filter((tool) => tool.tier === "advanced").map((tool) => tool.name));
export const SOURCE_CONTEXT_MCP_TOOL_NAMES = Object.freeze(MCP_TOOL_REGISTRY.filter((tool) => tool.writeEffects === "index-cache-if-auto-refresh").map((tool) => tool.name));
export const MEMORY_RECORDING_MCP_TOOL_NAMES = Object.freeze(MCP_TOOL_REGISTRY.filter((tool) => tool.writeEffects === "session-memory-auto").map((tool) => tool.name));
export const PRIMARY_CODEX_LOOP = "session_context -> search(if target unclear) -> task_brief -> change_plan(saveSnapshot) -> post_edit_review -> test_plan";
export const NO_SOURCE_MUTATION_CONTRACT = "Codexa MCP tools may write Codexa cache artifacts, but must not mutate source files.";

export function mcpToolRegistryEntry(name: string): McpToolRegistryEntry | undefined {
  return MCP_TOOL_REGISTRY.find((tool) => tool.name === name);
}
