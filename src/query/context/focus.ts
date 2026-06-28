import path from "node:path";
import { isTestPath } from "../../language.js";
import type { IntentConfidence, RetrievalMatch, RetrievalResult, TaskIntent } from "../../retrieval.js";
import type { ChangedSymbol, CodexaIndex, DiffImpactGroup, EvidenceTier, FileFact } from "../../types.js";
import { uniqueSorted } from "../../util.js";
import { betterTier, confidenceTier, formatReasons, tierScore } from "../formatting.js";
import { matchReason, matchScore } from "../search.js";
import { findFile, resolveFileTarget, resolveSymbolTarget } from "../targets.js";
import { isCodexaControlPath } from "../worktree.js";
import type { WorktreeState } from "../worktree-state.js";

export type FocusSelectionEntry = { file: FileFact; score: number; reasons: string[]; matchedTerms: string[]; tier: EvidenceTier };
export type ContextSourceKind = "explicit_target" | "natural_retrieval" | "lexical_query" | "dirty_worktree" | "graph_impact" | "workflow_trace" | "test_evidence" | "rank_fallback";
export type ContextSourceProvenance = { source: ContextSourceKind; reason: string; tier: EvidenceTier };
export type PacketFocusEntry = { file: FileFact; reasons: Set<string>; rank: number; tier: EvidenceTier; provenance: ContextSourceProvenance[] };
export type ContextFocusState = {
  focus: Map<string, PacketFocusEntry>;
  impactSeeds: Map<string, string>;
  addFocus: (filePath: string, reason: string, rank?: number, tier?: EvidenceTier, source?: ContextSourceKind) => void;
};
export type ContextSourceSummary = {
  source: ContextSourceKind;
  fileCount: number;
  evidenceTierCounts: Record<EvidenceTier, number>;
  sampleFiles: string[];
  sampleReasons: string[];
};
export type DirtyScopeSummary = {
  requested: boolean;
  mode: "edit" | "orientation";
  canPlan: boolean;
  broad: boolean;
  changedFileCount: number;
  representativeCount: number;
  plannedEditTargets: string[];
  reason: string;
};

export function createContextFocusState(index: CodexaIndex, warnings: string[]): ContextFocusState {
  const focus = new Map<string, PacketFocusEntry>();
  const impactSeeds = new Map<string, string>();
  const addFocus = (filePath: string, reason: string, rank = 1, tier: EvidenceTier = "derived", source?: ContextSourceKind) => {
    const file = findFile(index, filePath);
    if (!file) {
      warnings.push(`unindexed file ${filePath}`);
      return;
    }
    const existing = focus.get(file.path) ?? { file, reasons: new Set<string>(), rank: file.rank, tier, provenance: [] };
    existing.reasons.add(reason);
    const sources = source ? [source] : contextSourcesForReason(reason);
    for (const provenanceSource of sources.length > 0 ? sources : ["rank_fallback" as const]) {
      const provenanceTier = provenanceSource === "lexical_query" && tier === "authoritative" ? "derived" : tier;
      if (!existing.provenance.some((entry) => entry.source === provenanceSource && entry.reason === reason && entry.tier === provenanceTier)) {
        existing.provenance.push({ source: provenanceSource, reason, tier: provenanceTier });
      }
    }
    existing.rank += rank;
    existing.tier = betterTier(existing.tier, tier);
    focus.set(file.path, existing);
  };
  return { focus, impactSeeds, addFocus };
}

export function addExplicitTargetsToContextFocus(input: {
  index: CodexaIndex;
  repoRoot: string;
  requestedFiles: string[];
  requestedSymbols: string[];
  focus: ContextFocusState;
  warnings: string[];
}): string[] {
  const requestedResolvedPaths: string[] = [];
  for (const requested of input.requestedFiles) {
    const resolved = resolveFileTarget(input.index, requested, input.repoRoot);
    if (resolved.ambiguous.length > 0) {
      input.warnings.push(`ambiguous file ${requested}`);
      continue;
    }
    if (resolved.file) {
      requestedResolvedPaths.push(resolved.file.path);
      input.focus.addFocus(resolved.file.path, "requested file", 100, "authoritative", "explicit_target");
      input.focus.impactSeeds.set(resolved.file.path, "requested file");
    } else {
      input.warnings.push(`missing file ${requested}`);
    }
  }

  for (const requested of input.requestedSymbols) {
    const resolved = resolveSymbolTarget(input.index, requested);
    if (resolved.ambiguous.length > 0) {
      input.warnings.push(`ambiguous symbol ${requested}`);
      continue;
    }
    if (resolved.symbol) {
      input.focus.addFocus(resolved.symbol.path, `requested symbol ${resolved.symbol.qualifiedName}`, 100, "authoritative", "explicit_target");
      input.focus.impactSeeds.set(resolved.symbol.path, `requested symbol ${resolved.symbol.qualifiedName}`);
      for (const usage of input.index.usageSites.filter((site) => site.targetSymbolId === resolved.symbol!.id).slice(0, 12)) {
        input.focus.addFocus(usage.path, `uses ${resolved.symbol.qualifiedName}`, 4, confidenceTier(usage.confidence), "graph_impact");
      }
    } else {
      input.warnings.push(`missing symbol ${requested}`);
    }
  }
  return requestedResolvedPaths;
}

export function addLexicalQueryFocus(index: CodexaIndex, queryText: string, addFocus: ContextFocusState["addFocus"]): void {
  for (const file of index.files) {
    const score = matchScore(queryText, file.path);
    if (score > 0) {
      addFocus(file.path, `path ${matchReason(score)} ${queryText}`, score, score >= 9 ? "derived" : "heuristic", "lexical_query");
    }
  }
  for (const symbol of index.symbols) {
    const score = Math.max(matchScore(queryText, symbol.name), matchScore(queryText, symbol.qualifiedName), matchScore(queryText, symbol.path));
    if (score > 0) {
      addFocus(symbol.path, `symbol ${matchReason(score)} ${symbol.qualifiedName}`, score + 1, score >= 9 ? confidenceTier(symbol.confidence) : "heuristic", "lexical_query");
    }
  }
  for (const usage of index.usageSites) {
    const score = Math.max(matchScore(queryText, usage.name), matchScore(queryText, usage.text), matchScore(queryText, usage.path));
    if (score > 0) {
      addFocus(usage.path, `usage ${matchReason(score)} ${usage.name}`, score, confidenceTier(usage.confidence), "lexical_query");
    }
  }
}

export function addNaturalRetrievalFocus(input: {
  naturalRetrieval: RetrievalResult;
  explicitTargetProvided: boolean;
  explicitConfigTarget: boolean;
  limit: number;
  focus: ContextFocusState;
}): void {
  const scoreScale = input.explicitTargetProvided ? 0.6 : 1;
  for (const match of input.naturalRetrieval.matches.slice(0, input.limit * 2)) {
    if (input.explicitTargetProvided && !shouldAddExplicitNaturalMatch(match, input.explicitConfigTarget)) {
      continue;
    }
    const testLaneBacked = Boolean((match.lanes.test ?? 0) > 0 && input.naturalRetrieval.intents.includes("testing") && !input.naturalRetrieval.intents.includes("implementation"));
    const laneBacked = Boolean((match.lanes.exact ?? 0) > 0 || (match.lanes.symbol ?? 0) > 0 || (match.lanes.workflow ?? 0) > 0 || testLaneBacked);
    input.focus.addFocus(
      match.file.path,
      `natural task retrieval ${match.matchedTerms.slice(0, 6).join(", ") || "intent"}: ${formatReasons(match.reasons, 3)}`,
      Math.max(2, match.score * scoreScale),
      laneBacked ? "derived" : "heuristic",
      "natural_retrieval"
    );
    if (laneBacked || match.score >= 4) {
      input.focus.impactSeeds.set(match.file.path, "natural task retrieval");
    }
  }
  if (!input.explicitTargetProvided) {
    for (const workflow of input.naturalRetrieval.workflows.slice(0, 4)) {
      for (const filePath of workflow.relatedFiles.slice(0, 6)) {
        input.focus.addFocus(filePath, `workflow ${workflow.title}`, Math.max(2, workflow.rank / 4), confidenceTier(workflow.confidence), "workflow_trace");
      }
    }
  }
}

export function addDirtyWorktreeFocus(input: {
  index: CodexaIndex;
  changed: string[];
  changedSymbols: ChangedSymbol[];
  groups: DiffImpactGroup[];
  indexedPaths: Set<string>;
  explicitFocusProvided: boolean;
  dirtyContextTask: boolean;
  limit: number;
  focus: ContextFocusState;
  warnings: string[];
}): { broadDirty: boolean; dirtyDrivesFocus: boolean } {
  const broadDirty = input.changed.length > Math.max(8, input.limit);
  const dirtyDrivesFocus = input.changed.length > 0 && (!input.explicitFocusProvided || !broadDirty);
  if (input.changed.length > 0 && input.explicitFocusProvided && broadDirty) {
    input.warnings.push(`broad dirty tree (${input.changed.length} files) kept as diff context, not read-first focus`);
  }
  if (!dirtyDrivesFocus) {
    return { broadDirty, dirtyDrivesFocus };
  }

  const dirtyRepresentativeLimit = input.dirtyContextTask ? Math.max(1, Math.min(2, Math.ceil(input.limit / 5))) : input.limit * 2;
  const dirtyRepresentativePaths = new Set<string>();
  if (input.dirtyContextTask) {
    for (const group of input.groups.slice(0, dirtyRepresentativeLimit)) {
      const representative = representativeFileForDiffGroup(input.index, group.files);
      if (representative) {
        dirtyRepresentativePaths.add(representative.path);
        input.focus.addFocus(representative.path, `change-group representative ${group.module}`, 12, group.kind === "unknown" ? "fallback" : "authoritative", "dirty_worktree");
        input.focus.impactSeeds.set(representative.path, `change-group representative ${group.module}`);
      }
    }
    if (dirtyRepresentativePaths.size === 0) {
      for (const file of input.changed.filter((candidate) => input.indexedPaths.has(candidate)).slice(0, dirtyRepresentativeLimit)) {
        dirtyRepresentativePaths.add(file);
        input.focus.addFocus(file, "dirty diff", 6, "authoritative", "dirty_worktree");
        input.focus.impactSeeds.set(file, "dirty diff");
      }
    }
  } else {
    for (const file of input.changed.filter((candidate) => input.indexedPaths.has(candidate)).slice(0, input.limit * 2)) {
      input.focus.addFocus(file, "dirty diff", 6, "authoritative", "dirty_worktree");
      input.focus.impactSeeds.set(file, "dirty diff");
    }
    for (const entry of input.changedSymbols.slice(0, input.limit * 2)) {
      input.focus.addFocus(entry.symbol.path, `changed symbol ${entry.symbol.qualifiedName}`, 6, "derived", "dirty_worktree");
      input.focus.impactSeeds.set(entry.symbol.path, `changed symbol ${entry.symbol.qualifiedName}`);
    }
  }
  for (const group of input.groups) {
    if (input.dirtyContextTask && dirtyRepresentativePaths.size >= dirtyRepresentativeLimit) {
      break;
    }
    const representative = representativeFileForDiffGroup(input.index, group.files);
    if (representative) {
      if (input.dirtyContextTask) {
        dirtyRepresentativePaths.add(representative.path);
      }
      input.focus.addFocus(representative.path, `change-group representative ${group.module}`, 5, group.kind === "unknown" ? "fallback" : "derived", "dirty_worktree");
    }
  }
  return { broadDirty, dirtyDrivesFocus };
}

export function summarizeContextSources(focusEntries: Array<{ file: FileFact; provenance: ContextSourceProvenance[] }>): ContextSourceSummary[] {
  const summaries = new Map<ContextSourceKind, { fileTiers: Map<string, EvidenceTier>; reasons: Set<string> }>();
  const add = (source: ContextSourceKind, filePath: string, tier: EvidenceTier, reason: string) => {
    const summary =
      summaries.get(source) ?? {
        fileTiers: new Map<string, EvidenceTier>(),
        reasons: new Set<string>()
      };
    summary.fileTiers.set(filePath, betterTier(summary.fileTiers.get(filePath) ?? "fallback", tier));
    summary.reasons.add(reason);
    summaries.set(source, summary);
  };

  for (const entry of focusEntries) {
    if (entry.provenance.length === 0) {
      add("rank_fallback", entry.file.path, "fallback", "ranked context selection");
      continue;
    }
    for (const provenance of entry.provenance) {
      add(provenance.source, entry.file.path, provenance.tier, provenance.reason);
    }
  }

  const priority: ContextSourceKind[] = ["explicit_target", "dirty_worktree", "natural_retrieval", "graph_impact", "workflow_trace", "test_evidence", "lexical_query", "rank_fallback"];
  return [...summaries.entries()]
    .map(([source, summary]) => {
      const evidenceTierCounts: Record<EvidenceTier, number> = { authoritative: 0, derived: 0, heuristic: 0, fallback: 0 };
      for (const tier of summary.fileTiers.values()) {
        evidenceTierCounts[tier] += 1;
      }
      return {
        source,
        fileCount: summary.fileTiers.size,
        evidenceTierCounts,
        sampleFiles: [...summary.fileTiers.keys()].sort().slice(0, 6),
        sampleReasons: [...summary.reasons].sort().slice(0, 6)
      };
    })
    .sort((a, b) => priority.indexOf(a.source) - priority.indexOf(b.source) || b.fileCount - a.fileCount || a.source.localeCompare(b.source));
}

export function contextSourcesForReason(reason: string): ContextSourceKind[] {
  const lower = reason.toLowerCase();
  if (lower.startsWith("likely test")) {
    return ["test_evidence"];
  }
  const sources: ContextSourceKind[] = [];
  if (lower === "requested file" || lower.startsWith("requested symbol ")) {
    sources.push("explicit_target");
  }
  if (lower.includes("dirty diff") || lower.includes("changed symbol") || lower.includes("change-group representative")) {
    sources.push("dirty_worktree");
  }
  if (lower.includes("natural task retrieval")) {
    sources.push("natural_retrieval");
  }
  if (lower.includes("impact from") || lower.includes("imports ") || lower.includes("uses ") || lower.includes("call ") || lower.includes("reference ")) {
    sources.push("graph_impact");
  }
  if (lower.startsWith("workflow ") || lower.includes("workflow entry") || lower.includes("workflow test candidate")) {
    sources.push("workflow_trace");
  }
  if (lower.includes("likely test") || lower.includes("tests ")) {
    sources.push("test_evidence");
  }
  if (lower.startsWith("path ") || lower.startsWith("symbol ") || lower.startsWith("usage ")) {
    sources.push("lexical_query");
  }
  if (lower.includes("top-ranked fallback") || lower.includes("ranked project entry point")) {
    sources.push("rank_fallback");
  }
  return sources;
}

export function formatContextSources(sources: ContextSourceSummary[]): string {
  return sources
    .slice(0, 8)
    .map((source) => {
      const tiers = (["authoritative", "derived", "heuristic", "fallback"] as EvidenceTier[])
        .map((tier) => (source.evidenceTierCounts[tier] > 0 ? `${source.evidenceTierCounts[tier]} ${tier}` : undefined))
        .filter((entry): entry is string => Boolean(entry))
        .join(", ");
      return `${source.source} ${source.fileCount} file${source.fileCount === 1 ? "" : "s"}${tiers ? ` (${tiers})` : ""}`;
    })
    .join("; ");
}

export function representativeFileForDiffGroup(index: CodexaIndex, files: string[]): FileFact | undefined {
  return files
    .map((filePath) => findFile(index, filePath))
    .filter((file): file is FileFact => Boolean(file))
    .sort((a, b) => b.riskScore - a.riskScore || b.rank - a.rank || a.path.localeCompare(b.path))[0];
}

export function shouldRunNaturalRetrieval(explicitTargetProvided: boolean, explicitConfigTarget: boolean, taskIntents: TaskIntent[]): boolean {
  if (!explicitTargetProvided) {
    return true;
  }
  if (!explicitConfigTarget) {
    return false;
  }
  return taskIntents.some((intent) => intent === "configuration" || intent === "testing" || intent === "implementation");
}

export function focusMatchTier(file: FileFact, task: string, match?: RetrievalMatch): EvidenceTier {
  const lowerTask = task.toLowerCase();
  const lowerPath = file.path.toLowerCase();
  const baseName = path.posix.basename(lowerPath);
  const stem = baseName.replace(/\.[^.]+$/u, "");
  if (lowerTask.includes(lowerPath) || lowerTask.includes(baseName) || (stem.length >= 4 && lowerTask.includes(stem))) {
    return "derived";
  }
  if (match && ((match.lanes.exact ?? 0) > 0 || (match.lanes.symbol ?? 0) > 0 || (match.lanes.workflow ?? 0) > 0 || (match.lanes.dirty ?? 0) > 0)) {
    return "derived";
  }
  if (match && (match.lanes.test ?? 0) > 0 && taskAsksForTests(task)) {
    return "derived";
  }
  return "heuristic";
}

export function workflowFocusEntries(
  index: CodexaIndex,
  workflows: RetrievalResult["workflows"],
  task: string,
  limit: number
): FocusSelectionEntry[] {
  const includeTests = taskAsksForTests(task);
  const entries: FocusSelectionEntry[] = [];
  const scopedWorkflows = preferredWorkflowsForTask(workflows, task);
  const add = (filePath: string | undefined, score: number, reason: string, tier: EvidenceTier) => {
    if (!filePath) {
      return;
    }
    const file = findFile(index, filePath);
    if (!file) {
      return;
    }
    if ((file.test || isTestPath(file.path)) && !includeTests) {
      return;
    }
    entries.push({
      file,
      score,
      reasons: [reason],
      matchedTerms: [],
      tier
    });
  };
  for (const workflow of scopedWorkflows.slice(0, Math.max(1, Math.min(3, limit)))) {
    const tier = confidenceTier(workflow.confidence);
    add(workflow.entryPath, 90 + workflow.rank, `workflow entry ${workflow.title}`, tier);
    for (const step of workflow.steps.slice(0, 24)) {
      const stepTier = confidenceTier(step.confidence);
      const score =
        step.kind === "entry"
          ? 85
          : step.kind === "endpoint" || step.kind === "ui"
            ? 72
            : step.kind === "store" || step.kind === "adapter" || step.kind === "manifest"
              ? 68
              : step.kind === "test"
                ? 62
                : step.kind === "call" || step.kind === "reference" || step.kind === "import"
                  ? 58
                  : 36;
      add(step.path, score, `workflow ${workflow.title}: ${step.kind}`, stepTier);
      add(step.targetPath, Math.max(20, score - 8), `workflow ${workflow.title}: target ${step.kind}`, stepTier);
    }
    for (const filePath of workflow.relatedFiles.slice(0, 12)) {
      add(filePath, 45, `workflow related ${workflow.title}`, tier);
    }
  }
  return entries;
}

export function preferredWorkflowsForTask(
  workflows: RetrievalResult["workflows"],
  task: string
): RetrievalResult["workflows"] {
  const lower = task.toLowerCase();
  const preferredKinds = new Set<string>();
  if (/\b(route|routes|endpoint|endpoints|api|request|handler|backend)\b/u.test(lower)) {
    preferredKinds.add("route");
  }
  if (/\b(job|jobs|queue|worker|task|tasks|background|celery|polling)\b/u.test(lower)) {
    preferredKinds.add("job");
  }
  if (/\b(manifest|node|nodes|adapter|package|registry)\b/u.test(lower)) {
    preferredKinds.add("manifest");
  }
  if (preferredKinds.size === 0) {
    return workflows;
  }
  const narrowed = workflows.filter((workflow) => preferredKinds.has(workflow.workflowKind));
  return narrowed.length > 0 ? narrowed : workflows;
}

export function hasExactRetrievalLane(match: RetrievalMatch): boolean {
  return Boolean((match.lanes.exact ?? 0) > 0);
}

export function taskAsksForTests(task: string): boolean {
  return /\b(test|tests|spec|specs|pytest|vitest|coverage|verification|verify|tested)\b/iu.test(task);
}

export function exactFocusFileMatches(index: { files: FileFact[] }, task: string): FileFact[] {
  const lowerTask = task.toLowerCase();
  return index.files
    .filter((file) => {
      const lowerPath = file.path.toLowerCase();
      const baseName = path.posix.basename(lowerPath);
      return lowerTask.includes(lowerPath) || lowerTask.includes(baseName);
    })
    .sort((a, b) => b.rank - a.rank || a.path.localeCompare(b.path));
}

export function isConfigExpansionPath(filePath: string): boolean {
  return (
    /^manifests?\//u.test(filePath) ||
    /(^|\/)(package|manifest|node|adapter)[^/]*\.(json|ya?ml|toml)$/iu.test(filePath) ||
    /\.(json|ya?ml|toml)$/iu.test(filePath)
  );
}

export function shouldAddExplicitNaturalMatch(match: RetrievalMatch, explicitConfigTarget: boolean): boolean {
  if (!explicitConfigTarget) {
    return false;
  }
  const laneBacked = Boolean((match.lanes.exact ?? 0) > 0 || (match.lanes.symbol ?? 0) > 0 || (match.lanes.bm25 ?? 0) > 0);
  if (!laneBacked) {
    return false;
  }
  const evidenceText = `${match.file.path} ${match.reasons.join(" ")}`.toLowerCase();
  return /\b(adapter|manifest|node|type_id|node_type)\b/u.test(evidenceText) || /(^|\/)adapters?\//u.test(match.file.path);
}

export function dirtyScopeSummary(input: {
  taskIntents: TaskIntent[];
  changed: string[];
  worktree: WorktreeState | undefined;
  broadDirty: boolean;
  focusEntries: PacketFocusEntry[];
}): DirtyScopeSummary {
  const mode = dirtyScopeMode(input.taskIntents);
  const changedPlanFiles = uniqueSorted(input.changed.filter((filePath) => !isCodexaControlPath(filePath)));
  const degraded = input.worktree?.degraded ?? false;
  const canPlan = changedPlanFiles.length > 0 && !degraded;
  const reason = degraded
    ? `worktree state unavailable: ${input.worktree?.degradedReasons.join("; ") || "unknown"}`
    : changedPlanFiles.length === 0
      ? "no dirty files available for the requested dirty-worktree scope"
      : mode === "edit"
        ? "current dirty worktree is the explicit edit scope"
        : "current dirty worktree is the explicit inspection scope";
  return {
    requested: true,
    mode,
    canPlan,
    broad: input.broadDirty,
    changedFileCount: changedPlanFiles.length,
    representativeCount: input.focusEntries.filter((entry) => entry.provenance.some((item) => item.source === "dirty_worktree")).length,
    plannedEditTargets: changedPlanFiles,
    reason
  };
}

export function dirtyScopeMode(taskIntents: TaskIntent[]): "edit" | "orientation" {
  return taskIntents.some((intent) => intent === "implementation" || intent === "debugging") ? "edit" : "orientation";
}

export function dirtyWorktreeIntentConfidence(input: {
  taskIntents: TaskIntent[];
  dirtyScope: DirtyScopeSummary;
  focusEntries: PacketFocusEntry[];
  worktree: WorktreeState | undefined;
}): IntentConfidence {
  const primaryIntent = input.taskIntents.find((intent) => intent !== "unknown") ?? "unknown";
  const dirtyAnchors = uniqueSorted(
    input.focusEntries
      .filter((entry) => entry.provenance.some((item) => item.source === "dirty_worktree"))
      .map((entry) => entry.file.path)
  ).slice(0, 8);
  const missingAnchors: string[] = [];
  if (input.dirtyScope.changedFileCount === 0) {
    missingAnchors.push("no dirty files");
  }
  if (input.worktree?.degraded) {
    missingAnchors.push("worktree state unavailable");
  }
  if (input.dirtyScope.mode === "edit" && dirtyAnchors.length === 0) {
    missingAnchors.push("no selected dirty-worktree anchors");
  }
  const confidence = Math.max(
    0,
    Math.min(
      1,
      0.46 +
        Math.min(0.24, dirtyAnchors.length * 0.06) +
        (input.dirtyScope.canPlan ? 0.18 : 0) -
        (input.dirtyScope.broad ? 0.08 : 0) -
        missingAnchors.length * 0.2
    )
  );
  const editReady = input.dirtyScope.mode === "edit" && input.dirtyScope.canPlan && dirtyAnchors.length > 0 && missingAnchors.length === 0 && confidence >= 0.48;
  const verdict: IntentConfidence["verdict"] =
    editReady
      ? "edit-ready"
      : input.dirtyScope.mode === "orientation" && dirtyAnchors.length > 0 && !input.worktree?.degraded
        ? "orientation-only"
        : "needs-target";
  const recommendedNextTool = verdict === "edit-ready" ? "change_plan" : verdict === "orientation-only" ? "diff_impact" : "search";
  return {
    mode: input.dirtyScope.mode,
    intent: primaryIntent,
    confidence,
    anchors: dirtyAnchors,
    selectedAnchorCount: dirtyAnchors.length,
    discardedAnchorCount: Math.max(0, input.dirtyScope.changedFileCount - dirtyAnchors.length),
    missingAnchors: uniqueSorted(missingAnchors),
    recommendedNextTool,
    editReady,
    verdict,
    reasons: uniqueSorted([
      `mode ${input.dirtyScope.mode}`,
      `primary intent ${primaryIntent}`,
      "explicit dirty-worktree scope",
      `${input.dirtyScope.changedFileCount} dirty file(s)`,
      input.dirtyScope.broad ? "broad dirty tree represented by ranked change groups" : undefined,
      dirtyAnchors.length > 0 ? `${dirtyAnchors.length} selected dirty-worktree anchor(s)` : "no selected dirty-worktree anchors",
      ...missingAnchors.map((anchor) => `missing ${anchor}`)
    ].filter((entry): entry is string => Boolean(entry)))
  };
}

export function packetIntentConfidence(
  base: IntentConfidence,
  focusEntries: PacketFocusEntry[],
  options: { explicitTargetProvided: boolean; dirtyAnchorAllowed: boolean }
): IntentConfidence {
  const focusPathSet = new Set(focusEntries.map((entry) => entry.file.path));
  const allowTestAnchors = options.explicitTargetProvided || base.intent === "testing";
  const selectedBaseAnchors = base.anchors.filter((anchor) => focusPathSet.has(anchor));
  const evidenceEntries = focusEntries
    .filter((entry) => entry.tier === "authoritative" || entry.tier === "derived")
    .filter((entry) => entry.reasons.size > 0);
  const strongEvidenceAnchors = evidenceEntries
    .filter((entry) => isStrongPacketAnchor(entry, options.dirtyAnchorAllowed))
    .filter((entry) => allowTestAnchors || (!entry.file.test && !isTestPath(entry.file.path)))
    .map((entry) => entry.file.path);
  const anchors = uniqueSorted([...selectedBaseAnchors, ...strongEvidenceAnchors]).slice(0, 8);
  const nonTestEvidenceCount = evidenceEntries.filter((entry) => !entry.file.test && !isTestPath(entry.file.path)).length;
  const selectedTestOnlyAnchorCount =
    allowTestAnchors || anchors.length > 0 || nonTestEvidenceCount > 0
      ? 0
      : evidenceEntries.filter((entry) => entry.file.test || isTestPath(entry.file.path)).length;
  const discardedAnchorCount = base.anchors.filter((anchor) => !focusPathSet.has(anchor)).length;
  const missingAnchors = base.missingAnchors.filter((reason) => {
    if (anchors.length > 0 && (reason === "no authoritative or derived edit anchor" || reason === "broad prompt matched only weak lexical evidence")) {
      return false;
    }
    if (selectedTestOnlyAnchorCount === 0 && reason === "only test anchors for edit prompt") {
      return false;
    }
    return true;
  });
  if (base.mode === "edit" && anchors.length === 0 && !missingAnchors.includes("no selected packet anchors")) {
    missingAnchors.push("no selected packet anchors");
  }
  if (base.mode === "edit" && selectedTestOnlyAnchorCount > 0 && !missingAnchors.includes("only test anchors for edit prompt")) {
    missingAnchors.push("only test anchors for edit prompt");
  }
  const confidence = Math.max(
    0,
    Math.min(
      1,
      base.confidence +
        Math.min(0.16, anchors.length * 0.03) +
        (options.explicitTargetProvided && anchors.length > 0 ? 0.08 : 0) +
        (options.dirtyAnchorAllowed && anchors.length > 0 ? 0.05 : 0) -
        Math.min(0.3, discardedAnchorCount * 0.05) -
        (missingAnchors.length - base.missingAnchors.length) * 0.18
    )
  );
  const editReady = base.mode === "edit" && missingAnchors.length === 0 && anchors.length > 0 && confidence >= 0.48;
  const rawSearchBetter = missingAnchors.includes("broad prompt matched only weak lexical evidence") || missingAnchors.includes("only test anchors for edit prompt");
  const verdict =
    editReady ? "edit-ready" : rawSearchBetter || confidence < 0.24 ? "raw-search-better" : base.mode === "orientation" && confidence >= 0.3 && anchors.length > 0 ? "orientation-only" : "needs-target";
  return {
    ...base,
    confidence,
    anchors,
    selectedAnchorCount: anchors.length,
    discardedAnchorCount,
    missingAnchors: uniqueSorted(missingAnchors),
    editReady,
    verdict,
    recommendedNextTool: verdict === "edit-ready" ? (base.mode === "edit" ? "task_brief" : "find_context") : verdict === "orientation-only" ? "find_context" : "search",
    reasons: uniqueSorted([
      ...base.reasons.filter((reason) => !/direct anchor/.test(reason)),
      anchors.length > 0 ? `${anchors.length} selected packet anchor(s)` : "no selected packet anchors",
      discardedAnchorCount > 0 ? `${discardedAnchorCount} discarded retrieval anchor(s) not shown in packet` : undefined
    ].filter((entry): entry is string => Boolean(entry)))
  };
}

export function isStrongPacketAnchor(entry: PacketFocusEntry, dirtyAnchorAllowed: boolean): boolean {
  if (entry.provenance.some((item) => item.source === "explicit_target")) {
    return true;
  }
  if (dirtyAnchorAllowed && entry.provenance.some((item) => item.source === "dirty_worktree")) {
    return true;
  }
  return false;
}

export function taskReferencesDirtyContext(task: string): boolean {
  return /\b(current|dirty|diff|worktree|working tree|changed|changes|unstaged|staged|this change|these changes)\b/iu.test(task);
}

export function packetIntentDiagnostics(intent: IntentConfidence, baseDiagnostics: string[]): string[] {
  if (intent.editReady) {
    return [];
  }
  const diagnostics = baseDiagnostics.filter(
    (diagnostic) => !/needs explicit file|raw search likely|broad packet|only test anchors/iu.test(diagnostic)
  );
  if (intent.verdict === "needs-target") {
    diagnostics.push("needs explicit file, symbol, or narrower search before edit planning");
  }
  if (intent.verdict === "raw-search-better") {
    diagnostics.push("raw search likely gives a cleaner first pass than this broad packet");
  }
  for (const anchor of intent.missingAnchors) {
    diagnostics.push(`missing ${anchor}`);
  }
  return uniqueSorted(diagnostics);
}

export function actionabilityFromPacketVerdict(verdict: string): string {
  if (verdict === "edit-ready") {
    return "edit_ready";
  }
  if (verdict === "orientation-only") {
    return "orientation";
  }
  if (verdict === "raw-search-better") {
    return "raw_search_better";
  }
  if (verdict === "needs-target") {
    return "needs_target";
  }
  return "inspect_first";
}

export function qualityLikeFallbackActionability(entries: Array<{ tier: EvidenceTier }>): string {
  if (entries.length === 0 || entries.every((entry) => entry.tier === "fallback")) {
    return "needs_target";
  }
  return "inspect_first";
}

export function uniqueFocusEntries<T extends { file: FileFact; score: number; tier: EvidenceTier }>(entries: T[]): T[] {
  const byPath = new Map<string, T>();
  for (const entry of entries.sort((a, b) => tierScore(a.tier) - tierScore(b.tier) || b.score - a.score || a.file.path.localeCompare(b.file.path))) {
    if (!byPath.has(entry.file.path)) {
      byPath.set(entry.file.path, entry);
    }
  }
  return [...byPath.values()];
}
