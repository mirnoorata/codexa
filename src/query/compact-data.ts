import type { RetrievalResult } from "../retrieval.js";
import type { ChangedSymbol, DiffImpactGroup, FileFact, SymbolFact, WorkflowTraceFact } from "../types.js";

export function compactFileFact(file: FileFact): Pick<FileFact, "path" | "language" | "dirty" | "generated" | "test" | "rank" | "symbolCount" | "usageCount" | "importCount" | "riskScore"> {
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

export function compactSymbolFact(symbol: SymbolFact): Pick<SymbolFact, "path" | "name" | "qualifiedName" | "kind" | "language" | "range" | "confidence"> {
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

export function compactChangedSymbol(entry: ChangedSymbol): { symbol: ReturnType<typeof compactSymbolFact>; changedLines: string[] } {
  return {
    symbol: compactSymbolFact(entry.symbol),
    changedLines: entry.changedLines.slice(0, 12)
  };
}

export function compactDiffGroup(group: DiffImpactGroup): Omit<DiffImpactGroup, "changedSymbols"> & { changedSymbols: ReturnType<typeof compactChangedSymbol>[] } {
  return {
    ...group,
    files: group.files.slice(0, 40),
    unindexedFiles: group.unindexedFiles.slice(0, 20),
    changedSymbols: group.changedSymbols.slice(0, 20).map(compactChangedSymbol)
  };
}

export function compactWorkflowTrace(workflow: WorkflowTraceFact): Pick<WorkflowTraceFact, "id" | "workflowKind" | "title" | "entryPath" | "entrySymbolId" | "relatedFiles" | "tests" | "rank" | "confidence" | "summary"> & { steps: WorkflowTraceFact["steps"] } {
  return {
    id: workflow.id,
    workflowKind: workflow.workflowKind,
    title: workflow.title,
    entryPath: workflow.entryPath,
    entrySymbolId: workflow.entrySymbolId,
    steps: workflow.steps.slice(0, 16),
    relatedFiles: workflow.relatedFiles.slice(0, 40),
    tests: workflow.tests.slice(0, 20),
    rank: workflow.rank,
    confidence: workflow.confidence,
    summary: workflow.summary
  };
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
