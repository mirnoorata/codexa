import { describe, expect, it } from "vitest";
import { runCommand } from "../src/command.js";

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
});
