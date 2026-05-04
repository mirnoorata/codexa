#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const explicitRepo = process.argv[2];
const autoRefresh = process.env.CODEXA_PLUGIN_AUTO_REFRESH !== "0";
const repoRoot = resolveRepoRoot(explicitRepo);
if (!repoRoot) {
  console.error(
    "codexa plugin MCP could not find a git repository or focused workspace. Set CODEXA_REPO to the repository root or run Codexa from inside the workspace."
  );
  process.exit(1);
}

const launch = resolveCodexaLaunch(repoRoot, autoRefresh);
const child = spawn(launch.command, launch.args, {
  cwd: repoRoot,
  stdio: ["inherit", "inherit", "inherit"],
  env: process.env
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});

child.on("error", (error) => {
  console.error(`codexa plugin MCP failed to start ${launch.command}: ${error.message}`);
  process.exit(1);
});

function resolveCodexaLaunch(repoRoot, autoRefresh) {
  const serveArgs = ["serve", repoRoot, autoRefresh ? "--auto-refresh" : "--no-auto-refresh"];
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const bundledCli = path.resolve(scriptDir, "../../../dist/cli.js");
  if (existsSync(bundledCli)) {
    return { command: process.execPath, args: [bundledCli, ...serveArgs] };
  }
  if (process.env.CODEXA_PLUGIN_ALLOW_NPX_FALLBACK === "1") {
    return { command: "npx", args: ["-y", "@mirnoorata/codexa", ...serveArgs] };
  }
  console.error(
    "codexa plugin MCP could not find the bundled Codexa CLI. Reinstall the Codexa plugin package or set CODEXA_PLUGIN_ALLOW_NPX_FALLBACK=1 to allow npm registry fallback."
  );
  process.exit(1);
}

function resolveRepoRoot(explicit) {
  const candidates = [
    explicit,
    process.env.CODEXA_REPO,
    process.env.CODEXA_FOCUSED_REPO,
    process.env.CODEX_WORKSPACE_ROOT,
    process.env.CODEX_WORKSPACE,
    process.env.PWD,
    process.cwd()
  ].filter((value) => typeof value === "string" && value.trim().length > 0);

  for (const candidate of candidates) {
    const resolved = path.resolve(candidate);
    const root = gitRoot(resolved);
    if (root) {
      return root;
    }
    if (workspaceFocusFileExists(resolved)) {
      return resolved;
    }
  }
  return null;
}

function workspaceFocusFileExists(candidate) {
  return focusFileCandidates(candidate).some((focusFile) => existsSync(focusFile));
}

function focusFileCandidates(candidate) {
  return [process.env.CODEXA_WORKSPACE_FOCUS_FILE, path.join(candidate, ".codex", "WORKING.md")].filter(
    (value) => typeof value === "string" && value.trim().length > 0
  );
}

function gitRoot(candidate) {
  if (!existsSync(candidate)) {
    return null;
  }
  const result = spawnSync("git", ["-C", candidate, "rev-parse", "--show-toplevel"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"]
  });
  if (result.status !== 0) {
    return null;
  }
  const root = result.stdout.trim();
  return root ? path.resolve(root) : null;
}
