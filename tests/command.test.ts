import { describe, expect, it } from "vitest";
import { mkdtemp, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createCommandBudget, runCommand } from "../src/command.js";

describe("runCommand", () => {
  it("captures successful stdout without blocking", async () => {
    const result = await runCommand(process.execPath, ["-e", "console.log('codexa-command-ok')"], {
      timeoutMs: 1_000,
      maxBufferBytes: 16 * 1024
    });
    expect(result.ok).toBe(true);
    expect(result.stdout.trim()).toBe("codexa-command-ok");
    expect(result.timedOut).toBe(false);
    expect(result.truncated).toBe(false);
  });

  it("marks timed-out commands and kills the child", async () => {
    const result = await runCommand(process.execPath, ["-e", "setTimeout(() => {}, 1000)"], {
      timeoutMs: 50,
      maxBufferBytes: 16 * 1024
    });
    expect(result.ok).toBe(false);
    expect(result.timedOut).toBe(true);
  });

  it("bounds captured output", async () => {
    const result = await runCommand(process.execPath, ["-e", "process.stdout.write('x'.repeat(5000))"], {
      timeoutMs: 1_000,
      maxBufferBytes: 1024
    });
    expect(result.ok).toBe(false);
    expect(result.truncated).toBe(true);
    expect(result.stdout.length).toBe(1024);
  });

  it("tracks per-request command budgets and warnings", async () => {
    const warnings: string[] = [];
    const provenance: string[] = [];
    const budget = createCommandBudget(1, warnings, provenance);

    const first = await runCommand(process.execPath, ["-e", "setTimeout(() => {}, 1000)"], {
      timeoutMs: 500,
      maxBufferBytes: 16 * 1024,
      budget
    });
    const second = await runCommand(process.execPath, ["-e", "console.log('should-not-run')"], {
      timeoutMs: 500,
      maxBufferBytes: 16 * 1024,
      budget
    });

    expect(first.ok).toBe(false);
    expect(first.timedOut).toBe(true);
    expect(second.ok).toBe(false);
    expect(second.timedOut).toBe(true);
    expect(second.error?.message).toContain("Command budget exhausted");
    expect(budget.usedMs).toBeLessThanOrEqual(budget.totalMs);
    expect(budget.remainingMs()).toBe(0);
    expect(warnings.join("\n")).toContain("command timed out");
    expect(warnings.join("\n")).toContain("command budget exhausted");
    expect(provenance.some((entry) => entry.startsWith("command:"))).toBe(true);
  });

  it("uses the invoked package binary name in CLI help", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "codexa-cli-alias-"));
    const aliasPath = path.join(dir, "codera");
    await symlink(path.resolve("dist/cli.js"), aliasPath);

    const aliasHelp = await runCommand(process.execPath, [aliasPath, "--help"], {
      timeoutMs: 2_000,
      maxBufferBytes: 32 * 1024
    });
    const directHelp = await runCommand(process.execPath, [path.resolve("dist/cli.js"), "--help"], {
      timeoutMs: 2_000,
      maxBufferBytes: 32 * 1024
    });

    expect(aliasHelp.ok).toBe(true);
    expect(aliasHelp.stdout).toContain("Usage: codera");
    expect(directHelp.ok).toBe(true);
    expect(directHelp.stdout).toContain("Usage: codexa");
  });
});
