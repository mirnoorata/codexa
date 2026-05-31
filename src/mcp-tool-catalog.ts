export const MCP_TOOL_CATALOG = [
  { name: "session_context", tier: "primary", phase: "orientation", writeEffects: "session-memory-auto", readOnly: false, nextToolUse: ["task_brief", "search"] },
  { name: "task_brief", tier: "primary", phase: "brief", writeEffects: "session-memory-auto", readOnly: false, nextToolUse: ["change_plan"] },
  { name: "change_plan", tier: "primary", phase: "plan", writeEffects: "task-snapshot-cache", readOnly: false, nextToolUse: ["post_edit_review"] },
  { name: "post_edit_review", tier: "primary", phase: "review", writeEffects: "session-memory-auto", readOnly: false, nextToolUse: ["test_plan"] },
  { name: "test_plan", tier: "primary", phase: "verify", writeEffects: "session-memory-auto", readOnly: false, nextToolUse: [] },
  { name: "search", tier: "primary", phase: "inspect", writeEffects: "none", readOnly: true, nextToolUse: ["task_brief"] },
  { name: "workflow_path", tier: "advanced", phase: "inspect", writeEffects: "none", readOnly: true, nextToolUse: ["task_brief", "change_plan"] },
  { name: "freshness", tier: "advanced", phase: "diagnose", writeEffects: "none", readOnly: true, nextToolUse: ["task_brief"] },
  { name: "repo_map", tier: "advanced", phase: "orientation", writeEffects: "index-cache-if-auto-refresh", readOnly: false, nextToolUse: ["task_brief"] },
  { name: "find_context", tier: "advanced", phase: "inspect", writeEffects: "session-memory-auto", readOnly: false, nextToolUse: ["task_brief"] },
  { name: "context_pack", tier: "advanced", phase: "brief", writeEffects: "session-memory-auto", readOnly: false, nextToolUse: ["change_plan"] },
  { name: "focus_brief", tier: "advanced", phase: "orientation", writeEffects: "session-memory-auto", readOnly: false, nextToolUse: ["task_brief", "search"] },
  { name: "impact", tier: "advanced", phase: "inspect", writeEffects: "session-memory-auto", readOnly: false, nextToolUse: ["change_plan"] },
  { name: "diff_impact", tier: "advanced", phase: "inspect", writeEffects: "none", readOnly: true, nextToolUse: ["post_edit_review", "test_plan"] },
  { name: "symbol_context", tier: "advanced", phase: "inspect", writeEffects: "none", readOnly: true, nextToolUse: ["impact"] },
  { name: "callers", tier: "advanced", phase: "inspect", writeEffects: "none", readOnly: true, nextToolUse: ["impact"] },
  { name: "callees", tier: "advanced", phase: "inspect", writeEffects: "none", readOnly: true, nextToolUse: ["impact"] },
  { name: "dependency_path", tier: "advanced", phase: "inspect", writeEffects: "none", readOnly: true, nextToolUse: ["change_plan"] },
  { name: "placeholder_report", tier: "advanced", phase: "risk", writeEffects: "none", readOnly: true, nextToolUse: ["task_brief"] },
  { name: "session_memory", tier: "advanced", phase: "memory", writeEffects: "explicit-memory-cache", readOnly: false, nextToolUse: ["task_brief"] }
] as const;

export const PRIMARY_MCP_TOOL_NAMES = Object.freeze(MCP_TOOL_CATALOG.filter((tool) => tool.tier === "primary").map((tool) => tool.name));
export const ADVANCED_MCP_TOOL_NAMES = Object.freeze(MCP_TOOL_CATALOG.filter((tool) => tool.tier === "advanced").map((tool) => tool.name));
export const PRIMARY_CODEX_LOOP = "session_context -> task_brief -> change_plan(saveSnapshot) -> post_edit_review -> test_plan";
export const NO_SOURCE_MUTATION_CONTRACT = "Codexa MCP tools may write Codexa cache artifacts, but must not mutate source files.";
