#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  openSync,
  promises as fs,
  readFileSync,
  writeSync
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

class BootstrapLockBusyError extends Error {}

const STARTUP_INPUT_MAX_BYTES = 16 * 1024 * 1024;
const STARTUP_SCAN_TIMEOUT_MS = 5_000;
const STARTUP_SCAN_MAX_FILES = 128;
const STARTUP_SCAN_MAX_LOGICAL_BYTES = 64 * 1024 * 1024;
const STARTUP_DECLARATION_MAX_COUNT = 64;
const STARTUP_DECLARATION_MAX_NAME_BYTES = 32 * 1024;
const BUILD_SCAN_TIMEOUT_MS = 10_000;
const BUILD_SCAN_MAX_FILES = 10_000;
const BUILD_SCAN_MAX_ENTRIES = 10_000;
const BUILD_SCAN_MAX_LOGICAL_BYTES = 256 * 1024 * 1024;
const LOCK_OWNER_MAX_BYTES = 64 * 1024;
const BOOTSTRAP_LOCK_MAX_ATTEMPTS = 32;
const STABLE_REGULAR_READ_FLAGS =
  fsConstants.O_RDONLY | fsConstants.O_NONBLOCK | fsConstants.O_NOFOLLOW;

try {
  const mode = process.argv[2] ?? "";
  if (mode === "--verify-lock" || mode === "--try-lock") {
    await runLockProbe(mode, process.argv[3] ?? process.cwd());
  } else if (mode === "--inspect-inputs") {
    const repoRoot = await resolveGitRoot(process.argv[3] ?? process.cwd());
    process.stdout.write(`${JSON.stringify(await snapshotBootstrapInputs(repoRoot))}\n`);
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
    const {
      startupInputSha256: expectedStartupInput,
      buildInputSha256: expectedBuildInput
    } = await snapshotBootstrapInputs(repoRoot);
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
        "--expected-startup-input",
        expectedStartupInput,
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
  const budget = createStartupScanBudget();
  const seal = {
    schemaVersion: 1,
    kind: "codexa-dependency-install",
    packageJsonSha256: await hashFile(repoRoot, path.join(repoRoot, "package.json"), budget, "package-json"),
    packageLockSha256: await hashFile(repoRoot, path.join(repoRoot, "package-lock.json"), budget, "package-lock"),
    npmrcSha256: await hashFile(repoRoot, path.join(repoRoot, ".npmrc"), budget, "npmrc"),
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

async function snapshotBootstrapInputs(repoRoot) {
  return {
    startupInputSha256: await hashStartupInputs(repoRoot),
    buildInputSha256: await hashBuildInputs(repoRoot)
  };
}

async function hashBuildInputs(repoRoot) {
  const budget = createBuildScanBudget();
  const tree = await regularTreeFiles(
    repoRoot,
    path.join(repoRoot, "src"),
    budget
  );
  const files = [
    path.join(repoRoot, "package.json"),
    path.join(repoRoot, "package-lock.json"),
    path.join(repoRoot, "tsconfig.json"),
    ...tree.files
  ];
  const hash = createHash("sha256");
  hash.update("codexa-build-input-v2\0", "utf8");
  for (const filePath of files.sort()) {
    const read = await readBudgetedStableRegularFileSnapshot(
      filePath,
      STARTUP_INPUT_MAX_BYTES,
      "build-input",
      budget,
      repoRoot
    );
    tree.entries.push(read.snapshot);
    updateManifestRecord(
      hash,
      path.relative(repoRoot, filePath).replaceAll(path.sep, "/"),
      read.contents
    );
  }
  const digest = hash.digest("hex");
  await revalidateInputDirectories(tree, budget);
  return digest;
}

async function hashStartupInputs(repoRoot) {
  const budget = createStartupScanBudget();
  const wrapper = ".codex/worktree-bootstrap.sh";
  const wrapperContents = (await readBudgetedStableRegularFile(
    path.join(repoRoot, wrapper),
    STARTUP_INPUT_MAX_BYTES,
    "bootstrap-wrapper",
    budget,
    repoRoot
  )).toString("utf8");
  const declared = parseBootstrapInputNames(wrapperContents);
  return hashNamedFiles(repoRoot, [...new Set([
    ".codex/environments/environment.toml",
    ".codex/worktree-bootstrap.ps1",
    wrapper,
    ...declared
  ])].sort(), budget);
}

function parseBootstrapInputNames(wrapper) {
  const prefix = "# focus-worktree-bootstrap-input: ";
  const names = [];
  const seen = new Set();
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
        throw new Error("Codexa bootstrap input declarations are missing or duplicated.");
      }
      const name = wrapper.slice(nameStart, lineEnd);
      nameBytes += Buffer.byteLength(name, "utf8");
      if (
        nameBytes > STARTUP_DECLARATION_MAX_NAME_BYTES ||
        seen.has(name)
      ) {
        throw new Error("Codexa bootstrap input declarations are missing or duplicated.");
      }
      names.push(name);
      seen.add(name);
    }
    if (newline === -1) break;
    lineStart = newline + 1;
  }
  if (names.length === 0) {
    throw new Error("Codexa bootstrap input declarations are missing or duplicated.");
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
      throw new Error("Codexa bootstrap input declarations contain an unsafe path.");
    }
  }
  return names;
}

async function hashNamedFiles(repoRoot, names, budget = createStartupScanBudget()) {
  const hash = createHash("sha256");
  hash.update("codexa-startup-input-v2\0", "utf8");
  for (const name of names) {
    try {
      updateManifestRecord(
        hash,
        name,
        await readBudgetedStableRegularFile(
          path.join(repoRoot, name),
          STARTUP_INPUT_MAX_BYTES,
          "startup-input",
          budget,
          repoRoot
        )
      );
    } catch (error) {
      if (error?.code === "ENOENT") updateManifestRecord(hash, name, null);
      else throw error;
    }
  }
  return hash.digest("hex");
}

function updateManifestRecord(hash, name, contents) {
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

async function regularTreeFiles(repoRoot, directory, budget) {
  await assertContainedDirectory(repoRoot, directory);
  const repoReal = await fs.realpath(repoRoot);
  const files = [];
  const directories = [];
  const entries = [];
  const visit = async (current) => {
    const captured = await captureStableInputDirectory(
      current,
      repoReal,
      budget,
      "scan"
    );
    directories.push(captured.snapshot);
    const entries = captured.entries;
    for (const entry of entries) {
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
  return { containmentRootReal: repoReal, directories, entries, files };
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

  const processIdentity = readProcessIdentity(process.pid);
  const repeatedProcessIdentity = readProcessIdentity(process.pid);
  if (
    !isValidProcessIdentity(processIdentity) ||
    repeatedProcessIdentity !== processIdentity
  ) {
    throw new Error(`Codexa bootstrap lock could not identify the current ${process.platform} process.`);
  }
  if (
    process.platform === "linux" &&
    linuxProcessStartTime(
      `123 (probe name with ) characters) S ${Array.from({ length: 19 }, (_, index) => index + 1).join(" ")}`
    ) !== "19"
  ) {
    throw new Error("Codexa bootstrap lock could not parse a Linux process name containing spaces and parentheses.");
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

  const lockDir = path.join(repoRoot, ".codex/tmp/worktree-bootstrap.lock");
  const ownerPath = path.join(lockDir, "owner.json");

  await assertProbeOwnerBusy(
    repoRoot,
    lockDir,
    ownerPath,
    { schemaVersion: 2, pid: process.pid, token: randomUUID(), processIdentity },
    "matching process identity"
  );
  await assertProbeOwnerBusy(
    repoRoot,
    lockDir,
    ownerPath,
    { schemaVersion: 1, pid: process.pid, token: randomUUID() },
    "legacy live owner"
  );
  await assertProbeOwnerBusy(
    repoRoot,
    lockDir,
    ownerPath,
    { schemaVersion: 2, pid: process.pid, token: randomUUID(), processIdentity: "invalid" },
    "malformed live owner"
  );

  await writeProbeOwner(lockDir, ownerPath, {
    schemaVersion: 2,
    pid: process.pid,
    token: randomUUID(),
    processIdentity: distinctProcessIdentity(processIdentity)
  });
  const reusedPidRecovery = await acquireBootstrapLock(repoRoot);
  await releaseBootstrapLock(reusedPidRecovery);

  const exitedChild = spawnSync(process.execPath, ["-e", "process.exit(0)"], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  if (exitedChild.error || exitedChild.status !== 0 || !Number.isSafeInteger(exitedChild.pid)) {
    throw new Error("Codexa bootstrap lock could not create a dead-owner recovery probe.");
  }
  await writeProbeOwner(lockDir, ownerPath, {
    schemaVersion: 2,
    pid: exitedChild.pid,
    token: randomUUID(),
    processIdentity
  });
  const deadOwnerRecovery = await acquireBootstrapLock(repoRoot);
  await releaseBootstrapLock(deadOwnerRecovery);

  await fs.mkdir(lockDir, { mode: 0o700 });
  await fs.writeFile(
    path.join(
      lockDir,
      `.owner.recovery.${exitedChild.pid}.unknown.${randomUUID()}.0.json`
    ),
    `${JSON.stringify({
      schemaVersion: 2,
      pid: exitedChild.pid,
      token: randomUUID(),
      processIdentity
    })}\n`,
    { encoding: "utf8", flag: "wx", mode: 0o600 }
  );
  const interruptedRecovery = await acquireBootstrapLock(repoRoot);
  await releaseBootstrapLock(interruptedRecovery);

  await fs.mkdir(lockDir, { mode: 0o700 });
  const recovered = await acquireBootstrapLock(repoRoot);
  await releaseBootstrapLock(recovered);
  process.stdout.write(
    "Codexa bootstrap lock: contention, process-identity, PID-reuse, dead-owner, interrupted-recovery, and ownerless-crash recovery verified.\n"
  );
}

async function assertProbeOwnerBusy(repoRoot, lockDir, ownerPath, owner, label) {
  await writeProbeOwner(lockDir, ownerPath, owner);
  try {
    const contender = spawnSync(process.execPath, [fileURLPath(), "--try-lock", repoRoot], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    });
    if (contender.status !== 75) {
      throw new Error(
        `Codexa bootstrap lock reclaimed an unverifiable ${label} (exit ${contender.status}).` +
        `${contender.stderr ? ` ${bound(contender.stderr)}` : ""}`
      );
    }
  } finally {
    await fs.rm(ownerPath, { force: true });
    await fs.rmdir(lockDir).catch(() => undefined);
  }
}

async function writeProbeOwner(lockDir, ownerPath, owner) {
  await fs.mkdir(lockDir, { mode: 0o700 });
  await fs.writeFile(ownerPath, `${JSON.stringify(owner)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600
  });
}

async function acquireBootstrapLock(repoRoot) {
  const repoReal = await fs.realpath(repoRoot);
  const codexDir = await ensureSafeDirectory(repoReal, path.join(repoReal, ".codex"));
  const tmpDir = await ensureSafeDirectory(repoReal, path.join(codexDir, "tmp"));
  const lockDir = path.join(tmpDir, "worktree-bootstrap.lock");
  const ownerPath = path.join(lockDir, "owner.json");
  const token = randomUUID();
  const processIdentity = readProcessIdentity(process.pid);
  const ownerRecord = { schemaVersion: 2, pid: process.pid, token, processIdentity };

  for (let attempt = 0; attempt < BOOTSTRAP_LOCK_MAX_ATTEMPTS; attempt += 1) {
    const stagingDir = path.join(
      tmpDir,
      `.worktree-bootstrap.lock.${process.pid}.${token}.${attempt}.tmp`
    );
    const stagingOwnerPath = path.join(stagingDir, "owner.json");
    try {
      await fs.mkdir(stagingDir, { mode: 0o700 });
      await fs.writeFile(
        stagingOwnerPath,
        `${JSON.stringify(ownerRecord)}\n`,
        { encoding: "utf8", flag: "wx", mode: 0o600 }
      );
    } catch (error) {
      await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
    try {
      await fs.rename(stagingDir, lockDir);
      return { lockDir, ownerPath, token, processIdentity };
    } catch (error) {
      await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
      if (!isLockContentionError(error) && !existsSync(lockDir)) throw error;
      try {
        await assertContainedDirectory(repoReal, lockDir);
      } catch (containmentError) {
        if (containmentError?.code === "ENOENT") continue;
        throw new BootstrapLockBusyError(`Codexa bootstrap lock is not safely reclaimable: ${lockDir}`);
      }
      let owner;
      try {
        owner = await readBootstrapLockOwner(ownerPath, repoRoot);
      } catch (ownerError) {
        if (ownerError?.code === "ENOENT") {
          let entries;
          try {
            entries = await fs.readdir(lockDir);
          } catch (directoryError) {
            if (directoryError?.code === "ENOENT") continue;
            throw new BootstrapLockBusyError(`Codexa bootstrap lock is not safely reclaimable: ${lockDir}`);
          }
          if (entries.length === 0) {
            try {
              await fs.writeFile(ownerPath, `${JSON.stringify(ownerRecord)}\n`, {
                encoding: "utf8",
                flag: "wx",
                mode: 0o600
              });
              return { lockDir, ownerPath, token, processIdentity };
            } catch (claimError) {
              if (isLockHandoffRaceError(claimError)) continue;
              throw claimError;
            }
          }
          const abandonedRecovery = entries.length === 1
            ? parseBootstrapLockRecovery(entries[0])
            : null;
          if (abandonedRecovery && !recoveryOwnerIsLive(abandonedRecovery)) {
            try {
              await fs.rename(path.join(lockDir, entries[0]), ownerPath);
              continue;
            } catch (recoveryError) {
              if (isLockHandoffRaceError(recoveryError)) continue;
              throw new BootstrapLockBusyError(
                `Codexa bootstrap lock recovery marker changed unexpectedly: ${lockDir}`
              );
            }
          }
        }
        throw new BootstrapLockBusyError(`Codexa bootstrap lock is not safely reclaimable: ${lockDir}`);
      }
      if (isLivePid(owner?.pid)) {
        const observedIdentity = readProcessIdentity(owner.pid);
        if (
          owner?.schemaVersion !== 2 ||
          !isValidProcessIdentity(owner?.processIdentity) ||
          !isValidProcessIdentity(observedIdentity)
        ) {
          throw new BootstrapLockBusyError(
            `Codexa bootstrap lock owner ${owner.pid} is live but its process identity cannot be verified; ` +
            `refusing recovery for ${repoRoot}.`
          );
        }
        if (owner.processIdentity === observedIdentity) {
          throw new BootstrapLockBusyError(`Codexa bootstrap is already running for ${repoRoot} (pid ${owner.pid}).`);
        }
      }
      let confirmedOwner;
      try {
        confirmedOwner = await readBootstrapLockOwner(ownerPath, repoRoot);
      } catch (confirmationError) {
        if (confirmationError?.code === "ENOENT") continue;
        throw new BootstrapLockBusyError(`Codexa bootstrap lock changed during recovery: ${lockDir}`);
      }
      if (!sameBootstrapLockOwner(owner, confirmedOwner)) continue;
      const recoveryPath = path.join(
        lockDir,
        `.owner.recovery.${process.pid}.${recoveryIdentitySegment(processIdentity)}.${token}.${attempt}.json`
      );
      try {
        await fs.rename(ownerPath, recoveryPath);
      } catch (claimError) {
        if (isLockHandoffRaceError(claimError)) continue;
        throw new BootstrapLockBusyError(`Codexa bootstrap lock changed during recovery: ${lockDir}`);
      }
      let recoveredOwner;
      try {
        recoveredOwner = await readBootstrapLockOwner(recoveryPath, repoRoot);
      } catch {
        await fs.rename(recoveryPath, ownerPath).catch(() => undefined);
        throw new BootstrapLockBusyError(`Codexa bootstrap lock changed during recovery: ${lockDir}`);
      }
      if (!sameBootstrapLockOwner(confirmedOwner, recoveredOwner)) {
        await fs.rename(recoveryPath, ownerPath).catch(() => undefined);
        continue;
      }
      try {
        await fs.writeFile(ownerPath, `${JSON.stringify(ownerRecord)}\n`, {
          encoding: "utf8",
          flag: "wx",
          mode: 0o600
        });
      } catch (claimError) {
        if (isLockHandoffRaceError(claimError)) {
          await fs.rm(recoveryPath, { force: true }).catch(() => undefined);
          continue;
        }
        await fs.rename(recoveryPath, ownerPath).catch(() => undefined);
        throw claimError;
      }
      await fs.rm(recoveryPath);
      return { lockDir, ownerPath, token, processIdentity };
    }
  }
  throw new BootstrapLockBusyError(`Codexa bootstrap could not acquire its lock: ${lockDir}`);
}

async function readBootstrapLockOwner(ownerPath, repoRoot) {
  await assertSafeFile(ownerPath);
  return JSON.parse((await readBudgetedStableRegularFile(
    ownerPath,
    LOCK_OWNER_MAX_BYTES,
    "bootstrap-lock-owner",
    createStartupScanBudget(),
    repoRoot
  )).toString("utf8"));
}

function sameBootstrapLockOwner(left, right) {
  return left?.schemaVersion === right?.schemaVersion &&
    left?.pid === right?.pid &&
    left?.token === right?.token &&
    left?.processIdentity === right?.processIdentity;
}

function isLockContentionError(error) {
  return error?.code === "EEXIST" ||
    error?.code === "ENOTEMPTY" ||
    error?.code === "EPERM";
}

function isLockHandoffRaceError(error) {
  return isLockContentionError(error) || error?.code === "ENOENT";
}

function recoveryIdentitySegment(processIdentity) {
  return isValidProcessIdentity(processIdentity)
    ? processIdentity.replace(":", "-")
    : "unknown";
}

function parseBootstrapLockRecovery(entry) {
  const match = /^\.owner\.recovery\.(\d+)\.((?:linux|darwin|win32)-[0-9a-f]{64}|unknown)\.[0-9a-f-]{36}\.\d+\.json$/u.exec(entry);
  if (!match) return null;
  const pid = Number(match[1]);
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  const processIdentity = match[2] === "unknown"
    ? null
    : match[2].replace("-", ":");
  return { pid, processIdentity };
}

function recoveryOwnerIsLive(recovery) {
  if (!isLivePid(recovery.pid)) return false;
  if (!isValidProcessIdentity(recovery.processIdentity)) return true;
  const observedIdentity = readProcessIdentity(recovery.pid);
  return !isValidProcessIdentity(observedIdentity) ||
    observedIdentity === recovery.processIdentity;
}

async function releaseBootstrapLock(lock) {
  const repoRoot = path.dirname(path.dirname(path.dirname(lock.lockDir)));
  const owner = await readBootstrapLockOwner(lock.ownerPath, repoRoot);
  if (
    owner?.schemaVersion !== 2 ||
    owner?.token !== lock.token ||
    owner?.pid !== process.pid ||
    owner?.processIdentity !== lock.processIdentity
  ) {
    throw new Error(`Codexa bootstrap lock ownership changed unexpectedly: ${lock.lockDir}`);
  }
  await fs.rm(lock.ownerPath);
  try {
    await fs.rmdir(lock.lockDir);
  } catch (error) {
    if (isLockHandoffRaceError(error)) return;
    throw error;
  }
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

function readProcessIdentity(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    if (process.platform === "linux") {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const startTime = linuxProcessStartTime(stat);
      const bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim().toLowerCase();
      if (!/^\d+$/u.test(startTime ?? "") || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u.test(bootId)) {
        return null;
      }
      return hashProcessIdentity("linux", `${bootId}:${startTime}`);
    }

    if (process.platform === "darwin") {
      const result = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], {
        encoding: "utf8",
        env: { ...process.env, LC_ALL: "C" },
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 3_000
      });
      const startedAt = result.stdout?.trim().replace(/\s+/gu, " ");
      if (result.error || result.status !== 0 || !startedAt) return null;
      return hashProcessIdentity("darwin", startedAt);
    }

    if (process.platform === "win32") {
      const result = spawnSync(
        "powershell.exe",
        [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`
        ],
        {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
          timeout: 3_000,
          windowsHide: true
        }
      );
      const startedAt = result.stdout?.trim();
      if (result.error || result.status !== 0 || !/^\d+$/u.test(startedAt ?? "")) return null;
      return hashProcessIdentity("win32", startedAt);
    }
  } catch {
    return null;
  }
  return null;
}

function linuxProcessStartTime(stat) {
  const commandEnd = stat.lastIndexOf(")");
  if (commandEnd < 0) return null;
  const fieldsAfterCommand = stat.slice(commandEnd + 1).trim().split(/\s+/u);
  return fieldsAfterCommand[19] ?? null;
}

function hashProcessIdentity(platform, value) {
  return `${platform}:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function isValidProcessIdentity(value) {
  return /^(?:linux|darwin|win32):[0-9a-f]{64}$/u.test(value ?? "");
}

function distinctProcessIdentity(identity) {
  const replacement = identity.endsWith("0") ? "1" : "0";
  return `${identity.slice(0, -1)}${replacement}`;
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

async function readBudgetedStableRegularFile(filePath, maxBytes, label, budget, repoRoot) {
  return (await readBudgetedStableRegularFileSnapshot(
    filePath,
    maxBytes,
    label,
    budget,
    repoRoot
  )).contents;
}

async function readBudgetedStableRegularFileSnapshot(
  filePath,
  maxBytes,
  label,
  budget,
  repoRoot
) {
  assertInputScanDeadline(budget);
  budget.fileCount += 1;
  if (budget.fileCount > budget.maxFiles) {
    throw new Error(`${budget.label}-file-limit-exceeded`);
  }
  const expected = await fs.lstat(filePath);
  if (!expected.isFile() || expected.isSymbolicLink() || expected.nlink !== 1) {
    throw new Error(`${label}-invalid`);
  }
  if (expected.size > maxBytes) throw new Error(`${label}-size-limit-exceeded`);
  const handle = await fs.open(filePath, STABLE_REGULAR_READ_FLAGS).catch((error) => {
    if (error?.code === "ENOENT") throw new Error(`${label}-changed-during-read`);
    throw error;
  });
  try {
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      opened.dev !== expected.dev ||
      opened.ino !== expected.ino ||
      opened.size !== expected.size ||
      opened.mode !== expected.mode ||
      opened.nlink !== expected.nlink
    ) {
      throw new Error(`${label}-changed-during-read`);
    }
    const contents = Buffer.alloc(expected.size);
    let position = 0;
    while (position < contents.length) {
      assertInputScanDeadline(budget);
      const { bytesRead } = await handle.read(
        contents,
        position,
        contents.length - position,
        position
      );
      if (bytesRead <= 0) throw new Error(`${label}-changed-during-read`);
      position += bytesRead;
    }
    const final = await handle.stat();
    if (
      final.dev !== opened.dev ||
      final.ino !== opened.ino ||
      final.size !== opened.size ||
      final.mode !== opened.mode ||
      final.nlink !== opened.nlink ||
      final.mtimeMs !== opened.mtimeMs ||
      final.ctimeMs !== opened.ctimeMs
    ) {
      throw new Error(`${label}-changed-during-read`);
    }
    const named = await fs.lstat(filePath).catch((error) => {
      if (error?.code === "ENOENT") throw new Error(`${label}-changed-during-read`);
      throw error;
    });
    if (
      !named.isFile() ||
      named.isSymbolicLink() ||
      named.nlink !== final.nlink ||
      named.dev !== final.dev ||
      named.ino !== final.ino ||
      named.size !== final.size ||
      named.mode !== final.mode ||
      named.mtimeMs !== final.mtimeMs ||
      named.ctimeMs !== final.ctimeMs
    ) {
      throw new Error(`${label}-changed-during-read`);
    }
    budget.logicalBytes += contents.length;
    if (budget.logicalBytes > budget.maxLogicalBytes) {
      throw new Error(`${budget.label}-byte-limit-exceeded`);
    }
    let fileReal;
    if (repoRoot) {
      const rootReal = await fs.realpath(repoRoot);
      if (budget.rootReal && budget.rootReal !== rootReal) {
        throw new Error(`${budget.label}-repository-changed`);
      }
      budget.rootReal = rootReal;
      fileReal = await fs.realpath(filePath).catch((error) => {
        if (error?.code === "ENOENT") throw new Error(`${label}-changed-during-read`);
        throw error;
      });
      if (!isContainedPath(rootReal, fileReal)) {
        throw new Error(`${label}-outside-repository`);
      }
    }
    assertInputScanDeadline(budget);
    return {
      contents,
      snapshot: {
        path: filePath,
        kind: "file",
        realPath: fileReal ?? await fs.realpath(filePath),
        dev: named.dev,
        ino: named.ino,
        mode: named.mode,
        nlink: named.nlink,
        size: named.size,
        mtimeMs: named.mtimeMs,
        ctimeMs: named.ctimeMs
      }
    };
  } finally {
    await handle.close();
  }
}

async function hashFile(
  repoRoot,
  filePath,
  budget = createStartupScanBudget(),
  label = "startup-input"
) {
  return createHash("sha256")
    .update(await readBudgetedStableRegularFile(
      filePath,
      STARTUP_INPUT_MAX_BYTES,
      label,
      budget,
      repoRoot
    ))
    .digest("hex");
}

function createStartupScanBudget() {
  return createInputScanBudget(
    "startup-input",
    STARTUP_SCAN_MAX_FILES,
    STARTUP_SCAN_MAX_FILES,
    STARTUP_SCAN_MAX_LOGICAL_BYTES,
    STARTUP_SCAN_TIMEOUT_MS
  );
}

function createBuildScanBudget() {
  return createInputScanBudget(
    "build-input",
    BUILD_SCAN_MAX_FILES,
    BUILD_SCAN_MAX_ENTRIES,
    BUILD_SCAN_MAX_LOGICAL_BYTES,
    BUILD_SCAN_TIMEOUT_MS
  );
}

function createInputScanBudget(label, maxFiles, maxEntries, maxLogicalBytes, timeoutMs) {
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

function assertInputScanDeadline(budget) {
  if (Date.now() > budget.deadlineAt) {
    throw new Error(`${budget.label}-scan-timeout`);
  }
}

async function readBoundedDirectoryEntries(directory, budget, phase) {
  const entries = [];
  const handle = await fs.opendir(directory);
  try {
    while (true) {
      assertInputScanDeadline(budget);
      const entry = await handle.read();
      if (!entry) break;
      const count = phase === "scan"
        ? ++budget.scannedDirectoryEntries
        : ++budget.revalidatedDirectoryEntries;
      if (count > budget.maxEntries) {
        throw new Error(`${budget.label}-entry-limit-exceeded`);
      }
      entries.push(entry);
    }
  } finally {
    await handle.close();
  }
  assertInputScanDeadline(budget);
  return entries.sort((left, right) => compareEntryNames(left.name, right.name));
}

async function captureStableInputDirectory(
  directory,
  containmentRootReal,
  budget,
  phase
) {
  const before = await inputDirectorySnapshotState(
    directory,
    containmentRootReal,
    budget
  );
  const entries = await readBoundedDirectoryEntries(directory, budget, phase);
  const after = await inputDirectorySnapshotState(
    directory,
    containmentRootReal,
    budget
  );
  if (!sameInputDirectorySnapshotState(before, after)) {
    throw new Error(`${budget.label}-directory-changed-during-scan`);
  }
  return {
    entries,
    snapshot: {
      path: directory,
      ...after,
      entrySetSha256: inputDirectoryEntrySetSha256(entries)
    }
  };
}

async function revalidateInputDirectories(tree, budget) {
  for (const expected of [...tree.entries].reverse()) {
    assertInputScanDeadline(budget);
    const current = await fs.lstat(expected.path).catch((error) => {
      if (
        error?.code === "ENOENT" ||
        error?.code === "ENOTDIR" ||
        error?.code === "ELOOP"
      ) {
        throw new Error(`${budget.label}-entry-changed-during-scan`);
      }
      throw error;
    });
    const realPath = await fs.realpath(expected.path).catch((error) => {
      if (
        error?.code === "ENOENT" ||
        error?.code === "ENOTDIR" ||
        error?.code === "ELOOP"
      ) {
        throw new Error(`${budget.label}-entry-changed-during-scan`);
      }
      throw error;
    });
    if (
      !current.isFile() ||
      current.isSymbolicLink() ||
      current.dev !== expected.dev ||
      current.ino !== expected.ino ||
      current.mode !== expected.mode ||
      current.nlink !== expected.nlink ||
      current.size !== expected.size ||
      current.mtimeMs !== expected.mtimeMs ||
      current.ctimeMs !== expected.ctimeMs ||
      realPath !== expected.realPath ||
      !isContainedPath(tree.containmentRootReal, realPath)
    ) {
      throw new Error(`${budget.label}-entry-changed-during-scan`);
    }
  }
  for (const expected of [...tree.directories].reverse()) {
    const current = await captureStableInputDirectory(
      expected.path,
      tree.containmentRootReal,
      budget,
      "revalidation"
    ).catch((error) => {
      if (
        error?.code === "ENOENT" ||
        error?.code === "ENOTDIR" ||
        error?.code === "ELOOP"
      ) {
        throw new Error(`${budget.label}-directory-changed-during-scan`);
      }
      throw error;
    });
    if (
      !sameInputDirectorySnapshotState(expected, current.snapshot) ||
      expected.entrySetSha256 !== current.snapshot.entrySetSha256
    ) {
      throw new Error(`${budget.label}-directory-changed-during-scan`);
    }
  }
  assertInputScanDeadline(budget);
}

async function inputDirectorySnapshotState(
  directory,
  containmentRootReal,
  budget
) {
  assertInputScanDeadline(budget);
  const entry = await fs.lstat(directory);
  if (!entry.isDirectory() || entry.isSymbolicLink()) {
    throw new Error(`${budget.label}-directory-changed-during-scan`);
  }
  const realPath = await fs.realpath(directory);
  if (!isContainedPath(containmentRootReal, realPath)) {
    throw new Error(`${budget.label}-directory-changed-during-scan`);
  }
  assertInputScanDeadline(budget);
  return {
    realPath,
    dev: entry.dev,
    ino: entry.ino,
    mode: entry.mode,
    nlink: entry.nlink,
    size: entry.size,
    mtimeMs: entry.mtimeMs,
    ctimeMs: entry.ctimeMs
  };
}

function sameInputDirectorySnapshotState(left, right) {
  return left.realPath === right.realPath &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs;
}

function inputDirectoryEntrySetSha256(entries) {
  const hash = createHash("sha256");
  hash.update("codexa-directory-entries-v1\0", "utf8");
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    hash.update(`${directoryEntryKind(entry)}${name.length}:`, "utf8");
    hash.update(name);
  }
  return hash.digest("hex");
}

function directoryEntryKind(entry) {
  if (entry.isDirectory()) return "D";
  if (entry.isFile()) return "F";
  if (entry.isSymbolicLink()) return "L";
  if (entry.isBlockDevice()) return "B";
  if (entry.isCharacterDevice()) return "C";
  if (entry.isFIFO()) return "P";
  if (entry.isSocket()) return "S";
  return "U";
}

function compareEntryNames(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
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
