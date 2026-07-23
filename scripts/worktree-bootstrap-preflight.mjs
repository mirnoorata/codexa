#!/usr/bin/env node
import { promises as fs } from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(process.argv[2] ?? process.cwd());
const repoReal = await fs.realpath(repoRoot);
const codexDir = await ensureSafeDirectory(path.join(repoRoot, ".codex"));
const tmpDir = await ensureSafeDirectory(path.join(codexDir, "tmp"));
await ensureSafeDirectory(path.join(codexDir, "cache"));
await ensureSafeDirectory(path.join(repoRoot, "node_modules"));

const receiptPath = path.join(tmpDir, "worktree-bootstrap-receipt.json");
const logPath = path.join(tmpDir, "worktree-bootstrap.log");
const dependencyMarkerPath = path.join(repoRoot, "node_modules", ".codexa-dependencies.sha256");
const dependencySealPath = path.join(repoRoot, "node_modules", ".codexa-dependencies.json");
await assertSafeFile(receiptPath);
await assertSafeFile(logPath);
await assertSafeFile(dependencyMarkerPath);
await assertSafeFile(dependencySealPath);
await fs.rm(receiptPath, { force: true });

const distDir = path.join(repoRoot, "dist");
await assertSafeDirectory(distDir);
await fs.rm(distDir, { recursive: true, force: true });
await ensureSafeDirectory(distDir);

process.stdout.write(`${JSON.stringify({ ok: true, repoRoot, prepared: [".codex/tmp", ".codex/cache", "node_modules", "dist"] })}\n`);

async function ensureSafeDirectory(directoryPath) {
  await assertSafeDirectory(directoryPath);
  await fs.mkdir(directoryPath, { mode: 0o700 }).catch((error) => {
    if (error?.code !== "EEXIST") throw error;
  });
  await assertSafeDirectory(directoryPath);
  const directoryReal = await fs.realpath(directoryPath);
  if (!isContainedPath(repoReal, directoryReal)) {
    throw new Error(`Codexa bootstrap refuses a directory outside the worktree: ${directoryPath}`);
  }
  return directoryPath;
}

async function assertSafeDirectory(directoryPath) {
  try {
    const entry = await fs.lstat(directoryPath);
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new Error(`Codexa bootstrap refuses redirected or non-directory state: ${directoryPath}`);
    }
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
}

async function assertSafeFile(filePath) {
  try {
    const entry = await fs.lstat(filePath);
    if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1) {
      throw new Error(`Codexa bootstrap refuses redirected or non-regular generated file: ${filePath}`);
    }
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
}

function isContainedPath(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
