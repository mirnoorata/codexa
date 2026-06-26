import path from "node:path";
import { focusBriefQuery, testPlanQuery } from "./queries.js";
import { loadPolicyPack, type PolicyPackSummary } from "./policy-pack.js";
import { loadTaskSnapshot } from "./task-snapshots.js";
import { freshnessBanner } from "./query/runtime.js";
import { createQuerySession } from "./query/session.js";
import type {
  ChangeType,
  FreshnessInfo,
  QueryOptions,
  QueryResult,
  RefreshInfo,
  TaskSnapshot,
  TestRecommendation,
  VerificationCommandPlanEntry,
  VerificationLedgerEntry
} from "./types.js";
import { limitText, uniqueSorted } from "./util.js";

export interface ProveOptions extends QueryOptions {
  task?: string;
  diff?: boolean;
  changeType?: ChangeType;
  tokenBudget?: number;
  taskId?: string;
}

export interface ProveData {
  mode: "proof_card";
  task: string;
  repoRoot: string;
  freshness: {
    stale: boolean;
    reason: string;
    indexedAt: string;
    headCommit: string | null;
    dirtyFileCount: number;
    parserErrorCount: number;
  };
  worktree: {
    knownClean?: boolean;
    degraded?: boolean;
    dirtyFileCount?: number;
    changedFiles: string[];
    degradedReasons: string[];
  };
  readFirst: Array<{ path: string; riskScore?: number; rank?: number }>;
  snapshot: {
    status: "loaded" | "missing" | "blocked";
    taskId?: string;
    origin?: string;
    createdAt?: string;
    plannedEditTargets: string[];
    plannedTests: string[];
    reason?: string;
  };
  verification: {
    recommendedCommands: string[];
    commandPlan: VerificationCommandPlanEntry[];
    ledgerPreview: VerificationLedgerEntry[];
    tests: TestRecommendation[];
  };
  policies: PolicyPackSummary;
  gaps: string[];
  trustPosture: string[];
  nextCommands: string[];
}

interface FocusFileShape {
  path?: unknown;
  riskScore?: unknown;
  rank?: unknown;
}

interface WorktreeShape {
  knownClean?: unknown;
  degraded?: unknown;
  dirtyFileCount?: unknown;
  degradedReasons?: unknown;
}

export async function proveQuery(repoRoot: string, options: ProveOptions = {}): Promise<QueryResult> {
  const repo = path.resolve(repoRoot);
  const task = options.task?.trim() || "Codexa proof card";
  const diff = options.diff ?? true;
  const session = await createQuerySession(repo, options);
  const [focus, testPlan, snapshotLoad, policies] = await Promise.all([
    focusBriefQuery(session, { task, diff, tokenBudget: Math.min(options.tokenBudget ?? 1800, 3000), limit: 8 }, options),
    testPlanQuery(session, diff, { ...options, changeType: options.changeType ?? "unknown" }),
    loadTaskSnapshot(repo, options.taskId),
    loadPolicyPack(repo)
  ]);
  const focusData = asRecord(focus.data);
  const testData = asRecord(testPlan.data);
  const changedFiles = stringArray(testData.changedFiles);
  const worktree = worktreeFromData(focusData.worktree, changedFiles, stringArray(focusData.worktreeDegradationReasons));
  const snapshot = snapshotSummary(snapshotLoad.snapshot, {
    taskId: snapshotLoad.latestTaskId,
    reason: snapshotLoad.error ?? snapshotLoad.missingReason ?? snapshotLoad.blockedSnapshot?.reason,
    blocked: Boolean(snapshotLoad.blockedSnapshot)
  });
  const readFirst = readFirstFromFocus(focusData.focusFiles);
  const recommendedCommands = stringArray(testData.verificationCommands);
  const commandPlan = verificationCommandPlanFromData(testData.verificationCommandPlan);
  const ledgerPreview = verificationLedgerFromData(testData.verificationLedgerPreview);
  const tests = testRecommendationsFromData(testData.tests);
  const gaps = proofGaps({
    freshness: session.freshness,
    worktree,
    snapshot,
    policies,
    focusGaps: stringArray(focusData.gaps),
    testGaps: stringArray(testData.gaps)
  });
  const data: ProveData = {
    mode: "proof_card",
    task,
    repoRoot: repo,
    freshness: freshnessData(session.freshness),
    worktree,
    readFirst,
    snapshot,
    verification: {
      recommendedCommands,
      commandPlan,
      ledgerPreview,
      tests
    },
    policies,
    gaps,
    trustPosture: trustPosture(),
    nextCommands: nextCommands(repo, task, snapshot.status)
  };
  return {
    freshness: session.freshness,
    refresh: session.refresh,
    text: renderProofCard(data, session.freshness, session.refresh),
    data
  };
}

function renderProofCard(data: ProveData, freshness: FreshnessInfo, refresh: RefreshInfo | undefined): string {
  const worktreeLine = data.worktree.degraded
    ? `unknown (${data.worktree.degradedReasons.join("; ")})`
    : data.worktree.knownClean
      ? "clean"
      : `${data.worktree.dirtyFileCount ?? data.worktree.changedFiles.length} changed file(s)`;
  const lines = [
    freshnessBanner(freshness, refresh),
    "Codexa proof card",
    `Task: ${data.task}`,
    `Repo: ${data.repoRoot}`,
    `Worktree: ${worktreeLine}`,
    `Snapshot: ${formatSnapshot(data.snapshot)}`,
    "",
    "Read first:",
    ...formatReadFirst(data.readFirst),
    "",
    "Verification to earn credit:",
    ...formatCommands(data.verification.recommendedCommands),
    "",
    "Verification ledger preview:",
    ...formatLedger(data.verification.ledgerPreview),
    "",
    "Local policies:",
    ...formatPolicies(data.policies),
    "",
    "Trust posture:",
    ...data.trustPosture.map((line) => `- ${line}`),
    "",
    "Remaining proof gaps:",
    ...formatGaps(data.gaps),
    "",
    "Next commands:",
    ...data.nextCommands.map((command) => `- ${command}`)
  ];
  return limitText(lines.join("\n"), 8000);
}

function freshnessData(freshness: FreshnessInfo): ProveData["freshness"] {
  return {
    stale: freshness.stale,
    reason: freshness.reason,
    indexedAt: freshness.indexedAt,
    headCommit: freshness.headCommit,
    dirtyFileCount: freshness.dirtyFiles.length,
    parserErrorCount: freshness.parserErrorCount
  };
}

function readFirstFromFocus(value: unknown): ProveData["readFirst"] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry): ProveData["readFirst"][number] | undefined => {
      const record = entry as FocusFileShape;
      return typeof record.path === "string"
        ? {
            path: record.path,
            riskScore: typeof record.riskScore === "number" ? record.riskScore : undefined,
            rank: typeof record.rank === "number" ? record.rank : undefined
          }
        : undefined;
    })
    .filter((entry): entry is ProveData["readFirst"][number] => Boolean(entry))
    .slice(0, 8);
}

function snapshotSummary(
  snapshot: TaskSnapshot | undefined,
  fallback: { taskId?: string; reason?: string; blocked: boolean }
): ProveData["snapshot"] {
  if (snapshot) {
    return {
      status: "loaded",
      taskId: snapshot.taskId,
      origin: snapshot.origin,
      createdAt: snapshot.createdAt,
      plannedEditTargets: snapshot.plannedEditTargets.slice(0, 20),
      plannedTests: snapshot.plannedTests.map((test) => test.path).slice(0, 20)
    };
  }
  return {
    status: fallback.blocked ? "blocked" : "missing",
    taskId: fallback.taskId,
    plannedEditTargets: [],
    plannedTests: [],
    reason: fallback.reason
  };
}

function worktreeFromData(value: unknown, changedFiles: string[], fallbackDegradedReasons: string[]): ProveData["worktree"] {
  const record = asRecord(value);
  const degradedReasons = stringArray(record.degradedReasons).length > 0 ? stringArray(record.degradedReasons) : fallbackDegradedReasons;
  return {
    knownClean: typeof (record as WorktreeShape).knownClean === "boolean" ? ((record as WorktreeShape).knownClean as boolean) : changedFiles.length === 0 && degradedReasons.length === 0,
    degraded: typeof (record as WorktreeShape).degraded === "boolean" ? ((record as WorktreeShape).degraded as boolean) : degradedReasons.length > 0,
    dirtyFileCount: typeof (record as WorktreeShape).dirtyFileCount === "number" ? ((record as WorktreeShape).dirtyFileCount as number) : changedFiles.length,
    changedFiles: changedFiles.slice(0, 120),
    degradedReasons
  };
}

function verificationCommandPlanFromData(value: unknown): VerificationCommandPlanEntry[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(isVerificationCommandPlanEntry).slice(0, 30);
}

function verificationLedgerFromData(value: unknown): VerificationLedgerEntry[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(isVerificationLedgerEntry).slice(0, 30);
}

function testRecommendationsFromData(value: unknown): TestRecommendation[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(isTestRecommendation).slice(0, 30);
}

function isVerificationCommandPlanEntry(value: unknown): value is VerificationCommandPlanEntry {
  const record = asRecord(value);
  return (
    typeof record.command === "string" &&
    Array.isArray(record.covers) &&
    Array.isArray(record.targetPaths) &&
    Array.isArray(record.scopes) &&
    Array.isArray(record.sources) &&
    ["authoritative", "derived", "heuristic"].includes(String(record.confidence))
  );
}

function isVerificationLedgerEntry(value: unknown): value is VerificationLedgerEntry {
  const record = asRecord(value);
  return (
    typeof record.kind === "string" &&
    typeof record.recommended === "string" &&
    typeof record.target === "string" &&
    typeof record.status === "string" &&
    Array.isArray(record.evidence) &&
    Array.isArray(record.coverageKinds)
  );
}

function isTestRecommendation(value: unknown): value is TestRecommendation {
  const record = asRecord(value);
  return typeof record.path === "string" && typeof record.reason === "string" && typeof record.rank === "number";
}

function proofGaps(input: {
  freshness: FreshnessInfo;
  worktree: ProveData["worktree"];
  snapshot: ProveData["snapshot"];
  policies: PolicyPackSummary;
  focusGaps: string[];
  testGaps: string[];
}): string[] {
  return uniqueSorted([
    ...(input.freshness.stale ? [`index stale: ${input.freshness.reason}`] : []),
    ...(input.worktree.degraded ? input.worktree.degradedReasons.map((reason) => `worktree state unavailable: ${reason}`) : []),
    ...(input.snapshot.status === "missing" ? [`no saved change-plan snapshot${input.snapshot.reason ? `: ${input.snapshot.reason}` : ""}`] : []),
    ...(input.snapshot.status === "blocked" ? [`latest change-plan snapshot blocked${input.snapshot.reason ? `: ${input.snapshot.reason}` : ""}`] : []),
    ...(input.policies.missing.length > 0 ? [`policy pack missing: ${input.policies.missing.join(", ")}`] : []),
    ...input.policies.warnings,
    ...input.focusGaps,
    ...input.testGaps
  ]);
}

function trustPosture(): string[] {
  return [
    "core proof paths are local and model-free; optional semantic lanes remain explicit opt-ins",
    "Codexa MCP tools are context and review tools, not source-mutating edit tools",
    "reported commands earn verification credit only through the shared command classifier",
    "repository policy text is bounded local evidence, not executable code"
  ];
}

function nextCommands(repo: string, task: string, snapshotStatus: ProveData["snapshot"]["status"]): string[] {
  const quotedTask = shellQuote(task);
  return [
    snapshotStatus === "loaded"
      ? `codexa post-edit-review ${shellQuote(repo)} --task ${quotedTask} --ran-command "<command-you-ran>"`
      : `codexa change-plan ${shellQuote(repo)} --task ${quotedTask} --save-snapshot`,
    `codexa test-plan ${shellQuote(repo)} --diff`,
    `codexa prove ${shellQuote(repo)} --task ${quotedTask} --diff`
  ];
}

function formatSnapshot(snapshot: ProveData["snapshot"]): string {
  if (snapshot.status === "loaded") {
    const origin = snapshot.origin ? `; ${snapshot.origin}` : "";
    const created = snapshot.createdAt ? `; ${snapshot.createdAt}` : "";
    return `loaded ${snapshot.taskId ?? "latest"}${origin}${created}`;
  }
  return `${snapshot.status}${snapshot.reason ? ` (${snapshot.reason})` : ""}`;
}

function formatReadFirst(files: ProveData["readFirst"]): string[] {
  if (files.length === 0) {
    return ["- none selected"];
  }
  return files.map((file) => {
    const rank = file.rank === undefined ? "" : `; rank ${file.rank.toFixed(2)}`;
    const risk = file.riskScore === undefined ? "" : `; risk ${file.riskScore.toFixed(1)}`;
    return `- ${file.path}${rank}${risk}`;
  });
}

function formatCommands(commands: string[]): string[] {
  if (commands.length === 0) {
    return ["- none inferred; run codexa test-plan after choosing an edit target"];
  }
  return commands.slice(0, 12).map((command) => `- ${command}`);
}

function formatLedger(ledger: VerificationLedgerEntry[]): string[] {
  if (ledger.length === 0) {
    return ["- none yet; report actual commands to post-edit-review after running them"];
  }
  return ledger.slice(0, 12).map((entry) => {
    const command = entry.command ? `; command ${entry.command}` : "";
    return `- ${entry.status}: ${entry.kind} ${entry.target}${command}`;
  });
}

function formatPolicies(policies: PolicyPackSummary): string[] {
  const lines = policies.policies.flatMap((policy) => [
    `- ${policy.kind}: ${policy.purpose}`,
    ...policy.rules.slice(0, 3).map((rule) => `  - ${rule}`)
  ]);
  if (policies.missing.length > 0) {
    lines.push(`- missing policy files: ${policies.missing.map((kind) => `${kind}.json`).join(", ")}; run codexa policy-init <repo>`);
  }
  if (policies.warnings.length > 0) {
    lines.push(...policies.warnings.map((warning) => `- warning: ${warning}`));
  }
  return lines.length > 0 ? lines : ["- no local policy pack present; run codexa policy-init <repo>"];
}

function formatGaps(gaps: string[]): string[] {
  return gaps.length > 0 ? gaps.slice(0, 20).map((gap) => `- ${gap}`) : ["- none detected in the proof card inputs"];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}
