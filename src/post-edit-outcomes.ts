import { promises as fs } from "node:fs";
import path from "node:path";
import type { Confidence, FreshnessInfo, TestRecommendation } from "./types.js";
import { stableId } from "./util.js";

const OUTCOME_DIR = ".codex/cache/codexa-outcomes";
const LATEST_FILE = "latest.json";

export type PostEditVerdict = "continue" | "run_tests" | "inspect" | "replan";

export interface PostEditOutcomeInput {
  repoRoot: string;
  task: string;
  taskId?: string;
  snapshotPath?: string;
  verdict: PostEditVerdict;
  freshness: FreshnessInfo;
  changedFiles: string[];
  plannedEditTargets: string[];
  reviewTargets: string[];
  unplannedEditedFiles: string[];
  unindexedEditedFiles: string[];
  driftReasons: string[];
  tests: TestRecommendation[];
  testsNotRun: TestRecommendation[];
  ranTests: string[];
  quality?: { level?: unknown; counts?: unknown };
  confidence?: {
    authoritative: number;
    derived: number;
    heuristic: number;
    fallback: number;
  };
}

export interface PostEditOutcome {
  schemaVersion: 1;
  outcomeId: string;
  createdAt: string;
  repoRoot: string;
  task: string;
  taskId?: string;
  snapshotPath?: string;
  verdict: PostEditVerdict;
  headCommit: string | null;
  indexSnapshotId: string;
  changedFiles: string[];
  plannedEditTargets: string[];
  reviewTargets: string[];
  unplannedEditedFiles: string[];
  unindexedEditedFiles: string[];
  driftReasons: string[];
  recommendedTests: Array<Pick<TestRecommendation, "path" | "reason" | "rank" | "evidenceTier" | "command" | "commandSource" | "commandConfidence">>;
  testsNotRun: Array<Pick<TestRecommendation, "path" | "reason" | "rank" | "evidenceTier" | "command" | "commandSource" | "commandConfidence">>;
  ranTests: string[];
  qualityLevel?: string;
  confidence?: Record<Confidence | "fallback", number>;
  calibrationLabels: string[];
}

export async function savePostEditOutcome(input: PostEditOutcomeInput): Promise<{ outcome: PostEditOutcome; path: string; relativePath: string }> {
  const repoRoot = path.resolve(input.repoRoot);
  const createdAt = new Date().toISOString();
  const outcomeId = stableOutcomeId(repoRoot, input, createdAt);
  const outcome: PostEditOutcome = {
    schemaVersion: 1,
    outcomeId,
    createdAt,
    repoRoot,
    task: input.task,
    taskId: input.taskId,
    snapshotPath: input.snapshotPath,
    verdict: input.verdict,
    headCommit: input.freshness.headCommit,
    indexSnapshotId: input.freshness.snapshotId,
    changedFiles: input.changedFiles,
    plannedEditTargets: input.plannedEditTargets,
    reviewTargets: input.reviewTargets,
    unplannedEditedFiles: input.unplannedEditedFiles,
    unindexedEditedFiles: input.unindexedEditedFiles,
    driftReasons: input.driftReasons,
    recommendedTests: compactTests(input.tests),
    testsNotRun: compactTests(input.testsNotRun),
    ranTests: input.ranTests,
    qualityLevel: typeof input.quality?.level === "string" ? input.quality.level : undefined,
    confidence: input.confidence,
    calibrationLabels: calibrationLabels(input)
  };
  const dir = path.join(repoRoot, OUTCOME_DIR);
  await fs.mkdir(dir, { recursive: true });
  const outcomePath = path.join(dir, `${outcomeId}.json`);
  await atomicJsonWrite(outcomePath, outcome);
  await atomicJsonWrite(path.join(dir, LATEST_FILE), {
    schemaVersion: 1,
    outcomeId,
    path: path.basename(outcomePath),
    createdAt,
    verdict: outcome.verdict,
    taskId: outcome.taskId
  });
  return { outcome, path: outcomePath, relativePath: path.posix.join(OUTCOME_DIR, `${outcomeId}.json`) };
}

function stableOutcomeId(repoRoot: string, input: PostEditOutcomeInput, createdAt: string): string {
  const task = (input.taskId ?? input.task).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "post-edit";
  const suffix = stableId("post-edit-outcome", repoRoot, input.taskId, input.task, input.verdict, input.changedFiles.join("\n"), createdAt);
  return `${task}-${createdAt.replace(/[-:TZ.]/g, "").slice(0, 14)}-${suffix}`.slice(0, 120);
}

function compactTests(tests: TestRecommendation[]): PostEditOutcome["recommendedTests"] {
  return tests.map((test) => ({
    path: test.path,
    reason: test.reason,
    rank: test.rank,
    evidenceTier: test.evidenceTier,
    command: test.command,
    commandSource: test.commandSource,
    commandConfidence: test.commandConfidence
  }));
}

function calibrationLabels(input: PostEditOutcomeInput): string[] {
  const labels: string[] = [];
  if (input.unplannedEditedFiles.length > 0) {
    labels.push("unplanned-edits");
  }
  if (input.testsNotRun.length > 0) {
    labels.push("missing-recommended-tests");
  }
  if (input.unindexedEditedFiles.length > 0) {
    labels.push("unindexed-edits");
  }
  if (input.quality?.level === "low") {
    labels.push("low-context-quality");
  }
  if ((input.confidence?.heuristic ?? 0) > (input.confidence?.authoritative ?? 0) + (input.confidence?.derived ?? 0)) {
    labels.push("heuristic-heavy");
  }
  if (input.verdict === "replan") {
    labels.push("requires-replan");
  } else if (input.verdict === "inspect") {
    labels.push("requires-inspection");
  }
  return [...new Set(labels)].sort();
}

async function atomicJsonWrite(filePath: string, value: unknown): Promise<void> {
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.rename(tmp, filePath);
}
