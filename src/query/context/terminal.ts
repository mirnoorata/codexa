import type { IntentConfidence } from "../../retrieval.js";
import type { FreshnessInfo, QueryResult, RefreshInfo } from "../../types.js";
import { freshnessBanner } from "../runtime.js";
import type { ContextQuality } from "../quality.js";

export function terminalNoReadQuality(reason: string): ContextQuality {
  return {
    level: "high",
    recommendation: "The requested scope is authoritative and requires no indexed source read.",
    reasons: [reason],
    counts: { authoritative: 1, derived: 0, heuristic: 0, fallback: 0 }
  };
}

function terminalIntent(intent: IntentConfidence, targetPaths: string[], editReady: boolean, reason: string): IntentConfidence {
  return {
    ...intent,
    mode: editReady ? "edit" : "orientation",
    confidence: Math.max(intent.confidence, editReady ? 0.9 : 1),
    anchors: targetPaths.slice(0, 8),
    selectedAnchorCount: targetPaths.length,
    discardedAnchorCount: 0,
    missingAnchors: [],
    recommendedNextTool: "none",
    editReady,
    verdict: editReady ? "edit-ready" : "orientation-only",
    reasons: [...new Set([...intent.reasons, reason])]
  };
}

export function terminalFocusBriefResult(input: {
  freshness: FreshnessInfo;
  refresh?: RefreshInfo;
  task: string;
  intent: IntentConfidence;
  targetPaths: string[];
  reason: string;
}): QueryResult {
  const intent = terminalIntent(input.intent, input.targetPaths, input.targetPaths.length > 0, input.reason);
  const quality = terminalNoReadQuality(input.reason);
  const handoff = input.targetPaths.length > 0
    ? "No indexed source read is required; proceed with the named new target and stop Codexa."
    : "Codexa handoff: the worktree is clean; stop Codexa.";
  return {
    freshness: input.freshness,
    refresh: input.refresh,
    text: [freshnessBanner(input.freshness, input.refresh), "Codexa focus brief", `Task: ${input.task}`, `Actionability: ${intent.editReady ? "edit_ready" : "orientation"}`, handoff].join("\n"),
    data: {
      mode: "focus_brief",
      task: input.task,
      intentConfidence: intent,
      packetVerdict: intent.verdict,
      actionability: intent.editReady ? "edit_ready" : "orientation",
      diagnostics: [input.reason],
      focusFiles: [], workflows: [], modules: [], groups: [], tests: [], targetCandidates: [], unresolvedTargets: [],
      nextCall: { tool: "none", reason: handoff },
      retrieval: { intentConfidence: intent, semantic: { status: "disabled", diagnostics: [] } },
      quality,
      gaps: [],
      systemMessage: handoff
    }
  };
}

export function terminalContextPackResult(input: {
  freshness: FreshnessInfo;
  refresh?: RefreshInfo;
  task?: string;
  intent: IntentConfidence;
  targetPaths: string[];
  reason: string;
  dirtyScope?: unknown;
}): QueryResult {
  const intent = terminalIntent(input.intent, input.targetPaths, input.targetPaths.length > 0, input.reason);
  const quality = terminalNoReadQuality(input.reason);
  const handoff = input.targetPaths.length > 0
    ? "No indexed source read is required; proceed with the named new target and stop Codexa."
    : "Codexa handoff: the worktree is clean; stop Codexa.";
  return {
    freshness: input.freshness,
    refresh: input.refresh,
    text: [freshnessBanner(input.freshness, input.refresh), "Codexa context pack", input.task ? `Task: ${input.task}` : undefined, `Actionability: ${intent.editReady ? "edit_ready" : "orientation"}`, handoff].filter((line): line is string => Boolean(line)).join("\n"),
    data: {
      mode: "context_pack", task: input.task, focusFiles: [], changedFiles: [], changedEntries: [], changedSymbols: [], unindexedChanged: [], groups: [], tests: [], snippets: [], contextSources: [], warnings: [],
      dirtyScope: input.dirtyScope,
      intentConfidence: intent,
      packetVerdict: intent.verdict,
      actionability: intent.editReady ? "edit_ready" : "orientation",
      diagnostics: [input.reason],
      targetCandidates: [], unresolvedTargets: [], boundedPlanTargets: input.targetPaths, nextReads: [], nextTools: [],
      quality, gaps: [], systemMessage: handoff
    }
  };
}

export function terminalSearchResult(input: {
  freshness: FreshnessInfo;
  refresh?: RefreshInfo;
  query: string;
  intent: IntentConfidence;
  targetPaths: string[];
  reason: string;
}): QueryResult {
  const intent = terminalIntent(input.intent, input.targetPaths, true, input.reason);
  const quality = terminalNoReadQuality(input.reason);
  const handoff = "No indexed source read is required; proceed with the named new target and stop Codexa.";
  return {
    freshness: input.freshness,
    refresh: input.refresh,
    text: [freshnessBanner(input.freshness, input.refresh), `Search: ${input.query}`, "Actionability: edit_ready", handoff].join("\n"),
    data: {
      mode: "search", query: input.query, files: [], symbols: [], usageSites: [], tests: [], targetCandidates: [], unresolvedTargets: [],
      intentConfidence: intent, packetVerdict: intent.verdict, actionability: "edit_ready", diagnostics: [input.reason],
      nextTools: [], quality, gaps: [], systemMessage: handoff
    }
  };
}
