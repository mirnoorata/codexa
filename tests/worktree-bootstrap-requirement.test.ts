import type { CommandResult } from "../src/command.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const commandMocks = vi.hoisted(() => ({
  runCommand: vi.fn()
}));

vi.mock("../src/command.js", () => ({
  runCommand: commandMocks.runCommand
}));

const { isWorktreeBootstrapReceiptRequired } = await import(
  "../src/worktree-bootstrap-receipt-ref.js"
);

beforeEach(() => {
  commandMocks.runCommand.mockReset();
});

describe("worktree bootstrap requirement Git probe", () => {
  it("selects bounded direct teardown for a slow probe on every host", async () => {
    commandMocks.runCommand.mockResolvedValueOnce(commandResult({
      ok: true,
      stdout: ".codex/worktree-bootstrap.ps1\n"
    }));

    await expect(isWorktreeBootstrapReceiptRequired("/repo")).resolves.toBe(true);
    expect(commandMocks.runCommand).toHaveBeenCalledWith(
      "git",
      [
        "-C",
        expect.stringMatching(/[\\/]repo$/u),
        "ls-files",
        "--",
        ".codex/worktree-bootstrap.sh",
        ".codex/worktree-bootstrap.ps1"
      ],
      {
        timeoutMs: 2_500,
        maxBufferBytes: 16 * 1024,
        killProcessGroup: false
      }
    );
  });

  it("fails closed when the bounded probe times out", async () => {
    commandMocks.runCommand.mockResolvedValueOnce(commandResult({
      exitCode: null,
      timedOut: true
    }));

    await expect(isWorktreeBootstrapReceiptRequired("/repo")).rejects.toThrow(
      "bootstrap-requirement-git-inspection-failed"
    );
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
