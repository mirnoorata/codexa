#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const repoRoot = process.cwd();
const keepSnapshot = process.argv.includes("--keep");

assertCleanWorkingTree();

const tempRoot = mkdtempSync(path.join(os.tmpdir(), "codexa-public-snapshot-"));
const archivePath = path.join(tempRoot, "source.tar");
const snapshotRoot = path.join(tempRoot, "repo");

try {
  execFileSync("git", ["archive", "--format=tar", "--output", archivePath, "HEAD"], {
    cwd: repoRoot,
    stdio: "pipe"
  });
  execFileSync("mkdir", ["-p", snapshotRoot], { stdio: "pipe" });
  execFileSync("tar", ["-xf", archivePath, "-C", snapshotRoot], { stdio: "pipe" });
  execFileSync("git", ["init"], { cwd: snapshotRoot, stdio: "pipe" });
  execFileSync("git", ["branch", "-M", "main"], { cwd: snapshotRoot, stdio: "pipe" });
  execFileSync("git", ["add", "-A"], { cwd: snapshotRoot, stdio: "pipe" });
  execFileSync("git", ["-c", "user.name=Codexa", "-c", "user.email=codexa@example.invalid", "commit", "-m", "Initial public Codexa release"], {
    cwd: snapshotRoot,
    stdio: "pipe"
  });
  execFileSync(process.execPath, ["scripts/verify-public-hygiene.mjs"], {
    cwd: snapshotRoot,
    stdio: "pipe"
  });
  execFileSync(process.execPath, ["scripts/verify-public-hygiene.mjs", "--history"], {
    cwd: snapshotRoot,
    stdio: "pipe"
  });
  // npm publish --dry-run propagates dry-run config into nested npm commands.
  // This verifier needs a real temp install so source hygiene can import dev deps.
  execFileSync("npm", ["ci", "--dry-run=false", "--include=dev", "--ignore-scripts", "--no-audit", "--fund=false"], {
    cwd: snapshotRoot,
    stdio: "pipe"
  });
  execFileSync(process.execPath, ["scripts/verify-source-hygiene.mjs"], {
    cwd: snapshotRoot,
    stdio: "pipe"
  });

  console.log("public-snapshot: clean one-commit source snapshot verified");
  if (keepSnapshot) {
    console.log(`public-snapshot: kept at ${snapshotRoot}`);
  }
} finally {
  if (!keepSnapshot) {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

function assertCleanWorkingTree() {
  const dirty = execFileSync("git", ["status", "--porcelain=v1"], {
    cwd: repoRoot,
    encoding: "utf8"
  }).trim();
  if (dirty) {
    throw new Error("public-snapshot requires a clean working tree so the verified archive exactly matches HEAD");
  }
}
