import type { CodexaIndex, SessionMemoryInput, SessionMemoryRef, SessionMemoryScope } from "../types.js";
import { normalizePath, stableId, uniqueSorted } from "../util.js";
import { MAX_DETAILS_CHARS, MAX_REFS_PER_ENTRY, MAX_SUMMARY_CHARS } from "./model.js";

export function isOrientationOnlyChangePlan(toolName: string, data: unknown): boolean {
  if (toolName !== "change_plan" || !isRecord(data)) {
    return false;
  }
  const editReadiness = isRecord(data.editReadiness) ? data.editReadiness : undefined;
  return editReadiness?.status === "orientation-only" || editReadiness?.editable === false;
}

export function derivedEntriesForTool(
  toolName: string,
  data: unknown,
  scope: Pick<SessionMemoryScope, "files" | "symbols" | "tests" | "refs">
): NonNullable<SessionMemoryInput["entries"]> {
  if (!data || typeof data !== "object") {
    return [];
  }
  const record = data as Record<string, unknown>;
  if (toolName === "change_plan") {
    const snapshot = isRecord(record.snapshot) ? record.snapshot : undefined;
    const editReadiness = isRecord(record.editReadiness) ? record.editReadiness : undefined;
    const orientationOnly = editReadiness?.status === "orientation-only" || editReadiness?.editable === false;
    const taskId = typeof snapshot?.taskId === "string" ? snapshot.taskId : undefined;
    const plannedTargets = stringValues(record.plannedEditTargets).slice(0, MAX_REFS_PER_ENTRY);
    const targetCount = plannedTargets.length;
    const testCount = Array.isArray(record.tests) ? record.tests.length : 0;
    const workflowCheckCount = Array.isArray(record.requiredWorkflowChecks) ? record.requiredWorkflowChecks.length : 0;
    const dependencyCheckCount = Array.isArray(record.requiredDependencyChecks) ? record.requiredDependencyChecks.length : 0;
    if (orientationOnly) {
      return [
        {
          kind: "decision",
          key: `decision:change_plan:${stableId("change-plan-orientation", String(record.task ?? ""), scope.files.join("\n")).slice(0, 16)}`,
          summary: `change_plan withheld planned edit targets until an explicit file, symbol, or edit-ready packet is available.`,
          provenance: "codexa-derived",
          confidence: "derived",
          evidenceTier: "derived",
          scope
        }
      ];
    }
    return [
      {
        kind: "decision",
        key: `decision:change_plan:${taskId ?? stableId("change-plan", String(record.task ?? ""), scope.files.join("\n")).slice(0, 16)}`,
        summary: `change_plan prepared ${targetCount} planned edit target(s)${taskId ? ` for ${taskId}` : ""}.`,
        provenance: "codexa-derived",
        confidence: "derived",
        evidenceTier: "derived",
        scope
      },
      ...(plannedTargets.length > 0
        ? [
            {
              kind: "next_read" as const,
              key: `next_read:change_plan:${taskId ?? stableId("change-plan-read", plannedTargets.join("\n")).slice(0, 16)}`,
              summary: `Read planned edit target(s): ${plannedTargets.slice(0, 5).join(", ")}${plannedTargets.length > 5 ? `, +${plannedTargets.length - 5} more` : ""}.`,
              provenance: "codexa-derived" as const,
              confidence: "derived" as const,
              evidenceTier: "derived" as const,
              scope: {
                ...scope,
                files: uniqueSorted([...scope.files, ...plannedTargets]).slice(0, MAX_REFS_PER_ENTRY)
              }
            }
          ]
        : []),
      ...(testCount > 0 || workflowCheckCount > 0 || dependencyCheckCount > 0
        ? [
            {
              kind: "verification" as const,
              key: `verification:change_plan:${taskId ?? stableId("change-plan-verify", scope.files.join("\n"), String(testCount), String(workflowCheckCount), String(dependencyCheckCount)).slice(0, 16)}`,
              summary: `change_plan queued ${testCount} test target(s), ${workflowCheckCount} workflow check(s), and ${dependencyCheckCount} dependency check(s).`,
              provenance: "codexa-derived" as const,
              confidence: "derived" as const,
              evidenceTier: "derived" as const,
              scope
            }
          ]
        : [])
    ];
  }
  if (toolName === "post_edit_review") {
    const verdict = typeof record.verdict === "string" ? record.verdict : "unknown";
    const outcome = isRecord(record.outcome) ? record.outcome : undefined;
    const driftReasons = stringList(record.driftReasons, 8);
    const nextActions = stringList(record.nextActions, 8);
    const driftCount = arrayLength(record.driftReasons);
    const testsNotRun = arrayLength(record.testsNotRun);
    const outcomeTestsNotRun = arrayLength(outcome?.testsNotRun);
    const unaccountedTests = Math.max(testsNotRun, outcomeTestsNotRun);
      const ledgerCounts = ledgerStatusCounts(outcome?.verificationLedger ?? record.verificationLedger);
    const commandCount = arrayLength(record.ranCommands ?? outcome?.ranCommands);
    const commandReportCount = arrayLength(record.ranCommandReports ?? outcome?.ranCommandReports);
    const provenanceVersion = verificationProvenanceVersion(record.verificationProvenance ?? outcome?.verificationProvenance);
    const postEditScope = scopeWithOutcomeRefs(scope, record);
    return [
      {
        kind: "verification",
        key: `verification:post_edit_review:${stableId("post-edit-review", String(record.task ?? ""), verdict, postEditScope.files.join("\n")).slice(0, 16)}`,
        summary: `post_edit_review verdict ${verdict}; ${driftCount} drift reason(s); ${unaccountedTests} test(s) still unaccounted for; ledger ${ledgerCounts.covered}/${ledgerCounts.total} covered.`,
        details: clampText(
          [
            `ledger missing=${ledgerCounts.missing}, waived=${ledgerCounts.waived}, not_applicable=${ledgerCounts.notApplicable}, would_cover=${ledgerCounts.wouldCover}`,
            `commands=${commandCount}, commandReports=${commandReportCount}`,
            provenanceVersion ? `verificationLedgerVersion=${provenanceVersion}` : undefined
          ]
            .filter((entry): entry is string => Boolean(entry))
            .join("; "),
          MAX_DETAILS_CHARS
        ),
        provenance: "codexa-derived",
        confidence: "derived",
        evidenceTier: "derived",
        scope: postEditScope
      },
      {
        kind: "decision",
        key: `decision:post_edit_review:${stableId("post-edit-decision", String(record.task ?? ""), verdict, postEditScope.files.join("\n")).slice(0, 16)}`,
        summary: `post_edit_review recommended ${verdict}.`,
        details: nextActions.length > 0 ? `Next actions: ${nextActions.join(" | ")}` : undefined,
        provenance: "codexa-derived",
        confidence: "derived",
        evidenceTier: "derived",
        scope: postEditScope
      },
      ...(driftCount > 0 || unaccountedTests > 0
        ? [
            {
              kind: "risk" as const,
              key: `risk:post_edit_review:${stableId("post-edit-risk", String(record.task ?? ""), verdict, String(driftCount), String(unaccountedTests), postEditScope.files.join("\n")).slice(0, 16)}`,
              summary: `post_edit_review found ${driftCount} drift reason(s) and ${unaccountedTests} unaccounted test target(s).`,
              details: driftReasons.length > 0 ? `Drift reasons: ${driftReasons.join(" | ")}` : undefined,
              provenance: "codexa-derived" as const,
              confidence: "derived" as const,
              evidenceTier: "derived" as const,
              scope: postEditScope
            }
          ]
        : [])
    ];
  }
    if (toolName === "test_plan") {
      const testCount = Array.isArray(record.tests) ? record.tests.length : 0;
      const ledgerCounts = ledgerStatusCounts(record.verificationLedgerPreview);
      const commandCount = arrayLength(record.verificationCommands);
      const testsNotRun = arrayLength(record.testsNotRun);
      const provenanceVersion = verificationProvenanceVersion(record.verificationProvenance);
    return [
      {
        kind: "verification",
        key: `verification:test_plan:${stableId("test-plan", scope.tests.join("\n"), scope.files.join("\n")).slice(0, 16)}`,
        summary: `test_plan recommended ${testCount} test target(s), ${commandCount} verification command(s); preview would cover ${ledgerCounts.wouldCover}/${ledgerCounts.total} ledger item(s) if run.`,
        details: clampText(
          [
            `testsNotRun=${testsNotRun}`,
            `ledger missing=${ledgerCounts.missing}, waived=${ledgerCounts.waived}, not_applicable=${ledgerCounts.notApplicable}, would_cover=${ledgerCounts.wouldCover}`,
            provenanceVersion ? `verificationLedgerVersion=${provenanceVersion}` : undefined
          ]
            .filter((entry): entry is string => Boolean(entry))
            .join("; "),
          MAX_DETAILS_CHARS
        ),
        provenance: "codexa-derived",
        confidence: "derived",
        evidenceTier: "derived",
        scope
      }
    ];
  }
  return [];
}

function ledgerStatusCounts(value: unknown): { total: number; covered: number; missing: number; waived: number; notApplicable: number; wouldCover: number } {
  const entries = Array.isArray(value) ? value : [];
  let covered = 0;
  let missing = 0;
  let waived = 0;
  let notApplicable = 0;
  let wouldCover = 0;
  for (const entry of entries) {
    if (!isRecord(entry) || typeof entry.status !== "string") {
      continue;
    }
    if (entry.status === "covered") {
      covered += 1;
    } else if (entry.status === "missing") {
      missing += 1;
    } else if (entry.status === "waived") {
      waived += 1;
    } else if (entry.status === "not_applicable") {
      notApplicable += 1;
    } else if (entry.status === "would_cover") {
      wouldCover += 1;
    }
  }
  return { total: covered + missing + waived + notApplicable + wouldCover, covered, missing, waived, notApplicable, wouldCover };
}

function scopeWithOutcomeRefs(
  scope: Pick<SessionMemoryScope, "files" | "symbols" | "tests" | "refs">,
  record: Record<string, unknown>
): Pick<SessionMemoryScope, "files" | "symbols" | "tests" | "refs"> {
  const outcome = isRecord(record.outcome) ? record.outcome : undefined;
  const snapshot = isRecord(record.snapshot) ? record.snapshot : undefined;
  const snapshotLoad = isRecord(record.snapshotLoad) ? record.snapshotLoad : undefined;
  const outcomeId = typeof outcome?.outcomeId === "string" ? outcome.outcomeId : undefined;
  const outcomePath = typeof outcome?.path === "string" ? outcome.path : undefined;
  const snapshotId = typeof snapshot?.taskId === "string" ? snapshot.taskId : typeof snapshotLoad?.taskId === "string" ? snapshotLoad.taskId : undefined;
  const snapshotPath = typeof snapshotLoad?.path === "string" ? snapshotLoad.path : undefined;
  const refs: SessionMemoryRef[] = [
    ...scope.refs,
    ...(outcomeId
      ? [
          {
            kind: "outcome" as const,
            id: outcomeId,
            path: outcomePath ? normalizePath(outcomePath) : undefined,
            evidenceTier: "derived" as const,
            confidence: "derived" as const
          }
        ]
      : []),
    ...(snapshotId
      ? [
          {
            kind: "snapshot" as const,
            id: snapshotId,
            path: snapshotPath ? normalizePath(snapshotPath) : undefined,
            evidenceTier: "derived" as const,
            confidence: "derived" as const
          }
        ]
      : [])
  ];
  return {
    ...scope,
    refs: uniqueRefs(refs).slice(0, MAX_REFS_PER_ENTRY)
  };
}

function verificationProvenanceVersion(value: unknown): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  return typeof value.verificationLedgerVersion === "string" ? clampText(value.verificationLedgerVersion, 80) : undefined;
}

function arrayLength(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

function stringList(value: unknown, limit: number): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string").map((entry) => clampText(entry, MAX_SUMMARY_CHARS)).slice(0, limit) : [];
}

export function refsFromQueryResult(data: unknown, index: CodexaIndex): SessionMemoryRef[] {
  const fileByPath = new Map(index.files.map((file) => [file.path, file]));
  const symbolByPathName = new Map(index.symbols.map((symbol) => [`${symbol.path}:${symbol.qualifiedName}`, symbol]));
  const refs = new Map<string, SessionMemoryRef>();
  const addFile = (filePath: string, kind: "file" | "test" = "file") => {
    const normalized = normalizePath(filePath);
    const file = fileByPath.get(normalized);
    if (!file) {
      return;
    }
    const ref: SessionMemoryRef = {
      kind: kind === "test" || file.test ? "test" : "file",
      id: file.id,
      path: file.path,
      evidenceTier: "derived",
      confidence: file.confidence
    };
    refs.set(refKey(ref), ref);
  };
  const addSymbol = (pathValue: unknown, qualifiedName: unknown) => {
    if (typeof pathValue !== "string" || typeof qualifiedName !== "string") {
      return;
    }
    const symbol = symbolByPathName.get(`${normalizePath(pathValue)}:${qualifiedName}`);
    if (!symbol) {
      return;
    }
    const ref: SessionMemoryRef = {
      kind: "symbol",
      id: symbol.id,
      path: symbol.path,
      evidenceTier: "derived",
      confidence: symbol.confidence
    };
    refs.set(refKey(ref), ref);
  };
  const visit = (value: unknown, depth: number) => {
    if (refs.size >= MAX_REFS_PER_ENTRY || depth > 7 || value === null || value === undefined) {
      return;
    }
    if (typeof value === "string") {
      if (/^[^/\s]+(?:\/[^/\s]+)+$/u.test(value)) {
        addFile(value);
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value.slice(0, 120)) {
        visit(item, depth + 1);
      }
      return;
    }
    if (typeof value !== "object") {
      return;
    }
    const record = value as Record<string, unknown>;
    if (typeof record.path === "string") {
      addFile(record.path, typeof record.kind === "string" && record.kind === "test" ? "test" : "file");
      addSymbol(record.path, record.qualifiedName);
    }
    if (typeof record.entryPath === "string") {
      addFile(record.entryPath);
    }
    if (Array.isArray(record.relatedFiles)) {
      for (const file of record.relatedFiles.slice(0, 20)) {
        if (typeof file === "string") {
          addFile(file);
        }
      }
    }
    if (Array.isArray(record.tests)) {
      for (const file of record.tests.slice(0, 20)) {
        if (typeof file === "string") {
          addFile(file, "test");
        } else {
          visit(file, depth + 1);
        }
      }
    }
    if (typeof record.id === "string" && typeof record.workflowKind === "string" && typeof record.title === "string") {
      const ref: SessionMemoryRef = {
        kind: "workflow",
        id: record.id,
        path: typeof record.entryPath === "string" ? normalizePath(record.entryPath) : undefined,
        evidenceTier: "derived",
        confidence: "derived"
      };
      refs.set(refKey(ref), ref);
    }
    for (const [key, item] of Object.entries(record)) {
      if (["raw", "snippets", "mcp", "runtime", "sessionMemory", "priorSessionMemory"].includes(key)) {
        continue;
      }
      visit(item, depth + 1);
    }
  };
  visit(data, 0);
  return [...refs.values()].sort((a, b) => refKey(a).localeCompare(refKey(b))).slice(0, MAX_REFS_PER_ENTRY);
}

export function viewedSummary(toolName: string, refs: SessionMemoryRef[], files: string[], symbols: string[], tests: string[]): string {
  const parts = [`${toolName} returned ${refs.length} ref(s)`];
  if (files.length > 0) {
    parts.push(`${files.length} file(s)`);
  }
  if (symbols.length > 0) {
    parts.push(`${symbols.length} symbol(s)`);
  }
  if (tests.length > 0) {
    parts.push(`${tests.length} test(s)`);
  }
  return clampText(parts.join("; "), MAX_SUMMARY_CHARS);
}

export function taskIdFromToolData(data: unknown): string | undefined {
  if (!isRecord(data)) {
    return undefined;
  }
  if (typeof data.taskId === "string") {
    return data.taskId;
  }
  if (isRecord(data.snapshot) && typeof data.snapshot.taskId === "string") {
    return data.snapshot.taskId;
  }
  if (isRecord(data.snapshotBlock) && typeof data.snapshotBlock.taskId === "string") {
    return data.snapshotBlock.taskId;
  }
  if (isRecord(data.snapshotLoad) && typeof data.snapshotLoad.taskId === "string") {
    return data.snapshotLoad.taskId;
  }
  return undefined;
}

function stringValues(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return uniqueSorted(value.filter((entry): entry is string => typeof entry === "string").map((entry) => normalizePath(clampText(entry, 500))));
}

function refKey(ref: SessionMemoryRef): string {
  return [ref.kind, ref.id, ref.path ?? "", ref.edgeKind ?? "", ref.fromId ?? "", ref.toId ?? ""].join(":");
}

function uniqueRefs(refs: SessionMemoryRef[]): SessionMemoryRef[] {
  const byKey = new Map<string, SessionMemoryRef>();
  for (const ref of refs) {
    const normalized = {
      ...ref,
      path: ref.path ? normalizePath(ref.path) : undefined
    };
    byKey.set(refKey(normalized), normalized);
  }
  return [...byKey.values()].sort((a, b) => refKey(a).localeCompare(refKey(b)));
}

function clampText(value: string, limit: number): string {
  const cleaned = value.replace(/\s+/gu, " ").trim();
  return cleaned.length > limit ? `${cleaned.slice(0, Math.max(0, limit - 3))}...` : cleaned;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
