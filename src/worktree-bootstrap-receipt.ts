import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { runCommand } from "./command.js";
import {
  assertSafeManagedStateDirectory,
  isGitTrackedAsync
} from "./init-portability.js";
import {
  currentAdoptionReceiptFacts,
  currentAdoptionReceiptSnapshot,
  readBoundedStableRegularFileWithSnapshot,
  STARTUP_INPUT_MAX_BYTES,
  type WorktreeBootstrapAdoptionFacts,
  type WorktreeBootstrapAdoptionSnapshot
} from "./worktree-bootstrap-adoption.js";
import {
  worktreeBootstrapBuildInputDigest,
  worktreeBootstrapBuildInputSnapshot
} from "./worktree-bootstrap-build-input.js";
import { dependencyCheckFailure } from "./worktree-bootstrap-dependency-check.js";
import {
  expectedCodexaHookState,
  inspectHookLaneContract,
  lanePlatformMismatch
} from "./worktree-bootstrap-hook-contract.js";
import {
  isWorktreeBootstrapReceiptRequired,
  publishWorktreeReceiptRef,
  readWorktreeReceiptRef,
  WORKTREE_BOOTSTRAP_RECEIPT_REF
} from "./worktree-bootstrap-receipt-ref.js";
import { parseBootstrapInputNames } from "./worktree-bootstrap-startup-inputs.js";
import {
  adoptionDeadlineExpired,
  adoptionValidationDeadlineAt,
  withAdoptionCommandBudget
} from "./worktree-bootstrap-validation-budget.js";
import { sessionStartDeadlineAt } from "./session-start-budget.js";
import {
  revalidateStableTreeEntries,
  type StableDirectoryBudget,
  type StableTreeEntrySnapshot
} from "./stable-directory-snapshot.js";

export { isWorktreeBootstrapReceiptRequired, WORKTREE_BOOTSTRAP_RECEIPT_REF };
export const WORKTREE_BOOTSTRAP_DEPENDENCY_SEAL_RELATIVE_PATH = "node_modules/.codexa-dependencies.json";
const DEPENDENCY_MAX_ENTRIES = 100_000;
const DEPENDENCY_MAX_LOGICAL_BYTES = 2 * 1024 * 1024 * 1024;
const STARTUP_SCAN_TIMEOUT_MS = 5_000;
const STARTUP_SCAN_MAX_FILES = 128;
const STARTUP_SCAN_MAX_LOGICAL_BYTES = 64 * 1024 * 1024;

interface InputScanBudget extends StableDirectoryBudget {
  deadlineAt: number;
  fileCount: number;
  logicalBytes: number;
  maxFiles: number;
  maxLogicalBytes: number;
  rootDev?: number;
  rootIno?: number;
  rootReal?: string;
}

export type WorktreeBootstrapLane = "posix-hooks" | "native-windows-mcp";
export type WorktreeBootstrapValidation = "startup" | "adoption" | "full";
export type WorktreeBootstrapSetupState =
  | "not-required"
  | "missing"
  | "verified"
  | "stale"
  | "invalid"
  | "not-selected"
  | "unavailable";

export interface WorktreeBootstrapReceipt {
  schemaVersion: 2;
  kind: "codexa-worktree-bootstrap";
  status: "setup-complete";
  lane: WorktreeBootstrapLane;
  codexaHooks: "enabled" | "disabled";
  repoRoot: string;
  gitCommonDir: string;
  head: string;
  rootLockSha256: string;
  packageJsonSha256: string;
  packageLockSha256: string;
  startupInputSha256: string;
  buildInputSha256: string;
  distCliSha256: string;
  distRuntimeSha256: string;
  configSha256: string;
  hooksSha256: string;
  dependencySealSha256: string;
  dependencyInventory: {
    sha256: string;
    count: number;
    fileCount: number;
    logicalBytes: number;
  };
  runtime: {
    nodePath: string;
    nodeVersion: string;
    nodeModulesAbi: string;
    platform: NodeJS.Platform;
    arch: string;
  };
  toolProfile: "core";
  threadMcp: "unverified";
  generatedAt: string;
}

export interface WorktreeBootstrapInspection {
  state: WorktreeBootstrapSetupState;
  lane?: WorktreeBootstrapLane;
  reason?: string;
  validation?: WorktreeBootstrapValidation;
  receipt?: WorktreeBootstrapReceipt;
}

type WorktreeBootstrapStartupFacts = Pick<
  WorktreeBootstrapReceipt,
  | "repoRoot"
  | "gitCommonDir"
  | "rootLockSha256"
  | "packageJsonSha256"
  | "packageLockSha256"
  | "startupInputSha256"
  | "configSha256"
  | "hooksSha256"
  | "dependencySealSha256"
  | "runtime"
  | "toolProfile"
  | "threadMcp"
>;

type WorktreeBootstrapCompletionFacts = Pick<
  WorktreeBootstrapReceipt,
  "head" | "buildInputSha256"
>;

interface WorktreeBootstrapCompletionSnapshot {
  facts: WorktreeBootstrapCompletionFacts;
  revalidate(): Promise<void>;
}

interface WorktreeBootstrapStartupSnapshot {
  facts: WorktreeBootstrapStartupFacts;
  hookInputs: { configContents: Buffer; hooksContents: Buffer | null; hooksTracked: boolean };
}

export function parseWorktreeBootstrapLane(value: string): WorktreeBootstrapLane {
  if (value === "posix-hooks" || value === "native-windows-mcp") return value;
  throw new Error("worktree receipt lane must be posix-hooks or native-windows-mcp");
}

export async function worktreeBootstrapBuildInputSha256(repoRoot: string): Promise<string> {
  return worktreeBootstrapBuildInputDigest(path.resolve(repoRoot));
}

export async function worktreeBootstrapStartupInputSha256(repoRoot: string): Promise<string> {
  return hashStartupInputs(path.resolve(repoRoot));
}

async function runNpmLs(repoRoot: string): Promise<Awaited<ReturnType<typeof runCommand>>> {
  const options = {
    cwd: repoRoot,
    discardStdout: true,
    killProcessGroup: true,
    timeoutMs: 60_000,
    maxBufferBytes: 1024 * 1024
  };
  if (process.platform !== "win32") {
    return runCommand("npm", ["ls", "--all", "--silent"], options);
  }
  const commandInterpreter = process.env.ComSpec?.trim() || process.env.COMSPEC?.trim() || "cmd.exe";
  return runCommand(
    commandInterpreter,
    ["/d", "/s", "/c", "npm.cmd ls --all --silent"],
    options
  );
}

export async function issueWorktreeBootstrapReceipt(
  repoRoot: string,
  lane: WorktreeBootstrapLane,
  expectedBuildInputSha256: string,
  expectedStartupInputSha256: string
): Promise<WorktreeBootstrapReceipt> {
  const repo = path.resolve(repoRoot);
  if (!isSha256(expectedBuildInputSha256)) {
    throw new Error("Cannot issue Codexa worktree receipt: expected build input must be a SHA-256 digest");
  }
  if (!isSha256(expectedStartupInputSha256)) {
    throw new Error("Cannot issue Codexa worktree receipt: expected startup input must be a SHA-256 digest");
  }
  const platformReason = lanePlatformMismatch(lane, process.platform);
  if (platformReason) throw new Error(`Cannot issue Codexa worktree receipt: ${platformReason}`);
  const dependencyCheck = await runNpmLs(repo);
  if (!dependencyCheck.ok) {
    throw new Error(`Cannot issue Codexa worktree receipt: ${dependencyCheckFailure(
      dependencyCheck,
      "npm-dependency-tree-incomplete"
    )}`);
  }
  const startup = await currentStartupReceiptSnapshot(repo);
  const hookContract = inspectHookLaneContract(repo, lane, startup);
  if (!hookContract.ok) {
    throw new Error(`Cannot issue Codexa worktree receipt: ${hookContract.reason}`);
  }
  const receipt = await currentReceiptFacts(repo, lane, startup.facts);
  if (receipt.startupInputSha256 !== expectedStartupInputSha256) {
    throw new Error("Cannot issue Codexa worktree receipt: startup-input-changed-during-bootstrap");
  }
  if (receipt.buildInputSha256 !== expectedBuildInputSha256) {
    throw new Error("Cannot issue Codexa worktree receipt: build-input-changed-during-bootstrap");
  }
  const finalDependencyCheck = await runNpmLs(repo);
  if (!finalDependencyCheck.ok) {
    throw new Error(`Cannot issue Codexa worktree receipt: ${dependencyCheckFailure(
      finalDependencyCheck,
      "dependency-tree-changed-during-capture"
    )}`);
  }
  await publishWorktreeReceiptRef(repo, `${JSON.stringify(receipt, null, 2)}\n`);
  const inspection = await inspectWorktreeBootstrapReceipt(repo, { validation: "full" });
  if (inspection.state !== "verified" || inspection.validation !== "full") {
    throw new Error(`Codexa worktree receipt failed immediate validation: ${inspection.reason ?? inspection.state}`);
  }
  return receipt;
}

export async function validateWorktreeBootstrapReceipt(
  repoRoot: string,
  receipt: WorktreeBootstrapReceipt,
  validation: WorktreeBootstrapValidation = "full",
  requestedAdoptionDeadlineAt?: number
): Promise<WorktreeBootstrapInspection> {
  const aggregateDeadlineAt = adoptionValidationDeadlineAt(
    validation,
    requestedAdoptionDeadlineAt
  );
  const validate = () => validateWorktreeBootstrapReceiptWithinDeadline(
    repoRoot,
    receipt,
    validation,
    aggregateDeadlineAt
  );
  if (aggregateDeadlineAt === undefined) return validate();
  return withAdoptionCommandBudget(aggregateDeadlineAt, validate);
}

async function validateWorktreeBootstrapReceiptWithinDeadline(
  repoRoot: string,
  receipt: WorktreeBootstrapReceipt,
  validation: WorktreeBootstrapValidation,
  aggregateDeadlineAt?: number
): Promise<WorktreeBootstrapInspection> {
  let startup: WorktreeBootstrapStartupSnapshot;
  try {
    startup = await currentStartupReceiptSnapshot(repoRoot, aggregateDeadlineAt);
  } catch (error) {
    return {
      state: "unavailable",
      lane: receipt.lane,
      validation,
      reason: validationFailureReason(error, aggregateDeadlineAt)
    };
  }
  const startupMismatch = startupReceiptMismatch(path.resolve(repoRoot), receipt, startup);
  if (startupMismatch) {
    return { state: "stale", lane: receipt.lane, validation, reason: startupMismatch, receipt };
  }
  if (validation === "startup") {
    return { state: "verified", lane: receipt.lane, validation, receipt };
  }
  let completionSnapshot: WorktreeBootstrapCompletionSnapshot | undefined;
  if (validation === "full") {
    try {
      completionSnapshot = await currentCompletionReceiptSnapshot(repoRoot);
    } catch (error) {
      return { state: "unavailable", lane: receipt.lane, validation, reason: boundedReason(error), receipt };
    }
    const completionMismatch = completionReceiptMismatch(receipt, completionSnapshot.facts);
    if (completionMismatch) {
      return { state: "stale", lane: receipt.lane, validation, reason: completionMismatch, receipt };
    }
  }
  let adoptionSnapshot: WorktreeBootstrapAdoptionSnapshot;
  try {
    adoptionSnapshot = await currentAdoptionReceiptSnapshot(repoRoot, aggregateDeadlineAt);
  } catch (error) {
    return {
      state: "unavailable",
      lane: receipt.lane,
      validation,
      reason: validationFailureReason(error, aggregateDeadlineAt),
      receipt
    };
  }
  const adoption = adoptionSnapshot.facts;
  const adoptionMismatch = adoptionReceiptMismatch(receipt, adoption);
  if (adoptionMismatch) {
    return { state: "stale", lane: receipt.lane, validation, reason: adoptionMismatch, receipt };
  }
  if (validation === "adoption") {
    try {
      const finalStartup = await currentStartupReceiptSnapshot(repoRoot, aggregateDeadlineAt);
      const finalStartupMismatch = startupReceiptMismatch(path.resolve(repoRoot), receipt, finalStartup);
      return finalStartupMismatch
        ? { state: "stale", lane: receipt.lane, validation, reason: finalStartupMismatch, receipt }
        : { state: "verified", lane: receipt.lane, validation, receipt };
    } catch (error) {
      return {
        state: "unavailable",
        lane: receipt.lane,
        validation,
        reason: validationFailureReason(error, aggregateDeadlineAt),
        receipt
      };
    }
  }
  if (!completionSnapshot) {
    return { state: "unavailable", lane: receipt.lane, validation, reason: "completion-snapshot-missing", receipt };
  }
  // Capture S/C/A, then close C again after the more expensive adoption scan
  // before capturing final S. This detects cross-scope source and durable
  // startup drift without repeating the 100k-entry adoption traversal or
  // claiming a filesystem transaction.
  let finalStartup: WorktreeBootstrapStartupSnapshot;
  try {
    await completionSnapshot.revalidate();
  } catch (error) {
    const drift = snapshotRevalidationDrift(error);
    return {
      state: drift ? "stale" : "unavailable",
      lane: receipt.lane,
      validation,
      reason: drift ?? boundedReason(error),
      receipt
    };
  }
  try {
    finalStartup = await currentStartupReceiptSnapshot(repoRoot);
  } catch (error) {
    return { state: "unavailable", lane: receipt.lane, validation, reason: boundedReason(error), receipt };
  }
  const finalMismatch = startupReceiptMismatch(path.resolve(repoRoot), receipt, finalStartup);
  return finalMismatch
    ? { state: "stale", lane: receipt.lane, validation, reason: finalMismatch, receipt }
    : { state: "verified", lane: receipt.lane, validation, receipt };
}

function snapshotRevalidationDrift(
  error: unknown
): string | undefined {
  const reason = boundedReason(error);
  if (!/(?:changed-during|repository-changed)/u.test(reason)) return undefined;
  return reason.startsWith("git-head-") ? "head-drift" : "build-input-drift";
}

function startupReceiptMismatch(
  repoRoot: string,
  receipt: WorktreeBootstrapReceipt,
  startup: WorktreeBootstrapStartupSnapshot
): string | undefined {
  const current = startup.facts;
  const comparisons: Array<[boolean, string]> = [
    [receipt.repoRoot === current.repoRoot, "worktree-identity-drift"],
    [receipt.gitCommonDir === current.gitCommonDir, "git-identity-drift"],
    [receipt.rootLockSha256 === current.rootLockSha256, "lockfile-drift"],
    [receipt.packageJsonSha256 === current.packageJsonSha256, "package-json-drift"],
    [receipt.packageLockSha256 === current.packageLockSha256, "package-lock-drift"],
    [receipt.startupInputSha256 === current.startupInputSha256, "startup-input-drift"],
    [receipt.configSha256 === current.configSha256, "config-drift"],
    [receipt.hooksSha256 === current.hooksSha256, "hooks-drift"],
    [receipt.dependencySealSha256 === current.dependencySealSha256, "dependency-seal-drift"],
    [sameRuntime(receipt.runtime, current.runtime), "runtime-drift"],
    [receipt.toolProfile === "core" && receipt.toolProfile === current.toolProfile, "tool-profile-drift"],
    [receipt.codexaHooks === expectedCodexaHookState(receipt.lane), "hook-lane-drift"],
    [receipt.threadMcp === "unverified", "thread-mcp-claim-invalid"]
  ];
  const mismatch = comparisons.find(([matches]) => !matches);
  if (mismatch) return mismatch[1];
  const platformReason = lanePlatformMismatch(receipt.lane, current.runtime.platform);
  if (platformReason) return platformReason;
  const hookContract = inspectHookLaneContract(repoRoot, receipt.lane, startup);
  return hookContract.ok ? undefined : hookContract.reason;
}

function adoptionReceiptMismatch(
  receipt: WorktreeBootstrapReceipt,
  adoption: WorktreeBootstrapAdoptionFacts
): string | undefined {
  if (receipt.distCliSha256 !== adoption.distCliSha256) return "dist-cli-drift";
  if (receipt.distRuntimeSha256 !== adoption.distRuntimeSha256) return "dist-runtime-drift";
  if (
    receipt.dependencyInventory.sha256 !== adoption.dependencyInventory.sha256 ||
    receipt.dependencyInventory.count !== adoption.dependencyInventory.count ||
    receipt.dependencyInventory.fileCount !== adoption.dependencyInventory.fileCount ||
    receipt.dependencyInventory.logicalBytes !== adoption.dependencyInventory.logicalBytes
  ) {
    return "dependency-inventory-drift";
  }
  return undefined;
}
function completionReceiptMismatch(
  receipt: WorktreeBootstrapReceipt,
  completion: WorktreeBootstrapCompletionFacts
): string | undefined {
  if (receipt.head !== completion.head) return "head-drift";
  return receipt.buildInputSha256 === completion.buildInputSha256 ? undefined : "build-input-drift";
}

export async function inspectWorktreeBootstrapReceipt(
  repoRoot: string,
  options: {
    validation?: WorktreeBootstrapValidation;
    adoptionDeadlineAt?: number;
  } = {}
): Promise<WorktreeBootstrapInspection> {
  const repo = path.resolve(repoRoot);
  const validation = options.validation ?? "full";
  const aggregateDeadlineAt = adoptionValidationDeadlineAt(
    validation,
    options.adoptionDeadlineAt
  );
  const inspect = () => inspectWorktreeBootstrapReceiptWithinDeadline(
    repo,
    validation,
    aggregateDeadlineAt
  );
  if (aggregateDeadlineAt === undefined) return inspect();
  return withAdoptionCommandBudget(aggregateDeadlineAt, inspect);
}

async function inspectWorktreeBootstrapReceiptWithinDeadline(
  repo: string,
  validation: WorktreeBootstrapValidation,
  aggregateDeadlineAt?: number
): Promise<WorktreeBootstrapInspection> {
  let required: boolean;
  try {
    required = await isWorktreeBootstrapReceiptRequired(repo);
  } catch (error) {
    return {
      state: "unavailable",
      validation,
      reason: validationFailureReason(error, aggregateDeadlineAt)
    };
  }
  if (!required) return { state: "not-required" };
  try {
    const stored = await readWorktreeReceiptRef(repo);
    if (stored.state === "missing") {
      return { state: "missing", validation, reason: "receipt-missing" };
    }
    if (stored.state === "invalid") {
      if (adoptionDeadlineExpired(aggregateDeadlineAt)) {
        return { state: "unavailable", validation, reason: "adoption-validation-timeout" };
      }
      return { state: "invalid", validation, reason: stored.reason };
    }
    const parsed = JSON.parse(stored.contents) as unknown;
    if (!isWorktreeBootstrapReceipt(parsed)) {
      return { state: "invalid", validation, reason: "receipt-schema-invalid" };
    }
    return validateWorktreeBootstrapReceipt(repo, parsed, validation, aggregateDeadlineAt);
  } catch (error) {
    if (adoptionDeadlineExpired(aggregateDeadlineAt)) {
      return { state: "unavailable", validation, reason: "adoption-validation-timeout" };
    }
    return { state: "invalid", validation, reason: boundedReason(error) };
  }
}

async function currentReceiptFacts(
  repoRoot: string,
  lane: WorktreeBootstrapLane,
  startupFacts?: WorktreeBootstrapStartupFacts
): Promise<WorktreeBootstrapReceipt> {
  const repo = path.resolve(repoRoot);
  const startup = startupFacts ?? (await currentStartupReceiptSnapshot(repo)).facts;
  const [adoption, completion] = await Promise.all([
    currentAdoptionReceiptFacts(repo),
    currentCompletionReceiptFacts(repo)
  ]);
  return {
    schemaVersion: 2,
    kind: "codexa-worktree-bootstrap",
    status: "setup-complete",
    lane,
    codexaHooks: expectedCodexaHookState(lane),
    ...startup,
    ...adoption,
    ...completion,
    generatedAt: new Date().toISOString()
  };
}

async function currentCompletionReceiptFacts(
  repoRoot: string
): Promise<WorktreeBootstrapCompletionFacts> {
  return (await currentCompletionReceiptSnapshot(repoRoot)).facts;
}

async function currentCompletionReceiptSnapshot(
  repoRoot: string
): Promise<WorktreeBootstrapCompletionSnapshot> {
  const repo = path.resolve(repoRoot);
  const readHead = async (): Promise<string> => {
    const result = await runCommand(
      "git",
      ["-C", repo, "rev-parse", "HEAD"],
      { timeoutMs: 2_500, maxBufferBytes: 64 * 1024, killProcessGroup: false }
    );
    if (!result.ok) throw new Error("git-head-unavailable");
    const value = result.stdout.trim();
    if (!/^[0-9a-f]{40,64}$/u.test(value)) throw new Error("git-head-invalid");
    return value;
  };
  const head = await readHead();
  const buildInput = await worktreeBootstrapBuildInputSnapshot(repo);
  if (await readHead() !== head) throw new Error("git-head-changed-during-build-scan");
  return {
    facts: { head, buildInputSha256: buildInput.digest },
    revalidate: async () => {
      if (await readHead() !== head) throw new Error("git-head-changed-during-build-scan");
      await buildInput.revalidate();
      if (await readHead() !== head) throw new Error("git-head-changed-during-build-scan");
    }
  };
}

async function currentStartupReceiptSnapshot(
  repoRoot: string,
  aggregateDeadlineAt?: number
): Promise<WorktreeBootstrapStartupSnapshot> {
  const repo = path.resolve(repoRoot);
  const budget = createStartupScanBudget(aggregateDeadlineAt);
  const snapshots: StableTreeEntrySnapshot[] = [];
  const missingPaths: string[] = [];
  const repoRootReal = await fs.realpath(repo);
  const gitCommonDir = await currentGitCommonDir(repo);
  await assertSafeManagedStateDirectory(repo);
  const nodePath = await fs.realpath(process.execPath);
  const packageJsonContents = await readBudgetedStableRegularFile(
    path.join(repo, "package.json"),
    STARTUP_INPUT_MAX_BYTES,
    "package-json",
    budget,
    repo,
    snapshots
  );
  const packageLockContents = await readBudgetedStableRegularFile(
    path.join(repo, "package-lock.json"),
    STARTUP_INPUT_MAX_BYTES,
    "package-lock",
    budget,
    repo,
    snapshots
  );
  const uvLockContents = await readOptionalRegularFile(
    repo,
    path.join(repo, "uv.lock"),
    budget,
    "uv-lock",
    snapshots,
    missingPaths
  );
  const configContents = await readBudgetedStableRegularFile(
    path.join(repo, ".codex", "config.toml"),
    STARTUP_INPUT_MAX_BYTES,
    "config",
    budget,
    repo,
    snapshots
  );
  const hooksContents = await readOptionalRegularFile(
    repo,
    path.join(repo, ".codex", "hooks.json"),
    budget,
    "hooks",
    snapshots,
    missingPaths
  );
  const dependencySealContents = await readBudgetedStableRegularFile(
    path.join(repo, WORKTREE_BOOTSTRAP_DEPENDENCY_SEAL_RELATIVE_PATH),
    STARTUP_INPUT_MAX_BYTES,
    "dependency-seal",
    budget,
    repo,
    snapshots
  );
  const hooksTracked = await isGitTrackedAsync(repo, ".codex/hooks.json");
  const startupInputSha256 = await hashStartupInputs(
    repo,
    budget,
    snapshots,
    missingPaths
  );
  await revalidateStartupSnapshot({
    repo,
    repoRootReal,
    gitCommonDir,
    hooksTracked,
    budget,
    snapshots,
    missingPaths
  });
  return {
    facts: {
      repoRoot: repoRootReal,
      gitCommonDir,
      rootLockSha256: hashNamedContents([["package-lock.json", packageLockContents], ["uv.lock", uvLockContents]]),
      packageJsonSha256: sha256(packageJsonContents),
      packageLockSha256: sha256(packageLockContents),
      startupInputSha256,
      configSha256: sha256(configContents),
      hooksSha256: hooksContents ? sha256(hooksContents) : "missing",
      dependencySealSha256: sha256(dependencySealContents),
      runtime: {
        nodePath,
        nodeVersion: process.version,
        nodeModulesAbi: process.versions.modules,
        platform: process.platform,
        arch: process.arch
      },
      toolProfile: "core",
      threadMcp: "unverified"
    },
    hookInputs: { configContents, hooksContents, hooksTracked }
  };
}

async function currentGitCommonDir(repoRoot: string): Promise<string> {
  const result = await runCommand(
    "git",
    ["-C", repoRoot, "rev-parse", "--path-format=absolute", "--git-common-dir"],
    { timeoutMs: 2_500, maxBufferBytes: 64 * 1024, killProcessGroup: false }
  );
  if (!result.ok) throw new Error("git-identity-unavailable");
  return fs.realpath(result.stdout.trim());
}

async function revalidateStartupSnapshot(input: {
  repo: string;
  repoRootReal: string;
  gitCommonDir: string;
  hooksTracked: boolean;
  budget: InputScanBudget;
  snapshots: StableTreeEntrySnapshot[];
  missingPaths: string[];
}): Promise<void> {
  if (await fs.realpath(input.repo) !== input.repoRootReal) {
    throw new Error("startup-input-repository-changed");
  }
  if (await currentGitCommonDir(input.repo) !== input.gitCommonDir) {
    throw new Error("git-identity-changed-during-scan");
  }
  if (await isGitTrackedAsync(input.repo, ".codex/hooks.json") !== input.hooksTracked) {
    throw new Error("hooks-tracking-changed-during-scan");
  }
  for (const missingPath of input.missingPaths) {
    await fs.lstat(missingPath).then(
      () => {
        throw new Error("startup-input-entry-changed-during-scan");
      },
      (error: unknown) => {
        if (!isNodeError(error) || error.code !== "ENOENT") throw error;
      }
    );
    assertInputScanDeadline(input.budget);
  }
  await revalidateStableTreeEntries(
    { containmentRootReal: input.repoRootReal, entries: input.snapshots },
    input.budget,
    () => assertInputScanDeadline(input.budget)
  );
}

async function hashStartupInputs(
  repoRoot: string,
  budget: InputScanBudget = createStartupScanBudget(),
  snapshots?: StableTreeEntrySnapshot[],
  missingPaths?: string[]
): Promise<string> {
  const wrapper = ".codex/worktree-bootstrap.sh";
  const declared = parseBootstrapInputNames(
    (await readBudgetedStableRegularFile(
      path.join(repoRoot, wrapper),
      STARTUP_INPUT_MAX_BYTES,
      "bootstrap-wrapper",
      budget,
      repoRoot,
      snapshots
    )).toString("utf8")
  );
  return hashNamedFiles(repoRoot, [...new Set([
    ".codex/environments/environment.toml",
    ".codex/worktree-bootstrap.ps1",
    wrapper,
    ...declared
  ])].sort(), budget, snapshots, missingPaths);
}

async function hashNamedFiles(
  repoRoot: string,
  names: string[],
  budget: InputScanBudget = createStartupScanBudget(),
  snapshots?: StableTreeEntrySnapshot[],
  missingPaths?: string[]
): Promise<string> {
  const entries: Array<readonly [string, Buffer | null]> = [];
  for (const name of names) {
    const filePath = path.join(repoRoot, name);
    try {
      const contents = await readBudgetedStableRegularFile(
        filePath,
        STARTUP_INPUT_MAX_BYTES,
        "startup-input",
        budget,
        repoRoot,
        snapshots
      );
      entries.push([name, contents]);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        entries.push([name, null]);
        missingPaths?.push(filePath);
      }
      else throw error;
    }
  }
  return hashNamedContents(entries);
}

function hashNamedContents(entries: Array<readonly [string, Buffer | null]>): string {
  const hash = createHash("sha256");
  hash.update("codexa-startup-input-v2\0", "utf8");
  for (const [name, contents] of entries) updateManifestRecord(hash, name, contents);
  return hash.digest("hex");
}

function updateManifestRecord(
  hash: ReturnType<typeof createHash>,
  name: string,
  contents: Buffer | null
): void {
  const encodedName = Buffer.from(name, "utf8");
  hash.update(`N${encodedName.length}:`, "utf8");
  hash.update(encodedName);
  if (contents === null) {
    hash.update("M:", "utf8");
    return;
  }
  hash.update(`P${contents.length}:`, "utf8");
  hash.update(contents);
}

async function readBudgetedStableRegularFile(
  filePath: string,
  maxBytes: number,
  label: string,
  budget: InputScanBudget,
  repoRoot: string,
  snapshots?: StableTreeEntrySnapshot[]
): Promise<Buffer> {
  assertInputScanDeadline(budget);
  budget.fileCount += 1;
  if (budget.fileCount > budget.maxFiles) {
    throw new Error(`${budget.label}-file-limit-exceeded`);
  }
  const read = await readBoundedStableRegularFileWithSnapshot(
    filePath,
    maxBytes,
    label,
    budget.deadlineAt,
    repoRoot
  );
  const contents = read.contents;
  snapshots?.push(read.snapshot);
  budget.logicalBytes += contents.length;
  if (budget.logicalBytes > budget.maxLogicalBytes) {
    throw new Error(`${budget.label}-byte-limit-exceeded`);
  }
  const rootReal = await fs.realpath(repoRoot);
  const root = await fs.lstat(rootReal);
  if (
    budget.rootReal && (
      budget.rootReal !== rootReal ||
      budget.rootDev !== root.dev ||
      budget.rootIno !== root.ino
    )
  ) {
    throw new Error(`${budget.label}-repository-changed`);
  }
  budget.rootReal = rootReal;
  budget.rootDev = root.dev;
  budget.rootIno = root.ino;
  const fileReal = await fs.realpath(filePath).catch((error: unknown) => {
    if (isNodeError(error) && error.code === "ENOENT") {
      throw new Error(`${label}-changed-during-read`);
    }
    throw error;
  });
  if (!isContainedPath(rootReal, fileReal)) {
    throw new Error(`${label}-outside-repository`);
  }
  assertInputScanDeadline(budget);
  return contents;
}

function createStartupScanBudget(aggregateDeadlineAt?: number): InputScanBudget {
  const budget = createInputScanBudget(
    "startup-input",
    STARTUP_SCAN_MAX_FILES,
    STARTUP_SCAN_MAX_FILES,
    STARTUP_SCAN_MAX_LOGICAL_BYTES,
    STARTUP_SCAN_TIMEOUT_MS
  );
  budget.deadlineAt = Math.min(
    budget.deadlineAt,
    aggregateDeadlineAt ?? Number.POSITIVE_INFINITY
  );
  return budget;
}

function createInputScanBudget(
  label: string,
  maxFiles: number,
  maxEntries: number,
  maxLogicalBytes: number,
  timeoutMs: number
): InputScanBudget {
  return {
    deadlineAt: sessionStartDeadlineAt(Date.now() + timeoutMs),
    fileCount: 0,
    label,
    logicalBytes: 0,
    maxEntries,
    maxFiles,
    maxLogicalBytes,
    scannedDirectoryEntries: 0,
    revalidatedDirectoryEntries: 0
  };
}

function assertInputScanDeadline(budget: InputScanBudget): void {
  if (Date.now() > budget.deadlineAt) {
    throw new Error(`${budget.label}-scan-timeout`);
  }
}

function validationFailureReason(error: unknown, deadlineAt?: number): string {
  return adoptionDeadlineExpired(deadlineAt)
    ? "adoption-validation-timeout"
    : boundedReason(error);
}

function sha256(contents: Buffer): string {
  return createHash("sha256").update(contents).digest("hex");
}

function isWorktreeBootstrapReceipt(value: unknown): value is WorktreeBootstrapReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const receipt = value as Partial<WorktreeBootstrapReceipt>;
  const runtimePlatforms = new Set<NodeJS.Platform>([
    "aix", "android", "darwin", "freebsd", "haiku", "linux", "openbsd", "sunos", "win32", "cygwin", "netbsd"
  ]);
  return (
    receipt.schemaVersion === 2 &&
    receipt.kind === "codexa-worktree-bootstrap" &&
    receipt.status === "setup-complete" &&
    (receipt.lane === "posix-hooks" || receipt.lane === "native-windows-mcp") &&
    (receipt.codexaHooks === "enabled" || receipt.codexaHooks === "disabled") &&
    isBoundedPrintable(receipt.repoRoot, 4096) &&
    path.isAbsolute(receipt.repoRoot) &&
    isBoundedPrintable(receipt.gitCommonDir, 4096) &&
    path.isAbsolute(receipt.gitCommonDir) &&
    typeof receipt.head === "string" &&
    /^[a-f0-9]{40,64}$/u.test(receipt.head) &&
    isSha256(receipt.rootLockSha256) &&
    isSha256(receipt.packageJsonSha256) &&
    isSha256(receipt.packageLockSha256) &&
    isSha256(receipt.startupInputSha256) &&
    isSha256(receipt.buildInputSha256) &&
    isSha256(receipt.distCliSha256) &&
    isSha256(receipt.distRuntimeSha256) &&
    isSha256(receipt.configSha256) &&
    (receipt.hooksSha256 === "missing" || isSha256(receipt.hooksSha256)) &&
    isSha256(receipt.dependencySealSha256) &&
    Boolean(receipt.dependencyInventory) &&
    isSha256(receipt.dependencyInventory?.sha256) &&
    Number.isSafeInteger(receipt.dependencyInventory?.count) &&
    Number(receipt.dependencyInventory?.count) >= 0 &&
    Number(receipt.dependencyInventory?.count) <= 100_000 &&
    Number.isSafeInteger(receipt.dependencyInventory?.fileCount) &&
    Number(receipt.dependencyInventory?.fileCount) >= 0 &&
    Number(receipt.dependencyInventory?.fileCount) <= DEPENDENCY_MAX_ENTRIES &&
    Number.isSafeInteger(receipt.dependencyInventory?.logicalBytes) &&
    Number(receipt.dependencyInventory?.logicalBytes) >= 0 &&
    Number(receipt.dependencyInventory?.logicalBytes) <= DEPENDENCY_MAX_LOGICAL_BYTES &&
    Boolean(receipt.runtime) &&
    isBoundedPrintable(receipt.runtime?.nodePath, 4096) &&
    path.isAbsolute(receipt.runtime?.nodePath ?? "") &&
    isBoundedPrintable(receipt.runtime?.nodeVersion, 64) &&
    isBoundedPrintable(receipt.runtime?.nodeModulesAbi, 32) &&
    runtimePlatforms.has(receipt.runtime?.platform as NodeJS.Platform) &&
    isBoundedPrintable(receipt.runtime?.arch, 32) &&
    receipt.toolProfile === "core" &&
    receipt.threadMcp === "unverified" &&
    typeof receipt.generatedAt === "string" &&
    !Number.isNaN(Date.parse(receipt.generatedAt))
  );
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function isBoundedPrintable(value: unknown, maxLength: number): value is string {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= maxLength &&
    !/[\u0000-\u001f\u007f]/u.test(value);
}

function sameRuntime(
  left: WorktreeBootstrapReceipt["runtime"],
  right: WorktreeBootstrapReceipt["runtime"]
): boolean {
  return left.nodePath === right.nodePath &&
    left.nodeVersion === right.nodeVersion &&
    left.nodeModulesAbi === right.nodeModulesAbi &&
    left.platform === right.platform &&
    left.arch === right.arch;
}

async function readOptionalRegularFile(
  repoRoot: string,
  filePath: string,
  budget: InputScanBudget,
  label: string,
  snapshots?: StableTreeEntrySnapshot[],
  missingPaths?: string[]
): Promise<Buffer | null> {
  try {
    return await readBudgetedStableRegularFile(
      filePath,
      STARTUP_INPUT_MAX_BYTES,
      label,
      budget,
      repoRoot,
      snapshots
    );
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      missingPaths?.push(filePath);
      return null;
    }
    throw error;
  }
}

function isContainedPath(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function boundedReason(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/\s+/gu, " ").slice(0, 240);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
