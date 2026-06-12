#!/usr/bin/env node
// MCP launcher for the Codexa Claude Code plugin. Claude Code starts plugin
// MCP servers with the session's project directory as cwd; this script
// resolves the repository from there, resolves the Codexa CLI (explicit
// override, walked-up package/checkout dist, global install), and execs
// `codexa serve` over stdio. Self-contained on purpose: when the plugin is
// installed from a marketplace only this directory is copied, so it cannot
// reference files outside the plugin root.
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const explicitRepo = process.argv[2];
const autoRefresh = process.env.CODEXA_PLUGIN_AUTO_REFRESH !== "0";
const repoRoot = resolveRepoRoot(explicitRepo);
if (!repoRoot) {
  console.error(
    "codexa plugin MCP could not find a git repository. Set CODEXA_REPO to the repository root or start Claude Code inside the repository."
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
  // Claude Code has no client-side tool allowlist, so the profile is applied
  // server-side. Default core matches `codexa init`'s default and the
  // plugin's token-discipline pitch; CODEXA_PLUGIN_TOOLS=full widens it.
  const toolProfile = process.env.CODEXA_PLUGIN_TOOLS === "full" ? "full" : "core";
  const serveArgs = ["serve", repoRoot, autoRefresh ? "--auto-refresh" : "--no-auto-refresh", "--tools", toolProfile];
  const overrideCli = process.env.CODEXA_CLI;
  if (overrideCli && existsSync(overrideCli)) {
    return { command: process.execPath, args: [overrideCli, ...serveArgs] };
  }
  // npm package layout: integrations/claude-code/scripts -> package root.
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const bundledCli = path.resolve(scriptDir, "../../../dist/cli.js");
  if (existsSync(bundledCli)) {
    return { command: process.execPath, args: [bundledCli, ...serveArgs] };
  }
  if (commandExists("codexa")) {
    return { command: "codexa", args: serveArgs };
  }
  if (process.env.CODEXA_PLUGIN_ALLOW_NPX_FALLBACK === "1") {
    return { command: "npx", args: ["-y", "@mirnoorata/codexa", ...serveArgs] };
  }
  console.error(
    "codexa plugin MCP could not find the Codexa CLI. Install it with `npm install -g @mirnoorata/codexa`, set CODEXA_CLI to a dist/cli.js path, or set CODEXA_PLUGIN_ALLOW_NPX_FALLBACK=1 to allow npm registry fallback."
  );
  process.exit(1);
}

function commandExists(command) {
  const probe = process.platform === "win32" ? "where" : "which";
  try {
    return spawnSync(probe, [command], { stdio: "ignore" }).status === 0;
  } catch {
    return false;
  }
}

function resolveRepoRoot(explicit) {
  // Claude Code starts plugin MCP servers with the session's project
  // directory as cwd; that is the authoritative signal. $PWD is deliberately
  // NOT consulted — it is inherited shell state and can point at an
  // unrelated repository.
  const candidates = [explicit, process.env.CODEXA_REPO, process.env.CLAUDE_PROJECT_DIR, process.cwd()].filter(
    (value) => typeof value === "string" && value.trim().length > 0
  );
  for (const candidate of candidates) {
    const root = gitRoot(path.resolve(candidate));
    if (root) {
      return root;
    }
  }
  return null;
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
