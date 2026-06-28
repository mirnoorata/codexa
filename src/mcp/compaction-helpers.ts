export type McpTruncation = Record<string, { total: number; returned: number }>;

export function createArrayLimiter(): ((name: string, value: unknown, limit: number, map?: (entry: unknown) => unknown) => unknown) & {
  truncation: Record<string, { total: number; returned: number }>;
} {
  const truncation: Record<string, { total: number; returned: number }> = {};
  const limiter = ((name: string, value: unknown, limit: number, map?: (entry: unknown) => unknown): unknown => {
    if (!Array.isArray(value)) {
      return value;
    }
    const returned = value.slice(0, limit).map((entry) => (map ? map(entry) : entry));
    if (value.length > limit) {
      truncation[name] = { total: value.length, returned: limit };
    }
    return returned;
  }) as ((name: string, value: unknown, limit: number, map?: (entry: unknown) => unknown) => unknown) & {
    truncation: Record<string, { total: number; returned: number }>;
  };
  limiter.truncation = truncation;
  return limiter;
}

export function prefixTruncation(prefix: string, truncation: Record<string, { total: number; returned: number }> | undefined): Record<string, { total: number; returned: number }> {
  if (!truncation) {
    return {};
  }
  return Object.fromEntries(Object.entries(truncation).map(([key, value]) => [`${prefix}.${key}`, value]));
}

export function nestedTruncation(prefix: string, truncation: Record<string, { total: number; returned: number }>): Record<string, { total: number; returned: number }> | undefined {
  const nestedPrefix = `${prefix}.`;
  const nested = Object.fromEntries(Object.entries(truncation).filter(([key]) => key.startsWith(nestedPrefix)).map(([key, value]) => [key.slice(nestedPrefix.length), value]));
  return Object.keys(nested).length > 0 ? nested : undefined;
}

export function compactFileFact(value: unknown): unknown {
  if (!isRecord(value)) {
    return value;
  }
  const record = value;
  return {
    id: record.id,
    type: record.type,
    path: record.path,
    language: record.language,
    dirty: record.dirty,
    generated: record.generated,
    test: record.test,
    rank: record.rank,
    symbolCount: record.symbolCount,
    usageCount: record.usageCount,
    importCount: record.importCount,
    riskScore: record.riskScore,
    source: record.source,
    confidence: record.confidence
  };
}

export function compactFocusEntry(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  const record = value as Record<string, unknown>;
  const truncation: Record<string, { total: number; returned: number }> = {};
  const reasons = compactArrayField("reasons", record.reasons, 10, truncation);
  const matchedTerms = compactArrayField("matchedTerms", record.matchedTerms, 12, truncation);
  return {
    file: compactFileFact(record.file),
    reasons: reasons.value,
    rank: record.rank,
    score: record.score,
    tier: record.tier,
    matchedTerms: matchedTerms.value,
    truncation: Object.keys(truncation).length > 0 ? truncation : undefined
  };
}

export function compactTestRecommendation(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  const record = value as Record<string, unknown>;
  return {
    path: record.path,
    reason: record.reason,
    rank: record.rank,
    evidenceTier: record.evidenceTier,
    command: record.command,
    commandSource: record.commandSource,
    commandConfidence: record.commandConfidence,
    provenance: record.provenance
  };
}

export function compactNextTools(value: unknown, truncation?: McpTruncation, pathName = "nextTools"): unknown {
  if (!Array.isArray(value)) {
    return value;
  }
  if (value.length > 8 && truncation) {
    truncation[pathName] = { total: value.length, returned: 8 };
  }
  return value.slice(0, 8).map((entry, index) => compactNextTool(entry, truncation, `${pathName}.${index}`));
}

export function compactNextTool(value: unknown, truncation?: McpTruncation, pathName = "nextTools.entry"): unknown {
  if (typeof value === "string") {
    return value;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  const record = value as Record<string, unknown>;
  const localTruncation: McpTruncation = {};
  return {
    schemaVersion: record.schemaVersion,
    tool: record.tool,
    reason: typeof record.reason === "string" ? record.reason.slice(0, 240) : record.reason,
    requiredInputs: compactGenericValue(record.requiredInputs, { arrayLimit: 8, objectKeyLimit: 16, maxDepth: 3 }, truncation ?? localTruncation, `${pathName}.requiredInputs`),
    readOnly: record.readOnly,
    writes: limitArray(record.writes, 8)
  };
}

export function compactCommandEnvelope(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  const record = value as Record<string, unknown>;
  return {
    command: typeof record.command === "string" ? redactMcpText(record.command) : record.command,
    cwd: typeof record.cwd === "string" ? redactMcpText(record.cwd) : record.cwd,
    packageManager: typeof record.packageManager === "string" ? redactMcpText(record.packageManager) : record.packageManager,
    workspace: typeof record.workspace === "string" ? redactMcpText(record.workspace) : record.workspace,
    packageRoot: typeof record.packageRoot === "string" ? redactMcpText(record.packageRoot) : record.packageRoot,
    packageName: typeof record.packageName === "string" ? redactMcpText(record.packageName) : record.packageName,
    scriptName: typeof record.scriptName === "string" ? redactMcpText(record.scriptName) : record.scriptName,
    args: Array.isArray(record.args) ? sanitizeCommandArgs(record.args.slice(0, 20)) : record.args,
    argsTruncated: Array.isArray(record.args) && record.args.length > 20 ? { total: record.args.length, returned: 20 } : undefined,
    exitCode: record.exitCode,
    durationMs: record.durationMs,
    stdoutSummary: typeof record.stdoutSummary === "string" ? redactMcpText(record.stdoutSummary) : record.stdoutSummary,
    stderrSummary: typeof record.stderrSummary === "string" ? redactMcpText(record.stderrSummary) : record.stderrSummary,
    outputSummary: typeof record.outputSummary === "string" ? redactMcpText(record.outputSummary) : record.outputSummary,
    source: record.source,
    scopeStatus: record.scopeStatus,
    classifierVersion: record.classifierVersion
  };
}

export function compactCommandReportList(value: unknown, limit: number): unknown {
  return Array.isArray(value) ? value.slice(0, limit).map(compactCommandReport) : value;
}

export function compactCommandEnvelopeList(value: unknown, limit: number): unknown {
  return Array.isArray(value) ? value.slice(0, limit).map(compactCommandEnvelope) : value;
}

export function compactCommandReport(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  const record = value as Record<string, unknown>;
  return {
    ...record,
    command: typeof record.command === "string" ? redactMcpText(record.command) : record.command,
    cwd: typeof record.cwd === "string" ? redactMcpText(record.cwd) : record.cwd,
    workspace: typeof record.workspace === "string" ? redactMcpText(record.workspace) : record.workspace,
    packageRoot: typeof record.packageRoot === "string" ? redactMcpText(record.packageRoot) : record.packageRoot,
    packageName: typeof record.packageName === "string" ? redactMcpText(record.packageName) : record.packageName,
    packageManager: typeof record.packageManager === "string" ? redactMcpText(record.packageManager) : record.packageManager,
    scriptName: typeof record.scriptName === "string" ? redactMcpText(record.scriptName) : record.scriptName,
    args: Array.isArray(record.args) ? sanitizeCommandArgs(record.args) : record.args,
    stdoutSummary: typeof record.stdoutSummary === "string" ? redactMcpText(record.stdoutSummary) : record.stdoutSummary,
    stderrSummary: typeof record.stderrSummary === "string" ? redactMcpText(record.stderrSummary) : record.stderrSummary,
    outputSummary: typeof record.outputSummary === "string" ? redactMcpText(record.outputSummary) : record.outputSummary
  };
}

export function sanitizeCommandArgs(args: unknown[]): unknown[] {
  let redactNext = false;
  return args.map((arg) => {
    if (typeof arg !== "string") {
      return arg;
    }
    if (redactNext) {
      redactNext = false;
      return "<redacted>";
    }
    if (isSecretFlag(arg) && !arg.includes("=")) {
      redactNext = true;
      return redactMcpText(arg) ?? "";
    }
    return redactMcpText(redactSecretArg(arg)) ?? "";
  });
}

export function redactMcpText(value: string | undefined): string | undefined {
  return redactSecretText(value)
    ?.replace(/(^|[\s([,{])\/[^\s;|)\]'",]+/gu, "$1<abs-path>")
    .replace(/(^|[\s([,{])(?:\.\.?\/)[^\s;|)\]'",]+/gu, "$1<rel-path>");
}

export function redactSecretText(value: string | undefined): string | undefined {
  return value
    ?.replace(/(^|[\s([,{])((?:--?[a-z0-9-]*(?:token|secret|password|passwd|pwd|api[-_]?key|access[-_]?key|auth|credential|cookie)[a-z0-9-]*)(?:=|\s+))([^\s;|)\]'",]+)/giu, "$1$2<redacted>")
    .replace(/(\b[A-Z_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|PWD|API_?KEY|ACCESS_?KEY|AUTH|CREDENTIAL|COOKIE)[A-Z0-9_]*=)([^\s;|)\]'",]+)/gu, "$1<redacted>")
    .replace(/\b(Bearer)\s+[A-Za-z0-9._~+/-]+=*/giu, "$1 <redacted>");
}

export function redactSecretArg(value: string): string {
  if (/^Bearer\s+/iu.test(value)) {
    return "Bearer <redacted>";
  }
  if (isSecretFlag(value) && value.includes("=")) {
    return value.replace(/=.*/u, "=<redacted>");
  }
  if (/^(?:[A-Z_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|PWD|API_?KEY|ACCESS_?KEY|AUTH|CREDENTIAL|COOKIE)[A-Z0-9_]*)=/iu.test(value)) {
    return value.replace(/=.*/u, "=<redacted>");
  }
  return value;
}

export function isSecretFlag(value: string): boolean {
  return /^--?[a-z0-9-]*(?:token|secret|password|passwd|pwd|api-?key|access-?key|auth|credential|cookie)[a-z0-9-]*(?:=.*)?$/iu.test(value);
}

export function compactWorkflow(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  const record = value as Record<string, unknown>;
  const truncation: Record<string, { total: number; returned: number }> = {};
  const relatedFiles = compactArrayField("relatedFiles", record.relatedFiles, 20, truncation);
  const tests = compactArrayField("tests", record.tests, 20, truncation);
  const steps = compactArrayField("steps", record.steps, 16, truncation, compactWorkflowStep);
  return {
    id: record.id,
    title: record.title,
    workflowKind: record.workflowKind,
    entryPath: record.entryPath,
    relatedFiles: relatedFiles.value,
    tests: tests.value,
    summary: record.summary,
    rank: record.rank,
    confidence: record.confidence,
    steps: steps.value,
    truncation: Object.keys(truncation).length > 0 ? truncation : undefined
  };
}

export function compactWorkflowStep(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  const record = value as Record<string, unknown>;
  return {
    kind: record.kind,
    label: record.label,
    path: record.path,
    line: record.line,
    targetPath: record.targetPath,
    confidence: record.confidence,
    reason: record.reason
  };
}

export function compactModule(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  const record = value as Record<string, unknown>;
  const truncation: Record<string, { total: number; returned: number }> = {};
  const files = compactArrayField("files", record.files, 20, truncation);
  const reasons = compactArrayField("reasons", record.reasons, 10, truncation);
  return {
    name: record.name,
    score: record.score,
    rank: record.rank,
    summary: record.summary,
    files: files.value,
    reasons: reasons.value,
    truncation: Object.keys(truncation).length > 0 ? truncation : undefined
  };
}

export function compactGroup(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  const record = value as Record<string, unknown>;
  const truncation: Record<string, { total: number; returned: number }> = {};
  const files = compactArrayField("files", record.files, 30, truncation);
  const symbols = compactArrayField("symbols", record.symbols, 20, truncation);
  return {
    name: record.name,
    module: record.module,
    kind: record.kind,
    language: record.language,
    risk: record.risk,
    files: files.value,
    changes: record.changes,
    symbols: symbols.value,
    truncation: Object.keys(truncation).length > 0 ? truncation : undefined
  };
}

export function compactChangedEntry(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  const record = value as Record<string, unknown>;
  return { path: record.path, status: record.status, oldPath: record.oldPath };
}

export function compactSymbolLike(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  const record = value as Record<string, unknown>;
  return {
    id: record.id,
    path: record.path,
    name: record.name,
    qualifiedName: record.qualifiedName,
    kind: record.kind,
    exported: record.exported,
    line: typeof record.line === "number" ? record.line : undefined,
    range: record.range
  };
}

export function compactVerificationCoverage(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  const record = value as Record<string, unknown>;
  const truncation: Record<string, { total: number; returned: number }> = {};
  const details = compactArrayField("details", record.details, 8, truncation);
  return {
    kind: record.kind,
    command: record.command,
    source: record.source,
    confidence: record.confidence,
    scope: record.scope,
    targetPath: record.targetPath,
    details: details.value,
    exitCode: record.exitCode,
    durationMs: record.durationMs,
    outputSummary: record.outputSummary,
    commandEnvelope: compactCommandEnvelope(record.commandEnvelope),
    truncation: Object.keys(truncation).length > 0 ? truncation : undefined
  };
}

export function compactVerificationPlan(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  const record = value as Record<string, unknown>;
  const truncation: Record<string, { total: number; returned: number }> = {};
  const covers = compactArrayField("covers", record.covers, 12, truncation);
  const targetPaths = compactArrayField("targetPaths", record.targetPaths, 20, truncation);
  const scopes = compactArrayField("scopes", record.scopes, 12, truncation);
  const sources = compactArrayField("sources", record.sources, 12, truncation);
  return {
    command: record.command,
    covers: covers.value,
    targetPaths: targetPaths.value,
    scopes: scopes.value,
    sources: sources.value,
    confidence: record.confidence,
    truncation: Object.keys(truncation).length > 0 ? truncation : undefined
  };
}

export function compactVerificationLedgerEntry(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  const record = value as Record<string, unknown>;
  const truncation: Record<string, { total: number; returned: number }> = {};
  const evidence = compactArrayField("evidence", record.evidence, 8, truncation);
  const coverageKinds = compactArrayField("coverageKinds", record.coverageKinds, 12, truncation);
  return {
    kind: record.kind,
    recommended: record.recommended,
    target: record.target,
    status: record.status,
    evidence: evidence.value,
    missingReason: record.missingReason,
    waiverReason: record.waiverReason,
    notApplicableReason: record.notApplicableReason,
    coverageKinds: coverageKinds.value,
    command: record.command,
    source: record.source,
    truncation: Object.keys(truncation).length > 0 ? truncation : undefined
  };
}

export function compactCheck(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  const record = value as Record<string, unknown>;
  const truncation: Record<string, { total: number; returned: number }> = {};
  const evidence = compactArrayField("evidence", record.evidence, 8, truncation);
  return {
    kind: record.kind,
    target: record.target,
    status: record.status,
    reason: record.reason,
    evidence: evidence.value,
    truncation: Object.keys(truncation).length > 0 ? truncation : undefined
  };
}

export function compactRetrieval(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  const record = value as Record<string, unknown>;
  const limit = createArrayLimiter();
  const intentConfidence = compactIntentConfidence(record.intentConfidence);
  return {
    broad: record.broad,
    intents: limit("intents", record.intents, 12),
    diagnostics: limit("diagnostics", record.diagnostics, 20),
    intentConfidence,
    modules: limit("modules", record.modules, 20, compactModule),
    workflows: limit("workflows", record.workflows, 12, compactWorkflow),
    matchCount: Array.isArray(record.matches) ? record.matches.length : undefined,
    matches: limit("matches", record.matches, 20, compactFocusEntry),
    truncation: Object.keys(limit.truncation).length > 0 ? limit.truncation : undefined
  };
}

export function compactIntentConfidence(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  const record = value as Record<string, unknown>;
  const limit = createArrayLimiter();
  const compacted = {
    ...record,
    anchors: limit("anchors", record.anchors, 6),
    missingAnchors: limit("missingAnchors", record.missingAnchors, 6),
    reasons: limit("reasons", record.reasons, 12)
  };
  return {
    ...compacted,
    truncation: Object.keys(limit.truncation).length > 0 ? limit.truncation : undefined
  };
}

export function compactSession(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  const record = value as Record<string, unknown>;
  const limit = createArrayLimiter();
  const compacted = {
    repoRoot: record.repoRoot,
    routingSource: record.routingSource,
    focusReason: record.focusReason,
    workspaceSessionId: record.workspaceSessionId,
    commandBudgetMs: record.commandBudgetMs,
    maxResultBytes: record.maxResultBytes,
    maxResults: record.maxResults,
    provenance: limit("provenance", record.provenance, 30)
  };
  return {
    ...compacted,
    truncation: Object.keys(limit.truncation).length > 0 ? limit.truncation : undefined
  };
}

export function compactArrayField(
  name: string,
  value: unknown,
  limit: number,
  truncation: Record<string, { total: number; returned: number }>,
  map?: (entry: unknown) => unknown
): { value: unknown; truncation?: Record<string, { total: number; returned: number }> } {
  if (!Array.isArray(value)) {
    return { value };
  }
  const returned = value.slice(0, limit).map((entry) => (map ? map(entry) : entry));
  if (value.length > limit) {
    truncation[name] = { total: value.length, returned: limit };
  }
  return { value: returned, truncation: value.length > limit ? { [name]: { total: value.length, returned: limit } } : undefined };
}

export interface GenericCompactOptions {
  arrayLimit: number;
  objectKeyLimit: number;
  maxDepth: number;
}

export function compactGenericValue(value: unknown, options: GenericCompactOptions, truncation: McpTruncation, pathName = "value", depth = options.maxDepth): unknown {
  if (Array.isArray(value)) {
    const returned = value.slice(0, options.arrayLimit).map((entry) => compactGenericValue(entry, options, truncation, pathName, depth - 1));
    if (value.length > options.arrayLimit) {
      truncation[pathName] = { total: value.length, returned: options.arrayLimit };
    }
    return returned;
  }
  if (!isRecord(value)) {
    return value;
  }
  const entries = Object.entries(value).filter(([key]) => key !== "mcp");
  if (depth <= 0) {
    const keys = entries.map(([key]) => key);
    if (keys.length > options.objectKeyLimit) {
      truncation[`${pathName}.__keys`] = { total: keys.length, returned: options.objectKeyLimit };
    }
    return {
      compactedObject: true,
      keyCount: keys.length,
      keys: keys.slice(0, options.objectKeyLimit)
    };
  }
  const selected = entries.slice(0, options.objectKeyLimit);
  if (entries.length > options.objectKeyLimit) {
    truncation[`${pathName}.__keys`] = { total: entries.length, returned: options.objectKeyLimit };
  }
  return Object.fromEntries(
    selected.map(([key, entry]) => [key, compactGenericValue(entry, options, truncation, pathName === "value" ? key : `${pathName}.${key}`, depth - 1)])
  );
}

export function compactSummaryArray(name: string, value: unknown, limit: number, truncation: McpTruncation, map?: (entry: unknown) => unknown): unknown {
  if (!Array.isArray(value)) {
    return value;
  }
  const returned = value.slice(0, limit).map((entry) => (map ? map(entry) : entry));
  if (value.length > limit) {
    const previous = truncation[name];
    truncation[name] = { total: Math.max(previous?.total ?? 0, value.length), returned: limit };
  }
  return returned;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function clampLargeStrings(value: unknown, maxLength = 1000): { value: unknown; stringTruncations: number } {
  let stringTruncations = 0;
  const visit = (entry: unknown, depth: number): unknown => {
    if (typeof entry === "string") {
      if (entry.length <= maxLength) {
        return entry;
      }
      stringTruncations += 1;
      return `${entry.slice(0, maxLength - 3)}...`;
    }
    if (depth <= 0 || !entry || typeof entry !== "object") {
      return entry;
    }
    if (Array.isArray(entry)) {
      return entry.map((item) => visit(item, depth - 1));
    }
    return Object.fromEntries(Object.entries(entry as Record<string, unknown>).map(([key, item]) => [key, visit(item, depth - 1)]));
  };
  return { value: visit(value, 12), stringTruncations };
}

export function structuredByteLength(value: unknown): number {
  try {
    const serialized = JSON.stringify(value);
    return serialized ? Buffer.byteLength(serialized, "utf8") : 0;
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

export function truncatedArray(name: string, value: unknown, limit: number): Record<string, { total: number; returned: number }> {
  return Array.isArray(value) && value.length > limit ? { [name]: { total: value.length, returned: limit } } : {};
}

export function limitArray(value: unknown, limit: number): unknown {
  return Array.isArray(value) ? value.slice(0, limit) : value;
}

export function nonEmptyArray(value: unknown): value is unknown[] {
  return Array.isArray(value) && value.length > 0;
}

export function compactSnapshotLoad(value: unknown): unknown {
  if (!isRecord(value)) {
    return value;
  }
  return {
    taskId: value.taskId,
    path: typeof value.path === "string" ? value.path.split("/.codex/").pop()?.replace(/^/, ".codex/") ?? value.path : value.path,
    missingReason: value.missingReason,
    error: value.error,
    recoveredLatest: value.recoveredLatest,
    ambiguousLatest: value.ambiguousLatest,
    ambiguityReason: value.ambiguityReason
  };
}

export function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
