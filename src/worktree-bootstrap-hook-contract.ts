import path from "node:path";
import { parse as parseToml } from "smol-toml";

export type WorktreeBootstrapHookLane = "posix-hooks" | "native-windows-mcp";

interface WorktreeBootstrapHookSnapshot {
  facts: { runtime: { nodePath: string } };
  hookInputs: {
    configContents: Buffer;
    hooksContents: Buffer | null;
    hooksTracked: boolean;
  };
}

export function expectedCodexaHookState(
  lane: WorktreeBootstrapHookLane
): "enabled" | "disabled" {
  return lane === "posix-hooks" ? "enabled" : "disabled";
}

export function lanePlatformMismatch(
  lane: WorktreeBootstrapHookLane,
  platform: NodeJS.Platform
): string | null {
  if (lane === "native-windows-mcp") {
    return platform === "win32" ? null : "lane-platform-drift";
  }
  return platform === "win32" ? "lane-platform-drift" : null;
}

export function inspectHookLaneContract(
  repoRoot: string,
  lane: WorktreeBootstrapHookLane,
  snapshot: WorktreeBootstrapHookSnapshot
): { ok: true } | { ok: false; reason: string } {
  try {
    const configContents = snapshot.hookInputs.configContents.toString("utf8");
    const parsedConfig = parseToml(configContents) as unknown;
    if (!isPlainObject(parsedConfig)) return { ok: false, reason: "hook-config-invalid" };
    const hooksFeature = isPlainObject(parsedConfig.features)
      ? parsedConfig.features.hooks
      : undefined;
    const hooksContents = snapshot.hookInputs.hooksContents;
    const parsedHooks = hooksContents
      ? JSON.parse(hooksContents.toString("utf8")) as unknown
      : {};
    const hooks = isPlainObject(parsedHooks) && isPlainObject(parsedHooks.hooks)
      ? parsedHooks.hooks
      : {};
    const nodePath = snapshot.facts.runtime.nodePath;
    const hooksTracked = snapshot.hookInputs.hooksTracked;
    const expectedCommands = new Map([
      ["session-start", expectedCodexaHookCommand(repoRoot, nodePath, hooksTracked, "session-start")],
      ["hook-pre-edit", expectedCodexaHookCommand(repoRoot, nodePath, hooksTracked, "hook-pre-edit")],
      ["hook-post-edit", expectedCodexaHookCommand(repoRoot, nodePath, hooksTracked, "hook-post-edit")]
    ]);
    const expectedCommandSet = new Set(expectedCommands.values());
    const managedEntries = Object.values(hooks)
      .flatMap((value) => Array.isArray(value) ? value : [])
      .filter((entry) => hasCodexaHookSignal(entry, expectedCommandSet));

    if (lane === "native-windows-mcp") {
      return managedEntries.length === 0
        ? { ok: true }
        : { ok: false, reason: "hook-lane-drift" };
    }
    if (hooksFeature !== true) return { ok: false, reason: "hook-feature-disabled" };
    const required = [
      ["SessionStart", "startup|resume", "session-start"],
      ["PreToolUse", "Edit|MultiEdit|Write|NotebookEdit|apply_patch", "hook-pre-edit"],
      ["PostToolUse", "Edit|MultiEdit|Write|NotebookEdit|apply_patch", "hook-post-edit"]
    ] as const;
    if (managedEntries.length !== required.length) {
      return { ok: false, reason: "hook-contract-drift:managed-set" };
    }
    for (const [event, matcher, action] of required) {
      const entries = Array.isArray(hooks[event]) ? hooks[event] : [];
      const expectedCommand = expectedCommands.get(action);
      if (!expectedCommand) return { ok: false, reason: `hook-contract-drift:${event}` };
      const matching = entries.filter(
        (entry) => isExpectedManagedHookEntry(entry, matcher, expectedCommand)
      );
      if (matching.length !== 1) {
        return { ok: false, reason: `hook-contract-drift:${event}` };
      }
    }
    return { ok: true };
  } catch {
    return { ok: false, reason: "hook-contract-invalid" };
  }
}

function isExpectedManagedHookEntry(
  value: unknown,
  matcher: string,
  expectedCommand: string
): boolean {
  if (!isPlainObject(value) || value.codexaManaged !== true || value.matcher !== matcher) {
    return false;
  }
  if (!Array.isArray(value.hooks) || value.hooks.length !== 1) return false;
  const hook = value.hooks[0];
  return isPlainObject(hook) &&
    hook.codexaManaged === true &&
    hook.type === "command" &&
    hook.command === expectedCommand;
}

function hasCodexaHookSignal(value: unknown, expectedCommands: Set<string>): boolean {
  if (!isPlainObject(value)) return false;
  if (value.codexaManaged === true) return true;
  if (!Array.isArray(value.hooks)) return false;
  return value.hooks.some((hook) => isPlainObject(hook) && (
    hook.codexaManaged === true ||
    (typeof hook.command === "string" && expectedCommands.has(hook.command))
  ));
}

function expectedCodexaHookCommand(
  repoRoot: string,
  nodePath: string,
  hooksTracked: boolean,
  action: string
): string {
  const launchCommand = hooksTracked ? "node" : nodePath;
  const printableCommand = /[\s'"\\]/u.test(launchCommand)
    ? shellQuote(launchCommand)
    : launchCommand;
  const launch = `${printableCommand} ${shellQuote(path.join(repoRoot, "dist", "cli.js"))}`;
  const repoArg = hooksTracked ? undefined : repoRoot;
  return repoArg ? `${launch} ${action} ${shellQuote(repoArg)}` : `${launch} ${action}`;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
