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
        owner.heartbeatAt = new Date().toISOString();
        void writeLockOwner(ownerPath, owner).catch(() => undefined);
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
      if (!(await lockOwnerStillRunning(owner))) {
        return claimAndRemoveDeadOwnerLock(lockDir, owner);
      }
      const heartbeatMs = Date.parse(owner.heartbeatAt || owner.startedAt);
      if (Date.now() - heartbeatMs <= staleMs) {
        return false;
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

async function claimAndRemoveDeadOwnerLock(lockDir: string, expectedOwner: CacheLockOwner): Promise<boolean> {
  const ownerPath = path.join(lockDir, "owner.json");
  const claimedOwnerPath = path.join(lockDir, `owner.json.dead-${process.pid}-${randomUUID()}`);
  try {
    await fs.rename(ownerPath, claimedOwnerPath);
  } catch (error) {
    return isNodeError(error) && error.code === "ENOENT";
  }
  const claimed = await readLockOwner(claimedOwnerPath);
  if (claimed?.token !== expectedOwner.token || claimed.pid !== expectedOwner.pid) {
    await fs.rename(claimedOwnerPath, ownerPath).catch(() => undefined);
    return false;
  }
  await fs.rm(lockDir, { recursive: true, force: true });
  return true;
}

async function writeLockOwner(ownerPath: string, owner: CacheLockOwner): Promise<void> {
  const temp = `${ownerPath}.${process.pid}.${owner.token}.tmp`;
  await fs.writeFile(temp, `${JSON.stringify(owner)}\n`, "utf8");
  await fs.rename(temp, ownerPath);
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
