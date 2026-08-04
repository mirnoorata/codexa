type ProjectionTier = "narrow" | "emergency" | "terminal";

const ADVANCED_MODES = new Set([
  "workflow_path",
  "freshness",
  "repo_map",
  "find_context",
  "context_pack",
  "focus_brief",
  "impact",
  "diff_impact",
  "change_review",
  "symbol_context",
  "callers",
  "callees",
  "dependency_path",
  "placeholder_report",
  "session_memory"
]);

/**
 * Project an advanced result into a small, mode-aware decision surface.
 * Counts always describe the source packet; top identities are only bounded
 * examples and therefore never substitute their length for a source count.
 */
export function advancedModeDecisionKernel(mode: string, data: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!ADVANCED_MODES.has(mode)) return undefined;
  if (data.ambiguous === true) {
    return projection("ambiguous", {
      query: bounded(data.query, 180),
      target: targetIdentity(data),
      counts: { candidateCount: count(data.candidates) },
      top: { candidates: identities(data.candidates, 3, symbolIdentity) }
    });
  }

  switch (mode) {
    case "workflow_path":
      return projection(count(data.workflows) > 0 ? "resolved" : "empty", {
        query: bounded(data.query, 180),
        counts: {
          workflowCount: count(data.workflows),
          fileCount: count(data.files),
          relatedFileCount: count(data.relatedFiles),
          testCount: count(data.tests),
          recommendationCount: count(data.testRecommendations)
        },
        top: {
          workflows: identities(data.workflows, 3, workflowIdentity),
          files: identities(data.files, 3, fileIdentity),
          tests: identities(data.tests, 2, fileIdentity)
        }
      });
    case "freshness": {
      const freshness = record(data.freshness) ?? data;
      const status = freshness.missing === true ? "missing" : freshness.stale === true ? "stale" : "fresh";
      return projection(status, {
        target: defined({ repoRoot: bounded(freshness.repoRoot, 240), headCommit: bounded(freshness.headCommit, 100), snapshotId: bounded(freshness.snapshotId, 100) }),
        counts: { dirtyFileCount: count(freshness.dirtyFiles), parserErrorCount: number(freshness.parserErrorCount) },
        detail: defined({ reason: bounded(freshness.reason, 160), indexedAt: bounded(freshness.indexedAt, 80) }),
        top: { dirtyFiles: identities(freshness.dirtyFiles, 3, fileIdentity) }
      });
    }
    case "repo_map":
      return projection(count(data.files) + count(data.modules) > 0 ? "resolved" : "empty", {
        counts: { moduleCount: count(data.modules), fileCount: count(data.files) },
        top: {
          modules: identities(data.modules, 3, moduleIdentity),
          files: identities(data.files, 3, fileIdentity)
        }
      });
    case "find_context": {
      const retrieval = record(data.retrieval);
      return projection(count(data.files) + count(data.symbols) + count(data.usageSites) > 0 ? "resolved" : "empty", {
        query: bounded(data.query, 180),
        counts: {
          fileCount: count(data.files),
          symbolCount: count(data.symbols),
          usageCount: count(data.usageSites),
          retrievalMatchCount: count(retrieval?.matches)
        },
        top: {
          files: identities(data.files, 3, fileIdentity),
          symbols: identities(data.symbols, 3, symbolIdentity),
          usages: identities(data.usageSites, 2, usageIdentity)
        }
      });
    }
    case "context_pack":
    case "focus_brief":
      return projection(count(data.focusFiles) + count(data.nextReads) > 0 ? "resolved" : "empty", {
        query: bounded(data.task ?? data.query, 180),
        counts: {
          focusFileCount: count(data.focusFiles),
          nextReadCount: count(data.nextReads),
          workflowCount: count(data.workflows),
          testCount: count(data.tests),
          commandCount: count(data.verificationCommands)
        },
        top: {
          focusFiles: identities(data.focusFiles, 3, fileIdentity),
          nextReads: identities(data.nextReads, 3, fileIdentity),
          workflows: identities(data.workflows, 2, workflowIdentity)
        }
      });
    case "impact": {
      if ((data.file === null && data.symbol === null) || (data.target === null)) {
        return projection("not_found", { target: targetIdentity(data), counts: { affectedFileCount: 0, testCount: 0 } });
      }
      const target = record(data.target);
      return projection(target || count(data.affectedFiles) > 0 ? "resolved" : "not_found", {
        target: targetIdentity(target ?? data),
        detail: defined({ changeType: bounded(data.changeType, 40), depth: number(data.depth) }),
        counts: {
          selectedFileCount: count(data.selectedFiles),
          affectedFileCount: count(data.affectedFiles),
          readFirstFileCount: count(data.readFirstFiles),
          testCount: count(data.tests)
        },
        top: {
          readFirstFiles: identities(data.readFirstFiles, 3, fileIdentity),
          affectedFiles: identities(data.affectedFiles, 3, impactIdentity),
          tests: identities(data.tests, 2, fileIdentity)
        }
      });
    }
    case "diff_impact": {
      const worktree = record(data.worktree);
      const changedCount = count(data.changedFiles);
      return projection(worktree?.degraded === true ? "degraded" : changedCount > 0 ? "dirty" : "clean", {
        counts: {
          changedFileCount: changedCount,
          changedEntryCount: count(data.changedEntries),
          changedSymbolCount: count(data.changedSymbols),
          indexedChangedCount: count(data.indexedChanged),
          unindexedChangedCount: count(data.unindexedChanged),
          groupCount: count(data.groups),
          impactCount: count(data.impacts)
        },
        detail: defined({ knownClean: worktree?.knownClean, degraded: worktree?.degraded }),
        top: {
          changedFiles: identities(data.changedEntries ?? data.changedFiles, 3, fileIdentity),
          changedSymbols: identities(data.changedSymbols, 3, symbolIdentity),
          groups: identities(data.groups, 2, groupIdentity),
          unindexedFiles: identities(data.unindexedChanged, 2, fileIdentity)
        }
      });
    }
    case "change_review": {
      const change = record(data.change);
      const verdict = record(data.verdict);
      const plan = record(data.plan);
      const verification = record(data.verification);
      const impact = record(data.impact);
      const evidence = record(data.evidenceChains);
      const changedCount = number(change?.changedFileCount) ?? count(change?.changedFiles);
      return projection(
        verdict?.blocking === true ? "blocked" : bounded(verdict?.status, 40) ?? (changedCount > 0 ? "review" : "clean"),
        {
          counts: {
            changedFileCount: changedCount,
            affectedFileCount: number(impact?.affectedFileCount),
            recommendedTestCount: count(verification?.recommendedTests),
            coveredTestCount: count(verification?.coveredTests),
            missingTestCount: count(verification?.missingTests),
            unplannedFileCount: count(plan?.unplannedFiles),
            evidenceChainCount: count(evidence?.chains),
            evidenceGapCount: count(evidence?.gaps)
          },
          detail: defined({ policyMode: bounded(data.policyMode, 40), planConformance: bounded(plan?.conformance, 40), blocking: verdict?.blocking }),
          top: {
            changedFiles: identities(change?.entries ?? change?.changedFiles, 3, fileIdentity),
            affectedFiles: identities(impact?.affectedFiles, 3, fileIdentity),
            tests: identities(verification?.recommendedTests, 2, fileIdentity),
            evidenceChains: identities(evidence?.chains, 2, evidenceChainIdentity)
          }
        }
      );
    }
    case "symbol_context": {
      if (data.symbol === null) return projection("not_found", { counts: { candidateCount: count(data.candidates) }, top: { candidates: identities(data.candidates, 3, symbolIdentity) } });
      const radius = record(data.impactRadius);
      return projection(record(data.symbol) ? "resolved" : "not_found", {
        target: symbolIdentity(data.symbol),
        detail: defined({ depth: number(radius?.depth) }),
        counts: {
          callerCount: count(data.callers),
          calleeCount: count(data.callees),
          importerCount: count(data.importers),
          referenceCount: count(data.references),
          implementationCount: count(data.implementations),
          testCount: count(data.tests),
          riskCount: count(data.risks),
          impactedFileCount: number(radius?.fileCount) ?? count(radius?.files),
          edgeCount: number(radius?.edgeCount)
        },
        top: {
          callers: identities(data.callers, 2, edgeIdentity),
          callees: identities(data.callees, 2, edgeIdentity),
          tests: identities(data.tests, 2, fileIdentity),
          risks: identities(data.risks, 2, riskIdentity),
          impactedFiles: identities(radius?.files, 2, fileIdentity)
        }
      });
    }
    case "callers":
    case "callees":
      return projection(record(data.target) ? "resolved" : "needs_target", {
        target: targetIdentity(data.target),
        counts: { edgeCount: count(data.edges), fileCount: count(data.files) },
        top: {
          edges: identities(data.edges, 3, edgeIdentity),
          files: identities(data.files, 3, fileIdentity)
        }
      });
    case "dependency_path": {
      const pathCount = count(data.path);
      return projection(record(data.from) && record(data.to) ? (pathCount > 0 ? "resolved" : "no_path") : "needs_target", {
        target: defined({ from: targetLabel(data.from), to: targetLabel(data.to) }),
        counts: { edgeCount: pathCount, fileCount: count(data.files) },
        detail: { pathFound: pathCount > 0 },
        top: {
          edges: identities(data.path, 3, edgeIdentity),
          files: identities(data.files, 3, fileIdentity)
        }
      });
    }
    case "placeholder_report": {
      const returnedCount = count(data.findings);
      const total = number(data.totalFindings) ?? returnedCount;
      return projection(total > 0 ? "findings" : "clear", {
        counts: {
          totalFindingCount: total,
          returnedFindingCount: returnedCount,
          excludedByFilterCount: number(data.excludedByFilter) ?? 0,
          hiddenByLimitCount: number(data.hiddenByLimit) ?? 0,
          affectedFileCount: count(data.topFiles)
        },
        top: {
          findings: identities(data.findings, 3, findingIdentity),
          files: identities(data.topFiles, 3, fileIdentity),
          categories: categoryIdentities(data.categories, 3)
        }
      });
    }
    case "session_memory": {
      const memory = record(data.memory);
      const writes = record(data.writes);
      const entries = memory?.entries;
      return projection(count(entries) > 0 ? "resolved" : "empty", {
        target: defined({ sessionId: bounded(data.sessionId, 120), taskId: bounded(data.taskId, 120) }),
        detail: defined({ action: bounded(data.action, 30), revision: number(data.revision), compacted: writes?.compacted }),
        counts: {
          entryCount: count(entries),
          staleEntryCount: count(memory?.staleEntries),
          warningCount: count(data.warnings),
          recordedEntryCount: count(writes?.recordedEntryIds),
          viewedCount: count(memory?.viewed),
          claimCount: count(memory?.claims),
          decisionCount: count(memory?.decisions),
          verificationCount: count(memory?.verification),
          riskCount: count(memory?.risks),
          constraintCount: count(memory?.constraints)
        },
        top: {
          entries: identities(entries, 3, memoryIdentity),
          warnings: identities(data.warnings, 2, textIdentity)
        }
      });
    }
  }
}

export function compactAdvancedModeKernel(value: unknown, tier: ProjectionTier = "narrow"): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  const groupLimit = tier === "narrow" ? 5 : tier === "emergency" ? 3 : 2;
  const itemLimit = tier === "narrow" ? 2 : 1;
  const topValue = record(value.top);
  const top = topValue
    ? defined(Object.fromEntries(Object.entries(topValue).slice(0, groupLimit).map(([key, entries]) => [key, compactIdentityList(entries, itemLimit)])))
    : undefined;
  return defined({
    status: bounded(value.status, 40),
    query: tier === "terminal" ? undefined : bounded(value.query, tier === "narrow" ? 160 : 100),
    target: compactObject(value.target, tier === "terminal" ? 4 : 8),
    detail: compactObject(value.detail, tier === "terminal" ? 4 : 8),
    counts: numericRecord(value.counts, 20),
    top
  });
}

export function renderAdvancedModeKernel(value: unknown): string[] {
  if (!isRecord(value)) return [];
  const target = record(value.target);
  const counts = record(value.counts);
  const detail = record(value.detail);
  const summaryParts = [
    `status ${string(value.status) ?? "unknown"}`,
    target && Object.keys(target).length > 0 ? `target ${renderObject(target)}` : undefined,
    detail && Object.keys(detail).length > 0 ? renderObject(detail) : undefined,
    counts && Object.keys(counts).length > 0 ? `counts ${Object.entries(counts).map(([key, entry]) => `${key}=${String(entry)}`).join(", ")}` : undefined
  ].filter((entry): entry is string => Boolean(entry));
  const lines = [`Result: ${summaryParts.join("; ")}`];
  const top = record(value.top);
  for (const [group, entries] of Object.entries(top ?? {}).slice(0, 4)) {
    if (!Array.isArray(entries) || entries.length === 0) continue;
    lines.push(`Top ${group}: ${entries.slice(0, 3).map(renderIdentity).join(" | ")}`);
  }
  return lines.map((line) => clip(line, 520));
}

function projection(status: string, value: Record<string, unknown>): Record<string, unknown> {
  return defined({ status, ...value });
}

function identities(value: unknown, limit: number, project: (entry: unknown) => unknown): unknown[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  return value.slice(0, limit).map(project).filter((entry) => entry !== undefined);
}

function fileIdentity(value: unknown): unknown {
  if (typeof value === "string") return { path: bounded(value, 220) };
  if (!isRecord(value)) return undefined;
  const nested = record(value.file);
  const source = nested ?? value;
  return defined({
    path: bounded(source.path ?? value.path ?? value.file, 220),
    language: bounded(source.language, 40),
    rank: number(source.rank),
    risk: number(source.riskScore),
    count: number(value.count),
    score: number(value.score),
    status: bounded(value.status, 50),
    confidence: bounded(value.confidence ?? source.confidence, 40),
    reason: bounded(value.reason, 140)
  });
}

function symbolIdentity(value: unknown): unknown {
  if (!isRecord(value)) return typeof value === "string" ? { name: bounded(value, 180) } : undefined;
  const nested = record(value.symbol);
  const source = nested ?? value;
  return defined({
    id: bounded(source.id, 140),
    name: bounded(source.qualifiedName ?? source.name ?? value.name, 180),
    path: bounded(source.path ?? value.path, 220),
    kind: bounded(source.kind, 50),
    confidence: bounded(source.confidence ?? value.confidence, 40)
  });
}

function moduleIdentity(value: unknown): unknown {
  if (!isRecord(value)) return undefined;
  return defined({ name: bounded(value.name, 160), fileCount: count(value.files), rank: number(value.rank) });
}

function workflowIdentity(value: unknown): unknown {
  if (!isRecord(value)) return undefined;
  return defined({
    id: bounded(value.id, 140),
    name: bounded(value.title ?? value.name, 180),
    kind: bounded(value.workflowKind ?? value.kind, 60),
    path: bounded(value.entryPath ?? value.path, 220),
    confidence: bounded(value.confidence, 40)
  });
}

function usageIdentity(value: unknown): unknown {
  if (!isRecord(value)) return undefined;
  return defined({ name: bounded(value.name, 160), path: bounded(value.path, 220), kind: bounded(value.kind, 60), confidence: bounded(value.confidence, 40) });
}

function edgeIdentity(value: unknown): unknown {
  if (!isRecord(value)) return undefined;
  return defined({
    kind: bounded(value.edgeKind ?? value.kind, 60),
    from: bounded(value.fromPath ?? value.fromId, 180),
    to: bounded(value.toPath ?? value.toId, 180),
    confidence: bounded(value.confidence, 40),
    reason: bounded(value.reason, 120)
  });
}

function evidenceChainIdentity(value: unknown): unknown {
  if (!isRecord(value)) return undefined;
  const anchor = record(value.anchor);
  return defined({
    id: bounded(value.chainId, 140),
    name: bounded(value.summary, 180),
    kind: bounded(value.purpose, 60),
    path: bounded(anchor?.path, 220),
    confidence: bounded(value.confidence, 40)
  });
}

function impactIdentity(value: unknown): unknown {
  if (!isRecord(value)) return fileIdentity(value);
  const identity = fileIdentity(value);
  return isRecord(identity) ? defined({ ...identity, depth: number(value.depth), reasons: strings(value.reasons, 2) }) : identity;
}

function groupIdentity(value: unknown): unknown {
  if (!isRecord(value)) return undefined;
  return defined({ name: bounded(value.name ?? value.title ?? value.kind, 160), fileCount: count(value.files), symbolCount: count(value.symbols), confidence: bounded(value.confidence, 40) });
}

function riskIdentity(value: unknown): unknown {
  if (!isRecord(value)) return undefined;
  return defined({ name: bounded(value.signal ?? value.name, 140), path: bounded(value.path, 220), status: bounded(value.status, 50), reason: bounded(value.reason, 140), confidence: bounded(value.confidence, 40) });
}

function findingIdentity(value: unknown): unknown {
  if (!isRecord(value)) return undefined;
  return defined({ path: bounded(value.path, 220), line: number(value.line), name: bounded(value.signal, 140), kind: bounded(value.category, 60), score: number(value.score), confidence: bounded(value.confidence, 40) });
}

function memoryIdentity(value: unknown): unknown {
  if (!isRecord(value)) return undefined;
  const provenance = bounded(value.provenance, 40);
  const summary = sanitizeSummary(value.summary);
  return defined({
    id: bounded(value.id, 140),
    kind: bounded(value.kind, 50),
    status: bounded(value.status, 50),
    provenance,
    trust: provenance === "codexa-derived" ? "derived" : "untrusted",
    summary
  });
}

function textIdentity(value: unknown): unknown {
  return typeof value === "string" ? { summary: sanitizeSummary(value) } : undefined;
}

function categoryIdentities(value: unknown, limit: number): unknown[] | undefined {
  if (!isRecord(value)) return undefined;
  const entries = Object.entries(value)
    .filter((entry): entry is [string, number] => typeof entry[1] === "number")
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, limit)
    .map(([name, countValue]) => ({ name: bounded(name, 100), count: countValue }));
  return entries.length > 0 ? entries : undefined;
}

function targetIdentity(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  const file = record(value.file);
  const symbol = record(value.symbol);
  return defined({
    label: bounded(value.label, 180),
    file: bounded(file?.path ?? (typeof value.file === "string" ? value.file : undefined), 220),
    symbol: bounded(symbol?.qualifiedName ?? symbol?.name ?? symbol?.id ?? (typeof value.symbol === "string" ? value.symbol : undefined), 180),
    path: bounded(value.path, 220),
    query: bounded(value.query, 180)
  });
}

function targetLabel(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  return bounded(value.label ?? record(value.symbol)?.qualifiedName ?? record(value.file)?.path, 180);
}

function compactIdentityList(value: unknown, limit: number): unknown[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  return value.slice(0, limit).map((entry) => compactObject(entry, 8) ?? bounded(entry, 180)).filter((entry) => entry !== undefined);
}

function compactObject(value: unknown, keyLimit: number): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value).slice(0, keyLimit)) {
    if (typeof entry === "string") output[key] = bounded(entry, 180);
    else if (typeof entry === "number" || typeof entry === "boolean" || entry === null) output[key] = entry;
    else if (Array.isArray(entry)) output[key] = strings(entry, 2);
  }
  return defined(output);
}

function numericRecord(value: unknown, limit: number): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  return defined(Object.fromEntries(Object.entries(value).filter(([, entry]) => typeof entry === "number" || typeof entry === "boolean").slice(0, limit)));
}

function renderIdentity(value: unknown): string {
  if (!isRecord(value)) return clip(String(value), 180);
  const label = string(value.name) ?? string(value.path) ?? string(value.label) ?? string(value.id) ?? string(value.summary) ?? "item";
  const location = string(value.path) && label !== value.path ? ` at ${value.path}` : "";
  const edge = string(value.from) || string(value.to) ? `${string(value.from) ?? "?"}->${string(value.to) ?? "?"}` : undefined;
  const kind = string(value.kind) ? ` (${value.kind})` : "";
  const trust = value.trust === "untrusted" ? "untrusted " : "";
  const summary = string(value.summary) && label !== value.summary ? `: \"${value.summary}\"` : "";
  return clip(`${trust}${edge ?? label}${location}${kind}${summary}`, 220);
}

function renderObject(value: Record<string, unknown>): string {
  return Object.entries(value).map(([key, entry]) => `${key}=${String(entry)}`).join(", ");
}

function sanitizeSummary(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const sanitized = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, " ").replace(/\s+/gu, " ").trim();
  return sanitized ? sanitized.slice(0, 180) : undefined;
}

function strings(value: unknown, limit: number): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const output = value.filter((entry): entry is string => typeof entry === "string").slice(0, limit).map((entry) => entry.slice(0, 180));
  return output.length > 0 ? output : undefined;
}

function count(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function string(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function bounded(value: unknown, limit: number): string | undefined {
  return string(value)?.slice(0, limit);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function defined(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined && (!Array.isArray(entry) || entry.length > 0) && (!isRecord(entry) || Object.keys(entry).length > 0)));
}

function clip(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, Math.max(0, limit - 1))}…`;
}
