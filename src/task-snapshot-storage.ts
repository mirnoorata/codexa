import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

const ROLLBACK_DIR = ".previous";

export function taskSnapshotRollbackPath(snapshotDir: string, taskId: string): string {
  return path.join(snapshotDir, ROLLBACK_DIR, `${taskId}.json`);
}

export async function atomicJsonWrite(filePath: string, value: unknown): Promise<void> {
  const tmp = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    await fs.rename(tmp, filePath);
  } finally {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
  }
}

export async function atomicTextWrite(filePath: string, value: string): Promise<void> {
  const tmp = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(tmp, value, { encoding: "utf8", flag: "wx" });
    await fs.rename(tmp, filePath);
  } finally {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
  }
}

export function redactRepoPath(value: unknown, repoRoot: string): unknown {
  if (typeof value === "string") {
    return value.replaceAll(repoRoot, "<repo>");
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactRepoPath(entry, repoRoot));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, redactRepoPath(entry, repoRoot)]));
  }
  return value;
}

export async function readJson<T>(filePath: string): Promise<{ ok: true; value: T } | { ok: false; missing: boolean; error: string }> {
  try {
    const text = await fs.readFile(filePath, "utf8");
    return { ok: true, value: JSON.parse(text) as T };
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code) : "";
    return {
      ok: false,
      missing: code === "ENOENT",
      error: error instanceof Error ? error.message : String(error)
    };
  }
}
