import type { RetrievalResult } from "../retrieval.js";
import type { ChangedSymbol, CompactChangedSymbol, CompactDiffImpactGroup, CompactFileFact, CompactSymbolFact, DiffImpactGroup, FileFact, SymbolFact, WorkflowTraceFact } from "../types.js";

export function compactFileFact(file: FileFact): CompactFileFact {
  return {
    path: file.path,
    language: file.language,
    dirty: file.dirty,
    generated: file.generated,
    test: file.test,
    rank: file.rank,
    symbolCount: file.symbolCount,
    usageCount: file.usageCount,
    importCount: file.importCount,
    riskScore: file.riskScore
  };
}

export function compactSymbolFact(symbol: SymbolFact): CompactSymbolFact {
  return {
    path: symbol.path,
    name: symbol.name,
    qualifiedName: symbol.qualifiedName,
    kind: symbol.kind,
    language: symbol.language,
    range: symbol.range,
    confidence: symbol.confidence
  };
}

export function compactChangedSymbol(entry: ChangedSymbol): CompactChangedSymbol {
  return {
    symbol: compactSymbolFact(entry.symbol),
    changedLines: entry.changedLines.slice(0, 12)
  };
}

export function compactDiffGroup(group: DiffImpactGroup): CompactDiffImpactGroup {
  return {
    ...group,
    files: group.files.slice(0, 40),
    unindexedFiles: group.unindexedFiles.slice(0, 20),
    changedSymbols: group.changedSymbols.slice(0, 20).map(compactChangedSymbol)
  };
}

export function compactWorkflowTrace(workflow: WorkflowTraceFact): Pick<WorkflowTraceFact, "id" | "workflowKind" | "title" | "entryPath" | "entrySymbolId" | "relatedFiles" | "tests" | "rank" | "confidence" | "summary" | "truncation"> & { steps: WorkflowTraceFact["steps"] } {
  const steps = workflow.steps.slice(0, 16);
  const relatedFiles = workflow.relatedFiles.slice(0, 40);
  const tests = workflow.tests.slice(0, 20);
  return {
    id: workflow.id,
    workflowKind: workflow.workflowKind,
    title: workflow.title,
    entryPath: workflow.entryPath,
    entrySymbolId: workflow.entrySymbolId,
    steps,
    relatedFiles,
    tests,
    rank: workflow.rank,
    confidence: workflow.confidence,
    summary: workflow.summary,
    truncation: compactWorkflowTruncation(workflow, { steps: steps.length, relatedFiles: relatedFiles.length, tests: tests.length })
  };
}

function compactWorkflowTruncation(
  workflow: WorkflowTraceFact,
  returned: Record<"steps" | "relatedFiles" | "tests", number>
): WorkflowTraceFact["truncation"] {
  const truncation: NonNullable<WorkflowTraceFact["truncation"]> = {};
  for (const field of ["steps", "relatedFiles", "tests"] as const) {
    const sourceTotal = workflow[field].length;
    const priorTotal = validCount(workflow.truncation?.[field]?.total);
    const total = Math.max(sourceTotal, priorTotal ?? 0);
    if (total > returned[field]) truncation[field] = { total, returned: returned[field] };
  }
  const executionSurfaces = workflow.truncation?.executionSurfaces;
  const surfaceTotal = validCount(executionSurfaces?.total);
  const surfaceReturned = validCount(executionSurfaces?.returned);
  if (surfaceTotal !== undefined && surfaceReturned !== undefined && surfaceTotal > surfaceReturned) {
    truncation.executionSurfaces = { total: surfaceTotal, returned: surfaceReturned };
  }
  return Object.keys(truncation).length > 0 ? truncation : undefined;
}

function validCount(value: number | undefined): number | undefined {
  return Number.isSafeInteger(value) && (value ?? -1) >= 0 ? value : undefined;
}

export function compactRetrievalResult(retrieval: RetrievalResult): Omit<RetrievalResult, "matches" | "workflows" | "modules"> & {
  matches: Array<{ file: ReturnType<typeof compactFileFact>; score: number; reasons: string[]; matchedTerms: string[]; lanes: RetrievalResult["matches"][number]["lanes"] }>;
  workflows: ReturnType<typeof compactWorkflowTrace>[];
  modules: Array<{ name: string; score: number; files: string[]; reasons: string[] }>;
} {
  return {
    ...retrieval,
    matches: retrieval.matches.slice(0, 30).map((match) => ({
      file: compactFileFact(match.file),
      score: match.score,
      reasons: match.reasons.slice(0, 12),
      matchedTerms: match.matchedTerms.slice(0, 20),
      lanes: match.lanes
    })),
    workflows: retrieval.workflows.slice(0, 12).map(compactWorkflowTrace),
    modules: retrieval.modules.slice(0, 12).map((module) => ({
      name: module.name,
      score: module.score,
      files: module.files.slice(0, 40),
      reasons: module.reasons.slice(0, 12)
    }))
  };
}
