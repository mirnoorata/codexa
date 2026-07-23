import type { CommandResult } from "../src/command.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const childProcessMocks = vi.hoisted(() => ({
  execFileSync: vi.fn(),
  runCommand: vi.fn()
}));

vi.mock("node:child_process", () => ({
  execFileSync: childProcessMocks.execFileSync
}));

vi.mock("../src/command.js", () => ({
  runCommand: childProcessMocks.runCommand
}));

const { isGitTracked, isGitTrackedAsync } = await import("../src/init-portability.js");

beforeEach(() => {
  childProcessMocks.execFileSync.mockReset();
  childProcessMocks.runCommand.mockReset();
});

describe("bounded Git tracked-file inspection", () => {
  it("bounds the legacy synchronous compatibility helper", () => {
    expect(isGitTracked("/repo", ".codex/hooks.json")).toBe(true);
    expect(childProcessMocks.execFileSync).toHaveBeenCalledWith(
      "git",
      ["-C", "/repo", "ls-files", "--error-unmatch", "--", ".codex/hooks.json"],
      {
        maxBuffer: 16 * 1024,
        stdio: "ignore",
        timeout: 2_500,
        windowsHide: true
      }
    );

    childProcessMocks.execFileSync.mockImplementationOnce(() => {
      throw new Error("timed out");
    });
    expect(isGitTracked("/repo", "untracked.txt")).toBe(false);
  });

  it.each([
    [0, true],
    [1, false]
  ] as const)("maps the bounded async Git exit %i to tracked=%s", async (exitCode, tracked) => {
    childProcessMocks.runCommand.mockResolvedValueOnce(commandResult({ exitCode, ok: true }));

    await expect(isGitTrackedAsync("/repo", ".codex/hooks.json")).resolves.toBe(tracked);
    expect(childProcessMocks.runCommand).toHaveBeenCalledWith(
      "git",
      ["-C", "/repo", "ls-files", "--error-unmatch", "--", ".codex/hooks.json"],
      {
        maxBufferBytes: 16 * 1024,
        okExitCodes: [0, 1],
        timeoutMs: 2_500
      }
    );
  });

  it.each([
    ["git-tracked-inspection-timeout", { exitCode: null, timedOut: true }],
    ["git-tracked-inspection-output-limit-exceeded", { exitCode: null, truncated: true }],
    ["git-tracked-inspection-unavailable", { error: new Error("spawn failed"), exitCode: null }],
    ["git-tracked-inspection-failed:128", { exitCode: 128 }]
  ] as const)("fails closed on %s", async (message, partial) => {
    childProcessMocks.runCommand.mockResolvedValueOnce(commandResult(partial));

    await expect(isGitTrackedAsync("/repo", ".codex/hooks.json")).rejects.toThrow(message);
  });
});

function commandResult(overrides: Partial<CommandResult>): CommandResult {
  return {
    command: "git",
    args: [],
    stdout: "",
    stderr: "",
    exitCode: 0,
    signal: null,
    ok: false,
    timedOut: false,
    truncated: false,
    ...overrides
  };
}
