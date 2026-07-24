import { execFileSync } from "node:child_process";
import { promises as nodeFs } from "node:fs";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { inspectWorktreeBootstrapReceipt } from "../src/worktree-bootstrap-receipt.js";
import { createReceiptFixture, issueReceipt } from "./helpers/worktree-receipt-fixture.js";

const fixtures: string[] = [];

afterAll(async () => {
  await Promise.all(fixtures.map((fixture) => rm(fixture, { recursive: true, force: true })));
});

describe("worktree bootstrap receipt adversarial boundaries", () => {
  it.each([
    { mutation: "source" as const, reason: "build-input-drift" },
    { mutation: "head" as const, reason: "head-drift" }
  ])("rejects $mutation drift introduced while the adoption scope is scanned", async ({ mutation, reason }) => {
    const repo = await createReceiptFixture(`codexa-worktree-receipt-adoption-${mutation}-race-`);
    await issueReceipt(repo, "posix-hooks");
    const dependencyTrigger = path.join(repo, "node_modules/example-dependency/index.js");
    const sourcePath = path.join(repo, "src/index.ts");
    const originalOpen = nodeFs.open.bind(nodeFs);
    let mutated = false;
    vi.spyOn(nodeFs, "open").mockImplementation(async (file, flags, mode) => {
      if (!mutated && path.resolve(String(file)) === dependencyTrigger) {
        mutated = true;
        if (mutation === "source") {
          await writeFile(sourcePath, "export const fixture = 7;\n", "utf8");
        } else {
          execFileSync(
            "git",
            [
              "-c", "user.name=Codexa",
              "-c", "user.email=codexa@example.invalid",
              "commit", "--allow-empty", "-m", "adoption race HEAD"
            ],
            { cwd: repo, stdio: "ignore" }
          );
        }
      }
      return originalOpen(file, flags, mode);
    });
    try {
      await expect(inspectWorktreeBootstrapReceipt(repo)).resolves.toMatchObject({
        state: "stale",
        validation: "full",
        reason
      });
    } finally {
      vi.restoreAllMocks();
    }
    expect(mutated).toBe(true);
  });

  it.skipIf(process.platform === "win32")(
    "bounds delayed successful Git prelude calls inside the adoption wall",
    async () => {
      const repo = await createReceiptFixture("codexa-worktree-receipt-slow-git-");
      await issueReceipt(repo, "posix-hooks");
      const shimDirectory = await mkdtemp(path.join(os.tmpdir(), "codexa-slow-git-"));
      fixtures.push(shimDirectory);
      const shimPath = path.join(shimDirectory, "git");
      const callLog = path.join(shimDirectory, "calls.log");
      const realGit = execFileSync("sh", ["-c", "command -v git"], {
        encoding: "utf8"
      }).trim();
      await writeFile(
        shimPath,
        [
          "#!/usr/bin/env node",
          'const fs = require("node:fs");',
          'const { spawnSync } = require("node:child_process");',
          "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);",
          'fs.appendFileSync(process.env.CODEXA_FAKE_GIT_LOG, `${process.argv.slice(2).join(" ")}\\n`);',
          `const result = spawnSync(${JSON.stringify(realGit)}, process.argv.slice(2), { stdio: "inherit" });`,
          "if (result.error) throw result.error;",
          "process.exit(result.status ?? 1);"
        ].join("\n"),
        "utf8"
      );
      await chmod(shimPath, 0o755);
      const previousPath = process.env.PATH;
      const previousLog = process.env.CODEXA_FAKE_GIT_LOG;
      const startedAt = Date.now();
      process.env.PATH = `${shimDirectory}${path.delimiter}${previousPath ?? ""}`;
      process.env.CODEXA_FAKE_GIT_LOG = callLog;
      try {
        await expect(inspectWorktreeBootstrapReceipt(repo, {
          validation: "adoption",
          adoptionDeadlineAt: startedAt + 2_500
        })).resolves.toMatchObject({
          state: "unavailable",
          validation: "adoption",
          reason: "adoption-validation-timeout"
        });
      } finally {
        if (previousPath === undefined) delete process.env.PATH;
        else process.env.PATH = previousPath;
        if (previousLog === undefined) delete process.env.CODEXA_FAKE_GIT_LOG;
        else process.env.CODEXA_FAKE_GIT_LOG = previousLog;
      }
      expect(Date.now() - startedAt).toBeLessThan(5_500);
      const calls = await readFile(callLog, "utf8");
      expect(calls).toContain("cat-file blob");
    }
  );
});
