import { createHash, randomBytes, randomUUID } from "node:crypto";
import { constants, promises as fs } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import type { QueryResult } from "../types.js";

export const MCP_RESULT_ARTIFACT_DIR = ".codex/cache/codexa-mcp-results";
export const MCP_RESULT_ARTIFACT_MAX_BYTES = 1_048_576;
const MCP_RESULT_ARTIFACT_MAX_FILES = 256;
const MCP_RESULT_RECORD_MAX_BYTES = MCP_RESULT_ARTIFACT_MAX_BYTES * 2 + 32_768;
const MCP_RESULT_PRUNE_LOCK_STALE_MS = 30_000;
const MCP_RESULT_PRUNE_LOCK_WAIT_MS = 500;
const MCP_RESULT_IN_PROCESS_LOCK_STALL_MS = 2_000;
const MCP_RESULT_PRUNE_LOCK_NAME = ".prune.lock";
const MCP_RESULT_PRUNE_LOCK_OWNER = "owner.json";
const MCP_RESULT_PRUNE_LOCK_REAPER = "reaper.json";
const MCP_RESULT_LEASE_DIR = ".leases";
const MCP_RESULT_LEASE_STALE_MS = 60_000;
const MCP_RESULT_LEASE_HEARTBEAT_MS = 10_000;
const MCP_RESULT_LEASE_MAX_FILES = 256;
const MCP_RESULT_LEASE_MAX_BYTES = 32_768;
const MCP_RESULT_ID_PATTERN = /^mr_[a-f0-9]{64}$/u;
const MCP_RESULT_REPO_LOCATOR_PATTERN = /^rr_[a-f0-9]{32}$/u;
const MCP_RESULT_SESSION_ID_PATTERN = /^ms_[a-f0-9]{32}$/u;
const MCP_RESULT_LOCK_TOKEN_PATTERN = /^ml_[a-f0-9]{32}$/u;
const MCP_RESULT_ROUTER_MAX_ROOTS = 256;
const MCP_RESULT_IN_PROCESS_LOCK_MAX_WAITERS = MCP_RESULT_ARTIFACT_MAX_FILES - 1;
const inProcessPruneLocks = new Map<string, InProcessPruneLock>();

export interface McpResultArtifactReference {
  id: string;
  uri: string;
  byteLength: number;
}

export interface McpResultArtifactBinding {
  tool: string;
  checkout: {
    repoRoot: string;
    gitHead?: string | null;
    routingSource?: string;
    workspaceSessionId?: string;
  };
  freshness: {
    snapshotId?: string;
    headCommit?: string | null;
    indexedAt?: string;
    missing?: boolean;
    stale?: boolean;
    reason?: string;
  };
}

interface McpResultArtifactRouteEntry {
  repoRoot: string;
  locator: string;
  pending: number;
  committed: boolean;
}

export interface McpResultArtifactRouter {
  readonly sessionId: string;
  reserve(repoRoot: string): string | undefined;
  complete(repoRoot: string, locator: string, promised: boolean): void;
  resolve(locator: string): string | undefined;
  activateLease(directory: string): Promise<boolean>;
  close(): Promise<void>;
}

interface StoredMcpResultArtifact {
  schemaVersion: 1;
  id: string;
  /** Advisory retention metadata; integrity authority is the hashed binding + payload below. */
  firstObservedAt: string;
  tool: string;
  storageRepoRoot: string;
  checkout: McpResultArtifactBinding["checkout"];
  freshness: McpResultArtifactBinding["freshness"];
  byteLength: number;
  payload: string;
}

interface StoredMcpResultLease {
  schemaVersion: 1;
  sessionId: string;
  pid: number;
  processStartToken?: string;
  createdAt: string;
  ids: string[];
}

interface StoredMcpResultLockOwner {
  schemaVersion: 1;
  token: string;
  pid: number;
  processStartToken?: string;
  acquiredAt: string;
}

interface InProcessPruneLockWaiter {
  resolve: (release: InProcessPruneLockRelease) => void;
  reject: (error: Error) => void;
}

interface InProcessPruneLock {
  waiters: InProcessPruneLockWaiter[];
  stallTimer?: ReturnType<typeof setTimeout>;
}

type InProcessPruneLockRelease = (acquisitionFailure?: Error) => void;

export async function persistMcpResultArtifact(
  repoRoot: string,
  result: QueryResult,
  binding: McpResultArtifactBinding,
  router: McpResultArtifactRouter,
  protectedIds: ReadonlySet<string> = new Set()
): Promise<McpResultArtifactReference> {
  const payload = JSON.stringify(result);
  const byteLength = Buffer.byteLength(payload, "utf8");
  if (byteLength > MCP_RESULT_ARTIFACT_MAX_BYTES) {
    throw new Error(`MCP detailed result exceeds the ${MCP_RESULT_ARTIFACT_MAX_BYTES}-byte artifact limit`);
  }
  const { directory, repoReal } = await ensureMcpResultArtifactDir(repoRoot);
  const repoLocator = router.reserve(repoReal);
  if (!repoLocator) {
    throw new Error("Codexa MCP detailed-result routing capacity is exhausted; retain only a bounded self-contained decision receipt and block if it requires omitted detail");
  }
  let promised = false;
  try {
    const identity = {
      schemaVersion: 1 as const,
      tool: binding.tool,
      storageRepoRoot: repoReal,
      checkout: boundedBindingCheckout(binding.checkout),
      freshness: boundedBindingFreshness(binding.freshness),
      byteLength,
      payload
    };
    const id = `mr_${createHash("sha256").update(JSON.stringify(identity)).digest("hex")}`;
    const record: StoredMcpResultArtifact = { ...identity, id, firstObservedAt: new Date().toISOString() };
    const filePath = artifactPath(directory, id);
    const release = await acquirePruneLock(directory);
    let created = false;
    try {
      await cleanupStaleMcpResultTemps(directory);
      await validateArtifactDirectory(directory, repoReal);
      created = await atomicWriteIfAbsent(filePath, JSON.stringify(record));
      await validateArtifactDirectory(directory, repoReal);
      if (!created) {
        const existing = await readStoredMcpResultArtifact(filePath);
        validateStoredMcpResultArtifact(existing, id, repoReal);
        if (existing.payload !== payload || existing.tool !== binding.tool) {
          throw new Error(`Existing Codexa MCP result does not match its content address: ${id}`);
        }
      }
      // The repo-scoped lock defines one cross-process recency and pin order.
      // A URI is emitted only after this session's durable lease contains the
      // digest, so concurrent servers cannot prune a live promise.
      void protectedIds;
      await pinAndPruneMcpResultArtifactsLocked(directory, repoReal, id, router.sessionId);
    } catch (maintenanceError) {
      // Never leave an unpromised record created by a failed issuance. Do not
      // remove a pre-existing digest because an earlier successful call may
      // still have promised it.
      if (created) await fs.rm(filePath, { force: true }).catch(() => undefined);
      throw maintenanceError;
    } finally {
      await release();
    }
    if (!(await router.activateLease(directory))) {
      throw new Error("Codexa MCP detailed-result session closed before the resource URI could be promised; retain only a bounded self-contained decision receipt and block if it requires omitted detail");
    }
    const reference = { id, uri: mcpResultArtifactUri(repoLocator, id), byteLength };
    promised = true;
    return reference;
  } finally {
    router.complete(repoReal, repoLocator, promised);
  }
}

export async function readMcpResultArtifact(repoRoot: string, id: string): Promise<string> {
  requireMcpResultArtifactId(id);
  const { directory, repoReal } = await ensureMcpResultArtifactDir(repoRoot);
  await validateArtifactDirectory(directory, repoReal);
  const filePath = artifactPath(directory, id);
  const record = await readStoredMcpResultArtifact(filePath);
  validateStoredMcpResultArtifact(record, id, repoReal);
  return record.payload;
}

async function readStoredMcpResultArtifact(filePath: string): Promise<StoredMcpResultArtifact> {
  const beforeOpen = await fs.lstat(filePath);
  if (!beforeOpen.isFile()) {
    throw new Error("Codexa MCP result is not a regular file");
  }
  const handle = await fs.open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const loaded = await readBoundedRegularHandle(handle, MCP_RESULT_RECORD_MAX_BYTES);
    if (!loaded) {
      throw new Error("Codexa MCP result record is invalid or exceeds its byte limit");
    }
    const parsed: unknown = JSON.parse(loaded.text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Codexa MCP result record is malformed");
    }
    return parsed as StoredMcpResultArtifact;
  } finally {
    await handle.close();
  }
}

export function mcpResultArtifactUri(repoLocator: string, id: string): string {
  requireMcpResultArtifactRepoLocator(repoLocator);
  requireMcpResultArtifactId(id);
  return `codexa://repo/mcp-results/${repoLocator}/${id}`;
}

export function requireMcpResultArtifactId(id: string): void {
  if (!MCP_RESULT_ID_PATTERN.test(id)) {
    throw new Error(`Invalid Codexa MCP result id: ${id}`);
  }
}

export function rememberProtectedMcpResultId(ids: Set<string>, id: string, limit = 64): void {
  ids.delete(id);
  ids.add(id);
  while (ids.size > limit) {
    const oldest = ids.values().next().value;
    if (typeof oldest !== "string") break;
    ids.delete(oldest);
  }
}

export function requireMcpResultArtifactRepoLocator(locator: string): void {
  if (!MCP_RESULT_REPO_LOCATOR_PATTERN.test(locator)) {
    throw new Error("Invalid Codexa MCP result repository locator");
  }
}

/**
 * A server-scoped registry gives result URIs a fixed-size opaque route without
 * disclosing checkout paths. Committed roots are never evicted: once the
 * bounded root capacity is reached, callers must not emit a URI that could
 * later become unreadable. They may retain a bounded self-contained decision
 * receipt, but must block whenever safe action requires omitted detail.
 */
export function createMcpResultArtifactRouter(maxRoots = MCP_RESULT_ROUTER_MAX_ROOTS): McpResultArtifactRouter {
  if (!Number.isInteger(maxRoots) || maxRoots < 1 || maxRoots > MCP_RESULT_ROUTER_MAX_ROOTS) {
    throw new Error(`MCP result router capacity must be between 1 and ${MCP_RESULT_ROUTER_MAX_ROOTS}`);
  }
  const sessionId = `ms_${randomBytes(16).toString("hex")}`;
  const byRoot = new Map<string, McpResultArtifactRouteEntry>();
  const byLocator = new Map<string, McpResultArtifactRouteEntry>();
  const activeDirectories = new Set<string>();
  const drainWaiters = new Set<() => void>();
  let pendingIssuances = 0;
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  let closed = false;
  let closePromise: Promise<void> | undefined;
  const router: McpResultArtifactRouter = {
    sessionId,
    reserve(repoRoot) {
      if (closed) return undefined;
      const existing = byRoot.get(repoRoot);
      if (existing) {
        existing.pending += 1;
        pendingIssuances += 1;
        return existing.locator;
      }
      if (byRoot.size >= maxRoots) return undefined;
      let locator: string;
      do locator = `rr_${randomBytes(16).toString("hex")}`;
      while (byLocator.has(locator));
      const entry = { repoRoot, locator, pending: 1, committed: false };
      byRoot.set(repoRoot, entry);
      byLocator.set(locator, entry);
      pendingIssuances += 1;
      return locator;
    },
    complete(repoRoot, locator, didPromise) {
      const entry = byRoot.get(repoRoot);
      if (!entry || entry.locator !== locator) return;
      entry.pending = Math.max(0, entry.pending - 1);
      pendingIssuances = Math.max(0, pendingIssuances - 1);
      entry.committed ||= didPromise;
      if (!entry.committed && entry.pending === 0) {
        byRoot.delete(repoRoot);
        byLocator.delete(locator);
      }
      if (pendingIssuances === 0) {
        for (const resolve of drainWaiters) resolve();
        drainWaiters.clear();
      }
    },
    resolve(locator) {
      requireMcpResultArtifactRepoLocator(locator);
      return byLocator.get(locator)?.repoRoot;
    },
    async activateLease(directory) {
      if (closed && pendingIssuances === 0) {
        await releaseMcpResultLease(directory, sessionId);
        return false;
      }
      activeDirectories.add(directory);
      if (!heartbeatTimer) {
        heartbeatTimer = setInterval(() => {
          for (const activeDirectory of activeDirectories) {
            void heartbeatMcpResultLease(activeDirectory, sessionId).catch(() => undefined);
          }
        }, MCP_RESULT_LEASE_HEARTBEAT_MS);
        heartbeatTimer.unref?.();
      }
      return true;
    },
    close() {
      closePromise ??= (async () => {
        closed = true;
        if (pendingIssuances > 0) {
          await new Promise<void>((resolve) => drainWaiters.add(resolve));
        }
        if (heartbeatTimer) clearInterval(heartbeatTimer);
        heartbeatTimer = undefined;
        const directories = [...activeDirectories];
        activeDirectories.clear();
        await Promise.all(directories.map((directory) => releaseMcpResultLease(directory, sessionId)));
        byRoot.clear();
        byLocator.clear();
      })();
      return closePromise;
    }
  };
  return router;
}

async function ensureMcpResultArtifactDir(repoRoot: string): Promise<{ directory: string; repoReal: string }> {
  const repoReal = await fs.realpath(repoRoot).catch(() => "");
  if (!repoReal) {
    throw new Error("MCP result repository root does not exist");
  }
  const repoStat = await fs.lstat(repoReal);
  if (!repoStat.isDirectory()) {
    throw new Error("MCP result repository root is not a directory");
  }
  let parent = repoReal;
  for (const component of MCP_RESULT_ARTIFACT_DIR.split("/")) {
    const next = path.join(parent, component);
    const existing = await fs.lstat(next).catch((error: unknown) => {
      if (errorCode(error) === "ENOENT") return undefined;
      throw error;
    });
    if (!existing) {
      // Validate every existing ancestor before creating the next component;
      // recursive mkdir would otherwise traverse a symlinked .codex first.
      await validateArtifactDirectory(parent, repoReal);
      await fs.mkdir(next, { mode: 0o700 }).catch((error: unknown) => {
        if (errorCode(error) !== "EEXIST") throw error;
      });
    }
    await validateArtifactDirectory(next, repoReal);
    parent = next;
  }
  const directory = parent;
  await fs.chmod(directory, 0o700).catch(() => undefined);
  await validateArtifactDirectory(directory, repoReal);
  return { directory, repoReal };
}

async function validateArtifactDirectory(directory: string, repoReal: string): Promise<void> {
  const stat = await fs.lstat(directory);
  const directoryReal = await fs.realpath(directory);
  const relative = path.relative(repoReal, directoryReal);
  if (!stat.isDirectory() || stat.isSymbolicLink() || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("MCP result artifact directory escapes the repository or traverses a symbolic link");
  }
}

function artifactPath(directory: string, id: string): string {
  requireMcpResultArtifactId(id);
  return path.join(directory, `${id}.json`);
}

async function atomicWriteIfAbsent(filePath: string, payload: string): Promise<boolean> {
  const temp = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temp, payload, { encoding: "utf8", flag: "wx", mode: 0o600 });
    try {
      await fs.link(temp, filePath);
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code) : "";
      if (code !== "EEXIST") {
        throw error;
      }
      return false;
    }
    return true;
  } finally {
    await fs.rm(temp, { force: true }).catch(() => undefined);
  }
}

async function pinAndPruneMcpResultArtifactsLocked(directory: string, repoReal: string, currentId: string, sessionId: string): Promise<void> {
  requireMcpResultSessionId(sessionId);
  const leaseDirectory = await ensureMcpResultLeaseDirectory(directory, repoReal);
  const leases = await loadLiveMcpResultLeasesLocked(leaseDirectory);
  const ownLease = leases.find((lease) => lease.sessionId === sessionId);
  if (!ownLease && leases.length >= MCP_RESULT_LEASE_MAX_FILES) {
    throw new Error("Codexa MCP detailed-result live-session capacity is exhausted; retain only a bounded self-contained decision receipt and block if it requires omitted detail");
  }
  const pinnedIds = new Set(leases.flatMap((lease) => lease.ids));
  if (!pinnedIds.has(currentId) && pinnedIds.size >= MCP_RESULT_ARTIFACT_MAX_FILES) {
    throw new Error("Codexa MCP detailed-result live retention capacity is exhausted; retain only a bounded self-contained decision receipt and block if it requires omitted detail");
  }

  const names = await artifactRecordNames(directory);
  const observed = await Promise.all(
    names.map(async (name) => {
      const id = name.slice(0, -".json".length);
      const stat = await fs.lstat(path.join(directory, name)).catch(() => undefined);
      return { id, name, stat };
    })
  );
  for (const entry of observed) {
    if (entry.stat?.isFile()) continue;
    if (entry.id === currentId || pinnedIds.has(entry.id)) {
      throw new Error(`Pinned Codexa MCP result is not a regular file: ${entry.id}`);
    }
    const entryPath = path.join(directory, entry.name);
    if (entry.stat?.isDirectory() && !entry.stat.isSymbolicLink()) await fs.rm(entryPath, { recursive: true, force: true });
    else await fs.unlink(entryPath).catch((error: unknown) => {
      if (errorCode(error) !== "ENOENT") throw error;
    });
  }
  const candidates = observed
    .filter((entry): entry is typeof entry & { stat: NonNullable<typeof entry.stat> } => Boolean(entry.stat?.isFile()))
    .map(({ id, name, stat }) => ({ id, name, mtimeMs: stat.mtimeMs }));
  const candidateIds = new Set(candidates.map((candidate) => candidate.id));
  for (const pinnedId of pinnedIds) {
    if (!candidateIds.has(pinnedId)) {
      throw new Error(`Live Codexa MCP result lease points to a missing record: ${pinnedId}`);
    }
  }
  const newestObservedMtime = candidates.reduce((latest, candidate) => Number.isFinite(candidate.mtimeMs) ? Math.max(latest, candidate.mtimeMs) : latest, 0);
  // Date truncation plus sub-millisecond filesystem mtimes can otherwise
  // collapse adjacent issuances onto one timestamp and let the filename
  // tie-breaker evict a newer digest. Leave a full millisecond of separation
  // beyond the rounded-up newest observation.
  const issuedAt = Math.max(Date.now(), Math.ceil(newestObservedMtime) + 2);
  const current = candidates.find((candidate) => candidate.id === currentId);
  if (!current || !Number.isFinite(current.mtimeMs)) {
    throw new Error(`Current Codexa MCP result disappeared during retention: ${currentId}`);
  }
  await fs.utimes(path.join(directory, current.name), new Date(issuedAt), new Date(issuedAt));
  current.mtimeMs = issuedAt;
  const protectedIds = new Set(pinnedIds).add(currentId);
  let remaining = candidates.length;
  for (const candidate of candidates.sort((left, right) => left.mtimeMs - right.mtimeMs || left.name.localeCompare(right.name))) {
    if (remaining <= MCP_RESULT_ARTIFACT_MAX_FILES) {
      break;
    }
    if (protectedIds.has(candidate.id) || !Number.isFinite(candidate.mtimeMs)) {
      continue;
    }
    await fs.rm(path.join(directory, candidate.name), { force: true });
    remaining -= 1;
  }
  if (remaining > MCP_RESULT_ARTIFACT_MAX_FILES) {
    throw new Error("Codexa MCP detailed-result live retention capacity is exhausted; retain only a bounded self-contained decision receipt and block if it requires omitted detail");
  }

  // Commit the pin only after every fallible retention operation succeeds.
  // From this write onward the caller may safely publish the resource URI.
  const nextIds = [...new Set([...(ownLease?.ids ?? []), currentId])];
  const lease: StoredMcpResultLease = {
    schemaVersion: 1,
    sessionId,
    pid: process.pid,
    processStartToken: await readProcessStartToken(process.pid),
    createdAt: ownLease?.createdAt ?? new Date().toISOString(),
    ids: nextIds
  };
  await atomicReplaceFile(leasePath(leaseDirectory, sessionId), JSON.stringify(lease));
}

async function ensureMcpResultLeaseDirectory(directory: string, repoReal: string): Promise<string> {
  const leaseDirectory = path.join(directory, MCP_RESULT_LEASE_DIR);
  await fs.mkdir(leaseDirectory, { mode: 0o700 }).catch((error: unknown) => {
    if (errorCode(error) !== "EEXIST") throw error;
  });
  await validateArtifactDirectory(leaseDirectory, repoReal);
  await fs.chmod(leaseDirectory, 0o700).catch(() => undefined);
  return leaseDirectory;
}

async function loadLiveMcpResultLeasesLocked(leaseDirectory: string): Promise<StoredMcpResultLease[]> {
  const allNames = await fs.readdir(leaseDirectory);
  const tempNames = allNames.filter((name) => /^ms_[a-f0-9]{32}\.json\.\d+\.[a-f0-9-]{36}\.tmp$/u.test(name));
  if (tempNames.length > MCP_RESULT_LEASE_MAX_FILES) {
    throw new Error("Codexa MCP result lease temp-file cleanup exceeds its bounded scan limit");
  }
  for (const name of tempNames) await fs.rm(path.join(leaseDirectory, name), { force: true });

  const names = allNames.filter((name) => /^ms_[a-f0-9]{32}\.json$/u.test(name));
  if (names.length > MCP_RESULT_LEASE_MAX_FILES) {
    throw new Error("Codexa MCP result lease registry exceeds its hard file bound");
  }
  const live: StoredMcpResultLease[] = [];
  for (const name of names) {
    const filePath = path.join(leaseDirectory, name);
    const expectedSessionId = name.slice(0, -".json".length);
    let loaded: { lease: StoredMcpResultLease; mtimeMs: number } | undefined;
    try {
      loaded = await readStoredMcpResultLease(filePath, expectedSessionId);
    } catch {
      await fs.rm(filePath, { force: true });
      continue;
    }
    const stale = Date.now() - loaded.mtimeMs > MCP_RESULT_LEASE_STALE_MS;
    if (stale && !(await processIdentityIsLive(loaded.lease.pid, loaded.lease.processStartToken))) {
      await fs.rm(filePath, { force: true });
      continue;
    }
    live.push(loaded.lease);
  }
  return live;
}

async function readStoredMcpResultLease(filePath: string, expectedSessionId: string): Promise<{ lease: StoredMcpResultLease; mtimeMs: number }> {
  const beforeOpen = await fs.lstat(filePath);
  if (!beforeOpen.isFile() || beforeOpen.isSymbolicLink() || beforeOpen.size > MCP_RESULT_LEASE_MAX_BYTES) {
    throw new Error("Codexa MCP result lease is invalid");
  }
  const handle = await fs.open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const loaded = await readBoundedRegularHandle(handle, MCP_RESULT_LEASE_MAX_BYTES);
    if (!loaded) {
      throw new Error("Codexa MCP result lease changed while being read");
    }
    const parsed = JSON.parse(loaded.text) as StoredMcpResultLease;
    if (
      parsed.schemaVersion !== 1 ||
      parsed.sessionId !== expectedSessionId ||
      !MCP_RESULT_SESSION_ID_PATTERN.test(parsed.sessionId) ||
      !Number.isSafeInteger(parsed.pid) ||
      parsed.pid < 1 ||
      !isIsoTimestamp(parsed.createdAt) ||
      (parsed.processStartToken !== undefined && (typeof parsed.processStartToken !== "string" || parsed.processStartToken.length > 120)) ||
      !Array.isArray(parsed.ids) ||
      parsed.ids.length > MCP_RESULT_ARTIFACT_MAX_FILES ||
      new Set(parsed.ids).size !== parsed.ids.length ||
      parsed.ids.some((id) => typeof id !== "string" || !MCP_RESULT_ID_PATTERN.test(id))
    ) {
      throw new Error("Codexa MCP result lease metadata is invalid");
    }
    return { lease: parsed, mtimeMs: loaded.mtimeMs };
  } finally {
    await handle.close();
  }
}

function requireMcpResultSessionId(sessionId: string): void {
  if (!MCP_RESULT_SESSION_ID_PATTERN.test(sessionId)) throw new Error("Invalid Codexa MCP result session id");
}

function leasePath(leaseDirectoryOrArtifactDirectory: string, sessionId: string): string {
  requireMcpResultSessionId(sessionId);
  const leaseDirectory = path.basename(leaseDirectoryOrArtifactDirectory) === MCP_RESULT_LEASE_DIR
    ? leaseDirectoryOrArtifactDirectory
    : path.join(leaseDirectoryOrArtifactDirectory, MCP_RESULT_LEASE_DIR);
  return path.join(leaseDirectory, `${sessionId}.json`);
}

async function heartbeatMcpResultLease(directory: string, sessionId: string): Promise<void> {
  const filePath = leasePath(directory, sessionId);
  const handle = await fs.open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch((error: unknown) => {
    if (errorCode(error) === "ENOENT") return undefined;
    throw error;
  });
  if (!handle) return;
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) return;
    const now = new Date();
    await handle.utimes(now, now);
  } finally {
    await handle.close();
  }
}

async function releaseMcpResultLease(directory: string, sessionId: string): Promise<void> {
  await fs.unlink(leasePath(directory, sessionId)).catch((error: unknown) => {
    if (errorCode(error) !== "ENOENT") throw error;
  });
}

async function atomicReplaceFile(filePath: string, payload: string): Promise<void> {
  const temp = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temp, payload, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await fs.rename(temp, filePath);
  } finally {
    await fs.rm(temp, { force: true }).catch(() => undefined);
  }
}

async function cleanupStaleMcpResultTemps(directory: string): Promise<void> {
  const names = (await fs.readdir(directory)).filter((name) => /^mr_[a-f0-9]{64}\.json\.\d+\.[a-f0-9-]{36}\.tmp$/u.test(name));
  if (names.length > MCP_RESULT_ARTIFACT_MAX_FILES * 2) {
    throw new Error("Codexa MCP result temp-file cleanup exceeds its bounded scan limit");
  }
  const staleBefore = Date.now() - MCP_RESULT_PRUNE_LOCK_STALE_MS;
  for (const name of names) {
    const tempPath = path.join(directory, name);
    const stat = await fs.lstat(tempPath).catch(() => undefined);
    if (!stat || stat.mtimeMs >= staleBefore) continue;
    if (stat.isDirectory() && !stat.isSymbolicLink()) await fs.rmdir(tempPath).catch(() => undefined);
    else await fs.unlink(tempPath).catch((error: unknown) => {
      if (errorCode(error) !== "ENOENT") throw error;
    });
  }
}

async function artifactRecordNames(directory: string): Promise<string[]> {
  return (await fs.readdir(directory)).filter((name) => /^mr_[a-f0-9]{64}\.json$/u.test(name));
}

async function acquirePruneLock(directory: string): Promise<() => Promise<void>> {
  const releaseInProcess = await acquireInProcessPruneLock(directory);
  let releaseFilesystem: (() => Promise<void>) | undefined;
  try {
    releaseFilesystem = await acquireFilesystemPruneLock(directory);
  } catch (error) {
    releaseInProcess(error instanceof Error ? error : new Error(String(error)));
    throw error;
  }

  let released = false;
  return async () => {
    if (released) return;
    released = true;
    try {
      await releaseFilesystem();
    } finally {
      releaseInProcess();
    }
  };
}

/**
 * Serialize callers already sharing this process before they contend on the
 * cross-process directory lock. The filesystem timeout therefore measures a
 * genuinely foreign holder, not useful work queued in this process. One
 * progress timer per directory rejects bounded waiters only when the active
 * local holder stops handing off, so normal bursts add no polling.
 */
async function acquireInProcessPruneLock(directory: string): Promise<InProcessPruneLockRelease> {
  const existing = inProcessPruneLocks.get(directory);
  if (!existing) {
    const lock: InProcessPruneLock = { waiters: [] };
    inProcessPruneLocks.set(directory, lock);
    return inProcessPruneLockRelease(directory, lock);
  }
  if (existing.waiters.length >= MCP_RESULT_IN_PROCESS_LOCK_MAX_WAITERS) {
    throw new Error("Codexa MCP result in-process retention queue is full; retain only a bounded self-contained decision receipt and block if it requires omitted detail");
  }
  return new Promise<InProcessPruneLockRelease>((resolve, reject) => {
    existing.waiters.push({ resolve, reject });
    armInProcessPruneLockStallTimer(existing);
  });
}

function inProcessPruneLockRelease(directory: string, lock: InProcessPruneLock): InProcessPruneLockRelease {
  let released = false;
  return (acquisitionFailure) => {
    if (released) return;
    released = true;
    if (lock.stallTimer) clearTimeout(lock.stallTimer);
    lock.stallTimer = undefined;
    if (acquisitionFailure) {
      const waiters = lock.waiters.splice(0);
      for (const waiter of waiters) waiter.reject(acquisitionFailure);
      if (inProcessPruneLocks.get(directory) === lock) inProcessPruneLocks.delete(directory);
      return;
    }
    const next = lock.waiters.shift();
    if (!next) {
      if (inProcessPruneLocks.get(directory) === lock) inProcessPruneLocks.delete(directory);
      return;
    }
    next.resolve(inProcessPruneLockRelease(directory, lock));
    armInProcessPruneLockStallTimer(lock);
  };
}

function armInProcessPruneLockStallTimer(lock: InProcessPruneLock): void {
  if (lock.stallTimer || lock.waiters.length === 0) return;
  lock.stallTimer = setTimeout(() => {
    lock.stallTimer = undefined;
    const waiters = lock.waiters.splice(0);
    for (const waiter of waiters) {
      waiter.reject(new Error("Timed out waiting for in-process Codexa MCP result retention progress"));
    }
    // The active holder still owns the filesystem lock. Keep its one bounded
    // map entry until release rather than allowing a second local owner.
  }, MCP_RESULT_IN_PROCESS_LOCK_STALL_MS);
}

async function acquireFilesystemPruneLock(directory: string): Promise<() => Promise<void>> {
  const lockPath = path.join(directory, MCP_RESULT_PRUNE_LOCK_NAME);
  const ownerPath = path.join(lockPath, MCP_RESULT_PRUNE_LOCK_OWNER);
  const deadline = Date.now() + MCP_RESULT_PRUNE_LOCK_WAIT_MS;
  const owner: StoredMcpResultLockOwner = {
    schemaVersion: 1,
    token: `ml_${randomBytes(16).toString("hex")}`,
    pid: process.pid,
    processStartToken: await readProcessStartToken(process.pid),
    acquiredAt: new Date().toISOString()
  };
  while (true) {
    try {
      await fs.mkdir(lockPath, { mode: 0o700 });
      try {
        await fs.writeFile(ownerPath, JSON.stringify(owner), { encoding: "utf8", flag: "wx", mode: 0o600 });
      } catch (error) {
        await fs.rm(lockPath, { recursive: true, force: true }).catch(() => undefined);
        throw error;
      }
      if (!(await waitForCanonicalPruneLockOwnership(lockPath, owner.token, deadline))) continue;
      return async () => releaseOwnedPruneLock(lockPath, owner.token);
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
      const stat = await fs.lstat(lockPath).catch(() => undefined);
      if (stat?.isDirectory() && Date.now() - stat.mtimeMs > MCP_RESULT_PRUNE_LOCK_STALE_MS) {
        const currentOwner = await readStoredMcpResultLockOwner(ownerPath);
        if (!currentOwner || !(await processIdentityIsLive(currentOwner.pid, currentOwner.processStartToken))) {
          const reaped = await reapUnownedPruneLock(lockPath, currentOwner);
          if (reaped) continue;
        }
      }
      if (Date.now() >= deadline) {
        throw new Error("Timed out waiting for the Codexa MCP result retention lock");
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}

async function waitForCanonicalPruneLockOwnership(lockPath: string, token: string, deadline: number): Promise<boolean> {
  const ownerPath = path.join(lockPath, MCP_RESULT_PRUNE_LOCK_OWNER);
  const markerPath = path.join(lockPath, MCP_RESULT_PRUNE_LOCK_REAPER);
  while (true) {
    const owner = await readStoredMcpResultLockOwner(ownerPath);
    if (owner?.token !== token) return false;
    const reaper = await fs.lstat(markerPath).catch((error: unknown) => {
      if (errorCode(error) === "ENOENT") return undefined;
      throw error;
    });
    if (!reaper) return true;
    if (Date.now() >= deadline) {
      await releaseOwnedPruneLock(lockPath, token);
      return false;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/**
 * Claim stale-lock cleanup from inside the directory before renaming it.
 * The exclusive marker prevents the previous owner from removing the old
 * directory and a new live owner from appearing at the same pathname between
 * the ownership check and rename (the classic stale-lock ABA race). A process
 * crash in this tiny cleanup window intentionally leaves a bounded marker and
 * makes callers retain only a bounded self-contained decision receipt rather
 * than risking a promised result; omitted required detail remains blocking.
 */
async function reapUnownedPruneLock(lockPath: string, observedOwner: StoredMcpResultLockOwner | undefined): Promise<boolean> {
  const markerPath = path.join(lockPath, MCP_RESULT_PRUNE_LOCK_REAPER);
  const markerToken = `ml_${randomBytes(16).toString("hex")}`;
  try {
    await fs.writeFile(markerPath, markerToken, { encoding: "utf8", flag: "wx", mode: 0o600 });
  } catch (error) {
    if (errorCode(error) === "EEXIST" || errorCode(error) === "ENOENT") return false;
    throw error;
  }

  let renamed = false;
  try {
    const currentOwner = await readStoredMcpResultLockOwner(path.join(lockPath, MCP_RESULT_PRUNE_LOCK_OWNER));
    if (currentOwner?.token !== observedOwner?.token) return false;
    if (currentOwner && await processIdentityIsLive(currentOwner.pid, currentOwner.processStartToken)) return false;
    if (await readSmallRegularFile(markerPath, 128) !== markerToken) return false;

    const tombstone = `${lockPath}.stale.${randomUUID()}`;
    try {
      await fs.rename(lockPath, tombstone);
      renamed = true;
    } catch (error) {
      if (errorCode(error) === "ENOENT") return false;
      throw error;
    }
    await fs.rm(tombstone, { recursive: true, force: true });
    return true;
  } finally {
    if (!renamed) {
      await removeOwnedReaperMarker(markerPath, markerToken);
    }
  }
}

async function removeOwnedReaperMarker(markerPath: string, markerToken: string): Promise<void> {
  const existing = await readSmallRegularFile(markerPath, 128);
  if (existing !== markerToken) return;
  await fs.unlink(markerPath).catch((error: unknown) => {
    if (errorCode(error) !== "ENOENT") throw error;
  });
}

async function readStoredMcpResultLockOwner(ownerPath: string): Promise<StoredMcpResultLockOwner | undefined> {
  try {
    const text = await readSmallRegularFile(ownerPath, 2_048);
    if (text === undefined) return undefined;
    const parsed = JSON.parse(text) as StoredMcpResultLockOwner;
    if (
      parsed.schemaVersion !== 1 ||
      !MCP_RESULT_LOCK_TOKEN_PATTERN.test(parsed.token) ||
      !Number.isSafeInteger(parsed.pid) ||
      parsed.pid < 1 ||
      !isIsoTimestamp(parsed.acquiredAt) ||
      (parsed.processStartToken !== undefined && (typeof parsed.processStartToken !== "string" || parsed.processStartToken.length > 120))
    ) {
      return undefined;
    }
    return parsed;
  } catch {
    return undefined;
  }
}

async function readSmallRegularFile(filePath: string, maxBytes: number): Promise<string | undefined> {
  try {
    const handle = await fs.open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      return (await readBoundedRegularHandle(handle, maxBytes))?.text;
    } finally {
      await handle.close();
    }
  } catch {
    return undefined;
  }
}

async function readBoundedRegularHandle(handle: FileHandle, maxBytes: number): Promise<{ text: string; mtimeMs: number } | undefined> {
  const before = await handle.stat();
  if (!before.isFile() || before.size > maxBytes) return undefined;
  const buffer = Buffer.alloc(maxBytes + 1);
  let bytesRead = 0;
  while (bytesRead < buffer.length) {
    const result = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
    if (result.bytesRead === 0) break;
    bytesRead += result.bytesRead;
  }
  const after = await handle.stat();
  if (bytesRead !== before.size || after.size !== before.size || bytesRead > maxBytes) return undefined;
  const text = buffer.subarray(0, bytesRead).toString("utf8");
  if (Buffer.byteLength(text, "utf8") !== bytesRead) return undefined;
  return { text, mtimeMs: before.mtimeMs };
}

async function releaseOwnedPruneLock(lockPath: string, token: string): Promise<void> {
  const ownerPath = path.join(lockPath, MCP_RESULT_PRUNE_LOCK_OWNER);
  const owner = await readStoredMcpResultLockOwner(ownerPath);
  if (owner?.token !== token) return;
  await fs.unlink(ownerPath).catch(() => undefined);
  await fs.rmdir(lockPath).catch(() => undefined);
}

async function readProcessStartToken(pid: number): Promise<string | undefined> {
  if (process.platform !== "linux") return undefined;
  try {
    const value = await fs.readFile(`/proc/${pid}/stat`, "utf8");
    const closeParen = value.lastIndexOf(")");
    if (closeParen < 0) return undefined;
    // Fields after the command start at proc field 3; starttime is field 22.
    const startTime = value.slice(closeParen + 1).trim().split(/\s+/u)[19];
    return startTime ? `linux:${startTime}` : undefined;
  } catch {
    return undefined;
  }
}

async function processIdentityIsLive(pid: number, expectedStartToken?: string): Promise<boolean> {
  const currentStartToken = await readProcessStartToken(pid);
  if (expectedStartToken && currentStartToken) return expectedStartToken === currentStartToken;
  if (process.platform === "linux" && !currentStartToken) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) === "EPERM";
  }
}

function errorCode(error: unknown): string {
  return error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code) : "";
}

function validateStoredMcpResultArtifact(record: StoredMcpResultArtifact, id: string, repoReal: string): void {
  if (
    record.schemaVersion !== 1 ||
    record.id !== id ||
    record.storageRepoRoot !== repoReal ||
    typeof record.tool !== "string" ||
    !isIsoTimestamp(record.firstObservedAt) ||
    typeof record.payload !== "string" ||
    typeof record.byteLength !== "number" ||
    !record.checkout ||
    !record.freshness
  ) {
    throw new Error(`Codexa MCP result metadata is invalid: ${id}`);
  }
  const byteLength = Buffer.byteLength(record.payload, "utf8");
  if (byteLength !== record.byteLength || byteLength > MCP_RESULT_ARTIFACT_MAX_BYTES) {
    throw new Error(`Codexa MCP result payload violates its byte contract: ${id}`);
  }
  const identity = {
    schemaVersion: record.schemaVersion,
    tool: record.tool,
    storageRepoRoot: record.storageRepoRoot,
    checkout: record.checkout,
    freshness: record.freshness,
    byteLength: record.byteLength,
    payload: record.payload
  };
  const expectedId = `mr_${createHash("sha256").update(JSON.stringify(identity)).digest("hex")}`;
  if (expectedId !== id) {
    throw new Error(`Codexa MCP result failed its content-address check: ${id}`);
  }
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) return false;
  return new Date(value).toISOString() === value;
}

function boundedBindingCheckout(value: McpResultArtifactBinding["checkout"]): McpResultArtifactBinding["checkout"] {
  return {
    repoRoot: value.repoRoot.slice(0, 1_000),
    gitHead: typeof value.gitHead === "string" ? value.gitHead.slice(0, 160) : value.gitHead,
    routingSource: value.routingSource?.slice(0, 120),
    workspaceSessionId: value.workspaceSessionId?.slice(0, 160)
  };
}

function boundedBindingFreshness(value: McpResultArtifactBinding["freshness"]): McpResultArtifactBinding["freshness"] {
  return {
    snapshotId: value.snapshotId?.slice(0, 160),
    headCommit: typeof value.headCommit === "string" ? value.headCommit.slice(0, 160) : value.headCommit,
    indexedAt: value.indexedAt?.slice(0, 100),
    missing: value.missing,
    stale: value.stale,
    reason: value.reason?.slice(0, 240)
  };
}
