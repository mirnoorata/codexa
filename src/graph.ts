import type {
  CodexaIndex,
  Confidence,
  FileFact,
  GraphEdgeFact,
  GraphEdgeKind,
  GraphNodeKind,
  ImportEdgeFact,
  RiskSignalFact,
  SymbolFact,
  UsageSiteFact,
  WorkflowStep,
  WorkflowTraceFact
} from "./types.js";
import { stableId, uniqueSorted } from "./util.js";

export interface GraphTarget {
  id: string;
  kind: GraphNodeKind;
  path?: string;
  symbolId?: string;
  label: string;
}

export function buildGraphEdges(index: CodexaIndex): GraphEdgeFact[] {
  const filesByPath = new Map(index.files.map((file) => [file.path, file]));
  const symbolsById = new Map(index.symbols.map((symbol) => [symbol.id, symbol]));
  const edges: GraphEdgeFact[] = [];
  const seen = new Set<string>();
  const add = (
    edgeKind: GraphEdgeKind,
    from: GraphTarget,
    to: GraphTarget,
    confidence: Confidence,
    reason: string,
    weight: number,
    source: GraphEdgeFact["source"] = "tree-sitter",
    usage?: UsageSiteFact
  ) => {
    const id = stableId("graph-edge", edgeKind, from.id, to.id, reason, usage?.range?.startByte ?? 0);
    if (seen.has(id)) {
      return;
    }
    seen.add(id);
    edges.push({
      id,
      type: "GraphEdge",
      edgeKind,
      fromId: from.id,
      toId: to.id,
      fromKind: from.kind,
      toKind: to.kind,
      fromPath: from.path,
      toPath: to.path,
      fromSymbolId: from.symbolId,
      toSymbolId: to.symbolId,
      reason,
      weight,
      source,
      confidence,
      snapshotId: index.snapshot.snapshotId,
      indexedAt: index.snapshot.indexedAt,
      range: usage?.range
    });
  };

  for (const symbol of index.symbols) {
    const file = filesByPath.get(symbol.path);
    if (!file) {
      continue;
    }
    add("DEFINES", fileTarget(file), symbolTarget(symbol), symbol.confidence, `defines ${symbol.qualifiedName}`, 3, symbol.source);
    if (symbol.exported) {
      add(symbol.kind === "interface" || symbol.kind === "type" || symbol.kind === "enum" ? "TYPE_EXPORTS" : "EXPORTS", fileTarget(file), symbolTarget(symbol), symbol.confidence, `exports ${symbol.qualifiedName}`, 2.8, symbol.source);
    }
    if (symbol.kind === "route") {
      add("ROUTE", fileTarget(file), symbolTarget(symbol), symbol.confidence, `route entry ${symbol.qualifiedName}`, 4, symbol.source);
    }
    if (isJobSymbol(symbol)) {
      add("JOB", fileTarget(file), symbolTarget(symbol), "heuristic", `job entry ${symbol.qualifiedName}`, 4, "heuristic");
    }
  }

  for (const imp of index.imports) {
    if (!imp.resolvedPath || imp.typeOnly) {
      continue;
    }
    const from = filesByPath.get(imp.path);
    const to = filesByPath.get(imp.resolvedPath);
    if (!from || !to) {
      continue;
    }
    add("IMPORTS", fileTarget(from), fileTarget(to), imp.confidence, `imports ${imp.importedName ?? "*"} from ${imp.specifier}`, 3, imp.source);
    const importedSymbol = importedSymbolForEdge(index.symbols, imp);
    if (importedSymbol) {
      add("IMPORTS", fileTarget(from), symbolTarget(importedSymbol), imp.confidence, `imports ${imp.importedName ?? importedSymbol.name} from ${imp.specifier}`, 3.2, imp.source);
    }
  }

  for (const usage of index.usageSites) {
    if (!usage.targetSymbolId) {
      continue;
    }
    const target = symbolsById.get(usage.targetSymbolId);
    if (!target) {
      continue;
    }
    const fromSymbol = usage.usedBySymbolId ? symbolsById.get(usage.usedBySymbolId) : undefined;
    const fromFile = filesByPath.get(usage.path);
    if (!fromSymbol && !fromFile) {
      continue;
    }
    const from = fromSymbol ? symbolTarget(fromSymbol) : fileTarget(fromFile!);
    const kind: GraphEdgeKind = usage.kind === "call" ? "CALLS" : "REFERENCES";
    const weight = kind === "CALLS" ? 2.5 : usage.kind === "import" ? 2 : 1.5;
    add(kind, from, symbolTarget(target), usage.confidence, `${usage.kind} ${usage.name}`, weight, usage.source, usage);
    if (usage.kind === "type_reference" && /^extends\s+/i.test(usage.text)) {
      add("EXTENDS", from, symbolTarget(target), usage.confidence, usage.text, 2.5, usage.source, usage);
    }
    if (usage.kind === "type_reference" && /^implements\s+/i.test(usage.text)) {
      add("IMPLEMENTS", from, symbolTarget(target), usage.confidence, usage.text, 2.5, usage.source, usage);
    }
  }

  addTypedWorkflowEdges(index, { filesByPath, symbolsById, add, hasGraphEdge: (predicate) => edges.some(predicate) });

  for (const test of index.testEdges) {
    if (!test.targetPath) {
      continue;
    }
    const from = filesByPath.get(test.path);
    const to = filesByPath.get(test.targetPath);
    if (!from || !to) {
      continue;
    }
    add("TESTS", fileTarget(from), fileTarget(to), test.confidence, test.reason, 3, test.source);
    add("TEST_COVERS_WORKFLOW", fileTarget(from), fileTarget(to), test.confidence, test.reason, 2.8, test.source);
  }

  for (const risk of index.risks) {
    const file = filesByPath.get(risk.path);
    if (!file) {
      continue;
    }
    add("RISK", fileTarget(file), riskTarget(risk), risk.confidence, `${risk.signal}: ${risk.reason}`, Math.max(0.5, risk.score), risk.source);
  }

  return edges.sort(
    (a, b) =>
      a.edgeKind.localeCompare(b.edgeKind) ||
      (a.fromPath ?? "").localeCompare(b.fromPath ?? "") ||
      (a.toPath ?? "").localeCompare(b.toPath ?? "") ||
      a.reason.localeCompare(b.reason)
  );
}

function addTypedWorkflowEdges(
  index: CodexaIndex,
  context: {
    filesByPath: Map<string, FileFact>;
    symbolsById: Map<string, SymbolFact>;
    add: (
      edgeKind: GraphEdgeKind,
      from: GraphTarget,
      to: GraphTarget,
      confidence: Confidence,
      reason: string,
      weight: number,
      source?: GraphEdgeFact["source"],
      usage?: UsageSiteFact
    ) => void;
    hasGraphEdge: (predicate: (edge: GraphEdgeFact) => boolean) => boolean;
  }
): void {
  const { filesByPath, symbolsById, add, hasGraphEdge } = context;
  const routeEndpointUsages = index.usageSites.filter((usage) => usage.kind === "route_handler" && normalizeEndpointKey(usage.name));
  const endpointToRoute = new Map<string, { usage: UsageSiteFact; route?: SymbolFact }[]>();
  for (const usage of routeEndpointUsages) {
    const key = normalizeEndpointKey(usage.name);
    if (!key) {
      continue;
    }
    const route = usage.usedBySymbolId ? symbolsById.get(usage.usedBySymbolId) : undefined;
    if (!route) {
      continue;
    }
    const existing = endpointToRoute.get(key) ?? [];
    existing.push({ usage, route });
    endpointToRoute.set(key, existing);
    add("ROUTE_HANDLES", symbolTarget(route), endpointTarget(key, route.path), usage.confidence, `handles endpoint ${key}`, 4.5, usage.source, usage);
  }

  for (const usage of index.usageSites.filter((site) => site.kind === "endpoint_reference")) {
    const key = normalizeEndpointKey(usage.name);
    if (!key) {
      continue;
    }
    const matches = endpointMatches(endpointToRoute, key);
    for (const match of matches.slice(0, 4)) {
      const fromFile = filesByPath.get(usage.path);
      const fromSymbol = usage.usedBySymbolId ? symbolsById.get(usage.usedBySymbolId) : undefined;
      const from = fromSymbol ? symbolTarget(fromSymbol) : fromFile ? fileTarget(fromFile) : undefined;
      if (!from || !match.route) {
        continue;
      }
      const edgeKind = isTestLikePath(usage.path) ? "TEST_COVERS_WORKFLOW" : "UI_CALLS_ENDPOINT";
      add(edgeKind, from, endpointTarget(normalizeEndpointKey(match.usage.name) ?? key, match.route.path, match.route.id), mergeEndpointConfidence(usage.confidence, match.usage.confidence), `${usage.path} references endpoint ${key} handled by ${match.route.qualifiedName}`, edgeKind === "UI_CALLS_ENDPOINT" ? 3.8 : 3.2, usage.source, usage);
    }
  }

  const symbolsByPath = new Map<string, SymbolFact[]>();
  for (const symbol of index.symbols) {
    const list = symbolsByPath.get(symbol.path) ?? [];
    list.push(symbol);
    symbolsByPath.set(symbol.path, list);
  }
  const routeFiles = new Set(index.symbols.filter((symbol) => symbol.kind === "route").map((symbol) => symbol.path));
  const storeFiles = new Set(
    index.files
      .filter((file) => !routeFiles.has(file.path) && (isStorePath(file.path) || symbolsByPath.get(file.path)?.some(isStoreBoundarySymbol)))
      .map((file) => file.path)
  );
  const importsByPath = new Map<string, ImportEdgeFact[]>();
  for (const imp of index.imports) {
    const list = importsByPath.get(imp.path) ?? [];
    list.push(imp);
    importsByPath.set(imp.path, list);
  }
  const adapterFiles = new Set(index.files.filter((file) => isAdapterPath(file.path)).map((file) => file.path));

  for (const route of index.symbols.filter((symbol) => symbol.kind === "route")) {
    const routeTarget = symbolTarget(route);
    for (const usage of index.usageSites.filter((site) => site.usedBySymbolId === route.id)) {
      const target = usage.targetSymbolId ? symbolsById.get(usage.targetSymbolId) : undefined;
      const targetPath = target?.path;
      if (targetPath && storeFiles.has(targetPath)) {
        add("ROUTE_CALLS_STORE", routeTarget, symbolTarget(target), usage.confidence, `route store usage ${usage.name}`, 3, usage.source, usage);
      } else if (!targetPath) {
        const inferred = inferRouteStoreCallTarget(route, usage, storeFiles, symbolsByPath, importsByPath, filesByPath);
        if (inferred) {
          const hasNonHeuristicStoreEdge = hasGraphEdge(
            (edge) => edge.edgeKind === "ROUTE_CALLS_STORE" && edge.fromId === routeTarget.id && edge.toPath === inferred.path && edge.source !== "heuristic"
          );
          if (hasNonHeuristicStoreEdge) {
            continue;
          }
          add("ROUTE_CALLS_STORE", routeTarget, inferred, "heuristic", `route store usage ${usage.name} (inferred)`, 2.2, "heuristic", usage);
        }
      }
    }
  }

  for (const storePath of storeFiles) {
    const storeFile = filesByPath.get(storePath);
    if (!storeFile) {
      continue;
    }
    const adapterEvidence = new Set<string>();
    for (const usage of index.usageSites.filter((site) => site.path === storePath)) {
      const target = usage.targetSymbolId ? symbolsById.get(usage.targetSymbolId) : undefined;
      if (target && adapterFiles.has(target.path)) {
        adapterEvidence.add(target.path);
        add("STORE_DISPATCHES_ADAPTER", fileTarget(storeFile), symbolTarget(target), usage.confidence, `store adapter usage ${usage.name}`, 3.2, usage.source, usage);
      }
    }
    for (const imp of index.imports.filter((candidate) => candidate.path === storePath && candidate.resolvedPath && adapterFiles.has(candidate.resolvedPath))) {
      const adapterFile = imp.resolvedPath ? filesByPath.get(imp.resolvedPath) : undefined;
      if (adapterFile && !adapterEvidence.has(adapterFile.path)) {
        add("STORE_DISPATCHES_ADAPTER", fileTarget(storeFile), fileTarget(adapterFile), "derived", `store imports adapter ${imp.specifier}`, 2.4, imp.source);
      }
    }
  }

  const adapterFileList = [...adapterFiles].map((filePath) => filesByPath.get(filePath)).filter((file): file is FileFact => Boolean(file));
  for (const usage of index.usageSites.filter((site) => site.path.startsWith("atlas_api/packages/") && /adapter_key\s+/i.test(site.text))) {
    const manifest = filesByPath.get(usage.path);
    if (!manifest) {
      continue;
    }
    for (const adapter of matchingAdaptersForKey(adapterFileList, usage.name, manifest.path).slice(0, 4)) {
      add("ADAPTER_REFERENCED_BY_MANIFEST", fileTarget(manifest), fileTarget(adapter), usage.confidence, `manifest adapter_key ${usage.name}`, 3.6, usage.source, usage);
    }
  }
}

function normalizeEndpointKey(value: string): string | undefined {
  const match = /^(GET|POST|PUT|PATCH|DELETE|WEBSOCKET|ANY)\s+(\/\S*)$/i.exec(value.trim());
  if (!match) {
    return undefined;
  }
  const method = match[1].toUpperCase();
  const routePath = match[2].split(/[?#]/, 1)[0].replace(/\/+/g, "/").replace(/\/$/, "") || "/";
  return `${method} ${routePath}`;
}

function endpointMatches(endpointToRoute: Map<string, { usage: UsageSiteFact; route?: SymbolFact }[]>, key: string): { usage: UsageSiteFact; route?: SymbolFact }[] {
  const normalized = normalizeEndpointKey(key);
  if (!normalized) {
    return [];
  }
  const [method, routePath] = normalized.split(" ");
  const exact = endpointToRoute.get(normalized) ?? [];
  if (exact.length > 0) {
    return exact;
  }
  const compatible = [...endpointToRoute.entries()].filter(([candidate]) => {
    const [candidateMethod, candidatePath] = candidate.split(" ");
    const methodMatches = method === "ANY" || candidateMethod === "ANY" || candidateMethod === method;
    return methodMatches && endpointPathCompatible(routePath, candidatePath);
  });
  return compatible.flatMap(([, values]) => values);
}

function importedSymbolForEdge(symbols: SymbolFact[], imp: ImportEdgeFact): SymbolFact | undefined {
  if (!imp.resolvedPath || !imp.importedName || imp.importedName === "*") {
    return undefined;
  }
  const candidates = symbols.filter((symbol) => symbol.path === imp.resolvedPath && symbol.exported);
  if (imp.importedName === "default") {
    return candidates.find((symbol) => symbol.name === "default");
  }
  return candidates.find((symbol) => symbol.name === imp.importedName || symbol.qualifiedName === imp.importedName);
}

function endpointTarget(key: string, pathValue?: string, symbolId?: string): GraphTarget {
  return { id: stableId("endpoint", normalizeEndpointKey(key) ?? key), kind: "endpoint", path: pathValue, symbolId, label: normalizeEndpointKey(key) ?? key };
}

function endpointPathCompatible(left: string, right: string): boolean {
  if (left === right) {
    return true;
  }
  const leftSegments = left.split("/").filter(Boolean);
  const rightSegments = right.split("/").filter(Boolean);
  if (leftSegments.length !== rightSegments.length) {
    return false;
  }
  return leftSegments.every((segment, index) => pathSegmentCompatible(segment, rightSegments[index]));
}

function pathSegmentCompatible(left: string, right: string): boolean {
  if (left === right) {
    return true;
  }
  return isDynamicSegment(left) && isDynamicSegment(right);
}

function isDynamicSegment(value: string): boolean {
  return /^\{[^}]+\}$/.test(value) || /^\$\{[^}]+\}$/.test(value) || /^:[A-Za-z_][\w-]*$/.test(value);
}

function mergeEndpointConfidence(a: Confidence, b: Confidence): Confidence {
  if (a === "authoritative" && b === "authoritative") {
    return "authoritative";
  }
  if (a === "heuristic" || b === "heuristic") {
    return "heuristic";
  }
  return "derived";
}

function isTestLikePath(filePath: string): boolean {
  return /(^|\/)(tests?|__tests__)\/|(\.test|\.spec)\.[cm]?[jt]sx?$|(^|\/)test_[^/]+\.py$/.test(filePath);
}

function isStorePath(filePath: string): boolean {
  return /(^|\/)(store|stores|repository|repositories|db|database|models|execution|queue|run-store)(\/|\.|$)/i.test(filePath);
}

function isAdapterPath(filePath: string): boolean {
  return /(^|\/)adapters?\/|(^|\/).*adapter.*\.(py|[cm]?[jt]sx?)$/i.test(filePath);
}

function isStoreBoundarySymbol(symbol: SymbolFact): boolean {
  if (!["class", "function", "method"].includes(symbol.kind)) {
    return false;
  }
  return isStoreLikeName(symbol.name) || isStoreLikeName(symbol.qualifiedName);
}

function isStoreLikeName(value: string): boolean {
  return /\b(AtlasStore|RunStore|Store|Repository|Coordinator|Database)\b/.test(value) || /(Store|Repository|Coordinator)$/.test(value);
}

function inferRouteStoreCallTarget(
  route: SymbolFact,
  usage: UsageSiteFact,
  storeFiles: Set<string>,
  symbolsByPath: Map<string, SymbolFact[]>,
  importsByPath: Map<string, ImportEdgeFact[]>,
  filesByPath: Map<string, FileFact>
): GraphTarget | undefined {
  const match = /^store\.([A-Za-z_][\w]*)$/u.exec(usage.name);
  if (!match) {
    return undefined;
  }
  if (!hasStoreHandleInRouteFile(route, storeFiles, symbolsByPath, importsByPath)) {
    return undefined;
  }
  const methodName = match[1];
  const routePath = route.path;
  const importedStorePaths = uniqueSorted(
    (importsByPath.get(routePath) ?? [])
      .map((imp) => imp.resolvedPath)
      .filter((resolvedPath): resolvedPath is string => typeof resolvedPath === "string")
      .filter((resolvedPath) => storeFiles.has(resolvedPath))
  );
  const candidatePaths = importedStorePaths.length > 0 ? importedStorePaths : storeFiles.size === 1 ? [...storeFiles] : [];
  for (const storePath of candidatePaths) {
    const method = (symbolsByPath.get(storePath) ?? []).find((symbol) => symbol.name === methodName || symbol.qualifiedName.endsWith(`.${methodName}`));
    if (method) {
      return symbolTarget(method);
    }
  }
  for (const storePath of candidatePaths) {
    const file = filesByPath.get(storePath);
    if (file) {
      return fileTarget(file);
    }
  }
  return undefined;
}

function hasStoreHandleInRouteFile(
  route: SymbolFact,
  storeFiles: Set<string>,
  symbolsByPath: Map<string, SymbolFact[]>,
  importsByPath: Map<string, ImportEdgeFact[]>
): boolean {
  const imports = importsByPath.get(route.path) ?? [];
  const storeImports = imports.filter((imp) => typeof imp.resolvedPath === "string" && storeFiles.has(imp.resolvedPath));
  if (storeImports.length === 0) {
    return false;
  }
  if (storeImports.some((imp) => imp.localName === "store" || imp.importedName === "store")) {
    return true;
  }
  return (symbolsByPath.get(route.path) ?? []).some(
    (symbol) =>
      symbol.name === "store" &&
      symbol.kind === "variable" &&
      typeof symbol.range?.startLine === "number" &&
      typeof route.range?.startLine === "number" &&
      symbol.range.startLine < route.range.startLine
  );
}

function matchingAdaptersForKey(adapters: FileFact[], adapterKey: string, manifestPath?: string): FileFact[] {
  const keyParts = adapterKey
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((part) => part.length >= 2);
  const compactKey = keyParts.join("");
  const underscoredKey = keyParts.join("_");
  const scored = adapters
    .map((adapter) => {
      const stem = adapter.path
        .toLowerCase()
        .replace(/\.[^.]+$/, "")
        .split("/")
        .at(-1) ?? "";
      const compactStem = stem.replace(/[^a-z0-9]+/g, "");
      const pathText = adapter.path.toLowerCase();
      const exact = stem === adapterKey.toLowerCase() || stem === underscoredKey || compactStem === compactKey;
      const terminalExact = keyParts.at(-1) ? stem === keyParts.at(-1) : false;
      const localityBoost = manifestPath?.startsWith("atlas_api/packages/") && adapter.path.startsWith("atlas_api/adapters/") ? 20 : 0;
      const score = exact
        ? 100 + localityBoost
        : terminalExact
          ? 12 + localityBoost
          : keyParts.reduce((sum, part) => sum + (stem === part ? 4 : pathText.includes(part) ? 1 : 0), 0) + localityBoost;
      return { adapter, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || b.adapter.rank - a.adapter.rank || a.adapter.path.localeCompare(b.adapter.path));
  const exact = scored.filter((entry) => entry.score >= 100);
  if (exact.length > 0) {
    return exact.slice(0, 1).map((entry) => entry.adapter);
  }
  const best = scored[0]?.score ?? 0;
  return best > 0 ? scored.slice(0, 1).map((entry) => entry.adapter) : [];
}

export function extractWorkflowTraces(index: CodexaIndex): WorkflowTraceFact[] {
  const symbolsById = new Map(index.symbols.map((symbol) => [symbol.id, symbol]));
  const fileRank = new Map(index.files.map((file) => [file.path, file.rank]));
  const workflows: WorkflowTraceFact[] = [];

  const entrySymbols = index.symbols.filter((symbol) => symbol.kind === "route" || isJobSymbol(symbol));
  for (const symbol of entrySymbols) {
    const workflowKind = symbol.kind === "route" ? "route" : "job";
    const steps = entryStepsForSymbol(index, symbol, symbolsById);
    const relatedFiles = uniqueSorted(steps.flatMap((step) => [step.path, step.targetPath]).filter((filePath): filePath is string => Boolean(filePath)));
    const tests = relatedTests(index, relatedFiles);
    for (const testPath of tests.slice(0, 8)) {
      steps.push({
        kind: "test",
        label: testPath,
        path: testPath,
        targetPath: symbol.path,
        confidence: "authoritative",
        reason: "covers workflow-related file"
      });
    }
    workflows.push(workflowFact(index, {
      workflowKind,
      title: `${workflowKind} ${symbol.qualifiedName}`,
      entryPath: symbol.path,
      entrySymbolId: symbol.id,
      steps,
      relatedFiles: uniqueSorted([...relatedFiles, ...tests]),
      tests,
      rank: workflowRank(relatedFiles, tests, fileRank, workflowKind),
      summary: summarizeWorkflow(workflowKind, symbol.qualifiedName, relatedFiles, tests)
    }));
  }

  for (const symbol of index.symbols.filter((candidate) => candidate.kind === "node")) {
    const steps: WorkflowStep[] = [
      {
        kind: "entry",
        label: symbol.qualifiedName,
        path: symbol.path,
        line: symbol.range?.startLine,
        symbolId: symbol.id,
        confidence: symbol.confidence,
        reason: "Atlas manifest node"
      }
    ];
    for (const usage of index.usageSites.filter((site) => site.targetSymbolId === symbol.id || site.name === symbol.name).slice(0, 20)) {
      steps.push({
        kind: usage.kind === "call" ? "call" : "reference",
        label: usage.name,
        path: usage.path,
        line: usage.range?.startLine,
        targetSymbolId: usage.targetSymbolId,
        targetPath: usage.path,
        confidence: usage.confidence,
        reason: usage.text
      });
    }
    for (const edge of index.graphEdges.filter((candidate) => candidate.edgeKind === "ADAPTER_REFERENCED_BY_MANIFEST" && candidate.fromPath === symbol.path).slice(0, 12)) {
      steps.push({
        kind: "adapter",
        label: edge.reason,
        path: edge.fromPath ?? symbol.path,
        line: edge.range?.startLine,
        targetPath: edge.toPath,
        confidence: edge.confidence,
        reason: edge.edgeKind
      });
    }
    const relatedFiles = uniqueSorted(steps.flatMap((step) => [step.path, step.targetPath]).filter((filePath): filePath is string => Boolean(filePath)));
    const tests = relatedTests(index, relatedFiles);
    workflows.push(workflowFact(index, {
      workflowKind: "manifest",
      title: `manifest ${symbol.name}`,
      entryPath: symbol.path,
      entrySymbolId: symbol.id,
      steps,
      relatedFiles: uniqueSorted([...relatedFiles, ...tests]),
      tests,
      rank: workflowRank(relatedFiles, tests, fileRank, "manifest"),
      summary: summarizeWorkflow("manifest", symbol.name, relatedFiles, tests)
    }));
  }

  return workflows
    .filter((workflow) => workflow.steps.length > 0)
    .sort((a, b) => b.rank - a.rank || a.title.localeCompare(b.title));
}

function entryStepsForSymbol(index: CodexaIndex, entry: SymbolFact, symbolsById: Map<string, SymbolFact>): WorkflowStep[] {
  const steps: WorkflowStep[] = [
    {
      kind: "entry",
      label: entry.qualifiedName,
      path: entry.path,
      line: entry.range?.startLine,
      symbolId: entry.id,
      confidence: entry.confidence,
      reason: `${entry.kind} entry`
    }
  ];
  const directUsages = index.usageSites
    .filter((usage) => usage.usedBySymbolId === entry.id)
    .sort((a, b) => (a.range?.startLine ?? 0) - (b.range?.startLine ?? 0) || a.name.localeCompare(b.name))
    .slice(0, 30);
  for (const usage of directUsages) {
    const target = usage.targetSymbolId ? symbolsById.get(usage.targetSymbolId) : undefined;
    steps.push({
      kind: usage.kind === "call" ? "call" : usage.kind === "import" ? "import" : "reference",
      label: target?.qualifiedName ?? usage.name,
      path: usage.path,
      line: usage.range?.startLine,
      symbolId: usage.usedBySymbolId,
      targetSymbolId: usage.targetSymbolId,
      targetPath: target?.path ?? usage.path,
      confidence: usage.confidence,
      reason: usage.text
    });
  }
  steps.push(...typedWorkflowStepsForEntry(index, entry));
  for (const risk of index.risks.filter((candidate) => candidate.path === entry.path && rangesOverlap(candidate.range, entry.range)).slice(0, 12)) {
    steps.push({
      kind: "risk",
      label: risk.signal,
      path: risk.path,
      line: risk.range?.startLine,
      targetPath: risk.path,
      confidence: risk.confidence,
      reason: risk.reason
    });
  }
  return steps;
}

function typedWorkflowStepsForEntry(index: CodexaIndex, entry: SymbolFact): WorkflowStep[] {
  const steps: WorkflowStep[] = [];
  const routeEdges = index.graphEdges.filter((edge) => edge.fromSymbolId === entry.id && ["ROUTE_HANDLES", "ROUTE_CALLS_STORE"].includes(edge.edgeKind));
  const endpointIds = new Set(routeEdges.filter((edge) => edge.edgeKind === "ROUTE_HANDLES").map((edge) => edge.toId));
  for (const edge of routeEdges) {
    steps.push({
      kind: edge.edgeKind === "ROUTE_HANDLES" ? "endpoint" : "store",
      label: edge.reason,
      path: edge.fromPath ?? entry.path,
      line: edge.range?.startLine,
      symbolId: edge.fromSymbolId,
      targetPath: edge.toPath,
      targetSymbolId: edge.toSymbolId,
      confidence: edge.confidence,
      reason: edge.edgeKind
    });
  }
  for (const edge of index.graphEdges.filter((candidate) => endpointIds.has(candidate.toId) && ["UI_CALLS_ENDPOINT", "TEST_COVERS_WORKFLOW"].includes(candidate.edgeKind))) {
    steps.push({
      kind: edge.edgeKind === "UI_CALLS_ENDPOINT" ? "ui" : "test",
      label: edge.reason,
      path: edge.fromPath ?? entry.path,
      line: edge.range?.startLine,
      targetPath: edge.toPath,
      targetSymbolId: edge.toSymbolId,
      confidence: edge.confidence,
      reason: edge.edgeKind
    });
    if (edge.edgeKind === "UI_CALLS_ENDPOINT" && edge.fromPath) {
      steps.push(...uiFlowExpansionSteps(index, edge.fromPath));
    }
  }
  const storePaths = new Set(routeEdges.filter((edge) => edge.edgeKind === "ROUTE_CALLS_STORE").flatMap((edge) => [edge.toPath].filter((value): value is string => Boolean(value))));
  for (const edge of index.graphEdges.filter((candidate) => storePaths.has(candidate.fromPath ?? "") && candidate.edgeKind === "STORE_DISPATCHES_ADAPTER")) {
    steps.push({
      kind: "adapter",
      label: edge.reason,
      path: edge.fromPath ?? entry.path,
      line: edge.range?.startLine,
      targetPath: edge.toPath,
      targetSymbolId: edge.toSymbolId,
      confidence: edge.confidence,
      reason: edge.edgeKind
    });
  }
  return steps.sort((a, b) => a.kind.localeCompare(b.kind) || a.path.localeCompare(b.path) || (a.line ?? 0) - (b.line ?? 0));
}

function uiFlowExpansionSteps(index: CodexaIndex, uiPath: string): WorkflowStep[] {
  const interesting = /use[-_]?run[-_]?polling|useRunPolling|queue-dashboard|useQueueDashboard|polling|run-view|QueueDashboard/i;
  return index.graphEdges
    .filter((edge) => edge.fromPath === uiPath && ["CALLS", "REFERENCES", "IMPORTS"].includes(edge.edgeKind))
    .filter((edge) => interesting.test(edge.toPath ?? "") || interesting.test(edge.reason))
    .slice(0, 12)
    .map((edge) => ({
      kind: "ui" as const,
      label: edge.reason,
      path: edge.fromPath ?? uiPath,
      line: edge.range?.startLine,
      targetPath: edge.toPath,
      targetSymbolId: edge.toSymbolId,
      confidence: edge.confidence,
      reason: `ui dependency ${edge.edgeKind}`
    }));
}

function workflowFact(
  index: CodexaIndex,
  input: {
    workflowKind: WorkflowTraceFact["workflowKind"];
    title: string;
    entryPath: string;
    entrySymbolId?: string;
    steps: WorkflowStep[];
    relatedFiles: string[];
    tests: string[];
    rank: number;
    summary: string;
  }
): WorkflowTraceFact {
  return {
    id: stableId("workflow", input.workflowKind, input.entryPath, input.entrySymbolId, input.title),
    type: "WorkflowTrace",
    source: "heuristic",
    confidence: workflowConfidence(input.steps),
    snapshotId: index.snapshot.snapshotId,
    indexedAt: index.snapshot.indexedAt,
    path: input.entryPath,
    workflowKind: input.workflowKind,
    title: input.title,
    entryPath: input.entryPath,
    entrySymbolId: input.entrySymbolId,
    relatedFiles: input.relatedFiles,
    tests: input.tests,
    steps: input.steps,
    summary: input.summary,
    rank: input.rank
  };
}

function workflowConfidence(steps: WorkflowStep[]): Confidence {
  if (steps.some((step) => step.confidence === "authoritative")) {
    return steps.some((step) => step.confidence === "heuristic") ? "derived" : "authoritative";
  }
  if (steps.some((step) => step.confidence === "derived")) {
    return "derived";
  }
  return "heuristic";
}

function workflowRank(files: string[], tests: string[], fileRank: Map<string, number>, kind: WorkflowTraceFact["workflowKind"]): number {
  const base = kind === "route" ? 8 : kind === "job" ? 7 : kind === "manifest" ? 6 : 4;
  return base + files.reduce((sum, file) => sum + Math.log2((fileRank.get(file) ?? 0) + 1), 0) + tests.length * 2;
}

function summarizeWorkflow(kind: WorkflowTraceFact["workflowKind"], title: string, relatedFiles: string[], tests: string[]): string {
  const fileText = relatedFiles.slice(0, 5).join(", ") || "no related files";
  const testText = tests.slice(0, 3).join(", ") || "no direct tests";
  return `${kind} workflow ${title} touches ${relatedFiles.length} file(s): ${fileText}. Tests: ${testText}.`;
}

function relatedTests(index: CodexaIndex, relatedFiles: string[]): string[] {
  const related = new Set(relatedFiles);
  return uniqueSorted(
    index.testEdges
      .filter((edge) => edge.targetPath && related.has(edge.targetPath))
      .map((edge) => edge.path)
      .filter((pathValue) => pathValue)
  );
}

function isJobSymbol(symbol: SymbolFact): boolean {
  return symbol.decorators.some((decorator) => /(task|job|worker|celery|rq)/i.test(decorator));
}

function fileTarget(file: FileFact): GraphTarget {
  return { id: file.id, kind: "file", path: file.path, label: file.path };
}

function symbolTarget(symbol: SymbolFact): GraphTarget {
  return { id: symbol.id, kind: "symbol", path: symbol.path, symbolId: symbol.id, label: symbol.qualifiedName };
}

function riskTarget(risk: RiskSignalFact): GraphTarget {
  return { id: risk.id, kind: "risk", path: risk.path, label: risk.signal };
}

function rangesOverlap(a?: { startLine: number; endLine: number }, b?: { startLine: number; endLine: number }): boolean {
  if (!a || !b) {
    return true;
  }
  return a.startLine <= b.endLine && b.startLine <= a.endLine;
}
