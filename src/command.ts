import { spawn } from "node:child_process";
import { AsyncLocalStorage } from "node:async_hooks";

export interface RunCommandOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  input?: string;
  timeoutMs?: number;
  maxBufferBytes?: number;
  okExitCodes?: number[];
  budget?: CommandBudget;
  killProcessGroup?: boolean;
  discardStdout?: boolean;
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
const TERMINATION_GRACE_MS = 2_000;
const TERMINAL_SETTLE_MS = 250;
const WINDOWS_TREE_TERMINATION_TIMEOUT_MS = 10_000;
const commandBudgetContext = new AsyncLocalStorage<CommandBudget>();

export function createCommandBudget(
  totalMs: number,
  warnings: string[] = [],
  provenance: string[] = [],
  deadlineAt?: number
): CommandBudget {
  return new MutableCommandBudget(totalMs, warnings, provenance, deadlineAt);
}

export function withCommandBudget<T>(
  budget: CommandBudget,
  operation: () => Promise<T>
): Promise<T> {
  return commandBudgetContext.run(budget, operation);
}

export async function runCommand(command: string, args: string[], options: RunCommandOptions = {}): Promise<CommandResult> {
  const budget = options.budget ?? commandBudgetContext.getStore();
  const requestedTimeoutMs = Math.max(1, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const timeoutMs = budget?.reserveTimeout(requestedTimeoutMs) ?? requestedTimeoutMs;
  const maxBufferBytes = Math.max(1024, options.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES);
  const okExitCodes = new Set(options.okExitCodes ?? [0]);
  const startedAt = Date.now();
  const terminateTree = Boolean(
    options.killProcessGroup || (budget && options.killProcessGroup !== false)
  );
  const detached = terminateTree && process.platform !== "win32";

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
    budget?.record(result, 0);
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
    let directKillTimer: NodeJS.Timeout | undefined;
    let terminalTimer: NodeJS.Timeout | undefined;
    let treeTermination: Promise<Error | undefined> | undefined;
    let terminating = false;
    let settled = false;

    const finish = async (
      partial: Omit<CommandResult, "command" | "args" | "cwd" | "stdout" | "stderr" | "ok" | "timedOut" | "truncated">
    ): Promise<void> => {
      if (settled) {
        return;
      }
      const terminationError = treeTermination ? await treeTermination : undefined;
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (directKillTimer) clearTimeout(directKillTimer);
      if (terminalTimer) clearTimeout(terminalTimer);
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
        error: partial.error ?? terminationError
      };
      budget?.record(result, Math.max(0, Date.now() - startedAt));
      resolve(result);
    };

    const scheduleTerminalSettlement = (error?: Error): void => {
      if (settled || terminalTimer) return;
      terminalTimer = setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        child.stdin?.destroy();
        child.unref();
        void finish({ exitCode: null, signal: "SIGKILL", error });
      }, TERMINAL_SETTLE_MS);
    };

    const terminate = () => {
      if (terminating) return;
      terminating = true;
      if (!terminateTree) {
        killChild(child, false, "SIGTERM");
        directKillTimer = setTimeout(() => {
          if (!settled) {
            killChild(child, false, "SIGKILL");
            scheduleTerminalSettlement();
          }
        }, TERMINATION_GRACE_MS);
        return;
      }
      treeTermination = terminateCommandTree(child, detached);
      void treeTermination.then((error) => {
        scheduleTerminalSettlement(error);
      });
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

    child.stdout?.on("data", (chunk: Buffer) => {
      if (!options.discardStdout) collect(stdout, chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => collect(stderr, chunk));
    child.stdin?.on("error", () => undefined);
    child.on("error", (error) => {
      void finish({ exitCode: null, signal: null, error });
    });
    child.on("close", (exitCode, signal) => {
      void finish({ exitCode, signal });
    });
    if (options.input !== undefined) {
      child.stdin?.end(options.input, "utf8");
    }
  });
}

async function terminateCommandTree(
  child: ReturnType<typeof spawn>,
  detached: boolean
): Promise<Error | undefined> {
  if (process.platform === "win32" && child.pid !== undefined) {
    const error = await terminateWindowsProcessTree(child.pid);
    if (error) killChild(child, false, "SIGKILL");
    return error;
  }
  killChild(child, detached, "SIGTERM");
  await new Promise((resolve) => setTimeout(resolve, TERMINATION_GRACE_MS));
  killChild(child, detached, "SIGKILL");
  return undefined;
}

function terminateWindowsProcessTree(pid: number): Promise<Error | undefined> {
  return new Promise((resolve) => {
    const killer = spawn("taskkill", ["/pid", String(pid), "/t", "/f"], {
      stdio: "ignore",
      windowsHide: true
    });
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(error);
    };
    const timeout = setTimeout(() => {
      killChild(killer, false, "SIGKILL");
      finish(new Error("Windows process-tree termination exceeded its terminal bound"));
    }, WINDOWS_TREE_TERMINATION_TIMEOUT_MS);
    killer.once("error", (error) => {
      finish(new Error(`Windows process-tree termination failed: ${error.message}`));
    });
    killer.once("close", (status) => {
      finish(status === 0
        ? undefined
        : new Error(`Windows process-tree termination failed with exit ${status}`));
    });
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
  try {
    child.kill(signal);
  } catch {
    // Completion is owned by the close event or terminal fallback.
  }
}

class MutableCommandBudget implements CommandBudget {
  readonly totalMs: number;
  readonly warnings: string[];
  readonly provenance: string[];
  #usedMs = 0;
  readonly #deadlineAt: number | undefined;

  constructor(
    totalMs: number,
    warnings: string[],
    provenance: string[],
    deadlineAt?: number
  ) {
    this.totalMs = Math.max(1, Math.trunc(totalMs));
    this.warnings = warnings;
    this.provenance = provenance;
    this.#deadlineAt = deadlineAt;
  }

  get usedMs(): number {
    return this.#usedMs;
  }

  remainingMs(): number {
    const cumulativeRemaining = Math.max(0, this.totalMs - this.#usedMs);
    return this.#deadlineAt === undefined
      ? cumulativeRemaining
      : Math.max(0, Math.min(cumulativeRemaining, this.#deadlineAt - Date.now()));
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
