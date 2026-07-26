import {
  MAX_POST_EDIT_REVIEW_CANDIDATE_TARGETS,
  MAX_POST_EDIT_REVIEW_TARGETS_PER_PASS
} from "../../post-edit-review-coverage.js";
import type { SemanticRetrievalSummary } from "../../semantic-retrieval.js";
import type {
  ChangeType,
  CodexaIndex,
  DiffImpactGroup,
  EvidenceTier,
  FileFact,
  QueryOptions,
  QueryResult,
  TestRecommendation
} from "../../types.js";
import { contextPackQuery } from "../context.js";
import type { QuerySession } from "../session.js";
import type { ContextQuality } from "../quality.js";
import { inspectDirtyTargetAuthorities, resolveSymbolTarget } from "../targets.js";
import { stableId } from "../../util.js";

export interface PostEditReviewContextData extends Record<string, unknown> {
  focusFiles?: Array<{ file: FileFact; reasons: string[]; tier: EvidenceTier }>;
  changedFiles?: string[];
  unindexedChanged?: string[];
  groups?: DiffImpactGroup[];
  tests?: TestRecommendation[];
  recipes?: string[];
  quality?: ContextQuality;
  gaps?: string[];
  warnings?: string[];
  retrieval?: { semantic?: SemanticRetrievalSummary };
}

export function postEditReviewPasses(candidateTargets: string[], targetLimit: number): string[][] {
  if (targetLimit < 3 || targetLimit > MAX_POST_EDIT_REVIEW_TARGETS_PER_PASS) {
    throw new Error(`post-edit review pass limit must be between 3 and ${MAX_POST_EDIT_REVIEW_TARGETS_PER_PASS}`);
  }
  if (candidateTargets.length > MAX_POST_EDIT_REVIEW_CANDIDATE_TARGETS) {
    throw new Error(
      `post-edit review exceeds the ${MAX_POST_EDIT_REVIEW_CANDIDATE_TARGETS}-target lifecycle safety limit`
    );
  }
  const passes: string[][] = [];
  for (let offset = 0; offset < candidateTargets.length; offset += targetLimit) {
    passes.push(candidateTargets.slice(offset, offset + targetLimit));
  }
  return passes.length > 0 ? passes : [[]];
}

export function postEditExplicitSymbolTargets(
  index: CodexaIndex,
  symbols: string[] = []
): { resolvedFiles: string[]; unresolvedTargets: string[] } {
  const resolvedFiles: string[] = [];
  const unresolvedTargets: string[] = [];
  for (const [ordinal, symbol] of symbols.entries()) {
    const resolved = resolveSymbolTarget(index, symbol);
    if (resolved.symbol) resolvedFiles.push(resolved.symbol.path);
    else unresolvedTargets.push(`/@codexa/unresolved-symbol/${ordinal}/${stableId("unresolved-symbol", symbol)}`);
  }
  return { resolvedFiles, unresolvedTargets };
}

export async function postEditReviewContext(input: {
  session: QuerySession;
  task: string;
  reviewPasses: string[][];
  unresolvedTargets?: string[];
  symbols?: string[];
  changeType: ChangeType;
  includeDiff: boolean;
  tokenBudget: number;
  limit: number;
  includeSnippets: boolean;
  options: QueryOptions;
}): Promise<{ context: QueryResult; analyzedTargets: string[] }> {
  const candidateTargets = input.reviewPasses.flat();
  const unresolvedTargets = new Set(input.unresolvedTargets ?? []);
  const indexedFiles = new Map(input.session.index.files.map((file) => [file.path, file]));
  const dirtyAuthorities = await inspectDirtyTargetAuthorities(
    await input.session.getChangedFileEntries(),
    input.session.repoRoot,
    indexedFiles.keys()
  );
  const acceptedDirtyTargets = new Set(
    dirtyAuthorities.filter((authority) => authority.accepted && authority.path).map((authority) => authority.path!)
  );
  const analyzedTargets: string[] = [];
  for (const target of candidateTargets) {
    if (unresolvedTargets.has(target)) break;
    if (!indexedFiles.has(target) && !acceptedDirtyTargets.has(target)) break;
    analyzedTargets.push(target);
  }
  const representativeFiles = analyzedTargets.filter((target) => indexedFiles.has(target)).slice(0, input.limit);
  const context = await contextPackQuery(
    input.session,
    {
      task: input.task,
      files: representativeFiles,
      // This is the one task-global enrichment call. Preserve explicit symbol
      // resolution diagnostics even when target accounting spans many passes.
      symbols: input.symbols,
      changeType: input.changeType,
      diff: input.includeDiff,
      tokenBudget: Math.min(input.tokenBudget, 3600),
      limit: input.limit,
      includeSnippets: input.includeSnippets
    },
    { ...input.options, autoRefresh: false },
    { requiredFocusFiles: representativeFiles }
  );
  const contextData = context.data as PostEditReviewContextData;
  const focusByPath = new Map((contextData.focusFiles ?? []).map((entry) => [entry.file.path, entry]));
  for (const target of analyzedTargets) {
    const file = indexedFiles.get(target);
    if (!file) continue;
    focusByPath.set(target, {
      file,
      reasons: ["post-edit explicit review target"],
      tier: "authoritative"
    });
  }
  const analyzedTargetSet = new Set(analyzedTargets);
  const directOnlyQuality: ContextQuality | undefined =
    analyzedTargets.length > 0 && representativeFiles.length === 0
      ? {
          level: "high",
          recommendation: "Use exact Git dirty-target evidence; source-level context is unavailable for deletions or non-source files.",
          reasons: ["exact safe dirty-target evidence"],
          counts: { authoritative: analyzedTargets.length, derived: 0, heuristic: 0, fallback: 0 }
        }
      : undefined;
  return {
    context: {
      ...context,
      data: {
        ...contextData,
        quality: directOnlyQuality ?? contextData.quality,
        focusFiles: [...analyzedTargets.flatMap((target) => {
          const entry = focusByPath.get(target);
          return entry ? [entry] : [];
        }), ...[...focusByPath.entries()]
          .filter(([filePath]) => !analyzedTargetSet.has(filePath))
          .map(([, entry]) => entry)]
      }
    },
    analyzedTargets
  };
}
