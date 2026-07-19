import { promptModeForTask } from "../../retrieval/intent.js";
import type { ContextPackInput, SymbolFact } from "../../types.js";
import { classifyTaskTargetRoles, isStructuralEditTask, type TaskTargetRoles } from "../graph.js";
import { repositoryTargetPathAuthority, type RepositoryTargetPathAuthority } from "../targets.js";
import { uniqueSorted } from "../../util.js";

export function structuredNewTargetAuthority(task: string | undefined, changeType: ContextPackInput["changeType"]): { allowed: boolean; structural: boolean } {
  const normalized = (task ?? "").trim().toLowerCase().replace(/^(?:session start|task|request):\s*/u, "").replace(/^context(?:\s+first)?[.:]\s*/u, "").replace(/^(?:(?:please\s+)?(?:can|could|would|will)\s+you\s+(?:please\s+)?|please\s+)/u, "");
  const editDirected = promptModeForTask(task, changeType) === "edit";
  const structural = editDirected && (changeType === "rename" || isStructuralEditTask(normalized));
  const creation = editDirected && /\b(?:add(?:ing)?|build(?:ing)?|creat(?:e|ing)|document(?:ing)?|generat(?:e|ing)|implement(?:ing)?|sav(?:e|ing)|scaffold(?:ing)?|write|writing)\b/u.test(normalized);
  return { allowed: structural || creation, structural };
}

export type PlannedTargetAuthority = {
  inspections: RepositoryTargetPathAuthority[];
  newTargets: string[];
  indexedTargets: string[];
  indexedTargetMentions: string[];
};

export async function inspectPlannedTargetAuthority(
  proposedTargets: string[],
  repoRoot: string,
  repositoryFiles: string[],
  mentionedTargets: string[] = proposedTargets
): Promise<PlannedTargetAuthority> {
  const plannedTargets = new Set(proposedTargets);
  const inspections = await Promise.all(uniqueSorted([...proposedTargets, ...mentionedTargets]).map((filePath) => repositoryTargetPathAuthority(filePath, repoRoot, repositoryFiles)));
  return {
    inspections,
    newTargets: uniqueSorted(inspections.filter((entry) => entry.status === "missing" && plannedTargets.has(entry.requestedPath)).flatMap((entry) => entry.path ? [entry.path] : [])),
    indexedTargets: uniqueSorted(inspections.filter((entry) => entry.status === "indexed").flatMap((entry) => entry.path ? [entry.path] : [])),
    indexedTargetMentions: uniqueSorted(inspections.filter((entry) => entry.status === "indexed").map((entry) => entry.requestedPath))
  };
}

export function editableTargetsWithDefault(
  task: string,
  candidates: string[],
  repositoryFiles: string[],
  symbols: SymbolFact[]
): { roles: TaskTargetRoles; editableTargets: string[] } {
  const roles = classifyTaskTargetRoles(task, candidates, repositoryFiles, symbols);
  const classified = new Set([...roles.editableTargets, ...roles.readDependencies, ...roles.excludedTargets]);
  return { roles, editableTargets: [...new Set([...roles.editableTargets, ...candidates.filter((filePath) => !classified.has(filePath))])] };
}

export function mergeTaskTargetRoles(editableTargets: string[], ...roles: TaskTargetRoles[]): TaskTargetRoles {
  return {
    editableTargets,
    readDependencies: uniqueSorted(roles.flatMap((entry) => entry.readDependencies)).filter((filePath) => !editableTargets.includes(filePath)),
    excludedTargets: uniqueSorted(roles.flatMap((entry) => entry.excludedTargets)),
    hasReferenceCue: roles.some((entry) => entry.hasReferenceCue),
    unresolvedReferenceCue: roles.some((entry) => entry.unresolvedReferenceCue)
  };
}

export function completeTaskTargetRoles(roles: Partial<TaskTargetRoles> | undefined): TaskTargetRoles {
  return {
    editableTargets: roles?.editableTargets ?? [],
    readDependencies: roles?.readDependencies ?? [],
    excludedTargets: roles?.excludedTargets ?? [],
    hasReferenceCue: roles?.hasReferenceCue ?? false,
    unresolvedReferenceCue: roles?.unresolvedReferenceCue ?? false
  };
}
