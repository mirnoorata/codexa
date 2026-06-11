import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

export interface CacheLockOwner {
  pid: number;
  token: string;
  processStartTime?: string | null;
  startedAt: string;
  heartbeatAt: string;
  repoRoot: string;
}

export interface CacheLockOptions {
  repoRoot: string;
  lockDir: string;
  staleMs?: number;
  timeoutMs?: number;
  label?: string;
}

const DEFAULT_LOCK_STALE_MS = 120_000;
const DEFAULT_LOCK_TIMEOUT_MS = 30_000;
// A live-looking owner is never stolen for a transient stall, but if its
// heartbeat freezes for this multiple of staleMs it is treated as unrecoverable
// (wedged holder, or a recycled PID whose new owner does not update this lock's
// heartbeat) and reclaimed. Far longer than any plausible GC/swap/SIGSTOP pause.
const HARD_RECLAIM_HEARTBEAT_MULTIPLIER = 8;

export async function acquireCacheLock(options: CacheLockOptions): Promise<() => Promise<void>> {
  const repoRoot = path.resolve(options.repoRoot);
  const lockDir = path.isAbsolute(options.lockDir) ? options.lockDir : path.join(repoRoot, options.lockDir);
  const ownerPath = path.join(lockDir, "owner.json");
  const staleMs = positiveInt(options.staleMs, DEFAULT_LOCK_STALE_MS);
  const timeoutMs = positiveInt(options.timeoutMs, DEFAULT_LOCK_TIMEOUT_MS);
  const label = options.label ?? "Codexa cache";
  const started = Date.now();
  const owner: CacheLockOwner = {
    pid: process.pid,
    token: randomUUID(),
    processStartTime: await currentProcessStartTime(process.pid),
    startedAt: new Date().toISOString(),
    heartbeatAt: new Date().toISOString(),
    repoRoot
  };

  await fs.mkdir(path.dirname(lockDir), { recursive: true });
  while (true) {
    try {
      await fs.mkdir(lockDir, { recursive: false });
      await writeLockOwner(ownerPath, owner);
      const heartbeat = setInterval(() => {
        void renewLockOwner(ownerPath, owner).catch(() => undefined);
      }, Math.max(10_000, Math.floor(staleMs / 3)));
      heartbeat.unref?.();
      return async () => {
        clearInterval(heartbeat);
        await removeLockIfOwned(lockDir, owner).catch(() => undefined);
      };
    } catch (error) {
      if (!isNodeError(error) || error.code !== "EEXIST") {
        throw error;
      }
      if (await removeStaleLock(lockDir, staleMs)) {
        continue;
      }
      if (Date.now() - started > timeoutMs) {
        throw new Error(`Timed out waiting for ${label} lock: ${lockDir}`);
      }
      await sleep(250);
    }
  }
}

async function removeStaleLock(lockDir: string, staleMs: number): Promise<boolean> {
  const ownerPath = path.join(lockDir, "owner.json");
  try {
    const stat = await fs.stat(lockDir);
    const owner = await readLockOwner(ownerPath);
    if (owner) {
      // Reclaim a lock whose owning process is provably gone. A live process
      // with a briefly stale heartbeat may merely be stalled (GC, swap,
      // SIGSTOP, blocked event loop) and resume into its critical section;
      // stealing it would let two processes hold the lock — the corruption
      // this lock exists to prevent — so do not reclaim it for a short stall.
      if (!(await lockOwnerStillRunning(owner))) {
        return claimAndRemoveOwnerLock(lockDir, owner);
      }
      // ...but a lock whose owner.json has not been rewritten far beyond any
      // plausible pause means the holder is wedged, or the PID was recycled by an
      // unrelated process not updating this lock. Freshness is measured by the
      // owner.json file mtime, which every heartbeat bumps (write-temp + rename):
      // the filesystem sets it on actual write activity, independent of the
      // holder's clock or heartbeat *content*, so a live, actively-heart-beating
      // holder is never stolen while a frozen one is reclaimed even if its content
      // timestamp is future-dated or corrupt. Double-check at claim time so a
      // holder that refreshed just before our rename keeps the lock.
      const ceilingMs = staleMs * HARD_RECLAIM_HEARTBEAT_MULTIPLIER;
      const ownerMtimeMs = await fileMtimeMs(ownerPath);
      if (ownerMtimeMs !== undefined && Date.now() - ownerMtimeMs > ceilingMs) {
        const reclaimed = await claimAndRemoveOwnerLock(lockDir, owner, ceilingMs);
        if (reclaimed) {
          console.error(`codexa: reclaimed a stuck cache lock (owner pid ${owner.pid}, not refreshed > ${Math.round(ceilingMs / 1000)}s): ${lockDir}`);
        }
        return reclaimed;
      }
      return false;
    }
    if (Date.now() - stat.mtimeMs <= staleMs) {
      return false;
    }
    await fs.rm(lockDir, { recursive: true, force: true });
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return true;
    }
    return false;
  }
}

async function claimAndRemoveOwnerLock(lockDir: string, expectedOwner: CacheLockOwner, ceilingMs?: number): Promise<boolean> {
  const ownerPath = path.join(lockDir, "owner.json");
  const claimedOwnerPath = path.join(lockDir, `owner.json.claimed-${process.pid}-${randomUUID()}`);
  try {
    await fs.rename(ownerPath, claimedOwnerPath);
  } catch (error) {
    return isNodeError(error) && error.code === "ENOENT";
  }
  const claimed = await readLockOwner(claimedOwnerPath);
  if (claimed?.token !== expectedOwner.token || claimed.pid !== expectedOwner.pid) {
    await restoreClaimedOwner(ownerPath, claimedOwnerPath);
    return false;
  }
  // For a ceiling reclaim, re-confirm against the claimed file's preserved mtime
  // (rename keeps it) that the holder really did not refresh within the ceiling.
  // A holder that rewrote owner.json just before our rename shows a fresh mtime
  // and must be left alone. The dead-process path passes no ceiling and removes
  // unconditionally after the token check.
  if (ceilingMs !== undefined) {
    const claimedMtimeMs = await fileMtimeMs(claimedOwnerPath);
    if (claimedMtimeMs === undefined || Date.now() - claimedMtimeMs <= ceilingMs) {
      await restoreClaimedOwner(ownerPath, claimedOwnerPath);
      return false;
    }
  }
  // TOCTOU guard: the claim renamed owner.json aside, so ownerPath is now absent.
  // A holder we mean to reclaim is wedged/dead and writes no heartbeats, so it
  // stays absent. If a fresh owner.json has reappeared, the holder resumed and
  // recreated it between the claim and now — abort rather than fs.rm the live
  // holder's lock dir (which would let two processes hold the lock). The atomic
  // rename of owner.json is the only thing acting as the claim token; a heartbeat
  // written after it is reliably observed here because rename is atomic.
  if (await readLockOwner(ownerPath)) {
    await fs.rm(claimedOwnerPath, { force: true }).catch(() => undefined);
    return false;
  }
  await fs.rm(lockDir, { recursive: true, force: true });
  return true;
}

async function restoreClaimedOwner(ownerPath: string, claimedOwnerPath: string): Promise<void> {
  try {
    await fs.link(claimedOwnerPath, ownerPath);
  } catch (error) {
    if (!isNodeError(error) || (error.code !== "EEXIST" && error.code !== "ENOENT")) {
      await fs.rename(claimedOwnerPath, ownerPath).catch(() => undefined);
      return;
    }
  }
  await fs.rm(claimedOwnerPath, { force: true }).catch(() => undefined);
}

async function fileMtimeMs(filePath: string): Promise<number | undefined> {
  try {
    return (await fs.stat(filePath)).mtimeMs;
  } catch {
    return undefined;
  }
}

async function writeLockOwner(ownerPath: string, owner: CacheLockOwner): Promise<void> {
  const temp = `${ownerPath}.${process.pid}.${owner.token}.tmp`;
  await fs.writeFile(temp, `${JSON.stringify(owner)}\n`, "utf8");
  await fs.rename(temp, ownerPath);
}

async function renewLockOwner(ownerPath: string, owner: CacheLockOwner): Promise<void> {
  // Before renewing, confirm we still own the lock. If owner.json is gone (a
  // reclaimer renamed it aside to claim a wedged lock) or now holds a different
  // token, stop renewing: recreating owner.json would race the reclaimer's
  // pending directory removal and let two processes hold the lock. Combined with
  // the reclaimer's post-claim live re-read, this closes the resume window.
  const current = await readLockOwner(ownerPath);
  if (!current || current.token !== owner.token) {
    return;
  }
  owner.heartbeatAt = new Date().toISOString();
  await writeLockOwner(ownerPath, owner);
}

async function readLockOwner(ownerPath: string): Promise<CacheLockOwner | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(ownerPath, "utf8")) as Partial<CacheLockOwner>;
    return typeof parsed.pid === "number" && typeof parsed.token === "string" && typeof parsed.startedAt === "string" && typeof parsed.heartbeatAt === "string"
      ? {
          pid: parsed.pid,
          token: parsed.token,
          processStartTime: parsed.processStartTime,
          startedAt: parsed.startedAt,
          heartbeatAt: parsed.heartbeatAt,
          repoRoot: typeof parsed.repoRoot === "string" ? parsed.repoRoot : ""
        }
      : null;
  } catch {
    return null;
  }
}

async function removeLockIfOwned(lockDir: string, owner: CacheLockOwner): Promise<void> {
  const current = await readLockOwner(path.join(lockDir, "owner.json"));
  if (current?.token === owner.token) {
    await fs.rm(lockDir, { recursive: true, force: true });
  }
}

async function lockOwnerStillRunning(owner: CacheLockOwner): Promise<boolean> {
  if (!Number.isInteger(owner.pid) || owner.pid <= 0) {
    return false;
  }
  const currentStart = await currentProcessStartTime(owner.pid);
  if (owner.processStartTime && currentStart) {
    return owner.processStartTime === currentStart;
  }
  try {
    process.kill(owner.pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function currentProcessStartTime(pid: number): Promise<string | null> {
  try {
    const stat = await fs.readFile(`/proc/${pid}/stat`, "utf8");
    const closeParen = stat.lastIndexOf(")");
    if (closeParen < 0) {
      return null;
    }
    const fields = stat.slice(closeParen + 2).trim().split(/\s+/);
    return fields[19] ?? null;
  } catch {
    return null;
  }
}

function positiveInt(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && value !== undefined && value > 0 ? Math.trunc(value) : fallback;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
