import { createHash, randomUUID } from "node:crypto";
import { promises as fs, type Stats } from "node:fs";
import path from "node:path";
import { parse as parseToml } from "smol-toml";
import { runCommand } from "./command.js";
import {
  assertSafeManagedDirectory,
  assertSafeManagedFile,
  assertSafeManagedStateDirectory,
  ensureSafeManagedStateDirectory,
  isGitTracked
} from "./init-portability.js";

export const WORKTREE_BOOTSTRAP_RECEIPT_RELATIVE_PATH = ".codex/tmp/worktree-bootstrap-receipt.json";
export const WORKTREE_BOOTSTRAP_DEPENDENCY_SEAL_RELATIVE_PATH = "node_modules/.codexa-dependencies.json";
const RECEIPT_MAX_BYTES = 128 * 1024;
const ADOPTION_SCAN_TIMEOUT_MS = 20_000;
const DIST_RUNTIME_MAX_ENTRIES = 10_000;
const DIST_RUNTIME_MAX_LOGICAL_BYTES = 256 * 1024 * 1024;
const DIST_RUNTIME_MAX_FILE_BYTES = 128 * 1024 * 1024;
const DEPENDENCY_MAX_ENTRIES = 100_000;
const DEPENDENCY_MAX_LOGICAL_BYTES = 2 * 1024 * 1024 * 1024;
const DEPENDENCY_MAX_FILE_BYTES = 256 * 1024 * 1024;

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

type WorktreeBootstrapAdoptionFacts = Pick<
  WorktreeBootstrapReceipt,
  "distCliSha256" | "distRuntimeSha256" | "dependencyInventory"
>;

type WorktreeBootstrapCompletionFacts = Pick<
  WorktreeBootstrapReceipt,
  "head" | "buildInputSha256"
>;

export function parseWorktreeBootstrapLane(value: string): WorktreeBootstrapLane {
  if (value === "posix-hooks" || value === "native-windows-mcp") return value;
  throw new Error("worktree receipt lane must be posix-hooks or native-windows-mcp");
}

export async function worktreeBootstrapBuildInputSha256(repoRoot: string): Promise<string> {
  return hashBuildInputs(path.resolve(repoRoot));
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
  expectedBuildInputSha256: string
): Promise<WorktreeBootstrapReceipt> {
  const repo = path.resolve(repoRoot);
  if (!isSha256(expectedBuildInputSha256)) {
    throw new Error("Cannot issue Codexa worktree receipt: expected build input must be a SHA-256 digest");
  }
  const platformReason = lanePlatformMismatch(lane, process.platform);
  if (platformReason) throw new Error(`Cannot issue Codexa worktree receipt: ${platformReason}`);
  const dependencyCheck = await runNpmLs(repo);
  if (!dependencyCheck.ok) {
    throw new Error("Cannot issue Codexa worktree receipt: npm dependency tree is incomplete");
  }
  const hookContract = await inspectHookLaneContract(repo, lane);
  if (!hookContract.ok) {
    throw new Error(`Cannot issue Codexa worktree receipt: ${hookContract.reason}`);
  }
  const receipt = await currentReceiptFacts(repo, lane);
  if (receipt.buildInputSha256 !== expectedBuildInputSha256) {
    throw new Error("Cannot issue Codexa worktree receipt: build-input-changed-during-bootstrap");
  }
  const receiptPath = path.join(repo, WORKTREE_BOOTSTRAP_RECEIPT_RELATIVE_PATH);
  const receiptDir = await ensureSafeManagedStateDirectory(repo, "tmp");
  await assertSafeManagedFile(receiptPath);
  const temporaryPath = path.join(receiptDir, `.worktree-bootstrap-receipt.${process.pid}.${randomUUID()}.tmp`);
  try {
    await fs.writeFile(temporaryPath, `${JSON.stringify(receipt, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600
    });
    await fs.rename(temporaryPath, receiptPath);
  } finally {
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
  }
  const inspection = await inspectWorktreeBootstrapReceipt(repo, { validation: "full" });
  if (inspection.state !== "verified" || inspection.validation !== "full") {
    await fs.rm(receiptPath, { force: true }).catch(() => undefined);
    throw new Error(`Codexa worktree receipt failed immediate validation: ${inspection.reason ?? inspection.state}`);
  }
  return receipt;
}

export async function validateWorktreeBootstrapReceipt(
  repoRoot: string,
  receipt: WorktreeBootstrapReceipt,
  validation: WorktreeBootstrapValidation = "full"
): Promise<WorktreeBootstrapInspection> {
  let current: WorktreeBootstrapStartupFacts;
  try {
    current = await currentStartupReceiptFacts(repoRoot);
  } catch (error) {
    return { state: "unavailable", lane: receipt.lane, validation, reason: boundedReason(error) };
  }
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
  const hookContract = await inspectHookLaneContract(path.resolve(repoRoot), receipt.lane);
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
  const receiptPath = path.join(repo, WORKTREE_BOOTSTRAP_RECEIPT_RELATIVE_PATH);
  try {
    await assertSafeManagedStateDirectory(repo, "tmp");
    await assertSafeManagedFile(receiptPath);
    const stat = await fs.lstat(receiptPath);
    if (stat.size > RECEIPT_MAX_BYTES) {
      return { state: "invalid", validation, reason: "receipt-too-large" };
    }
    const parsed = JSON.parse(await fs.readFile(receiptPath, "utf8")) as unknown;
    if (!isWorktreeBootstrapReceipt(parsed)) {
      return { state: "invalid", validation, reason: "receipt-schema-invalid" };
    }
    return validateWorktreeBootstrapReceipt(repo, parsed, validation);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return required
        ? { state: "missing", validation, reason: "receipt-missing" }
        : { state: "not-required" };
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
  const startup = startupFacts ?? await currentStartupReceiptFacts(repo);
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
  const headResult = await runCommand(
    "git",
    ["-C", repo, "rev-parse", "HEAD"],
    { timeoutMs: 2_500, maxBufferBytes: 64 * 1024 }
  );
  if (!headResult.ok) throw new Error("git-head-unavailable");
  const head = headResult.stdout.trim();
  if (!/^[0-9a-f]{40,64}$/u.test(head)) throw new Error("git-head-invalid");
  return {
    head,
    buildInputSha256: await hashBuildInputs(repo)
  };
}

async function currentAdoptionReceiptFacts(
  repoRoot: string
): Promise<WorktreeBootstrapAdoptionFacts> {
  const repo = path.resolve(repoRoot);
  const packageLockPath = path.join(repo, "package-lock.json");
  await assertSafeManagedDirectory(path.join(repo, "dist"));
  const deadlineAt = Date.now() + ADOPTION_SCAN_TIMEOUT_MS;
  return {
    distRuntimeSha256: await hashBoundedRegularTree(
      repo,
      path.join(repo, "dist"),
      createScanBudget(
        "dist-runtime",
        deadlineAt,
        DIST_RUNTIME_MAX_ENTRIES,
        DIST_RUNTIME_MAX_LOGICAL_BYTES,
        DIST_RUNTIME_MAX_FILE_BYTES
      )
    ),
    distCliSha256: await hashRegularFile(path.join(repo, "dist", "cli.js")),
    dependencyInventory: await installedDependencyInventory(repo, packageLockPath, deadlineAt)
  };
}

async function currentStartupReceiptFacts(repoRoot: string): Promise<WorktreeBootstrapStartupFacts> {
  const repo = path.resolve(repoRoot);
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
  return {
    repoRoot: repoRootReal,
    gitCommonDir,
    rootLockSha256: await hashNamedFiles(repo, ["package-lock.json", "uv.lock"]),
    packageJsonSha256: await hashRegularFile(path.join(repo, "package.json")),
    packageLockSha256: await hashRegularFile(path.join(repo, "package-lock.json")),
    startupInputSha256: await hashStartupInputs(repo),
    configSha256: await hashRegularFile(path.join(repo, ".codex", "config.toml")),
    hooksSha256: await hashOptionalRegularFile(path.join(repo, ".codex", "hooks.json")),
    dependencySealSha256: await hashRegularFile(path.join(repo, WORKTREE_BOOTSTRAP_DEPENDENCY_SEAL_RELATIVE_PATH)),
    runtime: {
      nodePath,
      nodeVersion: process.version,
      nodeModulesAbi: process.versions.modules,
      platform: process.platform,
      arch: process.arch
    },
    toolProfile: "core",
    threadMcp: "unverified"
  };
}

async function hashBuildInputs(repoRoot: string): Promise<string> {
  const files = [
    path.join(repoRoot, "package.json"),
    path.join(repoRoot, "package-lock.json"),
    path.join(repoRoot, "tsconfig.json"),
    ...await regularTreeFiles(repoRoot, path.join(repoRoot, "src"))
  ];
  return hashFileManifest(repoRoot, files);
}

async function hashStartupInputs(repoRoot: string): Promise<string> {
  return hashNamedFiles(repoRoot, [
    ".npmrc",
    ".codex/environments/environment.toml",
    ".codex/worktree-bootstrap.ps1",
    ".codex/worktree-bootstrap.sh",
    "scripts/worktree-bootstrap-preflight.mjs",
    "scripts/worktree-bootstrap.mjs"
  ]);
}

async function hashNamedFiles(repoRoot: string, names: string[]): Promise<string> {
  const hash = createHash("sha256");
  for (const name of names) {
    const filePath = path.join(repoRoot, name);
    hash.update(`\0${name}\0`, "utf8");
    try {
      hash.update(await readRegularFile(filePath));
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") hash.update("missing", "utf8");
      else throw error;
    }
  }
  return hash.digest("hex");
}

async function regularTreeFiles(repoRoot: string, directory: string): Promise<string[]> {
  const repoReal = await fs.realpath(repoRoot);
  const directoryStat = await fs.lstat(directory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    throw new Error(`non-regular-directory:${path.relative(repoRoot, directory)}`);
  }
  const directoryReal = await fs.realpath(directory);
  if (!isContainedPath(repoReal, directoryReal)) throw new Error("tree-outside-repository");
  const files: string[] = [];
  const visit = async (current: string): Promise<void> => {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const candidate = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await assertSafeManagedDirectory(candidate);
        await visit(candidate);
      } else if (entry.isFile()) {
        await assertSafeManagedFile(candidate);
        files.push(candidate);
      } else {
        throw new Error(`non-regular-tree-entry:${path.relative(repoRoot, candidate)}`);
      }
    }
  };
  await visit(directory);
  return files;
}

async function hashFileManifest(base: string, files: string[]): Promise<string> {
  const hash = createHash("sha256");
  for (const file of files.sort()) {
    hash.update(`\0${path.relative(base, file).replaceAll(path.sep, "/")}\0`, "utf8");
    hash.update(await readRegularFile(file));
  }
  return hash.digest("hex");
}

async function installedDependencyInventory(
  repoRoot: string,
  packageLockPath: string,
  deadlineAt: number
): Promise<{ sha256: string; count: number; fileCount: number; logicalBytes: number }> {
  const repoReal = await fs.realpath(repoRoot);
  const nodeModules = path.join(repoRoot, "node_modules");
  const nodeModulesEntry = await fs.lstat(nodeModules);
  if (!nodeModulesEntry.isDirectory() || nodeModulesEntry.isSymbolicLink()) {
    throw new Error("dependency-root-invalid");
  }
  const nodeModulesReal = await fs.realpath(nodeModules);
  if (!isContainedPath(repoReal, nodeModulesReal)) {
    throw new Error("dependency-root-outside-repository");
  }
  const lock = JSON.parse((await readRegularFile(packageLockPath)).toString("utf8")) as {
    packages?: Record<string, unknown>;
  };
  if (!lock.packages || typeof lock.packages !== "object") {
    throw new Error("package-lock-packages-missing");
  }
  const installedPackagePaths: string[] = [];
  for (const lockPath of Object.keys(lock.packages).filter((entry) => entry.startsWith("node_modules/")).sort()) {
    assertAdoptionDeadline(deadlineAt);
    const packageDir = path.resolve(repoRoot, ...lockPath.split("/"));
    if (
      !isContainedPath(nodeModules, packageDir) ||
      path.relative(repoRoot, packageDir).replaceAll(path.sep, "/") !== lockPath
    ) {
      throw new Error(`package-lock-path-invalid:${lockPath.slice(0, 256)}`);
    }
    let entry;
    try {
      entry = await fs.lstat(packageDir);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") continue;
      throw error;
    }
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new Error(`dependency-directory-invalid:${lockPath}`);
    }
    if (!isContainedPath(nodeModulesReal, await fs.realpath(packageDir))) {
      throw new Error(`dependency-directory-outside-repository:${lockPath}`);
    }
    installedPackagePaths.push(lockPath);
  }

  const tree = await hashDependencyTree(
    repoRoot,
    nodeModulesReal,
    createScanBudget(
      "dependency-inventory",
      deadlineAt,
      DEPENDENCY_MAX_ENTRIES,
      DEPENDENCY_MAX_LOGICAL_BYTES,
      DEPENDENCY_MAX_FILE_BYTES
    )
  );
  return {
    sha256: createHash("sha256")
      .update(installedPackagePaths.join("\n"), "utf8")
      .update(`\0${tree.sha256}`, "utf8")
      .digest("hex"),
    count: installedPackagePaths.length,
    fileCount: tree.fileCount,
    logicalBytes: tree.logicalBytes
  };
}

interface AdoptionScanBudget {
  label: string;
  deadlineAt: number;
  maxEntries: number;
  maxLogicalBytes: number;
  maxFileBytes: number;
  entries: number;
  logicalBytes: number;
}

function createScanBudget(
  label: string,
  deadlineAt: number,
  maxEntries: number,
  maxLogicalBytes: number,
  maxFileBytes: number
): AdoptionScanBudget {
  return {
    label,
    deadlineAt,
    maxEntries,
    maxLogicalBytes,
    maxFileBytes,
    entries: 0,
    logicalBytes: 0
  };
}

async function hashBoundedRegularTree(
  repoRoot: string,
  directory: string,
  budget: AdoptionScanBudget
): Promise<string> {
  const repoReal = await fs.realpath(repoRoot);
  const directoryReal = await fs.realpath(directory);
  if (!isContainedPath(repoReal, directoryReal)) throw new Error("tree-outside-repository");
  const hash = createHash("sha256");
  const scratch = Buffer.allocUnsafe(1024 * 1024);
  const visit = async (current: string): Promise<void> => {
    assertAdoptionDeadline(budget.deadlineAt);
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const candidate = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await assertSafeManagedDirectory(candidate);
        consumeAdoptionEntry(budget, 0);
        hash.update(`D\0${path.relative(directory, candidate).replaceAll(path.sep, "/")}\0`, "utf8");
        await visit(candidate);
      } else if (entry.isFile()) {
        await assertSafeManagedFile(candidate);
        const stat = await fs.lstat(candidate);
        consumeAdoptionEntry(budget, stat.size);
        hash.update(
          `F\0${path.relative(directory, candidate).replaceAll(path.sep, "/")}` +
          `\0${(stat.mode & 0o777).toString(8)}\0${stat.size}\0`,
          "utf8"
        );
        await updateHashFromFile(hash, candidate, stat, scratch, budget.deadlineAt);
      } else {
        throw new Error(`non-regular-tree-entry:${path.relative(repoRoot, candidate)}`);
      }
    }
  };
  await visit(directory);
  return hash.digest("hex");
}

async function hashDependencyTree(
  repoRoot: string,
  nodeModulesReal: string,
  budget: AdoptionScanBudget
): Promise<{ sha256: string; fileCount: number; logicalBytes: number }> {
  const hash = createHash("sha256");
  const scratch = Buffer.allocUnsafe(1024 * 1024);
  let fileCount = 0;
  const visit = async (current: string): Promise<void> => {
    assertAdoptionDeadline(budget.deadlineAt);
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const candidate = path.join(current, entry.name);
      const relative = path.relative(nodeModulesReal, candidate).replaceAll(path.sep, "/");
      if (entry.isDirectory()) {
        const stat = await fs.lstat(candidate);
        if (!stat.isDirectory() || stat.isSymbolicLink()) {
          throw new Error(`dependency-directory-invalid:${relative}`);
        }
        if (!isContainedPath(nodeModulesReal, await fs.realpath(candidate))) {
          throw new Error(`dependency-directory-outside-root:${relative}`);
        }
        consumeAdoptionEntry(budget, 0);
        hash.update(`D\0${relative}\0${(stat.mode & 0o777).toString(8)}\0`, "utf8");
        await visit(candidate);
      } else if (entry.isFile()) {
        const stat = await assertDependencyRegularFile(nodeModulesReal, candidate);
        consumeAdoptionEntry(budget, stat.size);
        fileCount += 1;
        hash.update(`F\0${relative}\0${(stat.mode & 0o777).toString(8)}\0${stat.size}\0`, "utf8");
        await updateHashFromFile(hash, candidate, stat, scratch, budget.deadlineAt);
      } else if (entry.isSymbolicLink()) {
        const target = await fs.readlink(candidate);
        const resolved = await fs.realpath(candidate);
        if (!isContainedPath(nodeModulesReal, resolved)) {
          throw new Error(`dependency-symlink-outside-root:${relative}`);
        }
        consumeAdoptionEntry(budget, Buffer.byteLength(target));
        hash.update(`L\0${relative}\0${target}\0`, "utf8");
      } else {
        throw new Error(`dependency-entry-invalid:${relative}`);
      }
    }
  };
  await visit(nodeModulesReal);
  return {
    sha256: hash.digest("hex"),
    fileCount,
    logicalBytes: budget.logicalBytes
  };
}

async function updateHashFromFile(
  hash: ReturnType<typeof createHash>,
  filePath: string,
  expected: Stats,
  scratch: Buffer,
  deadlineAt: number
): Promise<void> {
  const handle = await fs.open(filePath, "r");
  try {
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      opened.dev !== expected.dev ||
      opened.ino !== expected.ino ||
      opened.size !== expected.size ||
      opened.mode !== expected.mode
    ) {
      throw new Error("adoption-file-changed-during-scan");
    }
    let position = 0;
    while (position < expected.size) {
      assertAdoptionDeadline(deadlineAt);
      const length = Math.min(scratch.length, expected.size - position);
      const { bytesRead } = await handle.read(scratch, 0, length, position);
      if (bytesRead <= 0) throw new Error("adoption-file-changed-during-scan");
      hash.update(scratch.subarray(0, bytesRead));
      position += bytesRead;
    }
    const final = await handle.stat();
    if (
      final.dev !== opened.dev ||
      final.ino !== opened.ino ||
      final.size !== opened.size ||
      final.mode !== opened.mode ||
      final.mtimeMs !== opened.mtimeMs
    ) {
      throw new Error("adoption-file-changed-during-scan");
    }
    assertAdoptionDeadline(deadlineAt);
  } finally {
    await handle.close();
  }
}

function consumeAdoptionEntry(budget: AdoptionScanBudget, logicalBytes: number): void {
  assertAdoptionDeadline(budget.deadlineAt);
  budget.entries += 1;
  budget.logicalBytes += logicalBytes;
  if (budget.entries > budget.maxEntries) {
    throw new Error(`${budget.label}-entry-limit-exceeded`);
  }
  if (logicalBytes > budget.maxFileBytes) {
    throw new Error(`${budget.label}-file-size-limit-exceeded`);
  }
  if (budget.logicalBytes > budget.maxLogicalBytes) {
    throw new Error(`${budget.label}-byte-limit-exceeded`);
  }
}

function assertAdoptionDeadline(deadlineAt: number): void {
  if (Date.now() > deadlineAt) throw new Error("adoption-scan-timeout");
}

async function assertDependencyRegularFile(
  nodeModulesReal: string,
  filePath: string
) {
  const stat = await fs.lstat(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`dependency-file-invalid:${path.relative(nodeModulesReal, filePath)}`);
  }
  if (!isContainedPath(nodeModulesReal, await fs.realpath(filePath))) {
    throw new Error(`dependency-file-outside-root:${path.relative(nodeModulesReal, filePath)}`);
  }
  return stat;
}

async function hashRegularFile(filePath: string): Promise<string> {
  return sha256(await readRegularFile(filePath));
}

async function hashOptionalRegularFile(filePath: string): Promise<string> {
  try {
    return await hashRegularFile(filePath);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return "missing";
    throw error;
  }
}

async function readRegularFile(filePath: string): Promise<Buffer> {
  await assertSafeManagedFile(filePath);
  return fs.readFile(filePath);
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

async function inspectHookLaneContract(
  repoRoot: string,
  lane: WorktreeBootstrapLane
): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    const configContents = (await readRegularFile(path.join(repoRoot, ".codex", "config.toml"))).toString("utf8");
    const parsedConfig = parseToml(configContents) as unknown;
    if (!isPlainObject(parsedConfig)) return { ok: false, reason: "hook-config-invalid" };
    const hooksFeature = isPlainObject(parsedConfig.features) ? parsedConfig.features.hooks : undefined;
    const hooksContents = await readOptionalRegularFile(path.join(repoRoot, ".codex", "hooks.json"));
    const parsedHooks = hooksContents ? JSON.parse(hooksContents.toString("utf8")) as unknown : {};
    const hooks = isPlainObject(parsedHooks) && isPlainObject(parsedHooks.hooks) ? parsedHooks.hooks : {};
    const nodePath = await fs.realpath(process.execPath);
    const hooksTracked = isGitTracked(repoRoot, ".codex/hooks.json");
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

async function readOptionalRegularFile(filePath: string): Promise<Buffer | null> {
  try {
    return await readRegularFile(filePath);
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
