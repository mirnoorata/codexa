import { promises as fs } from "node:fs";
import path from "node:path";
import { createCommandBudget, runCommand, type CommandBudget } from "../command.js";
import { isSubpath } from "../util.js";

export interface HookInput {
  payload?: unknown;
  error?: string;
}

// CLI invocations without host input remain supported. A pipe that never closes
// must not consume the host's entire hook timeout, or silently become no input.
export async function readHookInput(): Promise<HookInput> {
  if (process.stdin.isTTY) return {};
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    const finish = (result: HookInput): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      process.stdin.off("data", onData);
      process.stdin.off("end", onEnd);
      process.stdin.off("error", onError);
      process.stdin.pause();
      resolve(result);
    };
    const onError = (): void => finish({ error: "hook input could not be read" });
    const onData = (chunk: Buffer): void => {
      bytes += chunk.length;
      if (bytes > 1024 * 1024) finish({ error: "hook input exceeds 1 MiB" });
      else chunks.push(chunk);
    };
    const onEnd = (): void => {
      const text = Buffer.concat(chunks).toString("utf8").trim();
      if (!text) return finish({});
      try { finish({ payload: JSON.parse(text) }); }
      catch { finish({ error: "hook input is not valid JSON" }); }
    };
    const timer = setTimeout(() => finish({ error: "hook input did not complete within 500ms" }), 500);
    process.stdin.on("data", onData).once("end", onEnd).once("error", onError);
  });
}

/** Validate evidence scope only. Tool-controlled paths never select a repo. */
export async function assertHookInputMatchesRepo(repoRoot: string, input: HookInput): Promise<void> {
  if (input.error) throw new Error(input.error);
  if (input.payload === undefined) return;
  const event = record(input.payload);
  if (!event) throw new Error("hook input must be an object");
  const cwd = typeof event.cwd === "string" && path.isAbsolute(event.cwd) ? event.cwd : undefined;
  const tool = record(event.tool_input);
  const targets: string[] = [];
  for (const key of ["file_path", "notebook_path", "path"]) {
    if (typeof tool?.[key] === "string") targets.push(tool[key] as string);
  }
  const patch = typeof event.tool_input === "string" ? event.tool_input
    : typeof tool?.patch === "string" ? tool.patch
    : typeof tool?.input === "string" ? tool.input : undefined;
  if (patch !== undefined) {
    for (const match of patch.matchAll(/^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)\r?$/gmu)) {
      targets.push(match[1].replace(/\r$/u, ""));
    }
  }
  if (targets.length === 0 || targets.length > 128) {
    throw new Error("hook edit targets are missing or unsupported; review coverage unavailable");
  }
  const root = await fs.realpath(repoRoot);
  const checkedDirs = new Set<string>();
  const budget = createCommandBudget(2000);
  const rootGit = await gitRoot(root, budget);
  for (const target of targets) {
    if (!target || target.includes("\0") || (!path.isAbsolute(target) && !cwd)) {
      throw new Error("hook edit target needs an absolute path or host cwd");
    }
    const absolute = path.resolve(cwd ?? root, target);
    const existing = await existingAncestor(absolute);
    const real = await fs.realpath(existing);
    if (!isSubpath(absolute, path.resolve(repoRoot)) || !isSubpath(real, root)) {
      throw new Error("hook edit target is outside the configured checkout; initialize Codexa in the edited worktree and reload its hooks");
    }
    const dir = (await fs.stat(real)).isDirectory() ? real : path.dirname(real);
    if (!checkedDirs.has(dir)) {
      if (await gitRoot(dir, budget) !== rootGit) {
        throw new Error("hook edit target belongs to another repository; review coverage unavailable");
      }
      checkedDirs.add(dir);
    }
  }
}

async function existingAncestor(candidate: string): Promise<string> {
  try { await fs.lstat(candidate); return candidate; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" || path.dirname(candidate) === candidate) throw error;
    return existingAncestor(path.dirname(candidate));
  }
}

async function gitRoot(cwd: string, budget: CommandBudget): Promise<string> {
  const result = await runCommand("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { timeoutMs: 1000, budget });
  if (!result.ok) throw new Error("hook target Git identity unavailable");
  return fs.realpath(result.stdout.trim());
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
