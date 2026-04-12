import path from "node:path";
import { runCommand, type CommandResult } from "./command.js";

export interface GithubSyncCheckOptions {
  remote?: string;
  branch?: string;
  skipNetwork?: boolean;
  checkPush?: boolean;
  checkGh?: boolean;
  timeoutMs?: number;
}

export interface GithubSyncCommandSummary {
  name: string;
  ok: boolean;
  exitCode: number | null;
  timedOut: boolean;
  message?: string;
}

export interface GithubSyncCheck {
  repoRoot: string;
  branch: string | null;
  localHead: string | null;
  remoteName: string;
  remoteUrl: string | null;
  repoFullName: string | null;
  dirtyFileCount: number;
  remoteHead: string | null;
  remoteChecked: boolean;
  pushDryRunChecked: boolean;
  pushDryRunOk: boolean | null;
  ghInstalled: boolean | null;
  ghAuthenticated: boolean | null;
  authBlocked: boolean;
  warnings: string[];
  nextSteps: string[];
  commands: GithubSyncCommandSummary[];
}

interface GitRunOptions {
  timeoutMs?: number;
  okExitCodes?: number[];
}

const DEFAULT_TIMEOUT_MS = 10_000;

export async function checkGithubSync(repoInput: string, options: GithubSyncCheckOptions = {}): Promise<{ text: string; data: GithubSyncCheck }> {
  const initialRepo = path.resolve(repoInput || process.cwd());
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const remoteName = options.remote ?? "origin";
  const commands: GithubSyncCommandSummary[] = [];

  const rootResult = await git(initialRepo, ["rev-parse", "--show-toplevel"], { timeoutMs });
  commands.push(commandSummary("git rev-parse --show-toplevel", rootResult));
  if (!rootResult.ok) {
    throw new Error(`Codexa GitHub sync check requires a git repository: ${initialRepo}`);
  }

  const repoRoot = rootResult.stdout.trim();
  const branchResult = options.branch
    ? undefined
    : await git(repoRoot, ["branch", "--show-current"], { timeoutMs });
  if (branchResult) {
    commands.push(commandSummary("git branch --show-current", branchResult));
  }
  const branch = options.branch ?? nonEmpty(branchResult?.stdout.trim()) ?? null;

  const headResult = await git(repoRoot, ["rev-parse", "HEAD"], { timeoutMs });
  commands.push(commandSummary("git rev-parse HEAD", headResult));
  const localHead = headResult.ok ? nonEmpty(headResult.stdout.trim()) ?? null : null;

  const remoteResult = await git(repoRoot, ["remote", "get-url", remoteName], { timeoutMs });
  commands.push(commandSummary(`git remote get-url ${remoteName}`, remoteResult));
  const remoteUrl = remoteResult.ok ? nonEmpty(remoteResult.stdout.trim()) ?? null : null;
  const repoFullName = remoteUrl ? parseGithubRemote(remoteUrl) : null;

  const statusResult = await git(repoRoot, ["status", "--porcelain=v1"], { timeoutMs });
  commands.push(commandSummary("git status --porcelain=v1", statusResult));
  const dirtyFileCount = statusResult.ok ? statusResult.stdout.split(/\r?\n/u).filter(Boolean).length : 0;

  let remoteHead: string | null = null;
  let remoteChecked = false;
  let pushDryRunChecked = false;
  let pushDryRunOk: boolean | null = null;
  let authBlocked = false;

  if (!options.skipNetwork && remoteUrl && branch) {
    remoteChecked = true;
    const remoteHeadResult = await git(repoRoot, ["ls-remote", "--heads", remoteName, branch], { timeoutMs });
    commands.push(commandSummary(`git ls-remote --heads ${remoteName} ${branch}`, remoteHeadResult));
    if (remoteHeadResult.ok) {
      remoteHead = parseLsRemoteHead(remoteHeadResult.stdout);
    } else if (looksAuthBlocked(remoteHeadResult)) {
      authBlocked = true;
    }
  }

  if (!options.skipNetwork && remoteUrl && branch && (options.checkPush ?? true)) {
    pushDryRunChecked = true;
    const dryRunResult = await git(repoRoot, ["push", "--dry-run", "--porcelain", "-u", remoteName, `${branch}:${branch}`], {
      timeoutMs,
      okExitCodes: [0]
    });
    commands.push(commandSummary(`git push --dry-run -u ${remoteName} ${branch}:${branch}`, dryRunResult));
    pushDryRunOk = dryRunResult.ok;
    if (!dryRunResult.ok && looksAuthBlocked(dryRunResult)) {
      authBlocked = true;
    }
  }

  let ghInstalled: boolean | null = null;
  let ghAuthenticated: boolean | null = null;
  if (options.checkGh ?? true) {
    const ghVersion = await runCommand("gh", ["--version"], { timeoutMs: 2_000, maxBufferBytes: 16 * 1024 });
    commands.push(commandSummary("gh --version", ghVersion));
    ghInstalled = ghVersion.ok;
    if (ghVersion.ok) {
      const ghAuth = await runCommand("gh", ["auth", "status", "--hostname", "github.com"], {
        timeoutMs: 5_000,
        maxBufferBytes: 32 * 1024,
        env: noPromptEnv()
      });
      commands.push(commandSummary("gh auth status --hostname github.com", ghAuth));
      ghAuthenticated = ghAuth.ok;
    }
  }

  const warnings = buildGithubSyncWarnings({
    branch,
    dirtyFileCount,
    localHead,
    remoteUrl,
    repoFullName,
    remoteHead,
    remoteChecked,
    pushDryRunChecked,
    pushDryRunOk,
    ghInstalled,
    ghAuthenticated,
    authBlocked
  });
  const nextSteps = buildGithubSyncNextSteps({
    repoRoot,
    branch,
    remoteName,
    remoteUrl,
    repoFullName,
    localHead,
    remoteHead,
    pushDryRunChecked,
    pushDryRunOk,
    authBlocked,
    ghInstalled,
    ghAuthenticated
  });

  const data: GithubSyncCheck = {
    repoRoot,
    branch,
    localHead,
    remoteName,
    remoteUrl,
    repoFullName,
    dirtyFileCount,
    remoteHead,
    remoteChecked,
    pushDryRunChecked,
    pushDryRunOk,
    ghInstalled,
    ghAuthenticated,
    authBlocked,
    warnings,
    nextSteps,
    commands
  };

  return { text: renderGithubSyncCheck(data), data };
}

export function parseGithubRemote(remoteUrl: string): string | null {
  const cleaned = remoteUrl.trim().replace(/\.git$/u, "");
  const https = cleaned.match(/^https:\/\/(?:[^/@]+@)?github\.com\/([^/\s]+)\/([^/\s]+)$/iu);
  if (https) {
    return `${https[1]}/${https[2]}`;
  }
  const sshScp = cleaned.match(/^(?:[^@\s]+@)?github\.com:([^/\s]+)\/([^/\s]+)$/iu);
  if (sshScp) {
    return `${sshScp[1]}/${sshScp[2]}`;
  }
  const sshUrl = cleaned.match(/^ssh:\/\/(?:[^@\s]+@)?github\.com\/([^/\s]+)\/([^/\s]+)$/iu);
  if (sshUrl) {
    return `${sshUrl[1]}/${sshUrl[2]}`;
  }
  return null;
}

export function buildGithubSyncWarnings(input: {
  branch: string | null;
  dirtyFileCount: number;
  localHead: string | null;
  remoteUrl: string | null;
  repoFullName: string | null;
  remoteHead: string | null;
  remoteChecked: boolean;
  pushDryRunChecked: boolean;
  pushDryRunOk: boolean | null;
  ghInstalled: boolean | null;
  ghAuthenticated: boolean | null;
  authBlocked: boolean;
}): string[] {
  const warnings: string[] = [];
  const sourceSyncOk = input.pushDryRunChecked && input.pushDryRunOk === true;
  const sshGitHubRemote = input.remoteUrl ? isGithubSshRemote(input.remoteUrl) : false;
  if (!input.branch) {
    warnings.push("current branch could not be determined");
  }
  if (!input.localHead) {
    warnings.push("local HEAD could not be determined");
  }
  if (!input.remoteUrl) {
    warnings.push("no origin remote URL is configured");
  } else if (!input.repoFullName) {
    warnings.push("origin is not a recognized github.com remote");
  }
  if (input.dirtyFileCount > 0) {
    warnings.push(`working tree has ${input.dirtyFileCount} dirty file(s); commit or intentionally leave them out before syncing`);
  }
  if (input.authBlocked) {
    warnings.push("local shell cannot authenticate to GitHub non-interactively");
  }
  if (input.remoteChecked && input.remoteHead && input.localHead && input.remoteHead !== input.localHead) {
    warnings.push(`remote branch points at ${shortSha(input.remoteHead)}, while local HEAD is ${shortSha(input.localHead)}`);
  }
  if (input.pushDryRunChecked && input.pushDryRunOk === false && !input.authBlocked) {
    warnings.push("git push dry-run failed; inspect the command result before pushing");
  }
  if (input.ghInstalled === false) {
    warnings.push("GitHub CLI is not installed in this shell");
  } else if (input.ghInstalled && input.ghAuthenticated === false && !(sourceSyncOk && sshGitHubRemote)) {
    warnings.push("GitHub CLI is installed but not authenticated for github.com");
  }
  return warnings;
}

export function buildGithubSyncNextSteps(input: {
  repoRoot: string;
  branch: string | null;
  remoteName: string;
  remoteUrl: string | null;
  repoFullName: string | null;
  localHead: string | null;
  remoteHead: string | null;
  pushDryRunChecked: boolean;
  pushDryRunOk: boolean | null;
  authBlocked: boolean;
  ghInstalled: boolean | null;
  ghAuthenticated: boolean | null;
}): string[] {
  const steps: string[] = [];
  const sourceSyncOk = input.pushDryRunChecked && input.pushDryRunOk === true;
  const sshGitHubRemote = input.remoteUrl ? isGithubSshRemote(input.remoteUrl) : false;
  if (!input.remoteUrl) {
    steps.push(`add a GitHub remote, for example: git -C ${shellQuote(input.repoRoot)} remote add ${input.remoteName} git@github.com:OWNER/REPO.git`);
    return steps;
  }
  if (!input.repoFullName) {
    steps.push("point origin at a github.com repository if you want Codexa to diagnose GitHub source sync");
    return steps;
  }
  if (!input.branch) {
    steps.push("checkout or create the branch that should be pushed to GitHub");
    return steps;
  }
  if (input.authBlocked || (!sourceSyncOk && input.ghInstalled === false) || (!sourceSyncOk && input.ghAuthenticated === false && !sshGitHubRemote)) {
    steps.push("authenticate normal git access with SSH keys, a credential manager, or `gh auth login` from a shell that has gh installed");
  }
  if (input.remoteHead && input.localHead && input.remoteHead === input.localHead) {
    steps.push(`local ${input.branch} is already synced with ${input.remoteName}/${input.branch}; no source push is needed`);
    if (input.ghInstalled && input.ghAuthenticated === false) {
      steps.push("keep gh logged out until an API workflow needs it; prefer a short-lived GH_TOKEN or login only for that workflow, then logout");
    }
    steps.push("do not use GitHub Packages for source sync; packages are only for publishing npm/container artifacts later");
    steps.push("do not expect the Codex GitHub connector to supply shell git credentials; it is useful for repository inspection and small API operations, not local `git push` authentication");
    return steps;
  }
  if (input.pushDryRunChecked && input.pushDryRunOk === true) {
    steps.push(`push the current branch: git -C ${shellQuote(input.repoRoot)} push -u ${input.remoteName} ${input.branch}`);
  } else {
    steps.push(`after authentication, test safely with: git -C ${shellQuote(input.repoRoot)} push --dry-run -u ${input.remoteName} ${input.branch}`);
  }
  if (input.remoteHead && input.localHead && input.remoteHead !== input.localHead) {
    steps.push("inspect the remote branch before replacing it; if it is only the bootstrap placeholder, intentionally replace it with `git push --force-with-lease` after authentication");
  }
  steps.push("do not use GitHub Packages for source sync; packages are only for publishing npm/container artifacts later");
  steps.push("do not expect the Codex GitHub connector to supply shell git credentials; it is useful for repository inspection and small API operations, not local `git push` authentication");
  return steps;
}

function renderGithubSyncCheck(data: GithubSyncCheck): string {
  const lines = [
    "Codexa GitHub sync check",
    `Repo: ${data.repoRoot}`,
    `Branch: ${data.branch ?? "unknown"}`,
    `Local HEAD: ${data.localHead ? shortSha(data.localHead) : "unknown"}`,
    `Remote: ${data.remoteName}${data.remoteUrl ? ` (${data.remoteUrl})` : " (missing)"}`,
    `GitHub repo: ${data.repoFullName ?? "unknown"}`,
    `Remote branch HEAD: ${data.remoteHead ? shortSha(data.remoteHead) : data.remoteChecked ? "not found or inaccessible" : "not checked"}`,
    `Working tree dirty files: ${data.dirtyFileCount}`,
    `Push dry-run: ${data.pushDryRunChecked ? data.pushDryRunOk ? "passed" : "failed" : "not checked"}`,
    `gh installed: ${formatNullableBool(data.ghInstalled)}`,
    `gh authenticated: ${formatNullableBool(data.ghAuthenticated)}`,
    ""
  ];
  if (data.warnings.length > 0) {
    lines.push("Warnings:");
    lines.push(...data.warnings.map((warning) => `- ${warning}`));
    lines.push("");
  }
  lines.push("Next steps:");
  lines.push(...data.nextSteps.map((step) => `- ${step}`));
  lines.push("", "Command checks:");
  for (const command of data.commands) {
    const detail = command.message ? `: ${command.message}` : "";
    lines.push(`- ${command.name}: ${command.ok ? "ok" : "failed"}${detail}`);
  }
  return lines.join("\n");
}

function parseLsRemoteHead(stdout: string): string | null {
  const first = stdout.split(/\r?\n/u).find(Boolean);
  if (!first) {
    return null;
  }
  const [sha] = first.split(/\s+/u);
  return /^[0-9a-f]{40}$/iu.test(sha) ? sha : null;
}

async function git(repoRoot: string, args: string[], options: GitRunOptions): Promise<CommandResult> {
  return await runCommand("git", ["-C", repoRoot, ...args], {
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxBufferBytes: 512 * 1024,
    okExitCodes: options.okExitCodes,
    env: noPromptEnv()
  });
}

function commandSummary(name: string, result: CommandResult): GithubSyncCommandSummary {
  return {
    name,
    ok: result.ok,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    message: summarizeCommandMessage(result)
  };
}

function summarizeCommandMessage(result: CommandResult): string | undefined {
  if (result.ok) {
    return undefined;
  }
  if (result.timedOut) {
    return "timed out";
  }
  if (result.truncated) {
    return "output truncated";
  }
  const text = `${result.stderr}\n${result.stdout}`.trim().replace(/\s+/gu, " ");
  if (text) {
    return text.slice(0, 220);
  }
  if (result.error) {
    return result.error.message;
  }
  return result.exitCode === null ? "command did not start" : `exit ${result.exitCode}`;
}

function looksAuthBlocked(result: CommandResult): boolean {
  const text = `${result.stderr}\n${result.stdout}\n${result.error?.message ?? ""}`.toLowerCase();
  return (
    text.includes("could not read username") ||
    text.includes("authentication failed") ||
    text.includes("repository not found") ||
    text.includes("permission denied") ||
    text.includes("not logged in") ||
    text.includes("gh auth login") ||
    text.includes("terminal prompts disabled")
  );
}

function noPromptEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "never"
  };
}

function nonEmpty(value: string | undefined): string | undefined {
  return value && value.length > 0 ? value : undefined;
}

function shortSha(value: string): string {
  return value.slice(0, 12);
}

function formatNullableBool(value: boolean | null): string {
  return value === null ? "not checked" : value ? "yes" : "no";
}

function isGithubSshRemote(remoteUrl: string): boolean {
  return /^(?:[^@\s]+@)?github\.com:/iu.test(remoteUrl.trim()) || /^ssh:\/\/(?:[^@\s]+@)?github\.com\//iu.test(remoteUrl.trim());
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
