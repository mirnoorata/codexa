import type { ChangedFileEntry, ComplexityReviewData, ComplexityReviewItem, TestRecommendation } from "../types.js";
import { uniqueSorted } from "../util.js";

const DEFAULT_INVARIANTS = [
  "Do not cut trust-boundary validation, data-loss handling, security, accessibility, or explicit user requirements.",
  "Prefer deletion or a narrow local edit before adding a new abstraction.",
  "Prefer standard library, native platform features, and already-installed dependencies before adding code.",
  "Non-trivial logic still needs the smallest runnable check that would fail if it breaks."
];

const MANIFEST_PATH_RE = /(^|\/)(package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb|pyproject\.toml|requirements(?:-[^/]+)?\.txt|poetry\.lock|uv\.lock|go\.mod|go\.sum|Cargo\.toml|Cargo\.lock)$/u;
const ABSTRACTION_PATH_RE = /(^|[-_/])(abstract|adapter|factory|manager|registry|interface)([-_.\/]|$)/iu;

interface PlanComplexityInput {
  editReadiness: {
    editable: boolean;
    status: string;
    source: string;
    reason: string;
    explicitTargetProvided: boolean;
  };
  plannedEditTargets: string[];
  plannedTests: TestRecommendation[];
  requiredWorkflowChecks: unknown[];
  requiredDependencyChecks: unknown[];
}

interface PostEditComplexityInput {
  changedSinceSnapshot: ChangedFileEntry[];
  unplannedEditedFiles: string[];
  plannedScope: string[];
  testsNotRun: TestRecommendation[];
  noVerificationProofForEditedFiles: boolean;
  hasActualEditedFiles: boolean;
}

export function buildPlanComplexityReview(input: PlanComplexityInput): ComplexityReviewData {
  const items: ComplexityReviewItem[] = [];
  if (!input.editReadiness.editable) {
    items.push({
      kind: "yagni",
      severity: "review",
      message: "Do not edit from this orientation-only packet; narrow to an explicit file or symbol first.",
      rationale: input.editReadiness.reason
    });
  }

  const manifestTargets = manifestPaths(input.plannedEditTargets);
  if (manifestTargets.length > 0) {
    items.push({
      kind: "existing-dependency",
      severity: "review",
      message: "Package or dependency manifests are in scope; justify the change against stdlib, native, or already-installed alternatives.",
      paths: manifestTargets,
      rationale: "Manifest edits are a common source of avoidable dependency and maintenance cost."
    });
  }

  if (input.plannedEditTargets.length > 6) {
    items.push({
      kind: "scope",
      severity: "watch",
      message: `Planned edit scope spans ${input.plannedEditTargets.length} files; split it unless the task truly crosses that boundary.`,
      paths: input.plannedEditTargets.slice(0, 8),
      rationale: "Broad planned scopes make speculative scaffolding and unrelated edits more likely."
    });
  }

  const plannedVerificationCount = input.plannedTests.length + input.requiredWorkflowChecks.length + input.requiredDependencyChecks.length;
  if (input.editReadiness.editable && plannedVerificationCount === 0) {
    items.push({
      kind: "verification",
      severity: "review",
      message: "No runnable check is planned; non-trivial logic needs one smallest relevant check.",
      rationale: "Minimal code without proof is unfinished, not lean."
    });
  }

  return review("plan", items);
}

export function buildPostEditComplexityReview(input: PostEditComplexityInput): ComplexityReviewData {
  const items: ComplexityReviewItem[] = [];
  const changedPaths = input.changedSinceSnapshot.map((entry) => entry.path);
  const manifestChanges = manifestPaths(changedPaths);
  if (manifestChanges.length > 0) {
    items.push({
      kind: "existing-dependency",
      severity: "review",
      message: "Package or dependency manifests changed; verify this was necessary instead of using existing platform or dependency surface.",
      paths: manifestChanges,
      rationale: "The dirty tree proves only that manifests changed, so this remains a dependency/change review signal."
    });
  }

  const unplannedNewFiles = input.changedSinceSnapshot
    .filter((entry) => input.unplannedEditedFiles.includes(entry.path))
    .filter((entry) => entry.kind === "added" || entry.kind === "untracked")
    .map((entry) => entry.path);
  if (unplannedNewFiles.length > 0) {
    items.push({
      kind: "scope",
      severity: "review",
      message: "New files appeared outside the saved planned scope; confirm they are required before keeping them.",
      paths: unplannedNewFiles,
      rationale: "Unplanned new files are where speculative scaffolding usually enters."
    });
  }

  const abstractionFiles = input.changedSinceSnapshot
    .filter((entry) => entry.kind === "added" || entry.kind === "untracked")
    .map((entry) => entry.path)
    .filter((filePath) => ABSTRACTION_PATH_RE.test(filePath));
  if (abstractionFiles.length > 0) {
    items.push({
      kind: "abstraction",
      severity: "watch",
      message: "New abstraction-shaped files appeared; keep them only if there is more than one real caller or implementation.",
      paths: abstractionFiles,
      rationale: "One-implementation interfaces, managers, registries, and adapters often add ownership without reducing complexity."
    });
  }

  const broadThreshold = input.plannedScope.length > 0 ? Math.max(8, input.plannedScope.length + 3) : 8;
  if (input.changedSinceSnapshot.length > broadThreshold) {
    items.push({
      kind: "scope",
      severity: "watch",
      message: `Dirty scope spans ${input.changedSinceSnapshot.length} files since the snapshot; check for unrelated edits before finalizing.`,
      paths: changedPaths.slice(0, 8),
      rationale: "Large dirty fanout is a practical over-build signal even when every file is individually plausible."
    });
  }

  if (input.hasActualEditedFiles && input.noVerificationProofForEditedFiles) {
    items.push({
      kind: "verification",
      severity: "review",
      message: "Edited files have no credible verification evidence; smaller code still needs one runnable check.",
      rationale: "This mirrors the post-edit verification gate as a minimality invariant."
    });
  } else if (input.testsNotRun.length > 0) {
    items.push({
      kind: "verification",
      severity: "watch",
      message: "Recommended tests are still unaccounted for; do not use minimality as a reason to skip them.",
      paths: input.testsNotRun.map((test) => test.path).slice(0, 8),
      rationale: "The leanest acceptable proof is the smallest relevant check, not no check."
    });
  }

  return review("post-edit", items);
}

export function formatComplexityReview(reviewData: ComplexityReviewData): string[] {
  const lines = ["Complexity review:", `- ${reviewData.summary}`];
  if (reviewData.items.length === 0) {
    lines.push("- Lean already: no dependency, abstraction, scope, or verification complexity signal fired.");
  } else {
    for (const item of reviewData.items.slice(0, 8)) {
      const paths = item.paths && item.paths.length > 0 ? ` [${item.paths.slice(0, 4).join(", ")}${item.paths.length > 4 ? "; ..." : ""}]` : "";
      const replacement = item.replacement ? ` Replace with: ${item.replacement}.` : "";
      lines.push(`- ${item.kind}/${item.severity}: ${item.message}${paths} ${item.rationale}.${replacement}`.trim());
    }
  }
  lines.push("Invariants:");
  lines.push(...reviewData.invariants.slice(0, 4).map((invariant) => `- ${invariant}`));
  return lines;
}

export function compactComplexityReview(value: unknown, itemLimit = 8): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  const record = value as Partial<ComplexityReviewData>;
  const priorTruncation = complexityTruncation(record);
  const items = Array.isArray(record.items) ? record.items.slice(0, itemLimit).map(compactComplexityItem) : [];
  const invariants = Array.isArray(record.invariants) ? record.invariants.filter((entry): entry is string => typeof entry === "string").slice(0, 6) : [];
  const truncation: Record<string, { total: number; returned: number }> = { ...priorTruncation };
  if (Array.isArray(record.items) && record.items.length > itemLimit) {
    truncation.items = { total: priorTruncation.items?.total ?? record.items.length, returned: itemLimit };
  }
  if (Array.isArray(record.invariants) && record.invariants.length > 6) {
    truncation.invariants = { total: priorTruncation.invariants?.total ?? record.invariants.length, returned: 6 };
  }
  return {
    schemaVersion: record.schemaVersion,
    phase: record.phase,
    status: record.status,
    blocking: record.blocking,
    summary: record.summary,
    items,
    invariants,
    truncation: Object.keys(truncation).length > 0 ? truncation : undefined
  };
}

function review(phase: ComplexityReviewData["phase"], rawItems: ComplexityReviewItem[]): ComplexityReviewData {
  const items = dedupeItems(rawItems).slice(0, 8);
  const status = items.some((item) => item.severity === "review" || item.severity === "watch") ? "review" : "lean";
  const summary =
    status === "lean"
      ? "Lean already: no deterministic over-build signal fired; still prefer deletion, reuse, and native surface before adding code."
      : `${items.length} complexity signal(s) need review; keep this advisory and preserve safety and verification.`;
  return {
    schemaVersion: 1,
    phase,
    status,
    blocking: false,
    summary,
    items,
    invariants: DEFAULT_INVARIANTS
  };
}

function manifestPaths(paths: string[]): string[] {
  return uniqueSorted(paths.filter((filePath) => MANIFEST_PATH_RE.test(filePath)));
}

function dedupeItems(items: ComplexityReviewItem[]): ComplexityReviewItem[] {
  const seen = new Set<string>();
  const result: ComplexityReviewItem[] = [];
  for (const item of items) {
    const key = [item.kind, item.severity, item.message, item.paths?.join("\0") ?? ""].join("\0");
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push({
      ...item,
      paths: item.paths ? uniqueSorted(item.paths).slice(0, 12) : undefined
    });
  }
  return result;
}

function compactComplexityItem(item: unknown): unknown {
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    return item;
  }
  const record = item as Partial<ComplexityReviewItem>;
  return {
    kind: record.kind,
    severity: record.severity,
    message: record.message,
    paths: Array.isArray(record.paths) ? record.paths.slice(0, 8) : undefined,
    replacement: record.replacement,
    rationale: record.rationale
  };
}

function complexityTruncation(record: Partial<ComplexityReviewData>): Record<string, { total: number; returned: number }> {
  const truncation = (record as { truncation?: unknown }).truncation;
  if (!truncation || typeof truncation !== "object" || Array.isArray(truncation)) {
    return {};
  }
  const result: Record<string, { total: number; returned: number }> = {};
  for (const [key, value] of Object.entries(truncation)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      continue;
    }
    const maybeEntry = value as { total?: unknown; returned?: unknown };
    if (typeof maybeEntry.total === "number" && typeof maybeEntry.returned === "number") {
      result[key] = { total: maybeEntry.total, returned: maybeEntry.returned };
    }
  }
  return result;
}
