import { isRecord, stringValue } from "./compaction-helpers.js";

/** Bounded, trusted skill/playbook guidance retained by concise task context. */
export function skillGuidanceKernel(data: Record<string, unknown>): Record<string, unknown> | undefined {
  const skillHints = isRecord(data.skillHints) ? data.skillHints : undefined;
  const skills = Array.isArray(skillHints?.applicableSkills) ? skillHints.applicableSkills : [];
  const playbooks = Array.isArray(data.targetPlaybooks)
    ? data.targetPlaybooks
    : Array.isArray(skillHints?.targetPlaybooks)
      ? skillHints.targetPlaybooks
      : [];
  return definedRecord({
    skillCount: skills.length,
    skills: skills.slice(0, 4).map(guidanceEntry),
    playbookCount: playbooks.length,
    playbooks: playbooks.slice(0, 4).map(guidanceEntry)
  });
}

export function terminalGuidanceKernel(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  const skills = Array.isArray(value.skills) ? value.skills : [];
  const playbooks = Array.isArray(value.playbooks) ? value.playbooks : [];
  return definedRecord({
    skillCount: typeof value.skillCount === "number" ? value.skillCount : skills.length,
    skills: skills.slice(0, 1).map(guidanceEntry),
    playbookCount: typeof value.playbookCount === "number" ? value.playbookCount : playbooks.length,
    playbooks: playbooks.slice(0, 1).map(guidanceEntry)
  });
}

export function renderKernelGuidance(value: Record<string, unknown>): string | undefined {
  const skills = Array.isArray(value.skills) ? value.skills.filter(isRecord) : [];
  const playbooks = Array.isArray(value.playbooks) ? value.playbooks.filter(isRecord) : [];
  const skillCount = typeof value.skillCount === "number" ? value.skillCount : skills.length;
  const playbookCount = typeof value.playbookCount === "number" ? value.playbookCount : playbooks.length;
  if (skillCount === 0 && playbookCount === 0) return undefined;
  const renderedSkills = skills.slice(0, 2).map((entry) => {
    const name = stringValue(entry.name) ?? "unknown";
    const matchedGlob = stringValue(entry.matchedGlob);
    const matchedPath = stringValue(entry.matchedPath);
    return `skill ${name}${matchedGlob && matchedPath ? `: ${matchedGlob} matched ${matchedPath}` : ""}`;
  });
  const renderedPlaybooks = playbooks.slice(0, 2).map((entry) => {
    const module = stringValue(entry.module) ?? stringValue(entry.name) ?? "unknown";
    const uri = stringValue(entry.uri) ?? stringValue(entry.path) ?? "resource unavailable";
    return `playbook ${module}: ${uri}`;
  });
  const renderedCount = renderedSkills.length + renderedPlaybooks.length;
  const omitted = Math.max(0, skillCount + playbookCount - renderedCount);
  return bounded(`Skill and playbook hints: ${[...renderedSkills, ...renderedPlaybooks].join(" | ") || "details required"}${omitted > 0 ? ` | +${omitted} more` : ""}`, 500);
}

function guidanceEntry(value: unknown): unknown {
  if (!isRecord(value)) return value;
  return definedRecord({
    name: bounded(stringValue(value.name), 160),
    module: bounded(stringValue(value.module), 160),
    uri: bounded(stringValue(value.uri), 260),
    path: bounded(stringValue(value.path), 220),
    skillPath: bounded(stringValue(value.skillPath), 220),
    matchedGlob: bounded(stringValue(value.matchedGlob), 180),
    matchedPath: bounded(stringValue(value.matchedPath), 220)
  });
}

function bounded(value: string | undefined, limit: number): string | undefined {
  if (!value) return undefined;
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}

function definedRecord(value: Record<string, unknown>): Record<string, unknown> | undefined {
  const filtered = Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined && (!Array.isArray(entry) || entry.length > 0)));
  return Object.keys(filtered).length > 0 ? filtered : undefined;
}
