import type { CodexaIndex, GraphEdgeFact, RiskSignalFact, SymbolFact, TestEdgeFact, UsageSiteFact } from "../types.js";

export interface WorkflowEvidenceIndex {
  symbolsById: Map<string, SymbolFact>;
  usagesByUsedBySymbolId: Map<string, UsageSiteFact[]>;
  usagesByTargetSymbolId: Map<string, UsageSiteFact[]>;
  usagesByName: Map<string, UsageSiteFact[]>;
  usageOrder: Map<UsageSiteFact, number>;
  risksByPath: Map<string, RiskSignalFact[]>;
  graphEdgesByFromSymbolId: Map<string, GraphEdgeFact[]>;
  graphEdgesByToId: Map<string, GraphEdgeFact[]>;
  graphEdgesByFromPath: Map<string, GraphEdgeFact[]>;
  graphEdgeOrder: Map<GraphEdgeFact, number>;
  testEdgesByTargetPath: Map<string, TestEdgeFact[]>;
  testEdgesByPath: Map<string, TestEdgeFact[]>;
}

export function buildWorkflowEvidenceIndex(index: CodexaIndex): WorkflowEvidenceIndex {
  const evidence: WorkflowEvidenceIndex = {
    symbolsById: new Map(index.symbols.map((symbol) => [symbol.id, symbol])),
    usagesByUsedBySymbolId: new Map(),
    usagesByTargetSymbolId: new Map(),
    usagesByName: new Map(),
    usageOrder: new Map(),
    risksByPath: new Map(),
    graphEdgesByFromSymbolId: new Map(),
    graphEdgesByToId: new Map(),
    graphEdgesByFromPath: new Map(),
    graphEdgeOrder: new Map(),
    testEdgesByTargetPath: new Map(),
    testEdgesByPath: new Map()
  };
  for (const [order, usage] of index.usageSites.entries()) {
    evidence.usageOrder.set(usage, order);
    if (usage.usedBySymbolId) appendIndexed(evidence.usagesByUsedBySymbolId, usage.usedBySymbolId, usage);
    if (usage.targetSymbolId) appendIndexed(evidence.usagesByTargetSymbolId, usage.targetSymbolId, usage);
    appendIndexed(evidence.usagesByName, usage.name, usage);
  }
  for (const risk of index.risks) appendIndexed(evidence.risksByPath, risk.path, risk);
  for (const [order, edge] of index.graphEdges.entries()) {
    evidence.graphEdgeOrder.set(edge, order);
    if (edge.fromSymbolId) appendIndexed(evidence.graphEdgesByFromSymbolId, edge.fromSymbolId, edge);
    if (edge.fromPath) appendIndexed(evidence.graphEdgesByFromPath, edge.fromPath, edge);
    appendIndexed(evidence.graphEdgesByToId, edge.toId, edge);
  }
  for (const edge of index.testEdges) {
    appendIndexed(evidence.testEdgesByPath, edge.path, edge);
    if (edge.targetPath) appendIndexed(evidence.testEdgesByTargetPath, edge.targetPath, edge);
  }
  return evidence;
}

function appendIndexed<K, V>(index: Map<K, V[]>, key: K, value: V): void {
  const entries = index.get(key);
  if (entries) entries.push(value);
  else index.set(key, [value]);
}
