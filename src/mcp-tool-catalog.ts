export const MCP_TOOL_CATALOG = [
  {
    name: "session_context",
    tier: "primary",
    phase: "orientation",
    writeEffects: "session-memory-auto",
    readOnly: false,
    useWhen: "Start or resume work in a repo and choose the next focused Codexa call.",
    avoidWhen: "You already have an explicit file or symbol target; use task_brief instead.",
    nextToolUse: ["task_brief", "search"]
  },
  {
    name: "task_brief",
    tier: "primary",
    phase: "brief",
    writeEffects: "session-memory-auto",
    readOnly: false,
    useWhen: "First context call before editing, debugging, or reviewing a specific task.",
    avoidWhen: "The packet says raw_search_better or needs_target; narrow with search or explicit files first.",
    nextToolUse: ["change_plan"]
  },
  {
    name: "change_plan",
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
    tier: "primary",
    phase: "review",
    writeEffects: "session-memory-auto",
    readOnly: false,
    useWhen: "After edits, compare the dirty tree with the saved change_plan snapshot and ran commands.",
    avoidWhen: "Before editing or without a meaningful diff to review.",
    nextToolUse: ["test_plan"]
  },
  {
    name: "test_plan",
    tier: "primary",
    phase: "verify",
    writeEffects: "session-memory-auto",
    readOnly: false,
    useWhen: "Select verification for the current diff or after post_edit_review.",
    avoidWhen: "You need proof that tests ran; recommendations are not execution evidence.",
    nextToolUse: []
  },
  {
    name: "search",
    tier: "primary",
    phase: "inspect",
    writeEffects: "index-cache-if-auto-refresh",
    readOnly: false,
    useWhen: "Narrow ambiguous tasks, exact identifiers, or broad packets where raw search is likely better.",
    avoidWhen: "You need impact, workflow, or test proof; search is a locator, not a verifier.",
    nextToolUse: ["task_brief"]
  },
  {
    name: "workflow_path",
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
    tier: "advanced",
    phase: "memory",
    writeEffects: "explicit-memory-cache",
    readOnly: false,
    useWhen: "Read or write cache-only structured session memory for the current Codex workflow.",
    avoidWhen: "You need durable project docs or source changes.",
    nextToolUse: ["task_brief"]
  }
] as const;

export const PRIMARY_MCP_TOOL_NAMES = Object.freeze(MCP_TOOL_CATALOG.filter((tool) => tool.tier === "primary").map((tool) => tool.name));
export const ADVANCED_MCP_TOOL_NAMES = Object.freeze(MCP_TOOL_CATALOG.filter((tool) => tool.tier === "advanced").map((tool) => tool.name));
export const PRIMARY_CODEX_LOOP = "session_context -> task_brief -> change_plan(saveSnapshot) -> post_edit_review -> test_plan";
export const NO_SOURCE_MUTATION_CONTRACT = "Codexa MCP tools may write Codexa cache artifacts, but must not mutate source files.";
