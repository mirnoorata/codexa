import { execFileSync, spawnSync, type SpawnSyncReturns } from "node:child_process";
import { promises as nodeFs } from "node:fs";
import { chmod, link, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, truncate, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  inspectWorktreeBootstrapReceipt,
  issueWorktreeBootstrapReceipt,
  worktreeBootstrapBuildInputSha256,
  worktreeBootstrapStartupInputSha256,
  WORKTREE_BOOTSTRAP_DEPENDENCY_SEAL_RELATIVE_PATH,
  WORKTREE_BOOTSTRAP_RECEIPT_REF
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
    expect(receipt.dependencyInventory).toMatchObject({
      count: 1,
      fileCount: 4
    });
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

  it("rejects startup drift introduced while the full completion scope is scanned", async () => {
    const repo = await createReceiptFixture("codexa-worktree-receipt-cross-scope-startup-");
    await issueReceipt(repo, "posix-hooks");
    const completionTrigger = path.join(repo, "src/index.ts");
    const configPath = path.join(repo, ".codex/config.toml");
    const originalOpen = nodeFs.open.bind(nodeFs);
    let mutated = false;
    vi.spyOn(nodeFs, "open").mockImplementation(async (file, flags, mode) => {
      if (!mutated && path.resolve(String(file)) === completionTrigger) {
        mutated = true;
        await writeFile(configPath, "# changed during completion scan\n", "utf8");
      }
      return originalOpen(file, flags, mode);
    });
    try {
      await expect(inspectWorktreeBootstrapReceipt(repo)).resolves.toMatchObject({
        state: "stale",
        validation: "full",
        reason: "config-drift"
      });
    } finally {
      vi.restoreAllMocks();
    }
    expect(mutated).toBe(true);
  });

  it("rejects dependency drift introduced while the full completion scope is scanned", async () => {
    const repo = await createReceiptFixture("codexa-worktree-receipt-cross-scope-dependency-");
    await issueReceipt(repo, "posix-hooks");
    const completionTrigger = path.join(repo, "src/index.ts");
    const dependencyPath = path.join(repo, "node_modules/example-dependency/index.js");
    const originalOpen = nodeFs.open.bind(nodeFs);
    let mutated = false;
    vi.spyOn(nodeFs, "open").mockImplementation(async (file, flags, mode) => {
      if (!mutated && path.resolve(String(file)) === completionTrigger) {
        mutated = true;
        await writeFile(dependencyPath, "export const dependencyFixture = 2;\n", "utf8");
      }
      return originalOpen(file, flags, mode);
    });
    try {
      await expect(inspectWorktreeBootstrapReceipt(repo)).resolves.toMatchObject({
        state: "stale",
        validation: "full",
        reason: "dependency-inventory-drift"
      });
    } finally {
      vi.restoreAllMocks();
    }
    expect(mutated).toBe(true);
  });

  it("binds extraneous installed packages and rejects an oversized dependency file", async () => {
    const repo = await createReceiptFixture("codexa-worktree-receipt-inventory-");
    await issueReceipt(repo, "posix-hooks");
    await mkdir(path.join(repo, "node_modules/extraneous-package"), { recursive: true });
    await writeFile(
      path.join(repo, "node_modules/extraneous-package/package.json"),
      `${JSON.stringify({ name: "extraneous-package", version: "1.0.0" })}\n`,
      "utf8"
    );
    await expect(inspectWorktreeBootstrapReceipt(repo, { validation: "adoption" })).resolves.toMatchObject({
      state: "stale",
      validation: "adoption",
      reason: "dependency-inventory-drift"
    });

    const oversizedRepo = await createReceiptFixture("codexa-worktree-receipt-oversized-");
    const oversizedPath = path.join(oversizedRepo, "node_modules/example-dependency/oversized.bin");
    await writeFile(oversizedPath, "", "utf8");
    await truncate(oversizedPath, 256 * 1024 * 1024 + 1);
    await expect(issueReceipt(oversizedRepo, "posix-hooks")).rejects.toThrow(
      /dependency-inventory-file-size-limit-exceeded/u
    );
  });

  it("caps lockfile bytes and package entries before adoption materialization", async () => {
    const oversizedLockRepo = await createReceiptFixture("codexa-worktree-receipt-lock-bytes-");
    await issueReceipt(oversizedLockRepo, "posix-hooks");
    await truncate(path.join(oversizedLockRepo, "package-lock.json"), 16 * 1024 * 1024 + 1);
    await expect(
      inspectWorktreeBootstrapReceipt(oversizedLockRepo, { validation: "adoption" })
    ).resolves.toMatchObject({
      state: "unavailable",
      validation: "adoption",
      reason: "package-lock-size-limit-exceeded"
    });

    const excessiveEntriesRepo = await createReceiptFixture("codexa-worktree-receipt-lock-entries-");
    const lock = JSON.parse(
      await readFile(path.join(excessiveEntriesRepo, "package-lock.json"), "utf8")
    ) as { packages: Record<string, unknown> };
    for (let index = 0; index <= 100_000; index += 1) {
      lock.packages[`fixture-${index}`] = {};
    }
    await writeFile(
      path.join(excessiveEntriesRepo, "package-lock.json"),
      JSON.stringify(lock),
      "utf8"
    );
    await expect(issueReceipt(excessiveEntriesRepo, "posix-hooks")).rejects.toThrow(
      /package-lock-entry-limit-exceeded/u
    );
  });

  it("caps a wide runtime directory before sorting beyond the adoption entry budget", async () => {
    const repo = await createReceiptFixture("codexa-worktree-receipt-wide-dist-");
    const wide = path.join(repo, "dist", "wide");
    await mkdir(wide);
    const writes: Array<Promise<void>> = [];
    for (let index = 0; index <= 10_000; index += 1) {
      writes.push(writeFile(path.join(wide, `${index.toString().padStart(5, "0")}.js`), ""));
      if (writes.length === 256) {
        await Promise.all(writes);
        writes.length = 0;
      }
    }
    await Promise.all(writes);

    await expect(issueReceipt(repo, "posix-hooks")).rejects.toThrow(
      /dist-runtime-entry-limit-exceeded/u
    );
  }, 20_000);

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
    const startupInput = await worktreeBootstrapStartupInputSha256(repo);
    await expect(
      issueWorktreeBootstrapReceipt(repo, "posix-hooks", "0".repeat(64), startupInput)
    ).rejects.toThrow(/build-input-changed-during-bootstrap/u);
    await expect(
      issueWorktreeBootstrapReceipt(
        repo,
        "posix-hooks",
        await worktreeBootstrapBuildInputSha256(repo),
        "0".repeat(64)
      )
    ).rejects.toThrow(/startup-input-changed-during-bootstrap/u);

    await issueReceipt(repo, "posix-hooks");
    await writeFile(path.join(repo, ".npmrc"), "audit=false\n", "utf8");
    await expect(inspectWorktreeBootstrapReceipt(repo, { validation: "startup" })).resolves.toMatchObject({
      state: "stale",
      validation: "startup",
      reason: "startup-input-drift"
    });

    await issueReceipt(repo, "posix-hooks");
    await mkdir(path.join(repo, "scripts"), { recursive: true });
    await writeFile(path.join(repo, "scripts/worktree-bootstrap.mjs"), "// changed setup\n", "utf8");
    await expect(inspectWorktreeBootstrapReceipt(repo, { validation: "startup" })).resolves.toMatchObject({
      state: "stale",
      validation: "startup",
      reason: "startup-input-drift"
    });
  });

  it("rejects a HEAD change during the full build-input scan", async () => {
    const repo = await createReceiptFixture("codexa-worktree-receipt-head-race-");
    const expectedBuild = await worktreeBootstrapBuildInputSha256(repo);
    const expectedStartup = await worktreeBootstrapStartupInputSha256(repo);
    const racedSource = path.join(repo, "src/index.ts");
    const originalOpen = nodeFs.open.bind(nodeFs);
    let committed = false;
    vi.spyOn(nodeFs, "open").mockImplementation(async (file, flags, mode) => {
      if (!committed && path.resolve(String(file)) === racedSource) {
        committed = true;
        execFileSync(
          "git",
          [
            "-c", "user.name=Codexa",
            "-c", "user.email=codexa@example.invalid",
            "commit", "--allow-empty", "-m", "race HEAD"
          ],
          { cwd: repo, stdio: "ignore" }
        );
      }
      return originalOpen(file, flags, mode);
    });
    try {
      await expect(issueWorktreeBootstrapReceipt(
        repo,
        "posix-hooks",
        expectedBuild,
        expectedStartup
      )).rejects.toThrow(/git-head-changed-during-build-scan/u);
    } finally {
      vi.restoreAllMocks();
    }
    expect(committed).toBe(true);
  });

  it("rejects a source entry added after its directory was enumerated", async () => {
    const repo = await createReceiptFixture("codexa-worktree-receipt-source-entry-race-");
    const earlyDirectory = path.join(repo, "src/a");
    const trigger = path.join(repo, "src/z-trigger.ts");
    await mkdir(earlyDirectory);
    await writeFile(path.join(earlyDirectory, "existing.ts"), "export const early = true;\n", "utf8");
    await writeFile(trigger, "export const trigger = true;\n", "utf8");

    const originalOpen = nodeFs.open.bind(nodeFs);
    let mutated = false;
    vi.spyOn(nodeFs, "open").mockImplementation(async (file, flags, mode) => {
      if (!mutated && path.resolve(String(file)) === trigger) {
        await writeFile(
          path.join(earlyDirectory, "injected.ts"),
          "export const injected = true;\n",
          "utf8"
        );
        mutated = true;
      }
      return originalOpen(file, flags, mode);
    });
    try {
      await expect(worktreeBootstrapBuildInputSha256(repo)).rejects.toThrow(
        /build-input-(?:entry|directory)-changed-during-scan/u
      );
    } finally {
      vi.restoreAllMocks();
    }
    expect(mutated).toBe(true);
  });

  it("rejects a source directory replaced after its files were hashed", async () => {
    const repo = await createReceiptFixture("codexa-worktree-receipt-source-directory-race-");
    const earlyDirectory = path.join(repo, "src/a");
    const replacement = path.join(repo, "source-replacement");
    const displaced = path.join(repo, "source-displaced");
    const trigger = path.join(repo, "src/z-trigger.ts");
    await mkdir(earlyDirectory);
    await mkdir(replacement);
    await writeFile(path.join(earlyDirectory, "existing.ts"), "export const early = true;\n", "utf8");
    await writeFile(path.join(replacement, "existing.ts"), "export const early = true;\n", "utf8");
    await writeFile(trigger, "export const trigger = true;\n", "utf8");

    const originalOpen = nodeFs.open.bind(nodeFs);
    let mutated = false;
    vi.spyOn(nodeFs, "open").mockImplementation(async (file, flags, mode) => {
      if (!mutated && path.resolve(String(file)) === trigger) {
        await rename(earlyDirectory, displaced);
        await rename(replacement, earlyDirectory);
        mutated = true;
      }
      return originalOpen(file, flags, mode);
    });
    try {
      await expect(worktreeBootstrapBuildInputSha256(repo)).rejects.toThrow(
        /build-input-(?:entry|directory)-changed-during-scan/u
      );
    } finally {
      vi.restoreAllMocks();
    }
    expect(mutated).toBe(true);
  });

  it("rejects an early source file mutated in place during the build manifest scan", async () => {
    const repo = await createReceiptFixture("codexa-worktree-receipt-source-content-race-");
    const early = path.join(repo, "src/a.ts");
    const trigger = path.join(repo, "src/z-trigger.ts");
    await writeFile(early, "export const value = 1;\n", "utf8");
    await writeFile(trigger, "export const trigger = true;\n", "utf8");

    const originalOpen = nodeFs.open.bind(nodeFs);
    let mutated = false;
    vi.spyOn(nodeFs, "open").mockImplementation(async (file, flags, mode) => {
      if (!mutated && path.resolve(String(file)) === trigger) {
        await writeFile(early, "export const value = 2;\n", "utf8");
        const future = new Date(Date.now() + 5_000);
        await nodeFs.utimes(early, future, future);
        mutated = true;
      }
      return originalOpen(file, flags, mode);
    });
    try {
      await expect(worktreeBootstrapBuildInputSha256(repo)).rejects.toThrow(
        /build-input-entry-changed-during-scan/u
      );
    } finally {
      vi.restoreAllMocks();
    }
    expect(mutated).toBe(true);
  });

  it("distinguishes a missing startup input from a present file containing the old sentinel text", async () => {
    const repo = await createReceiptFixture("codexa-worktree-receipt-missing-frame-");
    const npmrcPath = path.join(repo, ".npmrc");
    await rm(npmrcPath);
    const missingDigest = await worktreeBootstrapStartupInputSha256(repo);

    await writeFile(npmrcPath, "missing", "utf8");
    const presentDigest = await worktreeBootstrapStartupInputSha256(repo);

    expect(presentDigest).not.toBe(missingDigest);
  });

  it("length-frames build manifest paths and contents", async () => {
    const repo = await createReceiptFixture("codexa-worktree-receipt-build-frame-");
    const firstPath = path.join(repo, "src/a.bin");
    const injectedPath = path.join(repo, "src/evil.ts");
    await writeFile(firstPath, Buffer.from("prefix\0src/evil.ts\0payload", "utf8"));
    const unsplit = await worktreeBootstrapBuildInputSha256(repo);
    const unsplitProducer = producerInputDigests(repo);

    await writeFile(firstPath, "prefix", "utf8");
    await writeFile(injectedPath, "payload", "utf8");
    const split = await worktreeBootstrapBuildInputSha256(repo);
    const splitProducer = producerInputDigests(repo);

    expect(split).not.toBe(unsplit);
    expect(unsplitProducer.buildInputSha256).toBe(unsplit);
    expect(splitProducer.buildInputSha256).toBe(split);
    expect(splitProducer.buildInputSha256).not.toBe(unsplitProducer.buildInputSha256);
  });

  it("keeps the production producer and receipt verifier input digests identical", async () => {
    const repo = await createReceiptFixture("codexa-worktree-receipt-producer-parity-");
    const producer = producerInputDigests(repo);

    await expect(worktreeBootstrapStartupInputSha256(repo)).resolves.toBe(
      producer.startupInputSha256
    );
    await expect(worktreeBootstrapBuildInputSha256(repo)).resolves.toBe(
      producer.buildInputSha256
    );
  });

  it.skipIf(process.platform === "win32")(
    "rejects a producer input replaced by a FIFO before open without blocking",
    async () => {
      const repo = await createReceiptFixture("codexa-worktree-producer-fifo-race-");
      const target = path.join(repo, "src/index.ts");
      const preload = path.join(repo, "fifo-open-race-preload.mjs");
      const sentinel = path.join(repo, "fifo-open-race-observed");
      await writeFile(
        preload,
        [
          'import { execFileSync } from "node:child_process";',
          'import { promises as fs } from "node:fs";',
          'import path from "node:path";',
          "const originalOpen = fs.open.bind(fs);",
          "let swapped = false;",
          "fs.open = async (file, flags, mode) => {",
          "  if (!swapped && path.resolve(String(file)) === path.resolve(process.env.CODEXA_FIFO_TARGET)) {",
          "    swapped = true;",
          "    await fs.rm(file);",
          '    execFileSync("mkfifo", [String(file)]);',
          '    await fs.writeFile(process.env.CODEXA_FIFO_SENTINEL, "observed\\n");',
          "  }",
          "  return originalOpen(file, flags, mode);",
          "};",
          ""
        ].join("\n"),
        "utf8"
      );

      const producer = spawnSync(
        process.execPath,
        [
          "--import",
          preload,
          path.resolve("scripts/worktree-bootstrap.mjs"),
          "--inspect-inputs",
          repo
        ],
        {
          encoding: "utf8",
          timeout: 3_000,
          env: {
            ...process.env,
            CODEXA_FIFO_TARGET: target,
            CODEXA_FIFO_SENTINEL: sentinel
          }
        }
      );
      expect(producer.error).toBeUndefined();
      expect(producer.status).not.toBe(0);
      expect(producer.stderr).toContain("build-input-changed-during-read");
      await expect(readFile(sentinel, "utf8")).resolves.toBe("observed\n");
    }
  );

  it("rejects an early producer source file mutated in place during its scan", async () => {
    const repo = await createReceiptFixture("codexa-worktree-producer-content-race-");
    const early = path.join(repo, "src/a.ts");
    const trigger = path.join(repo, "src/z-trigger.ts");
    const preload = path.join(repo, "source-content-race-preload.mjs");
    const sentinel = path.join(repo, "source-content-race-observed");
    await writeFile(early, "export const value = 1;\n", "utf8");
    await writeFile(trigger, "export const trigger = true;\n", "utf8");
    await writeFile(
      preload,
      [
        'import { promises as fs } from "node:fs";',
        'import path from "node:path";',
        "const originalOpen = fs.open.bind(fs);",
        "let mutated = false;",
        "fs.open = async (file, flags, mode) => {",
        "  if (!mutated && path.resolve(String(file)) === path.resolve(process.env.CODEXA_MUTATION_TRIGGER)) {",
        "    mutated = true;",
        '    await fs.writeFile(process.env.CODEXA_MUTATION_TARGET, "export const value = 2;\\n");',
        "    const future = new Date(Date.now() + 5_000);",
        "    await fs.utimes(process.env.CODEXA_MUTATION_TARGET, future, future);",
        '    await fs.writeFile(process.env.CODEXA_MUTATION_SENTINEL, "observed\\n");',
        "  }",
        "  return originalOpen(file, flags, mode);",
        "};",
        ""
      ].join("\n"),
      "utf8"
    );

    const producer = spawnSync(
      process.execPath,
      [
        "--import",
        preload,
        path.resolve("scripts/worktree-bootstrap.mjs"),
        "--inspect-inputs",
        repo
      ],
      {
        encoding: "utf8",
        timeout: 3_000,
        env: {
          ...process.env,
          CODEXA_MUTATION_TARGET: early,
          CODEXA_MUTATION_TRIGGER: trigger,
          CODEXA_MUTATION_SENTINEL: sentinel
        }
      }
    );
    expect(producer.error).toBeUndefined();
    expect(producer.status).not.toBe(0);
    expect(producer.stderr).toContain("build-input-entry-changed-during-scan");
    await expect(readFile(sentinel, "utf8")).resolves.toBe("observed\n");
  });

  it("parses newline-heavy wrappers without materializing every line", async () => {
    const repo = await createReceiptFixture("codexa-worktree-receipt-newline-heavy-");
    const ignoredDeclarations = Array.from(
      { length: 65 },
      (_, index) => ` # focus-worktree-bootstrap-input: ignored/${index}.txt`
    );
    await writeFile(
      path.join(repo, ".codex/worktree-bootstrap.sh"),
      [
        "#!/bin/sh",
        "# focus-worktree-bootstrap-input: .npmrc",
        "# focus-worktree-bootstrap-input: scripts/worktree-bootstrap.mjs",
        ...ignoredDeclarations,
        "not-a-declaration\r# focus-worktree-bootstrap-input: ignored/lone-cr.txt",
        ""
      ].join("\r\n") + "\n".repeat(6_000_000),
      "utf8"
    );

    const producerResult = spawnSync(
      process.execPath,
      [
        "--max-old-space-size=48",
        path.resolve("scripts/worktree-bootstrap.mjs"),
        "--inspect-inputs",
        repo
      ],
      { encoding: "utf8" }
    );
    expect(producerResult.status, producerResult.stderr).toBe(0);
    const producer = JSON.parse(producerResult.stdout) as {
      buildInputSha256: string;
      startupInputSha256: string;
    };
    await expect(worktreeBootstrapStartupInputSha256(repo)).resolves.toBe(
      producer.startupInputSha256
    );
  }, 20_000);

  it("enforces the declaration byte budget for multibyte names", async () => {
    const repo = await createReceiptFixture("codexa-worktree-receipt-declaration-bytes-");
    const oversizedName = `declared/${"é".repeat(17_000)}.txt`;
    await writeFile(
      path.join(repo, ".codex/worktree-bootstrap.sh"),
      `#!/bin/sh\n# focus-worktree-bootstrap-input: ${oversizedName}\n`,
      "utf8"
    );

    await expect(worktreeBootstrapStartupInputSha256(repo)).rejects.toThrow(
      /bootstrap-input-declarations-invalid/u
    );
    const producer = runProducerInputInspection(repo);
    expect(producer.status).not.toBe(0);
    expect(producer.stderr).toContain(
      "Codexa bootstrap input declarations are missing or duplicated."
    );
  });

  it.skipIf(process.platform === "win32")(
    "fails the production bootstrap before npm when declarations exceed the shared budget",
    async () => {
      const repo = await createReceiptFixture("codexa-worktree-receipt-declaration-limit-");
      const declarations = Array.from(
        { length: 65 },
        (_, index) => `# focus-worktree-bootstrap-input: declared/${index}.txt`
      );
      await writeFile(
        path.join(repo, ".codex/worktree-bootstrap.sh"),
        ["#!/bin/sh", ...declarations, ""].join("\n"),
        "utf8"
      );
      const fakeBin = path.join(repo, "fake-bin");
      const npmSentinel = path.join(repo, "npm-ran");
      await mkdir(fakeBin);
      await writeFile(
        path.join(fakeBin, "npm"),
        "#!/bin/sh\nprintf ran >\"$CODEXA_TEST_NPM_SENTINEL\"\n",
        "utf8"
      );
      await chmod(path.join(fakeBin, "npm"), 0o700);

      await expect(worktreeBootstrapStartupInputSha256(repo)).rejects.toThrow(
        /bootstrap-input-declarations-invalid/u
      );
      const inspection = runProducerInputInspection(repo);
      expect(inspection.status).not.toBe(0);
      expect(inspection.stderr).toContain("Codexa bootstrap input declarations are missing or duplicated.");

      const bootstrap = spawnSync(
        process.execPath,
        [path.resolve("scripts/worktree-bootstrap.mjs"), "posix-hooks", repo],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            CODEXA_TEST_NPM_SENTINEL: npmSentinel,
            PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}`
          }
        }
      );
      expect(bootstrap.status).not.toBe(0);
      expect(bootstrap.stderr).toContain("Codexa bootstrap input declarations are missing or duplicated.");
      await expect(readFile(npmSentinel, "utf8")).rejects.toThrow();
    }
  );

  it("enforces mirrored startup and build byte budgets", async () => {
    const startupRepo = await createReceiptFixture("codexa-worktree-receipt-startup-bytes-");
    const declared: string[] = [];
    for (let index = 0; index < 5; index += 1) {
      const name = `declared/${index}.bin`;
      const file = path.join(startupRepo, name);
      declared.push(name);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, "");
      await truncate(file, 16 * 1024 * 1024);
    }
    await writeFile(
      path.join(startupRepo, ".codex/worktree-bootstrap.sh"),
      [
        "#!/bin/sh",
        ...declared.map((name) => `# focus-worktree-bootstrap-input: ${name}`),
        ""
      ].join("\n"),
      "utf8"
    );
    await expect(worktreeBootstrapStartupInputSha256(startupRepo)).rejects.toThrow(
      /startup-input-byte-limit-exceeded/u
    );
    const startupProducer = runProducerInputInspection(startupRepo);
    expect(startupProducer.status).not.toBe(0);
    expect(startupProducer.stderr).toContain("startup-input-byte-limit-exceeded");

    const buildRepo = await createReceiptFixture("codexa-worktree-receipt-build-bytes-");
    await truncate(path.join(buildRepo, "src/index.ts"), 16 * 1024 * 1024 + 1);
    await expect(worktreeBootstrapBuildInputSha256(buildRepo)).rejects.toThrow(
      /build-input-size-limit-exceeded/u
    );
    const buildProducer = runProducerInputInspection(buildRepo);
    expect(buildProducer.status).not.toBe(0);
    expect(buildProducer.stderr).toContain("build-input-size-limit-exceeded");
  }, 20_000);

  it("keeps declared startup inputs independent from bounded durable receipt facts", async () => {
    const repo = await createReceiptFixture("codexa-worktree-receipt-budget-classes-");
    const declared: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      const name = `declared/${index}.bin`;
      const file = path.join(repo, name);
      declared.push(name);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, "");
      await truncate(file, 16 * 1024 * 1024);
    }
    await writeFile(
      path.join(repo, ".codex/worktree-bootstrap.sh"),
      ["#!/bin/sh", ...declared.map(
        (name) => `# focus-worktree-bootstrap-input: ${name}`
      ), ""].join("\n"),
      "utf8"
    );
    const configPrefix = "[features]\nhooks = true\n#";
    await writeFile(
      path.join(repo, ".codex/config.toml"),
      `${configPrefix}${"x".repeat(9 * 1024 * 1024 - configPrefix.length)}`
    );

    const producer = producerInputDigests(repo);
    await expect(worktreeBootstrapStartupInputSha256(repo)).resolves.toBe(
      producer.startupInputSha256
    );
    await expect(issueReceipt(repo, "posix-hooks")).resolves.toMatchObject({
      startupInputSha256: producer.startupInputSha256
    });

    await truncate(path.join(repo, ".codex/config.toml"), 16 * 1024 * 1024 + 1);
    await expect(inspectWorktreeBootstrapReceipt(repo, { validation: "startup" })).resolves.toMatchObject({
      state: "unavailable",
      reason: "config-size-limit-exceeded"
    });
  }, 30_000);

  it("caps source discovery before materializing an unbounded build manifest", async () => {
    const repo = await createReceiptFixture("codexa-worktree-receipt-build-entries-");
    const wide = path.join(repo, "src/wide");
    await mkdir(wide);
    const writes: Array<Promise<void>> = [];
    for (let index = 0; index <= 10_000; index += 1) {
      writes.push(writeFile(path.join(wide, `${index.toString().padStart(5, "0")}.ts`), ""));
      if (writes.length === 256) {
        await Promise.all(writes);
        writes.length = 0;
      }
    }
    await Promise.all(writes);

    await expect(worktreeBootstrapBuildInputSha256(repo)).rejects.toThrow(
      /build-input-entry-limit-exceeded/u
    );
    const producer = runProducerInputInspection(repo);
    expect(producer.status).not.toBe(0);
    expect(producer.stderr).toContain("build-input-entry-limit-exceeded");
  }, 20_000);

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
    publishRawReceiptRef(plain, "{}\n");
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

    publishRawReceiptRef(required, "{}\n");
    await expect(inspectWorktreeBootstrapReceipt(required)).resolves.toMatchObject({
      state: "invalid",
      reason: "receipt-schema-invalid"
    });
  });

  it("bounds immutable receipt blobs and rejects non-blob refs", async () => {
    const oversized = await createReceiptFixture("codexa-worktree-receipt-too-large-");
    await issueReceipt(oversized, "posix-hooks");
    publishRawReceiptRef(oversized, "x".repeat(128 * 1024 + 1));
    await expect(inspectWorktreeBootstrapReceipt(oversized)).resolves.toMatchObject({
      state: "invalid",
      reason: "receipt-too-large"
    });

    const nonBlob = await createReceiptFixture("codexa-worktree-receipt-non-blob-");
    const head = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: nonBlob,
      encoding: "utf8"
    }).trim();
    execFileSync(
      "git",
      ["update-ref", "--no-deref", WORKTREE_BOOTSTRAP_RECEIPT_REF, head],
      { cwd: nonBlob, stdio: "ignore" }
    );
    await expect(inspectWorktreeBootstrapReceipt(nonBlob)).resolves.toMatchObject({
      state: "invalid",
      reason: "receipt-ref-object-invalid"
    });
  });

  it("keeps the receipt ref isolated between linked worktrees", async () => {
    const repo = await createGitRepo("codexa-worktree-receipt-ref-scope-");
    const linked = await trackedTmp("codexa-worktree-receipt-ref-scope-linked-");
    await rm(linked, { recursive: true, force: true });
    execFileSync("git", ["worktree", "add", "--detach", linked, "HEAD"], {
      cwd: repo,
      stdio: "ignore"
    });
    try {
      const primaryObject = publishRawReceiptRef(repo, "{\"worktree\":\"primary\"}\n");
      const linkedObject = publishRawReceiptRef(linked, "{\"worktree\":\"linked\"}\n");
      expect(primaryObject).not.toBe(linkedObject);
      expect(resolveReceiptRef(repo)).toBe(primaryObject);
      expect(resolveReceiptRef(linked)).toBe(linkedObject);
    } finally {
      execFileSync("git", ["worktree", "remove", "--force", linked], {
        cwd: repo,
        stdio: "ignore"
      });
    }
  });

  it("does not consult redirected legacy receipt state", async () => {
    const repo = await createReceiptFixture("codexa-worktree-receipt-legacy-link-");
    const outside = await trackedTmp("codexa-worktree-receipt-legacy-link-target-");
    await writeFile(path.join(outside, "sentinel"), "unchanged\n", "utf8");
    await symlink(outside, path.join(repo, ".codex/tmp"), "dir");

    await issueReceipt(repo, "posix-hooks");
    await expect(inspectWorktreeBootstrapReceipt(repo)).resolves.toMatchObject({
      state: "verified",
      validation: "full"
    });
    expect(await readFile(path.join(outside, "sentinel"), "utf8")).toBe("unchanged\n");
    expect(await readdir(outside)).toEqual(["sentinel"]);
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

function publishRawReceiptRef(repo: string, contents: string): string {
  const objectId = execFileSync(
    "git",
    ["hash-object", "-w", "--stdin"],
    {
      cwd: repo,
      encoding: "utf8",
      input: contents
    }
  ).trim();
  execFileSync(
    "git",
    ["update-ref", "--no-deref", WORKTREE_BOOTSTRAP_RECEIPT_REF, objectId],
    { cwd: repo, stdio: "ignore" }
  );
  return objectId;
}

function resolveReceiptRef(repo: string): string {
  return execFileSync(
    "git",
    ["rev-parse", "--verify", "--end-of-options", WORKTREE_BOOTSTRAP_RECEIPT_REF],
    { cwd: repo, encoding: "utf8" }
  ).trim();
}

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
  execFileSync("git", ["add", ".npmrc", "package.json", "package-lock.json", "tsconfig.json", "src", "dist", ".codex/worktree-bootstrap.sh"], {
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
  return issueWorktreeBootstrapReceipt(
    repoRoot,
    lane,
    await worktreeBootstrapBuildInputSha256(repoRoot),
    await worktreeBootstrapStartupInputSha256(repoRoot)
  );
}

function producerInputDigests(repoRoot: string): {
  buildInputSha256: string;
  startupInputSha256: string;
} {
  const result = runProducerInputInspection(repoRoot);
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as {
    buildInputSha256: string;
    startupInputSha256: string;
  };
}

function runProducerInputInspection(repoRoot: string): SpawnSyncReturns<string> {
  return spawnSync(
    process.execPath,
    [path.resolve("scripts/worktree-bootstrap.mjs"), "--inspect-inputs", repoRoot],
    { encoding: "utf8" }
  );
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
