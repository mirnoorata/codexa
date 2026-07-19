import path from "node:path";
import { isTestPath } from "../language.js";
import type { ChangeType, GraphEdgeFact, GraphEdgeKind, SymbolFact, WorkflowTraceFact } from "../types.js";
import { uniqueSorted } from "../util.js";

export type ChangePlanNeed = {
  trigger: "dirty-scope" | "multiple-targets" | "multi-file" | "material-risk";
  reason: string;
};

export type ChangePlanRoutingInput = {
  mode: "edit" | "orientation";
  task?: string;
  explicitTargetCount?: number;
  dirtyScopeFileCount?: number;
  changeType?: ChangeType;
  targetFiles?: string[];
  repositoryFiles?: string[];
  ambiguousExplicitTarget?: boolean;
  unresolvedExplicitTarget?: boolean;
};

export function normalizeTaskRepositoryPaths(task: string, repoRoot: string): string {
  const normalizedTask = task.replaceAll("\\", "/");
  const normalizedRoot = repoRoot.replaceAll("\\", "/").replace(/\/$/u, "");
  return normalizedRoot ? normalizedTask.split(`${normalizedRoot}/`).join("") : normalizedTask;
}

export function recommendNextCodexaCall(
  intents: string[],
  workflows: WorkflowTraceFact[],
  changedFileCount: number,
  task: string,
  focusFiles: string[] = [],
  routing: Omit<ChangePlanRoutingInput, "task"> = {
    mode: intents.includes("implementation") ? "edit" : "orientation"
  }
): { tool: string; reason: string; arguments?: Record<string, unknown> } {
  const lowerTask = task.toLowerCase();
  const repositoryFiles = routing.repositoryFiles ?? focusFiles;
  const explicitFocusFiles = focusFilesInTaskOrder(task, focusFiles, repositoryFiles);
  const orderedTargets = routing.targetFiles?.length ? routing.targetFiles : explicitFocusFiles;
  const singleFocusFile = orderedTargets[0] ?? (focusFiles.length === 1 ? focusFiles[0] : undefined);
  if (routing.unresolvedExplicitTarget) {
    return { tool: "search", reason: "the named path does not resolve to an indexed repository file", arguments: { query: task } };
  }
  if (routing.ambiguousExplicitTarget) {
    return { tool: "search", reason: "the named target matches multiple repository files and needs one bounded disambiguation pass", arguments: { query: task } };
  }
  const changePlanNeed = classifyChangePlanNeed({
    ...routing,
    task,
    explicitTargetCount: routing.explicitTargetCount ?? explicitFocusFiles.length,
    targetFiles: routing.targetFiles ?? (explicitFocusFiles.length > 0 ? explicitFocusFiles : focusFiles)
  });
  if ((focusFiles.length > 0 || orderedTargets.length > 0 || (routing.dirtyScopeFileCount ?? 0) > 0) && changePlanNeed) {
    const planFiles = (routing.targetFiles?.length ? routing.targetFiles : explicitFocusFiles.length > 0 ? explicitFocusFiles : focusFiles).slice(0, 64);
    return {
      tool: "change_plan",
      reason: changePlanNeed.reason,
      arguments: {
        task,
        ...(changePlanNeed.trigger === "dirty-scope" ? {} : { files: planFiles }),
        diff: changePlanNeed.trigger === "dirty-scope" && changedFileCount > 0,
        saveSnapshot: true
      }
    };
  }
  if (/\b(callers?|importers?)\b/.test(lowerTask)) {
    return singleFocusFile
      ? { tool: "callers", reason: "the task asks who uses a symbol or file", arguments: { file: singleFocusFile } }
      : { tool: "source", reason: "the packet needs an exact file or symbol before caller traversal is useful" };
  }
  if (/\b(callees?|dependencies|uses)\b/.test(lowerTask)) {
    return singleFocusFile
      ? { tool: "callees", reason: "the task asks what a symbol or file depends on", arguments: { file: singleFocusFile } }
      : { tool: "source", reason: "the packet needs an exact file or symbol before dependency traversal is useful" };
  }
  if (/\b(path|between|connects?)\b/.test(lowerTask) && /\b(dependency|workflow|call)\b/.test(lowerTask)) {
    return orderedTargets.length >= 2
      ? {
          tool: "dependency_path",
          reason: "the task asks for a path between code elements",
          arguments: { fromFile: orderedTargets[0], toFile: orderedTargets[1] }
        }
      : { tool: "source", reason: "the packet needs two exact endpoints before dependency-path traversal is useful" };
  }
  if (intents.includes("workflow") && workflows.length > 0 && /\b(workflow|flow|route|job|process|end-to-end)\b/u.test(lowerTask)) {
    return { tool: "workflow_path", reason: "the task maps to route/job/process flow evidence", arguments: { query: task } };
  }
  return { tool: "source", reason: "the packet already identifies the sources and tests; read them and stop Codexa" };
}

interface OrderedFocusTarget {
  path: string;
  index: number;
}

function focusFileEntriesInTaskOrder(task: string, focusFiles: string[], repositoryFiles: string[] = focusFiles): OrderedFocusTarget[] {
  const normalizedTask = task.replaceAll("\\", "/");
  const lowerTask = normalizedTask.toLowerCase();
  const basenameCounts = new Map<string, number>();
  for (const file of repositoryFiles) {
    const basename = file.toLowerCase().replaceAll("\\", "/").split("/").at(-1) ?? "";
    basenameCounts.set(basename, (basenameCounts.get(basename) ?? 0) + 1);
  }
  return focusFiles
    .map((file) => {
      const normalizedFile = file.replaceAll("\\", "/");
      const lowerFile = normalizedFile.toLowerCase();
      const explicitPathIndex = focusFileTaskIndex(normalizedTask, `./${normalizedFile}`);
      const fullPathIndex = normalizedFile.includes("/") ? focusFileTaskIndex(normalizedTask, normalizedFile) : -1;
      const basename = lowerFile.split("/").at(-1) ?? lowerFile;
      const basenameIndex = (basenameCounts.get(basename) ?? 0) === 1 ? focusFileTaskIndex(lowerTask, basename) : -1;
      return { path: file, index: explicitPathIndex >= 0 ? explicitPathIndex : fullPathIndex >= 0 ? fullPathIndex : basenameIndex };
    })
    .filter((entry) => entry.index >= 0)
    .sort((left, right) => left.index - right.index || left.path.localeCompare(right.path));
}

export function focusFilesInTaskOrder(task: string, focusFiles: string[], repositoryFiles: string[] = focusFiles): string[] {
  return focusFileEntriesInTaskOrder(task, focusFiles, repositoryFiles).map((entry) => entry.path);
}

function focusSymbolFileEntriesInTaskOrder(task: string, symbols: SymbolFact[]): OrderedFocusTarget[] {
  return symbolLabelEntriesForTask(task, symbols)
    .filter((entry) => naturalSymbolEntryAllowed(task, entry.label, entry.paths))
    .filter((entry) => entry.paths.size === 1)
    .filter((entry) => isExplicitSymbolOccurrence(task, entry.label, entry.index))
    .map((entry) => ({ path: [...entry.paths][0], index: entry.index }))
    .filter((entry) => entry.index >= 0)
    .sort((left, right) => left.index - right.index || left.path.localeCompare(right.path));
}

export function focusSymbolFilesInTaskOrder(task: string, symbols: SymbolFact[]): string[] {
  return [...new Set(focusSymbolFileEntriesInTaskOrder(task, symbols).map((entry) => entry.path))];
}

export function focusFilesAndSymbolsInTaskOrder(task: string, focusFiles: string[], repositoryFiles: string[], symbols: SymbolFact[]): string[] {
  const ordered = [...focusFileEntriesInTaskOrder(task, focusFiles, repositoryFiles), ...focusSymbolFileEntriesInTaskOrder(task, symbols)]
    .sort((left, right) => left.index - right.index || left.path.localeCompare(right.path));
  return [...new Set(ordered.map((entry) => entry.path))];
}

export type TaskTargetRoles = {
  editableTargets: string[];
  readDependencies: string[];
  excludedTargets: string[];
  hasReferenceCue: boolean;
  unresolvedReferenceCue: boolean;
};

/**
 * Natural-language mentions do not all carry write authority. A comparison or
 * implementation reference is source to read, while an explicit negative
 * clause removes edit authority even when the same path is otherwise named.
 */
export function classifyTaskTargetRoles(
  task: string,
  candidatePaths: string[],
  repositoryFiles: string[],
  symbols: SymbolFact[]
): TaskTargetRoles {
  const candidates = new Set(candidatePaths);
  const mentions: Array<{ path: string; label: string; index: number; role: "editable" | "read" | "excluded" | "only-edit" }> = [];
  const fileEntries = focusFileEntriesInTaskOrder(task, candidatePaths, repositoryFiles);
  const pathMentions = focusPathMentions(task);
  const basenameCounts = new Map<string, number>();
  for (const filePath of repositoryFiles) {
    const basename = filePath.replaceAll("\\", "/").split("/").at(-1)?.toLowerCase() ?? "";
    basenameCounts.set(basename, (basenameCounts.get(basename) ?? 0) + 1);
  }
  for (const entry of fileEntries) {
    mentions.push({ path: entry.path, label: entry.path, index: entry.index, role: targetMentionRole(task, entry.path, entry.index) });
    const normalizedPath = entry.path.replaceAll("\\", "/");
    const basename = normalizedPath.split("/").at(-1)?.toLowerCase() ?? "";
    for (const mention of pathMentions) {
      const samePath = mention.candidate.toLowerCase() === normalizedPath.toLowerCase();
      const uniqueBasename = !mention.candidate.includes("/") && mention.candidate.toLowerCase() === basename && basenameCounts.get(basename) === 1;
      if ((!samePath && !uniqueBasename) || mention.index === entry.index) continue;
      mentions.push({ path: entry.path, label: task.slice(mention.index, mention.end), index: mention.index, role: targetMentionRole(task, task.slice(mention.index, mention.end), mention.index) });
    }
  }
  for (const { label, paths, index } of symbolLabelEntriesForTask(task, symbols)) {
    if (paths.size !== 1 || !naturalSymbolEntryAllowed(task, label, paths) || !isExplicitSymbolOccurrence(task, label, index)) continue;
    const [symbolPath] = paths;
    if (!symbolPath || !candidates.has(symbolPath)) continue;
    mentions.push({ path: symbolPath, label, index, role: targetMentionRole(task, label, index) });
  }

  const onlyEditable = new Set(mentions.filter((mention) => mention.role === "only-edit").map((mention) => mention.path));
  const editable = new Set(mentions.filter((mention) => mention.role === "editable" || mention.role === "only-edit").map((mention) => mention.path));
  const read = new Set(mentions.filter((mention) => mention.role === "read").map((mention) => mention.path));
  const excluded = new Set(mentions.filter((mention) => mention.role === "excluded").map((mention) => mention.path));
  const mentionedPaths = new Set(mentions.map((mention) => mention.path));
  for (const filePath of candidatePaths) {
    if (!mentionedPaths.has(filePath)) editable.add(filePath);
  }
  if (onlyEditable.size > 0) {
    for (const filePath of editable) {
      if (!onlyEditable.has(filePath)) excluded.add(filePath);
    }
  }
  for (const filePath of excluded) editable.delete(filePath);
  for (const filePath of editable) read.delete(filePath);

  const referenceCues = taskReferenceCueMentions(task).filter((cue) => !isExternalDependencyReference(cue.label, repositoryFiles));
  const resolvedReferenceIndexes = mentions.filter((mention) => mention.role === "read").map((mention) => mention.index);
  const unresolvedReferenceCue = referenceCues.some((cue) => !resolvedReferenceIndexes.some((index) => index >= cue.labelStart && index < cue.labelEnd));
  return {
    editableTargets: orderedRolePaths(editable, mentions),
    readDependencies: orderedRolePaths(read, mentions),
    excludedTargets: orderedRolePaths(excluded, mentions),
    hasReferenceCue: referenceCues.length > 0 || read.size > 0,
    unresolvedReferenceCue
  };
}

function orderedRolePaths(paths: Set<string>, mentions: Array<{ path: string; index: number }>): string[] {
  return [...paths].sort((left, right) => {
    const leftIndex = Math.min(...mentions.filter((mention) => mention.path === left).map((mention) => mention.index));
    const rightIndex = Math.min(...mentions.filter((mention) => mention.path === right).map((mention) => mention.index));
    return leftIndex - rightIndex || left.localeCompare(right);
  });
}

function targetMentionRole(task: string, label: string, index: number): "editable" | "read" | "excluded" | "only-edit" {
  const before = task.slice(Math.max(0, index - 120), index);
  const after = task.slice(index + label.length, index + label.length + 48);
  if (
    /\b(?:(?:do\s+not|don't|never)\s+(?:change|edit|modify|rewrite|touch|update)|without\s+(?:changing|editing|modifying|rewriting|touching|updating))\s+(?:the\s+)?$/iu.test(before)
    || /\b(?:but\s+not|except(?:\s+for)?|excluding)\s+(?:the\s+)?$/iu.test(before)
    || (/\bleave\s+(?:the\s+)?$/iu.test(before) && /^\s+(?:alone|unchanged)\b/iu.test(after))
  ) {
    return "excluded";
  }
  if (/\b(?:(?:only|solely|just)\s+(?:change|edit|modify|rewrite|touch|update)|(?:change|edit|modify|rewrite|touch|update)\s+(?:only|solely|just))\s+(?:the\s+)?$/iu.test(before)) {
    return "only-edit";
  }
  return hasTargetReferenceCueBefore(before) ? "read" : "editable";
}

function hasTargetReferenceCueBefore(before: string): boolean {
  return /\b(?:use|using|call(?:s|ing)?|invok(?:e|es|ing)|import(?:s|ing)?|model(?:ed|led)\s+after|same\s+behaviou?r\s+as|similar\s+to|analogous\s+to|based\s+on|compar(?:e|ed|ing)\s+(?:against|to|with)|match(?:es|ing)?|mirror(?:s|ing)?|pattern\s+(?:from|in)|according\s+to|referenc(?:e|ed|ing)(?:\s+implementation)?|like)\s+(?:the\s+)?$/iu.test(before)
    || /\b(?:use|using)\b[^.!?;\n]{1,80}\b(?:from|via)\s+(?:the\s+)?$/iu.test(before)
    || /\bcompar(?:e|ed|ing)\b(?:(?:(?![.!?;]\s)[^\n]){0,100}\b(?:against|to|with|and))?\s+(?:the\s+)?$/iu.test(before);
}

function taskReferenceCueMentions(task: string): Array<{ label: string; labelStart: number; labelEnd: number }> {
  const pattern = /\b(?:use|using|call(?:s|ing)?|invok(?:e|es|ing)|import(?:s|ing)?|model(?:ed|led)\s+after|same\s+behaviou?r\s+as|similar\s+to|analogous\s+to|based\s+on|compar(?:e|ed|ing)\s+(?:against|to|with)|match(?:es|ing)?|mirror(?:s|ing)?|pattern\s+(?:from|in)|according\s+to|referenc(?:e|ed|ing)(?:\s+implementation)?|like)\s+(?:the\s+)?[`'"]?((?:\.\/)?(?:[A-Za-z0-9_@.$-]+\/)*[A-Za-z_$][A-Za-z0-9_@.$:-]*)/giu;
  return [...task.matchAll(pattern)].flatMap((match) => {
    const label = match[1]?.replace(/[.,;:!?]+$/u, "");
    if (!label) return [];
    const labelStart = (match.index ?? 0) + match[0].lastIndexOf(match[1]);
    return [{ label, labelStart, labelEnd: labelStart + label.length }];
  });
}

function isExternalDependencyReference(label: string, repositoryFiles: string[]): boolean {
  const normalized = label.replace(/^\.\//u, "");
  if (!normalized.includes("/") || label.startsWith("./")) return false;
  const first = normalized.split("/")[0]?.toLowerCase();
  const topLevels = new Set(repositoryFiles.map((filePath) => filePath.replaceAll("\\", "/").split("/")[0]?.toLowerCase()));
  return Boolean(first && !first.startsWith(".") && !topLevels.has(first));
}

export function ambiguousFocusSymbolTargetCandidates(task: string, symbols: SymbolFact[], explicitPaths: string[] = []): string[] {
  return uniqueSorted(ambiguousFocusSymbolTargetCandidateGroups(task, symbols, explicitPaths).flat());
}

export function ambiguousFocusSymbolTargetCandidateGroups(task: string, symbols: SymbolFact[], explicitPaths: string[] = []): string[][] {
  const selectedPaths = new Set(explicitPaths);
  return symbolLabelEntriesForTask(task, symbols).flatMap(({ label, paths, index }) => {
    if (!naturalSymbolEntryAllowed(task, label, paths)) return [];
    if (paths.size < 2 || !isAmbiguousExplicitSymbolOccurrence(task, label, index)) return [];
    if ([...paths].some((candidate) => selectedPaths.has(candidate))) return [];
    return [uniqueSorted([...paths])];
  });
}

function naturalSymbolEntryAllowed(task: string, label: string, paths: Set<string>): boolean {
  if (![...paths].every(isTestPath)) return true;
  return task.toLowerCase().includes(`\`${label.toLowerCase()}\``);
}

export function hasAmbiguousFocusTarget(task: string, repositoryFiles: string[]): boolean {
  return ambiguousFocusTargetCandidates(task, repositoryFiles).length > 0;
}

export function ambiguousFocusTargetCandidates(task: string, repositoryFiles: string[], selectedPaths: string[] = []): string[] {
  const selected = new Set(selectedPaths);
  return uniqueSorted(ambiguousFocusTargetCandidateGroups(task, repositoryFiles).filter((group) => !group.some((filePath) => selected.has(filePath))).flat())
    .sort((left, right) => left.split(/[\\/]/u).length - right.split(/[\\/]/u).length || left.localeCompare(right));
}

export function ambiguousFocusTargetCandidateGroups(task: string, repositoryFiles: string[]): string[][] {
  const normalizedTask = task.toLowerCase().replaceAll("\\", "/");
  const filesByBasename = new Map<string, Array<{ file: string; normalized: string }>>();
  for (const file of repositoryFiles) {
    const normalizedFile = file.toLowerCase().replaceAll("\\", "/");
    const basename = normalizedFile.split("/").at(-1) ?? normalizedFile;
    const files = filesByBasename.get(basename) ?? [];
    files.push({ file, normalized: normalizedFile });
    filesByBasename.set(basename, files);
  }
  return [...filesByBasename.entries()].flatMap(([basename, files]) => {
      if (files.length < 2 || !hasUnqualifiedBasenameOccurrence(normalizedTask, basename, files.map((entry) => entry.normalized))) return [];
      return [files.map((entry) => entry.file).sort((left, right) => left.localeCompare(right))];
    });
}

export function narrowAmbiguousTargetGroupsToScope(groups: string[][], scopedPaths: Set<string>): { resolved: string[]; ambiguous: string[]; unmatched: boolean } {
  const resolved: string[] = [];
  const ambiguous: string[] = [];
  let unmatched = false;
  for (const group of groups) {
    const matches = group.filter((filePath) => scopedPaths.has(filePath));
    if (matches.length === 1) resolved.push(matches[0]);
    else if (matches.length > 1) ambiguous.push(...matches);
    else unmatched = true;
  }
  return { resolved: uniqueSorted(resolved), ambiguous: uniqueSorted(ambiguous), unmatched };
}

export function unresolvedFocusPathTargets(task: string, repositoryFiles: string[], authorizedPlannedTargets?: string[]): string[] {
  const planned = new Set(authorizedPlannedTargets ?? plannedNewFocusPathTargets(task, repositoryFiles));
  return [...new Set([
    ...unknownFocusPathTargets(task, repositoryFiles).filter((candidate) => !planned.has(candidate)),
    ...unsupportedExternalPathTargets(task)
  ])];
}

export function unknownFocusPathTargets(task: string, repositoryFiles: string[]): string[] {
  return [...new Set(unknownFocusPathMentions(task, repositoryFiles).map((entry) => entry.candidate))];
}

function unsupportedExternalPathTargets(task: string): string[] {
  const targets: string[] = [];
  for (const match of task.matchAll(/(?:^|[\s("'`\[<{,:;=>])((?:~\/|\$[A-Za-z_][A-Za-z0-9_]*\/|file:\/\/|[A-Za-z]:[\\/]|\\\\|\/|\.\.\/)[A-Za-z0-9_@.$~\\/-]+)(?=$|[\s,;:!?)}\]'"`])/giu)) {
    const target = match[1];
    const index = (match.index ?? 0) + match[0].indexOf(target);
    const before = task.slice(Math.max(0, index - 240), index);
    const authorityBefore = before.replace(/[`'"([{<]\s*$/u, "");
    if (hasMutationVerbBefore(authorityBefore) || /\b(?:add|build|copy|create|edit|extract|fix|harden|implement|migrate|move|relocate|rename|split|update|write)\b[\s\S]{0,200}(?:\b(?:as|at|in|into|to|under)\s*|->)$/iu.test(authorityBefore)) {
      targets.push(target.replace(/[.,;:!?]+$/u, ""));
    }
  }
  for (const match of task.matchAll(/https?:\/\/[^\s"'`()\[\]{}]+/giu)) {
    const index = match.index ?? 0;
    const before = task.slice(Math.max(0, index - 240), index);
    const authorityBefore = before.replace(/[`'"([{<]\s*$/u, "");
    if (/\b(?:convert|copy|extract|migrate|move|relocate|rename|split|transform)\b[\s\S]{0,200}(?:\b(?:as|into|to|under)\s*|->)$/iu.test(authorityBefore)) {
      targets.push(match[0].replace(/[.,;:!?]+$/u, ""));
    }
  }
  return targets;
}

export function plannedNewFocusPathTargets(task: string, repositoryFiles: string[]): string[] {
  const normalizedTask = task.replaceAll("\\", "/");
  const unknownIndexes = new Set(unknownFocusPathMentions(task, repositoryFiles).map((entry) => entry.index));
  const plannedIndexes = new Set<number>();
  const planned: string[] = [];
  let previous: FocusPathMention | undefined;
  for (const mention of focusPathMentions(normalizedTask)) {
    if (mention.candidate.split("/").includes("..")) {
      previous = mention;
      continue;
    }
    const unknown = unknownIndexes.has(mention.index);
    const before = normalizedTask.slice(Math.max(0, mention.index - 240), mention.index);
    const verbMatches = [...before.matchAll(/\b(add(?:ing)?|build(?:ing)?|chang(?:e|ing)|configur(?:e|ing)|convert(?:ing)?|cop(?:y|ying)|creat(?:e|ing)|delet(?:e|ing)|disabl(?:e|ing)|document(?:ing)?|enabl(?:e|ing)|extract(?:ing)?|fix(?:ing)?|generat(?:e|ing)|harden(?:ing)?|implement(?:ing)?|integrat(?:e|ing)|migrat(?:e|ing)|modify|modifying|mov(?:e|ing)|optimiz(?:e|ing)|patch(?:ing)?|prevent(?:ing)?|protect(?:ing)?|refactor(?:ing)?|relocat(?:e|ing)|remov(?:e|ing)|renam(?:e|ing)|repair(?:ing)?|replac(?:e|ing)|restor(?:e|ing)|revis(?:e|ing)|sav(?:e|ing)|scaffold(?:ing)?|secur(?:e|ing)|simplif(?:y|ying)|split(?:ting)?|support(?:ing)?|transform(?:ing)?|updat(?:e|ing)|upgrad(?:e|ing)|write|writing)\b/giu)];
    const governing = verbMatches.at(-1);
    const verb = normalizePlanningVerb(governing?.[1]);
    const tail = governing ? before.slice((governing.index ?? 0) + governing[0].length) : "";
    const directCreation = Boolean(verb && /^(?:add|build|create|generate|implement|save|scaffold|write)$/u.test(verb) && /^\s+(?:(?:a|an|the)\s+)?(?:(?:following|these|new)\s+)*(?:files?\s*)?(?::\s*)?(?:(?:[-*]\s*(?:\[[ xX]\]\s*)?|\d+[.)]\s*))?[\[<{]?\s*$/iu.test(tail));
    const descriptiveCreation = Boolean(verb && /^(?:build|create|generate|scaffold)$/u.test(verb) && /^\s+(?:(?:a|an|the|new)\s+)?(?:[a-z0-9_-]+\s+){1,6}[\[<{]?\s*$/iu.test(tail));
    const creationDestination = Boolean(verb && /^(?:build|create|document|generate|save|scaffold|write)$/u.test(verb) && /\b(?:as|at|in|into|to)\s*[\[<{]?\s*$/iu.test(tail))
      || Boolean(verb && /^(?:add|implement|support)$/u.test(verb) && /\b(?:at|in|into|to)\s*[\[<{]?\s*$/iu.test(tail))
      || verb === "write" && /\bimplementation\b[\s\S]{0,60}\b(?:at|in|into|to)\s*[\[<{]?\s*$/iu.test(tail);
    const structuralDestination = verb === "extract" && /(?:\b(?:as|into|to|under)|->)(?:\s+(?:(?:a|an|the|new)\s+){0,2}(?:file|module|package))?(?:\s+(?:at|in|into|to|under))?\s*[\[<{]?\s*$/iu.test(tail)
      || Boolean(verb && /^(?:convert|copy|migrate|move|relocate|split|transform)$/u.test(verb) && /(?:\b(?:as|into|to|under)|->)(?:\s+(?:(?:a|an|the|new)\s+){0,2}(?:file|module|package))?(?:\s+(?:at|in|into|to|under))?\s*[\[<{]?\s*$/iu.test(tail))
      || verb === "rename" && /(?:\b(?:as|to)|->)(?:\s+(?:(?:a|an|the|new)\s+){0,2}(?:file|module|package))?(?:\s+(?:at|in|into|to))?\s*[\[<{]?\s*$/iu.test(tail);
    const listContinuation = Boolean(previous && (plannedIndexes.has(previous.index) || directCreation || descriptiveCreation) && /^\s*[\]}>]?\s*(?:,\s*(?:and|&)?|;|\band\b|&|[-*]\s*(?:\[[ xX]\]\s*)?|\d+[.)])\s*[\[<{]?\s*$/iu.test(normalizedTask.slice(previous.end, mention.index)));
    if (!unknown) {
      if (directCreation || descriptiveCreation || listContinuation) plannedIndexes.add(mention.index);
      previous = mention;
      continue;
    }
    const strongSyntax = directCreation || descriptiveCreation || structuralDestination || listContinuation;
    const intentionalNewCue = /\bnew\b/iu.test(tail) || /(?:^|[-_.])new(?:[-_.]|$)/iu.test(mention.candidate.split("/").at(-1) ?? mention.candidate);
    const similarityAllowed = mention.explicit || structuralDestination || intentionalNewCue;
    if ((strongSyntax || creationDestination) && (similarityAllowed || !isLikelyPathTypo(mention.candidate, repositoryFiles))) {
      plannedIndexes.add(mention.index);
      planned.push(mention.candidate);
    }
    previous = mention;
  }
  return [...new Set(planned)];
}

function explicitSymbolListOccurrence(task: string, label: string, index: number): boolean {
  if (index < 0) return false;
  const before = task.slice(Math.max(0, index - 40), index);
  const after = task.slice(index + label.length, index + label.length + 80);
  return (
    /(?:\band\s+(?:the\s+)?|\bplus\s+(?:the\s+)?|\balongside\s+(?:the\s+)?|\btogether\s+with\s+(?:the\s+)?|\bwith\s+(?:the\s+)?|,\s*(?:the\s+)?)$/iu.test(before) && /^(?:\s+(?:and|to|with|for)\b|\s*[,;.]|\s*$)/iu.test(after)
  ) || /^\s+and\s+(?:\.\/)?(?:[A-Za-z0-9_@.-]+\/)+[A-Za-z0-9_@.-]+/u.test(after);
}

function isExplicitSymbolOccurrence(task: string, label: string, index: number): boolean {
  if (index < 0) return false;
  if (isStrongExplicitSymbolOccurrence(task, label, index)) return true;
  const before = task.slice(Math.max(0, index - 48), index);
  return hasMutationVerbBefore(before)
    || hasSymbolDependencyCueBefore(before)
    || /\b(?:in|inside|within)\s+(?:the\s+)?$/iu.test(before)
    || /\b(?:callers?|callees?|dependencies|uses)\s+(?:of\s+)?$/iu.test(before);
}

function isStrongExplicitSymbolOccurrence(task: string, label: string, index: number): boolean {
  if (index < 0) return false;
  return /[A-Z_$.:]/u.test(label) || task.toLowerCase().includes(`\`${label.toLowerCase()}\``) || explicitSymbolListOccurrence(task, label, index);
}

function isAmbiguousExplicitSymbolOccurrence(task: string, label: string, index: number): boolean {
  if (isStrongExplicitSymbolOccurrence(task, label, index)) return true;
  if (index < 0) return false;
  const before = task.slice(Math.max(0, index - 48), index);
  const after = task.slice(index + label.length, index + label.length + 32);
  return hasSymbolDependencyCueBefore(before)
    || /\b(?:in|inside|within)\s+(?:the\s+)?$/iu.test(before)
    || /\b(?:callers?|callees?|dependencies|uses)\s+(?:of\s+)?$/iu.test(before)
    || (hasMutationVerbBefore(before) && /^\s*(?:$|[.,;]|(?:and|plus|with)\b|(?:api\s+)?contract\b)/iu.test(after));
}

function hasSymbolDependencyCueBefore(before: string): boolean {
  return hasTargetReferenceCueBefore(before);
}

function hasMutationVerbBefore(before: string): boolean {
  return /\b(?:add(?:ing)?|address(?:ing)?|adjust(?:ing)?|allow(?:ing)?|apply|applying|build(?:ing)?|chang(?:e|ing)|complet(?:e|ing)|configur(?:e|ing)|continu(?:e|ing)|cop(?:y|ying)|correct(?:ing)?|creat(?:e|ing)|delet(?:e|ing)|disabl(?:e|ing)|edit(?:ing)?|enabl(?:e|ing)|enforc(?:e|ing)|ensur(?:e|ing)|extract(?:ing)?|finish(?:ing)?|fix(?:ing)?|generat(?:e|ing)|harden(?:ing)?|implement(?:ing)?|improv(?:e|ing)|integrat(?:e|ing)|make|making|migrat(?:e|ing)|modify|modifying|mov(?:e|ing)|optimiz(?:e|ing)|patch(?:ing)?|prevent(?:ing)?|protect(?:ing)?|refactor(?:ing)?|remov(?:e|ing)|renam(?:e|ing)|repair(?:ing)?|replac(?:e|ing)|resolv(?:e|ing)|restor(?:e|ing)|restrict(?:ing)?|revis(?:e|ing)|scaffold(?:ing)?|secur(?:e|ing)|set|setting|simplif(?:y|ying)|split(?:ting)?|support(?:ing)?|synchroni[sz](?:e|ing)|updat(?:e|ing)|upgrad(?:e|ing)|write|writing)\s+(?:the\s+)?$/iu.test(before);
}

function hasUnqualifiedBasenameOccurrence(task: string, basename: string, repositoryPaths: string[]): boolean {
  let start = 0;
  while (start < task.length) {
    const index = task.indexOf(basename, start);
    if (index < 0) return false;
    const before = index > 0 ? task[index - 1] : "";
    const after = task[index + basename.length] ?? "";
    const terminalPeriod = after === "." && !/[a-z0-9_]/iu.test(task[index + basename.length + 1] ?? "");
    if (!/[a-z0-9_.-]/iu.test(before) && (terminalPeriod || !/[a-z0-9_./-]/iu.test(after))) {
      const covered = repositoryPaths.some((filePath) => {
        const prefixLength = filePath.length - basename.length;
        return prefixLength > 0 && task.slice(Math.max(0, index - prefixLength), index + basename.length) === filePath
          || filePath === basename && task.slice(Math.max(0, index - 2), index + basename.length) === `./${basename}`;
      });
      if (!covered) return true;
    }
    start = index + 1;
  }
  return false;
}

function focusSymbolTaskIndex(task: string, label: string): number {
  return focusFileTaskIndex(task.toLowerCase(), label.toLowerCase());
}

function symbolLabelEntriesForTask(task: string, symbols: SymbolFact[]): Array<{ label: string; paths: Set<string>; index: number }> {
  const groups = new Map<string, Map<string, Set<string>>>();
  for (const symbol of symbols) {
    for (const label of [symbol.name, symbol.qualifiedName].filter((value) => value.length > 1)) {
      const variants = groups.get(label.toLowerCase()) ?? new Map<string, Set<string>>();
      const paths = variants.get(label) ?? new Set<string>();
      paths.add(symbol.path);
      variants.set(label, paths);
      groups.set(label.toLowerCase(), variants);
    }
  }
  return [...groups.values()].flatMap((variants) => {
    const exact = [...variants.entries()]
      .map(([label, paths]) => ({ label, paths, index: focusFileTaskIndex(task, label) }))
      .filter((entry) => entry.index >= 0);
    if (exact.length > 0) return exact;
    const [firstLabel] = variants.keys();
    const index = firstLabel ? focusSymbolTaskIndex(task, firstLabel) : -1;
    if (index < 0 || !firstLabel) return [];
    if (!/[A-Z_$.:]/u.test(firstLabel.slice(1)) && !task.toLowerCase().includes(`\`${firstLabel.toLowerCase()}\``)) return [];
    const paths = new Set<string>();
    for (const variantPaths of variants.values()) for (const filePath of variantPaths) paths.add(filePath);
    return [{ label: firstLabel, paths, index }];
  });
}

type FocusPathMention = { candidate: string; index: number; end: number; explicit: boolean };

function focusPathMentions(task: string): FocusPathMention[] {
  return [...task.matchAll(/(?:^|[\s("'`\[<{,:;=>])((?:\.\/)?(?:(?:[A-Za-z0-9_@.-]+\/)+(?:[A-Za-z0-9_@.-]*[A-Za-z0-9_@])|[A-Za-z0-9_@-]+\.[A-Za-z0-9]+|\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*|Dockerfile|Makefile))/giu)]
    .map((match) => {
      const raw = match[1];
      const index = (match.index ?? 0) + match[0].indexOf(raw);
      return { candidate: normalizeMentionCandidate(raw), index, end: index + raw.length, explicit: raw.startsWith("./") };
    });
}

function normalizeMentionCandidate(value: string): string {
  const portable = value.replace(/\.$/u, "").replaceAll("\\", "/");
  if (portable.split("/").includes("..")) return portable.replace(/^\.\//u, "");
  const normalized = path.posix.normalize(portable);
  return normalized.replace(/^\.\//u, "");
}

function unknownFocusPathMentions(task: string, repositoryFiles: string[]): FocusPathMention[] {
  const known = new Set(repositoryFiles.map((file) => file.replaceAll("\\", "/")));
  const knownBasenames = new Set(repositoryFiles.map((file) => (file.replaceAll("\\", "/").split("/").at(-1) ?? file).toLowerCase()));
  const knownExtensions = new Set(repositoryFiles.map((file) => file.match(/\.([A-Za-z0-9]+)$/u)?.[1]?.toLowerCase()).filter((extension): extension is string => Boolean(extension)));
  const repositoryTopLevels = new Set(repositoryFiles.map((file) => file.replaceAll("\\", "/").split("/")[0]));
  const normalizedTask = task.replaceAll("\\", "/");
  return focusPathMentions(normalizedTask)
    .filter((entry) => !entry.candidate.startsWith("../") && !entry.candidate.startsWith("@") && !known.has(entry.candidate))
    .filter((entry) => entry.explicit || entry.candidate.includes("/") || !knownBasenames.has(entry.candidate.toLowerCase()))
    .filter((entry) => {
      const firstSegment = entry.candidate.split("/")[0];
      if (repositoryTopLevels.has(firstSegment)) return true;
      const before = normalizedTask.slice(Math.max(0, entry.index - 48), entry.index);
      const after = normalizedTask.slice(entry.end, entry.end + 64);
      if (entry.candidate.includes("/") && firstSegment.includes(".") && !firstSegment.startsWith(".")) return false;
      if (/\b(?:for|from|import|link|url)\s*$/iu.test(before)) return false;
      if (/\b(?:compatibility|support(?:ing)?)\s+(?:(?:for|with)\s+)?$/iu.test(before)) return false;
      if (/\bcompatibility\s+(?:with\s+)?$/iu.test(before) && /(?:^|\/)v?\d+\.\d+/iu.test(entry.candidate)) return false;
      if (isDependencySpecifierMention(entry, normalizedTask, repositoryTopLevels)) return false;
      return true;
    })
    .filter((entry) => {
      if (entry.explicit) return true;
      const extension = entry.candidate.match(/\.([A-Za-z0-9]+)$/u)?.[1];
      const before = normalizedTask.slice(Math.max(0, entry.index - 96), entry.index);
      const directCreation = /\b(?:add(?:ing)?|build(?:ing)?|creat(?:e|ing)|document(?:ing)?|generat(?:e|ing)|implement(?:ing)?|sav(?:e|ing)|scaffold(?:ing)?|write|writing)\b[^.!?]{0,80}$/iu.test(before);
      const standardRootFile = /^(?:Dockerfile|Makefile|\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*)$/iu.test(entry.candidate);
      return Boolean((extension && (entry.candidate.includes("/") || knownExtensions.has(extension.toLowerCase()) || directCreation)) || (standardRootFile && directCreation));
    })
    ;
}

function isDependencySpecifierMention(entry: FocusPathMention, task: string, repositoryTopLevels: Set<string>): boolean {
  if (entry.explicit || !entry.candidate.includes("/")) return false;
  const firstSegment = entry.candidate.split("/")[0];
  if (repositoryTopLevels.has(firstSegment)) return false;
  const before = task.slice(Math.max(0, entry.index - 160), entry.index);
  const after = task.slice(entry.end, entry.end + 96);
  const dependencyContext = /\b(?:dependencies?|from|imports?|importing|packages?)\s*$/iu.test(before)
    || /^\s+(?:dependency|import|package|specifier|usage)\b/iu.test(after);
  if (dependencyContext) return true;
  const creationOrDestination = /\b(?:add|build|copy|create|document|extract|generate|implement|move|relocate|rename|save|scaffold|split|transform|write)\b[\s\S]{0,120}(?:\b(?:as|at|in|into|to|under)\s*|->)?$/iu.test(before);
  const escapedRoot = firstSegment.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const dependencyMigration = new RegExp(`\\bmigrat(?:e|ing)\\s+from\\s+${escapedRoot}\\/[^\\s]+\\s+to\\s+${escapedRoot}\\/`, "iu").test(task);
  if (dependencyMigration) return true;
  if (creationOrDestination) return false;
  return /\b(?:bump|downgrade|pin|update|upgrade)\b[^.!?]{0,80}$/iu.test(before)
    && /^\s+(?:in\s+)?(?:package\.json|pnpm-lock\.yaml|package-lock\.json|yarn\.lock|bun\.lockb?)\b/iu.test(after);
}

export function isLikelyPathTypo(candidate: string, repositoryFiles: string[]): boolean {
  const normalizedCandidate = candidate.toLowerCase().replaceAll("\\", "/");
  const basename = normalizedCandidate.split("/").at(-1) ?? normalizedCandidate;
  const candidateDirectory = normalizedCandidate.includes("/") ? normalizedCandidate.slice(0, normalizedCandidate.lastIndexOf("/")) : "";
  const extension = basename.match(/\.([a-z0-9]+)$/u)?.[1];
  const stem = basename.replace(/\.[^.]+$/u, "");
  if (!extension || stem.length < 3) return false;
  return repositoryFiles.some((filePath) => {
    const knownBasename = filePath.toLowerCase().replaceAll("\\", "/").split("/").at(-1) ?? "";
    if (!knownBasename.endsWith(`.${extension}`)) return false;
    const normalizedKnown = filePath.toLowerCase().replaceAll("\\", "/");
    const knownDirectory = normalizedKnown.includes("/") ? normalizedKnown.slice(0, normalizedKnown.lastIndexOf("/")) : "";
    if (candidateDirectory && candidateDirectory !== knownDirectory) return false;
    return editDistanceAtMostOne(stem, knownBasename.replace(/\.[^.]+$/u, ""));
  });
}

export function isStructuralEditTask(task: string): boolean {
  if (/\bmov(?:e|ing)\s+(?:ahead|forward|on)\b/iu.test(task)) return false;
  const pathDestination = "(?:\\./)?(?:(?:[A-Za-z0-9_@.-]+/)+[A-Za-z0-9_@.-]+|[A-Za-z0-9_@-]+\\.[A-Za-z0-9]+)";
  return new RegExp(`\\b(?:convert(?:ing)?|cop(?:y|ying)|extract(?:ing)?|migrat(?:e|ing)|mov(?:e|ing)|relocat(?:e|ing)|renam(?:e|ing)|split(?:ting)?|transform(?:ing)?)\\b[\\s\\S]{0,180}(?:(?:\\b(?:as|into|to|under)\\b|->)[\\s\\S]{0,80})${pathDestination}`, "iu").test(task);
}

function normalizePlanningVerb(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const lower = value.toLowerCase();
  const pairs: Array<[RegExp, string]> = [
    [/^add/u, "add"], [/^build/u, "build"], [/^convert/u, "convert"], [/^cop/u, "copy"], [/^creat/u, "create"], [/^document/u, "document"], [/^extract/u, "extract"], [/^generat/u, "generate"],
    [/^implement/u, "implement"], [/^migrat/u, "migrate"], [/^mov/u, "move"], [/^relocat/u, "relocate"], [/^renam/u, "rename"], [/^sav/u, "save"], [/^scaffold/u, "scaffold"],
    [/^split/u, "split"], [/^support/u, "support"], [/^transform/u, "transform"], [/^writ/u, "write"]
  ];
  return pairs.find(([pattern]) => pattern.test(lower))?.[1] ?? lower;
}

function editDistanceAtMostOne(left: string, right: string): boolean {
  if (left === right) return true;
  if (Math.abs(left.length - right.length) > 1) return false;
  if (left.length === right.length) {
    const mismatches: number[] = [];
    for (let index = 0; index < left.length; index += 1) if (left[index] !== right[index]) mismatches.push(index);
    if (mismatches.length <= 1) return true;
    return mismatches.length === 2
      && mismatches[1] === mismatches[0] + 1
      && left[mismatches[0]] === right[mismatches[1]]
      && left[mismatches[1]] === right[mismatches[0]];
  }
  const [shorter, longer] = left.length < right.length ? [left, right] : [right, left];
  let shortIndex = 0;
  let longIndex = 0;
  let skipped = false;
  while (shortIndex < shorter.length && longIndex < longer.length) {
    if (shorter[shortIndex] === longer[longIndex]) {
      shortIndex += 1;
      longIndex += 1;
    } else if (skipped) {
      return false;
    } else {
      skipped = true;
      longIndex += 1;
    }
  }
  return true;
}

function focusFileTaskIndex(task: string, file: string): number {
  let start = 0;
  while (start < task.length) {
    const index = task.indexOf(file, start);
    if (index < 0) break;
    const before = index > 0 ? task[index - 1] : "";
    const after = task[index + file.length] ?? "";
    const terminalPeriod = after === "." && !/[a-z0-9_]/iu.test(task[index + file.length + 1] ?? "");
    if (!/[a-z0-9_./-]/iu.test(before) && (terminalPeriod || !/[a-z0-9_./-]/iu.test(after))) return index;
    start = index + 1;
  }
  const normalizedFile = normalizeMentionCandidate(file);
  return focusPathMentions(task).find((mention) => mention.candidate === normalizedFile)?.index ?? -1;
}

export function classifyChangePlanNeed(input: ChangePlanRoutingInput): ChangePlanNeed | undefined {
  if (input.mode !== "edit") return undefined;
  const targetFilesKnown = input.targetFiles !== undefined;
  const implementationTargetCount = targetFilesKnown ? input.targetFiles!.filter(isImplementationPlanTarget).length : input.explicitTargetCount ?? 0;
  const hasImplementationTarget = targetFilesKnown ? implementationTargetCount > 0 : true;
  if ((input.dirtyScopeFileCount ?? 0) > 0) {
    return { trigger: "dirty-scope", reason: "save the full dirty-worktree edit plan and planned verification before editing" };
  }
  const task = input.task?.toLowerCase() ?? "";
  if (input.changeType === "style") return undefined;
  if (input.changeType === "api" || input.changeType === "rename" || input.changeType === "delete") {
    return { trigger: "material-risk", reason: `save one bounded plan because the ${input.changeType} edit crosses a material boundary` };
  }
  const riskProse = task
    .replace(/(?:^|[\s("'`])(?:[a-z0-9_@.-]+[\\/])+[a-z0-9_@.-]+/giu, " ")
    .replace(/\b[a-z0-9_@-]+\.[a-z0-9]+\b/giu, " ");
  const documentationCue = /\b(?:annotat(?:e|ing)|document(?:ing|ation)?|docs?|wording|readmes?|comments?|copy)\b/u.test(riskProse);
  const nonDocumentationProse = riskProse.replace(/\b(?:(?:stale|public|api|security|schemas?|contracts?|runtimes?|auth|authentication|authorization|permissions?|interfaces?|endpoints?|routes?)\s+){0,3}(?:documentation|docs?|wording|readmes?|comments?|copy)\b/gu, " ");
  const boundaryRiskPattern = /\b(?:access control|apis?|contracts?|credentials?|databases?|endpoints?|exported\s+(?:functions?|methods?|types?|values?)|exports?|persistence|public\s+(?:interfaces?|methods?|signatures?|types?)|(?:api|http|web)\s+routes?|routes?\s+(?:contracts?|handlers?|responses?)|schemas?|auth|authentication|authorization|security|permissions?|runtimes?)\b/u;
  const fileDestructionPattern = /\b(?:delete|remove)\s+(?:(?:a|the)\s+)?(?:file\s+)?(?:\.\/)?(?:[a-z0-9_@.-]+\/)*[a-z0-9_@.-]+\.[a-z0-9]+\b|\b(?:delete|remove)\s+(?:(?:a|the)\s+)?file\b/u;
  const structuralBoundaryPattern = /\b(?:migrate|move)\b[^.!?]{0,80}\b(?:between\s+(?:packages?|modules?|services?)|new\s+layout|out\s+of\s+(?:the\s+)?(?:package|module|service)|(?:into|to|under)\s+(?:(?:a|an|another|named|new|the)\s+){0,3}(?:(?:[a-z0-9_-]+\s+)?(?:layout|package|module|service)|(?:layout|package|module|service)\s+[a-z0-9_.-]+))\b/u;
  const highRiskPattern = /\b(?:atomic\s+writes?|writes?\s+atomic|cache\s+invalidation|command\s+injection|concurrenc(?:y|t)|credential\s+(?:exposure|leak)|data\s+(?:corruption|integrity|loss)|deadlocks?|directory\s+traversal|path\s+traversal|race\s+conditions?|remote\s+code\s+execution|rce|server[- ]side\s+request\s+forgery|shell\s+injection|sql\s+injection|ssrf|unsafe\s+(?:deserialization|file|path|shell|sql))\b/u;
  const codeObjectPattern = /\b(?:behavior|class|code|function|handler|implementation|logic|method|runtime behavior|signature|type)\b/u;
  const documentationObjectPhrase = /\b(?:comments?|copy|documentation|docs?|readmes?|wording)\s+(?:about|for|of|on)\b/u.test(riskProse);
  const documentationDirective = /\b(?:annotat(?:e|ing)|document(?:ing)?)\b/u.test(riskProse);
  const documentationOnlyTask = documentationCue && !codeObjectPattern.test(nonDocumentationProse) && (documentationDirective || documentationObjectPhrase || !boundaryRiskPattern.test(nonDocumentationProse));
  const trivialCue = /\b(?:comments?|copyright|formatting|metadata|punctuation|sorting|spelling|style|typos?|whitespace|wording)\b/u.test(nonDocumentationProse);
  const trivialOverride = /\b(?:behavior|implementation|logic|signature)\b/u.test(nonDocumentationProse) || /\b(?:cross[- ]cutting|harden|refactor|synchroni[sz]e)\b/u.test(nonDocumentationProse);
  if (documentationOnlyTask || (trivialCue && !trivialOverride)) return undefined;
  const localCleanup = /\b(?:dead\s+(?:local\s+)?code|(?:internal|private)\s+(?:helper|symbol)|local\s+(?:constant|function|helper|method|symbol|type|variable)|unused\s+import|within\s+(?:the\s+)?(?:same\s+)?file)\b/u.test(nonDocumentationProse);
  const destructiveResolvedCodeTarget = hasImplementationTarget
    && (input.explicitTargetCount ?? 0) > 0
    && /\b(?:delete|remove|rename)\b/u.test(nonDocumentationProse)
    && !localCleanup;
  if (hasImplementationTarget && (input.explicitTargetCount ?? 0) > 0 && /\b(?:current|local|pending|uncommitted) changes?\b/u.test(task)) {
    return { trigger: "material-risk", reason: "save one bounded plan for the explicitly named part of the current worktree edit" };
  }
  if ((input.explicitTargetCount ?? 0) > 1 && implementationTargetCount > 1) {
    return { trigger: "multiple-targets", reason: "save one bounded plan because the edit explicitly crosses multiple source targets" };
  }
  if (hasImplementationTarget && /\b(?:multi(?:ple)?[- ]files?|both files|across (?:files?|modules?|packages?|layers?|services?)|cross[- ](?:file|module|package|layer|service)|cross[- ]cutting)\b/u.test(task)) {
    return { trigger: "multi-file", reason: "save one bounded plan because the requested edit crosses source boundaries" };
  }
  if (hasImplementationTarget && (boundaryRiskPattern.test(nonDocumentationProse) || highRiskPattern.test(nonDocumentationProse) || fileDestructionPattern.test(task) || structuralBoundaryPattern.test(riskProse) || destructiveResolvedCodeTarget)) {
    return { trigger: "material-risk", reason: "save one bounded plan because the requested edit crosses a material contract, runtime, persistence, or security boundary" };
  }
  return undefined;
}

function isImplementationPlanTarget(file: string): boolean {
  const normalized = file.toLowerCase().replaceAll("\\", "/");
  const basename = normalized.split("/").at(-1) ?? normalized;
  if (isTestPath(normalized)) return false;
  if (/\.(?:md|mdx|rst|txt|adoc)$/u.test(normalized)) return false;
  if (/^(?:readme|changelog|license|contributing|code_of_conduct)(?:\.[a-z0-9]+)?$/u.test(basename)) return false;
  return !normalized.startsWith("docs/");
}

export function formatWorkflowSummary(workflow: WorkflowTraceFact): string {
  return `- ${workflow.title}: ${workflow.workflowKind}, rank ${workflow.rank.toFixed(2)}, ${workflow.confidence}; ${workflow.summary}`;
}

export function isImpactGraphEdge(kind: GraphEdgeKind): boolean {
  return [
    "CALLS",
    "REFERENCES",
    "IMPORTS",
    "TESTS",
    "ROUTE_HANDLES",
    "ROUTE_CALLS_STORE",
    "STORE_DISPATCHES_ADAPTER",
    "ADAPTER_REFERENCED_BY_MANIFEST",
    "UI_CALLS_ENDPOINT",
    "TEST_COVERS_WORKFLOW",
    "IMPLEMENTS",
    "EXTENDS"
  ].includes(kind);
}

export function graphEdgeSort(a: GraphEdgeFact, b: GraphEdgeFact): number {
  return (
    graphEdgeKindScore(a.edgeKind) - graphEdgeKindScore(b.edgeKind) ||
    confidenceScore(a.confidence) - confidenceScore(b.confidence) ||
    b.weight - a.weight ||
    (a.fromPath ?? "").localeCompare(b.fromPath ?? "") ||
    (a.toPath ?? "").localeCompare(b.toPath ?? "")
  );
}

export function formatGraphEdge(edge: GraphEdgeFact): string {
  const from = edge.fromSymbolId ? edge.fromSymbolId : edge.fromPath ?? edge.fromId;
  const to = edge.toSymbolId ? edge.toSymbolId : edge.toPath ?? edge.toId;
  const location = edge.range?.startLine ? ` at ${edge.fromPath ?? edge.path}:${edge.range.startLine}` : "";
  return `- ${edge.edgeKind}: ${from} -> ${to}; ${edge.confidence}; ${edge.reason}${location}`;
}

export function affectedWorkflowGraphEdges(index: { graphEdges: GraphEdgeFact[] }, paths: string[]): GraphEdgeFact[] {
  const pathSet = new Set(paths);
  return index.graphEdges
    .filter((edge) => pathSet.has(edge.fromPath ?? "") || pathSet.has(edge.toPath ?? ""))
    .filter((edge) => isImpactGraphEdge(edge.edgeKind) || edge.edgeKind === "ROUTE" || edge.edgeKind === "JOB")
    .sort(graphEdgeSort);
}

export function testsFromGraphEdges(edges: GraphEdgeFact[]): string[] {
  return uniqueSorted(
    edges
      .flatMap((edge) => [edge.fromPath, edge.toPath])
      .filter((filePath): filePath is string => Boolean(filePath))
      .filter((filePath) => isTestPath(filePath))
  );
}

function graphEdgeKindScore(kind: GraphEdgeKind): number {
  const order: Record<GraphEdgeKind, number> = {
    DEFINES: 0,
    ROUTE: 1,
    JOB: 1,
    ROUTE_HANDLES: 1,
    UI_CALLS_ENDPOINT: 2,
    TEST_COVERS_WORKFLOW: 2,
    ROUTE_CALLS_STORE: 3,
    STORE_DISPATCHES_ADAPTER: 3,
    ADAPTER_REFERENCED_BY_MANIFEST: 3,
    CALLS: 4,
    REFERENCES: 5,
    IMPORTS: 6,
    TESTS: 7,
    EXTENDS: 8,
    IMPLEMENTS: 8,
    EXPORTS: 9,
    TYPE_EXPORTS: 9,
    RISK: 10
  };
  return order[kind];
}

function confidenceScore(confidence: GraphEdgeFact["confidence"]): number {
  if (confidence === "authoritative") {
    return 0;
  }
  if (confidence === "derived") {
    return 1;
  }
  return 2;
}
