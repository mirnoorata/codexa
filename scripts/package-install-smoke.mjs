#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const repoRoot = process.cwd();
const keep = process.argv.includes("--keep");
const tempRoot = mkdtempSync(path.join(os.tmpdir(), "codexa-package-smoke-"));
const checks = [];

try {
  const packDir = path.join(tempRoot, "pack");
  const consumerRoot = path.join(tempRoot, "consumer");
  const targetRepo = path.join(tempRoot, "target-repo");
  const workspaceRoot = path.join(tempRoot, "workspace-root");
  const focusedRepo = path.join(workspaceRoot, "focused-repo");
  mkdirSync(packDir, { recursive: true });
  mkdirSync(consumerRoot, { recursive: true });

  const pack = run("npm", ["pack", "--dry-run=false", "--json", "--pack-destination", packDir], {
    cwd: repoRoot,
    label: "npm pack"
  });
  const packEntries = JSON.parse(pack.stdout);
  const packageEntry = Array.isArray(packEntries) ? packEntries[0] : undefined;
  const filename = typeof packageEntry?.filename === "string" ? packageEntry.filename : "";
  const tarball = path.join(packDir, filename);
  if (!filename || !existsSync(tarball)) {
    throw new Error("npm pack did not produce a tarball");
  }
  const packageFiles = new Set((packageEntry.files ?? []).map((entry) => entry.path));
  requirePackedFile(packageFiles, "dist/cli.js");
  requirePackedFile(packageFiles, "dist/mcp.js");
  requirePackedFile(packageFiles, "plugins/codexa/.codex-plugin/plugin.json");
  requirePackedFile(packageFiles, "plugins/codexa/.mcp.json");
  requirePackedFile(packageFiles, "plugins/codexa/scripts/codexa-mcp.js");
  requirePackedFile(packageFiles, "plugins/codexa/skills/codexa/SKILL.md");
  requirePackedFile(packageFiles, "integrations/claude-code/.claude-plugin/plugin.json");
  requirePackedFile(packageFiles, "integrations/claude-code/.mcp.json");
  requirePackedFile(packageFiles, "integrations/claude-code/scripts/codexa-mcp.js");
  requirePackedFile(packageFiles, "integrations/claude-code/hooks/hooks.json");
  requirePackedFile(packageFiles, "integrations/.claude-plugin/marketplace.json");
  rejectPackedPrefix(packageFiles, "src/");
  rejectPackedPrefix(packageFiles, ".codex/");

  writeFileSync(path.join(consumerRoot, "package.json"), `${JSON.stringify({ name: "codexa-package-smoke", private: true, type: "module" }, null, 2)}\n`, "utf8");
  run("npm", ["install", tarball, "--dry-run=false", "--no-audit", "--fund=false"], {
    cwd: consumerRoot,
    label: "install packed tarball",
    timeoutMs: 120_000
  });

  const codexa = packageBin(consumerRoot, "codexa");
  run(codexa, ["--version"], { cwd: consumerRoot, label: "installed codexa --version" });
  const help = run(codexa, ["--help"], { cwd: consumerRoot, label: "installed codexa --help" });
  assertIncludes(help.stdout, "Usage: codexa", "installed help should use the codexa binary name");

  createFixtureRepo(targetRepo);
  const init = run(codexa, ["init", targetRepo, "--policy-pack"], {
    cwd: consumerRoot,
    label: "installed codexa init",
    timeoutMs: 60_000
  });
  assertIncludes(init.stdout, "Codexa initialized", "init should complete from installed package");
  assertIncludes(init.stdout, "Policy pack:", "init --policy-pack should report local policies");
  for (const policyFile of ["verification.json", "complexity.json", "security.json"]) {
    const fullPath = path.join(targetRepo, ".codex", "policies", policyFile);
    if (!existsSync(fullPath)) {
      throw new Error(`init --policy-pack did not create ${fullPath}`);
    }
  }

  const status = run(codexa, ["status", targetRepo], {
    cwd: consumerRoot,
    label: "installed codexa status"
  });
  assertIncludes(status.stdout, "Codexa status", "status should render from installed package");

  const doctor = run(codexa, ["doctor", targetRepo], {
    cwd: consumerRoot,
    label: "installed codexa doctor"
  });
  assertIncludes(doctor.stdout, "Codexa doctor", "doctor should render from installed package");

  const repoMap = run(codexa, ["repo-map", targetRepo, "--no-auto-refresh", "--budget", "900", "--limit", "5"], {
    cwd: consumerRoot,
    label: "installed codexa repo-map"
  });
  assertIncludes(repoMap.stdout, "Top modules:", "repo-map should render from installed package");

  const brief = run(
    codexa,
    ["brief", targetRepo, "--task", "Change the greeting return value", "--file", "src/index.ts", "--no-auto-refresh", "--no-snippets", "--budget", "900", "--limit", "4"],
    {
      cwd: consumerRoot,
      label: "installed codexa brief"
    }
  );
  assertIncludes(brief.stdout, "Codexa task brief", "brief should render from installed package");

  const hookPre = run(codexa, ["hook-pre-edit", targetRepo], {
    cwd: consumerRoot,
    label: "installed hook-pre-edit"
  });
  assertIncludes(hookPre.stdout, "Codexa:", "pre-edit hook should stay advisory and printable");

  writeFileSync(path.join(targetRepo, "src", "index.ts"), "export function greeting() { return 'hello smoke v2' }\n", "utf8");
  const hookPost = run(codexa, ["hook-post-edit", targetRepo], {
    cwd: consumerRoot,
    label: "installed hook-post-edit",
    timeoutMs: 60_000
  });
  assertIncludes(hookPost.stdout, "Codexa", "post-edit hook should stay advisory and printable");

  await smokeMcp(codexa, targetRepo);
  const installedPackageRoot = path.join(consumerRoot, "node_modules", "@mirnoorata", "codexa");
  const installedPluginWrapper = path.join(installedPackageRoot, "plugins", "codexa", "scripts", "codexa-mcp.js");
  if (!existsSync(installedPluginWrapper)) {
    throw new Error("installed package is missing the Codexa plugin MCP wrapper");
  }
  await smokeMcp(process.execPath, targetRepo, {
    args: [installedPluginWrapper],
    env: { ...process.env, CODEXA_REPO: targetRepo, CODEXA_PLUGIN_AUTO_REFRESH: "0" },
    label: "installed plugin wrapper MCP startup"
  });
  // The Claude Code plugin launcher must resolve the bundled CLI through its
  // walk-up (integrations/claude-code/scripts -> package root/dist) from the
  // installed layout, and its core default must register the primary loop.
  const installedClaudeLauncher = path.join(installedPackageRoot, "integrations", "claude-code", "scripts", "codexa-mcp.js");
  if (!existsSync(installedClaudeLauncher)) {
    throw new Error("installed package is missing the Claude Code plugin MCP launcher");
  }
  await smokeMcp(process.execPath, targetRepo, {
    args: [installedClaudeLauncher],
    env: { ...process.env, CODEXA_REPO: targetRepo, CODEXA_PLUGIN_AUTO_REFRESH: "0" },
    requiredTools: ["freshness", "task_brief", "change_plan", "post_edit_review"],
    label: "installed Claude Code plugin launcher MCP startup (core profile)"
  });
  createWorkspaceFocusedRepo(workspaceRoot, focusedRepo);
  const focusedInit = run(codexa, ["init", focusedRepo], {
    cwd: consumerRoot,
    label: "installed codexa init focused repo",
    timeoutMs: 60_000
  });
  assertIncludes(focusedInit.stdout, "Codexa initialized", "focused repo init should complete from installed package");
  await smokeMcp(codexa, workspaceRoot, {
    expectedRepo: focusedRepo,
    label: "installed MCP workspace focus startup"
  });

  const summary = {
    package: {
      name: packageEntry.name,
      version: packageEntry.version,
      filename,
      size: packageEntry.size,
      unpackedSize: packageEntry.unpackedSize,
      fileCount: packageEntry.files?.length ?? null
    },
    checks
  };
  console.log(JSON.stringify(summary, null, 2));
  console.log(`package-smoke: passed ${checks.length} checks against ${filename}`);
} finally {
  if (keep) {
    console.log(`package-smoke: kept temp root ${tempRoot}`);
  } else {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

function run(command, args, options) {
  const startedAt = process.hrtime.bigint();
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
    timeout: options.timeoutMs ?? 30_000,
    stdio: ["ignore", "pipe", "pipe"]
  });
  const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
  checks.push({
    label: options.label,
    command: [command, ...args].join(" "),
    durationMs: Math.round(durationMs),
    exitCode: result.status,
    signal: result.signal ?? null
  });
  if (result.error) {
    throw new Error(`${options.label} failed to run: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`${options.label} failed with exit ${result.status}\nstdout:\n${bound(result.stdout)}\nstderr:\n${bound(result.stderr)}`);
  }
  return { stdout: result.stdout, stderr: result.stderr };
}

function createFixtureRepo(repo) {
  mkdirSync(path.join(repo, "src"), { recursive: true });
  mkdirSync(path.join(repo, "tests"), { recursive: true });
  run("git", ["init"], { cwd: repo, label: "fixture git init" });
  writeFileSync(path.join(repo, "package.json"), `${JSON.stringify({ scripts: { test: "node --test" } }, null, 2)}\n`, "utf8");
  writeFileSync(path.join(repo, "src", "index.ts"), "export function greeting() { return 'hello smoke' }\n", "utf8");
  writeFileSync(path.join(repo, "tests", "index.test.ts"), "import test from 'node:test'\nimport assert from 'node:assert/strict'\ntest('fixture', () => assert.equal(1, 1))\n", "utf8");
  run("git", ["add", "."], { cwd: repo, label: "fixture git add" });
  run("git", ["-c", "user.name=Codexa", "-c", "user.email=codexa@example.invalid", "commit", "-m", "fixture"], {
    cwd: repo,
    label: "fixture git commit"
  });
}

function createWorkspaceFocusedRepo(workspaceRoot, focusedRepo) {
  mkdirSync(workspaceRoot, { recursive: true });
  run("git", ["init"], { cwd: workspaceRoot, label: "workspace git init" });
  writeFileSync(path.join(workspaceRoot, "README.md"), "# workspace\n", "utf8");
  run("git", ["add", "."], { cwd: workspaceRoot, label: "workspace git add" });
  run("git", ["-c", "user.name=Codexa", "-c", "user.email=codexa@example.invalid", "commit", "-m", "workspace fixture"], {
    cwd: workspaceRoot,
    label: "workspace git commit"
  });
  createFixtureRepo(focusedRepo);
  mkdirSync(path.join(workspaceRoot, ".codex"), { recursive: true });
  writeFileSync(path.join(workspaceRoot, ".codex", "WORKING.md"), `## Active Focus\n\n- Project: \`${focusedRepo}\`\n`, "utf8");
}

async function smokeMcp(command, mcpRoot, options = {}) {
  const expectedRepo = options.expectedRepo ?? mcpRoot;
  const label = options.label ?? "installed MCP startup";
  const args = options.args ?? ["serve", mcpRoot, "--no-auto-refresh"];
  const transport = new StdioClientTransport({
    command,
    args,
    env: options.env,
    stderr: "pipe"
  });
  const stderrChunks = [];
  transport.stderr?.on("data", (chunk) => stderrChunks.push(Buffer.from(chunk)));
  const client = new Client({ name: "codexa-package-smoke", version: "0.1.0" });
  const startedAt = process.hrtime.bigint();
  try {
    await withTimeout(client.connect(transport), 15_000, "MCP connect timed out");
    const tools = await withTimeout(client.listTools(), 15_000, "MCP listTools timed out");
    const names = tools.tools.map((tool) => tool.name);
    for (const name of options.requiredTools ?? ["freshness", "repo_map", "task_brief"]) {
      if (!names.includes(name)) {
        throw new Error(`installed MCP server did not expose ${name}`);
      }
    }
    const freshness = await withTimeout(client.callTool({ name: "freshness", arguments: {} }), 15_000, "MCP freshness timed out");
    const text = JSON.stringify(freshness);
    if (!text.includes("fresh") && !text.includes("stale")) {
      throw new Error(`MCP freshness returned an unexpected payload: ${bound(text)}`);
    }
    assertIncludes(text, expectedRepo, "MCP freshness should resolve the expected repository");
  } finally {
    await client.close().catch(() => undefined);
    checks.push({
      label,
      command: [command, ...args].join(" "),
      durationMs: Math.round(Number(process.hrtime.bigint() - startedAt) / 1_000_000),
      exitCode: 0,
      signal: null,
      stderr: bound(Buffer.concat(stderrChunks).toString("utf8"), 500)
    });
  }
}

function packageBin(root, name) {
  return path.join(root, "node_modules", ".bin", process.platform === "win32" ? `${name}.cmd` : name);
}

function requirePackedFile(files, file) {
  if (!files.has(file)) {
    throw new Error(`packed package is missing ${file}`);
  }
}

function rejectPackedPrefix(files, prefix) {
  const matched = [...files].find((file) => file === prefix.slice(0, -1) || file.startsWith(prefix));
  if (matched) {
    throw new Error(`packed package should not include ${matched}`);
  }
}

function assertIncludes(text, expected, message) {
  if (!text.includes(expected)) {
    throw new Error(`${message}; expected ${JSON.stringify(expected)} in:\n${bound(text)}`);
  }
}

async function withTimeout(promise, timeoutMs, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function bound(text, max = 2000) {
  if (!text) {
    return "";
  }
  return text.length > max ? `${text.slice(0, max)}\n...<truncated>` : text;
}
