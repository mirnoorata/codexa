import { spawn } from "node:child_process";

export interface RunCommandOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  input?: string;
  timeoutMs?: number;
  maxBufferBytes?: number;
  okExitCodes?: number[];
  budget?: CommandBudget;
  killProcessGroup?: boolean;
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

export interface CommandBudget {
  readonly totalMs: number;
  readonly usedMs: number;
  readonly warnings: string[];
  readonly provenance: string[];
  remainingMs(): number;
  reserveTimeout(requestedMs: number): number;
  record(result: CommandResult, elapsedMs: number): void;
}

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_BUFFER_BYTES = 1024 * 1024;

export function createCommandBudget(totalMs: number, warnings: string[] = [], provenance: string[] = []): CommandBudget {
  return new MutableCommandBudget(totalMs, warnings, provenance);
}

export async function runCommand(command: string, args: string[], options: RunCommandOptions = {}): Promise<CommandResult> {
  const requestedTimeoutMs = Math.max(1, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const timeoutMs = options.budget?.reserveTimeout(requestedTimeoutMs) ?? requestedTimeoutMs;
  const maxBufferBytes = Math.max(1024, options.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES);
  const okExitCodes = new Set(options.okExitCodes ?? [0]);
  const startedAt = Date.now();
  const detached = Boolean(options.killProcessGroup && process.platform !== "win32");

  if (timeoutMs <= 0) {
    const result: CommandResult = {
      command,
      args,
      cwd: options.cwd,
      stdout: "",
      stderr: "",
      exitCode: null,
      signal: null,
      ok: false,
      timedOut: true,
      truncated: false,
      error: new Error(`Command budget exhausted before running ${command}`)
    };
    options.budget?.record(result, 0);
    return result;
  }

  return await new Promise<CommandResult>((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      detached,
      stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"]
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
      const result: CommandResult = {
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
      };
      options.budget?.record(result, Math.max(0, Date.now() - startedAt));
      resolve(result);
    };

    const terminate = () => {
      if (child.killed) {
        return;
      }
      killChild(child, detached, "SIGTERM");
      killTimer = setTimeout(() => {
        if (!settled) {
          killChild(child, detached, "SIGKILL");
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
    child.stdin?.on("error", () => undefined);
    child.on("error", (error) => finish({ exitCode: null, signal: null, error }));
    child.on("close", (exitCode, signal) => finish({ exitCode, signal }));
    if (options.input !== undefined) {
      child.stdin?.end(options.input, "utf8");
    }
  });
}

function killChild(child: ReturnType<typeof spawn>, detached: boolean, signal: NodeJS.Signals): void {
  if (detached && child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Fall back to killing the direct child if process-group signaling is unavailable.
    }
  }
  child.kill(signal);
}

class MutableCommandBudget implements CommandBudget {
  readonly totalMs: number;
  readonly warnings: string[];
  readonly provenance: string[];
  #usedMs = 0;

  constructor(totalMs: number, warnings: string[], provenance: string[]) {
    this.totalMs = Math.max(1, Math.trunc(totalMs));
    this.warnings = warnings;
    this.provenance = provenance;
  }

  get usedMs(): number {
    return this.#usedMs;
  }

  remainingMs(): number {
    return Math.max(0, this.totalMs - this.#usedMs);
  }

  reserveTimeout(requestedMs: number): number {
    return Math.min(Math.max(1, Math.trunc(requestedMs)), this.remainingMs());
  }

  record(result: CommandResult, elapsedMs: number): void {
    const elapsed = Math.max(0, Math.trunc(elapsedMs));
    this.#usedMs = Math.min(this.totalMs, this.#usedMs + elapsed);
    this.provenance.push(`command:${result.command}:${result.ok ? "ok" : "not-ok"}:${elapsed}ms`);
    if (result.error?.message.startsWith("Command budget exhausted")) {
      this.warnings.push(`command budget exhausted before running ${result.command}`);
    } else if (result.timedOut) {
      this.warnings.push(`command timed out: ${result.command}`);
    } else if (result.truncated) {
      this.warnings.push(`command output truncated: ${result.command}`);
    }
  }
}
