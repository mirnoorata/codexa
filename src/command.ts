import { spawn } from "node:child_process";

export interface RunCommandOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  maxBufferBytes?: number;
  okExitCodes?: number[];
}

export interface CommandResult {
  command: string;
  args: string[];
  cwd?: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  ok: boolean;
  timedOut: boolean;
  truncated: boolean;
  error?: Error;
}

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_BUFFER_BYTES = 1024 * 1024;

export async function runCommand(command: string, args: string[], options: RunCommandOptions = {}): Promise<CommandResult> {
  const timeoutMs = Math.max(1, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const maxBufferBytes = Math.max(1024, options.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES);
  const okExitCodes = new Set(options.okExitCodes ?? [0]);

  return await new Promise<CommandResult>((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bufferedBytes = 0;
    let timedOut = false;
    let truncated = false;
    let killTimer: NodeJS.Timeout | undefined;
    let settled = false;

    const finish = (partial: Omit<CommandResult, "command" | "args" | "cwd" | "stdout" | "stderr" | "ok" | "timedOut" | "truncated">) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (killTimer) {
        clearTimeout(killTimer);
      }
      const exitCode = partial.exitCode;
      resolve({
        command,
        args,
        cwd: options.cwd,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        exitCode,
        signal: partial.signal,
        ok: !timedOut && !truncated && exitCode !== null && okExitCodes.has(exitCode),
        timedOut,
        truncated,
        error: partial.error
      });
    };

    const terminate = () => {
      if (child.killed) {
        return;
      }
      child.kill("SIGTERM");
      killTimer = setTimeout(() => {
        if (!settled) {
          child.kill("SIGKILL");
        }
      }, 2_000);
    };

    const collect = (chunks: Buffer[], chunk: Buffer) => {
      if (truncated) {
        return;
      }
      const remaining = maxBufferBytes - bufferedBytes;
      if (remaining <= 0) {
        truncated = true;
        terminate();
        return;
      }
      if (chunk.length > remaining) {
        chunks.push(chunk.subarray(0, remaining));
        bufferedBytes += remaining;
        truncated = true;
        terminate();
        return;
      }
      chunks.push(chunk);
      bufferedBytes += chunk.length;
    };

    const timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => collect(stdout, chunk));
    child.stderr?.on("data", (chunk: Buffer) => collect(stderr, chunk));
    child.on("error", (error) => finish({ exitCode: null, signal: null, error }));
    child.on("close", (exitCode, signal) => finish({ exitCode, signal }));
  });
}
