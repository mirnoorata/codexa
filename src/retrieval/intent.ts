const editVerb = "add(?:ing)?|address(?:ing)?|adjust(?:ing)?|allow(?:ing)?|annotat(?:e|ing)|apply|applying|build(?:ing)?|bump(?:ing)?|chang(?:e|ing)|clean(?:ing)?\\s+up|complet(?:e|ing)|configur(?:e|ing)|consolidat(?:e|ing)|continu(?:e|ing)|convert(?:ing)?|cop(?:y|ying)|correct(?:ing)?|creat(?:e|ing)|deduplicat(?:e|ing)|delet(?:e|ing)|disabl(?:e|ing)|document(?:ing)?|downgrad(?:e|ing)|edit(?:ing)?|enabl(?:e|ing)|enforc(?:e|ing)|ensur(?:e|ing)|extract(?:ing)?|finish(?:ing)?|fix(?:ing)?|format(?:ting)?|generat(?:e|ing)|harden(?:ing)?|implement(?:ing)?|improv(?:e|ing)|integrat(?:e|ing)|introduc(?:e|ing)|make|making|merg(?:e|ing)|migrat(?:e|ing)|modify|modifying|mov(?:e|ing)|optimiz(?:e|ing)|patch(?:ing)?|pin(?:ning)?|prevent(?:ing)?|protect(?:ing)?|refactor(?:ing)?|reformat(?:ting)?|relocat(?:e|ing)|remov(?:e|ing)|renam(?:e|ing)|reorder(?:ing)?|repair(?:ing)?|replac(?:e|ing)|resolv(?:e|ing)|restor(?:e|ing)|restrict(?:ing)?|revis(?:e|ing)|rewrit(?:e|ing)|sav(?:e|ing)|scaffold(?:ing)?|secur(?:e|ing)|set|setting|simplif(?:y|ying)|sort(?:ing)?|split(?:ting)?|support(?:ing)?|synchroni[sz](?:e|ing)|transform(?:ing)?|updat(?:e|ing)|upgrad(?:e|ing)|write|writing";
const passiveEditVerb = "added|addressed|adjusted|allowed|annotated|applied|built|bumped|changed|cleaned\\s+up|completed|configured|consolidated|converted|copied|corrected|created|deduplicated|deleted|disabled|documented|downgraded|edited|enabled|enforced|ensured|extracted|finished|fixed|formatted|generated|hardened|implemented|improved|integrated|introduced|made|merged|migrated|modified|moved|optimized|patched|pinned|prevented|protected|refactored|reformatted|relocated|removed|renamed|reordered|repaired|replaced|resolved|restored|restricted|revised|rewritten|saved|scaffolded|secured|set|simplified|sorted|split|supported|synchronized|transformed|updated|upgraded|written";
const mutationHead = new RegExp(`^(?:(?:(?:(?:i|we|you)\\s+)?(?:need|want|plan|have)\\s+(?:you\\s+)?to|(?:i|we|you)\\s+(?:should|must|can|could|would)|let['’]s)\\s+)?(?:${editVerb})\\b`, "u");
const collaborativeMutationHead = new RegExp(`^(?:(?:can|could|would|will)\\s+we\\s+(?:please\\s+)?|(?:i|we)\\s+(?:would\\s+like|need|want)\\s+(?:help\\s+)?(?:to\\s+)?|i(?:['’]d|\\s+would)\\s+like\\s+(?:you\\s+)?to\\s+|help(?:\\s+(?:me|us))?\\s+(?:to\\s+)?|mind\\s+|proceed\\s+(?:to|with)\\s+|(?:i|we)\\s+are\\s+)(?:${editVerb})\\b`, "u");
const passiveMutation = new RegExp(`(?:\\b(?:needs?|requires?)\\s+(?:to\\s+be\\s+)?(?:${editVerb}|${passiveEditVerb})\\b|\\b(?:should|must|can|could|would)\\s+be\\s+(?:${passiveEditVerb})\\b|^(?:(?:i|we)\\s+)?(?:need|want)\\b[^.!?]{0,100}\\b(?:${passiveEditVerb})\\b)`, "u");
const modalSubjectPassiveMutation = new RegExp(`^(?:can|could|would|should|must)\\s+[^.!?]{1,100}?\\s+be\\s+(?:${passiveEditVerb})\\b`, "u");
const requiredSubjectPassiveMutation = new RegExp(`^[^.!?]{1,100}?\\s+(?:has|have)\\s+to\\s+be\\s+(?:${passiveEditVerb})\\b`, "u");
const activeDeclarativeMutation = new RegExp(`^(?:the\\s+)?[^.!?\\n]{1,140}?\\s+(?:should|must|needs?\\s+to|has\\s+to|have\\s+to)\\s+(?:${editVerb})\\b`, "u");
const readOnlyRequestHead = /^(?:(?:i|we)\s+)?(?:need|want)\s+(?:(?:(?:an?|the|some)\s+)?(?:analysis|assessment|checklist|context|details|diagram|document|explanation|information|inventory|list|map|overview|plan|proposal|report|review|summary|understanding)\b|(?:(?:you|help(?:\s+(?:me|us))?)\s+)?(?:to\s+)?(?:describe|explain|inspect|know|review|see|show|understand(?:ing)?)\b)/u;
const readOnlyLead = /^(?:what|which|who|where|when|why|how|does|check|assess|determine|verify|tell|show|review|inspect|compare|summarize|explain|list|identify|describe|understand|map|audit|analy[sz]e|report|find|locate|debug|diagnose)\b/u;
const readOnlyMutationNounHead = /^(?:change|patch)\s+review\b/u;
const laterEditVerb = new RegExp(`(?:[.,;:]|\\n|\\band\\b|\\bthen\\b|\\bbefore\\b)\\s*(?:please\\s+)?(?:${editVerb})\\b(?!-)`, "u");
const readOnlyArtifactHead = /^(?:build(?:ing)?|creat(?:e|ing)|generat(?:e|ing)|mak(?:e|ing)|writ(?:e|ing))\s+(?:(?:a|an|the)\s+)?(?:[a-z0-9_-]+\s+){0,3}(?:(?:architecture|call|dependency)\s+(?:diagram|graph)|(?:design|implementation)\s+document|(?:test|implementation|migration)\s+plan|analysis|assessment|checklist|diagram|document|flowchart|graph|inventory|list|map|overview|plan|proposal|report|review|summary|todo(?:\s+list)?|understanding)(?=\s+(?:about|and|covering|detailing|describing|for|from|in|including|of|on|showing|listing|summarizing|that|to|with)\b|\.(?![a-z0-9])|[?!,;:]|$)/u;
const readOnlyIdiomHead = /^(?:mak(?:e|ing)\s+sense\s+of|build(?:ing)?\s+an?\s+understanding\s+of|writ(?:e|ing)\s+up\s+(?:(?:a|the)\s+)?(?:analysis|overview|report|review|summary))\b/u;
const nominalMutation = /^(?:(?:i|we)\s+(?:need|require|want)\s+(?:an?\s+)?(?:changes?|fix(?:es)?|patch(?:es)?|updates?)\s+(?:for|in|to)\b|(?:(?:the\s+)?[a-z0-9_@.-]+(?:\s+[a-z0-9_@.-]+){0,5})\s+(?:needs?|requires?)\s+(?:an?\s+)?(?:changes?|fix(?:es)?|patch(?:es)?|updates?)\b)/u;
const artifactOutputPath = "(?:\\./)?(?:(?:docs?|reports?)/[a-z0-9_@./-]+|(?:[a-z0-9_@.-]+/)*(?:analysis|assessment|checklist|diagram|document|graph|inventory|map|overview|plan|proposal|report|review|summary)[a-z0-9_@.-]*\\.[a-z0-9]+)";
const repositoryArtifactWrite = new RegExp(`(?:^(?:build|create|generate|write)\\b[\\s\\S]{0,180}\\b(?:analysis|assessment|checklist|diagram|document|graph|inventory|list|map|overview|plan|proposal|report|review|summary)\\b[\\s\\S]{0,100}\\b(?:as|at|in|to)|\\bsav(?:e|ing)\\s+(?:it|this|the\\s+(?:analysis|assessment|checklist|diagram|document|graph|inventory|list|map|overview|plan|proposal|report|review|summary))\\s+(?:as|at|in|to))\\s+${artifactOutputPath}\\b`, "u");

export function promptModeForTask(query: string | undefined, changeType = "unknown"): "edit" | "orientation" {
  if (changeType === "api" || changeType === "rename" || changeType === "delete") return "edit";
  const normalized = (query ?? "").trim().toLowerCase()
    .replace(/^(?:[-*]\s+(?:\[[ x]\]\s*)?|#+\s+|>\s*)/u, "")
    .replace(/^(?:session start|task|request):\s*/u, "")
    .replace(/^(?:(?:the|your)\s+)?(?:task|goal|objective|request)\s+is\s+to\s+/u, "")
    .replace(/^context(?:\s+first)?[.:]\s*/u, "")
    .replace(/^(?:(?:please\s+)?(?:can|could|would|will)\s+you\s+(?:please\s+)?|please\s+)/u, "");
  const controlledDirective = unwrapControlledDirective(normalized);
  if (controlledDirective) return promptModeForTask(controlledDirective, changeType);
  const laterEdit = hasLaterEditDirective(normalized);
  if (repositoryArtifactWrite.test(normalized)) return "edit";
  if ((readOnlyArtifactHead.test(normalized) || readOnlyIdiomHead.test(normalized)) && !laterEdit) return "orientation";
  if (readOnlyMutationNounHead.test(normalized) && !laterEdit) return "orientation";
  if (readOnlyLead.test(normalized) && !laterEdit) return "orientation";
  if (readOnlyRequestHead.test(normalized) && !laterEdit) return "orientation";
  const passiveTask = normalized.replace(/(?:\.\/)?(?:[a-z0-9_@.-]+\/)*[a-z0-9_@.-]+\.[a-z0-9]+/gu, "target");
  return mutationHead.test(normalized) || collaborativeMutationHead.test(normalized) || passiveMutation.test(passiveTask)
    || modalSubjectPassiveMutation.test(passiveTask) || requiredSubjectPassiveMutation.test(passiveTask)
    || (!/\?\s*$/u.test(normalized) && activeDeclarativeMutation.test(passiveTask))
    || nominalMutation.test(passiveTask) || laterEdit ? "edit" : "orientation";
}

function unwrapControlledDirective(task: string): string | undefined {
  const patterns = [
    /^use\b[\s\S]{0,180}\bto\s+([\s\S]+)$/u,
    /^(?:try(?:ing)?|attempt(?:ing)?|start(?:ing)?|begin(?:ning)?)(?:\s+to)?\s+([\s\S]+)$/u,
    /^(?:keep|go\s+ahead\s+(?:to|with)|(?:i|we)\s+need\s+help\s+with)\s+([\s\S]+)$/u
  ];
  for (const pattern of patterns) {
    const directive = task.match(pattern)?.[1]?.trim();
    if (directive && directive !== task) return directive;
  }
  return undefined;
}

function hasLaterEditDirective(task: string): boolean {
  const match = laterEditVerb.exec(task);
  if (!match) return false;
  if (/^\s*and\b/u.test(match[0]) && /\bhow\s+to\b/u.test(task.slice(0, match.index))) return false;
  const directive = task.slice(match.index).replace(/^(?:[.,;:]|\n|\band\b|\bthen\b|\bbefore\b)\s*(?:please\s+)?/u, "");
  const readOnlyHead = readOnlyLead.test(task) || readOnlyRequestHead.test(task) || readOnlyArtifactHead.test(task) || readOnlyIdiomHead.test(task);
  if (readOnlyHead && /^\s*and\b/u.test(match[0]) && /^[a-z]+ing\b/u.test(directive)) return false;
  if (readOnlyArtifactHead.test(directive) || readOnlyIdiomHead.test(directive)) return hasLaterEditDirective(directive);
  const suffix = task.slice(match.index + match[0].length);
  return !/^\s+(?:alternatives?|approaches?|history|ideas?|options?|patterns?|planning|plans?|status|strategies|strategy)\b/u.test(suffix);
}
