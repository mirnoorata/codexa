import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { parse as parseToml } from "smol-toml";
import { runCommand } from "./command.js";
import {
  assertSafeManagedStateDirectory,
  isGitTrackedAsync
} from "./init-portability.js";
import {
  currentAdoptionReceiptFacts,
  readBoundedStableRegularFile,
  STARTUP_INPUT_MAX_BYTES,
  type WorktreeBootstrapAdoptionFacts
} from "./worktree-bootstrap-adoption.js";
import { worktreeBootstrapBuildInputDigest } from "./worktree-bootstrap-build-input.js";
import type { StableDirectoryBudget } from "./stable-directory-snapshot.js";

export const WORKTREE_BOOTSTRAP_RECEIPT_REF = "refs/worktree/codexa/bootstrap-receipt";
export const WORKTREE_BOOTSTRAP_DEPENDENCY_SEAL_RELATIVE_PATH = "node_modules/.codexa-dependencies.json";
const RECEIPT_MAX_BYTES = 128 * 1024;
const GIT_OBJECT_ID_PATTERN = /^[0-9a-f]{40,64}$/u;
const DEPENDENCY_MAX_ENTRIES = 100_000;
const DEPENDENCY_MAX_LOGICAL_BYTES = 2 * 1024 * 1024 * 1024;
const STARTUP_SCAN_TIMEOUT_MS = 5_000;
const STARTUP_SCAN_MAX_FILES = 128;
const STARTUP_SCAN_MAX_LOGICAL_BYTES = 64 * 1024 * 1024;
const STARTUP_DECLARATION_MAX_COUNT = 64;
const STARTUP_DECLARATION_MAX_NAME_BYTES = 32 * 1024;

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
  const options = { cwd: repoRoot, timeoutMs: 60_000, maxBufferBytes: 8 * 1024 * 1024 };
  if (process.platform !== "win32") {
    return runCommand("npm", ["ls", "--all", "--json", "--silent"], options);
  }
  const commandInterpreter = process.env.ComSpec?.trim() || process.env.COMSPEC?.trim() || "cmd.exe";
  return runCommand(
    commandInterpreter,
    ["/d", "/s", "/c", "npm.cmd ls --all --json --silent"],
    options
  );
}

export async function isWorktreeBootstrapReceiptRequired(repoRoot: string): Promise<boolean> {
  const repo = path.resolve(repoRoot);
  const tracked = await runCommand(
    "git",
    ["-C", repo, "ls-files", "--", ".codex/worktree-bootstrap.sh", ".codex/worktree-bootstrap.ps1"],
    { timeoutMs: 2_500, maxBufferBytes: 16 * 1024 }
  );
  if (!tracked.ok) throw new Error("bootstrap-requirement-git-inspection-failed");
  return tracked.stdout.trim().length > 0;
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
    throw new Error("Cannot issue Codexa worktree receipt: npm dependency tree is incomplete");
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
  validation: WorktreeBootstrapValidation = "full"
): Promise<WorktreeBootstrapInspection> {
  let startup: WorktreeBootstrapStartupSnapshot;
  try {
    startup = await currentStartupReceiptSnapshot(repoRoot);
  } catch (error) {
    return { state: "unavailable", lane: receipt.lane, validation, reason: boundedReason(error) };
  }
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
    [
      receipt.codexaHooks === expectedCodexaHookState(receipt.lane),
      "hook-lane-drift"
    ],
    [receipt.threadMcp === "unverified", "thread-mcp-claim-invalid"]
  ];
  const mismatch = comparisons.find(([matches]) => !matches);
  if (mismatch) return { state: "stale", lane: receipt.lane, validation, reason: mismatch[1], receipt };
  const platformReason = lanePlatformMismatch(receipt.lane, current.runtime.platform);
  if (platformReason) {
    return { state: "stale", lane: receipt.lane, validation, reason: platformReason, receipt };
  }
  const hookContract = inspectHookLaneContract(path.resolve(repoRoot), receipt.lane, startup);
  if (!hookContract.ok) {
    return { state: "stale", lane: receipt.lane, validation, reason: hookContract.reason, receipt };
  }
  if (validation === "startup") {
    return { state: "verified", lane: receipt.lane, validation, receipt };
  }
  let adoption: WorktreeBootstrapAdoptionFacts;
  try {
    adoption = await currentAdoptionReceiptFacts(repoRoot);
  } catch (error) {
    return { state: "unavailable", lane: receipt.lane, validation, reason: boundedReason(error), receipt };
  }
  const adoptionComparisons: Array<[boolean, string]> = [
    [receipt.distCliSha256 === adoption.distCliSha256, "dist-cli-drift"],
    [receipt.distRuntimeSha256 === adoption.distRuntimeSha256, "dist-runtime-drift"],
    [
      receipt.dependencyInventory.sha256 === adoption.dependencyInventory.sha256 &&
        receipt.dependencyInventory.count === adoption.dependencyInventory.count &&
        receipt.dependencyInventory.fileCount === adoption.dependencyInventory.fileCount &&
        receipt.dependencyInventory.logicalBytes === adoption.dependencyInventory.logicalBytes,
      "dependency-inventory-drift"
    ]
  ];
  const adoptionMismatch = adoptionComparisons.find(([matches]) => !matches);
  if (adoptionMismatch) {
    return { state: "stale", lane: receipt.lane, validation, reason: adoptionMismatch[1], receipt };
  }
  if (validation === "adoption") {
    return { state: "verified", lane: receipt.lane, validation, receipt };
  }
  let completion: WorktreeBootstrapCompletionFacts;
  try {
    completion = await currentCompletionReceiptFacts(repoRoot);
  } catch (error) {
    return { state: "unavailable", lane: receipt.lane, validation, reason: boundedReason(error), receipt };
  }
  const completionComparisons: Array<[boolean, string]> = [
    [receipt.head === completion.head, "head-drift"],
    [receipt.buildInputSha256 === completion.buildInputSha256, "build-input-drift"]
  ];
  const completionMismatch = completionComparisons.find(([matches]) => !matches);
  return completionMismatch
    ? { state: "stale", lane: receipt.lane, validation, reason: completionMismatch[1], receipt }
    : { state: "verified", lane: receipt.lane, validation, receipt };
}

export async function inspectWorktreeBootstrapReceipt(
  repoRoot: string,
  options: { validation?: WorktreeBootstrapValidation } = {}
): Promise<WorktreeBootstrapInspection> {
  const repo = path.resolve(repoRoot);
  const validation = options.validation ?? "full";
  let required: boolean;
  try {
    required = await isWorktreeBootstrapReceiptRequired(repo);
  } catch (error) {
    return { state: "unavailable", validation, reason: boundedReason(error) };
  }
  if (!required) return { state: "not-required" };
  try {
    const stored = await readWorktreeReceiptRef(repo);
    if (stored.state === "missing") {
      return { state: "missing", validation, reason: "receipt-missing" };
    }
    if (stored.state === "invalid") {
      return { state: "invalid", validation, reason: stored.reason };
    }
    const parsed = JSON.parse(stored.contents) as unknown;
    if (!isWorktreeBootstrapReceipt(parsed)) {
      return { state: "invalid", validation, reason: "receipt-schema-invalid" };
    }
    return validateWorktreeBootstrapReceipt(repo, parsed, validation);
  } catch (error) {
    return { state: "invalid", validation, reason: boundedReason(error) };
  }
}

async function publishWorktreeReceiptRef(
  repoRoot: string,
  contents: string
): Promise<void> {
  if (Buffer.byteLength(contents, "utf8") > RECEIPT_MAX_BYTES) {
    throw new Error("Cannot issue Codexa worktree receipt: receipt-too-large");
  }
  const stored = await runCommand(
    "git",
    ["-C", repoRoot, "hash-object", "-w", "--stdin"],
    {
      input: contents,
      timeoutMs: 2_500,
      maxBufferBytes: 64 * 1024
    }
  );
  const objectId = stored.stdout.trim();
  if (!stored.ok || !GIT_OBJECT_ID_PATTERN.test(objectId)) {
    throw new Error("Cannot issue Codexa worktree receipt: receipt-object-publication-failed");
  }
  const published = await runCommand(
    "git",
    ["-C", repoRoot, "update-ref", "--no-deref", WORKTREE_BOOTSTRAP_RECEIPT_REF, objectId],
    {
      timeoutMs: 2_500,
      maxBufferBytes: 64 * 1024
    }
  );
  if (!published.ok) {
    throw new Error("Cannot issue Codexa worktree receipt: receipt-ref-publication-failed");
  }
}

async function readWorktreeReceiptRef(
  repoRoot: string
): Promise<
  | { state: "missing" }
  | { state: "invalid"; reason: string }
  | { state: "ok"; contents: string }
> {
  const resolved = await runCommand(
    "git",
    ["-C", repoRoot, "rev-parse", "--verify", "--end-of-options", WORKTREE_BOOTSTRAP_RECEIPT_REF],
    {
      timeoutMs: 2_500,
      maxBufferBytes: 64 * 1024
    }
  );
  if (!resolved.ok) {
    if (resolved.timedOut || resolved.truncated || resolved.error) {
      return { state: "invalid", reason: "receipt-ref-resolution-failed" };
    }
    return { state: "missing" };
  }
  const objectId = resolved.stdout.trim();
  if (!GIT_OBJECT_ID_PATTERN.test(objectId)) {
    return { state: "invalid", reason: "receipt-ref-object-invalid" };
  }
  const type = await runCommand(
    "git",
    ["-C", repoRoot, "cat-file", "-t", objectId],
    {
      timeoutMs: 2_500,
      maxBufferBytes: 64 * 1024
    }
  );
  if (!type.ok || type.stdout.trim() !== "blob") {
    return { state: "invalid", reason: "receipt-ref-object-invalid" };
  }
  const contents = await runCommand(
    "git",
    ["-C", repoRoot, "cat-file", "blob", objectId],
    {
      timeoutMs: 2_500,
      maxBufferBytes: RECEIPT_MAX_BYTES + 1
    }
  );
  if (
    contents.truncated ||
    Buffer.byteLength(contents.stdout, "utf8") > RECEIPT_MAX_BYTES
  ) {
    return { state: "invalid", reason: "receipt-too-large" };
  }
  if (!contents.ok) {
    return { state: "invalid", reason: "receipt-object-read-failed" };
  }
  return { state: "ok", contents: contents.stdout };
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
  const repo = path.resolve(repoRoot);
  const readHead = async (): Promise<string> => {
    const result = await runCommand(
      "git",
      ["-C", repo, "rev-parse", "HEAD"],
      { timeoutMs: 2_500, maxBufferBytes: 64 * 1024 }
    );
    if (!result.ok) throw new Error("git-head-unavailable");
    const value = result.stdout.trim();
    if (!/^[0-9a-f]{40,64}$/u.test(value)) throw new Error("git-head-invalid");
    return value;
  };
  const head = await readHead();
  const buildInputSha256 = await worktreeBootstrapBuildInputDigest(repo);
  if (await readHead() !== head) throw new Error("git-head-changed-during-build-scan");
  return { head, buildInputSha256 };
}

async function currentStartupReceiptSnapshot(
  repoRoot: string
): Promise<WorktreeBootstrapStartupSnapshot> {
  const repo = path.resolve(repoRoot);
  const budget = createStartupScanBudget();
  const repoRootReal = await fs.realpath(repo);
  const commonDirResult = await runCommand(
    "git",
    ["-C", repo, "rev-parse", "--path-format=absolute", "--git-common-dir"],
    { timeoutMs: 2_500, maxBufferBytes: 64 * 1024 }
  );
  if (!commonDirResult.ok) throw new Error("git-identity-unavailable");
  const gitCommonDir = await fs.realpath(commonDirResult.stdout.trim());
  await assertSafeManagedStateDirectory(repo);
  const nodePath = await fs.realpath(process.execPath);
  const packageJsonContents = await readBudgetedStableRegularFile(
    path.join(repo, "package.json"),
    STARTUP_INPUT_MAX_BYTES,
    "package-json",
    budget,
    repo
  );
  const packageLockContents = await readBudgetedStableRegularFile(
    path.join(repo, "package-lock.json"),
    STARTUP_INPUT_MAX_BYTES,
    "package-lock",
    budget,
    repo
  );
  const uvLockContents = await readOptionalRegularFile(
    repo,
    path.join(repo, "uv.lock"),
    budget,
    "uv-lock"
  );
  const configContents = await readBudgetedStableRegularFile(
    path.join(repo, ".codex", "config.toml"),
    STARTUP_INPUT_MAX_BYTES,
    "config",
    budget,
    repo
  );
  const hooksContents = await readOptionalRegularFile(
    repo,
    path.join(repo, ".codex", "hooks.json"),
    budget,
    "hooks"
  );
  const dependencySealContents = await readBudgetedStableRegularFile(
    path.join(repo, WORKTREE_BOOTSTRAP_DEPENDENCY_SEAL_RELATIVE_PATH),
    STARTUP_INPUT_MAX_BYTES,
    "dependency-seal",
    budget,
    repo
  );
  const hooksTracked = await isGitTrackedAsync(repo, ".codex/hooks.json");
  const startupInputSha256 = await hashStartupInputs(repo);
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

async function hashStartupInputs(
  repoRoot: string,
  budget: InputScanBudget = createStartupScanBudget()
): Promise<string> {
  const wrapper = ".codex/worktree-bootstrap.sh";
  const declared = parseBootstrapInputNames(
    (await readBudgetedStableRegularFile(
      path.join(repoRoot, wrapper),
      STARTUP_INPUT_MAX_BYTES,
      "bootstrap-wrapper",
      budget,
      repoRoot
    )).toString("utf8")
  );
  return hashNamedFiles(repoRoot, [...new Set([
    ".codex/environments/environment.toml",
    ".codex/worktree-bootstrap.ps1",
    wrapper,
    ...declared
  ])].sort(), budget);
}

function parseBootstrapInputNames(wrapper: string): string[] {
  const prefix = "# focus-worktree-bootstrap-input: ";
  const names: string[] = [];
  const seen = new Set<string>();
  let nameBytes = 0;
  let lineStart = 0;
  while (lineStart <= wrapper.length) {
    const newline = wrapper.indexOf("\n", lineStart);
    let lineEnd = newline === -1 ? wrapper.length : newline;
    if (
      newline !== -1 &&
      lineEnd > lineStart &&
      wrapper.charCodeAt(lineEnd - 1) === 13
    ) {
      lineEnd -= 1;
    }
    if (
      lineEnd - lineStart >= prefix.length &&
      wrapper.startsWith(prefix, lineStart)
    ) {
      const nameStart = lineStart + prefix.length;
      const nameLength = lineEnd - nameStart;
      if (
        names.length >= STARTUP_DECLARATION_MAX_COUNT ||
        nameLength > STARTUP_DECLARATION_MAX_NAME_BYTES
      ) {
        throw new Error("bootstrap-input-declarations-invalid");
      }
      const name = wrapper.slice(nameStart, lineEnd);
      nameBytes += Buffer.byteLength(name, "utf8");
      if (
        nameBytes > STARTUP_DECLARATION_MAX_NAME_BYTES ||
        seen.has(name)
      ) {
        throw new Error("bootstrap-input-declarations-invalid");
      }
      names.push(name);
      seen.add(name);
    }
    if (newline === -1) break;
    lineStart = newline + 1;
  }
  if (names.length === 0) {
    throw new Error("bootstrap-input-declarations-invalid");
  }
  for (const name of names) {
    if (
      name.length === 0 ||
      name.length > 512 ||
      name.includes("\\") ||
      path.posix.isAbsolute(name) ||
      path.posix.normalize(name) !== name ||
      name.split("/").some((segment) => segment === "" || segment === "." || segment === "..") ||
      /[\u0000-\u001f\u007f]/u.test(name)
    ) {
      throw new Error("bootstrap-input-declarations-invalid");
    }
  }
  return names;
}

async function hashNamedFiles(
  repoRoot: string,
  names: string[],
  budget: InputScanBudget = createStartupScanBudget()
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
        repoRoot
      );
      entries.push([name, contents]);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") entries.push([name, null]);
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
  repoRoot: string
): Promise<Buffer> {
  assertInputScanDeadline(budget);
  budget.fileCount += 1;
  if (budget.fileCount > budget.maxFiles) {
    throw new Error(`${budget.label}-file-limit-exceeded`);
  }
  const contents = await readBoundedStableRegularFile(
    filePath,
    maxBytes,
    label,
    budget.deadlineAt,
    repoRoot
  );
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

function createStartupScanBudget(): InputScanBudget {
  return createInputScanBudget(
    "startup-input",
    STARTUP_SCAN_MAX_FILES,
    STARTUP_SCAN_MAX_FILES,
    STARTUP_SCAN_MAX_LOGICAL_BYTES,
    STARTUP_SCAN_TIMEOUT_MS
  );
}

function createInputScanBudget(
  label: string,
  maxFiles: number,
  maxEntries: number,
  maxLogicalBytes: number,
  timeoutMs: number
): InputScanBudget {
  return {
    deadlineAt: Date.now() + timeoutMs,
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

function expectedCodexaHookState(lane: WorktreeBootstrapLane): WorktreeBootstrapReceipt["codexaHooks"] {
  return lane === "posix-hooks" ? "enabled" : "disabled";
}

function lanePlatformMismatch(lane: WorktreeBootstrapLane, platform: NodeJS.Platform): string | null {
  if (lane === "native-windows-mcp") return platform === "win32" ? null : "lane-platform-drift";
  return platform === "win32" ? "lane-platform-drift" : null;
}

function inspectHookLaneContract(
  repoRoot: string,
  lane: WorktreeBootstrapLane,
  snapshot: WorktreeBootstrapStartupSnapshot
): { ok: true } | { ok: false; reason: string } {
  try {
    const configContents = snapshot.hookInputs.configContents.toString("utf8");
    const parsedConfig = parseToml(configContents) as unknown;
    if (!isPlainObject(parsedConfig)) return { ok: false, reason: "hook-config-invalid" };
    const hooksFeature = isPlainObject(parsedConfig.features) ? parsedConfig.features.hooks : undefined;
    const hooksContents = snapshot.hookInputs.hooksContents;
    const parsedHooks = hooksContents ? JSON.parse(hooksContents.toString("utf8")) as unknown : {};
    const hooks = isPlainObject(parsedHooks) && isPlainObject(parsedHooks.hooks) ? parsedHooks.hooks : {};
    const nodePath = snapshot.facts.runtime.nodePath;
    const hooksTracked = snapshot.hookInputs.hooksTracked;
    const expectedCommands = new Map([
      ["session-start", expectedCodexaHookCommand(repoRoot, nodePath, hooksTracked, "session-start")],
      ["hook-pre-edit", expectedCodexaHookCommand(repoRoot, nodePath, hooksTracked, "hook-pre-edit")],
      ["hook-post-edit", expectedCodexaHookCommand(repoRoot, nodePath, hooksTracked, "hook-post-edit")]
    ]);
    const expectedCommandSet = new Set(expectedCommands.values());
    const managedEntries = Object.values(hooks)
      .flatMap((value) => Array.isArray(value) ? value : [])
      .filter((entry) => hasCodexaHookSignal(entry, expectedCommandSet));

    if (lane === "native-windows-mcp") {
      return managedEntries.length === 0
        ? { ok: true }
        : { ok: false, reason: "hook-lane-drift" };
    }
    if (hooksFeature !== true) return { ok: false, reason: "hook-feature-disabled" };
    const required = [
      ["SessionStart", "startup|resume", "session-start"],
      ["PreToolUse", "Edit|MultiEdit|Write|NotebookEdit|apply_patch", "hook-pre-edit"],
      ["PostToolUse", "Edit|MultiEdit|Write|NotebookEdit|apply_patch", "hook-post-edit"]
    ] as const;
    if (managedEntries.length !== required.length) {
      return { ok: false, reason: "hook-contract-drift:managed-set" };
    }
    for (const [event, matcher, action] of required) {
      const entries = Array.isArray(hooks[event]) ? hooks[event] : [];
      const expectedCommand = expectedCommands.get(action);
      if (!expectedCommand) return { ok: false, reason: `hook-contract-drift:${event}` };
      const matching = entries.filter((entry) => isExpectedManagedHookEntry(entry, matcher, expectedCommand));
      if (matching.length !== 1) return { ok: false, reason: `hook-contract-drift:${event}` };
    }
    return { ok: true };
  } catch {
    return { ok: false, reason: "hook-contract-invalid" };
  }
}

function isExpectedManagedHookEntry(value: unknown, matcher: string, expectedCommand: string): boolean {
  if (!isPlainObject(value) || value.codexaManaged !== true || value.matcher !== matcher) return false;
  if (!Array.isArray(value.hooks) || value.hooks.length !== 1) return false;
  const hook = value.hooks[0];
  return isPlainObject(hook) &&
    hook.codexaManaged === true &&
    hook.type === "command" &&
    hook.command === expectedCommand;
}

function hasCodexaHookSignal(value: unknown, expectedCommands: Set<string>): boolean {
  if (!isPlainObject(value)) return false;
  if (value.codexaManaged === true) return true;
  if (!Array.isArray(value.hooks)) return false;
  return value.hooks.some((hook) => isPlainObject(hook) && (
    hook.codexaManaged === true ||
    (typeof hook.command === "string" && expectedCommands.has(hook.command))
  ));
}

function expectedCodexaHookCommand(
  repoRoot: string,
  nodePath: string,
  hooksTracked: boolean,
  action: string
): string {
  const launchCommand = hooksTracked ? "node" : nodePath;
  const printableCommand = /[\s'"\\]/u.test(launchCommand) ? shellQuote(launchCommand) : launchCommand;
  const launch = `${printableCommand} ${shellQuote(path.join(repoRoot, "dist", "cli.js"))}`;
  const repoArg = hooksTracked ? undefined : repoRoot;
  return repoArg ? `${launch} ${action} ${shellQuote(repoArg)}` : `${launch} ${action}`;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function readOptionalRegularFile(
  repoRoot: string,
  filePath: string,
  budget: InputScanBudget,
  label: string
): Promise<Buffer | null> {
  try {
    return await readBudgetedStableRegularFile(
      filePath,
      STARTUP_INPUT_MAX_BYTES,
      label,
      budget,
      repoRoot
    );
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return null;
    throw error;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
