import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  inspectWorktreeBootstrapReceipt,
  issueWorktreeBootstrapReceipt,
  worktreeBootstrapBuildInputSha256,
  WORKTREE_BOOTSTRAP_DEPENDENCY_SEAL_RELATIVE_PATH,
  WORKTREE_BOOTSTRAP_RECEIPT_RELATIVE_PATH
} from "../src/worktree-bootstrap-receipt.js";

const fixtures: string[] = [];
const testCliPath = path.resolve("dist/cli.js");
afterAll(async () => {
  await Promise.all(fixtures.map((fixture) => rm(fixture, { recursive: true, force: true })));
});

describe("worktree bootstrap receipt", () => {
  it("validates immediately and detects source, runtime, config, dependency, and HEAD drift", async () => {
    const repo = await createReceiptFixture("codexa-worktree-receipt-");
    const receipt = await issueReceipt(repo, "posix-hooks");
    expect(receipt.schemaVersion).toBe(2);
    expect(receipt.threadMcp).toBe("unverified");
    await expect(inspectWorktreeBootstrapReceipt(repo)).resolves.toMatchObject({
      state: "verified",
      lane: "posix-hooks",
      validation: "full"
    });

    await expectDrift(repo, "src/index.ts", "export const fixture = 2;\n", "build-input-drift");
    await expectDrift(repo, "dist/runtime.js", "export const runtime = 2;\n", "dist-runtime-drift");
    await expectDrift(repo, ".codex/config.toml", "# changed\n", "config-drift");

    const dependencyDir = path.join(repo, "node_modules/example-dependency");
    const movedDependency = path.join(repo, "node_modules/example-dependency-missing");
    await rename(dependencyDir, movedDependency);
    await expect(inspectWorktreeBootstrapReceipt(repo)).resolves.toMatchObject({
      state: "stale",
      reason: "dependency-inventory-drift"
    });
    await expect(inspectWorktreeBootstrapReceipt(repo, { validation: "adoption" })).resolves.toMatchObject({
      state: "stale",
      validation: "adoption",
      reason: "dependency-inventory-drift"
    });
    await rename(movedDependency, dependencyDir);

    await writeFile(path.join(repo, "HEAD-DRIFT.md"), "# drift\n", "utf8");
    execFileSync("git", ["add", "HEAD-DRIFT.md"], { cwd: repo, stdio: "ignore" });
    execFileSync(
      "git",
      ["-c", "user.name=Codexa", "-c", "user.email=codexa@example.invalid", "commit", "-m", "head drift"],
      { cwd: repo, stdio: "ignore" }
    );
    await expect(inspectWorktreeBootstrapReceipt(repo)).resolves.toMatchObject({
      state: "stale",
      reason: "head-drift"
    });
    await expect(inspectWorktreeBootstrapReceipt(repo, { validation: "startup" })).resolves.toMatchObject({
      state: "verified",
      validation: "startup"
    });
    await expect(inspectWorktreeBootstrapReceipt(repo, { validation: "adoption" })).resolves.toMatchObject({
      state: "verified",
      validation: "adoption"
    });

    await writeFile(
      path.join(repo, "node_modules/example-dependency/index.js"),
      "export const dependencyFixture = 2;\n",
      "utf8"
    );
    await expect(inspectWorktreeBootstrapReceipt(repo, { validation: "startup" })).resolves.toMatchObject({
      state: "verified",
      validation: "startup"
    });
    await expect(inspectWorktreeBootstrapReceipt(repo, { validation: "adoption" })).resolves.toMatchObject({
      state: "stale",
      validation: "adoption",
      reason: "dependency-inventory-drift"
    });
  });

  it("separates durable startup, executable adoption, and full completion validation", async () => {
    const repo = await createReceiptFixture("codexa-worktree-receipt-validation-scope-");
    await issueReceipt(repo, "posix-hooks");
    await writeFile(path.join(repo, "src/index.ts"), "export const fixture = 3;\n", "utf8");

    await expect(inspectWorktreeBootstrapReceipt(repo, { validation: "startup" })).resolves.toMatchObject({
      state: "verified",
      validation: "startup"
    });
    await expect(inspectWorktreeBootstrapReceipt(repo, { validation: "adoption" })).resolves.toMatchObject({
      state: "verified",
      validation: "adoption"
    });
    await expect(inspectWorktreeBootstrapReceipt(repo)).resolves.toMatchObject({
      state: "stale",
      validation: "full",
      reason: "build-input-drift"
    });
    const startupCli = spawnSync(
      process.execPath,
      [testCliPath, "worktree-receipt", "validate", repo, "--scope", "startup", "--json"],
      { encoding: "utf8" }
    );
    expect(startupCli.status).toBe(0);
    expect(JSON.parse(startupCli.stdout)).toMatchObject({
      state: "verified",
      validation: "startup"
    });
    const startupPlain = spawnSync(
      process.execPath,
      [testCliPath, "worktree-receipt", "validate", repo, "--scope", "startup"],
      { encoding: "utf8" }
    );
    expect(startupPlain.status).toBe(0);
    expect(startupPlain.stdout).toContain("verified (validation=startup; lane=posix-hooks)");
    const adoptionPlain = spawnSync(
      process.execPath,
      [testCliPath, "worktree-receipt", "validate", repo, "--scope", "adoption"],
      { encoding: "utf8" }
    );
    expect(adoptionPlain.status).toBe(0);
    expect(adoptionPlain.stdout).toContain("verified (validation=adoption; lane=posix-hooks)");
    const fullPlain = spawnSync(
      process.execPath,
      [testCliPath, "worktree-receipt", "validate", repo],
      { encoding: "utf8" }
    );
    expect(fullPlain.status).toBe(1);
    expect(fullPlain.stdout).toContain("stale (validation=full; lane=posix-hooks)");

    await writeFile(path.join(repo, "dist/runtime.js"), "export const runtime = 4;\n", "utf8");
    await expect(inspectWorktreeBootstrapReceipt(repo, { validation: "startup" })).resolves.toMatchObject({
      state: "verified",
      validation: "startup"
    });
    await expect(inspectWorktreeBootstrapReceipt(repo, { validation: "adoption" })).resolves.toMatchObject({
      state: "stale",
      validation: "adoption",
      reason: "dist-runtime-drift"
    });
  });

  it("rejects source races and invalidates durable setup-procedure drift", async () => {
    const repo = await createReceiptFixture("codexa-worktree-receipt-race-");
    await expect(
      issueWorktreeBootstrapReceipt(repo, "posix-hooks", "0".repeat(64))
    ).rejects.toThrow(/build-input-changed-during-bootstrap/u);

    await issueReceipt(repo, "posix-hooks");
    await mkdir(path.join(repo, "scripts"), { recursive: true });
    await writeFile(path.join(repo, "scripts/worktree-bootstrap.mjs"), "// changed setup\n", "utf8");
    await expect(inspectWorktreeBootstrapReceipt(repo, { validation: "startup" })).resolves.toMatchObject({
      state: "stale",
      validation: "startup",
      reason: "startup-input-drift"
    });
  });

  it("derives lane readiness from installed Codexa hook state", async () => {
    const posixRepo = await createReceiptFixture("codexa-worktree-receipt-posix-lane-");
    await expect(issueReceipt(posixRepo, "native-windows-mcp")).rejects.toThrow(
      /lane-platform-drift/u
    );

    const nativeRepo = await createReceiptFixture("codexa-worktree-receipt-native-lane-", {
      codexaHooks: false
    });
    await expect(issueReceipt(nativeRepo, "posix-hooks")).rejects.toThrow(
      /hook-feature-disabled/u
    );

    const fakeLauncherRepo = await createReceiptFixture("codexa-worktree-receipt-fake-hook-", {
      fakeHookLauncher: true
    });
    await expect(issueReceipt(fakeLauncherRepo, "posix-hooks")).rejects.toThrow(
      /hook-contract-drift:SessionStart/u
    );

    const extraManagedHookRepo = await createReceiptFixture("codexa-worktree-receipt-extra-hook-", {
      extraManagedHook: true
    });
    await expect(issueReceipt(extraManagedHookRepo, "posix-hooks")).rejects.toThrow(
      /hook-contract-drift:managed-set/u
    );
  });

  it("distinguishes non-opted repositories, required missing receipts, and malformed receipts", async () => {
    const plain = await createGitRepo("codexa-worktree-receipt-plain-");
    await expect(inspectWorktreeBootstrapReceipt(plain)).resolves.toEqual({ state: "not-required" });
    await mkdir(path.join(plain, ".codex/tmp"), { recursive: true });
    await writeFile(path.join(plain, WORKTREE_BOOTSTRAP_RECEIPT_RELATIVE_PATH), "{}\n", "utf8");
    await expect(inspectWorktreeBootstrapReceipt(plain)).resolves.toEqual({ state: "not-required" });

    const nonGit = await trackedTmp("codexa-worktree-receipt-no-git-");
    await expect(inspectWorktreeBootstrapReceipt(nonGit)).resolves.toMatchObject({
      state: "unavailable",
      validation: "full",
      reason: "bootstrap-requirement-git-inspection-failed"
    });

    const required = await createGitRepo("codexa-worktree-receipt-required-");
    await mkdir(path.join(required, ".codex"), { recursive: true });
    await writeFile(path.join(required, ".codex/worktree-bootstrap.sh"), "#!/bin/sh\n", "utf8");
    execFileSync("git", ["add", ".codex/worktree-bootstrap.sh"], { cwd: required, stdio: "ignore" });
    execFileSync(
      "git",
      ["-c", "user.name=Codexa", "-c", "user.email=codexa@example.invalid", "commit", "-m", "track bootstrap"],
      { cwd: required, stdio: "ignore" }
    );
    await expect(inspectWorktreeBootstrapReceipt(required)).resolves.toMatchObject({
      state: "missing",
      reason: "receipt-missing"
    });

    await mkdir(path.join(required, ".codex/tmp"), { recursive: true });
    await writeFile(path.join(required, WORKTREE_BOOTSTRAP_RECEIPT_RELATIVE_PATH), "{}\n", "utf8");
    await expect(inspectWorktreeBootstrapReceipt(required)).resolves.toMatchObject({
      state: "invalid",
      reason: "receipt-schema-invalid"
    });
  });

  it("refuses redirected receipt state without touching the target", async () => {
    const repo = await createGitRepo("codexa-worktree-receipt-link-");
    const outside = await trackedTmp("codexa-worktree-receipt-link-target-");
    await mkdir(path.join(repo, ".codex"), { recursive: true });
    await writeFile(path.join(repo, ".codex/worktree-bootstrap.sh"), "#!/bin/sh\n", "utf8");
    execFileSync("git", ["add", ".codex/worktree-bootstrap.sh"], { cwd: repo, stdio: "ignore" });
    execFileSync(
      "git",
      ["-c", "user.name=Codexa", "-c", "user.email=codexa@example.invalid", "commit", "-m", "track bootstrap"],
      { cwd: repo, stdio: "ignore" }
    );
    await writeFile(path.join(outside, "sentinel"), "unchanged\n", "utf8");
    await symlink(outside, path.join(repo, ".codex/tmp"), "dir");

    await expect(inspectWorktreeBootstrapReceipt(repo)).resolves.toMatchObject({
      state: "invalid",
      reason: expect.stringMatching(/refuses redirected or non-directory managed state/u)
    });
    expect(await readFile(path.join(outside, "sentinel"), "utf8")).toBe("unchanged\n");
  });
});

describe("worktree bootstrap path preflight", () => {
  const script = path.resolve("scripts/worktree-bootstrap-preflight.mjs");

  it("creates safe state and replaces stale dist with a real empty directory", async () => {
    const repo = await trackedTmp("codexa-worktree-preflight-");
    await mkdir(path.join(repo, "dist"), { recursive: true });
    await writeFile(path.join(repo, "dist/stale.js"), "stale\n", "utf8");

    const result = spawnSync(process.execPath, [script, repo], { encoding: "utf8" });

    expect(result.status).toBe(0);
    await expect(readFile(path.join(repo, "dist/stale.js"), "utf8")).rejects.toThrow();
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, repoRoot: repo });
  });

  it.each(["dist", "cache", "node_modules"] as const)("rejects a redirected %s path without mutating its target", async (kind) => {
    const repo = await trackedTmp(`codexa-worktree-preflight-${kind}-`);
    const outside = await trackedTmp(`codexa-worktree-preflight-${kind}-target-`);
    await mkdir(path.join(repo, ".codex"), { recursive: true });
    await writeFile(path.join(outside, "sentinel"), "unchanged\n", "utf8");
    const target = kind === "cache" ? path.join(repo, ".codex/cache") : path.join(repo, kind);
    await symlink(outside, target, "dir");

    const result = spawnSync(process.execPath, [script, repo], { encoding: "utf8" });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/refuses redirected or non-directory state/u);
    expect(await readFile(path.join(outside, "sentinel"), "utf8")).toBe("unchanged\n");
  });
});

async function expectDrift(repo: string, relativePath: string, changed: string, reason: string): Promise<void> {
  const filePath = path.join(repo, relativePath);
  const original = await readFile(filePath, "utf8");
  await writeFile(filePath, changed, "utf8");
  await expect(inspectWorktreeBootstrapReceipt(repo)).resolves.toMatchObject({ state: "stale", reason });
  await writeFile(filePath, original, "utf8");
  await expect(inspectWorktreeBootstrapReceipt(repo)).resolves.toMatchObject({ state: "verified" });
}

async function createReceiptFixture(
  prefix: string,
  options: { codexaHooks?: boolean; fakeHookLauncher?: boolean; extraManagedHook?: boolean } = {}
): Promise<string> {
  const repo = await createGitRepo(prefix, false);
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
  await writeFile(path.join(repo, "tsconfig.json"), "{}\n", "utf8");
  await writeFile(path.join(repo, "src/index.ts"), "export const fixture = 1;\n", "utf8");
  await writeFile(path.join(repo, "dist/cli.js"), "#!/usr/bin/env node\n", "utf8");
  await writeFile(path.join(repo, "dist/runtime.js"), "export const runtime = 1;\n", "utf8");
  await writeFile(path.join(repo, ".codex/worktree-bootstrap.sh"), "#!/bin/sh\n", "utf8");
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
  execFileSync("git", ["add", "package.json", "package-lock.json", "tsconfig.json", "src", "dist", ".codex/worktree-bootstrap.sh"], {
    cwd: repo,
    stdio: "ignore"
  });
  execFileSync(
    "git",
    ["-c", "user.name=Codexa", "-c", "user.email=codexa@example.invalid", "commit", "-m", "receipt fixture"],
    { cwd: repo, stdio: "ignore" }
  );
  return repo;
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

async function issueReceipt(
  repoRoot: string,
  lane: "posix-hooks" | "native-windows-mcp"
): Promise<Awaited<ReturnType<typeof issueWorktreeBootstrapReceipt>>> {
  return issueWorktreeBootstrapReceipt(repoRoot, lane, await worktreeBootstrapBuildInputSha256(repoRoot));
}

async function createGitRepo(prefix: string, commit = true): Promise<string> {
  const repo = await trackedTmp(prefix);
  execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
  await writeFile(path.join(repo, "README.md"), "# fixture\n", "utf8");
  if (commit) {
    execFileSync("git", ["add", "README.md"], { cwd: repo, stdio: "ignore" });
    execFileSync(
      "git",
      ["-c", "user.name=Codexa", "-c", "user.email=codexa@example.invalid", "commit", "-m", "fixture"],
      { cwd: repo, stdio: "ignore" }
    );
  }
  return repo;
}

async function trackedTmp(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  fixtures.push(directory);
  return directory;
}
