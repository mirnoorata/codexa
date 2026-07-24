import { execFileSync } from "node:child_process";
import { link, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll } from "vitest";
import {
  issueWorktreeBootstrapReceipt,
  worktreeBootstrapBuildInputSha256,
  worktreeBootstrapStartupInputSha256,
  WORKTREE_BOOTSTRAP_DEPENDENCY_SEAL_RELATIVE_PATH
} from "../../src/worktree-bootstrap-receipt.js";

const fixtures: string[] = [];

afterAll(async () => {
  await Promise.all(fixtures.map((fixture) => rm(fixture, { recursive: true, force: true })));
});

export async function createReceiptFixture(
  prefix: string,
  options: { codexaHooks?: boolean; fakeHookLauncher?: boolean; extraManagedHook?: boolean } = {}
): Promise<string> {
  const repo = await mkdtemp(path.join(os.tmpdir(), prefix));
  fixtures.push(repo);
  execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
  await mkdir(path.join(repo, "src"), { recursive: true });
  await mkdir(path.join(repo, "dist"), { recursive: true });
  await mkdir(path.join(repo, ".codex"), { recursive: true });
  await mkdir(path.join(repo, "node_modules/example-dependency"), { recursive: true });
  const packageJson = {
    name: "receipt-fixture",
    version: "1.0.0",
    dependencies: { "example-dependency": "1.0.0" }
  };
  const packageLock = {
    name: "receipt-fixture",
    version: "1.0.0",
    lockfileVersion: 3,
    requires: true,
    packages: {
      "": packageJson,
      "node_modules/example-dependency": { version: "1.0.0" }
    }
  };
  await writeFile(path.join(repo, "package.json"), `${JSON.stringify(packageJson, null, 2)}\n`, "utf8");
  await writeFile(path.join(repo, "package-lock.json"), `${JSON.stringify(packageLock, null, 2)}\n`, "utf8");
  await writeFile(path.join(repo, ".npmrc"), "audit=true\n", "utf8");
  await writeFile(path.join(repo, "tsconfig.json"), "{}\n", "utf8");
  await writeFile(path.join(repo, "src/index.ts"), "export const fixture = 1;\n", "utf8");
  await writeFile(path.join(repo, "dist/cli.js"), "#!/usr/bin/env node\n", "utf8");
  await writeFile(path.join(repo, "dist/runtime.js"), "export const runtime = 1;\n", "utf8");
  await writeFile(
    path.join(repo, ".codex/worktree-bootstrap.sh"),
    [
      "#!/bin/sh",
      "# focus-worktree-bootstrap-input: .npmrc",
      "# focus-worktree-bootstrap-input: scripts/worktree-bootstrap.mjs",
      ""
    ].join("\n"),
    "utf8"
  );
  const codexaHooks = options.codexaHooks ?? true;
  await writeFile(
    path.join(repo, ".codex/config.toml"),
    codexaHooks ? "[features]\nhooks = true\n" : "# hooks disabled\n",
    "utf8"
  );
  await writeFile(
    path.join(repo, ".codex/hooks.json"),
    `${JSON.stringify(
      codexaHooks
        ? await managedHookFixture(repo, options.fakeHookLauncher ?? false, options.extraManagedHook ?? false)
        : {},
      null,
      2
    )}\n`,
    "utf8"
  );
  await writeFile(
    path.join(repo, WORKTREE_BOOTSTRAP_DEPENDENCY_SEAL_RELATIVE_PATH),
    `${JSON.stringify({ schemaVersion: 1, source: "npm-ci-fixture" })}\n`,
    "utf8"
  );
  await writeFile(
    path.join(repo, "node_modules/example-dependency/package.json"),
    `${JSON.stringify({ name: "example-dependency", version: "1.0.0" })}\n`,
    "utf8"
  );
  await writeFile(
    path.join(repo, "node_modules/example-dependency/index.js"),
    "export const dependencyFixture = 1;\n",
    "utf8"
  );
  await link(
    path.join(repo, "node_modules/example-dependency/index.js"),
    path.join(repo, "node_modules/example-dependency/index-hardlink.js")
  );
  execFileSync(
    "git",
    ["add", ".npmrc", "package.json", "package-lock.json", "tsconfig.json", "src", "dist", ".codex/worktree-bootstrap.sh"],
    { cwd: repo, stdio: "ignore" }
  );
  execFileSync(
    "git",
    ["-c", "user.name=Codexa", "-c", "user.email=codexa@example.invalid", "commit", "-m", "receipt fixture"],
    { cwd: repo, stdio: "ignore" }
  );
  return repo;
}

export async function issueReceipt(
  repoRoot: string,
  lane: "posix-hooks" | "native-windows-mcp"
): Promise<Awaited<ReturnType<typeof issueWorktreeBootstrapReceipt>>> {
  return issueWorktreeBootstrapReceipt(
    repoRoot,
    lane,
    await worktreeBootstrapBuildInputSha256(repoRoot),
    await worktreeBootstrapStartupInputSha256(repoRoot)
  );
}

async function managedHookFixture(
  repoRoot: string,
  fakeLauncher: boolean,
  extraManagedHook: boolean
): Promise<Record<string, unknown>> {
  const nodePath = await realpath(process.execPath);
  const fixture: Record<string, unknown> = {
    hooks: {
      SessionStart: [managedHook(repoRoot, nodePath, "startup|resume", "session-start", fakeLauncher)],
      PreToolUse: [managedHook(repoRoot, nodePath, "Edit|MultiEdit|Write|NotebookEdit|apply_patch", "hook-pre-edit")],
      PostToolUse: [managedHook(repoRoot, nodePath, "Edit|MultiEdit|Write|NotebookEdit|apply_patch", "hook-post-edit")]
    }
  };
  if (extraManagedHook) {
    (fixture.hooks as Record<string, unknown>).Stop = [
      managedHook(repoRoot, nodePath, "", "session-start")
    ];
  }
  return fixture;
}

function managedHook(
  repoRoot: string,
  nodePath: string,
  matcher: string,
  action: string,
  fakeLauncher = false
): Record<string, unknown> {
  const command = fakeLauncher
    ? `echo ${action}`
    : `${quoteCommand(nodePath)} ${shellQuote(path.join(repoRoot, "dist", "cli.js"))} ${action} ${shellQuote(repoRoot)}`;
  return {
    codexaManaged: true,
    matcher,
    hooks: [{
      codexaManaged: true,
      type: "command",
      command
    }]
  };
}

function quoteCommand(value: string): string {
  return /[\s'"\\]/u.test(value) ? shellQuote(value) : value;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
