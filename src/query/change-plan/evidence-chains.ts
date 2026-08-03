import type {
  ChangeEvidenceAnchorAuthority,
  ChangeEvidenceBundleV1,
  ChangeEvidenceChainV1,
  ChangeEvidencePurpose,
  ChangeEvidenceTestV1,
  CodexaIndex,
  Confidence,
  FreshnessInfo,
  GraphEdgeFact,
  TestRecommendation
} from "../../types.js";
import { CHANGE_EVIDENCE_LIMITS, CHANGE_EVIDENCE_TEXT_LIMITS } from "../../types.js";
import { stableId, uniqueSorted } from "../../util.js";
import { redactRepoPath } from "../../task-snapshot-storage.js";
import { edgeEvidenceForGraphEdges } from "../edge-evidence.js";
import { workflowMatchesAnyPath } from "../../workflow-membership.js";

const MAX_TARGETS = 8;
const MAX_START_NODES_PER_TARGET = 128;
const MAX_TERMINAL_CANDIDATES_PER_TARGET = 48;
const SUPPORT_EDGE_KINDS = new Set(["DEFINES", "EXPORTS", "TYPE_EXPORTS"]);
const WORKFLOW_EDGE_KINDS = new Set([
  "ROUTE",
  "JOB",
  "ROUTE_HANDLES",
  "ROUTE_CALLS_STORE",
  "STORE_DISPATCHES_ADAPTER",
  "ADAPTER_REFERENCED_BY_MANIFEST",
  "UI_CALLS_ENDPOINT"
]);

export interface ChangeEvidenceAnchorInput {
  path: string;
  symbolId?: string;
  candidateId?: string;
  authority: ChangeEvidenceAnchorAuthority;
}

export interface BuildChangeEvidenceInput {
  index: CodexaIndex;
  task?: string;
  anchors: ChangeEvidenceAnchorInput[];
  /** Existing edit authority; only chain-local members are copied, never inferred. */
  editTargets: string[];
  tests?: TestRecommendation[];
  freshness?: FreshnessInfo;
}

export function buildChangePlanEvidence(input: {
  index: CodexaIndex;
  task?: string;
  editable: boolean;
  editTargets: string[];
  candidates: Array<{ candidateId: string; path: string; symbol?: { id: string } }>;
  plannedTests: TestRecommendation[];
  fallbackTests: TestRecommendation[];
  freshness?: FreshnessInfo;
}): ChangeEvidenceBundleV1 {
  return buildChangeEvidenceChains({
    index: input.index,
    task: input.task,
    anchors: input.editable
      ? input.editTargets.map((path) => ({ path, authority: "explicit-target" as const }))
      : input.candidates.slice(0, 3).map((candidate) => ({
          candidateId: candidate.candidateId,
          path: candidate.path,
          symbolId: candidate.symbol?.id,
          authority: "orientation-candidate" as const
        })),
    editTargets: input.editTargets,
    tests: input.editable ? input.plannedTests : input.fallbackTests,
    freshness: input.freshness
  });
}

export function formatChangeEvidenceSection(bundle: ChangeEvidenceBundleV1): string[] {
  return ["Causal change evidence:", ...formatChangeEvidenceChains(bundle), ""];
}

interface AdjacencyEntry {
  edge: GraphEdgeFact;
  nextId: string;
  nextKind: GraphEdgeFact["fromKind"];
  nextPath?: string;
  traversedForward: boolean;
}

interface TraversalState {
  nodeId: string;
  depth: number;
  edges: GraphEdgeFact[];
  causalDirection?: "forward" | "reverse";
}

interface TerminalCandidate {
  anchor: ChangeEvidenceAnchorInput;
  anchorOrder: number;
  purpose: ChangeEvidencePurpose;
  terminalPath?: string;
  terminalLabel: string;
  edges: GraphEdgeFact[];
  confidence: Confidence;
  score: number;
}

interface EvidenceGraphCache {
  edgeIndex: CompactEvidenceEdgeIndex;
  indexedPaths: Set<string>;
  testPaths: Set<string>;
}

interface CompactEvidenceEdgeIndex {
  edges: GraphEdgeFact[];
  /** Encodes edgeIndex * 2 + reverseTraversalFlag. */
  references: Uint32Array;
}

export interface ChangeEvidenceGraphCacheFootprint {
  edgeCount: number;
  edgeReferenceCount: number;
  edgeReferenceBytes: number;
}

const evidenceGraphCaches = new WeakMap<CodexaIndex, EvidenceGraphCache>();

export function buildChangeEvidenceChains(input: BuildChangeEvidenceInput): ChangeEvidenceBundleV1 {
  const taskFingerprint = stableId("change-evidence-task-v1", normalizeTask(input.task));
  const graph = evidenceGraphCache(input.index);
  const requestedAnchors = dedupeAnchors(input.anchors);
  const anchors = requestedAnchors.filter((anchor) => graph.indexedPaths.has(anchor.path) && portableEvidencePath(anchor.path)).slice(0, MAX_TARGETS);
  const editTargets = uniqueInOrder(input.editTargets);
  const globalVisited = new Set<string>();
  let examinedEdges = 0;
  let capped = false;
  let candidateRetentionTruncated = false;
  let observedCandidateCount = 0;
  const candidates: TerminalCandidate[] = [];
  const gaps: string[] = [];
  const analyzedAnchors: ChangeEvidenceAnchorInput[] = [];

  for (const [anchorOrder, anchor] of anchors.entries()) {
    if (capped) break;
    analyzedAnchors.push(anchor);
    const starts = anchorStartNodes(input.index, anchor, graph.edgeIndex);
    if (starts.length === 0) {
      gaps.push(`no graph node is available for ${anchor.path}`);
      continue;
    }
    const queue: TraversalState[] = starts.map((nodeId) => ({ nodeId, depth: 0, edges: [] }));
    const bestDepth = new Map(starts.map((nodeId) => [traversalKey(nodeId), 0]));
    let anchorCandidates = new Map<string, TerminalCandidate>();
    const observedCandidateKeys = new Set<string>();
    let cursor = 0;
    while (cursor < queue.length && !capped) {
      const state = queue[cursor++];
      globalVisited.add(state.nodeId);
      if (globalVisited.size >= CHANGE_EVIDENCE_LIMITS.maxVisitedNodes) {
        capped = true;
        break;
      }
      if (state.depth >= CHANGE_EVIDENCE_LIMITS.maxDepth) continue;
      for (const entry of adjacencyEntries(graph.edgeIndex, state.nodeId)) {
        examinedEdges += 1;
        if (examinedEdges >= CHANGE_EVIDENCE_LIMITS.maxExaminedEdges) {
          capped = true;
          break;
        }
        if (state.edges.some((edge) => edge.id === entry.edge.id)) continue;
        const causalDirection = nextCausalDirection(state.causalDirection, entry);
        if (causalDirection === "invalid") continue;
        const edges = [...state.edges, entry.edge];
        if (!edges.every(portableEvidenceEdgePaths)) continue;
        const depth = state.depth + 1;
        const purpose = terminalPurpose(graph.testPaths, anchor, entry, edges);
        if (purpose && containsCausalEdge(edges)) {
          const terminalPath = meaningfulTerminalPath(anchor.path, entry);
          const confidence = weakestConfidence(edges.map((edge) => edge.confidence));
          const candidate = {
            anchor,
            anchorOrder,
            purpose,
            terminalPath,
            terminalLabel: terminalLabel(entry, terminalPath),
            edges,
            confidence,
            score: candidateScore(purpose, depth, confidence, entry)
          };
          const key = candidateKey(candidate);
          if (!observedCandidateKeys.has(key)) {
            observedCandidateKeys.add(key);
            observedCandidateCount += 1;
          }
          anchorCandidates = retainDiverseCandidate(anchorCandidates, candidate, MAX_TERMINAL_CANDIDATES_PER_TARGET);
          if (observedCandidateKeys.size > MAX_TERMINAL_CANDIDATES_PER_TARGET) candidateRetentionTruncated = true;
        }
        const nextKey = traversalKey(entry.nextId, causalDirection);
        const priorDepth = bestDepth.get(nextKey);
        if (priorDepth === undefined || depth < priorDepth) {
          bestDepth.set(nextKey, depth);
          queue.push({ nodeId: entry.nextId, depth, edges, causalDirection });
        }
      }
    }
    candidates.push(...anchorCandidates.values());
    if (!candidates.some((candidate) => candidate.anchorOrder === anchorOrder)) {
      gaps.push(`no evidence-backed causal chain was proven for ${anchor.path}`);
    }
  }

  const eligibilityOmittedCount = requestedAnchors.length - anchors.length;
  const traversalOmittedCount = anchors.length - analyzedAnchors.length;
  const omittedTargetCount = requestedAnchors.length - analyzedAnchors.length;
  if (eligibilityOmittedCount > 0) gaps.push(`${eligibilityOmittedCount} target(s) were omitted because they are unindexed, not portable, or exceed the ${MAX_TARGETS}-target bound`);
  if (traversalOmittedCount > 0) gaps.push(`${traversalOmittedCount} bounded target(s) were omitted after traversal reached its global safety bound`);
  if (capped) gaps.push("causal traversal reached its global safety bound");
  if (candidateRetentionTruncated) gaps.push(`candidate retention exceeded the ${MAX_TERMINAL_CANDIDATES_PER_TARGET}-chain per-target bound; all traversed candidates were scored before selection`);

  const dedupedCandidates = dedupeCandidates(candidates);
  const selected = selectDiverseCandidates(dedupedCandidates, CHANGE_EVIDENCE_LIMITS.maxChains);
  const chains = selected.map((candidate) => materializeChain({
    candidate,
    index: input.index,
    taskFingerprint,
    editTargets,
    tests: input.tests ?? [],
    freshness: input.freshness ?? input.index.freshness,
    testPaths: graph.testPaths
  }));
  const representedTargetCount = new Set(selected.map((candidate) => candidate.anchorOrder)).size;
  const unrepresentedTargetCount = analyzedAnchors.length - representedTargetCount;
  const chainGaps = chains.flatMap((chain) => chain.gaps);
  const boundedGaps = uniqueInOrder([
    ...gaps,
    ...(unrepresentedTargetCount > 0 ? [`${unrepresentedTargetCount} analyzed target(s) are not represented in the bounded chain summary`] : []),
    ...chainGaps
  ]).map((gap) => boundedEvidenceText(gap, CHANGE_EVIDENCE_TEXT_LIMITS.gap)).slice(0, CHANGE_EVIDENCE_LIMITS.maxGaps);
  const traversal = {
    visitedNodes: Math.min(globalVisited.size, CHANGE_EVIDENCE_LIMITS.maxVisitedNodes),
    examinedEdges: Math.min(examinedEdges, CHANGE_EVIDENCE_LIMITS.maxExaminedEdges),
    capped
  };
  const truncation = {
    ...(requestedAnchors.length > analyzedAnchors.length
      ? { targets: { total: requestedAnchors.length, returned: analyzedAnchors.length } }
      : {}),
    ...(dedupedCandidates.length > chains.length || candidateRetentionTruncated
      ? { chains: { total: Math.max(dedupedCandidates.length, observedCandidateCount), returned: chains.length, exact: !capped } }
      : {})
  };
  const fingerprint = stableId(
    "change-evidence-bundle-v1",
    input.index.snapshot.snapshotId,
    taskFingerprint,
    JSON.stringify({ requestedAnchors: requestedAnchors.map(anchorKey), analyzedAnchors: analyzedAnchors.map(anchorKey), representedTargetCount, editTargets, chains, traversal, gaps: boundedGaps, truncation })
  );
  return {
    schemaVersion: 1,
    snapshotId: input.index.snapshot.snapshotId,
    taskFingerprint,
    fingerprint,
    requestedTargetCount: requestedAnchors.length,
    analyzedTargetCount: analyzedAnchors.length,
    omittedTargetCount,
    representedTargetCount,
    unrepresentedTargetCount,
    chains,
    limits: CHANGE_EVIDENCE_LIMITS,
    traversal,
    gaps: boundedGaps,
    truncation
  };
}

function retainDiverseCandidate(
  current: Map<string, TerminalCandidate>,
  candidate: TerminalCandidate,
  limit: number
): Map<string, TerminalCandidate> {
  const next = new Map(current);
  const key = candidateKey(candidate);
  const prior = next.get(key);
  if (!prior || compareCandidates(candidate, prior) < 0) next.set(key, candidate);
  if (next.size <= limit) return next;
  const sorted = [...next.values()].sort(compareCandidates);
  const purposeLeaders = [...new Set(sorted.map((entry) => entry.purpose))]
    .map((purpose) => sorted.find((entry) => entry.purpose === purpose)!)
    .sort(compareCandidates);
  const leaderKeys = new Set(purposeLeaders.map(candidateKey));
  const kept = [...purposeLeaders, ...sorted.filter((entry) => !leaderKeys.has(candidateKey(entry)))].slice(0, limit);
  return new Map(kept.map((entry) => [candidateKey(entry), entry]));
}

export function formatChangeEvidenceChains(bundle: ChangeEvidenceBundleV1): string[] {
  if (bundle.chains.length === 0) {
    return [
      "- no evidence-backed causal chain was proven inside the bounded graph",
      ...bundle.gaps.slice(0, 2).map((gap) => `- gap: ${gap}`)
    ];
  }
  const lines = bundle.chains.map((chain) => {
    const rangeSegment = chain.segments.find((segment) => segment.range && (segment.fromPath || segment.toPath));
    const citationPath = rangeSegment?.fromPath ?? rangeSegment?.toPath;
    const citation = citationPath && rangeSegment?.range ? ` at ${formatEvidencePath(citationPath)}:${rangeSegment.range.startLine}` : "";
    const read = chain.roles.readDependencies.length > 0 ? `; read ${chain.roles.readDependencies.slice(0, 1).map(formatEvidencePath).join(", ")}` : "";
    const verify = chain.roles.verifyTargets.length > 0 ? `; verify ${chain.roles.verifyTargets.slice(0, 1).map(formatEvidencePath).join(", ")}` : "";
    return `- ${boundedEvidenceText(chain.summary, 160)}; ${chain.confidence}${citation}${read}${verify}`;
  });
  return [...lines, ...bundle.gaps.slice(0, 2).map((gap) => `- gap: ${boundedEvidenceText(gap, 160)}`)];
}

function evidenceGraphCache(index: CodexaIndex): EvidenceGraphCache {
  const cached = evidenceGraphCaches.get(index);
  if (cached) return cached;
  const graph = {
    edgeIndex: buildCompactEdgeIndex(index.graphEdges),
    indexedPaths: new Set(index.files.map((file) => file.path)),
    testPaths: new Set(index.files.filter((file) => file.test && portableEvidencePath(file.path)).map((file) => file.path))
  };
  evidenceGraphCaches.set(index, graph);
  return graph;
}

export function changeEvidenceGraphCacheFootprint(index: CodexaIndex): ChangeEvidenceGraphCacheFootprint {
  const edgeIndex = evidenceGraphCache(index).edgeIndex;
  return {
    edgeCount: edgeIndex.edges.length,
    edgeReferenceCount: edgeIndex.references.length,
    edgeReferenceBytes: edgeIndex.references.byteLength
  };
}

function buildCompactEdgeIndex(edges: GraphEdgeFact[]): CompactEvidenceEdgeIndex {
  if (edges.length > 0x7fff_ffff) {
    throw new Error("causal evidence graph exceeds the compact edge-index limit");
  }
  let referenceCount = edges.length;
  for (const edge of edges) if (edge.toId !== edge.fromId) referenceCount += 1;
  const references = new Uint32Array(referenceCount);
  let cursor = 0;
  for (let edgeIndex = 0; edgeIndex < edges.length; edgeIndex += 1) {
    const edge = edges[edgeIndex]!;
    references[cursor++] = edgeIndex * 2;
    if (edge.toId !== edge.fromId) references[cursor++] = edgeIndex * 2 + 1;
  }
  // A compact canonical index keeps equal-depth traversal deterministic
  // without retaining two JavaScript AdjacencyEntry objects per graph edge.
  references.sort((left, right) => compareEdgeReferences(edges, left, right));
  return { edges, references };
}

function compareEdgeReferences(edges: GraphEdgeFact[], leftReference: number, rightReference: number): number {
  const leftEdge = edgeForReference(edges, leftReference);
  const rightEdge = edgeForReference(edges, rightReference);
  const leftReverse = edgeReferenceIsReverse(leftReference);
  const rightReverse = edgeReferenceIsReverse(rightReference);
  return edgeReferenceNodeId(leftEdge, leftReverse).localeCompare(edgeReferenceNodeId(rightEdge, rightReverse))
    || leftEdge.edgeKind.localeCompare(rightEdge.edgeKind)
    || (leftEdge.fromPath ?? "").localeCompare(rightEdge.fromPath ?? "")
    || (leftEdge.toPath ?? "").localeCompare(rightEdge.toPath ?? "")
    || leftEdge.reason.localeCompare(rightEdge.reason)
    || leftEdge.id.localeCompare(rightEdge.id)
    || edgeReferenceNextId(leftEdge, leftReverse).localeCompare(edgeReferenceNextId(rightEdge, rightReverse))
    || Number(leftReverse) - Number(rightReverse);
}

function* adjacencyEntries(index: CompactEvidenceEdgeIndex, nodeId: string): Generator<AdjacencyEntry> {
  const [start, end] = edgeReferenceRange(index, nodeId);
  for (let cursor = start; cursor < end; cursor += 1) {
    const reference = index.references[cursor]!;
    const edge = edgeForReference(index.edges, reference);
    const reverse = edgeReferenceIsReverse(reference);
    yield {
      edge,
      nextId: edgeReferenceNextId(edge, reverse),
      nextKind: reverse ? edge.fromKind : edge.toKind,
      nextPath: reverse ? edge.fromPath : edge.toPath,
      traversedForward: !reverse
    };
  }
}

function edgeReferenceRange(index: CompactEvidenceEdgeIndex, nodeId: string): [number, number] {
  return [edgeReferenceBound(index, nodeId, false), edgeReferenceBound(index, nodeId, true)];
}

function edgeReferenceBound(index: CompactEvidenceEdgeIndex, nodeId: string, upper: boolean): number {
  let low = 0;
  let high = index.references.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    const reference = index.references[middle]!;
    const edge = edgeForReference(index.edges, reference);
    const comparison = edgeReferenceNodeId(edge, edgeReferenceIsReverse(reference)).localeCompare(nodeId);
    if (comparison < 0 || (upper && comparison === 0)) low = middle + 1;
    else high = middle;
  }
  return low;
}

function edgeForReference(edges: GraphEdgeFact[], reference: number): GraphEdgeFact {
  return edges[reference >>> 1]!;
}

function edgeReferenceIsReverse(reference: number): boolean {
  return (reference & 1) === 1;
}

function edgeReferenceNodeId(edge: GraphEdgeFact, reverse: boolean): string {
  return reverse ? edge.toId : edge.fromId;
}

function edgeReferenceNextId(edge: GraphEdgeFact, reverse: boolean): string {
  return reverse ? edge.fromId : edge.toId;
}

function anchorStartNodes(index: CodexaIndex, anchor: ChangeEvidenceAnchorInput, edgeIndex: CompactEvidenceEdgeIndex): string[] {
  const file = index.files.find((candidate) => candidate.path === anchor.path);
  const validatedSymbol = anchor.symbolId
    ? index.symbols.find((candidate) => candidate.id === anchor.symbolId && candidate.path === anchor.path)
    : undefined;
  const pathSymbolIds = anchor.symbolId
    ? []
    : uniqueSorted(index.symbols.filter((symbol) => symbol.path === anchor.path).map((symbol) => symbol.id));
  return uniqueInOrder([
    ...(validatedSymbol ? [validatedSymbol.id] : []),
    ...(file ? [file.id] : []),
    ...pathSymbolIds
  ].filter((id) => {
    const [start, end] = edgeReferenceRange(edgeIndex, id);
    return start < end;
  })).slice(0, MAX_START_NODES_PER_TARGET);
}

function terminalPurpose(
  testPaths: Set<string>,
  anchor: ChangeEvidenceAnchorInput,
  entry: AdjacencyEntry,
  edges: GraphEdgeFact[]
): ChangeEvidencePurpose | undefined {
  const edge = entry.edge;
  if (edge.edgeKind === "RISK" || entry.nextKind === "risk") return "risk";
  if (edge.edgeKind === "TESTS" || edge.edgeKind === "TEST_COVERS_WORKFLOW" || Boolean(entry.nextPath && testPaths.has(entry.nextPath))) return "verification";
  if (WORKFLOW_EDGE_KINDS.has(edge.edgeKind) || entry.nextKind === "workflow" || entry.nextKind === "endpoint") return "runtime";
  const terminalPath = meaningfulTerminalPath(anchor.path, entry);
  if (!terminalPath) return undefined;
  if (["CALLS", "REFERENCES", "IMPORTS", "IMPLEMENTS", "EXTENDS"].includes(edge.edgeKind)) {
    return entry.traversedForward ? "runtime" : "blast-radius";
  }
  if (edges.some((candidate) => WORKFLOW_EDGE_KINDS.has(candidate.edgeKind))) return "runtime";
  return undefined;
}

function meaningfulTerminalPath(anchorPath: string, entry: AdjacencyEntry): string | undefined {
  const edgePath = entry.nextPath;
  return edgePath && edgePath !== anchorPath ? edgePath : undefined;
}

function terminalLabel(entry: AdjacencyEntry, terminalPath?: string): string {
  if (terminalPath) return terminalPath;
  if (entry.nextKind === "risk") return `risk: ${entry.edge.reason}`;
  if (entry.nextKind === "endpoint") return `endpoint: ${entry.edge.reason}`;
  return entry.edge.reason;
}

function containsCausalEdge(edges: GraphEdgeFact[]): boolean {
  return edges.some((edge) => !SUPPORT_EDGE_KINDS.has(edge.edgeKind));
}

function nextCausalDirection(current: TraversalState["causalDirection"], entry: AdjacencyEntry): TraversalState["causalDirection"] | "invalid" {
  if (SUPPORT_EDGE_KINDS.has(entry.edge.edgeKind)) return current;
  const next = entry.traversedForward ? "forward" : "reverse";
  return current === undefined || current === next ? next : "invalid";
}

function traversalKey(nodeId: string, direction?: TraversalState["causalDirection"]): string {
  return `${direction ?? "neutral"}\0${nodeId}`;
}

function directionalChainSummary(edges: GraphEdgeFact[]): string {
  return edges.map((edge) => `${edge.fromPath ?? edge.fromId} -${edge.edgeKind}-> ${edge.toPath ?? edge.toId}`).join(" | ");
}

function materializeChain(input: {
  candidate: TerminalCandidate;
  index: CodexaIndex;
  taskFingerprint: string;
  editTargets: string[];
  tests: TestRecommendation[];
  freshness: FreshnessInfo;
  testPaths: Set<string>;
}): ChangeEvidenceChainV1 {
  const { candidate } = input;
  const segments = edgeEvidenceForGraphEdges(candidate.edges, input.freshness, CHANGE_EVIDENCE_LIMITS.maxSegmentsPerChain)
    .map((segment) => ({ ...segment, reason: boundedEvidenceText(segment.reason, CHANGE_EVIDENCE_TEXT_LIMITS.reason) }));
  const allPaths = uniqueInOrder(candidate.edges.flatMap((edge) => [edge.fromPath, edge.toPath]).filter((value): value is string => typeof value === "string" && portableEvidencePath(value)));
  const allVerifyTargets = uniqueInOrder([
    ...(candidate.purpose === "verification" && candidate.terminalPath ? [candidate.terminalPath] : []),
    ...input.tests.filter((test) => testSupportsPaths(test, allPaths, candidate.anchor.path)).map((test) => test.path)
  ].filter((filePath) => portableEvidencePath(filePath) && (input.testPaths.has(filePath) || input.tests.some((test) => test.path === filePath))));
  const verifyTargets = allVerifyTargets.slice(0, CHANGE_EVIDENCE_LIMITS.maxTestsPerChain);
  const tests = chainTests(input.tests, verifyTargets, candidate);
  const editTargetSet = new Set(input.editTargets);
  const verifyTargetSet = new Set(verifyTargets);
  const chainEditTargets = uniqueInOrder([candidate.anchor.path, ...allPaths])
    .filter((filePath) => editTargetSet.has(filePath))
    .slice(0, CHANGE_EVIDENCE_LIMITS.maxPathsPerChain);
  const readDependencies = uniqueInOrder(allPaths.filter((filePath) => filePath !== candidate.anchor.path && !editTargetSet.has(filePath) && !verifyTargetSet.has(filePath))).slice(0, CHANGE_EVIDENCE_LIMITS.maxPathsPerChain);
  const subsystem = matchingSubsystem(input.index, candidate.anchor.path, allPaths);
  const gaps = uniqueInOrder([
    ...(segments.some((segment) => segment.degraded) ? ["chain includes heuristic evidence and is advisory"] : []),
    ...(tests.length === 0 && candidate.purpose !== "risk" ? ["no evidence-backed test is attached to this chain"] : [])
  ]).slice(0, CHANGE_EVIDENCE_LIMITS.maxGaps);
  const chainId = stableId(
    "change-evidence-chain-v1",
    input.index.snapshot.snapshotId,
    input.taskFingerprint,
    anchorKey(candidate.anchor),
    candidate.purpose,
    candidate.edges.map((edge) => edge.id).join("\n")
  );
  const chain: ChangeEvidenceChainV1 = {
    schemaVersion: 1,
    chainId,
    purpose: candidate.purpose,
    summary: boundedEvidenceText(`${candidate.purpose}: ${directionalChainSummary(candidate.edges)}`, CHANGE_EVIDENCE_TEXT_LIMITS.summary),
    confidence: candidate.confidence,
    anchor: {
      candidateId: optionalEvidenceText(candidate.anchor.candidateId, 160),
      path: candidate.anchor.path,
      symbolId: optionalEvidenceText(candidate.anchor.symbolId, 240),
      authority: candidate.anchor.authority
    },
    subsystem,
    segments,
    roles: {
      editTargets: chainEditTargets,
      readDependencies,
      verifyTargets
    },
    tests,
    gaps,
    truncated: allVerifyTargets.length > verifyTargets.length
      ? { tests: { total: allVerifyTargets.length, returned: verifyTargets.length } }
      : undefined
  };
  // Snapshot persistence applies the same redaction recursively. Normalize
  // before fingerprinting so the stored material still matches its receipt.
  return redactRepoPath(chain, input.index.freshness.repoRoot) as ChangeEvidenceChainV1;
}

function chainTests(tests: TestRecommendation[], verifyTargets: string[], candidate: TerminalCandidate): ChangeEvidenceTestV1[] {
  const byPath = new Map(tests.map((test) => [test.path, test]));
  return verifyTargets.slice(0, CHANGE_EVIDENCE_LIMITS.maxTestsPerChain).map((testPath) => {
    const test = byPath.get(testPath);
    return test
      ? {
          path: test.path,
          reason: boundedEvidenceText(test.reason, CHANGE_EVIDENCE_TEXT_LIMITS.reason),
          evidenceTier: test.evidenceTier,
          command: optionalEvidenceText(test.command, CHANGE_EVIDENCE_TEXT_LIMITS.command),
          commandCwd: test.commandCwd === "." || (test.commandCwd && portableEvidencePath(test.commandCwd)) ? test.commandCwd : undefined
        }
      : {
          path: testPath,
          reason: boundedEvidenceText(candidate.edges.at(-1)?.reason ?? `graph test evidence for ${candidate.anchor.path}`, CHANGE_EVIDENCE_TEXT_LIMITS.reason),
          evidenceTier: evidenceTier(candidate.confidence)
        };
  });
}

function testSupportsPaths(test: TestRecommendation, paths: string[], anchorPath: string): boolean {
  if (paths.includes(test.path)) return true;
  const provenanceTargets = test.provenance?.targetPaths ?? [];
  return provenanceTargets.includes(anchorPath) || provenanceTargets.some((target) => paths.includes(target));
}

function matchingSubsystem(index: CodexaIndex, anchorPath: string, paths: string[]): ChangeEvidenceChainV1["subsystem"] {
  const pathSet = new Set([anchorPath, ...paths]);
  const workflow = index.workflows
    .filter((candidate) => workflowMatchesAnyPath(candidate, pathSet))
    .sort((left, right) => right.rank - left.rank || left.id.localeCompare(right.id))[0];
  if (workflow) {
    return {
      kind: "workflow",
      id: workflow.id,
      label: boundedEvidenceText(workflow.title, CHANGE_EVIDENCE_TEXT_LIMITS.subsystemLabel),
      confidence: workflow.confidence
    };
  }
  const module = index.modules
    .filter((candidate) => candidate.files.some((filePath) => pathSet.has(filePath)))
    .sort((left, right) => right.rank - left.rank || left.id.localeCompare(right.id))[0];
  return module
    ? { kind: "module", id: module.id, label: boundedEvidenceText(module.name, CHANGE_EVIDENCE_TEXT_LIMITS.subsystemLabel), confidence: module.confidence }
    : undefined;
}

function selectDiverseCandidates(candidates: TerminalCandidate[], limit: number): TerminalCandidate[] {
  const sorted = [...candidates].sort(compareCandidates);
  if (limit <= 0 || sorted.length === 0) return [];
  const selected: TerminalCandidate[] = [];
  const selectedKeys = new Set<string>();
  const representedAnchors = new Set<number>();
  const representedPurposes = new Set<ChangeEvidencePurpose>();
  const add = (candidate: TerminalCandidate | undefined): boolean => {
    if (!candidate) return false;
    selected.push(candidate);
    selectedKeys.add(candidateKey(candidate));
    representedAnchors.add(candidate.anchorOrder);
    representedPurposes.add(candidate.purpose);
    return true;
  };
  add(sorted[0]);
  while (selected.length < limit) {
    const remaining = sorted.filter((candidate) => !selectedKeys.has(candidateKey(candidate)));
    if (remaining.length === 0) break;
    // Prefer joint novelty, then advance whichever represented dimension is
    // smaller. This spends the tiny chain budget on both target coverage and
    // decision-purpose diversity instead of exhausting it on either alone.
    const expandsBoth = remaining.find((candidate) => !representedAnchors.has(candidate.anchorOrder) && !representedPurposes.has(candidate.purpose));
    if (add(expandsBoth)) continue;
    const expandsPurpose = remaining.find((candidate) => !representedPurposes.has(candidate.purpose));
    const expandsAnchor = remaining.find((candidate) => !representedAnchors.has(candidate.anchorOrder));
    if (expandsPurpose && expandsAnchor) {
      add(representedPurposes.size <= representedAnchors.size ? expandsPurpose : expandsAnchor);
      continue;
    }
    if (add(expandsPurpose ?? expandsAnchor)) continue;
    add(remaining[0]);
  }
  return selected;
}

function dedupeCandidates(candidates: TerminalCandidate[]): TerminalCandidate[] {
  const byKey = new Map<string, TerminalCandidate>();
  for (const candidate of candidates.sort(compareCandidates)) {
    const key = candidateKey(candidate);
    if (!byKey.has(key)) byKey.set(key, candidate);
  }
  return [...byKey.values()];
}

function candidateKey(candidate: TerminalCandidate): string {
  return [anchorKey(candidate.anchor), candidate.purpose, candidate.terminalPath ?? candidate.terminalLabel, candidate.edges.map((edge) => edge.id).join(":")].join("|");
}

function candidateScore(purpose: ChangeEvidencePurpose, depth: number, confidence: Confidence, entry: AdjacencyEntry): number {
  const purposeScore: Record<ChangeEvidencePurpose, number> = { verification: 400, risk: 350, runtime: 300, "blast-radius": 250 };
  const confidenceScore: Record<Confidence, number> = { authoritative: 30, derived: 20, heuristic: 0 };
  return purposeScore[purpose] + confidenceScore[confidence] - depth * 8 + (entry.nextPath ? 2 : 0);
}

function compareCandidates(left: TerminalCandidate, right: TerminalCandidate): number {
  return left.anchorOrder - right.anchorOrder
    || right.score - left.score
    || left.edges.length - right.edges.length
    || left.purpose.localeCompare(right.purpose)
    || (left.terminalPath ?? left.terminalLabel).localeCompare(right.terminalPath ?? right.terminalLabel)
    || candidateKey(left).localeCompare(candidateKey(right));
}

function dedupeAnchors(anchors: ChangeEvidenceAnchorInput[]): ChangeEvidenceAnchorInput[] {
  const byKey = new Map<string, ChangeEvidenceAnchorInput>();
  for (const anchor of anchors) if (!byKey.has(anchorKey(anchor))) byKey.set(anchorKey(anchor), anchor);
  return [...byKey.values()];
}

function anchorKey(anchor: ChangeEvidenceAnchorInput): string {
  return [anchor.candidateId ?? "", anchor.path, anchor.symbolId ?? "", anchor.authority].join(":");
}

function weakestConfidence(values: Confidence[]): Confidence {
  return values.includes("heuristic") ? "heuristic" : values.includes("derived") ? "derived" : "authoritative";
}

function evidenceTier(confidence: Confidence): "authoritative" | "derived" | "heuristic" {
  return confidence;
}

function portableEvidenceEdgePaths(edge: GraphEdgeFact): boolean {
  return (edge.fromPath === undefined || portableEvidencePath(edge.fromPath))
    && (edge.toPath === undefined || portableEvidencePath(edge.toPath));
}

function portableEvidencePath(value: string): boolean {
  return value.length > 0
    && value.length <= CHANGE_EVIDENCE_TEXT_LIMITS.path
    && !value.startsWith("/")
    && !/^[A-Za-z]:[\\/]/u.test(value)
    && !/[\u0000-\u001f\u007f]/u.test(value)
    && !value.split(/[\\/]/u).some((segment) => segment === "." || segment === "..");
}

function boundedEvidenceText(value: string, limit: number): string {
  const normalized = value.replace(/[\u0000-\u001f\u007f]/gu, " ").replace(/\s+/gu, " ").trim();
  return (normalized || "evidence unavailable").slice(0, limit);
}

function optionalEvidenceText(value: string | undefined, limit: number): string | undefined {
  if (!value) return undefined;
  const normalized = value.replace(/[\u0000-\u001f\u007f]/gu, " ").replace(/\s+/gu, " ").trim();
  return normalized ? normalized.slice(0, limit) : undefined;
}

function formatEvidencePath(value: string): string {
  return value.length <= 96 ? value : `…${value.slice(-95)}`;
}

function normalizeTask(task?: string): string {
  return task?.trim().replace(/\s+/gu, " ").toLowerCase() ?? "";
}

function uniqueInOrder<T>(values: T[]): T[] {
  return [...new Set(values)];
}
