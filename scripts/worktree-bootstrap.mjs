#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  openSync,
  promises as fs,
  readFileSync,
  writeSync
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

class BootstrapLockBusyError extends Error {}

try {
  const mode = process.argv[2] ?? "";
  if (mode === "--verify-lock" || mode === "--try-lock") {
    await runLockProbe(mode, process.argv[3] ?? process.cwd());
  } else if (mode === "auto") {
    await runBootstrap(process.platform === "win32" ? "native-windows-mcp" : "posix-hooks", process.argv[3] ?? process.cwd());
  } else {
    await runBootstrap(mode, process.argv[3] ?? process.cwd());
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}

async function runBootstrap(lane, repoInput) {
  if (lane !== "posix-hooks" && lane !== "native-windows-mcp") {
    throw new Error("Codexa bootstrap lane must be posix-hooks or native-windows-mcp.");
  }
  if ((lane === "native-windows-mcp") !== (process.platform === "win32")) {
    throw new Error(`Codexa bootstrap lane ${lane} is not valid on ${process.platform}.`);
  }
  const major = Number(process.versions.node.split(".")[0]);
  if (!Number.isInteger(major) || major < 22) {
    throw new Error(`Codexa requires Node.js 22 or newer; found ${process.version}.`);
  }
  const repoRoot = await resolveGitRoot(repoInput);
  for (const required of ["package.json", "package-lock.json"]) {
    if (!existsSync(path.join(repoRoot, required))) {
      throw new Error(`Codexa bootstrap requires ${required} at ${repoRoot}.`);
    }
  }

  const lock = await acquireBootstrapLock(repoRoot);
  let logHandle;
  let primaryError;
  try {
    const expectedBuildInput = await hashBuildInputs(repoRoot);
    const preflight = spawnSync(
      process.execPath,
      [path.join(repoRoot, "scripts/worktree-bootstrap-preflight.mjs"), repoRoot],
      { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
    );
    if (preflight.error || preflight.status !== 0) {
      throw new Error(
        `Codexa bootstrap preflight failed${preflight.error ? `: ${preflight.error.message}` : ` (exit ${preflight.status})`}` +
        `${preflight.stderr ? `\n${bound(preflight.stderr)}` : ""}`
      );
    }

    const logPath = path.join(repoRoot, ".codex/tmp/worktree-bootstrap.log");
    await assertSafeFile(logPath);
    await fs.rm(logPath, { force: true });
    logHandle = openSync(logPath, "wx", 0o600);
    chmodSync(logPath, 0o600);
    writeSync(logHandle, `== path preflight ==\n${preflight.stdout}`);

    runLogged(logHandle, repoRoot, "npm ci", npmInvocation(["ci", "--no-audit", "--no-fund"]));
    await writeDependencySeal(repoRoot, expectedBuildInput);
    runLogged(logHandle, repoRoot, "build", commandInvocation("npm", ["run", "build"]));

    const initArgs = ["dist/cli.js", "init", repoRoot, "--tools", "core"];
    if (lane === "native-windows-mcp") initArgs.push("--no-hooks");
    runLogged(logHandle, repoRoot, `Codexa ${lane === "posix-hooks" ? "core" : "MCP-only"} init`, {
      command: process.execPath,
      args: initArgs
    });
    runLogged(logHandle, repoRoot, "Codexa worktree receipt", {
      command: process.execPath,
      args: [
        "dist/cli.js",
        "worktree-receipt",
        "issue",
        repoRoot,
        "--lane",
        lane,
        "--expected-build-input",
        expectedBuildInput,
        "--json"
      ]
    });
    runLogged(logHandle, repoRoot, "Codexa strict startup check", {
      command: process.execPath,
      args: ["dist/cli.js", "session-start", repoRoot, "--json", "--strict"]
    });

    const receiptPath = path.join(repoRoot, ".codex/tmp/worktree-bootstrap-receipt.json");
    process.stdout.write(
      `Codexa bootstrap: dependencies=installed; build=ready; wiring=core; ` +
      `lane=${lane}; receipt=${receiptPath}; log=${logPath}\n`
    );
    if (lane === "native-windows-mcp") {
      process.stderr.write(
        "Codexa Windows bootstrap is MCP-only; Codexa-managed hooks are disabled and current-thread MCP activation remains unverified.\n"
      );
    }
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    if (logHandle !== undefined) closeSync(logHandle);
    try {
      await releaseBootstrapLock(lock);
    } catch (releaseError) {
      if (!primaryError) throw releaseError;
    }
  }
}

function runLogged(logHandle, cwd, label, invocation) {
  writeSync(logHandle, `== ${label} ==\n`);
  const result = spawnSync(invocation.command, invocation.args, {
    cwd,
    stdio: ["ignore", logHandle, logHandle]
  });
  if (result.error || result.status !== 0) {
    throw new Error(
      `Codexa bootstrap failed during ${label}` +
      `${result.error ? `: ${result.error.message}` : ` (exit ${result.status})`}; ` +
      `log: ${path.join(cwd, ".codex/tmp/worktree-bootstrap.log")}`
    );
  }
}

function commandInvocation(command, args) {
  return process.platform === "win32" && command === "npm"
    ? npmInvocation(args)
    : { command, args };
}

function npmInvocation(args) {
  if (process.platform !== "win32") return { command: "npm", args };
  const commandInterpreter = process.env.ComSpec?.trim() || process.env.COMSPEC?.trim() || "cmd.exe";
  const commandLine = ["npm.cmd", ...args].map(quoteWindowsCommandArg).join(" ");
  return { command: commandInterpreter, args: ["/d", "/s", "/c", commandLine] };
}

function quoteWindowsCommandArg(value) {
  return /^[A-Za-z0-9._:@/=-]+$/u.test(value) ? value : `"${value.replaceAll('"', '""')}"`;
}

async function writeDependencySeal(repoRoot, buildInputSha256) {
  const nodeModules = path.join(repoRoot, "node_modules");
  await assertContainedDirectory(repoRoot, nodeModules);
  const sealPath = path.join(nodeModules, ".codexa-dependencies.json");
  await assertSafeFile(sealPath);
  const seal = {
    schemaVersion: 1,
    kind: "codexa-dependency-install",
    packageJsonSha256: await hashFile(path.join(repoRoot, "package.json")),
    packageLockSha256: await hashFile(path.join(repoRoot, "package-lock.json")),
    buildInputSha256,
    runtime: {
      nodeVersion: process.version,
      nodeModulesAbi: process.versions.modules,
      platform: process.platform,
      arch: process.arch
    },
    installedAt: new Date().toISOString()
  };
  const temporaryPath = path.join(nodeModules, `.codexa-dependencies.${process.pid}.${randomUUID()}.tmp`);
  try {
    await fs.writeFile(temporaryPath, `${JSON.stringify(seal, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600
    });
    await fs.rename(temporaryPath, sealPath);
  } finally {
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

async function hashBuildInputs(repoRoot) {
  const files = [
    path.join(repoRoot, "package.json"),
    path.join(repoRoot, "package-lock.json"),
    path.join(repoRoot, "tsconfig.json"),
    ...await regularTreeFiles(repoRoot, path.join(repoRoot, "src"))
  ];
  const hash = createHash("sha256");
  for (const filePath of files.sort()) {
    hash.update(`\0${path.relative(repoRoot, filePath).replaceAll(path.sep, "/")}\0`, "utf8");
    hash.update(await readRegularFile(filePath));
  }
  return hash.digest("hex");
}

async function regularTreeFiles(repoRoot, directory) {
  await assertContainedDirectory(repoRoot, directory);
  const files = [];
  const visit = async (current) => {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const candidate = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await assertContainedDirectory(repoRoot, candidate);
        await visit(candidate);
      } else if (entry.isFile()) {
        await assertSafeFile(candidate);
        files.push(candidate);
      } else {
        throw new Error(`Codexa bootstrap refuses non-regular build input: ${candidate}`);
      }
    }
  };
  await visit(directory);
  return files;
}

async function runLockProbe(probeMode, repoInput) {
  const repoRoot = await resolveGitRoot(repoInput);
  if (probeMode === "--try-lock") {
    try {
      const lock = await acquireBootstrapLock(repoRoot);
      await releaseBootstrapLock(lock);
      process.exitCode = 0;
    } catch (error) {
      if (error instanceof BootstrapLockBusyError) {
        process.exitCode = 75;
        return;
      }
      throw error;
    }
    return;
  }

  const lock = await acquireBootstrapLock(repoRoot);
  try {
    const contender = spawnSync(process.execPath, [fileURLPath(), "--try-lock", repoRoot], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    });
    if (contender.status !== 75) {
      throw new Error(
        `Codexa bootstrap lock allowed a concurrent owner (exit ${contender.status}).` +
        `${contender.stderr ? ` ${bound(contender.stderr)}` : ""}`
      );
    }
  } finally {
    await releaseBootstrapLock(lock);
  }
  const ownerlessLockDir = path.join(repoRoot, ".codex/tmp/worktree-bootstrap.lock");
  await fs.mkdir(ownerlessLockDir, { mode: 0o700 });
  const recovered = await acquireBootstrapLock(repoRoot);
  await releaseBootstrapLock(recovered);
  process.stdout.write("Codexa bootstrap lock: contention and ownerless-crash recovery verified.\n");
}

async function acquireBootstrapLock(repoRoot) {
  const repoReal = await fs.realpath(repoRoot);
  const codexDir = await ensureSafeDirectory(repoReal, path.join(repoReal, ".codex"));
  const tmpDir = await ensureSafeDirectory(repoReal, path.join(codexDir, "tmp"));
  const lockDir = path.join(tmpDir, "worktree-bootstrap.lock");
  const ownerPath = path.join(lockDir, "owner.json");
  const token = randomUUID();

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const stagingDir = path.join(tmpDir, `.worktree-bootstrap.lock.${process.pid}.${token}.tmp`);
    const stagingOwnerPath = path.join(stagingDir, "owner.json");
    try {
      await fs.mkdir(stagingDir, { mode: 0o700 });
      await fs.writeFile(
        stagingOwnerPath,
        `${JSON.stringify({ schemaVersion: 1, pid: process.pid, token })}\n`,
        { encoding: "utf8", flag: "wx", mode: 0o600 }
      );
      await fs.rename(stagingDir, lockDir);
      return { lockDir, ownerPath, token };
    } catch (error) {
      await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
      if (!existsSync(lockDir)) throw error;
      await assertContainedDirectory(repoReal, lockDir);
      let owner;
      try {
        await assertSafeFile(ownerPath);
        owner = JSON.parse(await fs.readFile(ownerPath, "utf8"));
      } catch (ownerError) {
        if (ownerError?.code === "ENOENT") {
          const entries = await fs.readdir(lockDir);
          if (entries.length === 0) {
            await fs.rmdir(lockDir);
            continue;
          }
        }
        throw new BootstrapLockBusyError(`Codexa bootstrap lock is not safely reclaimable: ${lockDir}`);
      }
      if (isLivePid(owner?.pid)) {
        throw new BootstrapLockBusyError(`Codexa bootstrap is already running for ${repoRoot} (pid ${owner.pid}).`);
      }
      await fs.rm(ownerPath, { force: true });
      try {
        await fs.rmdir(lockDir);
      } catch {
        throw new BootstrapLockBusyError(`Codexa bootstrap found a stale non-empty lock: ${lockDir}`);
      }
    }
  }
  throw new BootstrapLockBusyError(`Codexa bootstrap could not acquire its lock: ${lockDir}`);
}

async function releaseBootstrapLock(lock) {
  await assertSafeFile(lock.ownerPath);
  const owner = JSON.parse(await fs.readFile(lock.ownerPath, "utf8"));
  if (owner?.token !== lock.token || owner?.pid !== process.pid) {
    throw new Error(`Codexa bootstrap lock ownership changed unexpectedly: ${lock.lockDir}`);
  }
  await fs.rm(lock.ownerPath);
  await fs.rmdir(lock.lockDir);
}

function isLivePid(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function resolveGitRoot(repoInput) {
  const candidate = path.resolve(repoInput);
  const result = spawnSync("git", ["-C", candidate, "rev-parse", "--show-toplevel"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  if (result.error || result.status !== 0 || !result.stdout.trim()) {
    throw new Error(`Codexa bootstrap must run inside a Git worktree: ${candidate}.`);
  }
  return fs.realpath(result.stdout.trim());
}

async function ensureSafeDirectory(repoReal, directoryPath) {
  await assertSafeDirectory(directoryPath);
  await fs.mkdir(directoryPath, { mode: 0o700 }).catch((error) => {
    if (error?.code !== "EEXIST") throw error;
  });
  await assertContainedDirectory(repoReal, directoryPath);
  return directoryPath;
}

async function assertContainedDirectory(repoRoot, directoryPath) {
  await assertSafeDirectory(directoryPath);
  const repoReal = await fs.realpath(repoRoot);
  const directoryReal = await fs.realpath(directoryPath);
  if (!isContainedPath(repoReal, directoryReal)) {
    throw new Error(`Codexa bootstrap refuses a directory outside the worktree: ${directoryPath}`);
  }
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

async function readRegularFile(filePath) {
  await assertSafeFile(filePath);
  return fs.readFile(filePath);
}

async function hashFile(filePath) {
  return createHash("sha256").update(await readRegularFile(filePath)).digest("hex");
}

function isContainedPath(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function fileURLPath() {
  return fileURLToPath(import.meta.url);
}

function bound(value) {
  return String(value).replace(/\s+/gu, " ").trim().slice(0, 2_000);
}
