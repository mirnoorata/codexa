import path from "node:path";
import { isTestPath } from "../language.js";
import type { CodexaIndex, FileFact, QueryOptions, QueryResult, WorkflowTraceFact } from "../types.js";
import { limitText, uniqueSorted } from "../util.js";
import { formatGaps, indexGaps } from "./diff.js";
import { matchScore } from "./search.js";
import { assessContextQuality, formatContextQuality } from "./quality.js";
import { freshnessBanner } from "./runtime.js";
import { ensureQuerySession, type QuerySessionInput } from "./session.js";
import { findFile, resolveGraphTarget, type ResolvedGraphTarget } from "./targets.js";
import { retrieveForTask } from "../retrieval.js";
import { workflowTierCounts } from "./graph-traversal.js";

export async function workflowPathQuery(
  input: QuerySessionInput,
  workflowInput: { query?: string; file?: string; symbol?: string; limit?: number },
  options: QueryOptions = {}
): Promise<QueryResult> {
  const session = await ensureQuerySession(input, options);
  const { index, freshness, refresh, repoRoot } = session;
  const limit = Math.max(1, Math.min(workflowInput.limit ?? 8, session.maxResults));
  const queryText = workflowInput.query?.trim() || workflowInput.symbol || workflowInput.file || "workflow";
  const retrieval = retrieveForTask(index, queryText, limit);
  let workflows = retrieval.workflows;
  if (workflowInput.file || workflowInput.symbol) {
    const target = resolveGraphTarget(index, repoRoot, { file: workflowInput.file, symbol: workflowInput.symbol });
    if ("result" in target) {
      return { ...target.result, freshness, refresh };
    }
    workflows = workflows.filter((workflow) => workflowMatchesTarget(workflow, target));
    if (workflows.length === 0) {
      workflows = index.workflows.filter((workflow) => workflowMatchesTarget(workflow, target));
    }
  }
  if (workflows.length === 0) {
    workflows = fallbackWorkflowMatches(index, queryText, limit);
  }
  workflows = workflows.slice(0, limit);
  const files = rankWorkflowCoreFiles(index, workflows, queryText).slice(0, Math.max(8, limit * 2));
  const relatedFiles = rankWorkflowFiles(index, workflows, queryText).filter((file) => !files.includes(file)).slice(0, 30);
  const tests = uniqueSorted(workflows.flatMap((workflow) => workflow.tests));
  const quality = assessContextQuality({
    freshness,
    gaps: indexGaps(index, freshness),
    tiers: workflowTierCounts(workflows),
    selectedCount: workflows.length,
    testCount: tests.length,
    queryBroad: retrieval.broad
  });
  const text = [
    freshnessBanner(freshness, refresh),
    formatContextQuality(quality),
    `Workflow path query: ${queryText}`,
    "",
    "Workflows:",
    ...(workflows.length > 0 ? workflows.flatMap((workflow) => formatWorkflow(workflow)) : ["- no workflow traces matched"]),
    "",
    "Core path files:",
    ...(files.length > 0 ? files.map((file) => `- ${file}`) : ["- none"]),
    "",
    "Related candidate files:",
    ...(relatedFiles.length > 0 ? relatedFiles.map((file) => `- ${file}`) : ["- none"]),
    "",
    "Known gaps:",
    ...formatGaps(indexGaps(index, freshness))
  ].join("\n");
  return { freshness, refresh, text: limitText(text, 7000), data: { query: queryText, workflows, files, relatedFiles, tests, quality, retrieval } };
}

export function fallbackWorkflowMatches(index: { workflows: WorkflowTraceFact[] }, queryText: string, limit: number): WorkflowTraceFact[] {
  const terms = queryText
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .map((term) => term.trim())
    .filter((term) => term.length >= 3);
  if (terms.length === 0) {
    return [];
  }
  return index.workflows
    .map((workflow) => {
      const haystack = [
        workflow.title,
        workflow.workflowKind,
        workflow.entryPath,
        ...workflow.relatedFiles,
        ...workflow.steps.map((step) => `${step.kind} ${step.label} ${step.reason} ${step.path ?? ""} ${step.targetPath ?? ""}`)
      ]
        .join(" ")
        .toLowerCase();
      const termScore = terms.reduce((sum, term) => sum + (haystack.includes(term) ? 1 : 0), 0);
      const entryScore = terms.reduce((sum, term) => sum + (workflow.entryPath.toLowerCase().includes(term) ? 2 : 0), 0);
      return {
        workflow,
        score: termScore + entryScore + Math.log2(workflow.rank + 1) * 0.1
      };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || b.workflow.rank - a.workflow.rank || a.workflow.title.localeCompare(b.workflow.title))
    .slice(0, limit)
    .map((entry) => entry.workflow);
}

export function rankWorkflowFiles(index: Pick<CodexaIndex, "files">, workflows: WorkflowTraceFact[], queryText: string): string[] {
  const entries = new Map<string, number>();
  const add = (filePath: string | undefined, score: number) => {
    if (!filePath) {
      return;
    }
    if (isTestPath(filePath)) {
      return;
    }
    entries.set(filePath, (entries.get(filePath) ?? 0) + score + (index.files.find((file) => file.path === filePath)?.rank ?? 0) * 0.01);
  };
  for (const workflow of workflows) {
    add(workflow.entryPath, 12);
    for (const step of workflow.steps) {
      add(step.path, step.kind === "entry" ? 12 : step.kind === "test" ? 9 : step.kind === "ui" || step.kind === "endpoint" ? 8 : 5);
      add(step.targetPath, step.kind === "test" ? 8 : 4);
    }
    for (const file of workflow.relatedFiles) {
      add(file, 3 + workflowUiCoreScore(file, undefined, queryText));
    }
    for (const test of workflow.tests) {
      add(test, 9);
    }
  }
  return [...entries.entries()].filter(([, score]) => score > 0).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([filePath]) => filePath);
}

export function rankWorkflowCoreFiles(index: Pick<CodexaIndex, "files">, workflows: WorkflowTraceFact[], queryText: string): string[] {
  const entries = new Map<string, number>();
  const add = (filePath: string | undefined, score: number) => {
    if (!filePath) {
      return;
    }
    if (isTestPath(filePath)) {
      return;
    }
    entries.set(filePath, (entries.get(filePath) ?? 0) + score + (index.files.find((file) => file.path === filePath)?.rank ?? 0) * 0.01);
  };
  for (const workflow of workflows) {
    add(workflow.entryPath, 30);
    for (const step of workflow.steps) {
      const coreScore =
        step.kind === "entry"
          ? 26
          : step.kind === "ui"
            ? 24 + workflowUiCoreScore(step.path, step.targetPath, queryText)
            : step.kind === "endpoint"
              ? 22
              : step.kind === "store" || step.kind === "adapter" || step.kind === "manifest"
                ? 20
                : step.kind === "call" || step.kind === "reference"
                  ? 12
                  : step.kind === "test"
                    ? 4
                    : 8;
      add(step.path, coreScore);
      add(step.targetPath, Math.max(4, coreScore - 4));
    }
  }
  return [...entries.entries()].filter(([, score]) => score > 0).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([filePath]) => filePath);
}

export function workflowMatchesTarget(workflow: WorkflowTraceFact, target: ResolvedGraphTarget): boolean {
  if (target.symbol?.id) {
    return (
      workflow.entrySymbolId === target.symbol.id ||
      workflow.steps.some((step) => step.symbolId === target.symbol?.id || step.targetSymbolId === target.symbol?.id) ||
      (isAdapterPath(target.symbol.path) && workflow.steps.some((step) => step.targetPath === target.symbol?.path || step.path === target.symbol?.path))
    );
  }
  return workflow.relatedFiles.some((file) => target.paths.has(file));
}

export function formatWorkflow(workflow: WorkflowTraceFact): string[] {
  return [
    `- ${workflow.title}: ${workflow.workflowKind}, rank ${workflow.rank.toFixed(2)}, ${workflow.confidence}`,
    `  summary: ${workflow.summary}`,
    ...workflow.steps.slice(0, 12).map((step, index) => `  ${index + 1}. ${step.kind} ${step.label} at ${step.path}${step.line ? `:${step.line}` : ""}; ${step.confidence}; ${step.reason}`),
    workflow.steps.length > 12 ? `  ... ${workflow.steps.length - 12} more steps` : undefined,
    workflow.tests.length > 0 ? `  tests: ${workflow.tests.slice(0, 6).join(", ")}` : "  tests: none proven"
  ].filter((line): line is string => line !== undefined);
}

function workflowUiCoreScore(pathValue: string, targetPath: string | undefined, queryText: string): number {
  const joined = `${pathValue} ${targetPath ?? ""}`;
  if (/use-run-polling|useRunPolling/i.test(joined)) {
    return 34;
  }
  if (/queue-dashboard|useQueueDashboard/i.test(joined)) {
    return 32;
  }
  if (/\/polling\.[cm]?[jt]sx?$/i.test(joined)) {
    return 20;
  }
  if (/\/run-view\.[cm]?[jt]sx?$/i.test(joined)) {
    return 14;
  }
  return matchScore(queryText, joined) > 0 ? 10 : 0;
}

function isAdapterPath(filePath: string): boolean {
  return /(^|\/)adapters?\//i.test(filePath) || /adapter/i.test(path.posix.basename(filePath));
}
