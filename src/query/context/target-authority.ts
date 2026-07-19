import { promptModeForTask } from "../../retrieval/intent.js";
import type { ContextPackInput } from "../../types.js";
import { isStructuralEditTask } from "../graph.js";
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
  repositoryFiles: string[]
): Promise<PlannedTargetAuthority> {
  const inspections = await Promise.all(proposedTargets.map((filePath) => repositoryTargetPathAuthority(filePath, repoRoot, repositoryFiles)));
  return {
    inspections,
    newTargets: uniqueSorted(inspections.filter((entry) => entry.status === "missing").flatMap((entry) => entry.path ? [entry.path] : [])),
    indexedTargets: uniqueSorted(inspections.filter((entry) => entry.status === "indexed").flatMap((entry) => entry.path ? [entry.path] : [])),
    indexedTargetMentions: uniqueSorted(inspections.filter((entry) => entry.status === "indexed").map((entry) => entry.requestedPath))
  };
}
